// The HTTP server streams the bodies of the routes that take files of any size (a signed file URL's upload, a bundle,
// an archive) to the handler as they come, with no size cap and only an idle timeout, and reads every other body whole.
import { connect } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
	type FetchHandler,
	type Listening,
	listen,
	streamsRequestBody,
	toStreamedRequest,
} from "../../src/gateway/node-http.ts";

const servers: Listening[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

async function serve(handler: FetchHandler, requestTimeoutMs: number): Promise<Listening> {
	const server = await listen(handler, 0, { host: "127.0.0.1", requestTimeoutMs });
	servers.push(server);
	return server;
}

/** Answers how many bytes of body it read, or 400 when reading failed. */
const counting: FetchHandler = async (request) => {
	try {
		const bytes = await request.arrayBuffer();
		return Response.json({ bytes: bytes.byteLength });
	} catch {
		return new Response(null, { status: 400 });
	}
};

/** Sends `head` and then each of `parts` `gapMs` apart on a raw socket; resolves what came back once it closes. */
function slowly(port: number, head: string, parts: readonly string[], gapMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let received = "";
		const socket = connect(port, "127.0.0.1", () => {
			socket.write(head);
			let index = 0;
			const next = () => {
				const part = parts[index++];
				if (part === undefined || socket.destroyed) return;
				socket.write(part);
				setTimeout(next, gapMs);
			};
			setTimeout(next, gapMs);
		});
		const watchdog = setTimeout(() => {
			socket.destroy();
			reject(new Error("the server never closed the connection"));
		}, 15_000);
		socket.on("data", (data) => {
			received += data.toString();
			// One answer is all a test waits for (a whole JSON body, chunked or not): a kept-alive connection isn't closed.
			if (/\r\n\r\n[\s\S]*(\}|\r\n0\r\n\r\n)$/.test(received)) socket.end();
		});
		socket.on("close", () => {
			clearTimeout(watchdog);
			resolve(received);
		});
		socket.on("error", () => {});
	});
}

describe("which request bodies are streamed", () => {
	it("streams a file URL's upload, a bundle and an archive, whatever the query", () => {
		expect(streamsRequestBody("PUT", "/v1/file-urls/kfu_abc-DEF_123")).toBe(true);
		expect(streamsRequestBody("POST", "/v1/bundles")).toBe(true);
		expect(streamsRequestBody("POST", "/v1/bundles?account=acc_1&digest=sha256:00")).toBe(true);
		expect(streamsRequestBody("PUT", "/v1/sandboxes/sbx_1/files/archive")).toBe(true);
		expect(streamsRequestBody("PUT", "/v1/sandboxes/sbx_1/files/archive?path=/work&strip=1")).toBe(true);
	});

	it("reads every other body whole", () => {
		expect(streamsRequestBody("GET", "/v1/file-urls/kfu_abc")).toBe(false);
		expect(streamsRequestBody("HEAD", "/v1/file-urls/kfu_abc")).toBe(false);
		expect(streamsRequestBody("POST", "/v1/file-urls/kfu_abc")).toBe(false);
		expect(streamsRequestBody("PUT", "/v1/file-urls/kfu_abc/more")).toBe(false);
		expect(streamsRequestBody("PUT", "/v1/file-urls/")).toBe(false);
		expect(streamsRequestBody("GET", "/v1/bundles")).toBe(false);
		expect(streamsRequestBody("POST", "/v1/bundles/sha256:00")).toBe(false);
		expect(streamsRequestBody("PUT", "/v1/bundles")).toBe(false);
		expect(streamsRequestBody("POST", "/v1/sandboxes/sbx_1/files/archive")).toBe(false);
		expect(streamsRequestBody("PUT", "/v1/sandboxes/sbx_1/files")).toBe(false);
		expect(streamsRequestBody("PUT", "/v1/sandboxes/sbx_1/x/files/archive")).toBe(false);
		expect(streamsRequestBody("POST", "/v2/bundles")).toBe(false);
		expect(streamsRequestBody("POST", "/v1/projects")).toBe(false);
		expect(streamsRequestBody(undefined, undefined)).toBe(false);
	});
});

describe("a streamed body", () => {
	it("stops taking from the connection after a bounded number of bytes while nothing reads it", async () => {
		let pulled = 0;
		const incoming = new Readable({
			read() {
				pulled += 1024;
				this.push(new Uint8Array(1024));
			},
		});
		const request = toStreamedRequest(incoming, "http://localhost/v1/file-urls/kfu_slow", new AbortController().signal);
		const reader = (request.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
		// Its queue counts bytes, to the request's own high-water mark: counting chunks it would take thousands of them.
		expect(pulled).toBeLessThan(4 * incoming.readableHighWaterMark);
		await reader.cancel();
	});

	it("has no size cap: 6 MiB, more than any buffered body may be, reaches the handler whole", async () => {
		const server = await serve(counting, 5_000);
		const size = 6 * 1024 * 1024;
		const response = await fetch(`${server.url}/v1/file-urls/kfu_big`, { method: "PUT", body: new Uint8Array(size) });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ bytes: size });
		// The same size on any other route is refused.
		const buffered = await fetch(`${server.url}/v1/projects`, { method: "POST", body: new Uint8Array(size) }).catch(
			() => undefined,
		);
		if (buffered !== undefined) expect(buffered.status).toBe(413);
	});

	it("may take longer than the timeout in all, while it keeps coming", async () => {
		const server = await serve(counting, 500);
		const parts = ["aaaa", "bbbb", "cccc", "dddd", "eeee"];
		const head = `PUT /v1/bundles HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 20\r\n\r\n`;
		// The bundles route streams only a POST; this PUT is read whole, so it is cut off at the deadline as before.
		const cut = await slowly(server.port, head, parts, 300);
		expect(cut).not.toContain("200 OK");
		const streamed = await slowly(server.port, head.replace("PUT", "POST"), parts, 300);
		expect(streamed).toContain("200 OK");
		expect(streamed).toContain('{"bytes":20}');
	}, 20_000);

	it("is cut off once it stops arriving for the timeout", async () => {
		const server = await serve(counting, 500);
		const started = Date.now();
		const answer = await slowly(
			server.port,
			`PUT /v1/sandboxes/sbx_1/files/archive?path=/work HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nhalf`,
			[],
			0,
		);
		// The 408 may be lost as the connection is dropped; that it is dropped, and soon, is the point.
		expect(answer).not.toContain("200 OK");
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 20_000);
});
