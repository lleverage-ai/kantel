/**
 * The compute plane's HTTP API: `@kantel/api`'s `computeRoutes` under `/v1` (by default), over the service in
 * `service.ts`. It signs the caller in (an API key, or the host's person authenticator) only for a request that is for
 * one of its routes, and resolves `undefined` for any other, so a gateway can chain it before its own routes. Errors
 * answer `{ error: { code, message } }` with `STATUS_BY_CODE`'s status, and 401 `unauthenticated` for a missing or
 * bad credential.
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
import { type ComputeLimits, type ComputeService, createComputeService, type RateTable } from "./service.ts";
import { type ComputeStore, createMemoryStore } from "./store.ts";
import { createTelemetryExporter, type TelemetryExporter } from "./telemetry.ts";
import { createWebhookDispatcher, type WebhookDispatcher } from "./webhooks.ts";

/** The longest body a compute route reads: a 1 MiB file in base64, with room for the rest. */
export const COMPUTE_BODY_LIMIT = 2 * 1024 * 1024;
/** How often, at most, a request sweeps for sandboxes past their stop time. */
const SWEEP_EVERY_MS = 1000;

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
	/** The join command shown with a host join token, with `{url}` and `{token}`. */
	readonly hostJoinCommand?: string;
	/** The console page where a person approves a device sign-in, with `{url}`. Default `{url}/device`. */
	readonly deviceLoginUrl?: string;
	readonly rates?: RateTable;
	readonly limits?: ComputeLimits;
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

/** The error response for a failure: a KantelError's code and status, 401 for no valid credential, else 500. */
export function computeErrorResponse(error: unknown): Response {
	if (error instanceof UnauthenticatedError) {
		return json({ error: { code: "unauthenticated", message: error.message } }, 401, {
			"www-authenticate": 'Bearer realm="kantel"',
		});
	}
	if (isKantelError(error)) {
		return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
	}
	return json({ error: { code: "unavailable", message: "The compute API failed" } }, 500);
}

/** The compute plane's API over a backend, with its webhook dispatcher and telemetry exporter. */
export function createComputeApi(options: ComputeApiOptions): ComputeApi {
	const store = options.store ?? createMemoryStore();
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
		...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
		...(options.mode === undefined ? {} : { mode: options.mode }),
		...(options.hostJoinCommand === undefined ? {} : { hostJoinCommand: options.hostJoinCommand }),
		...(options.deviceLoginUrl === undefined ? {} : { deviceLoginUrl: options.deviceLoginUrl }),
		...(options.rates === undefined ? {} : { rates: options.rates }),
		...(options.limits === undefined ? {} : { limits: options.limits }),
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
			if (!patterns.some((pattern) => pattern.test(path))) return undefined;
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
