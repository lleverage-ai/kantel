/**
 * Host tools over HTTPS. The runtime calls a host's callback URL with each `HostToolCall`, signed with the secret the
 * host registered; the host checks the signature with `createHostToolEndpoint` (or `verifyHostToolSignature`) and
 * answers with a `HostToolResult`. Aborting the call aborts the request, which aborts the host handler's signal.
 *
 * Signature: `harbour-signature: t=<epoch ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, checked in constant time
 * and refused when `t` is more than five minutes away from the host's clock.
 */
import {
	type Clock,
	KantelError,
	type HostToolCall,
	type HostToolHandler,
	type HostToolResult,
	isKantelError,
	systemClock,
} from "@kantel/contracts";
import { HEADERS, json, MAX_BODY_BYTES } from "./wire.ts";

/** How far a signature's time may be from the verifier's clock. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
	let hex = "";
	for (const byte of mac) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return diff === 0;
}

/** The `harbour-signature` header for `body` at `at`. */
export async function signHostToolCall(secret: string, body: string, at: number): Promise<string> {
	return `t=${at},v1=${await hmacHex(secret, `${at}.${body}`)}`;
}

/** Whether `header` signs `body` with `secret`, within the tolerance of `now`. */
export async function verifyHostToolSignature(
	secret: string,
	body: string,
	header: string | null,
	now: number,
	toleranceMs = SIGNATURE_TOLERANCE_MS,
): Promise<boolean> {
	if (header === null) return false;
	const parts = new Map<string, string>();
	for (const part of header.split(",")) {
		const index = part.indexOf("=");
		if (index > 0) parts.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
	}
	const t = parts.get("t");
	const v1 = parts.get("v1");
	if (t === undefined || v1 === undefined || !/^\d{1,16}$/.test(t)) return false;
	if (Math.abs(now - Number(t)) > toleranceMs) return false;
	return constantTimeEqual(await hmacHex(secret, `${t}.${body}`), v1.toLowerCase());
}

/** Reads a body up to `limit` bytes; longer is `invalid`. */
export async function readBounded(source: Request | Response, limit = MAX_BODY_BYTES): Promise<string> {
	const declared = Number(source.headers.get("content-length") ?? "0");
	if (declared > limit) throw new KantelError("invalid", `The body is longer than ${limit} bytes`);
	if (source.body === null) return "";
	const reader = source.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > limit) {
			await reader.cancel().catch(() => {});
			throw new KantelError("invalid", `The body is longer than ${limit} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export interface CallbackHandlerOptions {
	readonly url: string;
	readonly secret: string;
	readonly fetch?: typeof fetch;
	readonly clock?: Clock;
	/** How long a call may take before it fails. Default ten minutes. */
	readonly timeoutMs?: number;
}

function parseResult(text: string): HostToolResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new KantelError("unavailable", "The host answered with something other than JSON");
	}
	const candidate = parsed as Partial<HostToolResult> | null;
	if (typeof candidate !== "object" || candidate === null || typeof candidate.output !== "string") {
		throw new KantelError("unavailable", "The host's answer has no output");
	}
	return {
		output: candidate.output,
		...(candidate.isError === true ? { isError: true } : {}),
		...(candidate.structured === undefined ? {} : { structured: candidate.structured }),
	};
}

/**
 * A `HostToolHandler` that POSTs each call to `url`, signed, and reads the host's `HostToolResult`. Redirects are not
 * followed. A host that answers with an error status fails the call; the model gets an error result.
 */
export function callbackHostToolHandler(options: CallbackHandlerOptions): HostToolHandler {
	const doFetch = options.fetch ?? fetch;
	const clock = options.clock ?? systemClock;
	const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
	return async (call: HostToolCall, signal: AbortSignal): Promise<HostToolResult> => {
		const body = JSON.stringify(call);
		const timeout = AbortSignal.timeout(timeoutMs);
		const response = await doFetch(
			new Request(options.url, {
				method: "POST",
				body,
				redirect: "manual",
				signal: AbortSignal.any([signal, timeout]),
				headers: {
					"content-type": "application/json; charset=utf-8",
					[HEADERS.signature]: await signHostToolCall(options.secret, body, clock.now()),
					[HEADERS.hostId]: call.hostId,
					[HEADERS.callId]: call.callId,
				},
			}),
		).catch((error: unknown) => {
			if (signal.aborted) throw new KantelError("aborted", "The tool call was aborted");
			if (timeout.aborted) throw new KantelError("unavailable", `The host did not answer within ${timeoutMs} ms`);
			throw new KantelError("unavailable", `The host could not be reached: ${String(error)}`);
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new KantelError("unavailable", `The host answered ${response.status}`);
		}
		return parseResult(await readBounded(response));
	};
}

/**
 * The runtime's `hostHandler` for durable registrations: each stored registration's callback is served by
 * `callbackHostToolHandler` over its URL and secret. Pass the same options the session API calls hosts with.
 */
export function callbackHostHandlers(
	options: Omit<CallbackHandlerOptions, "url" | "secret"> = {},
): (host: { readonly callback?: { readonly url: string; readonly secret: string } }) => HostToolHandler | undefined {
	return (host) =>
		host.callback === undefined
			? undefined
			: callbackHostToolHandler({ ...options, url: host.callback.url, secret: host.callback.secret });
}

export interface HostToolEndpointOptions {
	/** The secret the host registered; a function so it can rotate. */
	readonly secret: string | (() => string | undefined);
	readonly clock?: Clock;
	readonly toleranceMs?: number;
}

/**
 * The host side of a callback: checks the signature, runs `handler` with the request's abort signal, and answers with
 * its result. A bad signature is 401; a handler error is 500 with the error's code only.
 */
export function createHostToolEndpoint(
	handler: HostToolHandler,
	options: HostToolEndpointOptions,
): (request: Request) => Promise<Response> {
	const clock = options.clock ?? systemClock;
	return async (request) => {
		if (request.method !== "POST") return json({ error: { code: "invalid", message: "POST only" } }, 405);
		const secret = typeof options.secret === "string" ? options.secret : options.secret();
		let body: string;
		try {
			body = await readBounded(request);
		} catch {
			return json({ error: { code: "invalid", message: "The body is too long" } }, 413);
		}
		const valid =
			secret !== undefined &&
			(await verifyHostToolSignature(
				secret,
				body,
				request.headers.get(HEADERS.signature),
				clock.now(),
				options.toleranceMs,
			));
		if (!valid) return json({ error: { code: "unauthenticated", message: "Bad signature" } }, 401);
		let call: HostToolCall;
		try {
			call = JSON.parse(body) as HostToolCall;
		} catch {
			return json({ error: { code: "invalid", message: "The call is not JSON" } }, 400);
		}
		try {
			return json(await handler(call, request.signal));
		} catch (error) {
			const code = isKantelError(error) ? error.code : "unavailable";
			return json({ error: { code, message: "The host tool failed" } }, 500);
		}
	};
}
