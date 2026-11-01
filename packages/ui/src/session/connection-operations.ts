// What a connection request does, in words, from its method and URL: "Search pull requests: author tvdavies, created
// 31 Oct" for `GET api.github.com/search/issues?q=type:pr+author:tvdavies+created:2026-10-31`. A connection's calls
// read as their operations in the transcript (connection-tools.tsx); a request this doesn't know reads as itself,
// `GET api.github.com/repos/o/r/hooks`.
//
// Interim: the connections service is to classify each request from its template (#465) and put the operation on the
// call (`details.connection`, #464). Until then this small table covers GitHub's common REST endpoints, from the
// method and URL alone, and goes once the call carries its operation.

/** A request as the describer reads it. `url` is absolute; `path` and `query` are read from it. */
export type ConnectionRequestLine = {
	readonly method: string;
	readonly url: string;
};

/** A request's parts, read from its URL: the host, the path and the query's parameters in order. */
export type RequestParts = {
	readonly method: string;
	readonly host: string;
	readonly path: string;
	readonly query: readonly (readonly [name: string, value: string])[];
};

/** A URL's parts, or undefined when it isn't one. */
export function requestParts({ method, url }: ConnectionRequestLine): RequestParts | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	return {
		method: method.toUpperCase(),
		host: parsed.hostname,
		path: decodePath(parsed.pathname),
		query: [...parsed.searchParams.entries()],
	};
}

const decodePath = (path: string): string => {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
};

/** The services the describer knows, by their API's host: what a person calls them. */
const SERVICES: Readonly<Record<string, string>> = {
	"api.github.com": "GitHub",
	"uploads.github.com": "GitHub",
};

/** What a person calls the service at `host` ("GitHub"), or the host itself when the describer doesn't know it. */
export function serviceOf(host: string): string {
	return SERVICES[host.toLowerCase()] ?? host;
}

/** `GET api.github.com/user/repos`: a request as itself, without its query. */
export function requestLine(parts: Pick<RequestParts, "method" | "host" | "path">): string {
	return `${parts.method} ${parts.host}${parts.path}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "31 Oct" for 2026-10-31; anything that isn't a date as it is. */
function day(text: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:]+Z?)?$/.exec(text);
	if (match === null) return text;
	const month = MONTHS[Number(match[2]) - 1];
	return month === undefined ? text : `${Number(match[3])} ${month}`;
}

/** A search qualifier's date or range in words: ">=2026-10-30" as "on or after 30 Oct". */
function dates(value: string): string {
	const range = /^(.+)\.\.(.+)$/.exec(value);
	if (range !== null) return `${day(range[1] ?? "")} to ${day(range[2] ?? "")}`;
	const compared = /^(>=|<=|>|<)(.+)$/.exec(value);
	if (compared === null) return day(value);
	const words = { ">=": "on or after", "<=": "on or before", ">": "after", "<": "before" } as const;
	return `${words[compared[1] as keyof typeof words]} ${day(compared[2] ?? "")}`;
}

/** Search qualifiers in words, by name. One not here reads as its name and value: "language go". */
const QUALIFIERS: Readonly<Record<string, (value: string) => string>> = {
	author: (value) => `author ${value}`,
	assignee: (value) => `assigned to ${value}`,
	mentions: (value) => `mentioning ${value}`,
	commenter: (value) => `commented on by ${value}`,
	involves: (value) => `involving ${value}`,
	"reviewed-by": (value) => `reviewed by ${value}`,
	"review-requested": (value) => `review requested from ${value}`,
	repo: (value) => `in ${value}`,
	org: (value) => `in ${value}`,
	user: (value) => `owned by ${value}`,
	label: (value) => `labelled ${value}`,
	state: (value) => value,
	created: (value) => `created ${dates(value)}`,
	updated: (value) => `updated ${dates(value)}`,
	closed: (value) => `closed ${dates(value)}`,
	merged: (value) => `merged ${dates(value)}`,
	pushed: (value) => `pushed ${dates(value)}`,
};

/** What `type:` or `is:` says a search of issues is for. */
const ISSUE_KINDS: Readonly<Record<string, string>> = {
	pr: "pull requests",
	"pull-request": "pull requests",
	issue: "issues",
};

/**
 * A search's `q` in words: the qualifiers spelt out, in the order given, and its free words in quotes. `kind` takes
 * the `type:pr` or `is:issue` that names what an issues search is for.
 */
export function searchTerms(q: string): { readonly kind?: string; readonly terms: readonly string[] } {
	let kind: string | undefined;
	const terms: string[] = [];
	const words: string[] = [];
	for (const token of q.match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) ?? []) {
		const qualifier = /^(-?)([\w-]+):(.+)$/.exec(token);
		if (qualifier === null) {
			words.push(token.replace(/^"|"$/g, ""));
			continue;
		}
		const [, negated, name = "", raw = ""] = qualifier;
		const value = raw.replace(/^"|"$/g, "");
		if ((name === "type" || name === "is") && ISSUE_KINDS[value] !== undefined && negated === "") {
			kind = ISSUE_KINDS[value];
			continue;
		}
		if (name === "is" && negated === "") {
			terms.push(value);
			continue;
		}
		const said = QUALIFIERS[name]?.(value) ?? `${name} ${value}`;
		terms.push(negated === "" ? said : `not ${said}`);
	}
	if (words.length > 0) terms.unshift(`“${words.join(" ")}”`);
	return { ...(kind === undefined ? {} : { kind }), terms };
}

/** The value of a query parameter, if given. */
const param = (parts: RequestParts, name: string): string | undefined => parts.query.find(([key]) => key === name)?.[1];

/** ", page 2" for a list's later page; nothing for its first. */
const page = (parts: RequestParts): string => {
	const value = param(parts, "page");
	return value === undefined || value === "1" ? "" : `, page ${value}`;
};

/** "newest 10": a search sorted newest first, with how many it asked for. */
function order(parts: RequestParts): string | undefined {
	if (param(parts, "sort") !== "created" || (param(parts, "order") ?? "desc") !== "desc") return undefined;
	const count = param(parts, "per_page");
	return count === undefined ? "newest first" : `newest ${count}`;
}

/** A search: its kind, then its terms. */
function search(parts: RequestParts, noun: string): string {
	const { kind, terms } = searchTerms(param(parts, "q") ?? "");
	const sorted = order(parts);
	const said = [...terms, ...(sorted === undefined ? [] : [sorted])];
	const title = `Search ${kind ?? noun}`;
	return `${said.length === 0 ? title : `${title}: ${said.join(", ")}`}${page(parts)}`;
}

/** One endpoint of a service: a method, a path pattern with `{name}` segments, and its words from them. */
type Endpoint = {
	readonly method: string;
	readonly path: string;
	readonly label: (values: Readonly<Record<string, string>>, parts: RequestParts) => string;
};

/** GitHub's common REST endpoints (docs.github.com/en/rest). Reads first, then writes, for each resource. */
const GITHUB: readonly Endpoint[] = [
	{ method: "GET", path: "/search/issues", label: (_, parts) => search(parts, "issues and pull requests") },
	{ method: "GET", path: "/search/repositories", label: (_, parts) => search(parts, "repositories") },
	{ method: "GET", path: "/search/code", label: (_, parts) => search(parts, "code") },
	{ method: "GET", path: "/search/commits", label: (_, parts) => search(parts, "commits") },
	{ method: "GET", path: "/user", label: () => "Read your profile" },
	{ method: "GET", path: "/user/repos", label: (_, parts) => `List repositories you can access${page(parts)}` },
	{ method: "GET", path: "/user/orgs", label: (_, parts) => `List your organisations${page(parts)}` },
	{ method: "GET", path: "/user/installations", label: () => "List the app's installations you can access" },
	{ method: "GET", path: "/users/{user}", label: ({ user }) => `Read ${user}'s profile` },
	{
		method: "GET",
		path: "/users/{user}/events",
		label: ({ user }, parts) => `List ${user}'s recent activity${page(parts)}`,
	},
	{
		method: "GET",
		path: "/users/{user}/repos",
		label: ({ user }, parts) => `List ${user}'s repositories${page(parts)}`,
	},
	{ method: "GET", path: "/orgs/{org}/repos", label: ({ org }, parts) => `List ${org}'s repositories${page(parts)}` },
	{ method: "GET", path: "/repos/{owner}/{repo}", label: ({ owner, repo }) => `Read ${owner}/${repo}` },
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/pulls",
		label: ({ owner, repo }, parts) => `List pull requests in ${owner}/${repo}${page(parts)}`,
	},
	{
		method: "POST",
		path: "/repos/{owner}/{repo}/pulls",
		label: ({ owner, repo }) => `Open a pull request in ${owner}/${repo}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/pulls/{number}",
		label: ({ owner, repo, number }) => `Read pull request ${owner}/${repo}#${number}`,
	},
	{
		method: "PATCH",
		path: "/repos/{owner}/{repo}/pulls/{number}",
		label: ({ owner, repo, number }) => `Update pull request ${owner}/${repo}#${number}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/pulls/{number}/files",
		label: ({ owner, repo, number }) => `List the files changed in ${owner}/${repo}#${number}`,
	},
	{
		method: "POST",
		path: "/repos/{owner}/{repo}/pulls/{number}/reviews",
		label: ({ owner, repo, number }) => `Review pull request ${owner}/${repo}#${number}`,
	},
	{
		method: "PUT",
		path: "/repos/{owner}/{repo}/pulls/{number}/merge",
		label: ({ owner, repo, number }) => `Merge pull request ${owner}/${repo}#${number}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/issues",
		label: ({ owner, repo }, parts) => `List issues in ${owner}/${repo}${page(parts)}`,
	},
	{
		method: "POST",
		path: "/repos/{owner}/{repo}/issues",
		label: ({ owner, repo }) => `Open an issue in ${owner}/${repo}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/issues/{number}",
		label: ({ owner, repo, number }) => `Read issue ${owner}/${repo}#${number}`,
	},
	{
		method: "PATCH",
		path: "/repos/{owner}/{repo}/issues/{number}",
		label: ({ owner, repo, number }) => `Update issue ${owner}/${repo}#${number}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/issues/{number}/comments",
		label: ({ owner, repo, number }, parts) => `List comments on ${owner}/${repo}#${number}${page(parts)}`,
	},
	{
		method: "POST",
		path: "/repos/{owner}/{repo}/issues/{number}/comments",
		label: ({ owner, repo, number }) => `Comment on ${owner}/${repo}#${number}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/commits",
		label: ({ owner, repo }, parts) => `List commits in ${owner}/${repo}${page(parts)}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/branches",
		label: ({ owner, repo }, parts) => `List branches in ${owner}/${repo}${page(parts)}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/contents/{path*}",
		label: ({ owner, repo, path }) => `Read ${path} in ${owner}/${repo}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/actions/runs",
		label: ({ owner, repo }, parts) => `List Actions runs in ${owner}/${repo}${page(parts)}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/actions/runs/{run}",
		label: ({ owner, repo, run }) => `Read Actions run ${run} in ${owner}/${repo}`,
	},
	{
		method: "GET",
		path: "/repos/{owner}/{repo}/actions/runs/{run}/jobs",
		label: ({ owner, repo, run }) => `List the jobs of Actions run ${run} in ${owner}/${repo}`,
	},
	{
		method: "POST",
		path: "/repos/{owner}/{repo}/actions/runs/{run}/rerun",
		label: ({ owner, repo, run }) => `Re-run Actions run ${run} in ${owner}/${repo}`,
	},
];

/** The endpoints the describer knows, by their service's API host. */
const ENDPOINTS: Readonly<Record<string, readonly Endpoint[]>> = {
	"api.github.com": GITHUB,
};

/** A path's `{name}` values when it matches `pattern`; a last `{name*}` takes the rest of the path. */
function match(pattern: string, path: string): Record<string, string> | undefined {
	const want = pattern.split("/").filter((part) => part !== "");
	const have = path.split("/").filter((part) => part !== "");
	const values: Record<string, string> = {};
	for (let index = 0; index < want.length; index++) {
		const part = want[index] ?? "";
		const named = /^\{(\w+)(\*)?\}$/.exec(part);
		if (named?.[2] === "*") {
			if (index >= have.length) return undefined;
			values[named[1] ?? ""] = have.slice(index).join("/");
			return values;
		}
		const value = have[index];
		if (value === undefined) return undefined;
		if (named === null) {
			if (part !== value) return undefined;
		} else values[named[1] ?? ""] = value;
	}
	return have.length === want.length ? values : undefined;
}

/** What a known endpoint does, in words; undefined for one the describer doesn't know. */
export function describeOperation(parts: RequestParts): string | undefined {
	for (const endpoint of ENDPOINTS[parts.host.toLowerCase()] ?? []) {
		if (endpoint.method !== parts.method) continue;
		const values = match(endpoint.path, parts.path);
		if (values !== undefined) return endpoint.label(values, parts);
	}
	return undefined;
}

/** A request in words: its operation when the describer knows it, else `GET api.github.com/…` as itself. */
export function describeRequest(request: ConnectionRequestLine): string {
	const parts = requestParts(request);
	if (parts === undefined) return `${request.method.toUpperCase()} ${request.url}`;
	return describeOperation(parts) ?? requestLine(parts);
}
