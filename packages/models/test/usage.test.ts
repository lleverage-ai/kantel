/**
 * The gateway's usage records (docs/usage-analytics.md): one per call, written where the gateway sees the upstream's
 * response, with the cache split, failed and aborted calls' usage, and a write that fails never failing the call.
 */
import { type ModelStreamEvent, systemContext, type UsageRecord, type UsageWriter } from "@harbour/contracts";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import { createModelGateway } from "@harbour/models/gateway";
import { priceVersionOf, providerOf, type UsageWriteFailure, usageRecordOf } from "@harbour/models/usage";
import { createDeps } from "@harbour/testing/harness";
import { createFakeModelUpstream, type FakeUpstreamScript } from "@harbour/testing/models";
import { createMemoryVault } from "@harbour/vault/memory";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
const operator = { ...systemContext("operator"), organisationId: ORG };
const BASE_URL = "http://cpa.internal:8317/v1";

let sessions = 0;
const scopeFor = () => {
	sessions += 1;
	return { organisationId: ORG, projectId: "proj-a", agentId: "agent-1", sessionId: `sess-${sessions}` };
};

function memoryWriter(): UsageWriter & { readonly records: UsageRecord[] } {
	const records: UsageRecord[] = [];
	return {
		records,
		async record(record) {
			if (!records.some((held) => held.sessionId === record.sessionId && held.callId === record.callId)) {
				records.push(record);
			}
		},
	};
}

async function setup(
	options: {
		usage?: UsageWriter;
		onUsageFailure?: (failure: UsageWriteFailure) => void;
		preset?: "cliproxyapi" | "openrouter";
		model?: string;
	} = {},
) {
	const deps = createDeps();
	const upstream = createFakeModelUpstream({ models: [{ id: "claude-sonnet-4-5" }, { id: "gpt-5" }] });
	const vault = createMemoryVault({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const connectors = createMemoryModelConnectors({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const item = await vault.putItem(operator, {
		owner: { kind: "platform" },
		name: "CPA",
		hosts: ["cpa.internal"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: "sk-gateway-test-7d1f0e2a",
	});
	await connectors.putConnector(operator, {
		id: "cpa",
		owner: { kind: "platform" },
		preset: options.preset ?? "cliproxyapi",
		baseUrl: BASE_URL,
		vaultItemId: item.id,
		catalogue: { refresh: "static", include: ["claude-sonnet-4-5", "gpt-5"] },
	});
	await connectors.putRoute(operator, {
		name: "default",
		owner: { kind: "platform" },
		connectorId: "cpa",
		modelId: options.model ?? "claude-sonnet-4-5",
	});
	const usage = options.usage ?? memoryWriter();
	const gateway = createModelGateway({
		connectors,
		credentials: vault,
		clock: deps.clock,
		audit: deps.audit,
		fetch: upstream.fetch,
		baseUrl: "http://gateway.internal",
		access: deps.access,
		usage,
		...(options.onUsageFailure === undefined ? {} : { onUsageFailure: options.onUsageFailure }),
	});
	return { deps, upstream, gateway, usage };
}

async function run(
	gateway: Awaited<ReturnType<typeof setup>>["gateway"],
	scope = scopeFor(),
): Promise<ModelStreamEvent[]> {
	const events: ModelStreamEvent[] = [];
	const stream = await gateway.messages(scope, {
		model: "default",
		context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
	});
	for await (const event of stream) events.push(event);
	return events;
}

const recordsOf = (usage: UsageWriter) => (usage as ReturnType<typeof memoryWriter>).records;

describe("the gateway's usage records", () => {
	it("writes one record per call, with its scope, connector, provider, tokens and the model.call's ID", async () => {
		const { gateway, usage, deps } = await setup();
		const scope = scopeFor();
		await run(gateway, scope);
		await run(gateway, scope);
		const records = recordsOf(usage);
		expect(records).toHaveLength(2);
		const calls = deps.audit.ofType("model.call").map((event) => event.subject?.id);
		expect(records.map((record) => record.callId)).toEqual(calls);
		expect(records[0]).toMatchObject({
			organisationId: ORG,
			projectId: "proj-a",
			sessionId: scope.sessionId,
			agentId: "agent-1",
			route: "default",
			modelId: "claude-sonnet-4-5",
			provider: "anthropic",
			connectorId: "cpa",
			connectorPreset: "cliproxyapi",
			api: "anthropic-messages",
			status: "done",
			stopReason: "stop",
			inputTokens: 120,
			outputTokens: 40,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costSource: "none",
			priceVersion: "none",
			cost: { total: 0 },
		});
		expect(records[0]?.firstTokenMs).toBeGreaterThanOrEqual(0);
		expect(records[0]?.error).toBeUndefined();
	});

	it("keeps the cache split: reads and writes apart from uncached input", async () => {
		const { gateway, usage, upstream } = await setup();
		upstream.next({ usage: { input: 30, output: 12, cacheRead: 4_000, cacheWrite: 1_500 } });
		await run(gateway);
		expect(recordsOf(usage)[0]).toMatchObject({
			inputTokens: 30,
			outputTokens: 12,
			cacheReadTokens: 4_000,
			cacheWriteTokens: 1_500,
		});
	});

	it("keeps cache reads and writes on Chat Completions, and the reasoning count", async () => {
		const { gateway, usage, upstream } = await setup({ preset: "openrouter", model: "gpt-5" });
		upstream.next({ usage: { input: 50, output: 20, cacheRead: 300, cacheWrite: 70, reasoning: 9 } });
		await run(gateway);
		expect(recordsOf(usage)[0]).toMatchObject({
			api: "openai-completions",
			provider: "openai",
			connectorPreset: "openrouter",
			inputTokens: 50,
			outputTokens: 20,
			cacheReadTokens: 300,
			cacheWriteTokens: 70,
			reasoningTokens: 9,
		});
	});

	it("keeps a failed call's usage: the input an upstream read before failing, and the error", async () => {
		const { gateway, usage, upstream } = await setup();
		upstream.next({
			usage: { input: 900, output: 0, cacheRead: 5_000, cacheWrite: 200 },
			failAfterStart: "Overloaded",
		});
		const events = await run(gateway);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(recordsOf(usage)).toHaveLength(1);
		expect(recordsOf(usage)[0]).toMatchObject({
			status: "error",
			stopReason: "error",
			inputTokens: 900,
			cacheReadTokens: 5_000,
			cacheWriteTokens: 200,
			error: expect.stringContaining("Overloaded"),
		});
	});

	it("records a call the upstream refuses outright, with no tokens and the redacted error", async () => {
		const { gateway, usage, upstream } = await setup();
		upstream.next({
			error: { status: 529, message: "Overloaded; key sk-gateway-test-7d1f0e2a" },
		} as FakeUpstreamScript);
		await run(gateway);
		const [record] = recordsOf(usage);
		expect(record).toMatchObject({ status: "error", inputTokens: 0, outputTokens: 0 });
		expect(record?.error).toBeDefined();
		expect(record?.error).not.toContain("sk-gateway-test-7d1f0e2a");
	});

	it("retries a failed write, then tells the host and never fails the call", async () => {
		let attempts = 0;
		const failures: UsageWriteFailure[] = [];
		const { gateway } = await setup({
			usage: {
				async record() {
					attempts += 1;
					throw new Error("ledger down");
				},
			},
			onUsageFailure: (failure) => {
				failures.push(failure);
			},
		});
		const events = await run(gateway);
		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(attempts).toBe(3);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ attempts: 3, record: { status: "done" } });
	});
});

describe("usage record helpers", () => {
	it("tells who made a model from a namespaced ID, pi's catalogues or its name", () => {
		expect(providerOf("anthropic/claude-opus-4")).toBe("anthropic");
		expect(providerOf("claude-sonnet-4-5")).toBe("anthropic");
		expect(providerOf("gpt-5")).toBe("openai");
		expect(providerOf("gemini-2.5-pro")).toBe("google");
		expect(providerOf("my-alias", "openai/gpt-5")).toBe("openai");
		expect(providerOf("llama-local")).toBe("unknown");
	});

	it("names the rates a computed cost used, and cuts a long error", () => {
		const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		expect(priceVersionOf("computed", rates)).toBe("rates:3/15/0.3/3.75");
		expect(priceVersionOf("reported", rates)).toBe("reported");
		const record = usageRecordOf(
			{
				id: "call-1",
				at: 1,
				scope: { organisationId: ORG, projectId: "p", agentId: "a", sessionId: "s" },
				route: "default",
				connectorId: "cpa",
				modelId: "gpt-5",
				status: "error",
				durationMs: 5,
				usage: {
					input: 1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				costSource: "computed",
			},
			{
				connector: { preset: "litellm", catalogue: { refresh: "static" } },
				api: "openai-responses",
				rates,
				error: "x".repeat(900),
			},
		);
		expect(record.error).toHaveLength(500);
		expect(record.priceVersion).toBe("rates:3/15/0.3/3.75");
		expect(record.reasoningTokens).toBeUndefined();
	});
});
