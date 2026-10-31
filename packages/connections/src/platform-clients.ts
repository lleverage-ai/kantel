/**
 * The deployment's own OAuth clients (the `platform` tier, #326) from its configuration: `HARBOUR_OAUTH_CLIENTS`, a JSON
 * array of
 *
 * ```json
 * [{ "templateId": "github", "clientId": "Iv23li…", "label": "Harbour for GitHub" },
 *  { "templateId": "gmail", "clientId": "…apps.googleusercontent.com", "secretEnv": "HARBOUR_OAUTH_GMAIL_SECRET" }]
 * ```
 *
 * Each names a template (`templateId`) or an authorisation server (`issuer`), its public `clientId`, and optionally
 * `scopes` and a `label`. A confidential client's secret is never written in the JSON: `secretEnv` names the variable
 * (or Worker secret) holding it, read here. A client with no `secretEnv` is public: it signs in with the device flow
 * where the template has one, or with PKCE alone.
 *
 * Parsed defensively: a bad document or entry is reported in `problems` (never with a secret in it) and left out, so a
 * typo never stops the deployment starting.
 */
import type { PlatformOAuthClient } from "./ports.ts";

export interface PlatformClientsParse {
	readonly clients: readonly PlatformOAuthClient[];
	/** What was wrong and left out, for the deployment's log. Never holds a secret. */
	readonly problems: readonly string[];
}

/** An environment variable's name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** An optional string field: absent, its trimmed value, or `false` when it is there but not a non-empty string. */
const optionalString = (value: unknown): string | undefined | false =>
	value === undefined ? undefined : nonEmpty(value) ? value.trim() : false;

/** One entry as a client, or why it was left out. */
function readEntry(item: unknown, secret: (name: string) => string | undefined): PlatformOAuthClient | string {
	if (typeof item !== "object" || item === null || Array.isArray(item)) return "is not an object";
	const entry = item as Record<string, unknown>;
	if ("clientSecret" in entry || "secret" in entry) {
		// Refused rather than read: a secret in this JSON would sit in plain configuration, and in any dump of it.
		return "has a secret written in it; put it in its own variable and name that in secretEnv";
	}
	const clientId = entry.clientId;
	if (!nonEmpty(clientId)) return "has no clientId";
	const templateId = optionalString(entry.templateId);
	if (templateId === false) return "has a templateId that is not a string";
	const issuer = optionalString(entry.issuer);
	if (issuer === false || (issuer !== undefined && !issuer.startsWith("https://"))) {
		return "has an issuer that is not an https URL";
	}
	if (templateId === undefined && issuer === undefined) return "names neither a templateId nor an issuer";
	const scopes = entry.scopes;
	let scopeList: string[] | undefined;
	if (scopes !== undefined) {
		if (!Array.isArray(scopes) || !scopes.every(nonEmpty)) return "has scopes that are not a list of strings";
		scopeList = scopes.map((scope: string) => scope.trim());
	}
	const label = optionalString(entry.label);
	if (label === false) return "has a label that is not a string";
	let clientSecret: string | undefined;
	const secretEnv = entry.secretEnv;
	if (secretEnv !== undefined) {
		if (typeof secretEnv !== "string" || !ENV_NAME.test(secretEnv))
			return "has a secretEnv that is not a variable name";
		const value = secret(secretEnv);
		// Left out rather than taken as a public client: signing in without its secret would only fail at the provider.
		if (value === undefined || value.trim() === "") return `names ${secretEnv} in secretEnv, which is not set`;
		clientSecret = value.trim();
	}
	return {
		...(templateId === undefined ? {} : { templateId }),
		...(issuer === undefined ? {} : { issuer }),
		clientId: clientId.trim(),
		...(clientSecret === undefined ? {} : { clientSecret }),
		...(scopeList === undefined ? {} : { scopes: scopeList }),
		...(label === undefined ? {} : { label }),
	};
}

/**
 * Reads `HARBOUR_OAUTH_CLIENTS`'s value (`text`); `secret` looks up the variable a `secretEnv` names. Absent or blank
 * text is no clients and no problem.
 */
export function parsePlatformClients(
	text: string | undefined,
	secret: (name: string) => string | undefined,
): PlatformClientsParse {
	if (text === undefined || text.trim() === "") return { clients: [], problems: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { clients: [], problems: ["HARBOUR_OAUTH_CLIENTS is not JSON: no deployment OAuth clients were read"] };
	}
	if (!Array.isArray(parsed)) {
		return {
			clients: [],
			problems: ["HARBOUR_OAUTH_CLIENTS is not a JSON array: no deployment OAuth clients were read"],
		};
	}
	const clients: PlatformOAuthClient[] = [];
	const problems: string[] = [];
	for (const [index, item] of (parsed as unknown[]).entries()) {
		const read = readEntry(item, secret);
		if (typeof read === "string") problems.push(`HARBOUR_OAUTH_CLIENTS[${index}] ${read}, so it was left out`);
		else clients.push(read);
	}
	return { clients, problems };
}
