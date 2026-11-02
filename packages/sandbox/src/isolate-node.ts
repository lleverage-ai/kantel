/**
 * JavaScript in the isolate tier: a `node` program for the isolate shell that runs a script in QuickJS, compiled to
 * WebAssembly, inside the shell's own process. A host without a container tier (Cloudflare) installs it so an agent
 * can write a script with `write` and run it with `bash` (`node script.js`), on the session's isolate lease like any
 * other command.
 *
 * It is plain JavaScript (ES2023), not Node: there is `console`, `process.argv`, `process.env`, `process.exit`,
 * `process.stdout.write` and `process.stderr.write`, and nothing else from Node. `require`, `fs`, the network, timers
 * and npm packages are not there; a script reads its input from its arguments, and the shell around it does the rest
 * (`node gen.js > out.txt`, `node a.js | sort`).
 *
 * Each run gets its own WebAssembly instance with its own memory, dropped when the run ends, so nothing outlives a
 * command and a script that breaks the engine breaks only its own run. Instantiating the compiled module takes a few
 * milliseconds.
 *
 * Limits, for each run: `memoryBytes` of QuickJS heap inside a WebAssembly memory that can't grow past
 * `memoryBytes + NODE_MEMORY_HEADROOM_BYTES` (QuickJS's own limit misses some large allocations), `stackBytes` of stack,
 * `maxScriptBytes` of script and `maxOutputBytes` of output. Time is counted in interrupt checks, not on the clock:
 * Workers stop the clock while code runs, so a busy loop never sees a deadline pass. QuickJS checks for an interrupt
 * every few thousand operations, and a run stops (exit code 124) after `maxInterrupts` of them, a few seconds of busy
 * CPU, or at the next check once the command is cancelled.
 */

import variant from "@jitl/quickjs-wasmfile-release-sync";
import { DEFAULT_TIER_ROUTES, type TierRoute } from "@kantel/contracts";
import type { CustomCommand } from "just-bash/browser";
import {
	type CustomizeVariantOptions,
	newQuickJSWASMModuleFromVariant,
	newVariant,
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSWASMModule,
} from "quickjs-emscripten-core";

/** The route that sends a command starting with `node` to the isolate, for a host that installs the command. */
export const ISOLATE_NODE_ROUTE: TierRoute = { tool: "bash", programs: ["node"], tier: "isolate" };

/** The default table with `node` in the isolate. */
export const ISOLATE_NODE_ROUTES: readonly TierRoute[] = [ISOLATE_NODE_ROUTE, ...DEFAULT_TIER_ROUTES];

export const NODE_MEMORY_BYTES = 24 * 1024 * 1024;
/** What the WebAssembly memory may hold beyond the QuickJS heap: the engine's own data and stack. */
export const NODE_MEMORY_HEADROOM_BYTES = 8 * 1024 * 1024;
export const NODE_STACK_BYTES = 1024 * 1024;
export const NODE_MAX_SCRIPT_BYTES = 1024 * 1024;
export const NODE_MAX_OUTPUT_BYTES = 1024 * 1024;
/** A few seconds of a busy loop. */
export const NODE_MAX_INTERRUPTS = 5_000;
/** The smallest memory the engine starts in (its build's initial memory). */
const INITIAL_MEMORY_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 64 * 1024;
/** The WebAssembly global, which this package's types (ES2023, no DOM) know only as a namespace of types. */
const Wasm = (
	globalThis as unknown as {
		readonly WebAssembly: {
			readonly Memory: new (descriptor: {
				initial: number;
				maximum: number;
			}) => NonNullable<CustomizeVariantOptions["wasmMemory"]>;
		};
	}
).WebAssembly;

export interface IsolateNodeOptions {
	/**
	 * The compiled QuickJS module (the package's `@jitl/quickjs-wasmfile-release-sync/wasm`), as a Worker imports it.
	 * Absent, each run loads and compiles the package's file itself, which only works where it can read files (Node).
	 */
	readonly wasmModule?: WebAssembly.Module | (() => Promise<WebAssembly.Module>);
	readonly memoryBytes?: number;
	readonly stackBytes?: number;
	readonly maxScriptBytes?: number;
	readonly maxOutputBytes?: number;
	readonly maxInterrupts?: number;
}

type Result = { stdout: string; stderr: string; exitCode: number };

const USAGE = "Usage: node <script.js> [args...] | node -e <code> | node -p <expression>\n";
/** What `node --version` prints: not a Node version, so nothing mistakes this for Node. */
export const NODE_VERSION = "v0.0.0-quickjs";

/** Builds `console` and `process` in the context, from the two host functions and the run's arguments. */
const PRELUDE = String.raw`(function (setup) {
	const write = globalThis.__kantel_write;
	const exit = globalThis.__kantel_exit;
	delete globalThis.__kantel_write;
	delete globalThis.__kantel_exit;
	const EXIT = { kantelExit: true };
	function inspect(value, depth, seen, nested) {
		if (typeof value === "string") return nested ? "'" + value.replace(/'/g, "\\'") + "'" : value;
		if (typeof value === "bigint") return value + "n";
		if (typeof value === "symbol") return value.toString();
		if (typeof value === "function") return "[Function: " + (value.name || "(anonymous)") + "]";
		if (value === null || typeof value !== "object") return String(value);
		if (value instanceof Error) return value.stack ? value.name + ": " + value.message + "\n" + value.stack.replace(/\n$/, "") : value.name + ": " + value.message;
		if (seen.includes(value)) return "[Circular]";
		if (value instanceof Date) return value.toISOString();
		if (value instanceof RegExp) return String(value);
		if (depth > 2) return Array.isArray(value) ? "[Array]" : "[Object]";
		const inner = seen.concat([value]);
		const show = (item) => inspect(item, depth + 1, inner, true);
		if (Array.isArray(value)) return value.length === 0 ? "[]" : "[ " + value.map(show).join(", ") + " ]";
		if (value instanceof Map) return "Map(" + value.size + ") {" + (value.size === 0 ? "}" : " " + [...value].map(([k, v]) => show(k) + " => " + show(v)).join(", ") + " }");
		if (value instanceof Set) return "Set(" + value.size + ") {" + (value.size === 0 ? "}" : " " + [...value].map(show).join(", ") + " }");
		const keys = Object.keys(value);
		const name = value.constructor && value.constructor !== Object && value.constructor.name ? value.constructor.name + " " : "";
		if (keys.length === 0) return name + "{}";
		const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : "'" + k + "'");
		return name + "{ " + keys.map((k) => key(k) + ": " + show(value[k])).join(", ") + " }";
	}
	const format = (args) => args.map((arg) => inspect(arg, 0, [], false)).join(" ");
	const out = (...args) => { write(1, format(args) + "\n"); };
	const err = (...args) => { write(2, format(args) + "\n"); };
	globalThis.console = { log: out, info: out, debug: out, error: err, warn: err, trace: err, dir: (value) => write(1, inspect(value, 0, [], true) + "\n") };
	globalThis.process = {
		argv: setup.argv,
		env: setup.env,
		platform: "kantel",
		version: setup.version,
		versions: { quickjs: setup.quickjs },
		exitCode: undefined,
		cwd: () => setup.cwd,
		exit(code) {
			exit(code === undefined ? (globalThis.process.exitCode ?? 0) : Number(code) | 0);
			throw EXIT;
		},
		stdout: { write(text) { write(1, String(text)); return true; } },
		stderr: { write(text) { write(2, String(text)); return true; } },
	};
	globalThis.require = (name) => {
		throw new Error("Cannot find module '" + name + "': this node runs plain JavaScript in the isolate, without Node's modules");
	};
	globalThis.__kantel_inspect = (value) => inspect(value, 0, [], true);
})`;

/** A `node` program for the isolate shell (`ShellOptions.commands`). */
export function createIsolateNodeCommand(options: IsolateNodeOptions): CustomCommand {
	const memoryBytes = options.memoryBytes ?? NODE_MEMORY_BYTES;
	const pages = (bytes: number) => Math.ceil(bytes / PAGE_BYTES);
	const maximum = pages(Math.max(INITIAL_MEMORY_BYTES, memoryBytes + NODE_MEMORY_HEADROOM_BYTES));
	/** A fresh engine, in its own capped memory, for one run. */
	const engine = (): Promise<QuickJSWASMModule> =>
		newQuickJSWASMModuleFromVariant(
			newVariant(variant, {
				wasmMemory: new Wasm.Memory({ initial: pages(INITIAL_MEMORY_BYTES), maximum }),
				...(options.wasmModule === undefined ? {} : { wasmModule: options.wasmModule }),
			}),
		);
	const maxScriptBytes = options.maxScriptBytes ?? NODE_MAX_SCRIPT_BYTES;

	return {
		name: "node",
		async execute(args, ctx): Promise<Result> {
			const first = args[0];
			if (first === "-v" || first === "--version") return { stdout: `${NODE_VERSION}\n`, stderr: "", exitCode: 0 };
			if (first === "-h" || first === "--help") return { stdout: USAGE, stderr: "", exitCode: 0 };
			let code: string;
			let filename: string;
			let print = false;
			let rest: string[];
			if (first === "-e" || first === "--eval" || first === "-p" || first === "--print") {
				const given = args[1];
				if (given === undefined) return { stdout: "", stderr: `node: ${first} requires an argument\n`, exitCode: 9 };
				code = given;
				filename = "[eval]";
				print = first === "-p" || first === "--print";
				rest = args.slice(2);
			} else if (first === undefined || first === "-") {
				return {
					stdout: "",
					stderr: `node: give a script file or -e; this node has no REPL and reads no script from stdin\n${USAGE}`,
					exitCode: 9,
				};
			} else if (first.startsWith("-")) {
				return { stdout: "", stderr: `node: bad option: ${first}\n${USAGE}`, exitCode: 9 };
			} else {
				filename = ctx.fs.resolvePath(ctx.cwd, first);
				try {
					const stat = await ctx.fs.stat(filename);
					if (stat.isDirectory) throw new Error("directory");
					if (stat.size > maxScriptBytes) {
						return {
							stdout: "",
							stderr: `node: ${first} is ${stat.size} bytes; a script here may be at most ${maxScriptBytes}\n`,
							exitCode: 1,
						};
					}
					code = await ctx.fs.readFile(filename);
				} catch {
					return { stdout: "", stderr: `node: Cannot find module '${filename}'\n`, exitCode: 1 };
				}
				rest = args.slice(1);
			}
			if (code.startsWith("#!")) code = `//${code.slice(2)}`;
			const quickjs = await engine();
			return run(
				quickjs,
				{ ...options, memoryBytes },
				{
					code,
					filename,
					print,
					module: filename.endsWith(".mjs"),
					argv: ["node", ...(filename === "[eval]" ? [] : [filename]), ...rest],
					env: { ...(ctx.exportedEnv ?? {}) },
					cwd: ctx.cwd,
					...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
				},
			);
		},
	};
}

interface Run {
	readonly code: string;
	readonly filename: string;
	readonly print: boolean;
	readonly module: boolean;
	readonly argv: readonly string[];
	readonly env: Record<string, string>;
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

function run(quickjs: QuickJSWASMModule, options: IsolateNodeOptions, input: Run): Result {
	const maxOutput = options.maxOutputBytes ?? NODE_MAX_OUTPUT_BYTES;
	const maxInterrupts = options.maxInterrupts ?? NODE_MAX_INTERRUPTS;
	const output = { stdout: "", stderr: "", bytes: 0, truncated: false };
	let exitCode: number | undefined;
	let interrupts = 0;
	let stopped: "cpu" | "cancelled" | undefined;
	const memoryBytes = options.memoryBytes ?? NODE_MEMORY_BYTES;

	const runtime = quickjs.newRuntime();
	runtime.setMemoryLimit(memoryBytes);
	runtime.setMaxStackSize(options.stackBytes ?? NODE_STACK_BYTES);
	runtime.setInterruptHandler(() => {
		if (exitCode !== undefined) return true;
		if (input.signal?.aborted === true) {
			stopped = "cancelled";
			return true;
		}
		interrupts += 1;
		if (interrupts > maxInterrupts) {
			stopped = "cpu";
			return true;
		}
		return false;
	});
	const vm = runtime.newContext();
	const write = (fd: number, text: string) => {
		if (output.truncated) return;
		const room = maxOutput - output.bytes;
		const kept = text.length > room ? text.slice(0, Math.max(0, room)) : text;
		output.bytes += kept.length;
		if (fd === 2) output.stderr += kept;
		else output.stdout += kept;
		if (kept.length < text.length) output.truncated = true;
	};
	try {
		const writeFn = vm.newFunction("__kantel_write", (fd, text) => {
			write(vm.getNumber(fd), vm.getString(text));
		});
		vm.setProp(vm.global, "__kantel_write", writeFn);
		writeFn.dispose();
		const exitFn = vm.newFunction("__kantel_exit", (code) => {
			exitCode = vm.getNumber(code);
		});
		vm.setProp(vm.global, "__kantel_exit", exitFn);
		exitFn.dispose();
		const setup = JSON.stringify({
			argv: input.argv,
			env: input.env,
			cwd: input.cwd,
			version: NODE_VERSION,
			quickjs: "2025-09-13",
		});
		vm.unwrapResult(vm.evalCode(`${PRELUDE}(${setup})`, "kantel:prelude")).dispose();

		const evaluated = vm.evalCode(input.code, input.filename, { type: input.module ? "module" : "global" });
		let failure: QuickJSHandle | undefined;
		let value: QuickJSHandle | undefined;
		if (evaluated.error === undefined) value = evaluated.value;
		else failure = evaluated.error;

		// Promises and their callbacks run until none is left, within the same budget.
		while (failure === undefined && exitCode === undefined && stopped === undefined) {
			const jobs = runtime.executePendingJobs();
			if (jobs.error !== undefined) {
				failure = jobs.error;
				break;
			}
			if (jobs.value === 0) break;
		}
		if (failure === undefined && value !== undefined && exitCode === undefined && stopped === undefined) {
			const state = vm.getPromiseState(value);
			if (state.type === "rejected") failure = state.error;
			else if (state.type === "fulfilled") {
				if (input.print) write(1, `${show(vm, state.value)}\n`);
				if (!state.notAPromise) state.value.dispose();
			}
		}
		value?.dispose();
		if (failure !== undefined) {
			if (exitCode === undefined && stopped === undefined) {
				write(2, `${describeError(vm, failure, input.filename, memoryBytes)}\n`);
				exitCode = 1;
			}
			failure.dispose();
		}
	} catch (error) {
		// The engine itself failed (its memory is full, say). This run's instance is dropped with it.
		if (stopped === undefined) {
			write(2, `node: the engine stopped: ${error instanceof Error ? error.message : String(error)}\n`);
			exitCode = 1;
		}
	} finally {
		try {
			vm.dispose();
			runtime.dispose();
		} catch {
			// A broken engine may fail to free itself; its whole instance goes when this run ends.
		}
	}
	let stderr = output.stderr;
	if (output.truncated) stderr += `node: output stopped at ${maxOutput} bytes\n`;
	if (stopped === "cpu") {
		stderr += "node: the script was stopped: it used up its CPU budget\n";
		return { stdout: output.stdout, stderr, exitCode: 124 };
	}
	if (stopped === "cancelled") {
		stderr += "node: the script was stopped\n";
		return { stdout: output.stdout, stderr, exitCode: 124 };
	}
	return { stdout: output.stdout, stderr, exitCode: exitCode ?? 0 };
}

/** A value as `console.log` would show it nested, for `-p`. */
function show(vm: QuickJSContext, handle: QuickJSHandle): string {
	const inspect = vm.getProp(vm.global, "__kantel_inspect");
	try {
		const shown = vm.callFunction(inspect, vm.undefined, handle);
		if (shown.error !== undefined) {
			shown.error.dispose();
			return String(vm.dump(handle));
		}
		const text = vm.getString(shown.value);
		shown.value.dispose();
		return text;
	} finally {
		inspect.dispose();
	}
}

/** An uncaught error, as Node reports one: its stack when it has one, else its name and message. */
function describeError(vm: QuickJSContext, handle: QuickJSHandle, filename: string, memoryBytes: number): string {
	const dumped: unknown = vm.dump(handle);
	// Out of memory too far to make an error, QuickJS throws nothing a script would: null, or an empty string.
	if (dumped === null || dumped === undefined || dumped === "") {
		return `${filename}\nnode: the script stopped, most likely out of memory (its limit is ${memoryBytes >> 20} MiB)`;
	}
	if (dumped !== null && typeof dumped === "object" && "message" in dumped) {
		const error = dumped as { name?: unknown; message?: unknown; stack?: unknown };
		const head = `${String(error.name ?? "Error")}: ${String(error.message)}`;
		const stack = typeof error.stack === "string" ? error.stack.replace(/\n$/, "") : "";
		return stack === "" ? `${filename}\n${head}` : `${filename}\n${head}\n${stack}`;
	}
	return `${filename}\nUncaught ${typeof dumped === "string" ? `'${dumped}'` : JSON.stringify(dumped)}`;
}
