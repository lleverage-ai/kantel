// The Rules page's API seam: each of the page's calls is one call to the public API's rule routes, a refusal rejects
// with the server's own message, and a draft is checked before it is sent.
import type { MeResponse, OwnerRef, PromptRule } from "@harbour/contracts";
import { PROMPT_RULE_TEXT_LIMIT } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { apiRules, ruleDraftErrors, ruleInput } from "./rules-http.ts";

const ORG = "org_a";
const me: MeResponse = {
	actor: { kind: "human", userId: "usr_tom" },
	organisationId: ORG,
	method: "cloudflare_access",
	name: "Tom",
	roles: [{ role: "admin" }],
};

const RULE: PromptRule = {
	id: "rul_1",
	owner: { kind: "organisation", organisationId: ORG },
	name: "british-english",
	text: "Write in British English.",
	order: 0,
	createdAt: 1,
	updatedAt: 1,
};

const ORGANISATION: OwnerRef = { kind: "organisation", organisationId: ORG };

/** The rule routes' answers: a list with the one rule for a read, the rule itself for a write. */
const rulesAnswer = (request: Request) =>
	request.method === "GET" ? Response.json({ items: [RULE] }) : Response.json(RULE);

/** A fetch that answers with `answer`, and records each call and the credentials it came with. */
function fakeApi(answer: (request: Request) => Response) {
	const calls: string[] = [];
	const credentials: (string | null)[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://harbour.test"), init);
		const url = new URL(request.url);
		const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.clone().text();
		calls.push(`${request.method} ${url.pathname}${url.search}${body === "" ? "" : ` ${body}`}`);
		credentials.push(request.headers.get("authorization"));
		return answer(request);
	};
	return { calls, credentials, fetch: fetcher as typeof fetch };
}

describe("the Rules page on the API", () => {
	it("makes each of the page's calls one call to the rule routes", async () => {
		const api = fakeApi(rulesAnswer);
		const rules = apiRules(me, { fetch: api.fetch, headers: () => ({ authorization: "Bearer t" }) });
		expect(rules.organisationId).toBe(ORG);
		expect(rules.viewer).toBe("usr_tom");

		expect(await rules.list({ kind: "platform" })).toEqual([RULE]);
		await rules.list(ORGANISATION);
		await rules.list({ kind: "project", organisationId: ORG, projectId: "prj web" });
		await rules.list({ kind: "user", organisationId: ORG, userId: "usr_tom" });
		expect(await rules.resolved({})).toEqual([RULE]);
		await rules.resolved({ projectId: "prj_web" });
		const input = {
			owner: { kind: "project", organisationId: ORG, projectId: "prj_web" } as const,
			name: "tests",
			text: "Run the tests before you finish.",
			order: 2,
		};
		expect(await rules.put(input)).toEqual(RULE);
		// No order: the server's default, 0.
		expect(await rules.put({ owner: ORGANISATION, name: "plain", text: "Be plain." })).toEqual(RULE);
		expect(await rules.remove("rul/1")).toEqual(RULE);

		expect(api.calls).toEqual([
			"GET /v1/rules?owner=platform",
			"GET /v1/rules?owner=organisation",
			"GET /v1/rules?owner=project&projectId=prj+web",
			"GET /v1/rules?owner=user&userId=usr_tom",
			"GET /v1/rules/resolved",
			"GET /v1/rules/resolved?projectId=prj_web",
			`PUT /v1/rules ${JSON.stringify(input)}`,
			'PUT /v1/rules {"owner":{"kind":"organisation","organisationId":"org_a"},"name":"plain","text":"Be plain."}',
			"DELETE /v1/rules/rul%2F1",
		]);
		expect(new Set(api.credentials)).toEqual(new Set(["Bearer t"]));
	});

	it("rejects with the server's code and message, and says when the sign-in has ended", async () => {
		const refusal = "Changing the organisation's rules needs an organisation-wide admin.";
		let ended = 0;
		const api = fakeApi((request) => {
			if (request.method === "PUT") {
				return Response.json({ error: { code: "forbidden", message: refusal } }, { status: 403 });
			}
			if (request.method === "DELETE") {
				return Response.json({ error: { code: "not_found", message: "There's no such rule." } }, { status: 404 });
			}
			return Response.json({ error: { code: "unauthenticated", message: "Sign in again." } }, { status: 401 });
		});
		const rules = apiRules(me, {
			fetch: api.fetch,
			onUnauthenticated: () => {
				ended += 1;
			},
		});

		const put = rules.put({ owner: ORGANISATION, name: "plain", text: "Be plain." });
		await expect(put).rejects.toMatchObject({ status: 403, code: "forbidden", message: refusal });
		await expect(rules.remove("rul_1")).rejects.toMatchObject({ code: "not_found", message: "There's no such rule." });
		expect(ended).toBe(0);
		await expect(rules.list({ kind: "platform" })).rejects.toThrow("Sign in again.");
		expect(ended).toBe(1);
	});

	it("has no rules of yours for a caller who isn't a person", () => {
		const rules = apiRules({ actor: { kind: "service", serviceId: "svc_1" }, organisationId: ORG });
		expect(rules.organisationId).toBe(ORG);
		expect("viewer" in rules).toBe(false);
	});
});

describe("a rule's draft", () => {
	const owner: OwnerRef = { kind: "user", organisationId: ORG, userId: "usr_tom" };
	const longest = "x".repeat(PROMPT_RULE_TEXT_LIMIT);

	it("may be sent with a good name, a whole-number order in range and some text", () => {
		expect(ruleDraftErrors({ name: "british-english", order: "0", text: "Write in British English." })).toEqual({});
		expect(ruleDraftErrors({ name: " tests ", order: "", text: "x" })).toEqual({});
		expect(ruleDraftErrors({ name: "a".repeat(100), order: "-1000000", text: longest })).toEqual({});
	});

	it("says what's wrong with each field", () => {
		expect(ruleDraftErrors({ name: "", order: "2000000", text: "   " })).toEqual({
			name: "Give the rule a name.",
			order: "Use a whole number from -1,000,000 to 1,000,000.",
			text: "Write what the rule tells the agent.",
		});
		for (const name of ["-starts-with-a-hyphen", "has space", "a".repeat(101), "émigré"]) {
			expect(ruleDraftErrors({ name, order: "0", text: "x" }).name).toMatch(/letters, digits/);
		}
		for (const order of ["1.5", "abc", "-1000001"]) {
			expect(ruleDraftErrors({ name: "ok", order, text: "x" }).order).toMatch(/whole number/);
		}
		const tooLong = ruleDraftErrors({ name: "ok", order: "0", text: `${longest}x` });
		expect(tooLong.text).toBe("Keep the text to 32,768 characters; it has 32,769.");
	});

	it("becomes put's input for its owner, its name trimmed and an empty order 0", () => {
		expect(ruleInput(owner, { name: " tests ", order: "", text: "Run them." })).toEqual({
			owner,
			name: "tests",
			text: "Run them.",
			order: 0,
		});
		expect(ruleInput(owner, { name: "tests", order: "-3", text: "Run them." }).order).toBe(-3);
	});
});
