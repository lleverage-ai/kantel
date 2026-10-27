/**
 * Harbour container-tier agent. Runs in the container on port 8080 and is reached only by its Durable Object.
 *
 * It holds a working copy of one workspace in /workspace: a workspace version plus the changes commands have made
 * since, which stay here until the sandbox commits them (on lease release, or before an isolate command). Every call
 * carries a sync from the version the container holds to the current head; paths the container has changed are not
 * overwritten by it, so the container's own changes win. `/changes` returns those changes; `/ack` says they are
 * committed as a new version. The container never talks to object storage and has no credentials: all its network
 * traffic goes through the vault.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

const ROOT = "/workspace";
/** Not synced: dependency trees and git metadata stay local to the container (see README, "Workspace"). */
const SKIP = new Set(["node_modules", ".git"]);
const bootedAt = Date.now();

type FileState = { hash: string; mode: number; size: number; mtimeMs: number };
type Put = { path: string; mode: number; content: string };
type Sync = { from: number | null; to: number; put: Put[]; remove: string[] };

/** The workspace version /workspace is based on. */
let version: number | null = null;
/** What each file looked like at the last scan, to find what a command changed. */
let index = new Map<string, FileState>();
/** Paths changed since `version` and not yet committed. */
let dirty = new Map<string, "put" | "delete">();
let execs = 0;

async function walk(dir: string, prefix: string, out: Map<string, { mode: number; size: number; mtimeMs: number }>) {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (SKIP.has(name)) continue;
		const absolute = join(dir, name);
		const relative = prefix === "" ? name : `${prefix}/${name}`;
		const stat = await lstat(absolute);
		if (stat.isDirectory()) await walk(absolute, relative, out);
		else if (stat.isFile()) out.set(relative, { mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs });
	}
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function forget() {
	version = null;
	index = new Map();
	dirty = new Map();
}

async function applySync(body: Sync): Promise<boolean> {
	if (body.from !== version) return false;
	try {
		for (const path of body.remove) {
			if (dirty.has(path)) continue;
			await rm(join(ROOT, path), { force: true, recursive: true });
			index.delete(path);
		}
		for (const file of body.put) {
			if (dirty.has(file.path)) continue;
			const absolute = join(ROOT, file.path);
			// A directory replaced by a file (the removes above leave the emptied directory behind).
			const existing = await lstat(absolute).catch(() => null);
			if (existing?.isDirectory()) await rm(absolute, { recursive: true, force: true });
			await mkdir(dirname(absolute), { recursive: true });
			const bytes = Buffer.from(file.content, "base64");
			await writeFile(absolute, bytes);
			await chmod(absolute, file.mode);
			const stat = await lstat(absolute);
			index.set(file.path, { hash: sha256(bytes), mode: file.mode, size: stat.size, mtimeMs: stat.mtimeMs });
		}
	} catch (error) {
		// A half-applied sync: forget the working copy so the next call starts from a full sync.
		await rm(ROOT, { recursive: true, force: true });
		await mkdir(ROOT, { recursive: true });
		forget();
		throw error;
	}
	version = body.to;
	return true;
}

/** Marks what the last command changed as dirty. */
async function scan() {
	const seen = new Map<string, { mode: number; size: number; mtimeMs: number }>();
	await walk(ROOT, "", seen);
	const next = new Map<string, FileState>();
	for (const [path, stat] of seen) {
		const known = index.get(path);
		if (known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.mode === stat.mode) {
			next.set(path, known);
			continue;
		}
		const hash = sha256(await readFile(join(ROOT, path)));
		next.set(path, { hash, ...stat });
		if (known !== undefined && known.hash === hash && known.mode === stat.mode) continue;
		dirty.set(path, "put");
	}
	for (const path of index.keys()) if (!seen.has(path)) dirty.set(path, "delete");
	index = next;
}

async function pendingChanges() {
	const put: Put[] = [];
	const remove: string[] = [];
	for (const [path, op] of dirty) {
		if (op === "delete") {
			remove.push(path);
			continue;
		}
		const absolute = join(ROOT, path);
		const stat = await lstat(absolute).catch(() => null);
		if (stat === null || !stat.isFile()) {
			remove.push(path);
			continue;
		}
		put.push({ path, mode: stat.mode & 0o777, content: (await readFile(absolute)).toString("base64") });
	}
	return { put, remove };
}

const EGRESS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const BUNDLE = "/opt/harbour/ca-bundle.pem";
let caInstalled = false;

/**
 * Trust the egress CA so HTTPS goes through the vault's interception. The certificate appears only once the Durable
 * Object has turned on HTTPS interception, after the process has started, so this runs before each command until done.
 * It appends the CA to a copy of the system bundle and points the usual variables at it: milliseconds, where
 * update-ca-certificates takes about two seconds on a small instance.
 */
async function trustEgressCa(): Promise<Record<string, string>> {
	if (!caInstalled && (await Bun.file(EGRESS_CA).exists())) {
		const system = await Bun.file(SYSTEM_BUNDLE).text();
		const egress = await Bun.file(EGRESS_CA).text();
		await Bun.write(BUNDLE, `${system}\n${egress}\n`);
		caInstalled = true;
	}
	return caInstalled
		? {
				NODE_EXTRA_CA_CERTS: EGRESS_CA,
				REQUESTS_CA_BUNDLE: BUNDLE,
				SSL_CERT_FILE: BUNDLE,
				CURL_CA_BUNDLE: BUNDLE,
				GIT_SSL_CAINFO: BUNDLE,
			}
		: {};
}

async function run(
	command: string | string[],
	cwd: string,
	env: Record<string, string>,
	stdin: string | undefined,
	timeoutMs: number,
) {
	const caEnv = await trustEgressCa();
	// setsid: the command gets its own process group, so a timeout kills what it started in the background too.
	const argv = typeof command === "string" ? ["bash", "-c", command] : command;
	const child = Bun.spawn(["setsid", ...argv], {
		cwd,
		env: { ...process.env, ...caEnv, HOME: ROOT, ...env },
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	let abandon: ReturnType<typeof setTimeout> | undefined;
	const readers = [child.stdout.getReader(), child.stderr.getReader()];
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
		// Something that left the group (its own setsid, a daemon) may still hold the pipes: stop reading them.
		abandon = setTimeout(() => {
			for (const reader of readers) reader.cancel().catch(() => {});
		}, 2_000);
	}, timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([drain(readers[0]), drain(readers[1]), child.exited]);
	clearTimeout(timer);
	clearTimeout(abandon);
	return {
		stdout,
		stderr: timedOut ? `${stderr}timed out after ${timeoutMs} ms\n` : stderr,
		exitCode: timedOut ? 124 : exitCode,
	};
}

/** Reads a stream to the end, or to what was read when it is cancelled. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} catch {
		// Cancelled after a timeout.
	}
	return text + decoder.decode();
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function workingDirectory(cwd: string | undefined): string {
	if (cwd === undefined || cwd === "") return ROOT;
	const resolved = normalize(join(ROOT, cwd));
	if (resolved !== ROOT && !resolved.startsWith(`${ROOT}/`)) throw new Error(`cwd ${cwd} is outside the workspace`);
	return resolved;
}

await mkdir(ROOT, { recursive: true });

Bun.serve({
	port: 8080,
	idleTimeout: 255,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/health") return json({ ok: true, bootedAt, version, dirty: dirty.size, execs });

		if (url.pathname === "/exec" && request.method === "POST") {
			const started = performance.now();
			const body = (await request.json()) as {
				sync: Sync;
				command: string | string[];
				cwd?: string;
				env?: Record<string, string>;
				stdin?: string;
				timeoutMs?: number;
			};
			if (!(await applySync(body.sync))) return json({ error: "version_mismatch", have: version }, 409);
			const syncMs = performance.now() - started;
			execs += 1;
			const result = await run(
				body.command,
				workingDirectory(body.cwd),
				body.env ?? {},
				body.stdin,
				body.timeoutMs ?? 120_000,
			);
			const execMs = performance.now() - started - syncMs;
			await scan();
			const scanMs = performance.now() - started - syncMs - execMs;
			return json({
				...result,
				dirty: dirty.size,
				timings: {
					"container.sync": round(syncMs),
					"container.exec": round(execMs),
					"container.scan": round(scanMs),
				},
				container: { bootedAt, execs },
			});
		}

		if (url.pathname === "/changes" && request.method === "POST") {
			const body = (await request.json()) as { sync: Sync };
			if (!(await applySync(body.sync))) return json({ error: "version_mismatch", have: version }, 409);
			return json(await pendingChanges());
		}

		if (url.pathname === "/ack" && request.method === "POST") {
			// The changes are committed as `version`: the working copy is that version, with nothing pending.
			const body = (await request.json()) as { version: number };
			version = body.version;
			dirty = new Map();
			return json({ ok: true, version });
		}

		if (url.pathname === "/reset" && request.method === "POST") {
			// A discarded lease, or a container handed to another workspace: drop the working copy.
			await rm(ROOT, { recursive: true, force: true });
			await mkdir(ROOT, { recursive: true });
			forget();
			return json({ ok: true });
		}

		return json({ error: "not_found" }, 404);
	},
});

function round(ms: number) {
	return Math.round(ms * 10) / 10;
}

console.log(`harbour container agent listening on 8080 (booted ${new Date(bootedAt).toISOString()})`);
