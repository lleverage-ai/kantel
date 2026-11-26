// Kantel's shell filesystem: just-bash's in-memory one, built per command from the manifest the host sends (a file's
// body is read only when the command reads it), and the command's changes committed to the workspace (the filesystem
// provider, through the runtime's ops) in one commit, whose catch-up is the next manifest. The default filesystem of
// createShell (shell/index.js); an embedder gives its own with the same shape (see `ShellFilesystem` there).
import { InMemoryFs } from "just-bash/browser";
import { readError } from "./fs-errors.js";

export const ROOT = "/workspace";

export const abs = (path) => (path === "" ? ROOT : `${ROOT}/${path}`);
export const rel = (path) =>
	path === ROOT ? "" : path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : undefined;

export function normalise(base, path) {
	const out = [];
	for (const part of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

/** The entry just-bash's in-memory filesystem holds at a path, as it is (a lazy file not loaded). */
function entries(fs) {
	// just-bash 3.6 keeps its entries in `data`: a lazy file as `{ lazy }`, the function it was given, replaced on its
	// first read by `{ content }`, the bytes that function returned, and by a new entry on any write.
	if (!(fs.data instanceof Map))
		throw new Error("this just-bash's in-memory filesystem doesn't keep its entries in `data`");
	return (full) => fs.data.get(full);
}

/** A workspace node (the filesystem provider's) as a manifest entry. */
function entryOf(node) {
	if (node.kind === "file") return { kind: "file", sha: node.file, size: node.size, mode: node.mode };
	if (node.kind === "symlink") return { kind: "symlink", target: node.target };
	return { kind: "dir" };
}

/** Kantel's shell filesystem over the runtime's workspace ops (op_kt_blob_read, op_kt_stage, op_kt_commit). */
export function manifestFilesystem(ops) {
	const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const sha256 = (bytes) => hex(ops.op_kt_digest("sha256", bytes));
	let nextCommit = 1;

	async function open(request) {
		let lazyReads = 0;
		const manifest = request.manifest ?? {};
		const base = request.base ?? "";
		// What the workspace keeps, and whether its file ids are the bytes' SHA-256 (Kantel's are): otherwise an id
		// says nothing about the bytes, and an unchanged file is told by the digest of what the command read.
		const capabilities = JSON.parse(ops.op_kt_workspace_capabilities());
		const originals = new Map();
		/** Where a file's body came from, by the lazy function or the bytes it gave (a file's entry holds one or the other
		 * until something replaces its body): a manifest file the command started with (`{ path }`), or a host
		 * command's staged output (`{ staged }`). A file whose entry still holds one has exactly those bytes, however it
		 * was reached, moved or copied. */
		const origins = new WeakMap();
		/** A file's body, read from the workspace when the command first reads it. A manifest file's records its digest,
		 * which tells an unchanged file from a changed one at the end. */
		const lazy = (file, origin) => {
			const load = async () => {
				lazyReads++;
				let bytes;
				try {
					bytes = await ops.op_kt_blob_read(file);
				} catch (error) {
					throw readError(error);
				}
				if (origin.path !== undefined && !capabilities.contentAddressed && !originals.has(origin.path)) {
					originals.set(origin.path, sha256(bytes));
				}
				origins.set(bytes, origin);
				return bytes;
			};
			origins.set(load, origin);
			return load;
		};
		const files = {};
		for (const [path, entry] of Object.entries(manifest)) {
			if (entry.kind === "file") files[abs(path)] = lazy(entry.sha, { path });
		}
		/** The SHA-256 of a manifest file's bytes as the command found them, or undefined if they can't be read. */
		const originalDigest = async (path, entry) => {
			if (capabilities.contentAddressed) return entry.sha;
			if (originals.has(path)) return originals.get(path);
			// Overwritten without being read: read what it was, to compare.
			try {
				return sha256(await ops.op_kt_blob_read(entry.sha));
			} catch {
				return undefined;
			}
		};
		const fs = new InMemoryFs(files);
		const entryAt = entries(fs);
		await fs.mkdir(ROOT, { recursive: true });
		for (const [path, entry] of Object.entries(manifest)) {
			if (entry.kind === "dir") await fs.mkdir(abs(path), { recursive: true });
			else if (entry.kind === "symlink") await fs.symlink(entry.target, abs(path));
			else if (entry.mode !== 0o644) await fs.chmod(abs(path), entry.mode);
		}

		/** Where the file at `full` came from, and its mode, if its entry still holds a body this command was given (see
		 * `origins`). Never loads a lazy file. */
		const originOf = (full) => {
			const entry = entryAt(full);
			if (entry?.type !== "file") return undefined;
			const origin = origins.get("lazy" in entry ? entry.lazy : entry.content);
			// Its mode as the manifest has it (special bits too): an untouched setuid or sticky file is still untouched.
			return origin && { ...origin, mode: entry.mode & 0o7777 };
		};
		/** The manifest entry of the file at `path`, if it is still that file with its bytes and mode. */
		const untouched = (path, full) => {
			const before = manifest[path];
			const origin = originOf(full);
			return before?.kind === "file" && origin?.path === path && origin.mode === before.mode ? before : undefined;
		};

		/** The workspace as a node/python run sees it: untouched files and staged outputs by id (read only if the run
		 * reads them), files this command changed inline in `chunks`. */
		async function childIndex(chunks) {
			const index = {};
			for (const full of fs.getAllPaths()) {
				const path = rel(full);
				if (path === undefined || path === "") continue;
				const origin = originOf(full);
				if (origin?.staged) {
					const { blob: sha, size, hash } = origin.staged;
					index[path] = { kind: "file", sha, size, mode: origin.mode, hash };
					continue;
				}
				const before = untouched(path, full);
				if (before) {
					// `hash` is the bytes' SHA-256 where known, for the run to tell the file unchanged.
					const hash = capabilities.contentAddressed ? before.sha : originals.get(path);
					index[path] = { kind: "file", sha: before.sha, size: before.size, mode: before.mode, hash };
					continue;
				}
				const stat = await fs.lstat(full);
				if (stat.isSymbolicLink) index[path] = { kind: "symlink", target: await fs.readlink(full) };
				else if (stat.isDirectory) index[path] = { kind: "dir" };
				else {
					const bytes = await fs.readFileBuffer(full);
					index[path] = { kind: "file", data: chunks.add(bytes), size: bytes.byteLength, mode: stat.mode & 0o777 };
				}
			}
			return index;
		}

		/** A host command's staged output (a blob it uploaded): kept as a lazy file, never read unless the command reads
		 * it, and named by the commit by its blob wherever it then is. Anything that replaces its body makes it an
		 * ordinary file again. */
		function adoptStaged(path, staged, mode) {
			// Its SHA-256, to tell it from the file it replaces: on a content-addressed workspace, its blob id.
			const hash = staged.hash ?? (capabilities.contentAddressed ? staged.blob : undefined);
			const origin = { staged: { blob: staged.blob, size: staged.size, hash } };
			fs.writeFileLazy(abs(path), lazy(staged.blob, origin), { mode: mode ?? 0o644 });
		}

		/** The reply's files when nothing ran. */
		const unchanged = () => ({ manifest, changed: [], lazyReads });

		/** Save the command's changes: one commit from the version the command started from, changed files staged
		 * first. The files as the workspace then holds them, and the commit's outcome when it wasn't `committed`. */
		async function finish() {
			const commit = {
				operationId: `exec-${nextCommit++}`,
				base,
				puts: [],
				links: [],
				dirs: [],
				removes: [],
			};
			const next = {};
			const changed = [];
			for (const full of fs.getAllPaths()) {
				const path = rel(full);
				if (path === undefined || path === "") continue;
				const before = manifest[path];
				// A host command's staged output: committed by its blob, without reading it, unless it is what the file
				// was (its bytes and mode), which is no change.
				const origin = originOf(full);
				if (origin?.staged) {
					const { blob, size, hash } = origin.staged;
					const mode = origin.mode;
					const same =
						before?.kind === "file" &&
						before.mode === mode &&
						hash !== undefined &&
						(await originalDigest(path, before)) === hash;
					next[path] = same ? before : { kind: "file", sha: blob, size, mode };
					if (!same) {
						changed.push(path);
						commit.puts.push({ path, blob, mode });
					}
					continue;
				}
				// An untouched file keeps its entry without a stat: stat on a lazy file loads its body, which would read
				// the whole workspace on every commit.
				if (untouched(path, full)) {
					next[path] = before;
					continue;
				}
				const stat = await fs.lstat(full);
				if (stat.isSymbolicLink) {
					const target = await fs.readlink(full);
					next[path] = { kind: "symlink", target };
					if (before?.kind !== "symlink" || before.target !== target) {
						changed.push(path);
						commit.links.push({ path, target });
					}
				} else if (stat.isDirectory) {
					next[path] = { kind: "dir" };
					// A workspace that keeps files only has its directories implied by its files' paths: a new one
					// isn't a change, but what it replaced (a file, a link) is removed.
					if (before?.kind !== "dir" && capabilities.directories) {
						changed.push(path);
						commit.dirs.push(path);
					} else if (before && before.kind !== "dir") {
						changed.push(path);
						commit.removes.push(path);
					}
				} else {
					const bytes = await fs.readFileBuffer(full);
					const sha = sha256(bytes);
					const mode = stat.mode & 0o777;
					const same = before?.kind === "file" && before.mode === mode && (await originalDigest(path, before)) === sha;
					if (!same) {
						const staged = JSON.parse(await ops.op_kt_stage(path, bytes));
						changed.push(path);
						commit.puts.push({ path, blob: staged.blob, mode });
					}
					next[path] = { kind: "file", sha, size: bytes.byteLength, mode };
				}
			}
			for (const path of Object.keys(manifest)) {
				if (path in next) continue;
				changed.push(path);
				commit.removes.push(path);
			}
			// The files as the workspace holds them after a commit: the command's manifest with the catch-up applied
			// (the workspace's own file ids, and anything the host changed too), and with the removals sent if they
			// were taken.
			const holds = (catchUp, removals) => {
				const kept = { ...manifest };
				for (const path of [...removals, ...catchUp.removed]) delete kept[path];
				for (const [path, node] of Object.entries(catchUp.changed)) kept[path] = entryOf(node);
				const paths = new Set([...Object.keys(catchUp.changed), ...catchUp.removed]);
				for (const path of removals) if (path in manifest) paths.add(path);
				return { manifest: kept, changed: [...paths] };
			};
			let saved = { manifest, changed: [] };
			let unsaved;
			if (changed.length > 0) {
				const reply = JSON.parse(await ops.op_kt_commit(JSON.stringify(commit)));
				if (reply.status === "committed") saved = holds(reply.catchUp, commit.removes);
				else {
					unsaved = { status: reply.status, error: reply.error };
					// Unknown: the workspace holds what its catch-up says, which may or may not have the changes.
					// Failed: nothing of this command's was saved, but the workspace may have changed since its base
					// (the host's own writes). Fenced: no catch-up.
					if (reply.catchUp) saved = holds(reply.catchUp, []);
				}
			}
			return { ...saved, commit: unsaved, lazyReads };
		}

		return { fs, childIndex, unchanged, finish, adoptStaged };
	}

	return { open };
}
