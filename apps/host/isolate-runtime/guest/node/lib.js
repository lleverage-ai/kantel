// The rest of the node runtime's built-in modules: path, events, stream, os, crypto, url, assert, timers, readline,
// string_decoder and querystring, small but faithful where scripts commonly lean on them.
import { Buffer } from "../common/buffer.js";
import { inspect, isDeepStrictEqual } from "./util.js";

export function createPath(cwd) {
	function normalizeString(p, allowAbove) {
		const out = [];
		for (const part of p.split("/")) {
			if (part === "" || part === ".") continue;
			if (part === "..") {
				if (out.length && out[out.length - 1] !== "..") out.pop();
				else if (allowAbove) out.push("..");
			} else out.push(part);
		}
		return out.join("/");
	}
	const path = {
		sep: "/",
		delimiter: ":",
		normalize(p) {
			if (p === "") return ".";
			const isAbs = p.startsWith("/");
			const trailing = p.endsWith("/");
			let r = normalizeString(p, !isAbs);
			if (!r && !isAbs) r = ".";
			if (r && trailing) r += "/";
			return isAbs ? `/${r}` : r;
		},
		join: (...parts) => {
			const joined = parts.filter((x) => x !== "").join("/");
			return joined ? path.normalize(joined) : ".";
		},
		resolve: (...parts) => {
			let r = "";
			for (let i = parts.length - 1; i >= 0 && !r.startsWith("/"); i--) if (parts[i]) r = parts[i] + (r ? `/${r}` : "");
			if (!r.startsWith("/")) r = `${cwd()}/${r}`;
			return `/${normalizeString(r, false)}`;
		},
		isAbsolute: (p) => p.startsWith("/"),
		dirname(p) {
			if (!p) return ".";
			const trimmed = p.replace(/\/+$/, "") || "/";
			const i = trimmed.lastIndexOf("/");
			return i < 0 ? "." : i === 0 ? "/" : trimmed.slice(0, i);
		},
		basename(p, ext) {
			const b = p.replace(/\/+$/, "").split("/").pop() ?? "";
			return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
		},
		extname(p) {
			const b = path.basename(p);
			const i = b.lastIndexOf(".");
			return i <= 0 ? "" : b.slice(i);
		},
		relative(from, to) {
			const a = path.resolve(from).split("/").filter(Boolean);
			const b = path.resolve(to).split("/").filter(Boolean);
			let i = 0;
			while (i < a.length && a[i] === b[i]) i++;
			return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
		},
		parse(p) {
			const root = p.startsWith("/") ? "/" : "";
			const base = path.basename(p);
			const ext = path.extname(p);
			const dir = path.dirname(p);
			return { root, dir: dir === "." && !p.includes("/") ? "" : dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
		},
		format: (o) => {
			const dir = o.dir ?? o.root ?? "";
			const base = o.base ?? `${o.name ?? ""}${o.ext ?? ""}`;
			return dir ? (dir.endsWith("/") ? dir + base : `${dir}/${base}`) : base;
		},
		toNamespacedPath: (p) => p,
		matchesGlob: () => false,
	};
	path.posix = path;
	path.win32 = path;
	return path;
}

export class EventEmitter {
	#events = new Map();
	#max = 10;
	static defaultMaxListeners = 10;
	static once(emitter, name) {
		return new Promise((resolve, reject) => {
			const onError = (error) => {
				emitter.off(name, onValue);
				reject(error);
			};
			const onValue = (...args) => {
				emitter.off("error", onError);
				resolve(args);
			};
			emitter.once(name, onValue);
			if (name !== "error") emitter.once("error", onError);
		});
	}
	static async *on(emitter, name) {
		const queue = [];
		let wake;
		emitter.on(name, (...args) => {
			queue.push(args);
			wake?.();
		});
		for (;;) {
			while (queue.length) yield queue.shift();
			await new Promise((r) => {
				wake = r;
			});
		}
	}
	on(name, listener) {
		if (this.#events.has("newListener") && name !== "newListener") this.emit("newListener", name, listener);
		const list = this.#events.get(name) ?? [];
		list.push(listener);
		this.#events.set(name, list);
		return this;
	}
	addListener(name, listener) {
		return this.on(name, listener);
	}
	prependListener(name, listener) {
		this.#events.set(name, [listener, ...(this.#events.get(name) ?? [])]);
		return this;
	}
	once(name, listener) {
		const wrapper = (...args) => {
			this.off(name, wrapper);
			listener.apply(this, args);
		};
		wrapper.listener = listener;
		return this.on(name, wrapper);
	}
	prependOnceListener(name, listener) {
		const wrapper = (...args) => {
			this.off(name, wrapper);
			listener.apply(this, args);
		};
		wrapper.listener = listener;
		return this.prependListener(name, wrapper);
	}
	off(name, listener) {
		const list = this.#events.get(name);
		if (!list) return this;
		const i = list.findIndex((l) => l === listener || l.listener === listener);
		if (i >= 0) list.splice(i, 1);
		if (!list.length) this.#events.delete(name);
		return this;
	}
	removeListener(name, listener) {
		return this.off(name, listener);
	}
	removeAllListeners(name) {
		if (name === undefined) this.#events.clear();
		else this.#events.delete(name);
		return this;
	}
	emit(name, ...args) {
		const list = this.#events.get(name);
		if (!list?.length) {
			if (name === "error") throw args[0] instanceof Error ? args[0] : new Error(`Unhandled error. (${inspect(args[0])})`);
			return false;
		}
		for (const listener of [...list]) listener.apply(this, args);
		return true;
	}
	listenerCount(name) {
		return this.#events.get(name)?.length ?? 0;
	}
	listeners(name) {
		return (this.#events.get(name) ?? []).map((l) => l.listener ?? l);
	}
	rawListeners(name) {
		return [...(this.#events.get(name) ?? [])];
	}
	eventNames() {
		return [...this.#events.keys()];
	}
	setMaxListeners(n) {
		this.#max = n;
		return this;
	}
	getMaxListeners() {
		return this.#max;
	}
}

/** Minimal streams: Readable with push/pipe/async iteration, Writable, Transform/PassThrough. */
export function createStreams() {
	class Readable extends EventEmitter {
		#buffer = [];
		#ended = false;
		#flowing = false;
		#encoding;
		readable = true;
		destroyed = false;
		constructor(options = {}) {
			super();
			this._readImpl = options.read;
			if (options.objectMode) this.objectMode = true;
		}
		static from(iterable) {
			const r = new Readable({ objectMode: true });
			(async () => {
				try {
					for await (const chunk of iterable) r.push(chunk);
					r.push(null);
				} catch (error) {
					r.destroy(error);
				}
			})();
			return r;
		}
		setEncoding(enc) {
			this.#encoding = enc;
			return this;
		}
		push(chunk) {
			if (chunk === null) {
				this.#ended = true;
				queueMicrotask(() => this.#flush());
				return false;
			}
			this.#buffer.push(this.#encoding && chunk instanceof Uint8Array ? Buffer.from(chunk).toString(this.#encoding) : chunk);
			queueMicrotask(() => this.#flush());
			return true;
		}
		#flush() {
			if (!this.#flowing) return;
			while (this.#buffer.length) this.emit("data", this.#buffer.shift());
			if (this.#ended && !this.endEmitted) {
				this.endEmitted = true;
				this.readable = false;
				this.emit("end");
				this.emit("close");
			}
		}
		on(name, listener) {
			super.on(name, listener);
			if (name === "data") this.resume();
			if (name === "readable") queueMicrotask(() => this.emit("readable"));
			return this;
		}
		read() {
			if (!this.#buffer.length) {
				if (this.#ended && !this.endEmitted) queueMicrotask(() => this.#flush());
				return null;
			}
			const chunks = this.#buffer.splice(0);
			return chunks.every((c) => typeof c === "string") ? chunks.join("") : Buffer.concat(chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c)));
		}
		resume() {
			this.#flowing = true;
			queueMicrotask(() => this.#flush());
			return this;
		}
		pause() {
			this.#flowing = false;
			return this;
		}
		pipe(dest) {
			this.on("data", (chunk) => dest.write(chunk));
			this.on("end", () => {
				if (dest !== globalThis.process?.stdout && dest !== globalThis.process?.stderr) dest.end?.();
			});
			return dest;
		}
		destroy(error) {
			this.destroyed = true;
			if (error) queueMicrotask(() => this.emit("error", error));
			queueMicrotask(() => this.emit("close"));
			return this;
		}
		async *[Symbol.asyncIterator]() {
			this.pause();
			for (;;) {
				if (this.#buffer.length) {
					yield this.#buffer.shift();
					continue;
				}
				if (this.#ended) return;
				await new Promise((resolve) => queueMicrotask(resolve));
				if (!this.#buffer.length && !this.#ended) await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
	}
	class Writable extends EventEmitter {
		writable = true;
		constructor(options = {}) {
			super();
			this._writeImpl = options.write ?? ((_c, _e, cb) => cb());
			this._finalImpl = options.final;
		}
		write(chunk, encoding, callback) {
			if (typeof encoding === "function") [callback, encoding] = [encoding, undefined];
			this._writeImpl(chunk, encoding ?? "utf8", (error) => {
				if (error) this.emit("error", error);
				callback?.(error);
			});
			return true;
		}
		end(chunk, encoding, callback) {
			if (typeof chunk === "function") [callback, chunk] = [chunk, undefined];
			if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
			this.writable = false;
			const done = () => {
				this.emit("finish");
				this.emit("close");
				callback?.();
			};
			if (this._finalImpl) this._finalImpl(done);
			else queueMicrotask(done);
			return this;
		}
		destroy() {
			this.writable = false;
			return this;
		}
	}
	class Transform extends Readable {
		constructor(options = {}) {
			super(options);
			this._transformImpl = options.transform ?? ((chunk, _e, cb) => cb(null, chunk));
			this._flushImpl = options.flush;
		}
		write(chunk, encoding, callback) {
			this._transformImpl(chunk, encoding, (error, out) => {
				if (error) this.emit("error", error);
				else if (out !== undefined && out !== null) this.push(out);
				callback?.(error);
			});
			return true;
		}
		end(chunk) {
			if (chunk !== undefined && chunk !== null) this.write(chunk);
			const finish = () => {
				this.push(null);
				this.emit("finish");
			};
			if (this._flushImpl) this._flushImpl((error, out) => {
				if (out) this.push(out);
				finish();
			});
			else finish();
			return this;
		}
	}
	class PassThrough extends Transform {}
	const pipeline = (...streams) => {
		const callback = typeof streams[streams.length - 1] === "function" ? streams.pop() : undefined;
		for (let i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
		const last = streams[streams.length - 1];
		last.on("finish", () => callback?.());
		last.on("end", () => callback?.());
		return last;
	};
	const finished = (stream, callback) => {
		stream.on("end", () => callback());
		stream.on("finish", () => callback());
		stream.on("error", (e) => callback(e));
	};
	const promises = {
		pipeline: (...s) => new Promise((resolve, reject) => pipeline(...s, (e) => (e ? reject(e) : resolve()))),
		finished: (s) => new Promise((resolve, reject) => finished(s, (e) => (e ? reject(e) : resolve()))),
	};
	const Stream = Object.assign(Readable, { Readable, Writable, Transform, PassThrough, Duplex: Transform, pipeline, finished, promises, Stream: Readable });
	return Stream;
}

export function createCrypto(ops, webcrypto) {
	const toBytes = (d, enc) => (typeof d === "string" ? Buffer.from(d, enc ?? "utf8") : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
	const ALGS = { md5: "md5", sha1: "sha1", sha256: "sha256", sha384: "sha384", sha512: "sha512", "sha-1": "sha1", "sha-256": "sha256", "sha-384": "sha384", "sha-512": "sha512" };
	const BLOCK = { md5: 64, sha1: 64, sha256: 64, sha384: 128, sha512: 128 };
	const algOf = (name) => {
		const a = ALGS[String(name).toLowerCase()];
		if (!a) throw new Error(`Digest method not supported: ${name}`);
		return a;
	};
	const digest = (alg, bytes) => Buffer.from(ops.op_kt_digest(alg, bytes));
	const encode = (b, enc) => (enc ? b.toString(enc) : b);
	class Hash {
		#alg;
		#parts = [];
		constructor(alg) {
			this.#alg = algOf(alg);
		}
		update(d, enc) {
			this.#parts.push(toBytes(d, enc));
			return this;
		}
		digest(enc) {
			return encode(digest(this.#alg, Buffer.concat(this.#parts)), enc);
		}
		copy() {
			const h = new Hash(this.#alg);
			for (const p of this.#parts) h.update(p);
			return h;
		}
	}
	class Hmac {
		#alg;
		#key;
		#parts = [];
		constructor(alg, key) {
			this.#alg = algOf(alg);
			let k = toBytes(key);
			const block = BLOCK[this.#alg];
			if (k.length > block) k = digest(this.#alg, k);
			this.#key = new Uint8Array(block);
			this.#key.set(k);
		}
		update(d, enc) {
			this.#parts.push(toBytes(d, enc));
			return this;
		}
		digest(enc) {
			const inner = Buffer.concat([this.#key.map((b) => b ^ 0x36), ...this.#parts]);
			const outer = Buffer.concat([this.#key.map((b) => b ^ 0x5c), digest(this.#alg, inner)]);
			return encode(digest(this.#alg, outer), enc);
		}
	}
	const randomBytes = (n, callback) => {
		const b = Buffer.alloc(n);
		for (let i = 0; i < n; i += 65536) webcrypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
		if (callback) queueMicrotask(() => callback(null, b));
		return b;
	};
	return {
		createHash: (alg) => new Hash(alg),
		createHmac: (alg, key) => new Hmac(alg, key),
		hash: (alg, data, enc = "hex") => encode(digest(algOf(alg), toBytes(data)), enc),
		randomBytes,
		randomFillSync: (b) => webcrypto.getRandomValues(b),
		randomUUID: () => webcrypto.randomUUID(),
		randomInt(min, max) {
			if (max === undefined) [min, max] = [0, min];
			const range = max - min;
			const buf = new Uint32Array(1);
			webcrypto.getRandomValues(buf);
			return min + (buf[0] % range);
		},
		timingSafeEqual: (a, b) => {
			if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
			let d = 0;
			for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
			return d === 0;
		},
		getHashes: () => ["md5", "sha1", "sha256", "sha384", "sha512"],
		webcrypto,
		subtle: webcrypto.subtle,
		getRandomValues: (a) => webcrypto.getRandomValues(a),
	};
}

export function createAssert() {
	class AssertionError extends Error {
		constructor(options) {
			super(options.message);
			this.name = "AssertionError";
			this.code = "ERR_ASSERTION";
			this.actual = options.actual;
			this.expected = options.expected;
			this.operator = options.operator;
		}
	}
	const fail = (message, actual, expected, operator, fallback) => {
		if (message instanceof Error) throw message;
		throw new AssertionError({ message: message ?? fallback, actual, expected, operator });
	};
	const ok = (value, message) => value || fail(message, value, true, "==", "The expression evaluated to a falsy value");
	const assert = (value, message) => ok(value, message);
	const matches = (error, expected) => {
		if (expected === undefined) return true;
		if (typeof expected === "function") return expected.prototype !== undefined && error instanceof expected ? true : expected(error) === true;
		if (expected instanceof RegExp) return expected.test(String(error?.message ?? error));
		return Object.entries(expected).every(([k, v]) => (v instanceof RegExp ? v.test(error[k]) : isDeepStrictEqual(error[k], v)));
	};
	Object.assign(assert, {
		ok,
		AssertionError,
		fail: (message) => fail(message, undefined, undefined, "fail", "Failed"),
		equal: (a, b, m) => a == b || fail(m, a, b, "==", `${inspect(a)} == ${inspect(b)}`),
		notEqual: (a, b, m) => a != b || fail(m, a, b, "!=", `${inspect(a)} != ${inspect(b)}`),
		strictEqual: (a, b, m) => Object.is(a, b) || fail(m, a, b, "strictEqual", `Expected values to be strictly equal:\n\n${inspect(a)} !== ${inspect(b)}\n`),
		notStrictEqual: (a, b, m) => !Object.is(a, b) || fail(m, a, b, "notStrictEqual", `Expected "actual" to be strictly unequal to: ${inspect(b)}`),
		deepEqual: (a, b, m) => isDeepStrictEqual(a, b) || JSON.stringify(a) === JSON.stringify(b) || fail(m, a, b, "deepEqual", "Expected values to be loosely deep-equal"),
		deepStrictEqual: (a, b, m) => isDeepStrictEqual(a, b) || fail(m, a, b, "deepStrictEqual", `Expected values to be strictly deep-equal:\n${inspect(a)}\n\nshould equal\n\n${inspect(b)}`),
		notDeepStrictEqual: (a, b, m) => !isDeepStrictEqual(a, b) || fail(m, a, b, "notDeepStrictEqual", "Expected values not to be strictly deep-equal"),
		throws(fn, expected, message) {
			try {
				fn();
			} catch (error) {
				if (!matches(error, expected)) throw error;
				return;
			}
			fail(typeof expected === "string" ? expected : message, undefined, expected, "throws", "Missing expected exception.");
		},
		doesNotThrow(fn) {
			fn();
		},
		async rejects(p, expected, message) {
			try {
				await (typeof p === "function" ? p() : p);
			} catch (error) {
				if (!matches(error, expected)) throw error;
				return;
			}
			fail(message, undefined, expected, "rejects", "Missing expected rejection.");
		},
		async doesNotReject(p) {
			await (typeof p === "function" ? p() : p);
		},
		match: (s, re, m) => re.test(s) || fail(m, s, re, "match", `The input did not match the regular expression ${re}. Input:\n\n${inspect(s)}\n`),
		doesNotMatch: (s, re, m) => !re.test(s) || fail(m, s, re, "doesNotMatch", `The input was expected to not match ${re}`),
		ifError: (v) => {
			if (v !== null && v !== undefined) throw v;
		},
	});
	assert.strict = assert;
	return assert;
}

export function createReadline(EventEmitterClass) {
	class Interface extends EventEmitterClass {
		#closed = false;
		constructor(input, output) {
			super();
			this.input = input;
			this.output = output;
			let rest = "";
			const onData = (chunk) => {
				rest += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
				const lines = rest.split(/\r?\n/);
				rest = lines.pop() ?? "";
				for (const line of lines) if (!this.#closed) this.emit("line", line);
			};
			input?.on?.("data", onData);
			input?.on?.("end", () => {
				if (rest && !this.#closed) this.emit("line", rest);
				this.close();
			});
		}
		close() {
			if (this.#closed) return;
			this.#closed = true;
			this.emit("close");
		}
		question(query, callback) {
			this.output?.write?.(query);
			this.once("line", callback);
		}
		setPrompt() {}
		prompt() {}
		write(s) {
			this.output?.write?.(s);
		}
		async *[Symbol.asyncIterator]() {
			const lines = [];
			let done = false;
			let wake;
			this.on("line", (l) => {
				lines.push(l);
				wake?.();
			});
			this.on("close", () => {
				done = true;
				wake?.();
			});
			for (;;) {
				while (lines.length) yield lines.shift();
				if (done) return;
				await new Promise((r) => {
					wake = r;
				});
			}
		}
	}
	const createInterface = (input, output) =>
		input && typeof input === "object" && "input" in input ? new Interface(input.input, input.output) : new Interface(input, output);
	return {
		createInterface,
		Interface,
		promises: {
			createInterface,
			Interface,
		},
		clearLine: () => true,
		cursorTo: () => true,
		emitKeypressEvents: () => {},
	};
}

export function createQuerystring() {
	const escape = (s) => encodeURIComponent(s);
	const unescape = (s) => decodeURIComponent(s.replace(/\+/g, " "));
	return {
		escape,
		unescape,
		parse(s, sep = "&", eq = "=") {
			const out = {};
			for (const part of String(s).split(sep)) {
				if (!part) continue;
				const i = part.indexOf(eq);
				const k = unescape(i < 0 ? part : part.slice(0, i));
				const v = i < 0 ? "" : unescape(part.slice(i + eq.length));
				if (k in out) out[k] = [].concat(out[k], v);
				else out[k] = v;
			}
			return out;
		},
		stringify(o, sep = "&", eq = "=") {
			return Object.entries(o ?? {})
				.flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${escape(k)}${eq}${escape(String(x ?? ""))}`))
				.join(sep);
		},
	};
}

export class StringDecoder {
	#encoding;
	#rest = new Uint8Array(0);
	constructor(encoding = "utf8") {
		this.#encoding = encoding;
	}
	write(chunk) {
		if (typeof chunk === "string") return chunk;
		const all = Buffer.concat([this.#rest, chunk]);
		if (!/^utf-?8$/i.test(this.#encoding)) return all.toString(this.#encoding);
		let end = all.length;
		for (let i = Math.max(0, all.length - 3); i < all.length; i++) {
			const b = all[i];
			const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
			if (need > 1 && i + need > all.length) {
				end = i;
				break;
			}
		}
		this.#rest = all.subarray(end);
		return all.subarray(0, end).toString("utf8");
	}
	end(chunk) {
		const s = chunk ? this.write(chunk) : "";
		const rest = this.#rest.length ? Buffer.from(this.#rest).toString(this.#encoding) : "";
		this.#rest = new Uint8Array(0);
		return s + rest;
	}
}
