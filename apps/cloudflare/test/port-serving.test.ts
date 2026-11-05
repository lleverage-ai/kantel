// Exposed ports in the stack object (src/port-serving.ts): the one object also holds every account's API and every
// host's connection, so a port's uploads and answers stay within bounds a client can't push it past, public ports
// included. Over the real router (`@kantel/hosts/ports`) and a fake port whose server is scripted per test.
import type { PortSink, PortStream } from "@kantel/hosts/hub";
import { createPortRouter } from "@kantel/hosts/ports";
import { createMemoryRelayStore } from "@kantel/hosts/relay-store";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	const gated = await router.expose("sbx_1", 4000, { public: false, subdomain: "brave-otter-ab12cd" });
	return { router, url, gatedUrl: gated.url, closed, opened: () => opened };
}

/** A body that counts how often it is read from and whether it was cancelled, and sends `first` then waits. */
function watchedBody(first: string) {
	const seen = { pulls: 0, cancelled: false };
	let sent = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				seen.pulls += 1;
				if (!sent) controller.enqueue(encoder.encode(first));
				sent = true;
				return new Promise(() => undefined);
			},
			cancel() {
				seen.cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	return { body, seen };
}

afterEach(() => {
	vi.useRealTimers();
});

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

	it("reads no body of a request the router refuses, and takes no upload place for it", async () => {
		const { router, gatedUrl } = await exposed((_request, sink) => {
			sink.data(encoder.encode(`${head(2)}ok`));
			sink.end("done");
		});
		const serve = createPortServing(router, { uploads: 1 });
		const nobody = watchedBody("x");
		expect((await serve(post("https://3000-nobody.kantel.run/", nobody.body))).status).toBe(404);
		const wrong = watchedBody("x");
		const bare = new URL(gatedUrl);
		bare.searchParams.set("_token", "A".repeat(43));
		expect((await serve(post(bare.href, wrong.body))).status).toBe(401);
		for (const refused of [nobody, wrong]) {
			expect(refused.seen.pulls).toBe(0);
			expect(refused.seen.cancelled).toBe(true);
		}
		const url = gatedUrl.replace("4000-", "3000-").replace(/\?.*$/, "");
		expect((await serve(post(url, "fine"))).status).toBe(200);
	});

	it("frees an upload's place when it fails, and holds one past the answer timeout until its read is cancelled", async () => {
		const { router, url, opened } = await exposed((_request, sink) => {
			sink.data(encoder.encode(`${head(2)}ok`));
			sink.end("done");
		});
		const serve = createPortServing(router, { uploads: 1, bodyLimit: 8 });
		expect((await serve(post(url, "far too long for it"))).status).toBe(413);
		expect((await serve(post(url, "fits"))).status).toBe(200);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const held = watchedBody("half");
		const answer = serve(post(url, held.body));
		await vi.advanceTimersByTimeAsync(10);
		expect(held.seen.pulls).toBeGreaterThan(0);
		// Its place is held while it is read: another upload waits its turn.
		expect((await serve(post(url, "busy"))).status).toBe(503);
		await vi.advanceTimersByTimeAsync(30_000);
		expect((await answer).status).toBe(504);
		expect(held.seen.cancelled).toBe(true);
		// Nothing of it (nor of the 413 or the 503) reached the sandbox: only "fits" did. And its place is free again.
		expect(opened()).toBe(1);
		vi.useRealTimers();
		expect((await serve(post(url, "next"))).status).toBe(200);
	});

	it("fails an answer whose trailers never end, and closes its host stream; split trailers still complete", async () => {
		let stage = 0;
		const { router, url, closed } = await exposed((_request, sink) => {
			stage += 1;
			sink.data(encoder.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n"));
			if (stage === 1) {
				sink.data(encoder.encode("X-Check: a"));
				sink.data(encoder.encode("bc\r\n\r\n"));
				sink.end("done");
				return;
			}
			for (let i = 0; i < 40; i++) sink.data(encoder.encode("x".repeat(1024)));
		});
		const serve = createPortServing(router);
		const whole = await serve(new Request(url));
		expect(await whole.text()).toBe("hello");
		expect(whole.headers.get("x-check")).toBeNull();
		const endless = await serve(new Request(url));
		await expect(endless.text()).rejects.toThrow(/trailers are too big/);
		expect(closed).toContain(2);
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
