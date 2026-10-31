import {
	type CallContext,
	KantelError,
	isKantelError,
	type WorkspaceRecord,
	type Workspaces,
} from "@kantel/contracts";
import { actors, type ConformanceDeps, contextFor, createDeps } from "@kantel/testing/harness";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@kantel/workspace/memory";
import {
	contentTypeFor,
	createWorkspaceReadApi,
	createWorkspaceReadClient,
	VERSION_HEADER,
	type WorkspaceReader,
	type WorkspaceReadHandler,
} from "@kantel/workspace/read-api";
import { beforeEach, describe, expect, it } from "vitest";

const ORG = "org-1";
const PROJECT = "proj-1";
const SOURCE_PROJECT = "proj-source";
const alice = contextFor(actors.human("alice"), ORG, PROJECT);
const outsider = contextFor(actors.human("oscar"), ORG, "proj-other");
const mallory = contextFor(actors.human("mallory"), "org-2");
const viewerOfWorkspaceOnly = contextFor(actors.human("victor"), ORG, PROJECT);
const callers: { readonly [user: string]: CallContext } = {
	alice,
	oscar: outsider,
	mallory,
	victor: viewerOfWorkspaceOnly,
};

interface Fixture {
	readonly deps: ConformanceDeps;
	readonly api: WorkspaceReadHandler;
	readonly record: WorkspaceRecord;
	readonly calls: string[];
	readonly pinned: string;
	readonly workspaces: Workspaces;
	/** Runs between the content route's stat and its read, to change the workspace in between. */
	betweenStatAndRead?: () => Promise<void>;
}

let fixture: Fixture;

async function setUp(maxContentBytes?: number): Promise<Fixture> {
	const deps = createDeps();
	deps.tenancy.bind(alice.actor, ORG, "operator", PROJECT);
	deps.tenancy.bind(alice.actor, ORG, "viewer", SOURCE_PROJECT);
	deps.tenancy.bind(outsider.actor, ORG, "operator", "proj-other");
	deps.tenancy.bind(viewerOfWorkspaceOnly.actor, ORG, "viewer", PROJECT);
	const projectFiles = createMemoryProjectFiles({ access: deps.access });
	deps.tenancy.bind(alice.actor, ORG, "operator", SOURCE_PROJECT);
	await projectFiles.write!(alice, SOURCE_PROJECT, [{ op: "put", path: "README.md", content: "project readme" }]);
	// A later source version that leaves README alone, so README's last change and the mount's pin differ.
	const pinned = (await projectFiles.write!(alice, SOURCE_PROJECT, [{ op: "put", path: "OTHER.md", content: "other" }]))
		.version;
	const workspaces = createMemoryWorkspaces({
		clock: deps.clock,
		audit: deps.audit,
		sources: [projectFiles],
		access: deps.access,
	});
	const record = await workspaces.create(alice, {
		owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
		mounts: [{ path: "/project", source: "project-files", ref: SOURCE_PROJECT }],
	});
	await workspaces.commit(alice, record.id, {
		baseVersion: 0,
		changes: [
			{ op: "put", path: "notes/x.md", content: "# first" },
			{ op: "put", path: "site/index.html", content: "<script>alert(1)</script>" },
			{ op: "put", path: "bin/blob.bin", content: new Uint8Array([0, 1, 2, 255]) },
		],
	});
	await workspaces.commit(alice, record.id, {
		baseVersion: 1,
		changes: [{ op: "put", path: "notes/x.md", content: "# second" }],
	});
	const calls: string[] = [];
	// Only the read operations reach the API; record each so a test can show nothing else is called.
	const reader: WorkspaceReader = {
		get: (...args) => {
			calls.push("get");
			return workspaces.get(...args);
		},
		list: (...args) => {
			calls.push("list");
			return workspaces.list(...args);
		},
		stat: (...args) => {
			calls.push("stat");
			return workspaces.stat(...args);
		},
		read: async (...args) => {
			calls.push("read");
			await fixture?.betweenStatAndRead?.();
			return workspaces.read(...args);
		},
		history: (...args) => {
			calls.push("history");
			return workspaces.history(...args);
		},
	};
	const api = createWorkspaceReadApi({
		workspaces: reader,
		authenticate: async (request) => {
			const user = request.headers.get("x-user");
			const ctx = user === null ? undefined : callers[user];
			if (ctx === undefined) throw new KantelError("forbidden", "sign in first");
			return ctx;
		},
		...(maxContentBytes === undefined ? {} : { maxContentBytes }),
	});
	return { deps, api, record: await workspaces.get(alice, record.id), calls, pinned, workspaces };
}

async function get(path: string, user = "alice", init: RequestInit = {}): Promise<Response> {
	const response = await fixture.api(
		new Request(`https://harbour.test${path}`, {
			...init,
			headers: { ...(user === "" ? {} : { "x-user": user }), ...(init.headers as Record<string, string>) },
		}),
	);
	if (response === null) throw new Error(`${path} was not handled`);
	return response;
}

function route(id: string, rest = ""): string {
	return `/v1/workspaces/${encodeURIComponent(id)}${rest}`;
}

async function errorOf(response: Response): Promise<{ status: number; code: string }> {
	const body = (await response.json()) as { error: { code: string } };
	return { status: response.status, code: body.error.code };
}

describe("workspace read API", () => {
	beforeEach(async () => {
		fixture = await setUp();
	});

	it("returns the record with its head and pinned mounts", async () => {
		const response = await get(route(fixture.record.id));
		expect(response.status).toBe(200);
		const record = (await response.json()) as WorkspaceRecord;
		expect(record.head).toBe(2);
		expect(record.mounts).toEqual([
			{ path: "/project", source: "project-files", ref: SOURCE_PROJECT, version: fixture.pinned, readOnly: true },
		]);
	});

	it("lists a directory without bodies, and a mount through its source", async () => {
		const root = await (await get(route(fixture.record.id, "/files"))).json();
		expect(root).toEqual({
			items: [
				{ path: "bin", kind: "directory", size: 0, version: 1 },
				{ path: "notes", kind: "directory", size: 0, version: 2 },
				{ path: "site", kind: "directory", size: 0, version: 1 },
			],
		});
		const recursive = (await (await get(route(fixture.record.id, "/files?recursive=true&path=notes"))).json()) as {
			items: { path: string; content?: unknown }[];
		};
		expect(recursive.items.map((item) => item.path)).toEqual(["notes/x.md"]);
		expect(recursive.items.every((item) => !("content" in item))).toBe(true);
		const mount = (await (await get(route(fixture.record.id, "/files?path=/project"))).json()) as {
			items: { path: string }[];
		};
		expect(mount.items.map((item) => item.path)).toEqual(["/project/OTHER.md", "/project/README.md"]);
	});

	it("serves a file's bytes with its digest and version, and older versions as immutable", async () => {
		const head = await get(route(fixture.record.id, "/content?path=notes/x.md"));
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("# second");
		expect(head.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
		expect(head.headers.get(VERSION_HEADER)).toBe("2");
		expect(head.headers.get("ETag")).toMatch(/^"[0-9a-f]{64}"$/);
		expect(head.headers.get("Cache-Control")).toBe("private, no-cache");
		const old = await get(route(fixture.record.id, "/content?path=notes/x.md&version=1"));
		expect(await old.text()).toBe("# first");
		expect(old.headers.get("Cache-Control")).toContain("immutable");
		const binary = await get(route(fixture.record.id, "/content?path=bin/blob.bin"));
		expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 1, 2, 255]);
		expect(binary.headers.get("Content-Type")).toBe("application/octet-stream");
	});

	it("never lets a browser run what it serves", async () => {
		const html = await get(route(fixture.record.id, "/content?path=site/index.html"));
		expect(html.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(html.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(html.headers.get("Content-Security-Policy")).toContain("sandbox");
		expect(contentTypeFor("a/b.svg")).toBe("text/plain; charset=utf-8");
		expect(contentTypeFor("Makefile")).toBe("text/plain; charset=utf-8");
	});

	it("answers a matching If-None-Match with 304 and no body", async () => {
		const first = await get(route(fixture.record.id, "/content?path=notes/x.md"));
		const etag = first.headers.get("ETag")!;
		const again = await get(route(fixture.record.id, "/content?path=notes/x.md"), "alice", {
			headers: { "If-None-Match": etag },
		});
		expect(again.status).toBe(304);
		expect(await again.text()).toBe("");
		expect(fixture.calls.filter((call) => call === "read")).toHaveLength(1);
	});

	it("reads a mount at its pinned version", async () => {
		const response = await get(route(fixture.record.id, "/content?path=/project/README.md"));
		expect(await response.text()).toBe("project readme");
		expect(JSON.parse(response.headers.get(VERSION_HEADER)!)).toBe(fixture.pinned);
	});

	it("never caches a mount read as immutable, and revalidates it with the mount's pin", async () => {
		const first = await get(route(fixture.record.id, "/content?path=/project/README.md&version=2"));
		expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
		const again = await get(route(fixture.record.id, "/content?path=/project/README.md"), "alice", {
			headers: { "If-None-Match": first.headers.get("ETag")! },
		});
		expect(again.status).toBe(304);
		expect(JSON.parse(again.headers.get(VERSION_HEADER)!)).toBe(fixture.pinned);
	});

	it("answers HEAD with headers and never a body, errors included", async () => {
		const ok = await get(route(fixture.record.id, "/content?path=notes/x.md"), "alice", { method: "HEAD" });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("Content-Length")).toBe("8");
		expect(ok.body).toBeNull();
		const bad = await get(route(fixture.record.id, "/content"), "alice", { method: "HEAD" });
		expect(bad.status).toBe(400);
		expect(bad.body).toBeNull();
		const refused = await get(route(fixture.record.id), "", { method: "HEAD" });
		expect(refused.status).toBe(403);
		expect(refused.body).toBeNull();
	});

	it("refuses a file that grew past the limit between stat and read", async () => {
		fixture = await setUp(16);
		fixture.betweenStatAndRead = async () => {
			fixture.betweenStatAndRead = undefined;
			await fixture.workspaces.commit(alice, fixture.record.id, {
				baseVersion: 2,
				changes: [{ op: "put", path: "notes/x.md", content: "# much longer than sixteen bytes" }],
			});
		};
		expect(await errorOf(await get(route(fixture.record.id, "/content?path=notes/x.md")))).toEqual({
			status: 413,
			code: "refused",
		});
	});

	it("pages history newest first", async () => {
		const page = (await (await get(route(fixture.record.id, "/history?limit=2"))).json()) as {
			items: { version: number }[];
			nextCursor?: string;
		};
		expect(page.items.map((item) => item.version)).toEqual([2, 1]);
		expect(page.nextCursor).toBeDefined();
	});

	it("maps refusals and bad input to statuses, and leaves other paths alone", async () => {
		expect(await errorOf(await get(route(fixture.record.id, "/content")))).toEqual({ status: 400, code: "invalid" });
		expect(await errorOf(await get(route(fixture.record.id, "/content?path=nope.md")))).toEqual({
			status: 404,
			code: "not_found",
		});
		expect(await errorOf(await get(route(fixture.record.id, "/content?path=notes")))).toEqual({
			status: 400,
			code: "invalid",
		});
		expect(await errorOf(await get(route(fixture.record.id, "/files?version=x")))).toEqual({
			status: 400,
			code: "invalid",
		});
		expect(await errorOf(await get(route(fixture.record.id), "mallory"))).toEqual({ status: 404, code: "not_found" });
		expect(await errorOf(await get(route(fixture.record.id), ""))).toEqual({ status: 403, code: "forbidden" });
		expect(await errorOf(await get(route(fixture.record.id, "/nope")))).toEqual({ status: 404, code: "not_found" });
		const post = await get(route(fixture.record.id, "/files"), "alice", { method: "POST", body: "{}" });
		expect(post.status).toBe(405);
		expect(post.headers.get("Allow")).toBe("GET, HEAD");
		expect(await fixture.api(new Request("https://harbour.test/v1/sessions"))).toBeNull();
	});

	it("goes through project access: an outsider is refused and audited, a viewer reads", async () => {
		const before = fixture.deps.audit.ofType("access.denied").length;
		expect(await errorOf(await get(route(fixture.record.id, "/files"), "oscar"))).toEqual({
			status: 403,
			code: "forbidden",
		});
		expect(fixture.deps.audit.ofType("access.denied").length).toBe(before + 1);
		expect((await get(route(fixture.record.id, "/content?path=notes/x.md"), "victor")).status).toBe(200);
		// The viewer may read the workspace but not the project its /project mount comes from.
		expect(await errorOf(await get(route(fixture.record.id, "/content?path=/project/README.md"), "victor"))).toEqual({
			status: 403,
			code: "forbidden",
		});
	});

	it("refuses a file larger than it serves", async () => {
		fixture = await setUp(4);
		expect(await errorOf(await get(route(fixture.record.id, "/content?path=notes/x.md")))).toEqual({
			status: 413,
			code: "refused",
		});
	});

	it("only ever calls read operations", async () => {
		await get(route(fixture.record.id));
		await get(route(fixture.record.id, "/files?recursive=true"));
		await get(route(fixture.record.id, "/stat?path=notes/x.md"));
		await get(route(fixture.record.id, "/content?path=notes/x.md"));
		await get(route(fixture.record.id, "/history"));
		expect(new Set(fixture.calls)).toEqual(new Set(["get", "list", "stat", "read", "history"]));
	});
});

describe("workspace read client", () => {
	beforeEach(async () => {
		fixture = await setUp();
	});

	function client(user = "alice") {
		return createWorkspaceReadClient({
			baseUrl: "https://harbour.test/v1/workspaces/",
			headers: { "x-user": user },
			fetch: async (input, init) => {
				const response = await fixture.api(new Request(input as string, init));
				return response ?? new Response(null, { status: 404 });
			},
		});
	}

	it("reads through the API with the contract's types", async () => {
		const reader = client();
		const id = fixture.record.id;
		expect((await reader.get(id)).head).toBe(2);
		const page = await reader.list(id, { path: "notes", recursive: true });
		expect(page.items.map((item) => item.path)).toEqual(["notes/x.md"]);
		expect((await reader.stat(id, "notes/x.md")).size).toBe(8);
		const file = await reader.read(id, "notes/x.md", { version: 1 });
		expect(new TextDecoder().decode(file.content)).toBe("# first");
		expect(file.version).toBe(1);
		expect(file.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(file.contentType).toBe("text/markdown; charset=utf-8");
		const mounted = await reader.read(id, "/project/README.md");
		expect(mounted.version).toBe(fixture.pinned);
		expect((await reader.history(id, { limit: 1 })).items[0]?.version).toBe(2);
	});

	it("pages a large listing with the cursor", async () => {
		const reader = client();
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await reader.list(fixture.record.id, { recursive: true, limit: 2, ...(cursor ? { cursor } : {}) });
			seen.push(...page.items.map((item) => item.path));
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		expect(seen).toEqual(["bin", "bin/blob.bin", "notes", "notes/x.md", "site", "site/index.html"]);
	});

	it("turns error bodies back into KantelErrors", async () => {
		let caught: unknown;
		try {
			await client("oscar").read(fixture.record.id, "notes/x.md");
		} catch (error) {
			caught = error;
		}
		expect(isKantelError(caught, "forbidden")).toBe(true);
		await expect(client().read(fixture.record.id, "missing")).rejects.toMatchObject({ code: "not_found" });
	});
});
