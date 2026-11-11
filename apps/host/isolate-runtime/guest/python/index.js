// The `python` command's runtime: Pyodide (pinned in build-assets.sh), restored from a memory snapshot in a fresh
// isolate per run. boot() loads it from --assets (the module loader allows nothing else); run() puts the sandbox's
// files under /workspace, lazily (a file's body is read from the host only when Python opens it), runs the script
// and returns what it printed and what it changed under /workspace.
import { base64, Chunks, egressFetch, pack } from "../common/web.js";

const ROOT = "/workspace";
const MAX_OUTPUT = 16 * 1024 * 1024;

const HARNESS = `
import sys, os, traceback, ast, inspect, runpy
async def __kt_main(code, filename, argv, env, cwd, module):
    sys.argv = list(argv)
    os.environ.clear()
    os.environ.update(dict(env))
    try:
        os.chdir(cwd)
    except Exception:
        os.chdir("/workspace")
    if "" not in sys.path and filename in ("<string>", "<stdin>"):
        sys.path.insert(0, "")
    elif filename not in ("<string>", "<stdin>"):
        sys.path.insert(0, os.path.dirname(os.path.abspath(filename)))
    try:
        if module:
            runpy.run_module(module, run_name="__main__", alter_sys=True)
        else:
            g = {"__name__": "__main__", "__file__": filename, "__builtins__": __builtins__}
            co = compile(code, filename, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            r = eval(co, g)
            if inspect.isawaitable(r):
                await r
        return 0
    except SystemExit as e:
        c = e.code
        if c is None:
            return 0
        if isinstance(c, int):
            return c
        print(c, file=sys.stderr)
        return 1
    except BaseException:
        traceback.print_exc()
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
`;

export function createPython(ops, lockdown = () => {}) {
	const core = globalThis.Deno.core;
	const td = new TextDecoder();
	const g = globalThis;
	// Pyodide's "shell" environment (read and load defined): files come from --assets through op_kt_read_asset.
	g.read = (p) => core.decode(ops.op_kt_read_asset(String(p)));
	g.readbuffer = (p) => ops.op_kt_read_asset(String(p));
	g.load = (p) => {
		throw new Error(`load() isn't available: ${p}`);
	};
	// Emscripten's shell randomFill runs `head -c<N> /dev/urandom | base64`; answer that one, from the host's RNG.
	g.os = {
		system(cmd, args) {
			const m = /^head -c(\d+) \/dev\/urandom \| base64 --wrap=0$/.exec(args?.[1] ?? "");
			if (cmd !== "sh" || !m) throw new Error("os.system isn't available");
			const b = new Uint8Array(Number(m[1]));
			ops.op_kt_random(b);
			return base64(b);
		},
	};
	g.self = g;
	// pyfetch and `from js import fetch` go through the egress proxy like every other request.
	g.fetch = async (input, init = {}) => {
		const r = await egressFetch(input instanceof URL ? input.href : String(input?.url ?? input), init);
		const body = r.body;
		return {
			ok: r.status >= 200 && r.status < 300,
			status: r.status,
			statusText: r.statusText,
			url: r.url,
			redirected: r.redirected,
			type: "basic",
			headers: new Headers(r.headers),
			bodyUsed: false,
			clone() {
				return this;
			},
			arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
			bytes: async () => body.slice(),
			text: async () => td.decode(body),
			json: async () => JSON.parse(td.decode(body)),
		};
	};

	let py;
	const out = { stdout: [], stderr: [], bytes: 0, truncated: false };
	const writer = (stream) => ({
		isatty: false,
		write(buf) {
			if (out.bytes + buf.length <= MAX_OUTPUT) {
				out.bytes += buf.length;
				out[stream].push(buf.slice());
			} else out.truncated = true;
			return buf.length;
		},
	});

	async function boot(json) {
		const cfg = JSON.parse(json);
		const t0 = Date.now();
		const base = cfg.pyodide;
		// The host loaded pyodide.mjs and pyodide.asm.mjs as ES modules before this call (static imports pump the
		// module loader; a dynamic import() here wouldn't settle under the host's promise driver), leaving their
		// exports on globalThis.
		const loadPyodide = globalThis.__pyodideLoad;
		const createPyodideModule = globalThis.__pyodideModule;
		if (typeof loadPyodide !== "function") throw new Error("Pyodide modules were not loaded before boot");
		const config = {
			indexURL: `${base}/`,
			packageBaseUrl: `${base}/`,
			lockFileURL: `${base}/pyodide-lock.json`,
			createPyodideModule,
			checkAPIVersion: true,
			fullStdLib: false,
			stdout: () => {},
			stderr: () => {},
			env: { HOME: ROOT },
		};
		if (cfg.makeSnapshot) config._makeSnapshot = true;
		else config._loadSnapshot = new Uint8Array(ops.op_kt_python_snapshot());
		py = await loadPyodide(config);
		delete config._loadSnapshot;
		try {
			delete py._api.config._loadSnapshot;
		} catch {}
		if (cfg.makeSnapshot) {
			ops.op_kt_write_snapshot(py.makeMemorySnapshot());
			return Date.now() - t0;
		}
		py.runPython(HARNESS);
		py.setStdout(writer("stdout"));
		py.setStderr(writer("stderr"));
		py.FS.mkdirTree(ROOT);
		// Pyodide is up: end the wasm guard's boot mode before any user code runs, so a script can no longer make a
		// shared WebAssembly.Memory or have WebAssembly.compile() hand back the cached Pyodide module (finding H3).
		lockdown();
		return Date.now() - t0;
	}

	/** /workspace as Emscripten MEMFS nodes whose bodies are read from the host when first opened. */
	function mount(index) {
		const FS = py.FS;
		const MEMFS = FS.filesystems?.MEMFS ?? py._module.MEMFS;
		const fileNode = MEMFS.ops_table.file.node;
		const fileStream = MEMFS.ops_table.file.stream;
		const materialize = (node) => {
			const lazy = node.kt;
			if (!lazy) return;
			node.kt = undefined;
			const data = lazy.truncate ? new Uint8Array(0) : ops.op_kt_file(lazy.path);
			node.contents = data;
			node.usedBytes = data.length;
			node.node_ops = fileNode;
			node.stream_ops = fileStream;
			node.ktSha = lazy.sha;
		};
		const lazyNode = {
			getattr(node) {
				const attr = fileNode.getattr(node);
				if (node.kt) attr.size = node.kt.size;
				return attr;
			},
			setattr(node, attr) {
				if (node.kt && attr.size === 0) node.kt.truncate = true;
				if (node.kt && (attr.size !== undefined || attr.mode === undefined)) materialize(node);
				return fileNode.setattr(node, attr);
			},
		};
		const lazyStream = {};
		for (const [name, fn] of Object.entries(fileStream))
			lazyStream[name] = (stream, ...args) => {
				materialize(stream.node);
				return fn(stream, ...args);
			};
		lazyStream.open = (stream) => {
			materialize(stream.node);
			stream.stream_ops = fileStream;
		};
		const before = new Map();
		for (const [p, e] of Object.entries(index)) {
			const full = `${ROOT}/${p}`;
			const parent = full.slice(0, full.lastIndexOf("/"));
			if (e.kind === "dir") {
				FS.mkdirTree(full);
				before.set(p, { kind: "dir" });
			} else if (e.kind === "symlink") {
				FS.mkdirTree(parent);
				FS.symlink(e.target, full);
				before.set(p, { kind: "symlink", target: e.target });
			} else {
				FS.mkdirTree(parent);
				FS.writeFile(full, new Uint8Array(0));
				const node = FS.lookupPath(full).node;
				node.kt = { path: p, size: e.size ?? 0, sha: e.sha };
				node.node_ops = lazyNode;
				node.stream_ops = lazyStream;
				FS.chmod(full, e.mode ?? 0o644);
				before.set(p, { kind: "file", node, mode: e.mode ?? 0o644 });
			}
		}
		return before;
	}

	async function run(json) {
		const req = JSON.parse(json);
		// Wire sys.stdin to the command's stdin (echo x | python -c '...sys.stdin.read()'): hand Pyodide the bytes
		// once, then EOF.
		let stdinSent = false;
		py.setStdin({
			stdin: () => {
				if (stdinSent) return null;
				stdinSent = true;
				return td.decode(ops.op_kt_input());
			},
			autoEOF: true,
		});
		// Python's `random` state is baked into the memory snapshot, so every run (and every VM restored from one
		// template) would otherwise draw the same numbers. Reseed it from fresh OS entropy each run. os.urandom and
		// secrets already go through getRandomValues → the host RNG, so they need nothing. (Hash randomisation is
		// also snapshot-baked and can't be changed after start; a known gap, noted in the README.)
		const seedBytes = new Uint8Array(8);
		ops.op_kt_random(seedBytes);
		let seed = 0n;
		for (const b of seedBytes) seed = (seed << 8n) | BigInt(b);
		py.runPython(`import random as _r; _r.seed(${seed})`);
		const before = mount(req.index);
		const stdin = () => td.decode(ops.op_kt_input());
		let code;
		let filename = "<string>";
		let rest = [];
		let argv0 = "-c";
		let module = null;
		const args = req.args;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if ((a === "-c" || a === "-m") && i + 1 >= args.length) {
				out.stderr.push(
					core.encode(
						`Argument expected for the ${a} option\nusage: python [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry \`python -h' for more information.\n`,
					),
				);
				return finish(2, before);
			}
			if (a === "-c") {
				code = args[++i];
				rest = args.slice(i + 1);
				break;
			}
			if (a === "-m") {
				module = args[++i] ?? "";
				argv0 = module;
				rest = args.slice(i + 1);
				if (module === "pip" || module === "ensurepip" || module === "venv") {
					out.stderr.push(core.encode(`python: ${module} is not available in an isolate. Use a microVM.\n`));
					return finish(127, before, { command: "python", reason: "installing Python packages needs a microVM." });
				}
				code = "";
				break;
			}
			if (a === "-V" || a === "--version") {
				out.stdout.push(core.encode(`Python ${py.runPython("import sys; sys.version.split()[0]")}\n`));
				return finish(0, before);
			}
			if (a === "-") {
				code = stdin();
				filename = "<stdin>";
				argv0 = "-";
				rest = args.slice(i + 1);
				break;
			}
			if (a.startsWith("-")) continue;
			const full = a.startsWith("/") ? a : `${req.cwd || ROOT}/${a}`;
			try {
				code = td.decode(py.FS.readFile(full));
			} catch {
				out.stderr.push(core.encode(`python: can't open file '${full}': [Errno 2] No such file or directory\n`));
				return finish(2, before);
			}
			filename = a;
			argv0 = a;
			rest = args.slice(i + 1);
			break;
		}
		if (code === undefined) {
			code = stdin();
			filename = "<stdin>";
			argv0 = "";
		}
		// The packages that ship with Pyodide load from --assets when the code imports them (numpy at least).
		try {
			await py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: () => {} });
		} catch {}
		const main = py.globals.get("__kt_main");
		let exitCode;
		try {
			exitCode = await main(code, filename, py.toPy([argv0, ...rest]), py.toPy(req.env ?? {}), req.cwd || ROOT, module);
		} finally {
			main.destroy?.();
		}
		return finish(exitCode, before);
	}

	function finish(exitCode, before, needsMicrovm) {
		const FS = py.FS;
		const chunks = new Chunks();
		const writes = [];
		const mkdirs = [];
		const symlinks = [];
		const removes = [];
		const seen = new Set();
		const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
		const walk = (dir) => {
			for (const name of FS.readdir(dir)) {
				if (name === "." || name === "..") continue;
				const full = `${dir}/${name}`;
				const r = full.slice(ROOT.length + 1);
				const st = FS.lstat(full);
				const was = before.get(r);
				seen.add(r);
				if (FS.isDir(st.mode)) {
					if (was?.kind !== "dir") mkdirs.push(r);
					walk(full);
				} else if (FS.isLink(st.mode)) {
					const target = FS.readlink(full);
					if (was?.kind !== "symlink" || was.target !== target) symlinks.push({ path: r, target });
				} else if (FS.isFile(st.mode)) {
					const node = FS.lookupPath(full).node;
					const mode = st.mode & 0o777;
					// An unopened file at its own path, mode unchanged: as it was.
					if (was?.kind === "file" && was.node === node && node.kt && mode === was.mode) continue;
					const data = node.kt ? ops.op_kt_file(node.kt.path) : FS.readFile(full);
					const unchanged =
						was?.kind === "file" &&
						was.node === node &&
						mode === was.mode &&
						node.ktSha &&
						hex(ops.op_kt_digest("sha256", data)) === node.ktSha;
					// Emscripten makes files 0666; a new one gets the shell's umask (022), as one the shell makes would.
					if (!unchanged) writes.push({ path: r, data: chunks.add(data), mode: was ? mode : mode & ~0o022 });
				}
			}
		};
		walk(ROOT);
		for (const [p, was] of before)
			if (!seen.has(p) || (was.kind === "file" && !FS.isFile(FS.lstat(`${ROOT}/${p}`).mode))) removes.push(p);
		const join = (parts) => {
			const all = new Uint8Array(parts.reduce((n, b) => n + b.byteLength, 0));
			let at = 0;
			for (const b of parts) {
				all.set(b, at);
				at += b.byteLength;
			}
			return all;
		};
		if (out.truncated) out.stderr.push(core.encode("python: output over 16 MiB was dropped\n"));
		const meta = {
			exitCode,
			stdout: chunks.add(join(out.stdout)),
			stderr: chunks.add(join(out.stderr)),
			writes,
			mkdirs,
			symlinks,
			removes,
		};
		if (needsMicrovm) meta.needsMicrovm = needsMicrovm;
		ops.op_kt_set_result(pack(meta, chunks.list));
	}

	return { boot, run };
}
