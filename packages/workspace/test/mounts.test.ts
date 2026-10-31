import { type CallContext, isKantelError, type MountSource, type Skills } from "@kantel/contracts";
import { createMemorySkills } from "@kantel/skills/memory";
import { actors, type ConformanceDeps, contextFor, createDeps } from "@kantel/testing/harness";
import { createMemoryWorkspaces } from "@kantel/workspace/memory";
import {
	createSkillsMountSource,
	createWorkspaceProjectFiles,
	projectFilesWorkspaceId,
	sessionSkillVisibility,
	skillsMountVersion,
} from "@kantel/workspace/mounts";
import { beforeEach, describe, expect, it } from "vitest";

const ORG = "org-1";
const PROJECT = "proj-1";
const OTHER = "proj-2";
const SESSION = "sess-1";
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

describe("the skills mount", () => {
	let deps: ConformanceDeps;
	let skills: Skills;
	let source: MountSource;
	let reviewId: string;

	/** An admin across the organisation, who looks after its own skills. */
	const dana = contextFor(actors.human("dana"), ORG);

	async function publish(skillId: string, files: { path: string; content: string }[], as = alice) {
		const { digest } = await skills.saveDraft(as, skillId, { files });
		return skills.publish(as, skillId, { expectedDigest: digest });
	}

	beforeEach(async () => {
		deps = createDeps();
		deps.tenancy.bind(alice.actor, ORG, "operator", PROJECT);
		// Changing an organisation's skill needs a role across the organisation (M2-BE5).
		deps.tenancy.bind(dana.actor, ORG, "admin");
		deps.tenancy.bind(bob.actor, ORG, "operator", OTHER);
		deps.tenancy.session({ id: SESSION, organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
		skills = createMemorySkills({ clock: deps.clock, access: deps.access });
		const review = await skills.create(alice, {
			owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
			name: "pr-review",
			description: "Review",
		});
		reviewId = review.id;
		await publish(reviewId, [
			{ path: "SKILL.md", content: "---\nname: pr-review\ndescription: Review a PR\n---\nSteps" },
			{ path: "scripts/run.sh", content: "echo run" },
		]);
		const notes = await skills.create(dana, {
			owner: { kind: "organisation", organisationId: ORG },
			name: "notes",
			description: "Notes",
		});
		await publish(notes.id, [{ path: "SKILL.md", content: "---\nname: notes\ndescription: Take notes\n---\n" }], dana);
		const hidden = await skills.create(bob, {
			owner: { kind: "project", organisationId: ORG, projectId: OTHER },
			name: "hidden",
			description: "Another project's",
		});
		const { digest } = await skills.saveDraft(bob, hidden.id, { files: [{ path: "SKILL.md", content: "secret" }] });
		await skills.publish(bob, hidden.id, { expectedDigest: digest });
		source = createSkillsMountSource({ skills, visibility: sessionSkillVisibility(deps.tenancy.sessions) });
	});

	it("mounts a session's pinned skills read-only at /skills/<name>, where its listings point", async () => {
		const workspaces = createMemoryWorkspaces({ clock: deps.clock, sources: [source], access: deps.access });
		const record = await workspaces.create(alice, {
			owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
			sessionId: SESSION,
			mounts: [{ path: "/skills", source: "skills", ref: SESSION }],
		});
		const pins = await skills.pinForSession(alice, SESSION, { projectId: PROJECT });
		expect(record.mounts[0]).toMatchObject({ version: skillsMountVersion(pins), readOnly: true });

		const top = await workspaces.list(alice, record.id, { path: "/skills" });
		expect(top.items.map((entry) => [entry.path, entry.kind])).toEqual([
			["/skills/notes", "directory"],
			["/skills/pr-review", "directory"],
		]);
		const tree = await workspaces.list(alice, record.id, { path: "/skills/pr-review", recursive: true });
		expect(tree.items.map((entry) => entry.path)).toEqual([
			"/skills/pr-review/SKILL.md",
			"/skills/pr-review/scripts",
			"/skills/pr-review/scripts/run.sh",
		]);
		const listing = (await skills.list(alice, { projectId: PROJECT })).items.find((item) => item.name === "pr-review")!;
		const file = await workspaces.read(alice, record.id, listing.path);
		expect(text(file.content)).toContain("Steps");

		// Read-only: a commit under the mount is refused.
		expect(
			await codeOf(
				workspaces.commit(alice, record.id, {
					baseVersion: 0,
					changes: [{ op: "put", path: "/skills/pr-review/SKILL.md", content: "x" }],
				}),
			),
		).toBe("refused");
	});

	it("keeps showing the pinned revision after a newer one is published", async () => {
		const workspaces = createMemoryWorkspaces({ clock: deps.clock, sources: [source], access: deps.access });
		const record = await workspaces.create(alice, {
			owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
			sessionId: SESSION,
			mounts: [{ path: "/skills", source: "skills", ref: SESSION }],
		});
		await publish(reviewId, [{ path: "SKILL.md", content: "---\nname: pr-review\ndescription: v2\n---\nNew" }]);
		expect(text((await workspaces.read(alice, record.id, "/skills/pr-review/SKILL.md")).content)).toContain("Steps");
		expect(await source.latestVersion(alice, SESSION)).toBe(record.mounts[0]?.version);
	});

	it("never shows another project's skill, even under a forged pin", async () => {
		const hidden = (await skills.list(bob, { projectId: OTHER })).items.find((item) => item.name === "hidden")!;
		const forged = skillsMountVersion([{ skillId: hidden.skillId, revision: 1 }]);
		expect(await codeOf(source.list(alice, SESSION, forged, ""))).toBe("forbidden");
		expect(await codeOf(source.read(alice, SESSION, forged, "hidden/SKILL.md"))).toBe("forbidden");
		expect(await codeOf(source.list(alice, SESSION, "not-a-version", ""))).toBe("not_found");
		expect(await codeOf(source.list(alice, SESSION, "pins:%@1", ""))).toBe("not_found");
		const pinned = await source.latestVersion(alice, SESSION);
		expect(await codeOf(source.read(alice, SESSION, pinned, "hidden/SKILL.md"))).toBe("not_found");
		expect(await codeOf(source.read(alice, SESSION, pinned, "pr-review/missing.md"))).toBe("not_found");
		expect(await codeOf(source.list(alice, SESSION, pinned, "pr-review/SKILL.md"))).toBe("invalid");
	});
});
