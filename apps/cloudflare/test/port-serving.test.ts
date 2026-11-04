// Exposed ports in the stack object (src/port-serving.ts): the one object also holds every account's API and every
// host's connection, so a port's uploads and answers stay within bounds a client can't push it past, public ports
// included. Over the real router (`@kantel/hosts/ports`) and a fake port whose server is scripted per test.
import type { PortSink, PortStream } from "@kantel/hosts/hub";
import { createPortRouter } from "@kantel/hosts/ports";
import { createMemoryRelayStore } from "@kantel/hosts/relay-store";
import { describe, expect, it } from "vitest";
import { createPortServing } from "../src/port-serving.ts";

const DOMAIN = "kantel.run";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A port whose server is `serve`: called with the request's text once it is all written, and the sink to answer on. */
async function exposed(serve: (request: string, sink: PortSink) => void) {
	const closed: number[] = [];
	let opened = 0;
	const openPort = async (_sandboxId: string, _port: number, sink: PortSink): Promise<PortStream> => {
		const stream = ++opened;
		let request = "";
		return {
			stream,
			write(bytes) {
				request += decoder.decode(bytes);
				queueMicrotask(() => serve(request, sink));
			},
			close() {
				closed.push(stream);
			},
		};
	};
	const router = createPortRouter({ domain: DOMAIN, openPort, store: createMemoryRelayStore() });
	const { url } = await router.expose("sbx_1", 3000, { public: true, subdomain: "brave-otter-ab12cd" });
	return { router, url, closed, opened: () => opened };
}

const head = (length: number, extra = "") => `HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\n${extra}\r\n`;

/** A body that sends `chunks` and then waits until `finish` is called. */
function heldBody(chunks: Uint8Array[]) {
	let finish: () => void = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			finish = () => controller.close();
		},
	});
	return { body, finish: () => finish() };
}

const post = (url: string, body: BodyInit, headers: Record<string, string> = {}) =>
	new Request(url, { method: "POST", body, headers, duplex: "half" } as RequestInit & { duplex: "half" });

describe("exposed ports in the stack object", () => {
	it("passes a page through, and answers 404 while account hosts are off and 501 for a WebSocket", async () => {
		const { router, url } = await exposed((_request, sink) => {
			sink.data(encoder.encode(`${head(5)}hello`));
			sink.end("done");
		});
		const serve = createPortServing(router);
		const answer = await serve(new Request(url));
		expect(answer.status).toBe(200);
		expect(await answer.text()).toBe("hello");
		expect((await serve(new Request(url, { headers: { upgrade: "websocket" } }))).status).toBe(501);
		expect((await serve(new Request("https://3000-nobody.kantel.run/"))).status).toBe(404);
		expect((await createPortServing(undefined)(new Request(url))).status).toBe(404);
	});

	it("keeps a compressed answer's bytes and its Content-Encoding as the sandbox sent them", async () => {
		const gzip = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		const { router, url } = await exposed((_request, sink) => {
			sink.data(encoder.encode(head(gzip.length, "Content-Encoding: gzip\r\n")));
			sink.data(gzip);
			sink.end("done");
		});
		const answer = await createPortServing(router)(new Request(url));
		expect(answer.headers.get("content-encoding")).toBe("gzip");
		expect(new Uint8Array(await answer.arrayBuffer())).toEqual(gzip);
	});

	it("refuses a body past the limit, declared or counted, before or as it is read", async () => {
		const { router, url, opened } = await exposed((request, sink) => {
			sink.data(encoder.encode(`${head(String(request.length).length)}${request.length}`));
			sink.end("done");
		});
		const serve = createPortServing(router, { bodyLimit: 16 });
		const small = await serve(post(url, "0123456789"));
		expect(small.status).toBe(200);
		const declared = await serve(post(url, "x".repeat(17)));
		expect(declared.status).toBe(413);
		const counted = heldBody([encoder.encode("0123456789"), encoder.encode("0123456789")]);
		counted.finish();
		const streamed = await serve(post(url, counted.body));
		expect(streamed.status).toBe(413);
		// Neither too-big body reached the sandbox.
		expect(opened()).toBe(1);
	});

	it("reads at most `uploads` bodies at once, and frees each place once its body is read", async () => {
		const { router, url } = await exposed((_request, sink) => {
			sink.data(encoder.encode(`${head(2)}ok`));
			sink.end("done");
		});
		const serve = createPortServing(router, { uploads: 2 });
		const first = heldBody([encoder.encode("a")]);
		const second = heldBody([encoder.encode("b")]);
		const answers = [serve(post(url, first.body)), serve(post(url, second.body))];
		await new Promise((resolve) => setTimeout(resolve, 10));
		const third = await serve(post(url, "c"));
		expect(third.status).toBe(503);
		expect(third.headers.get("retry-after")).toBe("1");
		first.finish();
		expect((await answers[0])?.status).toBe(200);
		expect((await serve(post(url, "d"))).status).toBe(200);
		second.finish();
		expect((await answers[1])?.status).toBe(200);
	});

	it("cuts off an answer its client has fallen too far behind, and closes its host stream", async () => {
		let sink: PortSink | undefined;
		const { router, url, closed } = await exposed((_request, given) => {
			sink = given;
			given.data(encoder.encode(head(1_000_000)));
		});
		const serve = createPortServing(router, { answerQueueLimit: 1000 });
		const answer = await serve(new Request(url));
		expect(answer.status).toBe(200);
		// The sandbox sends far more than the client reads.
		for (let i = 0; i < 10; i++) sink?.data(new Uint8Array(200));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closed).toEqual([1]);
		await expect(answer.arrayBuffer()).rejects.toThrow(/too far behind/);
	});

	it("cuts off the answer that takes all answers together past the budget", async () => {
		const sinks: PortSink[] = [];
		const { router, url, closed } = await exposed((_request, sink) => {
			sinks.push(sink);
			sink.data(encoder.encode(head(1_000_000)));
		});
		const serve = createPortServing(router, { answerQueueLimit: 1000, answerQueueBudget: 1500 });
		const slow = await serve(new Request(url));
		const slower = await serve(new Request(url));
		sinks[0]?.data(new Uint8Array(800));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closed).toEqual([]);
		sinks[1]?.data(new Uint8Array(800));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closed).toEqual([2]);
		await expect(slower.arrayBuffer()).rejects.toThrow(/too far behind/);
		// The first is still whole: what it holds is handed on as its client reads, and then its place is free.
		const reader = slow.body?.getReader();
		expect((await reader?.read())?.value?.byteLength).toBe(800);
		sinks[0]?.data(new Uint8Array(900));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closed).toEqual([2]);
		expect((await reader?.read())?.value?.byteLength).toBe(900);
		await reader?.cancel();
		expect(closed).toEqual([2, 1]);
	});
});
