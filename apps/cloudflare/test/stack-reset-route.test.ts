// A deploy, or the isolate exceeding its memory limit, resets the stack object under every request in flight
// (src/route.ts `routeRequest`): workerd throws at the stub with an error marked `durableObjectReset` (and `retryable`
// for a lost connection), and thrown it would become Cloudflare's HTML 500 page. The route answers it as
// a JSON 503 with Retry-After instead, so a client waiting on a run's result asks again and gets it once the stack's
// resume() has picked the run up. Any other error is still thrown.
import { describe, expect, it } from "vitest";
import { isTransientObjectError, routeRequest } from "../src/route.ts";

const BASE = "https://kantel.test";

function throwing(error: unknown) {
	return { idFromName: () => "x", get: () => ({ fetch: async () => Promise.reject(error) }) };
}

function marked(message: string, mark: "retryable" | "overloaded" | "durableObjectReset") {
	return Object.assign(new Error(message), { [mark]: true });
}

const ASSETS = { fetch: async () => new Response("missing", { status: 404 }) };

describe("a request the stack object was reset under", () => {
	it("answers a reset as a JSON 503 with Retry-After, not a thrown error", async () => {
		const reset = marked("Durable Object reset because its code was updated.", "retryable");
		const request = new Request(`${BASE}/v1/sessions/s1/result?submission=s1%2F8&timeoutMs=120000`);
		const response = await routeRequest(request, {
			STACK: throwing(reset),
			VAULTS: throwing(new Error("unused")),
			ASSETS,
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("unavailable");
	});

	it("answers a memory reset, which workerd marks durableObjectReset but not retryable, the same way", async () => {
		const reset = marked("Durable Object's isolate exceeded its memory limit and was reset.", "durableObjectReset");
		const response = await routeRequest(new Request(`${BASE}/v1/sessions/s1/result?submission=s1%2F8`), {
			STACK: throwing(reset),
			VAULTS: throwing(new Error("unused")),
			ASSETS,
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
	});

	it("asks a client to wait longer for an overloaded object", async () => {
		const response = await routeRequest(new Request(`${BASE}/v1/sessions`), {
			STACK: throwing(marked("Durable Object is overloaded.", "overloaded")),
			VAULTS: throwing(new Error("unused")),
			ASSETS,
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("10");
	});

	it("still throws any other error", async () => {
		const bug = new Error("a bug");
		await expect(
			routeRequest(new Request(`${BASE}/v1/sessions`), { STACK: throwing(bug), VAULTS: throwing(bug), ASSETS }),
		).rejects.toBe(bug);
		expect(isTransientObjectError(Object.assign(new Error("x"), { retryable: false }))).toBe(false);
		expect(isTransientObjectError("retryable")).toBe(false);
	});
});
