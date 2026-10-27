// The isolate tier: one Dynamic Worker per session, loaded by the isolate host
// (loader.ts) through workerd's workerLoader binding.
//
// It runs just-bash over a lazy view of one workspace version. File bodies are
// fetched through the WS binding only when a command reads them. At the end of
// every command it uploads what changed and returns the new manifest; the
// session host commits that manifest as the next workspace version.
//
// Network: every fetch() (curl, wget) goes to globalOutbound, which the host
// points at the vault proxy. This module never sees a credential.

import { WorkerEntrypoint } from "cloudflare:workers";
import { Bash, InMemoryFs } from "just-bash/browser";

export type ManifestEntry =
	| { kind: "file"; sha: string; size: number; mode: number }
	| { kind: "symlink"; target: string }
	| { kind: "dir" };
export type Manifest = Record<string, ManifestEntry>;

interface WorkspaceBinding {
	read(sha: string): Promise<Uint8Array>;
	put(bytes: Uint8Array): Promise<string>;
}

interface Env {
	WS: WorkspaceBinding;
}

export interface ExecRequest {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	manifest: Manifest;
	timeoutMs?: number;
}

export interface ExecResponse {
	exitCode: number;
	stdout: string;
	stderr: string;
	manifest: Manifest;
	changed: string[];
	timings: { fsMs: number; execMs: number; commitMs: number; lazyReads: number };
}

const ROOT = "/workspace";

const abs = (path: string) => (path === "" ? ROOT : `${ROOT}/${path}`);
const rel = (path: string) => (path === ROOT ? "" : path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : undefined);

function normalise(base: string, path: string): string {
	const parts = (path.startsWith("/") ? path : `${base}/${path}`).split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function plainFetch(
	url: string,
	options: { method?: string; headers?: Headers | Record<string, string>; body?: string | Uint8Array; followRedirects?: boolean; signal?: AbortSignal } = {},
) {
	const response = await fetch(url, {
		method: options.method ?? "GET",
		headers: options.headers,
		body: options.body as BodyInit | undefined,
		redirect: options.followRedirects === false ? "manual" : "follow",
		signal: options.signal,
	});
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return {
		status: response.status,
		statusText: response.statusText,
		headers,
		body: new Uint8Array(await response.arrayBuffer()),
		url: response.url || url,
	};
}

/** Wrap a just-bash filesystem so writes over existing paths are recorded. */
function track(fs: InMemoryFs, dirty: Set<string>): InMemoryFs {
	const mark = (path: string) => dirty.add(normalise("/", path));
	const wrap = <K extends keyof InMemoryFs>(name: K, pick: (args: unknown[]) => string[]) => {
		const original = (fs[name] as (...args: unknown[]) => unknown).bind(fs);
		(fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
			for (const path of pick(args)) mark(path);
			return original(...args);
		};
	};
	const first = (args: unknown[]) => [String(args[0])];
	const second = (args: unknown[]) => [String(args[1])];
	wrap("writeFile", first);
	wrap("appendFile", first);
	wrap("chmod", first);
	wrap("utimes", first);
	wrap("cp", second);
	wrap("mv", second);
	wrap("symlink", second);
	wrap("link", second);
	return fs;
}

export default class Sandbox extends WorkerEntrypoint<Env> {
	/** List the workspace without reading any file body. */
	async list(manifest: Manifest): Promise<{ entries: number; bytes: number }> {
		let bytes = 0;
		for (const entry of Object.values(manifest)) if (entry.kind === "file") bytes += entry.size;
		return { entries: Object.keys(manifest).length, bytes };
	}

	async exec(request: ExecRequest): Promise<ExecResponse> {
		const t0 = performance.now();
		let lazyReads = 0;
		const files: Record<string, unknown> = {};
		for (const [path, entry] of Object.entries(request.manifest)) {
			if (entry.kind !== "file") continue;
			files[abs(path)] = async () => {
				lazyReads++;
				return await this.env.WS.read(entry.sha);
			};
		}
		const fs = new InMemoryFs(files as never);
		await fs.mkdir(ROOT, { recursive: true });
		for (const [path, entry] of Object.entries(request.manifest)) {
			if (entry.kind === "dir") await fs.mkdir(abs(path), { recursive: true });
			else if (entry.kind === "symlink") await fs.symlink(entry.target, abs(path));
			else if (entry.mode !== 0o644) await fs.chmod(abs(path), entry.mode);
		}
		const dirty = new Set<string>();
		track(fs, dirty);
		const bash = new Bash({
			fs,
			cwd: normalise(ROOT, request.cwd ?? "."),
			env: { HOME: ROOT, ...request.env },
			// The vault decides what may leave; globalOutbound enforces it, so
			// curl and wget get a plain fetch with no allow-list of their own.
			fetch: plainFetch,
		});
		const t1 = performance.now();
		const result = await bash.exec(request.command);
		const t2 = performance.now();

		const isDirty = (path: string) => {
			for (const mark of dirty) if (path === mark || path.startsWith(`${mark}/`)) return true;
			return false;
		};
		const next: Manifest = {};
		const changed: string[] = [];
		for (const full of fs.getAllPaths()) {
			const path = rel(full);
			if (path === undefined || path === "") continue;
			const before = request.manifest[path];
			// An untouched file keeps its entry without a stat: stat on a lazy file
			// loads its body, which would read the whole workspace on every commit.
			if (before?.kind === "file" && !isDirty(full)) {
				next[path] = before;
				continue;
			}
			const stat = await fs.lstat(full);
			if (stat.isSymbolicLink) {
				const target = await fs.readlink(full);
				next[path] = { kind: "symlink", target };
				if (before?.kind !== "symlink" || before.target !== target) changed.push(path);
			} else if (stat.isDirectory) {
				next[path] = { kind: "dir" };
				if (before?.kind !== "dir") changed.push(path);
			} else {
				const bytes = await fs.readFileBuffer(full);
				const sha = await sha256(bytes);
				const mode = stat.mode & 0o777;
				if (before?.kind !== "file" || before.sha !== sha || before.mode !== mode) {
					await this.env.WS.put(bytes);
					changed.push(path);
				}
				next[path] = { kind: "file", sha, size: bytes.byteLength, mode };
			}
		}
		for (const path of Object.keys(request.manifest)) if (!(path in next)) changed.push(path);
		const t3 = performance.now();
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			manifest: next,
			changed,
			timings: { fsMs: t1 - t0, execMs: t2 - t1, commitMs: t3 - t2, lazyReads },
		};
	}
}
