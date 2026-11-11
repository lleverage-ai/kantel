// The `node` command's runtime: a Node-like surface (console, process, require and import of fs, path, util, os,
// events, buffer, crypto, stream, readline, url, assert, timers and the script's own files, ESM and CommonJS,
// TypeScript with types stripped, fetch and timers) over the sandbox's files. One fresh isolate per run, from the
// startup snapshot; the host calls start() and then, if it answers {esm}, loads that module; it runs the event loop
// and calls finish(). Full Node compatibility is out of scope: no npm installs, no child processes, no servers.

import { Buffer } from "../common/buffer.js";
import { bytesOf, Chunks, egressFetch, pack, refTimer, resetClock, scheduleTimer, timerActive } from "../common/web.js";
import { createFs, ROOT } from "./fs.js";
import {
	createAssert,
	createCrypto,
	createPath,
	createQuerystring,
	createReadline,
	createStreams,
	EventEmitter,
	StringDecoder,
} from "./lib.js";
import { createUtil, format, inspect } from "./util.js";

const MAX_OUTPUT = 16 * 1024 * 1024;
const NODE_VERSION = "v22.18.0";

class Exit extends Error {
	constructor(code) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

export function createNode(ops) {
	const g = globalThis;
	const td = new TextDecoder();
	const state = {
		cwd: ROOT,
		files: new Map(),
		changed: new Set(),
		original: new Map(),
		started: Date.now(),
		read: 0,
		exitCode: undefined,
		exited: false,
		packed: false,
		needsMicrovm: undefined,
		out: { stdout: [], stderr: [], bytes: 0, truncated: false },
		stdinBytes: undefined,
		stdinPos: 0,
		stdin: () => {
			state.stdinBytes ??= ops.op_kt_input();
			return state.stdinBytes;
		},
		write(stream, bytes) {
			if (state.out.bytes + bytes.byteLength > MAX_OUTPUT) {
				state.out.truncated = true;
				return;
			}
			state.out.bytes += bytes.byteLength;
			state.out[stream].push(bytes.slice());
		},
	};
	const path = createPath(() => state.cwd);
	const Stream = createStreams();
	state.Readable = Stream.Readable;
	state.Writable = Stream.Writable;
	const fs = createFs(ops, state, path);
	const util = createUtil();
	const encode = (chunk, enc) => (typeof chunk === "string" ? Buffer.from(chunk, enc ?? "utf8") : bytesOf(chunk));

	// ---- process ----
	const writer = (name, fd) => {
		const w = new Stream.Writable({
			write(chunk, enc, callback) {
				state.write(name, encode(chunk, enc));
				callback();
			},
		});
		Object.assign(w, { fd, isTTY: false, columns: 80, rows: 24, hasColors: () => false, getColorDepth: () => 1 });
		w.end = (chunk, enc, callback) => {
			if (chunk != null && typeof chunk !== "function") w.write(chunk, enc);
			const cb = [chunk, enc, callback].find((x) => typeof x === "function");
			queueMicrotask(() => cb?.());
			return w;
		};
		return w;
	};
	const stdin = new Stream.Readable();
	let stdinStarted = false;
	const startStdin = () => {
		if (stdinStarted) return;
		stdinStarted = true;
		const bytes = state.stdin();
		if (bytes.length) stdin.push(Buffer.from(bytes));
		stdin.push(null);
	};
	for (const method of ["on", "once", "resume", "read", "pipe"]) {
		const original = stdin[method].bind(stdin);
		stdin[method] = (...args) => {
			startStdin();
			return original(...args);
		};
	}
	const iterate = stdin[Symbol.asyncIterator].bind(stdin);
	stdin[Symbol.asyncIterator] = () => {
		startStdin();
		return iterate();
	};
	Object.assign(stdin, { fd: 0, isTTY: false, setRawMode: () => stdin });

	const process = new EventEmitter();
	const hrtime = (prev) => {
		const t = performance.now();
		const s = Math.floor(t / 1000);
		const ns = Math.floor((t % 1000) * 1e6);
		if (!prev) return [s, ns];
		let ds = s - prev[0];
		let dns = ns - prev[1];
		if (dns < 0) {
			ds -= 1;
			dns += 1e9;
		}
		return [ds, dns];
	};
	hrtime.bigint = () => BigInt(Math.floor(performance.now())) * 1000000n;
	Object.assign(process, {
		title: "node",
		argv: [],
		argv0: "node",
		execPath: "/usr/local/bin/node",
		execArgv: [],
		env: {},
		platform: "linux",
		arch: "x64",
		pid: 1,
		ppid: 0,
		version: NODE_VERSION,
		versions: { node: NODE_VERSION.slice(1), v8: "kantel-isolate", uv: "0", modules: "127" },
		release: { name: "node" },
		features: {},
		config: { variables: {} },
		exitCode: undefined,
		cwd: () => state.cwd,
		chdir(dir) {
			const p = path.resolve(dir);
			const st = fs.statSync(p);
			if (!st.isDirectory())
				throw Object.assign(new Error(`ENOTDIR: not a directory, chdir '${dir}'`), { code: "ENOTDIR" });
			state.cwd = p;
		},
		exit(code) {
			const c = code ?? process.exitCode ?? 0;
			state.exitCode = Number(c) | 0;
			state.exited = true;
			process.emit("exit", state.exitCode);
			// Pack the result now (stdout/stderr/files buffered so far), then tell the host to end the run at once:
			// op_kt_exit terminates this isolate, so pending timers and promises don't keep running (finding H8).
			finish(null);
			ops.op_kt_exit();
			throw new Exit(state.exitCode);
		},
		abort() {
			process.exit(134);
		},
		kill() {
			throw new Error("process.kill isn't available in an isolate's node");
		},
		nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
		hrtime,
		uptime: () => performance.now() / 1000,
		memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), {
			rss: () => 0,
		}),
		cpuUsage: () => ({ user: 0, system: 0 }),
		resourceUsage: () => ({}),
		emitWarning: (w) => state.write("stderr", Buffer.from(`(node) Warning: ${w?.message ?? w}\n`)),
		stdout: writer("stdout", 1),
		stderr: writer("stderr", 2),
		stdin,
		umask: () => 0o022,
		getuid: () => 1000,
		geteuid: () => 1000,
		getgid: () => 1000,
		getegid: () => 1000,
		getgroups: () => [1000],
		binding: () => {
			throw new Error("process.binding isn't available");
		},
	});

	const log = (...args) => process.stdout.write(`${format(...args)}\n`);
	const elog = (...args) => process.stderr.write(`${format(...args)}\n`);
	const counts = new Map();
	const timersByLabel = new Map();
	let groupIndent = "";
	const indented =
		(w) =>
		(...args) =>
			w(groupIndent ? format(...args).replace(/^/gm, groupIndent) : format(...args));
	const console = {
		log: indented(log),
		info: indented(log),
		debug: indented(log),
		error: indented(elog),
		warn: indented(elog),
		trace: (...args) => elog(`Trace: ${format(...args)}\n${new Error().stack?.split("\n").slice(2).join("\n") ?? ""}`),
		dir: (v, o) => log(inspect(v, o)),
		dirxml: (...a) => log(...a),
		table: (v) => log(inspect(v)),
		assert: (c, ...a) => c || elog(`Assertion failed${a.length ? `: ${format(...a)}` : ""}`),
		count: (label = "default") => {
			counts.set(label, (counts.get(label) ?? 0) + 1);
			log(`${label}: ${counts.get(label)}`);
		},
		countReset: (label = "default") => counts.delete(label),
		time: (label = "default") => timersByLabel.set(label, performance.now()),
		timeLog: (label = "default", ...a) =>
			log(`${label}: ${performance.now() - (timersByLabel.get(label) ?? 0)}ms`, ...a),
		timeEnd: (label = "default") => {
			log(`${label}: ${performance.now() - (timersByLabel.get(label) ?? 0)}ms`);
			timersByLabel.delete(label);
		},
		group: (...a) => {
			if (a.length) log(...a);
			groupIndent += "  ";
		},
		groupCollapsed: (...a) => console.group(...a),
		groupEnd: () => {
			groupIndent = groupIndent.slice(2);
		},
	};

	// ---- timers (Node's Timeout objects) ----
	class Timeout {
		#id;
		constructor(id) {
			this.#id = id;
		}
		ref() {
			refTimer(this.#id, true);
			return this;
		}
		unref() {
			refTimer(this.#id, false);
			return this;
		}
		hasRef() {
			return timerActive(this.#id);
		}
		refresh() {
			return this;
		}
		close() {
			clearTimeout(this.#id);
			return this;
		}
		[Symbol.toPrimitive]() {
			return this.#id;
		}
	}
	const webClear = g.clearTimeout;
	const clearTimeout = (t) => webClear(t == null ? t : Number(t));
	const timers = {
		setTimeout: (cb, ms, ...a) => new Timeout(scheduleTimer(cb, ms, a, false)),
		setInterval: (cb, ms, ...a) => new Timeout(scheduleTimer(cb, ms, a, true)),
		setImmediate: (cb, ...a) => new Timeout(scheduleTimer(cb, 0, a, false)),
		clearTimeout,
		clearInterval: clearTimeout,
		clearImmediate: clearTimeout,
	};
	const timersPromises = {
		setTimeout: (ms, value) => new Promise((resolve) => timers.setTimeout(() => resolve(value), ms)),
		setImmediate: (value) => new Promise((resolve) => timers.setImmediate(() => resolve(value))),
		async *setInterval(ms, value) {
			for (;;) yield await timersPromises.setTimeout(ms, value);
		},
		scheduler: { wait: (ms) => timersPromises.setTimeout(ms) },
	};

	// ---- fetch ----
	class Blob {
		#bytes;
		constructor(parts = [], options = {}) {
			this.#bytes = Buffer.concat(
				parts.map((p) => (p instanceof Blob ? p.#bytes : encode(p instanceof ArrayBuffer ? new Uint8Array(p) : p))),
			);
			this.type = options.type ?? "";
		}
		get size() {
			return this.#bytes.length;
		}
		async arrayBuffer() {
			return this.#bytes.buffer.slice(this.#bytes.byteOffset, this.#bytes.byteOffset + this.#bytes.length);
		}
		async bytes() {
			return new Uint8Array(this.#bytes);
		}
		async text() {
			return td.decode(this.#bytes);
		}
		slice(start, end, type) {
			return new Blob([this.#bytes.subarray(start, end)], { type });
		}
	}
	class Body {
		#bytes;
		bodyUsed = false;
		constructor(bytes) {
			this.#bytes = bytes ?? new Uint8Array(0);
		}
		#take() {
			if (this.bodyUsed) throw new TypeError("Body is unusable: Body has already been read");
			this.bodyUsed = true;
			return this.#bytes;
		}
		get body() {
			const bytes = this.#bytes;
			const readable = Stream.Readable.from([Buffer.from(bytes)]);
			readable.getReader = () => {
				let done = false;
				return {
					read: async () => {
						if (done) return { done: true, value: undefined };
						done = true;
						return { done: false, value: new Uint8Array(bytes) };
					},
					releaseLock() {},
					cancel: async () => {},
				};
			};
			return readable;
		}
		async arrayBuffer() {
			const b = this.#take();
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		}
		async bytes() {
			return new Uint8Array(this.#take());
		}
		async text() {
			return td.decode(this.#take());
		}
		async json() {
			return JSON.parse(td.decode(this.#take()));
		}
		async blob() {
			return new Blob([this.#take()]);
		}
	}
	class Response extends Body {
		constructor(body, init = {}) {
			super(body == null ? undefined : typeof body === "string" ? Buffer.from(body) : bytesOf(body));
			this.status = init.status ?? 200;
			this.statusText = init.statusText ?? "";
			this.headers = new Headers(init.headers ?? {});
			this.ok = this.status >= 200 && this.status < 300;
			this.url = init.url ?? "";
			this.redirected = init.redirected ?? false;
			this.type = "basic";
		}
		static json(data, init = {}) {
			return new Response(JSON.stringify(data), {
				...init,
				headers: { "content-type": "application/json", ...init.headers },
			});
		}
		clone() {
			return this;
		}
	}
	class Request {
		constructor(input, init = {}) {
			this.url = input instanceof Request ? input.url : String(input);
			this.method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
			this.headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : {}));
			this.body = init.body ?? (input instanceof Request ? input.body : undefined);
			this.signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
			this.redirect = init.redirect ?? "follow";
		}
	}
	async function fetch(input, init = {}) {
		const request = input instanceof Request ? input : null;
		const url = request ? request.url : input instanceof URL ? input.href : String(input);
		let body = init.body ?? request?.body;
		if (body instanceof Blob) body = await body.bytes();
		const r = await egressFetch(url, {
			method: init.method ?? request?.method,
			headers: init.headers ?? request?.headers,
			body,
			redirect: init.redirect ?? request?.redirect,
			signal: init.signal ?? request?.signal,
		});
		if (r.redirected === undefined) r.redirected = r.url !== url;
		return new Response(r.body, r);
	}

	// ---- built-in modules ----
	const webcrypto = g.crypto;
	const nodeCrypto = createCrypto(ops, webcrypto);
	const events = Object.assign(EventEmitter, {
		EventEmitter,
		once: EventEmitter.once,
		on: EventEmitter.on,
		default: EventEmitter,
	});
	const os = {
		EOL: "\n",
		platform: () => "linux",
		type: () => "Linux",
		arch: () => "x64",
		machine: () => "x86_64",
		release: () => "6.0.0-kantel-isolate",
		version: () => "#1 SMP",
		cpus: () => [{ model: "isolate", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
		availableParallelism: () => 1,
		totalmem: () => state.memoryMiB * 2 ** 20,
		freemem: () => state.memoryMiB * 2 ** 19,
		homedir: () => ROOT,
		tmpdir: () => "/tmp",
		hostname: () => "isolate",
		userInfo: () => ({ username: "user", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: ROOT }),
		networkInterfaces: () => ({}),
		loadavg: () => [0, 0, 0],
		uptime: () => performance.now() / 1000,
		endianness: () => "LE",
		constants: { signals: {}, errno: {} },
		devNull: "/dev/null",
	};
	const url = {
		URL,
		URLSearchParams,
		fileURLToPath: (u) => decodeURIComponent(new URL(String(u)).pathname),
		pathToFileURL: (p) => new URL(`file://${encodeURI(path.resolve(p))}`),
		parse: (s) => {
			const u = new URL(s, "http://localhost");
			return {
				href: u.href,
				protocol: u.protocol,
				host: u.host,
				hostname: u.hostname,
				port: u.port,
				pathname: u.pathname,
				search: u.search,
				query: u.search.slice(1),
				hash: u.hash,
			};
		},
		format: (u) => (u instanceof URL ? u.href : String(u?.href ?? "")),
		resolve: (from, to) => new URL(to, new URL(from, "resolve://")).href.replace(/^resolve:\/\//, ""),
	};
	const unavailable = (name, reason) =>
		new Proxy(
			{},
			{
				get(_t, key) {
					if (key === "__esModule" || typeof key === "symbol" || key === "then") return undefined;
					return () => {
						state.needsMicrovm ??= { command: "node", reason: `${reason}.` };
						throw Object.assign(new Error(`${name} is not available in an isolate's node. Use a microVM.`), {
							code: "ERR_ISOLATE_UNAVAILABLE",
						});
					};
				},
			},
		);
	const builtins = {
		assert: createAssert(),
		buffer: { Buffer, Blob, atob, btoa, constants: { MAX_LENGTH: 2 ** 31 - 1 }, kMaxLength: 2 ** 31 - 1 },
		crypto: nodeCrypto,
		events,
		fs,
		"fs/promises": fs.promises,
		os,
		path,
		"path/posix": path,
		process,
		querystring: createQuerystring(),
		readline: createReadline(EventEmitter),
		stream: Stream,
		"stream/promises": Stream.promises,
		string_decoder: { StringDecoder },
		timers,
		"timers/promises": timersPromises,
		url,
		util,
		"util/types": util.types,
		zlib: {
			gzipSync: (d, o) => Buffer.from(ops.op_kt_zlib("gzip", encode(d), o?.level ?? 6)),
			gunzipSync: (d) => Buffer.from(ops.op_kt_zlib("gunzip", encode(d), 0)),
			deflateSync: (d, o) => Buffer.from(ops.op_kt_zlib("deflate", encode(d), o?.level ?? 6)),
			inflateSync: (d) => Buffer.from(ops.op_kt_zlib("inflate", encode(d), 0)),
			deflateRawSync: (d, o) => Buffer.from(ops.op_kt_zlib("deflateraw", encode(d), o?.level ?? 6)),
			inflateRawSync: (d) => Buffer.from(ops.op_kt_zlib("inflateraw", encode(d), 0)),
			constants: {},
		},
		child_process: unavailable("child_process", "running other programs needs a microVM"),
		cluster: unavailable("cluster", "processes need a microVM"),
		worker_threads: unavailable("worker_threads", "threads need a microVM"),
		http: unavailable("http", "an isolate can't serve or open raw HTTP connections; use fetch"),
		https: unavailable("https", "an isolate can't serve or open raw HTTP connections; use fetch"),
		http2: unavailable("http2", "an isolate can't open raw connections; use fetch"),
		net: unavailable("net", "an isolate can't open sockets"),
		tls: unavailable("tls", "an isolate can't open sockets"),
		dgram: unavailable("dgram", "an isolate can't open sockets"),
		dns: unavailable("dns", "an isolate can't resolve names itself; use fetch"),
		vm: unavailable("vm", "the vm module needs a microVM"),
		v8: {
			getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: state.memoryMiB * 2 ** 20 }),
		},
		perf_hooks: { performance },
		async_hooks: {
			AsyncLocalStorage: class AsyncLocalStorage {
				#store;
				getStore() {
					return this.#store;
				}
				run(store, fn, ...args) {
					const prev = this.#store;
					this.#store = store;
					try {
						return fn(...args);
					} finally {
						this.#store = prev;
					}
				}
				enterWith(store) {
					this.#store = store;
				}
			},
		},
		tty: { isatty: () => false },
		module: {
			createRequire: (from) =>
				makeRequire(path.dirname(String(from).startsWith("file:") ? url.fileURLToPath(from) : String(from))),
			builtinModules: [],
			isBuiltin: (name) => String(name).replace(/^node:/, "") in builtins,
		},
		test: unavailable("node:test", "the test runner needs a microVM"),
	};
	builtins.module.builtinModules = Object.keys(builtins);
	builtins.events.default = EventEmitter;

	// ---- CommonJS ----
	const moduleCache = new Map();
	const compileCjs = (source, filename) => {
		const body = source.startsWith("#!") ? `//${source}` : source;
		try {
			// The isolate runs only this run's code, so compiling it from a string is no more than running it.
			return new Function(
				"exports",
				"require",
				"module",
				"__filename",
				"__dirname",
				`${body}\n//# sourceURL=${filename}`,
			);
		} catch (error) {
			if (error instanceof SyntaxError) locateSyntaxError(error, filename, body);
			throw error;
		}
	};
	/** Gives a syntax error from compileCjs Node's form: where it is, the line, a caret under it, then the error. */
	function locateSyntaxError(error, filename, body) {
		let at;
		try {
			const json = ops.op_kt_syntax_error(filename, body);
			at = json ? JSON.parse(json) : undefined;
		} catch {}
		if (!at?.line) return;
		const caret = `${" ".repeat(at.start)}${"^".repeat(Math.max(1, at.end - at.start))}`;
		Object.defineProperty(error, "stack", {
			value: `${filename}:${at.line}\n${at.source}\n${caret}\n\n${error.name}: ${error.message}`,
			configurable: true,
			writable: true,
		});
	}
	const isTs = (f) => /\.(c|m)?tsx?$/.test(f);
	const sourceOf = (filename) => {
		const text = fs.readFileSync(filename, "utf8");
		return isTs(filename) ? ops.op_kt_transpile(filename, text) : text;
	};
	function loadCjs(filename) {
		const cached = moduleCache.get(filename);
		if (cached) return cached.exports;
		const module = {
			exports: {},
			filename,
			id: filename,
			path: path.dirname(filename),
			loaded: false,
			children: [],
			paths: [],
		};
		moduleCache.set(filename, module);
		try {
			if (filename.endsWith(".json")) module.exports = JSON.parse(fs.readFileSync(filename, "utf8"));
			else {
				module.require = makeRequire(path.dirname(filename));
				compileCjs(sourceOf(filename), filename).call(
					module.exports,
					module.exports,
					module.require,
					module,
					filename,
					path.dirname(filename),
				);
			}
		} catch (error) {
			moduleCache.delete(filename);
			throw error;
		}
		module.loaded = true;
		return module.exports;
	}
	const fileKind = (f) => {
		try {
			return fs.statSync(f).isFile();
		} catch {
			return false;
		}
	};
	function resolveFile(base, id) {
		const p = path.resolve(base, id);
		for (const c of [p, `${p}.js`, `${p}.cjs`, `${p}.mjs`, `${p}.json`, `${p}.ts`, `${p}.cts`, `${p}.mts`])
			if (fileKind(c)) return c;
		const pkgFile = `${p}/package.json`;
		if (fileKind(pkgFile)) {
			const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
			const entry = exportsEntry(pkg.exports, "require") ?? pkg.main;
			if (entry) {
				const r = resolveFile(p, entry);
				if (r) return r;
			}
		}
		for (const c of ["index.js", "index.cjs", "index.json", "index.ts"]) if (fileKind(`${p}/${c}`)) return `${p}/${c}`;
		return undefined;
	}
	function exportsEntry(exp, condition) {
		if (exp == null) return undefined;
		if (typeof exp === "string") return exp;
		if (Array.isArray(exp)) return exportsEntry(exp[0], condition);
		if ("." in exp) return exportsEntry(exp["."], condition);
		for (const key of [condition, "node", "default"]) if (key in exp) return exportsEntry(exp[key], condition);
		return undefined;
	}
	function resolveModule(dir, id) {
		const name = id.startsWith("node:") ? id.slice(5) : id;
		if (name in builtins) return { builtin: name };
		if (id.startsWith("./") || id.startsWith("../") || id.startsWith("/") || id === "." || id === "..") {
			const f = resolveFile(dir, id);
			if (f) return { file: f };
		} else {
			for (let d = dir; ; d = path.dirname(d)) {
				const f = resolveFile(`${d}/node_modules`, id);
				if (f) return { file: f };
				if (d === "/") break;
			}
		}
		throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
	}
	function makeRequire(dir) {
		const require = (id) => {
			const r = resolveModule(dir, String(id));
			if (r.builtin) return builtins[r.builtin];
			if (/\.m(j|t)s$/.test(r.file))
				throw Object.assign(
					new Error(`require() of ES Module ${r.file} isn't supported in an isolate's node; use import()`),
					{
						code: "ERR_REQUIRE_ESM",
					},
				);
			return loadCjs(r.file);
		};
		require.resolve = (id) => {
			const r = resolveModule(dir, String(id));
			return r.builtin ? (String(id).startsWith("node:") ? id : r.builtin) : r.file;
		};
		require.cache = {};
		require.main = state.main;
		return require;
	}

	// For the host's module loader: built-ins and CommonJS files as ES modules.
	Object.defineProperty(g, Symbol.for("kantel.node.builtin"), { value: (name) => builtins[name] });
	Object.defineProperty(g, Symbol.for("kantel.node.require"), { value: (file) => loadCjs(file) });

	// The runtime's own frames (the guest bundle, the host's calls into it, the compile wrapper) mean nothing to the
	// script's author, so an uncaught error's stack shows only the script's.
	const internalFrame =
		/^\s+at (?:.*\(kt:(?:guest|call)[:)]|kt:(?:guest|call):|new Function \(<anonymous>\)|Function \(<anonymous>\))/;
	// A frame in code compiled by compileCjs reads "(file, <anonymous>:line:col)", with the line counted from the top of
	// new Function's own source, which puts two lines of its wrapper before the body: give it as "(file:line:col)".
	const compiledFrame = /([(\s])([^(\s][^,()]*), <anonymous>:(\d+):(\d+)/g;
	const ownFrames = (stack) =>
		String(stack)
			.split("\n")
			.filter((line) => !internalFrame.test(line))
			.map((line) =>
				line.replace(compiledFrame, (_, lead, file, l, col) => `${lead}${file}:${Math.max(1, l - 2)}:${col}`),
			)
			.join("\n");
	function describe(error) {
		if (error instanceof Error) {
			const extra = Object.keys(error).filter((k) => k !== "stack" && k !== "message");
			return ownFrames(extra.length ? inspect(error) : error.stack || `${error.name}: ${error.message}`);
		}
		return `Uncaught ${inspect(error)}`;
	}
	const isEsmSyntax = (error) =>
		error instanceof SyntaxError &&
		/Cannot use import statement|Unexpected token 'export'|import\.meta|await is only valid|Unexpected reserved word|Cannot use 'import\.meta'/.test(
			error.message,
		);

	function start(json) {
		const req = JSON.parse(json);
		resetClock();
		state.memoryMiB = req.memoryMiB ?? 256;
		state.cwd = req.cwd || ROOT;
		state.files.set("/", { kind: "dir" });
		state.files.set("/tmp", { kind: "dir" });
		state.files.set(ROOT, { kind: "dir" });
		for (const [p, e] of Object.entries(req.index)) {
			const full = `${ROOT}/${p}`;
			const parts = full.split("/").filter(Boolean);
			for (let i = 1; i < parts.length; i++) {
				const d = `/${parts.slice(0, i).join("/")}`;
				if (!state.files.has(d)) state.files.set(d, { kind: "dir" });
			}
			const entry = e.kind === "file" ? { kind: "file", ref: p, size: e.size, mode: e.mode ?? 0o644 } : { ...e };
			state.files.set(full, entry);
			state.original.set(full, e.kind === "file" ? { kind: "file", entry } : { kind: e.kind, target: e.target });
		}
		process.env = { ...req.env };
		builtins.module.builtinModules = Object.keys(builtins);
		ops.op_kt_node_builtins(
			JSON.stringify(
				Object.fromEntries(
					Object.entries(builtins).map(([k, v]) => [
						k,
						Object.keys(v).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== "default"),
					]),
				),
			),
		);

		const args = req.args;
		let code;
		let filename;
		let rest = [];
		let print = false;
		let forceModule = false;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") {
				print = a === "-p" || a === "--print";
				if (i + 1 >= args.length) {
					state.write("stderr", Buffer.from(`node: ${a} requires an argument\n`));
					state.exitCode = 9;
					return {};
				}
				code = args[++i];
				rest = args.slice(i + 1);
				break;
			}
			if (a === "-v" || a === "--version") {
				state.write("stdout", Buffer.from(`${NODE_VERSION}\n`));
				state.exitCode = 0;
				return {};
			}
			if (a === "-h" || a === "--help") {
				state.write("stdout", Buffer.from('Usage: node [options] [ script.js | -e "script" | - ] [arguments]\n'));
				state.exitCode = 0;
				return {};
			}
			if (a === "--input-type=module") {
				forceModule = true;
				continue;
			}
			if (a === "-") {
				code = td.decode(state.stdin());
				state.stdinPos = state.stdinBytes.length;
				rest = args.slice(i + 1);
				break;
			}
			if (a === "--") continue;
			if (a.startsWith("-")) continue;
			filename = path.resolve(a);
			rest = args.slice(i + 1);
			break;
		}
		if (code === undefined && filename === undefined) {
			code = td.decode(state.stdin());
			state.stdinPos = state.stdinBytes?.length ?? 0;
		}
		process.argv = ["/usr/local/bin/node", ...(filename ? [filename] : []), ...rest];
		Object.assign(g, {
			process,
			Buffer,
			console,
			fetch,
			Response,
			Request,
			Blob,
			global: g,
			navigator: {
				userAgent: `Node.js/${NODE_VERSION.slice(1)}`,
				hardwareConcurrency: 1,
				language: "en-US",
				platform: "linux",
			},
			...timers,
		});
		try {
			if (code !== undefined) {
				const main = {
					exports: {},
					filename: `${state.cwd}/[eval]`,
					id: ".",
					path: state.cwd,
					loaded: false,
					children: [],
				};
				state.main = main;
				const require = makeRequire(state.cwd);
				if (forceModule) return esmEval(code);
				let fn;
				try {
					fn = compileCjs(print ? `return (${code}\n)` : code, "[eval]");
				} catch (error) {
					if (!print && isEsmSyntax(error)) return esmEval(code);
					throw error;
				}
				const value = fn.call(main.exports, main.exports, require, main, "[eval]", state.cwd);
				if (print) console.log(typeof value === "string" ? value : inspect(value));
				return {};
			}
			if (!fileKind(filename)) {
				const r = (() => {
					try {
						return resolveFile(state.cwd, filename);
					} catch {
						return undefined;
					}
				})();
				if (!r) {
					state.write(
						"stderr",
						Buffer.from(
							`node:internal/modules/cjs/loader\n\nError: Cannot find module '${filename}'\n  code: 'MODULE_NOT_FOUND'\n`,
						),
					);
					state.exitCode = 1;
					return {};
				}
				filename = r;
			}
			if (entryIsEsm(filename)) return { esm: `file://${encodeURI(filename)}` };
			const main = { exports: {}, filename, id: ".", path: path.dirname(filename), loaded: false, children: [] };
			state.main = main;
			moduleCache.set(filename, main);
			main.require = makeRequire(path.dirname(filename));
			main.require.main = main;
			let fn;
			try {
				fn = compileCjs(sourceOf(filename), filename);
			} catch (error) {
				if (isEsmSyntax(error)) {
					moduleCache.delete(filename);
					return { esm: `file://${encodeURI(filename)}` };
				}
				throw error;
			}
			fn.call(main.exports, main.exports, main.require, main, filename, path.dirname(filename));
			main.loaded = true;
		} catch (error) {
			if (error instanceof Exit) return {};
			state.write("stderr", Buffer.from(`${describe(error)}\n`));
			state.exitCode = 1;
		}
		return {};
	}
	function esmEval(code) {
		const file = `${state.cwd}/[eval${Date.now()}].mjs`;
		ops.op_kt_overlay(file, Buffer.from(code), true);
		return { esm: `file://${encodeURI(file)}` };
	}
	function entryIsEsm(filename) {
		if (/\.m(j|t)s$/.test(filename)) return true;
		if (/\.c(j|t)s$/.test(filename)) return false;
		for (let d = path.dirname(filename); ; d = path.dirname(d)) {
			const pkg = `${d}/package.json`;
			if (fileKind(pkg)) {
				try {
					return JSON.parse(fs.readFileSync(pkg, "utf8")).type === "module";
				} catch {
					return false;
				}
			}
			if (d === "/") return false;
		}
	}

	/** After the event loop (error: an uncaught exception or rejection there, as text; null if none). */
	function finish(error) {
		// Pack once: process.exit() packs before stopping the isolate, so the host's later finish() call is a no-op.
		if (state.packed) return;
		state.packed = true;
		if (error && !state.exited) {
			state.write("stderr", Buffer.from(`${error}\n`));
			state.exitCode = 1;
		}
		if (!state.exited) {
			try {
				process.emit("beforeExit", process.exitCode ?? 0);
				process.emit("exit", process.exitCode ?? 0);
			} catch {}
		}
		const exitCode = state.exitCode ?? process.exitCode ?? 0;
		const chunks = new Chunks();
		const writes = [];
		const mkdirs = [];
		const symlinks = [];
		const removes = [];
		const inWorkspace = (p) => p.startsWith(`${ROOT}/`);
		for (const p of state.changed) {
			if (!inWorkspace(p)) continue;
			const e = state.files.get(p);
			if (!e) continue;
			const r = p.slice(ROOT.length + 1);
			if (e.kind === "dir") {
				if (state.original.get(p)?.kind !== "dir") mkdirs.push(r);
			} else if (e.kind === "symlink") symlinks.push({ path: r, target: e.target });
			else {
				if (e.data === undefined) e.data = ops.op_kt_file(e.ref);
				writes.push({ path: r, data: chunks.add(e.data), mode: e.mode ?? 0o644 });
			}
		}
		for (const [p, o] of state.original) {
			const now = state.files.get(p);
			const gone = !now || now.kind !== o.kind || (o.kind === "file" && now !== o.entry && !state.changed.has(p));
			if (gone && !removes.some((d) => p.startsWith(`${ROOT}/${d}/`))) removes.push(p.slice(ROOT.length + 1));
		}
		const out = (name) => {
			const parts = state.out[name];
			const all = new Uint8Array(parts.reduce((n, b) => n + b.byteLength, 0));
			let at = 0;
			for (const b of parts) {
				all.set(b, at);
				at += b.byteLength;
			}
			return all;
		};
		const stderr = out("stderr");
		const truncatedNote = state.out.truncated
			? Buffer.from("node: output over 16 MiB was dropped\n")
			: new Uint8Array(0);
		const meta = {
			exitCode,
			stdout: chunks.add(out("stdout")),
			stderr: chunks.add(Buffer.concat([stderr, truncatedNote])),
			writes,
			mkdirs,
			symlinks,
			removes,
			read: state.read,
		};
		if (state.needsMicrovm) meta.needsMicrovm = state.needsMicrovm;
		ops.op_kt_set_result(pack(meta, chunks.list));
	}

	return {
		start: (json) => JSON.stringify(start(json)),
		finish: (error) => finish(error),
	};
}
