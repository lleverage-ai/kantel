import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallContext, ConceptInput } from "@kantel/contracts";
import { createMemoryMemory } from "@kantel/memory/memory";
import { withBundlePublishing } from "@kantel/memory/publish";
import { afterEach, describe, expect, it } from "vitest";
import { commitFiles, readTree } from "../src/git.ts";
import { salMemorySource } from "../src/memory-source.ts";
import { okfConcept, okfIndex } from "../src/okf.ts";
import { conceptFile, source, tempRepo } from "./helpers.ts";

const service: CallContext = { actor: { kind: "service", serviceId: "sal-worker" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "worker", sessionId: "session-1" },
	organisationId: "org-a",
};
const decoder = new TextDecoder();
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** Paths a commit changed against its parent. */
function changedIn(dir: string, commit: string): string[] {
	return git(dir, "diff-tree", "--no-commit-id", "--name-only", "-r", `${commit}^`, commit).split("\n").filter(Boolean);
}

async function wire(repo: string, branch: string) {
	const sourceOf = salMemorySource({ repo, branch, producer: "harbour/test" });
	const memory = withBundlePublishing({
		memory: createMemoryMemory(),
		sourceFor: () => sourceOf,
		render: sourceOf.render,
	});
	const space = await memory.createSpace(service, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name: "Sal memory",
	});
	await memory.importSnapshot(service, space.id, await sourceOf.snapshot(branch));
	const apply = async (write: Parameters<typeof memory.propose>[2]) => {
		const proposal = await memory.propose(agent, space.id, write);
		return memory.decide(service, proposal.id, { outcome: "apply" });
	};
	return { memory, space, apply, source: sourceOf };
}

function concept(id: string, title: string, statement: string): ConceptInput {
	return { id, title, statement, scope: { kind: "project", project: "harbour" }, sources: ["sal:session/abc"] };
}

describe("salMemorySource", () => {
	function fixture() {
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const first = repo.commit({
			"README.md": "# sal-memory\n",
			"knowledge/index.md":
				'---\nokf_version: "0.2"\n---\n\n# Sal knowledge\n\n- [Project knowledge](projects/index.md) - Scoped knowledge.\n',
			"knowledge/projects/index.md": "# Project knowledge\n\n- [Kantel](harbour/index.md)\n",
			"knowledge/projects/harbour/index.md":
				"# Kantel\n\n- [CI runs on push](ci.md)\n- [Deploys need a green build](deploys.md) - Release rule\n",
			"knowledge/projects/harbour/ci.md": conceptFile(
				{
					title: "CI runs on push",
					sources: [source("https://github.com/tvdavies/harbour")],
					sal: { learned_from: "owner", scope: "project", project: "harbour" },
				},
				"CI runs biome, tsc and vitest on every push.",
			),
			"knowledge/projects/harbour/deploys.md": conceptFile(
				{
					title: "Deploys need a green build",
					description: "Release rule",
					extra_field: { kept: true },
					sources: [source("https://example.com/a")],
					sal: { learned_from: "owner", scope: "project", project: "harbour" },
				},
				"Deploy only from a green main build.",
			),
			"knowledge/projects/harbour/Broken Name.md": "not a concept Sal reads\n",
		});
		return { repo, first };
	}

	it("publishes nothing when the bundle already says what the space holds", async () => {
		const { repo, first } = fixture();
		const { memory, space } = await wire(repo.dir, "main");
		expect((await memory.publishBundle(service, space.id)).ref).toBe(first);
		expect(git(repo.dir, "rev-parse", "main")).toBe(first);
	});

	it("commits an applied write as Sal's concept file with its indexes, and leaves every other file alone", async () => {
		const { repo, first } = fixture();
		const { memory, space, apply, source: sal } = await wire(repo.dir, "main");
		await apply({ op: "remember", concept: concept("projects/harbour/lint", "Biome lints", "Biome lints the code.") });
		const second = git(repo.dir, "rev-parse", "main");
		expect(second).not.toBe(first);
		expect(changedIn(repo.dir, second)).toEqual([
			"knowledge/projects/harbour/index.md",
			"knowledge/projects/harbour/lint.md",
		]);
		const lint = git(repo.dir, "show", `${second}:knowledge/projects/harbour/lint.md`);
		expect(lint).toContain('title: "Biome lints"');
		expect(lint).toContain('"learned_from":"session"');
		expect(lint).toContain('generated: {"by":"harbour/test"');
		expect(git(repo.dir, "show", `${second}:knowledge/projects/harbour/index.md`)).toBe(
			"# Kantel\n\n- [CI runs on push](ci.md)\n- [Deploys need a green build](deploys.md) - Release rule\n- [Biome lints](lint.md)",
		);
		expect(git(repo.dir, "log", "-1", "--format=%an <%ae>%n%B", second)).toContain(`Harbour-Space: ${space.id}`);

		// Sal reads it back as Kantel wrote it.
		const snapshot = await sal.snapshot(second);
		expect(snapshot.ref).toBe(second);
		expect(snapshot.concepts.find((item) => item.id === "projects/harbour/lint")).toMatchObject({
			title: "Biome lints",
			// As Sal reads a body: whole, from the blank line after the frontmatter.
			statement: "\nBiome lints the code.\n",
			setBy: "learned",
			status: "active",
			sources: ["sal:session/abc"],
		});
		expect((await memory.publishBundle(service, space.id)).ref).toBe(second);
	});

	it("writes a correction, a supersede and a forget as Sal does, keeping fields Kantel has no place for", async () => {
		const { repo } = fixture();
		const { memory, space } = await wire(repo.dir, "main");
		const deploys = await memory.getConcept(service, space.id, "projects/harbour/deploys");
		// An agent may not change what the owner set: the owner's service corrects it.
		const corrected = await memory.propose(service, space.id, {
			op: "correct",
			concept: {
				...concept("projects/harbour/deploys", deploys.title, "Deploy only from a green main build, never on Fridays."),
				description: "Release rule",
				sources: ["https://example.com/a", "https://example.com/b"],
			},
			expectedVersion: deploys.version,
		});
		await memory.decide(service, corrected.id, { outcome: "apply" });
		const afterCorrect = git(repo.dir, "rev-parse", "main");
		const text = git(repo.dir, "show", `${afterCorrect}:knowledge/projects/harbour/deploys.md`);
		expect(text).toContain('extra_field: {"kept":true}');
		expect(text).toContain('"resource":"https://example.com/a","title":"Owner instruction","author":"human:tom"');
		expect(text).toContain('{"id":"harbour","resource":"https://example.com/b"}');
		expect(text.endsWith("\n\nDeploy only from a green main build, never on Fridays.")).toBe(true);

		const ci = await memory.getConcept(service, space.id, "projects/harbour/ci");
		const superseding = await memory.propose(service, space.id, {
			op: "supersede",
			conceptId: ci.id,
			expectedVersion: ci.version,
			replacement: concept("projects/harbour/ci-checks", "CI checks", "CI runs biome, tsc, vitest and the e2e suite."),
		});
		await memory.decide(service, superseding.id, { outcome: "apply" });
		const afterSupersede = git(repo.dir, "rev-parse", "main");
		const old = git(repo.dir, "show", `${afterSupersede}:knowledge/projects/harbour/ci.md`);
		expect(old).toContain('status: "deprecated"');
		expect(old).toContain('"superseded_by":"projects/harbour/ci-checks"');
		expect(old).toContain("> Superseded by [CI checks](/projects/harbour/ci-checks.md) on ");
		expect(okfConcept("projects/harbour/ci", `${old}\n`).concept).toMatchObject({
			status: "superseded",
			supersededBy: "projects/harbour/ci-checks",
		});

		const lint = await memory.getConcept(service, space.id, "projects/harbour/ci-checks");
		const forgetting = await memory.propose(service, space.id, {
			op: "forget",
			conceptId: lint.id,
			expectedVersion: lint.version,
			reason: "Wrong",
		});
		await memory.decide(service, forgetting.id, { outcome: "apply" });
		const afterForget = git(repo.dir, "rev-parse", "main");
		const gone = git(repo.dir, "show", `${afterForget}:knowledge/projects/harbour/ci-checks.md`);
		expect(okfConcept("projects/harbour/ci-checks", `${gone}\n`).concept.status).toBe("forgotten");
		expect(gone).not.toContain("e2e suite");
		expect(git(repo.dir, "show", `${afterForget}:knowledge/projects/harbour/index.md`)).toBe(
			"# Kantel\n\n- [Deploys need a green build](deploys.md) - Release rule",
		);
		expect(git(repo.dir, "show", `${afterForget}:knowledge/projects/harbour/Broken Name.md`)).toBe(
			"not a concept Sal reads",
		);
		expect(git(repo.dir, "show", `${afterForget}:README.md`)).toBe("# sal-memory");
	});

	it("never moves a branch that moved since it was read", () => {
		const { repo, first } = fixture();
		const second = repo.commit({ "knowledge/projects/harbour/other.md": "x\n" });
		expect(() =>
			commitFiles(repo.dir, {
				branch: "main",
				parent: first,
				files: [{ path: "knowledge/x.md", text: "x\n" }],
				message: "stale",
				author: { name: "Test", email: "test@example.com" },
			}),
		).toThrow(/update-ref/);
		expect(git(repo.dir, "rev-parse", "main")).toBe(second);
		expect(() =>
			commitFiles(repo.dir, {
				branch: "main",
				parent: second,
				files: [{ path: "../escape.md", text: "x\n" }],
				message: "escape",
				author: { name: "Test", email: "test@example.com" },
			}),
		).toThrow(/Not a repository path/);
		expect(() =>
			commitFiles(repo.dir, {
				branch: "main",
				parent: second,
				files: [{ path: "knowledge/x.md\n0 0000000000000000000000000000000000000000\tREADME.md", text: "x\n" }],
				message: "inject",
				author: { name: "Test", email: "test@example.com" },
			}),
		).toThrow(/Not a repository path/);
		expect(git(repo.dir, "rev-parse", "main")).toBe(second);
	});

	it("refuses to publish a concept Sal's layout has no file for, rather than leave it out", async () => {
		const { repo } = fixture();
		const sal = salMemorySource({ repo: repo.dir, branch: "main" });
		await expect(sal.publish("space-1", [{ path: "projects/harbour/index.md", content: "x\n" }])).rejects.toThrow(
			/cannot hold/,
		);
	});
});

const SAL_MEMORY = process.env.SAL_MEMORY_REPO ?? join(process.env.HOME ?? "", "dev/tvdavies/sal-memory");

describe.skipIf(!existsSync(join(SAL_MEMORY, ".git")))("salMemorySource on the real sal-memory repo", () => {
	function clone() {
		const dir = mkdtempSync(join(tmpdir(), "harbour-sal-memory-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		execFileSync("git", ["clone", "-q", "--bare", "--no-hardlinks", SAL_MEMORY, dir]);
		return dir;
	}

	it("round-trips the whole bundle without a change, and Kantel's indexes match every one Sal wrote", async () => {
		const repo = clone();
		const head = git(repo, "rev-parse", "HEAD");
		const branch = git(repo, "symbolic-ref", "--short", "HEAD");
		const { memory, space } = await wire(repo, branch);
		expect((await memory.publishBundle(service, space.id)).ref).toBe(head);

		const tree = new Map(
			readTree(repo, head, ["knowledge"]).files.map((file) => [
				file.path.slice("knowledge/".length),
				decoder.decode(file.bytes),
			]),
		);
		const mismatched = [...tree.keys()]
			.filter((path) => path.endsWith("/index.md"))
			.map((path) => path.slice(0, -"/index.md".length))
			.filter((dir) => okfIndex(dir, tree) !== tree.get(`${dir}/index.md`));
		expect(mismatched).toEqual([]);
	});

	it("commits one applied write as its concept file and the indexes above it, nothing else", async () => {
		const repo = clone();
		const branch = git(repo, "symbolic-ref", "--short", "HEAD");
		const { apply } = await wire(repo, branch);
		await apply({
			op: "remember",
			concept: concept(
				"projects/harbour/okf-export-test",
				"Kantel publishes memory to sal-memory",
				"Kantel's M2-BE5 test commits one learned concept into a throwaway clone of sal-memory.",
			),
		});
		expect(changedIn(repo, git(repo, "rev-parse", branch))).toEqual([
			"knowledge/projects/harbour/index.md",
			"knowledge/projects/harbour/okf-export-test.md",
		]);
	});
});
