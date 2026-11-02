/**
 * Connections on the self-hosted gateway (epic #322): records in the gateway's store (Postgres, or memory), secrets in
 * its vault (`connectionSecret`), and every request a session makes through one sent from the gateway process, with
 * the credential added there, never in the sandbox.
 *
 * On with `KANTEL_PUBLIC_URL` (redirect URIs and connect URLs are built from it) and a vault; off with
 * `KANTEL_CONNECTIONS=off`. `KANTEL_CONNECTIONS_CIMD=on` once `/v1/connections/oauth/client-metadata.json` is
 * reachable from the internet without signing in; `KANTEL_CONNECTIONS_PERSONAL=on` for a deployment with one person.
 * A rule's `ask` waits on an approval of the exact request (#333), kept in the gateway's vault (`connectionApproval`).
 * `KANTEL_OAUTH_CLIENTS` lists the deployment's own OAuth clients (#326) as JSON, each confidential one's secret in the
 * environment variable its `secretEnv` names (see `parsePlatformClients`); a bad entry is logged and left out.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
	type ConnectionsService,
	createConnections,
	type Fetch,
	type PlatformOAuthClient,
	parsePlatformClients,
} from "@kantel/connections";
import type { ConnectionsRepository } from "@kantel/connections/repository";
import { vaultCeiling } from "@kantel/connections/rules";
import { connectionTools } from "@kantel/connections/tools";
import { vaultCredentials } from "@kantel/connections/vault-store";
import type { AuditSink, ProjectAccess, SessionDirectory, SessionRecord } from "@kantel/contracts";
import { KantelError, systemContext } from "@kantel/contracts";
import type { SessionRuntimeOptions } from "@kantel/runtime/core";
import type { KantelVault } from "@kantel/vault/engine";

export interface GatewayConnectionsConfig {
	/** The public origin people reach the console at. */
	readonly origin: string;
	readonly clientMetadataPublic: boolean;
	readonly personal: boolean;
	/** The deployment's own OAuth clients, from `KANTEL_OAUTH_CLIENTS`. Absent when there are none. */
	readonly platformClients?: readonly PlatformOAuthClient[];
}

/** Connections' configuration from the environment, or undefined when they are off. */
export function connectionsConfig(
	env: NodeJS.ProcessEnv,
	publicOrigin: string | undefined,
): GatewayConnectionsConfig | undefined {
	const flag = (name: string) => env[name]?.trim().toLowerCase() ?? "";
	if (flag("KANTEL_CONNECTIONS") === "off" || publicOrigin === undefined) return undefined;
	const platform = parsePlatformClients(env.KANTEL_OAUTH_CLIENTS, (name) => env[name]);
	for (const problem of platform.problems) console.warn(`kantel: ${problem}`);
	return {
		origin: publicOrigin,
		clientMetadataPublic: flag("KANTEL_CONNECTIONS_CIMD") === "on",
		personal: flag("KANTEL_CONNECTIONS_PERSONAL") === "on",
		...(platform.clients.length === 0 ? {} : { platformClients: platform.clients }),
	};
}

const PRIVATE = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 3],
] as const) {
	PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** Whether `address` is loopback, private, link-local, shared, multicast or otherwise not on the internet. */
export function privateAddress(address: string): boolean {
	// An IPv4-mapped address is its IPv4 address. (BlockList's own ::ffff:0:0/96 would match every IPv4 address.)
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	if (mapped !== undefined) return privateAddress(mapped);
	if (/^::ffff:/i.test(address)) return true;
	const family = isIP(address);
	if (family === 0) return true;
	return PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * A fetch that only reaches the internet: the gateway sits next to the database, the vault and the session hosts, and a
 * connection's URL is someone's say-so, so every name is looked up first and refused if any address is private. (A
 * name that changes between the look-up and the connection is the egress firewall's to stop; this stops the plain case.)
 */
export function publicFetch(inner: Fetch = (input, init) => globalThis.fetch(input, init)): Fetch {
	return async (input, init) => {
		const url = new URL(input);
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const addresses = isIP(host) === 0 ? (await lookup(host, { all: true })).map((found) => found.address) : [host];
		if (addresses.length === 0 || addresses.some(privateAddress)) {
			throw new KantelError("invalid", `${url.hostname} is not on the internet`);
		}
		return await inner(input, init);
	};
}

/** How often a gateway sweeps for tokens to refresh (#328): well inside the five-minute buffer before they expire. */
export const DEFAULT_SWEEP_MS = 60_000;

export interface RefreshSweeper {
	close(): Promise<void>;
}

/**
 * Runs the refresh sweep (#328) every `everyMs`, the first after a random part of it so gateways started together don't
 * sweep in step. A sweep still running when the next is due is left to finish rather than queued behind; a failed one
 * is logged once until one works again. The timer never keeps the process alive.
 */
export function refreshSweeper(
	service: Pick<ConnectionsService, "sweep">,
	everyMs: number,
	log: (line: string) => void,
): RefreshSweeper {
	const system = systemContext("connections-sweep");
	let failing = false;
	let running: Promise<void> | undefined;
	const start = () => {
		if (running !== undefined) return;
		running = service
			.sweep(system)
			.then((swept) => {
				if (failing) log("[gateway] connections: the refresh sweep works again");
				failing = false;
				if (swept.failed > 0) log(`[gateway] connections: ${swept.failed} token refresh(es) failed in the sweep`);
			})
			.catch((error: unknown) => {
				if (!failing) log(`[gateway] connections: the refresh sweep failed, will retry: ${String(error)}`);
				failing = true;
			})
			.finally(() => {
				running = undefined;
			});
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	const first = setTimeout(
		() => {
			start();
			timer = setInterval(start, everyMs);
			timer.unref?.();
		},
		Math.floor(Math.random() * everyMs),
	);
	first.unref?.();
	return {
		async close() {
			clearTimeout(first);
			if (timer !== undefined) clearInterval(timer);
			await running;
		},
	};
}

/**
 * The connections service once the vault exists (it is built after the runtime), and the session tools, which ask for
 * it per call. Without a vault there is no service and the tools are not offered.
 */
export function gatewayConnections(options: {
	readonly config: GatewayConnectionsConfig;
	readonly repository: ConnectionsRepository;
	readonly audit: AuditSink;
	readonly access: () => ProjectAccess;
	/** Default `publicFetch()`. */
	readonly fetch?: Fetch;
	/**
	 * How often this process runs the refresh sweep (#328), in ms; 0 for never. Default a minute. Every gateway over one
	 * database runs it; their refresh leases keep them from refreshing a connection twice.
	 */
	readonly sweepMs?: number;
	readonly log?: (line: string) => void;
}) {
	let service: ConnectionsService | undefined;
	let sweeper: RefreshSweeper | undefined;
	let tools: ((record: SessionRecord) => ReturnType<ReturnType<typeof connectionTools>>) | undefined;
	return {
		/** Builds the service over the vault. Call once, after the vault is made. */
		attach(vault: KantelVault, sessions?: Pick<SessionDirectory, "get">): ConnectionsService {
			service = createConnections({
				// Which connections a session may pick (#335).
				...(sessions === undefined ? {} : { sessions }),
				repository: options.repository,
				credentials: vaultCredentials(vault),
				// One ceiling per organisation, the vault's, bounds both its grants and connection rules (#332).
				ceiling: vaultCeiling(() => vault),
				// Approvals bound to the exact request (#333): a rule's ask is frozen and decided in the same vault.
				approvals: vault,
				deployment: {
					origin: options.config.origin,
					clientMetadataPublic: options.config.clientMetadataPublic,
					personal: options.config.personal,
					...(options.config.platformClients === undefined ? {} : { platformClients: options.config.platformClients }),
				},
				access: options.access,
				audit: options.audit,
				fetch: options.fetch ?? publicFetch(),
			});
			const every = options.sweepMs ?? DEFAULT_SWEEP_MS;
			if (every > 0) sweeper = refreshSweeper(service, every, options.log ?? ((line) => console.warn(line)));
			tools = connectionTools({
				connections: service,
				personal: options.config.personal,
				// Who can see the session now, read on every call, so a change takes effect at once (#335).
				...(sessions === undefined
					? {}
					: {
							current: (record: SessionRecord) =>
								sessions.get(
									{ actor: { kind: "system", component: "connections" }, organisationId: record.organisationId },
									record.id,
								),
						}),
			});
			return service;
		},
		/** Stops the refresh sweep, letting a sweep under way finish. */
		async close(): Promise<void> {
			await sweeper?.close();
		},
		/** The runtime's `tools`, with the connection tools added once the service is attached. */
		withTools(inner: SessionRuntimeOptions["tools"]): SessionRuntimeOptions["tools"] {
			return async (record: SessionRecord) => [...((await inner?.(record)) ?? []), ...(tools?.(record) ?? [])];
		},
	};
}
