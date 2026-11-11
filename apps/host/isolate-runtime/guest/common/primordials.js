// Uncurried intrinsics captured at module-evaluation time — i.e. while the startup snapshot is built, before any
// guest code (user or Pyodide) ever runs. The memory guards (buffer-guard.js, wasm-guard.js) must use these, not the
// live globals: a guest can replace Reflect.construct, WeakMap.prototype.get, Object.defineProperty, Number,
// Math.trunc, an iterator or a getter such as ArrayBuffer.prototype.byteLength and, if a guard looked them up when it
// runs, make it construct a resizable buffer or count less memory than V8 allocates (review findings H2 and #837).
// These bindings can't be swapped: module-local consts holding the originals.
//
// What a guard may do at call time, then: call these; read its own module-local variables; read own data properties
// of objects it made (null-prototype ones, so a missing key can't reach a getter on Object.prototype); and read a
// guest's argument once, copying what it read into its own object before acting on it. Not: `for...of`, spread or
// destructuring of arrays (they call the guest-replaceable Array iterator), `await` or `.then` on a promise whose
// value it trusts (an Object.prototype.then getter can change what a promise resolves with), `instanceof` a
// writable global, or a method or getter looked up on a guest-reachable prototype.

const {
	construct: ReflectConstruct,
	apply: ReflectApply,
	defineProperty: ReflectDefineProperty,
	ownKeys: ReflectOwnKeys,
} = Reflect;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

/** Turn a prototype method into a free function `f(thisArg, ...args)`, immune to later prototype mutation. */
const uncurry =
	(fn) =>
	(thisArg, ...args) =>
		ReflectApply(fn, thisArg, args);
/** The getter of an accessor property, uncurried. */
const getter = (object, key) => uncurry(ObjectGetOwnPropertyDescriptor(object, key).get);
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);

export const Prim = {
	ReflectConstruct,
	ReflectApply,
	ReflectDefineProperty,
	ReflectOwnKeys,
	ObjectDefineProperty,
	ObjectGetOwnPropertyDescriptor,
	ObjectGetPrototypeOf: Object.getPrototypeOf,
	ObjectSetPrototypeOf: Object.setPrototypeOf,
	ObjectFreeze: Object.freeze,
	ObjectEntries: Object.entries,
	NumberFn: Number,
	NumberIsFinite: Number.isFinite,
	NumberIsInteger: Number.isInteger,
	MathTrunc: Math.trunc,
	StringFn: String,
	JSONparse: JSON.parse,
	JSONstringify: JSON.stringify,
	TypeErrorFn: TypeError,
	RangeErrorFn: RangeError,
	// The original ArrayBuffer (before buffer-guard replaces the global): for brand checks a guest can't spoof.
	OrigArrayBuffer: ArrayBuffer,
	ArrayBufferIsView: ArrayBuffer.isView,
	arrayBufferByteLength: getter(ArrayBuffer.prototype, "byteLength"),
	// A typed array's or a DataView's buffer and window, without the guest's getters.
	typedArrayBuffer: getter(TypedArrayPrototype, "buffer"),
	typedArrayByteOffset: getter(TypedArrayPrototype, "byteOffset"),
	typedArrayByteLength: getter(TypedArrayPrototype, "byteLength"),
	dataViewBuffer: getter(DataView.prototype, "buffer"),
	dataViewByteOffset: getter(DataView.prototype, "byteOffset"),
	dataViewByteLength: getter(DataView.prototype, "byteLength"),
	uint8Set: uncurry(Uint8Array.prototype.set),
	uint8Subarray: uncurry(Uint8Array.prototype.subarray),
	// WeakMap methods, uncurried, so a guard's private maps work even if the prototypes are replaced.
	WeakMapGet: uncurry(WeakMap.prototype.get),
	WeakMapSet: uncurry(WeakMap.prototype.set),
	WeakMapHas: uncurry(WeakMap.prototype.has),
	newWeakMap: () => ReflectConstruct(WeakMap, []),
	newUint8Array: (...args) => ReflectConstruct(Uint8Array, args),
	ObjectHasOwn: Object.hasOwn,
};

/**
 * SharedArrayBuffer's byteLength getter, uncurried. SharedArrayBuffer isn't on the global while the snapshot is built,
 * so main.js's init captures it (captureShared) before any guest code runs and before it deletes the global.
 */
let sharedByteLength;
export function captureShared(g) {
	if (sharedByteLength === undefined && typeof g.SharedArrayBuffer === "function")
		sharedByteLength = getter(g.SharedArrayBuffer.prototype, "byteLength");
}

/** The byte length of an ArrayBuffer or a SharedArrayBuffer (a wasm memory's buffer), by the captured getters. */
export function bufferByteLength(buffer) {
	try {
		return Prim.arrayBufferByteLength(buffer);
	} catch (error) {
		if (sharedByteLength === undefined) throw error;
		return sharedByteLength(buffer);
	}
}

Object.freeze(Prim);
