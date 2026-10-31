// Which sessions may use a connection (connections.ts, `connectionUsableIn`): the owner bounds it, the usage narrows
// it, and a private connection never reaches a session other people can see (#335).
import { describe, expect, it } from "vitest";
import {
	type Connection,
	type ConnectionSessionScope,
	connectionUsableIn,
	defaultConnectionUsage,
	sessionAudienceOf,
} from "../src/index.ts";

type Subject = Pick<Connection, "organisationId" | "owner" | "usage" | "status" | "shares">;

const org = { kind: "organisation", organisationId: "org" } as const;
const project = { kind: "project", organisationId: "org", projectId: "p1" } as const;
const alice = { kind: "user", organisationId: "org", userId: "alice" } as const;

const subject = (owner: Subject["owner"], usage = defaultConnectionUsage(owner)): Subject => ({
	organisationId: "org",
	owner,
	usage,
	status: "active",
});

const session = (over: Partial<ConnectionSessionScope> = {}): ConnectionSessionScope => ({
	organisationId: "org",
	projectId: "p1",
	sessionId: "s1",
	agentId: "assistant",
	actingUserId: "alice",
	audience: { kind: "shared" },
	...over,
});

const usable = (connection: Subject, scope: ConnectionSessionScope) => connectionUsableIn(connection, scope).usable;

describe("connectionUsableIn", () => {
	it("keeps every connection inside its organisation", () => {
		expect(usable(subject(org), session({ organisationId: "other" }))).toBe(false);
	});

	it("keeps a project's connection in that project", () => {
		expect(usable(subject(project), session())).toBe(true);
		expect(usable(subject(project), session({ projectId: "p2" }))).toBe(false);
		expect(usable(subject(project), session({ projectId: undefined }))).toBe(false);
	});

	it("gives a person's connection only to private sessions acting for them, never unattended ones", () => {
		const own = subject(alice);
		expect(usable(own, session({ audience: { kind: "private", userId: "alice" } }))).toBe(true);
		expect(usable(own, session())).toBe(false);
		expect(usable(own, session({ actingUserId: "bob", audience: { kind: "private", userId: "bob" } }))).toBe(false);
		expect(usable(own, session({ actingUserId: undefined }))).toBe(false);
		// Even made shared and attended-only, it stays its owner's.
		const shared = subject(alice, { unattended: true, visibility: "shared" });
		expect(usable(shared, session())).toBe(true);
		expect(usable(shared, session({ actingUserId: undefined }))).toBe(false);
		expect(usable(shared, session({ actingUserId: "bob" }))).toBe(false);
	});

	it("narrows an organisation's connection by project, acting person and agent", () => {
		const narrowed = subject(org, {
			projects: ["p1"],
			actingUsers: ["alice"],
			agents: ["assistant"],
			unattended: false,
			visibility: "shared",
		});
		expect(usable(narrowed, session())).toBe(true);
		expect(usable(narrowed, session({ projectId: "p2" }))).toBe(false);
		expect(usable(narrowed, session({ actingUserId: "bob" }))).toBe(false);
		expect(usable(narrowed, session({ agentId: "triage" }))).toBe(false);
		expect(usable(narrowed, session({ actingUserId: undefined }))).toBe(false);
	});

	it("lets unattended sessions use organisation and project connections by default", () => {
		expect(usable(subject(org), session({ actingUserId: undefined }))).toBe(true);
		expect(usable(subject(project), session({ actingUserId: undefined }))).toBe(true);
	});

	it("keeps a private organisation connection out of sessions others can see", () => {
		const added = subject(project, { actingUsers: ["alice"], unattended: false, visibility: "private" });
		expect(usable(added, session({ audience: { kind: "private", userId: "alice" } }))).toBe(true);
		expect(usable(added, session())).toBe(false);
	});

	it("refuses a disabled connection", () => {
		expect(usable({ ...subject(org), status: "disabled" }, session())).toBe(false);
	});

	it("lets a person's connection shared with a project reach any attended session there, and says so", () => {
		const shared: Subject = {
			...subject(alice),
			shares: [{ projectId: "p1", sharedBy: { kind: "human", userId: "alice" }, sharedAt: 1 }],
		};
		// Bob's session his project can see.
		expect(connectionUsableIn(shared, session({ actingUserId: "bob" }))).toEqual({ usable: true, viaShare: true });
		// Alice's own shared session uses it through the share; her private one as her own.
		expect(connectionUsableIn(shared, session())).toEqual({ usable: true, viaShare: true });
		expect(connectionUsableIn(shared, session({ audience: { kind: "private", userId: "alice" } }))).toEqual({
			usable: true,
			viaShare: false,
		});
		// Never unattended, never another project, and its agents still apply.
		expect(usable(shared, session({ actingUserId: undefined }))).toBe(false);
		expect(usable(shared, session({ projectId: "p2", actingUserId: "bob" }))).toBe(false);
		expect(usable(shared, session({ projectId: undefined, actingUserId: "bob" }))).toBe(false);
		const narrowed: Subject = { ...shared, usage: { ...shared.usage, agents: ["other"] } };
		expect(connectionUsableIn(narrowed, session({ actingUserId: "bob" }))).toEqual({
			usable: false,
			reason: "It is not available to this agent",
		});
		expect(usable({ ...shared, status: "disabled" }, session({ actingUserId: "bob" }))).toBe(false);
	});

	it("lets a scheduled run acting for its person use their own connections, and otherwise stays unattended", () => {
		const mine = { kind: "private", userId: "alice" } as const;
		const scheduled = (over: Partial<ConnectionSessionScope> = {}) =>
			session({ unattended: true, audience: mine, ...over });
		// Her own "Just me" connection, which allows no unattended use, while the run is private to her.
		expect(connectionUsableIn(subject(alice), scheduled())).toEqual({ usable: true });
		expect(connectionUsableIn(subject(alice), scheduled({ audience: { kind: "shared" } }))).toEqual({
			usable: false,
			reason: "It is private, and other people can see this session",
		});
		// Never anyone else's, shared with the project or not.
		const bobs = { kind: "user", organisationId: "org", userId: "bob" } as const;
		const sharedBobs: Subject = {
			...subject(bobs),
			shares: [{ projectId: "p1", sharedBy: { kind: "human", userId: "bob" }, sharedAt: 1 }],
		};
		expect(usable(subject(bobs), scheduled())).toBe(false);
		expect(connectionUsableIn(sharedBobs, scheduled())).toEqual({
			usable: false,
			reason: "It is not available to sessions with no person behind them",
		});
		// Her own connection shared with the project is still hers: used as her own, not through the share.
		const sharedOwn: Subject = {
			...subject(alice),
			shares: [{ projectId: "p1", sharedBy: { kind: "human", userId: "alice" }, sharedAt: 1 }],
		};
		expect(connectionUsableIn(sharedOwn, scheduled())).toEqual({ usable: true });
		// The organisation's and projects' only when they allow unattended use, as for a run acting for no one.
		expect(usable(subject(org), scheduled())).toBe(true);
		expect(usable(subject(project), scheduled())).toBe(true);
		const attendedOnly = subject(org, { unattended: false, visibility: "shared" });
		expect(usable(attendedOnly, session())).toBe(true);
		expect(connectionUsableIn(attendedOnly, scheduled())).toEqual({
			usable: false,
			reason: "It is not available to sessions with no person behind them",
		});
		// A run acting for no one, as before.
		expect(usable(subject(alice), scheduled({ actingUserId: undefined, audience: { kind: "shared" } }))).toBe(false);
	});
});

describe("sessionAudienceOf", () => {
	it("is shared unless the session is private and acts for a person, or the deployment is one person's", () => {
		expect(sessionAudienceOf({})).toEqual({ kind: "shared" });
		expect(sessionAudienceOf({ visibility: "private" })).toEqual({ kind: "shared" });
		expect(sessionAudienceOf({ userId: "alice" })).toEqual({ kind: "shared" });
		expect(sessionAudienceOf({ userId: "alice", visibility: "shared" })).toEqual({ kind: "shared" });
		expect(sessionAudienceOf({ userId: "alice", visibility: "private" })).toEqual({
			kind: "private",
			userId: "alice",
		});
		expect(sessionAudienceOf({ userId: "alice" }, true)).toEqual({ kind: "private", userId: "alice" });
	});

	it("keeps a scheduled run acting for a person private only while its own visibility is, even for one person", () => {
		const unattended = { scheduleId: "sch_1", occurrenceId: "occ_1" };
		expect(sessionAudienceOf({ userId: "alice", unattended, visibility: "private" }, true)).toEqual({
			kind: "private",
			userId: "alice",
		});
		expect(sessionAudienceOf({ userId: "alice", unattended, visibility: "shared" }, true)).toEqual({ kind: "shared" });
		expect(sessionAudienceOf({ userId: "alice", unattended }, true)).toEqual({ kind: "shared" });
		expect(sessionAudienceOf({ unattended, visibility: "private" }, true)).toEqual({ kind: "shared" });
	});
});
