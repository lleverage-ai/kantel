// The versioned workspace: content-addressed blobs and manifests in MinIO (S3
// API), the head pointer in Postgres, moved under the session's lease fence.

import { AwsClient } from "aws4fetch";
import { S3Client } from "bun";
import type pg from "pg";
import type {
	LeaseFence,
	Manifest,
	Workspace,
	WorkspaceCommit,
	WorkspaceHead,
} from "../../../spike/contracts/index.ts";
import type { PostgresLeases } from "./lease.ts";

export const EMPTY_VERSION = "empty";

export function sha256Hex(bytes: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** A version ID is the hash of the canonical manifest, so equal trees share an ID. */
export function versionOf(manifest: Manifest): string {
	const paths = Object.keys(manifest).sort();
	if (paths.length === 0) return EMPTY_VERSION;
	return sha256Hex(JSON.stringify(paths.map((path) => [path, manifest[path]])));
}

export interface S3Options {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export class StaleWorkspace extends Error {
	constructor(workspaceId: string, base: string) {
		super(`workspace ${workspaceId}: base ${base} is not the head`);
		this.name = "StaleWorkspace";
	}
}

export class MinioWorkspace implements Workspace {
	readonly s3: S3Client;
	readonly #manifests = new Map<string, Manifest>();

	constructor(
		private readonly pool: pg.Pool,
		private readonly leases: PostgresLeases,
		readonly options: S3Options,
	) {
		this.s3 = new S3Client({ ...options, region: "us-east-1" });
	}

	/** Create the bucket if it is missing (MinIO starts empty). */
	async ensureBucket(): Promise<void> {
		const aws = new AwsClient({
			accessKeyId: this.options.accessKeyId,
			secretAccessKey: this.options.secretAccessKey,
			service: "s3",
			region: "us-east-1",
		});
		const url = `${this.options.endpoint}/${this.options.bucket}`;
		const head = await aws.fetch(url, { method: "HEAD" });
		if (head.ok) return;
		const created = await aws.fetch(url, { method: "PUT" });
		if (!created.ok && created.status !== 409) throw new Error(`create bucket: ${created.status} ${await created.text()}`);
	}

	#key(workspaceId: string, kind: "blobs" | "manifests", name: string) {
		return `workspaces/${encodeURIComponent(workspaceId)}/${kind}/${name}`;
	}

	async create(workspaceId: string): Promise<WorkspaceHead> {
		await this.pool.query(
			`INSERT INTO harbour.workspaces (id, version, seq) VALUES ($1, $2, 0) ON CONFLICT (id) DO NOTHING`,
			[workspaceId, EMPTY_VERSION],
		);
		return this.head(workspaceId);
	}

	async head(workspaceId: string): Promise<WorkspaceHead> {
		const result = await this.pool.query(`SELECT version, seq FROM harbour.workspaces WHERE id = $1`, [workspaceId]);
		if (result.rows[0] === undefined) throw new Error(`unknown workspace ${workspaceId}`);
		return { workspaceId, version: result.rows[0].version, seq: Number(result.rows[0].seq) };
	}

	async manifest(workspaceId: string, version: string): Promise<Manifest> {
		if (version === EMPTY_VERSION) return {};
		const cached = this.#manifests.get(`${workspaceId}@${version}`);
		if (cached !== undefined) return cached;
		const manifest = (await this.s3.file(this.#key(workspaceId, "manifests", `${version}.json`)).json()) as Manifest;
		this.#manifests.set(`${workspaceId}@${version}`, manifest);
		return manifest;
	}

	async readBlob(workspaceId: string, sha: string): Promise<Uint8Array> {
		return new Uint8Array(await this.s3.file(this.#key(workspaceId, "blobs", sha)).arrayBuffer());
	}

	async putBlob(workspaceId: string, bytes: Uint8Array): Promise<string> {
		const sha = sha256Hex(bytes);
		await this.s3.write(this.#key(workspaceId, "blobs", sha), bytes);
		return sha;
	}

	async commit(workspaceId: string, commit: WorkspaceCommit, fence: LeaseFence): Promise<WorkspaceHead> {
		const version = versionOf(commit.manifest);
		if (version !== EMPTY_VERSION) {
			await this.s3.write(this.#key(workspaceId, "manifests", `${version}.json`), JSON.stringify(commit.manifest));
			this.#manifests.set(`${workspaceId}@${version}`, commit.manifest);
		}
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await this.leases.check(fence, client);
			const moved = await client.query(
				`UPDATE harbour.workspaces SET version = $3, seq = seq + 1, updated_at = now()
				 WHERE id = $1 AND version = $2 RETURNING seq`,
				[workspaceId, commit.base, version],
			);
			if (moved.rowCount === 0) throw new StaleWorkspace(workspaceId, commit.base);
			const seq = Number(moved.rows[0].seq);
			await client.query(
				`INSERT INTO harbour.workspace_versions (workspace_id, seq, version, base, tier, changed, session_id, fence)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				[workspaceId, seq, version, commit.base, commit.tier, JSON.stringify(commit.changed), fence.sessionId, fence.fence],
			);
			await client.query("COMMIT");
			return { workspaceId, version, seq };
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
}
