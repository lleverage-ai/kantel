/**
 * OAuth for connections (#327, #338): PKCE, remote MCP authorisation discovery (RFC 9728 protected-resource metadata,
 * RFC 8414 authorisation server metadata, OpenID discovery), dynamic client registration (RFC 7591), the client ID
 * metadata document Harbour publishes (CIMD), and the token exchange and refresh. Network calls go through the `Fetch`
 * the caller passes, never following redirects, and only to https URLs on public hosts.
 */
import { HarbourError } from "@harbour/contracts";
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
 * Checks `value` is an https URL on a public host name, the only kind Harbour fetches for discovery, registration and
 * tokens on someone's say-so. `allowHttp` is for tests against a local server.
 */
export function publicUrl(value: string, what: string, allowHttp = false): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new HarbourError("invalid", `${what} is not a URL`);
	}
	if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
		throw new HarbourError("invalid", `${what} must be an https URL`);
	}
	if (!allowHttp && (url.hostname.endsWith(".") || PRIVATE_HOST.test(url.hostname) || !url.hostname.includes("."))) {
		throw new HarbourError("invalid", `${what} must be on a public host`);
	}
	if (url.username !== "" || url.password !== "") throw new HarbourError("invalid", `${what} must not carry a login`);
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
					clientInfo: { name: "Harbour", version: "1" },
				},
			}),
			redirect: "manual",
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch {
		throw new HarbourError("unavailable", `The MCP server at ${url.host} did not answer`);
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

/** The client ID metadata document Harbour publishes at its client ID (CIMD, draft-ietf-oauth-client-id-metadata-document). */
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

/** Dynamic client registration (RFC 7591): a public client using PKCE, for Harbour's callback. */
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
		throw new HarbourError("unavailable", "The authorisation server's registration endpoint did not answer");
	}
	const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if (!response.ok || typeof body?.client_id !== "string") {
		const reason = typeof body?.error_description === "string" ? `: ${body.error_description.slice(0, 200)}` : "";
		throw new HarbourError("refused", `Dynamic client registration was refused (${response.status})${reason}`);
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
		throw new HarbourError("unavailable", "The token endpoint did not answer");
	}
	const text = await response.text();
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		parsed = Object.fromEntries(new URLSearchParams(text));
	}
	if (!response.ok || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
		// The provider's words, with nothing of what was sent: a server that echoes the code, refresh token or client
		// secret back in its error must not put it in a message someone reads.
		const sent = [...body.values(), client.clientSecret ?? ""].filter((value) => value.length >= 4);
		const scrub = (text: string) => sent.reduce((out, value) => out.split(value).join("[redacted]"), text);
		const error =
			typeof parsed.error === "string" && /^[a-z0-9_.-]{1,64}$/i.test(parsed.error)
				? parsed.error
				: `status ${response.status}`;
		const description =
			typeof parsed.error_description === "string" ? `: ${scrub(parsed.error_description).slice(0, 200)}` : "";
		throw new HarbourError(
			error === "invalid_grant" ? "refused" : "unavailable",
			`The token request failed (${error})${description}`,
		);
	}
	const expiresIn = Number(parsed.expires_in);
	const scope = typeof parsed.scope === "string" ? parsed.scope.split(/[ ,]+/).filter(Boolean) : undefined;
	return {
		accessToken: parsed.access_token,
		...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
			? { refreshToken: parsed.refresh_token }
			: {}),
		...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: options.now + expiresIn * 1000 } : {}),
		...(scope === undefined ? {} : { scopes: scope }),
		...(typeof parsed.id_token === "string" ? { idToken: parsed.id_token } : {}),
	};
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
