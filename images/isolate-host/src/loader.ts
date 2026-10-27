// The self-hosted isolate host: a workerd Worker that loads one Dynamic Worker
// per session with the workerLoader binding, the same primitive the
// Cloudflare target uses.
//
// - Workspace: an RPC entrypoint the sandbox gets as its WS binding, scoped by
//   props to one workspace. It reads and writes content-addressed blobs in
//   MinIO (S3 API). The sandbox never sees the S3 credentials.
// - Egress: the sandbox's globalOutbound. It tags each request with the
//   session and forwards it to the vault proxy, an external service in HTTP
//   proxy style. Nothing else is reachable from the sandbox.

import { WorkerEntrypoint } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
// Bundled just-bash sandbox, embedded as a text module by config.capnp.
import sandboxSource from "harbour-sandbox-bundle";
import type { ExecRequest, Manifest } from "./sandbox.ts";

interface Env {
	LOADER: {
		get(
			id: string,
			factory: () => Promise<unknown>,
		): { getEntrypoint(name?: string): any };
	};
	VAULT: Fetcher;
	S3_ENDPOINT: string;
	S3_BUCKET: string;
	S3_ACCESS_KEY: string;
	S3_SECRET_KEY: string;
	/** Proves to the vault that a request's session header was set by this host, not by a sandbox. */
	VAULT_ISOLATE_KEY: string;
	COMPATIBILITY_DATE: string;
}

interface WorkspaceProps {
	workspaceId: string;
}

interface EgressProps {
	sessionId: string;
}

const s3 = (env: Env) =>
	new AwsClient({ accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY, service: "s3", region: "us-east-1" });

const blobUrl = (env: Env, workspaceId: string, sha: string) =>
	`${env.S3_ENDPOINT}/${env.S3_BUCKET}/workspaces/${encodeURIComponent(workspaceId)}/blobs/${sha}`;
const manifestUrl = (env: Env, workspaceId: string, version: string) =>
	`${env.S3_ENDPOINT}/${env.S3_BUCKET}/workspaces/${encodeURIComponent(workspaceId)}/manifests/${version}.json`;

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Workspace extends WorkerEntrypoint<Env, WorkspaceProps> {
	async read(sha: string): Promise<Uint8Array> {
		const response = await s3(this.env).fetch(blobUrl(this.env, this.ctx.props.workspaceId, sha));
		if (!response.ok) throw new Error(`blob ${sha}: ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}

	async put(bytes: Uint8Array): Promise<string> {
		const sha = await sha256(bytes);
		const response = await s3(this.env).fetch(blobUrl(this.env, this.ctx.props.workspaceId, sha), {
			method: "PUT",
			body: bytes,
		});
		if (!response.ok) throw new Error(`put blob ${sha}: ${response.status}`);
		return sha;
	}
}

export class Egress extends WorkerEntrypoint<Env, EgressProps> {
	async fetch(request: Request): Promise<Response> {
		const headers = new Headers(request.headers);
		// The vault decides per session; the sandbox cannot forge this header,
		// because the host sets it after the sandbox's request leaves the isolate.
		headers.set("x-harbour-session", this.ctx.props.sessionId);
		headers.set("x-harbour-tier", "isolate");
		headers.set("x-harbour-host-key", this.env.VAULT_ISOLATE_KEY);
		return this.env.VAULT.fetch(new Request(request, { headers }));
	}
}

interface LoadBody {
	sessionId: string;
	workspaceId: string;
	version: string;
	/** Optional: skip the manifest fetch when the caller already has it. */
	manifest?: Manifest;
}

function sandboxFor(env: Env, ctx: ExecutionContext & { exports: any }, body: LoadBody) {
	return env.LOADER.get(`session:${body.sessionId}`, async () => ({
		compatibilityDate: env.COMPATIBILITY_DATE,
		mainModule: "sandbox.js",
		modules: { "sandbox.js": sandboxSource },
		env: { WS: ctx.exports.Workspace({ props: { workspaceId: body.workspaceId } }) },
		globalOutbound: ctx.exports.Egress({ props: { sessionId: body.sessionId } }),
	})).getEntrypoint();
}

async function loadManifest(env: Env, workspaceId: string, version: string): Promise<Manifest> {
	if (version === "empty") return {};
	const response = await s3(env).fetch(manifestUrl(env, workspaceId, version));
	if (!response.ok) throw new Error(`manifest ${workspaceId}@${version}: ${response.status}`);
	return (await response.json()) as Manifest;
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext & { exports: any }): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/healthz") return json({ ok: true });
		if (request.method !== "POST") return json({ error: "not found" }, 404);
		try {
			const started = Date.now();
			const body = (await request.json()) as LoadBody & Partial<ExecRequest>;
			const manifest = body.manifest ?? (await loadManifest(env, body.workspaceId, body.version));
			const manifestMs = Date.now() - started;
			const sandbox = sandboxFor(env, ctx, body);
			if (url.pathname === "/list") {
				const listed = await sandbox.list(manifest);
				return json({ ...listed, timings: { manifestMs, totalMs: Date.now() - started } });
			}
			if (url.pathname === "/exec") {
				const result = await sandbox.exec({
					command: body.command!,
					cwd: body.cwd,
					env: body.env,
					manifest,
					timeoutMs: body.timeoutMs,
				});
				return json({ ...result, timings: { ...result.timings, manifestMs, totalMs: Date.now() - started } });
			}
			return json({ error: "not found" }, 404);
		} catch (error) {
			return json({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, 500);
		}
	},
};
