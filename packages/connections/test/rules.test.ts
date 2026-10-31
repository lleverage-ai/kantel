import { type ConnectionSessionScope, type RouteScope, systemContext } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryConnections, memoryCredentials } from "../src/memory.ts";
import type { CeilingStore } from "../src/rules.ts";
import { fakeAccess, human, ORG } from "../src/testing.ts";

const SYSTEM = systemContext("test");
const admin = human("admin");
const alice = human("alice");

const scope = (overrides: Partial<ConnectionSessionScope> = {}): ConnectionSessionScope => ({
	organisationId: ORG,
	sessionId: "ses_1",
	agentId: "triage",
	actingUserId: "admin",
	audience: { kind: "shared" },
	...overrides,
});

function setup(options: { ceiling?: readonly RouteScope[] | "none" } = {}) {
	const sent: string[] = [];
	let routes: readonly RouteScope[] | undefined = options.ceiling === "none" ? undefined : options.ceiling;
	const ceiling: CeilingStore | undefined =
		options.ceiling === "none"
			? undefined
			: {
					get: async () => routes,
					set: async (_ctx, next) => {
						routes = next;
						return next;
					},
				};
	let now = 1_000_000;
	const connections = createMemoryConnections({
		credentials: memoryCredentials(),
		access: fakeAccess(["admin"]),
		deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
		clock: { now: () => now },
		fetch: async (url, init) => {
			sent.push(`${init?.method ?? "GET"} ${String(url)}`);
			return new Response("{}", { headers: { "content-type": "application/json" } });
		},
		...(ceiling === undefined ? {} : { ceiling }),
	});
	return { connections, sent, advance: (ms: number) => (now += ms) };
}

async function github(env: ReturnType<typeof setup>) {
	return env.connections.connectKey(admin, {
		owner: { kind: "organisation", organisationId: ORG },
		templateId: "github",
		value: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
		usage: { unattended: true, visibility: "shared" },
	});
}

const send = (env: ReturnType<typeof setup>, id: string, method: "GET" | "POST" | "DELETE", url: string, s = scope()) =>
	env.connections.send(SYSTEM, s, id, { method, url, kind: "http" });

describe("connection rules", () => {
	it("leaves a connection made before rules as it was: everything allowed, version 0", async () => {
		const env = setup();
		const connection = await github(env);
		expect(await env.connections.getRules(admin, connection.id)).toEqual({
			connectionId: connection.id,
			rules: [],
			unmatched: "allow",
			version: 0,
		});
		await send(env, connection.id, "DELETE", "https://api.github.com/repos/acme/x");
		expect(env.sent.at(-1)).toBe("DELETE https://api.github.com/repos/acme/x");
	});

	it("enforces rules on the real send exactly as the dry run decides, and records the deciding rule", async () => {
		const env = setup();
		const connection = await github(env);
		const reset = await env.connections.updateRules(admin, connection.id, { reset: "template" });
		expect(reset.unmatched).toBe("ask");
		expect(reset.rules.map((rule) => [rule.what, rule.action, rule.source])).toEqual([
			[{ kind: "endpoint", method: "GET", path: "/**" }, "allow", "default"],
			[{ kind: "endpoint", method: "*", path: "/**" }, "ask", "default"],
		]);
		const deny = await env.connections.createRule(admin, connection.id, {
			who: { kind: "agent", agentId: "triage" },
			what: { kind: "endpoint", method: "DELETE", path: "/repos/**" },
			action: "deny",
			note: "Never delete",
		});
		const cases = [
			["GET", "https://api.github.com/repos/acme/x/issues", "allow"],
			["POST", "https://api.github.com/repos/acme/x/issues", "ask"],
			["DELETE", "https://api.github.com/repos/acme/x", "deny"],
		] as const;
		for (const [method, url, action] of cases) {
			const decision = await env.connections.dryRun(admin, connection.id, { method, url, agentId: "triage" });
			expect(decision.action).toBe(action);
			const real = await send(env, connection.id, method, url).then(
				() => "allow",
				(error: { code: string; message: string }) => {
					expect(error.code).toBe("refused");
					return error.message.includes("approve") ? "ask" : "deny";
				},
			);
			expect(real).toBe(action);
		}
		const uses = await env.connections.listUses(admin, { connectionId: connection.id });
		const denied = uses.items.find((use) => use.method === "DELETE");
		expect(denied).toMatchObject({ outcome: "denied", decision: "deny", decidedBy: "rule", ruleId: deny.id });
		expect(uses.items.find((use) => use.outcome === "allowed")).toMatchObject({ decision: "allow", decidedBy: "rule" });
		// Another agent isn't covered by the agent's deny: the template's write rule asks.
		expect(
			(
				await env.connections.dryRun(admin, connection.id, {
					method: "DELETE",
					url: "https://api.github.com/repos/acme/x",
					agentId: "other",
				})
			).action,
		).toBe("ask");
	});

	it("refuses a path the rules can't judge, on the send and the dry run alike, only once there are rules", async () => {
		const env = setup();
		const connection = await github(env);
		const sneaky = "https://api.github.com/repos/acme%2Fsecret/web";
		// Before rules, as before: it goes out.
		await send(env, connection.id, "GET", sneaky);
		await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "*", path: "/repos/acme/secret/**" },
			action: "deny",
		});
		const decision = await env.connections.dryRun(admin, connection.id, { method: "GET", url: sneaky });
		expect(decision).toMatchObject({ action: "deny", by: { kind: "connection" } });
		await expect(send(env, connection.id, "GET", sneaky)).rejects.toMatchObject({ code: "refused" });
		// Case and doubled slashes don't get past the deny either.
		for (const url of [
			"https://api.github.com/repos/ACME/Secret/web",
			"https://api.github.com/repos//acme/secret/web",
			"https://api.github.com/repos/%61cme/secret/web",
		]) {
			expect((await env.connections.dryRun(admin, connection.id, { method: "GET", url })).action).toBe("deny");
			await expect(send(env, connection.id, "GET", url)).rejects.toMatchObject({ code: "refused" });
		}
	});

	it("checks a rule before saving it", async () => {
		const env = setup();
		const connection = await github(env);
		const bad = [
			{ who: { kind: "any" }, what: { kind: "endpoint", method: "GET", path: "repos" }, action: "allow" },
			{ who: { kind: "any" }, what: { kind: "tool", tool: "x" }, action: "allow" },
			{
				who: { kind: "any" },
				what: { kind: "endpoint", method: "GET", path: "/", host: "evil.test" },
				action: "allow",
			},
			{ who: { kind: "any" }, what: { kind: "any" }, action: "maybe" },
			{ who: { kind: "any" }, what: { kind: "any" }, action: "allow", maxUses: 0 },
			{ who: { kind: "any" }, what: { kind: "any" }, action: "allow", expiresAt: 1 },
		];
		for (const input of bad) {
			await expect(env.connections.createRule(admin, connection.id, input as never)).rejects.toMatchObject({
				code: "invalid",
			});
		}
		// Only who may manage the connection may change its rules.
		await expect(
			env.connections.createRule(alice, connection.id, {
				who: { kind: "any" },
				what: { kind: "any" },
				action: "allow",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			env.connections.createRule(
				{ ...admin, actor: { kind: "agent", agentId: "a", sessionId: "s" } } as never,
				connection.id,
				{
					who: { kind: "any" },
					what: { kind: "any" },
					action: "allow",
				},
			),
		).rejects.toBeDefined();
	});

	it("refuses a rule the organisation's ceiling doesn't cover, and a request outside it whatever the rules say", async () => {
		const env = setup({ ceiling: [{ host: "api.github.com", methods: ["GET"], pathPrefix: "/repos" }] });
		const connection = await github(env);
		await expect(
			env.connections.createRule(admin, connection.id, {
				who: { kind: "any" },
				what: { kind: "endpoint", method: "POST", path: "/repos/**" },
				action: "allow",
			}),
		).rejects.toMatchObject({ code: "refused" });
		// A deny is never bounded.
		await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "POST", path: "/repos/**" },
			action: "deny",
		});
		// The connection was made before rules, so it allows unmatched, yet the ceiling still refuses.
		const decision = await env.connections.dryRun(admin, connection.id, {
			method: "GET",
			url: "https://api.github.com/user",
		});
		expect(decision).toMatchObject({ action: "deny", by: { kind: "ceiling" } });
		await expect(send(env, connection.id, "GET", "https://api.github.com/user")).rejects.toMatchObject({
			code: "refused",
		});
		expect(await env.connections.getCeiling(admin)).toMatchObject({ set: true });
		await expect(env.connections.setCeiling(alice, [])).rejects.toMatchObject({ code: "forbidden" });
		expect(await env.connections.setCeiling(admin, [])).toEqual({ set: true, routes: [] });
	});

	it("drops template defaults the ceiling doesn't cover on a reset", async () => {
		const env = setup({
			ceiling: ["api.github.com", "uploads.github.com"].map((host) => ({
				host,
				methods: ["GET", "HEAD"] as const,
				pathPrefix: "/",
			})),
		});
		const connection = await github(env);
		const reset = await env.connections.updateRules(admin, connection.id, { reset: "template" });
		expect(reset.rules.map((rule) => rule.action)).toEqual(["allow"]);
	});

	it("says it has no ceiling where the deployment keeps none", async () => {
		const env = setup({ ceiling: "none" });
		expect(await env.connections.getCeiling(admin)).toEqual({ set: false, routes: [] });
		await expect(env.connections.setCeiling(admin, [])).rejects.toMatchObject({ code: "not_supported" });
	});

	it("edits and removes rules, bumping the version each time but not on a use", async () => {
		const env = setup();
		const connection = await github(env);
		const rule = await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "GET", path: "/user" },
			action: "allow",
			maxUses: 2,
		});
		expect((await env.connections.getRules(admin, connection.id)).version).toBe(1);
		await send(env, connection.id, "GET", "https://api.github.com/user");
		const afterUse = await env.connections.getRules(admin, connection.id);
		expect(afterUse.version).toBe(1);
		expect(afterUse.rules[0]?.uses).toBe(1);
		await send(env, connection.id, "GET", "https://api.github.com/user");
		// Used up: the request falls to unmatched (allow, from before rules), and the rule no longer decides.
		const third = await env.connections.dryRun(admin, connection.id, {
			method: "GET",
			url: "https://api.github.com/user",
		});
		expect(third.by.kind).toBe("unmatched");
		const edited = await env.connections.updateRule(admin, connection.id, rule.id, { maxUses: null, action: "deny" });
		expect(edited).toMatchObject({ action: "deny", uses: 2 });
		expect(edited.maxUses).toBeUndefined();
		expect((await env.connections.getRules(admin, connection.id)).version).toBe(2);
		await env.connections.removeRule(admin, connection.id, rule.id);
		expect(await env.connections.getRules(admin, connection.id)).toMatchObject({ rules: [], version: 3 });
		await expect(env.connections.removeRule(admin, connection.id, rule.id)).rejects.toMatchObject({
			code: "not_found",
		});
	});

	it("lets an expired rule stop matching", async () => {
		const env = setup();
		const connection = await github(env);
		await env.connections.updateRules(admin, connection.id, { unmatched: "deny" });
		await env.connections.createRule(admin, connection.id, {
			who: { kind: "session", sessionId: "ses_1" },
			what: { kind: "any" },
			action: "allow",
			expiresAt: 1_000_000 + 60_000,
		});
		await send(env, connection.id, "GET", "https://api.github.com/user");
		env.advance(60_000);
		await expect(send(env, connection.id, "GET", "https://api.github.com/user")).rejects.toMatchObject({
			code: "refused",
		});
	});

	// Saving one with approvals is in approvals.test.ts, which checks the approval it names.
	it("refuses an approval's always-allow on a deployment with no approvals to check it against", async () => {
		const env = setup();
		const connection = await github(env);
		await expect(
			env.connections.createRuleFromApproval(
				admin,
				connection.id,
				{
					who: { kind: "agent", agentId: "triage" },
					what: { kind: "endpoint", method: "POST", path: "/repos/*/issues" },
					action: "allow",
				},
				"apr_1",
			),
		).rejects.toMatchObject({ code: "refused" });
		expect((await env.connections.getRules(admin, connection.id)).rules).toHaveLength(0);
	});

	it("keeps usage the hard outer layer: a rule can't open a personal connection to a shared session", async () => {
		const env = setup();
		const mine = await env.connections.connectKey(alice, {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			custom: { hosts: ["api.example.com"], injection: { kind: "bearer" }, kind: "http" },
			value: "a-long-enough-key-0001",
		});
		await env.connections.createRule(alice, mine.id, { who: { kind: "any" }, what: { kind: "any" }, action: "allow" });
		const decision = await env.connections.dryRun(alice, mine.id, {
			method: "GET",
			url: "https://api.example.com/",
			audience: "shared",
		});
		expect(decision).toMatchObject({ action: "deny", by: { kind: "usage" } });
		const own = await env.connections.dryRun(alice, mine.id, {
			method: "GET",
			url: "https://api.example.com/",
			audience: "private",
		});
		expect(own.action).toBe("allow");
	});
});
