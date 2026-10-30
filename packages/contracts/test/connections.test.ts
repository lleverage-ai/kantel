// Which sessions may use a connection (connections.ts, `connectionUsableIn`): the owner bounds it, the usage narrows
// it, and a private connection never reaches a session other people can see (#335).
import { describe, expect, it } from "vitest";
import {
	type Connection,
	type ConnectionSessionScope,
	connectionUsableIn,
	defaultConnectionUsage,
} from "../src/index.ts";

type Subject = Pick<Connection, "organisationId" | "owner" | "usage" | "status">;

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
});
