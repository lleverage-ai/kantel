import { describe, expect, it } from "vitest";
import { GITHUB_OPERATIONS } from "../src/github-operations.generated.ts";
import { classifyGraphQL, classifyRequest, githubRestOperation, graphqlOperations } from "../src/operations.ts";
import { withDefaultHeaders } from "../src/service.ts";
import { bodyPreview, clip, jsonPreview, SCRIPT_BODY_LIMIT, scriptResponse, TEXT_LIMIT } from "../src/tools.ts";

const github = (method: string, path: string, body?: string) =>
	classifyRequest("github", { method, url: `https://api.github.com${path}`, ...(body === undefined ? {} : { body }) });
const graphql = (query: string, extra: Record<string, unknown> = {}) =>
	github("POST", "/graphql", JSON.stringify({ query, ...extra }));

describe("GitHub operations (#465)", () => {
	it("knows every REST operation in GitHub's description", () => {
		expect(GITHUB_OPERATIONS.length).toBeGreaterThan(1000);
		for (const line of GITHUB_OPERATIONS) {
			const [method = "", path = ""] = line.split(" ");
			const concrete = path.replace(/\{[^}]+\}/g, "x1");
			expect(githubRestOperation(method, concrete), line).toBeDefined();
		}
	});

	it("labels, groups and classes a request, and names its repository", () => {
		expect(github("GET", "/repos/tvdavies/harbour/pulls?state=open")).toEqual({
			id: "pulls/list",
			label: "List pull requests in tvdavies/harbour",
			group: "repo",
			access: "read",
			resource: "tvdavies/harbour",
		});
		expect(github("POST", "/repos/tvdavies/harbour/issues/12/comments")).toMatchObject({
			id: "issues/create-comment",
			access: "write",
			resource: "tvdavies/harbour",
		});
		expect(github("DELETE", "/repos/tvdavies/harbour/git/refs/heads/old")).toMatchObject({
			id: "git/delete-ref",
			access: "delete",
		});
		expect(github("GET", "/user")).toMatchObject({ group: "profile", access: "read" });
		// What the curated words don't name says GitHub's own summary.
		expect(github("GET", "/repos/a/b/milestones")).toMatchObject({ label: "List milestones in a/b" });
		expect(github("GET", "/repos/a/b/actions/runs")).toMatchObject({ group: "workflow", access: "read" });
	});

	it("classes writes to settings, access and secrets as admin", () => {
		expect(github("PUT", "/repos/a/b/collaborators/eve")).toMatchObject({ access: "admin" });
		expect(github("PUT", "/repos/a/b/branches/main/protection")).toMatchObject({ access: "admin" });
		expect(github("PUT", "/repos/a/b/actions/secrets/TOKEN")).toMatchObject({ access: "admin" });
		expect(github("PATCH", "/repos/a/b")).toMatchObject({ id: "repos/update", access: "admin" });
		expect(github("POST", "/orgs/acme/hooks")).toMatchObject({ access: "admin" });
		// Reading them is still a read.
		expect(github("GET", "/repos/a/b/collaborators")).toMatchObject({ access: "read" });
	});

	it("prefers the literal path and lets a file's path hold slashes", () => {
		expect(github("GET", "/repos/a/b/pulls/comments")).toMatchObject({ id: "pulls/list-review-comments-for-repo" });
		expect(github("GET", "/repos/a/b/contents/src/lib/index.ts?ref=main")).toMatchObject({
			id: "repos/get-content",
			resource: "a/b",
		});
		expect(github("HEAD", "/repos/a/b")).toMatchObject({ id: "repos/get", access: "read" });
	});

	it("names a search's repository only when it names exactly one", () => {
		expect(github("GET", "/search/issues?q=repo:a/b+is:open")).toMatchObject({ resource: "a/b", access: "read" });
		expect(github("GET", "/search/issues?q=repo:a/b+repo:c/d")?.resource).toBeUndefined();
		expect(github("GET", "/search/issues?q=-repo:a/b")?.resource).toBeUndefined();
		expect(github("GET", "/search/code?q=fetch")?.resource).toBeUndefined();
	});

	it("says nothing about a request it doesn't know, or another template", () => {
		expect(github("GET", "/no/such/thing")).toBeUndefined();
		expect(github("GET", "https://example.com/")).toBeUndefined();
		expect(classifyRequest("linear", { method: "GET", url: "https://api.linear.app/graphql" })).toBeUndefined();
		expect(classifyRequest(undefined, { method: "GET", url: "https://api.github.com/user" })).toBeUndefined();
	});
});

describe("GitHub GraphQL (#465)", () => {
	it("reads a query and names its one repository, from arguments or variables", () => {
		expect(graphql('query { repository(owner: "a", name: "b") { issues(first: 5) { nodes { title } } } }')).toEqual({
			id: "graphql/query",
			label: "GraphQL query: repository in a/b",
			group: "repo",
			access: "read",
			resource: "a/b",
		});
		expect(
			graphql("query Q($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }", {
				variables: { o: "a", n: "b" },
			}),
		).toMatchObject({ access: "read", resource: "a/b" });
		expect(graphql("{ viewer { login } }")).toMatchObject({ access: "read", label: "GraphQL query: viewer" });
		expect(graphql('{ viewer { login } repository(owner: "a", name: "b") { id } }')?.resource).toBeUndefined();
	});

	it("classes a mutation as a write", () => {
		expect(graphql('mutation { addComment(input: {subjectId: "x", body: "hi"}) { clientMutationId } }')).toMatchObject({
			id: "graphql/mutation",
			label: "GraphQL mutation: addComment",
			access: "write",
		});
	});

	it("classes whatever it can't read with confidence as a write", () => {
		expect(graphql("query { viewer { login }")).toMatchObject({ access: "write" });
		expect(graphql("query A { viewer { login } } mutation B { x }")).toMatchObject({ access: "write" });
		expect(graphql("query A { viewer { login } } mutation B { x }", { operationName: "A" })).toMatchObject({
			access: "write",
		});
		expect(graphql("query A { viewer { login } }", { operationName: "Missing" })).toMatchObject({ access: "write" });
		expect(github("POST", "/graphql", "[{}]")).toMatchObject({ access: "write" });
		expect(github("POST", "/graphql", "not json")).toMatchObject({ access: "write" });
		expect(github("POST", "/graphql")).toMatchObject({ access: "write" });
		expect(graphql("query { ...F } fragment F on Query { viewer { login } }")).toMatchObject({
			access: "read",
		});
		expect(graphql("query { ...F } fragment F on Query { viewer { login } }")?.resource).toBeUndefined();
		expect(classifyGraphQL("GET", undefined)).toMatchObject({ access: "read" });
	});

	it("parses aliases, directives, strings with braces and comments", () => {
		expect(
			graphqlOperations(
				'# a } comment\nquery N @x(a: 1) { r: repository(owner: "a{", name: "b") @include(if: true) { id } }',
			),
		).toEqual([
			{ type: "query", name: "N", fields: [{ name: "repository", args: { owner: "a{", name: "b" } }], spreads: false },
		]);
		expect(graphqlOperations("query { a ")).toBeUndefined();
	});
});

describe("template default headers (#465)", () => {
	it("adds a template's headers unless the agent set its own, whatever their case", () => {
		expect(withDefaultHeaders({ "user-agent": "Kantel", accept: "application/vnd.github+json" }, undefined)).toEqual({
			"user-agent": "Kantel",
			accept: "application/vnd.github+json",
		});
		expect(withDefaultHeaders({ "user-agent": "Kantel" }, { "User-Agent": "mine" })).toEqual({ "User-Agent": "mine" });
		expect(withDefaultHeaders(undefined, { a: "b" })).toEqual({ a: "b" });
	});

	it("never adds a credential header", () => {
		expect(withDefaultHeaders({ authorization: "Bearer x", "user-agent": "Kantel" }, undefined)).toEqual({
			"user-agent": "Kantel",
		});
	});
});

describe("connection_request answers (#465)", () => {
	const events = Array.from({ length: 300 }, (_, index) => ({
		id: index,
		type: "PushEvent",
		repo: { name: "tvdavies/harbour" },
		payload: { commits: [{ message: "x".repeat(150) }] },
	}));
	const big = JSON.stringify(events);

	it("keeps a short answer whole", () => {
		expect(bodyPreview('{"a":1}', "application/json")).toBe('{"a":1}');
	});

	it("cuts a long JSON answer to a preview that still parses, and says what it kept", () => {
		expect(big.length).toBeGreaterThan(TEXT_LIMIT);
		const preview = bodyPreview(big, "application/json; charset=utf-8");
		const [json, note] = preview.split("\n");
		const parsed = JSON.parse(json ?? "") as unknown[];
		expect(parsed.length).toBeGreaterThan(10);
		expect(parsed.length).toBeLessThan(300);
		expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(TEXT_LIMIT);
		expect(note).toMatch(
			new RegExp(`keeping the first ${parsed.length} of 300 items; a code mode script gets the whole body\\]$`),
		);
	});

	it("cuts nested lists and long strings, keeping the rest", () => {
		const nested = { total_count: 2000, items: events.slice(0, 250), note: "y".repeat(5000) };
		const preview = jsonPreview(nested, 10_000);
		const parsed = JSON.parse(preview.text) as { total_count: number; items: unknown[]; note: string };
		expect(parsed.total_count).toBe(2000);
		expect(parsed.note.length).toBeLessThan(2100);
		expect(preview.cuts[0]).toMatchObject({ path: "items", of: 250 });
		expect(preview.cuts[0]?.kept).toBe(parsed.items.length);
	});

	it("cuts long text at a character, within the limit", () => {
		const text = "é".repeat(TEXT_LIMIT);
		const cut = clip(text);
		expect(cut).toMatch(/\n\[cut: \d+ more characters\]$/);
		expect(new TextEncoder().encode(cut.split("\n")[0]).length).toBeLessThanOrEqual(TEXT_LIMIT);
		expect(clip(Array.from({ length: 3000 }, () => "a").join("\n")).split("\n").length).toBeLessThanOrEqual(1501);
	});

	it("gives a script the whole answer, parsed, with the headers that count", () => {
		const response = scriptResponse({
			status: 200,
			headers: { "content-type": "application/json", link: '<https://x?page=2>; rel="next"', "set-cookie": "a=b" },
			body: big,
		});
		expect(response).toMatchObject({ status: 200, json: true, bytes: big.length });
		expect(response.body).toHaveLength(300);
		expect(response.headers).toEqual({ "content-type": "application/json", link: '<https://x?page=2>; rel="next"' });
		expect(scriptResponse({ status: 404, headers: {}, body: "Not Found" })).toMatchObject({
			json: false,
			body: "Not Found",
			truncated: false,
		});
	});

	it("cuts a script's body past 1 MiB to a preview that still parses", () => {
		const huge = JSON.stringify(Array.from({ length: 12_000 }, (_, id) => ({ id, text: "z".repeat(100) })));
		const response = scriptResponse({ status: 200, headers: { "content-type": "application/json" }, body: huge });
		expect(response.truncated).toBe(true);
		expect(response.json).toBe(true);
		expect(Array.isArray(response.body)).toBe(true);
		expect(JSON.stringify(response.body).length).toBeLessThanOrEqual(SCRIPT_BODY_LIMIT);
		expect((response.body as unknown[]).length).toBeGreaterThan(5000);
	});
});
