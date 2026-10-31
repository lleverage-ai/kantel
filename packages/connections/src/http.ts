/**
 * The Connections API's routes (`@kantel/api`'s `connectionRoutes`) over a `ConnectionsService`, and the browser
 * routes beside them:
 *
 * - `GET /v1/connections/oauth/client-metadata.json`: the deployment's client ID metadata document, without signing in.
 * - `GET /v1/connections/authorize/{attemptId}`: a connect URL. Signs the person in, checks they are the one it was made
 *   for, and redirects to the provider.
 * - `GET /v1/connections/callback`: the provider's redirect back. Signs the person in, finishes the connect and shows a
 *   small page saying how it went (and tells an opener window, for a console that opened it as a popup).
 * - `GET /v1/connections/github-app/{setupId}/start?state=…`: the page that posts a GitHub App manifest on to GitHub.
 *   The state is the capability: the service checks it, not who is signed in.
 * - `GET /v1/connections/github-app/callback`: GitHub's redirect back once the app is made. Uses the state up, stores
 *   the app's client and redirects to where the flow started.
 *
 * Who the caller is stays the host's job (`authenticate`). The GitHub App pages call no `authenticate`, but sit behind
 * whatever sign-in the host puts in front of these paths, like the connect URL and the callback.
 */
import { CONNECTION_BROWSER_PATHS, connectionRoutes, createRouter, STATUS_BY_CODE } from "@kantel/api";
import { type CallContext, type ConnectAttempt, isKantelError } from "@kantel/contracts";
import type { ConnectionsService } from "./service.ts";

export interface ConnectionsApiOptions {
	readonly connections: ConnectionsService;
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface ConnectionsApi {
	/** Answers a connections route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

export const CONNECTIONS_BODY_LIMIT = 64 * 1024;

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

export function connectionsErrorResponse(error: unknown): Response {
	if (isKantelError(error)) {
		return json(
			{
				error: {
					code: error.code,
					message: error.message,
					...(error.details === undefined ? {} : { details: error.details }),
				},
			},
			STATUS_BY_CODE[error.code],
		);
	}
	return json({ error: { code: "unavailable", message: "The connections API failed" } }, 500);
}

export function isConnectionsPath(path: string, basePath = "/v1"): boolean {
	const under = `${basePath.replace(/\/+$/, "")}/connections`;
	return path === under || path.startsWith(`${under}/`);
}

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page a person sees at the end of a connect. Plain, and safe to show any message in. */
function resultPage(
	title: string,
	message: string,
	status: number,
	attempt?: Pick<ConnectAttempt, "id" | "status" | "connectionId">,
): Response {
	const payload = JSON.stringify({
		type: "harbour.connection",
		...(attempt === undefined ? {} : { attemptId: attempt.id, status: attempt.status }),
		...(attempt?.connectionId === undefined ? {} : { connectionId: attempt.connectionId }),
	}).replace(/</g, "\\u003c");
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f}h1{font-size:1.25rem}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You can close this window.</p>
<script>try{if(window.opener){window.opener.postMessage(${payload},window.location.origin);}}catch(e){}</script>
</body></html>`;
	return new Response(html, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
			"referrer-policy": "no-referrer",
		},
	});
}

/**
 * The GitHub App manifest page's headers: the page may post a form to GitHub and nowhere else, run its one inline
 * script, and never be framed, cached or leak its URL (with the state in it) as a referrer.
 */
function manifestPage(html: string): Response {
	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'",
			"referrer-policy": "no-referrer",
		},
	});
}

const pageOf = (query: { readonly limit?: number; readonly cursor?: string }) => ({
	...(query.limit === undefined ? {} : { limit: query.limit }),
	...(query.cursor === undefined ? {} : { cursor: query.cursor }),
});

export function createConnectionsApi(options: ConnectionsApiOptions): ConnectionsApi {
	const { connections } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		connectionRoutes,
		{
			getConnectionsSettings: (ctx: CallContext) => connections.settings(ctx),
			listCatalogue: (ctx: CallContext, { query }) =>
				connections.listCatalogue(
					ctx,
					{
						...(query.category === undefined ? {} : { category: query.category }),
						...(query.authType === undefined ? {} : { authType: query.authType }),
						...(query.kind === undefined ? {} : { kind: query.kind }),
						...(query.q === undefined ? {} : { q: query.q }),
					},
					pageOf(query),
				),
			getProviderTemplate: (ctx: CallContext, { params }) => connections.getTemplate(ctx, params.templateId),
			discoverMcpServer: (ctx: CallContext, { body }) => connections.discoverMcp(ctx, body.url),
			startConnect: (ctx: CallContext, { body }) => connections.startConnect(ctx, body),
			getConnectAttempt: (ctx: CallContext, { params }) => connections.getAttempt(ctx, params.attemptId),
			connectKey: (ctx: CallContext, { body }) => connections.connectKey(ctx, body),
			listConnectionUses: (ctx: CallContext, { query }) =>
				connections.listUses(
					ctx,
					{
						...(query.connectionId === undefined ? {} : { connectionId: query.connectionId }),
						...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
					},
					pageOf(query),
				),
			listOAuthClients: (ctx: CallContext, { query }) =>
				connections.listClients(
					ctx,
					{
						...(query.templateId === undefined ? {} : { templateId: query.templateId }),
						...(query.tier === undefined ? {} : { tier: query.tier }),
					},
					pageOf(query),
				),
			createOAuthClient: (ctx: CallContext, { body }) => connections.createClient(ctx, body),
			getOAuthClient: (ctx: CallContext, { params }) => connections.getClient(ctx, params.oauthClientId),
			updateOAuthClient: (ctx: CallContext, { params, body }) =>
				connections.updateClient(ctx, params.oauthClientId, body),
			removeOAuthClient: async (ctx: CallContext, { params }) => {
				await connections.removeClient(ctx, params.oauthClientId);
				return undefined;
			},
			listConnections: (ctx: CallContext, { query }) =>
				connections.list(
					ctx,
					{
						...(query.ownerKind === undefined ? {} : { ownerKind: query.ownerKind }),
						...(query.ownerId === undefined ? {} : { ownerId: query.ownerId }),
						...(query.templateId === undefined ? {} : { templateId: query.templateId }),
						...(query.kind === undefined ? {} : { kind: query.kind }),
					},
					pageOf(query),
				),
			getConnection: (ctx: CallContext, { params }) => connections.get(ctx, params.connectionId),
			updateConnection: (ctx: CallContext, { params, body }) => connections.update(ctx, params.connectionId, body),
			removeConnection: async (ctx: CallContext, { params }) => {
				await connections.remove(ctx, params.connectionId);
				return undefined;
			},
			rotateConnectionKey: (ctx: CallContext, { params, body }) =>
				connections.rotateKey(ctx, params.connectionId, body),
			startGitHubApp: (ctx: CallContext, { body }) =>
				connections.startGitHubApp(ctx, {
					owner: body.owner,
					...(body.projectId === undefined ? {} : { projectId: body.projectId }),
					...(body.githubOrganisation === undefined ? {} : { githubOrganisation: body.githubOrganisation }),
					...(body.returnTo === undefined ? {} : { returnTo: body.returnTo }),
				}),
			getGitHubApp: (ctx: CallContext, { params }) => connections.getGitHubApp(ctx, params.setupId),
			getConnectionCeiling: (ctx: CallContext) => connections.getCeiling(ctx),
			setConnectionCeiling: (ctx: CallContext, { body }) => connections.setCeiling(ctx, body.routes),
			getConnectionRules: (ctx: CallContext, { params }) => connections.getRules(ctx, params.connectionId),
			updateConnectionRules: (ctx: CallContext, { params, body }) =>
				connections.updateRules(ctx, params.connectionId, body),
			createConnectionRule: (ctx: CallContext, { params, body }) =>
				connections.createRule(ctx, params.connectionId, body),
			createConnectionRuleFromApproval: (ctx: CallContext, { params, body }) =>
				connections.createRuleFromApproval(ctx, params.connectionId, body.rule, body.approvalId),
			dryRunConnectionRequest: (ctx: CallContext, { params, body }) =>
				connections.dryRun(ctx, params.connectionId, body),
			updateConnectionRule: (ctx: CallContext, { params, body }) =>
				connections.updateRule(ctx, params.connectionId, params.ruleId, body),
			removeConnectionRule: async (ctx: CallContext, { params }) => {
				await connections.removeRule(ctx, params.connectionId, params.ruleId);
				return undefined;
			},
		},
		{ basePath, maxBodyBytes: CONNECTIONS_BODY_LIMIT },
	);

	const metadataPath = `${basePath}${CONNECTION_BROWSER_PATHS.clientMetadata}`;
	const authorizePrefix = `${basePath}${CONNECTION_BROWSER_PATHS.authorize}/`;
	const callbackPath = `${basePath}${CONNECTION_BROWSER_PATHS.callback}`;
	const gitHubAppCallbackPath = `${basePath}${CONNECTION_BROWSER_PATHS.gitHubAppCallback}`;
	const gitHubAppPrefix = `${basePath}${CONNECTION_BROWSER_PATHS.gitHubApp}/`;

	return {
		async fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname;
			if (!isConnectionsPath(path, basePath)) return undefined;

			if (request.method === "GET" && path === metadataPath) {
				return new Response(JSON.stringify(connections.clientMetadata()), {
					headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
				});
			}

			if (request.method === "GET" && path.startsWith(authorizePrefix)) {
				const attemptId = decodeURIComponent(path.slice(authorizePrefix.length));
				try {
					const ctx = await options.authenticate(request);
					const { url: target } = await connections.authorize(ctx, attemptId);
					return new Response(null, {
						status: 302,
						headers: { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" },
					});
				} catch (error) {
					const message = isKantelError(error) ? error.message : "Something went wrong starting the sign-in.";
					return resultPage(
						"Could not start the connection",
						message,
						isKantelError(error) ? STATUS_BY_CODE[error.code] : 500,
					);
				}
			}

			// Before `github-app/{setupId}/start`, and before the JSON API's `github-app/{setupId}`.
			if (request.method === "GET" && path === gitHubAppCallbackPath) {
				try {
					const { redirectTo } = await connections.completeGitHubApp({
						code: url.searchParams.get("code") ?? "",
						state: url.searchParams.get("state") ?? "",
					});
					return new Response(null, {
						status: 302,
						headers: { location: redirectTo, "cache-control": "no-store", "referrer-policy": "no-referrer" },
					});
				} catch (error) {
					const message = isKantelError(error) ? error.message : "Something went wrong finishing the GitHub App.";
					return resultPage("GitHub App not set up", message, isKantelError(error) ? STATUS_BY_CODE[error.code] : 500);
				}
			}

			if (request.method === "GET" && path.startsWith(gitHubAppPrefix) && path.endsWith("/start")) {
				const raw = path.slice(gitHubAppPrefix.length, -"/start".length);
				if (raw !== "" && !raw.includes("/")) {
					try {
						const setupId = decodeURIComponent(raw);
						return manifestPage(await connections.gitHubAppManifestPage(setupId, url.searchParams.get("state") ?? ""));
					} catch (error) {
						const message = isKantelError(error) ? error.message : "Something went wrong starting the GitHub App.";
						return resultPage(
							"Could not start the GitHub App",
							message,
							isKantelError(error) ? STATUS_BY_CODE[error.code] : 500,
						);
					}
				}
			}

			if (request.method === "GET" && path === callbackPath) {
				const state = url.searchParams.get("state") ?? "";
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");
				const description = url.searchParams.get("error_description");
				try {
					const ctx = await options.authenticate(request);
					const attempt = await connections.completeConnect(ctx, {
						state,
						...(code === null ? {} : { code }),
						...(error === null ? {} : { error }),
						...(description === null ? {} : { errorDescription: description }),
					});
					if (attempt.status === "completed") {
						return resultPage("Connected", "The connection is ready to use.", 200, attempt);
					}
					return resultPage("Not connected", attempt.failure?.message ?? "The connection was not made.", 400, attempt);
				} catch (caught) {
					const message = isKantelError(caught) ? caught.message : "Something went wrong finishing the sign-in.";
					return resultPage("Not connected", message, isKantelError(caught) ? STATUS_BY_CODE[caught.code] : 500);
				}
			}

			try {
				const ctx = await options.authenticate(request);
				const answered = await router(ctx, request);
				if (answered !== undefined) return answered;
				return json({ error: { code: "not_found", message: "No such route" } }, 404);
			} catch (error) {
				return connectionsErrorResponse(error);
			}
		},
	};
}
