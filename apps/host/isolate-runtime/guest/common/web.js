// The small web platform the guests need, on deno_core's primitives and kantel-isolate's ops: timers, a coarse
// performance clock, crypto, events, abort signals, Headers, URL and atob/btoa. No network, files or environment
// here: the only ways out are the ops, which act for the sandbox the isolate belongs to.
import "./text.js";
import { URL, URLSearchParams } from "whatwg-url";
import { budgetedCopy } from "./budget.js";

const core = globalThis.Deno.core;
const ops = core.ops;
const g = globalThis;

// performance.now() in whole milliseconds since the isolate's run began: no finer clock to time anything with
// (SharedArrayBuffer and Atomics are removed for the same reason, in harden.js).
let timeOrigin = Date.now();
g.performance = {
	get timeOrigin() {
		return timeOrigin;
	},
	now: () => Date.now() - timeOrigin,
	mark() {},
	measure() {},
	toJSON: () => ({ timeOrigin }),
};
export function resetClock() {
	timeOrigin = Date.now();
}

const timers = new Map();
let nextTimer = 1;
function schedule(callback, delay, args, repeat) {
	if (typeof callback !== "function") throw new TypeError("The callback must be a function");
	const id = nextTimer++;
	const ms = typeof delay === "number" && delay > 0 ? Math.min(delay, 2 ** 31 - 1) : 0;
	const timer = core.createTimer(
		() => {
			if (!repeat) timers.delete(id);
			callback(...args);
		},
		ms,
		undefined,
		repeat,
		true,
	);
	timers.set(id, timer);
	return id;
}
function cancel(id) {
	const key = Number(id);
	const timer = timers.get(key);
	if (timer === undefined) return;
	timers.delete(key);
	core.cancelTimer(timer);
}
/** A timer that doesn't keep the run going (Node's unref()), or that does again. */
export function refTimer(id, ref) {
	const timer = timers.get(Number(id));
	if (timer !== undefined) (ref ? core.refTimer : core.unrefTimer)(timer);
}
export const timerActive = (id) => timers.has(Number(id));
export const scheduleTimer = schedule;
g.setTimeout = (callback, delay, ...args) => schedule(callback, delay, args, false);
g.setInterval = (callback, delay, ...args) => schedule(callback, delay, args, true);
g.clearTimeout = cancel;
g.clearInterval = cancel;
g.setImmediate = (callback, ...args) => schedule(callback, 0, args, false);
g.clearImmediate = cancel;
if (typeof g.queueMicrotask !== "function") g.queueMicrotask = (callback) => Promise.resolve().then(callback);

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function base64(bytes) {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
		out +=
			B64[(n >> 18) & 63] +
			B64[(n >> 12) & 63] +
			(i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") +
			(i + 2 < bytes.length ? B64[n & 63] : "=");
	}
	return out;
}
g.btoa = (input) => {
	const s = String(input);
	const bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c > 255) throw new DOMException("Invalid character", "InvalidCharacterError");
		bytes[i] = c;
	}
	return base64(bytes);
};
g.atob = (input) => {
	const s = String(input).replace(/[\t\n\f\r ]/g, "");
	if (s.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(s) || /=[^=]/.test(s))
		throw new DOMException("The string to be decoded is not correctly encoded.", "InvalidCharacterError");
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const ch of s.replace(/=+$/, "")) {
		buffer = (buffer << 6) | B64.indexOf(ch);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out += String.fromCharCode((buffer >> bits) & 255);
		}
	}
	return out;
};

class DOMException extends Error {
	constructor(message = "", name = "Error") {
		super(message);
		this.name = name;
	}
}
g.DOMException = DOMException;

export const bytesOf = (data) =>
	data instanceof Uint8Array
		? data
		: ArrayBuffer.isView(data)
			? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
			: new Uint8Array(data);

const DIGESTS = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };
g.crypto = {
	getRandomValues(array) {
		if (!ArrayBuffer.isView(array) || array instanceof Float32Array || array instanceof Float64Array)
			throw new TypeError("getRandomValues: an integer typed array is required");
		if (array.byteLength > 65536) throw new DOMException("getRandomValues: over 65536 bytes", "QuotaExceededError");
		ops.op_kt_random(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
		return array;
	},
	randomUUID() {
		const b = new Uint8Array(16);
		ops.op_kt_random(b);
		b[6] = (b[6] & 0x0f) | 0x40;
		b[8] = (b[8] & 0x3f) | 0x80;
		const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
		return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
	},
	subtle: {
		async digest(algorithm, data) {
			const name = (typeof algorithm === "string" ? algorithm : (algorithm?.name ?? "")).toUpperCase();
			const op = DIGESTS[name];
			if (!op) throw new DOMException(`Unrecognized algorithm name: ${name}`, "NotSupportedError");
			const d = ops.op_kt_digest(op, bytesOf(data));
			return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
		},
	},
};

class Event {
	constructor(type, init = {}) {
		this.type = String(type);
		this.bubbles = init.bubbles === true;
		this.cancelable = init.cancelable === true;
		this.defaultPrevented = false;
		this.target = null;
		this.currentTarget = null;
		this.timeStamp = Date.now() - timeOrigin;
	}
	preventDefault() {
		if (this.cancelable) this.defaultPrevented = true;
	}
	stopPropagation() {}
	stopImmediatePropagation() {}
}
class CustomEvent extends Event {
	constructor(type, init = {}) {
		super(type, init);
		this.detail = init.detail ?? null;
	}
}
class EventTarget {
	#listeners = new Map();
	addEventListener(type, listener, options) {
		if (!listener) return;
		const once = typeof options === "object" && options?.once === true;
		let set = this.#listeners.get(type);
		if (!set) {
			set = [];
			this.#listeners.set(type, set);
		}
		if (!set.some((e) => e.listener === listener)) set.push({ listener, once });
		const signal = typeof options === "object" ? options?.signal : undefined;
		signal?.addEventListener?.("abort", () => this.removeEventListener(type, listener), { once: true });
	}
	removeEventListener(type, listener) {
		const set = this.#listeners.get(type);
		if (set)
			this.#listeners.set(
				type,
				set.filter((e) => e.listener !== listener),
			);
	}
	dispatchEvent(event) {
		event.target = this;
		event.currentTarget = this;
		const handler = this[`on${event.type}`];
		if (typeof handler === "function") handler.call(this, event);
		for (const entry of [...(this.#listeners.get(event.type) ?? [])]) {
			if (entry.once) this.removeEventListener(event.type, entry.listener);
			if (typeof entry.listener === "function") entry.listener.call(this, event);
			else entry.listener?.handleEvent?.(event);
		}
		return !event.defaultPrevented;
	}
}
class AbortSignal extends EventTarget {
	aborted = false;
	reason = undefined;
	onabort = null;
	throwIfAborted() {
		if (this.aborted) throw this.reason;
	}
	static abort(reason) {
		const c = new AbortController();
		c.abort(reason);
		return c.signal;
	}
	static timeout(ms) {
		const c = new AbortController();
		g.setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
		return c.signal;
	}
	static any(signals) {
		const c = new AbortController();
		for (const s of signals) {
			if (s.aborted) {
				c.abort(s.reason);
				break;
			}
			s.addEventListener("abort", () => c.abort(s.reason), { once: true });
		}
		return c.signal;
	}
}
class AbortController {
	signal = new AbortSignal();
	abort(reason) {
		if (this.signal.aborted) return;
		this.signal.aborted = true;
		this.signal.reason = reason ?? new DOMException("This operation was aborted", "AbortError");
		this.signal.dispatchEvent(new Event("abort"));
	}
}
Object.assign(g, { Event, CustomEvent, EventTarget, AbortSignal, AbortController });

class Headers {
	#map = new Map();
	constructor(init) {
		if (init == null) return;
		if (init instanceof Headers || typeof init[Symbol.iterator] === "function")
			for (const [k, v] of init) this.append(k, v);
		else for (const [k, v] of Object.entries(init)) this.append(k, v);
	}
	append(name, value) {
		const k = String(name).toLowerCase();
		const v = String(value).trim();
		const prev = this.#map.get(k);
		this.#map.set(k, prev === undefined ? v : `${prev}, ${v}`);
	}
	set(name, value) {
		this.#map.set(String(name).toLowerCase(), String(value).trim());
	}
	get(name) {
		return this.#map.get(String(name).toLowerCase()) ?? null;
	}
	has(name) {
		return this.#map.has(String(name).toLowerCase());
	}
	delete(name) {
		this.#map.delete(String(name).toLowerCase());
	}
	getSetCookie() {
		const v = this.#map.get("set-cookie");
		return v === undefined ? [] : [v];
	}
	forEach(callback, thisArg) {
		for (const [k, v] of this.entries()) callback.call(thisArg, v, k, this);
	}
	*entries() {
		for (const k of [...this.#map.keys()].sort()) yield [k, this.#map.get(k)];
	}
	*keys() {
		for (const [k] of this.entries()) yield k;
	}
	*values() {
		for (const [, v] of this.entries()) yield v;
	}
	[Symbol.iterator]() {
		return this.entries();
	}
}
g.Headers = Headers;
g.URL = URL;
g.URLSearchParams = URLSearchParams;

// Values the guests hand each other are JSON-ish; this is enough for structuredClone's common uses.
g.structuredClone = (value) => clone(value, new Map());
function clone(v, seen) {
	if (v === null || typeof v !== "object") {
		if (typeof v === "function" || typeof v === "symbol")
			throw new DOMException(`${String(v)} could not be cloned.`, "DataCloneError");
		return v;
	}
	if (seen.has(v)) return seen.get(v);
	let out;
	if (v instanceof Date) out = new Date(v.getTime());
	else if (v instanceof RegExp) out = new RegExp(v.source, v.flags);
	else if (ArrayBuffer.isView(v)) out = new v.constructor(v);
	else if (v instanceof ArrayBuffer) out = v.slice(0);
	else if (v instanceof Map) {
		out = new Map();
		seen.set(v, out);
		for (const [k, x] of v) out.set(clone(k, seen), clone(x, seen));
		return out;
	} else if (v instanceof Set) {
		out = new Set();
		seen.set(v, out);
		for (const x of v) out.add(clone(x, seen));
		return out;
	} else if (Array.isArray(v)) {
		out = [];
		seen.set(v, out);
		for (const x of v) out.push(clone(x, seen));
		return out;
	} else if (v instanceof Error) out = new v.constructor(v.message);
	else {
		out = {};
		seen.set(v, out);
		for (const k of Object.keys(v)) out[k] = clone(v[k], seen);
		return out;
	}
	seen.set(v, out);
	return out;
}

/**
 * One HTTP request through the host's egress proxy (the op tags it with the sandbox and drops the guest's own
 * kantel-* headers). Resolves {status, statusText, headers, body: Uint8Array, url, redirected}.
 */
export async function egressFetch(url, options = {}) {
	const headers = {};
	new Headers(options.headers ?? {}).forEach((v, k) => {
		headers[k] = v;
	});
	let body = options.body;
	if (body == null) body = new Uint8Array(0);
	else if (typeof body === "string") body = core.encode(body);
	else if (body instanceof URLSearchParams) {
		body = core.encode(body.toString());
		headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
	} else body = bytesOf(body);
	const request = {
		url: String(url),
		method: String(options.method ?? "GET").toUpperCase(),
		headers,
		follow: options.followRedirects !== false && options.redirect !== "manual" && options.redirect !== "error",
	};
	const call = ops.op_kt_fetch(JSON.stringify(request), body);
	const signal = options.signal;
	let out;
	if (signal) {
		signal.throwIfAborted();
		out = await new Promise((resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			call.then(resolve, reject);
		});
	} else out = await call;
	return unpack(out, (meta, data) => ({ ...meta, body: budgetedCopy(data) }));
}

/** A buffer the host or a child made: [u32 big-endian meta length][meta JSON][data]. */
export function unpack(buffer, then = (meta, data) => ({ meta, data })) {
	const n = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
	return then(JSON.parse(core.decode(buffer.subarray(4, 4 + n))), buffer.subarray(4 + n));
}

/** The reverse of unpack: meta, then the chunks one after another. */
export function pack(meta, chunks) {
	let total = 0;
	for (const c of chunks) total += c.byteLength;
	const m = core.encode(JSON.stringify(meta));
	const out = new Uint8Array(4 + m.length + total);
	new DataView(out.buffer).setUint32(0, m.length);
	out.set(m, 4);
	let p = 4 + m.length;
	for (const c of chunks) {
		out.set(c, p);
		p += c.byteLength;
	}
	return out;
}

/** Collects chunks and hands out [offset, length] for each, for pack(). */
export class Chunks {
	list = [];
	size = 0;
	add(bytes) {
		const at = [this.size, bytes.byteLength];
		this.list.push(bytes);
		this.size += bytes.byteLength;
		return at;
	}
	/** All the chunks, one after another. */
	bytes() {
		const out = new Uint8Array(this.size);
		let p = 0;
		for (const c of this.list) {
			out.set(c, p);
			p += c.byteLength;
		}
		return out;
	}
}
