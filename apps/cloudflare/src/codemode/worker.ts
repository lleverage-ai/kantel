/**
 * `kantel-codemode`: the code mode sandbox Worker (`wrangler.codemode.jsonc`), deployed on its own beside the main
 * Worker, which binds its `KantelCodemodeSandbox` class with `script_name`. With `KANTEL_CODEMODE_OFFLOAD=on`
 * (`src/codemode.ts`) each script runs in one of its objects, a new one per script, instead of a Dynamic Worker the
 * stack (or session) object loads.
 *
 * Why a Durable Object of a separately deployed Worker: QuickJS runs synchronously, so a script that computes holds its
 * thread until it calls a tool. A Dynamic Worker loaded by a Durable Object runs on that object's thread, and a class
 * exported by the main Worker can share an isolate, and so a thread, with the stack object (TASK-4487 saw idle objects
 * share one). Only another Worker's object is sure to have a thread of its own. pi-codemode measured a script that
 * computed for 10 s delaying its caller by about 50 ms this way, against the whole 10 s in the caller's object or in a
 * Dynamic Worker it loaded (`@earendil-works/pi-codemode`'s README, "Why a separate Worker").
 *
 * The object only runs the VM: `src/codemode/serve.ts`, the same server and limits the Worker Loader's isolate runs.
 * The caller keeps the tools, the journal, approvals, the deadline and the abort, and answers each tool call the script
 * makes through the `exchange` function it passes with the script, which Workers RPC turns into a stub that calls back
 * into the caller. The object has no bindings, keeps nothing between scripts and never touches its storage; its VM has
 * no `fetch`, timers, modules or I/O, so a script still reaches the world only by calling one of the session's tools.
 *
 * The main Worker never imports this file.
 */
import { DurableObject } from "cloudflare:workers";
import type { CodemodeRemoteExchange, CodemodeRemoteRequest } from "@earendil-works/pi-codemode/portable";
// Compiled by wrangler's default `CompiledWasm` rule: Workers can't compile WebAssembly from bytes at run time.
import QUICKJS from "quickjs-wasi/quickjs.wasm";
import { createCodemodeServer } from "./serve.ts";

const server = createCodemodeServer(QUICKJS);

export class KantelCodemodeSandbox extends DurableObject {
	/** Runs one script; resolves once it has settled or its caller stopped it. Never rejects. */
	async execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
		return server.execute(request, exchange);
	}
}

export default {
	fetch(): Response {
		return new Response("Not found\n", { status: 404 });
	},
};
