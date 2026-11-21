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

/** Wrap a just-bash filesystem so writes over existing paths are recorded (as sandbox.ts does), and tell `written`. */
function track(fs, dirty, written = () => {}) {
	const mark = (path) => {
		const full = normalise("/", path);
		dirty.add(full);
		written(full);
	};
	const wrap = (name, pick) => {
		const original = fs[name].bind(fs);
		fs[name] = (...args) => {
			for (const path of pick(args)) mark(path);
			return original(...args);
		};
	};
	const first = (args) => [String(args[0])];
	const second = (args) => [String(args[1])];
	// rm too: a file removed and made again as a directory (by the shell, or replayed from a node/python run) is
	// then looked at afresh instead of keeping its old file entry.
	for (const name of ["writeFile", "appendFile", "chmod", "utimes", "rm"]) wrap(name, first);
	for (const name of ["cp", "mv", "symlink", "link"]) wrap(name, second);
	return fs;
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
		/** Host commands' staged outputs still at their paths, by path (see adoptStaged). */
		const stagedOutputs = new Map();
		// What the workspace keeps, and whether its file ids are the bytes' SHA-256 (Kantel's are): otherwise an id
		// says nothing about the bytes, and an unchanged file is told by the digest of what the command read.
		const capabilities = JSON.parse(ops.op_kt_workspace_capabilities());
		const originals = new Map();
		/** A file's body, read from the workspace when the command first reads it. */
		const lazy = (path, file) => async () => {
			lazyReads++;
			let bytes;
			try {
				bytes = await ops.op_kt_blob_read(file);
			} catch (error) {
				throw readError(error);
			}
			if (!capabilities.contentAddressed) originals.set(path, sha256(bytes));
			return bytes;
		};
		const files = {};
		for (const [path, entry] of Object.entries(manifest)) {
			if (entry.kind === "file") files[abs(path)] = lazy(path, entry.sha);
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
		await fs.mkdir(ROOT, { recursive: true });
		for (const [path, entry] of Object.entries(manifest)) {
			if (entry.kind === "dir") await fs.mkdir(abs(path), { recursive: true });
			else if (entry.kind === "symlink") await fs.symlink(entry.target, abs(path));
			else if (entry.mode !== 0o644) await fs.chmod(abs(path), entry.mode);
		}
		const dirty = new Set();
		track(fs, dirty, (path) => {
			const r = rel(path);
			if (r !== undefined) stagedOutputs.delete(r);
		});
		const isDirty = (path) => {
			for (const mark of dirty) if (path === mark || path.startsWith(`${mark}/`)) return true;
			return false;
		};

		/** The workspace as a node/python run sees it: untouched files by id (read only if the run reads them), files
		 * this command changed inline in `chunks`. */
		async function childIndex(chunks) {
			const index = {};
			for (const full of fs.getAllPaths()) {
				const path = rel(full);
				if (path === undefined || path === "") continue;
				const before = manifest[path];
				const staged = stagedOutputs.get(path);
				if (staged) {
					index[path] = { kind: "file", sha: staged.blob, size: staged.size, mode: staged.mode };
					continue;
				}
				if (before?.kind === "file" && !isDirty(full)) {
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
		 * it, and named by the commit as it is. A later write to the path makes it an ordinary change again. */
		function adoptStaged(path, staged, mode) {
			const full = abs(path);
			fs.writeFileLazy(full, lazy(path, staged.blob), { mode: mode ?? 0o644 });
			stagedOutputs.set(path, { blob: staged.blob, size: staged.size, mode: mode ?? 0o644 });
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
				// A host command's staged output, still there: committed by its blob, without reading it.
				const staged = stagedOutputs.get(path);
				if (staged) {
					next[path] = { kind: "file", sha: staged.blob, size: staged.size, mode: staged.mode };
					changed.push(path);
					commit.puts.push({ path, blob: staged.blob, mode: staged.mode });
					continue;
				}
				// An untouched file keeps its entry without a stat: stat on a lazy file loads its body, which would
				// read the whole workspace on every commit.
				if (before?.kind === "file" && !isDirty(full)) {
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
