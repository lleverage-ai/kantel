/**
 * The compute plane's HTTP API: `@kantel/api`'s `computeRoutes` under `/v1` (by default), over the service in
 * `service.ts`. It signs the caller in (an API key, or the host's person authenticator) only for a request that is for
 * one of its routes, and resolves `undefined` for any other, so a gateway can chain it before its own routes. Errors
 * answer `{ error: { code, message, details? } }` with `STATUS_BY_CODE`'s status, and 401 `unauthenticated` for a missing or
 * bad credential.
 *
 * A signed file URL (`/v1/file-urls/{token}`, with mounts) is answered before any of that, with no credential: its
 * token is the grant. Nothing here reads a request's body: the router reads a route's JSON body (up to
 * `COMPUTE_BODY_LIMIT`), and a route with a raw body (`rawBody`: a bundle's tar, an archive) or a file URL gets the
 * request with its body unread, to stream however large it is.
 */
import {
	computeRoutes,
	createRouter,
	pathPattern,
	publicComputeRoutes,
	type SignedInComputeRoutes,
	STATUS_BY_CODE,
} from "@kantel/api";
import { isKantelError } from "@kantel/contracts";
import { type AuthenticatePerson, authenticate, UnauthenticatedError } from "./auth.ts";
import type { SandboxBackend } from "./backend.ts";
import type { BaseImages } from "./base-status.ts";
import type { LiveRelay } from "./live.ts";
import { FILE_URL_PATH, type MountsOptions } from "./mounts.ts";
import {
	type ComputeLimits,
	type ComputeService,
	createComputeService,
	type InviteMailing,
	type RateTable,
} from "./service.ts";
import { type ComputeStore, createMemoryStore, fenceClosedAccounts } from "./store.ts";
import { createTelemetryExporter, type TelemetryExporter } from "./telemetry.ts";
import { createWebhookDispatcher, type WebhookDispatcher } from "./webhooks.ts";

/** The longest body a compute route reads: a 1 MiB file in base64, with room for the rest. */
export const COMPUTE_BODY_LIMIT = 2 * 1024 * 1024;
/** How often, at most, a request sweeps for sandboxes past their stop time. */
const SWEEP_EVERY_MS = 1000;
/**
 * The host agent's own paths beside the account hosts' `/hosts/{hostId}` (`@kantel/hosts/http`): never the compute API's,
 * so a gateway with no host routes answers them 404 rather than asking for a sign-in. A host's ID starts `host_`.
 */
const HOST_AGENT_PATH = /^\/hosts\/(?:register|connect)$/;
/** A signed file URL's path under the base path: its token is one path segment. */
const FILE_URL = new RegExp(`^${FILE_URL_PATH}/([A-Za-z0-9_-]+)$`);
/** The methods a signed file URL answers: a download's GET (and HEAD), an upload's PUT. */
const FILE_URL_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "PUT"]);

export interface ComputeApiOptions {
	/** Default an in-memory store. */
	readonly store?: ComputeStore;
	readonly backend: SandboxBackend;
	/** Checks a bearer that isn't an API key; absent, only API keys sign in. */
	readonly authenticatePerson?: AuthenticatePerson;
	/** For webhook deliveries and telemetry exports. Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Default `Date.now`. */
	readonly now?: () => number;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
	/** The control plane's public URL, for host join commands. Default each request's origin. */
	readonly publicUrl?: string;
	readonly mode?: "selfhosted" | "hosted";
	/** The domain sandboxes' addresses are under, which `GET /v1/me` names. Absent, none is named. */
	readonly sandboxDomain?: string;
	/** The join command shown with a host join token, with `{url}` and `{token}`. */
	readonly hostJoinCommand?: string;
	/** Account hosts' routes (`/v1/hosts`, experimental): accounts add hosts of their own. Default off. */
	readonly accountHosts?: boolean;
	/** Templates' routes (`/v1/templates`, experimental): versioned microVM profiles and their snapshots. Default off. */
	readonly templates?: boolean;
	/** The console page where a person approves a device sign-in, with `{url}`. Default `{url}/device`. */
	readonly deviceLoginUrl?: string;
	readonly rates?: RateTable;
	readonly limits?: ComputeLimits;
	/** Whether a person's sign-in (`PersonIdentity.session`) is still live; absent, sign-ins are taken to last. */
	readonly sessionLive?: (session: string) => Promise<boolean>;
	/** Whether a user may use the deployment's shared hosts (`ComputeServiceOptions.sharedHosts`); absent, everyone. */
	readonly sharedHosts?: (userId: string) => Promise<boolean>;
	/** Removes a person from sign-in once they delete their account (`ComputeServiceOptions.deletePerson`). */
	readonly deletePerson?: (userId: string) => Promise<void>;
	/** Wakes the deployment for the next account deletion pass (`ComputeServiceOptions.wakeAt`). */
	readonly wakeAt?: (at: number) => Promise<void> | void;
	/** Whether a person administers the deployment (`ComputeServiceOptions.deploymentAdmin`). */
	readonly deploymentAdmin?: (userId: string) => Promise<boolean>;
	/**
	 * `KANTEL_SECRETS_KEY`: 32 bytes, base64, sealing environments' protected values and secret files. Absent, a memory
	 * store makes one for the process and a persistent store refuses them. Not a key: `createComputeApi` throws.
	 */
	readonly secretsKey?: string;
	/**
	 * Image patching (experimental, `KANTEL_IMAGE_PATCHING`): Kantel's base image index, cached by the caller
	 * (`baseImageIndexReader`). Absent, off: no `base` fields, and its routes answer `not_supported`.
	 */
	readonly baseImages?: BaseImages;
	/** Mounts, bundles and signed file URLs (`KANTEL_MOUNTS=experimental`), with where bundles are kept. Default off. */
	readonly mounts?: MountsOptions;
	/** Emails an invite made for an address, with a link to join (`ComputeServiceOptions.invites`); absent, none. */
	readonly invites?: InviteMailing;
	/** Sandboxes' changes from the other gateways over one database (`ComputeServiceOptions.liveRelay`); absent, none. */
	readonly liveRelay?: LiveRelay;
	/** How long a call waits for a sandbox that is starting (`ComputeServiceOptions.startHoldMs`). Default 60 s. */
	readonly startHoldMs?: number;
	/** How often that call reads the sandbox again (`ComputeServiceOptions.startPollMs`). Default 250 ms. */
	readonly startPollMs?: number;
}

export interface ComputeApi {
	/** Answers a compute route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
	readonly dispatcher: WebhookDispatcher;
	readonly exporter: TelemetryExporter;
	readonly store: ComputeStore;
	readonly service: ComputeService;
	/** Stops the timers, kills detached commands and waits for the work under way. */
	close(): Promise<void>;
}

const json = (body: unknown, status: number, headers: { readonly [name: string]: string } = {}): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});

/**
 * The error response for a failure: a KantelError's code, status and details (a placement's `reason`, a
 * `SandboxNotRunning`), 401 for no valid
 * credential, else 500.
 */
export function computeErrorResponse(error: unknown): Response {
	if (error instanceof UnauthenticatedError) {
		return json({ error: { code: "unauthenticated", message: error.message } }, 401, {
			"www-authenticate": 'Bearer realm="kantel"',
		});
	}
	if (isKantelError(error)) {
		const { details } = error;
		return json(
			{ error: { code: error.code, message: error.message, ...(details === undefined ? {} : { details }) } },
			STATUS_BY_CODE[error.code],
		);
	}
	return json({ error: { code: "unavailable", message: "The compute API failed" } }, 500);
}

/** The compute plane's API over a backend, with its webhook dispatcher and telemetry exporter. */
export function createComputeApi(options: ComputeApiOptions): ComputeApi {
	const store = fenceClosedAccounts(options.store ?? createMemoryStore());
	const now = options.now ?? (() => Date.now());
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const dispatcher = createWebhookDispatcher({
		store,
		now,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
	let service: ComputeService | undefined;
	const exporter = createTelemetryExporter({
		store,
		now,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		collect: async () => (service === undefined ? [] : service.sampleUsage()),
	});
	const created = createComputeService({
		store,
		backend: options.backend,
		dispatcher,
		exporter,
		now,
		apiBasePath: basePath,
		...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
		...(options.mode === undefined ? {} : { mode: options.mode }),
		...(options.sandboxDomain === undefined ? {} : { sandboxDomain: options.sandboxDomain }),
		...(options.hostJoinCommand === undefined ? {} : { hostJoinCommand: options.hostJoinCommand }),
		...(options.accountHosts === undefined ? {} : { accountHosts: options.accountHosts }),
		...(options.templates === undefined ? {} : { templates: options.templates }),
		...(options.deviceLoginUrl === undefined ? {} : { deviceLoginUrl: options.deviceLoginUrl }),
		...(options.rates === undefined ? {} : { rates: options.rates }),
		...(options.limits === undefined ? {} : { limits: options.limits }),
		...(options.sessionLive === undefined ? {} : { sessionLive: options.sessionLive }),
		...(options.sharedHosts === undefined ? {} : { sharedHosts: options.sharedHosts }),
		...(options.deletePerson === undefined ? {} : { deletePerson: options.deletePerson }),
		...(options.wakeAt === undefined ? {} : { wakeAt: options.wakeAt }),
		...(options.deploymentAdmin === undefined ? {} : { deploymentAdmin: options.deploymentAdmin }),
		...(options.secretsKey === undefined ? {} : { secretsKey: options.secretsKey }),
		...(options.baseImages === undefined ? {} : { baseImages: options.baseImages }),
		...(options.mounts === undefined ? {} : { mounts: options.mounts }),
		...(options.invites === undefined ? {} : { invites: options.invites }),
		...(options.liveRelay === undefined ? {} : { liveRelay: options.liveRelay }),
		...(options.startHoldMs === undefined ? {} : { startHoldMs: options.startHoldMs }),
		...(options.startPollMs === undefined ? {} : { startPollMs: options.startPollMs }),
	});
	service = created;
	const publicIds = new Set<string>(Object.keys(publicComputeRoutes));
	const signedInRoutes = Object.fromEntries(
		Object.entries(computeRoutes).filter(([id]) => !publicIds.has(id)),
	) as unknown as SignedInComputeRoutes;
	const routerOptions = { basePath, maxBodyBytes: COMPUTE_BODY_LIMIT };
	const router = createRouter(signedInRoutes, created.handlers, routerOptions);
	// The routes that take no credential are answered before anyone is signed in.
	const publicRouter = createRouter(publicComputeRoutes, created.publicHandlers, routerOptions);
	const patterns = Object.values(computeRoutes).map((route) => pathPattern(route.path));
	let lastSweep = Number.NEGATIVE_INFINITY;

	return {
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return undefined;
			const path = url.pathname.slice(basePath.length) || "/";
			const fileUrl = FILE_URL.exec(path);
			if (fileUrl !== null) {
				// No sign-in: whoever holds the URL may use it, as the token is the grant (`serveFileUrl` checks it).
				if (!FILE_URL_METHODS.has(request.method)) {
					return json({ error: { code: "invalid", message: `${request.method} is not allowed here` } }, 405, {
						allow: [...FILE_URL_METHODS].join(", "),
					});
				}
				try {
					return await created.serveFileUrl(fileUrl[1] as string, request);
				} catch (error) {
					return computeErrorResponse(error);
				}
			}
			if (HOST_AGENT_PATH.test(path) || !patterns.some((pattern) => pattern.test(path))) return undefined;
			try {
				if (now() - lastSweep >= SWEEP_EVERY_MS) {
					lastSweep = now();
					await created.sweep();
				}
				const open = await publicRouter(undefined, request);
				if (open !== undefined) return open;
				const principal = await authenticate(request, {
					store,
					now: now(),
					...(options.authenticatePerson === undefined ? {} : { authenticatePerson: options.authenticatePerson }),
					reopenDeletion: (userId) => created.reopenDeletion(userId),
				});
				const answered = await router(principal, request);
				if (answered !== undefined) return answered;
				return json({ error: { code: "invalid", message: `${request.method} is not allowed here` } }, 405);
			} catch (error) {
				return computeErrorResponse(error);
			}
		},
		dispatcher,
		exporter,
		store,
		service: created,
		async close() {
			dispatcher.stop();
			exporter.stop();
			await created.close();
		},
	};
}
