// The sandbox isolate's shell: images/isolate-host/src/sandbox.ts on kantel-isolate's ops instead of workerd's
// bindings. just-bash runs each command over a lazy InMemoryFs built from the manifest the host sends: a file's body
// is read from STORE only when the command reads it, and the files the command changed are uploaded at the end and
// returned as the next manifest. `node` and `python` run in a fresh isolate each (op_kt_run), over the same files.
import { Bash, defineCommand, InMemoryFs } from "just-bash/browser";
import { budgetedCopy } from "../common/budget.js";
import { latin1 } from "../common/text.js";
import { Chunks, egressFetch, unpack } from "../common/web.js";
import { message, UNAVAILABLE } from "./unavailable.js";

const ROOT = "/workspace";
/** The most output one command may make (parity with sandbox.ts: zlib's 128 MiB output cap). */
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

const abs = (path) => (path === "" ? ROOT : `${ROOT}/${path}`);
const rel = (path) => (path === ROOT ? "" : path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : undefined);

function normalise(base, path) {
	const out = [];
	for (const part of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

/** Wrap a just-bash filesystem so writes over existing paths are recorded (as sandbox.ts does). */
function track(fs, dirty) {
	const mark = (path) => dirty.add(normalise("/", path));
	const wrap = (name, pick) => {
		const original = fs[name].bind(fs);
		fs[name] = (...args) => {
			for (const path of pick(args)) mark(path);
			return original(...args);
		};
	};
	const first = (args) => [String(args[0])];
	const second = (args) => [String(args[1])];
	for (const name of ["writeFile", "appendFile", "chmod", "utimes"]) wrap(name, first);
	for (const name of ["cp", "mv", "symlink", "link"]) wrap(name, second);
	return fs;
}

const fromLatin1 = (s) => {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
};

export function createShell(ops, log) {
	const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const sha256 = (bytes) => hex(ops.op_kt_digest("sha256", bytes));
	let nextRun = 1;

	async function exec(request) {
		const t0 = performance.now();
		let lazyReads = 0;
		const manifest = request.manifest ?? {};
		const files = {};
		for (const [path, entry] of Object.entries(manifest)) {
			if (entry.kind !== "file") continue;
			files[abs(path)] = async () => {
				lazyReads++;
				return budgetedCopy(await ops.op_kt_blob_read(entry.sha));
			};
		}
		const fs = new InMemoryFs(files);
		await fs.mkdir(ROOT, { recursive: true });
		for (const [path, entry] of Object.entries(manifest)) {
			if (entry.kind === "dir") await fs.mkdir(abs(path), { recursive: true });
			else if (entry.kind === "symlink") await fs.symlink(entry.target, abs(path));
			else if (entry.mode !== 0o644) await fs.chmod(abs(path), entry.mode);
		}
		const dirty = new Set();
		track(fs, dirty);
		const isDirty = (path) => {
			for (const mark of dirty) if (path === mark || path.startsWith(`${mark}/`)) return true;
			return false;
		};

		/** The first command that needed a microVM, and whether any child run was stopped (and why). */
		let needsMicrovm;
		let terminated;

		// node / python: the workspace as the child sees it (untouched files by digest, read by the child only if it
		// reads them; files this command changed, inline) and stdin; the child's writes come back here, so they reach
		// the manifest like any other command's.
		const child = (name) =>
			defineCommand(name, async (args, ctx) => {
				const chunks = new Chunks();
				const index = {};
				for (const full of fs.getAllPaths()) {
					const path = rel(full);
					if (path === undefined || path === "") continue;
					const before = manifest[path];
					if (before?.kind === "file" && !isDirty(full)) {
						index[path] = { kind: "file", sha: before.sha, size: before.size, mode: before.mode };
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
				const stdin = chunks.add(fromLatin1(String(ctx.stdin ?? "")));
				const env = ctx.exportedEnv ?? Object.fromEntries(ctx.env ?? []);
				const runId = nextRun++;
				const meta = { args, cwd: ctx.cwd, env, index, stdin, runId };
				const onAbort = () => ops.op_kt_cancel_run(runId);
				ctx.signal?.addEventListener?.("abort", onAbort, { once: true });
				let raw;
				try {
					raw = await ops.op_kt_run(name, JSON.stringify(meta), chunks.bytes());
				} finally {
					ctx.signal?.removeEventListener?.("abort", onAbort);
				}
				const { meta: result, data } = unpack(raw);
				const slice = (at) => data.subarray(at[0], at[0] + at[1]);
				for (const path of result.removes ?? []) await fs.rm(abs(path), { recursive: true, force: true });
				for (const path of result.mkdirs ?? []) await fs.mkdir(abs(path), { recursive: true });
				for (const w of result.writes ?? []) {
					const full = abs(w.path);
					await fs.mkdir(full.slice(0, full.lastIndexOf("/")) || "/", { recursive: true });
					await fs.writeFile(full, slice(w.data).slice());
					if (w.mode !== undefined && w.mode !== 0o644) await fs.chmod(full, w.mode);
				}
				for (const s of result.symlinks ?? []) {
					const full = abs(s.path);
					await fs.rm(full, { force: true });
					await fs.mkdir(full.slice(0, full.lastIndexOf("/")) || "/", { recursive: true });
					await fs.symlink(s.target, full);
				}
				if (result.needsMicrovm && !needsMicrovm) needsMicrovm = result.needsMicrovm;
				if (result.terminated) terminated = result.terminated;
				return {
					stdout: latin1(slice(result.stdout)),
					stdoutKind: "bytes",
					stderr: new TextDecoder().decode(slice(result.stderr)),
					exitCode: result.exitCode,
				};
			});

		const unavailable = UNAVAILABLE.map(([name, reason]) =>
			defineCommand(name, async () => {
				needsMicrovm ??= { command: name, reason: `${reason}.` };
				return { stdout: "", stderr: message(name), exitCode: 127 };
			}),
		);
		const bash = new Bash({
			fs,
			cwd: normalise(ROOT, request.cwd ?? "."),
			env: { HOME: ROOT, ...request.env },
			customCommands: [...unavailable, child("node"), child("python"), child("python3")],
			executionLimits: { maxOutputSize: MAX_OUTPUT_BYTES },
			// The host's egress proxy decides what may leave; curl and wget get a plain fetch with no allow-list of
			// their own (as sandbox.ts does with workerd's globalOutbound).
			fetch: (url, options = {}) => egressFetch(url, options),
		});
		const t1 = performance.now();
		const result = await bash.exec(request.command);
		const t2 = performance.now();

		const next = {};
		const changed = [];
		for (const full of fs.getAllPaths()) {
			const path = rel(full);
			if (path === undefined || path === "") continue;
			const before = manifest[path];
			// An untouched file keeps its entry without a stat: stat on a lazy file loads its body, which would read
			// the whole workspace on every commit.
			if (before?.kind === "file" && !isDirty(full)) {
				next[path] = before;
				continue;
			}
			const stat = await fs.lstat(full);
			if (stat.isSymbolicLink) {
				const target = await fs.readlink(full);
				next[path] = { kind: "symlink", target };
				if (before?.kind !== "symlink" || before.target !== target) changed.push(path);
			} else if (stat.isDirectory) {
				next[path] = { kind: "dir" };
				if (before?.kind !== "dir") changed.push(path);
			} else {
				const bytes = await fs.readFileBuffer(full);
				const sha = sha256(bytes);
				const mode = stat.mode & 0o777;
				if (before?.kind !== "file" || before.sha !== sha || before.mode !== mode) {
					await ops.op_kt_blob_put(bytes);
					changed.push(path);
				}
				next[path] = { kind: "file", sha, size: bytes.byteLength, mode };
			}
		}
		for (const path of Object.keys(manifest)) if (!(path in next)) changed.push(path);
		const t3 = performance.now();
		const response = {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			manifest: next,
			changed,
			timings: { fsMs: t1 - t0, execMs: t2 - t1, commitMs: t3 - t2, lazyReads },
		};
		// Only when the command failed: one that handled the missing program itself (`git --version || true`) ran.
		if (needsMicrovm && result.exitCode !== 0) response.needsMicrovm = needsMicrovm;
		if (terminated) response.terminated = terminated;
		if (log) log(1, `exec ${JSON.stringify(request.command).slice(0, 200)} -> ${result.exitCode}`);
		return response;
	}

	return {
		exec: async (json) => JSON.stringify(await exec(JSON.parse(json))),
	};
}
