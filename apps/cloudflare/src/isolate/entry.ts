/**
 * The `dynamic-worker` isolate: the module the Worker Loader runs, one isolate per session's workspace
 * (`src/dynamic-worker.ts`). `scripts/build-isolate.ts` bundles it, just-bash included, into
 * `generated/isolate.bundle.txt`; the main Worker never imports it directly.
 *
 * It has no bindings and no network (`globalOutbound: null`). Its only way to storage is the `WorkspacePort` stub the
 * stack object passes with each command: list a version, read a body, read under a mount, and ask whether the caller
 * has cancelled. It can't write: changes go back in the result for the stack to commit.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ShellRequest } from "@kantel/sandbox/isolate";
import {
	createIsolateRunner,
	type IsolateExecOptions,
	type IsolateLife,
	type IsolateOutcome,
	type IsolatePort,
} from "./runner.ts";

const runner = createIsolateRunner();

export class KantelIsolate extends WorkerEntrypoint {
	async exec(port: IsolatePort, request: ShellRequest, options?: IsolateExecOptions): Promise<IsolateOutcome> {
		return runner.exec(port, request, options);
	}

	/** When this isolate booted and how many commands it has run. */
	async ping(): Promise<IsolateLife> {
		return runner.ping();
	}
}

export default {
	fetch(): Response {
		return new Response("kantel isolate\n");
	},
};
