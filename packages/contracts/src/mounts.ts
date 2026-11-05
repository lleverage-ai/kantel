/**
 * Read-only mounts (experimental): files from outside a sandbox, present and readable inside it from its first command.
 * A sandbox's create names what goes where (`mounts`); Kantel decides how. Two sources:
 *
 * - a bundle: a tar the account uploaded, stored once and named by its SHA-256 (`sha256:<hex>`). A microVM's host
 *   turns it into a read-only drive, cached on the host and shared by every sandbox that mounts it.
 * - a bucket prefix: an object-store prefix (S3 or GCS) through a bucket source the account holds, with its credentials.
 *   The host mounts it lazily and read-only; the credentials stay on the host, never in the sandbox.
 *
 * What is mounted can't be changed from inside the sandbox: writing back is the caller's job, never Kantel's.
 *
 * The same switch turns on the signed file URLs (`files/upload-url`, `files/download-url`) and archive extraction
 * (`files/archive`), which move files of any size in and out without base64.
 *
 * Experimental: a deployment turns them on with `KANTEL_MOUNTS=experimental` (`mountsEnabled`). Off, a create that
 * names `mounts` and every route of theirs is answered `not_supported`.
 */

/** The deployment switch, an environment variable. */
export const MOUNTS_SWITCH = "KANTEL_MOUNTS";

/** Whether the switch's value turns mounts on: only `experimental` does, while they are. */
export function mountsEnabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === "experimental";
}

/** What a create that names `mounts`, or a route of theirs, is told with the switch off. */
export const MOUNTS_OFF = "Mounts and file URLs are off on this deployment (KANTEL_MOUNTS)";

/** The most mounts one sandbox may have. */
export const MAX_MOUNTS = 16;

/** A bundle's digest: `sha256:` and 64 lower-case hex digits. */
export const BUNDLE_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";

/**
 * Directories a mount may not be at or under: the system's own, which a mount would hide or break. `/` is refused too.
 */
export const MOUNT_SYSTEM_PATHS: readonly string[] = [
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/proc",
	"/run",
	"/sbin",
	"/sys",
	"/usr",
	"/var/lib/docker",
	"/var/run",
];

/** Whether `inner` is `outer` or under it; both normalised and absolute. */
export function pathWithin(inner: string, outer: string): boolean {
	if (outer === "/") return true;
	return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * Why `path` can't be a mount's path, or `undefined` when it can: absolute, normalised (no `.`, `..`, `//` or trailing
 * `/`), at most 1024 characters, not `/` and not at or under a system directory (`MOUNT_SYSTEM_PATHS`).
 */
export function mountPathProblem(path: string): string | undefined {
	if (!path.startsWith("/")) return `A mount's path must be absolute: ${JSON.stringify(path)}`;
	if (path.length > 1024) return "A mount's path is at most 1024 characters";
	if (path === "/") return "A mount can't be at /";
	if (path.endsWith("/")) return `A mount's path has no trailing slash: ${JSON.stringify(path)}`;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
	if (/[\u0000-\u001f\u007f]/.test(path)) return "A mount's path has no control characters";
	const segments = path.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		return `A mount's path must be normalised (no empty, \`.\` or \`..\` parts): ${JSON.stringify(path)}`;
	}
	const system = MOUNT_SYSTEM_PATHS.find((dir) => pathWithin(path, dir));
	if (system !== undefined) return `A mount can't be at or under ${system}: ${path}`;
	return undefined;
}

/**
 * Why a set of mount paths can't go together, or `undefined`: more than `MAX_MOUNTS`, a bad path, or two paths that are
 * the same or one under the other.
 */
export function mountPathsProblem(paths: readonly string[]): string | undefined {
	if (paths.length > MAX_MOUNTS) return `A sandbox has at most ${MAX_MOUNTS} mounts`;
	for (const path of paths) {
		const problem = mountPathProblem(path);
		if (problem !== undefined) return problem;
	}
	for (let i = 0; i < paths.length; i++) {
		for (let j = i + 1; j < paths.length; j++) {
			const a = paths[i] as string;
			const b = paths[j] as string;
			if (pathWithin(a, b) || pathWithin(b, a)) return `Mounts overlap: ${a} and ${b}`;
		}
	}
	return undefined;
}

/** The mount `path` is at or under, of `mounts`, if any: a write there is refused, as a mount is read-only. */
export function mountCovering<M extends { readonly path: string }>(
	mounts: readonly M[] | undefined,
	path: string,
): M | undefined {
	return mounts?.find((mount) => pathWithin(path, mount.path));
}

/**
 * The mounts `path` is in, or that are under `path`: extracting an archive into `path`, or deleting it, would reach
 * them.
 */
export function mountsTouching<M extends { readonly path: string }>(
	mounts: readonly M[] | undefined,
	path: string,
): M[] {
	return (mounts ?? []).filter((mount) => pathWithin(mount.path, path) || pathWithin(path, mount.path));
}

/** A signed file URL's lifetime when the request names none: 15 minutes. */
export const DEFAULT_FILE_URL_TTL_SECONDS = 900;
/** The longest a signed file URL lasts: an hour. */
export const MAX_FILE_URL_TTL_SECONDS = 3600;
