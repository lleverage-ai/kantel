// Refuse resizable ArrayBuffers and growable SharedArrayBuffers (adopted from W2's hardening, PR #834). V8 backs a
// resizable/growable buffer with pages from the isolate group's page allocator, NOT the embedder's ArrayBuffer
// allocator, so `new ArrayBuffer(n, {maxByteLength})` / `.resize` / `.grow` bypass the isolate's memory budget
// entirely (W2 measured 1.2 GiB allocated under a 256 MiB budget). The constructors here refuse maxByteLength and
// resize/grow are removed; prototype.constructor is repointed so the typed-array species path can't reach the
// native constructor. This is a JS-level guard — the V8 flag (--no-harmony-rab-gsab, set before platform init) is
// the real fence; this is defence in depth and covers builds where the flag is gone.
//
// Idempotent and per-constructor: SharedArrayBuffer isn't on the global at snapshot-build time but can be at runtime,
// so this is re-applied at the start of each run; a constructor already wrapped is left alone.
export function fixBuffers(g = globalThis) {
	for (const name of ["ArrayBuffer", "SharedArrayBuffer"]) {
		const Native = g[name];
		if (typeof Native !== "function" || Native.__ktFixed) continue;
		const grow = name === "ArrayBuffer" ? "resize" : "grow";
		const Fixed = function (length, options) {
			if (new.target === undefined) throw new TypeError(`Constructor ${name} requires 'new'`);
			if (options !== null && typeof options === "object" && options.maxByteLength !== undefined) {
				throw new RangeError(
					`${name}: resizable buffers are not available in an isolate (memory is limited per isolate)`,
				);
			}
			return Reflect.construct(Native, [length], new.target);
		};
		Object.defineProperty(Fixed, "name", { value: name, configurable: true });
		Object.defineProperty(Fixed, "length", { value: 1, configurable: true });
		Object.setPrototypeOf(Fixed, Object.getPrototypeOf(Native));
		for (const key of Reflect.ownKeys(Native)) {
			if (key === "prototype" || key === "length" || key === "name") continue;
			Object.defineProperty(Fixed, key, Object.getOwnPropertyDescriptor(Native, key));
		}
		Object.defineProperty(Fixed, "prototype", {
			value: Native.prototype,
			writable: false,
			enumerable: false,
			configurable: false,
		});
		Fixed.__ktFixed = true;
		// So `buf.constructor` (used by typed-array species) is the guarded one, not a path back to the native.
		Object.defineProperty(Native.prototype, "constructor", {
			value: Fixed,
			writable: false,
			enumerable: false,
			configurable: false,
		});
		delete Native.prototype[grow];
		// ArrayBuffer.prototype.transfer/transferToFixedLength can realloc; transferring with a larger length would
		// grow outside the budget. Drop the growable transfer entirely (plain transfer of the same size is fine, but
		// the simplest safe thing is to remove both; agent code rarely needs them).
		if (name === "ArrayBuffer") {
			delete Native.prototype.transfer;
			delete Native.prototype.transferToFixedLength;
		}
		Object.defineProperty(g, name, { value: Fixed, writable: true, enumerable: false, configurable: true });
	}
}
