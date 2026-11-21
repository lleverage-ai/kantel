// How the shell words a filesystem error, as bash does. Installed as `globalThis.__justBashFsError` (the hook
// guest/just-bash-patches.ts adds), so an error a redirection meets fails only its own command, and used for the
// errors the shell's own lazy reads raise.

const WORDING = {
	ENOENT: "No such file or directory",
	EISDIR: "Is a directory",
	ENOTDIR: "Not a directory",
	EACCES: "Permission denied",
	EPERM: "Operation not permitted",
	EEXIST: "File exists",
	EFBIG: "File too large",
	ENOSPC: "No space left on device",
	EROFS: "Read-only file system",
};

/** Bash's line for a filesystem error with a code it knows (`bash: <path>: <wording>`), or undefined for any other. */
export function describeFsError(error) {
	if (!error || typeof error !== "object") return undefined;
	const { code, path, reason } = error;
	if (typeof code !== "string" || !(code in WORDING)) return undefined;
	const wording = code === "EFBIG" && typeof reason === "string" && reason ? reason : WORDING[code];
	return `bash: ${typeof path === "string" && path ? `${path}: ` : ""}${wording}\n`;
}

/**
 * A lazy read's error as just-bash expects one: the workspace's "file too large" becomes EFBIG (with its explanation
 * as `reason`), which the patched just-bash reports as such rather than as a missing file. Others pass as they are.
 */
export function readError(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/file too large/i.test(message)) {
		return Object.assign(new Error(message), { code: "EFBIG", reason: message.replace(/^blob: /, "") });
	}
	return error;
}
