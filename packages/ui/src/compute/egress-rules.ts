// The words and checks the Environments and egress pages share: what a host, a path prefix and a variable's name may
// be, and how a binding or a grant reads in a table. The API checks the same things; these say what's wrong as you type.

import { type DestinationBinding, type EgressGrant, HTTP_METHODS, type HttpMethod } from "./compute-model.ts";

/** A host name, optionally `*.` for every subdomain. No scheme, path or port: a binding is to HTTPS on 443. */
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/i;

/** Why `host` can't be bound or granted, or undefined when it can. */
export function hostProblem(host: string): string | undefined {
	const value = host.trim();
	if (value === "") return "Give a host, such as api.github.com.";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return "Write the host alone, without https://.";
	if (value.includes("/")) return "Write the host alone, with no path. Paths go in their own field.";
	if (value.includes(":")) return "Write the host alone, with no port.";
	if (value === "*" || value.startsWith("*") !== value.startsWith("*.")) {
		return "A wildcard covers subdomains only: *.example.com.";
	}
	if (!HOST.test(value)) return "That isn't a host name.";
	return undefined;
}

/** A dotted IPv4 address: the account's allow and deny lists match one exactly. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An account list's host: one label or more, so `registry` and `*.ru` too, as the host's `matchHost` takes them. */
const ACCOUNT_HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

/** Why `host` can't go on the account's allow or deny list, or undefined when it can: a host name, or an address. */
export function accountHostProblem(host: string): string | undefined {
	const value = host.trim();
	if (IPV4.test(value)) return undefined;
	const problem = hostProblem(value);
	if (problem === undefined || problem !== "That isn't a host name.") return problem;
	return ACCOUNT_HOST.test(value) && !/^[\d.]+$/.test(value) ? undefined : problem;
}

/** Why `prefix` can't be a path prefix, or undefined when it can. */
export function pathProblem(prefix: string): string | undefined {
	if (!prefix.startsWith("/")) return "A path starts with /.";
	if (/[?#\s]/.test(prefix)) return "A path has no query, fragment or spaces.";
	return undefined;
}

/** A comma- or newline-separated list as its entries, trimmed, blanks dropped. */
export function splitList(text: string): readonly string[] {
	return text
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/** An environment variable's name, as the API checks it: what a shell accepts, and not one Kantel sets itself. */
export function variableNameProblem(name: string): string | undefined {
	if (name === "") return "Give the variable a name.";
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "Use letters, digits and underscores, not starting with a digit.";
	if (name.length > 255) return "Keep the name to 255 characters.";
	if (/^(KANTEL_|HTTPS?_PROXY$|NO_PROXY$)/i.test(name)) return "Kantel sets this one itself. Choose another name.";
	return undefined;
}

/** Why `url` can't be added beside the repositories at `taken`, or undefined when it can. A repository is its address. */
export function repoUrlProblem(url: string, taken: readonly string[]): string | undefined {
	const value = url.trim();
	if (!/^https:\/\/[^\s/]+\/\S+$/.test(value)) return "Give its https address, such as https://github.com/owner/name.";
	if (taken.some((each) => repoKey(each) === repoKey(value))) return "The environment already has this repository.";
	return undefined;
}

/** Hosts whose repository paths ignore case, so `Owner/Repo` and `owner/repo` are one repository there. */
const CASELESS_GIT_HOSTS = new Set(["github.com", "gitlab.com"]);

/**
 * A repository address as one repository: the host's case and a `.git` or trailing slash don't matter, and the path's
 * case matters except on a host known to ignore it (another Git server may keep `Service` and `service` apart).
 */
function repoKey(url: string): string {
	const trimmed = url
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return trimmed;
	}
	const host = parsed.host.toLowerCase();
	const path = parsed.pathname.replace(/\/+$/, "");
	return `${host}${CASELESS_GIT_HOSTS.has(host) ? path.toLowerCase() : path}`;
}

export const isMethod = (value: string): value is HttpMethod => (HTTP_METHODS as readonly string[]).includes(value);

/** `api.github.com`, `POST api.openai.com /v1/`, `GET, PUT registry.npmjs.org`. */
export function bindingText(binding: DestinationBinding): string {
	const methods = binding.methods.length === 0 ? "" : `${binding.methods.join(", ")} `;
	const paths = binding.pathPrefixes.length === 0 ? "" : ` ${binding.pathPrefixes.join(", ")}`;
	return `${methods}${binding.host}${paths}`;
}

/** `allow api.github.com`, `deny DELETE api.github.com /repos/*`. */
export function grantText(grant: EgressGrant): string {
	const methods = grant.methods.length === 0 ? "" : ` ${grant.methods.join(", ")}`;
	const paths = grant.paths.length === 0 ? "" : ` ${grant.paths.join(", ")}`;
	return `${grant.action}${methods} ${grant.host}${paths}`;
}

/** The hosts whose HTTPS the proxy looks inside: protected variables' bindings and grants that name methods or paths. */
export function inspectedHosts(bindings: readonly DestinationBinding[], grants: readonly EgressGrant[]): string[] {
	const hosts = new Set<string>();
	for (const binding of bindings) hosts.add(binding.host);
	for (const grant of grants) if (grant.methods.length > 0 || grant.paths.length > 0) hosts.add(grant.host);
	return [...hosts].sort();
}

/** "0600". */
export const modeText = (mode: number): string => mode.toString(8).padStart(4, "0");
