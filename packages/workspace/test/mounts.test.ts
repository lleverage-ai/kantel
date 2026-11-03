import { type CallContext, isKantelError } from "@kantel/contracts";
import { actors, type ConformanceDeps, contextFor, createDeps } from "@kantel/testing/harness";
import { createMemoryWorkspaces } from "@kantel/workspace/memory";
import { createWorkspaceProjectFiles, projectFilesWorkspaceId } from "@kantel/workspace/mounts";
import { beforeEach, describe, expect, it } from "vitest";

const ORG = "org-1";
const PROJECT = "proj-1";
const OTHER = "proj-2";
const alice = contextFor(actors.human("alice"), ORG, PROJECT);
const bob = contextFor(actors.human("bob"), ORG, OTHER);
const carol = contextFor(actors.human("carol"), ORG, OTHER);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (isKantelError(error)) return error.code;
		throw error;
	}
	throw new Error("expected a KantelError");
}

describe("workspace-backed project files", () => {
	let deps: ConformanceDeps;
	beforeEach(() => {
		deps = createDeps();
		deps.tenancy.bind(alice.actor, ORG, "operator", PROJECT);
		deps.tenancy.bind(bob.actor, ORG, "viewer", PROJECT);
		deps.tenancy.bind(bob.actor, ORG, "operator", OTHER);
		deps.tenancy.bind(carol.actor, ORG, "operator", OTHER);
		deps.tenancy.session({ id: "sess-x", organisationId: ORG, projectId: PROJECT, agentId: "agent-x" });
	});

	it("keeps each project's files as a workspace owned by the project, under a derived ID", async () => {
		const trees = createMemoryWorkspaces({ clock: deps.clock, access: deps.access });
		const files = createWorkspaceProjectFiles({ workspaces: trees, access: deps.access });
		expect(await files.latestVersion(alice, PROJECT)).toBe("0");
		const written = await files.write!(alice, PROJECT, [{ op: "put", path: "README.md", content: "hello" }]);
		expect(written).toEqual({ version: "1", actor: alice.actor });

		const id = await projectFilesWorkspaceId(ORG, PROJECT);
		expect(id).not.toBe(await projectFilesWorkspaceId(ORG, OTHER));
		expect(id).not.toBe(await projectFilesWorkspaceId("org-2", PROJECT));
		const record = await trees.get(alice, id);
		expect(record.owner).toEqual({ kind: "project", organisationId: ORG, projectId: PROJECT });
		// The tree's history names the person who wrote, not the source.
		expect((await trees.history(alice, id)).items[0]?.actor).toEqual(alice.actor);

		// Another source over the same store sees the same tree: the files outlive one process.
		const again = createWorkspaceProjectFiles({ workspaces: trees, access: deps.access });
		expect(text(await again.read(alice, PROJECT, "1", "README.md"))).toBe("hello");
		expect(await again.list(alice, PROJECT, "1", "")).toEqual([
			expect.objectContaining({ path: "README.md", kind: "file", size: 5, version: "1" }),
		]);
		expect(await codeOf(again.read(alice, PROJECT, "9", "README.md"))).toBe("not_found");
		expect(await codeOf(again.read(alice, PROJECT, "v1", "README.md"))).toBe("not_found");
	});

	it("needs operator on the project to write", async () => {
		const trees = createMemoryWorkspaces({ clock: deps.clock, access: deps.access });
		const files = createWorkspaceProjectFiles({ workspaces: trees, access: deps.access });
		expect(await codeOf(files.write!(bob, PROJECT, [{ op: "put", path: "x", content: "x" }]))).toBe("forbidden");
		expect(await files.latestVersion(alice, PROJECT)).toBe("0");
	});

	it("retries blind writes that race on the head, so concurrent writers both land", async () => {
		const trees = createMemoryWorkspaces({ clock: deps.clock, access: deps.access });
		const files = createWorkspaceProjectFiles({ workspaces: trees, access: deps.access });
		await Promise.all([
			files.write!(alice, PROJECT, [{ op: "put", path: "a.md", content: "a" }]),
			files.write!(alice, PROJECT, [{ op: "put", path: "b.md", content: "b" }]),
			files.write!(alice, PROJECT, [{ op: "put", path: "c.md", content: "c" }]),
		]);
		expect(await files.latestVersion(alice, PROJECT)).toBe("3");
		expect((await files.list(alice, PROJECT, "3", "")).map((entry) => entry.path)).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("derives distinct IDs for pairs a naive join would merge", async () => {
		expect(await projectFilesWorkspaceId("a\nb", "c")).not.toBe(await projectFilesWorkspaceId("a", "b\nc"));
		expect(await projectFilesWorkspaceId(ORG, "\uD800")).not.toBe(await projectFilesWorkspaceId(ORG, "\uFFFD"));
	});

	it("never uses a tree under the derived ID that is not exactly the project's", async () => {
		const trees = createMemoryWorkspaces({ clock: deps.clock, access: deps.access });
		const files = createWorkspaceProjectFiles({ workspaces: trees, access: deps.access });
		const id = await projectFilesWorkspaceId(ORG, PROJECT);
		// Bob operates OTHER and takes PROJECT's derived ID first, seeding it with his own files.
		await trees.ensure(bob, id, {
			owner: { kind: "project", organisationId: ORG, projectId: OTHER },
			seed: { name: "bait", sources: [{ kind: "files", files: { "README.md": "bob's" } }] },
		});
		expect(await codeOf(files.latestVersion(alice, PROJECT))).toBe("conflict");
		expect(await codeOf(files.read(alice, PROJECT, "1", "README.md"))).toBe("conflict");
		expect(await codeOf(files.write!(alice, PROJECT, [{ op: "put", path: "secret.md", content: "s" }]))).toBe(
			"conflict",
		);
		expect((await trees.get(bob, id)).head).toBe(1);

		// A session-tied workspace under the ID is refused the same way.
		const sessionTrees = createMemoryWorkspaces({ clock: deps.clock, access: deps.access });
		await sessionTrees.ensure(alice, id, {
			owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
			sessionId: "sess-x",
		});
		const sessionFiles = createWorkspaceProjectFiles({ workspaces: sessionTrees, access: deps.access });
		expect(await codeOf(sessionFiles.latestVersion(alice, PROJECT))).toBe("conflict");
	});

	it("checks the caller against the record that won an ensure race", async () => {
		const trees = createMemoryWorkspaces({ clock: deps.clock, access: deps.access });
		const seed = (who: string) => ({ name: who, sources: [{ kind: "files" as const, files: { "x.md": who } }] });
		const results = await Promise.allSettled([
			trees.ensure(alice, "pf_contested", {
				owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
				seed: seed("alice"),
			}),
			// Carol operates only OTHER, so she may not see PROJECT's workspace if Alice's wins.
			trees.ensure(carol, "pf_contested", {
				owner: { kind: "project", organisationId: ORG, projectId: OTHER },
				seed: seed("bob"),
			}),
		]);
		const won = results.filter((result) => result.status === "fulfilled");
		const lost = results.filter((result) => result.status === "rejected");
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(1);
		expect(isKantelError(lost[0]?.reason, "forbidden")).toBe(true);
	});

	it("refuses a keyed ID another organisation holds", async () => {
		const trees = createMemoryWorkspaces({ clock: deps.clock });
		const owner = (organisationId: string) => ({ kind: "project", organisationId, projectId: PROJECT }) as const;
		const system = (organisationId: string): CallContext => ({ actor: actors.system(), organisationId });
		await trees.ensure(system(ORG), "pf_shared", { owner: owner(ORG) });
		expect(await codeOf(trees.ensure(system("org-2"), "pf_shared", { owner: owner("org-2") }))).toBe("conflict");
		expect(await codeOf(trees.ensure(system(ORG), "../escape", { owner: owner(ORG) }))).toBe("invalid");
		const [first, second] = await Promise.all([
			trees.ensure(system(ORG), "pf_race", { owner: owner(ORG) }),
			trees.ensure(system(ORG), "pf_race", { owner: owner(ORG) }),
		]);
		expect(second).toEqual(first);
	});
});
