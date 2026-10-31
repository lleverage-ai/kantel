// Token refresh (#328): single-flight within a process and across processes over one database, the sweep, backoff while
// a refresh fails, and `connection_reconnect_required` once the provider refuses the grant.
import { type AuditEventInput, type ConnectionSessionScope, isKantelError, systemContext } from "@kantel/contracts";
import { pgliteDatabase, type TestDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { memoryCredentials } from "../src/memory.ts";
import {
	type ConnectionsRepository,
	createMemoryConnectionsRepository,
	createSqlConnectionsRepository,
	migrateConnections,
} from "../src/repository.ts";
import { type ConnectionsService, createConnections, refreshBackoffMs } from "../src/service.ts";
import { type FakeProvider, fakeAccess, fakeProvider, human, ORG, whole } from "../src/testing.ts";

const SYSTEM = systemContext("test");
const alice = human("alice");
const HOUR = 3600 * 1000;

const scope = (overrides: Partial<ConnectionSessionScope> = {}): ConnectionSessionScope => ({
	organisationId: ORG,
	sessionId: "ses_1",
	agentId: "agt_1",
	actingUserId: "alice",
	audience: { kind: "private", userId: "alice" },
	...overrides,
});

interface World {
	readonly provider: FakeProvider;
	readonly events: AuditEventInput[];
	readonly due: number[];
	readonly repository: ConnectionsRepository;
	/** A gateway process over the shared repository and vault. */
	gateway(holder: string, refresh?: { leaseWaitMs?: number; leaseMs?: number }): ConnectionsService;
	advance(ms: number): number;
	now(): number;
}

function world(repository: ConnectionsRepository = createMemoryConnectionsRepository()): World {
	const provider = fakeProvider();
	const credentials = memoryCredentials();
	const events: AuditEventInput[] = [];
	const due: number[] = [];
	let now = 1_000_000;
	return {
		provider,
		events,
		due,
		repository,
		gateway: (holder, refresh = {}) =>
			createConnections({
				repository,
				credentials,
				audit: {
					append: async (_ctx, batch) => {
						events.push(...batch);
					},
				},
				fetch: provider.fetch,
				access: fakeAccess(["admin"]),
				deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
				clock: { now: () => now },
				refresh: { holder, pollMs: 5, onDue: (at) => due.push(at), ...refresh },
			}),
		advance: (ms) => (now += ms),
		now: () => now,
	};
}

async function connect(env: World, gateway: ConnectionsService, connectionId?: string): Promise<string> {
	const attempt = await gateway.startConnect(alice, {
		owner: { kind: "user", organisationId: ORG, userId: "alice" },
		mcpUrl: env.provider.mcpUrl,
		...(connectionId === undefined ? {} : { connectionId }),
	});
	const { url } = await gateway.authorize(alice, attempt.id);
	const state = new URL(url).searchParams.get("state")!;
	const done = await gateway.completeConnect(alice, { state, code: env.provider.codeFor(url) });
	expect(done.status).toBe("completed");
	return done.connectionId!;
}

const refreshes = (provider: FakeProvider) =>
	provider.tokenRequests.filter((params) => params.get("grant_type") === "refresh_token").length;

const types = (events: AuditEventInput[]) => events.map((event) => event.type);

/** Past the access token's expiry, as the clock and the server both see it. */
function expire(env: World) {
	env.advance(HOUR + 1);
	env.provider.expireAccessTokens();
}

describe("single-flight refresh", () => {
	it("refreshes once for 20 concurrent requests on an expired token, and every request goes out with the new one", async () => {
		const env = world();
		const gateway = env.gateway("gw_a");
		const id = await connect(env, gateway);
		expire(env);
		env.provider.refreshDelayMs = 25;
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, (_, i) =>
				gateway.callTool(SYSTEM, scope(), id, { name: "whoami", toolCallId: `call_${i}` }),
			),
		);
		expect(results.filter((result) => result.status === "rejected")).toEqual([]);
		expect(refreshes(env.provider)).toBe(1);
		const fresh = `Bearer ${env.provider.issued.access[1]}`;
		// Each tools/call went out with the refreshed token (an MCP call sends initialize, a notification, then the call).
		expect(env.provider.mcpAuthorizations.slice(-60).every((auth) => auth === fresh)).toBe(true);
		expect(types(env.events).filter((type) => type === "connections.connection.refreshed")).toHaveLength(1);
	});

	it("refreshes once for 20 concurrent requests spread over two gateway processes sharing a database", async () => {
		const database: TestDatabase = await pgliteDatabase.open();
		cleanup.push(() => database.close());
		await migrateConnections(database.driver);
		const env = world(createSqlConnectionsRepository(database.driver));
		const a = env.gateway("gw_a");
		const b = env.gateway("gw_b");
		const id = await connect(env, a);
		expire(env);
		env.provider.refreshDelayMs = 40;
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, (_, i) =>
				(i % 2 === 0 ? a : b).callTool(SYSTEM, scope(), id, { name: "whoami", toolCallId: `call_${i}` }),
			),
		);
		expect(results.filter((result) => result.status === "rejected")).toEqual([]);
		// The server rotates refresh tokens: a second refresh with the first token would have been refused.
		expect(refreshes(env.provider)).toBe(1);
		expect((await a.get(alice, id)).health).toMatchObject({ state: "ok" });
		const lease = await env.repository.get<{ holder: string; until: number }>("refresh_lease", id);
		expect(lease?.value.until).toBe(0);
	});

	it("takes over a lease its holder never released, once it runs out", async () => {
		const env = world();
		const gateway = env.gateway("gw_a", { leaseWaitMs: 30 });
		const id = await connect(env, gateway);
		await env.repository.insert("refresh_lease", {
			id,
			organisationId: ORG,
			value: { holder: "gw_dead", until: env.now() + HOUR + 10_000 },
			createdAt: env.now(),
		});
		expire(env);
		// Held by a process that died mid-refresh: refused as retryable, nothing sent.
		const held = await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" }).catch((error: unknown) => error);
		expect(isKantelError(held, "unavailable")).toBe(true);
		expect((held as { details?: unknown }).details).toMatchObject({
			error: "connection_refresh_failing",
			retryable: true,
		});
		expect(refreshes(env.provider)).toBe(0);
		// Once its lease runs out, the next request takes it over and refreshes.
		env.advance(20_000);
		await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" });
		expect(refreshes(env.provider)).toBe(1);
	});
});

describe("the refresh sweep", () => {
	it("refreshes a connection nobody is using once it is within five minutes of expiry, and not before", async () => {
		const env = world();
		const gateway = env.gateway("gw_a");
		const id = await connect(env, gateway);
		const expiresAt = (await gateway.get(alice, id)).credential.expiresAt!;
		// Told when it is next due: five minutes before expiry, the default buffer.
		expect(env.due.at(-1)).toBe(expiresAt - 5 * 60 * 1000);
		expect(await gateway.nextRefreshAt(SYSTEM)).toBe(expiresAt - 5 * 60 * 1000);
		env.advance(HOUR - 6 * 60 * 1000);
		expect(await gateway.sweep(SYSTEM)).toMatchObject({ checked: 1, refreshed: 0, nextDueAt: expiresAt - 300_000 });
		expect(refreshes(env.provider)).toBe(0);
		env.advance(2 * 60 * 1000);
		const swept = await gateway.sweep(SYSTEM);
		expect(swept).toMatchObject({ checked: 1, refreshed: 1, failed: 0 });
		expect(refreshes(env.provider)).toBe(1);
		const after = await gateway.get(alice, id);
		expect(after.credential.expiresAt).toBe(env.now() + HOUR);
		expect(after.health).toMatchObject({ state: "ok", refreshedAt: env.now() });
		expect(swept.nextDueAt).toBe(env.now() + HOUR - 300_000);
	});

	it("is safe to run from two processes at once", async () => {
		const env = world();
		const a = env.gateway("gw_a");
		const b = env.gateway("gw_b");
		await connect(env, a);
		await connect(env, a);
		env.advance(HOUR - 60_000);
		env.provider.refreshDelayMs = 20;
		const [one, two] = await Promise.all([a.sweep(SYSTEM), b.sweep(SYSTEM)]);
		expect(refreshes(env.provider)).toBe(2);
		expect(one.refreshed + two.refreshed).toBe(2);
	});

	it("is for the system only", async () => {
		const env = world();
		await expect(env.gateway("gw_a").sweep(alice as never)).rejects.toMatchObject({ code: "forbidden" });
	});
});

describe("a failing refresh", () => {
	it("marks the connection refresh_failing, backs off, keeps using a token still valid, and recovers", async () => {
		const env = world();
		const gateway = env.gateway("gw_a");
		const id = await connect(env, gateway);
		env.advance(HOUR - 60_000);
		env.provider.refreshAnswer = "unavailable";
		// The token is still good for a minute: the request goes out with it while the refresh fails.
		await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" });
		expect(env.provider.mcpAuthorizations.at(-1)).toBe(`Bearer ${env.provider.issued.access[0]}`);
		let connection = await gateway.get(alice, id);
		expect(connection.status).toBe("active");
		expect(connection.health).toMatchObject({
			state: "refresh_failing",
			failures: 1,
			retryAt: env.now() + 30_000,
		});
		expect(connection.health?.reason).toContain("temporarily_unavailable");
		const failed = env.events.find((event) => event.type === "connections.connection.refresh_failed");
		expect(failed?.data).toMatchObject({ retryable: true, failures: 1 });
		expect(env.due.at(-1)).toBe(env.now() + 30_000);

		// Within the backoff, nothing is tried again.
		await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" });
		expect(await gateway.sweep(SYSTEM)).toMatchObject({ refreshed: 0, failed: 0 });
		expect(refreshes(env.provider)).toBe(1);

		// After it, the sweep tries again and the wait doubles.
		env.advance(30_000);
		expect(await gateway.sweep(SYSTEM)).toMatchObject({ refreshed: 0, failed: 1 });
		connection = await gateway.get(alice, id);
		expect(connection.health).toMatchObject({ state: "refresh_failing", failures: 2, retryAt: env.now() + 60_000 });

		// Once the token has run out, a request is refused as retryable, with nothing sent.
		expire(env);
		env.provider.refreshAnswer = "down";
		const sent = env.provider.mcpAuthorizations.length;
		const refused = await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" }).catch((error: unknown) => error);
		expect(isKantelError(refused, "unavailable")).toBe(true);
		expect((refused as Error).message).toMatch(/^connection_refresh_failing: /);
		expect((refused as { details?: unknown }).details).toMatchObject({
			error: "connection_refresh_failing",
			connectionId: id,
			retryable: true,
		});
		expect(env.provider.mcpAuthorizations.length).toBe(sent);
		expect((await gateway.get(alice, id)).health).toMatchObject({ failures: 3 });

		// The provider is back: the next try after the backoff recovers it.
		env.provider.refreshAnswer = "ok";
		env.advance(refreshBackoffMs(3));
		await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" });
		connection = await gateway.get(alice, id);
		expect(connection.health).toMatchObject({ state: "ok" });
		expect(connection.health?.failures).toBeUndefined();
		const refreshed = env.events.filter((event) => event.type === "connections.connection.refreshed").at(-1);
		expect(refreshed?.data).toMatchObject({ recovered: "refresh_failing" });
	});

	it("backs off 30 s, doubling, to at most 30 minutes", () => {
		expect([1, 2, 3, 4, 7, 20].map(refreshBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 1_800_000, 1_800_000]);
	});
});

describe("connection_reconnect_required", () => {
	it("refuses with a link to reconnect once the provider refuses the refresh token, until a person reconnects it", async () => {
		const env = world();
		const gateway = env.gateway("gw_a");
		const id = await connect(env, gateway);
		expire(env);
		env.provider.refreshAnswer = "refuse";
		const sent = env.provider.mcpAuthorizations.length;
		const refused = await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" }).catch((error: unknown) => error);
		expect(isKantelError(refused, "refused")).toBe(true);
		expect((refused as Error).message).toMatch(/^connection_reconnect_required: /);
		expect((refused as { details?: unknown }).details).toEqual({
			error: "connection_reconnect_required",
			connectionId: id,
			retryable: false,
			link: `https://harbour.test/connections?connection=${id}`,
			reason: expect.stringContaining("invalid_grant"),
		});
		expect(env.provider.mcpAuthorizations.length).toBe(sent);
		const connection = await gateway.get(alice, id);
		expect(connection.status).toBe("needs_reauth");
		expect(connection.health).toMatchObject({ state: "needs_reconnect", failures: 1 });
		expect(types(env.events)).toContain("connections.connection.needs_reconnect");

		// Every request after is refused the same way, before anything is tried, and the use is recorded.
		env.advance(1000);
		const again = await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" }).catch((error: unknown) => error);
		expect((again as { details?: { error?: string } }).details?.error).toBe("connection_reconnect_required");
		expect(refreshes(env.provider)).toBe(1);
		const uses = await gateway.listUses(alice, { connectionId: id });
		expect(uses.items[0]).toMatchObject({ outcome: "denied" });
		// The sweep leaves it alone, and it is announced once.
		expect(await gateway.sweep(SYSTEM)).toMatchObject({ checked: 0 });
		expect(types(env.events).filter((type) => type === "connections.connection.needs_reconnect")).toHaveLength(1);

		// Reconnecting keeps the connection's ID and makes it healthy again.
		env.provider.refreshAnswer = "ok";
		expect(await connect(env, gateway, id)).toBe(id);
		const back = await gateway.get(alice, id);
		expect(back.status).toBe("active");
		expect(back.health).toMatchObject({ state: "ok" });
		await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" });
	});

	it("keeps a reconnected connection's ID, rules and audit history", async () => {
		const env = world();
		const gateway = env.gateway("gw_a");
		const id = await connect(env, gateway);
		const rule = await gateway.createRule(alice, id, {
			who: { kind: "any" },
			what: { kind: "tool", tool: "delete_everything" },
			action: "deny",
		});
		await gateway.callTool(SYSTEM, scope(), id, { name: "whoami", toolCallId: "before" });
		expire(env);
		env.provider.refreshAnswer = "refuse";
		await expect(gateway.callTool(SYSTEM, scope(), id, { name: "whoami" })).rejects.toMatchObject({
			details: { error: "connection_reconnect_required" },
		});
		const history = env.events.filter((event) => event.subject?.id === id).map((event) => event.type);

		env.provider.refreshAnswer = "ok";
		env.advance(1000);
		expect(await connect(env, gateway, id)).toBe(id);
		expect((await gateway.getRules(alice, id)).rules.map((r) => r.id)).toEqual([rule.id]);
		const after = env.events.filter((event) => event.subject?.id === id).map((event) => event.type);
		expect(after.slice(0, history.length)).toEqual(history);
		expect(after).toContain("connections.connection.reconnected");
		const uses = whole(await gateway.listUses(alice, { connectionId: id }));
		expect(uses.map((use) => use.toolCallId)).toContain("before");
		// The rule still decides after the reconnect.
		await expect(gateway.callTool(SYSTEM, scope(), id, { name: "delete_everything" })).rejects.toMatchObject({
			code: "refused",
		});
	});
});

describe("refreshed tokens", () => {
	it("never appear outside the vault and the request that carries them (canary)", async () => {
		const env = world();
		const gateway = env.gateway("gw_a");
		const id = await connect(env, gateway);
		env.provider.echoToken = true;
		const seen: unknown[] = [];
		// A refresh by the sweep, one on demand, one on a 401, then a failing one and a refused one.
		env.advance(HOUR - 60_000);
		seen.push(await gateway.sweep(SYSTEM));
		expire(env);
		seen.push(await gateway.callTool(SYSTEM, scope(), id, { name: "whoami", toolCallId: "due" }));
		env.provider.expireAccessTokens();
		seen.push(await gateway.callTool(SYSTEM, scope(), id, { name: "whoami", toolCallId: "401" }));
		expire(env);
		env.provider.refreshAnswer = "unavailable";
		seen.push(await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" }).catch((error: unknown) => error));
		env.advance(HOUR);
		env.provider.refreshAnswer = "refuse";
		seen.push(await gateway.callTool(SYSTEM, scope(), id, { name: "whoami" }).catch((error: unknown) => error));
		expect(refreshes(env.provider)).toBeGreaterThanOrEqual(4);
		seen.push(
			await gateway.get(alice, id),
			await gateway.list(alice, {}),
			await gateway.listUses(alice, { connectionId: id }),
			await env.repository.list("connection", { organisationId: ORG }),
			await env.repository.get("refresh_lease", id),
			env.events,
		);
		const exposed = JSON.stringify(seen, (_key, value) =>
			value instanceof Error ? { message: value.message, ...(value as { details?: unknown }) } : value,
		);
		const tokens = [...env.provider.issued.access, ...env.provider.issued.refresh];
		// The connect's pair and three refreshed pairs.
		expect(tokens).toHaveLength(8);
		for (const token of tokens) expect(exposed).not.toContain(token);
		// The server did get them: the canary is live, not vacuous.
		expect(env.provider.mcpAuthorizations).toContain(`Bearer ${env.provider.issued.access.at(-1)}`);
	});
});

describe("a token the server refuses before it expires", () => {
	it("refreshes once for 20 concurrent requests that each got a 401, then sends each once more", async () => {
		const env = world();
		const gateway = env.gateway("gw_a");
		const id = await connect(env, gateway);
		// Revoked at the server, though by the clock it has most of an hour left.
		env.provider.expireAccessTokens();
		env.provider.refreshDelayMs = 25;
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, (_, i) => gateway.listTools(SYSTEM, scope({ sessionId: `ses_${i}` }), id)),
		);
		expect(results.filter((result) => result.status === "rejected")).toEqual([]);
		expect(refreshes(env.provider)).toBe(1);
		expect((await gateway.get(alice, id)).health).toMatchObject({ state: "ok" });
	});
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
