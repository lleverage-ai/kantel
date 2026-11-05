/**
 * Environments and egress for the command line: `--bind` and grant parsing, and the human output of `kantel env show`
 * and `kantel egress`. A protected variable's value is never printed: Kantel doesn't answer one, and should it ever,
 * `withoutProtectedValues` drops it before anything is shown.
 */
import type { KantelClient } from "@kantel/api/sdk";
import { UsageError } from "./errors.ts";
import { ago, bytes, fields, table, timestamp } from "./format.ts";

// The answers' shapes, as the SDK gives them.

export type Environment = Awaited<ReturnType<KantelClient["getEnvironment"]>>;
export type EnvironmentVariable = Environment["variables"][number];
export type EnvironmentRepo = Environment["repos"][number];
export type EgressGrant = Environment["grants"][number];
export type SandboxEgress = Awaited<ReturnType<KantelClient["getSandboxEgress"]>>;
export type EgressEntry = SandboxEgress["entries"][number];

/** Where a protected variable's value may be sent: a host, and optionally path prefixes and methods. */
export interface Binding {
	readonly host: string;
	readonly pathPrefixes?: readonly string[];
	readonly methods?: readonly string[];
}

/** A grant to send Kantel: an existing one keeps its `id`. */
export interface GrantInput {
	readonly id?: string;
	readonly action: "allow" | "deny";
	readonly host: string;
	readonly methods?: readonly string[];
	readonly paths?: readonly string[];
}

const HTTP_METHODS: readonly string[] = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
	"TRACE",
	"CONNECT",
];
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
/** `api.github.com`, or `*.example.com` for the names under it. */
const HOST = new RegExp(`^(\\*\\.)?(${LABEL}\\.)*${LABEL}$`);

const unique = (items: readonly string[]): string[] => [...new Set(items)];

/** A host as Kantel takes it, in lower case: refuses a URL, a port and anything that isn't a name. */
export function hostOf(text: string, what: string): string {
	if (text.includes("://")) throw new UsageError(`give ${what} as a host, not a URL: drop the scheme from "${text}"`);
	const host = text.toLowerCase();
	if (host.includes(":")) throw new UsageError(`give ${what} with no port, not "${text}"`);
	if (!HOST.test(host)) throw new UsageError(`"${text}" isn't a host name, such as api.github.com or *.example.com`);
	return host;
}

/**
 * One `--bind`: `<host>[/path-prefix][:METHOD,METHOD]`, such as `api.github.com`, `api.github.com/repos/:GET` or
 * `api.openai.com/v1/:POST,GET`. A path prefix of `/` is every path. A colon followed by anything other than HTTP
 * methods stays part of the path, as in `/v1/models/m:generate`.
 */
export function parseBinding(text: string): Binding {
	const trimmed = text.trim();
	if (trimmed.includes("://")) {
		throw new UsageError(`--bind takes a host, not a URL: drop the scheme from "${text}"`);
	}
	let rest = trimmed;
	let methods: string[] | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon !== -1) {
		const words = rest
			.slice(colon + 1)
			.split(",")
			.map((word) => word.trim().toUpperCase());
		if (words.every((word) => HTTP_METHODS.includes(word))) {
			methods = unique(words);
			rest = rest.slice(0, colon);
		}
	}
	const slash = rest.indexOf("/");
	const host = hostOf(slash === -1 ? rest : rest.slice(0, slash), "--bind's host");
	const path = slash === -1 ? undefined : rest.slice(slash);
	if (path !== undefined && /[?#]/.test(path)) {
		throw new UsageError(`--bind takes a path prefix with no query or fragment, not "${text}"`);
	}
	const prefix = path === undefined || path === "/" ? undefined : path;
	return {
		host,
		...(prefix === undefined ? {} : { pathPrefixes: [prefix] }),
		...(methods === undefined ? {} : { methods }),
	};
}

/**
 * `--bind`s for the same host and methods as one binding with all their path prefixes; one with no prefix (every
 * path) stays so.
 */
export function mergeBindings(bindings: readonly Binding[]): Binding[] {
	const keyOf = (binding: Binding): string => `${binding.host} ${[...(binding.methods ?? [])].sort().join(",")}`;
	const merged: Binding[] = [];
	for (const binding of bindings) {
		const index = merged.findIndex((item) => keyOf(item) === keyOf(binding));
		const existing = index === -1 ? undefined : merged[index];
		if (existing === undefined) {
			merged.push(binding);
			continue;
		}
		const prefixes =
			existing.pathPrefixes === undefined || binding.pathPrefixes === undefined
				? undefined
				: unique([...existing.pathPrefixes, ...binding.pathPrefixes]);
		merged[index] = {
			host: existing.host,
			...(prefixes === undefined ? {} : { pathPrefixes: prefixes }),
			...(existing.methods === undefined ? {} : { methods: existing.methods }),
		};
	}
	return merged;
}

/** A binding as `--bind` takes it: one per path prefix, such as `api.openai.com/v1/:POST,GET`. */
export function bindingTexts(binding: Binding): string[] {
	const methods = binding.methods === undefined || binding.methods.length === 0 ? "" : `:${binding.methods.join(",")}`;
	const prefixes =
		binding.pathPrefixes === undefined || binding.pathPrefixes.length === 0 ? [""] : binding.pathPrefixes;
	return prefixes.map((prefix) => `${binding.host}${prefix}${methods}`);
}

export const bindingsText = (bindings: readonly Binding[]): string => bindings.flatMap(bindingTexts).join(", ");

/** A grant from the command line: `allow|deny <host>`, `--method` and `--path`. */
export function parseGrant(
	action: string,
	hostText: string,
	methodTexts: readonly string[],
	pathTexts: readonly string[],
): GrantInput {
	if (action !== "allow" && action !== "deny") {
		throw new UsageError(`a grant is allow or deny, not "${action}"`);
	}
	const host = hostText === "*" ? "*" : hostOf(hostText, "the grant's host");
	const methods = unique(
		methodTexts.map((method) => {
			const upper = method.trim().toUpperCase();
			if (!/^[A-Z]+$/.test(upper)) throw new UsageError(`--method takes an HTTP method, such as GET, not "${method}"`);
			return upper;
		}),
	);
	const paths = unique(
		pathTexts.map((path) => {
			if (!path.startsWith("/")) throw new UsageError(`--path takes a path starting with /, not "${path}"`);
			return path;
		}),
	);
	return {
		action,
		host,
		...(methods.length === 0 ? {} : { methods }),
		...(paths.length === 0 ? {} : { paths }),
	};
}

/** A grant as the egress log's rule names it, such as `deny DELETE api.github.com /repos/*`. */
export function grantText(grant: GrantInput): string {
	const methods = grant.methods === undefined || grant.methods.length === 0 ? [] : [grant.methods.join(",")];
	const paths = grant.paths === undefined ? [] : grant.paths;
	return [grant.action, ...methods, grant.host, ...paths].join(" ");
}

/**
 * `value` with the `value` of anything marked `protected: true` left out, at any depth. Kantel never answers a
 * protected variable's value; this makes sure the command line never prints one, even with `--json`.
 */
export function withoutProtectedValues(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutProtectedValues);
	if (typeof value !== "object" || value === null) return value;
	const record = value as { readonly [key: string]: unknown };
	const kept: { [key: string]: unknown } = {};
	for (const [key, item] of Object.entries(record)) {
		if (key === "value" && record.protected === true) continue;
		kept[key] = withoutProtectedValues(item);
	}
	return kept;
}

const indent = (text: string): string =>
	text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");

function section(title: string, header: readonly string[], rows: readonly (readonly string[])[]): string {
	return rows.length === 0 ? `${title}: none` : `${title}:\n${indent(table(header, rows))}`;
}

/** A plain variable's value on one line. */
const shownValue = (value: string | undefined): string =>
	value === undefined ? "" : /[\n\r]/.test(value) ? JSON.stringify(value) : value;

/** A file's mode as octal, such as `0600`. */
export const octal = (mode: number): string => mode.toString(8).padStart(4, "0");

/** `kantel env show`: the environment, its variables (a protected one's bindings, never its value), files, repos and grants. */
export function describeEnvironment(environment: Environment): string {
	const variables = environment.variables.map((variable: EnvironmentVariable) =>
		variable.protected
			? [variable.name, "protected", bindingsText(variable.bindings ?? [])]
			: [variable.name, shownValue(variable.value), ""],
	);
	const files = environment.files.map((file) => [
		file.path,
		octal(file.mode),
		bytes(file.sizeBytes),
		ago(file.updatedAt),
	]);
	const repos = environment.repos.map((repo: EnvironmentRepo) => [repo.url, repo.path ?? "", repo.ref ?? ""]);
	const grants = environment.grants.map((grant: EgressGrant) => [grant.id, grantText(grant)]);
	return [
		fields([
			["id", environment.id],
			["name", environment.name],
			["description", environment.description],
			["sandboxes", String(environment.sandboxCount)],
			["updated", `${timestamp(environment.updatedAt)} (${ago(environment.updatedAt)})`],
		]),
		"",
		section("Variables", ["NAME", "VALUE", "SENT ONLY TO"], variables),
		section("Files", ["PATH", "MODE", "SIZE", "UPDATED"], files),
		section("Repos", ["URL", "PATH", "REF"], repos),
		section("Grants", ["ID", "RULE"], grants),
	].join("\n");
}

/** `kantel env list`. */
export function environmentTable(environments: readonly Environment[]): string {
	return table(
		["ID", "NAME", "VARIABLES", "FILES", "REPOS", "GRANTS", "SANDBOXES", "UPDATED"],
		environments.map((environment) => [
			environment.id,
			environment.name,
			String(environment.variables.length),
			String(environment.files.length),
			String(environment.repos.length),
			String(environment.grants.length),
			String(environment.sandboxCount),
			ago(environment.updatedAt),
		]),
	);
}

/** A log entry's time, to the second: `2026-11-03 14:05:09`. */
const second = (at: number): string => new Date(at).toISOString().slice(0, 19).replace("T", " ");

/** Where a request went: its host, a port other than 443 or 80, and its path (Kantel never keeps the query). */
function destination(entry: EgressEntry): string {
	const port = entry.port === 443 || entry.port === 80 ? "" : `:${entry.port}`;
	return `${entry.host}${port}${entry.path ?? ""}`;
}

/** `kantel egress`: what the sandbox has, then its log as a table, newest first as Kantel answers it. */
export function describeEgress(egress: SandboxEgress, entries: readonly EgressEntry[], deniedOnly: boolean): string {
	const environment = egress.environment;
	const protectedVariables = egress.protectedVariables.map(
		(variable) => `${variable.name} (${variable.placeholderPrefix}…) to ${bindingsText(variable.bindings)}`,
	);
	const grants = [
		...egress.environmentGrants.map((grant: EgressGrant) => `${grantText(grant)} (environment, ${grant.id})`),
		...egress.grants.map((grant: EgressGrant) => `${grantText(grant)} (sandbox, ${grant.id})`),
	];
	const head = fields([
		["sandbox", `${egress.sandboxId} (${egress.sandboxName})`],
		["environment", environment === undefined ? undefined : `${environment.name} (${environment.id})`],
		["protected", protectedVariables.join("; ")],
		["grants", grants.join("; ")],
	]);
	if (entries.length === 0) {
		return `${head}\n\n${deniedOnly ? "No refused requests." : "No requests yet."}`;
	}
	const rows = entries.map((entry) => [
		second(entry.at),
		entry.method,
		destination(entry),
		entry.status === undefined ? entry.decision : `${entry.decision} ${entry.status}`,
		[entry.code, entry.rule ?? entry.reason].filter((part) => part !== undefined && part !== "").join(": "),
		entry.swapped.join(","),
	]);
	return `${head}\n\n${table(["TIME", "METHOD", "DESTINATION", "DECISION", "CODE/RULE", "SWAPPED"], rows)}`;
}
