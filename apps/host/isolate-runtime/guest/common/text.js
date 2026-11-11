// TextEncoder and TextDecoder on deno_core's encode/decode. Loaded first: whatwg-url makes one when its module loads.
import { budgetedCopy } from "./budget.js";

const core = globalThis.Deno.core;

class TextEncoder {
	get encoding() {
		return "utf-8";
	}
	encode(input = "") {
		// Budget the bytes (finding H4): a retained TextEncoder().encode(...) must count against the isolate.
		return budgetedCopy(core.encode(String(input)));
	}
	encodeInto(input, dest) {
		const bytes = core.encode(String(input));
		let n = Math.min(bytes.length, dest.length);
		// Don't cut a UTF-8 sequence in half.
		while (n > 0 && n < bytes.length && (bytes[n] & 0xc0) === 0x80) n--;
		dest.set(bytes.subarray(0, n));
		return { read: core.decode(bytes.subarray(0, n)).length, written: n };
	}
}

const LATIN1 = new Set(["latin1", "ascii", "iso-8859-1", "windows-1252", "us-ascii", "binary"]);

export function latin1(bytes) {
	let out = "";
	for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return out;
}

class TextDecoder {
	#encoding;
	#fatal;
	#ignoreBOM;
	constructor(label = "utf-8", options = {}) {
		const name = String(label).trim().toLowerCase();
		this.#encoding = name === "utf8" || name === "unicode-1-1-utf-8" ? "utf-8" : name;
		if (this.#encoding !== "utf-8" && this.#encoding !== "utf-16le" && !LATIN1.has(this.#encoding))
			throw new RangeError(`The "${label}" encoding is not supported`);
		this.#fatal = options?.fatal === true;
		this.#ignoreBOM = options?.ignoreBOM === true;
	}
	get encoding() {
		return this.#encoding;
	}
	get fatal() {
		return this.#fatal;
	}
	get ignoreBOM() {
		return this.#ignoreBOM;
	}
	decode(input) {
		if (input === undefined) return "";
		let bytes =
			input instanceof Uint8Array
				? input
				: ArrayBuffer.isView(input)
					? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
					: new Uint8Array(input);
		if (LATIN1.has(this.#encoding)) return latin1(bytes);
		if (this.#encoding === "utf-16le") {
			let out = "";
			for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
			return out;
		}
		if (!this.#ignoreBOM && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
		const text = core.decode(bytes);
		if (this.#fatal && text.includes("�")) {
			// Valid UTF-8 encodes back to the same bytes; a replaced sequence doesn't.
			const again = core.encode(text);
			if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i]))
				throw new TypeError("The encoded data was not valid for encoding utf-8");
		}
		return text;
	}
}

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
