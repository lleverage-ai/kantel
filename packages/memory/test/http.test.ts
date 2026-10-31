// Contract tests for the public API's memory routes (`@kantel/api`'s `memoryRoutes`), called through the generated SDK
// against `createMemoryApi` over the in-memory memory, as the console or a host's adapter calls a deployed Kantel.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type CallContext, KantelError, type MemorySnapshot, type SnapshotConcept } from "@kantel/contracts";
import { createMemoryApi } from "@kantel/memory/http";
import { createMemoryMemory } from "@kantel/memory/memory";
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

const concept = (
	id: string,
	title: string,
	statement: string,
	extra: Partial<SnapshotConcept> = {},
): SnapshotConcept => ({
	id,
	title,
	statement,
	scope: { kind: "global" },
	sources: ["tvdavies/harbour#12"],
	setBy: "owner",
	status: "active",
	updatedAt: Date.UTC(2026, 9, 20),
	...extra,
});

const SNAPSHOT: MemorySnapshot = {
	sourceId: "sal-memory",
	ref: "abc123",
	concepts: [
		concept("personal/shell-fish", "Tom's shell is fish", "Commands Tom pastes must work in fish.", {
			tags: ["profile"],
			extensions: { sal: { appliesTo: null } },
		}),
		concept("projects/harbour/cloudflare-placement", "Kantel lives in weur", "D1, R2 and objects go in weur.", {
			scope: { kind: "project", project: "harbour" },
		}),
		concept("projects/harbour/old-placement", "Kantel lived in enam", "D1 was in Chicago.", {
			scope: { kind: "project", project: "harbour" },
			status: "superseded",
			supersededBy: "projects/harbour/cloudflare-placement",
		}),
	],
};

function setUp(options: { authorizeWrite?: (ctx: CallContext) => Promise<void> } = {}) {
	const clock = new ManualClock();
	const memory = createMemoryMemory({ clock });
	const api = createMemoryApi({
		memory,
		authenticate: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			const ctx = CALLERS[token];
			if (ctx === undefined) throw new KantelError("forbidden", "Unknown caller");
			return ctx;
		},
		...(options.authorizeWrite === undefined ? {} : { authorizeWrite: options.authorizeWrite }),
	});
	const fetchApi = async (input: string | URL | Request, init?: RequestInit) =>
		(await api.fetch(new Request(input, init))) ?? new Response("not mine", { status: 418 });
	const client = (token: string) => createKantelClient({ baseUrl: "https://harbour.test/v1", token, fetch: fetchApi });
	return { memory, api, fetchApi, client };
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

const team = { owner: { kind: "organisation", organisationId: ORG }, name: "Team" } as const;

describe("the memory routes", () => {
	it("create a space, load a snapshot and read it: spaces, concepts by status, one concept", async () => {
		const { client } = setUp();
		const harbour = client("owner");
		const space = await harbour.createMemorySpace({
			owner: { kind: "user", organisationId: ORG, userId: "owner" },
			name: "Sal's memory",
		});
		const loaded = await harbour.importMemorySnapshot(space.id, SNAPSHOT);
		expect(loaded.snapshot).toMatchObject({ sourceId: "sal-memory", ref: "abc123" });

		expect((await harbour.listMemorySpaces()).items.map((item) => item.name)).toEqual(["Sal's memory"]);
		expect((await client("other").listMemorySpaces()).items, "another person never sees a user's space").toEqual([]);
		expect((await client("host").listMemorySpaces()).items).toHaveLength(1);

		const all = await harbour.listConcepts(space.id);
		expect(all.items.map((item) => item.id)).toEqual([
			"personal/shell-fish",
			"projects/harbour/cloudflare-placement",
			"projects/harbour/old-placement",
		]);
		expect(all.items[0]?.extensions).toEqual({ sal: { appliesTo: null } });
		const superseded = await harbour.listConcepts(space.id, { status: "superseded" });
		expect(superseded.items.map((item) => item.id)).toEqual(["projects/harbour/old-placement"]);
		const paged = await harbour.listConcepts(space.id, { limit: 2 });
		expect(paged.items).toHaveLength(2);
		expect((await harbour.listConcepts(space.id, { limit: 2, cursor: paged.nextCursor })).items).toHaveLength(1);

		// A concept's ID holds slashes; the SDK encodes them as one path segment.
		const one = await harbour.getConcept(space.id, "projects/harbour/cloudflare-placement");
		expect(one).toMatchObject({ title: "Kantel lives in weur", scope: { kind: "project", project: "harbour" } });
		expect((await failure(harbour.getConcept(space.id, "personal/missing"))).status).toBe(404);
	});

	it("search and recall over HTTP as the memory does in process", async () => {
		const { client, memory } = setUp();
		const harbour = client("owner");
		const space = await harbour.createMemorySpace(team);
		await harbour.importMemorySnapshot(space.id, SNAPSHOT);

		const { hits } = await harbour.searchMemory({ spaceIds: [space.id], query: "fish shell commands" });
		expect(hits[0]?.concept.id).toBe("personal/shell-fish");
		expect(hits[0]?.snippet).toContain("fish");

		const request = {
			spaceIds: [space.id],
			query: "where does harbour's cloudflare placement live",
			scopes: { projects: ["harbour"] },
			profile: ["personal/shell-fish"],
		};
		const recall = await harbour.recallMemory(request);
		const direct = await memory.recall(CALLERS.owner as CallContext, request);
		expect(recall).toEqual(JSON.parse(JSON.stringify(direct)));
		expect(recall.manifest.map((entry) => [entry.conceptId, entry.reason])).toContainEqual([
			"personal/shell-fish",
			"profile",
		]);
		expect(recall.manifest.find((entry) => entry.reason === "search")?.snapshotRef).toBe("abc123");
		expect(recall.text).toContain("weur");
	});

	it("refuse agents' writes, an unknown caller and another organisation's spaces", async () => {
		const { client } = setUp();
		const space = await client("owner").createMemorySpace(team);
		expect((await failure(client("agent").importMemorySnapshot(space.id, SNAPSHOT))).status).toBe(403);
		expect((await failure(client("agent").createMemorySpace(team))).status).toBe(403);
		expect((await failure(client("nobody").listMemorySpaces())).status).toBe(403);
		expect((await client("stranger").listMemorySpaces()).items).toEqual([]);
		expect((await failure(client("stranger").listConcepts(space.id))).status).toBe(404);
		expect((await failure(client("stranger").searchMemory({ spaceIds: [space.id], query: "x" }))).status).toBe(404);
	});

	it("ask the deployment's check before creating a space or loading a snapshot", async () => {
		const { client } = setUp({
			authorizeWrite: async (ctx) => {
				if (ctx.actor.kind !== "service") throw new KantelError("forbidden", "Admins only");
			},
		});
		expect((await failure(client("owner").createMemorySpace(team))).message).toBe("Admins only");
		const space = await client("host").createMemorySpace(team);
		expect((await failure(client("owner").importMemorySnapshot(space.id, SNAPSHOT))).message).toBe("Admins only");
		expect((await client("host").importMemorySnapshot(space.id, SNAPSHOT)).snapshot?.ref).toBe("abc123");
		// Reads need no more than the memory's own rules.
		expect((await client("owner").listConcepts(space.id)).items).toHaveLength(3);
	});

	it("check requests against the routes' schemas, and answer only under /v1/memory", async () => {
		const { fetchApi, api } = setUp();
		const call = (path: string, init: RequestInit = {}) =>
			fetchApi(`https://harbour.test/v1${path}`, { ...init, headers: { authorization: "Bearer owner" } });
		expect((await call("/memory/spaces/s/concepts?status=lost")).status).toBe(400);
		expect((await call("/memory/spaces?limit=x")).status).toBe(400);
		expect((await call("/memory/recall", { method: "POST", body: "{}" })).status).toBe(400);
		expect(
			(await call("/memory/search", { method: "POST", body: JSON.stringify({ spaceIds: [], query: "x" }) })).status,
		).toBe(400);
		expect((await call("/memory/spaces/s/snapshot", { method: "POST", body: "{}" })).status).toBe(400);
		expect((await call("/memory/search")).status).toBe(404);
		expect(await api.fetch(new Request("https://harbour.test/v1/memoryx"))).toBeUndefined();
	});
});
