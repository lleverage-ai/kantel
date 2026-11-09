/**
 * The compute plane on the self-hosted gateway, always on: the console is its console.
 *
 * `@kantel/compute` serves the API (accounts, sandboxes, snapshots, scoped `ksk_` keys, webhooks, OpenTelemetry export
 * and hosts under `/v1`) over a `SandboxBackend`:
 *
 *   - `hosts` (the default wherever the gateway knows the address hosts reach it at, as the Compose stack does):
 *     machines running `kantel-host` (`@kantel/hosts`, apps/host). A host joins with a token the API mints
 *     (`POST /v1/admin/hosts/join-tokens`), registers at `POST /v1/hosts/register`, dials out to `GET /v1/hosts/connect`
 *     and runs the sandboxes the scheduler places on it: Firecracker microVMs and workerd isolates. The registry of
 *     hosts and placements is in Postgres with a database, in memory otherwise.
 *   - `stub` (the default with no such address, as under `pnpm dev`): a just-bash shell over files in memory, to try
 *     the API with no machine of your own. `KANTEL_COMPUTE_BACKEND=stub` picks it anywhere.
 *
 * The API's records (accounts, sandboxes, keys, webhooks and the rest) are in Postgres with a database (durable.ts),
 * so they outlast a restart and gateways over one database share them; in memory otherwise, gone after a restart. The
 * super-admin's key is kept either way: the gateway keeps its secret in the bootstrap file and makes it again on a start
 * that doesn't find it.
 *
 *   KANTEL_COMPUTE_BACKEND       `hosts` runs sandboxes on joined hosts, `stub` on the stand-in; default `hosts` when
 *                                one of the URLs below is set, else `stub`
 *   KANTEL_COMPUTE_PUBLIC_URL    with `hosts`: where hosts and clients reach this gateway (join commands, desktop,
 *                                browser and SSH tunnels); default KANTEL_PUBLIC_URL, one of which `hosts` needs.
 *                                deploy/compose/compose.yaml sets it to the gateway's local address by default
 *   KANTEL_COMPUTE_POOLS         no longer read: hosts keep no warm pools (a create restores a snapshot); set, it is
 *                                ignored with a warning
 *   KANTEL_COMPUTE_JOIN_COMMAND  the join command shown with a token, with {url} and {token}; default the host
 *                                installer from Kantel's latest GitHub Release (DEFAULT_HOST_JOIN_COMMAND)
 *   KANTEL_HOST_VERSION, KANTEL_HOST_UPDATE_URL
 *                                the kantel-host version hosts should run and where they fetch it ({version}, {os},
 *                                {arch}; default that version's GitHub Release, DEFAULT_HOST_UPDATE_URL); without a
 *                                version, hosts aren't asked to update on their own
 *   KANTEL_HOST_RELEASES         without KANTEL_HOST_VERSION: where the latest kantel-host release is read, hourly, to
 *                                say which hosts are out of date and update one from the console. A URL answering
 *                                `{"tag_name": "v0.4.2"}` or `{"version": "0.4.2"}`; default Kantel's latest GitHub
 *                                Release (DEFAULT_HOST_RELEASES_URL); `off` reads none
 *   KANTEL_RELEASE_CHECK_TOKEN   with KANTEL_HOST_RELEASES read: a shared secret (32 characters or more, such as
 *                                `openssl rand -hex 32`) that `POST /v1/hosts/releases/check` takes as its bearer to
 *                                read the latest release again at once, as the hosted control plane's release
 *                                workflow does. Unset, every call there is refused; a super-admin's Check for updates
 *                                (`POST /v1/admin/hosts/check-for-updates`) works either way
 *   KANTEL_COMPUTE_IMAGES        where `kantel-host install` gets the kernel and images (GET /v1/hosts/images/...): a
 *                                directory this gateway serves (with manifest.json from `kantel-host manifest <dir>`), or
 *                                an http(s) URL it redirects to; `off` serves none. Default: Kantel's published images,
 *                                DEFAULT_HOST_IMAGES. The images are public (an Ubuntu root file system with Chromium,
 *                                Docker and a desktop, the guest agent, a kernel), so the route asks no credential.
 *   KANTEL_COMPUTE_PORTS_DOMAIN  with `hosts`: the name exposed ports are served under, `{port}-{subdomain}.{domain}`;
 *                                point a wildcard DNS name and certificate (`*.{domain}`) at this gateway. Use a
 *                                registrable domain of its own (not under the gateway's), so a sandbox's page can't set
 *                                cookies for the console. Unset, sandboxes expose no ports
 *   KANTEL_EGRESS_ATTRIBUTION_KEY
 *                                signs the Kantel-Sandbox and Kantel-Account headers hosts send an account's proxy
 *                                upstream when its settings ask for attribution (share it with the upstream); unset,
 *                                they go unsigned
 *   KANTEL_ACCOUNT_HOSTS         `experimental` turns on account hosts with `hosts`: an account's people add machines
 *                                of their own (`POST /v1/hosts/join-tokens`, `kantel hosts add`), which dial out to
 *                                this gateway like any host and run only that account's sandboxes. Default off: the
 *                                `/v1/hosts` routes for them answer 501 not_supported
 *   KANTEL_IMAGE_PATCHING        `experimental` turns on image patching: sandboxes and saved snapshots say which base
 *                                image they are on and how far behind it is (`base`), `POST
 *                                /v1/sandboxes/{id}/restart-on-latest` moves one onto the newest, `GET
 *                                /v1/admin/hosts/images` lists the base images and their CVE scans, and hosts are
 *                                told the host images to fetch in their welcome. Default off: no `base`, and those
 *                                routes answer 501 not_supported
 *   KANTEL_BASE_IMAGE_INDEX      with image patching: where the base image index CI publishes is read, an http(s) URL;
 *                                default the `base-images` GitHub Release's index.json (DEFAULT_BASE_IMAGE_INDEX).
 *                                Read at most every 5 minutes; a failure is kept for a minute and shown in the admin
 *                                list
 *   KANTEL_MOUNTS                `experimental` turns on read-only mounts (bundles and bucket prefixes in a sandbox),
 *                                bundles (`POST /v1/bundles`), bucket sources, signed file URLs (`/v1/file-urls/...`)
 *                                and archive extraction, with either backend. A bundle's tar is kept once per account under
 *                                `bundles/` beside the bootstrap file (KANTEL_BOOTSTRAP_FILE, a volume in Compose), or
 *                                in KANTEL_BUNDLES_DIR, which replicas over one database must share: one whose store
 *                                isn't the deployment's refuses bundles' bytes (`BundleBlobStore.mark`).
 *                                Default off: their routes answer 501 not_supported
 *   KANTEL_SNAPSHOT_EXPIRY       `on` deletes automatic snapshots past their expiry, on hosts that keep their own copies
 *                                (off by default; a replicated install turns it on once every gateway runs this version)
 *   KANTEL_TEMPLATES             `experimental` turns on templates: versioned microVM profiles whose snapshots are built
 *                                in the background (`/v1/templates`, `/v1/template-bases`), on the stub or on hosts
 *                                that build them. Default off: those routes answer 501 not_supported
 *
 * An account's proxy settings (PUT /v1/proxy) reach its sandboxes as they boot (create, start, resume, fork): the host's
 * egress proxy applies the allow and deny rules, and with the host's --proxy-data-path switch on passes allowed
 * requests to the upstream with the account's headers, which the host holds and the sandbox never sees.
 *
 * A host's WebSocket is checked before it is used: no credential or a wrong or revoked one is accepted and closed at
 * once with 4003, which kantel-host reads as "stop, don't retry". (Bun's node:http drops a plain 401 written to an
 * upgrade's socket, so the host would see an empty reply and retry for ever.) No upgrade is refused with an HTTP
 * status for the same reason: the other refusals close with 4000 plus the status (`upgrade-refusal.ts`).
 *
 * A person signed in to the console (or with an OIDC or Access token) is a compute person under their user ID, and a
 * super-admin when they are an admin of the deployment's organisation.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { type Duplex, Readable } from "node:stream";
import {
	baseImageIndexReader,
	baseImageIndexUrl,
	type ComputeApi,
	type ComputeStore,
	createComputeApi,
	createMemoryStore,
	hostSnapshotLinks,
	type InviteMailing,
	imagePatchingSwitch,
	joinTokenSpender,
	type LiveRelay,
	type PersonIdentity,
	personName,
	type SandboxBackend,
} from "@kantel/compute";
import { createDirBundleStore, createMemoryBundleStore } from "@kantel/compute/bundles";
import { bootstrapSuperAdmin } from "@kantel/compute/serve";
import { createStubBackend } from "@kantel/compute/stub";
import {
	type Authenticator,
	callContextFor,
	EMAIL_OTP_ISSUER,
	type IdentityDirectory,
	KantelError,
	MOUNTS_SWITCH,
	normaliseEmail,
	systemContext,
} from "@kantel/contracts";
import { BROWSER_PORT, createHostBackend, SSH_PORT } from "@kantel/hosts/backend";
import type { HostCluster } from "@kantel/hosts/cluster";
import { createDesktopRoutes, type DesktopSocket, HOSTS_DESKTOP_PATH } from "@kantel/hosts/desktop";
import {
	createHostsApi,
	DEFAULT_HOST_IMAGES,
	HOSTS_BUNDLES_PATH,
	HOSTS_CONNECT_PATH,
	HOSTS_IMAGES_PATH,
	HOSTS_REGISTER_PATH,
	HOSTS_RELEASE_CHECK_PATH,
} from "@kantel/hosts/http";
import { closeQuietly } from "@kantel/hosts/hub";
import { openPortWebSocket } from "@kantel/hosts/port-websocket";
import { createPortRouter, type PortRouter } from "@kantel/hosts/ports";
import { HOST_CLOSE_REVOKED, HOST_MAX_MESSAGE_BYTES } from "@kantel/hosts/protocol";
import {
	createRelayAccess,
	RELAY_CLOSE_REVOKED,
	RELAY_REVOKED_REASON,
	type RelayAccess,
} from "@kantel/hosts/relay-access";
import type { RelayStore } from "@kantel/hosts/relay-store";
import {
	createHostReleases,
	DEFAULT_HOST_RELEASES_URL,
	DEFAULT_HOST_UPDATE_URL,
	type HostReleasesStore,
} from "@kantel/hosts/releases";
import { createHostsService, type HostsService } from "@kantel/hosts/service";
import type { HostStore } from "@kantel/hosts/store";
import { createTunnelTickets, HOSTS_TUNNEL_PATH, type IssuedGrant, type TunnelTickets } from "@kantel/hosts/tunnel";
import type { InviteMailer } from "@kantel/identity/invites";
import { hashSessionToken, isSessionToken } from "@kantel/identity/otp";
import { type WebSocket, WebSocketServer } from "ws";
import { CLUSTER_PATH, type GatewayCluster } from "./cluster.ts";
import type { UpgradeHandler } from "./node-http.ts";
import { refuseUpgrade } from "./upgrade-refusal.ts";

/** How often webhook deliveries that are due are sent. */
const WEBHOOK_INTERVAL_MS = 1000;
/** How often telemetry is exported. */
const TELEMETRY_INTERVAL_MS = 60_000;
/** How often expired tunnel tickets' rows are removed. */
const TICKET_SWEEP_MS = 10 * 60_000;
/** How often the compute sweep runs without requests: auto-stops, and egress a host missed while it was away. */
const COMPUTE_SWEEP_MS = 5_000;

/** The `hosts` backend's settings. */
export interface ComputeHostsConfig {
	readonly publicUrl: string;
	readonly joinCommand?: string;
	readonly desiredVersion?: string;
	readonly updateUrl?: string;
	/** Where the latest kantel-host release is read; absent, it isn't (KANTEL_HOST_RELEASES=off). */
	readonly releasesUrl?: string;
	/** KANTEL_RELEASE_CHECK_TOKEN: the bearer `POST /v1/hosts/releases/check` takes. Absent, it refuses every call. */
	readonly releaseToken?: string;
	readonly images?: string;
	readonly attributionKey?: string;
	/** Exposed ports' wildcard name's parent, such as `kantel-ports.example`. */
	readonly portsDomain?: string;
	/** Account hosts (KANTEL_ACCOUNT_HOSTS=experimental): accounts add hosts of their own. */
	readonly accountHosts?: boolean;
}

/** The compute plane's settings: `hosts` is set when sandboxes run on joined hosts, not the stub. */
export interface ComputeConfig {
	readonly hosts?: ComputeHostsConfig;
	/** Image patching (KANTEL_IMAGE_PATCHING=experimental), and where the base image index is read. */
	readonly imagePatching?: { readonly indexUrl: string };
	/** Mounts, bundles and signed file URLs (KANTEL_MOUNTS=experimental), on either backend. */
	readonly mounts?: boolean;
	/** Templates (KANTEL_TEMPLATES=experimental): versioned microVM profiles and their snapshot cache. */
	readonly templates?: boolean;
	/**
	 * Expiry of automatic snapshots (KANTEL_SNAPSHOT_EXPIRY=on). Off by default: a replicated install turns it on only
	 * once every gateway runs a version that has it.
	 */
	readonly snapshotExpiry?: boolean;
}

/**
 * The compute plane's settings. (`KANTEL_COMPUTE`, which once had to be `experimental` to turn it on, is no longer
 * read.)
 */
export function computeConfig(env: NodeJS.ProcessEnv): ComputeConfig {
	const publicUrl = (env.KANTEL_COMPUTE_PUBLIC_URL?.trim() || env.KANTEL_PUBLIC_URL?.trim()) ?? "";
	const backend = env.KANTEL_COMPUTE_BACKEND?.trim().toLowerCase() || (publicUrl === "" ? "stub" : "hosts");
	// Left out when off, so a config without it is as it was.
	const patching = imagePatchingSwitch(env.KANTEL_IMAGE_PATCHING)
		? { imagePatching: { indexUrl: baseImageIndexUrl(env.KANTEL_BASE_IMAGE_INDEX) } }
		: {};
	// Read whatever the backend, so a typo stops the gateway on the stub too.
	const mounts = mountsSwitch(env[MOUNTS_SWITCH]);
	const templates = templatesSwitch(env.KANTEL_TEMPLATES) ? { templates: true } : {};
	const expiry = snapshotExpirySwitch(env.KANTEL_SNAPSHOT_EXPIRY) ? { snapshotExpiry: true } : {};
	if (backend === "stub") return { ...(mounts ? { mounts } : {}), ...templates, ...patching, ...expiry };
	if (backend !== "hosts") throw new Error("KANTEL_COMPUTE_BACKEND is `stub` or `hosts`");
	if (!/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
		throw new Error(
			"KANTEL_COMPUTE_BACKEND=hosts needs KANTEL_COMPUTE_PUBLIC_URL or KANTEL_PUBLIC_URL: where hosts reach this gateway",
		);
	}
	if ((env.KANTEL_COMPUTE_POOLS?.trim() ?? "") !== "") {
		// An install from before warm pools were removed may still set it: it starts, without them.
		console.warn("[compute] KANTEL_COMPUTE_POOLS is ignored: hosts keep no warm pools, a create restores a snapshot");
	}
	const version = env.KANTEL_HOST_VERSION?.trim() ?? "";
	const updateUrl = env.KANTEL_HOST_UPDATE_URL?.trim() || DEFAULT_HOST_UPDATE_URL;
	const rawReleases = env.KANTEL_HOST_RELEASES?.trim() || DEFAULT_HOST_RELEASES_URL;
	const releasesUrl = rawReleases.toLowerCase() === "off" ? "" : rawReleases;
	if (releasesUrl !== "" && !/^https?:\/\/[^/\s]+/.test(releasesUrl)) {
		throw new Error("KANTEL_HOST_RELEASES is an http(s) URL, or `off`");
	}
	const releaseToken = env.KANTEL_RELEASE_CHECK_TOKEN?.trim() ?? "";
	const rawImages = env.KANTEL_COMPUTE_IMAGES?.trim() || DEFAULT_HOST_IMAGES;
	const images = rawImages.toLowerCase() === "off" ? "" : rawImages;
	const joinCommand = env.KANTEL_COMPUTE_JOIN_COMMAND?.trim() ?? "";
	const accountHosts = accountHostsSwitch(env.KANTEL_ACCOUNT_HOSTS);
	const attributionKey = env.KANTEL_EGRESS_ATTRIBUTION_KEY?.trim() ?? "";
	const portsDomain =
		env.KANTEL_COMPUTE_PORTS_DOMAIN?.trim()
			.toLowerCase()
			.replace(/^\*?\.+|\.+$/g, "") ?? "";
	if (portsDomain !== "") {
		if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(portsDomain)) {
			throw new Error("KANTEL_COMPUTE_PORTS_DOMAIN is a DNS name such as kantel-ports.example");
		}
		const gateway = new URL(publicUrl).hostname;
		if (gateway === portsDomain || gateway.endsWith(`.${portsDomain}`)) {
			throw new Error("KANTEL_COMPUTE_PORTS_DOMAIN can't be the gateway's own name or a parent of it");
		}
	}
	return {
		...(mounts ? { mounts } : {}),
		...templates,
		...expiry,
		hosts: {
			publicUrl: new URL(publicUrl).origin,
			...(accountHosts ? { accountHosts } : {}),
			...(portsDomain === "" ? {} : { portsDomain }),
			...(attributionKey === "" ? {} : { attributionKey }),
			...(images === "" ? {} : { images }),
			...(joinCommand === "" ? {} : { joinCommand }),
			...(version === "" || updateUrl === "" ? {} : { desiredVersion: version }),
			...(updateUrl === "" ? {} : { updateUrl }),
			...(version !== "" || releasesUrl === "" ? {} : { releasesUrl }),
			...(releaseToken === "" ? {} : { releaseToken }),
		},
		...patching,
	};
}

/**
 * KANTEL_ACCOUNT_HOSTS: `experimental` turns account hosts on; unset, empty or `off` leaves them off. Anything else is
 * a mistake worth stopping for, so a typo can't leave them off unnoticed.
 */
export function accountHostsSwitch(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase() ?? "";
	if (value === "" || value === "off") return false;
	if (value === "experimental") return true;
	throw new Error("KANTEL_ACCOUNT_HOSTS is `experimental` or `off`");
}

/**
 * KANTEL_MOUNTS: `experimental` turns mounts, bundles and signed file URLs on; unset, empty or `off` leaves them off.
 * Anything else stops the gateway, as for KANTEL_ACCOUNT_HOSTS.
 */
export function mountsSwitch(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase() ?? "";
	if (value === "" || value === "off") return false;
	if (value === "experimental") return true;
	throw new Error(`${MOUNTS_SWITCH} is \`experimental\` or \`off\``);
}

/**
 * KANTEL_TEMPLATES: `experimental` turns templates on; unset, empty or `off` leaves them off. Anything else is a mistake
 * worth stopping for, as KANTEL_ACCOUNT_HOSTS's is.
 */
export function templatesSwitch(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase() ?? "";
	if (value === "" || value === "off") return false;
	if (value === "experimental") return true;
	throw new Error("KANTEL_TEMPLATES is `experimental` or `off`");
}

/**
 * KANTEL_SNAPSHOT_EXPIRY: `on` expires automatic snapshots past their `expiresAt`; unset, empty or `off` leaves them be.
 * A replicated install turns it on only once every gateway runs a version that has it. Anything else stops the gateway.
 */
export function snapshotExpirySwitch(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase() ?? "";
	if (value === "" || value === "off") return false;
	if (value === "on") return true;
	throw new Error("KANTEL_SNAPSHOT_EXPIRY is `on` or `off`");
}

/** The registry of hosts (`@kantel/hosts`) the `hosts` backend places sandboxes on. */
export function gatewayHosts(
	config: ComputeHostsConfig,
	store: HostStore,
	log?: (message: string) => void,
	cluster?: HostCluster,
	/** Where release checks are recorded for every replica: the database's, with one. Default this gateway's memory. */
	releasesStore?: HostReleasesStore,
): HostsService {
	return createHostsService({
		store,
		...(cluster === undefined ? {} : { cluster }),
		publicUrl: config.publicUrl,
		...(config.joinCommand === undefined ? {} : { joinCommand: config.joinCommand }),
		...(config.desiredVersion === undefined ? {} : { desiredVersion: config.desiredVersion }),
		...(config.updateUrl === undefined ? {} : { updateUrl: config.updateUrl }),
		...(config.releasesUrl === undefined
			? {}
			: {
					releases: createHostReleases({
						url: config.releasesUrl,
						...(log === undefined ? {} : { log }),
						...(releasesStore === undefined ? {} : { store: releasesStore }),
					}),
				}),
		...(log === undefined ? {} : { log }),
	});
}

/** `GET /v1/hosts/images/{file}`: the host images `kantel-host install` fetches. */
export const HOST_IMAGES_PATH = HOSTS_IMAGES_PATH;

/** Kantel's published host images (`@kantel/hosts/http`); the hosted gateway serves the same ones. */
/**
 * Where a host fetches the kantel-host it's moved to (KANTEL_HOST_VERSION's, or the latest release's): that version's
 * GitHub Release; and where the latest release is read.
 */
export { DEFAULT_HOST_IMAGES, DEFAULT_HOST_RELEASES_URL, DEFAULT_HOST_UPDATE_URL };

/**
 * Serves the host images from a directory, or redirects to where they are; undefined for any other path. A file name
 * is one path segment of letters, digits, dots, dashes and underscores, so nothing outside the directory is reachable.
 */
export function hostImages(source: string): (request: Request) => Promise<Response | undefined> {
	const remote = /^https?:\/\//.test(source);
	return async (request) => {
		const path = new URL(request.url).pathname;
		if (!path.startsWith(`${HOST_IMAGES_PATH}/`)) return undefined;
		const name = path.slice(HOST_IMAGES_PATH.length + 1);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return new Response("Not found", { status: 404 });
		if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
		if (remote) {
			return new Response(null, { status: 302, headers: { location: `${source.replace(/\/+$/, "")}/${name}` } });
		}
		const file = join(source, name);
		const info = await stat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) return new Response("Not found", { status: 404 });
		const headers = {
			"content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream",
			"content-length": String(info.size),
			"cache-control": name === "manifest.json" ? "no-cache" : "public, max-age=300",
		};
		if (request.method === "HEAD") return new Response(null, { headers });
		return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, { headers });
	};
}

/**
 * What the `hosts` backend needs from the gateway: the registry, the tunnel tickets and exposed ports (both in the relay
 * store, so they outlast a restart and every replica serves them), and the check that ends relayed access.
 */
export interface GatewayHostsBackend {
	readonly service: HostsService;
	readonly config: ComputeHostsConfig;
	readonly tickets: TunnelTickets;
	/** Exposed ports, when the config names a domain for them. */
	readonly ports?: PortRouter;
	/** Whether relayed access may go on; asks the compute API once `bind` is called. */
	readonly access: RelayAccess;
	/** This gateway among its replicas, with a database: it serves their calls for hosts connected here. */
	readonly cluster?: GatewayCluster;
	/**
	 * Points the access check at the compute API, once there is one, and with `notRunning` what a request to a stopped
	 * sandbox's port is told (`ComputeService.portNotRunning`).
	 */
	bind(
		stillAllowed: (grantee: string | undefined, sandboxId: string) => Promise<boolean>,
		notRunning?: (sandboxId: string) => Promise<string | undefined>,
	): void;
}

/** The `hosts` backend's relay over `store`: tickets, exposed ports (with a ports domain) and the access check. */
export function gatewayRelay(
	config: ComputeHostsConfig,
	service: HostsService,
	store: RelayStore,
	options: { readonly intervalMs?: number; readonly now?: () => number; readonly cluster?: GatewayCluster } = {},
): GatewayHostsBackend {
	let check: ((grantee: string | undefined, sandboxId: string) => Promise<boolean>) | undefined;
	let stopped: ((sandboxId: string) => Promise<string | undefined>) | undefined;
	const access = createRelayAccess({
		// Nothing is let through before the compute API can answer.
		stillAllowed: (grantee, sandboxId) => check?.(grantee, sandboxId) ?? Promise.resolve(false),
		...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	const ports =
		config.portsDomain === undefined
			? undefined
			: createPortRouter({
					domain: config.portsDomain,
					scheme: new URL(config.publicUrl).protocol === "http:" ? "http" : "https",
					openPort: (sandboxId, port, sink) => service.sandboxes.openPort(sandboxId, port, sink),
					store,
					stillAllowed: (grantee, sandboxId) => access.allowed(grantee, sandboxId),
					notRunning: (sandboxId) => stopped?.(sandboxId) ?? Promise.resolve(undefined),
					...(options.now === undefined ? {} : { now: options.now }),
				});
	return {
		service,
		config,
		tickets: createTunnelTickets(store, options.now),
		...(ports === undefined ? {} : { ports }),
		...(options.cluster === undefined ? {} : { cluster: options.cluster }),
		access,
		bind(stillAllowed, notRunning) {
			check = stillAllowed;
			stopped = notRunning;
		},
	};
}

export interface GatewayCompute {
	readonly api: ComputeApi;
	/** The super-admin key's secret, for the bootstrap file. */
	readonly superAdminKey: string;
	/** `/v1/deployment`'s line about it. */
	readonly binding: string;
	/**
	 * The routes a host calls with no sign-in (`POST /v1/hosts/register`, its join token the authority) and the host
	 * images; undefined for any other path. Absent on the stub.
	 */
	readonly hostRoutes?: (request: Request) => Promise<Response | undefined>;
	/** Requests to an exposed port's name, before any other route; undefined for any other name. */
	readonly portRoutes?: (request: Request, client?: { readonly address?: string }) => Promise<Response | undefined>;
	close(): Promise<void>;
}

/**
 * The person a gateway sign-in is, or undefined for a key or no sign-in (a `ksk_` key is the compute API's own). A
 * person who is admin across the deployment's organisation is the compute plane's super-admin, who sees and adds
 * hosts. (A person's sign-in carries no role of its own: roles are held per project or organisation, so it asks
 * `identity`.) Their name and email come from `identity` too, with `getUser`: an invite made for an address is joined
 * by matching it, so without it no such invite could be, and the members list and "created by" name them so.
 */
async function personOf(
	authenticator: Authenticator,
	identity: PersonDirectory | undefined,
	request: Request,
): Promise<PersonIdentity | undefined> {
	let caller: Awaited<ReturnType<Authenticator["authenticate"]>>;
	try {
		caller = await authenticator.authenticate(request);
	} catch {
		return undefined;
	}
	if (caller.actor.kind !== "human") return undefined;
	const ctx = callContextFor(caller);
	const [superAdmin, user] = await Promise.all([
		identity === undefined
			? false
			: identity.authorize(ctx, "admin").then(
					() => true,
					() => false,
				),
		identity?.getUser?.(ctx, caller.actor.userId).catch(() => undefined),
	]);
	const email = user?.email === undefined || user.email === "" ? undefined : user.email;
	// A Kantel session can be ended (signing out), so access given under it records which one, to end with it.
	const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
	const session = bearer !== undefined && isSessionToken(bearer) ? await hashSessionToken(bearer) : undefined;
	return {
		userId: caller.actor.userId,
		// As they are known everywhere else: their name, else their email, never their user ID while either is known.
		name: personName({ userId: caller.actor.userId, name: user?.name, email }),
		...(email === undefined ? {} : { email }),
		superAdmin,
		...(session === undefined ? {} : { session }),
	};
}

/**
 * A compute organisation's invites, emailed with the deployment's mailer (the one that sends sign-in codes). The link
 * opens the console at `publicOrigin` (KANTEL_PUBLIC_URL): the request URL here is always `http:`.
 *
 * Sign-in here is invite-only: someone the deployment doesn't know yet can't get a sign-in code, and an organisation's
 * invite doesn't change that (letting someone into the deployment is its admins' call, with the deployment's own
 * invites). So with `identity`, an invite is emailed only to an address that can sign in by email code; for anyone
 * else the console shows the code, and an admin invites them to the deployment first.
 */
export function computeInvites(
	mailer: InviteMailer,
	publicOrigin: string | undefined,
	identity?: Pick<IdentityDirectory, "canSignIn">,
): InviteMailing {
	return {
		send: (mail) => mailer.sendInvite(mail),
		...(identity === undefined
			? {}
			: {
					canSignIn: (email: string) => {
						const normalised = normaliseEmail(email);
						return identity.canSignIn(INVITE_MAIL, {
							issuer: EMAIL_OTP_ISSUER,
							subject: normalised,
							email: normalised,
							emailVerified: true,
						});
					},
				}),
		...(publicOrigin === undefined ? {} : { consoleUrl: publicOrigin }),
		onMailError: (error, to) =>
			console.error(`[gateway] organisation invite mail to ${JSON.stringify(to)} failed:`, error),
	};
}

/** The context `computeInvites` asks identity whether an invite's address can sign in under. */
const INVITE_MAIL = systemContext("gateway.compute-invites");

/** What `personOf` asks identity: whether the person administers the organisation, and their name and email. */
type PersonDirectory = Pick<IdentityDirectory, "authorize"> & Partial<Pick<IdentityDirectory, "getUser">>;

/** The compute API over the stub, or over joined hosts with `hosts`, signed in with the gateway's `authenticator`. */
export async function gatewayCompute(options: {
	readonly authenticator: Authenticator;
	/**
	 * Who holds which role (an organisation admin who signs in is the compute plane's super-admin) and, with `getUser`,
	 * each person's name and email.
	 */
	readonly identity?: PersonDirectory;
	/** The super-admin key's secret from an earlier start, if any. */
	readonly superAdminKey?: string;
	readonly publicUrl?: string;
	readonly now?: () => number;
	readonly hosts?: GatewayHostsBackend;
	/** Where the API's records are kept: Postgres with a database. Default in memory. */
	readonly store?: ComputeStore;
	/** Whether a Kantel session (its token's hash) is live: access given under one ends when it does. */
	readonly sessionLive?: (session: string) => Promise<boolean>;
	/** Removes a person from sign-in once they delete their account (`ComputeServiceOptions.deletePerson`). */
	readonly deletePerson?: (userId: string) => Promise<void>;
	/**
	 * KANTEL_SECRETS_KEY: 32 bytes, base64, sealing environments' protected values and secret files. Without it, a
	 * Postgres store refuses them (a memory store seals with a key of its own, lost with the process).
	 */
	readonly secretsKey?: string;
	/** Image patching (KANTEL_IMAGE_PATCHING=experimental), from `computeConfig`; absent, off. */
	readonly imagePatching?: { readonly indexUrl: string };
	/** The base image index's fetch, for tests; default the global one. */
	readonly fetch?: typeof fetch;
	/**
	 * Mounts, bundles and signed file URLs (KANTEL_MOUNTS=experimental); absent, off. Bundles' tars are kept in
	 * `bundlesDir`, or in memory without one (gone with the process, though the API's records may outlast it).
	 */
	readonly mounts?: { readonly bundlesDir?: string };
	/** Emails an organisation's invites, with a link to join, where the deployment has mail (KANTEL_SMTP_URL). */
	readonly invites?: InviteMailing;
	/** Templates (KANTEL_TEMPLATES=experimental). Default off. */
	readonly templates?: boolean;
	/** Expiry of automatic snapshots (KANTEL_SNAPSHOT_EXPIRY=on). Default off. */
	readonly snapshotExpiry?: boolean;
	/** Sandboxes' live changes from the other replicas over the database (live-relay.ts); absent, this gateway's only. */
	readonly liveRelay?: LiveRelay;
}): Promise<GatewayCompute> {
	const store: ComputeStore = options.store ?? createMemoryStore();
	const records = options.store === undefined ? "memory" : "postgres";
	const hosts = options.hosts;
	const backend: SandboxBackend =
		hosts === undefined
			? createStubBackend()
			: createHostBackend({
					hosts: hosts.service,
					publicUrl: hosts.config.publicUrl,
					tickets: hosts.tickets,
					...(hosts.config.attributionKey === undefined ? {} : { attributionKey: hosts.config.attributionKey }),
					...(hosts.ports === undefined ? {} : { ports: hosts.ports }),
					...(options.now === undefined ? {} : { now: options.now }),
				});
	// The API mints and keeps join tokens; the registry spends them when a host registers.
	hosts?.service.useJoinTokens(joinTokenSpender(store));
	const publicUrl = hosts?.config.publicUrl ?? options.publicUrl;
	// One cached read of the index for the API and the hosts' welcome alike.
	const baseImages =
		options.imagePatching === undefined
			? undefined
			: baseImageIndexReader({
					url: options.imagePatching.indexUrl,
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					...(options.now === undefined ? {} : { now: options.now }),
				});
	const bundlesDir = options.mounts?.bundlesDir;
	const bundleStore =
		options.mounts === undefined
			? undefined
			: bundlesDir === undefined
				? createMemoryBundleStore()
				: createDirBundleStore(bundlesDir);
	const api = createComputeApi({
		store,
		backend,
		authenticatePerson: (request) => personOf(options.authenticator, options.identity, request),
		...(options.sessionLive === undefined ? {} : { sessionLive: options.sessionLive }),
		...(options.deletePerson === undefined ? {} : { deletePerson: options.deletePerson }),
		...(publicUrl === undefined ? {} : { publicUrl }),
		...(hosts?.config.joinCommand === undefined ? {} : { hostJoinCommand: hosts.config.joinCommand }),
		// With a ports domain, sandboxes' addresses are under it, and the console names them so.
		...(hosts?.config.portsDomain === undefined ? {} : { sandboxDomain: hosts.config.portsDomain }),
		...(hosts?.config.accountHosts === true ? { accountHosts: true } : {}),
		...(options.templates === true ? { templates: true } : {}),
		...(options.snapshotExpiry === true ? { snapshotExpiry: true } : {}),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.secretsKey === undefined ? {} : { secretsKey: options.secretsKey }),
		...(baseImages === undefined ? {} : { baseImages }),
		...(bundleStore === undefined ? {} : { mounts: { bundles: bundleStore } }),
		...(options.invites === undefined ? {} : { invites: options.invites }),
		...(options.liveRelay === undefined ? {} : { liveRelay: options.liveRelay }),
	});
	// Hosts fetch their sandboxes' protected values, bundles and bucket sources, and report what their egress proxies
	// did, their usage and how their mounts went, over their link. (With mounts off, the service answers nothing for
	// either source.)
	hosts?.service.useCompute({
		secrets: (hostId, sandboxId) => api.service.protectedTable(hostId, sandboxId),
		recordEgress: (hostId, records) => api.service.recordEgress(hostId, records),
		recordUsage: (hostId, usage, how) => api.service.recordUsage(hostId, usage, how),
		// Snapshot sizes always; the images and bases only with image patching on.
		...hostSnapshotLinks(api.service, baseImages),
		bundle: (hostId, sandboxId, digest) => api.service.bundleForHost(hostId, sandboxId, digest),
		// Relayed streams (SSH, the desktop and browser, hosted ports) are uses of their sandbox, for its idle stop.
		activity: (sandboxId) => api.service.noteActivity(sandboxId),
		bucketSource: (hostId, sandboxId, id) => api.service.bucketSourceForHost(hostId, sandboxId, id),
		reportMounts: (hostId, sandboxId, mounts, mountsAt) =>
			api.service.reportMounts(hostId, sandboxId, mounts, mountsAt),
		reportHealth: (hostId, sandboxId, health, reason, healthAt) =>
			api.service.reportHealth(hostId, sandboxId, health, reason, healthAt),
		// A microVM its host ended (its memory guard, an OOM kill, a crash) is in error, not left running.
		reportExit: (...report) => api.service.reportExit(...report),
		hostConnection: (...report) => api.service.reportHostConnection(...report),
	});
	// With several gateways, the one holding a host's connection passes its usage ticks on, so a poll on any has them.
	if (hosts !== undefined) hosts.cluster?.useUsage((hostId, usage) => hosts.service.recordSharedUsage(hostId, usage));
	const superAdminKey = await bootstrapSuperAdmin(api.store, options.superAdminKey, (options.now ?? Date.now)());
	api.dispatcher.start(WEBHOOK_INTERVAL_MS);
	api.exporter.start(TELEMETRY_INTERVAL_MS);
	if (hosts !== undefined) {
		hosts.bind(
			(grantee, sandboxId) => api.service.stillAllowed(grantee, sandboxId),
			(sandboxId) => api.service.portNotRunning(sandboxId),
		);
		hosts.access.start();
	}
	const sweepTickets = setInterval(
		() => void hosts?.tickets.sweep((options.now ?? Date.now)()).catch(() => undefined),
		TICKET_SWEEP_MS,
	);
	sweepTickets.unref();
	// The compute sweep runs on a timer too, not only as requests come: a host back after a drop gets the egress
	// updates it missed (and sandboxes due to stop are stopped) though nobody calls the API meanwhile.
	const sweepCompute = setInterval(() => void api.service.sweep().catch(() => undefined), COMPUTE_SWEEP_MS);
	sweepCompute.unref();
	let hostRoutes: GatewayCompute["hostRoutes"];
	if (hosts !== undefined) {
		// Registration, and its sandboxes' bundles (on its credential), only: the API serves the
		// operator's routes, so the registry's own admin routes refuse everyone.
		const register = createHostsApi({
			hosts: hosts.service,
			authorizeAdmin: () => Promise.reject(new KantelError("not_found", "Not found")),
			...(hosts.config.releaseToken === undefined ? {} : { releaseToken: hosts.config.releaseToken }),
		});
		const images = hosts.config.images === undefined ? undefined : hostImages(hosts.config.images);
		const desktops = createDesktopRoutes({
			tickets: hosts.tickets,
			allowed: (grant) => hosts.access.allowed(grant.grantee, grant.sandboxId),
			openPort: (sandboxId, port, sink) => hosts.service.sandboxes.openPort(sandboxId, port, sink),
			...(options.now === undefined ? {} : { now: options.now }),
		});
		hostRoutes = async (request) => {
			const path = new URL(request.url).pathname;
			if (path === HOSTS_REGISTER_PATH) return register.fetch(request);
			// The release workflow's (or a cron's) "a release is out", on the release token.
			if (path === HOSTS_RELEASE_CHECK_PATH) return register.fetch(request);
			// A bundle's tar for a sandbox the host runs, on the host's credential.
			if (path.startsWith(`${HOSTS_BUNDLES_PATH}/`)) return register.fetch(request);
			if (path.startsWith(`${CLUSTER_PATH}/`)) {
				return (await hosts.cluster?.peerRoutes(request)) ?? new Response("Not found", { status: 404 });
			}
			if (path.startsWith(`${HOST_IMAGES_PATH}/`)) {
				return (await images?.(request)) ?? new Response("Not found", { status: 404 });
			}
			// A desktop's page and Selkies' files, for a live desktop ticket whose holder still has access.
			if (path.startsWith(`${HOSTS_DESKTOP_PATH}/`)) return desktops.fetch(request);
			return undefined;
		};
	}
	return {
		api,
		superAdminKey,
		binding:
			`${records}, ${hosts === undefined ? "stub backend" : "kantel-host hosts"} (experimental)` +
			(bundleStore === undefined ? "" : `, mounts on with bundles in ${bundlesDir ?? "memory"} (experimental)`),
		...(hostRoutes === undefined ? {} : { hostRoutes }),
		...(hosts?.ports === undefined ? {} : { portRoutes: hosts.ports.fetch }),
		async close() {
			clearInterval(sweepTickets);
			clearInterval(sweepCompute);
			hosts?.access.stop();
			await api.close();
		},
	};
}

/** `GET /v1/hosts/tunnel/{ticket}[/{path}]`: a sandbox's port, as the ticket grants. */
const TUNNEL_PATH = new RegExp(`^${HOSTS_TUNNEL_PATH}/([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)(/.*)?$`);

/** What a relayed session is, for the log. */
function sessionKind(port: number, rest: string | undefined): string {
	if (port === SSH_PORT) return "ssh";
	if (port === BROWSER_PORT) return "cdp";
	return rest === undefined ? `tunnel ${port}` : `port ${port}`;
}

function bytesOf(data: unknown): Uint8Array {
	const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
	return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Hosts' connections and sandboxes' tunnels, then whatever served upgrades before.
 *
 * A tunnel is `/v1/hosts/tunnel/{ticket}`, a WebSocket of binary frames carrying the port's raw TCP (SSH through a
 * ProxyCommand), or `/v1/hosts/tunnel/{ticket}/{path}`, an HTTP upgrade passed through to the port with that path
 * (Chromium's DevTools WebSocket, for Playwright's `connectOverCDP`). A desktop's stream is
 * `/v1/hosts/desktop/{ticket}/api/websockets` (`@kantel/hosts/desktop`), which filters a view-only ticket's messages.
 *
 * Every tunnel, desktop and port WebSocket is held in `hosts.access` while open, and closed with 4003 once whoever was
 * given it loses access (`relay-access.ts`).
 */
export function withHostUpgrades(
	hosts: GatewayHostsBackend | undefined,
	next: UpgradeHandler | undefined,
	now: () => number = Date.now,
): UpgradeHandler | undefined {
	if (hosts === undefined) return next;
	const { service: compute, tickets, access } = hosts;
	const sockets = new WebSocketServer({ noServer: true, maxPayload: HOST_MAX_MESSAGE_BYTES });
	const desktops = createDesktopRoutes({
		tickets,
		allowed: (grant) => access.allowed(grant.grantee, grant.sandboxId),
		openPort: (sandboxId, port, sink) => compute.sandboxes.openPort(sandboxId, port, sink),
		now,
	});
	return (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
		const path = new URL(incoming.url ?? "/", "http://gateway").pathname;
		const refuse = (code: number, reason: string) =>
			sockets.handleUpgrade(incoming, socket, head, (accepted) => accepted.close(code, reason));
		if (hosts.ports !== undefined) {
			// An exposed port's name (a dev server's hot reload, an app's own WebSocket): only with its token, as its pages,
			// and its cookie only from the port's own pages or the same sandbox's (by Origin).
			const ports = hosts.ports;
			void (async () => {
				const port = await ports.upgrade(incoming.headers.host ?? "", incoming.url ?? "/", incoming.headers.cookie, {
					origin: incoming.headers.origin,
				});
				if (port === undefined) return gatewayUpgrade();
				if (!port.ok) return refuseUpgrade(incoming, socket, head, port.status, port.reason, sockets);
				const held = { sandboxId: port.sandboxId, kind: `port ${port.port}`, grantee: port.grantee };
				return passThrough(port.sandboxId, port.port, port.path, port.host, held);
			})().catch(() =>
				refuseUpgrade(incoming, socket, head, 502, "The gateway could not check the port's token", sockets),
			);
			return;
		}
		return gatewayUpgrade();

		/**
		 * An upgrade on the gateway's own name: a desktop's stream, a tunnel, a host's connection, or whatever served
		 * upgrades before.
		 */
		function gatewayUpgrade() {
			if (path.startsWith(`${HOSTS_DESKTOP_PATH}/`)) {
				void desktops.socket(incoming.url ?? "/").then(
					(target) => {
						// Refused too when the ticket's holder has lost access.
						if (target === undefined || target === "refused") {
							return refuse(HOST_CLOSE_REVOKED, "The desktop URL is wrong or has expired");
						}
						const held = sessionOf(target.grant, target.surface);
						return passThrough(target.sandboxId, target.port, target.path, undefined, held, target);
					},
					() => refuse(1011, "The gateway could not check the desktop URL"),
				);
				return;
			}
			const tunnel = TUNNEL_PATH.exec(path);
			if (tunnel?.[1] !== undefined) {
				const ticket = tunnel[1];
				const rest = tunnel[2];
				void (async () => {
					const grant = await tickets.verify(ticket, now());
					// A desktop's ticket opens only the desktop's route, where its mode is enforced.
					if (grant === undefined || grant.desktop !== undefined) {
						return refuse(HOST_CLOSE_REVOKED, "The tunnel URL is wrong or has expired");
					}
					if (!(await access.allowed(grant.grantee, grant.sandboxId))) {
						return refuse(RELAY_CLOSE_REVOKED, RELAY_REVOKED_REASON);
					}
					const held = sessionOf(grant, sessionKind(grant.port, rest));
					if (rest === undefined) return rawTunnel(grant.sandboxId, grant.port, held);
					return passThrough(grant.sandboxId, grant.port, rest, undefined, held);
				})().catch(() => refuse(1011, "The gateway could not check the tunnel URL"));
				return;
			}
			return hostConnection();
		}

		/** A relayed session, as `hosts.access` holds it. */
		function sessionOf(grant: IssuedGrant, kind: string) {
			return { sandboxId: grant.sandboxId, kind, grantee: grant.grantee };
		}

		/** Holds a session in `hosts.access` while it is open. */
		function hold(
			accepted: WebSocket,
			session: { sandboxId: string; kind: string; grantee: string | undefined },
			end: (reason: string) => void,
		) {
			const release = access.track({
				sandboxId: session.sandboxId,
				kind: session.kind,
				...(session.grantee === undefined ? {} : { grantee: session.grantee }),
				end,
			});
			accepted.on("close", () => release());
		}

		function hostConnection() {
			// Another replica's port stream, for a host connected here.
			if (hosts?.cluster?.peerUpgrade(incoming, socket, head, sockets)) return;
			if (path !== HOSTS_CONNECT_PATH) {
				if (next !== undefined) return next(incoming, socket, head);
				return refuseUpgrade(incoming, socket, head, 404, "Nothing upgrades at this path", sockets);
			}
			const credential = /^Bearer\s+(\S+)$/i.exec(incoming.headers.authorization ?? "")?.[1];
			if (incoming.method !== "GET" || credential === undefined)
				return refuse(HOST_CLOSE_REVOKED, "No host credential");
			void compute.authenticate(credential).then(
				(host) => {
					if (host === undefined) return refuse(HOST_CLOSE_REVOKED, "The host credential is unknown or revoked");
					sockets.handleUpgrade(incoming, socket, head, (accepted) => {
						// The bytes of binary frames sent but not yet written out, counted from each send's callback. Not the
						// socket's own `bufferedAmount`: under Bun, ws's never comes down again, so a file stream waiting on it
						// would stall for good once it had sent FILE_STREAM_BUFFER_BYTES.
						let unsent = 0;
						const held = compute.hub.accept(host.id, {
							sendText: (text) => accepted.send(text),
							sendBinary: (bytes) => {
								unsent += bytes.byteLength;
								accepted.send(bytes, { binary: true }, () => {
									unsent -= bytes.byteLength;
								});
							},
							close: (code, reason) => accepted.close(code, reason),
							// How far behind the socket is, so a file stream to the host waits rather than queues without end.
							bufferedAmount: () => unsent,
						});
						// The hub's receive closes a connection whose frame it can't handle; this catch is the last line, so
						// nothing a host sends (anyone's, with account hosts) escapes into the gateway process.
						accepted.on("message", (data, binary) => {
							try {
								if (binary) held.receive(bytesOf(data));
								else held.receive(data.toString());
							} catch (error) {
								console.error(`[hosts] host ${host.id}: a message couldn't be handled`, error);
								accepted.terminate();
							}
						});
						accepted.on("close", (code, reason) => held.closed(code, reason.toString()));
						accepted.on("error", () => accepted.terminate());
					});
				},
				// The registry is down: a plain close, so the host retries.
				() => refuse(1011, "The gateway could not check the credential"),
			);
		}

		/** The port's bytes as binary WebSocket frames. */
		function rawTunnel(
			sandboxId: string,
			port: number,
			session: { sandboxId: string; kind: string; grantee: string | undefined },
		) {
			sockets.handleUpgrade(incoming, socket, head, (accepted) => {
				hold(accepted, session, (reason) => accepted.close(RELAY_CLOSE_REVOKED, reason));
				const pending: Uint8Array[] = [];
				let stream: { write(bytes: Uint8Array): void; close(): void } | undefined;
				let done = false;
				accepted.on("message", (data) => {
					const chunk = bytesOf(data);
					if (stream === undefined) pending.push(chunk);
					else stream.write(chunk);
				});
				accepted.on("close", () => {
					done = true;
					stream?.close();
				});
				accepted.on("error", () => accepted.terminate());
				compute.sandboxes
					.openPort(sandboxId, port, {
						data: (bytes) => accepted.send(bytes, { binary: true }),
						// What the host says it ended or refused with is the host's: cut to fit and never thrown (`closeQuietly`).
						end: (reason) => closeQuietly(accepted, 1000, reason),
					})
					.then(
						(opened) => {
							stream = opened;
							if (done) return opened.close();
							for (const chunk of pending.splice(0)) opened.write(chunk);
						},
						(error: unknown) => closeQuietly(accepted, 1011, error instanceof Error ? error.message : String(error)),
					)
					.catch(() => closeQuietly(accepted, 1011, "The tunnel failed"));
			});
		}

		/**
		 * The client's WebSocket, passed message by message to a WebSocket at `path` on the port, which the gateway opens
		 * as a client on 127.0.0.1 (Chromium refuses DevTools to any other Host). Not raw bytes: Bun drops what is written
		 * to an upgrade's socket, so the client's side has to be `ws`'s. A desktop's `path` comes with its query, and its
		 * `accept` drops what a view-only client sends.
		 */
		function passThrough(
			sandboxId: string,
			port: number,
			rest: string,
			host: string | undefined,
			session: { sandboxId: string; kind: string; grantee: string | undefined },
			desktop?: DesktopSocket,
		) {
			// An exposed port's path comes with its query (less the token); a tunnel's takes the request's.
			const query =
				host === undefined && desktop === undefined ? new URL(incoming.url ?? "/", "http://gateway").search : "";
			const accept = desktop?.accept;
			sockets.handleUpgrade(incoming, socket, head, (accepted) => {
				hold(accepted, session, (reason) => {
					// The client hears why first; closing the port's side then ends it there too.
					accepted.close(RELAY_CLOSE_REVOKED, reason);
					inner.close();
				});
				const inner = openPortWebSocket(
					(sink) => compute.sandboxes.openPort(sandboxId, port, sink),
					port,
					`${rest}${query}`,
					{
						message: (data, binary) => accepted.send(data, { binary }),
						close: (code, reason) =>
							closeQuietly(
								accepted,
								code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011,
								reason,
							),
					},
					...(host === undefined ? [] : [host]),
				);
				accepted.on("message", (data, binary) => {
					const message = binary ? bytesOf(data) : data.toString();
					if (accept === undefined || accept(message, binary)) inner.send(message, binary);
				});
				accepted.on("close", () => inner.close());
				accepted.on("error", () => accepted.terminate());
			});
		}
	};
}
