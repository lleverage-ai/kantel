/**
 * Harbour container-tier agent. Runs in the container on port 8080 and is reached only by its Durable Object.
 *
 * It holds a working copy of one workspace in /workspace. The DO pushes the difference between the version the
 * container holds and the version a command must start from; the container runs the command with bash and returns
 * the files the command changed. The DO stores those as blobs and commits, then acknowledges the new version. The
 * container never talks to object storage and has no credentials: all its network traffic goes through the vault.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = "/workspace";
/** Not synced: dependency trees and git metadata stay local to the container (see README, "Workspace"). */
const SKIP = new Set(["node_modules", ".git"]);
const bootedAt = Date.now();

type FileState = { hash: string; mode: number; size: number; mtimeMs: number };
type Put = { path: string; mode: number; content: string };

/** What the container believes /workspace matches. `pending` while a commit of its changes is in flight. */
let version: string | null = null;
let pending: { base: string } | null = null;
let index = new Map<string, FileState>();
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

async function applySync(body: { from: string | null; to: string; put: Put[]; remove: string[] }) {
  if (body.from !== version || pending !== null) return { ok: false as const, have: pending === null ? version : null };
  try {
    await applyChanges(body);
  } catch (error) {
    // A half-applied sync: forget the working copy so the next exec starts from a full sync.
    version = null;
    index = new Map();
    throw error;
  }
  version = body.to;
  return { ok: true as const };
}

async function applyChanges(body: { put: Put[]; remove: string[] }) {
  for (const path of body.remove) {
    await rm(join(ROOT, path), { force: true, recursive: true });
    index.delete(path);
  }
  for (const file of body.put) {
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
}

async function changedFiles() {
  const seen = new Map<string, { mode: number; size: number; mtimeMs: number }>();
  await walk(ROOT, "", seen);
  const put: Put[] = [];
  const remove: string[] = [];
  const next = new Map<string, FileState>();
  for (const [path, stat] of seen) {
    const known = index.get(path);
    if (known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.mode === stat.mode) {
      next.set(path, known);
      continue;
    }
    const bytes = await readFile(join(ROOT, path));
    const hash = sha256(bytes);
    next.set(path, { hash, ...stat });
    if (known !== undefined && known.hash === hash && known.mode === stat.mode) continue;
    put.push({ path, mode: stat.mode, content: Buffer.from(bytes).toString("base64") });
  }
  for (const path of index.keys()) if (!seen.has(path)) remove.push(path);
  index = next;
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
    ? { NODE_EXTRA_CA_CERTS: EGRESS_CA, REQUESTS_CA_BUNDLE: BUNDLE, SSL_CERT_FILE: BUNDLE, CURL_CA_BUNDLE: BUNDLE, GIT_SSL_CAINFO: BUNDLE }
    : {};
}

async function run(command: string, cwd: string, env: Record<string, string>, timeoutMs: number) {
  const caEnv = await trustEgressCa();
  // setsid: the command gets its own process group, so a timeout kills what it started in the background too.
  const child = Bun.spawn(["setsid", "bash", "-c", command], {
    cwd,
    env: { ...process.env, ...caEnv, HOME: ROOT, ...env },
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

await mkdir(ROOT, { recursive: true });

Bun.serve({
  port: 8080,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, bootedAt, version, pending, execs });

    if (url.pathname === "/exec" && request.method === "POST") {
      const started = performance.now();
      const body = (await request.json()) as {
        sync: { from: string | null; to: string; put: Put[]; remove: string[] };
        command: string;
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      };
      const synced = await applySync(body.sync);
      if (!synced.ok) return json({ error: "version_mismatch", have: synced.have }, 409);
      const syncMs = performance.now() - started;
      execs += 1;
      const base = version as string;
      const result = await run(body.command, body.cwd ?? ROOT, body.env ?? {}, body.timeoutMs ?? 120_000);
      const execMs = performance.now() - started - syncMs;
      const changes = await changedFiles();
      if (changes.put.length > 0 || changes.remove.length > 0) pending = { base };
      const scanMs = performance.now() - started - syncMs - execMs;
      return json({
        ...result,
        base,
        changes,
        timings: {
          "container.sync": round(syncMs),
          "container.exec": round(execMs),
          "container.scan": round(scanMs),
        },
        container: { bootedAt, execs },
      });
    }

    if (url.pathname === "/ack" && request.method === "POST") {
      const body = (await request.json()) as { base: string; version: string };
      if (pending === null || pending.base !== body.base) return json({ error: "nothing_pending", version }, 409);
      version = body.version;
      pending = null;
      return json({ ok: true, version });
    }

    if (url.pathname === "/reset" && request.method === "POST") {
      // After a failed commit: drop the working copy so the next exec starts from a full sync.
      await rm(ROOT, { recursive: true, force: true });
      await mkdir(ROOT, { recursive: true });
      version = null;
      pending = null;
      index = new Map();
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  },
});

function round(ms: number) {
  return Math.round(ms * 10) / 10;
}

console.log(`harbour container agent listening on 8080 (booted ${new Date(bootedAt).toISOString()})`);
