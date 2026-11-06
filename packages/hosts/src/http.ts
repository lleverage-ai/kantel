/**
 * The compute plane's HTTP routes, for any target's fetch handler:
 *
 *   POST   /v1/hosts/register                   a host trades its join token for its credential (no sign-in: the
 *                                               token is the authority)
 *   GET    /v1/hosts/e2e/chain?space=…          with the host's credential: a space's E2E chain, and the host's own
 *   POST   /v1/hosts/e2e/chain                  host.add to it (`kantel-host e2e join`)
 *   GET    /v1/hosts/bundles/{digest}?sandboxId=…  with the host's credential: a bundle's tar, for a sandbox on that
 *                                               host that mounts it
 *   GET    /v1/admin/hosts                      the operator's: hosts, join tokens, drain and revoke, as in
 *   POST   /v1/admin/hosts/join-tokens          docs/site/src/content/docs/api/reference/hosts.md
 *   GET    /v1/admin/hosts/{id}
 *   PATCH  /v1/admin/hosts/{id}
 *   DELETE /v1/admin/hosts/{id}
 *   POST   /v1/admin/compute/sandboxes          the operator's diagnostics until the public sandbox API is served:
 *   POST   /v1/admin/compute/sandboxes/{id}/fork   create on a scheduled host, fork, any call on the sandbox's host,
 *   POST   /v1/admin/compute/sandboxes/{id}/call   and delete
 *   DELETE /v1/admin/compute/sandboxes/{id}
 *
 * `GET /v1/hosts/connect` is a WebSocket upgrade, which the target serves itself (the gateway's `hostUpgrades`).
 */
import { isKantelError, KantelError } from "@kantel/contracts";
import type { HostEgress, SandboxTier } from "./protocol.ts";
import type { HostsService } from "./service.ts";

export const HOSTS_REGISTER_PATH = "/v1/hosts/register";
export const HOSTS_E2E_CHAIN_PATH = "/v1/hosts/e2e/chain";
export const HOSTS_CONNECT_PATH = "/v1/hosts/connect";
/** `GET /v1/hosts/bundles/{digest}?sandboxId=…`: a bundle's tar, for a host that mounts it in one of its sandboxes. */
export const HOSTS_BUNDLES_PATH = "/v1/hosts/bundles";
const BUNDLE_DIGEST = /^sha256:[0-9a-f]{64}$/;
/** `GET /v1/hosts/images/{file}`: the host images `kantel-host install` fetches from the control plane. */
export const HOSTS_IMAGES_PATH = "/v1/hosts/images";

/**
 * Kantel's published host images (kernel, sandbox and isolate images, manifest.json): a GitHub Release on
 * lleverage-ai/kantel, made by apps/host/guest/release.sh. Pinned to one release, so a new image reaches hosts only
 * when this changes (or a self-hosted gateway's KANTEL_COMPUTE_IMAGES points elsewhere).
 */
export const DEFAULT_HOST_IMAGES = "https://github.com/lleverage-ai/kantel/releases/download/host-images-20261105.1";
const ADMIN_HOSTS = "/v1/admin/hosts";
const ADMIN_SANDBOXES = "/v1/admin/compute/sandboxes";

export function isHostsPath(path: string): boolean {
	return (
		path === HOSTS_REGISTER_PATH ||
		path === HOSTS_E2E_CHAIN_PATH ||
		path === ADMIN_HOSTS ||
		path.startsWith(`${ADMIN_HOSTS}/`) ||
		path === ADMIN_SANDBOXES ||
		path.startsWith(`${ADMIN_SANDBOXES}/`)
	);
}

export interface HostsApiOptions {
	readonly hosts: HostsService;
	/** Resolves for the deployment's operator; throws (a KantelError `forbidden` or `unauthenticated`) otherwise. */
	authorizeAdmin(request: Request): Promise<void>;
}

const STATUS: { readonly [code: string]: number } = {
	invalid: 400,
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	exhausted: 503,
	unavailable: 503,
	not_supported: 501,
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function body(request: Request): Promise<{ [key: string]: unknown }> {
	try {
		const value: unknown = await request.json();
		if (typeof value === "object" && value !== null && !Array.isArray(value))
			return value as { [key: string]: unknown };
	} catch {
		// Falls through.
	}
	throw new KantelError("invalid", "The body is a JSON object");
}

const optional = <T>(value: unknown, check: (value: unknown) => value is T, what: string): T | undefined => {
	if (value === undefined) return undefined;
	if (!check(value)) throw new KantelError("invalid", `${what} is not valid`);
	return value;
};
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isRecord = (value: unknown): value is { [key: string]: string } =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every((item) => typeof item === "string");
const isObject = (value: unknown): value is object =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

export function createHostsApi(options: HostsApiOptions) {
	const { hosts } = options;
	const admin = async (request: Request, path: string): Promise<Response | undefined> => {
		await options.authorizeAdmin(request);
		if (path === ADMIN_HOSTS && request.method === "GET") return json({ items: await hosts.list() });
		if (path === `${ADMIN_HOSTS}/join-tokens` && request.method === "POST") {
			const input = await body(request);
			const name = optional(input.name, isString, "name");
			const labels = optional(input.labels, isRecord, "labels");
			const expiresInMinutes = optional(input.expiresInMinutes, isNumber, "expiresInMinutes");
			return json(
				await hosts.createJoinToken({
					...(name === undefined ? {} : { name }),
					...(labels === undefined ? {} : { labels }),
					...(expiresInMinutes === undefined ? {} : { expiresInMinutes }),
				}),
				201,
			);
		}
		const hostMatch = /^\/v1\/admin\/hosts\/([^/]+)$/.exec(path);
		if (hostMatch?.[1] !== undefined) {
			const hostId = decodeURIComponent(hostMatch[1]);
			if (request.method === "GET") return json(await hosts.get(hostId));
			if (request.method === "DELETE") return json(await hosts.revoke(hostId));
			if (request.method === "PATCH") {
				const input = await body(request);
				const name = optional(input.name, isString, "name");
				const labels = optional(input.labels, isRecord, "labels");
				const draining = optional(input.draining, isBoolean, "draining");
				if (input.pools !== undefined && input.pools !== null) {
					throw new KantelError("invalid", "Hosts keep no warm pools: a create restores a snapshot");
				}
				return json(
					await hosts.update(hostId, {
						...(name === undefined ? {} : { name }),
						...(labels === undefined ? {} : { labels }),
						...(draining === undefined ? {} : { draining }),
					}),
				);
			}
			return undefined;
		}
		if (path === ADMIN_SANDBOXES && request.method === "POST") {
			const input = await body(request);
			const tier = input.tier;
			if (tier !== "microvm" && tier !== "isolate") throw new KantelError("invalid", "tier is microvm or isolate");
			const sandboxId = optional(input.sandboxId, isString, "sandboxId");
			const size = optional(input.size, isString, "size");
			const vcpus = optional(input.vcpus, isNumber, "vcpus");
			const memoryMiB = optional(input.memoryMiB, isNumber, "memoryMiB");
			const owner = optional(input.owner, isString, "owner");
			const labels = optional(input.labels, isRecord, "labels");
			const env = optional(input.env, isRecord, "env");
			const keys = optional(input.sshAuthorizedKeys, isStrings, "sshAuthorizedKeys");
			const egress = optional(input.egress, isObject, "egress") as HostEgress | undefined;
			return json(
				await hosts.sandboxes.create({
					tier: tier as SandboxTier,
					...(sandboxId === undefined ? {} : { sandboxId }),
					...(size === undefined ? {} : { size }),
					...(memoryMiB === undefined ? {} : { shape: { vcpus: vcpus ?? 0, memoryMiB } }),
					...(owner === undefined ? {} : { owner }),
					...(labels === undefined ? {} : { labels }),
					...(env === undefined ? {} : { env }),
					...(keys === undefined ? {} : { sshAuthorizedKeys: keys }),
					...(egress === undefined ? {} : { egress }),
				}),
				201,
			);
		}
		const sandboxMatch = /^\/v1\/admin\/compute\/sandboxes\/([^/]+)(\/fork|\/call)?$/.exec(path);
		if (sandboxMatch?.[1] !== undefined) {
			const sandboxId = decodeURIComponent(sandboxMatch[1]);
			const action = sandboxMatch[2];
			if (action === undefined && request.method === "DELETE") {
				await hosts.sandboxes.delete(sandboxId);
				return new Response(null, { status: 204 });
			}
			if (action === undefined && request.method === "GET") {
				const placement = await hosts.sandboxes.placement(sandboxId);
				if (placement === undefined) throw new KantelError("not_found", "No such sandbox");
				return json(placement);
			}
			if (action === "/fork" && request.method === "POST") {
				const input = await body(request);
				const newId = optional(input.newId, isString, "newId");
				return json(await hosts.sandboxes.fork(sandboxId, newId === undefined ? {} : { newId }), 201);
			}
			if (action === "/call" && request.method === "POST") {
				const input = await body(request);
				const method = input.method;
				if (typeof method !== "string") throw new KantelError("invalid", "method is a string");
				const params = optional(input.params, isObject, "params") ?? {};
				return json(await hosts.sandboxes.call(sandboxId, method, params));
			}
		}
		return undefined;
	};

	const isEntries = (value: unknown): value is { payload: string; sig: string }[] =>
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 100 &&
		value.every(
			(entry) =>
				isObject(entry) &&
				isString((entry as { payload?: unknown }).payload) &&
				isString((entry as { sig?: unknown }).sig),
		);
	/** The host whose credential the request carries, unless it is unknown or revoked. */
	const hostOf = async (request: Request) => {
		const credential = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
		return credential === undefined ? undefined : await hosts.authenticate(credential);
	};
	const noHost = () => json({ error: { code: "unauthenticated", message: "This needs a host's credential" } }, 401);

	/** The chain routes, for the host whose credential the request carries. */
	const chain = async (request: Request): Promise<Response> => {
		const host = await hostOf(request);
		if (host === undefined) return noHost();
		if (request.method === "GET") {
			const space = new URL(request.url).searchParams.get("space");
			if (space === null || space === "") throw new KantelError("invalid", "space is required");
			return json({ entries: await hosts.e2eChain(host.id, space) });
		}
		if (request.method === "POST") {
			const input = await body(request);
			if (!isString(input.space) || !isNumber(input.from) || !isEntries(input.entries)) {
				throw new KantelError("invalid", "The body is { space, from, entries }");
			}
			return json({ entries: await hosts.appendE2EChain(host.id, input.space, input.from, input.entries) });
		}
		return json({ error: { code: "invalid", message: "GET or POST" } }, 405);
	};

	/**
	 * A bundle's tar, streamed, for the host whose credential the request carries: only for a sandbox on that host that
	 * mounts it (the compute plane decides), so a host learns nothing of another's bundles.
	 */
	const bundle = async (request: Request, path: string): Promise<Response> => {
		const host = await hostOf(request);
		if (host === undefined) return noHost();
		if (request.method !== "GET") return json({ error: { code: "invalid", message: "GET only" } }, 405);
		let digest: string;
		try {
			digest = decodeURIComponent(path.slice(HOSTS_BUNDLES_PATH.length + 1));
		} catch {
			digest = "";
		}
		if (!BUNDLE_DIGEST.test(digest)) throw new KantelError("invalid", "A bundle's digest is sha256: and 64 hex digits");
		const sandboxId = new URL(request.url).searchParams.get("sandboxId");
		if (sandboxId === null || sandboxId === "") throw new KantelError("invalid", "sandboxId is required");
		const found = await hosts.bundle(host.id, sandboxId, digest);
		if (found === undefined) {
			return json({ error: { code: "not_found", message: "No such bundle for this sandbox on this host" } }, 404);
		}
		return new Response(found.body, {
			status: 200,
			headers: {
				"content-type": "application/x-tar",
				"content-length": String(found.sizeBytes),
				"cache-control": "no-store",
			},
		});
	};

	return {
		async fetch(request: Request): Promise<Response | undefined> {
			const path = new URL(request.url).pathname;
			try {
				if (path === HOSTS_REGISTER_PATH) {
					if (request.method !== "POST") return json({ error: { code: "invalid", message: "POST only" } }, 405);
					const input = await body(request);
					if (typeof input.token !== "string") throw new KantelError("invalid", "token is required");
					const name = optional(input.name, isString, "name");
					// Go marshals a host's empty labels as null.
					const labels = optional(input.labels ?? undefined, isRecord, "labels");
					const facts = optional(input.facts, isObject, "facts");
					return json(
						await hosts.register({
							token: input.token,
							...(name === undefined ? {} : { name }),
							...(labels === undefined ? {} : { labels }),
							...(facts === undefined ? {} : { facts: facts as never }),
						}),
						201,
					);
				}
				if (path === HOSTS_E2E_CHAIN_PATH) return await chain(request);
				if (path.startsWith(`${HOSTS_BUNDLES_PATH}/`)) return await bundle(request, path);
				if (!isHostsPath(path)) return undefined;
				return await admin(request, path);
			} catch (error) {
				if (isKantelError(error)) {
					return json({ error: { code: error.code, message: error.message } }, STATUS[error.code] ?? 500);
				}
				throw error;
			}
		},
	};
}
