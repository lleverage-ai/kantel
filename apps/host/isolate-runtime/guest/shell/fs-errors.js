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
	EIO: "Input/output error",
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
 * A lazy read's error as just-bash expects one. The file is in the manifest, so it exists: the workspace's "file too
 * large" becomes EFBIG (with its explanation as `reason`), which the patched just-bash reports as such, and any other
 * failure EIO, never one just-bash could take for a missing file (whose message it reads when there is no code) and
 * create in its place, emptying it (`exec 3<> f`, awk's append).
 */
export function readError(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/file too large/i.test(message)) {
		return Object.assign(new Error(message), { code: "EFBIG", reason: message.replace(/^blob: /, "") });
	}
	return Object.assign(new Error(message), { code: "EIO" });
}
