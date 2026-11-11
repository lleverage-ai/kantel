// WebAssembly memory accounting: every byte of wasm memory an isolate has counts against its memory limit, in the
// same budget as its ArrayBuffers (the host's allocator; op_kt_wasm_reserve adds to it).
//
// Wasm memory is outside the V8 heap and isn't allocated through the ArrayBuffer allocator, so the host can't see it
// directly. Instead every way to get or grow one goes through here, installed before any guest code runs and
// impossible to replace (non-writable, non-configurable, frozen):
// - new WebAssembly.Memory(): its initial size is reserved first;
// - Memory.prototype.grow(): the growth is reserved first;
// - compiling a module (new Module, compile, instantiate with bytes): the host parses it (op_kt_wasm_inspect) and
//   refuses one that has a memory.grow instruction (growth that wouldn't come through grow() above), a 64-bit or
//   shared memory, or anything it can't parse; it records the memories the module defines;
// - instantiating (new Instance, instantiate): the initial size of each memory the module defines is reserved first,
//   and the exported ones are tracked so their grow() is counted;
// - Memory.prototype.toResizableBuffer(), which would grow a memory through ArrayBuffer.prototype.resize, is removed.
// The descriptors and byte arrays a guest passes are read once and copied, so it can't show the check one value and
// V8 another. While a guest's code may run (from Pyodide's boot on, in python), the guard uses only intrinsics captured
// before any guest code (primordials.js): no live global, prototype method, getter, iterator or promise resolution
// a guest could replace takes part in counting (review finding H2, and PR #837's review).

import { bufferByteLength, Prim } from "./primordials.js";

const PAGE = 65536;
const MAX_PAGES = 65536;

/**
 * Installs the guard on globalThis.WebAssembly. `ops` are the host's ops (captured here, never exposed). In "boot"
 * mode (python, while Pyodide starts: trusted code only) a shared memory is allowed and the big Pyodide module comes
 * from the host's compiled-module cache; the returned lockdown() ends boot mode for good.
 */
export function installWasmGuard(ops, mode) {
	const WA = globalThis.WebAssembly;
	if (typeof WA !== "object" || WA === null) return () => {};
	let boot = mode === "boot";
	const OrigMemory = WA.Memory;
	const OrigModule = WA.Module;
	const OrigInstance = WA.Instance;
	const OrigCompileError = WA.CompileError;
	const origCompile = WA.compile;
	const origGrow = OrigMemory.prototype.grow;
	const bufferOf = Object.getOwnPropertyDescriptor(OrigMemory.prototype, "buffer").get;
	const exportsOf = Object.getOwnPropertyDescriptor(OrigInstance.prototype, "exports").get;
	const moduleImports = OrigModule.imports;
	const moduleExports = OrigModule.exports;
	const moduleCustomSections = OrigModule.customSections;
	// All intrinsics from Prim (snapshot-time), so a guest can't swap Reflect.apply / WeakMap methods / Number / an
	// iterator / a getter to defeat the accounting (e.g. make `reserved.get(this)` return a huge "already reserved"
	// value, review finding H2).
	const {
		ReflectApply: apply,
		WeakMapGet,
		WeakMapSet,
		WeakMapHas,
		newWeakMap,
		JSONparse,
		ObjectSetPrototypeOf,
		ReflectOwnKeys,
		NumberFn,
		NumberIsInteger,
		StringFn,
		TypeErrorFn,
		RangeErrorFn,
		ArrayBufferIsView,
		arrayBufferByteLength,
		typedArrayBuffer,
		typedArrayByteOffset,
		typedArrayByteLength,
		dataViewBuffer,
		dataViewByteOffset,
		dataViewByteLength,
		newUint8Array,
		uint8Set,
	} = Prim;
	const isMemory = (v) => {
		try {
			apply(bufferOf, v, []);
			return true;
		} catch {
			return false;
		}
	};

	/** Reserved bytes by memory. */
	const reserved = newWeakMap();
	/** What op_kt_wasm_inspect said about each module this isolate compiled. */
	const infos = newWeakMap();

	const limitError = (what) =>
		new RangeErrorFn(`${what}: out of memory (this isolate's memory limit counts WebAssembly memory too)`);
	function reserve(bytes, what) {
		if (bytes <= 0) return;
		if (!ops.op_kt_wasm_reserve(bytes)) throw limitError(what);
	}
	const release = (bytes) => {
		if (bytes > 0) ops.op_kt_wasm_release(bytes);
	};

	/** A page count: a primitive integer from 0 to MAX_PAGES, converted once (a guest's valueOf runs once, here). */
	function pages(value, name) {
		const n = NumberFn(value);
		if (!NumberIsInteger(n) || n < 0 || n > MAX_PAGES)
			throw new TypeErrorFn(`WebAssembly.Memory(): Property '${name}': must be an integer from 0 to ${MAX_PAGES}`);
		return n;
	}

	/** The current size of a memory's buffer, by the captured getters (not ArrayBuffer.prototype.byteLength). */
	const byteLengthOf = (memory) => bufferByteLength(apply(bufferOf, memory, []));

	/**
	 * A private copy of the bytes a guest passes to compile: an ArrayBuffer, a typed array or a DataView, read through
	 * the captured getters and copied into a buffer the guest never sees, so what is inspected is what V8 compiles.
	 */
	function copyBytes(source, what) {
		let buffer;
		let offset = 0;
		let length;
		if (ArrayBufferIsView(source)) {
			try {
				buffer = typedArrayBuffer(source);
				offset = typedArrayByteOffset(source);
				length = typedArrayByteLength(source);
			} catch {
				buffer = dataViewBuffer(source);
				offset = dataViewByteOffset(source);
				length = dataViewByteLength(source);
			}
		} else {
			try {
				length = arrayBufferByteLength(source);
				buffer = source;
			} catch {
				throw new TypeErrorFn(`${what}: Argument 0 must be a buffer source`);
			}
		}
		const out = newUint8Array(length);
		uint8Set(out, newUint8Array(buffer, offset, length));
		return out;
	}

	/** The parsed JSON with every object and array on a null prototype: a key it lacks reads as undefined. */
	const bare = (_key, value) => {
		if (typeof value === "object" && value !== null) ObjectSetPrototypeOf(value, null);
		return value;
	};
	const parseInfo = (json) => JSONparse(json, bare);

	function inspect(bytes, what) {
		const info = parseInfo(ops.op_kt_wasm_inspect(bytes, boot));
		if (info.error !== undefined) throw new OrigCompileError(`${what}: ${info.error}`);
		return info;
	}

	const Memory = function Memory(descriptor) {
		if (new.target === undefined) throw new TypeErrorFn("WebAssembly.Memory must be invoked with 'new'");
		if (typeof descriptor !== "object" || descriptor === null)
			throw new TypeErrorFn("WebAssembly.Memory(): Argument 0 must be a memory descriptor");
		// Each of the guest's fields read once, into locals.
		const initialField = descriptor.initial;
		const rawInitial = initialField !== undefined ? initialField : descriptor.minimum;
		const rawMaximum = descriptor.maximum;
		const shared = !!descriptor.shared;
		const address = descriptor.address ?? descriptor.index;
		if (address !== undefined && StringFn(address) !== "i32")
			throw new TypeErrorFn("WebAssembly.Memory(): only 32-bit memories are available in an isolate");
		if (shared && !boot) throw new TypeErrorFn("WebAssembly.Memory(): shared memory isn't available in an isolate");
		const initial = pages(rawInitial, "initial");
		// Null prototype: V8 reads maximum, shared, address, … from this, and none may come from Object.prototype.
		const clean = { __proto__: null, initial };
		if (rawMaximum !== undefined) clean.maximum = pages(rawMaximum, "maximum");
		if (shared) clean.shared = true;
		reserve(initial * PAGE, "WebAssembly.Memory()");
		let memory;
		try {
			memory = new OrigMemory(clean);
		} catch (error) {
			release(initial * PAGE);
			throw error;
		}
		WeakMapSet(reserved, memory, initial * PAGE);
		return memory;
	};

	function grow(delta) {
		const n = pages(delta, "delta");
		const current = byteLengthOf(this);
		const want = current + n * PAGE;
		const had = WeakMapGet(reserved, this);
		const have = had === undefined ? current : had;
		if (want <= have) return apply(origGrow, this, [n]);
		reserve(want - have, "WebAssembly.Memory.grow()");
		WeakMapSet(reserved, this, want);
		try {
			return apply(origGrow, this, [n]);
		} catch (error) {
			// Not grown (over its maximum, say): give the reservation back.
			release(want - have);
			WeakMapSet(reserved, this, have);
			throw error;
		}
	}

	const Module = function Module(bytes) {
		if (new.target === undefined) throw new TypeErrorFn("WebAssembly.Module must be invoked with 'new'");
		return compileNow(bytes, "WebAssembly.Module()");
	};
	Module.imports = moduleImports;
	Module.exports = moduleExports;
	Module.customSections = moduleCustomSections;

	/** Inspect a private copy of the bytes and compile that copy, synchronously: the module is recorded as compiled. */
	function compileNow(source, what) {
		const copy = copyBytes(source, what);
		const info = inspect(copy, what);
		const module = new OrigModule(copy);
		WeakMapSet(infos, module, info);
		return module;
	}

	/** A buffer source's length in bytes (-1 if it isn't one), by the captured getters. */
	function sourceLength(source) {
		try {
			if (!ArrayBufferIsView(source)) return arrayBufferByteLength(source);
			try {
				return typedArrayByteLength(source);
			} catch {
				return dataViewByteLength(source);
			}
		} catch {
			return -1;
		}
	}

	async function compileBytes(source, what) {
		if (boot && sourceLength(source) > 4 << 20) {
			// Pyodide's own module, once per process: the host keeps it compiled. Boot mode runs only Pyodide's
			// trusted start-up, so this one compiles asynchronously.
			const cached = ops.op_kt_wasm_cached();
			if (cached) {
				WeakMapSet(infos, cached, parseInfo(ops.op_kt_wasm_cached_info()));
				return cached;
			}
			const copy = copyBytes(source, what);
			const info = inspect(copy, what);
			const module = await apply(origCompile, WA, [copy]);
			WeakMapSet(infos, module, info);
			ops.op_kt_wasm_store(module, Prim.JSONstringify(info));
			return module;
		}
		// Compiled synchronously, and recorded before anything is awaited: the module V8 compiled is the one whose
		// memories are recorded. (Awaiting WebAssembly.compile's promise would let an Object.prototype.then getter
		// resolve it with another module, which would then be recorded with this module's memories.)
		return compileNow(source, what);
	}

	function makeInstance(module, imports, what) {
		const info = WeakMapGet(infos, module);
		if (info === undefined) throw new TypeErrorFn(`${what}: Argument 0 must be a WebAssembly.Module`);
		const memories = info.memories;
		let total = 0;
		// An index loop: `for...of` would call the guest's Array.prototype[Symbol.iterator].
		for (let i = 0; i < memories.length; i++) if (!memories[i].imported) total += memories[i].initial * PAGE;
		reserve(total, what);
		let instance;
		try {
			instance = new OrigInstance(module, imports);
		} catch (error) {
			release(total);
			throw error;
		}
		// The memories the module defined are counted from here by their grow(); a defined memory it doesn't export
		// can't grow (no memory.grow instruction) and stays reserved at its initial size.
		const exported = apply(exportsOf, instance, []);
		const names = ReflectOwnKeys(info.memoryExports);
		for (let i = 0; i < names.length; i++) {
			const m = memories[info.memoryExports[names[i]]];
			const value = exported[names[i]];
			if (m !== undefined && !m.imported && isMemory(value) && !WeakMapHas(reserved, value))
				WeakMapSet(reserved, value, m.initial * PAGE);
		}
		return instance;
	}

	const Instance = function Instance(module, imports) {
		if (new.target === undefined) throw new TypeErrorFn("WebAssembly.Instance must be invoked with 'new'");
		return makeInstance(module, imports, "WebAssembly.Instance()");
	};

	const compile = (source) => compileBytes(source, "WebAssembly.compile()");
	async function instantiate(source, imports) {
		const what = "WebAssembly.instantiate()";
		// A module this guard recorded (so compiled from inspected bytes); anything else is compiled as bytes.
		if (WeakMapHas(infos, source)) return makeInstance(source, imports, what);
		// Outside boot, compiled and instantiated with nothing awaited in between.
		const module = boot ? await compileBytes(source, what) : compileNow(source, what);
		return { module, instance: makeInstance(module, imports, what) };
	}
	const bytesOfResponse = async (response) => new Uint8Array(await (await response).arrayBuffer());
	const compileStreaming = async (response) => compile(await bytesOfResponse(response));
	const instantiateStreaming = async (response, imports) => instantiate(await bytesOfResponse(response), imports);

	Memory.prototype = OrigMemory.prototype;
	Module.prototype = OrigModule.prototype;
	Instance.prototype = OrigInstance.prototype;
	const fix = (object, key, value) =>
		Object.defineProperty(object, key, { value, writable: false, enumerable: false, configurable: false });
	fix(OrigMemory.prototype, "constructor", Memory);
	fix(OrigModule.prototype, "constructor", Module);
	fix(OrigInstance.prototype, "constructor", Instance);
	fix(OrigMemory.prototype, "grow", grow);
	if ("toResizableBuffer" in OrigMemory.prototype) delete OrigMemory.prototype.toResizableBuffer;
	for (const proto of [OrigMemory.prototype, OrigModule.prototype, OrigInstance.prototype]) Object.freeze(proto);
	for (const [key, value] of Object.entries({
		Memory,
		Module,
		Instance,
		compile,
		instantiate,
		compileStreaming,
		instantiateStreaming,
	}))
		fix(WA, key, value);
	Object.freeze(WA);
	Object.defineProperty(globalThis, "WebAssembly", {
		value: WA,
		writable: false,
		enumerable: false,
		configurable: false,
	});
	return () => {
		boot = false;
	};
}
