import { HarbourError } from "@harbour/contracts";
import { createCpaManagement } from "@harbour/models/cpa-management";
import { CANARY_SECRET } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

/** A management key holding the canary, so any leak of it shows. */
const KEY = `mgmt-${CANARY_SECRET}`;

interface Seen {
	readonly url: URL;
	readonly method: string;
	readonly headers: Headers;
	readonly body?: unknown;
}

/** A fetch that records each request and answers with `answer`'s response. */
function fakeFetch(answer: (url: URL) => Response | Promise<Response>) {
	const seen: Seen[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		seen.push({
			url,
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
		});
		return answer(url);
	}) as typeof fetch;
	return { fetcher, seen };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function failure(promise: Promise<unknown>): Promise<HarbourError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof HarbourError) return error;
		throw error;
	}
	throw new Error("It resolved");
}

describe("createCpaManagement", () => {
	it("starts a sign-in under CPA's root, with the management key as a bearer", async () => {
		const { fetcher, seen } = fakeFetch(() =>
			json({ status: "ok", url: "https://claude.ai/oauth/authorize?x=1", state: "anthropic-st1" }),
		);
		const cpa = createCpaManagement({ baseUrl: "http://cpa.internal:8317/v1/", managementKey: KEY, fetch: fetcher });
		expect(await cpa.authUrl("anthropic")).toEqual({
			status: "ok",
			url: "https://claude.ai/oauth/authorize?x=1",
			state: "anthropic-st1",
		});
		await cpa.authUrl("codex");
		expect(seen.map((request) => [request.method, request.url.toString()])).toEqual([
			["GET", "http://cpa.internal:8317/v0/management/anthropic-auth-url?is_webui=true"],
			["GET", "http://cpa.internal:8317/v0/management/codex-auth-url?is_webui=true"],
		]);
		expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
	});

	it("reads a sign-in's status", async () => {
		const answers: unknown[] = [{ status: "wait" }, { status: "ok" }, { status: "error", error: "Timed out" }, {}];
		const { fetcher, seen } = fakeFetch(() => json(answers.shift()));
		const cpa = createCpaManagement({ baseUrl: "http://cpa.internal:8317", managementKey: KEY, fetch: fetcher });
		expect(await cpa.authStatus("st 1&x")).toEqual({ status: "wait" });
		expect(await cpa.authStatus("st")).toEqual({ status: "ok" });
		expect(await cpa.authStatus("st")).toEqual({ status: "error", error: "Timed out" });
		expect((await failure(cpa.authStatus("st"))).code).toBe("unavailable");
		expect(seen[0]?.url.pathname).toBe("/v0/management/get-auth-status");
		expect(seen[0]?.url.searchParams.get("state")).toBe("st 1&x");
	});

	it("hands CPA the redirect address as JSON", async () => {
		const { fetcher, seen } = fakeFetch(() => json({ status: "ok" }));
		const cpa = createCpaManagement({ baseUrl: "http://cpa.internal:8317", managementKey: KEY, fetch: fetcher });
		const redirect = "http://localhost:1455/auth/callback?code=c&state=st";
		expect(await cpa.submitCallback("codex", "st", redirect)).toEqual({ status: "ok" });
		expect(seen[0]).toMatchObject({ method: "POST", body: { provider: "codex", redirect_url: redirect, state: "st" } });
		expect(seen[0]?.url.toString()).toBe("http://cpa.internal:8317/v0/management/oauth-callback");
		expect(seen[0]?.headers.get("content-type")).toBe("application/json");
		expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
	});

	it("lists credential files, keeping only the fields it knows", async () => {
		const { fetcher, seen } = fakeFetch(() =>
			json({
				files: [
					{ id: "a.json", type: "claude", email: "tom@example.com", status: "active", token: "never" },
					{ provider: "codex", label: "Work", disabled: true },
					"not a file",
				],
			}),
		);
		const cpa = createCpaManagement({ baseUrl: "http://cpa.internal:8317", managementKey: KEY, fetch: fetcher });
		expect(await cpa.authFiles()).toEqual({
			files: [
				{ type: "claude", email: "tom@example.com", status: "active" },
				{ provider: "codex", label: "Work", disabled: true },
			],
		});
		expect(seen[0]?.url.toString()).toBe("http://cpa.internal:8317/v0/management/auth-files");
	});

	it("maps a refused key to refused and other failures to unavailable, never quoting the key", async () => {
		for (const status of [401, 403]) {
			const { fetcher } = fakeFetch(() => json({ error: `bad key ${KEY}` }, status));
			const cpa = createCpaManagement({ baseUrl: "http://cpa.internal:8317", managementKey: KEY, fetch: fetcher });
			const error = await failure(cpa.authFiles());
			expect(error.code).toBe("refused");
			expect(error.message).toMatch(/management key/);
			expect(error.message).not.toContain(CANARY_SECRET);
		}

		const { fetcher: failing } = fakeFetch(() => json({ error: `upstream broke near ${KEY}` }, 500));
		const broken = await failure(
			createCpaManagement({ baseUrl: "http://cpa.internal:8317", managementKey: KEY, fetch: failing }).authUrl(
				"anthropic",
			),
		);
		expect(broken.code).toBe("unavailable");
		expect(broken.message).toMatch(/HTTP 500/);
		expect(broken.message).not.toContain(CANARY_SECRET);
		expect(broken.details).toEqual({ status: 500 });

		const unreachable = (async () => {
			throw new Error(`connect ECONNREFUSED with ${KEY}`);
		}) as typeof fetch;
		const down = await failure(
			createCpaManagement({ baseUrl: "http://cpa.internal:8317", managementKey: KEY, fetch: unreachable }).authFiles(),
		);
		expect(down.code).toBe("unavailable");
		expect(down.message).not.toContain(CANARY_SECRET);

		const { fetcher: html } = fakeFetch(() => new Response("<html>login</html>", { status: 200 }));
		const notJson = createCpaManagement({ baseUrl: "http://cpa.internal:8317", managementKey: KEY, fetch: html });
		expect((await failure(notJson.authFiles())).code).toBe("unavailable");

		const { fetcher: stateless } = fakeFetch(() => json({ status: "ok", url: "https://claude.ai/oauth" }));
		const noState = createCpaManagement({ baseUrl: "http://cpa.internal:8317", managementKey: KEY, fetch: stateless });
		expect((await failure(noState.authUrl("anthropic"))).code).toBe("unavailable");
	});
});
