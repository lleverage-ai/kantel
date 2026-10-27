import type { Context } from "@earendil-works/chord";
import {
  type BinaryReader,
  err,
  ExecutionError,
  type ExecutionEnv,
  FileError,
  type FileInfo,
  LineScanner,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import type { ExecResult, SandboxTier, WorkspaceManifest, WorkspaceVersion } from "./contracts.ts";
import type { HarbourSandbox } from "./sandbox.ts";
import { normalisePath, type R2Workspace } from "./workspace.ts";

export const ROOT = "/workspace";

export type ExecRecord = { command: string; tier: SandboxTier; exitCode: number; base: string; version: string; timings: ExecResult["timings"] };

/**
 * Pi Durable's ExecutionEnv for one Harbour session. Shell commands go to the Sandbox (isolate or container); file
 * operations go straight to the versioned workspace, each write a commit. Both move the same head, held by the
 * SessionDO, so the agent's read/write/edit tools and both shell tiers see one tree.
 *
 * Only what Pi's coding tools use is implemented; the rest returns `not_supported`.
 */
export class HarbourEnv implements ExecutionEnv {
  readonly id: string;
  cwd = ROOT;

  constructor(
    private readonly workspace: R2Workspace,
    private readonly sandbox: HarbourSandbox,
    private readonly head: { get(): WorkspaceVersion; set(version: WorkspaceVersion): void },
    private readonly onExec: (record: ExecRecord) => Promise<void>,
  ) {
    this.id = `harbour:${workspace.id}`;
  }

  // ---- paths -------------------------------------------------------------------------------------------------------

  #relative(path: string): Result<string, FileError> {
    const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
    const clean = `/${normalisePath(absolute)}`;
    if (clean === ROOT) return ok("");
    if (!clean.startsWith(`${ROOT}/`)) return err(new FileError("permission_denied", `outside ${ROOT}: ${path}`, path));
    return ok(clean.slice(ROOT.length + 1));
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    const relative = this.#relative(path);
    return relative.ok ? ok(relative.value === "" ? ROOT : `${ROOT}/${relative.value}`) : relative;
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    return this.absolutePath(path);
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(parts.join("/").replace(/\/+/g, "/"));
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  async #manifest(): Promise<WorkspaceManifest> {
    return this.workspace.manifest(this.head.get());
  }

  async #bytes(path: string): Promise<Result<Uint8Array, FileError>> {
    const relative = this.#relative(path);
    if (!relative.ok) return relative;
    const manifest = await this.#manifest();
    const entry = manifest.entries[relative.value];
    if (entry === undefined) {
      return isDirectory(manifest, relative.value)
        ? err(new FileError("is_directory", `is a directory: ${path}`, path))
        : err(new FileError("not_found", `no such file: ${path}`, path));
    }
    const bytes = await this.workspace.readBlob(entry.hash);
    return bytes === null ? err(new FileError("unknown", `missing blob for ${path}`, path)) : ok(bytes);
  }

  async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
    return this.#bytes(path);
  }

  async readTextFile(path: string): Promise<Result<string, FileError>> {
    const bytes = await this.#bytes(path);
    return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined): Promise<Result<string[], FileError>> {
    const text = await this.readTextFile(path);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    const relative = this.#relative(path);
    if (!relative.ok) return relative;
    const manifest = await this.#manifest();
    const absolute = relative.value === "" ? ROOT : `${ROOT}/${relative.value}`;
    const name = absolute.slice(absolute.lastIndexOf("/") + 1);
    const entry = manifest.entries[relative.value];
    if (entry !== undefined) return ok({ name, path: absolute, kind: "file", size: entry.size, mtimeMs: 0 });
    if (isDirectory(manifest, relative.value)) return ok({ name, path: absolute, kind: "directory", size: 0, mtimeMs: 0 });
    return err(new FileError("not_found", `no such file: ${path}`, path));
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : info;
  }

  async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
    const relative = this.#relative(path);
    if (!relative.ok) return relative;
    const manifest = await this.#manifest();
    const prefix = relative.value === "" ? "" : `${relative.value}/`;
    const children = new Map<string, FileInfo>();
    for (const entry of Object.values(manifest.entries)) {
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const childPath = `${ROOT}/${prefix}${name}`;
      if (slash === -1) children.set(name, { name, path: childPath, kind: "file", size: entry.size, mtimeMs: 0 });
      else if (!children.has(name)) children.set(name, { name, path: childPath, kind: "directory", size: 0, mtimeMs: 0 });
    }
    return ok([...children.values()]);
  }

  async openBinaryReader(path: string): Promise<Result<BinaryReader, FileError>> {
    const bytes = await this.#bytes(path);
    if (!bytes.ok) return bytes;
    const info = await this.fileInfo(path);
    if (!info.ok) return info;
    const data = bytes.value;
    return ok({
      info: async () => ok(info.value),
      read: async (offset: number, length: number) => ok(data.subarray(offset, offset + length)),
      scanLines: async (options: { startLine: number; endLine?: number }) => {
        const scanner = new LineScanner(options.startLine, options.endLine);
        scanner.push(data);
        return ok(scanner.finish());
      },
      close: async () => {},
    });
  }

  // ---- writes ------------------------------------------------------------------------------------------------------

  async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const relative = this.#relative(path);
    if (!relative.ok) return relative;
    if (relative.value === "") return err(new FileError("is_directory", "cannot write the workspace root", path));
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const manifest = await this.#manifest();
    const previous = manifest.entries[relative.value];
    const hash = await this.workspace.putBlob(bytes);
    if (previous?.hash === hash) return ok(undefined);
    const version = await this.workspace.commit(this.head.get(), [
      { kind: "put", path: relative.value, hash, size: bytes.byteLength, mode: previous?.mode ?? 0o644 },
    ]);
    this.head.set(version);
    return ok(undefined);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const existing = await this.#bytes(path);
    const add = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (!existing.ok && existing.error.code !== "not_found") return existing;
    const before = existing.ok ? existing.value : new Uint8Array();
    const joined = new Uint8Array(before.byteLength + add.byteLength);
    joined.set(before);
    joined.set(add, before.byteLength);
    return this.writeFile(path, joined);
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined): Promise<Result<void, FileError>> {
    const relative = this.#relative(path);
    if (!relative.ok) return relative;
    const manifest = await this.#manifest();
    const prefix = `${relative.value}/`;
    const doomed = Object.keys(manifest.entries).filter(
      (candidate) => candidate === relative.value || (options?.recursive === true && candidate.startsWith(prefix)),
    );
    if (doomed.length === 0) return options?.force === true ? ok(undefined) : err(new FileError("not_found", path, path));
    this.head.set(await this.workspace.commit(this.head.get(), doomed.map((p) => ({ kind: "delete" as const, path: p }))));
    return ok(undefined);
  }

  async createDir(): Promise<Result<void, FileError>> {
    // Directories exist implicitly in the manifest.
    return ok(undefined);
  }

  // ---- shell -------------------------------------------------------------------------------------------------------

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const text = typeof command === "string" ? command : command.map(shellQuote).join(" ");
    try {
      const result = await this.sandbox.exec({
        command: text,
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout * 1000 }),
      });
      await this.onExec({
        command: text,
        tier: result.tier,
        exitCode: result.exitCode,
        base: result.base,
        version: result.version,
        timings: result.timings,
      });
      if (result.stdout !== "") options?.onOutput?.(result.stdout, context, { stream: "stdout" });
      if (result.stderr !== "") options?.onOutput?.(result.stderr, context, { stream: "stderr" });
      return ok({ exitCode: result.exitCode });
    } catch (error) {
      return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
    }
  }

  // ---- not needed by the spike's tools -----------------------------------------------------------------------------

  async openTextLineReader(path: string) {
    return unsupported(path, "openTextLineReader");
  }
  async truncateFile(path: string) {
    return unsupported(path, "truncateFile");
  }
  async flushFile(): Promise<Result<void, FileError>> {
    return ok(undefined);
  }
  async renameFile(path: string) {
    return unsupported(path, "renameFile");
  }
  async openDirReader(path: string) {
    return unsupported(path, "openDirReader");
  }
  async watch() {
    return unsupported(ROOT, "watch");
  }
  async createTempDir() {
    return unsupported(ROOT, "createTempDir");
  }
  async createTempFile() {
    return unsupported(ROOT, "createTempFile");
  }
  async cleanup(): Promise<void> {}
}

function unsupported(path: string, operation: string): Result<never, FileError> {
  return err(new FileError("not_supported", `${operation} is not supported by the spike workspace`, path));
}

function isDirectory(manifest: WorkspaceManifest, relative: string): boolean {
  if (relative === "") return true;
  const prefix = `${relative}/`;
  return Object.keys(manifest.entries).some((path) => path.startsWith(prefix));
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./=:-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
