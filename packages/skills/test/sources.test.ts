import type { CallContext, SkillFile, SkillSource } from "@harbour/contracts";
import { createMemorySkills } from "@harbour/skills/memory";
import { renderSkillListings, sessionSkillListings, syncSkillSource, syncSkillSources } from "@harbour/skills/sources";
import { describe, expect, it } from "vitest";

const service: CallContext = { actor: { kind: "service", serviceId: "sal" }, organisationId: "org-a" };
const owner = { kind: "organisation", organisationId: "org-a" } as const;

function skillMd(name: string, description: string): SkillFile {
	return { path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n` };
}

function sourceOf(
	byRef: Record<string, { name: string; description: string; files: SkillFile[] }[]>,
	id = "toolkit",
): SkillSource {
	return {
		id,
		async fetch(ref) {
			const skills = byRef[ref];
			if (skills === undefined) throw new Error(`no ref ${ref}`);
			return skills;
		},
	};
}

describe("syncSkillSource", () => {
	it("publishes every skill at the ref once, and names the ones the store refuses", async () => {
		const skills = createMemorySkills();
		const source = sourceOf({
			a1: [
				{ name: "pr-review", description: "Review a PR", files: [skillMd("pr-review", "Review a PR")] },
				{ name: "Bad Name", description: "Refused", files: [skillMd("bad", "Refused")] },
			],
			b2: [{ name: "pr-review", description: "Review a PR well", files: [skillMd("pr-review", "Review a PR well")] }],
		});
		const first = await syncSkillSource(skills, service, { source, ref: "a1", owner });
		expect(first.revisions.map((revision) => [revision.name, revision.revision, revision.source])).toEqual([
			["pr-review", 1, { sourceId: "toolkit", ref: "a1" }],
		]);
		expect(first.refused.map((entry) => entry.name)).toEqual(["Bad Name"]);
		const again = await syncSkillSource(skills, service, { source, ref: "a1", owner });
		expect(again.revisions[0]!.revision).toBe(1);
		const next = await syncSkillSource(skills, service, {
			source,
			ref: "b2",
			owner,
			extensions: () => ({ sal: { path: "skills/general/pr-review" } }),
		});
		expect(next.revisions[0]).toMatchObject({ revision: 2, extensions: { sal: { path: "skills/general/pr-review" } } });
	});
});

describe("syncSkillSources", () => {
	it("publishes the first source's skill of a name, leaves out excluded names, and reports both", async () => {
		const skills = createMemorySkills();
		const local = sourceOf(
			{ d1: [{ name: "dev", description: "Local dev", files: [skillMd("dev", "Local dev")] }] },
			"pi-agent",
		);
		const toolkit = sourceOf({
			c1: [
				{ name: "dev", description: "Toolkit dev", files: [skillMd("dev", "Toolkit dev")] },
				{ name: "slack", description: "Slack", files: [skillMd("slack", "Slack")] },
				{ name: "pr-review", description: "Review", files: [skillMd("pr-review", "Review")] },
			],
		});
		const result = await syncSkillSources(skills, service, {
			sources: [
				{ source: local, ref: "d1" },
				{ source: toolkit, ref: "c1" },
			],
			owner,
			exclude: ["slack"],
		});
		expect(
			result.revisions.map((revision) => [revision.name, revision.description, revision.source?.sourceId]),
		).toEqual([
			["dev", "Local dev", "pi-agent"],
			["pr-review", "Review", "toolkit"],
		]);
		expect(result.shadowed).toEqual([{ name: "dev", sourceId: "toolkit", by: "pi-agent" }]);
		expect(result.excluded).toEqual([{ name: "slack", sourceId: "toolkit" }]);
	});
});

describe("sessionSkillListings", () => {
	it("lists a session's pinned revisions, which later publishing does not move", async () => {
		const skills = createMemorySkills();
		const source = sourceOf({
			a1: [{ name: "pr-review", description: "Review a PR", files: [skillMd("pr-review", "Review a PR")] }],
			b2: [{ name: "pr-review", description: "Review a PR well", files: [skillMd("pr-review", "Review a PR well")] }],
		});
		await syncSkillSource(skills, service, { source, ref: "a1", owner });
		const first = await sessionSkillListings(skills, service, "session-1", {});
		expect(first.listings).toEqual([
			{
				skillId: first.pins[0]!.skillId,
				name: "pr-review",
				description: "Review a PR",
				revision: 1,
				path: "/skills/pr-review/SKILL.md",
			},
		]);
		await syncSkillSource(skills, service, { source, ref: "b2", owner });
		const later = await sessionSkillListings(skills, service, "session-1", {});
		expect(later.listings[0]).toMatchObject({ revision: 1, description: "Review a PR" });
		const fresh = await sessionSkillListings(skills, service, "session-2", {});
		expect(fresh.listings[0]).toMatchObject({ revision: 2, description: "Review a PR well" });
	});
});

describe("renderSkillListings", () => {
	it("renders Pi's available_skills block, escaped, and nothing for no skills", () => {
		const text = renderSkillListings([
			{
				skillId: "s1",
				name: "docs",
				description: `Tom's "docs" & <notes>`,
				revision: 1,
				path: "/skills/docs/SKILL.md",
			},
		]);
		expect(text).toContain(
			"<available_skills>\n  <skill>\n    <name>docs</name>\n    <description>Tom&apos;s &quot;docs&quot; &amp; &lt;notes&gt;</description>\n    <location>/skills/docs/SKILL.md</location>\n  </skill>\n</available_skills>",
		);
		expect(renderSkillListings([])).toBe("");
	});
});
