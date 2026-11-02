// Placeholder-gated injection on the Cloudflare stack (#331): a session's in-process isolate holds a connection's
// placeholder, and its curl reaches the connection's API with the credential put in on the way out. The shared
// conformance cases (`@kantel/connections/egress-conformance`) run here as they do on the self-hosted gateway, then the
// canary check: the secret is nowhere the sandbox can see.
import {
	CANARY_SECRET,
	CONFORMANCE_CASES,
	CONFORMANCE_CONNECTION,
	canaryLeaks,
	checkConformanceCase,
	conformanceUpstream,
} from "@kantel/connections/egress-conformance";
import { memoryCredentials } from "@kantel/connections/memory";
import { letEverythingThrough } from "@kantel/connections/testing";
import { type CallContext, isRedactedUse } from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

async function setUp() {
	const upstream = conformanceUpstream();
	const { models } = createScriptedModel();
	const stack = await createStack({
		config: gatewayConfig({ KANTEL_ADMIN_EMAIL: "tom@kantel.test" }),
		models: () => ({ models }),
		connections: {
			credentials: memoryCredentials(),
			deployment: { origin: "https://kantel.test", clientMetadataPublic: false },
			fetch: upstream.fetch,
		},
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	const connections = stack.connections!;
	const connection = await connections.connectKey(admin, {
		owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
		name: CONFORMANCE_CONNECTION.name,
		custom: { hosts: [CONFORMANCE_CONNECTION.host], injection: { kind: "bearer" }, kind: "http" },
		value: CONFORMANCE_CONNECTION.value,
		usage: { unattended: true, visibility: "shared" },
	});
	// The cases are about the placeholder, not rules: a write or a delete goes through as before the defaults (#332).
	await letEverythingThrough(connections, admin, connection.id);
	const workspace = await stack.workspaces.create(admin, {
		owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
		seed: { name: "s", sources: [{ kind: "files", files: { "README.md": "egress\n" } }] },
	});
	const session = await stack.runtime.runtime.create(admin, {
		projectId: stack.project.id,
		agentId: DEFAULT_AGENT_ID,
		workspaceId: workspace.id,
	});
	const run = (command: string) =>
		stack.sandboxes.sandboxes.run(admin, {
			sessionId: session.id,
			workspaceId: workspace.id,
			tool: "bash",
			request: { command },
		});
	return { stack, admin, connections, connection, upstream, run };
}

describe("placeholder-gated injection on the Cloudflare stack", () => {
	it("gives each connection a stable placeholder, and the sandbox only that", async () => {
		const { admin, connections, connection, run } = await setUp();
		expect(connection.placeholder).toMatch(/^kantel-cn-[0-9a-f]{32}$/);
		const env = await run("printenv");
		expect(env.tier).toBe("isolate");
		expect(env.stdout).toContain(`${CONFORMANCE_CONNECTION.env}=${connection.placeholder}`);
		expect(env.stdout).not.toContain(CANARY_SECRET);
		await connections.rotateKey(admin, connection.id, { value: `${CANARY_SECRET}-rotated` });
		expect((await connections.get(admin, connection.id)).placeholder).toBe(connection.placeholder);
	});

	it("passes every conformance case, and the canary never reaches the sandbox or another host", async () => {
		const { upstream, run, stack, admin, connections } = await setUp();
		const seen: { where: string; text: string }[] = [];
		const failures: string[] = [];
		for (const test of CONFORMANCE_CASES) {
			const before = upstream.requests.length;
			const result = await run(test.command);
			seen.push(
				{ where: `${test.name}: stdout`, text: result.stdout },
				{ where: `${test.name}: stderr`, text: result.stderr },
			);
			for (const problem of checkConformanceCase(test, result, upstream.requests.slice(before))) {
				failures.push(`${test.name}: ${problem}`);
			}
		}
		const files = await run(
			`env > seen.txt; curl -s -D - -H "Authorization: $${CONFORMANCE_CONNECTION.env}" https://${CONFORMANCE_CONNECTION.host}/v1/me >> seen.txt; cat seen.txt`,
		);
		seen.push({ where: "seen.txt", text: files.stdout });
		// The log: every audit event and every recorded use.
		const events = await stack.audit.query(admin, {}, { limit: 500 });
		seen.push({ where: "audit", text: JSON.stringify(events.items) });
		const uses = await connections.listUses(admin, {}, { limit: 500 });
		seen.push({ where: "uses", text: JSON.stringify(uses.items) });
		const refusals = uses.items.flatMap((use) => (isRedactedUse(use) ? [] : [use.refusal]));
		expect(refusals).toContain("host_not_bound");
		expect(refusals).toContain("raw_secret");
		expect(failures).toEqual([]);
		expect(upstream.requests).toHaveLength(CONFORMANCE_CASES.filter((test) => test.sent !== undefined).length + 1);
		expect(files.stdout).toContain("[redacted]");
		expect(canaryLeaks(seen)).toEqual([]);
		expect(upstream.requests.every((request) => new URL(request.url).hostname === CONFORMANCE_CONNECTION.host)).toBe(
			true,
		);
	});
});
