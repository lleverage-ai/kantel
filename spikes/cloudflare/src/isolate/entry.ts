/**
 * The isolate tier: runs inside a Dynamic Worker, one per session, loaded by the SessionDO through the Worker Loader.
 * Bundled by scripts/build-isolate.ts into dist/isolate.bundle.txt; never imported by the main Worker directly.
 *
 * Each command builds a just-bash shell over a lazy view of one workspace version: the manifest is listed up front,
 * bodies are fetched by hash on first read and cached for the life of the isolate. What the command changed is
 * committed before exec() returns, so the next command (in either tier) sees it.
 *
 * Network: fetch() here goes to the loader's globalOutbound, the vault. There is no other way out.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { Bash, InMemoryFs } from "just-bash/browser";
import type { WorkspaceChange, WorkspaceManifest } from "../contracts.ts";

const ROOT = "/workspace";
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;

interface WorkspaceBinding {
  manifest(version: string): Promise<WorkspaceManifest>;
  readBlob(hash: string): Promise<Uint8Array | null>;
  putBlob(bytes: Uint8Array): Promise<string>;
  commit(base: string, changes: readonly WorkspaceChange[]): Promise<string>;
}

type IsolateEnv = { readonly WORKSPACE: WorkspaceBinding };

export interface IsolateExecRequest {
  readonly command: string;
  readonly base: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

const bootedAt = Date.now();
let calls = 0;
const manifests = new Map<string, WorkspaceManifest>();
const blobs = new Map<string, Uint8Array>();
let blobBytes = 0;

async function manifestOf(env: IsolateEnv, version: string): Promise<WorkspaceManifest> {
  const cached = manifests.get(version);
  if (cached !== undefined) return cached;
  const manifest = await env.WORKSPACE.manifest(version);
  manifests.set(version, manifest);
  return manifest;
}

async function blobOf(env: IsolateEnv, hash: string): Promise<Uint8Array> {
  const cached = blobs.get(hash);
  if (cached !== undefined) return cached;
  const bytes = await env.WORKSPACE.readBlob(hash);
  if (bytes === null) throw new Error(`missing blob ${hash}`);
  if (blobBytes + bytes.byteLength > BLOB_CACHE_BYTES) {
    blobs.clear();
    blobBytes = 0;
  }
  blobs.set(hash, bytes);
  blobBytes += bytes.byteLength;
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function relative(path: string): string | undefined {
  if (path === ROOT) return "";
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : undefined;
}

/** In-memory fs over the manifest, with lazy bodies, recording which paths a command touched. */
function workspaceFs(env: IsolateEnv, manifest: WorkspaceManifest) {
  const fs = new InMemoryFs({});
  fs.mkdirSync?.(ROOT, { recursive: true });
  for (const entry of Object.values(manifest.entries)) {
    fs.writeFileLazy(`${ROOT}/${entry.path}`, () => blobOf(env, entry.hash), { mode: entry.mode });
  }
  const touched = new Set<string>();
  const mark = (path: unknown) => {
    if (typeof path === "string") touched.add(path);
  };
  const tracked = new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const name = String(property);
      return (...args: unknown[]) => {
        switch (name) {
          case "writeFile":
          case "appendFile":
          case "chmod":
          case "createExclusive":
            mark(args[0]);
            break;
          case "cp":
          case "link":
            mark(args[1]);
            break;
          case "mv":
            mark(args[0]);
            mark(args[1]);
            break;
          case "rm":
            mark(args[0]);
            break;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fs, tracked, touched };
}

async function collectChanges(
  env: IsolateEnv,
  fs: InMemoryFs,
  manifest: WorkspaceManifest,
  touched: ReadonlySet<string>,
): Promise<WorkspaceChange[]> {
  const changes: WorkspaceChange[] = [];
  const touchedPrefixes = [...touched].map((path) => path.replace(/\/+$/, ""));
  const isTouched = (absolute: string) =>
    touchedPrefixes.some((prefix) => absolute === prefix || absolute.startsWith(`${prefix}/`));

  for (const absolute of fs.getAllPaths()) {
    const path = relative(absolute);
    if (path === undefined || path === "" || !isTouched(absolute)) continue;
    const stat = await fs.lstat(absolute);
    if (!stat.isFile) continue;
    const bytes = await fs.readFileBuffer(absolute);
    const hash = await sha256Hex(bytes);
    const mode = stat.mode & 0o777;
    const previous = manifest.entries[path];
    if (previous !== undefined && previous.hash === hash && previous.mode === mode) continue;
    const stored = await env.WORKSPACE.putBlob(bytes);
    blobs.set(stored, bytes);
    changes.push({ kind: "put", path, hash: stored, size: bytes.byteLength, mode });
  }
  for (const path of Object.keys(manifest.entries)) {
    if (!(await fs.exists(`${ROOT}/${path}`))) changes.push({ kind: "delete", path });
  }
  return changes;
}

export class HarbourIsolate extends WorkerEntrypoint<IsolateEnv> {
  /** Runs one command in just-bash and commits what it changed. */
  async exec(request: IsolateExecRequest) {
    calls += 1;
    const started = performance.now();
    const timings: Record<string, number> = {};
    const mark = (phase: string, from: number) => {
      timings[phase] = Math.round((performance.now() - from) * 10) / 10;
      return performance.now();
    };
    let at = performance.now();
    const manifest = await manifestOf(this.env, request.base);
    at = mark("isolate.manifest", at);
    const { fs, tracked, touched } = workspaceFs(this.env, manifest);
    const bash = new Bash({
      fs: tracked as unknown as InMemoryFs,
      cwd: request.cwd ?? ROOT,
      env: { HOME: ROOT, USER: "harbour", ...request.env },
      // just-bash's own allow-list is off on purpose: the vault (globalOutbound) is the policy point, and the
      // private-range check needs DNS pinning, which Workers cannot do. Its default turns on when `process` exists,
      // as it does under nodejs_compat, so it is set explicitly.
      network: { dangerouslyAllowFullInternetAccess: true, denyPrivateRanges: false },
    });
    const controller = new AbortController();
    const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), request.timeoutMs);
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await bash.exec(request.command, { signal: controller.signal, rawScript: true });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    at = mark("isolate.exec", at);
    const changes = await collectChanges(this.env, fs, manifest, touched);
    const version = changes.length === 0 ? request.base : await this.env.WORKSPACE.commit(request.base, changes);
    mark("isolate.commit", at);
    timings["isolate.total"] = Math.round((performance.now() - started) * 10) / 10;
    return {
      tier: "isolate" as const,
      exitCode: controller.signal.aborted ? 124 : result.exitCode,
      stdout: result.stdout,
      stderr: controller.signal.aborted ? `${result.stderr}timed out after ${request.timeoutMs} ms\n` : result.stderr,
      base: request.base,
      version,
      changed: changes.length,
      timings,
      isolate: { bootedAt, calls },
    };
  }

  /** Liveness and reuse: when this isolate booted and how many commands it has run. */
  async ping() {
    return { bootedAt, calls };
  }
}

export default {
  fetch(): Response {
    return new Response("harbour isolate\n");
  },
};
