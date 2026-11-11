// Refuse resizable ArrayBuffers and growable SharedArrayBuffers (review finding H2 hardened this). V8 backs a
// resizable/growable buffer with pages from the isolate group's page allocator, NOT the embedder's ArrayBuffer
// allocator, so `new ArrayBuffer(n, {maxByteLength})` / `.resize` / `.grow` bypass the isolate's memory budget. The
// constructors refuse maxByteLength and resize/grow are removed; prototype.constructor is repointed so the
// typed-array species path can't reach the native constructor.
//
// Hardened against guest-mutable intrinsics: every intrinsic used here (Reflect.construct, Object.defineProperty,
// …) is captured from Prim (primordials.js, bound at snapshot time), never looked up on the live global at call
// time — a guest could otherwise replace Reflect.construct, call `new ArrayBuffer(1)` to capture the native
// constructor, and build resizable buffers.
//
// Idempotent and per-constructor: SharedArrayBuffer isn't on the global at snapshot-build time but can be at runtime,
// so this is re-applied at the start of each run; a constructor already wrapped is left alone.
import { Prim } from "./primordials.js";

export function fixBuffers(g = globalThis) {
	const { ReflectConstruct, ReflectOwnKeys, ObjectDefineProperty, ObjectGetOwnPropertyDescriptor, ObjectGetPrototypeOf, ObjectSetPrototypeOf, RangeErrorFn, TypeErrorFn } = Prim;
	for (const name of ["ArrayBuffer", "SharedArrayBuffer"]) {
		const Native = g[name];
		if (typeof Native !== "function" || Native.__ktFixed) continue;
		const grow = name === "ArrayBuffer" ? "resize" : "grow";
		const Fixed = function (length, options) {
			if (new.target === undefined) throw new TypeErrorFn(`Constructor ${name} requires 'new'`);
			if (options !== null && typeof options === "object" && options.maxByteLength !== undefined) {
				throw new RangeErrorFn(`${name}: resizable buffers are not available in an isolate (memory is limited per isolate)`);
			}
			return ReflectConstruct(Native, [length], new.target);
		};
		ObjectDefineProperty(Fixed, "name", { value: name, configurable: true });
		ObjectDefineProperty(Fixed, "length", { value: 1, configurable: true });
		ObjectSetPrototypeOf(Fixed, ObjectGetPrototypeOf(Native));
		for (const key of ReflectOwnKeys(Native)) {
			if (key === "prototype" || key === "length" || key === "name") continue;
			ObjectDefineProperty(Fixed, key, ObjectGetOwnPropertyDescriptor(Native, key));
		}
		ObjectDefineProperty(Fixed, "prototype", { value: Native.prototype, writable: false, enumerable: false, configurable: false });
		Fixed.__ktFixed = true;
		// So `buf.constructor` (used by typed-array species) is the guarded one, not a path back to the native.
		ObjectDefineProperty(Native.prototype, "constructor", { value: Fixed, writable: false, enumerable: false, configurable: false });
		delete Native.prototype[grow];
		// transfer/transferToFixedLength can realloc to a larger length (outside the budget); drop both.
		if (name === "ArrayBuffer") {
			delete Native.prototype.transfer;
			delete Native.prototype.transferToFixedLength;
		}
		ObjectDefineProperty(g, name, { value: Fixed, writable: true, enumerable: false, configurable: true });
	}
}
