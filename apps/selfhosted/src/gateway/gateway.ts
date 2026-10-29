// The self-hosted gateway: one fetch handler that mounts every M1 API behind the deployment's authenticator, and
// serves the console's static build beside them.
//
//   /healthz                    liveness, no credentials
//   /v1/deployment              which implementation backs each contract, and where mail goes (credentials needed)
//   /v1/workspaces/...          workspace read API (@harbour/workspace/read-api)
//   /v1/audit/events, /event    audit query API (@harbour/audit/http)
//   /v1/...                     session API (@harbour/runtime/http): sessions, profiles, hosts
//   anything else               the console (apps/console's build), with index.html for its client-side routes
import { createAuditQueryHandler } from "@harbour/audit/http";
import { type Authenticator, type CallContext, callContextFor } from "@harbour/contracts";
import { createAuthenticator, withAuthentication } from "@harbour/identity/authenticator";
import { createSessionApi, type SessionApi } from "@harbour/runtime/http";
import { createWorkspaceReadApi, WORKSPACE_READ_API_BASE } from "@harbour/workspace/read-api";
import type { GatewayComponents } from "./components.ts";
import type { MailDescription } from "./mail.ts";
import { createStaticHandler } from "./static.ts";

export interface GatewayOptions {
	readonly components: GatewayComponents;
	/** The mail configuration, without credentials, shown at `/v1/deployment`. */
	readonly mail?: MailDescription;
	/** Default: API keys through `createAuthenticator` over the components' identity directory. */
	readonly authenticator?: Authenticator;
	/** The console's build directory (`apps/console/dist`). Without it, non-API paths are 404. */
	readonly consoleDir?: string;
	/** Which host-tool callback URLs the session API may call. Default: `https:` only. */
	readonly allowCallbackUrl?: (url: URL) => boolean;
}

export interface Gateway {
	fetch(request: Request): Promise<Response>;
	close(): Promise<void>;
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

const AUDIT_PREFIX = "/v1/audit/";

export function createGateway(options: GatewayOptions): Gateway {
	const { components } = options;
	const authenticator = options.authenticator ?? createAuthenticator({ identity: components.identity });
	const runtime = components.runtime;

	const sessions: SessionApi = createSessionApi({
		runtime: runtime.runtime,
		models: runtime.models,
		// The console's message actions: fork from an answer, edit a message and rerun from it.
		branching: runtime.branching,
		directory: runtime.directory,
		profiles: runtime.profiles,
		hostTools: runtime.hostTools,
		authenticator,
		...(options.allowCallbackUrl === undefined ? {} : { allowCallbackUrl: options.allowCallbackUrl }),
	});

	const audit = createAuditQueryHandler({ store: components.audit, authenticator });

	// The read API takes a context per request; the authentication wrapper turns failures into 401 and 403 first.
	const callers = new WeakMap<Request, CallContext>();
	const readWorkspaces = createWorkspaceReadApi({
		workspaces: components.workspaces,
		authenticate: async (request) => {
			const ctx = callers.get(request);
			if (ctx === undefined) throw new Error("workspace read API reached without authentication");
			return ctx;
		},
	});
	const workspaces = withAuthentication(authenticator, async (request, caller) => {
		callers.set(request, callContextFor(caller));
		return (await readWorkspaces(request)) ?? json({ error: { code: "not_found", message: "No such route" } }, 404);
	});

	const deployment = withAuthentication(authenticator, async () =>
		json({ target: "selfhosted", bindings: components.bindings, mail: options.mail ?? null }),
	);

	const consoleAssets = options.consoleDir === undefined ? undefined : createStaticHandler(options.consoleDir);

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			try {
				if (path === "/healthz") return json({ ok: true });
				if (path === "/v1/deployment") return await deployment(request);
				if (path === WORKSPACE_READ_API_BASE || path.startsWith(`${WORKSPACE_READ_API_BASE}/`)) {
					return await workspaces(request);
				}
				if (path.startsWith(AUDIT_PREFIX)) return await audit(request);
				if (path === "/v1" || path.startsWith("/v1/")) return await sessions.fetch(request);
				if (consoleAssets !== undefined) return await consoleAssets(request);
				return json({ error: { code: "not_found", message: "No such route" } }, 404);
			} catch (error) {
				// Each API answers its own errors; this is only for one that escapes, such as a directory that is down.
				console.error("[gateway]", error);
				return json({ error: { code: "unavailable", message: "The gateway could not answer" } }, 500);
			}
		},
		async close() {
			await sessions.close();
		},
	};
}
