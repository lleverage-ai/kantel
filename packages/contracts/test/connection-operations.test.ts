import { describe, expect, it } from "vitest";
import { describeOperation, describeRequest, searchTerms, serviceOf } from "../src/connection-operations.ts";

const get = (url: string) => describeRequest({ method: "GET", url });

describe("describeRequest", () => {
	it("spells out a search's qualifiers, in the order given", () => {
		expect(get("https://api.github.com/search/issues?q=type:pr+author:tvdavies+created:2026-10-31&per_page=100")).toBe(
			"Search pull requests: author tvdavies, created 31 Oct",
		);
		expect(get("https://api.github.com/search/issues?q=is%3Aissue%20repo%3Atvdavies%2Fharbour%20is%3Aopen")).toBe(
			"Search issues: in tvdavies/harbour, open",
		);
		expect(get("https://api.github.com/search/issues?q=involves:tvdavies+updated:>=2026-10-30")).toBe(
			"Search issues and pull requests: involving tvdavies, updated on or after 30 Oct",
		);
		expect(get("https://api.github.com/search/issues?q=type:pr+created:2026-10-01..2026-10-31+-label:bug")).toBe(
			"Search pull requests: created 1 Oct to 31 Oct, not labelled bug",
		);
	});

	it("says a search sorted newest first, and its free words in quotes", () => {
		expect(
			get("https://api.github.com/search/issues?q=type:pr+author:tvdavies&sort=created&order=desc&per_page=10"),
		).toBe("Search pull requests: author tvdavies, newest 10");
		expect(get("https://api.github.com/search/repositories?q=kantel+language:go")).toBe(
			"Search repositories: “kantel”, language go",
		);
	});

	it("names the common reads, with a later page", () => {
		expect(get("https://api.github.com/user/repos?per_page=5&page=3&sort=pushed")).toBe(
			"List repositories you can access, page 3",
		);
		expect(get("https://api.github.com/user/repos?per_page=5&page=1")).toBe("List repositories you can access");
		expect(get("https://api.github.com/user/orgs")).toBe("List your organisations");
		expect(get("https://api.github.com/users/tvdavies/events?per_page=100")).toBe("List tvdavies's recent activity");
		expect(get("https://api.github.com/repos/lleverage-ai/lleverage")).toBe("Read lleverage-ai/lleverage");
		expect(get("https://api.github.com/repos/tvdavies/harbour/pulls?state=open")).toBe(
			"List pull requests in tvdavies/harbour",
		);
		expect(get("https://api.github.com/repos/tvdavies/harbour/issues/459")).toBe("Read issue tvdavies/harbour#459");
		expect(get("https://api.github.com/repos/tvdavies/harbour/actions/runs")).toBe(
			"List Actions runs in tvdavies/harbour",
		);
		expect(get("https://api.github.com/repos/tvdavies/harbour/contents/docs/connections.md")).toBe(
			"Read docs/connections.md in tvdavies/harbour",
		);
	});

	it("names writes by their method", () => {
		const write = (method: string, url: string) => describeRequest({ method, url });
		expect(write("POST", "https://api.github.com/repos/tvdavies/harbour/issues")).toBe(
			"Open an issue in tvdavies/harbour",
		);
		expect(write("post", "https://api.github.com/repos/tvdavies/harbour/issues/459/comments")).toBe(
			"Comment on tvdavies/harbour#459",
		);
		expect(write("POST", "https://api.github.com/repos/tvdavies/harbour/pulls")).toBe(
			"Open a pull request in tvdavies/harbour",
		);
		expect(write("PUT", "https://api.github.com/repos/tvdavies/harbour/pulls/12/merge")).toBe(
			"Merge pull request tvdavies/harbour#12",
		);
	});

	it("falls back to the method, host and path for anything it doesn't know", () => {
		expect(get("https://api.github.com/repos/tvdavies/harbour/hooks?per_page=1")).toBe(
			"GET api.github.com/repos/tvdavies/harbour/hooks",
		);
		expect(describeRequest({ method: "DELETE", url: "https://api.github.com/repos/tvdavies/harbour" })).toBe(
			"DELETE api.github.com/repos/tvdavies/harbour",
		);
		expect(get("https://api.linear.app/graphql")).toBe("GET api.linear.app/graphql");
		expect(get("not a url")).toBe("GET not a url");
	});

	it("describes a request from a use's method, host and path, which carry no query", () => {
		expect(describeOperation({ method: "GET", host: "api.github.com", path: "/search/issues", query: [] })).toBe(
			"Search issues and pull requests",
		);
		expect(describeOperation({ method: "GET", host: "api.github.com", path: "/nope", query: [] })).toBeUndefined();
	});
});

describe("searchTerms and serviceOf", () => {
	it("takes the kind out of the terms", () => {
		expect(searchTerms("is:pr is:merged author:tvdavies")).toEqual({
			kind: "pull requests",
			terms: ["merged", "author tvdavies"],
		});
	});

	it("names GitHub by its API's hosts and anything else by its host", () => {
		expect(serviceOf("api.github.com")).toBe("GitHub");
		expect(serviceOf("api.linear.app")).toBe("api.linear.app");
	});
});
