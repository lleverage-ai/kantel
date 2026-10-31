/**
 * Sharing a person's connection with a project, and what a session's visibility lets it use (#335): only the owner
 * shares, into a project where they run sessions; any attended session there may then use it, recorded as a use
 * through the share; unattended sessions never; the owner or the project's admin stops it, and the next request is
 * refused and recorded.
 */
import type {
	AuditEventInput,
	CallContext,
	ConnectionSessionScope,
	ProjectAccess,
	SessionDirectory,
	SessionRecord,
} from "@kantel/contracts";
import { KantelError } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryConnections } from "../src/memory.ts";
import { fakeProvider, human, ORG } from "../src/testing.ts";

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

function access(): ProjectAccess {
	const passes = (
		ctx: CallContext,
		check: { readonly projectId?: string; readonly userId?: string; readonly needed: string },
	) => {
		if (ctx.actor.kind === "system") return true;
		if (ctx.actor.kind !== "human") return false;
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

function setup() {
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
		access: access(),
		audit: { append: async (_ctx, batch) => void events.push(...batch) },
		deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
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
		const uses = (await env.connections.listUses(alice, { connectionId: id })).items;
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
		const latest = (await env.connections.listUses(alice, { connectionId: id })).items[0];
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
