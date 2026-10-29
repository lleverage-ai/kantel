/**
 * A repository's branches over git's smart HTTP protocol (protocol v2 `ls-refs`), with `fetch` alone, so it runs in a
 * Worker as well as on a node. It is what a new session's branch picker lists, and it needs no REST API (and so none of
 * its rate limits): one `POST <repo>.git/git-upload-pack`, the request `git ls-remote --symref <repo> HEAD
 * 'refs/heads/*'` makes.
 *
 * Pass the vault's egress `fetch` for a private repository, which adds the credentials; the caller never holds them.
 */
import { type CallContext, HarbourError, isHarbourError, type ProjectAccess } from "@harbour/contracts";
import { gitHubRepo } from "./git-tarball.ts";
import { errorStatus } from "./read-api.ts";

export interface GitBranch {
	readonly name: string;
	/** The full commit ID the branch points at. */
	readonly commit: string;
}

export interface GitBranches {
	/** `owner/name`, as the seed spec names it. */
	readonly repo: string;
	/** The branch HEAD points at, when the server says. */
	readonly defaultBranch?: string;
	/** Sorted by name, the default branch first. At most `maxBranches`. */
	readonly branches: readonly GitBranch[];
	/** True when the repository has more branches than were kept. */
	readonly truncated: boolean;
}

export interface GitRefListerOptions {
	/** The egress `fetch`; the global one when absent. */
	readonly fetch?: typeof fetch;
	/** Default `https://github.com`. */
	readonly gitBase?: string;
	/** The most branches kept. Default 1,000. */
	readonly maxBranches?: number;
	/** The largest response read. Default 4 MiB. */
	readonly maxBytes?: number;
}

export interface GitRefLister {
	/** The repository's branches. `not_found` when there is no such repository (or it is private and unreachable). */
	branches(repo: string, options?: { readonly signal?: AbortSignal }): Promise<GitBranches>;
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One pkt-line: four hex digits of length (counting themselves), then the payload. */
function pktLine(text: string): string {
	return `${(encoder.encode(text).length + 4).toString(16).padStart(4, "0")}${text}`;
}

/** The protocol v2 `ls-refs` request for HEAD and every branch, with HEAD's target. */
export function lsRefsRequest(): string {
	return [
		pktLine("command=ls-refs\n"),
		pktLine("agent=harbour\n"),
		"0001",
		pktLine("symrefs\n"),
		pktLine("ref-prefix HEAD\n"),
		pktLine("ref-prefix refs/heads/\n"),
		"0000",
	].join("");
}

/** The payloads of a pkt-line stream up to its first flush; malformed framing is `unavailable`. */
export function parsePktLines(bytes: Uint8Array): string[] {
	const lines: string[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		if (offset + 4 > bytes.length) throw new HarbourError("unavailable", "the git server sent a truncated reply");
		const digits = decoder.decode(bytes.subarray(offset, offset + 4));
		if (!/^[0-9a-f]{4}$/.test(digits)) throw new HarbourError("unavailable", "the git server sent a malformed reply");
		const length = Number.parseInt(digits, 16);
		if (length === 0) return lines;
		if (length < 4) {
			// A delimiter (0001) or response-end (0002) packet.
			offset += 4;
			continue;
		}
		if (offset + length > bytes.length) throw new HarbourError("unavailable", "the git server sent a truncated reply");
		lines.push(decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/, ""));
		offset += length;
	}
	throw new HarbourError("unavailable", "the git server's reply has no end");
}

/** The default branch and the branches of an `ls-refs` reply with `symrefs`. */
export function parseLsRefs(lines: readonly string[]): { defaultBranch?: string; branches: GitBranch[] } {
	let defaultBranch: string | undefined;
	const branches: GitBranch[] = [];
	for (const line of lines) {
		if (line.startsWith("ERR ")) throw new HarbourError("unavailable", `the git server refused: ${line.slice(4)}`);
		const [commit, ref, ...attributes] = line.split(" ");
		if (commit === undefined || ref === undefined || !COMMIT.test(commit)) continue;
		if (ref === "HEAD") {
			const target = attributes.find((attribute) => attribute.startsWith("symref-target:"));
			const name = target?.slice("symref-target:".length);
			if (name?.startsWith("refs/heads/")) defaultBranch = name.slice("refs/heads/".length);
		} else if (ref.startsWith("refs/heads/")) {
			branches.push({ name: ref.slice("refs/heads/".length), commit });
		}
	}
	return { ...(defaultBranch === undefined ? {} : { defaultBranch }), branches };
}

/** A `GitRefLister` for GitHub repositories (`owner/name` or a github.com URL). */
export function createGitRefLister(options: GitRefListerOptions = {}): GitRefLister {
	const send = options.fetch ?? globalThis.fetch.bind(globalThis);
	const base = (options.gitBase ?? "https://github.com").replace(/\/+$/, "");
	const maxBranches = options.maxBranches ?? 1_000;
	const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
	return {
		async branches(repo, call = {}) {
			const [owner, name] = gitHubRepo(repo);
			const response = await send(`${base}/${owner}/${name}.git/git-upload-pack`, {
				method: "POST",
				headers: {
					"content-type": "application/x-git-upload-pack-request",
					accept: "application/x-git-upload-pack-result",
					"git-protocol": "version=2",
					"user-agent": "harbour-workspace",
				},
				body: lsRefsRequest(),
				...(call.signal === undefined ? {} : { signal: call.signal }),
			});
			// GitHub answers 401 for a repository that doesn't exist or that the caller can't see: it never says which.
			if (response.status === 401 || response.status === 403 || response.status === 404) {
				await response.body?.cancel();
				throw new HarbourError("not_found", `no repository ${owner}/${name} that Harbour can read`, {
					repo: `${owner}/${name}`,
				});
			}
			if (!response.ok || response.body === null) {
				await response.body?.cancel();
				throw new HarbourError(
					"unavailable",
					`listing the branches of ${owner}/${name} failed with ${response.status}`,
				);
			}
			const { defaultBranch, branches } = parseLsRefs(parsePktLines(await readAll(response.body, maxBytes)));
			branches.sort((left, right) => {
				if (left.name === defaultBranch) return -1;
				if (right.name === defaultBranch) return 1;
				return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
			});
			return {
				repo: `${owner}/${name}`,
				...(defaultBranch === undefined ? {} : { defaultBranch }),
				branches: branches.slice(0, maxBranches),
				truncated: branches.length > maxBranches,
			};
		},
	};
}

/** Where the console asks for a repository's branches. */
export const GIT_BRANCHES_PATH = "/v1/git/branches";

export interface GitBranchesApiOptions {
	readonly refs: GitRefLister;
	/** Project access, for the operator check: listing branches is the first step of seeding a workspace. */
	readonly access: ProjectAccess;
	/** Who is calling, from the request. Throw a `HarbourError` to refuse; its code sets the status. */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** Default `GIT_BRANCHES_PATH`. */
	readonly path?: string;
}

/**
 * `GET /v1/git/branches?projectId=…&repo=owner/name`: the repository's branches as `GitBranches`, for a person who may
 * create a workspace in the project (operator), checked before anything is fetched. Resolves `null` for any other path.
 * Errors are the read API's: `{ "error": { "code", "message" } }`.
 */
export function createGitBranchesApi(options: GitBranchesApiOptions): (request: Request) => Promise<Response | null> {
	const path = options.path ?? GIT_BRANCHES_PATH;
	return async (request) => {
		const url = new URL(request.url);
		if (url.pathname.replace(/\/+$/, "") !== path) return null;
		if (request.method !== "GET") {
			return errorResponse(405, "invalid", "GET only", { allow: "GET" });
		}
		try {
			const ctx = await options.authenticate(request);
			const projectId = url.searchParams.get("projectId") ?? "";
			const repo = (url.searchParams.get("repo") ?? "").trim();
			if (projectId === "") throw new HarbourError("invalid", "projectId is required");
			if (repo === "") throw new HarbourError("invalid", "repo is required, as owner/name");
			await options.access.require(ctx, { projectId, needed: "operator", operation: "workspace.create" });
			const branches = await options.refs.branches(repo, { signal: request.signal });
			return json(branches, 200);
		} catch (error) {
			if (isHarbourError(error)) return errorResponse(errorStatus(error.code), error.code, error.message);
			return errorResponse(502, "unavailable", "listing the branches failed");
		}
	};
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-store",
			...extra,
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

function errorResponse(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
	return json({ error: { code, message } }, status, extra);
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new HarbourError("exhausted", `the branch list is larger than ${maxBytes} bytes`);
		chunks.push(chunk);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
