/**
 * One HTTP request to a server in a sandbox, over the raw byte stream the sandbox's host relays to its port
 * (`HostsService.sandboxes.openPort`): the request written out as HTTP/1.1 with `Connection: close`, and the answer
 * read back into a `Response` whose body streams as it arrives. Written out by hand, as `port-websocket.ts` is, because
 * the gateway runs on Bun, whose `node:http` can't be handed a stream that isn't a socket.
 */
import type { PortSink, PortStream } from "./hub.ts";

export interface PortHttpOptions {
	/** The Host the server sees: the public name it was reached at, so a dev server's host check can pass. */
	readonly host: string;
	/** The path and query the server sees (default the request's). */
	readonly path?: string;
	/** Headers added for the server, such as `x-forwarded-proto`. */
	readonly forwarded?: Readonly<Record<string, string>>;
	/** Cookies the server must not see (Kantel's own). */
	readonly dropCookies?: readonly string[];
	/** How long to wait for the answer's head (default 30 s). */
	readonly headTimeoutMs?: number;
	/** The largest request body passed on (default 32 MiB). */
	readonly maxBodyBytes?: number;
	/**
	 * Takes the answer's body as it arrives instead of the `Response`'s stream, which then carries no bytes and only
	 * ends (or errors) when the body does. Each piece is the caller's to copy into what it owns, and nothing of it is
	 * kept here or queued, so what a sandbox sends is held only as the caller holds it. False, and the answer fails
	 * (502) and its stream is closed.
	 */
	readonly take?: (bytes: Uint8Array) => boolean;
}

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
]);
const MAX_HEAD_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const latin1 = new TextDecoder("latin1");

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

function indexOfCrlfCrlf(bytes: Uint8Array): number {
	for (let i = 0; i + 3 < bytes.length; i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
	}
	return -1;
}

function indexOfCrlf(bytes: Uint8Array, from = 0): number {
	for (let i = from; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
	return -1;
}

/** A header value with no CR or LF, so nothing a client sends can add a header of its own. */
const clean = (value: string) => value.replace(/[\r\n]+/g, " ");

function cookieWithout(header: string, names: readonly string[]): string {
	return header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "" && !names.includes(part.split("=")[0]?.trim() ?? ""))
		.join("; ");
}

/** The request's head and body as the server should see them. */
export async function requestBytes(
	request: Request,
	options: PortHttpOptions,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	const url = new URL(request.url);
	const path = options.path ?? `${url.pathname}${url.search}`;
	if (!path.startsWith("/") || /[\s]/.test(path)) throw new PortHttpError(400, "Not a path");
	const lines = [`${request.method} ${path} HTTP/1.1`, `Host: ${clean(options.host)}`];
	for (const [name, value] of request.headers) {
		if (HOP_BY_HOP.has(name) || name.startsWith("x-forwarded-") || name === "forwarded") continue;
		if (name === "cookie") {
			const kept = cookieWithout(value, options.dropCookies ?? []);
			if (kept !== "") lines.push(`Cookie: ${clean(kept)}`);
			continue;
		}
		lines.push(`${name}: ${clean(value)}`);
	}
	for (const [name, value] of Object.entries(options.forwarded ?? {})) lines.push(`${name}: ${clean(value)}`);
	let body = new Uint8Array(0);
	if (request.body !== null && request.method !== "GET" && request.method !== "HEAD") {
		const limit = options.maxBodyBytes ?? 32 * 1024 * 1024;
		const reader = request.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		// Given up on (the answer timed out, say): the body is cancelled and what was read let go.
		const stop = () => void reader.cancel(signal?.reason).catch(() => undefined);
		if (signal?.aborted) stop();
		signal?.addEventListener("abort", stop, { once: true });
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (signal?.aborted) {
					chunks.length = 0;
					throw signal.reason instanceof Error ? signal.reason : new PortHttpError(504, "The request was given up on");
				}
				if (done) break;
				size += value.length;
				if (size > limit) {
					await reader.cancel();
					throw new PortHttpError(413, "The request body is too big");
				}
				chunks.push(value);
			}
		} finally {
			signal?.removeEventListener("abort", stop);
		}
		body = new Uint8Array(size);
		let at = 0;
		for (const chunk of chunks) {
			body.set(chunk, at);
			at += chunk.length;
		}
		lines.push(`Content-Length: ${size}`);
	}
	lines.push("Connection: close", "", "");
	return concat(encoder.encode(lines.join("\r\n")), body);
}

export class PortHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "PortHttpError";
	}
}

interface Head {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Headers;
}

function parseHead(bytes: Uint8Array): Head {
	const lines = latin1.decode(bytes).split("\r\n");
	const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
	if (match?.[1] === undefined) throw new PortHttpError(502, "The sandbox's server didn't answer HTTP");
	const status = Number(match[1]);
	if (status < 100 || status > 599) throw new PortHttpError(502, "The sandbox's server answered no HTTP status");
	const headers = new Headers();
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		try {
			headers.append(name, value);
		} catch {
			// A header the Fetch API won't take: leave it out.
		}
	}
	return { status, statusText: match[2] ?? "", headers };
}

/**
 * A Set-Cookie from a sandbox, made host-only: without its Domain, a page on one port's name can't set cookies for
 * every sandbox's ports under the same domain.
 */
export function hostOnlyCookie(value: string): string {
	return value
		.split(";")
		.filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
		.join(";");
}

/** The most a chunked answer's trailer section (dropped) may be. */
const MAX_TRAILER_BYTES = 16 * 1024;

/** Undoes `Transfer-Encoding: chunked` as bytes arrive. */
function dechunker(emit: (bytes: Uint8Array) => void, done: () => void, fail: (error: Error) => void) {
	let buffer: Uint8Array = new Uint8Array(0);
	let remaining = -1; // -1: reading a size line; 0..n: bytes of the chunk left; -2: the CRLF after a chunk; -3: trailers
	let finished = false;
	let trailers = 0;
	return (bytes: Uint8Array) => {
		if (finished) return;
		buffer = concat(buffer, bytes);
		for (;;) {
			if (remaining === -1) {
				const end = indexOfCrlf(buffer);
				if (end < 0) {
					if (buffer.length > 4096) fail(new PortHttpError(502, "A chunk's size line is too long"));
					return;
				}
				const size = Number.parseInt(latin1.decode(buffer.subarray(0, end)).split(";")[0]?.trim() ?? "", 16);
				buffer = buffer.subarray(end + 2);
				if (!Number.isFinite(size) || size < 0) return fail(new PortHttpError(502, "A chunk's size isn't a number"));
				remaining = size === 0 ? -3 : size;
			} else if (remaining === -2) {
				if (buffer.length < 2) return;
				buffer = buffer.subarray(2);
				remaining = -1;
			} else if (remaining === -3) {
				// Trailers, which are dropped, end at an empty line. They are never emitted, so they are bounded here.
				const end = indexOfCrlf(buffer);
				if (end < 0) {
					if (trailers + buffer.length > MAX_TRAILER_BYTES) {
						finished = true;
						buffer = new Uint8Array(0);
						fail(new PortHttpError(502, "The answer's trailers are too big"));
					}
					return;
				}
				trailers += end + 2;
				buffer = buffer.subarray(end + 2);
				if (trailers > MAX_TRAILER_BYTES) {
					finished = true;
					buffer = new Uint8Array(0);
					return fail(new PortHttpError(502, "The answer's trailers are too big"));
				}
				if (end === 0) {
					finished = true;
					return done();
				}
			} else {
				if (buffer.length === 0) return;
				const take = Math.min(remaining, buffer.length);
				emit(buffer.slice(0, take));
				buffer = buffer.subarray(take);
				remaining -= take;
				if (remaining === 0) remaining = -2;
			}
		}
	};
}

/**
 * Sends `request` to the server on the other end of `open`'s stream and answers what it says. Rejects with a
 * `PortHttpError` (502, 504, 413) when there's no answer to give.
 */
export function proxyHttp(
	open: (sink: PortSink) => Promise<PortStream>,
	request: Request,
	options: PortHttpOptions,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		let stream: PortStream | undefined;
		let head: Head | undefined;
		let buffer: Uint8Array = new Uint8Array(0);
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let feed: ((bytes: Uint8Array) => void) | undefined;
		let settled = false;
		let ended = false;
		/** Aborted when the proxy fails: the request's body stops being read, and the request is never sent. */
		const given = new AbortController();
		/** Whether the body has a length or chunks, so the stream ending first means it was cut short. */
		let framed = false;
		const timer = setTimeout(
			() => fail(new PortHttpError(504, "The sandbox's server didn't answer in time")),
			options.headTimeoutMs ?? 30_000,
		);

		const fail = (error: Error) => {
			clearTimeout(timer);
			if (!given.signal.aborted) given.abort(error);
			stream?.close();
			if (!settled) {
				settled = true;
				reject(error);
			} else {
				try {
					controller?.error(error);
				} catch {
					// Already closed.
				}
			}
		};
		const close = () => {
			if (ended) return;
			ended = true;
			stream?.close();
			try {
				controller?.close();
			} catch {
				// Already closed or errored.
			}
		};

		const answer = (parsed: Head, rest: Uint8Array) => {
			clearTimeout(timer);
			const noBody = request.method === "HEAD" || parsed.status === 204 || parsed.status === 304;
			const chunked = /\bchunked\b/i.test(parsed.headers.get("transfer-encoding") ?? "");
			const lengthHeader = parsed.headers.get("content-length");
			if (parsed.status < 200) {
				// 101: a switch nobody asked for (upgrades go through `port-websocket.ts`).
				fail(new PortHttpError(502, "The sandbox's server switched protocols"));
				return;
			}
			const length = !chunked && lengthHeader !== null && /^\d+$/.test(lengthHeader.trim()) ? Number(lengthHeader) : -1;
			let left = length;
			framed = chunked || left >= 0;
			const headers = new Headers();
			// Headers' iteration gives each Set-Cookie on its own.
			for (const [name, value] of parsed.headers) {
				if (HOP_BY_HOP.has(name)) continue;
				headers.append(name, name === "set-cookie" ? hostOnlyCookie(value) : value);
			}
			if (left >= 0) headers.set("content-length", String(left));
			settled = true;
			if (noBody) {
				close();
				resolve(new Response(null, { status: parsed.status, statusText: parsed.statusText, headers }));
				return;
			}
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
				},
				cancel() {
					ended = true;
					stream?.close();
				},
			});
			const emit = (bytes: Uint8Array) => {
				if (ended || bytes.length === 0) return;
				if (options.take === undefined) return controller?.enqueue(bytes);
				if (!options.take(bytes)) {
					ended = true;
					fail(new PortHttpError(502, "The sandbox's server sent more than was expected"));
				}
			};
			if (chunked) {
				feed = dechunker(emit, close, fail);
			} else if (left >= 0) {
				feed = (bytes) => {
					const take = bytes.subarray(0, Math.max(0, left));
					left -= take.length;
					emit(take);
					if (left <= 0) close();
				};
			} else {
				feed = emit;
			}
			resolve(new Response(body, { status: parsed.status, statusText: parsed.statusText, headers }));
			if (left === 0) close();
			else if (rest.length > 0) feed(rest);
		};

		const sink: PortSink = {
			data(bytes) {
				if (feed !== undefined) return feed(bytes);
				buffer = concat(buffer, bytes);
				for (;;) {
					const end = indexOfCrlfCrlf(buffer);
					if (end < 0) {
						if (buffer.length > MAX_HEAD_BYTES)
							fail(new PortHttpError(502, "The sandbox's server sent too big a head"));
						return;
					}
					let parsed: Head;
					try {
						parsed = parseHead(buffer.subarray(0, end));
					} catch (error) {
						return fail(error as Error);
					}
					buffer = buffer.subarray(end + 4);
					// 100 Continue and other interim answers: the real one follows.
					if (parsed.status >= 100 && parsed.status < 200 && parsed.status !== 101) continue;
					head = parsed;
					return answer(head, buffer);
				}
			},
			end(reason) {
				if (!settled) return fail(new PortHttpError(502, `The sandbox's server closed without answering: ${reason}`));
				// A body that runs to the end of the stream ends here; one with a length or chunks that's cut short fails.
				if (feed === undefined || ended) return;
				if (framed) fail(new PortHttpError(502, "The sandbox's server stopped mid-answer"));
				else close();
			},
		};

		void requestBytes(request, options, given.signal).then(
			(bytes) => {
				// Given up on while the body was read (timed out): nothing is sent.
				if (given.signal.aborted) return;
				return open(sink).then(
					(opened) => {
						stream = opened;
						if ((settled && ended) || given.signal.aborted) return opened.close();
						opened.write(bytes);
					},
					(error: unknown) =>
						fail(
							new PortHttpError(
								502,
								`Couldn't reach the sandbox's port: ${error instanceof Error ? error.message : String(error)}`,
							),
						),
				);
			},
			(error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
		);
	});
}
