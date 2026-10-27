import { syncSkillSources } from "@harbour/skills/sources";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { afterEach, describe, expect, it } from "vitest";
import { okfConcept } from "../src/okf.ts";
import { SAL_RECALL_PREAMBLE, salRecallRenderer } from "../src/recall-renderer.ts";
import { gitSkillSource } from "../src/skill-sources.ts";
import { prepareSalWorker, startSalWorkerSession } from "../src/worker.ts";
import { conceptFile, source, tempRepo } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const skillMd = (name: string, description: string, extra = "") =>
	`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;
const at = "2026-10-20T10:00:00.000Z";

describe("salRecallRenderer", () => {
	const renderer = salRecallRenderer({ exists: (path) => path === "/present.md" });
	const concept = (id: string, fields: Record<string, unknown>, body: string) => ({
		...okfConcept(id, conceptFile({ generated: { by: "sal", at }, ...fields }, body)).concept,
		spaceId: "s",
		version: 1,
		tags: [],
	});

	it("renders a match as Sal does: scope, learned_from, updated, the first source and missing local sources", () => {
		const block = renderer.concept(
			concept(
				"projects/sal/ipad-app",
				{
					title: "iPad\napp",
					sources: [source('slack:"T1"/<C1>'), source("/missing.md"), source("file:///present.md")],
					sal: { learned_from: "task" },
				},
				"The iPad app.",
			) as never,
			{ reason: "search", stale: true },
		);
		expect(block).toEqual({
			text: `<memory_concept id="projects/sal/ipad-app" recalled="match" scope="project" learned_from="task" updated="2026-10-20" stale="true" source="slack:T1/C1" missing_sources="1">\n# iPad app\nThe iPad app.\n</memory_concept>`,
			truncated: false,
		});
	});

	it("renders the profile lean and an exception with what it applies to and overrides, cutting long bodies", () => {
		const profile = renderer.concept(
			concept("personal/timezone", { title: "Time", sources: [source("slack:x")] }, "x".repeat(1300)) as never,
			{ reason: "profile", stale: false },
		);
		expect(profile.truncated).toBe(true);
		expect(profile.text).toBe(
			`<memory_concept id="personal/timezone" recalled="profile" learned_from="owner" updated="2026-10-20">\n# Time\n${"x".repeat(1200)}\n…(truncated; memory_read has the rest)\n</memory_concept>`,
		);
		const exception = renderer.concept(
			concept(
				"personal/sweep-exception",
				{ title: "E", sources: [source("s")], sal: { applies_to: "docket:TASK-1", overrides: "personal/sweep" } },
				"Body",
			) as never,
			{ reason: "exception", stale: false },
		);
		expect(exception.text).toContain(
			'recalled="exception" scope="exception" learned_from="owner" updated="2026-10-20" applies_to="docket:TASK-1" overrides="personal/sweep" source="s"',
		);
		expect(renderer.open).toBe(`<memory_recall>\n${SAL_RECALL_PREAMBLE}`);
		expect(renderer.omitted(["a/b", "c/d"])).toContain("only for size, not because they are unknown: a/b, c/d.");
	});
});

describe("prepareSalWorker and startSalWorkerSession", () => {
	it("pins memory and skills per session, records their refs, and recalls as a Sal worker", async () => {
		const memoryRepo = tempRepo();
		const skillsRepo = tempRepo();
		cleanups.push(
			() => memoryRepo.remove(),
			() => skillsRepo.remove(),
		);
		const generated = { by: "sal", at };
		const memoryCommit = memoryRepo.commit({
			"knowledge/index.md": "# Index",
			"knowledge/personal/timezone.md": conceptFile(
				{ title: "Local time", tags: ["profile"], generated, sources: [source("slack:1")] },
				"Use UK time.",
			),
			"knowledge/personal/bug-sweep-job.md": conceptFile(
				{ title: "Bug sweep job", tags: ["bug-sweep"], generated, sources: [source("slack:2")] },
				"The bug sweep runs at 15:00.",
			),
			"knowledge/personal/bug-sweep-exception.md": conceptFile(
				{
					title: "Sweep exception for one task",
					generated,
					sources: [source("slack:3")],
					sal: { applies_to: "docket:TASK-9", overrides: "personal/bug-sweep-job" },
				},
				"For TASK-9 the sweep skips staging.",
			),
			"knowledge/projects/harbour/sweep-notes.md": conceptFile(
				{ title: "Harbour sweep notes", generated, sources: [source("slack:4")] },
				"Notes.",
			),
		});
		const firstSkills = skillsRepo.commit({
			"skills/general/sweep/SKILL.md": skillMd("sweep", "Run a bug sweep"),
			"skills/general/yolo/SKILL.md": skillMd("yolo-ticket", "Yolo", "disable-model-invocation: true\n"),
			"skills/general/slack/SKILL.md": skillMd("slack", "Post to Slack as Tom"),
		});
		const host = await prepareSalWorker({
			organisationId: "tom",
			memory: { repo: memoryRepo.dir, ref: "main" },
			skills: [{ source: gitSkillSource({ id: "agent-toolkit", repo: skillsRepo.dir, paths: ["skills"] }) }],
			now: () => Date.parse("2026-10-27T20:00:00Z"),
		});
		expect(host.pinned).toEqual([
			{ sourceId: "sal-memory", ref: memoryCommit },
			{ sourceId: "agent-toolkit", ref: firstSkills },
		]);
		expect(host.published.excluded).toEqual([{ name: "slack", sourceId: "agent-toolkit" }]);

		const session = await startSalWorkerSession(host, {
			sessionId: "s1",
			task: "TASK-9",
			brief: "Run the bug sweep for the Harbour project",
		});
		expect(session.listings.map((listing) => [listing.name, listing.revision, listing.path])).toEqual([
			["sweep", 1, "/skills/sweep/SKILL.md"],
			["yolo-ticket", 1, "/skills/yolo-ticket/SKILL.md"],
		]);
		expect(session.revisions.map((revision) => revision.source)).toEqual([
			{ sourceId: "agent-toolkit", ref: firstSkills },
			{ sourceId: "agent-toolkit", ref: firstSkills },
		]);
		// Pi keeps a skill with disable-model-invocation out of the prompt; it is still pinned and mounted.
		expect(session.skillsPrompt).toContain("<name>sweep</name>");
		expect(session.skillsPrompt).not.toContain("yolo-ticket");
		expect(session.recall.manifest.map((item) => [item.conceptId, item.reason, item.snapshotRef])).toEqual([
			["personal/timezone", "profile", memoryCommit],
			["projects/harbour/sweep-notes", "search", memoryCommit],
			// The exception travels with the general concept it overrides.
			["personal/bug-sweep-job", "search", memoryCommit],
			["personal/bug-sweep-exception", "exception", memoryCommit],
		]);
		expect(session.recall.text.startsWith(`<memory_recall>\n${SAL_RECALL_PREAMBLE}\n`)).toBe(true);

		// The session reads its pinned packages read-only at /skills.
		const workspaces = createMemoryWorkspaces({ sources: [host.skillsMount] });
		const workspace = await workspaces.create(host.ctx, {
			owner: { kind: "organisation", organisationId: "tom" },
			sessionId: "s1",
			mounts: [{ path: "/skills", source: "skills", ref: "s1" }],
		});
		const read = await workspaces.read(host.ctx, workspace.id, session.listings[0]!.path);
		expect(new TextDecoder().decode(read.content)).toContain("description: Run a bug sweep");

		// Another task does not get TASK-9's exception.
		const other = await startSalWorkerSession(host, { sessionId: "s2", task: "TASK-10", brief: "Run the bug sweep" });
		expect(other.recall.manifest.map((item) => item.conceptId)).not.toContain("personal/bug-sweep-exception");

		// A new commit of the skills publishes new revisions; s1 keeps what it was pinned to.
		const secondSkills = skillsRepo.commit({ "skills/general/sweep/SKILL.md": skillMd("sweep", "Run a better sweep") });
		const toolkit = gitSkillSource({ id: "agent-toolkit", repo: skillsRepo.dir, paths: ["skills"] });
		await syncSkillSources(host.skills, host.ctx, {
			sources: [{ source: toolkit, ref: secondSkills }],
			owner: { kind: "organisation", organisationId: "tom" },
			exclude: ["slack"],
		});
		const again = await startSalWorkerSession(host, { sessionId: "s1", task: "TASK-9", brief: "Run the bug sweep" });
		expect(again.listings.find((listing) => listing.name === "sweep")).toMatchObject({
			revision: 1,
			description: "Run a bug sweep",
		});
		const fresh = await startSalWorkerSession(host, { sessionId: "s3", brief: "Run the bug sweep" });
		expect(fresh.listings.find((listing) => listing.name === "sweep")).toMatchObject({
			revision: 2,
			description: "Run a better sweep",
		});
		expect(fresh.revisions.find((revision) => revision.name === "sweep")?.source).toEqual({
			sourceId: "agent-toolkit",
			ref: secondSkills,
		});
	});
});
