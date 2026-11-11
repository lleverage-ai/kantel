// kantel-isolate's guest: one classic script, evaluated once into the startup snapshot every isolate is made from
// (V8 can't deserialise isolates from two different snapshots in one process). It has all three runtimes; the host
// calls __kantel.init(kind) once per isolate, keeps the entry points it returns, and from then on the isolate's
// globals have no way to the host's ops: Deno, __bootstrap, __infra and __kantel are gone.
import "./common/web.js";
import { Buffer } from "./common/buffer.js";
import { fixBuffers } from "./common/buffer-guard.js";
import { installWasmGuard } from "./common/wasm-guard.js";
import { createNode } from "./node/index.js";
import { createPython } from "./python/index.js";
import { createShell } from "./shell/index.js";

const core = globalThis.Deno.core;
const ops = core.ops;

const fmt = (v) => {
	if (typeof v === "string") return v;
	if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
};
const logger =
	(level) =>
	(...args) =>
		ops.op_kt_log(level, args.map(fmt).join(" "));
const hostConsole = {
	log: logger(1),
	info: logger(1),
	debug: logger(0),
	warn: logger(2),
	error: logger(3),
	trace: logger(0),
	dir: logger(1),
	time() {},
	timeEnd() {},
	group() {},
	groupEnd() {},
};

function init(kind) {
	// No shared memory and so no way to build a fine timer from a counter (performance.now() is whole
	// milliseconds). Removed here, not in the snapshot: V8 adds to Atomics when it deserialises a context.
	delete globalThis.SharedArrayBuffer;
	delete globalThis.Atomics;
	// Refuse resizable/growable buffers, which would otherwise allocate outside the isolate's memory budget (W2).
	fixBuffers(globalThis);
	globalThis.console = hostConsole;
	let entry;
	if (kind === "shell") {
		// just-bash's gzip wants a Buffer global.
		globalThis.Buffer = Buffer;
		installWasmGuard(ops, "strict");
		entry = createShell(ops);
	} else if (kind === "node") {
		installWasmGuard(ops, "strict");
		entry = createNode(ops);
	} else if (kind === "python") {
		const lockdown = installWasmGuard(ops, "boot");
		entry = { ...createPython(ops), lockdown };
	} else throw new Error(`unknown isolate kind ${kind}`);
	// Every route from guest code to the host's ops: Deno.core.ops, and __bootstrap.core.ops (reachable from Python
	// via `js.__bootstrap`). __infra (promise/queue helpers deno_core keeps) has no ops, so it stays.
	for (const name of ["Deno", "__bootstrap", "__kantel"]) delete globalThis[name];
	return entry;
}

globalThis.__kantel = { init };
