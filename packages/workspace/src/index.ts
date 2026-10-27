/**
 * Portable workspace logic shared by every target: path rules, mount lookup, digests and content bytes.
 */
import { type CallContext, HarbourError, type Mount, type WorkspaceRecord, type Workspaces } from "@harbour/contracts";

/**
 * Returns `path` when it is a normalised relative workspace path, such as `notes/a.md`. Rejects with `invalid` an
 * empty path, an absolute path, a backslash, a NUL, a trailing slash, an empty segment and `.` or `..` segments.
 */
export function normalizeWorkspacePath(path: string): string {
	if (typeof path !== "string" || path.length === 0) throw invalidPath(path, "a workspace path must not be empty");
	if (path.startsWith("/")) throw invalidPath(path, "a workspace path must be relative");
	if (path.includes("\\")) throw invalidPath(path, "a workspace path must not contain a backslash");
	if (path.includes("\0")) throw invalidPath(path, "a workspace path must not contain NUL");
	if (path.endsWith("/")) throw invalidPath(path, "a workspace path must not end with a slash");
	for (const segment of path.split("/")) {
		if (segment === "") throw invalidPath(path, "a workspace path must not contain an empty segment");
		if (segment === "." || segment === "..") throw invalidPath(path, "a workspace path must not contain . or ..");
	}
	return path;
}

/** Returns `path` when it is an absolute mount point such as `/project`; rejects with `invalid` otherwise. */
export function normalizeMountPoint(path: string): string {
	if (typeof path !== "string" || !path.startsWith("/") || path.length < 2) {
		throw invalidPath(path, "a mount point must be an absolute path such as /project");
	}
	normalizeWorkspacePath(path.slice(1));
	return path;
}

/** Whether the absolute `path` is a mount point or lies below one. */
export function isUnderMount(path: string, mounts: readonly Pick<Mount, "path">[]): boolean {
	return mounts.some((mount) => path === mount.path || path.startsWith(`${mount.path}/`));
}

/**
 * The mount an absolute path reads, and the path inside the mount's source (`""` for the mount point itself).
 * Undefined when the path is under no mount; rejects with `invalid` when the part below the mount is not normalised.
 */
export function findMount<M extends Pick<Mount, "path">>(
	path: string,
	mounts: readonly M[],
): { readonly mount: M; readonly sourcePath: string } | undefined {
	for (const mount of mounts) {
		if (path === mount.path) return { mount, sourcePath: "" };
		if (path.startsWith(`${mount.path}/`)) {
			return { mount, sourcePath: normalizeWorkspacePath(path.slice(mount.path.length + 1)) };
		}
	}
	return undefined;
}

/** Hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
	let hex = "";
	for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

const encoder = new TextEncoder();

/** UTF-8 bytes of a string, or a copy of the given bytes so callers cannot change stored content. */
export function toBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);
}

/**
 * A `Workspaces` that can also open a workspace under an ID the caller derives, creating it at version 0 on first use.
 * Sources that keep their own versioned trees in workspaces (project files) use it. Not part of the contract: Harbour's
 * own implementations offer it; a host's need not.
 */
export interface KeyedWorkspaces extends Workspaces {
	/**
	 * Returns the workspace `id`, creating it from `input` when absent; two racing callers get the same record. `id`
	 * must pass `checkKeyedId`. An ID held by another organisation is `conflict`.
	 */
	ensure(ctx: CallContext, id: string, input: Parameters<Workspaces["create"]>[1]): Promise<WorkspaceRecord>;
}

/** Rejects with `invalid` an ID that `ensure` may not use: a lowercase prefix, `_`, then 1 to 120 of `[A-Za-z0-9_-]`. */
export function checkKeyedId(id: string): string {
	if (typeof id !== "string" || !/^[a-z]+_[A-Za-z0-9_-]{1,120}$/.test(id)) {
		throw new HarbourError("invalid", "a keyed workspace ID is a lowercase prefix, _ and up to 120 safe characters");
	}
	return id;
}

function invalidPath(path: unknown, message: string): HarbourError {
	return new HarbourError("invalid", message, { path: typeof path === "string" ? path : String(path) });
}
