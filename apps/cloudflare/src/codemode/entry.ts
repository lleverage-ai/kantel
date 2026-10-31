/**
 * The code mode isolate: the module the Worker Loader runs, one isolate per session that runs a script
 * (`src/codemode.ts`). `scripts/build-isolate.ts` bundles it, pi-codemode included, into
 * `generated/codemode.bundle.txt`; QuickJS's WebAssembly comes as its own module, `quickjs.wasm`. The main Worker never
 * imports this file.
 *
 * It has no bindings and no network (`globalOutbound: null`). Its only way out is the `exchange` stub the stack object
 * passes with each script, which answers the script's tool calls.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { CodemodeRemoteExchange, CodemodeRemoteRequest } from "@earendil-works/pi-codemode/portable";
import QUICKJS from "./quickjs.wasm";
import { createCodemodeServer } from "./serve.ts";

const server = createCodemodeServer(QUICKJS);

export class KantelCodemode extends WorkerEntrypoint {
	/** Runs one script; resolves once it has settled or the stack object stopped it. */
	async execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
		return server.execute(request, exchange);
	}
}

export default {
	fetch(): Response {
		return new Response("harbour codemode\n");
	},
};
