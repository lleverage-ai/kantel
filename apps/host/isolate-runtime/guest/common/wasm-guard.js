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
// V8 another.

import { Prim } from "./primordials.js";

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
	const origCompile = WA.compile;
	const origGrow = OrigMemory.prototype.grow;
	const bufferOf = Object.getOwnPropertyDescriptor(OrigMemory.prototype, "buffer").get;
	const moduleImports = OrigModule.imports;
	const moduleExports = OrigModule.exports;
	const moduleCustomSections = OrigModule.customSections;
	// All intrinsics from Prim (snapshot-time), so a guest can't swap Reflect.apply / WeakMap methods to defeat the
	// accounting (e.g. make `reserved.get(this)` return a huge "already reserved" value, review finding H2).
	const { ReflectApply: apply, WeakMapGet, WeakMapSet, WeakMapHas, newWeakMap, JSONparse, ObjectEntries } = Prim;
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
		new RangeError(`${what}: out of memory (this isolate's memory limit counts WebAssembly memory too)`);
	function reserve(bytes, what) {
		if (bytes <= 0) return;
		if (!ops.op_kt_wasm_reserve(bytes)) throw limitError(what);
	}
	const release = (bytes) => {
		if (bytes > 0) ops.op_kt_wasm_release(bytes);
	};

	function pages(value, name) {
		const n = Number(value);
		if (!Number.isFinite(n) || n < 0 || Math.trunc(n) !== n || n > MAX_PAGES)
			throw new TypeError(`WebAssembly.Memory(): Property '${name}': must be an integer from 0 to ${MAX_PAGES}`);
		return n;
	}

	function copyBytes(source, what) {
		if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
		if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
		throw new TypeError(`${what}: Argument 0 must be a buffer source`);
	}

	function inspect(bytes, what) {
		const info = JSONparse(ops.op_kt_wasm_inspect(bytes, boot));
		if (info.error) throw new WA.CompileError(`${what}: ${info.error}`);
		return info;
	}

	const Memory = function Memory(descriptor) {
		if (new.target === undefined) throw new TypeError("WebAssembly.Memory must be invoked with 'new'");
		if (typeof descriptor !== "object" || descriptor === null)
			throw new TypeError("WebAssembly.Memory(): Argument 0 must be a memory descriptor");
		const rawInitial = descriptor.initial !== undefined ? descriptor.initial : descriptor.minimum;
		const rawMaximum = descriptor.maximum;
		const shared = Boolean(descriptor.shared);
		const address = descriptor.address ?? descriptor.index;
		if (address !== undefined && String(address) !== "i32")
			throw new TypeError("WebAssembly.Memory(): only 32-bit memories are available in an isolate");
		if (shared && !boot) throw new TypeError("WebAssembly.Memory(): shared memory isn't available in an isolate");
		const initial = pages(rawInitial, "initial");
		const clean = { initial };
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
		const current = apply(bufferOf, this, []).byteLength;
		const want = current + n * PAGE;
		const have = WeakMapGet(reserved, this) ?? current;
		if (want > have) {
			reserve(want - have, "WebAssembly.Memory.grow()");
			WeakMapSet(reserved, this, want);
		}
		return apply(origGrow, this, [n]);
	}

	const Module = function Module(bytes) {
		if (new.target === undefined) throw new TypeError("WebAssembly.Module must be invoked with 'new'");
		const copy = copyBytes(bytes, "WebAssembly.Module()");
		const info = inspect(copy, "WebAssembly.Module()");
		const module = new OrigModule(copy);
		WeakMapSet(infos, module, info);
		return module;
	};
	Module.imports = moduleImports;
	Module.exports = moduleExports;
	Module.customSections = moduleCustomSections;

	async function compileBytes(source, what) {
		if (boot && (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) && source.byteLength > 4 << 20) {
			// Pyodide's own module, once per process: the host keeps it compiled.
			const cached = ops.op_kt_wasm_cached();
			if (cached) {
				WeakMapSet(infos, cached, JSONparse(ops.op_kt_wasm_cached_info()));
				return cached;
			}
			const copy = copyBytes(source, what);
			const info = inspect(copy, what);
			const module = await apply(origCompile, WA, [copy]);
			WeakMapSet(infos, module, info);
			ops.op_kt_wasm_store(module, JSON.stringify(info));
			return module;
		}
		const copy = copyBytes(source, what);
		const info = inspect(copy, what);
		const module = await apply(origCompile, WA, [copy]);
		WeakMapSet(infos, module, info);
		return module;
	}

	function makeInstance(module, imports, what) {
		const info = WeakMapGet(infos, module);
		if (info === undefined) throw new TypeError(`${what}: Argument 0 must be a WebAssembly.Module`);
		let total = 0;
		for (const m of info.memories) if (!m.imported) total += m.initial * PAGE;
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
		for (const [name, index] of ObjectEntries(info.memoryExports)) {
			const m = info.memories[index];
			const value = instance.exports[name];
			if (m && !m.imported && isMemory(value) && !WeakMapHas(reserved, value))
				WeakMapSet(reserved, value, m.initial * PAGE);
		}
		return instance;
	}

	const Instance = function Instance(module, imports) {
		if (new.target === undefined) throw new TypeError("WebAssembly.Instance must be invoked with 'new'");
		return makeInstance(module, imports, "WebAssembly.Instance()");
	};

	const compile = (source) => compileBytes(source, "WebAssembly.compile()");
	async function instantiate(source, imports) {
		if (source instanceof OrigModule) return makeInstance(source, imports, "WebAssembly.instantiate()");
		const module = await compileBytes(source, "WebAssembly.instantiate()");
		return { module, instance: makeInstance(module, imports, "WebAssembly.instantiate()") };
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
