import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	LineScanner,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { type CallContext, type FileEntry, isHarbourError, type SandboxTier } from "@harbour/contracts";
import type { CloudflareSandboxes } from "./sandbox.ts";
import { listAll, type ModedChange, type ObjectStoreWorkspaces } from "./workspace.ts";

export const ROOT = "/workspace";
const COMMIT_ATTEMPTS = 3;

export type ExecRecord = {
	command: string;
	tier: SandboxTier;
	exitCode: number;
	leaseId: string;
	base: number;
	version: number;
	timings: Record<string, number>;
};

/**
 * Pi Durable's ExecutionEnv for one Harbour session, over M0-BE1's contracts. Shell commands go to `Sandboxes.run`
 * (tool `bash`, routed by the contract's tier table); file operations go to `Workspaces`, each write a commit on the
 * head. Both tiers and the read/write/edit tools see one tree.
 *
 * Only what Pi's coding tools use is implemented; the rest returns `not_supported`.
 */
export class HarbourEnv implements ExecutionEnv {
	readonly id: string;
	cwd = ROOT;

	constructor(
		private readonly ctx: CallContext,
		private readonly sessionId: string,
		private readonly workspaceId: string,
		private readonly workspaces: ObjectStoreWorkspaces,
		private readonly sandboxes: CloudflareSandboxes,
		private readonly onExec: (record: ExecRecord) => Promise<void>,
	) {
		this.id = `harbour:${workspaceId}`;
	}

	// ---- paths -------------------------------------------------------------------------------------------------------

	/** The path relative to the workspace root ("" for the root), or an error for anything outside it. */
	#relative(path: string): Result<string, FileError> {
		const absolute = path.startsWith("/") ? path : `${this.cwd}/${path}`;
		const parts: string[] = [];
		for (const part of absolute.split("/")) {
			if (part === "" || part === ".") continue;
			if (part === "..") parts.pop();
			else parts.push(part);
		}
		const clean = `/${parts.join("/")}`;
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

	async #bytes(path: string): Promise<Result<Uint8Array, FileError>> {
		const relative = this.#relative(path);
		if (!relative.ok) return relative;
		if (relative.value === "") return err(new FileError("is_directory", `is a directory: ${path}`, path));
		try {
			return ok((await this.workspaces.read(this.ctx, this.workspaceId, relative.value)).content);
		} catch (error) {
			return err(fileError(error, path));
		}
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
		if (relative.value === "") return ok({ name: "workspace", path: ROOT, kind: "directory", size: 0, mtimeMs: 0 });
		try {
			return ok(info(await this.workspaces.stat(this.ctx, this.workspaceId, relative.value)));
		} catch (error) {
			return err(fileError(error, path));
		}
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const found = await this.fileInfo(path);
		if (found.ok) return ok(true);
		return found.error.code === "not_found" ? ok(false) : found;
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const relative = this.#relative(path);
		if (!relative.ok) return relative;
		try {
			const entries: FileInfo[] = [];
			let cursor: string | undefined;
			do {
				const page = await this.workspaces.list(this.ctx, this.workspaceId, {
					path: relative.value,
					...(cursor === undefined ? {} : { cursor }),
				});
				entries.push(...page.items.map(info));
				cursor = page.nextCursor;
			} while (cursor !== undefined);
			return ok(entries);
		} catch (error) {
			return err(fileError(error, path));
		}
	}

	async openBinaryReader(path: string): Promise<Result<BinaryReader, FileError>> {
		const bytes = await this.#bytes(path);
		if (!bytes.ok) return bytes;
		const found = await this.fileInfo(path);
		if (!found.ok) return found;
		const data = bytes.value;
		return ok({
			info: async () => ok(found.value),
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

	/** Commits `changes` on the head, re-reading it if another writer moved it first. */
	async #commit(changes: ModedChange[], message: string): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			const { head } = await this.workspaces.get(this.ctx, this.workspaceId);
			try {
				await this.workspaces.commit(this.ctx, this.workspaceId, {
					baseVersion: head,
					changes,
					writer: { sessionId: this.sessionId },
					message,
				});
				return;
			} catch (error) {
				if (!isHarbourError(error, "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
			}
		}
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const relative = this.#relative(path);
		if (!relative.ok) return relative;
		if (relative.value === "") return err(new FileError("is_directory", "cannot write the workspace root", path));
		try {
			await this.#commit([{ op: "put", path: relative.value, content }], `write ${relative.value}`);
			return ok(undefined);
		} catch (error) {
			return err(fileError(error, path));
		}
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

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
	): Promise<Result<void, FileError>> {
		const relative = this.#relative(path);
		if (!relative.ok) return relative;
		if (relative.value === "") return err(new FileError("permission_denied", "cannot remove the workspace root", path));
		try {
			let entry: FileEntry | undefined;
			try {
				entry = await this.workspaces.stat(this.ctx, this.workspaceId, relative.value);
			} catch (error) {
				if (!isHarbourError(error, "not_found")) throw error;
			}
			if (entry === undefined) {
				return options?.force === true ? ok(undefined) : err(new FileError("not_found", path, path));
			}
			let doomed = [relative.value];
			if (entry.kind === "directory") {
				if (options?.recursive !== true) return err(new FileError("is_directory", `is a directory: ${path}`, path));
				doomed = (await listAll(this.workspaces, this.ctx, this.workspaceId, { path: relative.value }))
					.filter((candidate) => candidate.kind === "file")
					.map((candidate) => candidate.path);
			}
			await this.#commit(
				doomed.map((doomedPath): ModedChange => ({ op: "delete", path: doomedPath })),
				`remove ${relative.value}`,
			);
			return ok(undefined);
		} catch (error) {
			return err(fileError(error, path));
		}
	}

	async createDir(): Promise<Result<void, FileError>> {
		// Directories exist implicitly in the workspace.
		return ok(undefined);
	}

	// ---- shell -------------------------------------------------------------------------------------------------------

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const text = typeof command === "string" ? command : command.join(" ");
		let cwd: string | undefined;
		if (options?.cwd !== undefined) {
			const relative = this.#relative(options.cwd);
			if (!relative.ok) return err(new ExecutionError("unknown", relative.error.message));
			cwd = relative.value;
		}
		try {
			const result = await this.sandboxes.run(this.ctx, {
				sessionId: this.sessionId,
				workspaceId: this.workspaceId,
				tool: "bash",
				request: {
					command,
					...(cwd === undefined || cwd === "" ? {} : { cwd }),
					...(options?.env === undefined ? {} : { env: options.env }),
					...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout * 1000 }),
				},
			});
			await this.onExec({
				command: text,
				tier: result.tier,
				exitCode: result.exitCode,
				leaseId: result.leaseId,
				base: result.baseVersion,
				version: result.workspaceVersion,
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

function info(entry: FileEntry): FileInfo {
	const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
	const path = entry.path.startsWith("/") ? entry.path : `${ROOT}/${entry.path}`;
	return { name, path, kind: entry.kind, size: entry.size, mtimeMs: 0 };
}

function fileError(error: unknown, path: string): FileError {
	if (isHarbourError(error, "not_found")) return new FileError("not_found", `no such file: ${path}`, path);
	if (isHarbourError(error, "invalid") && /is a directory/.test(error.message)) {
		return new FileError("is_directory", `is a directory: ${path}`, path);
	}
	if (isHarbourError(error, "refused")) return new FileError("permission_denied", error.message, path);
	return new FileError("unknown", error instanceof Error ? error.message : String(error), path);
}

function unsupported(path: string, operation: string): Result<never, FileError> {
	return err(new FileError("not_supported", `${operation} is not supported by the spike workspace`, path));
}
