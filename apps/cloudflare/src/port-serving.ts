/**
 * Exposed ports on the Worker: a request on a port's name (`{port}-{subdomain}.kantel.run`) answered by account hosts'
 * `PortRouter` (`@kantel/hosts/ports`, the self-hosted gateway's), inside the one stack object. That object also holds
 * every account's API and every host's connection, so a port's traffic is kept within bounds a single client can't
 * push it past, public ports included (no sign-in needed to reach them):
 *
 * - **Uploads.** The router's proxy reads a request's whole body before sending it on (`proxyHttp`), so a body is at
 *   most `PORT_BODY_LIMIT` (413 past it, declared or counted), and at most `PORT_UPLOADS` are read at once (503, with
 *   `Retry-After`, past that). A body is read only once the router has let the request in, and its place is held until
 *   its reading has ended and the proxy has sent it or given up (a timed-out proxy cancels it and sends nothing).
 * - **Answers.** Host frames arrive as fast as the sandbox sends them, with no backpressure to the host, and the proxy
 *   queues them for the client. They are taken off that queue as they come and held here, counted: once a client has
 *   fallen `PORT_ANSWER_QUEUE_LIMIT` bytes behind, or all answers together `PORT_ANSWER_QUEUE_BUDGET`, that answer is
 *   cut off (its host stream closed), rather than the object running out of memory.
 * - **Encoding.** The answer's body is the sandbox's bytes as sent, compressed or not, so it leaves with
 *   `encodeBody: "manual"` when it names a `Content-Encoding`: Workers would otherwise compress it again.
 * - **WebSockets** (a dev server's hot reload) are the stack object's, which passes them through with account hosts on
 *   (`StackHosts.socketTarget` and `relay` in `src/compute.ts`); one that reaches here is answered 501.
 *
 * Portable (no `cloudflare:workers`), so the tests run it in Node.
 */
import { PortHttpError } from "@kantel/hosts/port-http";
import type { PortRouter } from "@kantel/hosts/ports";

/** The largest request body passed to a port. */
export const PORT_BODY_LIMIT = 4 * 1024 * 1024;
/** How many request bodies to ports are read at once, across every port. */
export const PORT_UPLOADS = 3;
/** How far one client may fall behind a port's answer before it is cut off. */
export const PORT_ANSWER_QUEUE_LIMIT = 4 * 1024 * 1024;
/** How far all clients together may fall behind. */
export const PORT_ANSWER_QUEUE_BUDGET = 24 * 1024 * 1024;

export interface PortServingLimits {
	readonly bodyLimit?: number;
	readonly uploads?: number;
	readonly answerQueueLimit?: number;
	readonly answerQueueBudget?: number;
}

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
	new Response(`${body}\n`, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
	});

/** Answers requests on port names with `ports` (undefined while account hosts are off: every name is a 404). */
export function createPortServing(
	ports: PortRouter | undefined,
	limits: PortServingLimits = {},
): (request: Request) => Promise<Response> {
	const bodyLimit = limits.bodyLimit ?? PORT_BODY_LIMIT;
	const maxUploads = limits.uploads ?? PORT_UPLOADS;
	const queue = {
		limit: limits.answerQueueLimit ?? PORT_ANSWER_QUEUE_LIMIT,
		budget: limits.answerQueueBudget ?? PORT_ANSWER_QUEUE_BUDGET,
		queued: 0,
	};
	const slots = {
		taken: 0,
		take: () => {
			if (slots.taken >= maxUploads) return false;
			slots.taken += 1;
			return true;
		},
		release: () => {
			slots.taken -= 1;
		},
	};

	return async (request) => {
		if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
			return text(501, "WebSockets to exposed ports aren't relayed on this service yet.");
		}
		if (ports === undefined) return text(404, "No sandbox port is exposed here.");
		const upload = request.body !== null && request.method !== "GET" && request.method !== "HEAD";
		if (upload) {
			if (Number(request.headers.get("content-length") ?? "0") > bodyLimit) {
				await request.body?.cancel().catch(() => undefined);
				return text(413, "The request body is too big");
			}
		}
		const address = request.headers.get("cf-connecting-ip");
		const body = upload ? gatedBody(request, bodyLimit, slots) : undefined;
		let answer: Response | undefined;
		try {
			answer = await ports.fetch(body?.request ?? request, address === null ? undefined : { address });
		} finally {
			// Answered or given up on: a body still unread is cancelled, and its place is free once its reading has ended.
			body?.settled();
		}
		if (body?.refused()) {
			return text(503, "Too many uploads to exposed ports at once; try again shortly.", { "retry-after": "1" });
		}
		if (answer === undefined) return text(404, "No sandbox port is exposed here.");
		const encoded = answer.headers.has("content-encoding");
		if (answer.body === null && !encoded) return answer;
		const init: ResponseInit & { encodeBody?: "manual" } = {
			status: answer.status,
			statusText: answer.statusText,
			headers: answer.headers,
			...(encoded ? { encodeBody: "manual" } : {}),
		};
		return new Response(answer.body === null ? null : boundedQueue(answer.body, queue), init);
	};
}

/**
 * The request with a body read only as the router's proxy asks for it, so nothing is read for a request the router
 * refuses first (a name nobody exposed, a wrong token). Its first read takes one of `slots` (refused, with a 503, when
 * none is free), every read is counted against `limit` (past it, a 413), and the place is held until both the body's
 * reading has ended (read to the end, failed, or cancelled) and the request is `settled`: the proxy holds what it
 * read until it has sent it or given up. `settled` cancels a body still unread.
 */
function gatedBody(
	request: Request,
	limit: number,
	slots: { take(): boolean; release(): void },
): { request: Request; settled(): void; refused(): boolean } {
	const source = (request.body as ReadableStream<Uint8Array>).getReader();
	let size = 0;
	let holding = false;
	let refused = false;
	let read = false;
	let answered = false;
	const release = () => {
		if (holding && read && answered) {
			holding = false;
			slots.release();
		}
	};
	const ended = (cancel: boolean) => {
		if (read) return;
		read = true;
		if (cancel) void source.cancel().catch(() => undefined);
		release();
	};
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (!holding) {
					if (!slots.take()) {
						refused = true;
						ended(true);
						return controller.error(new PortHttpError(503, "Too many uploads to exposed ports at once"));
					}
					holding = true;
				}
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await source.read();
				} catch (error) {
					ended(false);
					return controller.error(error);
				}
				if (chunk.done) {
					ended(false);
					try {
						controller.close();
					} catch {
						// Cancelled while it read.
					}
					return;
				}
				size += chunk.value.byteLength;
				if (size > limit) {
					ended(true);
					return controller.error(new PortHttpError(413, "The request body is too big"));
				}
				controller.enqueue(chunk.value);
			},
			cancel() {
				ended(true);
			},
		},
		{ highWaterMark: 0 },
	);
	const init: RequestInit & { duplex: "half" } = {
		method: request.method,
		headers: request.headers,
		body,
		redirect: "manual",
		duplex: "half",
	};
	return {
		request: new Request(request.url, init),
		settled() {
			answered = true;
			ended(true);
			release();
		},
		refused: () => refused,
	};
}

/**
 * `body` read as fast as it comes, and handed on as the client asks: what the client hasn't taken yet is counted against
 * the answer's `limit` and everyone's `budget`, and past either the answer is cut off (`body` cancelled, which closes
 * its host stream) and the client's stream errors.
 */
function boundedQueue(
	body: ReadableStream<Uint8Array>,
	shared: { readonly limit: number; readonly budget: number; queued: number },
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const held: Uint8Array[] = [];
	let queued = 0;
	let ended = false;
	let failure: Error | undefined;
	let wake: (() => void) | undefined;
	const nudge = () => {
		const waiting = wake;
		wake = undefined;
		waiting?.();
	};
	const release = () => {
		shared.queued -= queued;
		queued = 0;
		held.length = 0;
	};
	const fail = (error: Error) => {
		if (failure !== undefined) return;
		failure = error;
		release();
		void reader.cancel(error).catch(() => undefined);
		nudge();
	};
	void (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done || failure !== undefined) break;
				held.push(value);
				queued += value.byteLength;
				shared.queued += value.byteLength;
				if (queued > shared.limit || shared.queued > shared.budget) {
					return fail(new Error("The client fell too far behind the sandbox's answer"));
				}
				nudge();
			}
		} catch (error) {
			return fail(error instanceof Error ? error : new Error(String(error)));
		}
		ended = true;
		nudge();
	})();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				while (held.length === 0 && !ended && failure === undefined) {
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
				if (failure !== undefined) return controller.error(failure);
				const chunk = held.shift();
				if (chunk === undefined) return controller.close();
				queued -= chunk.byteLength;
				shared.queued -= chunk.byteLength;
				controller.enqueue(chunk);
			},
			cancel() {
				fail(new Error("The client went away"));
			},
		},
		{ highWaterMark: 0 },
	);
}
