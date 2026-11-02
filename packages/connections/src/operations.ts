/**
 * What a request through a connection does (#465): its operation, read from the connection's template. For GitHub, a
 * table of every REST operation generated from GitHub's own OpenAPI description (`github-operations.generated.ts`,
 * `scripts/github-operations.ts`) gives method and path a label, a permission group, an access class and the
 * repository it acts on; a GraphQL document is a read when it is a query and a write when it is a mutation, labelled by
 * its root fields. A template with no classification, or a request the table doesn't know, gets none, and rules see
 * only its method and path.
 *
 * Rules decide on this (#466), so where a request can't be read with confidence it is classed the stricter way: a
 * GraphQL document that can't be parsed, holds more than one operation without naming one, is a batch, or mentions
 * `mutation` or `subscription` anywhere is a write, and a resource is given only where the request names exactly one
 * repository in a way GitHub reads the same (the path, one `repo:` search qualifier, or a query whose every root field
 * is that repository).
 */
import type { ConnectionOperation, HttpMethod, OperationAccess } from "@kantel/contracts";
import { describeOperation, requestParts, searchTerms } from "@kantel/contracts/connection-operations";
import { GITHUB_OPERATIONS } from "./github-operations.generated.ts";

/** A request as the classifier reads it: the body only matters for GraphQL. */
export interface OperationRequest {
	readonly method: HttpMethod | string;
	readonly url: string;
	readonly body?: string;
}

/** The operation a request through a connection made from `templateId` performs, or undefined when it can't say. */
export function classifyRequest(
	templateId: string | undefined,
	request: OperationRequest,
): ConnectionOperation | undefined {
	if (templateId === "github") return classifyGitHub(request);
	return undefined;
}

// GitHub's REST table.

interface GitHubOperation {
	readonly method: string;
	readonly id: string;
	readonly category: string;
	readonly subcategory: string;
	readonly summary: string;
	/** The path's segments: a literal, or `{name}` for a parameter. */
	readonly segments: readonly string[];
	/** Literal segments, for picking the most specific of several matches. */
	readonly literals: number;
}

/** Parameters that may hold slashes when they end a path: a file's path, a ref, a branch's name. */
const REST_PARAMETERS = new Set(["path", "ref", "branch", "file_path"]);

let table: Map<string, GitHubOperation[]> | undefined;

/** The generated table by method, each method's operations most literal first. */
function githubTable(): Map<string, GitHubOperation[]> {
	if (table !== undefined) return table;
	const out = new Map<string, GitHubOperation[]>();
	for (const line of GITHUB_OPERATIONS) {
		const [method = "", path = "", id = "", category = "", subcategory = "", ...summary] = line.split(" ");
		const segments = path.split("/").filter((part) => part !== "");
		const operation: GitHubOperation = {
			method,
			id,
			category,
			subcategory,
			summary: summary.join(" "),
			segments,
			literals: segments.filter((part) => !part.startsWith("{")).length,
		};
		out.set(method, [...(out.get(method) ?? []), operation]);
	}
	for (const list of out.values())
		list.sort((a, b) => b.literals - a.literals || b.segments.length - a.segments.length);
	table = out;
	return out;
}

/** The parameters of `path` when it is an instance of `operation`'s path, else undefined. */
function matchPath(operation: GitHubOperation, have: readonly string[]): Record<string, string> | undefined {
	const want = operation.segments;
	const values: Record<string, string> = {};
	for (let index = 0; index < want.length; index += 1) {
		const part = want[index] ?? "";
		const value = have[index];
		if (value === undefined) return undefined;
		const name = /^\{(\w+)\}$/.exec(part)?.[1];
		if (name === undefined) {
			if (part.toLowerCase() !== value.toLowerCase()) return undefined;
			continue;
		}
		// The last parameter takes the rest of the path when GitHub lets it hold slashes.
		if (index === want.length - 1 && have.length > want.length && REST_PARAMETERS.has(name)) {
			values[name] = have.slice(index).join("/");
			return values;
		}
		values[name] = value;
	}
	return have.length === want.length ? values : undefined;
}

/** The GitHub REST operation a method and path are, with the path's parameters, or undefined. */
export function githubRestOperation(
	method: string,
	path: string,
): { readonly operation: GitHubOperation; readonly values: Readonly<Record<string, string>> } | undefined {
	const have = path
		.split("/")
		.filter((part) => part !== "")
		.map((part) => {
			try {
				return decodeURIComponent(part);
			} catch {
				return part;
			}
		});
	// GitHub answers HEAD as it answers GET.
	const operations = githubTable().get(method === "HEAD" ? "GET" : method) ?? [];
	for (const operation of operations) {
		const values = matchPath(operation, have);
		if (values !== undefined) return { operation, values };
	}
	return undefined;
}

/**
 * Categories and subcategories (`x-github`) whose writes change settings, access, secrets or billing rather than
 * content: `admin`. A category alone covers all its subcategories.
 */
const ADMIN = new Set([
	"actions/hosted-runners",
	"actions/oidc",
	"actions/permissions",
	"actions/policies",
	"actions/secrets",
	"actions/self-hosted-runner-groups",
	"actions/self-hosted-runners",
	"actions/variables",
	"agents/secrets",
	"agents/variables",
	"apps",
	"billing",
	"branches/branch-protection",
	"code-security",
	"codespaces/organization-secrets",
	"codespaces/organizations",
	"codespaces/repository-secrets",
	"codespaces/secrets",
	"collaborators",
	"copilot",
	"credentials",
	"dependabot/repository-access",
	"dependabot/secrets",
	"deploy-keys",
	"deployments/branch-policies",
	"deployments/environments",
	"deployments/protection-rules",
	"interactions",
	"migrations",
	"orgs",
	"private-registries",
	"repos/autolinks",
	"repos/custom-properties",
	"repos/rules",
	"repos/webhooks",
	"secret-scanning/custom-patterns",
	"secret-scanning/push-protection",
	"teams",
	"users/blocking",
	"users/emails",
	"users/gpg-keys",
	"users/keys",
	"users/social-accounts",
	"users/ssh-signing-keys",
]);

/** Single operations that change a repository's settings or ownership. */
const ADMIN_OPERATIONS = new Set(["repos/update", "repos/transfer", "repos/rename-branch"]);

/** What a REST operation does: by its method, and `admin` for a write to settings, access or secrets. */
export function githubAccess(
	operation: Pick<GitHubOperation, "method" | "id" | "category" | "subcategory">,
): OperationAccess {
	if (operation.method === "GET" || operation.method === "HEAD") return "read";
	if (operation.method === "DELETE") return "delete";
	if (
		ADMIN.has(operation.category) ||
		ADMIN.has(`${operation.category}/${operation.subcategory}`) ||
		ADMIN_OPERATIONS.has(operation.id)
	)
		return "admin";
	return "write";
}

/**
 * The permission group of a REST operation, as GitHub's connection page groups them (#462): `workflow` for Actions,
 * `profile` for the signed-in person's own account, `repo` for everything else (repositories, issues, pull requests,
 * search, organisations).
 */
export function githubGroup(operation: Pick<GitHubOperation, "category">): string {
	if (operation.category === "actions") return "workflow";
	if (operation.category === "users") return "profile";
	return "repo";
}

/** `owner/name`, when both are plain names. */
const repository = (owner: string | undefined, name: string | undefined): string | undefined =>
	owner !== undefined && name !== undefined && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(name)
		? `${owner}/${name}`
		: undefined;

/** The one repository a search's `q` is limited to with `repo:`, when it names exactly one. */
function searchRepository(q: string | undefined): string | undefined {
	if (q === undefined) return undefined;
	const repos = [...q.matchAll(/(?:^|\s)(-?)repo:("?)([^\s"]+)\2/g)];
	if (repos.length !== 1 || repos[0]?.[1] === "-") return undefined;
	const [owner, name, ...rest] = (repos[0]?.[3] ?? "").split("/");
	return rest.length === 0 ? repository(owner, name) : undefined;
}

function classifyGitHub(request: OperationRequest): ConnectionOperation | undefined {
	const method = request.method.toUpperCase();
	const parts = requestParts({ method, url: request.url });
	if (parts === undefined) return undefined;
	if (parts.path.replace(/\/+$/, "") === "/graphql") return classifyGraphQL(method, request.body);
	const found = githubRestOperation(method, parts.path);
	if (found === undefined) return undefined;
	const { operation, values } = found;
	const resource = parts.path.toLowerCase().startsWith("/repos/")
		? repository(values.owner, values.repo)
		: operation.id.startsWith("search/")
			? searchRepository(parts.query.find(([name]) => name === "q")?.[1])
			: undefined;
	const label =
		describeOperation(parts) ??
		(operation.id.startsWith("search/") ? searchLabel(operation.summary, parts.query) : undefined) ??
		`${operation.summary}${resource === undefined ? "" : ` in ${resource}`}`;
	return {
		id: operation.id,
		label,
		group: githubGroup(operation),
		access: githubAccess(operation),
		...(resource === undefined ? {} : { resource }),
	};
}

/** A search the curated words don't name: the description's summary, then the qualifiers spelt out. */
function searchLabel(summary: string, query: readonly (readonly [string, string])[]): string {
	const q = query.find(([name]) => name === "q")?.[1];
	if (q === undefined) return summary;
	const { kind, terms } = searchTerms(q);
	const said = [...(kind === undefined ? [] : [kind]), ...terms];
	return said.length === 0 ? summary : `${summary}: ${said.join(", ")}`;
}

// GraphQL.

/** One operation in a GraphQL document: its type, name and the root fields it selects. */
interface GraphQLOperation {
	readonly type: "query" | "mutation" | "subscription";
	readonly name?: string;
	readonly fields: readonly GraphQLField[];
	/** It spreads a fragment at its root, so its root fields aren't all known. */
	readonly spreads: boolean;
}

interface GraphQLField {
	readonly name: string;
	/** Its arguments by name, as written: a string's value, `$name` for a variable, else the token. */
	readonly args: Readonly<Record<string, string>>;
}

type Token = { readonly kind: "name" | "punct" | "string" | "number" | "variable"; readonly value: string };

/** The document's tokens, or undefined when it doesn't lex as GraphQL. Comments and commas are dropped. */
function tokens(source: string): Token[] | undefined {
	const out: Token[] = [];
	let index = 0;
	while (index < source.length) {
		const char = source[index] ?? "";
		if (/[\s,\uFEFF]/.test(char)) {
			index += 1;
		} else if (char === "#") {
			while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
		} else if (source.startsWith('"""', index)) {
			const end = source.indexOf('"""', index + 3);
			if (end < 0) return undefined;
			out.push({ kind: "string", value: source.slice(index + 3, end) });
			index = end + 3;
		} else if (char === '"') {
			let value = "";
			index += 1;
			for (;;) {
				const next = source[index];
				if (next === undefined || next === "\n") return undefined;
				index += 1;
				if (next === '"') break;
				if (next === "\\") {
					const escaped = source[index];
					if (escaped === undefined) return undefined;
					value +=
						escaped === "u" ? String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 5), 16)) : escaped;
					index += escaped === "u" ? 5 : 1;
				} else value += next;
			}
			out.push({ kind: "string", value });
		} else if (char === "$") {
			const match = /^\$([_A-Za-z][_0-9A-Za-z]*)/.exec(source.slice(index));
			if (match === null) return undefined;
			out.push({ kind: "variable", value: match[1] ?? "" });
			index += match[0].length;
		} else if (/[_A-Za-z]/.test(char)) {
			const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index));
			out.push({ kind: "name", value: match?.[0] ?? char });
			index += match?.[0].length ?? 1;
		} else if (/[-0-9]/.test(char)) {
			const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
			if (match === null) return undefined;
			out.push({ kind: "number", value: match[0] });
			index += match[0].length;
		} else if (source.startsWith("...", index)) {
			out.push({ kind: "punct", value: "..." });
			index += 3;
		} else if ("!():=@[]{}|&".includes(char)) {
			out.push({ kind: "punct", value: char });
			index += 1;
		} else return undefined;
	}
	return out;
}

/**
 * The operations of a GraphQL document, or undefined when it doesn't parse as one. Only what classifying needs is read:
 * each operation's type and name, and its root fields with their arguments; nested selections are skipped by brackets.
 */
export function graphqlOperations(source: string): GraphQLOperation[] | undefined {
	const list = tokens(source);
	if (list === undefined) return undefined;
	const out: GraphQLOperation[] = [];
	let at = 0;
	const peek = () => list[at];
	const is = (value: string) => peek()?.kind === "punct" && peek()?.value === value;
	/** Skips a bracketed group starting at an opening bracket; false when it never closes. */
	const skipGroup = (): boolean => {
		const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
		const stack: string[] = [];
		do {
			const token = list[at];
			if (token === undefined) return false;
			at += 1;
			if (token.kind !== "punct") continue;
			if (pairs[token.value] !== undefined) stack.push(pairs[token.value] ?? "");
			else if (token.value === stack[stack.length - 1]) stack.pop();
			else if (")]}".includes(token.value)) return false;
		} while (stack.length > 0);
		return true;
	};
	const skipDirectives = (): boolean => {
		while (is("@")) {
			at += 1;
			if (peek()?.kind !== "name") return false;
			at += 1;
			if (is("(") && !skipGroup()) return false;
		}
		return true;
	};
	/** A root selection set: its fields and arguments, from `{` to its `}`. */
	const selection = (): { fields: GraphQLField[]; spreads: boolean } | undefined => {
		if (!is("{")) return undefined;
		at += 1;
		const fields: GraphQLField[] = [];
		let spreads = false;
		while (!is("}")) {
			const token = peek();
			if (token === undefined) return undefined;
			if (token.kind === "punct" && token.value === "...") {
				spreads = true;
				at += 1;
				if (peek()?.kind === "name" && peek()?.value === "on") at += 2;
				else if (peek()?.kind === "name") at += 1;
				if (!skipDirectives()) return undefined;
				if (is("{") && !skipGroup()) return undefined;
				continue;
			}
			if (token.kind !== "name") return undefined;
			at += 1;
			let name = token.value;
			if (is(":")) {
				at += 1;
				const real = peek();
				if (real?.kind !== "name") return undefined;
				name = real.value;
				at += 1;
			}
			const args: Record<string, string> = {};
			if (is("(")) {
				at += 1;
				while (!is(")")) {
					const arg = peek();
					if (arg?.kind !== "name") return undefined;
					at += 1;
					if (!is(":")) return undefined;
					at += 1;
					const value = peek();
					if (value === undefined) return undefined;
					if (value.kind === "punct") {
						if (!"[{".includes(value.value) || !skipGroup()) return undefined;
						args[arg.value] = "";
					} else {
						args[arg.value] = value.kind === "variable" ? `$${value.value}` : value.value;
						at += 1;
					}
				}
				at += 1;
			}
			if (!skipDirectives()) return undefined;
			if (is("{") && !skipGroup()) return undefined;
			fields.push({ name, args });
		}
		at += 1;
		return { fields, spreads };
	};
	while (at < list.length) {
		const token = peek();
		if (token?.kind === "punct" && token.value === "{") {
			const root = selection();
			if (root === undefined) return undefined;
			out.push({ type: "query", ...root });
			continue;
		}
		if (token?.kind !== "name") return undefined;
		if (token.value === "fragment") {
			at += 1;
			while (at < list.length && !is("{")) at += 1;
			if (!skipGroup()) return undefined;
			continue;
		}
		if (token.value !== "query" && token.value !== "mutation" && token.value !== "subscription") return undefined;
		at += 1;
		let name: string | undefined;
		if (peek()?.kind === "name") {
			name = peek()?.value;
			at += 1;
		}
		if (is("(") && !skipGroup()) return undefined;
		if (!skipDirectives()) return undefined;
		const root = selection();
		if (root === undefined) return undefined;
		out.push({ type: token.value, ...(name === undefined ? {} : { name }), ...root });
	}
	return out;
}

/** A GraphQL request's body: `{ query, operationName?, variables? }`. */
function graphqlBody(
	body: string | undefined,
):
	| { readonly query: string; readonly operationName?: string; readonly variables: Readonly<Record<string, unknown>> }
	| undefined {
	if (body === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const { query, operationName, variables } = parsed as Record<string, unknown>;
	if (typeof query !== "string") return undefined;
	if (operationName !== undefined && operationName !== null && typeof operationName !== "string") return undefined;
	return {
		query,
		...(typeof operationName === "string" ? { operationName } : {}),
		variables:
			typeof variables === "object" && variables !== null && !Array.isArray(variables)
				? (variables as Record<string, unknown>)
				: {},
	};
}

/** A GraphQL request the classifier can't read with confidence: a write, on no resource. */
const UNREAD_GRAPHQL: ConnectionOperation = {
	id: "graphql",
	label: "GraphQL request",
	group: "repo",
	access: "write",
};

/** The operation of a GraphQL request: a query reads, a mutation (or anything unsure) writes. */
export function classifyGraphQL(method: string, body: string | undefined): ConnectionOperation {
	// GitHub's GraphQL API takes only POST; anything else carries no document to read.
	if (method !== "POST") return { ...UNREAD_GRAPHQL, access: method === "GET" || method === "HEAD" ? "read" : "write" };
	const request = graphqlBody(body);
	if (request === undefined) return UNREAD_GRAPHQL;
	const operations = graphqlOperations(request.query);
	if (operations === undefined || operations.length === 0) return UNREAD_GRAPHQL;
	const chosen =
		request.operationName === undefined
			? operations.length === 1
				? operations[0]
				: undefined
			: operations.find((operation) => operation.name === request.operationName);
	if (chosen === undefined) return UNREAD_GRAPHQL;
	const fields = [...new Set(chosen.fields.map((field) => field.name))];
	const words = fields.length === 0 ? "" : `: ${fields.join(", ")}`;
	// A query only when nothing in the document could make GitHub read it otherwise.
	const read = chosen.type === "query" && !/\b(?:mutation|subscription)\b/.test(request.query);
	if (!read) {
		return {
			id: chosen.type === "query" ? "graphql" : `graphql/${chosen.type}`,
			label: `GraphQL ${chosen.type}${words}`,
			group: "repo",
			access: "write",
		};
	}
	const resource = chosen.spreads ? undefined : queryRepository(chosen.fields, request.variables);
	return {
		id: "graphql/query",
		label: `GraphQL query${words}${resource === undefined ? "" : ` in ${resource}`}`,
		group: "repo",
		access: "read",
		...(resource === undefined ? {} : { resource }),
	};
}

/** The one repository a query reads, when every root field is `repository(owner:, name:)` naming the same one. */
function queryRepository(
	fields: readonly GraphQLField[],
	variables: Readonly<Record<string, unknown>>,
): string | undefined {
	if (fields.length === 0) return undefined;
	const value = (raw: string | undefined): string | undefined => {
		if (raw === undefined) return undefined;
		if (!raw.startsWith("$")) return raw;
		const given = variables[raw.slice(1)];
		return typeof given === "string" ? given : undefined;
	};
	let named: string | undefined;
	for (const field of fields) {
		if (field.name !== "repository") return undefined;
		const found = repository(value(field.args.owner), value(field.args.name));
		if (found === undefined) return undefined;
		if (named !== undefined && named.toLowerCase() !== found.toLowerCase()) return undefined;
		named ??= found;
	}
	return named;
}
