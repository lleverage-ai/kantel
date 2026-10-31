import type { AccessCheck, CallContext } from "@kantel/contracts";
import { createDeps } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const ORG = "org-1";

function setUp() {
	const deps = createDeps();
	const owner = { kind: "human", userId: "owner" } as const;
	const reader = { kind: "human", userId: "reader" } as const;
	const ci = { kind: "service", serviceId: "ci" } as const;
	deps.tenancy.bind(owner, ORG, "admin");
	deps.tenancy.bind(reader, ORG, "viewer", "proj-a");
	deps.tenancy.bind(ci, ORG, "operator", "proj-a");
	const parent = deps.tenancy.session({ id: "sess-parent", organisationId: ORG, projectId: "proj-a", agentId: "a" });
	const child = deps.tenancy.session({
		id: "sess-child",
		organisationId: ORG,
		projectId: "proj-a",
		agentId: "a",
		parentSessionId: "sess-parent",
	});
	deps.tenancy.session({ id: "sess-sibling", organisationId: ORG, projectId: "proj-a", agentId: "a" });
	const as = (actor: CallContext["actor"], organisationId = ORG): CallContext => ({ actor, organisationId });
	const allows = (ctx: CallContext, check: Omit<AccessCheck, "operation">) => deps.access.allows(ctx, check);
	return { deps, owner, reader, ci, parent, child, as, allows };
}

describe("createProjectAccess", () => {
	it("checks humans and services by role, on the project or across the organisation", async () => {
		const { owner, reader, ci, as, allows } = setUp();
		expect(await allows(as(owner), { projectId: "proj-b", needed: "admin" })).toBe(true);
		expect(await allows(as(owner), { needed: "admin" })).toBe(true);
		expect(await allows(as(reader), { projectId: "proj-a", needed: "viewer" })).toBe(true);
		expect(await allows(as(reader), { projectId: "proj-a", needed: "operator" })).toBe(false);
		expect(await allows(as(reader), { needed: "viewer" })).toBe(false);
		expect(await allows(as(ci), { projectId: "proj-a", needed: "operator" })).toBe(true);
		expect(await allows(as(ci), { projectId: "proj-b", needed: "viewer" })).toBe(false);
		expect(await allows(as(owner, "org-2"), { projectId: "proj-a", needed: "viewer" })).toBe(false);
		expect(await allows(as({ kind: "system", component: "relay" }), { needed: "admin" })).toBe(true);
	});

	it("lets an agent act as an operator in its own open session's project, and on its children, never wider", async () => {
		const { deps, parent, child, as, allows } = setUp();
		expect(await allows(as(parent), { projectId: "proj-a", needed: "operator" })).toBe(true);
		expect(await allows(as(parent), { projectId: "proj-a", needed: "admin" })).toBe(false);
		expect(await allows(as(parent), { projectId: "proj-b", needed: "viewer" })).toBe(false);
		expect(await allows(as(parent), { needed: "viewer" })).toBe(false);
		expect(await allows(as(parent), { sessionId: "sess-parent", needed: "operator" })).toBe(true);
		expect(await allows(as(parent), { sessionId: "sess-child", needed: "operator" })).toBe(true);
		expect(await allows(as(child), { sessionId: "sess-parent", needed: "viewer" })).toBe(false);
		expect(await allows(as(parent), { sessionId: "sess-sibling", needed: "viewer" })).toBe(false);
		expect(await allows(as(parent), { sessionId: "sess-child", projectId: "proj-b", needed: "viewer" })).toBe(false);
		const impostor = { kind: "agent", agentId: "b", sessionId: "sess-parent" } as const;
		expect(await allows(as(impostor), { projectId: "proj-a", needed: "viewer" })).toBe(false);
		expect(await allows(as(parent, "org-2"), { projectId: "proj-a", needed: "viewer" })).toBe(false);
		deps.tenancy.close("sess-parent");
		expect(await allows(as(parent), { projectId: "proj-a", needed: "viewer" })).toBe(false);
		expect(await allows(as(parent), { sessionId: "sess-child", needed: "viewer" })).toBe(false);
	});

	it("lets only the user, an organisation-wide service and the user's own sessions' agents through a user owner", async () => {
		const { deps, owner, reader, ci, parent, as, allows } = setUp();
		const mine = { kind: "human", userId: "mine" } as const;
		const host = { kind: "service", serviceId: "host" } as const;
		deps.tenancy.bind(mine, ORG, "viewer", "proj-a");
		deps.tenancy.bind(host, ORG, "admin");
		const inProject = deps.tenancy.session({
			id: "sess-mine",
			organisationId: ORG,
			projectId: "proj-a",
			agentId: "m",
			userId: "mine",
		});
		const inOrganisation = deps.tenancy.session({ id: "sess-org", organisationId: ORG, agentId: "o", userId: "mine" });
		const user = { userId: "mine" };
		// The user, with no organisation-wide role at all; never another person, the organisation's admin included.
		expect(await allows(as(mine), { ...user, needed: "admin" })).toBe(true);
		expect(await allows(as(owner), { ...user, needed: "viewer" })).toBe(false);
		expect(await allows(as(reader), { ...user, needed: "viewer" })).toBe(false);
		// A project the check names still needs the role there.
		expect(await allows(as(mine), { ...user, projectId: "proj-a", needed: "viewer" })).toBe(true);
		expect(await allows(as(mine), { ...user, projectId: "proj-a", needed: "operator" })).toBe(false);
		// A service needs the role across the organisation.
		expect(await allows(as(host), { ...user, needed: "admin" })).toBe(true);
		expect(await allows(as(ci), { ...user, needed: "viewer" })).toBe(false);
		// An agent through a session that works for the user, in a project or the organisation, as an operator at most.
		expect(await allows(as(inProject), { ...user, needed: "operator" })).toBe(true);
		expect(await allows(as(inOrganisation), { ...user, needed: "operator" })).toBe(true);
		expect(await allows(as(inOrganisation), { ...user, sessionId: "sess-org", needed: "operator" })).toBe(true);
		expect(await allows(as(inProject), { ...user, needed: "admin" })).toBe(false);
		expect(await allows(as(inOrganisation), { ...user, sessionId: "sess-mine", needed: "viewer" })).toBe(false);
		expect(await allows(as(inOrganisation), { ...user, projectId: "proj-a", needed: "viewer" })).toBe(false);
		expect(await allows(as(parent), { ...user, needed: "viewer" })).toBe(false);
		deps.tenancy.close("sess-org");
		expect(await allows(as(inOrganisation), { ...user, needed: "viewer" })).toBe(false);
	});

	it("keeps a private session to its person and the service that made it, an admin of the project included (#335)", async () => {
		const { deps, owner, reader, ci, as, allows } = setUp();
		const alice = { kind: "human", userId: "alice" } as const;
		deps.tenancy.bind(alice, ORG, "operator", "proj-a");
		const own = deps.tenancy.session({
			id: "sess-private",
			organisationId: ORG,
			projectId: "proj-a",
			agentId: "a",
			userId: "alice",
			visibility: "private",
			createdBy: ci,
		});
		deps.tenancy.session({
			id: "sess-private-child",
			organisationId: ORG,
			projectId: "proj-a",
			agentId: "a",
			userId: "alice",
			visibility: "private",
			parentSessionId: "sess-private",
		});
		expect(await allows(as(alice), { sessionId: "sess-private", needed: "operator" })).toBe(true);
		expect(await allows(as(ci), { sessionId: "sess-private", needed: "operator" })).toBe(true);
		expect(await allows(as(owner), { sessionId: "sess-private", needed: "viewer" })).toBe(false);
		expect(await allows(as(reader), { sessionId: "sess-private", needed: "viewer" })).toBe(false);
		// Its own agent, and its children's supervision, as always.
		expect(await allows(as(own), { sessionId: "sess-private", needed: "operator" })).toBe(true);
		expect(await allows(as(own), { sessionId: "sess-private-child", needed: "operator" })).toBe(true);
		expect(
			await allows(as({ kind: "system", component: "relay" }), { sessionId: "sess-private", needed: "admin" }),
		).toBe(true);
		// A shared one is the project's, as before.
		deps.tenancy.session({
			id: "sess-shared",
			organisationId: ORG,
			projectId: "proj-a",
			agentId: "a",
			userId: "alice",
			visibility: "shared",
		});
		expect(await allows(as(reader), { sessionId: "sess-shared", needed: "viewer" })).toBe(true);
		expect(await allows(as(owner), { sessionId: "sess-shared", needed: "admin" })).toBe(true);
	});

	it("refuses with one generic forbidden and audits it once, with no secret", async () => {
		const { deps, reader, as } = setUp();
		const refusal = deps.access.require(as(reader), {
			projectId: "proj-b",
			needed: "operator",
			operation: "vault.propose",
			subject: { kind: "vault.item", id: "item-1" },
		});
		await expect(refusal).rejects.toMatchObject({ code: "forbidden" });
		const denied = deps.audit.ofType("access.denied");
		expect(denied).toHaveLength(1);
		expect(denied[0]).toMatchObject({
			source: "access",
			actor: reader,
			organisationId: ORG,
			projectId: "proj-b",
			subject: { kind: "vault.item", id: "item-1" },
			data: { operation: "vault.propose", needed: "operator" },
		});
		expect(await deps.access.allows(as(reader), { projectId: "proj-b", needed: "operator" })).toBe(false);
		expect(deps.audit.ofType("access.denied")).toHaveLength(1);
	});
});
