import { type CallContext, isKantelError, type WorkspaceRecord } from "@kantel/contracts";
import { actors, type ConformanceDeps, contextFor, createDeps } from "@kantel/testing/harness";
import { createMemoryWorkspaces } from "@kantel/workspace/memory";
import { beforeEach, describe, expect, it } from "vitest";

const ORG = "org-1";
const PROJECT = "proj-1";
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function codeOf(operation: Promise<unknown>): Promise<string> {
	try {
		await operation;
		return "none";
	} catch (error) {
		return isKantelError(error) ? error.code : String(error);
	}
}

/**
 * A session's own workspace is bound to it (`sessionId`), as the self-hosted gateway's console sessions are. Its
 * subagents, however far down, work in it; nothing beside or below them gets anything new.
 */
describe("a workspace bound to a session, used by the session's subagents", () => {
	let deps: ConformanceDeps;
	let workspaces: ReturnType<typeof createMemoryWorkspaces>;
	let bound: WorkspaceRecord;
	const agentIn = (sessionId: string, projectId = PROJECT): CallContext =>
		contextFor(actors.agent("agent-1", sessionId), ORG, projectId);

	beforeEach(async () => {
		deps = createDeps();
		const session = (id: string, parentSessionId?: string, projectId = PROJECT) =>
			deps.tenancy.session({
				id,
				organisationId: ORG,
				projectId,
				agentId: "agent-1",
				userId: "alice",
				visibility: "private",
				...(parentSessionId === undefined ? {} : { parentSessionId }),
			});
		session("root");
		session("child", "root");
		session("grandchild", "child");
		session("sibling", "root");
		session("other", undefined, "proj-2");
		session("other-child", "other", "proj-2");
		workspaces = createMemoryWorkspaces({ clock: deps.clock, audit: deps.audit, access: deps.access });
		bound = await workspaces.create(agentIn("root"), {
			owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
			sessionId: "root",
			seed: { name: "own", sources: [{ kind: "files", files: { "notes.md": "from the parent\n" } }] },
		});
	});

	it("lets a child and a grandchild read, list and write the root's workspace, and audits it through the chain", async () => {
		for (const sessionId of ["child", "grandchild"]) {
			const ctx = agentIn(sessionId);
			expect((await workspaces.get(ctx, bound.id)).id).toBe(bound.id);
			expect((await workspaces.list(ctx, bound.id)).items.map((item) => item.path)).toContain("notes.md");
			expect(decode((await workspaces.read(ctx, bound.id, "notes.md")).content)).toBe("from the parent\n");
			await workspaces.commit(ctx, bound.id, {
				baseVersion: (await workspaces.get(ctx, bound.id)).head,
				changes: [{ op: "put", path: `${sessionId}.md`, content: `written by ${sessionId}\n` }],
			});
		}
		const root = agentIn("root");
		expect(decode((await workspaces.read(root, bound.id, "grandchild.md")).content)).toBe("written by grandchild\n");
		const allowed = deps.audit.ofType("access.ancestor.allowed");
		expect(allowed.length).toBeGreaterThan(0);
		expect(
			allowed.find((event) => event.data?.operation === "workspace.commit" && event.sessionId === "grandchild"),
		).toMatchObject({
			subject: { kind: "workspace", id: bound.id },
			data: { ancestorSessionId: "root", ancestorDepth: 2 },
		});
		expect(deps.audit.ofType("access.denied")).toHaveLength(0);
	});

	it("refuses siblings, cousins and other projects, and gives the root nothing below its own child", async () => {
		expect(await codeOf(workspaces.read(agentIn("other-child", "proj-2"), bound.id, "notes.md"))).toBe("forbidden");
		const childOwn = await workspaces.create(agentIn("child"), {
			owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
			sessionId: "child",
		});
		expect(await codeOf(workspaces.get(agentIn("sibling"), childOwn.id))).toBe("forbidden");
		expect(await codeOf(workspaces.get(agentIn("grandchild"), childOwn.id))).toBe("none");
		const siblingOwn = await workspaces.create(agentIn("sibling"), {
			owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
			sessionId: "sibling",
		});
		expect(await codeOf(workspaces.get(agentIn("child"), siblingOwn.id))).toBe("forbidden");
		expect(await codeOf(workspaces.get(agentIn("grandchild"), siblingOwn.id))).toBe("forbidden");
		// The root reaches its child's as decide() always let it, and no further down.
		const grandchildOwn = await workspaces.create(agentIn("grandchild"), {
			owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
			sessionId: "grandchild",
		});
		expect(await codeOf(workspaces.get(agentIn("root"), childOwn.id))).toBe("none");
		expect(await codeOf(workspaces.get(agentIn("root"), grandchildOwn.id))).toBe("forbidden");
		const denied = deps.audit.ofType("access.denied");
		expect(denied.length).toBe(5);
		expect(denied.every((event) => String(event.data?.operation).startsWith("workspace."))).toBe(true);
	});
});
