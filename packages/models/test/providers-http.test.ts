import type { CallContext, Vault, VaultItem } from "@harbour/contracts";
import type { CpaAuthStatus, CpaManagement } from "@harbour/models/cpa-management";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import { createModelProviders } from "@harbour/models/providers";
import { createModelProvidersApi } from "@harbour/models/providers-http";
import { actors, CANARY_SECRET, contextFor, createDeps } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const ORG = "org-http";
const admin = contextFor(actors.human("admin"), ORG);
const agent = contextFor(actors.agent("agent-1", "sess-1"), ORG);
const KEY = `sk-ant-${CANARY_SECRET}`;

function setUp(caller: CallContext = admin) {
	const deps = createDeps();
	deps.tenancy.bind(actors.human("admin"), ORG, "admin");
	deps.tenancy.session({ id: "sess-1", organisationId: ORG, agentId: "agent-1" });
	const connectors = createMemoryModelConnectors({ clock: deps.clock, audit: deps.audit, access: deps.access });
	let items = 0;
	const vault: Pick<Vault, "putItem"> = {
		async putItem(_ctx, input) {
			items += 1;
			const item: VaultItem = {
				id: `item-${items}`,
				owner: input.owner,
				name: input.name,
				hosts: [...input.hosts],
				injection: input.injection,
				placeholder: `harbour://${input.name}/0`,
				hasValue: input.value !== undefined,
				valueVersion: 1,
				createdAt: 1,
				updatedAt: 1,
			};
			return item;
		},
	};
	const statuses = new Map<string, CpaAuthStatus>();
	const callbacks: string[] = [];
	const subscriptions: CpaManagement = {
		authUrl: async (provider) => ({ status: "ok", url: `https://${provider}.example/oauth`, state: `st-${provider}` }),
		authStatus: async (state) => statuses.get(state) ?? { status: "wait" },
		submitCallback: async (provider, state, redirectUrl) => {
			callbacks.push(`${provider}:${state}:${redirectUrl}`);
			return { status: "ok" };
		},
		authFiles: async () => ({ files: [] }),
	};
	const providers = createModelProviders({
		connectors,
		vault,
		subscriptions,
		access: deps.access,
		audit: deps.audit,
		clock: deps.clock,
	});
	const api = createModelProvidersApi({ providers, authenticate: async () => caller });
	const call = async (method: string, path: string, body?: unknown) => {
		const response = await api.fetch(
			new Request(`https://harbour.test/v1${path}`, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
			}),
		);
		const text = response === undefined ? "" : await response.text();
		// biome-ignore lint/suspicious/noExplicitAny: a test reads the answer's JSON loosely.
		const json: any = text === "" ? undefined : JSON.parse(text);
		return { status: response?.status, body: json, text };
	};
	return { api, call, statuses, callbacks };
}

describe("the model providers API", () => {
	it("lists, connects a key, and disconnects", async () => {
		const { call } = setUp();
		const listed = await call("GET", "/model-providers");
		expect(listed.status).toBe(200);
		expect(listed.body.items).toHaveLength(7);
		expect(listed.body.defaultRoute).toBeUndefined();

		const connected = await call("PUT", "/model-providers/anthropic/key", { key: KEY });
		expect(connected.status).toBe(200);
		expect(connected.body).toMatchObject({
			id: "anthropic",
			connection: { connectorId: "org-anthropic", routes: ["anthropic", "default"], modelId: "claude-sonnet-5-5" },
		});
		expect(connected.text).not.toContain(CANARY_SECRET);
		const after = await call("GET", "/model-providers");
		expect(after.body.defaultRoute).toEqual({
			connectorId: "org-anthropic",
			modelId: "claude-sonnet-5-5",
			owner: "organisation",
		});
		expect(after.text).not.toContain(CANARY_SECRET);

		const removed = await call("DELETE", "/model-providers/anthropic");
		expect(removed.status).toBe(204);
		expect(removed.text).toBe("");
		expect((await call("DELETE", "/model-providers/anthropic")).status).toBe(404);
		expect((await call("GET", "/model-providers")).body.defaultRoute).toBeUndefined();
	});

	it("signs in to a subscription, polls it and finishes it by hand", async () => {
		const { call, statuses, callbacks } = setUp();
		const started = await call("POST", "/model-providers/claude/sign-ins");
		expect(started.status).toBe(201);
		expect(started.body).toEqual({
			id: "st-anthropic",
			providerId: "claude",
			status: "pending",
			url: "https://anthropic.example/oauth",
		});
		expect((await call("GET", "/model-providers/claude/sign-ins/st-anthropic")).body).toEqual({
			id: "st-anthropic",
			providerId: "claude",
			status: "pending",
		});
		statuses.set("st-anthropic", { status: "ok" });
		expect((await call("GET", "/model-providers/claude/sign-ins/st-anthropic")).body.status).toBe("completed");

		const redirect = "http://localhost:1455/auth/callback?code=c&state=st-codex";
		const finished = await call("POST", "/model-providers/chatgpt/sign-ins/st-codex/finish", { redirectUrl: redirect });
		expect(finished.status).toBe(200);
		expect(finished.body).toEqual({ id: "st-codex", providerId: "chatgpt", status: "pending" });
		expect(callbacks).toEqual([`codex:st-codex:${redirect}`]);
	});

	it("refuses malformed requests, a subscription's key and an agent", async () => {
		const { call } = setUp();
		expect((await call("PUT", "/model-providers/mistral/key", { key: KEY })).status).toBe(400);
		expect((await call("PUT", "/model-providers/anthropic/key", {})).status).toBe(400);
		const subscription = await call("PUT", "/model-providers/claude/key", { key: KEY });
		expect(subscription.status).toBe(400);
		expect(subscription.body.error.code).toBe("invalid");
		expect((await call("PUT", "/model-providers/openai/key", { key: "short" })).status).toBe(400);
		expect((await call("POST", "/model-providers/anthropic/sign-ins")).status).toBe(400);
		expect((await call("POST", "/model-providers/chatgpt/sign-ins/st/finish", {})).status).toBe(400);
		expect((await call("DELETE", "/model-providers/claude")).status).toBe(400);

		const asAgent = setUp(agent);
		const refused = await asAgent.call("PUT", "/model-providers/anthropic/key", { key: KEY });
		expect(refused.status).toBe(403);
		expect(refused.body.error.code).toBe("forbidden");
		expect(refused.text).not.toContain(CANARY_SECRET);
		expect((await asAgent.call("DELETE", "/model-providers/anthropic")).status).toBe(403);
	});

	it("answers 404 for an unknown route, hides unexpected errors, and leaves other paths alone", async () => {
		const { api, call } = setUp();
		expect((await call("GET", "/model-providers/anthropic")).status).toBe(404);
		expect(await api.fetch(new Request("https://harbour.test/v1/onboarding"))).toBeUndefined();
		expect(await api.fetch(new Request("https://harbour.test/v1/model-providersx"))).toBeUndefined();

		const failing = createModelProvidersApi({
			providers: {} as never,
			authenticate: async () => {
				throw new Error(`database said ${CANARY_SECRET}`);
			},
		});
		const response = await failing.fetch(new Request("https://harbour.test/v1/model-providers"));
		expect(response?.status).toBe(500);
		expect(await response?.text()).not.toContain(CANARY_SECRET);
	});
});
