// Node's Buffer, as a Uint8Array subclass: the node runtime's, and a global in the shell for just-bash's gzip.
import { latin1, utf8 } from "./text.js";
import { base64 } from "./web.js";

const core = globalThis.Deno.core;
const HEX = "0123456789abcdef";
const ENCODINGS = [
	"utf8",
	"utf-8",
	"hex",
	"base64",
	"base64url",
	"latin1",
	"binary",
	"ascii",
	"ucs2",
	"ucs-2",
	"utf16le",
	"utf-16le",
];

function encodingOf(enc) {
	const e = String(enc ?? "utf8").toLowerCase();
	if (!ENCODINGS.includes(e)) throw new TypeError(`Unknown encoding: ${enc}`);
	return e;
}

function fromString(s, enc) {
	switch (encodingOf(enc)) {
		case "hex": {
			const n = s.length >> 1;
			const b = new Buffer(n);
			for (let i = 0; i < n; i++) {
				const v = Number.parseInt(s.substr(i * 2, 2), 16);
				if (Number.isNaN(v)) return b.subarray(0, i);
				b[i] = v;
			}
			return b;
		}
		case "base64":
		case "base64url": {
			const clean = s
				.replace(/-/g, "+")
				.replace(/_/g, "/")
				.replace(/[^A-Za-z0-9+/]/g, "");
			const bin = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
			const b = new Buffer(bin.length);
			for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
			return b;
		}
		case "latin1":
		case "binary":
		case "ascii": {
			const b = new Buffer(s.length);
			for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
			return b;
		}
		case "ucs2":
		case "ucs-2":
		case "utf16le":
		case "utf-16le": {
			const b = new Buffer(s.length * 2);
			for (let i = 0; i < s.length; i++) {
				const c = s.charCodeAt(i);
				b[i * 2] = c & 255;
				b[i * 2 + 1] = c >> 8;
			}
			return b;
		}
		default: {
			const u = utf8(s);
			return new Buffer(u.buffer, u.byteOffset, u.byteLength);
		}
	}
}

export class Buffer extends Uint8Array {
	static from(value, encOrOffset, length) {
		if (typeof value === "string") return fromString(value, encOrOffset);
		if (value instanceof ArrayBuffer)
			return new Buffer(value, encOrOffset ?? 0, length ?? value.byteLength - (encOrOffset ?? 0));
		if (ArrayBuffer.isView(value)) {
			const b = new Buffer(value.byteLength);
			b.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
			return b;
		}
		if (Array.isArray(value)) return new Buffer(value.map((x) => x & 255));
		if (value && value.type === "Buffer" && Array.isArray(value.data)) return new Buffer(value.data);
		if (value && typeof value[Symbol.toPrimitive] === "function") return fromString(String(value), encOrOffset);
		throw new TypeError("The first argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.");
	}
	static alloc(size, fill, enc) {
		const b = new Buffer(size);
		if (fill !== undefined && fill !== 0) b.fill(fill, 0, size, enc);
		return b;
	}
	static allocUnsafe(size) {
		return new Buffer(size);
	}
	static allocUnsafeSlow(size) {
		return new Buffer(size);
	}
	static isBuffer(b) {
		return b instanceof Buffer;
	}
	static isEncoding(enc) {
		return ENCODINGS.includes(String(enc).toLowerCase());
	}
	static byteLength(s, enc) {
		if (typeof s !== "string") return s.byteLength;
		const e = encodingOf(enc);
		if (e === "utf8" || e === "utf-8") return utf8(s).byteLength;
		return fromString(s, e).length;
	}
	static compare(a, b) {
		const n = Math.min(a.length, b.length);
		for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
		return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
	}
	static concat(list, total) {
		total ??= list.reduce((n, b) => n + b.length, 0);
		const out = new Buffer(total);
		let p = 0;
		for (const b of list) {
			if (p >= total) break;
			out.set(b.subarray(0, Math.min(b.length, total - p)), p);
			p += b.length;
		}
		return out;
	}
	toString(enc = "utf8", start = 0, end = this.length) {
		const v = this.subarray(Math.max(0, start), Math.min(this.length, end));
		switch (encodingOf(enc)) {
			case "hex": {
				let s = "";
				for (const x of v) s += HEX[x >> 4] + HEX[x & 15];
				return s;
			}
			case "base64":
				return base64(v);
			case "base64url":
				return base64(v).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			case "latin1":
			case "binary":
				return latin1(v);
			case "ascii":
				return latin1(v.map((x) => x & 127));
			case "ucs2":
			case "ucs-2":
			case "utf16le":
			case "utf-16le": {
				let s = "";
				for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode(v[i] | (v[i + 1] << 8));
				return s;
			}
			default:
				return core.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
		}
	}
	toJSON() {
		return { type: "Buffer", data: Array.from(this) };
	}
	equals(other) {
		return Buffer.compare(this, other) === 0;
	}
	compare(other) {
		return Buffer.compare(this, other);
	}
	slice(start, end) {
		return this.subarray(start, end);
	}
	write(s, offset = 0, length, enc) {
		if (typeof offset === "string") [enc, offset] = [offset, 0];
		if (typeof length === "string") [enc, length] = [length, undefined];
		const b = fromString(String(s), enc);
		const n = Math.min(b.length, this.length - offset, length ?? Number.POSITIVE_INFINITY);
		this.set(b.subarray(0, n), offset);
		return n;
	}
	copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
		const part = this.subarray(sourceStart, sourceEnd);
		const n = Math.min(part.length, target.length - targetStart);
		target.set(part.subarray(0, n), targetStart);
		return n;
	}
	fill(value, start = 0, end = this.length, enc) {
		if (typeof start === "string") [enc, start, end] = [start, 0, this.length];
		if (typeof value === "string") {
			const b = fromString(value, enc);
			if (b.length === 0) return super.fill(0, start, end);
			for (let i = start; i < end; i++) this[i] = b[(i - start) % b.length];
			return this;
		}
		return super.fill(typeof value === "boolean" ? Number(value) : value, start, end);
	}
	indexOf(value, from = 0, enc) {
		if (typeof value === "number") return super.indexOf(value, from);
		const needle = typeof value === "string" ? fromString(value, enc) : value;
		outer: for (let i = Math.max(0, from < 0 ? this.length + from : from); i <= this.length - needle.length; i++) {
			for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
			return i;
		}
		return -1;
	}
	includes(value, from, enc) {
		return this.indexOf(value, from, enc) !== -1;
	}
}

const ACCESSORS = [
	["UInt8", "Uint8", 1],
	["Int8", "Int8", 1],
	["UInt16", "Uint16", 2],
	["Int16", "Int16", 2],
	["UInt32", "Uint32", 4],
	["Int32", "Int32", 4],
	["Float", "Float32", 4],
	["Double", "Float64", 8],
	["BigUInt64", "BigUint64", 8],
	["BigInt64", "BigInt64", 8],
];
for (const [name, dv, size] of ACCESSORS) {
	for (const [suffix, little] of size === 1
		? [["", false]]
		: [
				["LE", true],
				["BE", false],
			]) {
		Object.defineProperty(Buffer.prototype, `read${name}${suffix}`, {
			value(offset = 0) {
				return new DataView(this.buffer, this.byteOffset, this.byteLength)[`get${dv}`](offset, little);
			},
			writable: true,
			configurable: true,
		});
		Object.defineProperty(Buffer.prototype, `write${name}${suffix}`, {
			value(value, offset = 0) {
				new DataView(this.buffer, this.byteOffset, this.byteLength)[`set${dv}`](offset, value, little);
				return offset + size;
			},
			writable: true,
			configurable: true,
		});
	}
}
for (const alias of ["Uint8", "Uint16LE", "Uint16BE", "Uint32LE", "Uint32BE", "BigUint64LE", "BigUint64BE"]) {
	const target = alias.replace("Uint", "UInt");
	Buffer.prototype[`read${alias}`] = Buffer.prototype[`read${target}`];
	Buffer.prototype[`write${alias}`] = Buffer.prototype[`write${target}`];
}
