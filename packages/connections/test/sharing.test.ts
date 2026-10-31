/**
 * Sharing a person's connection with a project, and what a session's visibility lets it use (#335): only the owner
 * shares, into a project where they run sessions; any attended session there may then use it, recorded as a use
 * through the share; unattended sessions never; the owner or the project's admin stops it, and the next request is
 * refused and recorded.
 */
import type {
	AuditEventInput,
	CallContext,
	Connection,
	ConnectionSessionScope,
	ProjectAccess,
	SessionDirectory,
	SessionRecord,
} from "@kantel/contracts";
import { isRedactedUse, KantelError } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryConnections } from "../src/memory.ts";
import { fakeProvider, human, letEverythingThrough, ORG, whole } from "../src/testing.ts";
import { connectionTools } from "../src/tools.ts";

const alice = human("alice");
const bob = human("bob");
const carol = human("carol");
const SYSTEM: CallContext = { actor: { kind: "system", component: "test" }, organisationId: ORG };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agt_1", sessionId: "ses_a" },
	organisationId: ORG,
};

/** Roles per person per project; `org` for an organisation-wide check. */
const ROLES: Record<string, Record<string, "viewer" | "operator" | "admin">> = {
	alice: { prj_a: "operator", prj_b: "viewer" },
	bob: { prj_a: "operator" },
	carol: { prj_a: "admin", org: "admin" },
};
const RANK = { viewer: 0, operator: 1, admin: 2 } as const;

/**
 * As `createProjectAccess` for these people. With `sessions`, a check naming a session resolves to its project, and a
 * private one opens only to its person, as #335 has it.
 */
function access(sessions?: ReadonlyMap<string, SessionRecord>): ProjectAccess {
	const passes = (
		ctx: CallContext,
		check: {
			readonly projectId?: string;
			readonly sessionId?: string;
			readonly userId?: string;
			readonly needed: string;
		},
	): boolean => {
		if (ctx.actor.kind === "system") return true;
		if (ctx.actor.kind !== "human") return false;
		if (check.sessionId !== undefined && sessions !== undefined) {
			const target = sessions.get(check.sessionId);
			if (target === undefined) return false;
			if (target.visibility === "private" && target.userId !== ctx.actor.userId) return false;
			const { sessionId: _sessionId, ...rest } = check;
			return passes(ctx, { ...rest, ...(target.projectId === undefined ? {} : { projectId: target.projectId }) });
		}
		if (check.userId !== undefined) return check.userId === ctx.actor.userId;
		const role = ROLES[ctx.actor.userId]?.[check.projectId ?? "org"];
		if (role === undefined) return check.projectId === undefined && check.needed === "viewer";
		return RANK[role] >= RANK[check.needed as keyof typeof RANK];
	};
	return {
		async require(ctx, check) {
			if (!passes(ctx, check)) throw new KantelError("forbidden", "no");
			return { scope: { kind: "organisation", organisationId: ctx.organisationId } } as never;
		},
		async allows(ctx, check) {
			return passes(ctx, check);
		},
		async resource() {
			throw new KantelError("forbidden", "no");
		},
		async allowsResource() {
			return undefined;
		},
	};
}

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
	id: "ses_1",
	organisationId: ORG,
	projectId: "prj_a",
	agentId: "agt_1",
	userId: "bob",
	status: "idle",
	labels: {},
	createdBy: bob.actor,
	createdAt: 0,
	updatedAt: 0,
	...overrides,
});

const scope = (overrides: Partial<ConnectionSessionScope> = {}): ConnectionSessionScope => ({
	organisationId: ORG,
	projectId: "prj_a",
	sessionId: "ses_1",
	agentId: "agt_1",
	actingUserId: "bob",
	audience: { kind: "shared" },
	...overrides,
});

function setup(options: { readonly personal?: boolean } = {}) {
	const provider = fakeProvider();
	const events: AuditEventInput[] = [];
	const sessions = new Map<string, SessionRecord>();
	let now = 1_000_000;
	const directory: Pick<SessionDirectory, "get"> = {
		async get(_ctx, sessionId) {
			const found = sessions.get(sessionId);
			if (found === undefined) throw new KantelError("not_found", `No session ${sessionId}`);
			return found;
		},
	};
	const connections = createMemoryConnections({
		fetch: provider.fetch,
		access: access(sessions),
		audit: { append: async (_ctx, batch) => void events.push(...batch) },
		deployment: {
			origin: "https://harbour.test",
			clientMetadataPublic: false,
			...(options.personal === true ? { personal: true } : {}),
		},
		clock: { now: () => now },
		sessions: directory,
	});
	return { provider, connections, events, sessions, tick: () => (now += 1000) };
}

async function connectAlice(env: ReturnType<typeof setup>): Promise<string> {
	const attempt = await env.connections.startConnect(alice, {
		owner: { kind: "user", organisationId: ORG, userId: "alice" },
		mcpUrl: env.provider.mcpUrl,
	});
	const { url } = await env.connections.authorize(alice, attempt.id);
	const state = new URL(url).searchParams.get("state")!;
	const done = await env.connections.completeConnect(alice, { state, code: env.provider.codeFor(url) });
	// These tests are about who may use it, not what it may do: no rules, every tool call allowed.
	await letEverythingThrough(env.connections, alice, done.connectionId!);
	return done.connectionId!;
}

describe("sharing a person's connection with a project", () => {
	it("lets only its owner share it, into a project where they run sessions", async () => {
		const env = setup();
		const id = await connectAlice(env);
		await expect(env.connections.share(agent, id, "prj_a")).rejects.toMatchObject({ code: "forbidden" });
		// An admin sees it exists, but can't share it.
		await expect(env.connections.share(carol, id, "prj_a")).rejects.toMatchObject({ code: "forbidden" });
		// Alice is only a viewer in prj_b.
		await expect(env.connections.share(alice, id, "prj_b")).rejects.toMatchObject({ code: "forbidden" });
		const shared = await env.connections.share(alice, id, "prj_a");
		expect(shared.shares).toEqual([{ projectId: "prj_a", sharedBy: alice.actor, sharedAt: 1_000_000 }]);
		// Sharing again changes nothing and audits nothing.
		await env.connections.share(alice, id, "prj_a");
		const audited = env.events.filter((event) => event.type === "connections.connection.shared");
		expect(audited).toHaveLength(1);
		expect(audited[0]).toMatchObject({
			projectId: "prj_a",
			actor: alice.actor,
			subject: { kind: "connection", id },
			data: { project: "prj_a", owner: "user" },
		});
	});

	it("refuses to share a project's or the organisation's connection", async () => {
		const env = setup();
		const attempt = await env.connections.startConnect(carol, {
			owner: { kind: "project", organisationId: ORG, projectId: "prj_a" },
			mcpUrl: env.provider.mcpUrl,
		});
		const { url } = await env.connections.authorize(carol, attempt.id);
		const state = new URL(url).searchParams.get("state")!;
		const done = await env.connections.completeConnect(carol, { state, code: env.provider.codeFor(url) });
		await expect(env.connections.share(carol, done.connectionId!, "prj_a")).rejects.toMatchObject({
			code: "invalid",
		});
	});

	it("lets any attended session in the project use it, and records the use as through the share", async () => {
		const env = setup();
		const id = await connectAlice(env);
		// Before sharing: bob's shared session in prj_a can't, and the refusal is recorded.
		expect(await env.connections.usable(SYSTEM, scope())).toEqual([]);
		await expect(env.connections.callTool(SYSTEM, scope(), id, { name: "whoami" })).rejects.toMatchObject({
			code: "forbidden",
		});
		env.tick();
		await env.connections.share(alice, id, "prj_a");
		const usable = await env.connections.usable(SYSTEM, scope());
		expect(usable.map((connection) => connection.id)).toEqual([id]);
		await env.connections.callTool(SYSTEM, scope(), id, { name: "whoami", toolCallId: "call_1" });
		const uses = whole(await env.connections.listUses(alice, { connectionId: id }));
		expect(uses[0]).toMatchObject({ outcome: "allowed", viaShare: true, actingUserId: "bob", toolCallId: "call_1" });
		expect(uses[1]).toMatchObject({ outcome: "denied" });
		expect(uses[1]?.reason).toMatch(/isn't shared here/);
		// Bob sees the connection now it reaches his project, but can't share it on or remove it.
		expect((await env.connections.get(bob, id)).id).toBe(id);
		await expect(env.connections.share(bob, id, "prj_a")).rejects.toMatchObject({ code: "forbidden" });
		await expect(env.connections.remove(bob, id)).rejects.toMatchObject({ code: "forbidden" });
		// Alice's own private session is not a use through the share.
		const own = scope({ actingUserId: "alice", audience: { kind: "private", userId: "alice" } });
		env.tick();
		await env.connections.callTool(SYSTEM, own, id, { name: "whoami" });
		const latest = whole(await env.connections.listUses(alice, { connectionId: id }))[0];
		expect(latest?.outcome).toBe("allowed");
		expect(latest?.viaShare).toBeUndefined();
	});

	it("never reaches an unattended session or another project, shared or not", async () => {
		const env = setup();
		const id = await connectAlice(env);
		await env.connections.share(alice, id, "prj_a");
		const { actingUserId: _actingUserId, ...rest } = scope();
		expect(await env.connections.usable(SYSTEM, rest)).toEqual([]);
		await expect(env.connections.callTool(SYSTEM, rest, id, { name: "whoami" })).rejects.toMatchObject({
			code: "forbidden",
		});
		expect(await env.connections.usable(SYSTEM, scope({ projectId: "prj_b" }))).toEqual([]);
	});

	it("still applies its agents: a share doesn't widen who may use it", async () => {
		const env = setup();
		const id = await connectAlice(env);
		await env.connections.update(alice, id, {
			usage: { actingUsers: ["alice"], unattended: false, visibility: "private", agents: ["agt_2"] },
		});
		await env.connections.share(alice, id, "prj_a");
		expect(await env.connections.usable(SYSTEM, scope())).toEqual([]);
		expect((await env.connections.usable(SYSTEM, scope({ agentId: "agt_2" }))).map((c) => c.id)).toEqual([id]);
	});

	it("stops at once when the project's admin unshares it, and records the next request as refused", async () => {
		const env = setup();
		const id = await connectAlice(env);
		await env.connections.share(alice, id, "prj_a");
		await env.connections.callTool(SYSTEM, scope(), id, { name: "whoami" });
		// Bob is only an operator: he can't take it out.
		await expect(env.connections.unshare(bob, id, "prj_a")).rejects.toMatchObject({ code: "forbidden" });
		await expect(env.connections.unshare(agent, id, "prj_a")).rejects.toMatchObject({ code: "forbidden" });
		env.tick();
		const unshared = await env.connections.unshare(carol, id, "prj_a");
		expect(unshared.shares).toEqual([]);
		expect(env.events.find((event) => event.type === "connections.connection.unshared")).toMatchObject({
			projectId: "prj_a",
			actor: carol.actor,
			data: { project: "prj_a" },
		});
		await expect(env.connections.callTool(SYSTEM, scope(), id, { name: "whoami" })).rejects.toMatchObject({
			code: "forbidden",
		});
		const uses = (await env.connections.listUses(alice, { connectionId: id })).items;
		expect(uses[0]).toMatchObject({ outcome: "denied" });
		expect(uses[1]).toMatchObject({ outcome: "allowed", viaShare: true });
	});

	it("lets its owner unshare it themselves", async () => {
		const env = setup();
		const id = await connectAlice(env);
		await env.connections.share(alice, id, "prj_a");
		expect((await env.connections.unshare(alice, id, "prj_a")).shares).toEqual([]);
	});
});

describe("uses in private sessions (#335)", () => {
	async function used() {
		const env = setup();
		const id = await connectAlice(env);
		const attempt = await env.connections.startConnect(carol, {
			owner: { kind: "organisation", organisationId: ORG },
			mcpUrl: env.provider.mcpUrl,
		});
		const { url } = await env.connections.authorize(carol, attempt.id);
		const state = new URL(url).searchParams.get("state")!;
		const org = (await env.connections.completeConnect(carol, { state, code: env.provider.codeFor(url) }))
			.connectionId!;
		await letEverythingThrough(env.connections, carol, org);
		const sessions: Record<string, SessionRecord> = {
			ses_alice: session({ id: "ses_alice", userId: "alice", createdBy: alice.actor, visibility: "private" }),
			ses_bob: session({ id: "ses_bob", visibility: "private" }),
			ses_1: session(),
		};
		for (const [key, record] of Object.entries(sessions)) env.sessions.set(key, record);
		const inSession = (sessionId: string) => {
			const record = sessions[sessionId]!;
			return scope({
				sessionId,
				actingUserId: record.userId!,
				audience: record.visibility === "private" ? { kind: "private", userId: record.userId! } : { kind: "shared" },
			});
		};
		// Alice's own private session uses her connection and the organisation's.
		await env.connections.callTool(SYSTEM, inSession("ses_alice"), id, { name: "whoami" });
		await env.connections.callTool(SYSTEM, inSession("ses_alice"), org, { name: "whoami" });
		// Shared with prj_a: Bob's private session and his shared one use it through the share.
		await env.connections.share(alice, id, "prj_a");
		await env.connections.callTool(SYSTEM, inSession("ses_bob"), id, { name: "whoami" });
		await env.connections.callTool(SYSTEM, inSession("ses_1"), id, { name: "whoami" });
		// Each use as `session:connection`, or `private:connection` for one redacted to the caller.
		const seen = async (ctx: CallContext, filter: { connectionId?: string; sessionId?: string } = {}) =>
			(await env.connections.listUses(ctx, filter)).items
				.map((use) => `${isRedactedUse(use) ? "private" : use.sessionId}:${use.connectionId}`)
				.sort();
		return { env, id, org, seen };
	}

	it("redacts them for an admin, by connection and unfiltered, and refuses the session itself", async () => {
		const { id, org, seen } = await used();
		expect(await seen(carol, { connectionId: id })).toEqual([`private:${id}`, `private:${id}`, `ses_1:${id}`]);
		expect(await seen(carol, { connectionId: org })).toEqual([`private:${org}`]);
		expect(await seen(carol)).toEqual([`private:${id}`, `private:${id}`, `private:${org}`, `ses_1:${id}`].sort());
		await expect(seen(carol, { sessionId: "ses_alice" })).rejects.toMatchObject({ code: "forbidden" });
		await expect(seen(carol, { sessionId: "ses_bob" })).rejects.toMatchObject({ code: "forbidden" });
	});

	it("keeps a redacted use to when, how it ended and who it acted for", async () => {
		const { env, id, org } = await used();
		const owners = (await env.connections.listUses(alice, { connectionId: org })).items;
		const admins = (await env.connections.listUses(carol, { connectionId: org })).items;
		expect(admins).toEqual([
			{
				id: owners[0]!.id,
				connectionId: org,
				organisationId: ORG,
				redacted: true,
				actingUserId: "alice",
				audience: { kind: "private", userId: "alice" },
				outcome: "allowed",
				at: owners[0]!.at,
			},
		]);
		// Nothing from inside the private session: no session, step, agent, project, host, path or tool.
		for (const inside of ["ses_alice", "whoami", "agt_1", "prj_a", new URL(env.provider.mcpUrl).host]) {
			expect(JSON.stringify(admins)).not.toContain(inside);
		}
		// Alice's connection, used in her private session and Bob's: neither session is named to the admin.
		const personal = JSON.stringify((await env.connections.listUses(carol, { connectionId: id })).items);
		expect(personal).not.toContain("ses_alice");
		expect(personal).not.toContain("ses_bob");
	});

	it("shows the connection's owner every use of it, and each person their own sessions'", async () => {
		const { id, org, seen } = await used();
		// Alice owns the connection: hers, and Bob's private and shared sessions' through the share.
		expect(await seen(alice, { connectionId: id })).toEqual([`ses_1:${id}`, `ses_alice:${id}`, `ses_bob:${id}`]);
		// The organisation's connection in her own private session.
		expect(await seen(alice, { connectionId: org })).toEqual([`ses_alice:${org}`]);
		expect(await seen(alice, { sessionId: "ses_alice" })).toEqual([`ses_alice:${id}`, `ses_alice:${org}`].sort());
		// Bob sees the connection now it is shared into his project: his own sessions' uses whole, Alice's private one
		// redacted, and so is her use of the organisation's connection.
		expect(await seen(bob, { connectionId: id })).toEqual([`private:${id}`, `ses_1:${id}`, `ses_bob:${id}`]);
		expect(await seen(bob, { sessionId: "ses_bob" })).toEqual([`ses_bob:${id}`]);
		expect(await seen(bob)).toEqual([`private:${id}`, `private:${org}`, `ses_1:${id}`, `ses_bob:${id}`].sort());
	});

	it("shows a use in a session that has since been shared to those who can open it now", async () => {
		const { env, org, seen } = await used();
		env.sessions.set("ses_alice", { ...env.sessions.get("ses_alice")!, visibility: "shared" });
		expect(await seen(carol, { connectionId: org })).toEqual([`ses_alice:${org}`]);
	});
});

describe("an organisation-level agent (#335)", () => {
	/** Keys for each kind of owner: the organisation's (any project, or prj_a only), prj_a's, prj_b's, Alice's, Bob's. */
	async function owned() {
		const env = setup();
		const key = async (ctx: CallContext, owner: Connection["owner"], name: string, usage?: Connection["usage"]) =>
			(
				await env.connections.connectKey(ctx, {
					custom: { kind: "http", hosts: [`${name}.example.com`], injection: { kind: "bearer" } },
					owner,
					name,
					value: `sk-${name}-abcdefghijklmnop`,
					...(usage === undefined ? {} : { usage }),
				})
			).id;
		const organisation = { kind: "organisation", organisationId: ORG } as const;
		const ids = {
			org: await key(carol, organisation, "org", { unattended: true, visibility: "shared" }),
			orgAttended: await key(carol, organisation, "org-attended", { unattended: false, visibility: "shared" }),
			orgInA: await key(carol, organisation, "org-in-a", {
				projects: ["prj_a"],
				unattended: true,
				visibility: "shared",
			}),
			projectA: await key(carol, { kind: "project", organisationId: ORG, projectId: "prj_a" }, "project-a", {
				unattended: true,
				visibility: "shared",
			}),
			projectB: await key(SYSTEM, { kind: "project", organisationId: ORG, projectId: "prj_b" }, "project-b", {
				unattended: true,
				visibility: "shared",
			}),
			alice: await key(alice, { kind: "user", organisationId: ORG, userId: "alice" }, "alice"),
			bob: await key(bob, { kind: "user", organisationId: ORG, userId: "bob" }, "bob"),
		};
		// Alice's is shared with prj_a, so it reaches that project's attended sessions, not the organisation's.
		await env.connections.share(alice, ids.alice, "prj_a");
		const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
		const usable = async (at: ConnectionSessionScope) =>
			(await env.connections.usable(SYSTEM, at)).map((connection) => names.get(connection.id)).sort();
		// An organisation session: no project.
		const { projectId: _projectId, ...organisationScope } = scope({ agentId: "agt_org", actingUserId: "alice" });
		return { env, ids, usable, organisationScope };
	}

	it("sees the organisation's connections, and no project's or person's, in an organisation session", async () => {
		const { usable, organisationScope } = await owned();
		expect(await usable(organisationScope)).toEqual(["org", "orgAttended"]);
	});

	it("gets a person's own only when the session is theirs alone, and never another person's", async () => {
		const { usable, organisationScope } = await owned();
		const aliceAlone = { ...organisationScope, audience: { kind: "private", userId: "alice" } } as const;
		expect(await usable(aliceAlone)).toEqual(["alice", "org", "orgAttended"]);
		const bobAlone = {
			...organisationScope,
			actingUserId: "bob",
			audience: { kind: "private", userId: "bob" },
		} as const;
		expect(await usable(bobAlone)).toEqual(["bob", "org", "orgAttended"]);
	});

	it("gets only the organisation's unattended connections with no person behind it", async () => {
		const { usable, organisationScope } = await owned();
		const { actingUserId: _actingUserId, ...unattended } = organisationScope;
		expect(await usable(unattended)).toEqual(["org"]);
	});

	it("in a project session, sees the organisation's and that project's, and nothing else", async () => {
		const { usable } = await owned();
		const inA = scope({ agentId: "agt_org" });
		expect(await usable(inA)).toEqual(["alice", "org", "orgAttended", "orgInA", "projectA"]);
		expect(await usable(scope({ agentId: "agt_org", projectId: "prj_b" }))).toEqual(["org", "orgAttended", "projectB"]);
	});

	it("is refused a project's connection, and the refusal is recorded", async () => {
		const { env, ids, organisationScope } = await owned();
		for (const id of [ids.projectA, ids.orgInA, ids.bob]) {
			await expect(
				env.connections.send(SYSTEM, organisationScope, id, {
					kind: "http",
					method: "GET",
					url: `https://${id}.example.com/`,
				}),
			).rejects.toMatchObject({ code: "forbidden" });
		}
		const uses = whole(await env.connections.listUses(SYSTEM, {}));
		expect(uses.map((use) => [use.connectionId, use.outcome, use.projectId])).toEqual(
			expect.arrayContaining([
				[ids.projectA, "denied", undefined],
				[ids.orgInA, "denied", undefined],
				[ids.bob, "denied", undefined],
			]),
		);
		expect(uses.find((use) => use.connectionId === ids.projectA)?.reason).toContain(
			"It belongs to a project, and this is an organisation session",
		);
		expect(uses.find((use) => use.connectionId === ids.orgInA)?.reason).toContain(
			"It is only for sessions in some projects, and this is an organisation session",
		);
	});

	it("keeps one organisation's connections from another's people and sessions", async () => {
		const { env, ids, organisationScope } = await owned();
		const outsider = human("carol", "org_2");
		expect((await env.connections.list(outsider)).items).toEqual([]);
		await expect(env.connections.get(outsider, ids.org)).rejects.toMatchObject({ code: "not_found" });
		await expect(env.connections.listUses(outsider, { connectionId: ids.org })).rejects.toMatchObject({
			code: "not_found",
		});
		const elsewhere = { ...organisationScope, organisationId: "org_2" };
		expect(await env.connections.usable(SYSTEM, elsewhere)).toEqual([]);
		await expect(
			env.connections.send(SYSTEM, elsewhere, ids.org, {
				kind: "http",
				method: "GET",
				url: "https://org.example.com/",
			}),
		).rejects.toMatchObject({ code: "not_found" });
	});

	it("lists what an organisation session may use, and as if it were private", async () => {
		const { env, ids } = await owned();
		env.sessions.set(
			"ses_org",
			session({ id: "ses_org", projectId: undefined, agentId: "agt_org", userId: "alice", createdBy: alice.actor }),
		);
		const eligible = async (visibility?: "private" | "shared") =>
			Object.fromEntries(
				(
					await env.connections.sessionConnections(
						SYSTEM,
						"ses_org",
						visibility === undefined ? undefined : { visibility },
					)
				).map((entry) => [entry.connection.id, entry.usable]),
			);
		expect(await eligible()).toEqual({
			[ids.org]: true,
			[ids.orgAttended]: true,
			[ids.orgInA]: false,
			[ids.alice]: false,
		});
		expect((await eligible("private"))[ids.alice]).toBe(true);
	});
});

describe("which connections a session may use", () => {
	it("answers for the session's own visibility, or as if it had another", async () => {
		const env = setup();
		const id = await connectAlice(env);
		env.sessions.set("ses_mine", session({ id: "ses_mine", userId: "alice", createdBy: alice.actor }));
		const shared = await env.connections.sessionConnections(alice, "ses_mine");
		expect(shared).toEqual([
			expect.objectContaining({ connection: expect.objectContaining({ id }), usable: false, ownerId: "alice" }),
		]);
		expect(shared[0]?.reason).toMatch(/private/i);
		const asPrivate = await env.connections.sessionConnections(alice, "ses_mine", { visibility: "private" });
		expect(asPrivate[0]).toMatchObject({ usable: true });
		expect(asPrivate[0]?.reason).toBeUndefined();
		env.sessions.set(
			"ses_private",
			session({ id: "ses_private", userId: "alice", createdBy: alice.actor, visibility: "private" }),
		);
		expect((await env.connections.sessionConnections(alice, "ses_private"))[0]).toMatchObject({ usable: true });
	});

	it("shows another person's connection only once it is shared with the session's project, and then its account", async () => {
		const env = setup();
		const id = await connectAlice(env);
		env.sessions.set("ses_1", session());
		expect(await env.connections.sessionConnections(bob, "ses_1")).toEqual([]);
		await env.connections.share(alice, id, "prj_a");
		const after = await env.connections.sessionConnections(bob, "ses_1");
		expect(after).toEqual([expect.objectContaining({ usable: true, viaShare: true, ownerId: "alice" })]);
	});

	it("needs viewer on the session, and sessions to read", async () => {
		const env = setup();
		env.sessions.set("ses_1", session());
		const outsider: CallContext = {
			actor: { kind: "agent", agentId: "agt_9", sessionId: "ses_9" },
			organisationId: ORG,
		};
		await expect(env.connections.sessionConnections(outsider, "ses_1")).rejects.toMatchObject({ code: "forbidden" });
		const bare = createMemoryConnections({
			fetch: env.provider.fetch,
			access: access(),
			deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
		});
		await expect(bare.sessionConnections(bob, "ses_1")).rejects.toMatchObject({ code: "unavailable" });
	});
});

describe("a deployment with one person: all mine (#335)", () => {
	/**
	 * Alice's connection (an MCP server), Bob's key and the organisation's attended key, with three of Alice's sessions:
	 * an organisation-level agent's with no visibility set, a project session marked shared, and an unattended run.
	 */
	async function mine(personal: boolean) {
		const env = setup({ personal });
		const id = await connectAlice(env);
		const key = async (ctx: CallContext, owner: Connection["owner"], name: string, usage?: Connection["usage"]) =>
			(
				await env.connections.connectKey(ctx, {
					custom: { kind: "http", hosts: [`${name}.example.com`], injection: { kind: "bearer" } },
					owner,
					name,
					value: `sk-${name}-abcdefghijklmnop`,
					...(usage === undefined ? {} : { usage }),
				})
			).id;
		const bobs = await key(bob, { kind: "user", organisationId: ORG, userId: "bob" }, "bob");
		const org = await key(carol, { kind: "organisation", organisationId: ORG }, "org", {
			unattended: false,
			visibility: "shared",
		});
		const { projectId: _projectId, ...organisationLevel } = session({
			id: "ses_org",
			agentId: "agt_org",
			userId: "alice",
			createdBy: alice.actor,
		});
		const records = {
			ses_org: organisationLevel,
			ses_shared: session({ id: "ses_shared", userId: "alice", createdBy: alice.actor, visibility: "shared" }),
			ses_nightly: (({ userId: _userId, ...rest }) => rest)(session({ id: "ses_nightly", createdBy: SYSTEM.actor })),
		} satisfies Record<string, SessionRecord>;
		for (const [sessionId, record] of Object.entries(records)) env.sessions.set(sessionId, record);
		const names = new Map([
			[id, "alice"],
			[bobs, "bob"],
			[org, "org"],
		]);
		// What the session's tools list, as the model sees them: the deployment's `personal` given to the tools too.
		const listed = async (sessionId: keyof typeof records) => {
			const list = connectionTools({ connections: env.connections, personal })(records[sessionId]).find(
				(tool) => tool.name === "connections_list",
			)!;
			const result = await list.execute({} as never, { callId: "call_list" } as never, {} as never);
			const text = (result.output![0] as { text: string }).text;
			if (!text.startsWith("[")) return [];
			return (JSON.parse(text) as { id: string }[]).map((entry) => names.get(entry.id)).sort();
		};
		const eligible = async (sessionId: keyof typeof records) =>
			Object.fromEntries(
				(await env.connections.sessionConnections(SYSTEM, sessionId)).map((entry) => [
					names.get(entry.connection.id),
					entry.usable,
				]),
			);
		return { env, id, records, listed, eligible };
	}

	it("gives the person's own connection to every session acting for them, an organisation agent's included", async () => {
		const { listed, eligible } = await mine(true);
		expect(await listed("ses_org")).toEqual(["alice", "org"]);
		expect(await listed("ses_shared")).toEqual(["alice", "org"]);
		expect(await eligible("ses_org")).toMatchObject({ alice: true, org: true });
		expect(await eligible("ses_shared")).toMatchObject({ alice: true, org: true });
	});

	it("uses it there, recorded as the person's private session", async () => {
		const { env, id, records } = await mine(true);
		const call = connectionTools({ connections: env.connections, personal: true })(records.ses_org).find(
			(tool) => tool.name === "connection_call",
		)!;
		const result = await call.execute(
			{ connectionId: id, tool: "whoami", arguments: {} } as never,
			{ callId: "call_1", details: async () => {} } as never,
			{} as never,
		);
		expect(result.isError).toBe(false);
		const [use] = whole(await env.connections.listUses(alice, { connectionId: id }));
		expect(use).toMatchObject({
			sessionId: "ses_org",
			agentId: "agt_org",
			toolCallId: "call_1",
			outcome: "allowed",
			audience: { kind: "private", userId: "alice" },
		});
		expect(use?.projectId).toBeUndefined();
	});

	it("still never gives anyone another person's connection, or a personal one to an unattended run", async () => {
		const { listed, eligible } = await mine(true);
		expect(await listed("ses_org")).not.toContain("bob");
		expect(await eligible("ses_org")).not.toMatchObject({ bob: true });
		expect(await listed("ses_nightly")).toEqual([]);
		expect(await eligible("ses_nightly")).not.toMatchObject({ alice: true });
	});

	it("without personal mode, keeps the person's connection out of a session not marked private", async () => {
		const { listed, eligible } = await mine(false);
		expect(await listed("ses_org")).toEqual(["org"]);
		expect(await listed("ses_shared")).toEqual(["org"]);
		expect(await eligible("ses_shared")).toMatchObject({ alice: false, org: true });
	});
});
