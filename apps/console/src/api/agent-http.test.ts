// The skills and memory pages' API sources against the real routes (`createSkillsApi`, `createMemoryApi` over the
// in-memory stores), as the console calls a deployed gateway.
import { type CallContext, HarbourError } from "@harbour/contracts";
import { createMemoryApi } from "@harbour/memory/http";
import { createMemoryMemory } from "@harbour/memory/memory";
import { createSkillsApi } from "@harbour/skills/http";
import { createMemorySkills } from "@harbour/skills/memory";
import { describe, expect, it } from "vitest";
import { apiAgent } from "./agent-http.ts";

const ORG = "org-a";
const TOM: CallContext = { actor: { kind: "human", userId: "tom" }, organisationId: ORG };
const SKILL_MD = "---\nname: pr-review\ndescription: Review a PR.\n---\n\nRead the diff.\n";

async function setUp() {
	const skills = createMemorySkills();
	const memory = createMemoryMemory();
	const authenticate = async (request: Request) => {
		if (request.headers.get("cf-access-jwt-assertion") !== "tom") throw new HarbourError("forbidden", "Who?");
		return TOM;
	};
	const skillsApi = createSkillsApi({ skills, authenticate });
	const memoryApi = createMemoryApi({ memory, authenticate });
	const calls: string[] = [];
	let signedIn = true;
	const fetchApi = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://harbour.test"), init);
		calls.push(`${request.method} ${new URL(request.url).pathname}`);
		if (!signedIn) return new Response(null, { status: 401 });
		request.headers.set("cf-access-jwt-assertion", "tom");
		return (await skillsApi.fetch(request)) ?? (await memoryApi.fetch(request)) ?? new Response(null, { status: 404 });
	};
	let unauthenticated = 0;
	const agent = apiAgent({ fetch: fetchApi as typeof fetch, onUnauthenticated: () => (unauthenticated += 1) });

	const created = await skills.create(TOM, {
		owner: { kind: "organisation", organisationId: ORG },
		name: "pr-review",
		description: "Review a PR.",
	});
	const draft = await skills.saveDraft(TOM, created.id, {
		files: [
			{ path: "SKILL.md", content: SKILL_MD },
			{ path: "scripts/diff.sh", content: "git diff\n" },
		],
	});
	await skills.publish(TOM, created.id, { expectedDigest: draft.digest });

	const space = await memory.createSpace(TOM, { owner: { kind: "organisation", organisationId: ORG }, name: "Team" });
	await memory.importSnapshot(TOM, space.id, {
		sourceId: "sal-memory",
		ref: "abc123",
		concepts: [
			{
				id: "projects/harbour/placement",
				title: "Harbour lives in weur",
				statement: "D1, R2 and objects go in weur.",
				scope: { kind: "project", project: "harbour" },
				sources: ["tvdavies/harbour#140"],
				setBy: "owner",
				status: "active",
				updatedAt: Date.UTC(2026, 9, 20),
			},
		],
	});
	return {
		agent,
		calls,
		skillId: created.id,
		spaceId: space.id,
		signOut: () => (signedIn = false),
		unauthenticated: () => unauthenticated,
	};
}

describe("the console's skills and memory over the public API", () => {
	it("reads skills: the list, a package, its revisions and a file", async () => {
		const { agent, skillId, calls } = await setUp();
		const listed = await agent.skills.list({});
		expect(listed.items.map((item) => item.name)).toEqual(["pr-review"]);
		expect((await agent.skills.get(skillId)).name).toBe("pr-review");
		const revisions = await agent.skills.listRevisions(skillId);
		expect(revisions.items.map((item) => item.revision)).toEqual([1]);
		const revision = await agent.skills.getRevision(skillId, 1);
		expect(revision.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "scripts/diff.sh"]);
		expect(await agent.skills.readFile(skillId, 1, "scripts/diff.sh")).toBe("git diff\n");
		expect(calls).toContain(`GET /v1/skills/${skillId}/revisions/1/file`);
	});

	it("reads memory: spaces, concepts by ID with slashes, search and recall; and serves no proposals", async () => {
		const { agent, spaceId, calls } = await setUp();
		const spaces = await agent.spaces();
		expect(spaces.map((space) => space.name)).toEqual(["Team"]);
		expect(spaces[0]?.snapshot).toMatchObject({ sourceId: "sal-memory", ref: "abc123" });
		const concepts = await agent.memory.listConcepts(spaceId, { status: "active" });
		expect(concepts.items.map((concept) => concept.id)).toEqual(["projects/harbour/placement"]);
		expect((await agent.memory.getConcept(spaceId, "projects/harbour/placement")).title).toBe("Harbour lives in weur");
		expect(calls).toContain(`GET /v1/memory/spaces/${spaceId}/concepts/projects%2Fharbour%2Fplacement`);
		const hits = await agent.memory.search({ spaceIds: [spaceId], query: "weur" });
		expect(hits.map((hit) => hit.concept.id)).toEqual(["projects/harbour/placement"]);
		const recall = await agent.memory.recall({
			spaceIds: [spaceId],
			query: "where does harbour put D1",
			scopes: { projects: ["harbour"] },
		});
		expect(recall.manifest.map((entry) => entry.conceptId)).toEqual(["projects/harbour/placement"]);
		// The API serves reads only: the page shows no Proposals view.
		expect(agent.memory.listProposals).toBeUndefined();
		expect(agent.memory.decide).toBeUndefined();
		expect(agent.author).toBeUndefined();
	});

	it("says when the sign-in has ended", async () => {
		const { agent, signOut, unauthenticated } = await setUp();
		signOut();
		await expect(agent.spaces()).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
		expect(unauthenticated()).toBe(1);
	});
});
