// Contract tests for the public API's skill routes (`@kantel/api`'s `skillRoutes`), called through the generated SDK
// against `createSkillsApi` over the in-memory store, as the console or a host's adapter calls a deployed Kantel.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type CallContext, KantelError } from "@kantel/contracts";
import { createSkillsApi } from "@kantel/skills/http";
import { createMemorySkills } from "@kantel/skills/memory";
import { ManualClock } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const ORG = "org-a";

/** Callers by bearer: a person, another person, a host's key, an agent, and a person in another organisation. */
const CALLERS: { [token: string]: CallContext } = {
	owner: { actor: { kind: "human", userId: "owner" }, organisationId: ORG },
	other: { actor: { kind: "human", userId: "other" }, organisationId: ORG },
	host: { actor: { kind: "service", serviceId: "sal" }, organisationId: ORG },
	agent: { actor: { kind: "agent", agentId: "a", sessionId: "s" }, organisationId: ORG },
	stranger: { actor: { kind: "human", userId: "stranger" }, organisationId: "org-b" },
};

const SKILL_MD = "---\nname: pr-review\ndescription: Review a pull request.\n---\n\n# Review\n\nRead the diff.\n";

function setUp(options: { authorizeImport?: (ctx: CallContext) => Promise<void> } = {}) {
	const clock = new ManualClock();
	const skills = createMemorySkills({ clock });
	const api = createSkillsApi({
		skills,
		authenticate: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			const ctx = CALLERS[token];
			if (ctx === undefined) throw new KantelError("forbidden", "Unknown caller");
			return ctx;
		},
		...(options.authorizeImport === undefined ? {} : { authorizeImport: options.authorizeImport }),
	});
	const fetchApi = async (input: string | URL | Request, init?: RequestInit) =>
		(await api.fetch(new Request(input, init))) ?? new Response("not mine", { status: 418 });
	const client = (token: string) => createKantelClient({ baseUrl: "https://harbour.test/v1", token, fetch: fetchApi });
	const importPrReview = (token: string, content = SKILL_MD, ref = "c1") =>
		client(token).importSkill({
			owner: { kind: "organisation", organisationId: ORG },
			name: "pr-review",
			description: "Review a pull request.",
			files: [
				{ path: "SKILL.md", content },
				{ path: "scripts/check.sh", content: "#!/bin/sh\necho ok\n" },
			],
			source: { sourceId: "agent-toolkit", ref },
		});
	return { clock, skills, api, fetchApi, client, importPrReview };
}

async function failure(promise: Promise<unknown>): Promise<KantelApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("expected the call to fail");
}

describe("the skill routes", () => {
	it("import a skill and read it back: the list, the package, its revisions and its files", async () => {
		const { client, importPrReview, clock } = setUp();
		const first = await importPrReview("host");
		expect(first).toMatchObject({ revision: 1, name: "pr-review", source: { sourceId: "agent-toolkit", ref: "c1" } });
		clock.advance(1000);
		const second = await importPrReview("owner", `${SKILL_MD}\nThen comment.\n`, "c2");
		expect(second.revision).toBe(2);
		// The same source and ref again publishes nothing new.
		expect((await importPrReview("host", `${SKILL_MD}\nThen comment.\n`, "c2")).revision).toBe(2);

		const harbour = client("owner");
		expect((await harbour.listSkills()).items).toEqual([
			{
				skillId: first.skillId,
				name: "pr-review",
				description: "Review a pull request.",
				revision: 2,
				path: "/skills/pr-review/SKILL.md",
			},
		]);
		expect(await harbour.getSkill(first.skillId)).toMatchObject({
			name: "pr-review",
			latestRevision: 2,
			owner: { kind: "organisation", organisationId: ORG },
		});
		const revisions = await harbour.listSkillRevisions(first.skillId);
		expect(revisions.items.map((revision) => revision.revision).sort()).toEqual([1, 2]);
		expect((await harbour.getSkillRevision(first.skillId, "1")).files).toEqual([
			{ path: "SKILL.md", size: SKILL_MD.length },
			{ path: "scripts/check.sh", size: 18 },
		]);
		expect(await harbour.readSkillFile(first.skillId, "1", { path: "SKILL.md" })).toEqual({
			path: "SKILL.md",
			content: SKILL_MD,
		});
		expect((await harbour.readSkillFile(first.skillId, "2", { path: "scripts/check.sh" })).content).toContain("ok");
		expect((await failure(harbour.readSkillFile(first.skillId, "1", { path: "missing.md" }))).status).toBe(404);
		expect((await failure(harbour.getSkillRevision(first.skillId, "9"))).status).toBe(404);
		expect((await failure(harbour.getSkill("skill_missing"))).status).toBe(404);
	});

	it("page the list and the revisions", async () => {
		const { client, importPrReview } = setUp();
		const first = await importPrReview("host");
		await importPrReview("host", `${SKILL_MD}\nv2\n`, "c2");
		await importPrReview("host", `${SKILL_MD}\nv3\n`, "c3");
		const harbour = client("owner");
		const page = await harbour.listSkillRevisions(first.skillId, { limit: 2 });
		expect(page.items).toHaveLength(2);
		expect(page.nextCursor).toBeDefined();
		const rest = await harbour.listSkillRevisions(first.skillId, { limit: 2, cursor: page.nextCursor });
		expect(rest.items).toHaveLength(1);
		expect(rest.nextCursor).toBeUndefined();
	});

	it("refuse an agent's import, an unknown caller, and another organisation's skills", async () => {
		const { client, importPrReview } = setUp();
		const imported = await importPrReview("host");
		const byAgent = await failure(importPrReview("agent"));
		expect([byAgent.status, byAgent.code]).toEqual([403, "forbidden"]);
		expect((await failure(client("nobody").listSkills())).status).toBe(403);
		expect((await client("stranger").listSkills()).items).toEqual([]);
		expect((await failure(client("stranger").getSkill(imported.skillId))).status).toBe(404);
	});

	it("ask the deployment's check before an import", async () => {
		const { importPrReview } = setUp({
			authorizeImport: async (ctx) => {
				if (ctx.actor.kind !== "service") throw new KantelError("forbidden", "Admins only");
			},
		});
		const refused = await failure(importPrReview("owner"));
		expect([refused.status, refused.message]).toEqual([403, "Admins only"]);
		expect((await importPrReview("host")).revision).toBe(1);
	});

	it("check requests against the routes' schemas, and answer only under /v1/skills", async () => {
		const { fetchApi, api } = setUp();
		const call = (path: string, init: RequestInit = {}) =>
			fetchApi(`https://harbour.test/v1${path}`, { ...init, headers: { authorization: "Bearer owner" } });
		expect((await call("/skills/x/revisions/0")).status).toBe(400);
		expect((await call("/skills/x/revisions/1.5")).status).toBe(400);
		expect((await call("/skills/x/revisions/1/file")).status).toBe(400);
		expect((await call("/skills?limit=0")).status).toBe(400);
		expect((await call("/skills/import", { method: "POST", body: "not json" })).status).toBe(400);
		const missing = await call("/skills/import", { method: "POST", body: JSON.stringify({ name: "x" }) });
		expect(missing.status).toBe(400);
		expect(((await missing.json()) as { error: { message: string } }).error.message).toMatch(/^body/);
		expect((await call("/skills/x/nope")).status).toBe(404);
		expect(await api.fetch(new Request("https://harbour.test/v1/skillsx"))).toBeUndefined();
		expect(await api.fetch(new Request("https://harbour.test/v1/sessions"))).toBeUndefined();
	});
});
