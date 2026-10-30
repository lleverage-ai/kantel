// Onboarding's API seam: each call is one call to the public API's onboarding routes, and a refusal rejects with the
// server's own message.
import type { Onboarding } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { createOnboardingHttp } from "./onboarding-http.ts";

const ONBOARDING: Onboarding = {
	organisationId: "org_a",
	status: "active",
	current: "connectors",
	steps: { models: "done", connectors: "pending", session: "pending" },
	updatedAt: 1,
};

/** A fetch that answers with `answer`, and records each call and the credentials it came with. */
function fakeApi(answer: (request: Request) => Response) {
	const calls: string[] = [];
	const credentials: (string | null)[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://harbour.test"), init);
		const url = new URL(request.url);
		const body = request.method === "GET" ? "" : await request.clone().text();
		calls.push(`${request.method} ${url.pathname}${url.search}${body === "" ? "" : ` ${body}`}`);
		credentials.push(request.headers.get("authorization"));
		return answer(request);
	};
	return { calls, credentials, fetch: fetcher as typeof fetch };
}

describe("onboarding on the API", () => {
	it("makes each call one call to the onboarding routes", async () => {
		const api = fakeApi(() => Response.json(ONBOARDING));
		const onboarding = createOnboardingHttp({ fetch: api.fetch, headers: () => ({ authorization: "Bearer t" }) });

		expect(await onboarding.get()).toEqual(ONBOARDING);
		expect(await onboarding.setStep("models", "done")).toEqual(ONBOARDING);
		expect(await onboarding.goTo("models")).toEqual(ONBOARDING);
		expect(await onboarding.dismiss()).toEqual(ONBOARDING);
		expect(await onboarding.reopen()).toEqual(ONBOARDING);
		expect(await onboarding.reopen("session")).toEqual(ONBOARDING);

		expect(api.calls).toEqual([
			"GET /v1/onboarding",
			'PUT /v1/onboarding/steps/models {"status":"done"}',
			'PUT /v1/onboarding/current {"step":"models"}',
			"POST /v1/onboarding/dismiss",
			"POST /v1/onboarding/reopen {}",
			'POST /v1/onboarding/reopen {"step":"session"}',
		]);
		expect(new Set(api.credentials)).toEqual(new Set(["Bearer t"]));
	});

	it("rejects with the server's code and message, and says when the sign-in has ended", async () => {
		const refusal = "Changing onboarding needs an organisation-wide admin.";
		let ended = 0;
		const api = fakeApi((request) =>
			request.method === "GET"
				? Response.json({ error: { code: "unauthenticated", message: "Sign in again." } }, { status: 401 })
				: Response.json({ error: { code: "forbidden", message: refusal } }, { status: 403 }),
		);
		const onboarding = createOnboardingHttp({
			fetch: api.fetch,
			onUnauthenticated: () => {
				ended += 1;
			},
		});

		await expect(onboarding.dismiss()).rejects.toMatchObject({ status: 403, code: "forbidden", message: refusal });
		expect(ended).toBe(0);
		await expect(onboarding.get()).rejects.toThrow("Sign in again.");
		expect(ended).toBe(1);
	});
});
