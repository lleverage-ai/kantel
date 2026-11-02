/**
 * What the code mode isolate runs (`entry.ts`), kept free of `cloudflare:workers` so the tests run it in Node.
 *
 * One call runs one script: pi-codemode's remote end (`serveCodemodeRemote`) starts a QuickJS VM on this isolate's
 * thread and sends each tool call the script makes back through `exchange`, the function the stack object passed with
 * the call. The tools themselves never run here: the stack object runs each one as the session's agent and answers the
 * exchange with its result. The VM has no timers, I/O or `fetch`, and the isolate around it has no bindings and no
 * network, so a script's only way out is a tool call.
 *
 * The limits apply whatever the caller asks for: `CODEMODE_INTERRUPT_BUDGET` bounds how much a script may compute in
 * all (the isolate shares the stack object's thread, see `src/codemode.ts`), and `CODEMODE_MEMORY_LIMIT_BYTES` the
 * VM's heap.
 */
import {
	type CodemodeRemote,
	type CodemodeRemoteExchange,
	type CodemodeRemoteRequest,
	type CodemodeWasmModule,
	serveCodemodeRemote,
} from "@earendil-works/pi-codemode/portable";

/**
 * Interrupt polls one script may make, counted over its whole run: pi-codemode's in-thread launcher never resets the
 * count, so tool calls between computations don't renew it. Past it the script fails with "Execution exceeded its
 * interrupt budget". QuickJS polls by work done, not by time, so what the budget allows in seconds depends on the code:
 * on harbour.myslop.app (2 Nov 2026, TASK-4485) `while (true) {}` was stopped after about 4.3 s, while a Collatz loop
 * over a million numbers computed for about 19 s without reaching it, holding the stack object all that time. Three
 * countdown loops that each fit the budget, with a tool call between each, failed in the third.
 */
export const CODEMODE_INTERRUPT_BUDGET = 50_000;
/** The VM's heap. The isolate has 128 MB in all. */
export const CODEMODE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

/** The code mode isolate's entry point, as the stack object calls it. */
export function createCodemodeServer(wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>): CodemodeRemote {
	return {
		execute: (request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange) =>
			serveCodemodeRemote(request, exchange, {
				wasm,
				maxInterruptBudget: CODEMODE_INTERRUPT_BUDGET,
				maxMemoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
			}),
	};
}
