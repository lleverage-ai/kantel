/**
 * The protocol between Kantel and `kantel-host`, the agent on a machine that runs sandboxes. The Go side is
 * apps/host/internal/proto/proto.go; keep the two in step.
 *
 * A host registers once (`POST /v1/hosts/register` with a one-time join token, `kth_…`) and gets a host credential
 * (`khc_…`), stored hashed. It then keeps one WebSocket open to `GET /v1/hosts/connect` with
 * `Authorization: Bearer khc_…`, dialling out, so a host needs no inbound port.
 *
 * Text frames are JSON `HostMessage`s. Binary frames carry port streams: 4 bytes of stream ID (big-endian), then the
 * payload; an empty payload closes that direction.
 *
 * Calls go both ways. Kantel calls the host (`HostMethods`); the host calls Kantel only for `secrets.fetch`, with IDs
 * starting `h` so they never clash with Kantel's, and Kantel answers for a sandbox on that host alone. Every addition
 * since version 1 is optional, so the version stays 1.
 */

/** Bumped on any incompatible change; Kantel refuses a host whose version it doesn't speak. */
export const HOST_PROTOCOL_VERSION = 1;

/** The host's credential was revoked or is unknown: the host stops, and doesn't reconnect. */
export const HOST_CLOSE_REVOKED = 4003;
/** A newer connection for the same host took over. */
export const HOST_CLOSE_REPLACED = 4008;
/** The host spoke out of turn, or a version Kantel doesn't speak. */
export const HOST_CLOSE_PROTOCOL = 4002;

export const HOST_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export type HostErrorCode =
	| "not_found"
	| "invalid"
	| "conflict"
	| "capacity"
	| "unavailable"
	| "internal"
	| "unsupported"
	| "timeout";

export interface HostError {
	readonly code: HostErrorCode | string;
	readonly message: string;
}

export type SandboxTier = "microvm" | "isolate";

export interface HostSize {
	readonly name: string;
	readonly vcpus: number;
	readonly memoryMiB: number;
	readonly diskGiB: number;
}

/** What a host is: it changes only with its hardware or software. */
export interface HostFacts {
	readonly version: string;
	readonly protocol: number;
	readonly os: string;
	readonly arch: string;
	readonly kernel: string;
	readonly hostname: string;
	readonly cpus: number;
	/** What the host offers sandboxes, not the whole machine. */
	readonly memoryMiB: number;
	readonly diskGiB: number;
	readonly kvm: boolean;
	/** Whether sandboxes get /dev/kvm. */
	readonly nested: boolean;
	readonly tiers: readonly SandboxTier[];
	readonly sizes: readonly HostSize[];
	readonly labels?: { readonly [key: string]: string };
	/** `open` (NAT), `proxy` (only through the host's egress proxy) or `none`. */
	readonly egress: string;
	/**
	 * What the host can do beyond protocol 1 as first released (`HOST_FEATURES`). An addition a host must enforce, not
	 * merely accept, is gated on one: a host that predates it would ignore the field and report success.
	 */
	readonly features?: readonly string[];
}

/** Features a host may report in its facts. */
export const HOST_FEATURES = {
	/**
	 * Egress `grants` and `protected` variables: the proxy enforces the grants (methods and paths too), swaps placeholders
	 * only where bound, refuses older `revision`s, and a fork takes its `env`.
	 */
	egressPolicy: "egress-policy",
} as const;

/** Whether an egress needs the `egress-policy` feature to be enforced: it has grants or protected variables. */
export function needsEgressPolicy(egress: HostEgress | null | undefined): boolean {
	return (
		egress !== undefined && egress !== null && (egress.protected !== undefined || (egress.grants?.length ?? 0) > 0)
	);
}

/** What is free on a host now. */
export interface HostCapacity {
	readonly freeMemoryMiB: number;
	readonly freeDiskGiB: number;
	readonly running: number;
	readonly stopped: number;
	readonly load1: number;
	/** Pre-warmed sandboxes ready, by `<tier>/<pool>`. */
	readonly warm: { readonly [pool: string]: number };
}

export type SandboxState = "starting" | "running" | "stopping" | "stopped" | "error" | "deleted";

/** A sandbox as its host sees it. */
export interface HostSandbox {
	readonly id: string;
	readonly tier: SandboxTier;
	readonly size: string;
	readonly state: SandboxState;
	readonly address?: string;
	/** A stopped sandbox kept its memory, so a resume continues its processes. */
	readonly memory?: boolean;
	readonly error?: string;
	readonly createdAt: number;
	/** The operation's timings in milliseconds, by step. */
	readonly timings?: { readonly [step: string]: number };
	/** How a create was served: `pool`, `snapshot` or `boot`. */
	readonly source?: string;
}

export interface HostSnapshot {
	readonly id: string;
	readonly sandboxId: string;
	readonly kind: "auto" | "saved";
	readonly name?: string;
	readonly createdAt: number;
	readonly sizeBytes: number;
	readonly memory: boolean;
	readonly tier: SandboxTier;
}

/** A sandbox's way out, sent with create, resume and fork. The host holds the token; the sandbox never sees it. */
export interface HostEgress {
	readonly mode?: "open" | "proxy" | "none";
	/** The proxy the host's egress proxy chains to, such as Kantel's vault proxy. */
	readonly upstream?: string;
	readonly token?: string;
	readonly caCert?: string;
	readonly attributionKey?: string;
	/** Headers for the upstream on every request (an account's upstream settings). Kantel-* ones are the host's. */
	readonly headers?: { readonly [name: string]: string };
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
	readonly defaultDeny?: boolean;
	/**
	 * Present only when the sandbox has protected variables: the hosts their bindings name (patterns, never a value),
	 * which the host intercepts with a CA of the sandbox's own, and the version of its protected values, which the host
	 * fetches with `secrets.fetch`.
	 */
	readonly protected?: HostEgressProtected;
	/** The environment's grants, then the sandbox's own, on top of `allow` and `deny`; deny wins. */
	readonly grants?: readonly HostEgressGrant[];
	/**
	 * Orders the control plane's egress for a sandbox (its `egressRevision`): the host ignores a `sandbox.egress` older
	 * than the egress it has, which was read before a later change. Absent: unordered, always taken.
	 */
	readonly revision?: number;
}

export interface HostEgressProtected {
	readonly version: number;
	readonly intercept: readonly string[];
}

/** An egress grant; one naming methods or paths makes its host intercepted. */
export interface HostEgressGrant {
	readonly action: "allow" | "deny";
	readonly host: string;
	readonly methods?: readonly string[];
	/** Glob patterns: `*` one segment, `**` the rest. */
	readonly paths?: readonly string[];
	/** The rule as the egress log names it, such as `deny DELETE api.github.com /repos/*`. */
	readonly rule: string;
}

/** Where a protected value may go: port 443 of `host`, under these path prefixes, by these methods (empty: any). */
export interface HostSecretBinding {
	readonly host: string;
	readonly pathPrefixes?: readonly string[];
	readonly methods?: readonly string[];
}

export interface HostSecretEntry {
	readonly placeholder: string;
	readonly name: string;
	readonly value: string;
	readonly bindings: readonly HostSecretBinding[];
}

/** The result of a host's `secrets.fetch` `{ sandboxId }`: the sandbox's protected values, in host memory only. */
export interface HostSecrets {
	readonly version: number;
	readonly entries: readonly HostSecretEntry[];
}

/** One request or connection a host's egress proxy handled, in an `egress` event. Never a value or a query string. */
export interface HostEgressRecord {
	/** Milliseconds since the epoch. */
	readonly at: number;
	readonly sandboxId: string;
	/** `CONNECT` for a tunnel the proxy didn't look inside. */
	readonly method: string;
	readonly host: string;
	readonly port: number;
	readonly path?: string;
	readonly allowed: boolean;
	readonly reason?: string;
	readonly rule?: string;
	/** The `X-Kantel-Proxy-Error` code of a refusal. */
	readonly code?: string;
	/** The protected variables swapped in, by name. */
	readonly swapped: readonly string[];
	readonly inspected: boolean;
	readonly status?: number;
	readonly bytesUp: number;
	readonly bytesDown: number;
}

export interface HostHello {
	readonly hostId: string;
	readonly facts: HostFacts;
	readonly sandboxes: readonly HostSandbox[];
	readonly capacity: HostCapacity;
}

export interface HostWelcome {
	readonly hostId: string;
	readonly heartbeatSeconds: number;
	readonly desiredVersion?: string;
	/** With `{version}`, `{os}` and `{arch}` for the host to fill in. */
	readonly updateUrl?: string;
	/** Pre-warmed sandboxes wanted, by `<tier>/<pool>`, such as `{"microvm/default": 2}`. */
	readonly pools?: { readonly [pool: string]: number };
	readonly draining?: boolean;
}

export interface HostEvent {
	readonly kind: string;
	readonly sandbox?: HostSandbox;
	/** Base64, for `exec.output`. */
	readonly stdout?: string;
	readonly stderr?: string;
	readonly at: number;
	/** For `egress`: a batch, at most 100 records or 2 seconds' worth. */
	readonly egress?: readonly HostEgressRecord[];
}

export interface HostMessage {
	readonly type: "hello" | "welcome" | "heartbeat" | "call" | "result" | "event" | "stream.close" | string;
	readonly hello?: HostHello;
	readonly welcome?: HostWelcome;
	readonly heartbeat?: { readonly capacity: HostCapacity };
	readonly id?: string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: HostError;
	readonly event?: HostEvent;
	/** On an event: the call it is progress of. */
	readonly call?: string;
	readonly stream?: number;
	readonly reason?: string;
}

export const HostMethods = {
	create: "sandbox.create",
	stop: "sandbox.stop",
	resume: "sandbox.resume",
	start: "sandbox.start",
	fork: "sandbox.fork",
	/** Replaces a sandbox's egress: `{ sandboxId, egress }` (null for the host's default). */
	egress: "sandbox.egress",
	delete: "sandbox.delete",
	get: "sandbox.get",
	list: "sandbox.list",
	exec: "sandbox.exec",
	fileRead: "sandbox.files.read",
	fileWrite: "sandbox.files.write",
	fileDelete: "sandbox.files.delete",
	fileList: "sandbox.files.list",
	snapshotList: "snapshot.list",
	snapshotSave: "snapshot.save",
	snapshotDelete: "snapshot.delete",
	snapshotTree: "snapshot.tree",
	snapshotRead: "snapshot.read",
	portOpen: "port.open",
	hostUpdate: "host.update",
	hostPools: "host.pools",
	/** Kantel to host: a sandbox's protected values changed, `{ sandboxId, version }`; it drops its copy. Result `{}`. */
	secrets: "sandbox.secrets",
	/** Host to Kantel: `{ sandboxId }`, answered with `HostSecrets`, or `not_found` for a sandbox not on that host. */
	secretsFetch: "secrets.fetch",
} as const;

export type HostMethod = (typeof HostMethods)[keyof typeof HostMethods];

/** A binary frame: the stream ID, then the payload. */
export function encodeStreamFrame(stream: number, payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(4 + payload.byteLength);
	new DataView(frame.buffer).setUint32(0, stream >>> 0, false);
	frame.set(payload, 4);
	return frame;
}

export function decodeStreamFrame(
	frame: Uint8Array,
): { readonly stream: number; readonly payload: Uint8Array } | undefined {
	if (frame.byteLength < 4) return undefined;
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	return { stream: view.getUint32(0, false), payload: frame.subarray(4) };
}

/** Whether a value read off the socket is a message at all; the fields are the sender's to get right. */
export function parseHostMessage(text: string): HostMessage | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") {
			return undefined;
		}
		return value as HostMessage;
	} catch {
		return undefined;
	}
}
