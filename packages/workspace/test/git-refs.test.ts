import { type CallContext, HarbourError, isHarbourError } from "@harbour/contracts";
import { actors, contextFor, createDeps } from "@harbour/testing/harness";
import {
	createGitBranchesApi,
	createGitRefLister,
	type GitBranches,
	lsRefsRequest,
	parseLsRefs,
	parsePktLines,
} from "@harbour/workspace/git-refs";
import { describe, expect, it } from "vitest";

const ORG = "org-1";
const PROJECT = "proj-1";
const MAIN = "0123456789abcdef0123456789abcdef01234567";
const FEATURE = "89abcdef0123456789abcdef0123456789abcdef";
const encoder = new TextEncoder();

/** One pkt-line, as a git server writes it. */
const pkt = (text: string) => `${(encoder.encode(text).length + 4).toString(16).padStart(4, "0")}${text}`;

/** What GitHub answers `ls-refs` with for a repository with `main` (HEAD) and `feature/x`. */
const REPLY = [
	pkt(`${MAIN} HEAD symref-target:refs/heads/main\n`),
	pkt(`${FEATURE} refs/heads/feature/x\n`),
	pkt(`${MAIN} refs/heads/main\n`),
	"0000",
].join("");

function fakeGit(reply: () => Response = () => new Response(REPLY)) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		return reply();
	};
	return { calls, fetch };
}

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isHarbourError(error) ? error.code : `not a HarbourError: ${String(error)}`;
	}
	return undefined;
}

describe("the ls-refs exchange", () => {
	it("asks for HEAD and the branches, with symrefs, in protocol v2 framing", () => {
		const request = lsRefsRequest();
		expect(request).toBe(
			"0014command=ls-refs\n0012agent=harbour\n0001000csymrefs\n0014ref-prefix HEAD\n001bref-prefix refs/heads/\n0000",
		);
	});

	it("reads the default branch and the branches", () => {
		const lines = parsePktLines(encoder.encode(REPLY));
		expect(parseLsRefs(lines)).toEqual({
			defaultBranch: "main",
			branches: [
				{ name: "feature/x", commit: FEATURE },
				{ name: "main", commit: MAIN },
			],
		});
	});

	it("refuses a truncated or malformed reply, and a server error", () => {
		expect(() => parsePktLines(encoder.encode(REPLY.slice(0, 20)))).toThrow(HarbourError);
		expect(() => parsePktLines(encoder.encode("zzzz"))).toThrow(HarbourError);
		expect(() => parsePktLines(encoder.encode(pkt("x\n")))).toThrow(/no end/);
		expect(() => parseLsRefs(["ERR access denied"])).toThrow(/access denied/);
	});
});

describe("createGitRefLister", () => {
	it("lists a repository's branches with one POST to its upload-pack, the default branch first", async () => {
		const git = fakeGit();
		const branches = await createGitRefLister({ fetch: git.fetch }).branches("https://github.com/tvdavies/site.git");
		expect(branches).toEqual({
			repo: "tvdavies/site",
			defaultBranch: "main",
			branches: [
				{ name: "main", commit: MAIN },
				{ name: "feature/x", commit: FEATURE },
			],
			truncated: false,
		});
		expect(git.calls).toHaveLength(1);
		expect(git.calls[0]!.url).toBe("https://github.com/tvdavies/site.git/git-upload-pack");
		expect(git.calls[0]!.init?.method).toBe("POST");
		expect(new Headers(git.calls[0]!.init?.headers).get("git-protocol")).toBe("version=2");
		// Nothing of the caller's travels: no credential is added here, the egress `fetch` adds any.
		expect(new Headers(git.calls[0]!.init?.headers).has("authorization")).toBe(false);
	});

	it("keeps at most maxBranches and says there were more", async () => {
		const branches = await createGitRefLister({ fetch: fakeGit().fetch, maxBranches: 1 }).branches("tvdavies/site");
		expect(branches.branches).toEqual([{ name: "main", commit: MAIN }]);
		expect(branches.truncated).toBe(true);
	});

	it("is not_found for a repository the server won't show, and unavailable when it fails", async () => {
		for (const status of [401, 403, 404]) {
			const lister = createGitRefLister({
				fetch: fakeGit(() => new Response("Repository not found.", { status })).fetch,
			});
			expect(await codeOf(lister.branches("tvdavies/private"))).toBe("not_found");
		}
		const failing = createGitRefLister({ fetch: fakeGit(() => new Response("", { status: 502 })).fetch });
		expect(await codeOf(failing.branches("tvdavies/site"))).toBe("unavailable");
		const big = createGitRefLister({ fetch: fakeGit().fetch, maxBytes: 10 });
		expect(await codeOf(big.branches("tvdavies/site"))).toBe("exhausted");
	});

	it("refuses anything that isn't a GitHub repository before fetching", async () => {
		const git = fakeGit();
		const lister = createGitRefLister({ fetch: git.fetch });
		expect(await codeOf(lister.branches("../etc/passwd"))).toBe("not_supported");
		expect(await codeOf(lister.branches("https://evil.test/a/b"))).toBe("not_supported");
		expect(git.calls).toHaveLength(0);
	});
});

describe("GET /v1/git/branches", () => {
	const operator = contextFor(actors.human("olive"), ORG, PROJECT);
	const viewer = contextFor(actors.human("vera"), ORG, PROJECT);
	const callers: { readonly [user: string]: CallContext } = { olive: operator, vera: viewer };

	function setUp() {
		const deps = createDeps();
		deps.tenancy.bind(operator.actor, ORG, "operator", PROJECT);
		deps.tenancy.bind(viewer.actor, ORG, "viewer", PROJECT);
		const git = fakeGit();
		const api = createGitBranchesApi({
			refs: createGitRefLister({ fetch: git.fetch }),
			access: deps.access,
			authenticate: async (request) => {
				const ctx = callers[request.headers.get("x-user") ?? ""];
				if (ctx === undefined) throw new HarbourError("forbidden", "who are you?");
				return ctx;
			},
		});
		const get = async (user: string, query: Record<string, string>, method = "GET") =>
			(await api(
				new Request(`https://harbour.test/v1/git/branches?${new URLSearchParams(query)}`, {
					method,
					headers: { "x-user": user },
				}),
			))!;
		return { deps, git, api, get };
	}

	it("lists the branches for an operator", async () => {
		const { get } = setUp();
		const response = await get("olive", { projectId: PROJECT, repo: "tvdavies/site" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as GitBranches;
		expect(body.defaultBranch).toBe("main");
		expect(body.branches.map((branch) => branch.name)).toEqual(["main", "feature/x"]);
	});

	it("refuses a viewer before anything is fetched, and audits it", async () => {
		const { get, git, deps } = setUp();
		const response = await get("vera", { projectId: PROJECT, repo: "tvdavies/site" });
		expect(response.status).toBe(403);
		expect(git.calls).toHaveLength(0);
		expect(deps.audit.events.some((event) => event.type === "access.denied")).toBe(true);
	});

	it("needs a project and a repository, and only answers GET on its path", async () => {
		const { get, api } = setUp();
		expect((await get("olive", { repo: "tvdavies/site" })).status).toBe(400);
		expect((await get("olive", { projectId: PROJECT })).status).toBe(400);
		expect((await get("olive", { projectId: PROJECT, repo: "tvdavies/site" }, "POST")).status).toBe(405);
		expect(await api(new Request("https://harbour.test/v1/git/tags"))).toBeNull();
	});

	it("answers a repository Harbour can't read as not found", async () => {
		const { deps } = setUp();
		const api = createGitBranchesApi({
			refs: createGitRefLister({ fetch: fakeGit(() => new Response("", { status: 401 })).fetch }),
			access: deps.access,
			authenticate: async () => operator,
		});
		const response = (await api(
			new Request(`https://harbour.test/v1/git/branches?projectId=${PROJECT}&repo=tvdavies/private`),
		))!;
		expect(response.status).toBe(404);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
	});
});
