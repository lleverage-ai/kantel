import { type CallContext, isKantelError, KantelError, type WorkspaceRecord } from "@kantel/contracts";
import { actors, type ConformanceDeps, contextFor, createDeps } from "@kantel/testing/harness";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@kantel/workspace/memory";
import { createWorkspaceReadApi, createWorkspaceReadClient } from "@kantel/workspace/read-api";
import type { GitFetcher } from "@kantel/workspace/seed";
import {
	createWorkspaceWriteApi,
	createWorkspaceWriteClient,
	DEFAULT_MAX_SEED_BODY_BYTES,
	type WorkspaceWriteHandler,
} from "@kantel/workspace/write-api";
import { beforeEach, describe, expect, it } from "vitest";

const ORG = "org-1";
const PROJECT = "proj-1";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BASE = "https://kantel.test/v1/workspaces";
const encoder = new TextEncoder();

const operator = contextFor(actors.human("olive"), ORG, PROJECT);
const viewer = contextFor(actors.human("vera"), ORG, PROJECT);
const otherProject = contextFor(actors.human("oscar"), ORG, "proj-other");
const otherOrg = contextFor(actors.human("mallory"), "org-2");
const callers: { readonly [user: string]: CallContext } = {
	olive: operator,
	vera: viewer,
	oscar: otherProject,
	mallory: otherOrg,
};

interface Fixture {
	readonly deps: ConformanceDeps;
	readonly api: WorkspaceWriteHandler;
	readonly fetched: string[];
	readonly read: ReturnType<typeof createWorkspaceReadClient>;
}

let fixture: Fixture;

function setUp(): Fixture {
	const deps = createDeps();
	deps.tenancy.bind(operator.actor, ORG, "operator", PROJECT);
	deps.tenancy.bind(viewer.actor, ORG, "viewer", PROJECT);
	deps.tenancy.bind(otherProject.actor, ORG, "operator", "proj-other");
	const fetched: string[] = [];
	// A stand-in for the GitHub tarball fetcher: a small repository with a README, a source file and a chart.
	const git: GitFetcher = {
		async fetch(_ctx, source) {
			fetched.push(`${source.repo}@${source.ref}`);
			return {
				commit: COMMIT,
				files: [
					{ path: "README.md", content: encoder.encode("# billing-sync") },
					{ path: "src/retry.ts", content: encoder.encode("export const retries = 3;") },
					{ path: "docs/chart.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
				],
			};
		},
	};
	const projectFiles = createMemoryProjectFiles({ access: deps.access });
	const workspaces = createMemoryWorkspaces({
		clock: deps.clock,
		audit: deps.audit,
		access: deps.access,
		sources: [projectFiles],
		seeders: { git },
	});
	const authenticate = async (request: Request) => {
		const user = request.headers.get("x-user");
		const ctx = user === null ? undefined : callers[user];
		if (ctx === undefined) throw new KantelError("forbidden", "who are you?");
		return ctx;
	};
	const api = createWorkspaceWriteApi({ workspaces, access: deps.access, authenticate });
	const readApi = createWorkspaceReadApi({ workspaces, authenticate });
	const read = createWorkspaceReadClient({
		baseUrl: BASE,
		headers: { "x-user": "olive" },
		fetch: async (input, init) => (await readApi(new Request(input, init)))!,
	});
	return { deps, api, fetched, read };
}

beforeEach(() => {
	fixture = setUp();
});

const seed = {
	name: "billing-sync",
	sources: [
		{ kind: "git", repo: "acme/billing-sync", ref: "main", sparse: ["src", "docs"], into: "repo" },
		{ kind: "files", files: { "notes/plan.md": "# Plan\n\n- [ ] Retry the 503s" } },
	],
};

function post(body: unknown, user = "olive", init: RequestInit = {}): Promise<Response | null> {
	return fixture.api(
		new Request(BASE, {
			method: "POST",
			headers: { "content-type": "application/json", "x-user": user },
			body: typeof body === "string" ? body : JSON.stringify(body),
			...init,
		}),
	);
}

async function errorOf(response: Response | null): Promise<{ status: number; code: string }> {
	expect(response).not.toBeNull();
	const body = (await response!.json()) as { error: { code: string } };
	return { status: response!.status, code: body.error.code };
}

describe("POST /v1/workspaces", () => {
	it("creates a workspace seeded from a git ref and static files, readable through the read API", async () => {
		const response = await post({ projectId: PROJECT, seed });
		expect(response!.status).toBe(201);
		const record = (await response!.json()) as WorkspaceRecord;
		expect(response!.headers.get("location")).toBe(`/v1/workspaces/${record.id}`);
		expect(response!.headers.get("cache-control")).toBe("no-store");
		expect(record.owner).toEqual({ kind: "project", organisationId: ORG, projectId: PROJECT });
		expect(record.seedReadiness).toBe("files");
		expect(record.seedReport?.sources[0]).toMatchObject({ kind: "git", repo: "acme/billing-sync", commit: COMMIT });
		expect(fixture.fetched).toEqual(["acme/billing-sync@main"]);

		const root = await fixture.read.list(record.id, { path: "" });
		expect(root.items.map((entry) => entry.path).sort()).toEqual(["notes", "repo"]);
		const repo = await fixture.read.list(record.id, { path: "repo", recursive: true });
		// The sparse list kept src and docs, and left README out.
		expect(repo.items.filter((entry) => entry.kind === "file").map((entry) => entry.path)).toEqual([
			"repo/docs/chart.png",
			"repo/src/retry.ts",
		]);
		expect(new TextDecoder().decode((await fixture.read.read(record.id, "notes/plan.md")).content)).toContain("Retry");
		expect((await fixture.read.read(record.id, "repo/docs/chart.png")).contentType).toBe("image/png");
	});

	it("seeds without a sandbox: nothing reaches the audit log but the write itself", async () => {
		await post({ projectId: PROJECT, seed });
		expect(fixture.deps.audit.events.filter((event) => event.type.startsWith("sandbox."))).toEqual([]);
		expect(fixture.deps.audit.ofType("access.denied")).toEqual([]);
	});

	it("creates an empty workspace without a seed", async () => {
		const response = await post({ projectId: PROJECT });
		expect(response!.status).toBe(201);
		expect(fixture.fetched).toEqual([]);
	});

	it.each([
		["a viewer of the project", "vera"],
		["an operator of another project", "oscar"],
		["someone in another organisation", "mallory"],
	])("refuses %s, audits it once and fetches nothing", async (_label, user) => {
		expect(await errorOf(await post({ projectId: PROJECT, seed }, user))).toEqual({ status: 403, code: "forbidden" });
		expect(fixture.fetched).toEqual([]);
		const denied = fixture.deps.audit.ofType("access.denied");
		expect(denied).toHaveLength(1);
		expect(denied[0]!.data).toMatchObject({ operation: "workspace.create" });
	});

	it("refuses before it reads the seed: a viewer's malformed body is still 403", async () => {
		expect(await errorOf(await post({ projectId: PROJECT, seed: { sources: "nope" } }, "vera"))).toEqual({
			status: 403,
			code: "forbidden",
		});
	});

	it("refuses an unauthenticated caller with the authenticator's code", async () => {
		expect(await errorOf(await post({ projectId: PROJECT, seed }, "nobody"))).toEqual({
			status: 403,
			code: "forbidden",
		});
	});

	it.each([
		["not JSON", "{", "invalid"],
		["an array", [], "invalid"],
		["no project", { seed }, "invalid"],
		["a seed without a name", { projectId: PROJECT, seed: { sources: [] } }, "invalid"],
		[
			"a git source without a ref",
			{ projectId: PROJECT, seed: { name: "x", sources: [{ kind: "git", repo: "a/b" }] } },
			"invalid",
		],
		[
			"a file that isn't text",
			{ projectId: PROJECT, seed: { name: "x", sources: [{ kind: "files", files: { a: 1 } }] } },
			"invalid",
		],
		["an unknown source kind", { projectId: PROJECT, seed: { name: "x", sources: [{ kind: "ftp" }] } }, "invalid"],
		[
			"a path outside the workspace",
			{ projectId: PROJECT, seed: { name: "x", sources: [{ kind: "files", files: { "../x": "" } }] } },
			"invalid",
		],
		[
			"an objects source",
			{ projectId: PROJECT, seed: { name: "x", sources: [{ kind: "objects", prefix: "p" }] } },
			"not_supported",
		],
		[
			"dependency steps",
			{ projectId: PROJECT, seed: { name: "x", sources: [], deps: [{ run: "pnpm i" }] } },
			"not_supported",
		],
	])("refuses %s as %s", async (_label, body, code) => {
		const error = await errorOf(await post(body));
		expect(error.code).toBe(code);
		expect(error.status).toBe(code === "invalid" ? 400 : 501);
		expect(fixture.fetched).toEqual([]);
	});

	it("takes a v1 spec with an archive source, which waits at metadata when the host has no archive seeder", async () => {
		const response = await post({
			projectId: PROJECT,
			seed: { version: 1, name: "tools", sources: [{ kind: "archive", url: "https://example.test/tools.tgz" }] },
		});
		expect(response!.status).toBe(201);
		const record = (await response!.json()) as WorkspaceRecord;
		expect(record.seed).toEqual({
			version: 1,
			name: "tools",
			sources: [{ kind: "archive", url: "https://example.test/tools.tgz" }],
		});
		expect(record.seedReadiness).toBe("metadata");
	});

	it("refuses a body over the limit as 413", async () => {
		const big = "x".repeat(DEFAULT_MAX_SEED_BODY_BYTES + 1);
		const response = await post({
			projectId: PROJECT,
			seed: { name: "big", sources: [{ kind: "files", files: { a: big } }] },
		});
		expect(response!.status).toBe(413);
	});

	it("leaves other methods and paths to the read API", async () => {
		expect(await fixture.api(new Request(BASE, { method: "GET" }))).toBeNull();
		expect(await fixture.api(new Request(`${BASE}/ws_1`, { method: "POST", body: "{}" }))).toBeNull();
		expect(
			await fixture.api(new Request("https://kantel.test/v1/sessions", { method: "POST", body: "{}" })),
		).toBeNull();
	});
});

describe("createWorkspaceWriteClient", () => {
	const client = (user: string) =>
		createWorkspaceWriteClient({
			baseUrl: BASE,
			headers: { "x-user": user },
			fetch: async (input, init) => (await fixture.api(new Request(input, init)))!,
		});

	it("creates and returns the record", async () => {
		const record = await client("olive").create({
			projectId: PROJECT,
			seed: { name: "notes", sources: [{ kind: "files", files: { "notes/a.md": "# A" } }] },
		});
		expect(record.seedReadiness).toBe("files");
		expect((await fixture.read.stat(record.id, "notes/a.md")).kind).toBe("file");
	});

	it("throws the server's error as a KantelError", async () => {
		try {
			await client("vera").create({ projectId: PROJECT });
			expect.unreachable();
		} catch (error) {
			expect(isKantelError(error) && error.code).toBe("forbidden");
		}
	});
});

describe("PUT /v1/workspaces/:id/content", () => {
	async function workspace(): Promise<WorkspaceRecord> {
		const response = await post({
			projectId: PROJECT,
			seed: { name: "doc", sources: [{ kind: "files", files: { "documents/plan.md": "# Plan\n" } }] },
		});
		return (await response!.json()) as WorkspaceRecord;
	}
	const put = (id: string, path: string, body: string, user = "olive", headers: Record<string, string> = {}) =>
		fixture.api(
			new Request(`${BASE}/${id}/content?${new URLSearchParams({ path })}`, {
				method: "PUT",
				headers: { "x-user": user, ...headers },
				body,
			}),
		);
	const text = async (id: string, path: string) =>
		new TextDecoder().decode((await fixture.read.read(id, path)).content);

	it("writes a file as a new version, only while it's what the writer read", async () => {
		const record = await workspace();
		const read = await fixture.read.read(record.id, "documents/plan.md");
		const saved = await put(record.id, "documents/plan.md", "# Plan\n\nEdited.\n", "olive", {
			"if-match": `"${read.digest}"`,
		});
		expect(saved!.status).toBe(200);
		const body = (await saved!.json()) as { version: number; digest: string };
		expect(body.version).toBeGreaterThan(record.head);
		expect(await text(record.id, "documents/plan.md")).toBe("# Plan\n\nEdited.\n");
		// The same digest again is stale now: the file changed since.
		const stale = await put(record.id, "documents/plan.md", "# Lost\n", "olive", { "if-match": `"${read.digest}"` });
		expect(await errorOf(stale)).toEqual({ status: 409, code: "conflict" });
		expect(await text(record.id, "documents/plan.md")).toBe("# Plan\n\nEdited.\n");
		// The new digest goes on.
		const again = await put(record.id, "documents/plan.md", "# Plan\n\nAgain.\n", "olive", {
			"if-match": `"${body.digest}"`,
		});
		expect(again!.status).toBe(200);
	});

	it("isn't stale when the agent changed another file meanwhile", async () => {
		const record = await workspace();
		const read = await fixture.read.read(record.id, "documents/plan.md");
		expect((await put(record.id, "notes/other.md", "# Other\n"))!.status).toBe(200);
		const saved = await put(record.id, "documents/plan.md", "# Mine\n", "olive", { "if-match": `"${read.digest}"` });
		expect(saved!.status).toBe(200);
	});

	it("refuses a viewer, a mount path and a new file that already exists", async () => {
		const record = await workspace();
		expect(await errorOf(await put(record.id, "documents/plan.md", "# No", "vera"))).toMatchObject({ status: 403 });
		expect(await errorOf(await put(record.id, "/project/a.md", "# No"))).toEqual({ status: 400, code: "invalid" });
		expect(await errorOf(await put(record.id, "documents/plan.md", "# No", "olive", { "if-none-match": "*" }))).toEqual(
			{ status: 409, code: "conflict" },
		);
		expect(await text(record.id, "documents/plan.md")).toBe("# Plan\n");
	});

	it("leaves other methods and paths to the read API", async () => {
		const record = await workspace();
		expect(
			await fixture.api(new Request(`${BASE}/${record.id}/content?path=a.md`, { headers: { "x-user": "olive" } })),
		).toBeNull();
		expect(
			await fixture.api(new Request(`${BASE}/${record.id}/files`, { method: "PUT", headers: { "x-user": "olive" } })),
		).toBeNull();
	});
});

describe("POST /v1/workspaces/:id/fork", () => {
	const fork = (id: string, body: unknown, user = "olive") =>
		fixture.api(
			new Request(`${BASE}/${encodeURIComponent(id)}/fork`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-user": user },
				body: JSON.stringify(body),
			}),
		);

	it("forks a workspace into the project, sharing its files, and the client does the same", async () => {
		const source = (await (await post({ projectId: PROJECT, seed }))!.json()) as WorkspaceRecord;
		const response = await fork(source.id, { projectId: PROJECT });
		expect(response!.status).toBe(201);
		const record = (await response!.json()) as WorkspaceRecord;
		expect(response!.headers.get("location")).toBe(`/v1/workspaces/${record.id}`);
		expect(record.forkedFrom).toEqual({ workspaceId: source.id, version: source.head });
		expect(new TextDecoder().decode((await fixture.read.read(record.id, "notes/plan.md")).content)).toContain("Retry");
		// The seed was fetched once, for the source.
		expect(fixture.fetched).toEqual(["acme/billing-sync@main"]);

		const client = createWorkspaceWriteClient({
			baseUrl: BASE,
			headers: { "x-user": "olive" },
			fetch: async (input, init) => (await fixture.api(new Request(input, init)))!,
		});
		const older = await client.fork(source.id, { projectId: PROJECT, version: 0 });
		expect(older.head).toBe(0);
	});

	it("refuses a viewer, a caller outside the project and a bad version, and forks nothing", async () => {
		const source = (await (await post({ projectId: PROJECT, seed }))!.json()) as WorkspaceRecord;
		expect(await errorOf(await fork(source.id, { projectId: PROJECT }, "vera"))).toEqual({
			status: 403,
			code: "forbidden",
		});
		expect(await errorOf(await fork(source.id, { projectId: "proj-other" }, "oscar"))).toMatchObject({ status: 403 });
		expect(await errorOf(await fork(source.id, { projectId: PROJECT, version: -1 }))).toEqual({
			status: 400,
			code: "invalid",
		});
		expect(await errorOf(await fork("ws_missing", { projectId: PROJECT }))).toEqual({ status: 404, code: "not_found" });
		expect(fixture.deps.audit.ofType("workspace.forked")).toEqual([]);
	});
});
