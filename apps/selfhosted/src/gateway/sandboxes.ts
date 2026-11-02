// The gateway's sessions get coding tools on demand (#196), as on Cloudflare: a session on a workspace gets `read`,
// `write`, `edit`, `ls` and `bash` (those its profile names). The file tools work on the workspace directly, through
// the gateway's `Workspaces` (Postgres and S3 on the stack), as the session's agent, with no lease and no isolate.
// Only `bash` reaches a sandbox: `Sandboxes.run` leases the session's isolate (or container) on its first command
// there, never before, and the runtime's `sandbox` session-end teardown releases it on abort and close. Building a
// session's environment acquires nothing (`@kantel/sandbox/coding-tools`).
//
//   isolate tier    #94's just-bash shell in the gateway's own process, over the same workspaces (as Cloudflare's
//                   default `in-process` backend). A lease holds no state outside its workspace, so leases are kept in
//                   memory and one lost to a restart costs nothing: the next command acquires another.
//   container tier  with `containers` (KANTEL_SANDBOX_CONTAINERS, on in compose): the Docker backend
//                   (@kantel/selfhosted-sandbox, #126), one long-lived container per lease from the sandbox image
//                   (images/sandbox: git, node, python3, bun, pnpm, gh and the rest), over the Docker socket. A command
//                   goes there when the contract's table says so (`git`, `node`, `python3`, the rest of
//                   `DEFAULT_TIER_ROUTES`) or when it starts a program the isolate doesn't have (`make`, `unzip`, ...;
//                   `escalatingRouter`), and its changes are committed after every command (`checkpointContainer`), so
//                   the file tools, which read the workspace itself, see them. The runtime is `runsc` (gVisor) when the
//                   daemon has it registered and `runc` otherwise (`KANTEL_SANDBOX_RUNTIME`, default `auto`). With
//                   the vault proxy (KANTEL_VAULT_PROXY_URL), each lease's container gets an internal network of its
//                   own whose only other member is the proxy, so its way out is the vault's policy, with a token the
//                   proxy resolves to the session (`harbour.sandbox_tokens`, the table the session hosts' tokens are
//                   in). Without the proxy it has no network at all, as on Cloudflare. Without `containers`, a command
//                   routed to the container is refused `unavailable`.
//
// The runtime is built before the workspaces and sandboxes (they need its project access), so its options reach them
// late: a session the runtime resumes as it starts has its tools, and they find the sandboxes when a command runs.
import type { AuditSink, CallContext, Clock, LeaseEndReason, ProjectAccess, SystemContext } from "@kantel/contracts";
import { KantelError } from "@kantel/contracts";
import type { SessionRuntimeOptions } from "@kantel/runtime/core";
import { noContainers, sessionCodingTools, sessionEnvironments } from "@kantel/sandbox/coding-tools";
import type { IsolateEgress } from "@kantel/sandbox/egress";
import { createInProcessIsolateBackend, escalatingRouter, isolatePrograms } from "@kantel/sandbox/isolate";
import {
	type ContainerBackend,
	createMemoryLeaseStore,
	createTieredSandboxes,
	type TieredSandboxes,
} from "@kantel/sandbox/tiered";
import {
	createDockerContainerBackend,
	DEFAULT_DOCKER_SOCKET,
	DockerClient,
	type DockerContainerBackendOptions,
	type ProxyCredentials,
} from "@kantel/selfhosted-sandbox";
import type { SqlDriver } from "@kantel/sql";
import type { StoredWorkspaces } from "@kantel/workspace/stored";

const NO_CONTAINERS =
	"This gateway has no container tier, and this command needs it (KANTEL_SANDBOX_IMAGE turns it on, as " +
	"deploy/compose/compose.yaml does)";

const ISOLATE_BINDING = "in-process isolate (just-bash), leased on first bash";

/** What `/v1/deployment` says backs the sandboxes when there is no container tier. */
export const SANDBOX_BINDING = `${ISOLATE_BINDING}; no container tier`;

/** How often the janitor removes containers a previous gateway process left behind. */
const JANITOR_INTERVAL_MS = 5 * 60_000;
/** How long a lease's proxy token is good for. A lease lives 15 minutes unless renewed; its end revokes the token. */
const TOKEN_TTL_HOURS = 24;
const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_NANO_CPUS = 2_000_000_000;

/** The container tier's settings, from the environment (`containerTierConfig`). */
export interface ContainerTierConfig {
	readonly socketPath: string;
	readonly image: string;
	/** A Docker runtime's name, or `auto`: `runsc` when the daemon has it registered, `runc` otherwise. */
	readonly runtime: string;
	/** Prefix of every label the tier sets and its janitor filters on: one per deployment on a daemon. */
	readonly labelPrefix: string;
	readonly memoryBytes: number;
	readonly nanoCpus: number;
	/** The vault proxy, each lease's only way out. Absent: no network at all. */
	readonly network?: {
		/** Name prefix of each lease's own internal network. */
		readonly name: string;
		/** Such as http://vault-proxy:3128: the proxy by the host name sandboxes reach it at. */
		readonly proxyUrl: string;
		/** The proxy's container, which joins each lease's network. */
		readonly proxyContainer: string;
		/** An IPv4 range each lease's network takes a /28 of; absent, Docker's default pools. */
		readonly subnetPool?: string;
	};
}

/**
 * The container tier's settings, or undefined when it is off. `KANTEL_SANDBOX_CONTAINERS` is `docker` or `off`; unset,
 * the tier is on when `KANTEL_SANDBOX_IMAGE` names the image, as compose does.
 *
 *   KANTEL_SANDBOX_IMAGE          the sandbox image (images/sandbox), such as harbour-sandbox:dev
 *   KANTEL_SANDBOX_RUNTIME        `auto` (default): runsc when the daemon has it, else runc; or a runtime's name
 *   KANTEL_DOCKER_SOCKET          the daemon's socket in the gateway's container; default /var/run/docker.sock
 *   KANTEL_SANDBOX_LABEL_PREFIX   default `kantel`; one per deployment sharing a daemon
 *   KANTEL_SANDBOX_MEMORY_BYTES   per container; default 2 GiB
 *   KANTEL_SANDBOX_NANO_CPUS      per container; default 2 CPUs (2000000000)
 *   KANTEL_VAULT_PROXY_URL        the vault proxy; unset, containers have no network
 *   KANTEL_VAULT_CONTAINER        the proxy's container; default the proxy URL's host
 *   KANTEL_SANDBOX_NETWORK        name prefix of each lease's network; default kantel-sbx
 *   KANTEL_SANDBOX_SUBNET_POOL    an IPv4 range for those networks, such as 10.251.0.0/16
 */
export function containerTierConfig(env: NodeJS.ProcessEnv): ContainerTierConfig | undefined {
	const switched = env.KANTEL_SANDBOX_CONTAINERS?.trim().toLowerCase() ?? "";
	const image = env.KANTEL_SANDBOX_IMAGE?.trim() ?? "";
	if (switched === "off") return undefined;
	if (switched !== "" && switched !== "docker") throw new Error("KANTEL_SANDBOX_CONTAINERS must be docker or off");
	if (image === "") {
		if (switched === "docker") throw new Error("KANTEL_SANDBOX_CONTAINERS=docker needs KANTEL_SANDBOX_IMAGE");
		return undefined;
	}
	const positive = (name: string, fallback: number) => {
		const value = env[name]?.trim() ?? "";
		if (value === "") return fallback;
		const number = Number(value);
		if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive whole number`);
		return number;
	};
	const proxyUrl = env.KANTEL_VAULT_PROXY_URL?.trim() ?? "";
	let network: ContainerTierConfig["network"];
	if (proxyUrl !== "") {
		let host: string;
		try {
			host = new URL(proxyUrl).hostname;
		} catch {
			throw new Error("KANTEL_VAULT_PROXY_URL must be a URL, such as http://vault-proxy:3128");
		}
		const subnetPool = env.KANTEL_SANDBOX_SUBNET_POOL?.trim() ?? "";
		network = {
			name: env.KANTEL_SANDBOX_NETWORK?.trim() || "kantel-sbx",
			proxyUrl,
			proxyContainer: env.KANTEL_VAULT_CONTAINER?.trim() || host,
			...(subnetPool === "" ? {} : { subnetPool }),
		};
	}
	return {
		socketPath: env.KANTEL_DOCKER_SOCKET?.trim() || DEFAULT_DOCKER_SOCKET,
		image,
		runtime: env.KANTEL_SANDBOX_RUNTIME?.trim() || "auto",
		labelPrefix: env.KANTEL_SANDBOX_LABEL_PREFIX?.trim() || "kantel",
		memoryBytes: positive("KANTEL_SANDBOX_MEMORY_BYTES", DEFAULT_MEMORY_BYTES),
		nanoCpus: positive("KANTEL_SANDBOX_NANO_CPUS", DEFAULT_NANO_CPUS),
		...(network === undefined ? {} : { network }),
	};
}

/** The part of Docker's `GET /info` the tier reads. */
export interface DockerInfo {
	readonly Runtimes?: { readonly [name: string]: unknown };
}

/** What `auto` means on a daemon with these runtimes: gVisor's `runsc` when it is registered, else `runc`. */
export function autoRuntime(info: DockerInfo): string {
	return Object.hasOwn(info.Runtimes ?? {}, "runsc") ? "runsc" : "runc";
}

/** The gateway's container tier, ready to build over its workspaces. */
export interface GatewayContainers {
	/** What `/v1/deployment` says backs the sandboxes with it. */
	readonly binding: string;
	/** The backend over the gateway's workspaces; built once, at `attach`. */
	backend(workspaces: StoredWorkspaces): GatewayContainerBackend;
}

/** A container backend, with the janitor and shutdown the gateway runs it with. */
export interface GatewayContainerBackend extends ContainerBackend {
	/** Removes what a previous gateway process left behind (`DockerContainerBackend.reapExpired`). */
	reapExpired?(): Promise<number>;
	close?(): Promise<void>;
}

export interface PrepareContainerTierOptions {
	/** Where the lease tokens go that the vault proxy resolves to sessions: the stack's Postgres. Absent: no tokens. */
	readonly tokens?: SqlDriver;
	/** Docker's `GET /info`; default the daemon's on `config.socketPath`. */
	readonly info?: () => Promise<DockerInfo>;
	/** Builds the backend; default the Docker one. */
	readonly create?: (options: DockerContainerBackendOptions) => GatewayContainerBackend;
	readonly log?: (message: string) => void;
}

/**
 * Asks the daemon which runtimes it has (for `auto`), checks the proxy's token table is there, and returns the tier.
 * A daemon that doesn't answer (no socket mounted, say) gives a tier that refuses every command `unavailable`, saying
 * why, rather than a gateway that won't start: sessions still have the isolate.
 */
export async function prepareContainerTier(
	config: ContainerTierConfig,
	options: PrepareContainerTierOptions = {},
): Promise<GatewayContainers> {
	const log = options.log ?? ((message: string) => console.error(message));
	let info: DockerInfo;
	try {
		info = await (options.info ?? (() => dockerInfo(config.socketPath)))();
	} catch (error) {
		const reason = `the Docker daemon at ${config.socketPath} did not answer (${error instanceof Error ? error.message : String(error)})`;
		log(`[gateway] no container tier: ${reason}`);
		const message = `This command needs the container tier, which isn't available: ${reason}`;
		return {
			binding: `${ISOLATE_BINDING}; container tier unavailable: ${reason}`,
			backend: () => noContainers(message),
		};
	}
	const runtime = config.runtime === "auto" ? autoRuntime(info) : config.runtime;
	if (!Object.hasOwn(info.Runtimes ?? {}, runtime)) {
		log(`[gateway] the Docker daemon has no runtime ${runtime}: container commands fail until it is registered`);
	}
	const tokens = options.tokens === undefined ? undefined : await tokenTable(options.tokens, log);
	const credentials = config.network === undefined || tokens === undefined ? undefined : proxyTokens(tokens);
	const egress =
		config.network === undefined
			? "no network"
			: `egress through the vault proxy (${config.network.proxyContainer})${credentials === undefined ? ", no session tokens" : ""}`;
	const binding =
		`${ISOLATE_BINDING}; Docker container tier (${runtime}${config.runtime === "auto" ? ", auto" : ""}), ` +
		`one container per lease from ${config.image}, ${egress}`;
	log(`[gateway] container tier: ${binding}`);
	const create = options.create ?? createDockerContainerBackend;
	const network = config.network;
	return {
		binding,
		backend: (workspaces) =>
			create({
				workspaces,
				socketPath: config.socketPath,
				image: config.image,
				runtime,
				memoryBytes: config.memoryBytes,
				nanoCpus: config.nanoCpus,
				labelPrefix: config.labelPrefix,
				...(network === undefined
					? {}
					: {
							network: {
								name: network.name,
								proxyUrl: network.proxyUrl,
								isolation: "per-lease",
								proxyContainer: network.proxyContainer,
								...(network.subnetPool === undefined ? {} : { subnetPool: network.subnetPool }),
							},
						}),
				...(credentials === undefined ? {} : { proxyCredentials: credentials }),
			}),
	};
}

async function dockerInfo(socketPath: string): Promise<DockerInfo> {
	const docker = new DockerClient({ socketPath, requestTimeoutMs: 5_000 });
	try {
		return await docker.json<DockerInfo>({ method: "GET", path: "/info" });
	} finally {
		docker.close();
	}
}

/** The proxy's token table, when it is there: the session hosts' migrations (`host-migrate` in compose) make it. */
async function tokenTable(driver: SqlDriver, log: (message: string) => void): Promise<SqlDriver | undefined> {
	const [row] = await driver.query<{ found: string | null }>(
		"SELECT to_regclass('harbour.sandbox_tokens')::text AS found",
	);
	if (typeof row?.found === "string") return driver;
	log("[gateway] harbour.sandbox_tokens is missing: container requests reach the vault proxy with no session token");
	return undefined;
}

/**
 * Lease tokens in `harbour.sandbox_tokens`, which the vault proxy resolves to the session (`callerOf` in
 * apps/vault-proxy). A token starts with its lease's ID, so `revoke` finds every token of the lease, a restarted
 * gateway's janitor included, with nothing else to remember.
 */
export function proxyTokens(driver: SqlDriver): ProxyCredentials {
	return {
		async issue({ lease }) {
			const token = `${lease.id}.${crypto.randomUUID().replaceAll("-", "")}`;
			await driver.query(
				`INSERT INTO harbour.sandbox_tokens (token, session_id, tier, expires_at)
				 VALUES (?, ?, 'container', now() + interval '${TOKEN_TTL_HOURS} hours')`,
				[token, lease.sessionId],
			);
			return token;
		},
		async revoke(leaseId) {
			await driver.query("DELETE FROM harbour.sandbox_tokens WHERE starts_with(token, ?)", [`${leaseId}.`]);
		},
	};
}

export interface GatewaySandboxes {
	/** The runtime's coding tools, their environment and the sandbox teardown and sweep. */
	readonly runtimeOptions: Pick<SessionRuntimeOptions, "tools" | "environment" | "sandboxes">;
	/** What `/v1/deployment` says backs the sandboxes. */
	readonly binding: string;
	/** Builds the sandboxes over the gateway's workspaces, once the runtime's project access exists. */
	attach(options: {
		readonly workspaces: StoredWorkspaces;
		readonly access: ProjectAccess;
		readonly audit: AuditSink;
		readonly clock?: Clock;
		/** The isolate's way out (#331): the connections egress gate. Absent: full internet and no credentials. */
		readonly egress?: IsolateEgress;
	}): TieredSandboxes;
	/** Stops the container janitor and closes the container tier's Docker connections. */
	close(): Promise<void>;
}

export function createGatewaySandboxes(options: { readonly containers?: GatewayContainers } = {}): GatewaySandboxes {
	let sandboxes: TieredSandboxes | undefined;
	let workspaces: StoredWorkspaces | undefined;
	let container: GatewayContainerBackend | undefined;
	let janitor: ReturnType<typeof setInterval> | undefined;
	const ready = <T>(value: T | undefined): T => {
		if (value === undefined) throw new KantelError("unavailable", "The gateway's sandboxes are not ready");
		return value;
	};
	const reap = () => {
		container
			?.reapExpired?.()
			.then((removed) => {
				if (removed > 0) console.error(`[gateway] removed ${removed} sandbox container(s) left behind`);
			})
			.catch((error: unknown) => console.error(`[gateway] the sandbox janitor failed: ${String(error)}`));
	};
	return {
		binding: options.containers?.binding ?? SANDBOX_BINDING,
		runtimeOptions: {
			tools: sessionCodingTools(),
			environment: sessionEnvironments({
				sandboxes: () => ready(sandboxes),
				workspaces: () => ready(workspaces),
			}),
			sandboxes: {
				// A session can end before the sandboxes exist (resumed and aborted as the gateway starts): it holds no lease.
				releaseSession: (ctx: CallContext, sessionId: string, reason?: LeaseEndReason) =>
					sandboxes === undefined ? Promise.resolve() : sandboxes.releaseSession(ctx, sessionId, reason),
				sweep: async (ctx: SystemContext) => (sandboxes === undefined ? [] : sandboxes.sweep(ctx)),
			},
		},
		attach(attached) {
			if (sandboxes !== undefined) throw new Error("the gateway's sandboxes are already attached");
			workspaces = attached.workspaces;
			container = options.containers?.backend(attached.workspaces);
			sandboxes = createTieredSandboxes({
				workspaces: attached.workspaces,
				isolate: createInProcessIsolateBackend(
					attached.workspaces,
					attached.egress === undefined ? {} : { egress: attached.egress },
				),
				container: container ?? noContainers(NO_CONTAINERS),
				leases: createMemoryLeaseStore(),
				audit: attached.audit,
				access: attached.access,
				...(attached.clock === undefined ? {} : { clock: attached.clock }),
				// With a container to escalate to, a command the isolate can't run goes there instead of failing, and its
				// changes are committed after it, so the file tools see them (as on Cloudflare).
				...(container === undefined ? {} : { router: escalatingRouter(isolatePrograms()), checkpointContainer: true }),
			});
			if (container?.reapExpired !== undefined) {
				reap();
				janitor = setInterval(reap, JANITOR_INTERVAL_MS);
				janitor.unref?.();
			}
			return sandboxes;
		},
		async close() {
			if (janitor !== undefined) clearInterval(janitor);
			janitor = undefined;
			await container?.close?.();
		},
	};
}
