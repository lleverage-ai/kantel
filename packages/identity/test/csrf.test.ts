// Cross-site refusal and the console's cookies (TASK-4842): the rules both gateways apply, case by case.
import { describe, expect, it } from "vitest";
import { clearConsoleCookie, consoleCookieName, readConsoleCookie, setConsoleCookie } from "../src/cookies.ts";
import { CROSS_SITE_REFUSED, crossSiteReason, crossSiteRefusal } from "../src/csrf.ts";

const CONSOLE = "https://app.kantel.test";
const PORT_PAGE = "https://5173-k7xq2m.ports.kantel.test";

const request = (method: string, headers: Record<string, string> = {}, url = `${CONSOLE}/v1/sandboxes`) =>
	new Request(url, { method, headers });

describe("crossSiteReason", () => {
	it("leaves reads alone, whatever sent them", () => {
		for (const method of ["GET", "HEAD", "OPTIONS"]) {
			expect(
				crossSiteReason(request(method, { origin: PORT_PAGE, "sec-fetch-site": "same-site", cookie: "a=1" })),
			).toBe(undefined);
		}
	});

	it("leaves a bearer alone: no other page can attach one", () => {
		const headers = { authorization: "Bearer ksk_x", origin: PORT_PAGE, "sec-fetch-site": "cross-site", cookie: "a=1" };
		expect(crossSiteReason(request("POST", headers))).toBe(undefined);
		// An empty Authorization header is no bearer.
		expect(crossSiteReason(request("POST", { ...headers, authorization: " " }))).toBe("fetch-site");
	});

	it("refuses a Sec-Fetch-Site other than same-origin", () => {
		for (const site of ["same-site", "cross-site", "none", "SAME-SITE"]) {
			expect(crossSiteReason(request("POST", { "sec-fetch-site": site, origin: CONSOLE })), site).toBe("fetch-site");
		}
		expect(crossSiteReason(request("POST", { "sec-fetch-site": "same-origin", origin: CONSOLE }))).toBe(undefined);
	});

	it("takes only the console's exact origin", () => {
		for (const origin of [
			PORT_PAGE,
			"null",
			"http://app.kantel.test",
			"https://app.kantel.test:8443",
			"https://kantel.test",
			"https://app.kantel.test.evil.example",
			`${CONSOLE}/`,
		]) {
			expect(crossSiteReason(request("POST", { origin })), origin).toBe("origin");
		}
		expect(crossSiteReason(request("POST", { origin: CONSOLE }))).toBe(undefined);
		expect(crossSiteReason(request("DELETE", { origin: CONSOLE }))).toBe(undefined);
	});

	it("takes the origins it is given and, when asked, the request's host over https", () => {
		const local = (origin: string) => request("POST", { origin }, "http://kantel.example.test/v1/sandboxes");
		expect(crossSiteReason(local("https://kantel.example.test"))).toBe("origin");
		expect(crossSiteReason(local("https://kantel.example.test"), { httpsTwin: true })).toBe(undefined);
		expect(crossSiteReason(local("http://kantel.example.test"))).toBe(undefined);
		const named = { origins: ["https://console.example.test/some/path", "not a url"] };
		expect(crossSiteReason(local("https://console.example.test"), named)).toBe(undefined);
		expect(crossSiteReason(local("https://other.example.test"), named)).toBe("origin");
	});

	it("refuses a write with a cookie and no Origin, and lets one with neither through", () => {
		expect(crossSiteReason(request("POST", { cookie: "CF_Authorization=x" }))).toBe("no-origin");
		expect(crossSiteReason(request("POST"))).toBe(undefined);
		expect(crossSiteReason(request("POST", { cookie: "" }))).toBe(undefined);
	});

	it("answers a refusal with a 403 that says why and is never cached", async () => {
		const refusal = crossSiteRefusal(request("POST", { origin: PORT_PAGE }));
		expect(refusal?.status).toBe(403);
		expect(refusal?.headers.get("cache-control")).toBe("no-store");
		expect(await refusal?.json()).toEqual({ error: { code: "forbidden", message: CROSS_SITE_REFUSED } });
		expect(crossSiteRefusal(request("POST", { origin: CONSOLE }))).toBeUndefined();
	});
});

describe("the console's cookies", () => {
	it("are __Host- cookies over https: Secure, Path=/ and no Domain", () => {
		const cookie = setConsoleCookie("kantel_state", "abc", { secure: true, maxAgeSeconds: 600 });
		expect(cookie).toBe("__Host-kantel_state=abc; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax");
		expect(cookie).not.toMatch(/domain/i);
	});

	it("drop the prefix and Secure over plain http, where a browser refuses both", () => {
		expect(setConsoleCookie("kantel_state", "abc", { secure: false })).toBe(
			"kantel_state=abc; Path=/; HttpOnly; SameSite=Lax",
		);
		expect(consoleCookieName("kantel_state", false)).toBe("kantel_state");
		expect(clearConsoleCookie("kantel_state", { secure: true })).toBe(
			"__Host-kantel_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
		);
	});

	it("refuse a name that already has a prefix or isn't a plain token, and a value that isn't cookie-safe", () => {
		expect(() => consoleCookieName("__Host-x", true)).toThrow();
		expect(() => consoleCookieName("a b", true)).toThrow();
		expect(() => setConsoleCookie("x", "a;b", { secure: true })).toThrow();
	});

	it("read only the prefixed name over https, so a bare one planted for the whole site is never read", () => {
		const read = (cookie: string, secure = true) =>
			readConsoleCookie(new Request(CONSOLE, { headers: { cookie } }), "kantel_state", { secure });
		expect(read("__Host-kantel_state=good")).toBe("good");
		expect(read("kantel_state=planted")).toBeUndefined();
		expect(read("kantel_state=planted; __Host-kantel_state=good")).toBe("good");
		// Two of the prefixed name: only one can be the console's, so neither is taken.
		expect(read("__Host-kantel_state=a; __Host-kantel_state=b")).toBeUndefined();
		expect(read("kantel_state=local", false)).toBe("local");
	});
});
