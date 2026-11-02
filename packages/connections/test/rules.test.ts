import { type AuditEventInput, type ConnectionSessionScope, type RouteScope, systemContext } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { memoryCredentials } from "../src/memory.ts";
import { createMemoryConnectionsRepository } from "../src/repository.ts";
import type { CeilingStore } from "../src/rules.ts";
import { createConnections } from "../src/service.ts";
import { fakeAccess, human, letEverythingThrough, ORG, whole } from "../src/testing.ts";

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
	const repository = createMemoryConnectionsRepository();
	const audited: AuditEventInput[] = [];
	const connections = createConnections({
		repository,
		audit: { append: async (_ctx, events) => void audited.push(...events) },
		credentials: memoryCredentials(),
		access: fakeAccess(["admin"]),
		deployment: { origin: "https://kantel.test", clientMetadataPublic: false },
		clock: { now: () => now },
		fetch: async (url, init) => {
			sent.push(`${init?.method ?? "GET"} ${String(url)}`);
			return new Response("{}", { headers: { "content-type": "application/json" } });
		},
		...(ceiling === undefined ? {} : { ceiling }),
	});
	return { connections, repository, audited, sent, advance: (ms: number) => (now += ms) };
}

async function github(env: ReturnType<typeof setup>) {
	return env.connections.connectKey(admin, {
		owner: { kind: "organisation", organisationId: ORG },
		templateId: "github",
		value: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
		usage: { unattended: true, visibility: "shared" },
	});
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const send = (env: ReturnType<typeof setup>, id: string, method: Method, url: string, s = scope()) =>
	env.connections.send(SYSTEM, s, id, { method, url, kind: "http" });

/** What the real send does with a request: `allow` when it went out, else `ask` or `deny` from its refusal. */
const outcome = (env: ReturnType<typeof setup>, id: string, method: Method, url: string) =>
	send(env, id, method, url).then(
		() => "allow",
		(error: { code: string; message: string }) => {
			expect(error.code).toBe("refused");
			return error.message.includes("approve") ? "ask" : "deny";
		},
	);

// GitHub classifies its requests (#465), so its defaults are by operation (#466), beside the method defaults that catch
// a request the classification leaves out.
const GITHUB_DEFAULTS = [
	[{ kind: "operation", access: "read" }, "allow", "default"],
	[{ kind: "operation", access: "write" }, "ask", "default"],
	[{ kind: "operation", access: "delete" }, "deny", "default"],
	[{ kind: "operation", access: "admin" }, "ask", "default"],
	[{ kind: "endpoint", method: "GET", path: "/**" }, "allow", "default"],
	[{ kind: "endpoint", method: "*", path: "/**" }, "ask", "default"],
	[{ kind: "endpoint", method: "DELETE", path: "/**" }, "deny", "default"],
	[{ kind: "endpoint", method: "HEAD", path: "/**" }, "allow", "default"],
];

/** A GitHub connection as one made before rules is stored: with no rules record. */
async function githubBeforeRules(env: ReturnType<typeof setup>) {
	const connection = await github(env);
	await env.repository.remove("rules", connection.id);
	env.audited.length = 0;
	return connection;
}

describe("connection rules", () => {
	it("gives a new connection its template's defaults: reads allow, writes ask, deletes are blocked", async () => {
		const env = setup();
		const connection = await github(env);
		const rules = await env.connections.getRules(admin, connection.id);
		expect(rules).toMatchObject({
			unmatched: "ask",
			version: 1,
			defaults: { reason: "created", at: 1_000_000 },
		});
		expect(rules.rules.map((rule) => [rule.what, rule.action, rule.source])).toEqual(GITHUB_DEFAULTS);
		const cases = [
			["GET", "https://api.github.com/repos/acme/x/issues", "allow"],
			["POST", "https://api.github.com/repos/acme/x/issues", "ask"],
			["PATCH", "https://api.github.com/repos/acme/x", "ask"],
			["DELETE", "https://api.github.com/repos/acme/x", "deny"],
			// A GraphQL request with no query to read is taken for a mutation: it asks.
			["POST", "https://api.github.com/graphql", "ask"],
		] as const;
		for (const [method, url, action] of cases) {
			expect((await env.connections.dryRun(admin, connection.id, { method, url })).action).toBe(action);
			expect(await outcome(env, connection.id, method, url)).toBe(action);
		}
		// The key's test request at connect, then the one read: nothing that asks or is blocked went out.
		expect(env.sent).toEqual(["GET https://api.github.com/user", "GET https://api.github.com/repos/acme/x/issues"]);
		expect(env.audited.find((event) => event.type === "connections.rules.defaulted")).toMatchObject({
			subject: { kind: "connection", id: connection.id },
			actor: { kind: "human", userId: "admin" },
			data: { reason: "created", unmatched: "ask", version: 1 },
		});
	});

	it("gives a connection made before rules its template's defaults on first read, once, and audits it", async () => {
		const env = setup();
		const connection = await githubBeforeRules(env);
		env.advance(5_000);
		// The dry run is the first read: it already answers under the defaults.
		const dry = await env.connections.dryRun(admin, connection.id, {
			method: "DELETE",
			url: "https://api.github.com/repos/acme/x",
		});
		expect(dry).toMatchObject({ action: "deny", by: { kind: "rule" }, rulesVersion: 1 });
		const rules = await env.connections.getRules(admin, connection.id);
		expect(rules).toMatchObject({ unmatched: "ask", version: 1, defaults: { reason: "migrated", at: 1_005_000 } });
		expect(rules.rules.map((rule) => [rule.what, rule.action, rule.source])).toEqual(GITHUB_DEFAULTS);
		expect(await outcome(env, connection.id, "GET", "https://api.github.com/user")).toBe("allow");
		expect(await outcome(env, connection.id, "POST", "https://api.github.com/repos/acme/x/issues")).toBe("ask");
		expect(await outcome(env, connection.id, "DELETE", "https://api.github.com/repos/acme/x")).toBe("deny");
		const defaulted = env.audited.filter((event) => event.type === "connections.rules.defaulted");
		expect(defaulted).toHaveLength(1);
		expect(defaulted[0]).toMatchObject({
			actor: { kind: "system", component: "connections" },
			data: { reason: "migrated", before: { unmatched: "allow", rules: 0, version: 0 } },
		});
	});

	it("migrates every connection made before rules on the first sweep, and leaves rules a person edited alone", async () => {
		const env = setup();
		const before = await githubBeforeRules(env);
		const edited = await github(env);
		await letEverythingThrough(env.connections, admin, edited.id);
		const editedRules = await env.connections.getRules(admin, edited.id);
		expect(editedRules).toMatchObject({ rules: [], unmatched: "allow" });
		await env.connections.sweep(SYSTEM);
		expect(await env.repository.get("rules", before.id)).toMatchObject({
			value: { unmatched: "ask", version: 1, defaults: { reason: "migrated" } },
		});
		// Edited: unchanged, and still letting everything through, which the console warns about.
		expect(await env.connections.getRules(admin, edited.id)).toEqual(editedRules);
		expect(await outcome(env, edited.id, "DELETE", "https://api.github.com/repos/acme/x")).toBe("allow");
	});

	it("settles two instances giving the same connection its defaults at once on one set", async () => {
		const env = setup();
		const connection = await githubBeforeRules(env);
		const [a, b] = await Promise.all([
			env.connections.getRules(admin, connection.id),
			env.connections.dryRun(admin, connection.id, { method: "GET", url: "https://api.github.com/user" }),
		]);
		expect(b.rulesVersion).toBe(a.version);
		expect(await env.connections.getRules(admin, connection.id)).toEqual(a);
		expect(env.audited.filter((event) => event.type === "connections.rules.defaulted")).toHaveLength(1);
	});

	it("gives an API connection with no template the method defaults", async () => {
		const env = setup();
		const custom = await env.connections.connectKey(admin, {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "bearer" }, kind: "http" },
			value: "a-long-enough-key-0001",
			usage: { unattended: true, visibility: "shared" },
		});
		const rules = await env.connections.getRules(admin, custom.id);
		expect(rules.rules.map((rule) => [rule.what, rule.action])).toEqual([
			[{ kind: "endpoint", method: "GET", path: "/**" }, "allow"],
			[{ kind: "endpoint", method: "HEAD", path: "/**" }, "allow"],
			[{ kind: "endpoint", method: "DELETE", path: "/**" }, "deny"],
		]);
		const put = await env.connections.dryRun(admin, custom.id, { method: "PUT", url: "https://api.example.com/x" });
		expect(put).toMatchObject({ action: "ask", by: { kind: "unmatched" } });
	});

	it("enforces rules on the real send exactly as the dry run decides, and records the deciding rule", async () => {
		const env = setup();
		const connection = await github(env);
		await letEverythingThrough(env.connections, admin, connection.id);
		const reset = await env.connections.updateRules(admin, connection.id, { reset: "template" });
		expect(reset.unmatched).toBe("ask");
		expect(reset.defaults).toEqual({ reason: "reset", at: 1_000_000 });
		expect(reset.rules.map((rule) => [rule.what, rule.action, rule.source])).toEqual(GITHUB_DEFAULTS);
		const deny = await env.connections.createRule(admin, connection.id, {
			who: { kind: "agent", agentId: "triage" },
			what: { kind: "endpoint", method: "PUT", path: "/repos/**" },
			action: "deny",
			note: "Never replace",
		});
		const cases = [
			["GET", "https://api.github.com/repos/acme/x/issues", "allow"],
			["POST", "https://api.github.com/repos/acme/x/issues", "ask"],
			["PUT", "https://api.github.com/repos/acme/x/topics", "deny"],
			["DELETE", "https://api.github.com/repos/acme/x", "deny"],
		] as const;
		for (const [method, url, action] of cases) {
			const decision = await env.connections.dryRun(admin, connection.id, { method, url, agentId: "triage" });
			expect(decision.action).toBe(action);
			expect(await outcome(env, connection.id, method, url)).toBe(action);
		}
		const uses = whole(await env.connections.listUses(admin, { connectionId: connection.id }));
		const denied = uses.find((use) => use.method === "PUT");
		expect(denied).toMatchObject({ outcome: "denied", decision: "deny", decidedBy: "rule", ruleId: deny.id });
		expect(uses.find((use) => use.method === "DELETE")).toMatchObject({ outcome: "denied", decision: "deny" });
		expect(uses.find((use) => use.outcome === "allowed")).toMatchObject({ decision: "allow", decidedBy: "rule" });
		// Another agent isn't covered by the agent's deny: the template's write rule asks.
		expect(
			(
				await env.connections.dryRun(admin, connection.id, {
					method: "PUT",
					url: "https://api.github.com/repos/acme/x/topics",
					agentId: "other",
				})
			).action,
		).toBe("ask");
	});

	it("refuses a path the rules can't judge, on the send and the dry run alike, only once there are rules", async () => {
		const env = setup();
		const connection = await github(env);
		const sneaky = "https://api.github.com/repos/acme%2Fsecret/web";
		// With every rule removed and unmatched allowed, as before rules: it goes out.
		await letEverythingThrough(env.connections, admin, connection.id);
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
	});

	it("refuses an agent every change to the rules, even in an admin's organisation, and leaves them as they were", async () => {
		const env = setup();
		const connection = await github(env);
		const rule = await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "DELETE", path: "/repos/**" },
			action: "deny",
		});
		const before = await env.connections.getRules(admin, connection.id);
		const agent = { ...admin, actor: { kind: "agent", agentId: "assistant", sessionId: "ses_1" } } as never;
		const allowAll = { who: { kind: "any" }, what: { kind: "any" }, action: "allow" } as const;
		for (const attempt of [
			() => env.connections.createRule(agent, connection.id, allowAll),
			() => env.connections.updateRule(agent, connection.id, rule.id, { action: "allow" }),
			() => env.connections.removeRule(agent, connection.id, rule.id),
			() => env.connections.updateRules(agent, connection.id, { unmatched: "allow" }),
			() => env.connections.updateRules(agent, connection.id, { reset: "template" }),
		]) {
			// An agent doesn't reach the connection through the people's routes at all, or is refused managing it.
			const error = await attempt().then(
				() => undefined,
				(caught: { code?: string }) => caught,
			);
			expect(["forbidden", "not_found"]).toContain(error?.code);
		}
		expect(await env.connections.getRules(admin, connection.id)).toEqual(before);
		await expect(send(env, connection.id, "DELETE", "https://api.github.com/repos/acme/x")).rejects.toThrow(/blocked/);
		expect(env.sent).not.toContain("DELETE https://api.github.com/repos/acme/x");
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
		// Its defaults allow reads, yet the ceiling still refuses.
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

	describe("a GitHub connection with the method defaults it had before operation rules (#466)", () => {
		/** As #485 left it: the method defaults alone, version 1. */
		async function methodDefaultsOnly(
			env: ReturnType<typeof setup>,
			shape?: (rules: unknown[]) => unknown[],
			unmatched = "ask",
		) {
			const connection = await github(env);
			const stored = (await env.repository.get("rules", connection.id)) as {
				value: { rules: { what: { kind: string } }[] };
			};
			const endpoint = stored.value.rules.filter((rule) => rule.what.kind === "endpoint");
			await env.repository.remove("rules", connection.id);
			await env.repository.insert("rules", {
				id: connection.id,
				organisationId: ORG,
				key: connection.id,
				value: { ...stored.value, rules: shape === undefined ? endpoint : shape(endpoint), unmatched, version: 1 },
				createdAt: 1_000_000,
			} as never);
			env.audited.length = 0;
			return connection;
		}
		const graphqlQuery = {
			method: "POST" as const,
			url: "https://api.github.com/graphql",
			body: '{"query":"{ viewer { login } }"}',
		};

		it("gets GitHub's operation defaults once, audited, so a GraphQL query reads", async () => {
			const env = setup();
			const connection = await methodDefaultsOnly(env);
			const rules = await env.connections.getRules(admin, connection.id);
			expect(rules.version).toBe(2);
			expect(rules.rules.filter((rule) => rule.what.kind === "operation")).toHaveLength(4);
			expect((await env.connections.dryRun(admin, connection.id, graphqlQuery)).action).toBe("allow");
			await env.connections.getRules(admin, connection.id);
			const defaulted = env.audited.filter((event) => event.type === "connections.rules.defaulted");
			expect(defaulted).toHaveLength(1);
			expect(defaulted[0]).toMatchObject({ data: { reason: "operations", version: 2 } });
		});

		it("is left alone once someone shaped it: a default removed, or unmatched changed", async () => {
			const env = setup();
			const removed = await methodDefaultsOnly(env, (rules) =>
				rules.filter((rule) => (rule as { what: { method: string } }).what.method === "DELETE"),
			);
			const denying = await methodDefaultsOnly(env, undefined, "deny");
			for (const connection of [removed, denying]) {
				const rules = await env.connections.getRules(admin, connection.id);
				expect(rules.version).toBe(1);
				expect(rules.rules.some((rule) => rule.what.kind === "operation")).toBe(false);
				expect((await env.connections.dryRun(admin, connection.id, graphqlQuery)).action).not.toBe("allow");
			}
			expect(env.audited.filter((event) => event.type === "connections.rules.defaulted")).toHaveLength(0);
		});
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
		// The write rule reaches outside it, and so do the operation rules that allow or ask, since a read can be a POST
		// (a GraphQL query); a deny is never bounded.
		const words = (rule: (typeof reset.rules)[number]) =>
			rule.what.kind === "endpoint" ? rule.what.method : rule.what.kind === "operation" ? rule.what.access : "";
		expect(reset.rules.map((rule) => [words(rule), rule.action])).toEqual([
			["delete", "deny"],
			["GET", "allow"],
			["DELETE", "deny"],
			["HEAD", "allow"],
		]);
	});

	it("says it has no ceiling where the deployment keeps none", async () => {
		const env = setup({ ceiling: "none" });
		expect(await env.connections.getCeiling(admin)).toEqual({ set: false, routes: [] });
		await expect(env.connections.setCeiling(admin, [])).rejects.toMatchObject({ code: "not_supported" });
	});

	it("edits and removes rules, bumping the version each time but not on a use", async () => {
		const env = setup();
		const connection = await github(env);
		await letEverythingThrough(env.connections, admin, connection.id);
		const base = (await env.connections.getRules(admin, connection.id)).version;
		const rule = await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "GET", path: "/user" },
			action: "allow",
			maxUses: 2,
		});
		expect((await env.connections.getRules(admin, connection.id)).version).toBe(base + 1);
		await send(env, connection.id, "GET", "https://api.github.com/user");
		const afterUse = await env.connections.getRules(admin, connection.id);
		expect(afterUse.version).toBe(base + 1);
		expect(afterUse.rules[0]?.uses).toBe(1);
		await send(env, connection.id, "GET", "https://api.github.com/user");
		// Used up: the request falls to unmatched (allow, as set above), and the rule no longer decides.
		const third = await env.connections.dryRun(admin, connection.id, {
			method: "GET",
			url: "https://api.github.com/user",
		});
		expect(third.by.kind).toBe("unmatched");
		const edited = await env.connections.updateRule(admin, connection.id, rule.id, { maxUses: null, action: "deny" });
		expect(edited).toMatchObject({ action: "deny", uses: 2 });
		expect(edited.maxUses).toBeUndefined();
		expect((await env.connections.getRules(admin, connection.id)).version).toBe(base + 2);
		await env.connections.removeRule(admin, connection.id, rule.id);
		expect(await env.connections.getRules(admin, connection.id)).toMatchObject({ rules: [], version: base + 3 });
		await expect(env.connections.removeRule(admin, connection.id, rule.id)).rejects.toMatchObject({
			code: "not_found",
		});
	});

	it("lets an expired rule stop matching", async () => {
		const env = setup();
		const connection = await github(env);
		await letEverythingThrough(env.connections, admin, connection.id);
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
		expect((await env.connections.getRules(admin, connection.id)).rules.map((rule) => rule.source)).not.toContain(
			"approval",
		);
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
