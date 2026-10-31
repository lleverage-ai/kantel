/**
 * The spike's workspace: one version in R2 laid out as M0-CF1 reads it (a head object, then that version's manifest,
 * then blobs by digest), and the same head and manifest kept hot in a WorkspaceDO, as the readiness doc's step 2 plans.
 * The isolate gets file bodies through `Blobs` (a binding fixed at load, today's path) or a `WorkspaceScope` passed
 * with each call (the pool's path). Both are read-only and accept only 64-hex-digit SHA-256 names.
 */
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { Manifest } from "@kantel/isolate-host/src/sandbox.ts";
import { where } from "./where.ts";

export type Head = { readonly version: number };

const headKey = (id: string) => `ws/${id}/head.json`;
const manifestKey = (id: string, version: number) => `ws/${id}/versions/${version}.json`;
const blobKey = (id: string, sha: string) => `ws/${id}/blobs/${sha}`;
const SHA256 = /^[0-9a-f]{64}$/;

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBlob(bucket: R2Bucket, id: string, sha: string): Promise<Uint8Array> {
	if (!SHA256.test(sha)) throw new Error("blob names are SHA-256 digests");
	const object = await bucket.get(blobKey(id, sha));
	if (object === null) throw new Error(`no blob ${sha}`);
	return new Uint8Array(await object.arrayBuffer());
}

/** One R2 read of the head, as M0-CF1's `ObjectStoreWorkspaces` does on every lookup. */
export async function readHead(bucket: R2Bucket, id: string): Promise<Head> {
	const object = await bucket.get(headKey(id));
	if (object === null) throw new Error(`no workspace ${id}`);
	return (await object.json()) as Head;
}

/** Today's listing path: the head, then that version's manifest, both from R2. */
export async function readManifest(bucket: R2Bucket, id: string): Promise<Manifest> {
	const head = await readHead(bucket, id);
	const object = await bucket.get(manifestKey(id, head.version));
	if (object === null) throw new Error(`no manifest ${id}@${head.version}`);
	return (await object.json()) as Manifest;
}

/**
 * A small source tree of `files` files (61, M0-CF1's bench workspace size) in a few directories, written to R2 as
 * version 1. Returns the manifest for the WorkspaceDO.
 */
export async function seedWorkspace(bucket: R2Bucket, id: string, files: number): Promise<Manifest> {
	const manifest: Manifest = {};
	const dirs = ["src", "src/lib", "test", "docs", "scripts"];
	for (const dir of dirs) manifest[dir] = { kind: "dir" };
	for (let i = 0; i < files; i += 1) {
		const dir = i < 6 ? "" : `${dirs[i % dirs.length]}/`;
		const path = `${dir}file-${String(i).padStart(2, "0")}.${i % 3 === 0 ? "md" : "ts"}`;
		const bytes = new TextEncoder().encode(`// ${path}\n${"export const value = 1;\n".repeat(20 + (i % 40))}`);
		const sha = await sha256(bytes);
		await bucket.put(blobKey(id, sha), bytes);
		manifest[path] = { kind: "file", sha, size: bytes.byteLength, mode: 0o644 };
	}
	await bucket.put(manifestKey(id, 1), JSON.stringify(manifest));
	await bucket.put(headKey(id), JSON.stringify({ version: 1 } satisfies Head));
	return manifest;
}

/** Deletes everything the spike wrote to R2, so the bucket can be deleted. */
export async function clearBucket(bucket: R2Bucket): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: "ws/", ...(cursor ? { cursor } : {}) });
		if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
		deleted += page.objects.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
	return deleted;
}

/** The workspace's head and manifest kept hot in Durable Object storage (and memory), so a listing reads no R2. */
export class WorkspaceDO extends DurableObject<Env> {
	#manifest: Manifest | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS spike_manifest (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
	}

	async seed(manifest: Manifest): Promise<void> {
		this.ctx.storage.sql.exec(
			"INSERT INTO spike_manifest (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
			JSON.stringify(manifest),
		);
		this.#manifest = manifest;
	}

	where() {
		return where();
	}

	async manifest(): Promise<Manifest> {
		if (this.#manifest === undefined) {
			const row = this.ctx.storage.sql
				.exec<{ body: string }>("SELECT body FROM spike_manifest WHERE id = 1")
				.toArray()[0];
			if (row === undefined) throw new Error("workspace not seeded");
			this.#manifest = JSON.parse(row.body) as Manifest;
		}
		return this.#manifest;
	}
}

type BlobsProps = { readonly workspaceId: string };

/** Today's isolate binding (`WS`): one workspace, chosen by props at load. Reads only. */
export class Blobs extends WorkerEntrypoint<Env, BlobsProps> {
	read(sha: string): Promise<Uint8Array> {
		return readBlob(this.env.WORKSPACES, this.ctx.props.workspaceId, sha);
	}

	put(_bytes: Uint8Array): Promise<string> {
		return Promise.reject(new Error("the spike's workspace is read-only"));
	}
}

/**
 * A pooled isolate's workspace for one call, as in images/isolate-host: built by the SessionDO for its session's
 * workspace, passed with the call and revoked when the call ends.
 */
export class WorkspaceScope extends RpcTarget {
	readonly #bucket: R2Bucket;
	readonly #workspaceId: string;
	#revoked = false;

	constructor(bucket: R2Bucket, workspaceId: string) {
		super();
		this.#bucket = bucket;
		this.#workspaceId = workspaceId;
	}

	read(sha: string): Promise<Uint8Array> {
		if (this.#revoked) return Promise.reject(new Error("workspace scope revoked"));
		return readBlob(this.#bucket, this.#workspaceId, sha);
	}

	put(_bytes: Uint8Array): Promise<string> {
		return Promise.reject(new Error("the spike's workspace is read-only"));
	}

	revoke(): void {
		this.#revoked = true;
	}
}

type EgressProps = { readonly session?: string; readonly slot?: string };

/**
 * The isolate's globalOutbound. The spike measures readiness, not egress, so it refuses everything; its props carry the
 * session (today's isolate) or only the slot (a pooled one), so the load matches the design's.
 */
export class Egress extends WorkerEntrypoint<Env, EgressProps> {
	override async fetch(): Promise<Response> {
		return new Response("harbour-ready-spike: no egress", { status: 403 });
	}
}
