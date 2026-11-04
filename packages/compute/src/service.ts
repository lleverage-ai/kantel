/**
 * The compute plane's handlers: one per route of `@kantel/api`'s `computeRoutes`, over a `ComputeStore` and a
 * `SandboxBackend`. The service keeps every record (accounts, sandboxes and their lifecycle, commands, snapshots, keys,
 * webhooks, telemetry, hosts) and asks the backend only for machines and bytes.
 *
 * A sandbox moves `starting` → `running` → `stopping` → `stopped` or `paused`, into `error` when the backend fails, and
 * through `deleting` to `deleted`. A lifecycle call puts the sandbox in its passing state and answers at once, leaving
 * the backend's work running in the background, or answers when it is done with `wait`; calls on one sandbox run one
 * after another. Every change is an event (`EVENT_TYPES`), stored, queued for the account's webhooks and exported as an
 * OpenTelemetry log record.
 *
 * Cost uses a per-type and per-size rate table; the default, `PLACEHOLDER_RATES`, is a placeholder until real pricing
 * exists. CPU seconds are estimated from the usage readings taken while a sandbox runs.
 *
 * An environment is what a sandbox starts with: plain variables, protected ones, secret files, repositories and egress
 * grants. A protected variable's value is sealed (`secrets.ts`) and never answered: the sandbox gets a placeholder of
 * its own, and only the sandbox's host is given the value (`protectedTable`, over its link), for its egress proxy to
 * swap in on requests to the variable's bindings.
 */
import { computeSchema, type PublicComputeRoutes, type RouteHandlers, type SignedInComputeRoutes } from "@kantel/api";
import { KantelError } from "@kantel/contracts";
import type { ChainEntry } from "@kantel/e2e/chain";
import {
	type Acting,
	accountById,
	actingAccount,
	decodeGrantee,
	encodeGrantee,
	keyPrincipal,
	liveKeyPrincipal,
	memberId,
	newApiKeySecret,
	type Principal,
	requireGrantable,
	requirePerson,
	requireScope,
	roleIn,
} from "./auth.ts";
import type {
	BackendCapabilities,
	BackendEgress,
	BackendEgressGrant,
	BackendFileEntry,
	BootOptions,
	Placement,
	SandboxBackend,
} from "./backend.ts";
import type { BaseImageIndex, BaseImageVersion } from "./base-images.ts";
import { type BaseImages, baseImageOf, baseStatus, HOST_BASE_IMAGE, hostImageChannel } from "./base-status.ts";
import { createE2EChains } from "./e2e.ts";
import { createEphemeralSealer, createSealer, type SealedValue, type Sealer, sealedAt } from "./secrets.ts";
import type {
	ComputeStore,
	RunPeriod,
	StoredAccount,
	StoredApiKey,
	StoredCommand,
	StoredDeviceLogin,
	StoredEgressEntry,
	StoredEnvironment,
	StoredEnvironmentFile,
	StoredEnvironmentVariable,
	StoredHost,
	StoredInvite,
	StoredProxy,
	StoredSandbox,
	StoredSnapshot,
	StoredTelemetry,
	StoredWebhook,
} from "./store.ts";
import { UniqueViolation } from "./store.ts";
import type { TelemetryExporter, TelemetryUsageSample } from "./telemetry.ts";
import {
	base64ToBytes,
	bytesToBase64,
	HOME,
	paginate,
	randomId,
	randomSecret,
	randomSlug,
	randomUserCode,
	resolvePath,
	sha256Hex,
} from "./util.ts";
import { deliveryView, newWebhookSecret, type WebhookDispatcher } from "./webhooks.ts";

type Sandbox = computeSchema.Sandbox;
type SandboxState = computeSchema.SandboxState;
type SandboxType = computeSchema.SandboxType;
type MemberRole = computeSchema.MemberRole;
type EventType = computeSchema.EventType;
type EventData = computeSchema.Event["data"];
/** What decides a sandbox's egress besides its account's proxy settings. */
type EgressSubject = Pick<StoredSandbox, "environmentId" | "placeholders" | "grants" | "egressRevision">;

/** What an hour of running costs, per type and microVM size. */
export interface RateTable {
	/** ISO 4217. */
	readonly currency: string;
	readonly isolate: number;
	readonly microvm: { readonly [size in computeSchema.SandboxSizeName]: number };
}

/** A placeholder until real pricing exists: rough figures so the console has something to show. */
export const PLACEHOLDER_RATES: RateTable = {
	currency: "USD",
	isolate: 0.01,
	microvm: { small: 0.03, default: 0.06, large: 0.12, xlarge: 0.24 },
};

/** Limits on every account, where the deployment sets any. */
export interface ComputeLimits {
	readonly concurrentSandboxes?: number;
	/** Reported only; not enforced yet. */
	readonly startsPerMinute?: number;
	readonly savedSnapshots?: number;
}

export interface ComputeServiceOptions {
	readonly store: ComputeStore;
	readonly backend: SandboxBackend;
	readonly dispatcher: WebhookDispatcher;
	readonly exporter: TelemetryExporter;
	readonly now: () => number;
	/** The control plane's public URL, for host join commands. Default the request's origin. */
	readonly publicUrl?: string;
	/** Default `selfhosted`. */
	readonly mode?: "selfhosted" | "hosted";
	/** The join command shown with a host join token, with `{url}` and `{token}`. Default the npm package's. */
	readonly hostJoinCommand?: string;
	/**
	 * Account hosts (experimental): an account's people add hosts of its own (`/v1/hosts`), which only its
	 * sandboxes use. Off, those routes answer `not_supported`. Default off; the gateways turn it on with
	 * `KANTEL_ACCOUNT_HOSTS=experimental`, and only where sandboxes run on hosts.
	 */
	readonly accountHosts?: boolean;
	/** The console page where a person approves a device sign-in, with `{url}` for the public URL. */
	readonly deviceLoginUrl?: string;
	/** Default `PLACEHOLDER_RATES`. */
	readonly rates?: RateTable;
	readonly limits?: ComputeLimits;
	/**
	 * Whether a sign-in a person's access was given under (`PersonIdentity.session`) is still live. Absent, sign-ins are
	 * taken to last.
	 */
	readonly sessionLive?: (session: string) => Promise<boolean>;
	/**
	 * Whether a user (a person, or the person a key acts for) may use the deployment's shared hosts: have sandboxes
	 * placed on them, or use one already there. Without, only their accounts' own hosts (account hosts). Absent,
	 * everyone may. The hosted gateway keeps its stub, in the stack object's memory, to the deployment's organisation.
	 */
	readonly sharedHosts?: (userId: string) => Promise<boolean>;
	/**
	 * The deployment's `KANTEL_SECRETS_KEY` (32 bytes, base64), which seals protected variable values and secret files.
	 * Absent: a memory store seals with a key made at random for the process; a persistent store refuses them
	 * (`not_supported`), and plain variables still work. Not a key: the service refuses to start.
	 */
	readonly secretsKey?: string;
	/**
	 * Image patching (experimental): Kantel's base image index (`base-status.ts`), which sandboxes' and snapshots' `base`,
	 * `restartSandboxOnLatest` and the admin's `listBaseImages` read. Absent, the feature is off: no `base` is answered
	 * and those routes answer `not_supported`. The gateways set it with `KANTEL_IMAGE_PATCHING=experimental`, and cache
	 * the index themselves.
	 */
	readonly baseImages?: BaseImages;
}

/** A destination a protected value may go to, as the host's proxy is given it: every list present, empty for any. */
export interface ProtectedBinding {
	readonly host: string;
	readonly pathPrefixes: readonly string[];
	readonly methods: readonly string[];
}

/** One protected variable as a sandbox's host is given it: the sandbox's placeholder and the value it stands for. */
export interface ProtectedEntry {
	readonly placeholder: string;
	readonly name: string;
	readonly value: string;
	readonly bindings: readonly ProtectedBinding[];
}

/** A sandbox's protected values, the answer to its host's `secrets.fetch`. */
export interface ProtectedTable {
	readonly version: number;
	readonly entries: readonly ProtectedEntry[];
}

/** One request or connection a host's egress proxy reports for a sandbox: never a value nor a query string. */
export interface ReportedEgress {
	readonly at: number;
	readonly sandboxId: string;
	readonly method: string;
	readonly host: string;
	readonly port: number;
	readonly path?: string;
	readonly allowed: boolean;
	readonly reason?: string;
	readonly rule?: string;
	readonly code?: string;
	readonly swapped: readonly string[];
	readonly inspected: boolean;
	readonly status?: number;
	readonly bytesUp: number;
	readonly bytesDown: number;
}

/** What someone kept off the shared hosts is told about a sandbox on one. */
export const SHARED_HOSTS_REFUSED =
	"This sandbox is on the deployment's shared hosts, which are for its own organisation; use a host of your own";

/** A sandbox whose making from another failed, with nothing left to make it from. */
export const NEVER_MADE =
	"This sandbox was never made from its source, and there's no snapshot left to make it from; fork or create it again";

/** A host whose credential no running backend holds (an account's own, account hosts off) can't be revoked. */
export const HOST_NOT_REVOCABLE =
	"This host's credential is kept by a part of the deployment that is off (account hosts); turn it on to revoke the host";

/** What someone kept off the shared hosts is told when they rotate a key that isn't. */
export const SHARED_KEY_REFUSED =
	"This key may use the deployment's shared hosts, which you may not, so you can't take its secret; revoke it instead";

export interface ComputeService {
	/** A handler for every compute route that signs the caller in, given the signed-in caller. */
	readonly handlers: RouteHandlers<SignedInComputeRoutes, Principal>;
	/** A handler for each route that takes no credential (`publicComputeRoutes`), given no caller. */
	readonly publicHandlers: RouteHandlers<PublicComputeRoutes, undefined>;
	/** Stops every running sandbox whose `stopsAt` has passed. */
	sweep(): Promise<void>;
	/**
	 * Whether `grantee` (`encodeGrantee`) may still open `sandboxId`'s access: the key unrevoked and unexpired, or the
	 * person's sign-in live, and either still able to see the sandbox with the `access` scope. A relay asks while access
	 * it carries lasts. No grantee named: true.
	 */
	stillAllowed(grantee: string | undefined, sandboxId: string): Promise<boolean>;
	/** Reads every running sandbox's usage, keeps it, and answers it for the metrics export. */
	sampleUsage(): Promise<TelemetryUsageSample[]>;
	/**
	 * A sandbox's protected values, opened, for the host that asked over its link (`secrets.fetch`): `undefined` unless
	 * the sandbox's recorded host is `hostId`, so a host learns only its own sandboxes' values. `unavailable` when a value
	 * doesn't open.
	 */
	protectedTable(hostId: string, sandboxId: string): Promise<ProtectedTable | undefined>;
	/**
	 * An organisation's E2E chain, for a host that asked over its credential (`kantel-host e2e join`): an account's own
	 * host reads only its account's, a shared host any. `not_found` otherwise.
	 */
	hostE2EChain(hostId: string, space: string): Promise<ChainEntry[]>;
	/** Adds a host's own entries (a `host.add` naming it, signed with an admin's join ticket) to the chain. */
	appendHostE2EChain(
		hostId: string,
		space: string,
		from: number,
		entries: readonly ChainEntry[],
	): Promise<ChainEntry[]>;
	/**
	 * Keeps what a host's egress proxy reported, in each sandbox's log (the newest `MAX_EGRESS_ENTRIES`). Records for a
	 * sandbox not on `hostId` are dropped, and a path's query string is never kept.
	 */
	recordEgress(hostId: string, records: readonly ReportedEgress[]): Promise<void>;
	/**
	 * Keeps the bases a host says its sandboxes' disks are on (image patching, experimental: its hello and its events), so
	 * a sandbox made before the host versioned its images shows its base without another boot. Only a sandbox on
	 * `hostId` is changed, and only to a base that looks like one (a host images version or a digest).
	 */
	recordBases(hostId: string, reports: readonly { readonly sandboxId: string; readonly base: string }[]): Promise<void>;
	/** Resolves once every lifecycle operation and detached command started so far has ended. */
	idle(): Promise<void>;
	/** Kills the detached commands and waits for the work under way. */
	close(): Promise<void>;
}

/** A port's URL as a sandbox's record keeps it: without its token, which only the answer to exposing it shows. */
function withoutPortToken(url: string): string {
	const parsed = new URL(url);
	if (!parsed.searchParams.has("_token")) return url;
	parsed.searchParams.delete("_token");
	return parsed.toString();
}

/** The largest file the files routes read or write. */
/**
 * The join command shown with a host join token: the host installer from Kantel's latest GitHub Release
 * (`apps/host/install.sh`), which downloads kantel-host, checks its SHA-256 and runs its `install`. It pastes into
 * bash, zsh and fish alike.
 */
export const DEFAULT_HOST_JOIN_COMMAND =
	"curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url {url} --token {token}";
/** The console's page where a person approves a device sign-in. */
export const DEFAULT_DEVICE_LOGIN_URL = "{url}/device";
/** How long a device sign-in waits for a person, and how often its device may poll. */
export const DEVICE_LOGIN_TTL_MS = 15 * 60_000;
export const DEVICE_LOGIN_INTERVAL_SECONDS = 2;
/** A device sign-in's key works this long unless its approver says otherwise. */
export const DEVICE_LOGIN_KEY_DAYS = 90;
/** At most this many device sign-ins wait at once, as their start takes no credential. */
export const MAX_PENDING_DEVICE_LOGINS = 1000;

export const MAX_FILE_BYTES = 1024 * 1024;
/** The most output a command keeps per stream. */
export const MAX_OUTPUT_CHARS = 1024 * 1024;
/** A command's default time limit. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** How many of each base image's versions the admin list answers, newest first. */
export const BASE_IMAGE_VERSIONS_LISTED = 10;
/** The routes whose answers carry a sandbox's or snapshot's `base`, which read the base image index first. */
const BASE_ROUTES = [
	"listSandboxes",
	"createSandbox",
	"getSandbox",
	"updateSandbox",
	"startSandbox",
	"stopSandbox",
	"resumeSandbox",
	"forkSandbox",
	"recoverSandbox",
	"restartSandboxOnLatest",
	"deleteSandbox",
	"listSnapshots",
	"takeSnapshot",
	"saveSnapshot",
	"getSnapshot",
] as const satisfies readonly (keyof SignedInComputeRoutes)[];
/** How long an automatic snapshot is kept. */
export const AUTOMATIC_SNAPSHOT_TTL_MS = 7 * 24 * 3_600_000;
/** The usage readings kept per sandbox: a day at one every 5 minutes. */
export const MAX_SAMPLES = 288;
/** The egress log entries kept per sandbox, newest first. */
export const MAX_EGRESS_ENTRIES = 1000;
/** How many of a placeholder's characters the API shows: `kph_` and 4 more, to tell it apart, never to use it. */
export const PLACEHOLDER_PREFIX_CHARS = 8;
/** An environment's limits: its variables, its secret files, and their bytes in all (one record must hold them). */
export const MAX_ENVIRONMENT_VARIABLES = 200;
export const MAX_ENVIRONMENT_FILES = 20;
export const MAX_ENVIRONMENT_FILE_BYTES = 1024 * 1024;
/** How long a repository's clone may take when a sandbox starts. */
const CLONE_TIMEOUT_MS = 10 * 60_000;
/** How many times a boot sends egress changed while it started (or tries again), before it is stopped instead. */
const BOOT_RECONCILE_ROUNDS = 5;
/**
 * How long a gateway has to carry out a stop a sandbox was due for (`stopFor`) once it took it on, before the sweep
 * takes it as abandoned (its gateway gone) and stops it again.
 */
const STOP_LEASE_MS = 5 * 60_000;
/** Why a sandbox whose host can't enforce its egress grants or protected variables is stopped. */
const UNENFORCED = "Its host doesn't enforce egress grants or protected variables";
/** What a host reports when it enforces egress grants and protected variables (`HOST_FEATURES` in @kantel/hosts). */
const EGRESS_POLICY_FEATURE = "egress-policy";
/**
 * How long an idempotency key's claim lasts without a renewal: a gateway that dies mid-call frees its key within this,
 * and a retry then does the work. The holder renews it every `IDEMPOTENCY_RENEW_MS` while the work runs.
 */
export const IDEMPOTENCY_CLAIM_MS = 60_000;
export const IDEMPOTENCY_RENEW_MS = 20_000;
const DEFAULT_AUTO_STOP_MINUTES = 60;
/**
 * How stale a host record's `lastSeenAt` may get before it is written again: it moves on every heartbeat, and the host
 * list answers it fresh from the backend anyway, so the record needn't be written on every create.
 */
export const HOST_SEEN_PRECISION_MS = 60_000;

/** Whether a host record needs writing: anything but `lastSeenAt` changed, or that is `HOST_SEEN_PRECISION_MS` stale. */
/** "a" or "an" before a sandbox type: an isolate, a microvm. */
function article(type: string): string {
	return /^[aeiou]/i.test(type) ? "an" : "a";
}

function hostChanged(known: StoredHost, next: StoredHost): boolean {
	const { lastSeenAt: knownSeen, ...knownRest } = known;
	const { lastSeenAt: nextSeen, ...nextRest } = next;
	if (JSON.stringify(knownRest) !== JSON.stringify(nextRest)) return true;
	if (nextSeen === undefined || knownSeen === nextSeen) return false;
	return knownSeen === undefined || Math.abs(nextSeen - knownSeen) >= HOST_SEEN_PRECISION_MS;
}
const NOT_DELETED: readonly computeSchema.SandboxState[] = [
	"starting",
	"running",
	"stopping",
	"stopped",
	"paused",
	"error",
	"deleting",
];
/**
 * How long SSH, desktop and browser access can be opened for, unless the call says: a bearer URL that leaks is good for
 * minutes, as boat.dev's are. A connection opened in time stays open; the schema caps a request at an hour.
 */
const ACCESS_TTL_MINUTES = 10;
const DAY_MS = 24 * 3_600_000;

const ISOLATE_CAPABILITIES: computeSchema.SandboxCapabilities = {
	exec: true,
	files: true,
	ssh: false,
	desktop: false,
	browser: false,
	ports: true,
	docker: false,
	kvm: false,
	pause: false,
};
const MICROVM_CAPABILITIES: computeSchema.SandboxCapabilities = {
	exec: true,
	files: true,
	ssh: true,
	desktop: true,
	browser: true,
	ports: true,
	docker: true,
	kvm: true,
	pause: true,
};

const ADJECTIVES = ["brave", "calm", "eager", "fond", "gentle", "keen", "lucky", "merry", "quick", "quiet", "swift"];
const ANIMALS = ["otter", "heron", "badger", "lynx", "marten", "puffin", "wren", "hare", "stoat", "newt", "plover"];
const pick = (items: readonly string[]): string => items[Math.floor(Math.random() * items.length)] ?? "sandbox";
const generatedName = () => `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const notFound = (what: string) => new KantelError("not_found", `No such ${what}`);
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * The sandbox limit a key made or rotated by `principal` may carry: a limited key grants only sandboxes in its own list,
 * and a key it makes with none named gets its list.
 */
function grantableSandboxes(principal: Principal, wanted: readonly string[] | undefined): string[] | undefined {
	if (principal.kind !== "key" || principal.limits.sandboxIds === undefined) {
		return wanted === undefined ? undefined : [...wanted];
	}
	const allowed = principal.limits.sandboxIds;
	if (wanted === undefined) return [...allowed];
	if (!wanted.every((id) => allowed.includes(id))) {
		throw new KantelError("forbidden", "A limited key can't grant sandboxes beyond its own");
	}
	return [...wanted];
}
const newestFirst = <T extends { readonly createdAt: number }>(items: readonly T[]): T[] =>
	[...items].sort((a, b) => b.createdAt - a.createdAt);

/** The milliseconds of `runs` inside `[from, to)`. */
function runningMs(runs: readonly RunPeriod[], from: number, to: number): number {
	let total = 0;
	for (const run of runs) {
		const start = Math.max(run.from, from);
		const end = Math.min(run.to ?? to, to);
		if (end > start) total += end - start;
	}
	return total;
}

function subdomainFor(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${slug === "" ? "sandbox" : slug}-${randomSlug(6)}`;
}

function checkUrl(url: string, what: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new KantelError("invalid", `${what} is not a URL`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new KantelError("invalid", `${what} must be an HTTPS (or, self-hosted, HTTP) URL`);
	}
}

/**
 * A host the join command can carry as plain data: a DNS name (an international one in its punycode form, as the URL
 * parser writes it) or an IPv4 address, or an IPv6 literal in brackets. The URL parser alone lets through hosts such as
 * `$(id).example.com`, which a shell would run when the command is pasted.
 */
const PLAIN_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$|^\[[0-9a-f:.]+\]$/;

/**
 * A public URL as an origin, `https://kantel.example.com`: http(s), with nothing after the host but a trailing slash,
 * and a host that's a DNS name or an IP address, so the origin goes into a shell command as data.
 */
export function publicOrigin(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		throw new KantelError("invalid", "The public URL is not a URL, such as https://kantel.example.com");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new KantelError("invalid", "The public URL starts with https:// or http://");
	}
	if (
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		throw new KantelError("invalid", "The public URL is an origin, with no path, such as https://kantel.example.com");
	}
	if (!PLAIN_HOST.test(parsed.hostname)) {
		throw new KantelError(
			"invalid",
			"The public URL's host is a domain name or an IP address, such as kantel.example.com",
		);
	}
	return parsed.origin;
}

/** Whether only a host on the same machine could reach `url`: `127.0.0.1`, `localhost`, `::1` or `0.0.0.0`. */
export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		/^127\.\d+\.\d+\.\d+$/.test(host) ||
		host === "[::1]" ||
		host === "0.0.0.0"
	);
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
	try {
		// `ignoreBOM` is the default, given because workers-types requires it (apps/cloudflare serves this API).
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		throw new KantelError("invalid", `${path} is not UTF-8 text; read it with encoding base64`);
	}
}

const truncate = (text: string): { text: string; truncated: boolean } =>
	text.length > MAX_OUTPUT_CHARS
		? { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true }
		: { text, truncated: false };

// Environments: names, destinations and grants, checked and kept in one form.

const RESERVED_VARIABLES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);

/** Whether Kantel keeps a variable's name for itself: `KANTEL_*` and the proxy's, in any case. */
export function isReservedVariable(name: string): boolean {
	const upper = name.toUpperCase();
	return upper.startsWith("KANTEL_") || RESERVED_VARIABLES.has(upper);
}

function refuseReserved(name: string): void {
	if (isReservedVariable(name)) {
		throw new KantelError(
			"invalid",
			`${name} is Kantel's own (KANTEL_*, HTTP_PROXY, HTTPS_PROXY and NO_PROXY are); choose another name`,
		);
	}
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

function checkVariableName(name: string): void {
	if (!VARIABLE_NAME.test(name)) {
		throw new KantelError("invalid", "A variable's name is letters, digits and underscores, not starting with a digit");
	}
	refuseReserved(name);
}

const HOST_LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOST_NAME = new RegExp(`^(\\*\\.)?(${HOST_LABEL}\\.)*${HOST_LABEL}$`);

/** A host or a `*.` pattern, in lower case; `invalid` when it is neither. */
function checkHost(host: string, what: string): string {
	const lower = host.trim().toLowerCase();
	if (lower.length > 253 || !HOST_NAME.test(lower)) {
		throw new KantelError(
			"invalid",
			`${what} must be a host, such as api.github.com, or *.example.com for its subdomains`,
		);
	}
	return lower;
}

function checkPaths(paths: readonly string[] | undefined, what: string): string[] {
	const checked = unique(paths ?? []);
	for (const path of checked) {
		// Never a query: the proxy matches paths only, and a query could carry what shouldn't be kept.
		if (!path.startsWith("/") || /[?#\s]/.test(path)) {
			throw new KantelError("invalid", `${what} must start with / and have no query, fragment or spaces`);
		}
	}
	return checked;
}

const methodsOf = (methods: readonly string[] | undefined): string[] =>
	unique((methods ?? []).map((method) => method.toUpperCase()));

/** A request body's binding (readonly) or a stored one. */
type BindingInput = {
	readonly host: string;
	readonly pathPrefixes?: readonly string[];
	readonly methods?: readonly string[];
};

function normaliseBinding(binding: BindingInput): computeSchema.DestinationBinding {
	const pathPrefixes = checkPaths(binding.pathPrefixes, "A binding's path prefix");
	const methods = methodsOf(binding.methods);
	return {
		host: checkHost(binding.host, "A binding's host"),
		...(pathPrefixes.length === 0 ? {} : { pathPrefixes }),
		...(methods.length === 0 ? {} : { methods }),
	};
}

const copyBinding = (binding: computeSchema.DestinationBinding): computeSchema.DestinationBinding => ({
	host: binding.host,
	...(binding.pathPrefixes === undefined ? {} : { pathPrefixes: [...binding.pathPrefixes] }),
	...(binding.methods === undefined ? {} : { methods: [...binding.methods] }),
});

const GRANT_ID = /^grt_[a-z0-9]{1,32}$/;

/** Grants as given, checked: a well-formed ID is kept (so an edit keeps its grants'), anything else gets a new one. */
function normaliseGrants(
	inputs: readonly {
		readonly id?: string;
		readonly action: "allow" | "deny";
		readonly host: string;
		readonly methods?: readonly string[];
		readonly paths?: readonly string[];
	}[],
): computeSchema.EgressGrant[] {
	const ids = new Set<string>();
	return inputs.map((input) => {
		const id = input.id !== undefined && GRANT_ID.test(input.id) && !ids.has(input.id) ? input.id : randomId("grt", 8);
		ids.add(id);
		const methods = methodsOf(input.methods);
		const paths = checkPaths(input.paths, "A grant's path");
		return {
			id,
			action: input.action,
			// `*` is every host, for a grant (never a binding: a value can't be allowed everywhere).
			host: input.host.trim() === "*" ? "*" : checkHost(input.host, "A grant's host"),
			...(methods.length === 0 ? {} : { methods }),
			...(paths.length === 0 ? {} : { paths }),
		};
	});
}

const copyGrant = (grant: computeSchema.EgressGrant): computeSchema.EgressGrant => ({
	id: grant.id,
	action: grant.action,
	host: grant.host,
	...(grant.methods === undefined ? {} : { methods: [...grant.methods] }),
	...(grant.paths === undefined ? {} : { paths: [...grant.paths] }),
});

/** A grant as the egress log names it, such as `deny DELETE api.github.com /repos/*`. */
export function grantRule(grant: computeSchema.EgressGrant): string {
	return [
		grant.action,
		...(grant.methods === undefined || grant.methods.length === 0 ? [] : [grant.methods.join(",")]),
		grant.host,
		...(grant.paths === undefined || grant.paths.length === 0 ? [] : [grant.paths.join(",")]),
	].join(" ");
}

const backendGrant = (grant: computeSchema.EgressGrant): BackendEgressGrant => ({
	action: grant.action,
	host: grant.host,
	...(grant.methods === undefined || grant.methods.length === 0 ? {} : { methods: [...grant.methods] }),
	...(grant.paths === undefined || grant.paths.length === 0 ? {} : { paths: [...grant.paths] }),
	rule: grantRule(grant),
});

/** A path in the sandbox: absolute, or from its user's home (`~/` or relative). */
const sandboxPath = (path: string): string => resolvePath(path.startsWith("~/") ? path.slice(2) : path);

const REPO_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

function normaliseRepo(repo: computeSchema.EnvironmentRepo): computeSchema.EnvironmentRepo {
	let url: URL;
	try {
		url = new URL(repo.url);
	} catch {
		throw new KantelError("invalid", "A repository's URL is not a URL");
	}
	if (url.protocol !== "https:") throw new KantelError("invalid", "A repository's URL must be HTTPS");
	if (url.username !== "" || url.password !== "") {
		throw new KantelError(
			"invalid",
			"A repository's URL may not carry credentials; keep them in a protected variable bound to its host",
		);
	}
	if (url.search !== "" || url.hash !== "") {
		throw new KantelError("invalid", "A repository's URL has no query or fragment");
	}
	// Starting with a letter or digit, a ref is never taken for one of git's options.
	if (repo.ref !== undefined && !REPO_REF.test(repo.ref)) {
		throw new KantelError("invalid", "A repository's ref must be a branch or tag name");
	}
	const path = repo.path === undefined ? undefined : sandboxPath(repo.path);
	if (path === "/") throw new KantelError("invalid", "A repository can't be cloned into /");
	return {
		url: url.toString(),
		...(path === undefined ? {} : { path }),
		...(repo.ref === undefined ? {} : { ref: repo.ref }),
	};
}

const copyRepo = (repo: computeSchema.EnvironmentRepo): computeSchema.EnvironmentRepo => ({
	url: repo.url,
	...(repo.path === undefined ? {} : { path: repo.path }),
	...(repo.ref === undefined ? {} : { ref: repo.ref }),
});

/** Repositories as text that is the same when they are: for a write's `expected`. */
const reposKey = (repos: readonly computeSchema.EnvironmentRepo[]): string =>
	JSON.stringify(repos.map((repo) => [repo.url, repo.path ?? "", repo.ref ?? ""]));

/** Grants as text that is the same when they are: for a write's `expected`. */
const grantsKey = (
	grants: readonly {
		readonly id?: string;
		readonly action: string;
		readonly host: string;
		readonly methods?: readonly string[];
		readonly paths?: readonly string[];
	}[],
): string =>
	JSON.stringify(
		grants.map((grant) => [
			grant.id ?? "",
			grant.action,
			grant.host.trim().toLowerCase(),
			[...(grant.methods ?? [])].map((method) => method.toUpperCase()),
			[...(grant.paths ?? [])],
		]),
	);

/** An account's proxy settings before any are written: off, everything allowed. */
const unsetProxy = (account: StoredAccount): StoredProxy => ({
	id: account.id,
	accountId: account.id,
	enabled: false,
	defaultAction: "allow",
	allow: [],
	deny: [],
	attribution: false,
	updatedAt: account.createdAt,
});

/** Proxy settings as text that is the same when they are: for a write's `expected`. Header values aren't in it. */
const proxyKey = (settings: {
	readonly enabled: boolean;
	readonly defaultAction: string;
	readonly allow: readonly string[];
	readonly deny: readonly string[];
	readonly upstream?: { readonly url: string; readonly headerNames: readonly string[] };
	readonly attribution: boolean;
}): string =>
	JSON.stringify([
		settings.enabled,
		settings.defaultAction,
		settings.allow,
		settings.deny,
		settings.upstream === undefined ? null : [settings.upstream.url, [...settings.upstream.headerNames].sort()],
		settings.attribution,
	]);

/** Refuses a write made from a read of `what` that is out of date: `expected` isn't what is there now. */
function requireUnchanged(expected: string | undefined, now: string, what: string): void {
	if (expected !== undefined && expected !== now) {
		throw new KantelError("conflict", `${what} changed since you read them; read them again and redo the change`);
	}
}

/** Where a repository is cloned: its path, or `~/<name>` after the URL's last segment. */
function clonePath(repo: computeSchema.EnvironmentRepo): string {
	if (repo.path !== undefined) return repo.path;
	const last =
		new URL(repo.url).pathname
			.split("/")
			.filter((part) => part !== "")
			.pop() ?? "";
	const name = last.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
	return `${HOME}/${name === "" || name.startsWith(".") ? "repo" : name}`;
}

/** One word for `sh`, quoted. */
const shellWord = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** Whether a binding's host pattern (`example.com`, `*.example.com`) covers a host. */
function coversHost(pattern: string, host: string): boolean {
	const want = host.toLowerCase();
	const have = pattern.toLowerCase();
	return have.startsWith("*.") ? want.endsWith(have.slice(1)) : want === have;
}

/**
 * The protected variable a repository's clone authenticates with: the environment's first one, which this sandbox has a
 * placeholder for, whose bindings between them let its value go with each request a smart-HTTP clone makes (`GET
 * <repo>/info/refs`, then `POST <repo>/git-upload-pack`), one binding or two. None: the clone is anonymous. The proxy
 * still judges every request itself; this only decides whether Git is given the placeholder.
 */
export function repoCredential(
	environment: Pick<StoredEnvironment, "variables">,
	repo: computeSchema.EnvironmentRepo,
	placeholders: { readonly [name: string]: string },
): string | undefined {
	const url = new URL(repo.url);
	if (url.port !== "" && url.port !== "443") return undefined;
	const base = url.pathname.replace(/\/+$/, "");
	const requests = [
		{ method: "GET", path: `${base}/info/refs` },
		{ method: "POST", path: `${base}/git-upload-pack` },
	];
	const lets = (binding: computeSchema.DestinationBinding, request: { method: string; path: string }) =>
		coversHost(binding.host, url.hostname) &&
		(binding.pathPrefixes === undefined ||
			binding.pathPrefixes.length === 0 ||
			binding.pathPrefixes.some((prefix) => request.path.startsWith(prefix))) &&
		(binding.methods === undefined ||
			binding.methods.length === 0 ||
			binding.methods.some((method) => method.toUpperCase() === request.method));
	return environment.variables.find(
		(variable) =>
			variable.protected &&
			placeholders[variable.name] !== undefined &&
			requests.every((request) => variable.bindings.some((binding) => lets(binding, request))),
	)?.name;
}

/**
 * `git -c …` arguments that give Git the variable's placeholder as its HTTPS password (user `x-access-token`, which
 * GitHub and most forges accept with a token), from the clone's environment: a helper, as Git reads no token from
 * the environment itself, and none of the guest's own helpers. The name is a checked variable name, so plain.
 */
export function gitCredentialArgs(name: string): string[] {
	const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${name}"; }; f`;
	return ["-c", shellWord("credential.helper="), "-c", shellWord(`credential.helper=${helper}`)];
}

/** A protected variable's placeholder in one sandbox: `kph_` and 40 characters from the CSPRNG. */
const newPlaceholder = (): string => randomSecret("kph_", 40);

const variableAad = (environmentId: string, name: string) =>
	sealedAt("environments", environmentId, `variables.${name}`);
const fileAad = (environmentId: string, path: string) => sealedAt("environments", environmentId, `files.${path}`);

/** An environment's protected values' next version: it only moves on, and a time keeps it so across a deletion. */
const nextSecretsVersion = (previous: number, at: number) => Math.max(previous + 1, at);

const clip = (text: string, length: number) => (text.length > length ? text.slice(0, length) : text);
const whole = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** The compute plane's handlers over a store and a backend. */
export function createComputeService(options: ComputeServiceOptions): ComputeService {
	const { store, backend, dispatcher, exporter, now } = options;
	const e2eChains = createE2EChains(store.e2eChain, now);
	/**
	 * A host's own account's chain; for a shared host, the chain of a space it runs a sandbox of or is enrolled in
	 * already (not every account's). The same `not_found` for a space it may not read.
	 */
	const hostMayUseChain = async (hostId: string, space: string) => {
		const host = (await ensureHosts()).find((known) => known.id === hostId);
		const account = await store.accounts.get(space);
		const refuse = () => new KantelError("not_found", "No such space");
		if (host === undefined || account === undefined) throw refuse();
		if (host.accountId !== undefined) {
			if (host.accountId !== space) throw refuse();
			return;
		}
		// A sandbox it runs now (stopped counts: its disk is there); a deleted one's record keeps its hostId, but not this.
		const placed = await store.sandboxes.list({ hostId });
		if (placed.some((sandbox) => sandbox.accountId === space && sandbox.state !== "deleted")) return;
		const state = await e2eChains.state(space).catch(() => undefined);
		if (state?.hosts.has(hostId) !== true) throw refuse();
	};
	const rates = options.rates ?? PLACEHOLDER_RATES;
	const limits = options.limits ?? {};
	const mode = options.mode ?? "selfhosted";
	/**
	 * The base image index as last read (image patching on), for the views, which answer synchronously: the routes that
	 * answer sandboxes or snapshots read it first (`BASE_ROUTES`). One that fails to read keeps the last one read.
	 */
	let baseIndex: BaseImageIndex | undefined;
	const refreshBase = async (): Promise<void> => {
		if (options.baseImages === undefined) return;
		baseIndex = (await options.baseImages.index().catch(() => undefined)) ?? baseIndex;
	};
	const requireImagePatching = (): BaseImages => {
		if (options.baseImages === undefined) {
			throw new KantelError("not_supported", "Image patching is off on this deployment (KANTEL_IMAGE_PATCHING)");
		}
		return options.baseImages;
	};
	/** How far behind a recorded base is, while image patching is on and the index knows its image. */
	const baseView = (base: string | undefined): computeSchema.SandboxBase | undefined =>
		options.baseImages === undefined || baseIndex === undefined || base === undefined
			? undefined
			: baseStatus(baseIndex, baseImageOf(base), base, now());
	// A key that isn't one throws here, so the deployment fails to start rather than on its first protected value.
	const sealer: Sealer | undefined =
		options.secretsKey !== undefined
			? createSealer(options.secretsKey)
			: store.persistent === true
				? undefined
				: createEphemeralSealer();
	const requireSealer = (): Sealer => {
		if (sealer === undefined) {
			throw new KantelError(
				"not_supported",
				"Protected variables and secret files need the deployment's secrets key: set KANTEL_SECRETS_KEY",
			);
		}
		return sealer;
	};

	/** Each sandbox's queue of lifecycle work; settled promises, so a failure doesn't stop the next. */
	const pending = new Map<string, Promise<void>>();
	/** Detached commands and their kill switches. */
	const runningCommands = new Map<string, AbortController>();
	const background = new Set<Promise<unknown>>();
	const inflight = new Map<string, Promise<unknown>>();

	/** A timestamp after `previous`, for a field that must move on with every write whatever the gateways' clocks say. */
	const later = (previous: number | undefined) => Math.max(now(), (previous ?? 0) + 1);

	const keepGoing = (work: Promise<unknown>) => {
		const tracked: Promise<unknown> = work.catch(() => undefined).finally(() => background.delete(tracked));
		background.add(tracked);
	};

	/** Runs `work` after every operation already queued on the sandboxes, and answers its promise. */
	function track<T>(ids: readonly string[], work: () => Promise<T>): Promise<T> {
		const previous = Promise.all(ids.map((id) => pending.get(id) ?? Promise.resolve()));
		const next = previous.then(work);
		const settled: Promise<void> = next
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				for (const id of ids) if (pending.get(id) === settled) pending.delete(id);
			});
		for (const id of ids) pending.set(id, settled);
		return next;
	}
	const settledOn = async (id: string) => {
		await pending.get(id);
	};

	// Hosts: the backend's, refreshed whenever they are needed (hosts join, connect and drop off at any time). The
	// super-admin's name, labels, drain and revocation are kept; what the host is and whether it's connected follow it.
	// Answers every host record as it is now, oldest first. The records are read in one statement, beside the backend's
	// hosts (or the caller's read of them), and one is written only when it changed: a host's `lastSeenAt` alone moves
	// on every heartbeat, so it is written once it is `HOST_SEEN_PRECISION_MS` stale, and the answer has it fresh.
	let hostsReady: Promise<StoredHost[]> | undefined;
	const ensureHosts = (read?: Promise<BackendCapabilities>): Promise<StoredHost[]> => {
		hostsReady ??= (async () => {
			const [capabilities, records] = await Promise.all([read ?? backend.capabilities(), store.hosts.list()]);
			const byId = new Map(records.map((record) => [record.id, record]));
			const writes: Promise<void>[] = [];
			for (const host of capabilities.hosts) {
				const known = byId.get(host.id);
				const reachable = host.connected !== false;
				// A host enrolled into an account stays that account's: the registry says so, or the enrolment it spent does
				// (looked up once, when the host is first seen). Once private, never shared again.
				const accountId =
					known?.accountId ?? host.accountId ?? (known === undefined ? await enrolledInto(host.id) : undefined);
				// Applied to the record as it is when written, not only as read above: a revocation or drain that lands
				// meanwhile (another request, another gateway) is kept.
				const refresh = (current: StoredHost): StoredHost => {
					const held = current.state === "revoked" || current.state === "draining";
					const owner = current.accountId ?? accountId;
					return {
						...current,
						...(owner === undefined ? {} : { accountId: owner }),
						state: held ? current.state : reachable ? "online" : "unreachable",
						version: host.version,
						os: host.os,
						arch: host.arch,
						tiers: [...host.tiers],
						kvm: host.kvm,
						nestedVirtualisation: host.nestedVirtualisation,
						capacity: { ...host.capacity },
						lastSeenAt: host.lastSeenAt ?? (reachable ? now() : current.lastSeenAt),
					};
				};
				const kept = (written: StoredHost | undefined) => {
					if (written !== undefined) byId.set(host.id, written);
				};
				if (known !== undefined) {
					const next = refresh(known);
					byId.set(host.id, next);
					if (hostChanged(known, next)) writes.push(store.hosts.update(host.id, refresh).then(kept));
					continue;
				}
				const joined: StoredHost = {
					id: host.id,
					name: host.name,
					state: reachable ? "online" : "unreachable",
					version: host.version,
					latestVersion: host.version,
					os: host.os,
					arch: host.arch,
					tiers: [...host.tiers],
					kvm: host.kvm,
					nestedVirtualisation: host.nestedVirtualisation,
					capacity: { ...host.capacity },
					allocated: { sandboxes: 0, vcpus: 0, memoryMb: 0, diskGb: 0 },
					labels: { ...host.labels },
					...(accountId === undefined ? {} : { accountId }),
					joinedAt: now(),
					lastSeenAt: now(),
				};
				byId.set(host.id, joined);
				// Another gateway saw it first: refresh what that one wrote.
				writes.push(
					store.hosts
						.insert(joined)
						.then(async (inserted) => (inserted ? undefined : kept(await store.hosts.update(host.id, refresh)))),
				);
			}
			// A host the backend no longer has (account hosts switched off, say) can't take sandboxes: it is unreachable,
			// so placement passes it over, its record (owner, revocation, sandboxes) kept for when the backend has it again.
			const advertised = new Set(capabilities.hosts.map((host) => host.id));
			for (const record of records) {
				if (advertised.has(record.id) || record.state !== "online") continue;
				byId.set(record.id, { ...record, state: "unreachable" });
				writes.push(
					store.hosts
						.update(record.id, (current) =>
							current.state === "online" ? { ...current, state: "unreachable" } : undefined,
						)
						.then(() => undefined),
				);
			}
			await Promise.all(writes);
			return [...byId.values()];
		})().finally(() => {
			hostsReady = undefined;
		});
		return hostsReady;
	};

	/** The account the enrolment a host spent joined it to, if it was an enrolment. */
	async function enrolledInto(hostId: string): Promise<string | undefined> {
		const [token] = await store.joinTokens.list({ hostId });
		return token?.accountId;
	}

	/**
	 * The hosts of `hosts` (`ensureHosts`'s answer) an account's sandbox of `type` may go on: online, running the type
	 * and carrying every label; `unavailable` when none does. An account with hosts of its own (account hosts) that
	 * qualify uses only those; otherwise the deployment's shared hosts. Another account's hosts never qualify.
	 *
	 * `affine`: for a machine or snapshot that already has a disk somewhere (start, resume, recover, fork, a create from
	 * a snapshot), every qualifying host the account may use, its own and shared alike, draining ones too (a drain stops
	 * new sandboxes, not what a host already holds). The backend boots it where its disk is, only if that host is in the
	 * list; preferring the account's hosts there would leave a disk on a shared host with nowhere eligible to boot.
	 *
	 * `shared`: whether the caller may use the shared hosts at all (`ComputeServiceOptions.sharedHosts`); without, only
	 * the account's own.
	 */
	function requireHosts(
		hosts: readonly StoredHost[],
		accountId: string,
		type: SandboxType,
		labels: { readonly [key: string]: string },
		affine: boolean,
		shared: boolean,
	): string[] {
		const qualifying = hosts
			.filter((host) => host.state === "online" || (affine && host.state === "draining"))
			.filter((host) => host.tiers.includes(type))
			.filter((host) => Object.entries(labels).every(([key, value]) => host.labels[key] === value));
		const own = qualifying.filter((host) => host.accountId === accountId);
		const common = shared ? qualifying.filter((host) => host.accountId === undefined) : [];
		const eligible = (affine ? [...own, ...common] : own.length > 0 ? own : common).map((host) => host.id);
		if (eligible.length === 0) {
			throw new KantelError(
				"unavailable",
				shared
					? `No host can run ${article(type)} ${type} sandbox now`
					: `No host of this account's own can run ${article(type)} ${type} sandbox now. Add one with kantel hosts add, or under Hosts in the console`,
			);
		}
		return eligible;
	}

	/**
	 * Whether `principal` may use the deployment's shared hosts (`ComputeServiceOptions.sharedHosts`). A super-admin
	 * always may.
	 */
	async function mayShare(principal: Principal): Promise<boolean> {
		if (options.sharedHosts === undefined || principal.superAdmin) return true;
		return options.sharedHosts(principal.userId);
	}

	// Views: what the API answers for a record.

	const rateOf = (sandbox: StoredSandbox) =>
		sandbox.type === "isolate" ? rates.isolate : rates.microvm[sandbox.size ?? "default"];

	const meanCpu = (sandbox: StoredSandbox) =>
		sandbox.samples.length === 0
			? 0
			: sandbox.samples.reduce((total, sample) => total + sample.cpu, 0) / sandbox.samples.length;

	function sandboxView(sandbox: StoredSandbox, principal: Principal): Sandbox {
		const seconds = runningMs(sandbox.runs, 0, now()) / 1000;
		const rate = rateOf(sandbox);
		return {
			id: sandbox.id,
			accountId: sandbox.accountId,
			name: sandbox.name,
			subdomain: sandbox.subdomain,
			type: sandbox.type,
			size: sandbox.size,
			resources: sandbox.resources,
			image: sandbox.image,
			state: sandbox.state,
			health: sandbox.health,
			reason: sandbox.reason,
			visibility: sandbox.visibility,
			capabilities: sandbox.capabilities,
			labels: sandbox.labels,
			autoStopMinutes: sandbox.autoStopMinutes,
			stopsAt: sandbox.state === "running" ? sandbox.stopsAt : undefined,
			latestSnapshotId: sandbox.latestSnapshotId,
			source: sandbox.source,
			environmentId: sandbox.environmentId,
			grants: (sandbox.grants ?? []).map(copyGrant),
			createdBy: sandbox.createdBy,
			createdAt: sandbox.createdAt,
			startedAt: sandbox.startedAt,
			stoppedAt: sandbox.stoppedAt,
			cost: { currency: rates.currency, total: round((seconds / 3600) * rate), ratePerHour: rate },
			usage: {
				runningSeconds: round(seconds),
				cpuSeconds: round(seconds * meanCpu(sandbox)),
				recentCpu: sandbox.samples.slice(-24).map((sample) => sample.cpu),
			},
			hostId: principal.superAdmin ? sandbox.hostId : undefined,
			base: baseView(sandbox.base),
		};
	}

	const snapshotView = (snapshot: StoredSnapshot): computeSchema.Snapshot => ({
		id: snapshot.id,
		accountId: snapshot.accountId,
		kind: snapshot.kind,
		name: snapshot.name,
		description: snapshot.description,
		sandboxId: snapshot.sandboxId,
		sandboxType: snapshot.sandboxType,
		state: snapshot.state,
		trigger: snapshot.trigger,
		memory: snapshot.memory,
		sizeBytes: snapshot.sizeBytes,
		createdAt: snapshot.createdAt,
		expiresAt: snapshot.expiresAt,
		base: baseView(snapshot.base),
	});

	/** A version of a base image as the admin list answers it: what the index says of it, its commit left out. */
	const baseVersionView = (version: BaseImageVersion): computeSchema.BaseImageVersion => ({
		version: version.version,
		digest: version.digest,
		builtAt: version.builtAt,
		signed: version.signed,
		...(version.reason === undefined ? {} : { reason: version.reason }),
		...(version.scan === undefined
			? {}
			: {
					scan: {
						scanner: version.scan.scanner,
						scannedAt: version.scan.scannedAt,
						counts: { ...version.scan.counts },
						fixable: { ...version.scan.fixable },
						findings: version.scan.findings.map((finding) => ({
							id: finding.id,
							severity: finding.severity,
							package: finding.package,
							installed: finding.installed,
							...(finding.fixed === undefined ? {} : { fixed: finding.fixed }),
							...(finding.title === undefined ? {} : { title: finding.title }),
						})),
					},
				}),
	});

	const commandView = (command: StoredCommand): computeSchema.Command => ({
		id: command.id,
		sandboxId: command.sandboxId,
		command: command.command,
		cwd: command.cwd,
		state: command.state,
		exitCode: command.exitCode,
		stdout: command.stdout,
		stderr: command.stderr,
		truncated: command.truncated,
		startedAt: command.startedAt,
		endedAt: command.endedAt,
		durationMs: command.durationMs,
	});

	const apiKeyView = (key: StoredApiKey): computeSchema.ApiKey => ({
		id: key.id,
		accountId: key.accountId,
		name: key.name,
		prefix: key.prefix,
		scopes: [...key.scopes],
		sandboxIds: key.sandboxIds === undefined ? undefined : [...key.sandboxIds],
		createdBy: key.createdBy,
		createdAt: key.createdAt,
		expiresAt: key.expiresAt,
		lastUsedAt: key.lastUsedAt,
		revokedAt: key.revokedAt,
	});

	const webhookView = (webhook: StoredWebhook): computeSchema.Webhook => ({
		id: webhook.id,
		accountId: webhook.accountId,
		name: webhook.name,
		url: webhook.url,
		events: [...webhook.events],
		enabled: webhook.enabled,
		createdAt: webhook.createdAt,
		lastDelivery: webhook.lastDelivery,
	});

	const telemetryView = (telemetry: StoredTelemetry): computeSchema.TelemetryExport => ({
		accountId: telemetry.accountId,
		endpoint: telemetry.endpoint,
		headerNames: Object.keys(telemetry.headers),
		signals: [...telemetry.signals],
		lastExport: telemetry.lastExport,
		updatedAt: telemetry.updatedAt,
	});

	const proxyView = (proxy: StoredProxy): computeSchema.ProxySettings => ({
		accountId: proxy.accountId,
		enabled: proxy.enabled,
		defaultAction: proxy.defaultAction,
		allow: [...proxy.allow],
		deny: [...proxy.deny],
		upstream:
			proxy.upstream === undefined
				? undefined
				: { url: proxy.upstream.url, headerNames: Object.keys(proxy.upstreamHeaders ?? {}) },
		attribution: proxy.attribution,
		updatedAt: proxy.updatedAt,
	});

	/**
	 * A sandbox's egress for the backend, `{ egress }` to spread into a spec: the account's proxy settings when they're
	 * on, with its protected variables' hosts (never a value) and its environment's and its own grants. With the proxy
	 * off, a sandbox with protected variables or grants still goes through it, open but for the grants, so its
	 * placeholders are swapped. With neither, nothing.
	 */
	const egressFor = async (
		accountId: string,
		subject?: EgressSubject,
	): Promise<{ egress?: BackendEgress; egressRevision?: number }> => {
		// The revision goes with no egress too: a boot states its egress, none being the host's default, and an update
		// read before it (an empty egress included) is then older and refused.
		const revision = subject?.egressRevision === undefined ? {} : { egressRevision: subject.egressRevision };
		const [proxy, environment] = await Promise.all([
			store.proxies.get(accountId),
			subject?.environmentId === undefined ? undefined : store.environments.get(subject.environmentId),
		]);
		const names = Object.keys(subject?.placeholders ?? {});
		const bound = (environment?.variables ?? []).filter(
			(variable) => variable.protected && variable.sealed !== undefined && names.includes(variable.name),
		);
		const grants = [...(environment?.grants ?? []), ...(subject?.grants ?? [])];
		const on = proxy?.enabled;
		if (!on && bound.length === 0 && grants.length === 0) return revision;
		const base: BackendEgress = proxy?.enabled
			? {
					defaultAction: proxy.defaultAction,
					allow: [...proxy.allow],
					deny: [...proxy.deny],
					...(proxy.upstream === undefined
						? {}
						: { upstream: { url: proxy.upstream.url, headers: { ...proxy.upstreamHeaders } } }),
					attribution: proxy.attribution,
				}
			: { defaultAction: "allow", allow: [], deny: [], attribution: false };
		return {
			egress: {
				...base,
				...(environment === undefined || bound.length === 0
					? {}
					: {
							protected: {
								version: environment.secretsVersion,
								intercept: unique(bound.flatMap((variable) => variable.bindings.map((binding) => binding.host))),
							},
						}),
				...(grants.length === 0 ? {} : { grants: grants.map(backendGrant) }),
				...(subject?.egressRevision === undefined ? {} : { revision: subject.egressRevision }),
			},
			...revision,
		};
	};

	/**
	 * Moves a sandbox's `egressRevision` on, after a change to what its egress is made of has been written: an egress
	 * read after this has the change in it and a later revision than any read before, which its host then ignores.
	 */
	const bumpEgress = (sandboxId: string) =>
		patchSandbox(sandboxId, (current) => ({ ...current, egressRevision: later(current.egressRevision) }));

	/** A refusal by a host that can't enforce egress grants or protected variables. */
	const unenforceable = (error: unknown) => error instanceof KantelError && error.code === "not_supported";

	/**
	 * Takes a starting or running sandbox out of service because its egress, as stored, isn't what its host enforces
	 * (its host lacks the feature, or a boot couldn't get its egress there). It is first made due to stop now, durably
	 * (`stopsAt`, with `stopFor` the reason), so that whatever happens next it is stopped: then it is stopped as the
	 * sweep stops a sandbox past its time, and a stop that doesn't reach its host (its link lost) leaves it running and
	 * due, for the sweep to stop once its host is connected (and one whose gateway went before it was carried out, once
	 * its claim on it lapses, `STOP_LEASE_MS`).
	 *
	 * Only for what was found unenforceable: the sandbox in the state and at the `egressRevision` the refused delivery
	 * (or the boot) was for. A newer egress (a clear, a boot's fresh revision) or another lifecycle step since leaves it
	 * to its own delivery, and it answers `false`. A boot gives its `placement`, written with the intent, so the stop
	 * and its retries know the host. `wait` awaits the stop (never from inside the sandbox's own queued work, which the
	 * stop queues behind).
	 */
	async function enforceStop(
		sandboxId: string,
		reason: string,
		wait: boolean,
		evaluated: Pick<StoredSandbox, "state" | "egressRevision">,
		placement?: Placement,
	): Promise<boolean> {
		const at = now();
		const due = await patchSandbox(sandboxId, (current) =>
			current.state === evaluated.state && current.egressRevision === evaluated.egressRevision
				? {
						...current,
						...(placement === undefined
							? {}
							: {
									hostId: placement.hostId,
									resources: placement.resources ?? current.resources,
									capabilities: placement.capabilities,
									...(placement.base === undefined ? {} : { base: placement.base }),
								}),
						stopsAt: at,
						stopFor: reason,
					}
				: undefined,
		);
		if (due === undefined) return false;
		const still = (current: StoredSandbox) => current.stopFor === reason;
		const began = await beginStop(due, false, reason, undefined, still, true).catch(() => undefined);
		if (began !== undefined) {
			if (wait) await began.work.catch(() => undefined);
			else keepGoing(began.work);
		}
		return true;
	}

	/** Records that a sandbox's backend took its egress at `revision`: `egressApplied` only moves on. */
	const markApplied = (sandboxId: string, revision: number | undefined) =>
		revision === undefined
			? Promise.resolve(undefined)
			: patchSandbox(sandboxId, (current) =>
					(current.egressApplied ?? Number.NEGATIVE_INFINITY) >= revision
						? undefined
						: { ...current, egressApplied: revision },
				);

	/**
	 * Sends a sandbox (as just read) its egress as it is now, and records the revision once its backend has taken it.
	 * What its egress is made of is read after the sandbox, so the revision sent is never later than what was read with
	 * it. A failure leaves `egressApplied` behind, for the sweep to send again.
	 */
	async function deliverEgress(sandbox: StoredSandbox): Promise<void> {
		const update = backend.updateEgress?.bind(backend);
		if (update === undefined) return;
		const { egress } = await egressFor(sandbox.accountId, sandbox);
		await update(sandbox.id, egress, sandbox.egressRevision);
		await markApplied(sandbox.id, sandbox.egressRevision);
	}

	/** How many sends of each sandbox's egress are under way, by ID: the sweep leaves those sandboxes be. */
	const delivering = new Map<string, number>();

	/**
	 * Sends each running sandbox its egress as it is now, to the backend, where it can take it while the sandbox runs:
	 * the sandbox is read again first. A starting one is left to its boot, which reconciles before it runs; one whose
	 * update fails (its host away) is sent again by the sweep, as it is then.
	 */
	const pushEgress = (sandboxes: readonly StoredSandbox[]) => {
		if (backend.updateEgress === undefined) return;
		for (const sandbox of sandboxes) {
			delivering.set(sandbox.id, (delivering.get(sandbox.id) ?? 0) + 1);
			const work = (async () => {
				const current = await store.sandboxes.get(sandbox.id);
				if (current === undefined || current.state !== "running") return;
				try {
					await deliverEgress(current);
				} catch (error) {
					if (!unenforceable(error)) throw error;
					// Its host can't enforce what its egress now holds (a grant written as it was placed on a host without the
					// feature): it doesn't run on without it. Stopped, its disk kept; it starts again only where it is enforced.
					await enforceStop(current.id, UNENFORCED, true, current);
				}
			})();
			keepGoing(
				work.finally(() => {
					const left = (delivering.get(sandbox.id) ?? 1) - 1;
					if (left > 0) delivering.set(sandbox.id, left);
					else delivering.delete(sandbox.id);
				}),
			);
		}
	};

	/** The sandboxes made from an environment that run, or are starting (and will reconcile when they run). */
	const liveFrom = async (environmentId: string) =>
		(await store.sandboxes.list({ environmentId })).filter(
			(sandbox) => sandbox.state === "running" || sandbox.state === "starting",
		);

	/**
	 * Tells the hosts of an environment's running sandboxes that its protected values changed, so they drop what they
	 * hold and fetch them again, and gives them its egress as it is now (the hosts to intercept, the grants). A starting
	 * one's revision moves on too, so its boot sees the change and reconciles.
	 */
	async function pushEnvironment(environmentId: string, version: number | undefined): Promise<void> {
		const live = await liveFrom(environmentId);
		const bumped = (await Promise.all(live.map((sandbox) => bumpEgress(sandbox.id)))).filter(
			(sandbox): sandbox is StoredSandbox => sandbox !== undefined,
		);
		const running = bumped.filter((sandbox) => sandbox.state === "running");
		const updateSecrets = backend.updateSecrets?.bind(backend);
		if (version !== undefined && updateSecrets !== undefined) {
			for (const sandbox of running) keepGoing(updateSecrets(sandbox.id, version));
		}
		pushEgress(running);
	}

	/**
	 * Refuses a change that needs its sandboxes' hosts to enforce egress grants or protected variables when one of them
	 * says it doesn't: it would drop them and carry on, and the change would show as applied. A sandbox on no host yet
	 * is placed only where they are enforced.
	 */
	async function requireEnforcing(sandboxes: readonly StoredSandbox[]): Promise<void> {
		const placed = sandboxes.filter(
			(sandbox) => sandbox.hostId !== undefined && (sandbox.state === "running" || sandbox.state === "starting"),
		);
		if (placed.length === 0) return;
		const { hosts } = await backend.capabilities();
		for (const sandbox of placed) {
			const host = hosts.find((each) => each.id === sandbox.hostId);
			// A backend that names no features (the stub) enforces what it is given however its sandboxes run.
			if (host?.features === undefined || host.features.includes(EGRESS_POLICY_FEATURE)) continue;
			throw new KantelError(
				"not_supported",
				`The sandbox ${sandbox.name}'s host (${host.name}) doesn't enforce egress grants or protected variables; upgrade its kantel-host first`,
			);
		}
	}

	const variableView = (variable: StoredEnvironmentVariable): computeSchema.EnvironmentVariable => ({
		name: variable.name,
		protected: variable.protected,
		// Never a protected one's: it is kept sealed, and only its sandboxes' hosts are given it.
		...(variable.protected || variable.value === undefined ? {} : { value: variable.value }),
		bindings: variable.protected ? variable.bindings.map(copyBinding) : [],
		updatedAt: variable.updatedAt,
	});

	const fileView = (file: StoredEnvironmentFile): computeSchema.EnvironmentFile => ({
		path: file.path,
		mode: file.mode,
		sizeBytes: file.sizeBytes,
		updatedAt: file.updatedAt,
	});

	async function environmentView(environment: StoredEnvironment): Promise<computeSchema.Environment> {
		const made = await store.sandboxes.list({ environmentId: environment.id });
		return {
			id: environment.id,
			accountId: environment.accountId,
			name: environment.name,
			...(environment.description === undefined ? {} : { description: environment.description }),
			variables: environment.variables.map(variableView),
			files: environment.files.map(fileView),
			repos: environment.repos.map(copyRepo),
			grants: environment.grants.map(copyGrant),
			sandboxCount: made.filter((sandbox) => sandbox.state !== "deleted").length,
			createdAt: environment.createdAt,
			updatedAt: environment.updatedAt,
		};
	}

	const egressEntryView = (entry: StoredEgressEntry): computeSchema.EgressEntry => ({
		id: entry.id,
		at: entry.at,
		method: entry.method,
		host: entry.host,
		port: entry.port,
		...(entry.path === undefined ? {} : { path: entry.path }),
		decision: entry.decision,
		...(entry.reason === undefined ? {} : { reason: entry.reason }),
		...(entry.rule === undefined ? {} : { rule: entry.rule }),
		...(entry.code === undefined ? {} : { code: entry.code }),
		swapped: [...entry.swapped],
		inspected: entry.inspected,
		...(entry.status === undefined ? {} : { status: entry.status }),
		bytesUp: entry.bytesUp,
		bytesDown: entry.bytesDown,
	});

	/** A sandbox's egress log, newest first. */
	async function egressLog(sandboxId: string): Promise<StoredEgressEntry[]> {
		const entries = await store.egress.list({ sandboxId });
		// Oldest first by arrival from the store; newest first by time, and the later arrival first of two at one time.
		return entries
			.map((entry, index) => ({ entry, index }))
			.sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
			.map(({ entry }) => entry);
	}

	async function sandboxEgressView(sandbox: StoredSandbox, limit: number): Promise<computeSchema.SandboxEgress> {
		const [environment, log] = await Promise.all([
			sandbox.environmentId === undefined ? undefined : store.environments.get(sandbox.environmentId),
			egressLog(sandbox.id),
		]);
		const protectedVariables: computeSchema.SandboxProtectedVariable[] = [];
		for (const [name, placeholder] of Object.entries(sandbox.placeholders ?? {})) {
			const variable = environment?.variables.find((each) => each.name === name && each.protected);
			// One whose variable is gone, or plain now, no longer resolves: it isn't protected any more.
			if (variable === undefined) continue;
			protectedVariables.push({
				name,
				placeholderPrefix: placeholder.slice(0, PLACEHOLDER_PREFIX_CHARS),
				bindings: variable.bindings.map(copyBinding),
			});
		}
		return {
			sandboxId: sandbox.id,
			sandboxName: sandbox.name,
			accountId: sandbox.accountId,
			...(environment === undefined ? {} : { environment: { id: environment.id, name: environment.name } }),
			protectedVariables,
			environmentGrants: (environment?.grants ?? []).map(copyGrant),
			grants: (sandbox.grants ?? []).map(copyGrant),
			entries: log.slice(0, limit).map(egressEntryView),
		};
	}

	/** An environment the caller may act on with `scope`; `not_found` when it doesn't exist or isn't in their accounts. */
	async function environmentFor(
		principal: Principal,
		environmentId: string,
		scope: computeSchema.ApiKeyScope,
	): Promise<StoredEnvironment> {
		const environment = await store.environments.get(environmentId);
		if (environment === undefined) throw notFound("environment");
		const role = await roleIn(store, principal, environment.accountId);
		if (role === undefined) throw notFound("environment");
		requireScope(principal, scope, role);
		return environment;
	}

	/** The environment a create names in an account: an environment's ID, or its name. */
	async function environmentIn(accountId: string, ref: string): Promise<StoredEnvironment> {
		const byId = await store.environments.get(ref);
		if (byId !== undefined && byId.accountId === accountId) return byId;
		const [byName] = await store.environments.list({ accountId, name: ref });
		if (byName === undefined) throw notFound(`environment ${ref}`);
		return byName;
	}

	const nameTaken = (name: string) => new KantelError("conflict", `The account has an environment named ${name}`);

	/**
	 * Makes a write that may give an environment `name`. The store refuses one that would give a second environment of
	 * the account a name (`UniqueViolation`, a unique index in SQL), in the write itself: a create or rename, on any
	 * gateway, however long after it read, never commits a name another holds, and nothing is left to recover if it
	 * dies part-way. The refusal is `conflict`.
	 */
	async function naming<T>(name: string, write: () => Promise<T>): Promise<T> {
		try {
			return await write();
		} catch (error) {
			if (error instanceof UniqueViolation) throw nameTaken(name);
			throw error;
		}
	}

	/**
	 * Replaces an account's proxy settings with `replacing` of them, only while they are still `expected` (`proxyKey`):
	 * otherwise `conflict`. Settings never written read as `unsetProxy`'s, and the first write inserts them; another
	 * writer's insert meanwhile is read and compared like any change. The settings appearing and going again and again
	 * meanwhile is a `conflict` too.
	 */
	async function replaceProxyAsRead(
		account: StoredAccount,
		expected: string,
		replacing: (existing: StoredProxy | undefined) => StoredProxy,
	): Promise<StoredProxy> {
		const what = "The proxy settings";
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await store.proxies.get(account.id);
			if (existing === undefined) {
				requireUnchanged(expected, proxyKey(proxyView(unsetProxy(account))), what);
				const settings = replacing(undefined);
				if (await store.proxies.insert(settings)) return settings;
				continue;
			}
			const changed = await store.proxies.update(account.id, (current) => {
				requireUnchanged(expected, proxyKey(proxyView(current)), what);
				return replacing(current);
			});
			if (changed !== undefined) return changed;
		}
		throw new KantelError("conflict", `${what} keep changing; read them again and redo the change`);
	}

	/** Changes an environment with `update`, answering it as written; `not_found` when it went meanwhile. */
	async function changeEnvironment(
		environmentId: string,
		change: (current: StoredEnvironment) => StoredEnvironment,
	): Promise<StoredEnvironment> {
		const changed = await store.environments.update(environmentId, change);
		if (changed === undefined) throw notFound("environment");
		return changed;
	}

	/**
	 * Writes an environment's secret files into a sandbox that has just started, then clones its repositories (through
	 * the sandbox's egress proxy, so a protected token bound to the repository's host is swapped in). A failure is an
	 * event on the sandbox, which keeps running: what failed is named, never a file's contents.
	 *
	 * `authorised` is the environment as the create read it, when it checked that its caller may run commands (a clone
	 * runs with the sandbox's env, which that caller chose): its repositories are cloned, not any added since, which no
	 * one's authority covers. The files are the environment's as it is now (a rotation meanwhile is taken).
	 */
	async function provision(sandbox: StoredSandbox, authorised: StoredEnvironment): Promise<void> {
		const latest = await store.environments.get(authorised.id);
		if (latest === undefined) return;
		const environment = { ...latest, repos: authorised.repos };
		const degraded = (reason: string) =>
			emit("sandbox.degraded", sandbox.accountId, { sandbox, data: { reason } }).catch(() => undefined);
		for (const file of environment.files) {
			try {
				const bytes = await requireSealer().open(file.sealed, fileAad(environment.id, file.path));
				await backend.writeFile(sandbox.id, file.path, bytes, file.mode);
			} catch (error) {
				await degraded(`The environment's secret file ${file.path} wasn't written: ${messageOf(error)}`);
			}
		}
		for (const repo of environment.repos) {
			const path = clonePath(repo);
			// Git reads no token from the environment: a credential helper answers with the placeholder of the protected
			// variable bound to the repository, which the host's proxy swaps for the token inside Basic auth.
			const credential = repoCredential(environment, repo, sandbox.placeholders ?? {});
			const command = [
				"git",
				...(credential === undefined ? [] : gitCredentialArgs(credential)),
				"clone --depth 1",
				...(repo.ref === undefined ? [] : [`--branch ${shellWord(repo.ref)}`]),
				"--",
				shellWord(repo.url),
				shellWord(path),
			].join(" ");
			try {
				const result = await backend.exec(sandbox.id, {
					command,
					// No terminal to ask on: a repository that wants a login fails at once, saying so.
					env: { ...sandbox.env, GIT_TERMINAL_PROMPT: "0" },
					timeoutMs: CLONE_TIMEOUT_MS,
				});
				if (result.exitCode !== 0 || result.timedOut) {
					const why = result.timedOut
						? "it took too long"
						: clip(result.stderr.trim(), 500) || `exit ${result.exitCode}`;
					await degraded(`The environment's repository ${repo.url} wasn't cloned into ${path}: ${why}`);
				}
			} catch (error) {
				await degraded(`The environment's repository ${repo.url} wasn't cloned into ${path}: ${messageOf(error)}`);
			}
		}
	}

	const inviteView = (invite: StoredInvite, code?: string): computeSchema.Invite => ({
		id: invite.id,
		accountId: invite.accountId,
		role: invite.role,
		email: invite.email,
		code,
		expiresAt: invite.expiresAt,
		createdAt: invite.createdAt,
	});

	const accountView = (account: StoredAccount, role: MemberRole): computeSchema.Account => ({
		id: account.id,
		kind: account.kind,
		name: account.name,
		role,
		defaultVisibility: account.defaultVisibility,
		createdAt: account.createdAt,
	});

	async function hostView(host: StoredHost): Promise<computeSchema.Host> {
		const placed = (await store.sandboxes.list({ hostId: host.id })).filter(
			(sandbox) => sandbox.state === "running" || sandbox.state === "starting" || sandbox.state === "paused",
		);
		const sum = (pickOf: (sandbox: StoredSandbox) => number) =>
			placed.reduce((total, sandbox) => total + pickOf(sandbox), 0);
		return {
			...host,
			allocated: {
				sandboxes: placed.length,
				vcpus: sum((sandbox) => sandbox.resources?.vcpus ?? 0),
				memoryMb: sum((sandbox) => sandbox.resources?.memoryMb ?? 0),
				diskGb: sum((sandbox) => sandbox.resources?.diskGb ?? 0),
			},
		};
	}

	const fileEntry = (entry: BackendFileEntry): computeSchema.FileEntry => ({
		name: entry.name,
		path: entry.path,
		kind: entry.kind,
		size: entry.size,
		modifiedAt: entry.modifiedAt,
	});

	const actorOf = (principal: Principal): Sandbox["createdBy"] =>
		principal.kind === "key"
			? { kind: "api_key", id: principal.keyId, name: principal.keyName }
			: { kind: "user", id: principal.userId, name: principal.name };

	// Events.

	async function emit(
		type: EventType,
		accountId: string,
		fields: { sandbox?: StoredSandbox; snapshotId?: string; data?: EventData },
	): Promise<void> {
		const { sandbox } = fields;
		const event: computeSchema.Event = {
			id: randomId("evt"),
			type,
			accountId,
			createdAt: now(),
			sandboxId: sandbox?.id,
			snapshotId: fields.snapshotId,
			data: {
				...(sandbox === undefined ? {} : { name: sandbox.name, state: sandbox.state }),
				...fields.data,
			},
		};
		// The webhooks are looked up while the event is written, but a delivery is queued only once the event is stored.
		const written = store.events.put(event);
		await Promise.all([written, dispatcher.enqueue(event, written).catch(() => undefined)]);
		exporter.record({ event, sandboxType: sandbox?.type });
	}

	// Sandbox records.

	async function mustGetSandbox(id: string): Promise<StoredSandbox> {
		const sandbox = await store.sandboxes.get(id);
		if (sandbox === undefined) throw notFound("sandbox");
		return sandbox;
	}

	/**
	 * Moves a sandbox on with `update`, only while it is still in one of the states `from`: so of two calls racing on
	 * different gateways (or a stale background step and a newer call) only the first wins, and the other loses cleanly.
	 * Answers the sandbox as written, or `lost` with the sandbox as it is when it had already moved on (or `still` says
	 * no).
	 */
	async function transition(
		sandboxId: string,
		from: SandboxState | readonly SandboxState[],
		next: (current: StoredSandbox) => StoredSandbox,
		still: (current: StoredSandbox) => boolean = () => true,
		expected?: StoredSandbox,
	): Promise<{ readonly moved: StoredSandbox } | { readonly lost: StoredSandbox }> {
		const allowed: readonly SandboxState[] = typeof from === "string" ? [from] : from;
		let seen: StoredSandbox | undefined;
		// With `expected` (the record as this call wrote it), the store may skip reading it: see `Collection.update`.
		const moved = await store.sandboxes.update(
			sandboxId,
			(current) => {
				seen = current;
				return allowed.includes(current.state) && still(current) ? next(current) : undefined;
			},
			expected,
		);
		if (moved !== undefined) return { moved };
		if (seen === undefined) throw notFound("sandbox");
		return { lost: seen };
	}

	/** Changes a sandbox's fields other than its state with `update`, so it never writes over a newer state. */
	const patchSandbox = (sandboxId: string, change: (current: StoredSandbox) => StoredSandbox | undefined) =>
		store.sandboxes.update(sandboxId, change);

	/** The sandbox in a new state, with its run periods, stop time and timestamps kept in step. */
	function withState(sandbox: StoredSandbox, state: SandboxState, extra: Partial<StoredSandbox> = {}): StoredSandbox {
		const at = now();
		const wasRunning = sandbox.state === "running";
		const running = state === "running";
		let runs = sandbox.runs;
		if (wasRunning && !running) runs = runs.map((run) => (run.to === undefined ? { ...run, to: at } : run));
		if (!wasRunning && running) runs = [...runs, { from: at }];
		const autoStop = extra.autoStopMinutes === undefined ? sandbox.autoStopMinutes : extra.autoStopMinutes;
		return {
			...sandbox,
			...extra,
			state,
			runs,
			stopsAt: !running
				? undefined
				: wasRunning
					? sandbox.stopsAt
					: autoStop === null
						? undefined
						: at + autoStop * 60_000,
			startedAt: running && !wasRunning ? at : sandbox.startedAt,
			stoppedAt: state === "stopped" || state === "paused" ? at : sandbox.stoppedAt,
			reason: extra.reason,
			// A stop it was due for is done with once it boots again.
			...(state === "starting" ? { stopFor: undefined } : {}),
		};
	}

	/** Whether the caller may see a sandbox in an account where they have `role`. */
	async function canSee(principal: Principal, sandbox: StoredSandbox, role: MemberRole): Promise<boolean> {
		if (principal.kind === "key" && principal.limits.sandboxIds !== undefined) {
			const madeByKey = sandbox.createdBy.kind === "api_key" && sandbox.createdBy.id === principal.keyId;
			if (!principal.limits.sandboxIds.includes(sandbox.id) && !madeByKey) return false;
		}
		if (sandbox.visibility === "organisation" || sandbox.ownerUserId === principal.userId) return true;
		// A private sandbox whose person has left its organisation is left for an admin to delete or share.
		if (role === "member") return false;
		return (await store.members.get(memberId(sandbox.accountId, sandbox.ownerUserId))) === undefined;
	}

	/** A sandbox the caller may see, checked for `scope`; `not_found` when it is deleted, unless `deleted` allows it. */
	async function sandboxFor(
		principal: Principal,
		sandboxId: string,
		scope: computeSchema.ApiKeyScope,
		deleted = false,
	): Promise<{ sandbox: StoredSandbox; role: MemberRole }> {
		const sandbox = await store.sandboxes.get(sandboxId);
		if (sandbox === undefined || (!deleted && sandbox.state === "deleted")) throw notFound("sandbox");
		const role = await roleIn(store, principal, sandbox.accountId);
		if (role === undefined || !(await canSee(principal, sandbox, role))) throw notFound("sandbox");
		requireScope(principal, scope, role);
		await refuseShared(principal, sandbox);
		return { sandbox, role };
	}

	/**
	 * Refuses someone kept off the shared hosts (`mayShare`) a sandbox on one, though a member shared its account. A
	 * sandbox with no host yet passes, so whatever then waits on it checks again once it is placed (`settledFor`): a
	 * create or start under way may put it on a shared host before the caller's call reaches it.
	 */
	async function refuseShared(principal: Principal, sandbox: StoredSandbox): Promise<void> {
		if (sandbox.hostId === undefined || (await mayShare(principal))) return;
		const host = (await ensureHosts()).find((known) => known.id === sandbox.hostId);
		if (host?.accountId === undefined) throw new KantelError("forbidden", SHARED_HOSTS_REFUSED);
	}

	/** The sandbox once its queued operations end (a placement among them), checked again with `refuseShared`. */
	async function settledFor(principal: Principal, sandboxId: string): Promise<StoredSandbox> {
		await settledOn(sandboxId);
		const sandbox = await mustGetSandbox(sandboxId);
		await refuseShared(principal, sandbox);
		return sandbox;
	}

	/** Refuses a desktop or browser the sandbox doesn't have, with its image's reason where it reported one. */
	function requireScreen(sandbox: StoredSandbox, screen: "desktop" | "browser"): void {
		if (sandbox.capabilities[screen]) return;
		throw new KantelError(
			"not_supported",
			sandbox.type === "microvm"
				? (sandbox.capabilities.guest?.[screen].reason ?? `No ${screen} in this image`)
				: `The ${screen} needs a microVM; this is an isolate`,
		);
	}

	/** `settledFor`, refused with `conflict` unless the sandbox is running. */
	async function requireRunning(principal: Principal, sandboxId: string): Promise<StoredSandbox> {
		const sandbox = await settledFor(principal, sandboxId);
		if (sandbox.state !== "running") {
			throw new KantelError("conflict", `The sandbox is ${sandbox.state}; it must be running (resume it first)`);
		}
		return sandbox;
	}

	async function requireCapacity(accountId: string, adding: number): Promise<void> {
		if (limits.concurrentSandboxes === undefined) return;
		const active = (await store.sandboxes.list({ accountId })).filter(
			(sandbox) => sandbox.state === "starting" || sandbox.state === "running" || sandbox.state === "stopping",
		).length;
		if (active + adding > limits.concurrentSandboxes) {
			throw new KantelError("exhausted", `The account may run ${limits.concurrentSandboxes} sandboxes at once`);
		}
	}

	/**
	 * The snapshot a start or recovery makes the sandbox from: its newest, or, when it was never placed (its create or
	 * fork failed), the one it was to be made from. A sandbox made from another that has no such snapshot (a running
	 * sandbox's fork) can't be made again here, so it is refused rather than started empty under its source's name; the
	 * same keeps an account's own host's snapshot with the host (routed there, or refused while it is unreachable).
	 */
	async function latestRef(sandbox: StoredSandbox): Promise<string | undefined> {
		if (sandbox.latestSnapshotId !== undefined) return (await store.snapshots.get(sandbox.latestSnapshotId))?.ref;
		if (!neverPlaced(sandbox)) return undefined;
		const from = sandbox.source?.snapshotId;
		const source = from === undefined ? undefined : await store.snapshots.get(from);
		if (source === undefined) throw new KantelError("conflict", NEVER_MADE);
		return readyRef(source);
	}

	/** A sandbox made from another whose making failed: no backend has it, and it has no snapshot of its own. */
	const neverPlaced = (sandbox: StoredSandbox): boolean =>
		sandbox.hostId === undefined && sandbox.latestSnapshotId === undefined && sandbox.source !== undefined;

	/**
	 * Boots a sandbox for a start or recovery with `boot`: `booted` where a backend has it, or, when it was never placed
	 * (`latestRef`), made as its create would make it, from its source's snapshot, since no backend has it to start.
	 */
	function bootAgain(
		sandbox: StoredSandbox,
		boot: BootOptions,
		booted: (boot: BootOptions) => Promise<Placement>,
	): Promise<Placement> {
		if (!neverPlaced(sandbox)) return booted(boot);
		return backend.create({
			...boot,
			sandboxId: sandbox.id,
			accountId: sandbox.accountId,
			type: sandbox.type,
			subdomain: sandbox.subdomain,
			...(sandbox.image === undefined ? {} : { image: sandbox.image }),
		});
	}

	/** Lets the backend drop a snapshot's bytes once no snapshot record shares them. */
	async function releaseRef(ref: string | undefined): Promise<void> {
		if (ref === undefined) return;
		if ((await store.snapshots.list({ ref })).length > 0) return;
		await backend.deleteSnapshot(ref).catch(() => undefined);
	}

	/** Marks a sandbox's running commands killed, and kills the detached ones. */
	async function killCommandsOf(sandboxId: string): Promise<void> {
		for (const command of await store.commands.list({ sandboxId, state: "running" })) {
			runningCommands.get(command.id)?.abort();
			runningCommands.delete(command.id);
			const at = now();
			await store.commands.put({ ...command, state: "killed", endedAt: at, durationMs: at - command.startedAt });
		}
	}

	/**
	 * Boots a sandbox in `starting` with `run`, and records `running`, or `error` when it fails; either only while it is
	 * still `starting`, so a delete that landed meanwhile (on any gateway) is kept.
	 */
	async function boot(
		sandboxId: string,
		run: () => Promise<Placement>,
		written?: StoredSandbox,
		/** The `egressRevision` of the egress `run` sent, read before it. */
		sent?: { readonly egressRevision: number | undefined },
	): Promise<StoredSandbox | undefined> {
		let placement: Placement;
		try {
			placement = await run();
		} catch (error) {
			return fail(sandboxId, error, "starting");
		}
		// The revision its backend has: what the boot sent, or what reconciling sent since.
		let applied = sent?.egressRevision;
		const toRunning = (sandbox: StoredSandbox) =>
			withState(sandbox, "running", {
				hostId: placement.hostId,
				resources: placement.resources ?? sandbox.resources,
				capabilities: placement.capabilities,
				health: "ok",
				// What its root file system is now (a rebase moves it on); a backend that doesn't say leaves what it was.
				...(placement.base === undefined ? {} : { base: placement.base }),
				...(applied === undefined || (sandbox.egressApplied ?? Number.NEGATIVE_INFINITY) >= applied
					? {}
					: { egressApplied: applied }),
			});
		const reconciles = sent !== undefined && backend.updateEgress !== undefined;
		// Running only if its egress is what its backend has (what the boot sent, at first), on every move to running:
		// the usual case, in one write.
		const upToDate = (sandbox: StoredSandbox) => !reconciles || sandbox.egressRevision === applied;
		let result = await transition(sandboxId, "starting", toRunning, upToDate, written);
		// What its egress is made of changed while it started (a grant, its environment, the proxy settings): a change
		// skips a starting sandbox, so it is sent now, before it is running, and again for each change made while that
		// was sent. One whose egress can't be got there (its host can't enforce it, or it fails or keeps changing for
		// every round) never runs: it is stopped, as `enforceStop` does, never given up on.
		for (let round = 0; "lost" in result && result.lost.state === "starting"; round++) {
			const lost = result.lost;
			if (round >= BOOT_RECONCILE_ROUNDS) {
				const reason = "Its egress couldn't be applied to it while it started";
				if (await enforceStop(sandboxId, reason, false, lost, placement)) return undefined;
				result = await transition(sandboxId, "starting", toRunning, upToDate);
				continue;
			}
			try {
				await deliverEgress(lost);
				applied = lost.egressRevision;
			} catch (error) {
				// Refused for the egress it has still: stopped. One changed since is sent next round.
				if (unenforceable(error) && (await enforceStop(sandboxId, UNENFORCED, false, lost, placement))) {
					return undefined;
				}
				// A call that didn't get through: tried again, a moment on.
				await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** round));
			}
			result = await transition(sandboxId, "starting", toRunning, upToDate);
		}
		if (!("moved" in result)) return undefined;
		const next = result.moved;
		// Changed again while that was sent: now it runs, an ordinary update.
		if (sent !== undefined && next.egressRevision !== applied) pushEgress([next]);
		await emit("sandbox.running", next.accountId, { sandbox: next, data: { previousState: "starting" } });
		return next;
	}

	/**
	 * Records `error` for work that failed, only while the sandbox is still in `from`, the passing state that work set: a
	 * stale step that lost to another call (a second stop, a delete) never writes `error` over the state that call left.
	 */
	async function fail(sandboxId: string, error: unknown, from: SandboxState): Promise<StoredSandbox | undefined> {
		const reason = messageOf(error);
		const result = await transition(sandboxId, from, (sandbox) => withState(sandbox, "error", { reason })).catch(
			() => undefined,
		);
		if (result === undefined || !("moved" in result)) return undefined;
		const next = result.moved;
		await emit("sandbox.error", next.accountId, { sandbox: next, data: { previousState: from, reason } });
		return next;
	}

	/**
	 * Puts a running (or paused) sandbox in `stopping` and stops or pauses it in the background; answers once it is
	 * `stopping`, with the work (wrapped, so awaiting the answer doesn't await the work). The move is conditional on the
	 * state `sandbox` was read in: when another call (on any gateway) moved it first, it is `conflict` and nothing is
	 * stopped.
	 */
	async function beginStop(
		sandbox: StoredSandbox,
		keepMemory: boolean,
		reason: string | undefined,
		actor: Principal | undefined,
		still?: (current: StoredSandbox) => boolean,
		handBack = false,
	): Promise<{ readonly work: Promise<void> }> {
		const began = await transition(
			sandbox.id,
			sandbox.state,
			(current) => withState(current, "stopping", current.stopFor === undefined ? {} : { stopClaimedAt: now() }),
			still,
		);
		if (!("moved" in began)) throw new KantelError("conflict", `The sandbox is ${began.lost.state}`);
		const work = track([sandbox.id], async () => {
			try {
				await killCommandsOf(sandbox.id);
				const taken = await backend.stop(sandbox.id, { keepMemory });
				const at = now();
				const snapshot: StoredSnapshot = {
					id: randomId("snap"),
					accountId: sandbox.accountId,
					kind: "automatic",
					sandboxId: sandbox.id,
					sandboxType: sandbox.type,
					state: "ready",
					trigger: "stop",
					memory: keepMemory,
					sizeBytes: taken.sizeBytes,
					createdAt: at,
					expiresAt: at + AUTOMATIC_SNAPSHOT_TTL_MS,
					ref: taken.ref,
					...(taken.base === undefined ? {} : { base: taken.base }),
				};
				await store.snapshots.put(snapshot);
				const result = await transition(sandbox.id, "stopping", (current) =>
					withState(current, keepMemory ? "paused" : "stopped", {
						latestSnapshotId: snapshot.id,
						ports: [],
						pausedSnapshotId: keepMemory ? snapshot.id : undefined,
					}),
				);
				if (!("moved" in result)) return;
				const next = result.moved;
				await emit(keepMemory ? "sandbox.paused" : "sandbox.stopped", next.accountId, {
					sandbox: next,
					data: {
						previousState: sandbox.state,
						...(reason === undefined ? {} : { reason }),
						...(actor === undefined ? {} : { actor: actorOf(actor) }),
					},
				});
			} catch (error) {
				if (handBack && error instanceof KantelError && error.code === "unavailable") {
					// The stop wasn't carried out (its host away, its connection lost or replaced on the way, a replica's view of
					// it stale, no answer in time), so the machine may still be running there: it is running again as it was
					// (its stop time and run unchanged), for a later sweep to stop. What the host refused outright (`conflict`,
					// `not_found`, ...) is an error as before. It is decided by the failure, not by whether the host is connected
					// by now, which a reconnection or a stale view could answer either way.
					await transition(sandbox.id, "stopping", (current) => ({
						...current,
						state: "running",
						runs: sandbox.runs,
						stopsAt: sandbox.stopsAt,
						reason: undefined,
					}));
					return;
				}
				await fail(sandbox.id, error, "stopping");
				throw error;
			}
		});
		return { work };
	}

	/** The backend's connected hosts now: the stub's always are. */
	async function connectedHosts(): Promise<Set<string>> {
		const { hosts } = await backend.capabilities();
		return new Set(hosts.filter((host) => host.connected !== false).map((host) => host.id));
	}

	/** The snapshot `from` names in an account: a snapshot's ID, or a saved snapshot's name. */
	async function snapshotFrom(principal: Principal, accountId: string, from: string): Promise<StoredSnapshot> {
		const byId = await store.snapshots.get(from);
		if (byId !== undefined && byId.accountId === accountId && (await canSeeSnapshot(principal, byId))) {
			if (byId.state !== "ready" || byId.ref === undefined)
				throw new KantelError("conflict", "The snapshot isn't ready");
			return byId;
		}
		const [byName] = await store.snapshots.list({ accountId, kind: "saved", name: from });
		if (byName === undefined || byName.ref === undefined) throw notFound(`snapshot named ${from}`);
		return byName;
	}

	async function canSeeSnapshot(principal: Principal, snapshot: StoredSnapshot): Promise<boolean> {
		const role = await roleIn(store, principal, snapshot.accountId);
		if (role === undefined) return false;
		if (snapshot.kind === "saved" || snapshot.sandboxId === undefined) return true;
		const sandbox = await store.sandboxes.get(snapshot.sandboxId);
		return sandbox === undefined || (await canSee(principal, sandbox, role));
	}

	async function snapshotFor(
		principal: Principal,
		snapshotId: string,
		scope: computeSchema.ApiKeyScope,
	): Promise<StoredSnapshot> {
		const snapshot = await store.snapshots.get(snapshotId);
		if (snapshot === undefined || !(await canSeeSnapshot(principal, snapshot))) throw notFound("snapshot");
		requireScope(principal, scope, (await roleIn(store, principal, snapshot.accountId)) ?? "member");
		return snapshot;
	}

	const readyRef = (snapshot: StoredSnapshot): string => {
		if (snapshot.state !== "ready" || snapshot.ref === undefined) {
			throw new KantelError("conflict", "The snapshot isn't ready");
		}
		return snapshot.ref;
	};

	async function apiKeyFor(principal: Principal, apiKeyId: string, scope: computeSchema.ApiKeyScope) {
		const key = await store.apiKeys.get(apiKeyId);
		const role = key === undefined ? undefined : await roleIn(store, principal, key.accountId);
		if (key === undefined || role === undefined) throw notFound("API key");
		requireScope(principal, scope, role);
		return key;
	}

	async function webhookFor(principal: Principal, webhookId: string): Promise<StoredWebhook> {
		const webhook = await store.webhooks.get(webhookId);
		const role = webhook === undefined ? undefined : await roleIn(store, principal, webhook.accountId);
		if (webhook === undefined || role === undefined) throw notFound("webhook");
		requireScope(principal, "account:admin", role);
		return webhook;
	}

	async function hostFor(principal: Principal, hostId: string): Promise<StoredHost> {
		requireScope(principal, "hosts:admin");
		const host = (await ensureHosts()).find((known) => known.id === hostId);
		if (host === undefined) throw notFound("host");
		return host;
	}

	const requireAccountHosts = () => {
		if (options.accountHosts !== true) {
			throw new KantelError("not_supported", "Account hosts are off on this deployment (KANTEL_ACCOUNT_HOSTS)");
		}
	};

	/**
	 * One of an account's own hosts, for a caller in that account with `scope`. A host of an account the caller isn't
	 * in, and a shared host, are `not_found`, so a host's existence isn't given away.
	 */
	async function accountHostFor(
		principal: Principal,
		hostId: string,
		scope: "account:read" | "account:admin",
	): Promise<{ host: StoredHost; acting: Acting }> {
		requireAccountHosts();
		const host = (await ensureHosts()).find((known) => known.id === hostId);
		if (host?.accountId === undefined) throw notFound("host");
		const acting = await accountById(store, principal, host.accountId).catch(() => {
			throw notFound("host");
		});
		requireScope(principal, scope, acting.role);
		return { host, acting };
	}

	/** A join token, shown once, and its command; an account's joins the host to `owner.accountId`. */
	/**
	 * Where hosts reach this control plane: the URL a super-admin set in the console, else the deployment's own
	 * (`publicUrl`, or the address the call came in at).
	 */
	async function publicUrlView(request: Request): Promise<computeSchema.PublicUrl> {
		const deploymentUrl = (options.publicUrl ?? new URL(request.url).origin).replace(/\/+$/, "");
		const set = await store.settings.get("publicUrl");
		const publicUrl = set?.value ?? deploymentUrl;
		return {
			publicUrl,
			source: set === undefined ? "deployment" : "console",
			deploymentUrl,
			loopback: isLoopbackUrl(publicUrl),
		};
	}

	async function mintJoinToken(
		body: {
			readonly name?: string;
			readonly labels?: { readonly [key: string]: string };
			readonly expiresInMinutes?: number;
		},
		request: Request,
		owner?: { readonly accountId: string; readonly createdBy: string },
	): Promise<computeSchema.HostJoinToken> {
		const token = randomSecret("kth_", 32);
		const expiresAt = now() + (body.expiresInMinutes ?? 60) * 60_000;
		const id = randomId(owner === undefined ? "hjt" : "enr");
		await store.joinTokens.put({
			id,
			tokenHash: await sha256Hex(token),
			name: body.name,
			labels: { ...body.labels },
			expiresAt,
			createdAt: now(),
			...(owner === undefined ? {} : { accountId: owner.accountId, createdBy: owner.createdBy }),
		});
		const { publicUrl } = await publicUrlView(request);
		return {
			id,
			token,
			command: (options.hostJoinCommand ?? DEFAULT_HOST_JOIN_COMMAND)
				.replaceAll("{url}", publicUrl)
				.replaceAll("{token}", token),
			expiresAt,
		};
	}

	async function changeHost(
		host: StoredHost,
		body: {
			readonly name?: string;
			readonly labels?: { readonly [key: string]: string };
			readonly draining?: boolean;
		},
	): Promise<computeSchema.Host> {
		if (host.state === "revoked") throw new KantelError("conflict", "The host is revoked");
		await backend.updateHost?.(host.id, {
			...(body.name === undefined ? {} : { name: body.name }),
			...(body.labels === undefined ? {} : { labels: { ...body.labels } }),
			...(body.draining === undefined ? {} : { draining: body.draining }),
		});
		// On the record as it is now: a revocation that landed meanwhile stays (and the change is refused).
		let revoked = false;
		const updated = await store.hosts.update(host.id, (current) => {
			revoked = current.state === "revoked";
			if (revoked) return undefined;
			let state = current.state;
			if (body.draining === true) state = "draining";
			if (body.draining === false && current.state === "draining") state = "online";
			return {
				...current,
				name: body.name ?? current.name,
				labels: body.labels === undefined ? current.labels : { ...body.labels },
				state,
			};
		});
		if (revoked) throw new KantelError("conflict", "The host is revoked");
		if (updated === undefined) throw new KantelError("not_found", "No such host");
		return hostView(updated);
	}

	async function revokeStoredHost(host: StoredHost): Promise<computeSchema.Host> {
		if (backend.revokeHost !== undefined) await backend.revokeHost(host.id);
		else if (!(await backend.capabilities()).hosts.some((known) => known.id === host.id)) {
			// Its credential is with a backend that isn't running here now (account hosts, switched off): marked revoked,
			// it would still sign in once that backend is back.
			throw new KantelError("unavailable", HOST_NOT_REVOCABLE);
		}
		const revoked = await store.hosts.update(host.id, (current) => ({ ...current, state: "revoked" }));
		return hostView(revoked ?? { ...host, state: "revoked" });
	}

	/**
	 * Takes the key's claim for `claim`: inserts it, or takes over one whose holder stopped renewing it. Answers the first
	 * call's answer when there is one, `true` when the claim is now `claim`'s, and refuses with `conflict` while another
	 * call holds it.
	 */
	async function claimKey(id: string, claim: string): Promise<{ readonly body: string } | true> {
		const claimed = () => ({ id, createdAt: now(), claim, claimExpiresAt: now() + IDEMPOTENCY_CLAIM_MS });
		// Twice at most: the claim may be released (its call failed) between the insert and the read.
		for (let attempt = 0; attempt < 2; attempt++) {
			if (await store.idempotency.insert(claimed())) return true;
			let answered: string | undefined;
			let seen = false;
			const taken = await store.idempotency.update(id, (current) => {
				seen = true;
				answered = current.body;
				if (current.body !== undefined || (current.claimExpiresAt ?? 0) > now()) return undefined;
				return claimed();
			});
			if (answered !== undefined) return { body: answered };
			if (taken !== undefined) return true;
			if (seen) break;
		}
		throw new KantelError(
			"conflict",
			"A call with this Idempotency-Key is still in progress; retry it once that call has answered",
		);
	}

	/**
	 * Answers an idempotent call's first answer again for the same caller, operation and key, on every gateway. The key is
	 * claimed before the work starts, so only one call does it: a call with the same key while it works waits for it on
	 * this gateway, and is `conflict` on another. The claim is renewed while the work runs and lapses
	 * `IDEMPOTENCY_CLAIM_MS` after the last renewal, so a gateway that died mid-call frees the key within that. A call that
	 * fails releases the key, so a retry does the work again.
	 */
	async function once<T>(
		principal: Principal,
		operation: string,
		key: string | undefined,
		work: () => Promise<T>,
	): Promise<T> {
		if (key === undefined) return work();
		const caller = principal.kind === "key" ? `key:${principal.keyId}` : `user:${principal.userId}`;
		const id = `${caller}:${operation}:${key}`;
		const running = inflight.get(id);
		if (running !== undefined) return running as Promise<T>;
		const promise = (async () => {
			const claim = randomId("claim");
			const held = await claimKey(id, claim);
			if (held !== true) return JSON.parse(held.body) as T;
			const renew = setInterval(() => {
				void store.idempotency
					.update(id, (current) =>
						current.claim === claim && current.body === undefined
							? { ...current, claimExpiresAt: now() + IDEMPOTENCY_CLAIM_MS }
							: undefined,
					)
					.catch(() => undefined);
			}, IDEMPOTENCY_RENEW_MS);
			(renew as { unref?: () => void }).unref?.();
			let answer: T;
			try {
				answer = await work();
			} catch (error) {
				clearInterval(renew);
				await store.idempotency.delete(id).catch(() => undefined);
				throw error;
			}
			clearInterval(renew);
			await store.idempotency.put({ id, body: JSON.stringify(answer), createdAt: now() });
			return answer;
		})();
		inflight.set(id, promise);
		try {
			return await promise;
		} finally {
			inflight.delete(id);
		}
	}

	async function recordSample(sandboxId: string): Promise<TelemetryUsageSample | undefined> {
		const sandbox = await store.sandboxes.get(sandboxId);
		if (sandbox === undefined || sandbox.state !== "running") return undefined;
		const reading = await backend.usage(sandboxId).catch(() => undefined);
		if (reading === undefined) return undefined;
		const at = now();
		const written = await patchSandbox(sandboxId, (latest) =>
			latest.state !== "running"
				? undefined
				: {
						...latest,
						samples: [...latest.samples, { at, cpu: reading.cpu, memoryMb: reading.memoryBytes / (1024 * 1024) }].slice(
							-MAX_SAMPLES,
						),
					},
		);
		if (written === undefined) return undefined;
		return {
			accountId: sandbox.accountId,
			sandboxId,
			sandboxType: sandbox.type,
			cpu: reading.cpu,
			memoryBytes: reading.memoryBytes,
			runningSeconds: runningMs(sandbox.runs, 0, at) / 1000,
			at,
			startedAt: sandbox.startedAt,
		};
	}

	/** The cost and running time of an account's sandboxes since `since`. */
	async function accountUsage(account: StoredAccount, since: number) {
		const sandboxes = await store.sandboxes.list({ accountId: account.id });
		const at = now();
		let seconds = 0;
		let total = 0;
		for (const sandbox of sandboxes) {
			const ran = runningMs(sandbox.runs, since, at) / 1000;
			seconds += ran;
			total += (ran / 3600) * rateOf(sandbox);
		}
		const hasLimits =
			limits.concurrentSandboxes !== undefined ||
			limits.startsPerMinute !== undefined ||
			limits.savedSnapshots !== undefined;
		return {
			accountId: account.id,
			since,
			running: sandboxes.filter((sandbox) => sandbox.state === "running").length,
			runningSeconds: round(seconds),
			cost: { currency: rates.currency, total: round(total), ratePerHour: 0 },
			limits: hasLimits ? { ...limits } : undefined,
		};
	}

	async function membersView(accountId: string): Promise<computeSchema.Member[]> {
		const members: computeSchema.Member[] = [];
		for (const member of await store.members.list({ accountId })) {
			const user = await store.users.get(member.userId);
			members.push({
				userId: member.userId,
				name: user?.name ?? member.userId,
				email: user?.email,
				role: member.role,
				joinedAt: member.joinedAt,
			});
		}
		return members;
	}

	async function accountsOf(principal: Principal): Promise<computeSchema.Account[]> {
		if (principal.kind === "key") {
			const account = await store.accounts.get(principal.accountId);
			const role = await roleIn(store, principal, principal.accountId);
			return account === undefined || role === undefined ? [] : [accountView(account, role)];
		}
		const accounts: computeSchema.Account[] = [];
		for (const member of await store.members.list({ userId: principal.userId })) {
			const account = await store.accounts.get(member.accountId);
			if (account !== undefined) accounts.push(accountView(account, member.role));
		}
		return accounts.sort((a, b) =>
			a.id === principal.personalAccountId ? -1 : b.id === principal.personalAccountId ? 1 : a.createdAt - b.createdAt,
		);
	}

	const requireOrganisation = (acting: Acting) => {
		if (acting.account.kind !== "organisation") {
			throw new KantelError("invalid", "A personal account has no other members");
		}
	};

	const ownerCount = async (accountId: string) => (await store.members.list({ accountId, role: "owner" })).length;

	// Device sign-ins.

	const deviceLoginView = (login: StoredDeviceLogin): computeSchema.DeviceLoginRequest => ({
		userCode: login.userCode,
		clientName: login.clientName,
		state: login.state === "pending" && login.expiresAt <= now() ? "expired" : login.state,
		createdAt: login.createdAt,
		expiresAt: login.expiresAt,
	});

	/** The pending sign-in a person typed or followed the code of; `not_found` for an unknown or finished one. */
	async function pendingDeviceLogin(userCode: string): Promise<StoredDeviceLogin> {
		const typed = userCode.toUpperCase().replace(/[^A-Z]/g, "");
		const code = typed.length === 8 ? `${typed.slice(0, 4)}-${typed.slice(4)}` : userCode;
		const [login] = await store.deviceLogins.list({ userCode: code });
		if (login === undefined || login.expiresAt <= now()) throw new KantelError("not_found", "No such sign-in code");
		return login;
	}

	const publicHandlers: RouteHandlers<PublicComputeRoutes, undefined> = {
		startDeviceLogin: async (_none, { body }, request) => {
			const at = now();
			let waiting = 0;
			for (const login of await store.deviceLogins.list()) {
				if (login.expiresAt <= at) await store.deviceLogins.delete(login.id);
				else if (login.state === "pending") waiting++;
			}
			if (waiting >= MAX_PENDING_DEVICE_LOGINS) {
				throw new KantelError("exhausted", "Too many sign-ins are waiting; try again in a few minutes");
			}
			const deviceCode = randomSecret("kdc_", 40);
			let userCode = randomUserCode();
			while ((await store.deviceLogins.list({ userCode })).length > 0) userCode = randomUserCode();
			const login: StoredDeviceLogin = {
				id: await sha256Hex(deviceCode),
				userCode,
				clientName: body.clientName ?? "kantel",
				state: "pending",
				createdAt: at,
				expiresAt: at + DEVICE_LOGIN_TTL_MS,
			};
			await store.deviceLogins.put(login);
			const publicUrl = (options.publicUrl ?? new URL(request.url).origin).replace(/\/+$/, "");
			const verificationUrl = (options.deviceLoginUrl ?? DEFAULT_DEVICE_LOGIN_URL).replaceAll("{url}", publicUrl);
			const complete = new URL(verificationUrl);
			complete.searchParams.set("code", userCode);
			return {
				deviceCode,
				userCode,
				verificationUrl,
				verificationUrlComplete: complete.toString(),
				intervalSeconds: DEVICE_LOGIN_INTERVAL_SECONDS,
				expiresAt: login.expiresAt,
			};
		},

		pollDeviceLogin: async (_none, { body }) => {
			const id = await sha256Hex(body.deviceCode);
			const login = await store.deviceLogins.get(id);
			if (login === undefined) throw new KantelError("not_found", "No such sign-in");
			if (login.state === "approved" && login.secret !== undefined && login.apiKeyId !== undefined) {
				// Only the first poll that sees it gets the secret, which is then dropped.
				const collected = await store.deviceLogins.update(id, (current) =>
					current.secret === undefined ? undefined : { ...current, secret: undefined, collectedAt: now() },
				);
				const key = await store.apiKeys.get(login.apiKeyId);
				if (collected === undefined || key === undefined) return { state: "expired" };
				return { state: "approved", issued: { key: apiKeyView(key), secret: login.secret } };
			}
			if (login.state === "approved") return { state: "expired" };
			return { state: deviceLoginView(login).state };
		},
	};

	const handlers: RouteHandlers<SignedInComputeRoutes, Principal> = {
		// Device sign-ins, which a person approves on the console's page.

		getDeviceLogin: async (principal, { params }) => {
			requirePerson(principal);
			return deviceLoginView(await pendingDeviceLogin(params.userCode));
		},

		approveDeviceLogin: async (principal, { params, body }) => {
			const person = requirePerson(principal);
			const login = await pendingDeviceLogin(params.userCode);
			if (login.state !== "pending") throw new KantelError("conflict", `The sign-in is already ${login.state}`);
			const { account, role } = await actingAccount(store, person, body.account);
			requireScope(person, "account:admin", role);
			const scopes =
				body.preset === undefined
					? computeSchema.API_KEY_SCOPES.filter((scope) => scope !== "hosts:admin" || person.superAdmin)
					: [...computeSchema.API_KEY_PRESETS[body.preset]];
			requireGrantable(person, scopes);
			const { secret, prefix, hash } = await newApiKeySecret();
			const key: StoredApiKey = {
				id: randomId("key"),
				accountId: account.id,
				name: login.clientName,
				prefix,
				scopes,
				createdBy: actorOf(person),
				createdAt: now(),
				expiresAt: now() + (body.expiresInDays ?? DEVICE_LOGIN_KEY_DAYS) * DAY_MS,
				secretHash: hash,
				ownerUserId: person.userId,
			};
			const approved = await store.deviceLogins.update(login.id, (current) =>
				current.state === "pending"
					? { ...current, state: "approved", apiKeyId: key.id, secret, decidedBy: person.userId }
					: undefined,
			);
			if (approved === undefined) throw new KantelError("conflict", "The sign-in was decided meanwhile");
			await store.apiKeys.put(key);
			return deviceLoginView(approved);
		},

		denyDeviceLogin: async (principal, { params }) => {
			const person = requirePerson(principal);
			const login = await pendingDeviceLogin(params.userCode);
			if (login.state !== "pending") throw new KantelError("conflict", `The sign-in is already ${login.state}`);
			const denied = await store.deviceLogins.update(login.id, (current) =>
				current.state === "pending" ? { ...current, state: "denied", decidedBy: person.userId } : undefined,
			);
			if (denied === undefined) throw new KantelError("conflict", "The sign-in was decided meanwhile");
			return deviceLoginView(denied);
		},

		// Who is calling, accounts and organisations.

		getCaller: async (principal) => {
			const accounts = await accountsOf(principal);
			if (principal.kind === "key") {
				const key = await store.apiKeys.get(principal.keyId);
				return {
					apiKey: { id: principal.keyId, name: principal.keyName, scopes: [...principal.scopes] },
					user: key === undefined ? undefined : await personSummary(key.ownerUserId),
					accountId: principal.accountId,
					accounts,
					superAdmin: principal.superAdmin,
					mode,
				};
			}
			return {
				user: { id: principal.userId, name: principal.name, email: principal.email },
				accountId: principal.personalAccountId,
				accounts,
				superAdmin: principal.superAdmin,
				mode,
			};
		},

		listAccounts: async (principal) => {
			requireScope(principal, "account:read");
			return { items: await accountsOf(principal) };
		},

		createOrganisation: async (principal, { body }) => {
			const person = requirePerson(principal);
			const account: StoredAccount = {
				id: randomId("acc"),
				kind: "organisation",
				name: body.name,
				defaultVisibility: body.defaultVisibility ?? "organisation",
				createdAt: now(),
			};
			await store.accounts.put(account);
			await store.members.put({
				id: memberId(account.id, person.userId),
				accountId: account.id,
				userId: person.userId,
				role: "owner",
				joinedAt: now(),
			});
			return accountView(account, "owner");
		},

		joinOrganisation: async (principal, { body }) => {
			const person = requirePerson(principal);
			const [invite] = await store.invites.list({ codeHash: await sha256Hex(body.code) });
			if (invite === undefined) throw notFound("invite");
			if (invite.revokedAt !== undefined || invite.usedAt !== undefined || invite.expiresAt <= now()) {
				throw new KantelError("expired", "The invite has expired or been used");
			}
			if (invite.email !== undefined && invite.email.toLowerCase() !== (person.email ?? "").toLowerCase()) {
				throw new KantelError("forbidden", "The invite is for someone else");
			}
			const account = await store.accounts.get(invite.accountId);
			if (account === undefined) throw notFound("organisation");
			if ((await store.members.get(memberId(account.id, person.userId))) !== undefined) {
				throw new KantelError("conflict", "You are already a member");
			}
			await store.members.put({
				id: memberId(account.id, person.userId),
				accountId: account.id,
				userId: person.userId,
				role: invite.role,
				joinedAt: now(),
			});
			await store.invites.put({ ...invite, usedAt: now(), usedBy: person.userId });
			return accountView(account, invite.role);
		},

		getAccount: async (principal, { params }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:read", role);
			return accountView(account, role);
		},

		updateAccount: async (principal, { params, body }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", role);
			if (account.kind === "personal" && body.defaultVisibility === "organisation") {
				throw new KantelError("invalid", "A personal account's sandboxes are always private");
			}
			const updated: StoredAccount = {
				...account,
				name: body.name ?? account.name,
				defaultVisibility: body.defaultVisibility ?? account.defaultVisibility,
			};
			await store.accounts.put(updated);
			return accountView(updated, role);
		},

		deleteOrganisation: async (principal, { params }) => {
			requirePerson(principal);
			const acting = await accountById(store, principal, params.accountId);
			const { account, role } = acting;
			if (account.kind === "personal") throw new KantelError("invalid", "A personal account can't be deleted here");
			if (role !== "owner") throw new KantelError("forbidden", "Only an owner deletes an organisation");
			const sandboxes = (await store.sandboxes.list({ accountId: account.id })).filter(
				(sandbox) => sandbox.state !== "deleted",
			);
			const saved = await store.snapshots.list({ accountId: account.id, kind: "saved" });
			if (sandboxes.length > 0 || saved.length > 0) {
				throw new KantelError("conflict", "Delete the organisation's sandboxes and saved snapshots first");
			}
			for (const member of await store.members.list({ accountId: account.id })) await store.members.delete(member.id);
			for (const invite of await store.invites.list({ accountId: account.id })) await store.invites.delete(invite.id);
			for (const key of await store.apiKeys.list({ accountId: account.id })) {
				if (key.revokedAt === undefined) await store.apiKeys.put({ ...key, revokedAt: now() });
			}
			for (const webhook of await store.webhooks.list({ accountId: account.id })) {
				await store.webhooks.delete(webhook.id);
			}
			await store.telemetry.delete(account.id);
			await store.proxies.delete(account.id);
			await store.accounts.delete(account.id);
			return undefined;
		},

		getAccountUsage: async (principal, { params, query }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:read", role);
			return accountUsage(account, query.since ?? now() - DAY_MS);
		},

		listMembers: async (principal, { params }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:read", role);
			return { items: await membersView(account.id) };
		},

		updateMember: async (principal, { params, body }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			requireOrganisation(acting);
			const target = await store.members.get(memberId(params.accountId, params.userId));
			if (target === undefined) throw notFound("member");
			if ((body.role === "owner" || target.role === "owner") && acting.role !== "owner") {
				throw new KantelError("forbidden", "Only an owner makes or unmakes an owner");
			}
			if (target.role === "owner" && body.role !== "owner" && (await ownerCount(params.accountId)) <= 1) {
				throw new KantelError("conflict", "The last owner stays an owner");
			}
			await store.members.put({ ...target, role: body.role });
			const [member] = (await membersView(params.accountId)).filter((entry) => entry.userId === params.userId);
			if (member === undefined) throw notFound("member");
			return member;
		},

		removeMember: async (principal, { params }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireOrganisation(acting);
			const leaving = principal.kind === "person" && params.userId === principal.userId;
			if (!leaving) requireScope(principal, "account:admin", acting.role);
			const target = await store.members.get(memberId(params.accountId, params.userId));
			if (target === undefined) throw notFound("member");
			if (!leaving && target.role === "owner" && acting.role !== "owner") {
				throw new KantelError("forbidden", "Only an owner removes an owner");
			}
			if (target.role === "owner" && (await ownerCount(params.accountId)) <= 1) {
				throw new KantelError("conflict", "The last owner can't leave");
			}
			await store.members.delete(target.id);
			// Their private sandboxes stay, stopped; their keys in the organisation stop working.
			for (const sandbox of await store.sandboxes.list({ accountId: params.accountId, ownerUserId: params.userId })) {
				if (sandbox.visibility === "private" && sandbox.state === "running") {
					keepGoing((await beginStop(sandbox, false, "Its person left the organisation", principal)).work);
				}
			}
			for (const key of await store.apiKeys.list({ accountId: params.accountId, ownerUserId: params.userId })) {
				if (key.revokedAt === undefined) await store.apiKeys.put({ ...key, revokedAt: now() });
			}
			return undefined;
		},

		listInvites: async (principal, { params }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			const open = (await store.invites.list({ accountId: params.accountId })).filter(
				(invite) => invite.revokedAt === undefined && invite.usedAt === undefined && invite.expiresAt > now(),
			);
			return { items: newestFirst(open).map((invite) => inviteView(invite)) };
		},

		createInvite: async (principal, { params, body }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			requireOrganisation(acting);
			const role = body.role ?? "member";
			if (role === "owner" && acting.role !== "owner") {
				throw new KantelError("forbidden", "Only an owner invites an owner");
			}
			const code = randomSecret("kji_", 32);
			const invite: StoredInvite = {
				id: randomId("inv"),
				accountId: params.accountId,
				role,
				email: body.email,
				codeHash: await sha256Hex(code),
				expiresAt: now() + (body.expiresInHours ?? 168) * 3_600_000,
				createdAt: now(),
			};
			await store.invites.put(invite);
			return inviteView(invite, code);
		},

		revokeInvite: async (principal, { params }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			const invite = await store.invites.get(params.inviteId);
			if (invite === undefined || invite.accountId !== params.accountId) throw notFound("invite");
			if (invite.revokedAt === undefined) await store.invites.put({ ...invite, revokedAt: now() });
			return undefined;
		},

		// Sandboxes.

		listSandboxes: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:read", role);
			const active: readonly SandboxState[] = ["starting", "running", "stopping"];
			const visible: StoredSandbox[] = [];
			for (const sandbox of await store.sandboxes.list({ accountId: account.id })) {
				if (sandbox.state === "deleted") continue;
				const wanted =
					query.state !== undefined
						? sandbox.state === query.state
						: query.all === true || active.includes(sandbox.state);
				if (!wanted) continue;
				const labels = query.label ?? {};
				if (!Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value)) continue;
				if (await canSee(principal, sandbox, role)) visible.push(sandbox);
			}
			const page = paginate(newestFirst(visible), query.limit, query.cursor);
			return { items: page.items.map((sandbox) => sandboxView(sandbox, principal)), nextCursor: page.nextCursor };
		},

		createSandbox: async (principal, { body, idempotencyKey }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "sandboxes:write", role);
			return once(principal, "createSandbox", idempotencyKey, async () => {
				const from = body.from === undefined ? undefined : await snapshotFrom(principal, account.id, body.from);
				const type = body.type ?? from?.sandboxType ?? "isolate";
				const environment =
					body.environment === undefined ? undefined : await environmentIn(account.id, body.environment);
				// Its repositories are cloned with a command that runs with the env this call chooses (a shell reads functions
				// from it): only a caller that may run commands may have them cloned.
				if (environment !== undefined && environment.repos.length > 0) requireScope(principal, "exec", role);
				const protectedNames = new Set(
					(environment?.variables ?? []).filter((variable) => variable.protected).map((variable) => variable.name),
				);
				for (const name of Object.keys(body.env ?? {})) {
					refuseReserved(name);
					if (protectedNames.has(name)) {
						throw new KantelError("invalid", `${name} is a protected variable of the environment; leave it out of env`);
					}
				}
				// The sandbox's own placeholder for each protected variable, minted now and never changed (a rotation changes
				// the value it stands for). Its env: the environment's plain variables, then the placeholders, then its own.
				const placeholders: { [name: string]: string } = {};
				for (const name of protectedNames) placeholders[name] = newPlaceholder();
				const env: { [name: string]: string } = {};
				for (const variable of environment?.variables ?? []) {
					if (!variable.protected && variable.value !== undefined) env[variable.name] = variable.value;
				}
				Object.assign(env, placeholders, body.env);
				const egressRevision = now();
				const subject: EgressSubject = {
					...(environment === undefined ? {} : { environmentId: environment.id }),
					placeholders,
					grants: [],
					egressRevision,
				};
				// The backend's hosts and the host records, read at once: one round trip, not one each. The backend's hosts
				// are read once, for the checks below and the host records alike.
				const read = backend.capabilities();
				const known = ensureHosts(read);
				// A check below may refuse the call before this is awaited.
				known.catch(() => undefined);
				const capabilities = await read;
				if (!capabilities.types.includes(type)) throw new KantelError("unavailable", `No host runs ${type} sandboxes`);
				if (type === "isolate" && body.size !== undefined) throw new KantelError("invalid", "Isolates have no size");
				if (body.size !== undefined && !capabilities.sizes.some((size) => size.name === body.size)) {
					throw new KantelError("not_supported", `This deployment doesn't offer the size ${body.size}`);
				}
				if (account.kind === "personal" && body.visibility === "organisation") {
					throw new KantelError("invalid", "A personal account's sandboxes are always private");
				}
				await requireCapacity(account.id, 1);
				const hostLabels = { ...body.hostLabels };
				const hosts = requireHosts(
					await known,
					account.id,
					type,
					hostLabels,
					from !== undefined,
					await mayShare(principal),
				);
				const name = body.name ?? generatedName();
				const sandbox: StoredSandbox = {
					id: randomId("sbx"),
					accountId: account.id,
					name,
					subdomain: subdomainFor(name),
					type,
					size: type === "microvm" ? (body.size ?? "default") : undefined,
					image: type === "microvm" ? (body.image ?? capabilities.defaultImage) : undefined,
					state: "starting",
					visibility: account.kind === "personal" ? "private" : (body.visibility ?? account.defaultVisibility),
					capabilities: type === "microvm" ? MICROVM_CAPABILITIES : ISOLATE_CAPABILITIES,
					labels: { ...body.labels },
					autoStopMinutes: body.autoStopMinutes === undefined ? DEFAULT_AUTO_STOP_MINUTES : body.autoStopMinutes,
					source: from === undefined ? undefined : { snapshotId: from.id },
					createdBy: actorOf(principal),
					createdAt: now(),
					ownerUserId: principal.userId,
					env,
					...(environment === undefined ? {} : { environmentId: environment.id }),
					grants: [],
					placeholders,
					egressRevision,
					hostLabels,
					runs: [],
					samples: [],
					ports: [],
				};
				// The record before its event: who may see an event is decided by its sandbox, so the event is never stored
				// (or delivered) before the sandbox is.
				await store.sandboxes.put(sandbox);
				// Its egress is read once it is stored: a change to its environment or the proxy settings from then on moves its
				// revision on (and its boot reconciles), which one read before couldn't promise. Read with the event's write.
				const [egress] = await Promise.all([
					egressFor(account.id, subject),
					emit("sandbox.created", account.id, { sandbox, data: { actor: actorOf(principal) } }),
				]);
				const work = track([sandbox.id], async () => {
					const booted = await boot(
						sandbox.id,
						() =>
							backend.create({
								sandboxId: sandbox.id,
								accountId: account.id,
								type,
								subdomain: sandbox.subdomain,
								size: sandbox.size,
								image: sandbox.image,
								env: sandbox.env,
								eligibleHosts: hosts,
								fromSnapshot: from?.ref,
								...egress,
							}),
						sandbox,
						{ egressRevision },
					);
					// Queued with the boot, so a call after the create (an exec, a stop) finds the files and repositories there.
					if (booted?.state === "running" && environment !== undefined) {
						// As read when the call was authorised, not as it may be now.
						await provision(booted, environment).catch(() => undefined);
					}
					return booted;
				});
				if (body.wait !== true) {
					keepGoing(work);
					// As written: it is starting.
					return sandboxView(sandbox, principal);
				}
				// As the boot wrote it (`running` or `error`), unless something else moved it meanwhile, such as a delete.
				const booted = await work;
				return sandboxView(booted ?? (await mustGetSandbox(sandbox.id)), principal);
			});
		},

		getSandbox: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:read", true);
			return sandboxView(sandbox, principal);
		},

		updateSandbox: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			const current = await settledFor(principal, sandbox.id);
			const account = await store.accounts.get(current.accountId);
			if (body.visibility === "organisation" && account?.kind === "personal") {
				throw new KantelError("invalid", "A personal account's sandboxes are always private");
			}
			const updated = await patchSandbox(current.id, (latest) => {
				let stopsAt = latest.stopsAt;
				if (body.autoStopMinutes !== undefined && latest.state === "running") {
					stopsAt = body.autoStopMinutes === null ? undefined : now() + body.autoStopMinutes * 60_000;
				}
				if (body.extendMinutes !== undefined) {
					if (latest.state !== "running") throw new KantelError("conflict", "Only a running sandbox has a stop time");
					stopsAt = now() + body.extendMinutes * 60_000;
				}
				return {
					...latest,
					name: body.name ?? latest.name,
					autoStopMinutes: body.autoStopMinutes === undefined ? latest.autoStopMinutes : body.autoStopMinutes,
					visibility: body.visibility ?? latest.visibility,
					labels: body.labels === undefined ? latest.labels : { ...body.labels },
					stopsAt,
				};
			});
			if (updated === undefined) throw notFound("sandbox");
			return sandboxView(updated, principal);
		},

		startSandbox: async (principal, { params, body }) => restart(principal, params.sandboxId, body, "start"),

		stopSandbox: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			const current = await settledFor(principal, sandbox.id);
			const keepMemory = body.keepMemory === true;
			if (keepMemory && !current.capabilities.pause) {
				throw new KantelError("not_supported", "Pausing with memory needs a microVM; stop an isolate instead");
			}
			if ((current.state === "stopped" && !keepMemory) || (current.state === "paused" && keepMemory)) {
				return sandboxView(current, principal);
			}
			if (current.state !== "running" && !(current.state === "paused" && !keepMemory)) {
				throw new KantelError("conflict", `The sandbox is ${current.state}`);
			}
			const { work } = await beginStop(current, keepMemory, undefined, principal);
			if (body.wait === true) await work;
			else keepGoing(work);
			return sandboxView(await mustGetSandbox(sandbox.id), principal);
		},

		resumeSandbox: async (principal, { params, body }) => restart(principal, params.sandboxId, body, "resume"),

		forkSandbox: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox: source } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			return once(principal, "forkSandbox", idempotencyKey, async () => {
				const current = await settledFor(principal, source.id);
				const count = body.count ?? 1;
				let snapshot: StoredSnapshot | undefined;
				if (body.snapshotId !== undefined) {
					snapshot = await store.snapshots.get(body.snapshotId);
					if (snapshot === undefined || snapshot.sandboxId !== current.id) throw notFound("snapshot of this sandbox");
				} else if (current.state !== "running") {
					snapshot =
						current.latestSnapshotId === undefined ? undefined : await store.snapshots.get(current.latestSnapshotId);
					if (snapshot === undefined) throw new KantelError("conflict", "The sandbox has no snapshot to fork from");
				}
				const ref = snapshot === undefined ? undefined : readyRef(snapshot);
				if (current.type === "isolate" && body.size !== undefined) {
					throw new KantelError("invalid", "Isolates have no size");
				}
				const account = await store.accounts.get(current.accountId);
				if (account?.kind === "personal" && body.visibility === "organisation") {
					throw new KantelError("invalid", "A personal account's sandboxes are always private");
				}
				await requireCapacity(current.accountId, count);
				const hosts = requireHosts(
					await ensureHosts(),
					current.accountId,
					current.type,
					current.hostLabels,
					true,
					await mayShare(principal),
				);
				const forks: StoredSandbox[] = [];
				// One for them all, as their egress is read once for them all.
				const egressRevision = now();
				for (let index = 0; index < count; index++) {
					// Fresh placeholders: the parent's may be on the copied disk, and they stand for nothing in the fork.
					const placeholders: { [name: string]: string } = {};
					const env: { [name: string]: string } = { ...current.env };
					for (const [variable, parent] of Object.entries(current.placeholders ?? {})) {
						const own = newPlaceholder();
						placeholders[variable] = own;
						if (env[variable] === parent) env[variable] = own;
					}
					const name =
						body.name === undefined
							? `${current.name}-fork-${randomSlug(4)}`
							: count === 1
								? body.name
								: `${body.name}-${index + 1}`;
					forks.push({
						id: randomId("sbx"),
						accountId: current.accountId,
						name,
						subdomain: subdomainFor(name),
						type: current.type,
						size: current.type === "microvm" ? (body.size ?? current.size) : undefined,
						image: current.image,
						state: "starting",
						visibility: account?.kind === "personal" ? "private" : (body.visibility ?? current.visibility),
						capabilities: current.capabilities,
						labels: body.labels === undefined ? { ...current.labels } : { ...body.labels },
						autoStopMinutes: current.autoStopMinutes,
						source: { sandboxId: current.id, snapshotId: snapshot?.id },
						createdBy: actorOf(principal),
						createdAt: now(),
						ownerUserId: principal.userId,
						env,
						...(current.environmentId === undefined ? {} : { environmentId: current.environmentId }),
						grants: (current.grants ?? []).map(copyGrant),
						placeholders,
						egressRevision,
						hostLabels: { ...current.hostLabels },
						runs: [],
						samples: [],
						ports: [],
					});
				}
				for (const fork of forks) {
					await store.sandboxes.put(fork);
					await emit("sandbox.created", fork.accountId, { sandbox: fork, data: { actor: actorOf(principal) } });
				}
				// Queued behind the source too, so it isn't stopped while its live disk is copied. The forks' egress is alike:
				// their placeholders differ, but not the variables they stand for.
				const egress = await egressFor(current.accountId, forks[0] ?? current);
				// One target at a time, each placement recorded as it lands: a backend makes a batch's targets one by one, so
				// a failure part-way leaves the earlier ones made, and they must keep their host (a start or recovery uses that
				// machine) rather than be taken for never made (`neverPlaced`).
				const work = track([current.id, ...forks.map((fork) => fork.id)], async () => {
					for (const fork of forks) {
						await boot(
							fork.id,
							async () => {
								const [placement] = await backend.fork(
									{ sandboxId: current.id, ...(ref === undefined ? {} : { snapshot: ref }) },
									[
										{
											sandboxId: fork.id,
											accountId: fork.accountId,
											type: fork.type,
											subdomain: fork.subdomain,
											size: fork.size,
											image: fork.image,
											env: fork.env,
											eligibleHosts: hosts,
											...egress,
										},
									],
								);
								if (placement === undefined) throw new KantelError("unavailable", "The fork was not placed");
								return placement;
							},
							undefined,
							{ egressRevision },
						);
					}
				});
				if (body.wait === true) await work;
				else keepGoing(work);
				const items: Sandbox[] = [];
				for (const fork of forks) items.push(sandboxView(await mustGetSandbox(fork.id), principal));
				return { items };
			});
		},

		recoverSandbox: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			const current = await settledFor(principal, sandbox.id);
			if (current.state !== "running" && current.state !== "error") {
				throw new KantelError("conflict", `A ${current.state} sandbox is started or resumed, not recovered`);
			}
			const hosts = requireHosts(
				await ensureHosts(),
				current.accountId,
				current.type,
				current.hostLabels,
				true,
				await mayShare(principal),
			);
			const fromSnapshot = await latestRef(current);
			// A boot's egress is read afresh, so it gets a revision of its own: an update read before (from when it last ran,
			// say, still being retried) never equals it, and loses.
			const began = await transition(current.id, current.state, (latest) =>
				withState(latest, "starting", { ports: [], egressRevision: later(latest.egressRevision) }),
			);
			if (!("moved" in began)) throw new KantelError("conflict", `The sandbox is ${began.lost.state}`);
			const starting = began.moved;
			// As written now it is starting: a change from here on moves its revision on, and its boot reconciles.
			const egress = await egressFor(starting.accountId, starting);
			keepGoing(
				track([current.id], () =>
					boot(
						current.id,
						() =>
							bootAgain(
								current,
								{ fromSnapshot, env: current.env, eligibleHosts: hosts, size: current.size, ...egress },
								(options) => backend.recover(current.id, options),
							),
						undefined,
						{ egressRevision: starting.egressRevision },
					),
				),
			);
			return sandboxView(starting, principal);
		},

		restartSandboxOnLatest: async (principal, { params }) => {
			requireImagePatching();
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			let current = await settledFor(principal, sandbox.id);
			if (
				current.state !== "running" &&
				current.state !== "stopped" &&
				current.state !== "paused" &&
				current.state !== "error"
			) {
				throw new KantelError("conflict", `The sandbox is ${current.state}`);
			}
			// A running one holds its place already; the hosts are checked before it is stopped, so a sandbox no host can
			// take now is refused as it is, not left stopped.
			if (current.state !== "running") await requireCapacity(current.accountId, 1);
			const hosts = requireHosts(
				await ensureHosts(),
				current.accountId,
				current.type,
				current.hostLabels,
				true,
				await mayShare(principal),
			);
			// Where it is to land: the host images version the index's `stable` names, whatever base it reported (none, for
			// one from before image patching); a container's image (a digest) is its backend's to pick. Checked with the
			// machine its disk is on before anything stops, so a restart that can't get there (no stable host images in the
			// index, a host that isn't eligible, doesn't patch images, or hasn't taken that version yet) leaves the sandbox
			// as it is.
			await refreshBase();
			const onHostImages = current.base === undefined || baseImageOf(current.base) === HOST_BASE_IMAGE;
			const rebaseTo = onHostImages && baseIndex !== undefined ? hostImageChannel(baseIndex)?.version : undefined;
			await backend.prepareRebase?.(current.id, {
				eligibleHosts: hosts,
				...(rebaseTo === undefined ? {} : { rebaseTo }),
			});
			if (current.state === "running") {
				// Its disk is saved first, as a stop saves it (without its memory, which a new base can't take): the boot below
				// starts from that snapshot. Waited for, as the boot needs it.
				const { work } = await beginStop(current, false, undefined, principal);
				await work;
				current = await mustGetSandbox(current.id);
				if (current.state !== "stopped") throw new KantelError("conflict", `The sandbox is ${current.state}`);
			}
			const fromSnapshot = await latestRef(current);
			// A boot's egress is read afresh, so it gets a revision of its own, as a recovery's does. A paused sandbox's memory
			// is let go: the machine boots cold on the new base.
			const began = await transition(current.id, current.state, (latest) =>
				withState(latest, "starting", {
					ports: [],
					pausedSnapshotId: undefined,
					egressRevision: later(latest.egressRevision),
				}),
			);
			if (!("moved" in began)) throw new KantelError("conflict", `The sandbox is ${began.lost.state}`);
			const starting = began.moved;
			const stopped = current;
			// As written now it is starting: a change from here on moves its revision on, and its boot reconciles.
			const egress = await egressFor(starting.accountId, starting);
			keepGoing(
				track([stopped.id], () =>
					boot(
						stopped.id,
						() =>
							bootAgain(
								stopped,
								{
									fromSnapshot,
									env: stopped.env,
									eligibleHosts: hosts,
									size: stopped.size,
									...egress,
									rebase: true,
									...(rebaseTo === undefined ? {} : { rebaseTo }),
								},
								(options) => backend.start(stopped.id, options),
							),
						undefined,
						{ egressRevision: starting.egressRevision },
					),
				),
			);
			return sandboxView(starting, principal);
		},

		deleteSandbox: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:delete");
			const current = await settledFor(principal, sandbox.id);
			if (current.state === "deleted") return sandboxView(current, principal);
			// A sandbox is deleted from any state, so the move is refused only once another call has deleted it. A delete
			// already under way (on another gateway, or one that died) is done again: destroying is idempotent, and only one
			// of them writes `deleted`.
			const began = await transition(current.id, NOT_DELETED, (latest) => withState(latest, "deleting"));
			if (!("moved" in began)) return sandboxView(began.lost, principal);
			await track([current.id], async () => {
				try {
					await killCommandsOf(current.id);
					await backend.destroy(current.id);
					for (const snapshot of await store.snapshots.list({ sandboxId: current.id })) {
						if (snapshot.kind === "automatic") {
							await store.snapshots.delete(snapshot.id);
							await releaseRef(snapshot.ref);
						} else {
							await store.snapshots.put({ ...snapshot, sandboxId: undefined });
						}
					}
					const result = await transition(current.id, "deleting", (latest) =>
						withState(latest, "deleted", { ports: [], latestSnapshotId: undefined, pausedSnapshotId: undefined }),
					);
					if (!("moved" in result)) return;
					const deleted = result.moved;
					await emit("sandbox.deleted", deleted.accountId, {
						sandbox: deleted,
						data: { previousState: current.state, actor: actorOf(principal) },
					});
				} catch (error) {
					await fail(current.id, error, "deleting");
					throw error;
				}
			});
			return sandboxView(await mustGetSandbox(current.id), principal);
		},

		getSandboxUsage: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:read", true);
			if (sandbox.state === "running") await recordSample(sandbox.id);
			const current = await mustGetSandbox(sandbox.id);
			const at = now();
			const intervalMs = (query.intervalSeconds ?? 300) * 1000;
			const since = Math.max(query.since ?? at - DAY_MS, current.createdAt - intervalMs);
			const rate = rateOf(current);
			const start = Math.max(since, at - 1000 * intervalMs);
			const points: { at: number; cpu: number; memoryMb: number; runningSeconds: number; cost: number }[] = [];
			for (let from = start; from < at; from += intervalMs) {
				const to = Math.min(from + intervalMs, at);
				const seconds = runningMs(current.runs, from, to) / 1000;
				const samples = current.samples.filter((sample) => sample.at >= from && sample.at < to);
				const mean = (values: readonly number[]) =>
					values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
				points.push({
					at: from,
					cpu: Math.min(1, mean(samples.map((sample) => sample.cpu))),
					memoryMb: round(mean(samples.map((sample) => sample.memoryMb))),
					runningSeconds: round(seconds),
					cost: round((seconds / 3600) * rate),
				});
			}
			const seconds = runningMs(current.runs, since, at) / 1000;
			return {
				sandboxId: current.id,
				intervalSeconds: intervalMs / 1000,
				points,
				totals: {
					runningSeconds: round(seconds),
					cpuSeconds: round(seconds * meanCpu(current)),
					cost: { currency: rates.currency, total: round((seconds / 3600) * rate), ratePerHour: rate },
				},
			};
		},

		// Commands and files.

		runCommand: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			return once(principal, "runCommand", idempotencyKey, async () => {
				const current = await requireRunning(principal, sandbox.id);
				if (!current.capabilities.exec) throw new KantelError("not_supported", "This sandbox runs no commands");
				const detached = body.detached === true;
				const command: StoredCommand = {
					id: randomId("cmd"),
					sandboxId: current.id,
					accountId: current.accountId,
					command: body.command,
					cwd: resolvePath(body.cwd ?? HOME),
					state: "running",
					stdout: "",
					stderr: "",
					truncated: false,
					startedAt: now(),
				};
				await store.commands.put(command);
				const controller = new AbortController();
				runningCommands.set(command.id, controller);
				const finish = async (result: {
					exitCode: number;
					stdout: string;
					stderr: string;
					timedOut: boolean;
				}): Promise<StoredCommand> => {
					runningCommands.delete(command.id);
					const latest = (await store.commands.get(command.id)) ?? command;
					if (latest.state !== "running") return latest;
					const stdout = truncate(result.stdout);
					const stderr = truncate(result.stderr);
					const at = now();
					const ended: StoredCommand = {
						...latest,
						state: result.timedOut ? "timed_out" : "exited",
						exitCode: result.exitCode,
						stdout: stdout.text,
						stderr: stderr.text,
						truncated: stdout.truncated || stderr.truncated,
						endedAt: at,
						durationMs: at - latest.startedAt,
					};
					await store.commands.put(ended);
					return ended;
				};
				const failed = (error: unknown) =>
					finish({ exitCode: 1, stdout: "", stderr: `${messageOf(error)}\n`, timedOut: false });
				const run = backend.exec(current.id, {
					command: body.command,
					cwd: command.cwd,
					env: { ...current.env, ...body.env },
					stdin: body.stdin,
					timeoutMs: detached ? undefined : (body.timeoutMs ?? DEFAULT_TIMEOUT_MS),
					signal: controller.signal,
				});
				if (detached) {
					keepGoing(run.then(finish, failed));
					return commandView(command);
				}
				return commandView(await run.then(finish, failed));
			});
		},

		listCommands: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const page = paginate(
				newestFirst(
					(await store.commands.list({ sandboxId: sandbox.id })).map((command) => ({
						...command,
						createdAt: command.startedAt,
					})),
				),
				query.limit,
				query.cursor,
			);
			return { items: page.items.map(commandView), nextCursor: page.nextCursor };
		},

		getCommand: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const command = await store.commands.get(params.commandId);
			if (command === undefined || command.sandboxId !== sandbox.id) throw notFound("command");
			return commandView(command);
		},

		killCommand: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const command = await store.commands.get(params.commandId);
			if (command === undefined || command.sandboxId !== sandbox.id) throw notFound("command");
			if (command.state !== "running") return commandView(command);
			runningCommands.get(command.id)?.abort();
			runningCommands.delete(command.id);
			const at = now();
			const killed: StoredCommand = {
				...command,
				state: "killed",
				exitCode: 137,
				endedAt: at,
				durationMs: at - command.startedAt,
			};
			await store.commands.put(killed);
			return commandView(killed);
		},

		readFile: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(principal, sandbox.id);
			const path = resolvePath(query.path);
			const ranged = query.offset !== undefined || query.length !== undefined;
			const offset = query.offset ?? 0;
			// Without a range, a file over 1 MiB is refused: one more byte is enough to tell, and the host sends no more.
			const length = ranged ? Math.min(query.length ?? MAX_FILE_BYTES, MAX_FILE_BYTES) : MAX_FILE_BYTES + 1;
			const { bytes, size } = await backend.readFile(sandbox.id, path, { offset, length });
			if (!ranged && size > MAX_FILE_BYTES) {
				throw new KantelError("invalid", `${path} is larger than 1 MiB; read it in parts with offset and length`);
			}
			const encoding = query.encoding ?? "utf8";
			return {
				path,
				encoding,
				content: encoding === "base64" ? bytesToBase64(bytes) : decodeUtf8(bytes, path),
				size,
				...(ranged ? { offset: Math.min(offset, size) } : {}),
			};
		},

		writeFile: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(principal, sandbox.id);
			const path = resolvePath(body.path);
			const bytes = body.encoding === "base64" ? base64ToBytes(body.content) : new TextEncoder().encode(body.content);
			if (bytes.byteLength > MAX_FILE_BYTES) throw new KantelError("invalid", "A file written here is at most 1 MiB");
			let mode: number | undefined;
			if (body.mode !== undefined) {
				if (!/^0?[0-7]{3,4}$/.test(body.mode)) throw new KantelError("invalid", "mode must be octal, such as 0755");
				mode = Number.parseInt(body.mode, 8);
			}
			return fileEntry(await backend.writeFile(sandbox.id, path, bytes, mode));
		},

		deleteFile: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(principal, sandbox.id);
			await backend.deleteFile(sandbox.id, resolvePath(query.path));
			return undefined;
		},

		listFiles: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(principal, sandbox.id);
			const path = resolvePath(query.path ?? HOME);
			const page = paginate(await backend.listFiles(sandbox.id, path), query.limit, query.cursor);
			return { path, items: page.items.map(fileEntry), nextCursor: page.nextCursor };
		},

		// Ports, desktop, browser and SSH.

		listPorts: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			return { items: [...sandbox.ports] };
		},

		exposePort: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			if (!sandbox.capabilities.ports) throw new KantelError("not_supported", "This sandbox can't expose ports");
			const current = await requireRunning(principal, sandbox.id);
			const isPublic = body.public === true;
			const existing = current.ports.find((entry) => entry.port === body.port);
			// A public port's URL holds no secret, so exposing it again answers it as it is. A gated port's token is shown
			// once and kept only as a hash, so exposing it again gives it a new one, ending the old.
			if (existing?.public && isPublic) return existing;
			const { url } = await backend.exposePort(current.id, body.port, {
				public: isPublic,
				subdomain: current.subdomain,
				grantee: encodeGrantee(principal),
			});
			const exposed: computeSchema.ExposedPort = {
				port: body.port,
				url,
				public: isPublic,
				createdAt: existing?.createdAt ?? now(),
			};
			await patchSandbox(current.id, (latest) => ({
				...latest,
				ports: [
					...latest.ports.filter((entry) => entry.port !== body.port),
					{ ...exposed, url: withoutPortToken(url) },
				],
			}));
			return exposed;
		},

		hidePort: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			const current = await settledFor(principal, sandbox.id);
			const port = Number(params.port);
			if (!current.ports.some((entry) => entry.port === port)) throw notFound("exposed port");
			await backend.hidePort(current.id, port);
			await patchSandbox(current.id, (latest) => ({
				...latest,
				ports: latest.ports.filter((entry) => entry.port !== port),
			}));
			return undefined;
		},

		openE2E: async (principal, { params, body }) => {
			// The URL's grant is the caller's: it goes only to the person whose device asked for it.
			if (body.user !== undefined && body.user !== principal.userId) {
				throw new KantelError("forbidden", "This session was asked for as another person: the sign-in has changed");
			}
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			if (backend.openE2E === undefined) {
				throw new KantelError("not_supported", "This gateway's sandboxes aren't on hosts it can open E2E sessions to");
			}
			// A session is with the host, not the guest: a stopped or paused sandbox's still is (its disk and its command
			// history are there), and the host refuses what needs a running guest. One starting, stopping or failed waits.
			const current = await settledFor(principal, sandbox.id);
			if (current.state !== "running" && current.state !== "stopped" && current.state !== "paused") {
				throw new KantelError("conflict", `The sandbox is ${current.state}; its host can't open a session for it`);
			}
			const ttlMinutes = body.ttlMinutes ?? ACCESS_TTL_MINUTES;
			const access = await backend.openE2E(current.id, { ttlMinutes, grantee: encodeGrantee(principal) });
			return {
				url: access.url,
				hostId: access.hostId,
				accountId: current.accountId,
				expiresAt: now() + ttlMinutes * 60_000,
			};
		},

		getE2EChain: async (principal, { params }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:read", role);
			return { entries: await e2eChains.read(account.id) };
		},

		appendE2EChain: async (principal, { params, body }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:read", role);
			// A person, or a key acting for one (`kantel login`'s is a key): the entries are their devices' to sign either way.
			// A key limited to some sandboxes isn't the account's, and the chain is.
			if (principal.kind === "key" && principal.limits.sandboxIds !== undefined) {
				throw new KantelError("forbidden", "A key limited to some sandboxes can't change the account's E2E chain");
			}
			const person = { userId: principal.userId };
			const entries = await e2eChains.append(account.id, body.from, body.entries, async (payload) => {
				if (payload.type === "genesis") {
					// What it starts with is its admin: an admin of the organisation, starting it on their own device.
					if (role === "member") throw new KantelError("forbidden", "Only an admin or owner starts the chain");
					if (payload.body.device.user !== person.userId) {
						throw new KantelError("forbidden", "The genesis lists the device of the person who starts it");
					}
				}
				if (
					payload.type === "member.add" &&
					(await store.members.get(memberId(account.id, payload.body.user))) === undefined
				) {
					throw new KantelError("invalid", `${payload.body.user} isn't a member of the organisation`);
				}
			});
			return { entries };
		},

		openSsh: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			if (!sandbox.capabilities.ssh) throw new KantelError("not_supported", "SSH needs a microVM; this is an isolate");
			const current = await requireRunning(principal, sandbox.id);
			const ttlMinutes = body.ttlMinutes ?? ACCESS_TTL_MINUTES;
			const grant = await backend.openSsh(current.id, {
				ttlMinutes,
				grantee: encodeGrantee(principal),
				...(body.publicKey === undefined ? {} : { publicKey: body.publicKey }),
			});
			return {
				host: grant.host,
				port: grant.port,
				user: grant.user,
				command: grant.command ?? `ssh -p ${grant.port} ${grant.user}@${grant.host}`,
				...(grant.proxyUrl === undefined ? {} : { proxyUrl: grant.proxyUrl }),
				privateKey: grant.privateKey,
				hostKeyFingerprint: grant.hostKeyFingerprint,
				expiresAt: now() + ttlMinutes * 60_000,
			};
		},

		openDesktop: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			requireScreen(sandbox, "desktop");
			const current = await requireRunning(principal, sandbox.id);
			// Again once it's placed: a new sandbox's image reports what it has only then.
			requireScreen(current, "desktop");
			const ttlMinutes = body.ttlMinutes ?? ACCESS_TTL_MINUTES;
			const viewOnly = body.viewOnly === true;
			const access = await backend.openDesktop(current.id, { viewOnly, ttlMinutes, grantee: encodeGrantee(principal) });
			return { url: access.url, embedUrl: access.embedUrl, viewOnly, expiresAt: now() + ttlMinutes * 60_000 };
		},

		openBrowser: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			requireScreen(sandbox, "browser");
			const current = await requireRunning(principal, sandbox.id);
			requireScreen(current, "browser");
			const ttlMinutes = body.ttlMinutes ?? ACCESS_TTL_MINUTES;
			const viewOnly = body.viewOnly === true;
			const access = await backend.openBrowser(current.id, { viewOnly, ttlMinutes, grantee: encodeGrantee(principal) });
			return { url: access.url, cdpUrl: access.cdpUrl, viewOnly, expiresAt: now() + ttlMinutes * 60_000 };
		},

		// Snapshots.

		listSnapshots: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "snapshots:read", role);
			const visible: StoredSnapshot[] = [];
			for (const snapshot of await store.snapshots.list({ accountId: account.id })) {
				if (query.kind !== undefined && snapshot.kind !== query.kind) continue;
				if (query.sandboxId !== undefined && snapshot.sandboxId !== query.sandboxId) continue;
				if (snapshot.state === "deleting") continue;
				if (await canSeeSnapshot(principal, snapshot)) visible.push(snapshot);
			}
			const page = paginate(newestFirst(visible), query.limit, query.cursor);
			return { items: page.items.map(snapshotView), nextCursor: page.nextCursor };
		},

		takeSnapshot: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "snapshots:write");
			const current = await requireRunning(principal, sandbox.id);
			const taken = await backend.takeSnapshot(current.id);
			const at = now();
			const snapshot: StoredSnapshot = {
				id: randomId("snap"),
				accountId: current.accountId,
				kind: "automatic",
				description: body.description,
				sandboxId: current.id,
				sandboxType: current.type,
				state: "ready",
				trigger: "manual",
				memory: false,
				sizeBytes: taken.sizeBytes,
				createdAt: at,
				expiresAt: at + AUTOMATIC_SNAPSHOT_TTL_MS,
				ref: taken.ref,
				...(taken.base === undefined ? {} : { base: taken.base }),
			};
			await store.snapshots.put(snapshot);
			await patchSandbox(current.id, (latest) => ({ ...latest, latestSnapshotId: snapshot.id }));
			return snapshotView(snapshot);
		},

		saveSnapshot: async (principal, { body }) => {
			const { sandbox } = await sandboxFor(principal, body.sandboxId, "snapshots:write");
			const current = await settledFor(principal, sandbox.id);
			const [existing] = await store.snapshots.list({ accountId: current.accountId, kind: "saved", name: body.name });
			if (existing !== undefined && body.replace !== true) {
				throw new KantelError("conflict", `A saved snapshot is already named ${body.name}`);
			}
			if (existing === undefined && limits.savedSnapshots !== undefined) {
				const saved = await store.snapshots.list({ accountId: current.accountId, kind: "saved" });
				if (saved.length >= limits.savedSnapshots) {
					throw new KantelError("exhausted", `The account may keep ${limits.savedSnapshots} saved snapshots`);
				}
			}
			let ref: string;
			let sizeBytes: number | undefined;
			// The base its disk is on, from what it is saved from: kept so a template made from it shows how far behind it is.
			let base: string | undefined;
			if (body.snapshotId !== undefined) {
				const source = await store.snapshots.get(body.snapshotId);
				if (source === undefined || source.sandboxId !== current.id) throw notFound("snapshot of this sandbox");
				ref = readyRef(source);
				sizeBytes = source.sizeBytes;
				base = source.base;
			} else if (current.state === "running") {
				const taken = await backend.takeSnapshot(current.id);
				ref = taken.ref;
				sizeBytes = taken.sizeBytes;
				base = taken.base;
			} else {
				const latest =
					current.latestSnapshotId === undefined ? undefined : await store.snapshots.get(current.latestSnapshotId);
				if (latest === undefined) throw new KantelError("conflict", "The sandbox has no state to save yet");
				ref = readyRef(latest);
				sizeBytes = latest.sizeBytes;
				base = latest.base;
			}
			const snapshot: StoredSnapshot = {
				id: randomId("snap"),
				accountId: current.accountId,
				kind: "saved",
				name: body.name,
				description: body.description,
				sandboxId: current.id,
				sandboxType: current.type,
				state: "ready",
				trigger: "save",
				memory: false,
				sizeBytes,
				createdAt: now(),
				ref,
				...(base === undefined ? {} : { base }),
			};
			await store.snapshots.put(snapshot);
			if (existing !== undefined) {
				await store.snapshots.delete(existing.id);
				await releaseRef(existing.ref);
				await emit("snapshot.deleted", existing.accountId, {
					snapshotId: existing.id,
					data: { name: existing.name, actor: actorOf(principal) },
				});
			}
			await emit("snapshot.saved", snapshot.accountId, {
				snapshotId: snapshot.id,
				data: { name: snapshot.name, actor: actorOf(principal) },
			});
			return snapshotView(snapshot);
		},

		getSnapshot: async (principal, { params }) =>
			snapshotView(await snapshotFor(principal, params.snapshotId, "snapshots:read")),

		listSnapshotFiles: async (principal, { params, query }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:read");
			const path = resolvePath(query.path ?? HOME);
			const page = paginate(await backend.listSnapshotFiles(readyRef(snapshot), path), query.limit, query.cursor);
			return { path, items: page.items.map(fileEntry), nextCursor: page.nextCursor };
		},

		readSnapshotFile: async (principal, { params, query }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:read");
			const path = resolvePath(query.path);
			const bytes = await backend.readSnapshotFile(readyRef(snapshot), path);
			if (bytes.byteLength > MAX_FILE_BYTES) throw new KantelError("invalid", `${path} is larger than 1 MiB`);
			const encoding = query.encoding ?? "utf8";
			return {
				path,
				encoding,
				content: encoding === "base64" ? bytesToBase64(bytes) : decodeUtf8(bytes, path),
				size: bytes.byteLength,
			};
		},

		deleteSnapshot: async (principal, { params }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:write");
			const sandbox = snapshot.sandboxId === undefined ? undefined : await store.sandboxes.get(snapshot.sandboxId);
			if (sandbox !== undefined) await settledOn(sandbox.id);
			const current = sandbox === undefined ? undefined : await mustGetSandbox(sandbox.id);
			if (current !== undefined && current.latestSnapshotId === snapshot.id) {
				if (current.state === "stopped" || current.state === "paused" || current.state === "error") {
					throw new KantelError("conflict", "A stopped sandbox's newest snapshot is what it resumes from");
				}
			}
			await store.snapshots.delete(snapshot.id);
			await releaseRef(snapshot.ref);
			if (current !== undefined && current.latestSnapshotId === snapshot.id) {
				const [newest] = newestFirst(
					(await store.snapshots.list({ sandboxId: current.id, kind: "automatic" })).filter(
						(entry) => entry.state === "ready",
					),
				);
				await patchSandbox(current.id, (latest) =>
					latest.latestSnapshotId === snapshot.id ? { ...latest, latestSnapshotId: newest?.id } : undefined,
				);
			}
			if (snapshot.kind === "saved") {
				await emit("snapshot.deleted", snapshot.accountId, {
					snapshotId: snapshot.id,
					data: { name: snapshot.name, actor: actorOf(principal) },
				});
			}
			return undefined;
		},

		// API keys.

		listApiKeys: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			return { items: newestFirst(await store.apiKeys.list({ accountId: account.id })).map(apiKeyView) };
		},

		createApiKey: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			const scopes = unique([
				...(body.scopes ?? []),
				...(body.preset === undefined ? [] : computeSchema.API_KEY_PRESETS[body.preset]),
			]);
			if (scopes.length === 0) throw new KantelError("invalid", "Give scopes or a preset");
			requireGrantable(principal, scopes);
			const sandboxIds = grantableSandboxes(principal, body.sandboxIds);
			const { secret, prefix, hash } = await newApiKeySecret();
			const key: StoredApiKey = {
				id: randomId("key"),
				accountId: account.id,
				name: body.name,
				prefix,
				scopes,
				sandboxIds,
				createdBy: actorOf(principal),
				createdAt: now(),
				expiresAt: body.expiresInDays === undefined ? undefined : now() + body.expiresInDays * DAY_MS,
				secretHash: hash,
				ownerUserId: principal.userId,
			};
			await store.apiKeys.put(key);
			return { key: apiKeyView(key), secret };
		},

		getApiKey: async (principal, { params }) => apiKeyView(await apiKeyFor(principal, params.apiKeyId, "account:read")),

		rotateApiKey: async (principal, { params }) => {
			const key = await apiKeyFor(principal, params.apiKeyId, "account:admin");
			if (key.revokedAt !== undefined) throw new KantelError("conflict", "The key is revoked");
			// Rotating answers the key's new secret, so it is as much as making the key: the caller must be able to grant
			// everything it holds.
			requireGrantable(principal, key.scopes);
			grantableSandboxes(principal, key.sandboxIds);
			if (principal.kind === "key" && principal.limits.sandboxIds !== undefined && key.sandboxIds === undefined) {
				throw new KantelError("forbidden", "A limited key can't rotate a key without limits");
			}
			// A key acts as its owner, shared hosts included (`mayShare`), so someone kept off them can't take one that
			// isn't, as another of the account's admins' key would be.
			if (!(await mayShare(principal)) && (await mayShare(keyPrincipal(key)))) {
				throw new KantelError("forbidden", SHARED_KEY_REFUSED);
			}
			const { secret, prefix, hash } = await newApiKeySecret();
			const rotated = await store.apiKeys.update(key.id, (current) =>
				current.revokedAt === undefined ? { ...current, prefix, secretHash: hash } : undefined,
			);
			if (rotated === undefined) throw new KantelError("conflict", "The key is revoked");
			return { key: apiKeyView(rotated), secret };
		},

		revokeApiKey: async (principal, { params }) => {
			const key = await apiKeyFor(principal, params.apiKeyId, "account:admin");
			const revoked: StoredApiKey = key.revokedAt === undefined ? { ...key, revokedAt: now() } : key;
			await store.apiKeys.put(revoked);
			return apiKeyView(revoked);
		},

		// The proxy.

		getProxySettings: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			const stored = await store.proxies.get(account.id);
			return proxyView(stored ?? unsetProxy(account));
		},

		putProxySettings: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			if (body.upstream !== undefined && body.upstream !== null) checkUrl(body.upstream.url, "The upstream");
			/** The settings the body makes of `existing`, which keeps its upstream's header values when none are given. */
			const replacing = (existing: StoredProxy | undefined): StoredProxy => {
				let upstream: StoredProxy["upstream"];
				let upstreamHeaders: StoredProxy["upstreamHeaders"];
				if (body.upstream !== undefined && body.upstream !== null) {
					upstreamHeaders =
						body.upstream.headers === undefined ? (existing?.upstreamHeaders ?? {}) : { ...body.upstream.headers };
					upstream = { url: body.upstream.url, headerNames: Object.keys(upstreamHeaders) };
				}
				return {
					id: account.id,
					accountId: account.id,
					enabled: body.enabled,
					defaultAction: body.defaultAction ?? "allow",
					allow: [...(body.allow ?? [])],
					deny: [...(body.deny ?? [])],
					upstream,
					upstreamHeaders,
					attribution: body.attribution === true,
					updatedAt: now(),
				};
			};
			let settings: StoredProxy;
			if (body.expected === undefined) {
				settings = replacing(await store.proxies.get(account.id));
				await store.proxies.put(settings);
			} else {
				settings = await replaceProxyAsRead(account, proxyKey(body.expected), replacing);
			}
			// Running sandboxes take them now where the backend can; the rest when they next boot. Each with its own
			// protected hosts and grants.
			if (backend.updateEgress !== undefined) {
				// Each one's revision moves on first, so a boot under way reconciles, and an egress read before is ignored.
				const live = (await store.sandboxes.list({ accountId: account.id })).filter(
					(sandbox) => sandbox.state === "running" || sandbox.state === "starting",
				);
				const bumped = await Promise.all(live.map((sandbox) => bumpEgress(sandbox.id)));
				pushEgress(
					bumped.filter((sandbox): sandbox is StoredSandbox => sandbox !== undefined && sandbox.state === "running"),
				);
			}
			return proxyView(settings);
		},

		// Environments, and sandboxes' egress.

		listEnvironments: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			const environments = await store.environments.list({ accountId: account.id });
			return { items: await Promise.all(environments.map(environmentView)) };
		},

		createEnvironment: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			const environmentId = randomId("env", 8);
			const at = now();
			const environment: StoredEnvironment = {
				id: environmentId,
				accountId: account.id,
				name: body.name,
				...(body.description === undefined || body.description === "" ? {} : { description: body.description }),
				variables: [],
				files: [],
				repos: [],
				grants: [],
				secretsVersion: 1,
				createdAt: at,
				updatedAt: at,
			};
			// An insert: its ID is new, so it never overwrites; the name is the store's to refuse.
			await naming(body.name, () => store.environments.insert(environment));
			return environmentView(environment);
		},

		getEnvironment: async (principal, { params }) =>
			environmentView(await environmentFor(principal, params.environmentId, "account:read")),

		updateEnvironment: async (principal, { params, body }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			// Whatever name it writes (a new one, or the one it read, which it may no longer have), the store refuses it if
			// another environment holds it by then.
			const changed = await naming(body.name ?? environment.name, () =>
				changeEnvironment(environment.id, (current) => {
					const { description: _kept, ...rest } = current;
					const description = body.description === undefined ? current.description : body.description;
					return {
						...rest,
						name: body.name ?? current.name,
						...(description === undefined || description === "" ? {} : { description }),
						updatedAt: later(current.updatedAt),
					};
				}),
			);
			return environmentView(changed);
		},

		deleteEnvironment: async (principal, { params }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			await store.environments.delete(environment.id);
			// Its sandboxes keep their env and files; their placeholders stop resolving at once, and its grants go.
			await pushEnvironment(environment.id, nextSecretsVersion(environment.secretsVersion, now()));
			return undefined;
		},

		setEnvironmentVariable: async (principal, { params, body }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			const name = params.name;
			checkVariableName(name);
			if (body.value === "" && body.protected === true) {
				throw new KantelError("invalid", "A protected variable's value can't be empty");
			}
			const bindingsGiven = body.bindings?.map(normaliseBinding);
			if ((body.protected ?? environment.variables.find((variable) => variable.name === name)?.protected) === true) {
				await requireEnforcing(await liveFrom(environment.id));
			}
			// A value given is sealed up front (sealing is async; the change below isn't) when it will be protected, as far as
			// the read above can tell; the change checks it again against the variable as it is.
			const sealsUpFront =
				body.value !== undefined &&
				body.value !== "" &&
				(body.protected ?? environment.variables.find((variable) => variable.name === name)?.protected) === true;
			const sealedGiven = sealsUpFront
				? await requireSealer().seal(body.value as string, variableAad(environment.id, name))
				: undefined;
			const at = now();
			let touchesSecrets = false;
			// Built from the variable as the store has it, each time the change runs: a field left out is kept as it is now,
			// never as an earlier read had it (a bindings edit doesn't undo a rotation that landed meanwhile).
			const changed = await changeEnvironment(environment.id, (current) => {
				const existing = current.variables.find((variable) => variable.name === name);
				if (existing === undefined && current.variables.length >= MAX_ENVIRONMENT_VARIABLES) {
					throw new KantelError("invalid", `An environment has at most ${MAX_ENVIRONMENT_VARIABLES} variables`);
				}
				// Left out, a variable stays as protected as it is; a new one is plain.
				const wantProtected = body.protected ?? existing?.protected ?? false;
				const switching = existing !== undefined && existing.protected !== wantProtected;
				if (body.value === undefined && (existing === undefined || switching)) {
					throw new KantelError("invalid", "A new variable, or one turning protected or plain, needs a value");
				}
				let next: StoredEnvironmentVariable;
				if (wantProtected) {
					const bindings = bindingsGiven ?? (existing?.protected === true ? existing.bindings.map(copyBinding) : []);
					if (bindings.length === 0) {
						throw new KantelError("invalid", "A protected variable needs at least one binding: where its value may go");
					}
					if (body.value === "") throw new KantelError("invalid", "A protected variable's value can't be empty");
					if (body.value !== undefined && sealedGiven === undefined) {
						// It turned protected after the read above: the value wasn't sealed.
						throw new KantelError("conflict", `${name} changed meanwhile; try again`);
					}
					const sealed = sealedGiven ?? existing?.sealed;
					if (sealed === undefined) throw new KantelError("invalid", "The variable needs a value");
					next = { name, protected: true, sealed, bindings, updatedAt: at };
				} else {
					if (sealedGiven !== undefined) {
						// It turned plain after the read above: a value meant to be protected is never kept in the clear.
						throw new KantelError("conflict", `${name} changed meanwhile; try again`);
					}
					if (bindingsGiven !== undefined && bindingsGiven.length > 0) {
						throw new KantelError("invalid", "Only a protected variable has bindings");
					}
					next = { name, protected: false, value: body.value ?? existing?.value ?? "", bindings: [], updatedAt: at };
				}
				touchesSecrets = wantProtected || existing?.protected === true;
				return {
					...current,
					// In its place, or last when it is new.
					variables:
						existing !== undefined
							? current.variables.map((variable) => (variable.name === name ? next : variable))
							: [...current.variables, next],
					secretsVersion: touchesSecrets ? nextSecretsVersion(current.secretsVersion, at) : current.secretsVersion,
					updatedAt: later(current.updatedAt),
				};
			});
			if (touchesSecrets) await pushEnvironment(changed.id, changed.secretsVersion);
			return environmentView(changed);
		},

		deleteEnvironmentVariable: async (principal, { params }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			const existing = environment.variables.find((variable) => variable.name === params.name);
			if (existing === undefined) throw notFound("variable");
			const at = now();
			const changed = await changeEnvironment(environment.id, (current) => ({
				...current,
				variables: current.variables.filter((variable) => variable.name !== params.name),
				secretsVersion: existing.protected ? nextSecretsVersion(current.secretsVersion, at) : current.secretsVersion,
				updatedAt: at,
			}));
			if (existing.protected) await pushEnvironment(changed.id, changed.secretsVersion);
			return environmentView(changed);
		},

		setEnvironmentFile: async (principal, { params, body }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			const path = sandboxPath(body.path);
			if (path === "/") throw new KantelError("invalid", "A secret file needs a file's path");
			// New contents are sealed up front (sealing is async; the change below isn't).
			let given: { readonly sealed: SealedValue; readonly sizeBytes: number } | undefined;
			if (body.content !== undefined) {
				const bytes = body.encoding === "base64" ? base64ToBytes(body.content) : new TextEncoder().encode(body.content);
				if (bytes.byteLength > MAX_ENVIRONMENT_FILE_BYTES) {
					throw new KantelError("invalid", "An environment's secret files are at most 1 MiB in all");
				}
				given = {
					sealed: await requireSealer().seal(bytes, fileAad(environment.id, path)),
					sizeBytes: bytes.byteLength,
				};
			}
			const at = now();
			// Built from the file as the store has it, each time the change runs: a mode-only edit keeps the contents as they
			// are now, and new contents keep the mode as it is now.
			const changed = await changeEnvironment(environment.id, (current) => {
				const existing = current.files.find((file) => file.path === path);
				if (existing === undefined && current.files.length >= MAX_ENVIRONMENT_FILES) {
					throw new KantelError("invalid", `An environment has at most ${MAX_ENVIRONMENT_FILES} secret files`);
				}
				const contents = given ?? existing;
				if (contents === undefined) throw new KantelError("invalid", "A new secret file needs its contents");
				const others = current.files
					.filter((file) => file.path !== path)
					.reduce((total, file) => total + file.sizeBytes, 0);
				if (given !== undefined && others + given.sizeBytes > MAX_ENVIRONMENT_FILE_BYTES) {
					throw new KantelError("invalid", "An environment's secret files are at most 1 MiB in all");
				}
				const file: StoredEnvironmentFile = {
					path,
					mode: body.mode ?? existing?.mode ?? 0o600,
					sizeBytes: contents.sizeBytes,
					sealed: contents.sealed,
					updatedAt: at,
				};
				return {
					...current,
					files:
						existing !== undefined
							? current.files.map((each) => (each.path === path ? file : each))
							: [...current.files, file],
					updatedAt: later(current.updatedAt),
				};
			});
			return environmentView(changed);
		},

		deleteEnvironmentFile: async (principal, { params, query }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			const path = sandboxPath(query.path);
			if (!environment.files.some((file) => file.path === path)) throw notFound("secret file");
			const changed = await changeEnvironment(environment.id, (current) => ({
				...current,
				files: current.files.filter((file) => file.path !== path),
				updatedAt: now(),
			}));
			return environmentView(changed);
		},

		putEnvironmentRepos: async (principal, { params, body }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			const repos = body.repos.map(normaliseRepo);
			const paths = repos.map(clonePath);
			if (new Set(paths).size !== paths.length) {
				throw new KantelError("invalid", "Two repositories would be cloned into one path; give one a path");
			}
			const expected = body.expected === undefined ? undefined : reposKey(body.expected);
			const changed = await changeEnvironment(environment.id, (current) => {
				requireUnchanged(expected, reposKey(current.repos), "The environment's repositories");
				return { ...current, repos, updatedAt: now() };
			});
			return environmentView(changed);
		},

		putEnvironmentGrants: async (principal, { params, body }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			const grants = normaliseGrants(body.grants);
			if (grants.length > 0) await requireEnforcing(await liveFrom(environment.id));
			const expected = body.expected === undefined ? undefined : grantsKey(body.expected);
			const changed = await changeEnvironment(environment.id, (current) => {
				requireUnchanged(expected, grantsKey(current.grants), "The environment's grants");
				return { ...current, grants, updatedAt: later(current.updatedAt) };
			});
			await pushEnvironment(changed.id, undefined);
			return environmentView(changed);
		},

		getSandboxEgress: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "account:read", true);
			return sandboxEgressView(sandbox, query.limit ?? 100);
		},

		putSandboxGrants: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "account:admin");
			const grants = normaliseGrants(body.grants);
			if (grants.length > 0) await requireEnforcing([sandbox]);
			// Its revision moves on with them, in the one write: an egress read before has the older revision, which its host
			// ignores once this one's has come; a boot under way sees it changed and reconciles.
			const expected = body.expected === undefined ? undefined : grantsKey(body.expected);
			const changed = await patchSandbox(sandbox.id, (current) => {
				requireUnchanged(expected, grantsKey(current.grants ?? []), "The sandbox's grants");
				return { ...current, grants, egressRevision: later(current.egressRevision) };
			});
			if (changed === undefined) throw notFound("sandbox");
			if (changed.state === "running") pushEgress([changed]);
			return sandboxEgressView(changed, 100);
		},

		// Events, webhooks and telemetry.

		listEvents: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:read", role);
			const matching = (await store.events.list({ accountId: account.id })).filter(
				(event) =>
					(query.sandboxId === undefined || event.sandboxId === query.sandboxId) &&
					(query.type === undefined || event.type === query.type) &&
					(query.since === undefined || event.createdAt >= query.since),
			);
			// A sandbox's events are seen only by who may see the sandbox (a private one, a limited key's list); one whose
			// sandbox is gone stays with the account's admins and unlimited keys.
			const seen = new Map<string, boolean>();
			const events = [];
			for (const event of matching) {
				if (event.sandboxId === undefined) {
					events.push(event);
					continue;
				}
				let visible = seen.get(event.sandboxId);
				if (visible === undefined) {
					const sandbox = await store.sandboxes.get(event.sandboxId);
					const limited = principal.kind === "key" && principal.limits.sandboxIds !== undefined;
					visible =
						sandbox === undefined
							? !limited && (role === "owner" || role === "admin")
							: await canSee(principal, sandbox, role);
					seen.set(event.sandboxId, visible);
				}
				if (visible) events.push(event);
			}
			const page = paginate([...events].reverse(), query.limit, query.cursor);
			return { items: page.items, nextCursor: page.nextCursor };
		},

		listWebhooks: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:admin", role);
			return { items: (await store.webhooks.list({ accountId: account.id })).map(webhookView) };
		},

		createWebhook: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			checkUrl(body.url, "The webhook's URL");
			const webhook: StoredWebhook = {
				id: randomId("whk"),
				accountId: account.id,
				name: body.name,
				url: body.url,
				events: unique(body.events),
				enabled: true,
				createdAt: now(),
				secret: newWebhookSecret(),
				consecutiveFailures: 0,
			};
			await store.webhooks.put(webhook);
			return { webhook: webhookView(webhook), secret: webhook.secret };
		},

		getWebhook: async (principal, { params }) => webhookView(await webhookFor(principal, params.webhookId)),

		updateWebhook: async (principal, { params, body }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			if (body.url !== undefined) checkUrl(body.url, "The webhook's URL");
			const updated: StoredWebhook = {
				...webhook,
				name: body.name ?? webhook.name,
				url: body.url ?? webhook.url,
				events: body.events === undefined ? webhook.events : unique(body.events),
				enabled: body.enabled ?? webhook.enabled,
				consecutiveFailures: body.enabled === true ? 0 : webhook.consecutiveFailures,
			};
			await store.webhooks.put(updated);
			return webhookView(updated);
		},

		deleteWebhook: async (principal, { params }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			for (const delivery of await store.deliveries.list({ webhookId: webhook.id })) {
				await store.deliveries.delete(delivery.id);
			}
			await store.webhooks.delete(webhook.id);
			return undefined;
		},

		rotateWebhookSecret: async (principal, { params }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			const rotated: StoredWebhook = { ...webhook, secret: newWebhookSecret() };
			await store.webhooks.put(rotated);
			return { webhook: webhookView(rotated), secret: rotated.secret };
		},

		testWebhook: async (principal, { params }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			return deliveryView(await dispatcher.test(webhook.id));
		},

		listWebhookDeliveries: async (principal, { params, query }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			const recent = (await store.deliveries.list({ webhookId: webhook.id })).filter(
				(delivery) => delivery.createdAt >= now() - 30 * DAY_MS,
			);
			const page = paginate(newestFirst(recent), query.limit, query.cursor);
			return { items: page.items.map(deliveryView), nextCursor: page.nextCursor };
		},

		getTelemetry: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:admin", role);
			const telemetry = await store.telemetry.get(account.id);
			if (telemetry === undefined) throw notFound("telemetry export");
			return telemetryView(telemetry);
		},

		putTelemetry: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			checkUrl(body.endpoint, "The endpoint");
			const existing = await store.telemetry.get(account.id);
			const signals: readonly ("metrics" | "logs")[] = body.signals ?? ["metrics", "logs"];
			const configured: StoredTelemetry = {
				id: account.id,
				accountId: account.id,
				endpoint: body.endpoint,
				headerNames: [],
				headers: body.headers === undefined ? (existing?.headers ?? {}) : { ...body.headers },
				signals: unique(signals),
				updatedAt: now(),
			};
			const test = await exporter.test(configured);
			const saved: StoredTelemetry = {
				...configured,
				headerNames: Object.keys(configured.headers),
				lastExport: { at: now(), ok: test.ok, status: test.status, error: test.error },
			};
			await store.telemetry.put(saved);
			return { telemetry: telemetryView(saved), test: { ok: test.ok, status: test.status, error: test.error } };
		},

		deleteTelemetry: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:admin", role);
			await store.telemetry.delete(account.id);
			return undefined;
		},

		// Hosts.

		listHosts: async (principal) => {
			requireScope(principal, "hosts:admin");
			const items: computeSchema.Host[] = [];
			for (const host of await ensureHosts()) items.push(await hostView(host));
			return { items };
		},

		createHostJoinToken: async (principal, { body }, request) => {
			requireScope(principal, "hosts:admin");
			return mintJoinToken(body, request);
		},

		getPublicUrl: async (principal, _input, request) => {
			requireScope(principal, "hosts:admin");
			return publicUrlView(request);
		},

		setPublicUrl: async (principal, { body }, request) => {
			requireScope(principal, "hosts:admin");
			if (body.publicUrl === null) await store.settings.delete("publicUrl");
			else {
				await store.settings.put({
					id: "publicUrl",
					value: publicOrigin(body.publicUrl),
					updatedAt: now(),
					updatedBy: principal.userId,
				});
			}
			return publicUrlView(request);
		},

		getHost: async (principal, { params }) => hostView(await hostFor(principal, params.hostId)),

		updateHost: async (principal, { params, body }) => changeHost(await hostFor(principal, params.hostId), body),

		revokeHost: async (principal, { params }) => revokeStoredHost(await hostFor(principal, params.hostId)),

		// Base images (image patching, experimental).

		listBaseImages: async (principal) => {
			const baseImages = requireImagePatching();
			requireScope(principal, "hosts:admin");
			let index: BaseImageIndex | undefined;
			let error: string | undefined;
			try {
				index = await baseImages.index();
			} catch (failure) {
				error = messageOf(failure);
			}
			return {
				images: (index?.images ?? []).map((image) => {
					const head = image.channels.stable;
					const latest = head === undefined ? undefined : image.versions.find((version) => version.digest === head);
					return {
						name: image.name,
						repository: image.repository,
						channel: "stable" as const,
						...(latest === undefined ? {} : { latest: baseVersionView(latest) }),
						// The index keeps them newest first.
						versions: image.versions.slice(0, BASE_IMAGE_VERSIONS_LISTED).map(baseVersionView),
					};
				}),
				// Templates and their bases come with the templates feature; none until then.
				templates: [],
				indexUrl: baseImages.indexUrl,
				...(index === undefined ? {} : { generatedAt: index.generatedAt }),
				...(error === undefined ? {} : { error }),
			};
		},

		// An account's own hosts.

		createAccountJoinToken: async (principal, { body }, request) => {
			requireAccountHosts();
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			const made = await mintJoinToken(body, request, { accountId: account.id, createdBy: principal.userId });
			return { ...made, accountId: account.id };
		},

		listAccountHosts: async (principal, { query }) => {
			requireAccountHosts();
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			const items: computeSchema.Host[] = [];
			for (const host of await ensureHosts()) {
				if (host.accountId === account.id) items.push(await hostView(host));
			}
			return { items };
		},

		getAccountHost: async (principal, { params }) =>
			hostView((await accountHostFor(principal, params.hostId, "account:read")).host),

		updateAccountHost: async (principal, { params, body }) =>
			changeHost((await accountHostFor(principal, params.hostId, "account:admin")).host, body),

		removeAccountHost: async (principal, { params }) =>
			revokeStoredHost((await accountHostFor(principal, params.hostId, "account:admin")).host),
	};

	// With image patching on, the routes that answer sandboxes or snapshots read the base image index first, so their
	// views (which answer synchronously) say how far behind each base is. The gateway caches the index; this only asks.
	if (options.baseImages !== undefined) {
		const wrapped = handlers as unknown as { [route: string]: (...args: never[]) => Promise<unknown> };
		for (const route of BASE_ROUTES) {
			const handler = wrapped[route];
			if (handler === undefined) continue;
			wrapped[route] = async (...args) => {
				await refreshBase();
				return handler(...args);
			};
		}
	}

	async function idle(): Promise<void> {
		for (;;) {
			const waiting = [...pending.values(), ...background];
			if (waiting.length === 0) return;
			await Promise.all(waiting);
		}
	}

	async function personSummary(userId: string) {
		const user = await store.users.get(userId);
		return user === undefined ? undefined : { id: user.id, name: user.name, email: user.email };
	}

	/** Starts (fresh from the newest snapshot) or resumes (from memory when paused) a sandbox. */
	async function restart(
		principal: Principal,
		sandboxId: string,
		body: { readonly size?: computeSchema.SandboxSizeName; readonly wait?: boolean },
		how: "start" | "resume",
	): Promise<Sandbox> {
		const { sandbox } = await sandboxFor(principal, sandboxId, "sandboxes:write");
		const current = await settledFor(principal, sandbox.id);
		if (current.state === "running") return sandboxView(current, principal);
		if (current.state !== "stopped" && current.state !== "paused" && current.state !== "error") {
			throw new KantelError("conflict", `The sandbox is ${current.state}`);
		}
		if (current.type === "isolate" && body.size !== undefined)
			throw new KantelError("invalid", "Isolates have no size");
		await requireCapacity(current.accountId, 1);
		const hosts = requireHosts(
			await ensureHosts(),
			current.accountId,
			current.type,
			current.hostLabels,
			true,
			await mayShare(principal),
		);
		const fromSnapshot = await latestRef(current);
		const began = await transition(current.id, current.state, (latest) =>
			withState(latest, "starting", {
				size: body.size ?? latest.size,
				pausedSnapshotId: how === "resume" ? latest.pausedSnapshotId : undefined,
				// Its egress is read afresh for the boot: a revision of its own, so an update read before (from when it last
				// ran, still being retried) never equals it, and loses.
				egressRevision: later(latest.egressRevision),
			}),
		);
		if (!("moved" in began)) {
			// Another call (on another gateway) got there first: a sandbox it has started is answered as it is.
			if (began.lost.state === "running" || began.lost.state === "starting") return sandboxView(began.lost, principal);
			throw new KantelError("conflict", `The sandbox is ${began.lost.state}`);
		}
		const starting = began.moved;
		const bootOptions = {
			fromSnapshot,
			size: starting.size,
			env: current.env,
			eligibleHosts: hosts,
			// As written now it is starting: a change from here on moves its revision on, and its boot reconciles.
			...(await egressFor(starting.accountId, starting)),
		};
		const work = track([current.id], () =>
			boot(
				current.id,
				() =>
					bootAgain(current, bootOptions, (options) =>
						how === "start" ? backend.start(current.id, options) : backend.resume(current.id, options),
					),
				undefined,
				{ egressRevision: starting.egressRevision },
			),
		);
		if (body.wait === true) await work;
		else keepGoing(work);
		return sandboxView(await mustGetSandbox(current.id), principal);
	}

	return {
		handlers,
		publicHandlers,

		async stillAllowed(text, sandboxId) {
			if (text === undefined) return true;
			const grantee = decodeGrantee(text);
			if (grantee === undefined) return false;
			let principal: Principal;
			if (grantee.kind === "key") {
				const key = await liveKeyPrincipal(store, grantee.keyId, now());
				if (key === undefined) return false;
				principal = key;
			} else {
				const user = await store.users.get(grantee.userId);
				if (user === undefined) return false;
				if (grantee.session !== undefined && options.sessionLive !== undefined) {
					if (!(await options.sessionLive(grantee.session))) return false;
				}
				principal = {
					kind: "person",
					userId: user.id,
					name: user.name,
					superAdmin: user.superAdmin,
					personalAccountId: user.personalAccountId,
				};
			}
			try {
				await sandboxFor(principal, sandboxId, "access");
				return true;
			} catch (error) {
				if (error instanceof KantelError) return false;
				throw error;
			}
		},

		async sweep() {
			const at = now();
			// The sweep alone stops a sandbox past its time, and only where its host is connected: one on a host that is
			// away (or whose stop didn't get through, `beginStop`) stays running, and a later sweep, as on its host's
			// reconnection, stops it.
			let connected: Set<string> | undefined;
			// A stop it was due for (`stopFor`) that a gateway went before carrying out: decided by a boot that went before
			// taking it on (`starting`, since `stopsAt`), or taken on and never sent (`stopping`, since `stopClaimedAt`).
			// Running again, where its machine may be, and due now, for the pass below to stop. One this gateway is still
			// working on is left to it, as is one within its lease (its gateway may be at it).
			for (const state of ["starting", "stopping"] as const) {
				for (const sandbox of await store.sandboxes.list({ state })) {
					const since = state === "stopping" ? sandbox.stopClaimedAt : sandbox.stopsAt;
					if (sandbox.stopFor === undefined || since === undefined || pending.has(sandbox.id)) continue;
					if (since + STOP_LEASE_MS > at) continue;
					const marker = (current: StoredSandbox) =>
						current.stopFor === sandbox.stopFor &&
						(state === "stopping" ? current.stopClaimedAt : current.stopsAt) === since;
					await transition(
						sandbox.id,
						state,
						(current) => ({
							...current,
							state: "running",
							stopsAt: at,
							stopClaimedAt: undefined,
							reason: undefined,
						}),
						marker,
					).catch(() => undefined);
				}
			}
			for (const sandbox of await store.sandboxes.list({ state: "running" })) {
				// An egress update that didn't get through (its host away, a call that failed) is sent again, as it is now,
				// once its host is there: a later revision the host has taken already makes this one moot.
				if (
					backend.updateEgress !== undefined &&
					sandbox.egressRevision !== undefined &&
					(sandbox.egressApplied ?? Number.NEGATIVE_INFINITY) < sandbox.egressRevision &&
					!delivering.has(sandbox.id)
				) {
					connected ??= await connectedHosts();
					if (sandbox.hostId !== undefined && connected.has(sandbox.hostId)) pushEgress([sandbox]);
				}
				// Due: past its time, or owed a stop (`stopFor`), whatever its time says.
				const due = (current: StoredSandbox) =>
					current.stopFor !== undefined || (current.stopsAt !== undefined && current.stopsAt <= at);
				if (!due(sandbox) || pending.has(sandbox.id)) continue;
				connected ??= await connectedHosts();
				if (sandbox.hostId === undefined || !connected.has(sandbox.hostId)) continue;
				// Every gateway sweeps: `beginStop` moves it only while it is still running, so one of them stops it and the
				// rest skip it.
				const reason = sandbox.stopFor ?? "auto-stop";
				const began = await beginStop(sandbox, false, reason, undefined, due, true).catch(() => undefined);
				if (began !== undefined) keepGoing(began.work);
			}
		},

		async sampleUsage() {
			const samples: TelemetryUsageSample[] = [];
			for (const sandbox of await store.sandboxes.list({ state: "running" })) {
				const sample = await recordSample(sandbox.id);
				if (sample !== undefined) samples.push(sample);
			}
			return samples;
		},

		async hostE2EChain(hostId, space) {
			await hostMayUseChain(hostId, space);
			return e2eChains.read(space);
		},

		async appendHostE2EChain(hostId, space, from, entries) {
			await hostMayUseChain(hostId, space);
			return e2eChains.append(space, from, entries, (payload) => {
				if (payload.type !== "host.add" || payload.body.host.id !== hostId) {
					throw new KantelError("forbidden", "A host adds only its own host.add");
				}
			});
		},

		async protectedTable(hostId, sandboxId) {
			const sandbox = await store.sandboxes.get(sandboxId);
			// Only the host the sandbox is on: another host asking learns nothing, not even that it exists.
			if (sandbox === undefined || sandbox.state === "deleted" || sandbox.hostId !== hostId) return undefined;
			const environment =
				sandbox.environmentId === undefined ? undefined : await store.environments.get(sandbox.environmentId);
			// Its environment deleted: nothing resolves, at a version past any it was given.
			if (environment === undefined) return { version: now(), entries: [] };
			const entries: ProtectedEntry[] = [];
			for (const [name, placeholder] of Object.entries(sandbox.placeholders ?? {})) {
				const variable = environment.variables.find((each) => each.name === name);
				if (variable === undefined || !variable.protected || variable.sealed === undefined) continue;
				const value = await requireSealer().openText(variable.sealed, variableAad(environment.id, name));
				entries.push({
					placeholder,
					name,
					value,
					bindings: variable.bindings.map((binding) => ({
						host: binding.host,
						pathPrefixes: [...(binding.pathPrefixes ?? [])],
						methods: [...(binding.methods ?? [])],
					})),
				});
			}
			return { version: environment.secretsVersion, entries };
		},

		async recordBases(hostId, reports) {
			for (const { sandboxId, base } of reports) {
				if (typeof sandboxId !== "string" || typeof base !== "string" || !REPORTED_BASE.test(base)) continue;
				const sandbox = await store.sandboxes.get(sandboxId);
				if (sandbox === undefined || sandbox.hostId !== hostId || sandbox.base === base) continue;
				if (sandbox.state === "deleted" || sandbox.state === "deleting") continue;
				await store.sandboxes.update(sandboxId, (current) =>
					current.hostId === hostId && current.base !== base ? { ...current, base } : current,
				);
			}
		},

		async recordEgress(hostId, records) {
			const bySandbox = new Map<string, ReportedEgress[]>();
			for (const record of records) {
				if (typeof record?.sandboxId !== "string") continue;
				const batch = bySandbox.get(record.sandboxId) ?? [];
				batch.push(record);
				bySandbox.set(record.sandboxId, batch);
			}
			for (const [sandboxId, batch] of bySandbox) {
				const sandbox = await store.sandboxes.get(sandboxId);
				// A host reports only its own sandboxes; anything else is dropped.
				if (sandbox === undefined || sandbox.hostId !== hostId) continue;
				for (const record of batch.slice(-MAX_EGRESS_ENTRIES)) {
					await store.egress.put(egressEntryFrom(record, sandbox, now()));
				}
				const log = await egressLog(sandboxId);
				for (const stale of log.slice(MAX_EGRESS_ENTRIES)) await store.egress.delete(stale.id);
			}
		},

		async close() {
			for (const controller of runningCommands.values()) controller.abort();
			await idle();
		},

		idle,
	};
}

/** A base a host may report: a host images version (such as host-images-20261104.812) or an image digest. */
const REPORTED_BASE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/;

/** A host's report as a log entry: checked field by field, as a host is trusted with no more than its own sandboxes. */
function egressEntryFrom(record: ReportedEgress, sandbox: StoredSandbox, at: number): StoredEgressEntry {
	const text = (value: unknown, length: number): string | undefined =>
		typeof value === "string" && value !== "" ? clip(value, length) : undefined;
	// Never a query string or a fragment, even when a host sends one.
	const path = text(record.path, 2048)?.split(/[?#]/, 1)[0];
	const reason = text(record.reason, 500);
	const rule = text(record.rule, 500);
	const code = text(record.code, 64);
	const status = whole(record.status);
	const swapped: unknown[] = Array.isArray(record.swapped) ? [...record.swapped] : [];
	return {
		id: randomId("egr", 12),
		sandboxId: sandbox.id,
		accountId: sandbox.accountId,
		at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : at,
		method: text(record.method, 16)?.toUpperCase() ?? "CONNECT",
		host: text(record.host, 253) ?? "",
		port: whole(record.port),
		...(path === undefined || path === "" ? {} : { path }),
		decision: record.allowed === true ? "allowed" : "denied",
		...(reason === undefined ? {} : { reason }),
		...(rule === undefined ? {} : { rule }),
		...(code === undefined ? {} : { code }),
		swapped: swapped.filter((name): name is string => typeof name === "string").map((name) => clip(name, 255)),
		inspected: record.inspected === true,
		...(status === 0 ? {} : { status }),
		bytesUp: whole(record.bytesUp),
		bytesDown: whole(record.bytesDown),
	};
}
