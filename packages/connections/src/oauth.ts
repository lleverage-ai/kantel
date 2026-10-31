/**
 * OAuth for connections (#327, #338): PKCE, remote MCP authorisation discovery (RFC 9728 protected-resource metadata,
 * RFC 8414 authorisation server metadata, OpenID discovery), dynamic client registration (RFC 7591), the client ID
 * metadata document Kantel publishes (CIMD), the token exchange and refresh, and the device flow (RFC 8628) for a
 * public client. Network calls go through the `Fetch` the caller passes, never following redirects, and only to https
 * URLs on public hosts.
 */
import { KantelError } from "@kantel/contracts";
import type { Fetch } from "./ports.ts";

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random URL-safe token of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
	return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export async function pkcePair(): Promise<{ readonly verifier: string; readonly challenge: string }> {
	const verifier = randomToken(48);
	return { verifier, challenge: await sha256(verifier) };
}

const PRIVATE_HOST =
	/^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

/**
 * Checks `value` is an https URL on a public host name, the only kind Kantel fetches for discovery, registration and
 * tokens on someone's say-so. `allowHttp` is for tests against a local server.
 */
export function publicUrl(value: string, what: string, allowHttp = false): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new KantelError("invalid", `${what} is not a URL`);
	}
	if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
		throw new KantelError("invalid", `${what} must be an https URL`);
	}
	if (!allowHttp && (url.hostname.endsWith(".") || PRIVATE_HOST.test(url.hostname) || !url.hostname.includes("."))) {
		throw new KantelError("invalid", `${what} must be on a public host`);
	}
	if (url.username !== "" || url.password !== "") throw new KantelError("invalid", `${what} must not carry a login`);
	return url;
}

export interface AuthServerMetadata {
	readonly issuer: string;
	readonly authorization_endpoint: string;
	readonly token_endpoint: string;
	readonly registration_endpoint?: string;
	readonly revocation_endpoint?: string;
	readonly scopes_supported?: readonly string[];
	readonly code_challenge_methods_supported?: readonly string[];
	readonly token_endpoint_auth_methods_supported?: readonly string[];
	readonly client_id_metadata_document_supported?: boolean;
}

export interface McpAuthDiscovery {
	readonly url: string;
	readonly auth: "oauth" | "none" | "unknown";
	readonly resource?: string;
	readonly scopes?: readonly string[];
	readonly server?: AuthServerMetadata;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

async function getJson(fetch: Fetch, url: string, signal?: AbortSignal): Promise<unknown | undefined> {
	try {
		const response = await fetch(url, {
			headers: { accept: "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
			redirect: "manual",
			...(signal === undefined ? {} : { signal }),
		});
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	}
}

/** The `resource_metadata` and `scope` parameters of a `WWW-Authenticate: Bearer …` challenge. */
export function parseBearerChallenge(header: string | null): { resourceMetadata?: string; scope?: string } {
	if (header === null || !/^\s*bearer\b/i.test(header)) return {};
	const param = (name: string) => header.match(new RegExp(`${name}="([^"]*)"`, "i"))?.[1];
	const resourceMetadata = param("resource_metadata");
	const scope = param("scope");
	return {
		...(resourceMetadata === undefined ? {} : { resourceMetadata }),
		...(scope === undefined ? {} : { scope }),
	};
}

/** RFC 8414 / OpenID discovery for an issuer, trying each well-known location the MCP spec lists. */
export async function authServerMetadata(
	fetch: Fetch,
	issuer: string,
	options: { readonly allowHttp?: boolean; readonly signal?: AbortSignal } = {},
): Promise<AuthServerMetadata | undefined> {
	const url = publicUrl(issuer, "The authorisation server", options.allowHttp);
	const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
	const candidates = [
		`${url.origin}/.well-known/oauth-authorization-server${path}`,
		`${url.origin}/.well-known/openid-configuration${path}`,
		...(path === "" ? [] : [`${url.origin}${path}/.well-known/openid-configuration`]),
	];
	for (const candidate of candidates) {
		const found = await getJson(fetch, candidate, options.signal);
		if (isMetadata(found)) return found;
	}
	return undefined;
}

function isMetadata(value: unknown): value is AuthServerMetadata {
	if (typeof value !== "object" || value === null) return false;
	const metadata = value as Record<string, unknown>;
	return typeof metadata.authorization_endpoint === "string" && typeof metadata.token_endpoint === "string";
}

const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

/**
 * What a remote MCP server says about its auth (MCP authorisation spec, 2025-06-18 and later): an unauthenticated
 * `initialize` either succeeds (`none`) or is refused with a Bearer challenge naming its protected-resource metadata;
 * failing that, the well-known locations are tried, and last the server's own origin as its authorisation server.
 */
export async function discoverMcpAuth(
	fetch: Fetch,
	mcpUrl: string,
	options: { readonly allowHttp?: boolean; readonly signal?: AbortSignal } = {},
): Promise<McpAuthDiscovery> {
	const url = publicUrl(mcpUrl, "The MCP server's URL", options.allowHttp);
	let response: Response;
	try {
		response = await fetch(url.href, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": MCP_PROTOCOL_VERSION,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "Kantel", version: "1" },
				},
			}),
			redirect: "manual",
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch {
		throw new KantelError("unavailable", `The MCP server at ${url.host} did not answer`);
	}
	await response.body?.cancel().catch(() => undefined);
	if (response.ok) return { url: url.href, auth: "none" };
	if (response.status !== 401 && response.status !== 403) return { url: url.href, auth: "unknown" };

	const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
	const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
	const prmCandidates = [
		...(challenge.resourceMetadata === undefined ? [] : [challenge.resourceMetadata]),
		`${url.origin}/.well-known/oauth-protected-resource${path}`,
		`${url.origin}/.well-known/oauth-protected-resource`,
	];
	let prm: Record<string, unknown> | undefined;
	for (const candidate of prmCandidates) {
		try {
			publicUrl(candidate, "The protected-resource metadata", options.allowHttp);
		} catch {
			continue;
		}
		const found = await getJson(fetch, candidate, options.signal);
		if (typeof found === "object" && found !== null) {
			prm = found as Record<string, unknown>;
			break;
		}
	}
	const issuers = strings(prm?.authorization_servers) ?? [];
	const issuer = issuers[0] ?? url.origin;
	const server = await authServerMetadata(fetch, issuer, options);
	const resource = typeof prm?.resource === "string" ? prm.resource : undefined;
	const scopes =
		challenge.scope?.split(" ").filter(Boolean) ?? strings(prm?.scopes_supported) ?? server?.scopes_supported;
	return {
		url: url.href,
		auth: server === undefined ? "unknown" : "oauth",
		...(resource === undefined ? {} : { resource }),
		...(scopes === undefined || scopes.length === 0 ? {} : { scopes: [...scopes] }),
		...(server === undefined ? {} : { server }),
	};
}

/** The client ID metadata document Kantel publishes at its client ID (CIMD, draft-ietf-oauth-client-id-metadata-document). */
export function clientMetadataDocument(input: {
	readonly clientId: string;
	readonly origin: string;
	readonly redirectUri: string;
	readonly clientName: string;
}): Record<string, unknown> {
	return {
		client_id: input.clientId,
		client_name: input.clientName,
		client_uri: input.origin,
		redirect_uris: [input.redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
}

export interface RegisteredClient {
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly tokenEndpointAuthMethod: string;
}

/** Dynamic client registration (RFC 7591): a public client using PKCE, for Kantel's callback. */
export async function registerClient(
	fetch: Fetch,
	endpoint: string,
	input: {
		readonly redirectUri: string;
		readonly clientName: string;
		readonly origin: string;
		readonly scope?: string;
	},
	options: { readonly allowHttp?: boolean; readonly signal?: AbortSignal } = {},
): Promise<RegisteredClient> {
	publicUrl(endpoint, "The registration endpoint", options.allowHttp);
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				client_name: input.clientName,
				client_uri: input.origin,
				redirect_uris: [input.redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				...(input.scope === undefined ? {} : { scope: input.scope }),
			}),
			redirect: "manual",
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch {
		throw new KantelError("unavailable", "The authorisation server's registration endpoint did not answer");
	}
	const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if (!response.ok || typeof body?.client_id !== "string") {
		const reason = typeof body?.error_description === "string" ? `: ${body.error_description.slice(0, 200)}` : "";
		throw new KantelError("refused", `Dynamic client registration was refused (${response.status})${reason}`);
	}
	return {
		clientId: body.client_id,
		...(typeof body.client_secret === "string" ? { clientSecret: body.client_secret } : {}),
		tokenEndpointAuthMethod:
			typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none",
	};
}

export interface TokenSet {
	readonly accessToken: string;
	readonly refreshToken?: string;
	/** Milliseconds since the epoch. */
	readonly expiresAt?: number;
	readonly scopes?: readonly string[];
	readonly idToken?: string;
}

export interface TokenClient {
	readonly clientId: string;
	readonly clientSecret?: string;
	/** `client_secret_basic`, `client_secret_post` or `none`. Default `client_secret_post` with a secret. */
	readonly authMethod?: string;
}

/** Posts a token request and reads the answer, as JSON or (GitHub, without the header) form-encoded. */
export async function tokenRequest(
	fetch: Fetch,
	tokenUrl: string,
	client: TokenClient,
	params: Record<string, string>,
	options: { readonly allowHttp?: boolean; readonly now: number; readonly signal?: AbortSignal },
): Promise<TokenSet> {
	publicUrl(tokenUrl, "The token endpoint", options.allowHttp);
	const body = new URLSearchParams(params);
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	};
	const method = client.authMethod ?? (client.clientSecret === undefined ? "none" : "client_secret_post");
	if (method === "client_secret_basic" && client.clientSecret !== undefined) {
		headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
	} else {
		body.set("client_id", client.clientId);
		if (client.clientSecret !== undefined && method !== "none") body.set("client_secret", client.clientSecret);
	}
	let response: Response;
	try {
		response = await fetch(tokenUrl, {
			method: "POST",
			headers,
			body: body.toString(),
			redirect: "manual",
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch {
		throw new KantelError("unavailable", "The token endpoint did not answer");
	}
	const parsed = parseAnswer(await response.text());
	if (!response.ok || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
		// The provider's words, with nothing of what was sent: a server that echoes the code, refresh token or client
		// secret back in its error must not put it in a message someone reads.
		const sent = [...body.values(), client.clientSecret ?? ""];
		const { error, description } = providerError(parsed, response.status, sent);
		throw new KantelError(
			error === "invalid_grant" ? "refused" : "unavailable",
			`The token request failed (${error})${description === undefined ? "" : `: ${description}`}`,
		);
	}
	return tokenSetFrom(parsed, parsed.access_token, options.now);
}

/** A token answer's fields, once it is known to carry an access token. */
function tokenSetFrom(parsed: Record<string, unknown>, accessToken: string, now: number): TokenSet {
	const expiresIn = Number(parsed.expires_in);
	const scope = typeof parsed.scope === "string" ? parsed.scope.split(/[ ,]+/).filter(Boolean) : undefined;
	return {
		accessToken,
		...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
			? { refreshToken: parsed.refresh_token }
			: {}),
		...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
		...(scope === undefined ? {} : { scopes: scope }),
		...(typeof parsed.id_token === "string" ? { idToken: parsed.id_token } : {}),
	};
}

/** A JSON answer, or (GitHub without the accept header) a form-encoded one. */
function parseAnswer(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return Object.fromEntries(new URLSearchParams(text));
	}
}

/**
 * A provider's error code and description, safe to show: the code only if it looks like one, the description cut short
 * and with every value Kantel sent (`sent`, four characters or more) cut out of it.
 */
function providerError(
	parsed: Record<string, unknown>,
	status: number,
	sent: readonly string[],
): { readonly error: string; readonly description?: string } {
	const values = sent.filter((value) => value.length >= 4);
	const scrub = (text: string) => values.reduce((out, value) => out.split(value).join("[redacted]"), text);
	const error =
		typeof parsed.error === "string" && /^[a-z0-9_.-]{1,64}$/i.test(parsed.error) ? parsed.error : `status ${status}`;
	return typeof parsed.error_description === "string"
		? { error, description: scrub(parsed.error_description).slice(0, 200) }
		: { error };
}

/** How long a revocation request may take before a disconnect gives up on it and says so (#329). */
export const REVOKE_TIMEOUT_MS = 10_000;

/** A revocation's answer: the provider confirmed it, or why not, in words with nothing Kantel sent in them. */
export type RevokeResult = { readonly revoked: true } | { readonly revoked: false; readonly reason: string };

/**
 * Revokes one token at the provider (#329), once, never following a redirect.
 * - `rfc7009`: RFC 7009 section 2.1: a form POST of `token` and `token_type_hint`, with the client authenticated the
 *   way its token requests are (`client_secret_basic`, `client_secret_post`, or only `client_id` for a public client).
 *   Any 2xx is success: the RFC answers 200 for a token already invalid too.
 * - `github_grant`: GitHub's `DELETE /applications/{client_id}/grant` with the client's ID and secret as Basic auth and
 *   the access token in the body. It ends every token of that grant. Answers 204.
 */
export async function revokeToken(
	fetch: Fetch,
	input: {
		readonly url: string;
		readonly style: "rfc7009" | "github_grant";
		readonly client: TokenClient;
		readonly token: string;
		readonly hint: "access_token" | "refresh_token";
	},
	options: { readonly allowHttp?: boolean; readonly signal?: AbortSignal } = {},
): Promise<RevokeResult> {
	publicUrl(input.url, "The revocation endpoint", options.allowHttp);
	const { client } = input;
	const sent = [input.token, client.clientSecret ?? ""];
	let response: Response;
	try {
		if (input.style === "github_grant") {
			if (client.clientSecret === undefined) return { revoked: false, reason: "GitHub needs the app's client secret" };
			response = await fetch(input.url, {
				method: "DELETE",
				headers: {
					authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
					accept: "application/vnd.github+json",
					"content-type": "application/json",
					"x-github-api-version": "2022-11-28",
				},
				body: JSON.stringify({ access_token: input.token }),
				redirect: "manual",
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		} else {
			const body = new URLSearchParams({ token: input.token, token_type_hint: input.hint });
			const headers: Record<string, string> = {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			};
			const method = client.authMethod ?? (client.clientSecret === undefined ? "none" : "client_secret_post");
			if (method === "client_secret_basic" && client.clientSecret !== undefined) {
				headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
			} else {
				body.set("client_id", client.clientId);
				if (client.clientSecret !== undefined && method !== "none") body.set("client_secret", client.clientSecret);
			}
			response = await fetch(input.url, {
				method: "POST",
				headers,
				body: body.toString(),
				redirect: "manual",
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		}
	} catch (error) {
		const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		return {
			revoked: false,
			reason: timedOut ? "The revocation endpoint did not answer in time" : "The revocation endpoint did not answer",
		};
	}
	const text = await response.text().catch(() => "");
	if (response.status >= 200 && response.status < 300) return { revoked: true };
	const { error, description } = providerError(parseAnswer(text), response.status, sent);
	return {
		revoked: false,
		reason: `The provider refused the revocation (${error})${description === undefined ? "" : `: ${description}`}`,
	};
}

/** What a device authorisation endpoint hands out (RFC 8628 section 3.2). The device code stays inside Kantel. */
export interface DeviceAuthorization {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly verificationUri: string;
	/** Seconds until the codes expire. */
	readonly expiresIn: number;
	/** Seconds to wait between polls. */
	readonly interval: number;
}

/** What GitHub says when its app has the device flow turned off, in words a person can act on. */
export const DEVICE_FLOW_DISABLED = "Device flow is turned off for this GitHub app: enable it in the app's settings";

/**
 * Asks a device authorisation endpoint for a device code and a user code (RFC 8628), for a public client: only the
 * client ID and the scopes are sent, never a secret.
 */
export async function deviceAuthorization(
	fetch: Fetch,
	endpoint: string,
	input: { readonly clientId: string; readonly scope?: string },
	options: { readonly allowHttp?: boolean; readonly signal?: AbortSignal } = {},
): Promise<DeviceAuthorization> {
	publicUrl(endpoint, "The device authorisation endpoint", options.allowHttp);
	const body = new URLSearchParams({ client_id: input.clientId });
	if (input.scope !== undefined && input.scope !== "") body.set("scope", input.scope);
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: body.toString(),
			redirect: "manual",
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch {
		throw new KantelError("unavailable", "The device authorisation endpoint did not answer");
	}
	const parsed = parseAnswer(await response.text());
	const deviceCode = parsed.device_code;
	const userCode = parsed.user_code;
	const verificationUri = parsed.verification_uri;
	if (
		!response.ok ||
		typeof deviceCode !== "string" ||
		deviceCode === "" ||
		typeof userCode !== "string" ||
		userCode === "" ||
		typeof verificationUri !== "string"
	) {
		const { error, description } = providerError(parsed, response.status, [...body.values()]);
		if (error === "device_flow_disabled") throw new KantelError("refused", DEVICE_FLOW_DISABLED);
		throw new KantelError(
			"refused",
			`The device sign-in could not start (${error})${description === undefined ? "" : `: ${description}`}`,
		);
	}
	// The person is sent there, so it must be a public https page like any other URL Kantel hands out.
	const verification = publicUrl(verificationUri, "The device verification page", options.allowHttp).href;
	const expiresIn = Number(parsed.expires_in);
	const interval = Number(parsed.interval);
	return {
		deviceCode,
		userCode,
		verificationUri: verification,
		expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
		interval: Number.isFinite(interval) && interval > 0 ? Math.ceil(interval) : 5,
	};
}

/** One poll of the token endpoint in the device flow. */
export type DevicePollResult =
	/** `authorization_pending`: the person hasn't typed the code yet. */
	| { readonly pending: true }
	/** `slow_down`: poll less often; `interval` when the provider names the new one, in seconds. */
	| { readonly slowDown: true; readonly interval?: number }
	/** Any other error, such as `access_denied` or `expired_token`. `description` has nothing Kantel sent in it. */
	| { readonly error: string; readonly description?: string }
	| { readonly tokens: TokenSet };

/**
 * Asks the token endpoint once whether a device code has been authorised (RFC 8628 section 3.4), for a public client:
 * the client ID, the device code and the grant type, never a secret. Unlike `tokenRequest` an error is an answer, not a
 * throw: GitHub answers 200 with `error` in the body while the person hasn't finished. Throws `unavailable` only when
 * the endpoint did not answer.
 */
export async function devicePoll(
	fetch: Fetch,
	tokenUrl: string,
	clientId: string,
	deviceCode: string,
	options: { readonly allowHttp?: boolean; readonly now: number; readonly signal?: AbortSignal },
): Promise<DevicePollResult> {
	publicUrl(tokenUrl, "The token endpoint", options.allowHttp);
	const body = new URLSearchParams({
		client_id: clientId,
		device_code: deviceCode,
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
	});
	let response: Response;
	try {
		response = await fetch(tokenUrl, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: body.toString(),
			redirect: "manual",
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch {
		throw new KantelError("unavailable", "The token endpoint did not answer");
	}
	const parsed = parseAnswer(await response.text());
	if (response.ok && typeof parsed.access_token === "string" && parsed.access_token.length > 0) {
		return { tokens: tokenSetFrom(parsed, parsed.access_token, options.now) };
	}
	const { error, description } = providerError(parsed, response.status, [deviceCode, clientId]);
	if (error === "authorization_pending") return { pending: true };
	if (error === "slow_down") {
		const interval = Number(parsed.interval);
		return Number.isFinite(interval) && interval > 0
			? { slowDown: true, interval: Math.ceil(interval) }
			: { slowDown: true };
	}
	return description === undefined ? { error } : { error, description };
}

/** The email, name and subject an ID token claims, read without verifying it: for display only, never for access. */
export function idTokenAccount(
	idToken: string | undefined,
): { id?: string; name?: string; email?: string } | undefined {
	if (idToken === undefined) return undefined;
	const payload = idToken.split(".")[1];
	if (payload === undefined) return undefined;
	try {
		const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
		const account = {
			...(typeof json.sub === "string" ? { id: json.sub } : {}),
			...(typeof json.name === "string" ? { name: json.name } : {}),
			...(typeof json.email === "string" ? { email: json.email } : {}),
		};
		return Object.keys(account).length === 0 ? undefined : account;
	} catch {
		return undefined;
	}
}
