// The sandbox Worker's object in a Node worker thread (test/codemode-thread.ts): the same server
// (src/codemode/serve.ts) on a thread of its own, each tool call sent back to the test's thread and answered there, as
// Workers RPC calls the `exchange` stub back into the stack object.
import { parentPort } from "node:worker_threads";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { CodemodeRemoteMessage, CodemodeRemoteReply } from "@earendil-works/pi-codemode/portable";
import { createCodemodeServer } from "../src/codemode/serve.ts";

const port = parentPort;
if (port === null) throw new Error("Run this as a worker thread");
const server = createCodemodeServer(loadQuickJSWasm());
const waiting = new Map<number, { resolve: (reply: CodemodeRemoteReply) => void; reject: (error: Error) => void }>();
let next = 0;

port.on(
	"message",
	(message: { type: string; run?: number; request?: never; seq?: number; reply?: never; error?: string }) => {
		if (message.type === "execute") {
			const run = message.run;
			const exchange = (messages: CodemodeRemoteMessage[]) =>
				new Promise<CodemodeRemoteReply>((resolve, reject) => {
					const seq = next++;
					waiting.set(seq, { resolve, reject });
					port.postMessage({ type: "exchange", run, seq, messages });
				});
			void server.execute(message.request as never, exchange).then(() => port.postMessage({ type: "settled", run }));
			return;
		}
		if (message.type === "reply" && message.seq !== undefined) {
			const pending = waiting.get(message.seq);
			waiting.delete(message.seq);
			if (message.error !== undefined) pending?.reject(new Error(message.error));
			else pending?.resolve(message.reply ?? null);
		}
	},
);
