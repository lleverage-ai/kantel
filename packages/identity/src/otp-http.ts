/**
 * Email one-time PIN sign-in over HTTP: `POST /auth/otp/start`, `POST /auth/otp/verify` and `POST /auth/session/end`
 * (the paths and bodies are in `packages/contracts/src/identity.ts`). A Fetch-style handler, so it mounts in any
 * Node, Bun or Worker router. It authenticates nothing itself: start and verify are what a person calls before they
 * have credentials.
 */
import {
	authenticationFailureOf,
	KantelError,
	type IdentityErrorResponse,
	isKantelError,
	OTP_START_PATH,
	OTP_VERIFY_PATH,
	type OtpStartResponse,
	type OtpVerifyResponse,
	SESSION_END_PATH,
} from "@kantel/contracts";
import { bearerToken } from "./authenticator.ts";
import type { EmailOtp } from "./otp.ts";

/** Bodies bigger than this are refused before they are parsed. */
const MAX_BODY_BYTES = 4096;

const NO_STORE = { "cache-control": "no-store" };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
	});
}

function errorResponse(status: number, code: string, message: string, headers?: Record<string, string>): Response {
	const body: IdentityErrorResponse = { error: { code, message } };
	return json(status, body, headers);
}

const unauthenticated = (message: string) =>
	errorResponse(401, "unauthenticated", message, { "www-authenticate": `Bearer realm="harbour"` });

/** The JSON object in `request`'s body, or an `invalid` error. */
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
	const tooLarge = () => new KantelError("invalid", "The body is too large");
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) throw tooLarge();
	// Counted as it arrives, so a body with no (or a false) Content-Length is cut off at the limit, not buffered whole.
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body !== null) {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw tooLarge();
			}
			chunks.push(value);
		}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new KantelError("invalid", "The body must be JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new KantelError("invalid", "The body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
	const value = body[name];
	if (typeof value !== "string") throw new KantelError("invalid", `${name} must be a string`);
	return value;
}

export interface OtpHandlerOptions {
	readonly otp: EmailOtp;
}

/**
 * Serves the three routes; any other path is 404, any other method 405. Start is always 202 with the same body for
 * a well-formed email. Verify is 200 with the session, or 401 with one body for every failure. Session end is 204
 * once a session bearer is given. Malformed bodies are 400; an unavailable store or directory is 503; anything else
 * is 500 with no detail. No response echoes a code or a token it was given.
 */
export function createOtpHandler(options: OtpHandlerOptions): (request: Request) => Promise<Response> {
	const { otp } = options;
	return async (request) => {
		const path = new URL(request.url).pathname;
		if (path !== OTP_START_PATH && path !== OTP_VERIFY_PATH && path !== SESSION_END_PATH) {
			return errorResponse(404, "not_found", "No such route");
		}
		if (request.method !== "POST") return errorResponse(405, "invalid", "Use POST", { allow: "POST" });
		try {
			if (path === OTP_START_PATH) {
				const body = await jsonBody(request);
				await otp.start(stringField(body, "email"));
				const accepted: OtpStartResponse = { status: "accepted" };
				return json(202, accepted);
			}
			if (path === OTP_VERIFY_PATH) {
				const body = await jsonBody(request);
				const session = await otp.verify(stringField(body, "email"), stringField(body, "code"));
				const signedIn: OtpVerifyResponse = {
					token: session.token,
					expiresAt: session.expiresAt,
					user: session.signIn.user,
					organisationIds: session.signIn.organisationIds,
				};
				return json(200, signedIn);
			}
			const token = bearerToken(request);
			if (token === undefined) {
				return errorResponse(401, "unauthenticated", "Send the session as a bearer token", {
					"www-authenticate": `Bearer realm="harbour"`,
				});
			}
			await otp.endSession(token);
			return new Response(null, { status: 204, headers: NO_STORE });
		} catch (error) {
			return failed(error, path === OTP_VERIFY_PATH ? "The code is not valid" : "The credentials are not valid");
		}
	};
}

function failed(error: unknown, unauthenticatedMessage: string): Response {
	if (authenticationFailureOf(error) !== undefined) return unauthenticated(unauthenticatedMessage);
	if (isKantelError(error, "invalid")) return errorResponse(400, "invalid", error.message);
	if (isKantelError(error, "unavailable")) return errorResponse(503, "unavailable", "Sign-in is unavailable");
	return errorResponse(500, "internal", "Internal error");
}
