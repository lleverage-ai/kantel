// node:util's inspect and format, close enough to Node's output for console.log of everyday values.
import { Buffer } from "../common/buffer.js";

const IDENT = /^[A-Za-z_$][\w$]*$/;
const quote = (s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

export function inspect(value, options = {}) {
	const opts = typeof options === "object" ? options : {};
	const depth = opts.depth === null ? Number.POSITIVE_INFINITY : (opts.depth ?? 2);
	return fmt(value, depth, new Set(), 0, opts);
}
inspect.custom = Symbol.for("nodejs.util.inspect.custom");

function constructorName(v) {
	const proto = Object.getPrototypeOf(v);
	if (proto === null) return null;
	return proto.constructor?.name ?? "Object";
}

function fmt(v, depth, seen, level, opts) {
	if (typeof v === "string") return level === 0 ? v : quote(v);
	if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
	if (typeof v === "bigint") return `${v}n`;
	if (typeof v === "symbol") return v.toString();
	if (typeof v === "undefined") return "undefined";
	if (v === null) return "null";
	if (typeof v === "boolean") return String(v);
	if (typeof v === "function") {
		const src = Function.prototype.toString.call(v);
		const kind = src.startsWith("class") ? "class" : v.constructor?.name === "AsyncFunction" ? "AsyncFunction" : "Function";
		const base = kind === "class" ? `[class ${v.name || "(anonymous)"}]` : `[${kind}: ${v.name || "(anonymous)"}]`;
		const keys = Object.keys(v);
		return keys.length && depth >= 0 ? `${base} ${fmtEntries(v, keys, depth, seen, level, opts, "{", "}")}` : base;
	}
	if (typeof v[inspect.custom] === "function" && v[inspect.custom] !== inspect)
		return String(v[inspect.custom](depth, { ...opts, stylize: (s) => s }, inspect));
	if (seen.has(v)) return "[Circular *1]";
	if (v instanceof Error) {
		const stack = v.stack || `${v.name}: ${v.message}`;
		const extra = Object.keys(v).filter((k) => k !== "stack" && k !== "message");
		if (!extra.length || depth < 0) return level ? `[${stack}]` : stack;
		seen.add(v);
		try {
			return `${stack} ${fmtEntries(v, extra, depth, seen, level, opts, "{", "}")}`;
		} finally {
			seen.delete(v);
		}
	}
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
	if (v instanceof RegExp) return String(v);
	if (v instanceof Promise) return "Promise { <pending> }";
	if (v instanceof WeakMap) return "WeakMap { <items unknown> }";
	if (v instanceof WeakSet) return "WeakSet { <items unknown> }";
	if (v instanceof Buffer) {
		const shown = Array.from(v.subarray(0, 50), (x) => x.toString(16).padStart(2, "0")).join(" ");
		return `<Buffer${shown ? ` ${shown}` : ""}${v.length > 50 ? ` ... ${v.length - 50} more bytes` : ""}>`;
	}
	if (depth < 0) return Array.isArray(v) ? "[Array]" : `[${constructorName(v) ?? "Object: null prototype"}]`;
	seen.add(v);
	try {
		if (Array.isArray(v)) {
			const items = v.slice(0, 100).map((x) => fmt(x, depth - 1, seen, level + 1, opts));
			if (v.length > 100) items.push(`... ${v.length - 100} more item${v.length - 100 > 1 ? "s" : ""}`);
			for (const k of Object.keys(v)) if (!/^\d+$/.test(k)) items.push(`${key(k)}: ${fmt(v[k], depth - 1, seen, level + 1, opts)}`);
			return wrap(items, "[", "]", level);
		}
		if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
			const items = Array.from(v.subarray(0, 100), (x) => fmt(x, depth - 1, seen, level + 1, opts));
			if (v.length > 100) items.push(`... ${v.length - 100} more items`);
			return `${constructorName(v)}(${v.length}) ${wrap(items, "[", "]", level)}`;
		}
		if (v instanceof ArrayBuffer) return `ArrayBuffer { byteLength: ${v.byteLength} }`;
		if (v instanceof Map) {
			const items = [...v].map(([k, x]) => `${fmt(k, depth - 1, seen, level + 1, opts)} => ${fmt(x, depth - 1, seen, level + 1, opts)}`);
			return `Map(${v.size}) ${wrap(items, "{", "}", level)}`;
		}
		if (v instanceof Set) {
			const items = [...v].map((x) => fmt(x, depth - 1, seen, level + 1, opts));
			return `Set(${v.size}) ${wrap(items, "{", "}", level)}`;
		}
		const name = constructorName(v);
		const keys = Object.keys(v);
		const symbols = Object.getOwnPropertySymbols(v).filter((s) => Object.getOwnPropertyDescriptor(v, s)?.enumerable);
		const body = fmtEntries(v, [...keys, ...symbols], depth, seen, level, opts, "{", "}");
		if (name === null) return `[Object: null prototype] ${body}`;
		if (name !== "Object") return keys.length || symbols.length ? `${name} ${body}` : `${name} {}`;
		return body;
	} finally {
		seen.delete(v);
	}
}

const key = (k) => (typeof k === "symbol" ? `[${k.toString()}]` : IDENT.test(k) ? k : quote(k));

function fmtEntries(v, keys, depth, seen, level, opts, open, close) {
	const items = keys.map((k) => {
		const d = Object.getOwnPropertyDescriptor(v, k);
		if (d && (d.get || d.set)) return `${key(k)}: [${d.get && d.set ? "Getter/Setter" : d.get ? "Getter" : "Setter"}]`;
		return `${key(k)}: ${fmt(v[k], depth - 1, seen, level + 1, opts)}`;
	});
	return wrap(items, open, close, level);
}

function wrap(items, open, close, level) {
	if (!items.length) return `${open}${close}`;
	const single = `${open} ${items.join(", ")} ${close}`;
	if (single.length + level * 2 <= 72 && !single.includes("\n")) return single;
	// Nested values were laid out at their own level already: only each item's first line needs indenting.
	const pad = "  ".repeat(level + 1);
	return `${open}\n${items.map((i) => pad + i).join(",\n")}\n${"  ".repeat(level)}${close}`;
}

export function format(...args) {
	if (typeof args[0] !== "string") return args.map((a) => fmt(a, 2, new Set(), 0, {})).join(" ");
	let i = 1;
	const first = args[0].replace(/%([sdifjoOc%])/g, (m, c) => {
		if (c === "%") return "%";
		if (i >= args.length) return m;
		const a = args[i++];
		switch (c) {
			case "s":
				return typeof a === "string" ? a : typeof a === "bigint" ? `${a}n` : fmt(a, 1, new Set(), 1, {});
			case "d":
			case "i":
				return typeof a === "bigint" ? `${a}n` : String(c === "i" ? Number.parseInt(a, 10) : Number(a));
			case "f":
				return String(Number.parseFloat(a));
			case "j":
				try {
					return JSON.stringify(a);
				} catch {
					return "[Circular]";
				}
			case "c":
				return "";
			default:
				return fmt(a, c === "O" ? 2 : 4, new Set(), 1, {});
		}
	});
	return [first, ...args.slice(i).map((a) => (typeof a === "string" ? a : fmt(a, 2, new Set(), 0, {})))].join(" ");
}

function isDeepStrictEqual(a, b, seen = new Map()) {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
	if (seen.get(a) === b) return true;
	seen.set(a, b);
	if (a instanceof Date) return a.getTime() === b.getTime();
	if (a instanceof RegExp) return String(a) === String(b);
	if (ArrayBuffer.isView(a)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
	if (a instanceof Map) {
		if (a.size !== b.size) return false;
		for (const [k, v] of a) if (!b.has(k) || !isDeepStrictEqual(v, b.get(k), seen)) return false;
		return true;
	}
	if (a instanceof Set) {
		if (a.size !== b.size) return false;
		for (const v of a) if (!b.has(v)) return false;
		return true;
	}
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => Object.hasOwn(b, k) && isDeepStrictEqual(a[k], b[k], seen));
}

export function createUtil() {
	const promisify = (fn) => {
		if (typeof fn[promisify.custom] === "function") return fn[promisify.custom];
		return (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value))));
	};
	promisify.custom = Symbol.for("nodejs.util.promisify.custom");
	const types = {
		isUint8Array: (x) => x instanceof Uint8Array,
		isTypedArray: (x) => ArrayBuffer.isView(x) && !(x instanceof DataView),
		isArrayBuffer: (x) => x instanceof ArrayBuffer,
		isDate: (x) => x instanceof Date,
		isRegExp: (x) => x instanceof RegExp,
		isMap: (x) => x instanceof Map,
		isSet: (x) => x instanceof Set,
		isPromise: (x) => x instanceof Promise,
		isNativeError: (x) => x instanceof Error,
		isAsyncFunction: (x) => typeof x === "function" && x.constructor?.name === "AsyncFunction",
	};
	return {
		format,
		inspect,
		promisify,
		callbackify: (fn) => (...args) => {
			const callback = args.pop();
			fn(...args).then((v) => callback(null, v), (e) => callback(e));
		},
		inherits(ctor, superCtor) {
			Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
			Object.setPrototypeOf(ctor, superCtor);
			ctor.super_ = superCtor;
		},
		deprecate: (fn) => fn,
		isDeepStrictEqual: (a, b) => isDeepStrictEqual(a, b),
		isArray: Array.isArray,
		isString: (x) => typeof x === "string",
		isNumber: (x) => typeof x === "number",
		isObject: (x) => x !== null && typeof x === "object",
		isFunction: (x) => typeof x === "function",
		types,
		TextEncoder,
		TextDecoder,
		stripVTControlCharacters: (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""),
		styleText: (_style, text) => text,
		parseArgs: () => {
			throw new Error("util.parseArgs isn't available in an isolate's node");
		},
	};
}

export { isDeepStrictEqual };
