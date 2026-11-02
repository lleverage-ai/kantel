// A stand-in for the `kantel-codemode` Worker's objects (`CODEMODE_SANDBOXES`, src/codemode/worker.ts) in Node: every
// object runs its scripts on one worker thread (test/codemode-thread-worker.ts), not the test's, as the deployed
// objects run on threads other than the stack object's. What crosses is copied, as RPC copies it, and the `exchange`
// function stays on the test's thread, where each tool call runs, as Workers RPC turns it into a stub that calls back.
import { Worker } from "node:worker_threads";
import type {
	CodemodeRemote,
	CodemodeRemoteExchange,
	CodemodeRemoteMessage,
	CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode/portable";
import type { CodemodeSandboxObjects } from "../src/codemode.ts";

export interface ThreadSandboxes extends CodemodeSandboxObjects<string> {
	/** The objects scripts ran in, by name, and the location hint each was asked for. */
	readonly made: { readonly name: string; readonly locationHint?: string }[];
	/** Every message the scripts sent back, in order, and when each arrived (`performance.now()`). */
	readonly messages: CodemodeRemoteMessage[];
	readonly arrived: number[];
	close(): Promise<void>;
}

export function threadSandboxes(): ThreadSandboxes {
	const worker = new Worker(new URL("./codemode-thread-worker.ts", import.meta.url));
	worker.unref();
	const exchanges = new Map<number, CodemodeRemoteExchange>();
	const settled = new Map<number, () => void>();
	const made: { name: string; locationHint?: string }[] = [];
	const messages: CodemodeRemoteMessage[] = [];
	const arrived: number[] = [];
	let runs = 0;
	worker.on("message", (message: { type: string; run: number; seq?: number; messages?: CodemodeRemoteMessage[] }) => {
		if (message.type === "settled") {
			settled.get(message.run)?.();
			settled.delete(message.run);
			exchanges.delete(message.run);
			return;
		}
		const exchange = exchanges.get(message.run);
		const sent = message.messages ?? [];
		messages.push(...sent);
		arrived.push(...sent.map(() => performance.now()));
		if (exchange === undefined) {
			worker.postMessage({ type: "reply", seq: message.seq, reply: { type: "stop" } });
			return;
		}
		exchange(sent).then(
			(reply) => worker.postMessage({ type: "reply", seq: message.seq, reply }),
			(error: unknown) => worker.postMessage({ type: "reply", seq: message.seq, error: String(error) }),
		);
	});
	return {
		made,
		messages,
		arrived,
		idFromName: (name) => name,
		get(id, options) {
			made.push({ name: id, ...(options?.locationHint === undefined ? {} : { locationHint: options.locationHint }) });
			const remote: CodemodeRemote = {
				execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange) {
					const run = runs++;
					exchanges.set(run, exchange);
					return new Promise<void>((resolve) => {
						settled.set(run, resolve);
						worker.postMessage({ type: "execute", run, request });
					});
				},
			};
			return remote;
		},
		close: async () => {
			await worker.terminate();
		},
	};
}
