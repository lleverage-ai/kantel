// Placeholder-gated injection on the self-hosted gateway (#331): a session's isolate holds a connection's placeholder,
// and its curl reaches the connection's API with the credential put in on the way out. The shared conformance cases
// (`@kantel/connections/egress-conformance`) run here as they do on the Cloudflare stack, then the canary check: the
// secret is nowhere the sandbox can see.
import {
	CANARY_SECRET,
	CONFORMANCE_CASES,
	CONFORMANCE_CONNECTION,
	canaryLeaks,
	checkConformanceCase,
	conformanceUpstream,
} from "@kantel/connections/egress-conformance";
import { letEverythingThrough } from "@kantel/connections/testing";
import { type CallContext, isRedactedUse, type SessionId, systemContext } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";

const ORIGIN = "https://harbour.example.com";
const opened: GatewayComponents[] = [];
afterEach(async () => {
	for (const components of opened.splice(0)) await components.close();
});

async function setUp() {
	const upstream = conformanceUpstream();
	const components = createGatewayComponents({
		connections: { origin: ORIGIN, clientMetadataPublic: false, personal: false },
		connectionsFetch: upstream.fetch,
	});
	opened.push(components);
	const seeded = await bootstrap(components, { organisation: "Egress", project: "egress" });
	const system = { ...systemContext("egress-test"), organisationId: seeded.organisationId };
	const key = await components.identity.authenticateApiKey(system, seeded.apiKey);
	const operator: CallContext = {
		actor: key.actor,
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	// An admin connects the key, as the console does.
	const service = await components.identity.createServiceIdentity(system, { name: "connections admin" });
	const admin = await components.identity.issueApiKey(system, {
		serviceId: service.id,
		projectIds: [seeded.projectId],
		role: "admin",
	});
	const adminCtx: CallContext = {
		actor: (await components.identity.authenticateApiKey(system, admin.secret)).actor,
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	const connections = components.connections!;
	const connection = await connections.connectKey(adminCtx, {
		owner: { kind: "project", organisationId: seeded.organisationId, projectId: seeded.projectId },
		name: CONFORMANCE_CONNECTION.name,
		custom: { hosts: [CONFORMANCE_CONNECTION.host], injection: { kind: "bearer" }, kind: "http" },
		value: CONFORMANCE_CONNECTION.value,
		usage: { unattended: true, visibility: "shared" },
	});
	// The cases are about the placeholder, not rules: a write or a delete goes through as before the defaults (#332).
	await letEverythingThrough(connections, adminCtx, connection.id);
	const session = await components.runtime.runtime.create(operator, {
		projectId: seeded.projectId,
		agentId: "echo",
		workspaceId: seeded.workspaceId,
	});
	const run = (command: string) =>
		components.sandboxes.run(operator, {
			sessionId: session.id as SessionId,
			workspaceId: seeded.workspaceId,
			tool: "bash",
			request: { command },
		});
	return { components, connections, connection, upstream, session, run, adminCtx, seeded };
}

describe("placeholder-gated injection on the self-hosted gateway", () => {
	it("gives each connection a stable placeholder, and the sandbox only that", async () => {
		const { connection, connections, adminCtx, run } = await setUp();
		expect(connection.placeholder).toMatch(/^kantel-cn-[0-9a-f]{32}$/);
		const env = await run("printenv");
		expect(env.stdout).toContain(`${CONFORMANCE_CONNECTION.env}=${connection.placeholder}`);
		expect(env.stdout).not.toContain(CANARY_SECRET);
		// Rotating the key keeps the placeholder: the sandbox's copy stays good.
		await connections.rotateKey(adminCtx, connection.id, { value: `${CANARY_SECRET}-rotated` });
		expect((await connections.get(adminCtx, connection.id)).placeholder).toBe(connection.placeholder);
	});

	it("passes every conformance case, and the canary never reaches the sandbox or another host", async () => {
		const { upstream, run, components, adminCtx, connections } = await setUp();
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
		// The sandbox writing down what it could see, then reading back: still no secret.
		const files = await run(
			'env > seen.txt; curl -s -D - -H "Authorization: $KANTEL_CONNECTION_CONFORMANCE_API" https://api.conformance.test/v1/me >> seen.txt; cat seen.txt',
		);
		seen.push({ where: "seen.txt", text: files.stdout });
		// The log: every audit event and every recorded use.
		const events = await components.audit.query(adminCtx, {}, { limit: 500 });
		seen.push({ where: "audit", text: JSON.stringify(events.items) });
		const uses = await connections.listUses(adminCtx, {}, { limit: 500 });
		seen.push({ where: "uses", text: JSON.stringify(uses.items) });
		const refusals = uses.items.flatMap((use) => (isRedactedUse(use) ? [] : [use.refusal]));
		expect(refusals).toContain("host_not_bound");
		expect(refusals).toContain("raw_secret");
		expect(failures).toEqual([]);
		// Each case that sends reached the API once, and the last command once more.
		expect(upstream.requests).toHaveLength(CONFORMANCE_CASES.filter((test) => test.sent !== undefined).length + 1);
		expect(files.stdout).toContain("[redacted]");
		expect(canaryLeaks(seen)).toEqual([]);
		expect(upstream.requests.every((request) => new URL(request.url).hostname === CONFORMANCE_CONNECTION.host)).toBe(
			true,
		);
	});
});
