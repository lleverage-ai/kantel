/**
 * Test doubles for connections: a fake provider (a remote MCP server with its authorisation server: protected-resource
 * metadata, RFC 8414 metadata, DCR, authorize and token), answered from memory through a `Fetch`, and a small access.
 * For tests only.
 */
import {
	type CallContext,
	type Connections,
	type ConnectionUse,
	isRedactedUse,
	KantelError,
	type ListedConnectionUse,
	type Page,
	type ProjectAccess,
} from "@kantel/contracts";
import { sha256 } from "./oauth.ts";
import type { Fetch } from "./ports.ts";

export const ORG = "org_1";

/** A page of uses the caller sees whole: fails on any redacted (#335), for a test where none should be. */
export function whole(page: Page<ListedConnectionUse>): ConnectionUse[] {
	return page.items.map((use) => {
		if (isRedactedUse(use)) throw new Error(`Use ${use.id} is redacted for this caller`);
		return use;
	});
}

export const human = (userId: string, organisationId = ORG): CallContext => ({
	actor: { kind: "human", userId },
	organisationId,
});

/**
 * Sets a connection's rules to let every request through, as a person would by removing every rule and answering
 * Allow for requests no rule covers: for a test about something other than rules, now that every connection starts
 * with its template's defaults (#332), which ask about writes and block deletes.
 */
export async function letEverythingThrough(
	connections: Pick<Connections, "getRules" | "removeRule" | "updateRules">,
	ctx: CallContext,
	connectionId: string,
): Promise<void> {
	const set = await connections.getRules(ctx, connectionId);
	for (const rule of set.rules) await connections.removeRule(ctx, connectionId, rule.id);
	await connections.updateRules(ctx, connectionId, { unmatched: "allow" });
}

/** Admins may do anything in the organisation; anyone may act on their own; viewers see. */
export function fakeAccess(admins: readonly string[]): ProjectAccess {
	const passes = (ctx: CallContext, check: { readonly userId?: string; readonly needed: string }) => {
		if (ctx.actor.kind === "system") return true;
		if (ctx.actor.kind !== "human") return false;
		// As in createProjectAccess: a person reaches a user's own record only as that user.
		if (check.userId !== undefined) return check.userId === ctx.actor.userId;
		return check.needed === "viewer" || admins.includes(ctx.actor.userId);
	};
	return {
		async require(ctx, check) {
			if (!passes(ctx, check)) throw new KantelError("forbidden", "no");
			return { scope: { kind: "organisation", organisationId: ctx.organisationId } } as never;
		},
		async allows(ctx, check) {
			return passes(ctx, check);
		},
		async resource() {
			throw new KantelError("forbidden", "no");
		},
		async allowsResource() {
			return undefined;
		},
	};
}

export interface FakeProvider {
	readonly fetch: Fetch;
	readonly mcpUrl: string;
	readonly issued: { access: string[]; refresh: string[] };
	readonly registrations: { clientId: string; redirectUris: string[] }[];
	readonly tokenRequests: URLSearchParams[];
	readonly mcpAuthorizations: (string | null)[];
	/** Each RFC 7009 revocation request's form, in order (#329). */
	readonly revocations: URLSearchParams[];
	/** The code the authorize endpoint would hand back for the last authorisation URL. */
	codeFor(authorizationUrl: string): string;
	expireAccessTokens(): void;
	echoToken: boolean;
	/** What the MCP server's `tools/list` answers. One unannotated `whoami` unless a test sets more. */
	tools: {
		readonly name: string;
		readonly description?: string;
		readonly inputSchema?: unknown;
		readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
	}[];
	/**
	 * How the token endpoint answers a refresh (#328): `ok`, `unavailable` (503), `down` (no answer) or `refuse`
	 * (`invalid_grant`, as for a revoked grant). Each refresh token works once: the server rotates it, as many do.
	 */
	refreshAnswer: "ok" | "unavailable" | "down" | "refuse";
	/** How long the token endpoint takes to answer a refresh, in real milliseconds. */
	refreshDelayMs: number;
}

export function fakeProvider(
	options: {
		readonly cimd?: boolean;
		readonly dcr?: boolean;
		readonly open?: boolean;
		/**
		 * The authorisation server's revocation endpoint (#329): absent (the default), `ok`, `refuse` (answers 503), or
		 * `down` (the request fails as a network error does).
		 */
		readonly revocation?: "ok" | "refuse" | "down";
	} = {},
): FakeProvider {
	const base = "https://mcp.example.com";
	const issued = { access: [] as string[], refresh: [] as string[] };
	const valid = new Set<string>();
	const codes = new Map<string, { challenge: string; clientId: string; resource: string | null }>();
	const registrations: { clientId: string; redirectUris: string[] }[] = [];
	const tokenRequests: URLSearchParams[] = [];
	const mcpAuthorizations: (string | null)[] = [];
	const revocations: URLSearchParams[] = [];
	const revoked = new Set<string>();
	const spent = new Set<string>();
	let n = 0;
	const provider: FakeProvider = {
		mcpUrl: `${base}/mcp`,
		issued,
		registrations,
		tokenRequests,
		mcpAuthorizations,
		revocations,
		echoToken: false,
		tools: [{ name: "whoami", description: "Who am I", inputSchema: { type: "object" } }],
		refreshAnswer: "ok",
		refreshDelayMs: 0,
		codeFor(authorizationUrl) {
			const url = new URL(authorizationUrl);
			n += 1;
			const code = `code_${n}`;
			codes.set(code, {
				challenge: url.searchParams.get("code_challenge") ?? "",
				clientId: url.searchParams.get("client_id") ?? "",
				resource: url.searchParams.get("resource"),
			});
			return code;
		},
		expireAccessTokens() {
			valid.clear();
		},
		fetch: async (input, init) => {
			const url = new URL(input);
			const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
				new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
			if (url.pathname === "/mcp") {
				const auth = new Headers(init?.headers).get("authorization");
				mcpAuthorizations.push(auth);
				const token = auth?.replace(/^Bearer /, "");
				if (!options.open && (token === undefined || !valid.has(token))) {
					return new Response("", {
						status: 401,
						headers: {
							"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
						},
					});
				}
				const message = JSON.parse(String(init?.body ?? "{}")) as {
					id?: number;
					method: string;
					params?: { name?: string };
				};
				if (message.id === undefined) return new Response(null, { status: 202 });
				const result =
					message.method === "initialize"
						? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
						: message.method === "tools/list"
							? { tools: provider.tools }
							: {
									content: [
										{ type: "text", text: provider.echoToken ? `you are ${token}` : `called ${message.params?.name}` },
									],
								};
				// Answer as an event stream, as many servers do.
				return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" },
				});
			}
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read", "write"] });
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return json({
					issuer: base,
					authorization_endpoint: `${base}/authorize`,
					token_endpoint: `${base}/token`,
					...(options.dcr === false ? {} : { registration_endpoint: `${base}/register` }),
					code_challenge_methods_supported: ["S256"],
					...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
					...(options.revocation === undefined ? {} : { revocation_endpoint: `${base}/revoke` }),
				});
			}
			if (url.pathname === "/revoke" && options.revocation !== undefined) {
				const params = new URLSearchParams(String(init?.body));
				revocations.push(params);
				if (options.revocation === "down") throw new TypeError("fetch failed");
				if (options.revocation === "refuse") return json({ error: "temporarily_unavailable" }, 503);
				// Revoking a refresh token ends the grant: its access tokens too (RFC 7009 section 2.1).
				const token = params.get("token") ?? "";
				revoked.add(token);
				if (issued.refresh.includes(token)) valid.clear();
				valid.delete(token);
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/register") {
				const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
				const clientId = `dcr_${registrations.length + 1}`;
				registrations.push({ clientId, redirectUris: body.redirect_uris });
				return json({ client_id: clientId, token_endpoint_auth_method: "none" }, 201);
			}
			if (url.pathname === "/token") {
				const params = new URLSearchParams(String(init?.body));
				tokenRequests.push(params);
				if (params.get("grant_type") === "authorization_code") {
					const code = codes.get(params.get("code") ?? "");
					codes.delete(params.get("code") ?? "");
					if (code === undefined) return json({ error: "invalid_grant" }, 400);
					if ((await sha256(params.get("code_verifier") ?? "")) !== code.challenge)
						return json({ error: "invalid_grant" }, 400);
					if (params.get("client_id") !== code.clientId) return json({ error: "invalid_client" }, 401);
				} else if (params.get("grant_type") === "refresh_token") {
					const refresh = params.get("refresh_token") ?? "";
					if (provider.refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, provider.refreshDelayMs));
					if (provider.refreshAnswer === "down") throw new TypeError("fetch failed");
					if (provider.refreshAnswer === "unavailable") return json({ error: "temporarily_unavailable" }, 503);
					if (
						provider.refreshAnswer === "refuse" ||
						!issued.refresh.includes(refresh) ||
						revoked.has(refresh) ||
						spent.has(refresh)
					)
						return json({ error: "invalid_grant" }, 400);
					spent.add(refresh);
				}
				const access = `access-token-${issued.access.length + 1}-secret`;
				const refresh = `refresh-token-${issued.refresh.length + 1}-secret`;
				issued.access.push(access);
				issued.refresh.push(refresh);
				valid.add(access);
				return json({
					access_token: access,
					refresh_token: refresh,
					token_type: "Bearer",
					expires_in: 3600,
					scope: "read write",
				});
			}
			return new Response("not found", { status: 404 });
		},
	};
	return provider;
}
