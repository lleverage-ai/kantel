// node:fs over the sandbox's files, in memory for the run. A file's body is read from the host (op_kt_file) only when
// the script reads it; what the script writes, makes and removes under /workspace goes back into the manifest when
// the run ends. Anything outside /workspace (such as /tmp) lasts only for the run.
import { Buffer } from "../common/buffer.js";

export const ROOT = "/workspace";
const MODULE_EXTENSIONS = /\.(m|c)?(j|t)sx?$|\.json$/;

export function createFs(ops, state, path) {
	const fsError = (code, syscall, p, text) =>
		Object.assign(new Error(`${code}: ${text}, ${syscall} '${p}'`), {
			code,
			syscall,
			path: p,
			errno: ERRNO[code] ?? -1,
		});
	const ENOENT = (s, p) => fsError("ENOENT", s, p, "no such file or directory");
	const toPath = (p) => {
		if (p instanceof URL) return p.pathname;
		if (p instanceof Uint8Array) return new TextDecoder().decode(p);
		if (typeof p !== "string") throw new TypeError(`The "path" argument must be of type string. Received ${typeof p}`);
		return p;
	};
	const abs = (p) => path.resolve(toPath(p));

	function entry(p, syscall) {
		const e = state.files.get(p);
		if (!e) throw ENOENT(syscall, p);
		return e;
	}
	/**
	 * The entry a path names, following symlinks in every component, as realpath does: a symlink's target is walked
	 * component by component too (from the link's directory, or from / when absolute), so a target that itself passes
	 * through a directory symlink resolves. One hop limit covers the whole walk. A final symlink is followed only with
	 * followLast.
	 */
	function resolve(p, syscall, followLast = true) {
		let pending = p.split("/").filter(Boolean);
		let cur = "/";
		let hops = 0;
		while (pending.length > 0) {
			const name = pending.shift();
			if (name === ".") continue;
			if (name === "..") {
				cur = path.dirname(cur);
				continue;
			}
			const next = cur === "/" ? `/${name}` : `${cur}/${name}`;
			const e = state.files.get(next);
			if (!e) throw ENOENT(syscall, p);
			if (e.kind === "symlink" && (followLast || pending.length > 0)) {
				if (++hops > 40) throw fsError("ELOOP", syscall, p, "too many symbolic links encountered");
				pending = [...e.target.split("/").filter(Boolean), ...pending];
				if (e.target.startsWith("/")) cur = "/";
				continue;
			}
			if (pending.length > 0 && e.kind !== "dir") throw fsError("ENOTDIR", syscall, p, "not a directory");
			cur = next;
		}
		return [cur, state.files.get(cur) ?? { kind: "dir" }];
	}
	/**
	 * The key of the entry a path names itself, a final symlink not followed (what unlink, lstat, readlink, rename and
	 * symlink act on): its parent directory resolved through any symlinks, so a path through a directory symlink
	 * names the same entry as the real path does. Throws if the parent doesn't exist or isn't a directory.
	 */
	function locate(ap, syscall) {
		if (ap === "/") return "/";
		const [dir, e] = resolve(path.dirname(ap), syscall);
		if (e.kind !== "dir") throw fsError("ENOTDIR", syscall, ap, "not a directory");
		return dir === "/" ? `/${path.basename(ap)}` : `${dir}/${path.basename(ap)}`;
	}
	/** A located key, then through any final symlinks (to a target that may not exist yet): where a write lands. */
	function followLinks(key, syscall) {
		for (let hops = 0; state.files.get(key)?.kind === "symlink"; hops++) {
			if (hops > 40) throw fsError("ELOOP", syscall, key, "too many symbolic links encountered");
			key = locate(path.resolve(path.dirname(key), state.files.get(key).target), syscall);
		}
		return key;
	}
	const exists = (ap) => {
		try {
			resolve(ap, "access");
			return true;
		} catch {
			return false;
		}
	};
	function contents(_p, e) {
		if (e.data === undefined) {
			e.data = ops.op_kt_file(e.ref);
			state.read += e.data.byteLength;
		}
		return e.data;
	}
	const touched = (p) => {
		state.changed.add(p);
		const e = state.files.get(p);
		if (MODULE_EXTENSIONS.test(p)) {
			if (e?.kind === "file") ops.op_kt_overlay(p, e.data, true);
			else ops.op_kt_overlay(p, new Uint8Array(0), false);
		}
	};
	function bytesFrom(data, options) {
		const encoding = typeof options === "string" ? options : options?.encoding;
		if (typeof data === "string") return Buffer.from(data, encoding ?? "utf8");
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
		if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
		throw new TypeError(
			'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.',
		);
	}
	const encodingOf = (options) => (typeof options === "string" ? options : options?.encoding);
	const out = (bytes, options) => {
		const b = new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const enc = encodingOf(options);
		return enc && enc !== "buffer" ? b.toString(enc) : b;
	};

	class Stats {
		#kind;
		constructor(e) {
			this.#kind = e.kind;
			this.dev = 1;
			this.ino = 0;
			this.nlink = 1;
			this.uid = 1000;
			this.gid = 1000;
			this.rdev = 0;
			this.blksize = 4096;
			this.size =
				e.kind === "file" ? (e.data ? e.data.byteLength : e.size) : e.kind === "symlink" ? e.target.length : 4096;
			this.blocks = Math.ceil(this.size / 512);
			this.mode =
				(e.kind === "dir" ? 0o040000 : e.kind === "symlink" ? 0o120000 : 0o100000) |
				(e.mode ?? (e.kind === "dir" ? 0o755 : 0o644));
			this.mtimeMs = this.atimeMs = this.ctimeMs = this.birthtimeMs = e.mtimeMs ?? state.started;
			this.mtime = this.atime = this.ctime = this.birthtime = new Date(this.mtimeMs);
		}
		isFile() {
			return this.#kind === "file";
		}
		isDirectory() {
			return this.#kind === "dir";
		}
		isSymbolicLink() {
			return this.#kind === "symlink";
		}
		isFIFO() {
			return false;
		}
		isSocket() {
			return false;
		}
		isBlockDevice() {
			return false;
		}
		isCharacterDevice() {
			return false;
		}
	}
	class Dirent {
		constructor(name, dir, e) {
			this.name = name;
			this.parentPath = dir;
			this.path = dir;
			this.kind = e.kind;
		}
		isFile() {
			return this.kind === "file";
		}
		isDirectory() {
			return this.kind === "dir";
		}
		isSymbolicLink() {
			return this.kind === "symlink";
		}
	}

	const STDIN = new Set(["/dev/stdin", "/proc/self/fd/0"]);
	function readFileSync(p, options) {
		if (p === 0 || STDIN.has(p)) return out(state.stdin(), options);
		if (typeof p === "number") return out(fds.get(p)?.read() ?? new Uint8Array(0), options);
		const [rp, e] = resolve(abs(p), "open");
		if (e.kind === "dir") throw fsError("EISDIR", "read", rp, "illegal operation on a directory");
		return out(contents(rp, e), options);
	}
	function writeFileSync(p, data, options) {
		if (typeof p === "number") return writeSync(p, data);
		if (p === "/dev/stdout" || p === "/dev/stderr")
			return state.write(p.endsWith("out") ? "stdout" : "stderr", bytesFrom(data, options));
		const named = locate(abs(p), "open");
		const flag = typeof options === "object" ? options?.flag : undefined;
		if (flag === "wx" && state.files.has(named)) throw fsError("EEXIST", "open", named, "file already exists");
		const ap = followLinks(named, "open");
		const prev = state.files.get(ap);
		if (prev?.kind === "dir") throw fsError("EISDIR", "open", ap, "illegal operation on a directory");
		const bytes = bytesFrom(data, options);
		if (flag === "a" && prev) return appendFileSync(ap, bytes);
		state.files.set(ap, {
			kind: "file",
			data: bytes,
			mode: prev?.mode ?? (options?.mode ?? 0o666) & 0o777 & ~0o022,
			mtimeMs: Date.now(),
		});
		touched(ap);
	}
	function appendFileSync(p, data, options) {
		const ap = followLinks(locate(abs(p), "open"), "open");
		const prev = state.files.get(ap);
		if (prev?.kind === "dir") throw fsError("EISDIR", "open", ap, "illegal operation on a directory");
		const old = prev ? contents(ap, prev) : new Uint8Array(0);
		const add = bytesFrom(data, options);
		const joined = new Uint8Array(old.length + add.length);
		joined.set(old);
		joined.set(add, old.length);
		writeFileSync(ap, joined);
	}
	function readdirSync(p, options) {
		const [dp, e] = resolve(abs(p), "scandir");
		if (e.kind !== "dir") throw fsError("ENOTDIR", "scandir", dp, "not a directory");
		const prefix = dp === "/" ? "/" : `${dp}/`;
		const names = [];
		const walk = options?.recursive === true;
		for (const k of state.files.keys())
			if (k !== dp && k.startsWith(prefix) && (walk || !k.slice(prefix.length).includes("/")))
				names.push(k.slice(prefix.length));
		names.sort();
		if (!options?.withFileTypes) return encodingOf(options) === "buffer" ? names.map((n) => Buffer.from(n)) : names;
		return names.map((name) => {
			const full = prefix + name;
			return new Dirent(path.basename(full), path.dirname(full), state.files.get(full));
		});
	}
	function mkdirSync(p, options) {
		const ap = abs(p);
		const recursive = typeof options === "object" && options?.recursive === true;
		if (!recursive) {
			const key = locate(ap, "mkdir");
			if (state.files.has(key)) throw fsError("EEXIST", "mkdir", ap, "file already exists");
			state.files.set(key, { kind: "dir", mtimeMs: Date.now() });
			touched(key);
			return undefined;
		}
		// Each component through any symlink to a directory, so a directory made below one lands at its real path.
		let first;
		let cur = "/";
		const parts = ap.split("/").filter(Boolean);
		for (let i = 0; i < parts.length; i++) {
			const next = cur === "/" ? `/${parts[i]}` : `${cur}/${parts[i]}`;
			if (!state.files.has(next)) {
				state.files.set(next, { kind: "dir", mtimeMs: Date.now() });
				touched(next);
				first ??= next;
				cur = next;
				continue;
			}
			const [real, e] = resolve(next, "mkdir");
			if (e.kind !== "dir")
				throw i === parts.length - 1
					? fsError("EEXIST", "mkdir", ap, "file already exists")
					: fsError("ENOTDIR", "mkdir", ap, "not a directory");
			cur = real;
		}
		return first;
	}
	function remove(ap) {
		for (const k of [...state.files.keys()])
			if (k === ap || k.startsWith(`${ap}/`)) {
				state.files.delete(k);
				state.changed.delete(k);
				if (MODULE_EXTENSIONS.test(k)) ops.op_kt_overlay(k, new Uint8Array(0), false);
			}
	}
	function rmSync(p, options) {
		let ap;
		try {
			ap = locate(abs(p), "rm");
		} catch (error) {
			if (options?.force && error.code === "ENOENT") return;
			throw error;
		}
		const e = state.files.get(ap);
		if (!e) {
			if (options?.force) return;
			throw ENOENT("rm", ap);
		}
		if (e.kind === "dir" && !options?.recursive && readdirSync(ap).length)
			throw fsError("ERR_FS_EISDIR", "rm", ap, "Path is a directory");
		remove(ap);
	}
	function renameSync(from, to) {
		const a = locate(abs(from), "rename");
		const b = locate(abs(to), "rename");
		entry(a, "rename");
		if (a === b) return;
		const moved = [];
		for (const k of state.files.keys()) if (k === a || k.startsWith(`${a}/`)) moved.push(k);
		const entries = moved.map((k) => {
			const v = state.files.get(k);
			if (v.kind === "file") contents(k, v);
			return [b + k.slice(a.length), v];
		});
		remove(b);
		remove(a);
		for (const [k, v] of entries) {
			state.files.set(k, v);
			touched(k);
		}
	}
	const fds = new Map();
	let nextFd = 3;
	function openSync(p, flags = "r", mode) {
		const ap = abs(p);
		const f = String(flags);
		if (f.startsWith("w")) writeFileSync(ap, "", { flag: f.includes("x") ? "wx" : "w", mode });
		else if (f.startsWith("a") && !exists(ap)) writeFileSync(ap, "");
		const [rp, e] = resolve(ap, "open");
		if (e.kind === "dir" && f !== "r") throw fsError("EISDIR", "open", rp, "illegal operation on a directory");
		const fd = nextFd++;
		let position = f.startsWith("a") ? contents(rp, e).length : 0;
		fds.set(fd, {
			path: rp,
			read() {
				return contents(rp, state.files.get(rp));
			},
			readInto(buffer, offset, length, pos) {
				const data = contents(rp, state.files.get(rp));
				const at = pos ?? position;
				const n = Math.max(0, Math.min(length, data.length - at));
				buffer.set(data.subarray(at, at + n), offset);
				if (pos == null) position += n;
				return n;
			},
			write(bytes, pos) {
				const e2 = state.files.get(rp);
				const data = contents(rp, e2);
				const at = pos ?? position;
				const next = new Uint8Array(Math.max(data.length, at + bytes.length));
				next.set(data);
				next.set(bytes, at);
				e2.data = next;
				e2.mtimeMs = Date.now();
				touched(rp);
				if (pos == null) position = at + bytes.length;
				return bytes.length;
			},
		});
		return fd;
	}
	function writeSync(fd, data, a, b, c) {
		if (fd === 1 || fd === 2) {
			const bytes = typeof data === "string" ? Buffer.from(data, typeof b === "string" ? b : "utf8") : bytesFrom(data);
			state.write(fd === 1 ? "stdout" : "stderr", bytes);
			return bytes.length;
		}
		const f = fds.get(fd);
		if (!f) throw fsError("EBADF", "write", String(fd), "bad file descriptor");
		if (typeof data === "string")
			return f.write(Buffer.from(data, typeof b === "string" ? b : "utf8"), typeof a === "number" ? a : null);
		const view = bytesFrom(data).subarray(a ?? 0, (a ?? 0) + (b ?? data.byteLength));
		return f.write(view, c ?? null);
	}
	function readSync(fd, buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
		if (typeof offset === "object" && offset !== null)
			({ offset = 0, length = buffer.byteLength, position = null } = offset);
		if (fd === 0) {
			const data = state.stdin();
			const n = Math.max(0, Math.min(length, data.length - state.stdinPos));
			new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(
				data.subarray(state.stdinPos, state.stdinPos + n),
				offset,
			);
			state.stdinPos += n;
			return n;
		}
		const f = fds.get(fd);
		if (!f) throw fsError("EBADF", "read", String(fd), "bad file descriptor");
		return f.readInto(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), offset, length, position);
	}

	const fs = {
		constants: {
			F_OK: 0,
			R_OK: 4,
			W_OK: 2,
			X_OK: 1,
			O_RDONLY: 0,
			O_WRONLY: 1,
			O_RDWR: 2,
			O_CREAT: 64,
			O_EXCL: 128,
			O_TRUNC: 512,
			O_APPEND: 1024,
			COPYFILE_EXCL: 1,
		},
		existsSync(p) {
			return exists(abs(p));
		},
		accessSync(p) {
			resolve(abs(p), "access");
		},
		readFileSync,
		writeFileSync,
		appendFileSync,
		readdirSync,
		mkdirSync,
		rmSync,
		rmdirSync(p, options) {
			const ap = locate(abs(p), "rmdir");
			const e = entry(ap, "rmdir");
			if (e.kind !== "dir") throw fsError("ENOTDIR", "rmdir", ap, "not a directory");
			if (!options?.recursive && readdirSync(ap).length) throw fsError("ENOTEMPTY", "rmdir", ap, "directory not empty");
			remove(ap);
		},
		unlinkSync(p) {
			const ap = locate(abs(p), "unlink");
			const e = entry(ap, "unlink");
			if (e.kind === "dir") throw fsError("EISDIR", "unlink", ap, "illegal operation on a directory");
			remove(ap);
		},
		renameSync,
		copyFileSync(from, to, mode) {
			if (mode & 1 && fs.existsSync(to)) throw fsError("EEXIST", "copyfile", abs(to), "file already exists");
			writeFileSync(to, readFileSync(from));
		},
		cpSync(from, to, options) {
			const a = abs(from);
			const [, e] = resolve(a, "cp");
			if (e.kind !== "dir") return fs.copyFileSync(a, to);
			if (!options?.recursive)
				throw fsError("ERR_FS_EISDIR", "cp", a, "Recursive option is required to copy a directory");
			mkdirSync(to, { recursive: true });
			for (const name of readdirSync(a)) fs.cpSync(`${a}/${name}`, `${abs(to)}/${name}`, options);
		},
		statSync(p, options) {
			try {
				return new Stats(resolve(abs(p), "stat")[1]);
			} catch (error) {
				if (options?.throwIfNoEntry === false && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
		lstatSync(p, options) {
			try {
				const ap = abs(p);
				return new Stats(ap === "/" ? { kind: "dir" } : entry(locate(ap, "lstat"), "lstat"));
			} catch (error) {
				if (options?.throwIfNoEntry === false && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
		chmodSync(p, mode) {
			const [rp, e] = resolve(abs(p), "chmod");
			e.mode = (typeof mode === "string" ? Number.parseInt(mode, 8) : mode) & 0o777;
			touched(rp);
		},
		utimesSync(p, _atime, mtime) {
			const [, e] = resolve(abs(p), "utime");
			e.mtimeMs = typeof mtime === "number" ? mtime * 1000 : new Date(mtime).getTime();
		},
		realpathSync(p) {
			return resolve(abs(p), "realpath")[0];
		},
		symlinkSync(target, p) {
			const ap = locate(abs(p), "symlink");
			if (state.files.has(ap)) throw fsError("EEXIST", "symlink", ap, "file already exists");
			state.files.set(ap, { kind: "symlink", target: toPath(target) });
			touched(ap);
		},
		readlinkSync(p) {
			const ap = locate(abs(p), "readlink");
			const e = entry(ap, "readlink");
			if (e.kind !== "symlink") throw fsError("EINVAL", "readlink", ap, "invalid argument");
			return e.target;
		},
		mkdtempSync(prefix) {
			const dir = `${abs(prefix)}${Math.random().toString(36).slice(2, 8)}`;
			mkdirSync(dir, { recursive: true });
			return dir;
		},
		openSync,
		closeSync(fd) {
			fds.delete(fd);
		},
		readSync,
		writeSync,
		fstatSync(fd) {
			const f = fds.get(fd);
			if (!f) throw fsError("EBADF", "fstat", String(fd), "bad file descriptor");
			return new Stats(state.files.get(f.path));
		},
		fsyncSync() {},
		truncateSync(p, len = 0) {
			const [rp, e] = resolve(abs(p), "open");
			const data = contents(rp, e);
			const next = new Uint8Array(len);
			next.set(data.subarray(0, len));
			e.data = next;
			touched(rp);
		},
		watch() {
			throw fsError("ENOSYS", "watch", "", "not available in an isolate");
		},
	};
	fs.realpathSync.native = fs.realpathSync;

	// Streams: whole-file reads and writes, enough for pipe() and the 'data'/'end'/'finish' events scripts use.
	fs.createReadStream = (p, options) => {
		const stream = new state.Readable();
		queueMicrotask(() => {
			try {
				let data = readFileSync(p);
				const start = options?.start ?? 0;
				const end = options?.end !== undefined ? options.end + 1 : data.length;
				data = data.subarray(start, end);
				const enc = encodingOf(options);
				stream.push(enc ? data.toString(enc) : data);
				stream.push(null);
			} catch (error) {
				stream.destroy(error);
			}
		});
		return stream;
	};
	fs.createWriteStream = (p, options) => {
		const parts = [];
		const flags = options?.flags ?? "w";
		if (flags.startsWith("w")) writeFileSync(p, "");
		const stream = new state.Writable({
			write(chunk, enc, callback) {
				parts.push(typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk);
				appendFileSync(p, parts.pop());
				callback();
			},
		});
		stream.path = abs(p);
		return stream;
	};

	// Callback and promise forms of every sync function.
	const promises = {};
	for (const [name, fn] of Object.entries(fs)) {
		if (!name.endsWith("Sync") || typeof fn !== "function") continue;
		const base = name.slice(0, -4);
		promises[base] = (...args) => {
			try {
				return Promise.resolve(fn(...args));
			} catch (error) {
				return Promise.reject(error);
			}
		};
		if (base === "exists") {
			fs.exists = (p, callback) => queueMicrotask(() => callback(fs.existsSync(p)));
			continue;
		}
		fs[base] = (...args) => {
			const callback = typeof args[args.length - 1] === "function" ? args.pop() : () => {};
			let result;
			let error = null;
			try {
				result = fn(...args);
			} catch (e) {
				error = e;
			}
			queueMicrotask(() => callback(error, result));
		};
	}
	delete promises.exists;
	promises.constants = fs.constants;
	promises.open = async (p, flags, mode) => {
		const fd = openSync(p, flags, mode);
		return {
			fd,
			readFile: (o) => Promise.resolve(out(fds.get(fd).read(), o)),
			writeFile: (d, o) => Promise.resolve(writeFileSync(fds.get(fd).path, d, o)),
			write: (d) => Promise.resolve({ bytesWritten: writeSync(fd, d) }),
			read: (buffer, offset, length, position) =>
				Promise.resolve({ bytesRead: readSync(fd, buffer, offset, length, position), buffer }),
			stat: () => Promise.resolve(fs.fstatSync(fd)),
			close: () => Promise.resolve(fds.delete(fd)),
		};
	};
	fs.promises = promises;
	fs.Stats = Stats;
	fs.Dirent = Dirent;
	return fs;
}

const ERRNO = {
	ENOENT: -2,
	EEXIST: -17,
	ENOTDIR: -20,
	EISDIR: -21,
	EINVAL: -22,
	ENOTEMPTY: -39,
	EBADF: -9,
	ELOOP: -40,
	ENOSYS: -38,
};
