// Uncurried intrinsics captured at module-evaluation time — i.e. while the startup snapshot is built, before any
// guest code (user or Pyodide) ever runs. The memory guards (buffer-guard.js, wasm-guard.js, budget.js) must use
// these, not the live globals: a guest can replace Reflect.construct, WeakMap.prototype.get, Object.defineProperty,
// etc. and, if a guard looked them up dynamically, make it construct a resizable buffer or believe growth is
// already reserved (review finding H2). These bindings can't be swapped: module-local consts holding the originals.

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
	MathTrunc: Math.trunc,
	JSONparse: JSON.parse,
	JSONstringify: JSON.stringify,
	TypeErrorFn: TypeError,
	RangeErrorFn: RangeError,
	// The original ArrayBuffer (before buffer-guard replaces the global): for brand checks a guest can't spoof.
	OrigArrayBuffer: ArrayBuffer,
	ArrayBufferIsView: ArrayBuffer.isView,
	arrayBufferByteLength: uncurry(ObjectGetOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get),
	uint8Set: uncurry(Uint8Array.prototype.set),
	uint8Subarray: uncurry(Uint8Array.prototype.subarray),
	// WeakMap methods, uncurried, so a guard's private maps work even if the prototypes are replaced.
	WeakMapGet: uncurry(WeakMap.prototype.get),
	WeakMapSet: uncurry(WeakMap.prototype.set),
	WeakMapHas: uncurry(WeakMap.prototype.has),
	newWeakMap: () => ReflectConstruct(WeakMap, []),
	newUint8Array: (...args) => ReflectConstruct(Uint8Array, args),
};

Object.freeze(Prim);
