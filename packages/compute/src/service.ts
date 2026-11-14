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
 * Cost uses a rate table per vCPU and per GB of memory an hour; the default, `PLACEHOLDER_RATES`, is a placeholder until
 * real pricing exists. CPU seconds are estimated from the usage readings taken while a sandbox runs.
 *
 * An environment is what a sandbox starts with: plain variables, protected ones, secret files, repositories and egress
 * grants. A protected variable's value is sealed (`secrets.ts`) and never answered: the sandbox gets a placeholder of
 * its own, and only the sandbox's host is given the value (`protectedTable`, over its link), for its egress proxy to
 * swap in on requests to the variable's bindings.
 *
 * A template (experimental, `templates.ts`) is a versioned microVM profile whose snapshots are built in the background
 * and kept as a cache apart from the account's snapshots; a create naming one starts from its newest ready snapshot, or
 * boots fresh.
 */
import { computeSchema, type PublicComputeRoutes, type RouteHandlers, type SignedInComputeRoutes } from "@kantel/api";
import {
	INVITE_EMAIL_MAX_LENGTH,
	KantelError,
	MOUNTS_OFF,
	mountCovering,
	mountsTouching,
	normaliseEmail,
	type PlacementReason,
	placementError,
	placementReasonOf,
} from "@kantel/contracts";
import { MOUNT_SYSTEM_PATHS } from "@kantel/contracts/mounts";
import {
	type Acting,
	accountById,
	actingAccount,
	decodeGrantee,
	defaultAccountOf,
	encodeGrantee,
	keyPrincipal,
	liveKeyPrincipal,
	liveTokenPrincipal,
	memberId,
	newApiKeySecret,
	newPersonalTokenSecret,
	type PersonPrincipal,
	type Principal,
	personalAccountIdOf,
	requireGrantable,
	requirePerson,
	requireScope,
	requireSignIn,
	requireUnlimitedToken,
	roleIn,
	tokenRefusal,
} from "./auth.ts";
import {
	type BackendCapabilities,
	type BackendDiskUsage,
	type BackendEgress,
	type BackendEgressGrant,
	type BackendFileEntry,
	type BackendHost,
	type BackendMountStatus,
	type BackendShape,
	type BackendSize,
	type BackendStickyDisk,
	type BackendStickyDiskStatus,
	type BootOptions,
	type CommandProgress,
	type ExecResult,
	hostNotConnected,
	isCommandProgress,
	isDetachedWaitEnded,
	isUpgradeOutcomeUnknown,
	type Placement,
	refusedBeforeTheMachine,
	type SandboxBackend,
	type SandboxSpec,
	type SandboxTemplateBoot,
	type SharedSnapshotBytes,
	SNAPSHOT_KEEP_FEATURE,
	type SnapshotCopies,
	type SnapshotMadeOn,
	type TakenSnapshot,
	type UpgradedPlacement,
	type UpgradeOutcome,
} from "./backend.ts";
import type { BaseImageIndex, BaseImageVersion } from "./base-images.ts";
import { type BaseImages, baseImageOf, baseStatus, HOST_BASE_IMAGE, hostImageChannel } from "./base-status.ts";
import {
	createDiskHolders,
	type DiskLocateRequest,
	type DiskLocation,
	GRANT_KEY_UNAVAILABLE,
	type GrantKeyring,
	type GrantKeyView,
	type HoldingsReport,
} from "./disk-holders.ts";
import {
	composeEnv,
	type EnvironmentResolution,
	environmentFields,
	environmentIdsOf,
	envLayersOf,
	MAX_SANDBOX_ENVIRONMENTS,
	protectedClashes,
	protectedWinners,
	resolveEnvironments,
	secretsVersionOf,
	shadowedOf,
} from "./environment-resolution.ts";
import { createGithubApp, type GithubApp, importAppKey } from "./github-app.ts";
import {
	createGithubRunners,
	kindView,
	newGithubRunnersId,
	type RunnerPool,
	type StoredGithubRunners,
} from "./github-runners.ts";
import { createLiveFeed, type LiveRelay, type WatchVerdict, watchResponse, watchSandboxes } from "./live.ts";
import {
	type AskedMachine,
	copiedOn,
	copiedResources,
	diskLimitsOf,
	makesCustom,
	makesShape,
	memoryOf,
	recordedMachine,
	recordsMachine,
	requireMinMemory,
	restoreAsked,
	sandboxMachine,
} from "./machine.ts";
import type { MountsOptions, ResolvedBucketSource, StoredBlob } from "./mounts.ts";
import {
	backendMounts,
	createMounts,
	laterMountsAt,
	type MountHandlers,
	mountsAfter,
	pendingMounts,
	reportMountStatuses,
} from "./mounts-service.ts";
import { isPlaceholderName, personName } from "./names.ts";
import {
	delay,
	portNotRunningText,
	START_HOLD_MS,
	START_POLL_MS,
	sandboxNotRunning,
	sandboxUnresponsive,
} from "./not-running.ts";
import { createPoolService, defaultPoolOf, type PoolRunners, poolOwnerOf } from "./pools.ts";
import { createEphemeralSealer, createSealer, type SealedValue, type Sealer, sealedAt } from "./secrets.ts";
import { COPY_RETRY_MS, type CopyHost, copyTarget, keepingCopies, SNAPSHOT_COPIES } from "./snapshot-copies.ts";
import type {
	ComputeStore,
	OOMPending,
	ProvisionWork,
	RunPeriod,
	StoredAccount,
	StoredApiKey,
	StoredCommand,
	StoredDeletion,
	StoredDeviceLogin,
	StoredDiskHolder,
	StoredEgressEntry,
	StoredEnvironment,
	StoredEnvironmentFile,
	StoredEnvironmentVariable,
	StoredHost,
	StoredIdempotency,
	StoredInvite,
	StoredJoinToken,
	StoredPeak,
	StoredPersonalToken,
	StoredPool,
	StoredProxy,
	StoredSample,
	StoredSandbox,
	StoredSnapshot,
	StoredStickyDisk,
	StoredStickyDiskVersion,
	StoredTelemetry,
	StoredUsageClaim,
	StoredUser,
	StoredWebhook,
} from "./store.ts";
import {
	diskHolderId,
	OPERATOR_POOLS,
	STICKY_PREFETCH_MS,
	stickyDiskNameId,
	UniqueViolation,
	usageClaimId,
} from "./store.ts";
import type { TelemetryExporter, TelemetryUsageSample } from "./telemetry.ts";
import { createTemplateService, DEFAULT_TEMPLATE_RESOURCES, templateBootImage } from "./templates.ts";
import {
	type BackendUsageReport,
	createUsageSeries,
	RAW_WINDOW_MS,
	type ReportedUsage,
	ROLLUP_MS,
	type Rollup,
	SPARKLINE_POINTS,
	USAGE_INTERVAL_MS,
} from "./usage-series.ts";
import {
	base64ToBytes,
	bytesToBase64,
	HOME,
	homeFor,
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

/** Whether two lists of IDs are the same, in the same order. */
const sameIds = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id, index) => id === b[index]);

/** `pendingProvision` without an environment's own set-up (its files and repositories). */
const pendingWithout = (
	sandbox: Pick<StoredSandbox, "pendingProvision">,
	environmentId: string,
): Pick<StoredSandbox, "pendingProvision"> => {
	const pending = (sandbox.pendingProvision ?? []).filter((work) => work.environmentId !== environmentId);
	return { pendingProvision: pending.length === 0 ? undefined : pending };
};

/** The set-up an environment a sandbox has just been given needs: its files, and its repositories. */
const workFor = (environment: StoredEnvironment): ProvisionWork[] => [
	...(environment.files.length > 0
		? [{ id: randomId("pw", 8), kind: "files" as const, environmentId: environment.id }]
		: []),
	...(environment.repos.length > 0
		? [{ id: randomId("pw", 8), kind: "repos" as const, environmentId: environment.id }]
		: []),
];

/** The secret file paths whose winning environment differs between two resolutions, and that one of `after` wins. */
const changedWinners = (before: EnvironmentResolution, after: EnvironmentResolution): string[] =>
	[...after.files.entries()]
		.filter(([path, winner]) => before.files.get(path)?.environment.id !== winner.environment.id)
		.map(([path]) => path);

/** The environments whose repositories a boot's set-up may clone once it runs, as the call read them. */
interface Provisioning {
	readonly environments: readonly StoredEnvironment[];
}

/** What decides a sandbox's egress besides its account's proxy settings. */
type EgressSubject = Pick<
	StoredSandbox,
	"environmentId" | "environmentIds" | "placeholders" | "grants" | "egressRevision" | "env" | "secretsFloor"
>;

/** What an hour of running costs: a microVM by its vCPUs and memory, an isolate by its memory (its CPU is shared). */
export interface RateTable {
	/** ISO 4217. */
	readonly currency: string;
	readonly microvmPerVcpuHour: number;
	readonly microvmPerGbHour: number;
	readonly isolatePerGbHour: number;
}

/** A placeholder until real pricing exists: rough figures so the console has something to show. */
export const PLACEHOLDER_RATES: RateTable = {
	currency: "USD",
	microvmPerVcpuHour: 0.0075,
	microvmPerGbHour: 0.00125,
	isolatePerGbHour: 0.02,
};

/** What an hour of a sandbox of `type` with these resources costs at `rates`. */
export function hourlyRate(
	rates: RateTable,
	type: computeSchema.SandboxType,
	resources: { readonly vcpus: number; readonly memoryMb: number },
): number {
	const gb = resources.memoryMb / 1024;
	const rate =
		type === "isolate"
			? gb * rates.isolatePerGbHour
			: resources.vcpus * rates.microvmPerVcpuHour + gb * rates.microvmPerGbHour;
	return Math.round(rate * 1e6) / 1e6;
}

/** A microVM's memory may be this much per vCPU, at least and at most. */
export const MEMORY_MB_PER_VCPU = { min: 512, max: 8192 } as const;
/** A microVM's memory moves in steps of this. */
const MICROVM_MEMORY_STEP_MB = 512;
/** No host takes more vCPUs than this (Firecracker's limit). */
const MAX_VCPUS = 32;
/** No host takes a disk larger than this (`kantel-host`'s most for a custom shape). */
const MAX_DISK_GB = 4096;

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
	/** The API's base path, where its routes are served (`createComputeApi`'s `basePath`), for the URLs it mints. Default `/v1`. */
	readonly apiBasePath?: string;
	/** Default `selfhosted`. */
	readonly mode?: "selfhosted" | "hosted";
	/**
	 * The domain sandboxes' addresses are under (`<subdomain>.<domain>`, ports `<port>-<subdomain>.<domain>`), which the
	 * caller is told so the console names them as the deployment serves them. Absent, none is named.
	 */
	readonly sandboxDomain?: string;
	/** The join command shown with a host join token, with `{url}` and `{token}`. Default the npm package's. */
	readonly hostJoinCommand?: string;
	/**
	 * Account hosts (experimental): an account's people add hosts of its own (`/v1/hosts`), which only its
	 * sandboxes use. Off, those routes answer `not_supported`. Default off; the gateways turn it on with
	 * `KANTEL_ACCOUNT_HOSTS=experimental`, and only where sandboxes run on hosts.
	 */
	readonly accountHosts?: boolean;
	/**
	 * Read-only mounts, bundles, bucket sources, signed file URLs and archive extraction (experimental). Absent, off:
	 * their routes, and a create naming `mounts`, answer `not_supported`. The gateways turn it on with
	 * `KANTEL_MOUNTS=experimental`.
	 */
	readonly mounts?: MountsOptions;
	/**
	 * Templates (experimental, `templates.ts`): versioned microVM profiles and their snapshot cache (`/v1/templates`).
	 * Off, those routes and a create naming a template answer `not_supported`, as they do with a backend that has no
	 * templates. Default off; the gateways turn it on with `KANTEL_TEMPLATES=experimental`.
	 */
	readonly templates?: boolean;
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
	 * Removes a person from the deployment's sign-in once `deleteCaller` has removed them here: their user, the ways
	 * they sign in and their sessions, so they are signed out everywhere. Absent, only the compute plane's records go.
	 */
	readonly deletePerson?: (userId: string) => Promise<void>;
	/**
	 * Wakes the deployment at `at` to carry on account deletions (`carryOnDeletions`), where nothing else would: the hosted
	 * stack object sleeps between requests. Absent, the sweep carries them on (self-hosted sweeps on a timer).
	 */
	readonly wakeAt?: (at: number) => Promise<void> | void;
	/**
	 * Whether a person administers the deployment, whichever organisation a call names: `deleteCaller` refuses them, as
	 * the deployment needs its administrators. Absent, `superAdmin` on the call alone decides.
	 */
	readonly deploymentAdmin?: (userId: string) => Promise<boolean>;
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
	/** Emails an invite made for an address, with a link that joins with its code. Absent, Kantel sends none. */
	readonly invites?: InviteMailing;
	/**
	 * Carries sandboxes' changes between gateways over one database (`live.ts`), so a console watching on one sees what
	 * another did. Absent, one process alone: its own changes only.
	 */
	readonly liveRelay?: LiveRelay;
	/**
	 * How long a call that needs a running sandbox (a command, a file) waits for one that is starting, before it answers
	 * `conflict` with `sandbox_starting`. Not counted against a command's own timeout. Default `START_HOLD_MS`, 60 s.
	 */
	readonly startHoldMs?: number;
	/**
	 * Expiry of automatic snapshots (`expireSnapshots`). Off by default: it relies on every gateway adopting a snapshot
	 * it makes a sandbox from (`adopt`), so a replicated install turns it on only once every gateway runs a version that
	 * does. On, the first pass waits `snapshotExpiryDelayMs` after the process starts, so the requests an older version's
	 * process still had in flight (a single instance being replaced) have ended.
	 */
	readonly snapshotExpiry?: boolean;
	/** How long after it starts a process first expires snapshots. Default `SNAPSHOT_EXPIRY_START_DELAY_MS`, 15 minutes. */
	readonly snapshotExpiryDelayMs?: number;
	/** How often such a call reads a starting sandbox again, for a start another gateway carries out. Default 250 ms. */
	readonly startPollMs?: number;
	/**
	 * GitHub Actions runners (experimental, `github-runners.ts`): GitHub Apps whose `workflow_job` webhooks get ephemeral
	 * microVM runners (`/v1/github-runners`). Absent, off: their routes answer `not_supported`. The gateways turn it on
	 * with `KANTEL_GITHUB_RUNNERS=experimental`, and only where sandboxes run on hosts.
	 */
	readonly githubRunners?: GithubRunnersSettings;
	/**
	 * Sticky disks (experimental, docs/design/disk-store.md): an account's named, versioned disks, cloned into microVMs
	 * (`/v1/sticky-disks`, `stickyDisks` in a create). Absent, off: their routes and a create naming them answer
	 * `not_supported`, as they do with a backend that has none. The gateways turn it on with
	 * `KANTEL_STICKY_DISKS=experimental`.
	 */
	readonly stickyDisks?: boolean;
}

/** How the GitHub runner broker reaches GitHub (`ComputeServiceOptions.githubRunners`). */
export interface GithubRunnersSettings {
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	readonly log?: (message: string) => void;
	/** Makes the App's client; tests give a stand-in. Default `createGithubApp`. */
	readonly app?: (credentials: { readonly appId: number; readonly privateKey: string }) => GithubApp;
}

/** One invite to email: the same message as identity's `InviteMessage`, so its mailers send it as they are. */
export interface InviteMail {
	readonly to: string;
	/** The organisation's name. */
	readonly organisation: string;
	/** Who made the invite: their email, or their name without one. */
	readonly invitedBy: string;
	/** The console, opened on the join with the invite's code (`inviteLink`). */
	readonly link: string;
	readonly expiresAt: number;
}

/** How a deployment emails invites (`ComputeServiceOptions.invites`). */
export interface InviteMailing {
	send(mail: InviteMail): Promise<void>;
	/**
	 * Whether `email` can sign in to follow the link. An invite to an address that can't isn't emailed (its code is shown
	 * to pass on instead), since its link would lead nowhere. Without it, every address can (open sign-up).
	 */
	readonly canSignIn?: (email: string) => Promise<boolean>;
	/** The console's address, which the link opens. Default the address the invite was made at. */
	readonly consoleUrl?: string;
	/** A send that failed, for the log: the invite stands, and the console shows its code to pass on instead. */
	readonly onMailError?: (error: unknown, to: string) => void;
}

/**
 * The link in an invite's email: the console, which opens Join with the code. The code goes in the fragment, which a
 * browser never sends, so it stays out of every request log on the way.
 */
export function inviteLink(consoleUrl: string, code: string): string {
	return `${consoleUrl.replace(/\/+$/, "")}/organisation#join=${encodeURIComponent(code)}`;
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
/** How often an upgrade under way says it is (`upgrading.heartbeatAt`). */
export const UPGRADE_HEARTBEAT_MS = 20_000;
/** How long an upgrade may go without saying so before the sweep settles it with its backend. */
export const UPGRADE_STALE_MS = 2 * 60_000;
/** How long a command's end that needs a microVM waits for its owner to record it with its run again. */
export const RERUN_CLAIM_MS = 10 * 60_000;
/** What an upgrade whose outcome can't be told yet answers. */
export const UPGRADE_OUTCOME_UNKNOWN =
	"The sandbox's host didn't answer, so whether it is a microVM yet isn't known: it stays starting until Kantel " +
	"settles the upgrade with its host, and is then the microVM or the isolate it was";

/** What an upgrade is refused with where no backend upgrades isolates. */
export const UPGRADE_UNSUPPORTED =
	"This deployment's hosts don't upgrade isolates to microVMs; make a microVM and copy the files across";

/** What an upgrade into a snapshot whose pool can't be told is told to do instead (`poolOfSnapshot`). */
const UPGRADE_IN_POOL = "upgrade into a snapshot saved in the sandbox's pool";

export const SHARED_HOSTS_REFUSED =
	"This sandbox is on the deployment's shared hosts, which are for its own organisation; use a host of your own";

/** A sandbox whose making from another failed, with nothing left to make it from. */
export const NEVER_MADE =
	"This sandbox was never made from its source, and there's no snapshot left to make it from; fork or create it again";

/** A sandbox's reason once its host is revoked (`strandOn`). */
export const HOST_REVOKED_REASON = "Its host was revoked, so it can't be reached; delete it to write it off";

/**
 * Why a sandbox whose guest agent stopped answering is in `error`: the host's words (how long, whether it is out of
 * memory), and what to do, which a host's reason may already say.
 */
export function unresponsiveReason(reported: string | undefined): string {
	const said = reported?.trim().replace(/\.$/, "") ?? "";
	const why = said === "" ? "Its guest agent stopped answering" : said;
	return /\brecover\b/i.test(why) ? why : `${why}. Recover it: a restart that keeps its disk`;
}
/**
 * Why a running sandbox whose host ended its VM (`ComputeService.reportExit`) is in `error`: the host's words (its memory
 * guard stopped it, the kernel killed it at the host's memory limit, it crashed, the host restarted), and what to do. Its
 * disk is kept on its host, so a start boots it from there.
 */
export function hostExitReason(reported: string | undefined): string {
	const said = reported?.trim().replace(/\.$/, "").slice(0, 1000) ?? "";
	const why = said === "" ? "Its host stopped its VM" : `${said.charAt(0).toUpperCase()}${said.slice(1)}`;
	return `${why}. Start it again to boot it from its disk, which is kept`;
}
/** A host whose credential no running backend holds (an account's own, account hosts off) can't be revoked. */
export const HOST_NOT_REVOCABLE =
	"This host's credential is kept by a part of the deployment that is off (account hosts); turn it on to revoke the host";

/** What someone kept off the shared hosts is told when they rotate a key that isn't. */
export const SHARED_KEY_REFUSED =
	"This key may use the deployment's shared hosts, which you may not, so you can't take its secret; revoke it instead";

/**
 * What someone joining with an invite made for another email is told: both emails, so they can sign in as the one it
 * was made for. Whoever holds the code was given it, so naming the invited email tells them nothing new.
 */
export function inviteForSomeoneElse(invited: string, signedInAs: string | undefined): string {
	const as = signedInAs === undefined || signedInAs === "" ? "with no email" : `as ${normaliseEmail(signedInAs)}`;
	return `This invite is for ${normaliseEmail(invited)}, but you're signed in ${as}. Sign in as ${normaliseEmail(invited)} to join.`;
}

/** An invite's email as it is kept: trimmed and lower-cased, so it matches the email the person signs in with. */
function inviteEmail(email: string): string {
	const normalised = normaliseEmail(email);
	if (normalised.length > INVITE_EMAIL_MAX_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(normalised)) {
		throw new KantelError("invalid", "The invite's email is not an email address");
	}
	return normalised;
}

export interface ComputeService {
	/** A handler for every compute route that signs the caller in, given the signed-in caller. */
	readonly handlers: RouteHandlers<SignedInComputeRoutes, Principal>;
	/** A handler for each route that takes no credential (`publicComputeRoutes`), given no caller. */
	readonly publicHandlers: RouteHandlers<PublicComputeRoutes, undefined>;
	/**
	 * Stops every running sandbox whose `stopsAt` has passed, and with templates on reconciles every template's snapshot
	 * cache (which notices hosts' runtimes changing).
	 */
	sweep(): Promise<void>;
	/**
	 * Answers a GitHub App's webhook for a runner integration (`POST /v1/github-runners/{id}/webhook`, no sign-in: its
	 * signature is the check). `not_supported` while GitHub runners are off.
	 */
	githubWebhook(integrationId: string, request: Request): Promise<Response>;
	/**
	 * One pass of the GitHub runner broker over every integration: runners made for queued jobs, booted ones registered,
	 * ended ones deleted. Answers when the next is due (undefined with none, or while it is off): for a deployment that
	 * wakes for it (`wakeAt`).
	 */
	tickGithubRunners(): Promise<number | undefined>;
	/**
	 * Carries on every account deletion whose pass is due, waiting for each, and answers when the next is due (undefined
	 * with none): for a deployment that wakes for them (`wakeAt`).
	 */
	carryOnDeletions(): Promise<number | undefined>;
	/**
	 * Counts a use of a sandbox toward its idle stop (`idleStopMinutes`): a relayed port stream opened or carrying bytes
	 * (SSH, the desktop or browser, a hosted port's request or WebSocket). Cheap enough for every frame: it is kept in
	 * memory, and written as the sandbox's `lastActiveAt` at most once each `ACTIVITY_WRITE_MS` (the sweep writes what
	 * was held). Calls that need a running sandbox (commands, files, ports) count by themselves.
	 */
	noteActivity(sandboxId: string): void;
	/**
	 * What a request to a hosted port of a sandbox that isn't running is told, in words: that it is stopped (or paused,
	 * starting, in error) and why, and how it is resumed. Undefined while it runs, or when it is gone. Nothing resumes it:
	 * Kantel never resumes a sandbox for a call, as for a command (`not-running.ts`).
	 */
	portNotRunning(sandboxId: string): Promise<string | undefined>;
	/**
	 * Makes `digest` a template base channel's current one (the image patching pipeline's call, as the super-admin's
	 * `POST /v1/template-bases` is), and rebuilds the templates following it in the background. `not_supported` while
	 * templates are off.
	 */
	publishTemplateBase(input: computeSchema.PublishTemplateBaseBody): Promise<computeSchema.TemplateBaseChannel>;
	/**
	 * Whether `grantee` (`encodeGrantee`) may still open `sandboxId`'s access: the key unrevoked and unexpired, or the
	 * person's sign-in live, and either still able to see the sandbox with the `access` scope. A relay asks while access
	 * it carries lasts. No grantee named: true.
	 */
	stillAllowed(grantee: string | undefined, sandboxId: string): Promise<boolean>;
	/**
	 * The running sandboxes' readings since the last call, for the metrics export: what their hosts reported
	 * (`recordUsage`), and for a host that doesn't report, one read now by running a command in the sandbox.
	 */
	sampleUsage(): Promise<TelemetryUsageSample[]>;
	/**
	 * Takes a host's usage tick (`HostUsageReport` in @kantel/hosts): its own readings and its sandboxes', kept in
	 * memory for an hour as they came and as 5-minute means, a sandbox's in its record. Readings for a sandbox not on
	 * `hostId` are dropped. A host's ticks are taken in the order they came. `shared`: another gateway replica, the one
	 * holding the host's connection, passed it on; that one exports it to telemetry, so this one doesn't. A numbered tick
	 * (`seq` and `run`) taken already, as one sent again after a reconnect is, resolves without being taken twice. It
	 * resolves once the tick is in its series: what the host's link acknowledges (`usage.ack`).
	 */
	recordUsage(hostId: string, report: ReportedUsage, how?: { readonly shared?: boolean }): Promise<void>;
	/**
	 * A sandbox's protected values, opened, for the host that asked over its link (`secrets.fetch`): `undefined` unless
	 * the sandbox's recorded host is `hostId`, so a host learns only its own sandboxes' values. `unavailable` when a value
	 * doesn't open.
	 */
	protectedTable(hostId: string, sandboxId: string): Promise<ProtectedTable | undefined>;
	/**
	 * A sandbox's env as it is now, for the host that asked over its link (`env.fetch`), which applies a `sandbox.env`
	 * from it: `undefined` unless the sandbox's recorded host is `hostId`.
	 */
	sandboxEnv(hostId: string, sandboxId: string): Promise<{ env: { [name: string]: string } } | undefined>;
	/**
	 * Keeps what a host's egress proxy reported, in each sandbox's log (the newest `MAX_EGRESS_ENTRIES`). Records for a
	 * sandbox not on `hostId` are dropped, and a path's query string is never kept.
	 */
	recordEgress(hostId: string, records: readonly ReportedEgress[]): Promise<void>;
	/**
	 * Fills in the bases a host says its sandboxes' disks and its snapshots are on (image patching, experimental: its
	 * hello, its events and its snapshot list), so what was made before the host versioned its images shows its base
	 * without another boot. Only a sandbox on `hostId`, or a snapshot whose ref is that host's. A sandbox's report is
	 * ordered by its `baseAt`, the time the host put it on that base: it fills a missing base, and replaces one only when
	 * later than the time recorded (a rebase boot whose answer was lost), so one read before a boot never undoes it. A
	 * snapshot's base never changes, so only a missing one is filled. Only a base that looks like one (a host images
	 * version or a digest).
	 */
	recordBases(hostId: string, reports: BaseReports): Promise<void>;
	/**
	 * Updates the sizes of a host's snapshots to the space they take on its disk now, as it measures them (`snapshot.list`
	 * with `HOST_FEATURES.snapshotSizes`): only a snapshot whose ref is that host's, and only where the size changed.
	 * Where the host says what is each snapshot's own (`uniqueBytes`) and which files several share (`shared`), each
	 * shared file counts once, for the holder this plane's records say keeps it (`attributeSnapshotBytes`). Every record
	 * of the same bytes (a save shares its source's ref) gets the same size.
	 */
	recordSnapshotSizes(
		hostId: string,
		sizes: readonly SnapshotSizeReport[],
		shared?: readonly SharedSnapshotBytes[],
	): Promise<void>;
	/**
	 * A bundle's tar, for the host that asked (`GET /v1/hosts/bundles/{digest}`): `undefined` unless `sandboxId` is on
	 * `hostId` (or still starting, so being placed there) and mounts `digest`. Mounts off: always `undefined`.
	 */
	bundleForHost(hostId: string, sandboxId: string, digest: string): Promise<StoredBlob | undefined>;
	/**
	 * A bucket source with its credentials opened, for the host that asked over its link (`bucket.fetch`): `undefined`
	 * unless `sandboxId` is on `hostId` (or still starting) and mounts `bucketSourceId`. `unavailable` when its
	 * credentials don't open. Mounts off: always `undefined`.
	 */
	bucketSourceForHost(
		hostId: string,
		sandboxId: string,
		bucketSourceId: string,
	): Promise<ResolvedBucketSource | undefined>;
	/**
	 * A host's word on whether a running microVM's guest agent answers (`HOST_FEATURES.guestHealth`), from its events and
	 * its hello: `health` `unresponsive`, with the host's `reason`, marks a `running` sandbox on `hostId` so, which
	 * refuses its commands and files at once (they would hang); anything else, once its agent answers again, makes it `ok`.
	 * `healthAt` is the host's clock when it set the health: a report no later than the last taken is dropped. Dropped for
	 * a sandbox on another host or in any other state (one being recovered, stopped or started is that call's).
	 */
	reportHealth(
		hostId: string,
		sandboxId: string,
		health: string | undefined,
		reason: string | undefined,
		healthAt?: number,
	): Promise<void>;
	/**
	 * A host's word that a microVM it ran ended without Kantel asking (its memory guard stopped it, the kernel killed it
	 * at the host's memory limit, it crashed, or the host restarted under it): a `running` sandbox on `hostId` moves to
	 * `error` with the host's `error` as its reason (`hostExitReason`) and its ports cleared, its commands end, and it
	 * emits `sandbox.error`. Dropped for a sandbox on another host or in any other state: a stop, start, recovery or
	 * delete under way owns its outcome. `healthAt` is the host's last health stamp for the machine that ended (its clock,
	 * from that machine's start on): one earlier than the stamp the sandbox's run was booted with (`machineAt`, the same
	 * host's clock) is an earlier machine's exit, reported late, and dropped, as is one without a stamp for a run that
	 * has one.
	 */
	reportExit(hostId: string, sandboxId: string, error: string | undefined, healthAt?: number): Promise<void>;
	/**
	 * A host's capacity report's holdings (`HostCapacity.stickyDisks` and `HostCapacity.holdings`) and fetches
	 * (`HostCapacity.fetches`), received at `at`: its copies in the catalogue (`StoredDiskHolder`), held and being
	 * fetched, are made what it reports (`DiskHolders.recordHoldings`). Nothing of sticky disks with them off, nor of
	 * templates' root filesystems with templates off.
	 */
	recordHoldings(hostId: string, at: number, report: HoldingsReport): Promise<void>;
	/**
	 * A host's `disk.locate`: the version's block map digest, the online hosts in the asker's pool holding it with their
	 * mesh addresses, and a grant to fetch it from them (docs/design/disk-store.md, 2c). `not_found` for a version the
	 * catalogue doesn't have or the host may not have; `not_supported` with its kind off (sticky disks, templates) or no
	 * grant key.
	 */
	locateDisk(hostId: string, request: DiskLocateRequest): Promise<DiskLocation>;
	/**
	 * The control plane's grant key's public key (base64url), for hosts' welcomes, made on first use; undefined with
	 * sticky disks and templates off, or with no secrets key over a persistent store.
	 */
	grantPublicKey(): Promise<string | undefined>;
	/**
	 * Every grant key hosts accept grants from now, for their welcomes (`HostWelcome.grantKeys`): the one that signs first,
	 * then one a rotation published (with when it signs), then those rotated out, each until it stops being accepted.
	 * Undefined as for `grantPublicKey`.
	 */
	grantKeys(): Promise<readonly GrantKeyView[] | undefined>;
	/**
	 * A host connected to this gateway, or its connection here ended: each of its sandboxes that isn't deleted is
	 * published to the live feed as it is (its state unchanged), so an open console reads it again and shows whether it can
	 * be reached (`hostReachable`). Nothing is written.
	 */
	reportHostConnection(hostId: string, connected: boolean): Promise<void>;
	/**
	 * Whether a pool has sync on (`Pool.sync`): its hosts that run the mesh peer with each other. False for a pool that
	 * has gone.
	 */
	poolSync(poolId: string): Promise<boolean>;
	/**
	 * A host's later word on a sandbox's mounts (a `sandbox.mounts` event): each status replaces the one at its path.
	 * Dropped unless the sandbox is on `hostId`, or is starting (its boot's host not recorded yet: the caller checks that
	 * `hostId` holds its placement); a path the sandbox doesn't mount is ignored. `mountsAt` is when the host set them:
	 * one set no later than the record's is dropped (`reportMountStatuses`).
	 */
	reportMounts(
		hostId: string,
		sandboxId: string,
		mounts: readonly BackendMountStatus[],
		mountsAt?: number,
	): Promise<void>;
	/**
	 * Answers a signed file URL (`GET` or `PUT /v1/file-urls/{token}`), which takes no credential: the token is the
	 * grant. Streams the file out, or the request's body in.
	 */
	serveFileUrl(token: string, request: Request): Promise<Response>;
	/** Resolves once every lifecycle operation and detached command started so far has ended. */
	idle(): Promise<void>;
	/** Kills the detached commands and waits for the work under way. */
	close(): Promise<void>;
}

/** What a mounts route answers with mounts off. */
async function mountsOff(): Promise<never> {
	throw new KantelError("not_supported", MOUNTS_OFF);
}

/** Refuses a write into one of the sandbox's mounts, which are read-only. */
function refuseInMount(sandbox: StoredSandbox, path: string): void {
	const mount = mountCovering(sandbox.mounts, path);
	if (mount !== undefined) throw new KantelError("conflict", `${path} is in the read-only mount at ${mount.path}`);
}

const MOUNTS_OFF_HANDLERS: MountHandlers = {
	refreshSandboxMounts: mountsOff,
	createUploadUrl: mountsOff,
	createDownloadUrl: mountsOff,
	extractArchive: mountsOff,
	uploadBundle: mountsOff,
	listBundles: mountsOff,
	getBundle: mountsOff,
	deleteBundle: mountsOff,
	createBucketSource: mountsOff,
	listBucketSources: mountsOff,
	getBucketSource: mountsOff,
	deleteBucketSource: mountsOff,
};

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
/**
 * An account deletion's last pass comes this long after its first: long enough for any write already under way when
 * the account closed (a request in flight, a host registering) to have landed, so that pass clears it.
 */
const DELETION_LAST_PASS_MS = 10 * 60_000;
/**
 * How long a deletion waits for its account's hosts to finish removing its template caches before revoking them all
 * the same: long enough for a host that is away for a while to come back, not so long a host gone for good holds the
 * deletion up for ever.
 */
const DELETION_HOST_WAIT_MS = 24 * 60 * 60_000;
/** How long one gateway carries on a deletion before another may (should it have died). */
const DELETION_LEASE_MS = 5 * 60_000;
/** A failed pass is tried again after this, doubling to at most `DELETION_RETRY_MAX_MS`. */
const DELETION_RETRY_MS = 30_000;
const DELETION_RETRY_MAX_MS = 15 * 60_000;

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
/** How long after its start a detached command its backend doesn't know is taken as lost, not as not yet started. */
const LOST_COMMAND_MS = 60_000;
/** The longest a stop or delete waits to bring in the ends of a sandbox's detached commands no gateway here follows. */
const RECONCILE_MS = 5_000;
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
/** How often the sweep looks for automatic snapshots past their `expiresAt` to delete (`expireSnapshots`). */
export const SNAPSHOT_EXPIRY_EVERY_MS = 10 * 60_000;
/** How often the sweep counts every saved snapshot's copies, and asks for those missing (`keepEverySnapshotsCopies`). */
export const SNAPSHOT_COPIES_EVERY_MS = 5 * 60_000;
/**
 * How long after it starts a process first expires snapshots (`snapshotExpiry`): longer than any create or fork an older
 * version's process, replaced by this one, could still have had in flight.
 */
export const SNAPSHOT_EXPIRY_START_DELAY_MS = 15 * 60_000;
/** How long a process holds an expiry's mark (`markExpiring`) before another may take it over. */
export const RETIRE_LEASE_MS = 10 * 60_000;
/**
 * How long a save may stay `creating` while its host's limit admits it (`admitSave`, a few reads) before the sweep
 * takes it back as one whose gateway died, releasing its bytes (`withdrawSave`).
 */
export const SAVE_ADMISSION_LEASE_MS = 10 * 60_000;
/** The usage readings kept per sandbox: a day of 5-minute means. */
export const MAX_SAMPLES = 288;
/** The hourly means kept per sandbox before its day of 5-minute ones (`keptSamples`): six more days, a week in all. */
export const HOURLY_SAMPLES = 144;
/** How far apart readings are taken by running a command in a sandbox, for a host that doesn't send its own. */
export const FALLBACK_INTERVAL_MS = 60_000;
/** How often a read may run that command at most, per sandbox. */
export const FALLBACK_READ_GAP_MS = 15_000;
/** How often a host's tick also closes the 5-minute means of sandboxes that stopped reporting. */
const SETTLE_EVERY_MS = 60_000;
/** How far ahead of the control plane's a host's clock may be before its ticks are stamped on arrival instead. */
const MAX_CLOCK_SKEW_MS = 30_000;
/** The most numbered ticks held for a host while they can't be taken: its own backlog's bound (kantel-host's). */
export const MAX_HELD_USAGE = 120;
const HOUR_MS = 3_600_000;
/** The runs of a host's sampler whose taken ticks are kept (`takenSeq`): a restart or two, and a late tick of the last. */
const MAX_RUNS_KEPT = 4;
/** Expired usage claims removed at once, and the pause between batches (`sweepUsageClaims`). */
const CLAIM_SWEEP_BATCH = 50;
const CLAIM_SWEEP_PAUSE_MS = 50;

/** A tick from a host with acknowledged ticks (`usage-acks`): its `seq` and `run` both there. */
type NumberedUsage = ReportedUsage & { readonly seq: number; readonly run: string };

/**
 * A numbered tick on its way in. `shared`: another replica passed it on. `exported`: whether this replica exports it,
 * once its claim (`claimUsage`) is settled; kept while it is held, so trying it again doesn't claim it again.
 */
interface HeldUsage {
	readonly report: NumberedUsage;
	readonly shared: boolean;
	exported?: boolean;
}
/** A host is reporting while its last tick came within this, or 3 of its intervals if longer. */
const REPORTING_WITHIN_MS = 15_000;
/** How far back the metrics export reaches for a sandbox it hasn't exported before. */
const EXPORT_LOOKBACK_MS = 5 * 60_000;

/**
 * The mean CPU and memory over `[from, to)` of a sandbox's kept samples, each weighted by how much of the span it
 * covers. A 5-minute mean (one with `readings`, what hosts' ticks are kept as) covers its 5 minutes, the one under way
 * included; a single reading (kept before ticks, a minute apart) counts for a minute when it falls in the span, wherever
 * it was taken. A response interval that isn't on a 5-minute boundary so gets the means it overlaps.
 */
export function spanMean(
	samples: readonly StoredSample[],
	from: number,
	to: number,
): {
	cpu: number;
	memoryMb: number;
	measured: boolean;
	cpuMax?: number;
	memoryMbMax?: number;
	diskMb?: number;
	io?: number;
} {
	let weight = 0;
	let cpu = 0;
	let memoryMb = 0;
	let cpuMax = 0;
	let memoryMbMax = 0;
	const disk = { weight: 0, sum: 0 };
	const io = { weight: 0, sum: 0 };
	for (const sample of samples) {
		const readings = sample.readings ?? 1;
		const covered =
			sample.readings !== undefined
				? Math.min(to, sample.at + (sample.spanMs ?? ROLLUP_MS)) - Math.max(from, sample.at)
				: sample.at >= from && sample.at < to
					? FALLBACK_INTERVAL_MS
					: 0;
		if (covered <= 0) continue;
		weight += covered;
		cpu += covered * sample.cpu;
		memoryMb += covered * sample.memoryMb;
		// The highest of any mean the span touches: a peak isn't spread over its neighbours.
		cpuMax = Math.max(cpuMax, sample.cpuMax ?? sample.cpu);
		memoryMbMax = Math.max(memoryMbMax, sample.memoryMbMax ?? sample.memoryMb);
		// Disk and IO count for the share of its readings that had them.
		if (sample.diskMb !== undefined) {
			const share = covered * (diskReadings(sample) / readings);
			disk.weight += share;
			disk.sum += share * sample.diskMb;
		}
		if (sample.io !== undefined) {
			const share = covered * (ioReadings(sample) / readings);
			io.weight += share;
			io.sum += share * sample.io;
		}
	}
	if (weight === 0) return { cpu: 0, memoryMb: 0, measured: false };
	return {
		cpu: cpu / weight,
		memoryMb: memoryMb / weight,
		measured: true,
		cpuMax,
		memoryMbMax,
		...(disk.weight === 0 ? {} : { diskMb: disk.sum / disk.weight }),
		...(io.weight === 0 ? {} : { io: io.sum / io.weight }),
	};
}

/**
 * A sandbox's samples with a new 5-minute mean in its place (`keepRollup`), at most a day of 5-minute means: older ones
 * are folded into hourly means, each the mean of the 5-minute means of one clock hour weighted by their readings and
 * covering from its first to the end of its last (`spanMs`), at most `HOURLY_SAMPLES` of them. Oldest first.
 */
export function keptSamples(samples: readonly StoredSample[]): StoredSample[] {
	const folded = samples.filter((sample) => sample.spanMs !== undefined);
	const fine = samples.filter((sample) => sample.spanMs === undefined);
	if (fine.length <= MAX_SAMPLES) return [...samples];
	const hourly = [...folded];
	for (const sample of fine.slice(0, fine.length - MAX_SAMPLES)) {
		const last = hourly[hourly.length - 1];
		const end = sample.at + (sample.readings === undefined ? FALLBACK_INTERVAL_MS : ROLLUP_MS);
		if (last !== undefined && Math.floor(last.at / HOUR_MS) === Math.floor(sample.at / HOUR_MS)) {
			hourly[hourly.length - 1] = foldSample(last, sample, end);
		} else {
			hourly.push({ ...sample, readings: sample.readings ?? 1, spanMs: end - sample.at });
		}
	}
	return [...hourly.slice(-HOURLY_SAMPLES), ...fine.slice(-MAX_SAMPLES)];
}

/** Of a sample's readings, those with a disk figure: all of them unless it says (`diskReadings`), none without one. */
const diskReadings = (sample: StoredSample): number =>
	sample.diskMb === undefined ? 0 : (sample.diskReadings ?? sample.readings ?? 1);
/** Of a sample's readings, those with IO pressure, likewise. */
const ioReadings = (sample: StoredSample): number =>
	sample.io === undefined ? 0 : (sample.ioReadings ?? sample.readings ?? 1);

/**
 * An hourly mean with one more 5-minute mean (or reading) in it, to `end`. CPU and memory are weighted by all their
 * readings; disk and IO only by those that had them, so a gap between two figures doesn't dilute either.
 */
function foldSample(into: StoredSample, sample: StoredSample, end: number): StoredSample {
	const a = into.readings ?? 1;
	const b = sample.readings ?? 1;
	const readings = a + b;
	const fold = (x: number | undefined, wx: number, y: number | undefined, wy: number) =>
		x === undefined || wx === 0 ? y : y === undefined || wy === 0 ? x : (x * wx + y * wy) / (wx + wy);
	const disks = diskReadings(into) + diskReadings(sample);
	const ios = ioReadings(into) + ioReadings(sample);
	const diskMb = fold(into.diskMb, diskReadings(into), sample.diskMb, diskReadings(sample));
	const io = fold(into.io, ioReadings(into), sample.io, ioReadings(sample));
	return {
		at: into.at,
		cpu: (into.cpu * a + sample.cpu * b) / readings,
		memoryMb: (into.memoryMb * a + sample.memoryMb * b) / readings,
		cpuMax: Math.max(into.cpuMax ?? into.cpu, sample.cpuMax ?? sample.cpu),
		memoryMbMax: Math.max(into.memoryMbMax ?? into.memoryMb, sample.memoryMbMax ?? sample.memoryMb),
		readings,
		spanMs: Math.max(into.at + (into.spanMs ?? ROLLUP_MS), end) - into.at,
		...(diskMb === undefined ? {} : { diskMb, ...(disks === readings ? {} : { diskReadings: disks }) }),
		...(io === undefined ? {} : { io, ...(ios === readings ? {} : { ioReadings: ios }) }),
	};
}
const MIB = 1024 * 1024;
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
/** What a host reports when it sends its own usage ticks (`HOST_FEATURES.usage` in @kantel/hosts). */
const USAGE_FEATURE = "usage";
/**
 * How long an idempotency key's claim lasts without a renewal: a gateway that dies mid-call frees its key within this,
 * and a retry then does the work. The holder renews it every `IDEMPOTENCY_RENEW_MS` while the work runs.
 */
export const IDEMPOTENCY_CLAIM_MS = 60_000;
export const IDEMPOTENCY_RENEW_MS = 20_000;
/**
 * What a user is told when the deployment has no secrets key (`ComputeApiOptions.secretsKey`) and a persistent store:
 * nothing they can do about it, so no operator advice. The gateways log that (`secretsKeyMissing`), and the caller says
 * it up front (`Caller.protectedValues`).
 */
/** What sticky disks' routes answer while they are off. */
const STICKY_DISKS_OFF =
	"Sticky disks are off here; the deployment turns them on with KANTEL_STICKY_DISKS=experimental";
/** How long a deleted sticky disk's tombstone is kept, its versions deleted from hosts that come back meanwhile. */
const STICKY_TOMBSTONE_MS = 30 * 24 * 3_600_000;
/**
 * How often the sweep deletes tombstoned sticky disks' versions from hosts again, and forgets versions their hosts no
 * longer hold.
 */
const STICKY_SWEEP_EVERY_MS = 10 * 60_000;
/**
 * How long before a host's report arrived a version must have been committed for the report to say whether the host
 * holds it: the host measures its holdings a moment before it sends them, so a version committed meanwhile may be
 * missing from them.
 */
const STICKY_REPORT_GRACE_MS = 2 * 60_000;
/** How many of a disk's versions a get answers. */
const STICKY_VERSIONS_LISTED = 20;
/** How long the sweep leaves between the broker's passes when it has no word of when the next is due. */
const IDLE_RUNNER_PASS_MS = 60_000;
/** What GitHub runners' routes answer while they are off. */
const GITHUB_RUNNERS_OFF =
	"GitHub runners are off here; the deployment turns them on with KANTEL_GITHUB_RUNNERS=experimental";
/** What an integration's own key may do: make, run commands in and delete its runners' sandboxes. */
const GITHUB_RUNNER_SCOPES: readonly computeSchema.ApiKeyScope[] = [
	"sandboxes:read",
	"sandboxes:write",
	"sandboxes:delete",
	"exec",
];
/** What a broker key needs as well while one of its integration's pools commits sticky disks. */
const GITHUB_RUNNER_COMMIT_SCOPE: computeSchema.ApiKeyScope = "snapshots:write";
/** The most runner kinds an integration has, across its pools: as many as its `pools` take. */
const MAX_RUNNER_KINDS = 20;
/** Runner pools as the integration's `pools` take them: never with a pool, which those don't say. */
const unpooled = (pools: readonly RunnerPool[]): RunnerPool[] => pools.map(({ poolId: _pool, ...pool }) => pool);
/** Whether one of `pools` commits its runners' copies of its sticky disks. */
const poolsCommit = (pools: readonly RunnerPool[]): boolean =>
	pools.some((pool) => pool.stickyDisks?.some((sticky) => sticky.commit !== undefined) === true);
/** The scopes a broker key needs for `pools`. */
const githubRunnerScopes = (pools: readonly RunnerPool[]): computeSchema.ApiKeyScope[] => [
	...GITHUB_RUNNER_SCOPES,
	...(poolsCommit(pools) ? [GITHUB_RUNNER_COMMIT_SCOPE] : []),
];

export const PROTECTED_VALUES_UNSUPPORTED =
	"This deployment doesn't support protected variables or secret files; plain variables still work";
export const BUCKET_CREDENTIALS_UNSUPPORTED = "This deployment doesn't support bucket sources with credentials";
/**
 * What a gateway logs at start for its operator when it has a persistent store and no secrets key: what is refused,
 * and the setting that turns it on. Never shown to a user.
 */
export const secretsKeyMissing = (how: string): string =>
	`kantel: KANTEL_SECRETS_KEY is not set, so protected variables, secret files and bucket sources' credentials are refused. ${how}`;
/** A retry of a call whose answer held a secret the deployment had no key to seal, so didn't keep. */
export const ANSWER_WITHHELD =
	"The call with this Idempotency-Key was done, and its answer held a secret this deployment keeps no copy of without " +
	"KANTEL_SECRETS_KEY: look the record up instead, or rotate its secret";
/** A retry of a call that stopped answering or failed part way: it may have taken effect (or yet will), so it is never done again. */
export const CLAIM_LAPSED =
	"A call with this Idempotency-Key didn't finish (it stopped answering, or failed part way), so whether it took effect is " +
	"unknown: check, then use a new key";
/**
 * The errors a call refuses with before it does anything (a check, a state, a limit), which free its Idempotency-Key.
 * `unavailable`, `aborted` and an error that isn't Kantel's may come after an effect, so they keep it.
 */
const REFUSALS: ReadonlySet<string> = new Set([
	"invalid",
	"forbidden",
	"not_found",
	"conflict",
	"refused",
	"exhausted",
	"not_supported",
	"expired",
]);
const refusedBeforeEffects = (error: unknown): boolean =>
	error instanceof KantelError && (REFUSALS.has(error.code) || refusedBeforeTheMachine(error));
/** Where an idempotent call's sealed answer is kept, as its additional data. */
const idempotencyAad = (id: string) => sealedAt("idempotency", id, "body");
/** Whether a stored key is for this request: a key kept before fingerprints were is taken to be. */
const sameRequest = (record: StoredIdempotency, fingerprint: string) =>
	record.fingerprint === undefined || record.fingerprint === fingerprint;
const keyReused = () =>
	new KantelError("refused", "This Idempotency-Key was used for a different request; use a new key for each new call");

/** `value` as JSON with each object's keys in order, so the same request always reads the same. */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map((each) => (each === undefined ? "null" : canonicalJson(each))).join(",")}]`;
	const entries = Object.entries(value as { [key: string]: unknown })
		.filter(([, each]) => each !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonicalJson(each)}`).join(",")}}`;
}
const DEFAULT_AUTO_STOP_MINUTES = 60;
/** The `reason` of a stop for a sandbox's idle stop (`idleStopMinutes`), kept apart from its auto-stop's `auto-stop`. */
export const IDLE_STOP_REASON = "idle-stop";
/** The `reason` of a stop for a sandbox's auto-stop time. */
export const AUTO_STOP_REASON = "auto-stop";
/**
 * How often a gateway writes a sandbox's `lastActiveAt` while it is used: at once for the first use after a quiet spell,
 * then at most once in this long, the rest held until the sweep after it. So a sandbox's recorded use is at most about
 * this (and a sweep) behind, and a busy port costs a write per sandbox per window, not one per request or frame.
 */
export const ACTIVITY_WRITE_MS = 15_000;

/**
 * How long past its idle time a sandbox's idle stop waits before it is due: longer than any gateway takes to store a use
 * it saw (held for up to `ACTIVITY_WRITE_MS`, then written at its next sweep, every 5 s on a self-hosted gateway). So a
 * use seen only by another gateway, whose record of it is held back or on its way, has landed before this gateway's
 * sweep can claim the stop; its own unstored use counts directly (`idleStopDue`'s `seenAt`). It delays only the idle
 * stop, never an auto-stop or a stop a sandbox is owed.
 */
export const IDLE_STOP_GRACE_MS = 2 * ACTIVITY_WRITE_MS;

/** When a running sandbox was last used, for its idle stop: its latest recorded use, else its start. */
function lastUse(sandbox: StoredSandbox): number | undefined {
	return sandbox.lastActiveAt ?? sandbox.startedAt;
}

/**
 * Whether a running sandbox's idle stop is due at `at`: it has one, and has gone that long without use, and
 * `IDLE_STOP_GRACE_MS` more for other gateways' use to land. `seenAt` is a later use this gateway saw that may not be
 * stored yet (its write held back, in flight or failed): it counts too.
 */
export function idleStopDue(sandbox: StoredSandbox, at: number, seenAt?: number): boolean {
	const minutes = sandbox.idleStopMinutes;
	if (minutes === undefined || minutes === null) return false;
	const stored = lastUse(sandbox);
	const last = seenAt === undefined ? stored : Math.max(stored ?? seenAt, seenAt);
	return last !== undefined && last + minutes * 60_000 + IDLE_STOP_GRACE_MS <= at;
}
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

/** What a named size stood for before hosts reported theirs (`kantel-host`'s defaults), to price an old sandbox by. */
const LEGACY_SIZES: { readonly [size: string]: { readonly vcpus: number; readonly memoryMb: number } } & {
	readonly default: { readonly vcpus: number; readonly memoryMb: number };
} = {
	small: { vcpus: 1, memoryMb: 1024 },
	default: { vcpus: 4, memoryMb: 2048 },
	large: { vcpus: 4, memoryMb: 8192 },
	xlarge: { vcpus: 16, memoryMb: 32768 },
};

/** `value` down to a multiple of `step`. */
const floorTo = (value: number, step: number) => Math.floor(value / step) * step;

/**
 * What a microVM may be on `hosts` (those the account may use that run microVMs): their presets, and, where a host
 * makes custom shapes, any vCPUs and memory it has. Undefined with no such host.
 *
 * A preset is a name and its whole shape: hosts that give one name different shapes each keep theirs. A disk may be
 * asked for apart from the vCPUs and memory where a host makes custom shapes: from the least its hosts give to the most
 * any gives, no more than the free disk it last reported, the default preset's by default. Without one, a custom
 * shape's disk is its host's to give, and the sandbox's resources say what it got.
 */
export function microvmShapes(
	hosts: readonly BackendHost[],
	deploymentSizes: readonly BackendSize[],
): computeSchema.SandboxShapes["microvm"] {
	if (hosts.length === 0) return undefined;
	const presets = new Map<string, computeSchema.ShapePreset>();
	let maxVcpus = 1;
	let maxMemory = MICROVM_MEMORY_STEP_MB;
	let minDisk: number | undefined;
	let maxDisk: number | undefined;
	for (const host of hosts) {
		const sizes = host.sizes ?? deploymentSizes;
		for (const size of sizes) {
			const key = `${size.name}/${size.vcpus}/${size.memoryMb}/${size.diskGb}`;
			presets.set(key, { name: size.name, vcpus: size.vcpus, memoryMb: size.memoryMb, diskGb: size.diskGb });
			maxVcpus = Math.max(maxVcpus, size.vcpus);
			maxMemory = Math.max(maxMemory, size.memoryMb);
		}
		if (makesCustom(host)) {
			maxVcpus = Math.max(maxVcpus, Math.min(MAX_VCPUS, host.capacity.vcpus));
			maxMemory = Math.max(maxMemory, floorTo(host.capacity.memoryMb, MICROVM_MEMORY_STEP_MB));
			const limits = diskLimitsOf(host, deploymentSizes);
			// No more than it had free when it last reported (none free is none), else when it started, else its own limit: a
			// create of more waits for room, so the slider doesn't offer it. A host without room for its least offers none.
			const reported = host.freeDiskGb ?? (host.capacity.diskGb > 0 ? host.capacity.diskGb : undefined);
			const free = reported === undefined ? limits.maxGb : Math.min(limits.maxGb, Math.max(0, reported));
			if (free >= limits.minGb) {
				minDisk = Math.min(minDisk ?? limits.minGb, limits.minGb);
				maxDisk = Math.max(maxDisk ?? 0, free);
			}
		}
	}
	const list = [...presets.values()].sort(
		(a, b) => a.vcpus - b.vcpus || a.memoryMb - b.memoryMb || a.diskGb - b.diskGb || a.name.localeCompare(b.name),
	);
	const preferred = list.find((preset) => preset.name === "default") ?? list[0];
	const minMemory = Math.min(MEMORY_MB_PER_VCPU.min, ...list.map((preset) => preset.memoryMb));
	const disk =
		minDisk === undefined || maxDisk === undefined
			? undefined
			: {
					min: minDisk,
					max: Math.min(MAX_DISK_GB, maxDisk),
					step: 1,
					default: Math.min(Math.min(MAX_DISK_GB, maxDisk), Math.max(minDisk, preferred?.diskGb ?? minDisk)),
				};
	return {
		vcpus: { min: 1, max: maxVcpus, step: 1, default: preferred?.vcpus ?? Math.min(2, maxVcpus) },
		memoryMb: {
			min: minMemory,
			max: maxMemory,
			step: MICROVM_MEMORY_STEP_MB,
			default: preferred?.memoryMb ?? Math.min(2048, maxMemory),
		},
		memoryMbPerVcpu: { ...MEMORY_MB_PER_VCPU },
		...(disk === undefined ? {} : { diskGb: disk }),
		presets: list,
		custom: hosts.some(makesCustom),
	};
}

/**
 * Checks a create's `resources` for its type: an isolate's memory is 128 to 512 MB in steps of 64 and it has no vCPUs;
 * a microVM's is whole vCPUs (at most 32) and memory in steps of 512 MB that its vCPUs may hold, unless it is one of
 * the presets. Whether a host has room is placement's to say.
 */
export function checkShape(
	type: computeSchema.SandboxType,
	shape: computeSchema.SandboxShapeInput,
	presets: readonly { readonly vcpus: number; readonly memoryMb: number }[] = [],
): { readonly vcpus: number; readonly memoryMb: number } {
	const { memoryMb } = shape;
	if (memoryMb === undefined) {
		throw new KantelError("invalid", "resources need memoryMb, unless they give a microVM's diskGb alone");
	}
	if (type === "isolate") {
		const range = computeSchema.ISOLATE_MEMORY_MB;
		if (shape.diskGb !== undefined) {
			throw new KantelError("invalid", "An isolate has no disk of its own: it shares its account's VM");
		}
		if (shape.vcpus !== undefined && shape.vcpus !== 0) {
			throw new KantelError("invalid", "An isolate has no vCPUs of its own: it shares its account's VM's CPU");
		}
		if (memoryMb < range.min || memoryMb > range.max || memoryMb % range.step !== 0) {
			throw new KantelError("invalid", "An isolate's memory is 128 to 512 MB in steps of 64");
		}
		return { vcpus: 0, memoryMb };
	}
	const vcpus = shape.vcpus;
	if (vcpus === undefined) throw new KantelError("invalid", "A microVM's resources need vcpus as well as memoryMb");
	if (vcpus < 1 || vcpus > MAX_VCPUS) throw new KantelError("invalid", `A microVM has 1 to ${MAX_VCPUS} vCPUs`);
	if (presets.some((preset) => preset.vcpus === vcpus && preset.memoryMb === memoryMb)) return { vcpus, memoryMb };
	if (memoryMb % MICROVM_MEMORY_STEP_MB !== 0) {
		throw new KantelError("invalid", `A microVM's memory is in steps of ${MICROVM_MEMORY_STEP_MB} MB`);
	}
	if (memoryMb < vcpus * MEMORY_MB_PER_VCPU.min || memoryMb > vcpus * MEMORY_MB_PER_VCPU.max) {
		throw new KantelError(
			"invalid",
			`A microVM's memory is ${MEMORY_MB_PER_VCPU.min} MB to ${MEMORY_MB_PER_VCPU.max / 1024} GB a vCPU`,
		);
	}
	return { vcpus, memoryMb };
}

/**
 * A microVM's disk as a create asks for it (`resources.diskGb`), checked: a whole number of GB, at least 1 and at most
 * `MAX_DISK_GB`. Whether a host gives that much, and has it free, is `machineFor`'s and placement's to say.
 */
export function checkDisk(type: computeSchema.SandboxType, diskGb: number | undefined): number | undefined {
	if (diskGb === undefined) return undefined;
	if (type === "isolate") {
		throw new KantelError("invalid", "An isolate has no disk of its own: it shares its account's VM");
	}
	if (!Number.isInteger(diskGb) || diskGb < 1 || diskGb > MAX_DISK_GB) {
		throw new KantelError("invalid", `A microVM's disk is 1 to ${MAX_DISK_GB} GB, in whole GB`);
	}
	return diskGb;
}

/**
 * A create's shape, checked: what it asked for, against the hosts it may go to (`hosts`), however full they are now.
 * An isolate that asks for nothing gets the default 256 MB; a microVM, its deployment's default size (undefined), as
 * one that asks for a disk alone does (its disk is `checkDisk`'s). A microVM shape none of them can make is
 * `not_supported` before anything is stored, unless `checkHosts` is false (a create from a snapshot, which goes to the
 * snapshot's host and boots as it was).
 */
export function shapeFor(
	type: computeSchema.SandboxType,
	resources: computeSchema.SandboxShapeInput | undefined,
	hosts: readonly BackendHost[],
	deploymentSizes: readonly BackendSize[],
	checkHosts = true,
): BackendShape | undefined {
	if (resources === undefined) {
		return type === "isolate" ? { vcpus: 0, memoryMb: computeSchema.ISOLATE_MEMORY_MB.default } : undefined;
	}
	const diskGb = checkDisk(type, resources.diskGb);
	if (resources.vcpus === undefined && resources.memoryMb === undefined && diskGb !== undefined) return undefined;
	const presets = hosts.flatMap((host) => host.sizes ?? deploymentSizes);
	const checked = checkShape(type, resources, presets);
	const shape: BackendShape = diskGb === undefined ? checked : { ...checked, diskGb };
	if (type === "microvm" && checkHosts) requireMaker(hosts, deploymentSizes, shape);
	return shape;
}

/** `not_supported` unless one of `hosts` can make a microVM of `shape` (`makesShape`), however full it is now. */
export function requireMaker(
	hosts: readonly BackendHost[],
	deploymentSizes: readonly BackendSize[],
	shape: BackendShape,
): void {
	if (hosts.some((host) => makesShape(host, deploymentSizes, shape))) return;
	const disk = shape.diskGb === undefined ? "" : ` and a ${shape.diskGb} GB disk`;
	throw placementError(
		"not_supported",
		"no_host_offers_size",
		`No host this sandbox may use can make a microVM of ${shape.vcpus} vCPU and ${shape.memoryMb} MB${disk}; see getSandboxShapes`,
	);
}

/** How long an update asked for is shown as under way before it's taken not to have happened: 10 minutes. */
const HOST_UPDATE_WINDOW_MS = 10 * 60 * 1000;

/** The version a host should run, as its backend says, and whether it's behind it. */
function hostVersions(host: BackendHost): Pick<StoredHost, "latestVersion" | "updateAvailable"> {
	return {
		...(host.latestVersion === undefined ? {} : { latestVersion: host.latestVersion }),
		...(host.updateAvailable === true ? { updateAvailable: true } : {}),
	};
}

/** A delete's error that says there was nothing to delete: a backend's `not_found`, or a host's. */
function goneAlready(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";
}

/**
 * The host a snapshot's ref names, `<hostId>/<id>` as a host backend's are; undefined for one that names none (a saved
 * snapshot's ID alone, or another backend's).
 */
function refHost(ref: string): string | undefined {
	const slash = ref.indexOf("/");
	return slash > 0 ? ref.slice(0, slash) : undefined;
}

/** A snapshot's ID on its hosts (a disk store object's, kind `snapshot`): a ref's second half, or one naming no host whole. */
function refId(ref: string): string {
	const slash = ref.indexOf("/");
	return slash > 0 ? ref.slice(slash + 1) : ref;
}

/**
 * A snapshot's ref naming its host, for a call to that host (its files, a keep, a fork or upgrade from it, its delete):
 * its ref, or for one naming none, its copy on the host it was taken on (`StoredSnapshot.hostId`), `<hostId>/<ref>`.
 */
function hostRef(snapshot: Pick<StoredSnapshot, "ref" | "hostId">): string | undefined {
	const { ref, hostId } = snapshot;
	if (ref === undefined || hostId === undefined || refHost(ref) !== undefined) return ref;
	return `${hostId}/${ref}`;
}

/** Whether a ref `hostId` reports its snapshots by is one of its own: `<hostId>/<id>`, or one naming no host. */
const reportsOwn = (hostId: string, ref: string): boolean => ref.startsWith(`${hostId}/`) || refHost(ref) === undefined;

/**
 * Whether a record's bytes are those `hostId` took, which it reports by their ref: a ref naming that host, or one naming
 * none whose record says it was taken there (a copy elsewhere is reported by the same ref).
 */
const takenHere = (hostId: string, snapshot: StoredSnapshot): snapshot is StoredSnapshot & { readonly ref: string } =>
	snapshot.ref !== undefined &&
	(refHost(snapshot.ref) === undefined ? snapshot.hostId === hostId : refHost(snapshot.ref) === hostId);

/** A byte count for a message: in GiB to one decimal place, or MiB below 1 GiB. */
function bytesText(bytes: number): string {
	const gib = bytes / 2 ** 30;
	return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${Math.round(bytes / 2 ** 20)} MiB`;
}

/** What a snapshot was made on (`SnapshotMadeOn`), copied for another record: none where it says none. */
function madeOnOf(made: SnapshotMadeOn): SnapshotMadeOn {
	return {
		...(made.cpu === undefined ? {} : { cpu: { ...made.cpu } }),
		...(made.runtime === undefined ? {} : { runtime: made.runtime }),
	};
}

/** A host's CPU and runtime fingerprints as its backend says them now, for its record: none where it says none. */
function fingerprintsOf(host: BackendHost): Pick<StoredHost, "cpuFingerprint" | "runtimeFingerprints"> {
	return {
		...(host.cpuFingerprint === undefined ? {} : { cpuFingerprint: host.cpuFingerprint }),
		...(host.runtimeFingerprints === undefined ? {} : { runtimeFingerprints: [...host.runtimeFingerprints] }),
	};
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
/** The states a revoked host's sandbox is moved to `error` from (`strandOn`): a delete under way is left to it. */
const STRANDABLE: readonly computeSchema.SandboxState[] = ["starting", "running", "stopping", "stopped", "paused"];
/**
 * How long SSH, desktop and browser access can be opened for, unless the call says: a bearer URL that leaks is good for
 * minutes, as boat.dev's are. A connection opened in time stays open; the schema caps a request at an hour.
 */
const ACCESS_TTL_MINUTES = 10;
const DAY_MS = 24 * 3_600_000;

/**
 * An isolate's until its host says what its runtime has (the placement's capabilities): no `node` or `python` yet,
 * which a host from before kantel-isolate never has.
 */
const ISOLATE_CAPABILITIES: computeSchema.SandboxCapabilities = {
	exec: true,
	files: true,
	javascript: false,
	python: false,
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
	javascript: true,
	python: true,
	ssh: true,
	desktop: true,
	browser: true,
	ports: true,
	docker: true,
	kvm: true,
	pause: true,
};

/**
 * A sandbox's capabilities with `javascript` and `python`, which a sandbox recorded before them lacks: a microVM has
 * both, and an isolate placed before its host said has neither (its next placement says).
 */
function withLanguages(
	type: SandboxType,
	capabilities: computeSchema.SandboxCapabilities,
): computeSchema.SandboxCapabilities {
	if (typeof capabilities.javascript === "boolean" && typeof capabilities.python === "boolean") return capabilities;
	const vm = type === "microvm";
	return { ...capabilities, javascript: capabilities.javascript ?? vm, python: capabilities.python ?? vm };
}

const ADJECTIVES = ["brave", "calm", "eager", "fond", "gentle", "keen", "lucky", "merry", "quick", "quiet", "swift"];
const ANIMALS = ["otter", "heron", "badger", "lynx", "marten", "puffin", "wren", "hare", "stoat", "newt", "plover"];
const pick = (items: readonly string[]): string => items[Math.floor(Math.random() * items.length)] ?? "sandbox";
const generatedName = () => `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** A host's `poolId` field, where it has one. */
const pooled = (poolId: string | undefined) => (poolId === undefined ? {} : { poolId });

/**
 * The pools a sandbox may be placed in, before its labels choose among their hosts: of the account's own hosts, those in
 * `own`, and of the shared hosts, those in `shared`; none of either where it is absent. `name`: the pool it named, which a
 * refusal says.
 */
interface PoolChoice {
	readonly own?: string;
	readonly shared?: string;
	readonly name?: string;
}
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

/**
 * A command's stream at its end, from what was recorded while it ran and its end's. A real end's starts with what was
 * recorded (its backend keeps the start of each stream), and is kept to the cap. Any other is an end Kantel made up,
 * such as its result lost, which says why: what was recorded is kept whole, and the reason follows it, past the cap if
 * it must be, so it is never cut off and an attach that has shown what was recorded shows it next.
 */
function endStream(recorded: string, final: string): { text: string; truncated: boolean } {
	if (final.startsWith(recorded)) return truncate(final);
	if (final === "") return { text: recorded, truncated: false };
	return {
		text: recorded === "" || recorded.endsWith("\n") ? recorded + final : `${recorded}\n${final}`,
		truncated: false,
	};
}

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
	const { backend, dispatcher, exporter, now } = options;
	// Every change of a sandbox's state is a write of its record, so the feed publishes from the store itself: whoever moved
	// it (a call, the sweep's auto-stop, a host's report), the watchers hear of it (`live.ts`).
	const live = createLiveFeed({
		read: (sandboxId) => options.store.sandboxes.get(sandboxId),
		...(options.liveRelay === undefined ? {} : { relay: options.liveRelay }),
	});
	const store: ComputeStore = {
		...options.store,
		sandboxes: watchSandboxes(options.store.sandboxes, (change) => live.publish(change), now),
	};
	const rates = options.rates ?? PLACEHOLDER_RATES;
	const limits = options.limits ?? {};
	const mode = options.mode ?? "selfhosted";
	const deploymentDomain = options.sandboxDomain === undefined ? {} : { sandboxDomain: options.sandboxDomain };
	const apiBasePath = (options.apiBasePath ?? "/v1").replace(/\/+$/, "");
	const startHoldMs = options.startHoldMs ?? START_HOLD_MS;
	const startPollMs = options.startPollMs ?? START_POLL_MS;
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
		if (sealer === undefined) throw new KantelError("not_supported", PROTECTED_VALUES_UNSUPPORTED);
		return sealer;
	};

	/** Each sandbox's queue of lifecycle work; settled promises, so a failure doesn't stop the next. */
	const pending = new Map<string, Promise<void>>();
	/** The commands this gateway is waiting for, and what ends each wait. */
	const runningCommands = new Map<string, AbortController>();
	const background = new Set<Promise<unknown>>();
	/** Idempotent calls working on this gateway, by their key's ID, with their request's fingerprint. */
	const inflight = new Map<string, { readonly fingerprint: string; readonly promise: Promise<unknown> }>();
	/** Each sandbox's readings, and each host's, as they came (`recordUsage`); in this process's memory. */
	const sandboxSeries = createUsageSeries();
	const hostSeries = createUsageSeries();
	/** When each sandbox was last read by running a command in it (the fallback, `readUsage`). */
	const fallbackReadAt = new Map<string, number>();
	/** The newest point of each sandbox's series the metrics export has looked at (taking those not passed on). */
	const exportedUntil = new Map<string, number>();
	/** When each host's last tick arrived, by this process's clock: whether it is reporting. */
	const tickArrivedAt = new Map<string, number>();
	/**
	 * The newest tick taken from each host that numbers them (`ReportedUsage.seq`, `usage-acks`), in each of its
	 * sampler's recent runs (`MAX_RUNS_KEPT`, newest last): one sent again after a reconnect, at or before it, is
	 * acknowledged without being taken twice. By run, so a late tick of a host's old run (passed on from another replica)
	 * never moves its new run's back. A run's ticks are taken in order (`ingestInTurn`), so every one at or before it is in.
	 */
	const takenSeq = new Map<string, Map<string, number>>();
	/**
	 * Each host's numbered ticks that couldn't be taken (the store failing), oldest first, with every numbered tick after
	 * them: taken in order before anything newer (`ingestInTurn`).
	 */
	const heldUsage = new Map<string, HeldUsage[]>();
	/** Up to when the backend's own ticks (the stub's) are in. */
	let pulledUntil = Number.NEGATIVE_INFINITY;
	/** The stub's past ticks being taken (`catchUpUsage`), if they are. */
	let replaying: Promise<void> | undefined;
	let settledAt = Number.NEGATIVE_INFINITY;
	/** This process, as the owner of the usage ticks it claims to export (`StoredUsageClaim.owner`). */
	const usageOwner = crypto.randomUUID();
	let claimsSweptAt = Number.NEGATIVE_INFINITY;
	/** When `expireSnapshots` last began a pass. */
	let snapshotsExpiredAt = Number.NEGATIVE_INFINITY;
	/** When `keepEverySnapshotsCopies` last began a pass. */
	let copiesKeptAt = Number.NEGATIVE_INFINITY;
	/** When this process may first expire snapshots (`snapshotExpiryDelayMs` after it started). */
	const expiryStartsAt = now() + (options.snapshotExpiryDelayMs ?? SNAPSHOT_EXPIRY_START_DELAY_MS);
	/** This process, as the owner of the expiry marks it makes (`markExpiring`). */
	const retireOwner = crypto.randomUUID();
	/** Set by `close`: a claim sweep under way stops. */
	let closing = false;

	/** A timestamp after `previous`, for a field that must move on with every write whatever the gateways' clocks say. */
	const later = (previous: number | undefined) => Math.max(now(), (previous ?? 0) + 1);

	const keepGoing = (work: Promise<unknown>) => {
		const tracked: Promise<unknown> = work.catch(() => undefined).finally(() => background.delete(tracked));
		background.add(tracked);
	};

	/**
	 * Each sandbox's use this gateway has seen (`noteActivity`): its latest use, the latest the store has taken, when it
	 * last tried a write (the throttle's window) and the write on its way. A use stays here until a write of it succeeds,
	 * so one held back, in flight or failed still counts for the sweep's idle stop, and a failed one is tried again.
	 */
	const activity = new Map<string, { latest: number; persisted: number; tried: number; writing?: Promise<void> }>();

	/**
	 * Writes `at` as the sandbox's `lastActiveAt`, while it runs with an idle stop and has no later use recorded: true
	 * once the store has it (or doesn't need it), false if the write failed.
	 */
	const writeActivity = (sandboxId: string, at: number): Promise<boolean> =>
		store.sandboxes
			.update(sandboxId, (current) =>
				current.state !== "running" ||
				current.idleStopMinutes === undefined ||
				current.idleStopMinutes === null ||
				(current.lastActiveAt ?? Number.NEGATIVE_INFINITY) >= at
					? undefined
					: { ...current, lastActiveAt: at },
			)
			.then(
				() => true,
				() => false,
			);

	/** Writes a sandbox's latest use, marking it taken only once the write succeeds. */
	function persistActivity(
		sandboxId: string,
		seen: { latest: number; persisted: number; tried: number; writing?: Promise<void> },
	) {
		const at = seen.latest;
		seen.tried = now();
		const writing = writeActivity(sandboxId, at).then((ok) => {
			if (ok) seen.persisted = Math.max(seen.persisted, at);
			if (seen.writing === writing) seen.writing = undefined;
		});
		seen.writing = writing;
		return writing;
	}

	function noteActivity(sandboxId: string): void {
		const at = now();
		let seen = activity.get(sandboxId);
		if (seen === undefined) {
			seen = { latest: at, persisted: Number.NEGATIVE_INFINITY, tried: Number.NEGATIVE_INFINITY };
			activity.set(sandboxId, seen);
		} else seen.latest = Math.max(seen.latest, at);
		// Within the window, or with a write on its way, it's held for the sweep after it.
		if (seen.writing !== undefined || at - seen.tried < ACTIVITY_WRITE_MS) return;
		keepGoing(persistActivity(sandboxId, seen));
	}

	/** The latest use this gateway saw of a sandbox, stored or not, for the sweep's idle stop. */
	const seenActivity = (sandboxId: string): number | undefined => activity.get(sandboxId)?.latest;

	/**
	 * Writes the use held back (or whose write failed) once its window has passed, and forgets sandboxes whose latest use
	 * is stored and that were quiet for a window. A write still on its way is left to finish: the sweep counts its use
	 * from here meanwhile (`seenActivity`), so a slow store doesn't hold the sweep up.
	 */
	async function flushActivity(): Promise<void> {
		const at = now();
		const writes: Promise<unknown>[] = [];
		for (const [sandboxId, seen] of activity) {
			if (seen.writing !== undefined || at - seen.tried < ACTIVITY_WRITE_MS) continue;
			if (seen.latest <= seen.persisted) {
				activity.delete(sandboxId);
				continue;
			}
			writes.push(persistActivity(sandboxId, seen));
		}
		await Promise.all(writes);
	}

	// GitHub Actions runners: the broker, acting through each integration's own key with the handlers below.
	const runnerSettings = options.githubRunners;
	/** What an internal call to a handler is given for its request: the broker's calls come from no request. */
	const internalRequest = () => new Request("http://kantel.internal/github-runners");
	const answered = <T>(value: T | Response): T => {
		if (value instanceof Response)
			throw new KantelError("unavailable", "A handler answered a raw response to the broker");
		return value;
	};
	const githubRunners = createGithubRunners({
		store,
		now,
		sealer: requireSealer,
		principalOf: (keyId) => liveKeyPrincipal(store, keyId, now()),
		// Ending runners outlives the key: revoking it stops new runners, not the deletion of those it made.
		cleanupPrincipalOf: async (keyId) => {
			const key = await store.apiKeys.get(keyId);
			return key === undefined ? undefined : keyPrincipal(key);
		},
		github:
			runnerSettings?.app ??
			((credentials) =>
				createGithubApp({
					...credentials,
					now,
					...(runnerSettings?.fetch === undefined ? {} : { fetch: runnerSettings.fetch }),
				})),
		...(options.wakeAt === undefined ? {} : { wakeAt: options.wakeAt }),
		...(runnerSettings?.log === undefined ? {} : { log: runnerSettings.log }),
		place: (record) => placeRunnerKinds(record),
		sandboxes: {
			async create(principal, body) {
				return answered(await handlers.createSandbox(principal, { params: {}, query: {}, body }, internalRequest()));
			},
			async get(principal, sandboxId) {
				try {
					return answered(
						await handlers.getSandbox(
							principal,
							{ params: { sandboxId }, query: {}, body: undefined },
							internalRequest(),
						),
					);
				} catch (error) {
					if (error instanceof KantelError && error.code === "not_found") return undefined;
					throw error;
				}
			},
			async delete(principal, sandboxId) {
				answered(
					await handlers.deleteSandbox(
						principal,
						{ params: { sandboxId }, query: {}, body: undefined },
						internalRequest(),
					),
				);
			},
			async exec(principal, sandboxId, command, timeoutMs) {
				// As root, as a pool's `beforeCommit` is documented to run (stopping Docker, say), whatever the image's default
				// user: only this internal call can ask for that, never a caller's command.
				const { sandbox } = await sandboxFor(principal, sandboxId, "exec");
				const ran = await runCommandOnce(principal, sandbox.id, { command, timeoutMs }, { asRoot: true });
				return ran.exitCode ?? 1;
			},
			async commit(principal, sandboxId, disk) {
				answered(
					await handlers.commitStickyDisk(
						principal,
						{ params: { sandboxId, stickyDiskId: disk }, query: {}, body: undefined },
						internalRequest(),
					),
				);
			},
			async run(principal, sandboxId, command, env) {
				const started = answered(
					await handlers.runCommand(
						principal,
						{ params: { sandboxId }, query: {}, body: { command, env, detached: true } },
						internalRequest(),
					),
				);
				return started.id;
			},
			async commandRunning(principal, sandboxId, commandId) {
				try {
					const command = answered(
						await handlers.getCommand(
							principal,
							{ params: { sandboxId, commandId }, query: {}, body: undefined },
							internalRequest(),
						),
					);
					return command.state === "running";
				} catch (error) {
					if (error instanceof KantelError && error.code === "not_found") return false;
					return undefined;
				}
			},
			async listMadeBy(accountId, keyId, labels) {
				return (await store.sandboxes.list({ accountId }))
					.filter(
						(sandbox) =>
							sandbox.state !== "deleted" &&
							sandbox.createdBy.kind === "api_key" &&
							sandbox.createdBy.id === keyId &&
							Object.entries(labels).every(([key, value]) => sandbox.labels?.[key] === value),
					)
					.map((sandbox) => ({ id: sandbox.id, createdAt: sandbox.createdAt }));
			},
		},
	});
	/** When the sweep next runs the broker's pass (`tickGithubRunners` moves it on). */
	let runnersDueAt = 0;
	const requireGithubRunners = (): void => {
		if (runnerSettings === undefined) throw new KantelError("not_supported", GITHUB_RUNNERS_OFF);
	};
	/** The account's integration `id`, for a caller who may administer it; `not_found` for any other. */
	async function githubRunnersFor(principal: Principal, id: string): Promise<StoredGithubRunners> {
		requireGithubRunners();
		const record = await store.githubRunners.get(id);
		if (record === undefined || record.retiringAt !== undefined) {
			throw new KantelError("not_found", "No such GitHub runner integration");
		}
		const { role } = await actingAccount(store, principal, record.accountId).catch(() => {
			throw new KantelError("not_found", "No such GitHub runner integration");
		});
		requireScope(principal, "account:admin", role);
		return record;
	}
	const githubWebhookUrl = async (request: Request, id: string) =>
		`${(await publicUrlView(request)).publicUrl}${apiBasePath}/github-runners/${id}/webhook`;
	/** Checks a pool list: labels unique, and each template one the account has. */
	async function checkPools(accountId: string, pools: readonly RunnerPool[]): Promise<void> {
		const labels = new Set<string>();
		const capabilities = await backend.capabilities();
		const presets = [...capabilities.sizes, ...capabilities.hosts.flatMap((host) => host.sizes ?? [])];
		for (const pool of pools) {
			if (labels.has(pool.label)) throw new KantelError("invalid", `Two pools have the label ${pool.label}`);
			labels.add(pool.label);
			// The constraints a create holds the shape to, its hosts' preset sizes included, so a pool that can never make a
			// runner is refused now.
			checkShape("microvm", pool.resources, presets);
			checkDisk("microvm", pool.resources.diskGb);
			await templates.templateIn(accountId, pool.template);
			if ((pool.stickyDisks?.length ?? 0) > 0) {
				requireSticky();
				const attached = await stickyDisksFor(accountId, pool.stickyDisks ?? []);
				// A kind's runners are made in its pool, and a sticky disk is attached only in its own.
				const held = pool.poolId === undefined ? undefined : await poolOfStickyDisks(attached, await ensureHosts());
				if (held !== undefined && held.poolId !== pool.poolId) {
					throw new KantelError(
						"invalid",
						`The sticky disk ${held.disk} is in pool ${await poolName(held.poolId)}, not ${pool.label}'s pool ${await poolName(pool.poolId ?? "")}: a runner kind's sticky disks are in its pool`,
					);
				}
			}
		}
	}
	/** Forgets an account's GitHub runner records: its sandboxes and keys go with it. */
	const forgetGithubRunners = (accountId: string): Promise<void> => githubRunners.forgetAccount(accountId);
	/**
	 * Gives an integration's broker key the scope its runners' sticky disk commits need, when it lacks it: only from a
	 * caller who may grant that scope, and never to a revoked key, which stays as it is.
	 */
	async function grantRunnerCommits(principal: Principal, keyId: string): Promise<void> {
		const key = await store.apiKeys.get(keyId);
		if (key === undefined || key.revokedAt !== undefined || key.scopes.includes(GITHUB_RUNNER_COMMIT_SCOPE)) return;
		requireGrantable(principal, [GITHUB_RUNNER_COMMIT_SCOPE]);
		await store.apiKeys.update(keyId, (current) =>
			current.revokedAt !== undefined || current.scopes.includes(GITHUB_RUNNER_COMMIT_SCOPE)
				? undefined
				: { ...current, scopes: [...current.scopes, GITHUB_RUNNER_COMMIT_SCOPE] },
		);
	}

	/** What the broker logs: the deployment's runner log, else the process's. */
	const runnerLog = (message: string): void => (runnerSettings?.log ?? console.log)(`[github-runners] ${message}`);
	/**
	 * The pool a runner kind with none goes in, and why. The pool its sticky disks are in, where its runners went before
	 * kinds were in pools; else the one pool whose hosts its `hostLabels` select, of the hosts that could run its runners
	 * (microVM hosts its integration's runners may use, the account's own first, as placement prefers them); else, with
	 * no labels or labels that select hosts in several pools or none, the default pool its runners went to before: the
	 * account's own default where one of its hosts there could run them, else the deployment's where it may use that.
	 * Judged on the hosts as they are, not whether each is online now, so a host away for a moment doesn't move it. A
	 * failed read rejects, so the kind is placed on a later try rather than from what couldn't be read.
	 */
	async function kindPool(
		accountId: string,
		/** Whether its runners may run on the deployment's shared hosts (`mayShare` of its integration's key). */
		shared: boolean,
		kind: RunnerPool,
	): Promise<{ readonly poolId: string; readonly why: string }> {
		const hosts = await ensureHosts();
		if ((kind.stickyDisks?.length ?? 0) > 0) {
			// A disk gone, or two in different pools, says nothing of a pool; any other failure is thrown.
			const settled = (error: unknown) => {
				if (error instanceof KantelError && (error.code === "not_found" || error.code === "invalid")) return undefined;
				throw error;
			};
			const attached = await stickyDisksFor(accountId, kind.stickyDisks ?? []).catch(settled);
			const held = attached === undefined ? undefined : await poolOfStickyDisks(attached, hosts).catch(settled);
			if (held !== undefined) return { poolId: held.poolId, why: `its sticky disk ${held.disk} is there` };
		}
		const labels = Object.entries(kind.hostLabels ?? {});
		const could = hosts.filter(
			(host) =>
				host.state !== "revoked" &&
				host.tiers.includes("microvm") &&
				(host.accountId === accountId || (shared && host.accountId === undefined)) &&
				labels.every(([name, value]) => host.labels[name] === value),
		);
		const fallback = async (why: string) => {
			const choice = await placementPool(accountId, undefined, hosts, shared);
			const ran = (poolId: string | undefined) => poolId !== undefined && could.some((host) => host.poolId === poolId);
			const poolId = ran(choice.own) ? choice.own : ran(choice.shared) ? choice.shared : (choice.own ?? choice.shared);
			return { poolId: poolId ?? (await pools.defaultPool(accountId)).id, why };
		};
		if (labels.length === 0) return fallback("it has no host labels, so it went in the default pool");
		const own = could.filter((host) => host.accountId === accountId);
		const selected = unique((own.length > 0 ? own : could).flatMap((host) => host.poolId ?? []));
		const [only] = selected;
		if (selected.length === 1 && only !== undefined) return { poolId: only, why: "its host labels select hosts there" };
		return fallback(
			selected.length === 0
				? "its host labels select no host, so it went in the default pool"
				: "its host labels select hosts in several pools, so it went in the default pool",
		);
	}
	/**
	 * `kinds` each in a pool: one already in one stays there, one `current` has (by label) stays in that one's, and a new
	 * one goes where `kindPool` says.
	 */
	async function placedKinds(
		accountId: string,
		shared: boolean,
		kinds: readonly RunnerPool[],
		current: readonly RunnerPool[],
		/** The integration, by ID or name, for the log. */
		integration: string,
	): Promise<RunnerPool[]> {
		const placed: RunnerPool[] = [];
		for (const kind of kinds) {
			const kept = kind.poolId ?? current.find((other) => other.label === kind.label)?.poolId;
			if (kept !== undefined && (await store.pools.get(kept)) !== undefined) {
				placed.push({ ...kind, poolId: kept });
				continue;
			}
			const { poolId, why } = await kindPool(accountId, shared, kind);
			runnerLog(`${integration}: runner kind ${kind.label} is in pool ${await poolName(poolId)}: ${why}`);
			placed.push({ ...kind, poolId });
		}
		return placed;
	}
	/**
	 * Puts an integration's kinds that have no pool (kept before kinds were in pools, or whose pool went) in one, once:
	 * a kind given a pool meanwhile keeps it. Answers the record as it is then; one that couldn't be placed now is
	 * answered as it was, and placed on a later read.
	 */
	async function placeRunnerKinds(record: StoredGithubRunners): Promise<StoredGithubRunners> {
		const live = await Promise.all(
			record.pools.map(async (kind) => kind.poolId !== undefined && (await store.pools.get(kind.poolId)) !== undefined),
		);
		if (live.every(Boolean)) return record;
		try {
			const lacking = record.pools.filter((_kind, at) => live[at] !== true).map(({ poolId: _pool, ...kind }) => kind);
			const key = await store.apiKeys.get(record.keyId);
			const shared = key === undefined || (await mayShare(keyPrincipal(key)));
			const placed = await placedKinds(record.accountId, shared, lacking, [], record.id);
			// Only a kind still as it was read: one placed or moved meanwhile keeps that.
			const seen = new Map(record.pools.map((kind) => [kind.label, kind.poolId]));
			const updated = await store.githubRunners.update(record.id, (current) => {
				let changed = false;
				const kinds = current.pools.map((kind) => {
					const into = placed.find((other) => other.label === kind.label)?.poolId;
					if (into === undefined || !seen.has(kind.label) || seen.get(kind.label) !== kind.poolId) return kind;
					changed = true;
					return { ...kind, poolId: into };
				});
				return changed ? { ...current, pools: kinds } : undefined;
			});
			return updated ?? (await store.githubRunners.get(record.id)) ?? record;
		} catch (error) {
			runnerLog(
				`${record.id}: its runner kinds couldn't be put in pools yet: ${error instanceof Error ? error.message : String(error)}`,
			);
			return record;
		}
	}

	/** GitHub runner kinds as the account pools' `runners` read and write them: kept with their integrations. */
	const poolRunners: PoolRunners = {
		async of(owner, list) {
			const byPool = new Map<string, computeSchema.GithubRunnerKind[]>();
			for (const found of await store.githubRunners.list({ accountId: owner })) {
				if (found.retiringAt !== undefined) continue;
				const record = await placeRunnerKinds(found);
				for (const kind of record.pools) {
					if (kind.poolId === undefined || !list.some((pool) => pool.id === kind.poolId)) continue;
					byPool.set(kind.poolId, [...(byPool.get(kind.poolId) ?? []), kindView(record.id, kind)]);
				}
			}
			return byPool;
		},
		async in(pool) {
			const labels: string[] = [];
			const integrations =
				pool.owner === OPERATOR_POOLS
					? await store.githubRunners.list()
					: await store.githubRunners.list({ accountId: pool.owner });
			for (const found of integrations) {
				if (found.retiringAt !== undefined) continue;
				const record = await placeRunnerKinds(found);
				for (const kind of record.pools) if (kind.poolId === pool.id) labels.push(kind.label);
			}
			return labels;
		},
		async set(principal, pool, kinds) {
			requireGithubRunners();
			const accountId = pool.owner;
			// The integrations the call names, each the account's, and those with kinds in the pool now, which it replaces.
			const records = new Map<string, StoredGithubRunners>();
			for (const id of unique(kinds.map((kind) => kind.integration))) {
				const found = await store.githubRunners.get(id);
				if (found === undefined || found.retiringAt !== undefined || found.accountId !== accountId) {
					throw new KantelError("not_found", `No GitHub runner integration ${id} in the pool's account`);
				}
				records.set(id, await placeRunnerKinds(found));
			}
			for (const found of await store.githubRunners.list({ accountId })) {
				if (found.retiringAt !== undefined || records.has(found.id)) continue;
				const record = await placeRunnerKinds(found);
				if (record.pools.some((kind) => kind.poolId === pool.id)) records.set(found.id, record);
			}
			/** Each integration's kinds in the pool from now: the call's, a label it has in another pool moving here. */
			const mine = (id: string): RunnerPool[] =>
				kinds
					.filter((kind) => kind.integration === id)
					.map(({ integration: _integration, ...kind }) => ({ ...kind, poolId: pool.id }));
			const merged = (id: string, current: readonly RunnerPool[]): RunnerPool[] => {
				const here = mine(id);
				const labels = new Set(here.map((kind) => kind.label));
				return [...current.filter((kind) => kind.poolId !== pool.id && !labels.has(kind.label)), ...here];
			};
			// Every integration's kinds checked as they would be, before any is written.
			for (const [id, record] of records) {
				const next = merged(id, record.pools);
				if (next.length > MAX_RUNNER_KINDS) {
					throw new KantelError("invalid", `${record.name} would have more than ${MAX_RUNNER_KINDS} runner kinds`);
				}
				await checkPools(accountId, next);
				// Kinds that commit need the key to commit, given it first, as the integration's own update does.
				if (poolsCommit(next)) await grantRunnerCommits(principal, record.keyId);
			}
			// Each integration's write merges into its kinds as they are then, held to the limit again. Each is atomic; a call
			// changing several integrations writes them one after another.
			for (const id of records.keys()) {
				await store.githubRunners.update(id, (current) => {
					if (current.retiringAt !== undefined) return undefined;
					const next = merged(id, current.pools);
					if (next.length > MAX_RUNNER_KINDS) {
						throw new KantelError("invalid", `${current.name} would have more than ${MAX_RUNNER_KINDS} runner kinds`);
					}
					return { ...current, pools: next, updatedAt: now() };
				});
			}
		},
	};

	// Sticky disks.
	const requireSticky = (): void => {
		if (options.stickyDisks !== true || backend.commitStickyDisk === undefined) {
			throw new KantelError("not_supported", STICKY_DISKS_OFF);
		}
	};
	/** The account's sticky disk by ID or name; `not_found` for any other. */
	async function stickyDiskIn(accountId: string, ref: string): Promise<StoredStickyDisk> {
		const byId = ref.startsWith("sdk_") ? await store.stickyDisks.get(ref) : undefined;
		const named =
			byId?.accountId === accountId ? undefined : await store.stickyDiskNames.get(stickyDiskNameId(accountId, ref));
		const disk = byId?.accountId === accountId ? byId : named && (await store.stickyDisks.get(named.diskId));
		if (disk === undefined || disk.deletedAt !== undefined) throw new KantelError("not_found", "No such sticky disk");
		return disk;
	}
	/**
	 * A create's sticky disks, checked: each the account's, once, at a path the guest takes for a mount (absolute, clean,
	 * not its system's own: `MOUNT_SYSTEM_PATHS`), apart from the others and from the sandbox's read-only mounts.
	 */
	async function stickyDisksFor(
		accountId: string,
		inputs: readonly computeSchema.SandboxStickyDiskInput[],
		mountPaths: readonly string[] = [],
	): Promise<computeSchema.SandboxStickyDisk[]> {
		const disks: computeSchema.SandboxStickyDisk[] = [];
		const meets = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
		for (const input of inputs) {
			const path = input.path.replace(/\/+$/, "") || "/";
			const unclean = path.split("/").some((part, at) => at > 0 && (part === "" || part === "." || part === ".."));
			if (
				path === "/" ||
				unclean ||
				MOUNT_SYSTEM_PATHS.some((reserved) => path === reserved || path.startsWith(`${reserved}/`))
			) {
				throw new KantelError("invalid", `A sticky disk can't be mounted at ${input.path}`);
			}
			if (mountPaths.some((mount) => meets(mount, path))) {
				throw new KantelError("invalid", `A sticky disk at ${path} would meet one of the sandbox's mounts`);
			}
			const disk = await stickyDiskIn(accountId, input.disk);
			if (disks.some((other) => other.diskId === disk.id)) {
				throw new KantelError("invalid", `${disk.name} is attached twice`);
			}
			if (disks.some((other) => meets(other.path, path))) {
				throw new KantelError("invalid", `Two sticky disks can't be mounted at ${path} and inside each other`);
			}
			disks.push({ diskId: disk.id, name: disk.name, path, state: "pending" });
		}
		return disks;
	}
	/** What a create sends its backend for the sandbox's sticky disks: each one's size, read now. */
	async function stickySpecOf(sandbox: StoredSandbox): Promise<{ stickyDisks?: BackendStickyDisk[] }> {
		if (sandbox.stickyDisks === undefined || sandbox.stickyDisks.length === 0) return {};
		const specs: BackendStickyDisk[] = [];
		for (const attached of sandbox.stickyDisks) {
			const disk = await store.stickyDisks.get(attached.diskId);
			if (disk === undefined || disk.deletedAt !== undefined) {
				throw new KantelError("not_found", `The sticky disk ${attached.name} was deleted`);
			}
			// Its head, which placement prefers a host holding (docs/design/disk-store.md, 2d).
			specs.push({
				diskId: disk.id,
				path: attached.path,
				sizeGiB: disk.sizeGb,
				...(disk.head === undefined ? {} : { version: disk.head }),
			});
		}
		return { stickyDisks: specs };
	}
	/**
	 * A sandbox's sticky disks once its backend answered: what it reported for each, `failed` for one it didn't, and those
	 * its host has that the record doesn't name.
	 */
	const stickyAfter = (
		stored: readonly computeSchema.SandboxStickyDisk[],
		reported: readonly BackendStickyDiskStatus[] | undefined,
	): computeSchema.SandboxStickyDisk[] => [
		...stored.map((disk) => {
			const status = reported?.find((candidate) => candidate.diskId === disk.diskId);
			if (status === undefined) {
				return disk.state === "pending"
					? { ...disk, state: "failed" as const, reason: "Its host didn't attach it" }
					: disk;
			}
			const { version: _version, reason: _reason, ...rest } = disk;
			return {
				...rest,
				...(status.version === undefined ? {} : { version: status.version }),
				state: status.state,
				...(status.reason === undefined ? {} : { reason: status.reason }),
			};
		}),
		// Disks its host has that the record doesn't name: inherited from the snapshot it was made from. Named by ID until
		// a commit or get reads the disk; a commit checks the disk is the sandbox's account's.
		...(reported ?? [])
			.filter((status) => !stored.some((disk) => disk.diskId === status.diskId))
			.map((status) => ({
				diskId: status.diskId,
				name: status.diskId,
				path: status.path,
				...(status.version === undefined ? {} : { version: status.version }),
				state: status.state,
				...(status.reason === undefined ? {} : { reason: status.reason }),
			})),
	];
	const stickyVersionView = (version: StoredStickyDiskVersion): computeSchema.StickyDiskVersion => ({
		id: version.id,
		...(version.parent === undefined ? {} : { parent: version.parent }),
		hostId: version.hostId,
		sandboxId: version.sandboxId,
		sizeBytes: version.sizeBytes,
		allocatedBytes: version.allocatedBytes,
		createdAt: version.createdAt,
	});
	async function stickyDiskView(disk: StoredStickyDisk, withVersions: boolean): Promise<computeSchema.StickyDisk> {
		const versions = withVersions
			? (await store.stickyDiskVersions.list({ diskId: disk.id }))
					.sort((a, b) => b.seq - a.seq)
					.slice(0, STICKY_VERSIONS_LISTED)
					.map(stickyVersionView)
			: undefined;
		return {
			id: disk.id,
			accountId: disk.accountId,
			name: disk.name,
			...(disk.description === undefined ? {} : { description: disk.description }),
			sizeGb: disk.sizeGb,
			...(disk.head === undefined ? {} : { head: disk.head }),
			...(versions === undefined ? {} : { versions }),
			...pooled(disk.poolId),
			createdAt: disk.createdAt,
			updatedAt: disk.updatedAt,
		};
	}
	/** The sticky disk by ID or name in an account the caller may act in, with `scope`; `not_found` for any other. */
	async function stickyDiskFor(
		principal: Principal,
		ref: string,
		scope: computeSchema.ApiKeyScope,
	): Promise<StoredStickyDisk> {
		const found = ref.startsWith("sdk_") ? await store.stickyDisks.get(ref) : undefined;
		const byId = found?.deletedAt === undefined ? found : undefined;
		if (byId !== undefined) {
			const { role } = await actingAccount(store, principal, byId.accountId).catch(() => {
				throw new KantelError("not_found", "No such sticky disk");
			});
			requireScope(principal, scope, role);
			return byId;
		}
		const { account, role } = await actingAccount(store, principal, undefined);
		requireScope(principal, scope, role);
		return stickyDiskIn(account.id, ref);
	}
	/**
	 * Deletes a sticky disk: a tombstone, with its name's claim released, so it is gone to callers and to a commit from
	 * now on and its name is free; then its catalogue versions, and its versions on the hosts there are now. The tombstone
	 * is kept (`STICKY_TOMBSTONE_MS`) for the sweep to delete its versions from hosts again, so a host away now, or a
	 * commit finishing meanwhile, leaves nothing behind.
	 */
	async function deleteStickyDiskNow(diskId: string): Promise<void> {
		if ((await store.stickyDiskWrites.tombstone(diskId, now())) === undefined) return;
		for (const version of await store.stickyDiskVersions.list({ diskId })) {
			await store.stickyDiskVersions.delete(version.id);
		}
		await diskHolders.forget("sticky", diskId);
		await backend.deleteStickyDisk?.(diskId).catch(() => undefined);
	}
	/**
	 * Deletes an account's sticky disks, as a delete does: their sandboxes go with the account, and their tombstones
	 * outlive it (the fence lets them be written in a closed account), so the sweep still deletes their versions from
	 * hosts that were away. A disk made since is refused by the fence.
	 */
	async function forgetStickyDisks(accountId: string): Promise<void> {
		for (const disk of await store.stickyDisks.list({ accountId })) await deleteStickyDiskNow(disk.id);
	}

	/** When the sweep last went over sticky disks. */
	let stickySweptAt = Number.NEGATIVE_INFINITY;
	/**
	 * Deletes deleted sticky disks' versions from every connected host again (a host away at the delete, or a commit
	 * that finished after it), and their catalogue versions a delete stopped before, and forgets tombstones past
	 * `STICKY_TOMBSTONE_MS`. Tombstones of a deleted account's disks too: they outlive it. Then sweeps the holders of
	 * every kind (`DiskHolders.sweep`), and forgets the versions of live disks their hosts no longer hold
	 * (`forgetDroppedStickyVersions`). With sticky disks off and templates on, it sweeps the holders alone: templates'
	 * root filesystems have holders too.
	 */
	async function sweepStickyDisks(): Promise<void> {
		if (options.stickyDisks !== true && options.templates !== true) return;
		const t = now();
		if (t - stickySweptAt < STICKY_SWEEP_EVERY_MS) return;
		stickySweptAt = t;
		if (options.stickyDisks !== true) {
			await diskHolders.sweep(t);
			return;
		}
		const disks = await store.stickyDisks.list();
		if (backend.deleteStickyDisk !== undefined) {
			for (const disk of disks) {
				if (disk.deletedAt === undefined) continue;
				for (const version of await store.stickyDiskVersions.list({ diskId: disk.id })) {
					await store.stickyDiskVersions.delete(version.id);
				}
				await diskHolders.forget("sticky", disk.id);
				await backend.deleteStickyDisk(disk.id).catch(() => undefined);
				if (t - disk.deletedAt > STICKY_TOMBSTONE_MS) await store.stickyDisks.delete(disk.id);
			}
		}
		await diskHolders.sweep(t);
		await forgetDroppedStickyVersions(disks);
	}
	/**
	 * Forgets each version of a live disk that its host, connected and reporting what it holds, no longer holds (it
	 * keeps only its newest few), so a disk lists the versions there are. Never the disk's head, which a later commit
	 * replaces; never on the word of a host that doesn't say what it holds (absent isn't none); never a version
	 * committed within `STICKY_REPORT_GRACE_MS` of the report, which may have been measured before it; and never a version
	 * another host still holds (its holders, `StoredDiskHolder`), which the version's own host's report can't speak for.
	 * Its holders go with it.
	 *
	 * A version without its block map's digest (its map took longer than its commit, or it was committed before maps)
	 * gets the one its host reports.
	 */
	async function forgetDroppedStickyVersions(disks: readonly StoredStickyDisk[]): Promise<void> {
		if (backend.stickyHoldings === undefined) return;
		const live = disks.filter((disk) => disk.deletedAt === undefined);
		if (live.length === 0) return;
		const reports = new Map<
			string,
			{ readonly reportedAt: number; readonly held: ReadonlySet<string>; readonly digests: ReadonlyMap<string, string> }
		>();
		for (const report of await backend.stickyHoldings()) {
			if (report.disks === undefined) continue;
			const held = new Set(report.disks.flatMap((disk) => disk.versions.map((version) => `${disk.diskId}/${version}`)));
			const digests = new Map(
				report.disks.flatMap((disk) =>
					Object.entries(disk.mapDigests ?? {}).map(
						([version, digest]) => [`${disk.diskId}/${version}`, digest] as const,
					),
				),
			);
			reports.set(report.hostId, { reportedAt: report.reportedAt, held, digests });
		}
		if (reports.size === 0) return;
		const hosts = new Map((await ensureHosts()).map((host) => [host.id, host]));
		for (const disk of live) {
			const holders = await diskHolders.holdersOf("sticky", disk.id);
			for (const version of await store.stickyDiskVersions.list({ diskId: disk.id })) {
				const report = reports.get(version.hostId);
				const digest = report?.digests.get(`${disk.id}/${version.id}`);
				if (version.mapDigest === undefined && digest !== undefined) {
					const given = await store.stickyDiskVersions.update(version.id, (current) =>
						current.mapDigest === undefined ? { ...current, mapDigest: digest } : undefined,
					);
					// A head committed before its map was made is sent to its disk's hosts now it can be fetched. Whether it is the
					// head is read again there: one committed since this pass read the disk is too.
					if (given !== undefined) keepGoing(prefetchStickyHead(disk.id, version.id));
				}
				if (version.id === disk.head || report === undefined) continue;
				if (version.createdAt > report.reportedAt - STICKY_REPORT_GRACE_MS) continue;
				if (report.held.has(`${disk.id}/${version.id}`)) continue;
				// A copy elsewhere keeps it: one held, not one being fetched (which needs a copy held to finish) or deleted.
				const elsewhere = (holder: StoredDiskHolder) =>
					holder.hostId !== version.hostId && holder.state === "held" && hosts.get(holder.hostId)?.state !== "revoked";
				if ((holders.get(version.id) ?? []).some(elsewhere)) continue;
				// Checked again as it is forgotten: a host that records holding it meanwhile keeps it.
				if (!(await store.stickyDiskWrites.forget(version.id, (latest) => latest.some(elsewhere)))) continue;
				await diskHolders.forget("sticky", disk.id, version.id);
			}
		}
	}

	/**
	 * Writes down that a sandbox with sticky disks started on its host (`StoredStickyDisk.ranOn`), so each new head is sent
	 * there (`prefetchStickyHead`): only where the host's entry is older than `STICKY_RAN_EVERY_MS`, so most starts only
	 * read, and entries past `STICKY_PREFETCH_MS` go as it writes (`stickyRunNoted`). Through `StickyDiskWrites`, which
	 * the account fence leaves alone, so a note landing as the account closes never removes the disk or its tombstone.
	 */
	async function noteStickyRuns(sandbox: StoredSandbox): Promise<void> {
		const hostId = sandbox.hostId;
		if (options.stickyDisks !== true || hostId === undefined) return;
		for (const attached of sandbox.stickyDisks ?? [])
			await store.stickyDiskWrites.noteRun(attached.diskId, hostId, now());
	}

	/**
	 * Sends a sticky disk's head to the hosts in its pool that started a sandbox with it within `STICKY_PREFETCH_MS`
	 * (`StoredStickyDisk.ranOn`), so the next sandbox there starts warm (docs/design/disk-store.md, 2d): `disk.fetch` with
	 * its pool's holders and a grant, as `fetchHostStickyDisk` sends it. Only while the version is still the head, where
	 * the disk's pool syncs, and once the head has its block map's digest, which the fetch checks against (a commit whose
	 * map took longer is sent once the sweep has it). A host that holds or is fetching it, that is away or draining, or
	 * that doesn't sync is left out, and nothing waits for the fetches, which progress in the hosts' reports.
	 */
	async function prefetchStickyHead(diskId: string, versionId: string): Promise<void> {
		const fetchDisk = backend.fetchDisk;
		if (fetchDisk === undefined) return;
		const disk = await store.stickyDisks.get(diskId);
		if (disk === undefined || disk.deletedAt !== undefined || disk.head !== versionId || disk.poolId === undefined)
			return;
		const since = now() - STICKY_PREFETCH_MS;
		const recent = Object.entries(disk.ranOn ?? {})
			.filter(([, at]) => at > since)
			.map(([hostId]) => hostId);
		if (recent.length === 0) return;
		const [version, pool] = await Promise.all([store.stickyDiskVersions.get(versionId), store.pools.get(disk.poolId)]);
		if (version?.mapDigest === undefined || pool?.sync !== true) return;
		const hosts = new Map((await ensureHosts()).map((host) => [host.id, host]));
		const holding = new Set(
			((await diskHolders.holdersOf("sticky", diskId)).get(versionId) ?? [])
				.filter((holder) => holder.state !== "deleting")
				.map((holder) => holder.hostId),
		);
		const request = { kind: "sticky", objectId: diskId, version: versionId };
		await Promise.all(
			recent.map(async (hostId) => {
				const host = hosts.get(hostId);
				if (host?.state !== "online" || host.poolId !== disk.poolId || holding.has(hostId)) return;
				// One host's refusal (it doesn't sync, it went away, nothing it can reach holds the head) is no other's.
				try {
					const location = await diskHolders.locate(hostId, request);
					if (location.holders.length > 0) await fetchDisk(hostId, { ...request, ...location });
				} catch {
					// Its next sandbox starts on the version it has, and fetches the head then.
				}
			}),
		);
	}

	/**
	 * Has `hostId` fetch a saved snapshot's disk (`ref`) from the hosts in its pool that hold it, as its own `disk.locate`
	 * would find them; its memory follows where it restores there. The host is recorded fetching it first, so a delete of
	 * the snapshot meanwhile reaches it at once, as one before its first report of the copy does; kept when the call fails,
	 * as the host may have started it anyway. A fast path only: whatever it misses, the host's report of a copy of a
	 * snapshot the catalogue no longer has gets it deleted (`DiskHolders.recordHoldings`), and the host asks before it
	 * publishes one. `conflict` when no other host there holds it.
	 */
	async function sendSnapshotFetch(hostId: string, ref: string): Promise<void> {
		if (backend.fetchDisk === undefined) {
			throw new KantelError("not_supported", "This deployment's hosts don't fetch disks from each other");
		}
		const objectId = refId(ref);
		const request = { kind: "snapshot", objectId, version: "disk" };
		const location = await diskHolders.locate(hostId, request);
		if (location.holders.length === 0) {
			throw new KantelError("conflict", "No other host in the host's pool holds that snapshot where it can fetch it");
		}
		await diskHolders.recordSnapshotFetch(objectId, "disk", hostId, ref);
		await backend.fetchDisk(hostId, { ...request, ...location });
	}

	/**
	 * Every host as saved snapshots' copies are counted and placed (`CopyHost`): its record's state, pool, owner and
	 * fingerprints, and what the backend says of its features, connection and free disk; its mesh address only while its
	 * pool syncs (`hostMeshAddress`).
	 */
	async function copyHosts(): Promise<Map<string, CopyHost>> {
		const [records, capabilities] = await Promise.all([ensureHosts(), backend.capabilities()]);
		const reported = new Map(capabilities.hosts.map((host) => [host.id, host]));
		const hosts = new Map<string, CopyHost>();
		for (const record of records) {
			const host = reported.get(record.id);
			const meshAddress = hostMeshAddress.get(record.id);
			hosts.set(record.id, {
				id: record.id,
				state: record.state,
				...(record.poolId === undefined ? {} : { poolId: record.poolId }),
				...(record.accountId === undefined ? {} : { accountId: record.accountId }),
				...(record.arch === undefined ? {} : { arch: record.arch }),
				...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
				...(record.cpuFingerprint === undefined ? {} : { cpuFingerprint: record.cpuFingerprint }),
				...(record.runtimeFingerprints === undefined ? {} : { runtimeFingerprints: record.runtimeFingerprints }),
				...(record.savedSnapshotBytesLimit === undefined
					? {}
					: { savedSnapshotBytesLimit: record.savedSnapshotBytesLimit }),
				...(meshAddress === undefined ? {} : { meshAddress }),
				// One the backend no longer has isn't connected, whatever its record says.
				connected: host !== undefined && host.connected !== false,
				...(host?.features === undefined ? {} : { features: host.features }),
				...(host?.freeDiskGb === undefined ? {} : { freeDiskGb: host.freeDiskGb }),
			});
		}
		return hosts;
	}

	/**
	 * Keeps a saved snapshot on `SNAPSHOT_COPIES` hosts of its pool (`snapshot-copies.ts`): where it has fewer, the host
	 * `copyTarget` picks is told to fetch it (`sendSnapshotFetch`). Only a saved snapshot named by its ID alone (an older
	 * ref's host-local ID may name another snapshot on the host that would fetch it), where snapshots are synced, in an
	 * account with `snapshotCopies` on. One ask for each snapshot every `COPY_RETRY_MS`, of every gateway, unless the last
	 * was answered (its host holds the copy): written over its record as it was read (`StoredSnapshot.copying`), which the
	 * next pick passes that host over by while it hasn't it.
	 * `read` is a pass's one read of what it needs for every snapshot; absent, it is read for this one.
	 */
	async function keepSnapshotCopies(
		snapshot: StoredSnapshot,
		read?: {
			readonly hosts: ReadonlyMap<string, CopyHost>;
			readonly holders: Map<string, StoredDiskHolder[]>;
			readonly accounts: Map<string, Promise<StoredAccount | undefined>>;
			readonly saved: readonly StoredSnapshot[];
		},
	): Promise<void> {
		const { ref } = snapshot;
		if (backend.fetchDisk === undefined || !diskHolders.syncsSnapshots) return;
		if (snapshot.kind !== "saved" || snapshot.state !== "ready" || ref === undefined || refHost(ref) !== undefined)
			return;
		let account = read?.accounts.get(snapshot.accountId);
		if (account === undefined) {
			account = store.accounts.get(snapshot.accountId);
			read?.accounts.set(snapshot.accountId, account);
		}
		const owner = await account;
		if (owner === undefined || owner.closedAt !== undefined || owner.snapshotCopies === false) return;
		const holders = (
			read === undefined
				? ((await diskHolders.holdersOf("snapshot", ref)).get("disk") ?? [])
				: (read.holders.get(ref) ?? [])
		).filter((holder) => holder.ref === ref && holder.version === "disk");
		// Nothing to copy from until its host has reported it.
		if (!holders.some((holder) => holder.state === "held")) return;
		const hosts = read?.hosts ?? (await copyHosts());
		const taken = await hostOfSnapshot(snapshot);
		const poolId = snapshot.poolId ?? (taken === undefined ? undefined : hosts.get(taken)?.poolId);
		if (poolId === undefined) return;
		const at = now();
		if (keepingCopies(holders, hosts, poolId, at).length >= SNAPSHOT_COPIES) return;
		const target = copyTarget(snapshot, holders, await withAllowances(snapshot, hosts, read), poolId, at);
		if (target === undefined) return;
		// An ask the host it named has answered (it holds the copy) holds back no other.
		const held = new Set(holders.filter((holder) => holder.state === "held").map((holder) => holder.hostId));
		const claimed = await store.snapshots.update(snapshot.id, (latest) =>
			latest.state !== "ready" ||
			(latest.copying !== undefined && latest.copying.at > at - COPY_RETRY_MS && !held.has(latest.copying.hostId))
				? undefined
				: { ...latest, copying: { hostId: target, at } },
		);
		if (claimed === undefined) return;
		// Counted as fetching it for the rest of the pass, so a host's allowance isn't spent twice.
		read?.holders.set(ref, [
			...(read.holders.get(ref) ?? []),
			{
				id: diskHolderId("snapshot", refId(ref), "disk", target),
				kind: "snapshot",
				objectId: refId(ref),
				version: "disk",
				hostId: target,
				state: "fetching",
				since: at,
				ref,
			},
		]);
		// One that fails is asked of another host on a later pass: this one is passed over meanwhile.
		await sendSnapshotFetch(target, ref).catch(() => undefined);
	}

	/**
	 * `hosts` with what `snapshot`'s account may still keep in saved snapshots on each that limits it
	 * (`CopyHost.savedBytesLeft`): its limit less the full size of each of the account's saved snapshots there, by ref,
	 * once each, whether the host saved it or holds or is fetching a copy (`savedBytesOver` counts its own saves alone,
	 * so a copy never keeps an account from saving), all but `snapshot` itself, which `copyTarget` adds. A host without a
	 * limit is as it was.
	 */
	async function withAllowances(
		snapshot: StoredSnapshot,
		hosts: ReadonlyMap<string, CopyHost>,
		read?: {
			readonly holders: ReadonlyMap<string, readonly StoredDiskHolder[]>;
			readonly saved: readonly StoredSnapshot[];
		},
	): Promise<ReadonlyMap<string, CopyHost>> {
		const limited = [...hosts.values()].filter((host) => host.savedSnapshotBytesLimit !== undefined);
		if (limited.length === 0) return hosts;
		const saved = (
			read?.saved ?? (await store.snapshots.list({ accountId: snapshot.accountId, kind: "saved" }))
		).filter(
			(record) => record.accountId === snapshot.accountId && record.state !== "deleting" && record.ref !== undefined,
		);
		const used = new Map<string, Map<string, number>>();
		for (const record of saved) {
			const ref = record.ref ?? "";
			// This one's own charge, where a host holds or is fetching it already, is the copy's: asked again (a fetch that
			// ran too long), it costs nothing more there.
			if (ref === snapshot.ref) continue;
			const copies =
				read?.holders.get(ref) ??
				((await diskHolders.holdersOf("snapshot", refId(ref))).get("disk") ?? []).filter(
					(holder) => holder.ref === ref,
				);
			const on = new Set(copies.filter((holder) => holder.state !== "deleting").map((holder) => holder.hostId));
			const taken = await hostOfSnapshot(record);
			if (taken !== undefined) on.add(taken);
			for (const hostId of on) {
				const refs = used.get(hostId) ?? new Map<string, number>();
				refs.set(ref, Math.max(refs.get(ref) ?? 0, fullSize(record)));
				used.set(hostId, refs);
			}
		}
		const out = new Map(hosts);
		for (const host of limited) {
			let total = 0;
			for (const size of used.get(host.id)?.values() ?? []) total += size;
			out.set(host.id, { ...host, savedBytesLeft: (host.savedSnapshotBytesLimit ?? 0) - total });
		}
		return out;
	}

	/** Keeps the copies of each saved snapshot with `ref` (`keepSnapshotCopies`): a host holds its disk now. */
	async function keepCopiesOf(ref: string): Promise<void> {
		for (const snapshot of await store.snapshots.list({ ref })) await keepSnapshotCopies(snapshot);
	}

	/**
	 * Keeps every saved snapshot's copies (`keepSnapshotCopies`), each in turn, over one read of the hosts, the holders of
	 * saved snapshots' disks and the accounts: run by the sweep every `SNAPSHOT_COPIES_EVERY_MS`, and on a host's
	 * revocation, so a copy lost with a host revoked or away is made again from the one left.
	 */
	async function keepEverySnapshotsCopies(): Promise<void> {
		if (backend.fetchDisk === undefined || !diskHolders.syncsSnapshots) return;
		const saved = (await store.snapshots.list({ kind: "saved", state: "ready" })).filter(
			(snapshot) => snapshot.ref !== undefined && refHost(snapshot.ref) === undefined,
		);
		if (saved.length === 0) return;
		const holders = new Map<string, StoredDiskHolder[]>();
		for (const holder of await store.diskHolders.list()) {
			if (holder.kind !== "snapshot" || holder.version !== "disk" || holder.ref === undefined) continue;
			holders.set(holder.ref, [...(holders.get(holder.ref) ?? []), holder]);
		}
		const read = {
			hosts: await copyHosts(),
			holders,
			accounts: new Map<string, Promise<StoredAccount | undefined>>(),
			saved: await store.snapshots.list({ kind: "saved" }),
		};
		for (const snapshot of saved) {
			if (closing) return;
			await keepSnapshotCopies(snapshot, read).catch(() => undefined);
		}
	}

	// Templates: their routes, their snapshot cache's builds (tracked, so `idle()` waits for them) and a create's start.
	const templates = createTemplateService({
		store,
		backend,
		now,
		enabled: options.templates === true,
		keepGoing,
		buildHosts: async (accountId, userId) => {
			const shared = options.sharedHosts === undefined || (await options.sharedHosts(userId));
			const known = await ensureHosts();
			try {
				return requireHosts(known, accountId, "microvm", {}, false, shared).map((id) => ({
					id,
					...pooled(known.find((host) => host.id === id)?.poolId),
				}));
			} catch {
				return [];
			}
		},
		// In its pool's mesh, with the pool's sync on, as the latest read of the hosts says.
		takesCopies: (hostId) => hostMeshAddress.has(hostId),
		buildEgress: async (accountId, grants) => (await egressFor(accountId, { grants, env: {} })).egress,
		normaliseGrants,
		checkVariableName,
		checkResources: (resources) => checkShape("microvm", resources),
		actorOf: (principal) => actorOf(principal),
		once: (principal, operation, input, work) => once(principal, operation, input, work),
	});

	// Pools: an account's hosts, or the shared ones, in sets (`pools.ts`).
	const pools = createPoolService({
		store,
		now,
		hosts: () => ensureHosts(),
		syncChanged: async (poolId, sync) => {
			await backend.updatePool?.(poolId, { sync });
		},
		requireAccountHosts: () => requireAccountHosts(),
		once: (principal, operation, input, work) => once(principal, operation, input, work),
		...(runnerSettings === undefined ? {} : { runners: poolRunners }),
	});

	// Which hosts hold which disk versions, and grants to fetch them from each other (`disk-holders.ts`).
	const diskHolders = createDiskHolders({
		store,
		now,
		stickyDisks: options.stickyDisks === true,
		templates: options.templates === true,
		sealer,
		hosts: () => ensureHosts(),
		meshAddress: (hostId) => hostMeshAddress.get(hostId),
		reportGraceMs: STICKY_REPORT_GRACE_MS,
		// Connected hosts are told at once; the hosts service's check on their heartbeats makes good a telling missed.
		keysChanged: () => {
			if (backend.grantKeysChanged !== undefined) keepGoing(backend.grantKeysChanged());
		},
		// A copy of a saved snapshot the catalogue no longer has, whatever became of its record: deleted from its host.
		deleteSnapshotCopy: (hostId, objectId) => backend.deleteSnapshot(`${hostId}/${objectId}`),
		// A save its host has mapped, or a copy one has fetched: its copies are counted now, so a second is asked for at once.
		snapshotHeld: (ref) => keepGoing(keepCopiesOf(ref)),
	});

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
	// The pools as the latest read of the hosts read them, beside the hosts (`placementPool`'s, saving a read a create).
	let poolsRead: readonly StoredPool[] = [];
	// Each host's memory as the backend last said, answered with it (`hostView`) but never stored: it moves on every
	// heartbeat.
	const hostMemory = new Map<string, computeSchema.HostMemory>();
	// Each host's mesh address as the backend last said, for `disk.locate`'s answers; not stored either.
	const hostMeshAddress = new Map<string, string>();
	// Each host's mesh health as the backend last said, kept as its memory is: it moves on every heartbeat too.
	const hostMesh = new Map<string, computeSchema.HostMesh>();
	const ensureHosts = (read?: Promise<BackendCapabilities>): Promise<StoredHost[]> => {
		hostsReady ??= (async () => {
			const [capabilities, records, allPools] = await Promise.all([
				read ?? backend.capabilities(),
				store.hosts.list(),
				store.pools.list(),
			]);
			const byId = new Map(records.map((record) => [record.id, record]));
			const writes: Promise<void>[] = [];
			hostMemory.clear();
			poolsRead = allPools;
			hostMeshAddress.clear();
			// Mesh addresses are up only in pools with sync on: a host in another is no holder to fetch from (taken below).
			const syncing = new Set(allPools.filter((pool) => pool.sync === true).map((pool) => pool.id));
			hostMesh.clear();
			// Each owner's pools, read in the one statement above; an owner with none gets its default made.
			const ownerPools = new Map<string, Promise<StoredPool[]>>();
			const grouped = new Map<string, StoredPool[]>();
			for (const pool of allPools) grouped.set(pool.owner, [...(grouped.get(pool.owner) ?? []), pool]);
			for (const [owner, owned] of grouped) ownerPools.set(owner, Promise.resolve(owned));
			/**
			 * The pool a host is in: `wanted` where it is one of the owner's pools, else the owner's default. So a host is in
			 * a pool that exists whatever raced: one from before pools, one joined with a token whose pool was deleted
			 * meanwhile, and one in a pool deleted as it was moved or joined there all go to the default. None where the
			 * owner's pools can't be made (an account closing, whose hosts are being revoked).
			 */
			const poolFor = async (owner: string, wanted: string | undefined): Promise<string | undefined> => {
				let read = ownerPools.get(owner);
				if (read === undefined) {
					// An account gone or closing gets none made: its hosts are being revoked.
					read = (async () => {
						if (owner !== OPERATOR_POOLS) {
							const account = await store.accounts.get(owner);
							if (account === undefined || account.closedAt !== undefined) return [];
						}
						return pools.poolsOf(owner).catch(() => []);
					})();
					ownerPools.set(owner, read);
				}
				const known = await read;
				if (wanted === undefined) return defaultPoolOf(known)?.id;
				if (known.some((pool) => pool.id === wanted)) return wanted;
				// Not in the pools read: made since (a move into it read after them) unless it has gone.
				const since = await store.pools.get(wanted);
				if (since !== undefined && since.owner === owner) return wanted;
				return defaultPoolOf(known)?.id ?? wanted;
			};
			for (const host of capabilities.hosts) {
				if (host.memory !== undefined) hostMemory.set(host.id, host.memory);
				if (host.mesh !== undefined) hostMesh.set(host.id, host.mesh);
				const known = byId.get(host.id);
				const reachable = host.connected !== false;
				// A host enrolled into an account stays that account's: the registry says so, or the enrolment it spent does
				// (looked up once, when the host is first seen). Once private, never shared again.
				const enrolment =
					known === undefined && (host.accountId === undefined || host.poolId === undefined)
						? await enrolmentOf(host.id)
						: undefined;
				const accountId = known?.accountId ?? host.accountId ?? enrolment?.accountId;
				// Its pool: the one it is in; else, first seen, the one its join token named; else (one from before pools, or
				// a pool that has gone) its owner's default (`poolFor`). A revoked host's is left.
				const poolId =
					known?.state === "revoked"
						? known.poolId
						: await poolFor(accountId ?? OPERATOR_POOLS, known?.poolId ?? host.poolId ?? enrolment?.poolId);
				// Applied to the record as it is when written, not only as read above: a revocation or drain that lands
				// meanwhile (another request, another gateway) is kept.
				const refresh = (current: StoredHost): StoredHost => {
					const held = current.state === "revoked" || current.state === "draining";
					const owner = current.accountId ?? accountId;
					// The version to run is the backend's now; an update under way ends once the host is on it, or isn't
					// after `HOST_UPDATE_WINDOW_MS` (the host couldn't, and says so in its log).
					const {
						latestVersion: _latest,
						updateAvailable: _available,
						updating,
						diskUsage: keptDisk,
						cpuFingerprint: _cpu,
						runtimeFingerprints: _runtimes,
						...rest
					} = current;
					const pending =
						updating !== undefined &&
						updating.version !== host.version &&
						now() - updating.requestedAt < HOST_UPDATE_WINDOW_MS;
					return {
						...rest,
						...(owner === undefined ? {} : { accountId: owner }),
						// A move written meanwhile (another gateway) stands.
						...pooled(current.poolId === known?.poolId ? poolId : current.poolId),
						state: held ? current.state : reachable ? "online" : "unreachable",
						...hostVersions(host),
						...(pending ? { updating } : {}),
						version: host.version,
						os: host.os,
						arch: host.arch,
						tiers: [...host.tiers],
						kvm: host.kvm,
						nestedVirtualisation: host.nestedVirtualisation,
						...fingerprintsOf(host),
						capacity: { ...host.capacity },
						// What its disk holds: the latest measure it sent, else the one kept.
						...(host.diskUsage === undefined
							? keptDisk === undefined
								? {}
								: { diskUsage: keptDisk }
							: { diskUsage: { ...host.diskUsage } }),
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
					...hostVersions(host),
					os: host.os,
					arch: host.arch,
					tiers: [...host.tiers],
					kvm: host.kvm,
					nestedVirtualisation: host.nestedVirtualisation,
					...fingerprintsOf(host),
					capacity: { ...host.capacity },
					...(host.diskUsage === undefined ? {} : { diskUsage: { ...host.diskUsage } }),
					allocated: { sandboxes: 0, vcpus: 0, memoryMb: 0, diskGb: 0 },
					labels: { ...host.labels },
					...(accountId === undefined ? {} : { accountId }),
					...(poolId === undefined ? {} : { poolId }),
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
				// One that isn't here now goes into a pool that exists too.
				const poolId =
					advertised.has(record.id) || record.state === "revoked"
						? record.poolId
						: await poolFor(poolOwnerOf(record), record.poolId);
				if (poolId !== undefined && poolId !== record.poolId) {
					byId.set(record.id, { ...(byId.get(record.id) ?? record), poolId });
					writes.push(
						store.hosts
							.update(record.id, (current) => (current.poolId === record.poolId ? { ...current, poolId } : undefined))
							.then(() => undefined),
					);
				}
				if (advertised.has(record.id) || record.state !== "online") continue;
				byId.set(record.id, { ...(byId.get(record.id) ?? record), state: "unreachable" });
				writes.push(
					store.hosts
						.update(record.id, (current) =>
							current.state === "online" ? { ...current, state: "unreachable" } : undefined,
						)
						.then(() => undefined),
				);
			}
			await Promise.all(writes);
			const answer = [...byId.values()];
			for (const host of capabilities.hosts) {
				const record = byId.get(host.id);
				if (record === undefined || record.state === "revoked") continue;
				// Its mesh address, given in the registry's pool: only while that is the pool here too (a move the registry
				// hasn't taken yet has an address in the pool it left) and it has sync on.
				if (host.meshAddress !== undefined && host.poolId === record.poolId && syncing.has(record.poolId ?? "")) {
					hostMeshAddress.set(host.id, host.meshAddress);
				}
				// The registry keeps each host's pool too, for what runs on the hosts (the mesh): told where it differs.
				if (record.poolId !== undefined && host.poolId !== record.poolId) {
					tellPool(record.id, record.poolId, host.poolId !== undefined);
				}
			}
			return answer;
		})().finally(() => {
			hostsReady = undefined;
		});
		return hostsReady;
	};

	/** The join token a host spent, where this store minted it: the account and pool it joined the host to. */
	async function enrolmentOf(hostId: string): Promise<StoredJoinToken | undefined> {
		const [token] = await store.joinTokens.list({ hostId });
		return token;
	}

	// The hosts whose registry is being told their pool (`tellPool`), and the pool told to each that keeps none.
	const telling = new Set<string>();
	const toldUnkept = new Map<string, string>();

	/**
	 * Tells the backend's registry the pool a host is in, in the background, one call at a time per host. A registry that
	 * keeps a pool (`kept`) and has another is told whenever it is read so, from any gateway, so it is put right after a
	 * move whose call to it failed; one that keeps none (a routed backend's other side) is told once per pool from this
	 * gateway, not on every read.
	 */
	function tellPool(hostId: string, poolId: string, kept: boolean): void {
		const updateHost = backend.updateHost?.bind(backend);
		if (updateHost === undefined || telling.has(hostId) || (!kept && toldUnkept.get(hostId) === poolId)) return;
		telling.add(hostId);
		keepGoing(
			updateHost(hostId, { poolId })
				.then(() => {
					if (!kept) toldUnkept.set(hostId, poolId);
				})
				.finally(() => telling.delete(hostId)),
		);
	}

	/**
	 * Whether a host holds a sandbox. Its backend's scheduler says first where it can (`hostHolds`: a placement, one
	 * being made included, which a drained host takes no more of). Then the records here: a create, fork or upgrade that
	 * doesn't name the host yet (starting, or `error` from a call never answered, which the host may still have made),
	 * found by where its backend placed it, as `strandOn` finds them; and one whose record names the host, in any state
	 * but `deleted`. Read in that order, so one that comes to name it between the reads is found by the last.
	 */
	async function holdsSandboxes(hostId: string): Promise<boolean> {
		if ((await backend.hostHolds?.(hostId)) === true) return true;
		if (backend.placedOn !== undefined) {
			const unnamed = (
				await Promise.all([store.sandboxes.list({ state: "starting" }), store.sandboxes.list({ state: "error" })])
			)
				.flat()
				.filter((sandbox) => sandbox.hostId === undefined);
			for (const sandbox of unnamed) {
				if ((await backend.placedOn(sandbox.id)) === hostId) return true;
			}
		}
		const named = await store.sandboxes.list({ hostId });
		return named.some((sandbox) => NOT_DELETED.includes(sandbox.state));
	}

	/**
	 * Moves a drained host with no sandboxes to another of its owner's pools: one conditional write, made only while the
	 * host is still draining and in the pool it was read in, so a host undrained or moved meanwhile isn't moved. A draining
	 * host takes no new sandbox (here or in the registry, whose scheduler refuses one too), so none can land after the
	 * check. Then the registry is told, which a later read tells again should that fail (`tellPool`). It stays draining:
	 * whoever moved it undrains it.
	 */
	async function moveHost(host: StoredHost, into: StoredPool): Promise<StoredHost> {
		if (into.id === host.poolId) return host;
		if (host.state !== "draining") {
			throw new KantelError(
				"conflict",
				"Drain the host before moving it to another pool, and move it once it has no sandboxes",
			);
		}
		if (await holdsSandboxes(host.id)) {
			throw new KantelError("conflict", "The host still has sandboxes: move it once they are deleted");
		}
		const from = host.poolId;
		const drain = host.drainEpoch;
		let refused: string | undefined;
		const moved = await store.hosts.update(host.id, (current) => {
			refused =
				current.state === "revoked"
					? "The host is revoked"
					: current.state !== "draining" || current.drainEpoch !== drain
						? "The host was undrained meanwhile: drain it again to move it"
						: current.poolId !== from
							? "The host was moved meanwhile"
							: undefined;
			return refused === undefined ? { ...current, poolId: into.id, poolSince: now() } : undefined;
		});
		if (refused !== undefined) throw new KantelError("conflict", refused);
		if (moved === undefined) throw new KantelError("not_found", "No such host");
		await backend.updateHost?.(host.id, { poolId: into.id }).catch(() => undefined);
		return moved;
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
	 *
	 * `pin`: the one host it was asked to go on (`CreateSandboxBody.host`), whether or not the account has hosts of its
	 * own; `host_unavailable` when that host can't take it now.
	 *
	 * `pool`: the pools it may go in (`PoolChoice`), before its labels choose among their hosts; absent, any.
	 */
	function requireHosts(
		hosts: readonly StoredHost[],
		accountId: string,
		type: SandboxType,
		labels: { readonly [key: string]: string },
		affine: boolean,
		shared: boolean,
		pin?: string,
		pool?: PoolChoice,
	): string[] {
		if (pin !== undefined) {
			const pinned = hosts.find((host) => host.id === pin);
			const eligible =
				pinned === undefined ? [] : requireHostsOrNone([pinned], accountId, type, labels, affine, shared, false, pool);
			if (eligible.length === 0) {
				throw placementError(
					"unavailable",
					"host_unavailable",
					`The host ${pinned?.name ?? pin} can't run ${article(type)} ${type} sandbox now: it is offline, draining, doesn't run ${type} sandboxes or lacks the host labels asked for`,
				);
			}
			return eligible;
		}
		return requireHostsOrNone(hosts, accountId, type, labels, affine, shared, true, pool);
	}

	/** `requireHosts` without a pin: the eligible hosts, or with `refuse` an `unavailable` error when there are none. */
	function requireHostsOrNone(
		hosts: readonly StoredHost[],
		accountId: string,
		type: SandboxType,
		labels: { readonly [key: string]: string },
		affine: boolean,
		shared: boolean,
		refuse = false,
		pool?: PoolChoice,
	): string[] {
		// The hosts it may use, narrowed a check at a time, so a refusal says which check left none: its pool first.
		const up = hosts
			.filter((host) => host.accountId === accountId || (shared && host.accountId === undefined))
			.filter(
				(host) =>
					pool === undefined || (host.accountId === undefined ? host.poolId === pool.shared : host.poolId === pool.own),
			)
			.filter((host) => host.state === "online" || (affine && host.state === "draining"));
		const typed = up.filter((host) => host.tiers.includes(type));
		const qualifying = typed.filter((host) =>
			Object.entries(labels).every(([key, value]) => host.labels[key] === value),
		);
		const own = qualifying.filter((host) => host.accountId === accountId);
		const common = shared ? qualifying.filter((host) => host.accountId === undefined) : [];
		const eligible = (affine ? [...own, ...common] : own.length > 0 ? own : common).map((host) => host.id);
		if (eligible.length === 0 && refuse) {
			// Bound to its disk or snapshot, it can go only on that one host, whatever else the fleet has: that host is the
			// reason, as it is when the boot finds it gone with other hosts up.
			const reason: PlacementReason = affine
				? "host_unavailable"
				: up.length === 0
					? "no_host"
					: typed.length === 0
						? "no_host_for_type"
						: "no_host_with_labels";
			const what = `${article(type)} ${type} sandbox${reason === "no_host_with_labels" ? " with those host labels" : ""}`;
			throw placementError(
				"unavailable",
				reason,
				pool?.name !== undefined
					? `No host in pool ${pool.name} can run ${what} now`
					: shared
						? `No host can run ${what} now`
						: `No host of this account's own can run ${what} now. Add one with kantel hosts add, or under Hosts in the console`,
			);
		}
		return eligible;
	}

	/**
	 * The pools a new sandbox may go in. Named (`CreateSandboxBody.pool`), one of the account's pools, else (where the
	 * caller may use shared hosts) one of the deployment's: that pool only. Not named, the account's default pool for its
	 * own hosts (where it has any) and the deployment's default for the shared ones, so it goes as before pools: on its
	 * own hosts where one qualifies, else a shared one.
	 */
	async function placementPool(
		accountId: string,
		ref: string | undefined,
		hosts: readonly StoredHost[],
		shared: boolean,
	): Promise<PoolChoice> {
		// An owner's pools as the hosts' read had them, else read (and its default made) now.
		const poolsOf = async (owner: string) => {
			const read = poolsRead.filter((pool) => pool.owner === owner);
			return read.length > 0 ? read : pools.poolsOf(owner);
		};
		const named = (list: readonly StoredPool[], name: string) =>
			list.find((pool) => pool.id === name) ?? list.find((pool) => pool.name === name);
		if (ref !== undefined) {
			// The account's pools as the hosts' read had them, else read again (one made since): none made by naming one.
			const mine =
				named(
					poolsRead.filter((pool) => pool.owner === accountId),
					ref,
				) ?? named(await store.pools.list({ owner: accountId }), ref);
			if (mine !== undefined) return { own: mine.id, name: mine.name };
			if (shared) {
				const theirs =
					named(await poolsOf(OPERATOR_POOLS), ref) ?? named(await store.pools.list({ owner: OPERATOR_POOLS }), ref);
				if (theirs !== undefined) return { shared: theirs.id, name: theirs.name };
			}
			throw new KantelError("not_found", `No pool named ${ref}`);
		}
		const hasOwn = hosts.some((host) => host.accountId === accountId && host.state !== "revoked");
		const [own, common] = await Promise.all([
			hasOwn ? poolsOf(accountId).then(defaultPoolOf) : undefined,
			shared ? poolsOf(OPERATOR_POOLS).then(defaultPoolOf) : undefined,
		]);
		return { ...(own === undefined ? {} : { own: own.id }), ...(common === undefined ? {} : { shared: common.id }) };
	}

	/**
	 * The pools a sandbox placed before may be placed in again: its own (`poolId`) only; any, for one from before pools;
	 * none, where its pool has gone (it isn't placed elsewhere).
	 */
	async function poolOfSandbox(sandbox: StoredSandbox): Promise<PoolChoice | undefined> {
		return sandbox.poolId === undefined ? undefined : poolChoiceOf(sandbox.poolId);
	}

	/** The pool `poolId` as a placement's choice: that pool only; none, where it has gone. */
	async function poolChoiceOf(poolId: string): Promise<PoolChoice> {
		const pool = await store.pools.get(poolId);
		if (pool === undefined) return { name: poolId };
		return pool.owner === OPERATOR_POOLS ? { shared: pool.id, name: pool.name } : { own: pool.id, name: pool.name };
	}

	/**
	 * `poolId` where that pool is still there (as the hosts' read had the pools, else read now), else undefined: data
	 * whose pool was deleted under it (a delete racing its create) is taken to have none, so it isn't left unusable.
	 */
	async function livePool(poolId: string | undefined): Promise<string | undefined> {
		if (poolId === undefined) return undefined;
		if (poolsRead.some((pool) => pool.id === poolId)) return poolId;
		return (await store.pools.get(poolId)) === undefined ? undefined : poolId;
	}

	/** A pool's name for a message, or its ID where it has gone; "no pool" for none. */
	async function poolName(poolId: string | undefined): Promise<string> {
		if (poolId === undefined) return "no pool";
		return (await store.pools.get(poolId))?.name ?? poolId;
	}

	/**
	 * The pool a sandbox made or forked from `snapshot` goes in: the snapshot's own (`poolId`), else (one from before
	 * pools, or whose pool has since been deleted) the pool of the host holding it, among `hosts`. Refused,
	 * `host_unavailable`, when that host is in another pool than the snapshot's now (moved since): a snapshot stays in its
	 * pool, and nothing is made from it in another. Undefined where neither can be told.
	 *
	 * One that must go in a pool (`kept`: the pool a create named, or the one an upgrading isolate is in) is refused,
	 * `host_unavailable`, when the snapshot is in another, or when its pool can't be told, which isn't guessed. `name`:
	 * that pool as the caller knows it; `instead`: what to do then.
	 */
	async function poolOfSnapshot(
		snapshot: StoredSnapshot,
		hosts: readonly StoredHost[],
		kept?: { readonly id: string; readonly name: string; readonly instead: string },
	): Promise<string | undefined> {
		const holderId = await hostOfSnapshot(snapshot);
		const holderPool = holderId === undefined ? undefined : hosts.find((host) => host.id === holderId)?.poolId;
		const recorded = await livePool(snapshot.poolId);
		// A ref naming no host (a saved snapshot's ID alone) is its pool's, on any of its holders there: the host it was
		// taken on moving to another pool leaves the copies in its own.
		const named = snapshot.ref !== undefined && refHost(snapshot.ref) !== undefined;
		if (recorded !== undefined && holderPool !== undefined && holderPool !== recorded && named) {
			throw placementError(
				"unavailable",
				"host_unavailable",
				`The snapshot is in pool ${await poolName(recorded)}, and the host holding it is in pool ${await poolName(holderPool)} now: nothing is made from it outside its pool`,
			);
		}
		const pool = recorded ?? holderPool;
		if (kept !== undefined && pool !== kept.id) {
			throw placementError(
				"unavailable",
				"host_unavailable",
				pool === undefined
					? `The snapshot's pool can't be told, so it can't be made in ${kept.name}: ${kept.instead}`
					: `The snapshot is in pool ${await poolName(pool)}, not ${kept.name}: a sandbox made from it runs only in its pool`,
			);
		}
		return pool;
	}

	/** The pool a sandbox is kept to (a `PoolChoice`), as `poolOfSnapshot` takes it: none for one kept to none. */
	function keptPool(pool: PoolChoice | undefined, instead: string) {
		const id = pool?.own ?? pool?.shared;
		return id === undefined || pool?.name === undefined ? undefined : { id, name: pool.name, instead };
	}

	/**
	 * The pool a sandbox's sticky disks hold it to, and the disk that says so: each disk's own (`StoredStickyDisk.poolId`),
	 * or for one from before pools with versions, the pool of the host its newest was made on, among `hosts`. Undefined
	 * where none has a pool yet. `invalid` when two are in different pools.
	 */
	async function poolOfStickyDisks(
		attached: readonly computeSchema.SandboxStickyDisk[],
		hosts: readonly StoredHost[],
	): Promise<{ readonly poolId: string; readonly disk: string } | undefined> {
		let held: { readonly poolId: string; readonly disk: string } | undefined;
		for (const each of attached) {
			const disk = await store.stickyDisks.get(each.diskId);
			const recorded = await livePool(disk?.poolId);
			const head = recorded !== undefined || disk?.head === undefined ? undefined : disk.head;
			const madeOn = head === undefined ? undefined : (await store.stickyDiskVersions.get(head))?.hostId;
			const poolId = recorded ?? hosts.find((host) => host.id === madeOn)?.poolId;
			if (poolId === undefined) continue;
			if (held !== undefined && held.poolId !== poolId) {
				throw new KantelError(
					"invalid",
					`The sticky disks ${held.disk} and ${each.name} are in different pools (${await poolName(held.poolId)} and ${await poolName(poolId)}): a sandbox's sticky disks are all of its pool`,
				);
			}
			held = { poolId, disk: each.name };
		}
		return held;
	}

	/** Refusal of a sticky disk in pool `diskPool` for a sandbox in `sandboxPool`, naming both. */
	async function stickyPoolRefusal(disk: string, diskPool: string, sandboxPool: string | undefined) {
		return placementError(
			"unavailable",
			"host_unavailable",
			`The sticky disk ${disk} is in pool ${await poolName(diskPool)}, not ${sandboxPool === undefined ? "no pool" : `pool ${await poolName(sandboxPool)}`}: a sticky disk is attached only to sandboxes in its own pool`,
		);
	}

	/**
	 * Gives a sandbox's sticky disks with no pool yet the sandbox's, `poolId`, all of them or none
	 * (`StickyDiskWrites.pool`): refused, naming both pools, while any is in another. So of two sandboxes in different
	 * pools attaching new disks at once, one gives them its pool and the other is refused, leaving none in its own.
	 */
	async function bindStickyDisks(attached: readonly computeSchema.SandboxStickyDisk[], poolId: string): Promise<void> {
		// A disk whose pool was deleted under it (a delete racing its create) has none again, only while it still names it.
		for (const each of attached) {
			const gone = (await store.stickyDisks.get(each.diskId))?.poolId;
			if (gone === undefined || gone === poolId || (await livePool(gone)) !== undefined) continue;
			await store.stickyDisks.update(each.diskId, ({ poolId: was, ...rest }) => (was === gone ? rest : undefined));
		}
		const other = await store.stickyDiskWrites.pool(
			attached.map((disk) => disk.diskId),
			poolId,
		);
		if (other === undefined) return;
		const name = attached.find((disk) => disk.diskId === other.diskId)?.name ?? other.diskId;
		throw await stickyPoolRefusal(name, other.poolId, poolId);
	}

	/**
	 * Whether `principal` may use the deployment's shared hosts (`ComputeServiceOptions.sharedHosts`). A super-admin
	 * always may.
	 */
	async function mayShare(principal: Principal): Promise<boolean> {
		if (options.sharedHosts === undefined || principal.superAdmin) return true;
		return options.sharedHosts(principal.userId);
	}

	/**
	 * The hosts a sandbox made from `snapshot` can start on (`SandboxSpec.snapshotCopies`, docs/design/disk-store.md,
	 * "Phase 3 notes"): the host it was taken on (`hostOfSnapshot`), its first holder, then each host with a copy of its
	 * disk (the catalogue's `snapshot` holders of its ref), each with whether its copy restores the snapshot's memory (the
	 * host it was taken on, or a copy whose memory came too, which a host fetches only where it restores it). It may be
	 * fetched by another host where snapshots are synced, its pool can be told (a copy is offered only in it), and a
	 * holder online in it has reported its disk.
	 */
	async function snapshotCopiesOf(
		snapshot: StoredSnapshot,
		hosts: readonly StoredHost[],
		poolId: string | undefined,
	): Promise<SnapshotCopies> {
		const memory = await holdsMemory(snapshot);
		const origin = await hostOfSnapshot(snapshot);
		const holders: { hostId: string; memory: boolean }[] = origin === undefined ? [] : [{ hostId: origin, memory }];
		const { ref } = snapshot;
		if (ref === undefined) return { holders, memory, fetch: false };
		const byVersion = await diskHolders.holdersOf("snapshot", refId(ref));
		const held = (version: string) =>
			(byVersion.get(version) ?? []).filter((holder) => holder.ref === ref && holder.state === "held");
		const withMemory = new Set(held("memory").map((holder) => holder.hostId));
		const disks = held("disk");
		for (const holder of disks) {
			if (holders.some((each) => each.hostId === holder.hostId)) continue;
			holders.push({ hostId: holder.hostId, memory: memory && withMemory.has(holder.hostId) });
		}
		const online = new Map(
			hosts
				.filter((host) => (host.state === "online" || host.state === "draining") && host.poolId === poolId)
				.map((host) => [host.id, host]),
		);
		// The holders that serve it (a full or draining one too), which a host fetches from only of its architecture.
		const serving = disks.filter((holder) => holder.mapDigest !== undefined && online.has(holder.hostId));
		const architectures = [...new Set(serving.flatMap((holder) => online.get(holder.hostId)?.arch ?? []))];
		// Only a saved snapshot's ID alone: an older ref's host-local ID may name another snapshot on the host fetching it.
		const fetch =
			diskHolders.syncsSnapshots && poolId !== undefined && refHost(ref) === undefined && serving.length > 0;
		return { holders, memory, fetch, ...(fetch && architectures.length > 0 ? { architectures } : {}) };
	}

	/**
	 * The hosts a saved snapshot is on, for its details (`Snapshot.hosts`), as their hosts report them: the catalogue's
	 * holders of its disk under its ref (`snapshot` holders), held or being fetched, the host it was taken on first, each
	 * with whether a sandbox made from it there restores its memory (its own host, or a copy whose memory is held there
	 * too). One rule for every snapshot whose holdings are reported. Those that aren't, an isolate's (only the microVM
	 * tier reports snapshots) and a ref naming its host with no holder (its host may be from before hosts reported them),
	 * are listed on the host they were taken on, as their save said, the only word there is. A revoked host holds
	 * nothing. Each is named only to a caller who may be told of it (`mayKnowHost`). Undefined for an automatic
	 * snapshot, or one not yet ready.
	 */
	async function snapshotHostsView(
		principal: Principal,
		snapshot: StoredSnapshot,
	): Promise<computeSchema.SnapshotHost[] | undefined> {
		const { ref } = snapshot;
		if (snapshot.kind !== "saved" || ref === undefined) return undefined;
		const origin = await hostOfSnapshot(snapshot);
		const byVersion = await diskHolders.holdersOf("snapshot", refId(ref));
		const of = (version: string) => (byVersion.get(version) ?? []).filter((holder) => holder.ref === ref);
		const disks = of("disk").filter((holder) => holder.state !== "deleting");
		const unreported = snapshot.sandboxType === "isolate" || (refHost(ref) !== undefined && disks.length === 0);
		let entries: { hostId: string; state: "held" | "fetching"; memory: boolean }[];
		if (unreported) {
			entries = origin === undefined ? [] : [{ hostId: origin, state: "held", memory: snapshot.memory }];
		} else {
			const withMemory = new Set(
				of("memory")
					.filter((holder) => holder.state === "held")
					.map((holder) => holder.hostId),
			);
			entries = disks
				.map((holder) => {
					const held = holder.state === "held";
					const memory = snapshot.memory && held && (holder.hostId === origin || withMemory.has(holder.hostId));
					return { hostId: holder.hostId, state: held ? ("held" as const) : ("fetching" as const), memory };
				})
				.sort((a, b) => Number(b.hostId === origin) - Number(a.hostId === origin));
		}
		const hosts = new Map((await store.hosts.list()).map((host) => [host.id, host]));
		return entries.flatMap(({ hostId, state, memory }) => {
			const host = hosts.get(hostId);
			if (host?.state === "revoked") return [];
			const named = host !== undefined && mayKnowHost(principal, host, snapshot.accountId);
			return [{ ...(named ? { hostId: host.id, hostName: host.name } : {}), state, memory }];
		});
	}

	/**
	 * Whether `principal` may be told that `host` exists, and which of an account's sandboxes run on it: a super-admin any
	 * host, anyone else only a host of the account the sandbox is in (account hosts).
	 */
	const mayKnowHost = (principal: Principal, host: StoredHost, accountId: string): boolean =>
		principal.superAdmin || (host.accountId !== undefined && host.accountId === accountId);

	/**
	 * The host `ref` (an ID or a name) names, for a sandbox of `accountId` to be pinned to (or, with `revoked`, for its
	 * sandboxes to be listed by): one of the account's own hosts, or for a super-admin a shared one. Another account's host, and for anyone else a shared host, is `not_found`,
	 * as `accountHostFor` answers, so a host's existence isn't given away.
	 */
	function pinnableHost(
		principal: Principal,
		accountId: string,
		hosts: readonly StoredHost[],
		ref: string,
		{ revoked = false }: { readonly revoked?: boolean } = {},
	): StoredHost {
		const known = hosts.filter(
			(host) =>
				(revoked || host.state !== "revoked") &&
				(host.accountId === undefined ? principal.superAdmin : host.accountId === accountId),
		);
		const byId = known.find((host) => host.id === ref);
		if (byId !== undefined) return byId;
		const named = known.filter((host) => host.name === ref);
		if (named.length > 1) throw new KantelError("invalid", `${named.length} hosts are named ${ref}: give its ID`);
		const [host] = named;
		if (host === undefined) throw notFound("host");
		return host;
	}

	// Views: what the API answers for a record.

	/**
	 * What an hour of it costs: by what its host gave it, else what it asked for, else its named size (an isolate made
	 * before shapes counts as the default 256 MB).
	 */
	const rateOf = (sandbox: StoredSandbox) => {
		const resources =
			sandbox.resources ??
			sandbox.shape ??
			(sandbox.type === "isolate"
				? { vcpus: 0, memoryMb: computeSchema.ISOLATE_MEMORY_MB.default }
				: (LEGACY_SIZES[sandbox.size ?? "default"] ?? LEGACY_SIZES.default));
		return hourlyRate(rates, sandbox.type, resources);
	};

	/**
	 * What a sandbox's runs over `[from, to)` cost: each at its own rate where it has one (an upgraded isolate's run before
	 * its upgrade, priced as the isolate it was), else at the sandbox's rate now.
	 */
	const costOf = (sandbox: StoredSandbox, from: number, to: number): number => {
		const rate = rateOf(sandbox);
		let cost = 0;
		for (const run of sandbox.runs) cost += (runningMs([run], from, to) / 3_600_000) * (run.ratePerHour ?? rate);
		return cost;
	};

	/**
	 * A sandbox's mean CPU over `[from, to)` (all it has kept, without): its kept means and the one under way, each
	 * weighted by the time it covers, so an hourly mean counts for its hour and one outside the span not at all.
	 */
	const meanCpu = (sandbox: StoredSandbox, from = 0, to = now()) => spanMean(withPartial(sandbox), from, to).cpu;

	/** Its idle stop, and while it runs with one, its last use and when the stop comes if nothing uses it first. */
	function idleView(sandbox: StoredSandbox): Pick<Sandbox, "idleStopMinutes" | "lastActiveAt" | "idleStopsAt"> {
		const minutes = sandbox.idleStopMinutes ?? null;
		if (minutes === null || sandbox.state !== "running") return { idleStopMinutes: minutes };
		const last = lastUse(sandbox);
		return last === undefined
			? { idleStopMinutes: minutes }
			: { idleStopMinutes: minutes, lastActiveAt: last, idleStopsAt: last + minutes * 60_000 };
	}

	/**
	 * The host a sandbox is on, as `principal` may be told it (`mayKnowHost`): its ID and name, or nothing. `hosts` keeps
	 * the host records read for one answer, so a page of sandboxes on a few hosts reads each once.
	 */
	async function hostOfView(
		sandbox: StoredSandbox,
		principal: Principal,
		hosts: Map<string, Promise<StoredHost | undefined>> = new Map(),
	): Promise<Pick<Sandbox, "hostId" | "hostName">> {
		const id = sandbox.hostId;
		if (id === undefined) return {};
		let read = hosts.get(id);
		if (read === undefined) {
			read = store.hosts.get(id);
			hosts.set(id, read);
		}
		const host = await read;
		// A super-admin is shown the ID of a host it has no record of, as before hosts were recorded.
		if (host === undefined) return principal.superAdmin ? { hostId: id } : {};
		return mayKnowHost(principal, host, sandbox.accountId) ? { hostId: id, hostName: host.name } : {};
	}

	/**
	 * Whether the host a sandbox is placed on is connected now (`Sandbox.hostReachable`), told to anyone who sees the
	 * sandbox, whether or not they may know which host it is; absent until it's placed. A host the backend has no word on
	 * (the stub's) is. `reach` keeps the answers for one response, so a page of sandboxes asks once per host.
	 */
	async function hostReachableOf(
		sandbox: StoredSandbox,
		reach: Map<string, Promise<boolean | undefined>> = new Map(),
	): Promise<Pick<Sandbox, "hostReachable">> {
		const id = sandbox.hostId;
		if (id === undefined) return {};
		if (backend.hostConnected === undefined) return { hostReachable: true };
		let read = reach.get(id);
		if (read === undefined) {
			// One that can't be read says nothing: it's left as reachable rather than failing the answer.
			read = backend.hostConnected(id).catch(() => undefined);
			reach.set(id, read);
		}
		return { hostReachable: (await read) ?? true };
	}

	/** Whether a call that needs the sandbox's machine can reach it: refused at once while its host isn't connected. */
	async function requireHostReachable(sandbox: StoredSandbox): Promise<void> {
		if ((await hostReachableOf(sandbox)).hostReachable === false) throw hostNotConnected();
	}

	/**
	 * `requireHostReachable` for what's on a snapshot's host (its files, a copy of its bytes): refused at once, without
	 * naming the host, rather than failing in the host call. A ref no host backend names (the stub's) always passes.
	 */
	async function requireSnapshotHostReachable(ref: string): Promise<void> {
		const hostId = refHost(ref);
		if (hostId === undefined || backend.hostConnected === undefined) return;
		if ((await backend.hostConnected(hostId).catch(() => undefined)) === false) throw hostNotConnected();
	}

	async function sandboxView(
		sandbox: StoredSandbox,
		principal: Principal,
		hosts?: Map<string, Promise<StoredHost | undefined>>,
		reach?: Map<string, Promise<boolean | undefined>>,
	): Promise<Sandbox> {
		const [host, reachable] = await Promise.all([
			hostOfView(sandbox, principal, hosts),
			hostReachableOf(sandbox, reach),
		]);
		const at = now();
		const seconds = runningMs(sandbox.runs, 0, at) / 1000;
		const rate = rateOf(sandbox);
		return {
			id: sandbox.id,
			accountId: sandbox.accountId,
			name: sandbox.name,
			subdomain: sandbox.subdomain,
			type: sandbox.type,
			size: sandbox.size,
			// What it asked for, so a sandbox of a shape no size names reads as that shape while it starts.
			shape: sandbox.shape === undefined ? undefined : { ...sandbox.shape },
			resources: sandbox.resources,
			image: sandbox.image,
			state: sandbox.state,
			health: sandbox.health,
			reason: sandbox.reason,
			placementReason: sandbox.placementReason,
			visibility: sandbox.visibility,
			capabilities: withLanguages(sandbox.type, sandbox.capabilities),
			labels: sandbox.labels,
			autoStopMinutes: sandbox.autoStopMinutes,
			stopsAt: sandbox.state === "running" ? sandbox.stopsAt : undefined,
			...idleView(sandbox),
			...(sandbox.autoUpgrade === true ? { autoUpgrade: true } : {}),
			...(sandbox.autoUpgradeFrom === undefined ? {} : { autoUpgradeFrom: sandbox.autoUpgradeFrom }),
			...(sandbox.upgradedFrom === undefined ? {} : { upgradedFrom: { ...sandbox.upgradedFrom } }),
			latestSnapshotId: sandbox.latestSnapshotId,
			latestSnapshotAt: sandbox.latestSnapshotId === undefined ? undefined : sandbox.latestSnapshotAt,
			source: sandbox.source,
			...environmentFields(environmentIdsOf(sandbox)),
			template: sandbox.template === undefined ? undefined : { ...sandbox.template },
			grants: (sandbox.grants ?? []).map(copyGrant),
			createdBy: sandbox.createdBy,
			createdAt: sandbox.createdAt,
			startedAt: sandbox.startedAt,
			stoppedAt: sandbox.stoppedAt,
			...(sandbox.mounts === undefined
				? {}
				: { mounts: sandbox.mounts.map((mount) => ({ ...mount, source: { ...mount.source } })) }),
			...(sandbox.stickyDisks === undefined ? {} : { stickyDisks: sandbox.stickyDisks.map((disk) => ({ ...disk })) }),
			cost: { currency: rates.currency, total: round(costOf(sandbox, 0, at)), ratePerHour: rate },
			usage: {
				runningSeconds: round(seconds),
				cpuSeconds: round(seconds * meanCpu(sandbox)),
				...sparklines(sandbox),
				...(sandbox.state === "running" ? guestMemoryView(sandbox.id) : {}),
				...peakView(peakOf(sandbox)),
			},
			...host,
			...pooled(sandbox.poolId),
			...reachable,
			base: baseView(sandbox.base),
			...(sandbox.startup === undefined ? {} : { startup: { ...sandbox.startup } }),
		};
	}

	/**
	 * How many of an account's sandboxes were made from each snapshot (`source.snapshotId`: a create from it, or a fork
	 * from it; `upgradedFrom.snapshotId`: an upgrade into it), deleted ones included, by the snapshot's ID: a snapshot's
	 * `uses`.
	 */
	async function usesIn(accountId: string): Promise<Map<string, number>> {
		const uses = new Map<string, number>();
		for (const sandbox of await store.sandboxes.list({ accountId })) {
			const from = sandbox.source?.snapshotId;
			if (from !== undefined) uses.set(from, (uses.get(from) ?? 0) + 1);
			// And what an upgrade started its microVM from.
			const into = sandbox.upgradedFrom?.snapshotId;
			if (into !== undefined) uses.set(into, (uses.get(into) ?? 0) + 1);
		}
		return uses;
	}

	/** A snapshot as the API answers it; `uses` from `usesIn`, 0 for one just made. */
	const snapshotView = (snapshot: StoredSnapshot, uses = 0): computeSchema.Snapshot => ({
		id: snapshot.id,
		accountId: snapshot.accountId,
		kind: snapshot.kind,
		name: snapshot.name,
		description: snapshot.description,
		...(snapshot.labels === undefined ? {} : { labels: snapshot.labels }),
		sandboxId: snapshot.sandboxId,
		sandboxType: snapshot.sandboxType,
		state: snapshot.state,
		trigger: snapshot.trigger,
		memory: snapshot.memory,
		...recordedMachine(snapshot),
		...(snapshot.minMemoryMb === undefined ? {} : { minMemoryMb: snapshot.minMemoryMb }),
		sizeBytes: snapshot.sizeBytes,
		uses,
		createdAt: snapshot.createdAt,
		// An automatic snapshot's state is from when it was taken; a saved one's only where it was kept, since one saved
		// before then may be a copy of an older snapshot.
		...(snapshot.takenAt !== undefined
			? { takenAt: snapshot.takenAt }
			: snapshot.kind === "automatic"
				? { takenAt: snapshot.createdAt }
				: {}),
		createdBy: snapshot.createdBy,
		expiresAt: snapshot.expiresAt,
		base: baseView(snapshot.base),
		...pooled(snapshot.poolId),
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
		...(command.needsMicrovm === undefined ? {} : { needsMicrovm: { ...command.needsMicrovm } }),
		...(command.terminated === undefined ? {} : { terminated: command.terminated }),
		...(command.rerunAs === undefined ? {} : { rerunAs: command.rerunAs }),
		...(command.rerunOf === undefined ? {} : { rerunOf: command.rerunOf }),
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

	/** A sandbox's environments as they are now, in order; one deleted meanwhile is left out. */
	async function environmentsOf(
		sandbox: Pick<StoredSandbox, "environmentIds" | "environmentId">,
	): Promise<StoredEnvironment[]> {
		const found = await Promise.all(environmentIdsOf(sandbox).map((id) => store.environments.get(id)));
		return found.filter((environment): environment is StoredEnvironment => environment !== undefined);
	}

	/** What `environments` give a sandbox, in order (`resolveEnvironments`). */
	const resolved = (environments: readonly StoredEnvironment[]): EnvironmentResolution =>
		resolveEnvironments(environments, clonePath);

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
		const [proxy, environments] = await Promise.all([
			store.proxies.get(accountId),
			subject === undefined ? [] : environmentsOf(subject),
		]);
		const resolution = resolved(environments);
		const bound = subject === undefined ? [] : protectedWinners(subject, resolution).map(({ winner }) => winner.item);
		const grants = [...resolution.grants, ...(subject?.grants ?? [])];
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
				...(bound.length === 0
					? {}
					: {
							protected: {
								version: secretsVersionOf(environments, subject?.secretsFloor) ?? now(),
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
	 * and its retries know the host. `publishing` is what else changes with the intent: a boot's (an upgrade's microVM,
	 * its type, which its stop and snapshot are then), or an undone upgrade's (the isolate's runs and stop times as they
	 * were, `restoreUpgrade`). `wait` awaits the stop (never from inside the sandbox's own queued work,
	 * which the stop queues behind).
	 */
	async function enforceStop(
		sandboxId: string,
		reason: string,
		wait: boolean,
		evaluated: Pick<StoredSandbox, "state" | "egressRevision">,
		placement?: Placement,
		publishing?: (sandbox: StoredSandbox) => Partial<StoredSandbox>,
	): Promise<boolean> {
		const at = now();
		const due = await patchSandbox(sandboxId, (current) =>
			current.state === evaluated.state &&
			current.egressRevision === evaluated.egressRevision &&
			// Its host revoked under its boot (`strandOn`): its boot ends it `error`, not a stop its host can't take.
			(placement === undefined || !(current.strandedOn ?? []).includes(placement.hostId))
				? {
						...current,
						...publishing?.(current),
						...(placement === undefined
							? {}
							: {
									hostId: placement.hostId,
									resources: placement.resources ?? current.resources,
									capabilities: placement.capabilities,
									...placedBase(placement),
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

	/** The sandboxes that have an environment, but deleted ones. Environments and their sandboxes share an account. */
	const sandboxesWith = async (environment: Pick<StoredEnvironment, "id" | "accountId">) =>
		(await store.sandboxes.list({ accountId: environment.accountId })).filter(
			(sandbox) => sandbox.state !== "deleted" && environmentIdsOf(sandbox).includes(environment.id),
		);

	/** The sandboxes with an environment that run, or are starting (and will reconcile when they run). */
	const liveFrom = async (environment: Pick<StoredEnvironment, "id" | "accountId">) =>
		(await sandboxesWith(environment)).filter((sandbox) => sandbox.state === "running" || sandbox.state === "starting");

	/**
	 * Whether a variable of this name in an environment decides which protected value a running sandbox's placeholder
	 * stands for: one with other environments has a placeholder of the name, so the variable shadows (or shadowed) one.
	 */
	const shadowsProtected = async (environment: Pick<StoredEnvironment, "id" | "accountId">, name: string) =>
		(await liveFrom(environment)).some(
			(sandbox) => environmentIdsOf(sandbox).length > 1 && Object.hasOwn(sandbox.placeholders ?? {}, name),
		);

	/**
	 * A sandbox's next protected-values version: past every version it may have been given, which is at most the newest
	 * of its environments' and its floor, and past now.
	 */
	const nextFloorOf = async (sandbox: StoredSandbox): Promise<number> =>
		nextSecretsVersion(secretsVersionOf(await environmentsOf(sandbox), sandbox.secretsFloor) ?? 0, now());

	/**
	 * Tells the hosts of an environment's running sandboxes that its protected values changed, so they drop what they
	 * hold and fetch them again, and gives them its egress as it is now (the hosts to intercept, the grants). A starting
	 * one's revision moves on too, so its boot sees the change and reconciles.
	 */
	async function pushEnvironment(
		environment: Pick<StoredEnvironment, "id" | "accountId">,
		version: number | undefined,
	): Promise<void> {
		const live = await liveFrom(environment);
		const bumped = (
			await Promise.all(
				live.map(async (sandbox) => {
					if (version === undefined) return bumpEgress(sandbox.id);
					// Its protected values changed: its own version moves past any it was given, from all its environments
					// (this one as it is now), so one of several whose version is behind another's still counts as a change.
					const floor = await nextFloorOf(sandbox);
					return patchSandbox(sandbox.id, (current) => ({
						...current,
						secretsFloor: Math.max(floor, current.secretsFloor ?? 0),
						egressRevision: later(current.egressRevision),
					}));
				}),
			)
		).filter((sandbox): sandbox is StoredSandbox => sandbox !== undefined);
		const running = bumped.filter((sandbox) => sandbox.state === "running");
		const updateSecrets = backend.updateSecrets?.bind(backend);
		if (version !== undefined && updateSecrets !== undefined) {
			for (const sandbox of running) {
				if (sandbox.secretsFloor !== undefined) keepGoing(updateSecrets(sandbox.id, sandbox.secretsFloor));
			}
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
		const made = await sandboxesWith(environment);
		return {
			id: environment.id,
			accountId: environment.accountId,
			name: environment.name,
			...(environment.description === undefined ? {} : { description: environment.description }),
			variables: environment.variables.map(variableView),
			files: environment.files.map(fileView),
			repos: environment.repos.map(copyRepo),
			grants: environment.grants.map(copyGrant),
			sandboxCount: made.length,
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
		const [environments, log] = await Promise.all([environmentsOf(sandbox), egressLog(sandbox.id)]);
		const resolution = resolved(environments);
		// One whose variable is gone, plain now or shadowed no longer resolves: it isn't protected any more.
		const protectedVariables: computeSchema.SandboxProtectedVariable[] = protectedWinners(sandbox, resolution).map(
			({ name, placeholder, winner }) => ({
				name,
				placeholderPrefix: placeholder.slice(0, PLACEHOLDER_PREFIX_CHARS),
				bindings: winner.item.bindings.map(copyBinding),
				environmentId: winner.environment.id,
			}),
		);
		const [first] = environments;
		return {
			sandboxId: sandbox.id,
			sandboxName: sandbox.name,
			accountId: sandbox.accountId,
			...(first === undefined ? {} : { environment: { id: first.id, name: first.name } }),
			environments: environments.map((environment) => ({ id: environment.id, name: environment.name })),
			protectedVariables,
			environmentGrants: resolution.grants.map(copyGrant),
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

	/** The environments a create names, `environment` or `environments`, in order; each once. */
	async function environmentsNamed(
		accountId: string,
		one: string | undefined,
		many: readonly string[] | undefined,
	): Promise<StoredEnvironment[]> {
		if (one !== undefined && many !== undefined) {
			throw new KantelError("invalid", "Give environment or environments, not both");
		}
		const refs = many ?? (one === undefined ? [] : [one]);
		if (refs.length > MAX_SANDBOX_ENVIRONMENTS) {
			throw new KantelError("invalid", `A sandbox has at most ${MAX_SANDBOX_ENVIRONMENTS} environments`);
		}
		const environments = await Promise.all(refs.map((ref) => environmentIn(accountId, ref)));
		const seen = new Set<string>();
		for (const environment of environments) {
			if (seen.has(environment.id))
				throw new KantelError("invalid", `The environment ${environment.name} is named twice`);
			seen.add(environment.id);
		}
		return environments;
	}

	/** Refuses a sandbox's own variable that would hide a protected variable of its environments. */
	function refuseProtectedClashes(
		own: { readonly [name: string]: string },
		resolution: EnvironmentResolution,
		count: number,
	): void {
		const [name] = protectedClashes(own, resolution);
		if (name === undefined) return;
		const of =
			count > 1 ? `of the environment ${resolution.variables.get(name)?.environment.name}` : "of the environment";
		throw new KantelError("invalid", `${name} is a protected variable ${of}; leave it out of env`);
	}

	/** A sandbox's environments, in order, with what each gives it and whether its files and repositories are to come. */
	async function sandboxEnvironmentsView(sandbox: StoredSandbox): Promise<computeSchema.SandboxEnvironments> {
		const environments = await environmentsOf(sandbox);
		const resolution = resolved(environments);
		const { own } = envLayersOf(sandbox);
		// Pending: its own files or repositories, or a path a move gave it whose file isn't written yet.
		const pending = new Set(
			(sandbox.pendingProvision ?? []).flatMap((work) =>
				work.kind === "paths"
					? (work.paths ?? []).map((path) => resolution.files.get(path)?.environment.id)
					: [work.environmentId],
			),
		);
		return {
			sandboxId: sandbox.id,
			environments: environments.map((environment) => ({
				id: environment.id,
				name: environment.name,
				shadowed: shadowedOf(environment, resolution, own, clonePath),
				pending: pending.has(environment.id),
			})),
		};
	}

	/**
	 * Gives a sandbox the environments `change` makes of its own, then works its env out again from them as they are now
	 * (its own variables over them), and moves its egress and its protected values' version on. A running sandbox takes
	 * the change at once: its egress and protected values, its env (for new shells, where its host can), and an attached
	 * environment's secret files and repositories, set up in the background. A stopped one gets those when it next runs.
	 */
	async function changeSandboxEnvironments(
		sandbox: StoredSandbox,
		change: (ids: string[]) => string[],
		how: { attached: StoredEnvironment } | { detached: string },
	): Promise<computeSchema.SandboxEnvironments> {
		const before = environmentIdsOf(sandbox);
		const ids = change([...before]);
		if (ids.length > MAX_SANDBOX_ENVIRONMENTS) {
			throw new KantelError("invalid", `A sandbox has at most ${MAX_SANDBOX_ENVIRONMENTS} environments`);
		}
		const settled = ["running", "stopped", "paused", "error"];
		if (!settled.includes(sandbox.state)) throw new KantelError("conflict", `The sandbox is ${sandbox.state}`);
		const read = await Promise.all(ids.map((id) => store.environments.get(id)));
		const environments = read.filter((environment): environment is StoredEnvironment => environment !== undefined);
		// The version its host was last given: the new floor goes past it, so no fetch answers below what it holds.
		const had = await environmentsOf(sandbox);
		const given = secretsVersionOf(had, sandbox.secretsFloor) ?? 0;
		const resolution = resolved(environments);
		const attached = "attached" in how ? how.attached : undefined;
		const moved = attached !== undefined && before.includes(attached.id);
		// The set-up it needs, recorded with the change: a newly attached environment's files and repositories, and the
		// paths whose winning file another environment now has (a move). A detach needs none: what it wrote stays.
		const newly = attached !== undefined && !moved ? workFor(attached) : [];
		const repaths = changedWinners(resolved(had), resolution).filter(
			(path) => moved || resolution.files.get(path)?.environment.id !== attached?.id,
		);
		const work: ProvisionWork[] = [
			...newly,
			...(attached !== undefined && repaths.length > 0
				? [{ id: randomId("pw", 8), kind: "paths" as const, paths: repaths }]
				: []),
		];
		if (attached !== undefined) {
			refuseProtectedClashes(envLayersOf(sandbox).own, resolution, environments.length);
			const enforced = attached.grants.length > 0 || attached.variables.some((variable) => variable.protected);
			if (enforced) await requireEnforcing([sandbox]);
		}
		let changed = await patchSandbox(sandbox.id, (current) => {
			if (!sameIds(environmentIdsOf(current), before)) {
				throw new KantelError("conflict", "The sandbox's environments changed meanwhile; try again");
			}
			if (!settled.includes(current.state)) throw new KantelError("conflict", `The sandbox is ${current.state}`);
			const envLayers = envLayersOf(current);
			const { env, placeholders } = composeEnv(envLayers, resolution, current.placeholders ?? {}, newPlaceholder);
			// Pending until a set-up has done it, running or not: if a stop gets there first, its next start does it.
			const kept =
				"detached" in how ? pendingWithout(current, how.detached).pendingProvision : current.pendingProvision;
			const pending = [...(kept ?? []), ...work];
			return {
				...current,
				...environmentFields(environments.map((environment) => environment.id)),
				pendingProvision: pending.length === 0 ? undefined : pending,
				env,
				envLayers,
				placeholders,
				// Past any version its host was given: it drops what it held, and fetches them again as they are now.
				secretsFloor: nextSecretsVersion(Math.max(given, current.secretsFloor ?? 0), now()),
				egressRevision: later(current.egressRevision),
			};
		});
		if (changed === undefined) throw notFound("sandbox");
		// Deleted while it was being attached, after the delete looked for its sandboxes: taken off again here, as the
		// delete would have, with the floor moved past what it may have given.
		let gone = false;
		if (attached !== undefined && (await store.environments.get(attached.id)) === undefined) {
			gone = true;
			const floor = nextSecretsVersion(Math.max(given, attached.secretsVersion, changed.secretsFloor ?? 0), now());
			changed = await patchSandbox(sandbox.id, (current) => ({
				...current,
				...environmentFields(environmentIdsOf(current).filter((id) => id !== attached.id)),
				...pendingWithout(current, attached.id),
				secretsFloor: Math.max(floor, current.secretsFloor ?? 0),
				egressRevision: later(current.egressRevision),
			}));
			if (changed === undefined) throw notFound("sandbox");
		}
		const done = changed;
		await emit("sandbox.environments_changed", done.accountId, {
			sandbox: done,
			data: {
				...("attached" in how ? { attached: how.attached.id } : { detached: how.detached }),
				environmentIds: [...environmentIdsOf(done)],
			},
		}).catch(() => undefined);
		if (done.state === "running") {
			pushEgress([done]);
			const updateSecrets = backend.updateSecrets?.bind(backend);
			if (updateSecrets !== undefined && done.secretsFloor !== undefined) {
				keepGoing(updateSecrets(done.id, done.secretsFloor));
			}
			keepGoing(deliverEnv(done));
			if (!gone && work.length > 0) {
				// Its repositories as this call read them, which the caller (who may run commands) authorised.
				keepGoing(track([done.id], () => provision(done.id, attached === undefined ? [] : [attached])));
			}
		}
		return sandboxEnvironmentsView(done);
	}

	/**
	 * Tells a running sandbox's host its env changed (`updateEnv`). The host applies the env Kantel has when it takes
	 * the notification (`sandboxEnv`, over its link), not the one sent, so however late one lands it never puts an older
	 * env back. A failure is an event; its next boot has the env anyway.
	 */
	async function deliverEnv(sandbox: StoredSandbox): Promise<void> {
		const updateEnv = backend.updateEnv?.bind(backend);
		if (updateEnv === undefined) return;
		try {
			await updateEnv(sandbox.id, sandbox.env);
		} catch (error) {
			await emit("sandbox.degraded", sandbox.accountId, {
				sandbox,
				data: {
					reason: `New commands have its environments' variables, but its env file (/etc/kantel/env) won't until it restarts: ${messageOf(error)}`,
				},
			}).catch(() => undefined);
		}
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
	 * Does a running sandbox's pending environment set-up (`pendingProvision`): writes the secret files each item names
	 * (an environment's, at the paths it wins; or whatever wins the paths a move changed), and clones an environment's
	 * repositories through the sandbox's egress proxy (so a protected token bound to a repository's host is swapped in).
	 * A failure is an event on the sandbox, which keeps running: what failed is named, never a file's contents.
	 *
	 * Each item comes off by its ID once done, never before, so a set-up that stops leaves the rest for the next start,
	 * and never one another change added. Each set-up takes a fence past every earlier one's (in the store), which its
	 * writes carry: the host drops one below a fence it has taken, so an older set-up's write, however late it lands,
	 * never overwrites a newer one's. Every change that moves a file's winner records the item that writes it, so the
	 * newest set-up writes the newest winner.
	 *
	 * `authorised` is the environments whose repositories the call that started it may have cloned (its caller may run
	 * commands, and a clone runs with the sandbox's env), as it read them: not any added since. A repositories item of
	 * another environment waits for a set-up that may.
	 */
	async function provision(sandboxId: string, authorised: readonly StoredEnvironment[]): Promise<void> {
		const fenced = await patchSandbox(sandboxId, (latest) =>
			latest.state === "running" && (latest.pendingProvision?.length ?? 0) > 0
				? { ...latest, provisionFence: (latest.provisionFence ?? 0) + 1 }
				: undefined,
		);
		if (fenced === undefined) return;
		const fence = fenced.provisionFence ?? 1;
		const work = fenced.pendingProvision ?? [];
		const asAuthorised = new Map(authorised.map((environment) => [environment.id, environment]));
		const environments = await environmentsOf(fenced);
		const resolution = resolved(
			environments.map((latest) => {
				const read = asAuthorised.get(latest.id);
				return read === undefined ? latest : { ...latest, repos: read.repos };
			}),
		);
		const degraded = (reason: string) =>
			emit("sandbox.degraded", fenced.accountId, { sandbox: fenced, data: { reason } }).catch(() => undefined);
		const label = (environment: StoredEnvironment) =>
			environments.length > 1 ? `The environment ${environment.name}'s` : "The environment's";
		const credentials = { variables: protectedWinners(fenced, resolution).map(({ winner }) => winner.item) };
		/** Writes a file; false when its outcome is unknown (it failed in flight), so its item stays pending. */
		const write = async ({
			environment,
			item: file,
		}: {
			environment: StoredEnvironment;
			item: StoredEnvironmentFile;
		}) => {
			let bytes: Uint8Array;
			try {
				bytes = await requireSealer().open(file.sealed, fileAad(environment.id, file.path));
			} catch (error) {
				await degraded(`${label(environment)} secret file ${file.path} wasn't written: ${messageOf(error)}`);
				return true;
			}
			try {
				// Fenced (dropped by its host): a newer set-up's write of this path landed, whose winner is newer than this
				// one's, so this item's part there is done.
				await backend.writeFile(sandboxId, file.path, bytes, file.mode, { fence });
				return true;
			} catch (error) {
				await degraded(`${label(environment)} secret file ${file.path} wasn't written: ${messageOf(error)}`);
				return false;
			}
		};
		/** Clones a repository; false when its outcome is unknown, so its item stays pending. */
		const clone = async ({
			environment,
			item: repo,
		}: {
			environment: StoredEnvironment;
			item: computeSchema.EnvironmentRepo;
		}) => {
			const path = clonePath(repo);
			// Git reads no token from the environment: a credential helper answers with the placeholder of the protected
			// variable bound to the repository, which the host's proxy swaps for the token inside Basic auth.
			const credential = repoCredential(credentials, repo, fenced.placeholders ?? {});
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
				const result = await backend.exec(sandboxId, {
					command,
					// No terminal to ask on: a repository that wants a login fails at once, saying so.
					env: { ...fenced.env, GIT_TERMINAL_PROMPT: "0" },
					timeoutMs: CLONE_TIMEOUT_MS,
				});
				if (result.exitCode !== 0 || result.timedOut) {
					const why = result.timedOut
						? "it took too long"
						: clip(result.stderr.trim(), 500) || `exit ${result.exitCode}`;
					await degraded(`${label(environment)} repository ${repo.url} wasn't cloned into ${path}: ${why}`);
				}
				return true;
			} catch (error) {
				await degraded(`${label(environment)} repository ${repo.url} wasn't cloned into ${path}: ${messageOf(error)}`);
				return false;
			}
		};
		const done: string[] = [];
		for (const item of work) {
			let finished = true;
			if (item.kind === "repos") {
				// Only for a set-up a caller who may run commands started; otherwise it waits for one.
				if (item.environmentId === undefined || !asAuthorised.has(item.environmentId)) continue;
				for (const winner of resolution.repos.values()) {
					if (winner.environment.id === item.environmentId && !(await clone(winner))) finished = false;
				}
			} else {
				const targets =
					item.kind === "files"
						? [...resolution.files.values()].filter((winner) => winner.environment.id === item.environmentId)
						: (item.paths ?? []).flatMap((path) => {
								const winner = resolution.files.get(path);
								return winner === undefined ? [] : [winner];
							});
				for (const target of targets) if (!(await write(target))) finished = false;
			}
			if (finished) done.push(item.id);
		}
		if (done.length === 0) return;
		await patchSandbox(sandboxId, (latest) => {
			const pending = (latest.pendingProvision ?? []).filter((item) => !done.includes(item.id));
			return { ...latest, pendingProvision: pending.length === 0 ? undefined : pending };
		});
	}

	/**
	 * Takes environments deleted since a create or fork read them off the sandbox it has just stored: the delete looked
	 * for its sandboxes before this one was there. Nothing was given its host yet, so only the record changes.
	 */
	async function dropDeleted(sandbox: StoredSandbox): Promise<void> {
		const ids = environmentIdsOf(sandbox);
		if (ids.length === 0) return;
		const found = await Promise.all(ids.map((id) => store.environments.get(id)));
		const missing = new Set(ids.filter((_, index) => found[index] === undefined));
		if (missing.size === 0) return;
		await patchSandbox(sandbox.id, (current) => {
			let pending: Pick<StoredSandbox, "pendingProvision"> = current;
			for (const id of missing) pending = pendingWithout(pending, id);
			return {
				...current,
				...environmentFields(environmentIdsOf(current).filter((id) => !missing.has(id))),
				pendingProvision: pending.pendingProvision,
			};
		});
	}

	/**
	 * Emails an invite with a link that joins with its code, when the deployment sends mail; whether it went. A send that
	 * fails leaves the invite standing: the console shows the code to pass on instead.
	 */
	const mailInvite = async (
		principal: Principal,
		invite: StoredInvite,
		to: string,
		code: string,
		request: Request,
	): Promise<boolean> => {
		const mailing = options.invites;
		if (mailing === undefined) return false;
		try {
			if (mailing.canSignIn !== undefined && !(await mailing.canSignIn(to))) return false;
			const [account, inviter] = await Promise.all([
				store.accounts.get(invite.accountId),
				principal.kind === "person" ? principal : store.users.get(principal.userId),
			]);
			const consoleUrl = mailing.consoleUrl ?? new URL(request.url).origin;
			await mailing.send({
				to,
				organisation: account?.name ?? "an organisation",
				// Never a user ID, which a record made before people were named by their names may still have.
				invitedBy: inviter?.email || (isPlaceholderName(inviter?.name) ? undefined : inviter?.name) || "Someone",
				link: inviteLink(consoleUrl, code),
				expiresAt: invite.expiresAt,
			});
			return true;
		} catch (error) {
			mailing.onMailError?.(error, to);
			return false;
		}
	};

	const inviteView = (invite: StoredInvite, code?: string): computeSchema.Invite => ({
		id: invite.id,
		accountId: invite.accountId,
		role: invite.role,
		email: invite.email,
		code,
		expiresAt: invite.expiresAt,
		createdAt: invite.createdAt,
	});

	/**
	 * A personal account named for its person (`name`) when it was made with their user ID for a name, as gateways named
	 * people once; any other account as it is.
	 */
	const personalNamed = (account: StoredAccount, name: string | undefined): StoredAccount =>
		account.kind === "personal" && name !== undefined && isPlaceholderName(account.name)
			? { ...account, name }
			: account;

	const accountView = (account: StoredAccount, role: MemberRole): computeSchema.Account => ({
		id: account.id,
		kind: account.kind,
		name: account.name,
		role,
		defaultVisibility: account.defaultVisibility,
		personalTokens: account.personalTokens ?? "allowed",
		snapshotCopies: account.snapshotCopies !== false,
		createdAt: account.createdAt,
	});

	const personalTokenView = (token: StoredPersonalToken): computeSchema.PersonalToken => ({
		id: token.id,
		name: token.name,
		prefix: token.prefix,
		...(token.scopes === undefined ? {} : { scopes: [...token.scopes] }),
		...(token.accounts === undefined ? {} : { accounts: [...token.accounts] }),
		createdAt: token.createdAt,
		expiresAt: token.expiresAt,
		lastUsedAt: token.lastUsedAt,
		revokedAt: token.revokedAt,
	});

	/**
	 * A personal access token for `person`, as `createPersonalToken` and a personal device sign-in make one: its scopes
	 * and accounts held to the token `person` signed in with, if any, and every account named checked as one they may act
	 * in now. Not stored: the caller stores it, once the rest of what it does is done.
	 */
	async function newPersonalToken(
		person: PersonPrincipal,
		input: {
			readonly name: string;
			readonly scopes?: readonly computeSchema.ApiKeyScope[];
			readonly accounts?: readonly string[];
			readonly expiresInDays?: number;
		},
	): Promise<{ token: StoredPersonalToken; secret: string }> {
		const days = input.expiresInDays ?? computeSchema.PERSONAL_TOKEN_DEFAULT_DAYS;
		if (days > computeSchema.PERSONAL_TOKEN_MAX_DAYS) {
			throw new KantelError(
				"invalid",
				`A personal access token lasts at most ${computeSchema.PERSONAL_TOKEN_MAX_DAYS} days`,
			);
		}
		const scopes = input.scopes === undefined ? undefined : unique([...input.scopes]);
		if (scopes?.includes("hosts:admin")) {
			throw new KantelError("invalid", "A personal access token can't hold hosts:admin: use a super-admin's API key");
		}
		const limits = person.token;
		const accounts =
			input.accounts === undefined
				? limits?.accounts === undefined
					? undefined
					: [...limits.accounts]
				: unique([...input.accounts]);
		if (limits !== undefined) {
			if (limits.scopes !== undefined) {
				if (scopes === undefined)
					throw new KantelError("forbidden", "A token with scopes can only make tokens with scopes");
				requireGrantable(person, scopes);
			}
			if (limits.accounts !== undefined && accounts?.some((id) => !limits.accounts?.includes(id))) {
				throw new KantelError("forbidden", "A token can only make tokens for the accounts it has");
			}
		}
		for (const accountId of accounts ?? []) {
			if ((await roleIn(store, person, accountId)) === undefined) {
				throw new KantelError("forbidden", `You can't act in ${accountId}`);
			}
		}
		const expiresAt = Math.min(now() + days * DAY_MS, limits?.expiresAt ?? Number.POSITIVE_INFINITY);
		const { secret, prefix, hash } = await newPersonalTokenSecret();
		return {
			token: {
				id: randomId("pat"),
				name: input.name,
				prefix,
				...(scopes === undefined ? {} : { scopes }),
				...(accounts === undefined ? {} : { accounts }),
				createdAt: now(),
				expiresAt,
				secretHash: hash,
				userId: person.userId,
			},
			secret,
		};
	}

	/** A host's memory, as it last reported it, when it is connected. */
	function hostMemoryOf(hostId: string): { memory?: computeSchema.HostMemory } {
		const memory = hostMemory.get(hostId);
		return memory === undefined ? {} : { memory: { ...memory } };
	}

	/** How a host reaches its mesh peers, as it last reported it, when it is connected and has a mesh. */
	function hostMeshOf(hostId: string): { mesh?: computeSchema.HostMesh } {
		const mesh = hostMesh.get(hostId);
		return mesh === undefined
			? {}
			: { mesh: { address: mesh.address, peers: mesh.peers.map((peer) => ({ ...peer })) } };
	}

	async function hostView(host: StoredHost): Promise<computeSchema.Host> {
		await catchUpUsage();
		// Isolates share their owner's VM, so what one asked for isn't a share of the host: they count as sandboxes only.
		const placed = (await store.sandboxes.list({ hostId: host.id })).filter(
			(sandbox) => sandbox.state === "running" || sandbox.state === "starting" || sandbox.state === "paused",
		);
		const machines = placed.filter((sandbox) => sandbox.type !== "isolate");
		const sum = (pickOf: (sandbox: StoredSandbox) => number) =>
			machines.reduce((total, sandbox) => total + pickOf(sandbox), 0);
		// An update that hasn't happened in its window isn't under way, whether or not the record was refreshed since.
		const { updating, diskUsage, drainEpoch: _drain, poolSince: _since, ...rest } = host;
		const pending = updating !== undefined && now() - updating.requestedAt < HOST_UPDATE_WINDOW_MS;
		return {
			...rest,
			...(diskUsage === undefined ? {} : { diskUsage: await diskView(host.id, diskUsage) }),
			...(pending ? { updating } : {}),
			usage: hostSparklines(host.id),
			...hostMemoryOf(host.id),
			// A revoked or dropped host's last report says nothing about now (a revoke answers before the next read).
			...(host.state === "revoked" || host.state === "unreachable" ? {} : hostMeshOf(host.id)),
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
			: { kind: "user", id: principal.userId, name: personName(principal) };

	/** What a person is called now, by user ID: undefined for someone the store doesn't know. */
	async function nameOfUser(userId: string): Promise<string | undefined> {
		const user = await store.users.get(userId);
		return user === undefined ? undefined : personName({ userId: user.id, name: user.name, email: user.email });
	}

	/**
	 * `items` with each person who made one named as they are now when their record names them by a user ID: gateways
	 * named everyone that way once, and what they made then still says so. Each person is looked up once.
	 */
	async function withMakersNamed<T extends { readonly createdBy: Sandbox["createdBy"] }>(
		items: readonly T[],
	): Promise<T[]> {
		const names = new Map<string, Promise<string | undefined>>();
		return Promise.all(
			items.map(async (item) => {
				const maker = item.createdBy;
				if (maker.kind !== "user" || !isPlaceholderName(maker.name, maker.id)) return item;
				let name = names.get(maker.id);
				if (name === undefined) {
					name = nameOfUser(maker.id);
					names.set(maker.id, name);
				}
				const named = await name;
				return named === undefined || named === maker.name ? item : { ...item, createdBy: { ...maker, name: named } };
			}),
		);
	}

	const withMakerNamed = async <T extends { readonly createdBy: Sandbox["createdBy"] }>(item: T): Promise<T> =>
		(await withMakersNamed([item]))[0] ?? item;

	/**
	 * Sandboxes with when their latest snapshot was taken, for those whose record has the snapshot but not when (kept
	 * before records had it): from the snapshot's own record, if it is still there.
	 */
	async function withSnapshotTimes(items: readonly Sandbox[]): Promise<Sandbox[]> {
		return Promise.all(
			items.map(async (item) => {
				if (item.latestSnapshotId === undefined || item.latestSnapshotAt !== undefined) return item;
				const snapshot = await store.snapshots.get(item.latestSnapshotId);
				return snapshot === undefined ? item : { ...item, latestSnapshotAt: snapshot.createdAt };
			}),
		);
	}

	// Events.

	async function emit(
		type: EventType,
		accountId: string,
		fields: { sandbox?: StoredSandbox; snapshotId?: string; data?: EventData },
		/** Its ID, for an event that may be stored again (written over, not added twice); default a new one. */
		eventId: string = randomId("evt"),
	): Promise<void> {
		const { sandbox } = fields;
		const event: computeSchema.Event = {
			id: eventId,
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

	/** Whether `principal` may make calls that need `scope` where they have `role` (`requireScope`), without refusing. */
	const mayUse = (principal: Principal, scope: computeSchema.ApiKeyScope, role: MemberRole): boolean => {
		try {
			requireScope(principal, scope, role);
			return true;
		} catch {
			return false;
		}
	};

	/** Changes a sandbox's fields other than its state with `update`, so it never writes over a newer state. */
	const patchSandbox = (sandboxId: string, change: (current: StoredSandbox) => StoredSandbox | undefined) =>
		store.sandboxes.update(sandboxId, change);

	/**
	 * Exposes a fork's source's ports (`ports`, as the source had them when it was forked) on the fork once it runs, each
	 * as it was there: the same port, public or behind a token. Each gets its own URL under the fork's subdomain, exposed
	 * as `grantee` (whoever forked it), so it ends when their access does, as a port they exposed would. A gated port's
	 * token is shown to no one, as nobody asked for it: exposing the port again gives a new one, as it always does. A port
	 * that can't be exposed is left off (the fork runs all the same).
	 *
	 * A port exposed on the fork by hand meanwhile wins, whichever lands first: each copy is made only where the port
	 * isn't exposed at all (`ifAbsent`, one step in the relay's store, shared by every replica), so it never replaces an
	 * exposure (its access, token and grantee), and its record is added only where the fork's record has none for it.
	 */
	async function copyPorts(
		fork: StoredSandbox,
		ports: readonly computeSchema.ExposedPort[],
		grantee: string,
	): Promise<void> {
		if (!fork.capabilities.ports) return;
		for (const port of ports) {
			const latest = await store.sandboxes.get(fork.id);
			if (latest?.state !== "running") return;
			if (latest.ports.some((entry) => entry.port === port.port)) continue;
			let url: string;
			try {
				({ url } = await backend.exposePort(fork.id, port.port, {
					public: port.public,
					subdomain: fork.subdomain,
					grantee,
					ifAbsent: true,
				}));
			} catch {
				// Exposed by hand meanwhile (`conflict`), or it couldn't be: left as it is.
				continue;
			}
			const exposed: computeSchema.ExposedPort = {
				port: port.port,
				url: withoutPortToken(url),
				public: port.public,
				createdAt: now(),
			};
			await patchSandbox(fork.id, (latest) =>
				// Stopped or gone meanwhile (its ports went with it), or the port exposed on it by hand already: as it is.
				latest.state !== "running" || latest.ports.some((entry) => entry.port === port.port)
					? undefined
					: { ...latest, ports: [...latest.ports, exposed] },
			);
		}
	}

	/** The sandbox in a new state, with its run periods, stop time and timestamps kept in step. */
	function withState(sandbox: StoredSandbox, state: SandboxState, extra: Partial<StoredSandbox> = {}): StoredSandbox {
		const at = now();
		const wasRunning = sandbox.state === "running";
		const running = state === "running";
		let runs = sandbox.runs;
		if (wasRunning && !running) runs = runs.map((run) => (run.to === undefined ? { ...run, to: at } : run));
		if (!wasRunning && running) runs = [...runs, { from: at }];
		const autoStop = extra.autoStopMinutes === undefined ? sandbox.autoStopMinutes : extra.autoStopMinutes;
		// Its agent's health is its running machine's: a boot, or a stop once done, leaves none unresponsive
		// (`reportHealth`). A stop under way keeps it and its reason, for one handed back running with the same machine.
		const stillUnresponsive =
			sandbox.health === "unresponsive" && extra.health === undefined && (state === "stopping" || state === "running");
		return {
			...sandbox,
			...extra,
			state,
			runs,
			// Its idle time counts from each start: what it was used for before it stopped doesn't carry over.
			lastActiveAt: running && !wasRunning ? at : sandbox.lastActiveAt,
			stopsAt: !running
				? undefined
				: wasRunning
					? sandbox.stopsAt
					: autoStop === null
						? undefined
						: at + autoStop * 60_000,
			startedAt: running && !wasRunning ? at : sandbox.startedAt,
			stoppedAt: state === "stopped" || state === "paused" ? at : sandbox.stoppedAt,
			lifecycle: (sandbox.lifecycle ?? 0) + 1,
			reason: extra.reason ?? (stillUnresponsive ? sandbox.reason : undefined),
			placementReason: extra.placementReason,
			// Stranded only in the state its stranding wrote (`strandOn`).
			strandedOn: extra.strandedOn,
			...(sandbox.health === "unresponsive" && extra.health === undefined && !stillUnresponsive
				? { health: "ok" as const }
				: {}),
			// A stop it was due for is done with once it boots again.
			...(state === "starting" ? { stopFor: undefined } : {}),
		};
	}

	/**
	 * A watcher as they are now: a key's current scopes and limits, or a person whose sign-in is still live; undefined once
	 * the key is revoked or expired, the sign-in has ended, or the person has deleted their account (their deletion is
	 * recorded, or their user record retired), whatever memberships of theirs remain.
	 */
	/**
	 * Who was given access (`encodeGrantee`'s text), as they are now: undefined once the key or personal token is revoked
	 * or expired, the sign-in has ended, or the person is gone or being deleted. Their rights are checked by the caller.
	 */
	async function granteePrincipal(text: string): Promise<Principal | undefined> {
		const grantee = decodeGrantee(text);
		if (grantee === undefined) return undefined;
		if (grantee.kind === "key") return liveKeyPrincipal(store, grantee.keyId, now());
		if (grantee.kind === "token") {
			// Given with a personal token: it lasts as long as the token, within the token's limits.
			const token = await liveTokenPrincipal(store, grantee.tokenId, now());
			return token === undefined || token.userId !== grantee.userId ? undefined : token;
		}
		const user = await store.users.get(grantee.userId);
		// Gone, or being (or having been) deleted: nothing they were given goes on.
		if (user === undefined || (await store.deletions.get(grantee.userId)) !== undefined) return undefined;
		if (grantee.session !== undefined && options.sessionLive !== undefined) {
			if (!(await options.sessionLive(grantee.session))) return undefined;
		}
		return {
			kind: "person",
			userId: user.id,
			name: personName({ userId: user.id, name: user.name, email: user.email }),
			superAdmin: user.superAdmin,
			personalAccountId: user.personalAccountId,
		};
	}

	async function watcherNow(principal: Principal): Promise<Principal | undefined> {
		if (principal.kind === "key") return liveKeyPrincipal(store, principal.keyId, now());
		if (principal.token !== undefined) return liveTokenPrincipal(store, principal.token.id, now());
		if (principal.session !== undefined && options.sessionLive !== undefined) {
			if (!(await options.sessionLive(principal.session))) return undefined;
		}
		const [user, deletion] = await Promise.all([
			store.users.get(principal.userId),
			store.deletions.get(principal.userId),
		]);
		return user === undefined || user.retiredAt !== undefined || deletion !== undefined ? undefined : principal;
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

	/**
	 * `settledFor`, refused with `conflict` (`sandboxNotRunning`) unless the sandbox is running. One that is starting is
	 * waited for, up to `startHoldMs`: its start's own work when this gateway carries it out, else read again every
	 * `startPollMs` (another gateway's). It moves nothing itself: concurrent callers each wait, and a stopped sandbox
	 * stays stopped.
	 */
	function requireRunning(principal: Principal, sandboxId: string): Promise<StoredSandbox> {
		return runningOnce(
			sandboxId,
			(id) => settledFor(principal, id),
			(sandbox) => refuseShared(principal, sandbox),
		);
	}

	/**
	 * `requireRunning` for a call a token authorises rather than a principal (a signed file URL): the same wait and the
	 * same refusals, with no check of who may use the sandbox, which the token already made.
	 */
	function requireRunningByToken(sandboxId: string): Promise<StoredSandbox> {
		return runningOnce(sandboxId, async (id) => {
			await settledOn(id);
			return mustGetSandbox(id);
		});
	}

	/** The wait behind `requireRunning`: `settled` reads the sandbox once its queued work ends. */
	async function runningOnce(
		sandboxId: string,
		settled: (sandboxId: string) => Promise<StoredSandbox>,
		authorise: (sandbox: StoredSandbox) => Promise<void> = async () => undefined,
	): Promise<StoredSandbox> {
		let held = false;
		const hold = delay(startHoldMs);
		const holdOver = hold.done.then(() => {
			held = true;
		});
		try {
			for (;;) {
				const latest = await mustGetSandbox(sandboxId);
				// Its host isn't connected: refused at once, before waiting for its start (a placed sandbox starting again on a
				// host that went), behind what's queued on it (a stop waits up to minutes for the host), or on anything its guest
				// said, which can't be known now. One not yet placed has no host to ask, and waits for its start as before.
				if (latest.state !== "deleted") {
					await authorise(latest);
					await requireHostReachable(latest);
				}
				if (latest.state !== "starting") {
					// As before: whatever is queued on it (a stop, a fork of it) ends first, however long that takes.
					const sandbox = await settled(sandboxId);
					if (sandbox.state === "running") {
						// Its host went while the call waited: nothing reaches the machine (an SSH or desktop grant would only
						// fail when used).
						await requireHostReachable(sandbox);
						// Its guest agent doesn't answer its host: the call would only hang.
						if (sandbox.health === "unresponsive") throw sandboxUnresponsive(sandbox, apiBasePath);
						// Owed a stop (`enforceStop`: its egress as stored isn't what its host enforces) that didn't reach its host:
						// running only until the sweep stops it, and never used meanwhile, its host back or not.
						if (sandbox.stopFor !== undefined) {
							throw new KantelError("conflict", `The sandbox is being stopped: ${sandbox.stopFor}`);
						}
						// A call that needs it running (a command, its files, a port, SSH, the desktop) is a use of it.
						noteActivity(sandbox.id);
						return sandbox;
					}
					// Started by what was queued (a start queued behind a stop): waited for as any start.
					if (sandbox.state === "starting") continue;
					if (sandbox.state === "deleted") throw notFound("sandbox");
					throw sandboxNotRunning(sandbox, apiBasePath);
				}
				if (held) throw sandboxNotRunning(latest, apiBasePath, startHoldMs);
				// Its start's own work, when this gateway carries it out; never a tight loop on the store when it doesn't.
				const work = pending.get(sandboxId);
				const poll = delay(startPollMs);
				await Promise.race([...(work === undefined ? [] : [work]), poll.done, holdOver]);
				poll.cancel();
			}
		} finally {
			hold.cancel();
		}
	}

	/** Mounts, bundles, bucket sources, file URLs and archives, when the deployment turned them on. */
	const mounts =
		options.mounts === undefined
			? undefined
			: createMounts({
					store,
					backend,
					options: options.mounts,
					now,
					sealer: () => {
						if (sealer === undefined) throw new KantelError("not_supported", BUCKET_CREDENTIALS_UNSUPPORTED);
						return sealer;
					},
					publicUrl: (request) => (options.publicUrl ?? new URL(request.url).origin).replace(/\/+$/, ""),
					apiBasePath,
					sandboxFor,
					requireRunning,
					requireRunningByToken,
					granteePrincipal,
					accountOpen,
					once: (principal, operation, input, work) => once(principal, operation, input, work),
				});

	async function requireCapacity(accountId: string, adding: number): Promise<void> {
		if (limits.concurrentSandboxes === undefined) return;
		const active = (await store.sandboxes.list({ accountId })).filter(
			(sandbox) => sandbox.state === "starting" || sandbox.state === "running" || sandbox.state === "stopping",
		).length;
		if (active + adding > limits.concurrentSandboxes) {
			throw placementError(
				"exhausted",
				"account_limit",
				`The account may run ${limits.concurrentSandboxes} sandboxes at once`,
			);
		}
	}

	/**
	 * The snapshot a start or recovery makes the sandbox from: its newest, or, when it was never placed (its create or
	 * fork failed), the one it was to be made from (none for a plain create: its image, as its create had). A sandbox
	 * made from another that has no such snapshot (a running sandbox's fork) can't be made again here, so it is refused
	 * rather than started empty under its source's name; the same keeps an account's own host's snapshot with the host
	 * (routed there, or refused while it is unreachable).
	 */
	async function latestRef(sandbox: StoredSandbox): Promise<string | undefined> {
		if (sandbox.latestSnapshotId !== undefined) {
			const latest = await store.snapshots.get(sandbox.latestSnapshotId);
			return latest === undefined ? undefined : hostRef(latest);
		}
		if (!neverPlaced(sandbox) || sandbox.source === undefined) return undefined;
		const from = sandbox.source.snapshotId;
		const source = from === undefined ? undefined : await store.snapshots.get(from);
		if (source === undefined) throw new KantelError("conflict", NEVER_MADE);
		return readyRef(source);
	}

	/**
	 * A sandbox whose create or fork failed: it was never placed on a host, so no backend has it (a backend lets a failed
	 * create's placement go), and it has no snapshot of its own. Made from a snapshot or not.
	 */
	const neverPlaced = (sandbox: StoredSandbox): boolean =>
		sandbox.hostId === undefined && sandbox.latestSnapshotId === undefined;

	/**
	 * The hosts a start or recovery may boot the sandbox on: as for its create when it was never placed and isn't made
	 * from a snapshot (the account's own hosts first, online ones only), else any qualifying host, so a backend that
	 * holds its disk or snapshot finds its own host among them.
	 */
	async function hostsToBoot(principal: Principal, sandbox: StoredSandbox): Promise<string[]> {
		const affine = !neverPlaced(sandbox) || sandbox.source !== undefined;
		return requireHosts(
			await ensureHosts(),
			sandbox.accountId,
			sandbox.type,
			sandbox.hostLabels,
			affine,
			await mayShare(principal),
			sandbox.hostPin,
			// Placed afresh, in its pool again.
			affine ? undefined : await poolOfSandbox(sandbox),
		);
	}

	/**
	 * Boots a sandbox for a start or recovery with `boot`: `booted` where a backend has it, or, when it was never placed
	 * (`neverPlaced`), made as its create would make it (from its source's snapshot, `latestRef`, or its image, or its
	 * template's base and setup as its create resolved them, booted fresh, at its own size and shape), placed as a create
	 * is, since no backend has it to start. `sandbox` is the record as the boot moved it (a restart's new size and shape
	 * included), and `boot` its sizing.
	 */
	async function bootAgain(
		sandbox: StoredSandbox,
		boot: BootOptions,
		booted: (boot: BootOptions) => Promise<Placement>,
	): Promise<Placement> {
		if (!neverPlaced(sandbox)) return booted(boot);
		const stored = sandbox.source === undefined ? sandbox.templateBoot : undefined;
		let template: Omit<SandboxTemplateBoot, "snapshot" | "snapshotHosts"> | undefined;
		let eligibleHosts = boot.eligibleHosts;
		if (stored !== undefined) {
			const { holders, ...fresh } = stored;
			template = fresh;
			// A custom image boots only where it was built: on its holders the sandbox may still use.
			if (holders !== undefined) {
				eligibleHosts = holders.filter((hostId) => boot.eligibleHosts.includes(hostId));
				if (eligibleHosts.length === 0) {
					throw placementError(
						"unavailable",
						"host_unavailable",
						"No host this sandbox may use holds its template's image now; make a new sandbox from the template once it's built",
					);
				}
			}
		}
		// From a saved snapshot named by its ID alone: on its holders in its pool, or a host that fetches it, as its create.
		const source =
			sandbox.source?.snapshotId === undefined || boot.fromSnapshot === undefined
				? undefined
				: await store.snapshots.get(sandbox.source.snapshotId);
		let fromCopies: Pick<SandboxSpec, "fromSnapshot" | "snapshotCopies"> = {};
		// Either kind of ref: an older one names its host and is never fetched, but goes on a copy held under it too.
		if (source?.ref !== undefined && (refHost(source.ref) !== undefined || source.hostId !== undefined)) {
			const known = await ensureHosts();
			const poolId = sandbox.poolId ?? source.poolId;
			fromCopies = { fromSnapshot: source.ref, snapshotCopies: await snapshotCopiesOf(source, known, poolId) };
			if (poolId !== undefined) {
				const inPool = new Set(known.filter((host) => host.poolId === poolId).map((host) => host.id));
				eligibleHosts = eligibleHosts.filter((hostId) => inPool.has(hostId));
			}
		}
		const placement = await backend.create({
			...boot,
			...fromCopies,
			eligibleHosts,
			// Placed afresh (from its source's snapshot too): in its pool, kept to it as the host admits it.
			...pooled(sandbox.poolId),
			sandboxId: sandbox.id,
			accountId: sandbox.accountId,
			type: sandbox.type,
			subdomain: sandbox.subdomain,
			...(boot.shape === undefined ? {} : { shape: boot.shape }),
			...(sandbox.image === undefined ? {} : { image: sandbox.image }),
			...(template === undefined ? {} : { template: { ...template } }),
			...(await stickySpecOf(sandbox)),
		});
		// Made again from its template's base, its setup run: no longer the snapshot its create was to start from.
		return template === undefined || sandbox.template?.start !== "snapshot"
			? placement
			: { ...placement, bootedFresh: true };
	}

	/** A template's boot as a sandbox keeps it for a retry of its create (`templateBoot`): its base and setup, no snapshot. */
	const freshBoot = ({
		snapshot: _cached,
		snapshotHosts: _copies,
		...fresh
	}: SandboxTemplateBoot): Omit<SandboxTemplateBoot, "snapshot" | "snapshotHosts"> => fresh;

	/** A boot's sizing from the record as it moved: its named size and, where it has one, its shape. */
	const sizingOf = (sandbox: StoredSandbox): Pick<BootOptions, "size" | "shape"> => ({
		...(sandbox.size === undefined ? {} : { size: sandbox.size }),
		...(sandbox.shape === undefined ? {} : { shape: sandbox.shape }),
	});

	/**
	 * What a boot's set-up may do once the sandbox runs, if it has any pending (`pendingProvision`): the environments whose
	 * repositories it may clone, checked as a create checks it (only a caller that may run commands has repositories
	 * cloned; `lenient` leaves them pending for one that may, rather than refuse). A sandbox made before set-up was
	 * recorded, whose create never placed it, has its environments' set-up recorded now.
	 */
	async function provisionedAgain(
		principal: Principal,
		role: MemberRole,
		sandbox: StoredSandbox,
		lenient = false,
	): Promise<Provisioning | undefined> {
		let pending = sandbox.pendingProvision ?? [];
		const environments = await environmentsOf(sandbox);
		const older = sandbox.envLayers === undefined && neverPlaced(sandbox) && sandbox.source === undefined;
		if (pending.length === 0 && older) {
			const work = environments.flatMap(workFor);
			if (work.length === 0) return undefined;
			await patchSandbox(sandbox.id, (latest) =>
				(latest.pendingProvision?.length ?? 0) > 0 ? undefined : { ...latest, pendingProvision: work },
			);
			pending = work;
		}
		if (pending.length === 0) return undefined;
		const cloning = new Set(pending.filter((work) => work.kind === "repos").map((work) => work.environmentId));
		let authorised = environments.filter((environment) => cloning.has(environment.id));
		if (authorised.length > 0) {
			if (!lenient) requireScope(principal, "exec", role);
			else if (!mayScope(principal, "exec", role)) authorised = [];
		}
		return { environments: authorised };
	}

	/** Whether a caller may act with `scope`, as `requireScope` would let them. */
	function mayScope(principal: Principal, scope: computeSchema.ApiKeyScope, role: MemberRole): boolean {
		try {
			requireScope(principal, scope, role);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Refuses a start, recovery or restart on latest that makes a sandbox again from its template (`bootAgain`), running
	 * the template's setup with its env, to a caller that may not run commands, as its create does.
	 */
	function requireSetupScope(principal: Principal, role: MemberRole, sandbox: StoredSandbox): void {
		if (!neverPlaced(sandbox) || sandbox.source !== undefined || sandbox.templateBoot?.setup === undefined) return;
		requireScope(principal, "exec", role);
	}

	/** `boot`, then, once it runs, the provisioning its create would have done (`provisionedAgain`). */
	async function bootProvisioned(
		sandboxId: string,
		run: () => Promise<Placement>,
		provisioning: Provisioning | undefined,
		sent: { readonly egressRevision: number | undefined },
	): Promise<StoredSandbox | undefined> {
		const booted = await boot(sandboxId, run, undefined, sent);
		if (booted?.state === "running" && provisioning !== undefined)
			await provision(booted.id, provisioning.environments).catch(() => undefined);
		return booted;
	}

	/** Lets the backend drop a snapshot's bytes once no snapshot record shares them. */
	/**
	 * Whether a snapshot's bytes hold memory: its own say, or that of another snapshot of the same bytes (a save made
	 * before saves kept the flag shares its pause's ref but says no). Reads report it, so a client sees what a create
	 * from it will be held to.
	 */
	async function holdsMemory(snapshot: StoredSnapshot): Promise<boolean> {
		if (snapshot.memory) return true;
		if (snapshot.ref === undefined) return false;
		return (await store.snapshots.list({ ref: snapshot.ref, memory: true })).length > 0;
	}

	/**
	 * Deletes a snapshot's record. One that holds memory first passes that on to every other record of its bytes (a save
	 * made before saves kept the flag says no), so none of them stops saying so once it is gone.
	 */
	async function forgetSnapshot(snapshot: StoredSnapshot): Promise<void> {
		if (snapshot.memory && snapshot.ref !== undefined) {
			for (const other of await store.snapshots.list({ ref: snapshot.ref, memory: false })) {
				await store.snapshots.update(other.id, (latest) => (latest.memory ? undefined : { ...latest, memory: true }));
			}
		}
		await store.snapshots.delete(snapshot.id);
	}

	/** Lets the backend drop a snapshot's bytes (`ref`, on `hostId` where it names none) once no record has their ref. */
	async function releaseRef(bytes: Pick<StoredSnapshot, "ref" | "hostId">): Promise<void> {
		const { ref } = bytes;
		if (ref === undefined) return;
		if ((await store.snapshots.list({ ref })).length > 0) return;
		await deleteSnapshotBytes({ ...bytes, ref }).catch(() => undefined);
	}

	/**
	 * Deletes a snapshot's bytes on the host they were taken on (its ref's, or `hostId` for a ref naming none), then the
	 * copies other hosts fetched of it, or are fetching (`disk-holders.ts`, kind `snapshot`: the holders recorded as copies
	 * of this ref, never of another ref that shares its host's ID), whose holders go with them. That is the prompt path
	 * only: a copy it doesn't reach (its host away, or told to fetch it just as this ran) is deleted when its host next
	 * reports it (`DiskHolders.recordHoldings`). Bytes their host no longer has count as deleted; any other failure there
	 * is thrown, and the copies are left for a retry.
	 */
	async function deleteSnapshotBytes(bytes: { readonly ref: string; readonly hostId?: string }): Promise<void> {
		const { ref } = bytes;
		const named = hostRef(bytes) ?? ref;
		try {
			await backend.deleteSnapshot(named);
		} catch (error) {
			if (!goneAlready(error)) throw error;
		}
		const hostId = refHost(named);
		if (hostId === undefined) return;
		const objectId = refId(named);
		const copies = [...(await diskHolders.holdersOf("snapshot", objectId)).values()]
			.flat()
			.filter((holder) => holder.ref === ref);
		for (const host of new Set(copies.map((holder) => holder.hostId))) {
			if (host === hostId) continue;
			await backend.deleteSnapshot(`${host}/${objectId}`).catch(() => undefined);
		}
		for (const holder of copies) await store.diskHolders.delete(holder.id);
	}

	/**
	 * Refuses bytes just taken of `read` (a running sandbox, as read before they were taken) when what they are of can't
	 * be told: the sandbox began or ended an upgrade meanwhile, so they may be the isolate's or the microVM's. The bytes go
	 * again (`taken`). A snapshot's `sandboxType` is then always what its bytes are of.
	 */
	async function requireSameTier(read: StoredSandbox, taken: Pick<StoredSnapshot, "ref" | "hostId">): Promise<void> {
		const latest = await store.sandboxes.get(read.id);
		if (latest === undefined) return;
		if (
			latest.type === read.type &&
			latest.upgrading === undefined &&
			latest.upgradedFrom?.at === read.upgradedFrom?.at
		) {
			return;
		}
		await releaseRef(taken);
		throw new KantelError("conflict", "The sandbox was upgraded while its snapshot was taken; take it again");
	}

	// Expiry of automatic snapshots. A record goes ready → marked (`deleting`, `retiring` {by, token, at}, which may be
	// put back) → settling (`retiring.settling`, never put back) → gone; each move a compare-and-set on the record
	// (`update`, which the SQL store writes only over the version it read):
	//
	// - `markExpiring` marks only a ready automatic snapshot past its `expiresAt`, on a host that keeps a saved snapshot's
	//   own copy (`keepsCopies`, `snapshot-keep`), whose ref no other record has. On such a host nothing newly shares a
	//   ref (only a save on a host without `snapshot.keep` does), so expiry never touches bytes another record names. A
	//   host without it prunes its automatic snapshots itself, as before.
	// - `settleSnapshot` is the only way from a mark to settling: by the mark's owner (or another process once the mark
	//   is past `RETIRE_LEASE_MS`, taking it over with a new token), after reading afresh what depends on the snapshot
	//   (`dependents`: what a sandbox resumes from, its pause, what a never-placed one is to be made from) for that very
	//   token; something does, the mark is put back; the read fails, nothing moves.
	// - `adopt` is the only way a create, a fork or a sandbox's newest moved back to an older one comes to depend on an
	//   existing snapshot: the dependency is written first, then the snapshot read again, and anything but ready (or a
	//   failed read) rolls it back. A mark happens before every dependents read, so either expiry sees the dependency or
	//   the adopter sees the mark.
	// - `releaseBytes` deletes a settling record's bytes, unless another record has their ref, and then the record; a
	//   host that can't delete them leaves it settling, and the sweep tries again.
	// - `withdrawSave` moves a save's own record that its host's limit refused (`admitSave`) from `creating` straight to
	//   settling: nothing can depend on a snapshot that was never ready. The sweep retries these with expiry off too, and
	//   takes back a save left `creating` past `SAVE_ADMISSION_LEASE_MS` the same way.
	//
	// A delete by hand, a save and a sandbox's delete are as they were: a delete of a snapshot expiry has marked simply
	// wins (expiry's compare-and-sets then find no record and do nothing), and a record a delete removes is no holder.

	/**
	 * Whether the host a snapshot's bytes are on keeps a copy of its own for every save (`snapshot.keep`), so nothing
	 * there ever shares the snapshot's ref. The host is its ref's (`<hostId>/<id>`), else its sandbox's. A backend that
	 * can't keep copies, or a host that can't be told, doesn't.
	 */
	async function keepsCopies(snapshot: StoredSnapshot, hosts: ReadonlyMap<string, BackendHost>): Promise<boolean> {
		if (backend.keepSnapshot === undefined || snapshot.ref === undefined) return false;
		const slash = snapshot.ref.indexOf("/");
		const hostId =
			slash > 0
				? snapshot.ref.slice(0, slash)
				: snapshot.sandboxId === undefined
					? undefined
					: (await store.sandboxes.get(snapshot.sandboxId))?.hostId;
		const host = hostId === undefined ? undefined : hosts.get(hostId);
		// A backend's own hosts that say nothing of features (the stub) keep copies when the backend does.
		return host !== undefined && (host.features === undefined || host.features.includes(SNAPSHOT_KEEP_FEATURE));
	}

	/** Marks an expired automatic snapshot `deleting`, provisionally, owned by this process; undefined when it isn't to be. */
	async function markExpiring(snapshotId: string): Promise<StoredSnapshot | undefined> {
		return store.snapshots.update(snapshotId, (latest) =>
			latest.state !== "ready" || latest.kind !== "automatic"
				? undefined
				: { ...latest, state: "deleting", retiring: { by: retireOwner, token: randomId("ret"), at: now() } },
		);
	}

	/** Puts this process's provisional mark back (`ready`), while it is still the mark with `token`. */
	async function unmarkExpiring(snapshotId: string, token: string | undefined): Promise<void> {
		await store.snapshots.update(snapshotId, (latest) => {
			if (
				latest.state !== "deleting" ||
				latest.retiring?.by !== retireOwner ||
				latest.retiring.token !== token ||
				latest.retiring.settling === true
			) {
				return undefined;
			}
			const { retiring: _, ...rest } = latest;
			return { ...rest, state: "ready" };
		});
	}

	/**
	 * Of `snapshotIds`, those a sandbox depends on, read afresh: what one resumes from (its newest), its pause while it is
	 * paused or resuming, and what a never-placed one is to be made from. Only a deleted sandbox depends on nothing: one
	 * being deleted may yet fail back to `error`, as it was. Throws when the read fails.
	 */
	async function dependents(snapshotIds: ReadonlySet<string>): Promise<Set<string>> {
		const needed = new Set<string>();
		for (const sandbox of await store.sandboxes.list()) {
			if (sandbox.state === "deleted") continue;
			for (const id of [
				sandbox.latestSnapshotId,
				sandbox.state === "paused" || sandbox.state === "starting" ? sandbox.pausedSnapshotId : undefined,
				neverPlaced(sandbox) ? sandbox.source?.snapshotId : undefined,
				// What an upgrade under way starts its microVM from.
				sandbox.upgrading?.snapshotId,
			]) {
				if (id !== undefined && snapshotIds.has(id)) needed.add(id);
			}
		}
		return needed;
	}

	/**
	 * Carries an expiry's mark on to settling (the model above): this process's mark, or one held past its lease, taken
	 * over; one that is fresh and not this process's is left to its owner. Answers `kept` when it isn't this process's to
	 * settle, something depends on it (put back), or a read failed; `settling` when its bytes couldn't be released yet;
	 * `gone` when its record is gone.
	 */
	async function settleSnapshot(
		snapshot: StoredSnapshot,
		/** What depends on it, read after it was marked (a pass's one read for all it marked). */
		read?: ReadonlySet<string>,
	): Promise<"kept" | "settling" | "gone"> {
		const at = now();
		const mine = (latest: StoredSnapshot) => latest.retiring?.by === retireOwner;
		const stale = (latest: StoredSnapshot) =>
			latest.retiring === undefined || latest.retiring.at + RETIRE_LEASE_MS <= at;
		let current = await store.snapshots.get(snapshot.id);
		if (current === undefined) return "gone";
		if (current.state !== "deleting") return "kept";
		if (!mine(current) || current.retiring?.token === undefined) {
			current = await store.snapshots.update(current.id, (latest) =>
				latest.state === "deleting" && stale(latest)
					? { ...latest, retiring: { ...latest.retiring, by: retireOwner, token: randomId("ret"), at } }
					: undefined,
			);
			if (current === undefined) return "kept";
		}
		if (current.retiring?.settling !== true) {
			const token = current.retiring?.token;
			let needed: boolean;
			try {
				// A pass's one read stands only for the mark it was read after.
				const fresh = read !== undefined && snapshot.retiring?.token === token;
				needed = (fresh ? read : await dependents(new Set([current.id]))).has(current.id);
			} catch {
				return "kept";
			}
			if (needed) {
				await unmarkExpiring(current.id, token);
				return "kept";
			}
			const claimed = await store.snapshots.update(current.id, (latest) =>
				latest.state === "deleting" &&
				mine(latest) &&
				latest.retiring?.token === token &&
				latest.retiring?.settling !== true
					? {
							...latest,
							retiring: { ...latest.retiring, by: retireOwner, at: latest.retiring?.at ?? at, settling: true },
						}
					: undefined,
			);
			if (claimed === undefined) return (await store.snapshots.get(current.id)) === undefined ? "gone" : "kept";
			current = claimed;
		}
		return (await releaseBytes(current).catch(() => false)) ? "gone" : "settling";
	}

	/**
	 * Deletes a settling record: its bytes, unless another record has their ref, then the record. False, the record
	 * kept for the sweep to try again, when a read failed or the host couldn't delete them; bytes the host no longer
	 * has count as deleted.
	 */
	async function releaseBytes(snapshot: StoredSnapshot): Promise<boolean> {
		const { ref } = snapshot;
		if (ref !== undefined && !(await store.snapshots.list({ ref })).some((other) => other.id !== snapshot.id)) {
			try {
				await deleteSnapshotBytes({ ref, ...(snapshot.hostId === undefined ? {} : { hostId: snapshot.hostId }) });
			} catch (error) {
				if (!goneAlready(error)) return false;
			}
		}
		await store.snapshots.deleteIf(snapshot.id, (latest) => latest.state === "deleting");
		return true;
	}

	/**
	 * Makes something depend on an existing snapshot (the model above): `depend` writes the dependency, then the snapshot
	 * is read again, and anything but ready, or a read that fails, has `undo` roll it back. Answers whether it stands.
	 */
	async function adopt(snapshotId: string, depend: () => Promise<void>, undo: () => Promise<void>): Promise<boolean> {
		await depend();
		const still = await store.snapshots.get(snapshotId).then(
			(read) => read?.state === "ready",
			() => false,
		);
		if (still) return true;
		await undo();
		return false;
	}

	/** The error a create or fork answers when the snapshot it is made from was deleted under it. */
	const deletedMeanwhile = () => new KantelError("conflict", "The snapshot was deleted while it was being used");

	/** An upgrade starts its microVM from a microVM's snapshot, never an isolate's (`invalid`). */
	function requireMicrovmSnapshot(snapshot: StoredSnapshot): void {
		if (snapshot.sandboxType === "isolate") {
			throw new KantelError(
				"invalid",
				`Snapshot ${snapshot.id} is of an isolate: an isolate upgrades into a snapshot of a microVM`,
			);
		}
	}

	/**
	 * What an isolate's automatic upgrade is to start from (`autoUpgradeFrom`), checked as its upgrade will take it: the
	 * snapshot's pool too, by the caller, once the sandbox's is known (`poolOfSnapshot`).
	 */
	async function checkAutoUpgradeFrom(principal: Principal, accountId: string, from: string): Promise<StoredSnapshot> {
		const snapshot = await snapshotFrom(principal, accountId, from);
		requireMicrovmSnapshot(snapshot);
		return snapshot;
	}

	/**
	 * Expires automatic snapshots past their `expiresAt` (the model above), at most once each `SNAPSHOT_EXPIRY_EVERY_MS`,
	 * in the background: first what is left `deleting` (settling ones, and marks past their lease), then the expired,
	 * marked, one read of what depends on them, and each settled for its own mark. With expiry off, only the settling
	 * ones (a refused save's bytes, `withdrawSave`) are tried again. Either way, a save left `creating` past
	 * `SAVE_ADMISSION_LEASE_MS` (its gateway died) is taken back first.
	 */
	function expireSnapshots(): void {
		const expiring = options.snapshotExpiry === true;
		if (expiring && now() < expiryStartsAt) return;
		if (now() - snapshotsExpiredAt < SNAPSHOT_EXPIRY_EVERY_MS) return;
		snapshotsExpiredAt = now();
		keepGoing(
			(async () => {
				const at = now();
				// A save left `creating` past its lease (its gateway died mid-admission): taken back, its bytes with it.
				for (const creating of await store.snapshots.list({ state: "creating", kind: "saved" })) {
					if (closing) return;
					if (creating.createdAt + SAVE_ADMISSION_LEASE_MS > at) continue;
					await withdrawSave(creating.id, at).catch(() => undefined);
				}
				for (const deleting of await store.snapshots.list({ state: "deleting" })) {
					if (closing) return;
					const fresh = deleting.retiring !== undefined && deleting.retiring.at + RETIRE_LEASE_MS > at;
					if (deleting.retiring?.settling !== true && (fresh || !expiring)) continue;
					await settleSnapshot(deleting).catch(() => "kept");
				}
				if (!expiring) return;
				// One read for the pass: the expired, and how many records name each ref.
				const all = await store.snapshots.list();
				const named = new Map<string, number>();
				for (const snapshot of all) {
					if (snapshot.ref !== undefined) named.set(snapshot.ref, (named.get(snapshot.ref) ?? 0) + 1);
				}
				const expired = all.filter(
					(snapshot) =>
						snapshot.kind === "automatic" &&
						snapshot.expiresAt !== undefined &&
						snapshot.expiresAt <= at &&
						snapshot.state === "ready",
				);
				if (expired.length === 0) return;
				const hosts = new Map((await backend.capabilities()).hosts.map((host) => [host.id, host]));
				const marked: StoredSnapshot[] = [];
				for (const snapshot of expired) {
					if (snapshot.ref === undefined || !(await keepsCopies(snapshot, hosts))) continue;
					if ((named.get(snapshot.ref) ?? 0) > 1) continue;
					const written = await markExpiring(snapshot.id).catch(() => undefined);
					if (written !== undefined) marked.push(written);
				}
				if (marked.length === 0) return;
				const read = await dependents(new Set(marked.map((snapshot) => snapshot.id))).catch(() => undefined);
				if (read === undefined) return;
				for (const snapshot of marked) {
					if (closing) return;
					await settleSnapshot(snapshot, read).catch(() => "kept");
				}
			})(),
		);
	}

	/**
	 * A save's new bytes' size (a kept copy, `keepSnapshot`, or a live save's `takeSnapshot`) as a refresh will count it
	 * (`attributeSnapshotBytes`): its own bytes, and each group of files it shares for the holder the records choose,
	 * itself included as a saved record made now. A backend that doesn't say how its files are shared answers its size
	 * alone.
	 */
	async function keptSize(kept: TakenSnapshot, replacing: StoredSnapshot | undefined): Promise<number> {
		if (kept.uniqueBytes === undefined) return kept.sizeBytes;
		const shared = kept.shared ?? [];
		const records: Pick<StoredSnapshot, "ref" | "kind" | "createdAt" | "state">[] = [
			{ ref: kept.ref, kind: "saved", createdAt: now(), state: "ready" },
		];
		for (const ref of new Set(shared.flatMap((group) => group.refs))) {
			if (ref === kept.ref) continue;
			// Not the save it replaces, which goes once this one is put: its files are this one's to keep. Nor another save
			// still being admitted (`creating`, `admitSave`): refused, it would take its files with it uncounted, so this one
			// counts them too until a refresh says which keeps them.
			records.push(
				...(await store.snapshots.list({ ref })).filter(
					(record) => record.id !== replacing?.id && record.state !== "creating",
				),
			);
		}
		return attributeSnapshotBytes(records, new Map([[kept.ref, kept.uniqueBytes]]), shared).get(kept.ref) ?? 0;
	}

	/**
	 * Records a running command's end; one no longer `running` (a kill or a stop landed first) is kept as it is. Output
	 * already recorded while it ran is kept: a real end's output starts with it, and an end Kantel made up (its result
	 * lost, its host gone) adds its reason after it.
	 */
	async function endCommand(
		commandId: string,
		result: ExecResult,
		rerunAs?: string,
		/** Its owner, the call that ran it: the one that records an end its sandbox's upgrade runs again. */
		owner = false,
	): Promise<StoredCommand | undefined> {
		const at = now();
		const ended = await settleCommand(commandId, (latest) => {
			if (!owner && heldForRerun(latest, result, at)) return undefined;
			const stdout = endStream(latest.stdout, result.stdout);
			const stderr = endStream(latest.stderr, result.stderr);
			return {
				...latest,
				state: result.timedOut ? "timed_out" : "exited",
				exitCode: result.exitCode,
				stdout: stdout.text,
				stderr: stderr.text,
				// One whose recorded output was cut, and that kept it, still has it cut.
				truncated:
					stdout.truncated ||
					stderr.truncated ||
					(latest.truncated && !(result.stdout.startsWith(latest.stdout) && result.stderr.startsWith(latest.stderr))),
				endedAt: at,
				durationMs: at - latest.startedAt,
				...(result.needsMicrovm === undefined
					? {}
					: {
							needsMicrovm: {
								command: result.needsMicrovm.command,
								reason: result.needsMicrovm.reason,
								...(result.needsMicrovm.inferred === true ? { inferred: true } : {}),
							},
						}),
				...(result.terminated === undefined ? {} : { terminated: result.terminated }),
				...(rerunAs === undefined ? {} : { rerunAs }),
			};
		});
		return ended ?? (await store.commands.get(commandId));
	}

	/**
	 * Moves a command out of `running` with `change`, atomically: `undefined` when it was no longer running (another
	 * end, a kill or a stop got there first, on any gateway), which is then kept as it is.
	 */
	async function settleCommand(
		commandId: string,
		change: (running: StoredCommand) => StoredCommand | undefined,
	): Promise<StoredCommand | undefined> {
		let won = false;
		const written = await store.commands.update(commandId, (latest) => {
			const next = latest.state === "running" ? change(latest) : undefined;
			won = next !== undefined;
			return next;
		});
		return won ? written : undefined;
	}

	/**
	 * Whether a command's end, needing a microVM (as its runtime said, in a sandbox with `autoUpgrade`), is its owner's to
	 * record with its run again: until `RERUN_CLAIM_MS` after a reader first saw it (`rerunPending`), when its owner is
	 * taken to be gone and the end is recorded as it is.
	 */
	const heldForRerun = (command: StoredCommand, result: ExecResult | CommandProgress, at: number): boolean =>
		command.autoUpgrade === true &&
		!isCommandProgress(result) &&
		result.needsMicrovm !== undefined &&
		result.needsMicrovm.inferred !== true &&
		(command.rerunPending === undefined || at - command.rerunPending < RERUN_CLAIM_MS);

	/**
	 * A running command as its backend has it now: its output so far (what `attach` shows while it runs), and ended once
	 * the backend says so. One no gateway here is waiting for (the one that started it closed, or is another replica) is
	 * lost once the backend no longer knows it; one a gateway here follows is left to that gateway to end.
	 */
	async function fetchedCommand(command: StoredCommand): Promise<StoredCommand> {
		if (command.state !== "running" || backend.commandResult === undefined) return command;
		const followed = runningCommands.has(command.id);
		// A foreground one a gateway here waits for is ended by that wait, and only its output so far is recorded; one none
		// here does outlived its gateway (on a backend that runs commands on past their call) or is another replica's, and
		// is asked for as a detached one is.
		if (command.detached !== true && followed) return progressOf(command);
		let result: ExecResult | CommandProgress | undefined;
		try {
			result = await backend.commandResult(command.sandboxId, command.id);
		} catch (error) {
			// Not just started (a start the backend hasn't recorded yet reads as unknown too).
			if (
				followed ||
				!(error instanceof KantelError && error.code === "not_found") ||
				now() - command.startedAt < LOST_COMMAND_MS
			) {
				return command;
			}
			result = {
				exitCode: 1,
				stdout: "",
				stderr:
					"Kantel lost this command's result: its sandbox's host no longer knows it (it or the sandbox restarted)\n",
				timedOut: false,
			};
		}
		if (result === undefined) return command;
		if (isCommandProgress(result)) return (await recordProgress(command.id, result)) ?? command;
		// Its owner runs it again in the microVM its sandbox upgrades to, and records its end with that: seen, and left.
		if (heldForRerun(command, result, now())) {
			if (command.rerunPending !== undefined) return command;
			return (
				(await store.commands.update(command.id, (latest) =>
					latest.state === "running" && latest.rerunPending === undefined
						? { ...latest, rerunPending: now() }
						: undefined,
				)) ?? command
			);
		}
		return (await endCommand(command.id, result)) ?? command;
	}

	/**
	 * A running foreground command's output so far, from its backend, for one a gateway here waits for: recorded, while
	 * its end is left to that wait (the backend's answer to it has the whole of its output). A backend that can't say
	 * leaves it as it is.
	 */
	async function progressOf(command: StoredCommand): Promise<StoredCommand> {
		const result = await backend.commandResult?.(command.sandboxId, command.id).catch(() => undefined);
		if (result === undefined || !isCommandProgress(result)) return command;
		return (await recordProgress(command.id, result)) ?? command;
	}

	/**
	 * A running command's output so far, written while it is still running and only when it has more than is recorded
	 * (its backend keeps the start of each stream, so it only grows).
	 */
	async function recordProgress(commandId: string, progress: CommandProgress): Promise<StoredCommand | undefined> {
		const stdout = truncate(progress.stdout);
		const stderr = truncate(progress.stderr);
		return store.commands
			.update(commandId, (latest) => {
				if (latest.state !== "running") return undefined;
				if (stdout.text.length <= latest.stdout.length && stderr.text.length <= latest.stderr.length) return undefined;
				return {
					...latest,
					stdout: stdout.text.length > latest.stdout.length ? stdout.text : latest.stdout,
					stderr: stderr.text.length > latest.stderr.length ? stderr.text : latest.stderr,
					truncated: latest.truncated || stdout.truncated || stderr.truncated || progress.truncated === true,
				};
			})
			.then(async (written) => written ?? (await store.commands.get(commandId)));
	}

	/**
	 * `killCommand`: a running command marked killed and its kill sent to its backend; one ended is answered with its end.
	 * A command its sandbox's upgrade runs again (`autoUpgrade`) has its run again killed with it, whether the kill finds
	 * it running with its run again starting (`rerunStarting`), or ended naming its run again (`rerunAs`): a kill never
	 * leaves its run again running.
	 */
	async function killStored(sandboxId: string, stored: StoredCommand): Promise<StoredCommand> {
		// Killed before, but its kill never reached its backend: sent again.
		if (stored.state === "killed" && stored.killPending === true) {
			return reachRerun(sandboxId, await deliverKill(sandboxId, stored));
		}
		// One that ended where no gateway here saw it is answered with its end, not killed.
		const command = await fetchedCommand(stored);
		if (command.state !== "running") return reachRerun(sandboxId, command);
		noteActivity(sandboxId);
		const at = now();
		// Recorded first, so the end its process now comes to (137) isn't recorded as an exit; and only by the kill
		// that moved it out of running, so an end recorded meanwhile is kept, and its process isn't sent a kill. Its
		// kill is pending from then until its backend takes it, so a gateway that dies before sending it, or a send
		// that fails, leaves it for the next kill to send.
		const killed = await settleCommand(command.id, (latest) => ({
			...latest,
			state: "killed",
			exitCode: 137,
			endedAt: at,
			durationMs: at - latest.startedAt,
			...(backend.killCommand === undefined ? {} : { killPending: true }),
		}));
		if (killed === undefined) return reachRerun(sandboxId, (await store.commands.get(command.id)) ?? command);
		runningCommands.get(command.id)?.abort();
		runningCommands.delete(command.id);
		// Its process, which the gateway that started it may not be: the kill goes to its host whichever it is.
		return reachRerun(sandboxId, await deliverKill(sandboxId, killed));
	}

	/**
	 * A killed or ended command's run again (`autoUpgrade`), killed too while it runs. One whose run again isn't recorded
	 * yet is left to that run's start, which runs it only while this one still runs (`runCommandOnce`). A killed one gets
	 * the `rerunAs` its owner can no longer record.
	 */
	async function reachRerun(sandboxId: string, command: StoredCommand): Promise<StoredCommand> {
		const rerunId = command.rerunAs ?? (command.state === "killed" ? command.rerunStarting : undefined);
		if (rerunId === undefined) return command;
		const rerun = await store.commands.get(rerunId);
		if (rerun === undefined || rerun.sandboxId !== sandboxId) return command;
		if (rerun.state === "running" || (rerun.state === "killed" && rerun.killPending === true)) {
			await killStored(sandboxId, rerun);
		}
		if (command.rerunAs !== undefined) return command;
		return (
			(await store.commands.update(command.id, (latest) =>
				latest.rerunAs === undefined ? { ...latest, rerunAs: rerunId } : undefined,
			)) ?? command
		);
	}

	/**
	 * Sends a killed command's kill to its backend (`killCommand`), the record's `killPending` until it is done: the
	 * backend took it, or can't ever (`not_supported`, an older host). One that failed otherwise (its host out of reach)
	 * stays pending, its stderr saying so, and the next kill of it, on any gateway, sends it again.
	 */
	async function deliverKill(sandboxId: string, command: StoredCommand): Promise<StoredCommand> {
		if (backend.killCommand === undefined) return command;
		let failure: unknown;
		let delivered = false;
		try {
			await backend.killCommand(sandboxId, command.id);
			delivered = true;
		} catch (error) {
			failure = error;
		}
		const final = delivered || (failure instanceof KantelError && failure.code === "not_supported");
		const note = delivered
			? undefined
			: `Kantel marked this command killed but couldn't stop it, so it may still be running: ${messageOf(failure)}${
					final ? "" : "; kill it again to retry"
				}\n`;
		// Only while it is still pending: once another attempt has delivered it, a late failure changes nothing.
		const written = await store.commands.update(command.id, (latest) => {
			if (latest.state !== "killed" || latest.killPending !== true) return undefined;
			const stderr =
				note === undefined || latest.stderr.includes(note) ? latest.stderr : truncate(`${latest.stderr}${note}`).text;
			if (!final) return { ...latest, stderr, killPending: true };
			const { killPending: _, ...done } = latest;
			return { ...done, stderr };
		});
		return written ?? (await store.commands.get(command.id)) ?? command;
	}

	/**
	 * Marks a sandbox's running commands killed, and stops waiting for them: its stop or delete ends their processes
	 * (a pause keeps them, as it keeps the rest of the sandbox's memory).
	 */
	async function killCommandsOf(sandboxId: string, listed?: readonly StoredCommand[]): Promise<void> {
		const running = listed ?? (await store.commands.list({ sandboxId, state: "running" }));
		// One that ended where no gateway here saw it keeps its end, not a kill: asked for all at once, for at most
		// RECONCILE_MS in all, so a stop or delete never waits long on a host that doesn't answer. One not answered in
		// time is marked killed.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const budget = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), RECONCILE_MS);
		});
		const reconciled = await Promise.all(
			running.map(async (listed) => (await Promise.race([fetchedCommand(listed), budget])) ?? listed),
		);
		if (timer !== undefined) clearTimeout(timer);
		for (const command of reconciled) {
			if (command.state !== "running") continue;
			const at = now();
			await settleCommand(command.id, (latest) => ({
				...latest,
				state: "killed",
				endedAt: at,
				durationMs: at - latest.startedAt,
			}));
			runningCommands.get(command.id)?.abort();
			runningCommands.delete(command.id);
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
		/** What else changes as it is published (an upgrade's microVM: its type, size and image). */
		publishing?: (sandbox: StoredSandbox) => Partial<StoredSandbox>,
	): Promise<StoredSandbox | undefined> {
		let placement: Placement;
		const calledAt = now();
		try {
			placement = await run();
		} catch (error) {
			return fail(sandboxId, error, "starting");
		}
		// Its machine's phases, from this start: none where its backend didn't say, not a previous start's.
		const startup: computeSchema.SandboxStartup | undefined =
			placement.startup === undefined
				? undefined
				: { ...placement.startup, totalMs: Math.max(placement.startup.hostMs, now() - calledAt) };
		// The revision its backend has: what the boot sent, or what reconciling sent since.
		let applied = sent?.egressRevision;
		// Made from a template snapshot whose host had no room, it booted the template fresh elsewhere: so its record says.
		const bootedFresh = (template: computeSchema.SandboxTemplate): computeSchema.SandboxTemplate => {
			const { snapshotId: _none, ...rest } = template;
			return { ...rest, start: "boot" };
		};
		// What its publishing changes goes with every outcome once its machine exists: running, stopped for its egress, or
		// `error` with its host revoked. An upgrade's isolate is gone by then, so none of them may say it is one.
		const published = (stored: StoredSandbox): StoredSandbox =>
			publishing === undefined ? stored : { ...stored, ...publishing(stored) };
		const toRunning = (stored: StoredSandbox) => {
			const sandbox = published(stored);
			return withState(sandbox, "running", {
				hostId: placement.hostId,
				// The pool its host was in as its backend admitted it there, where it says: the one it was kept to, or for one
				// from before pools, the one it landed in.
				...pooled(placement.poolId),
				// This run's machine, which fences a late report of an earlier one's exit (`reportExit`); none where not said.
				machineAt: placement.machineAt,
				resources: placement.resources ?? sandbox.resources,
				// A microVM's shape is what its machine runs as, where its backend says: a host that can't resize a stopped or
				// live-forked machine keeps the one it had, and its next restart, fork or revival reads that, not a size it asked for.
				...(sandbox.type === "microvm" && placement.resources !== undefined
					? {
							shape: {
								vcpus: placement.resources.vcpus,
								memoryMb: placement.resources.memoryMb,
								// Its disk too, so a fork or a start from its snapshot asks for the disk it has.
								...(placement.resources.diskGb > 0 ? { diskGb: placement.resources.diskGb } : {}),
							},
						}
					: {}),
				...(placement.bootedFresh === true && sandbox.template !== undefined
					? { template: bootedFresh(sandbox.template) }
					: {}),
				// Its image is the base it booted, not the one its snapshot (perhaps a release behind) was built from.
				...(placement.bootedFresh === true && sandbox.templateBoot !== undefined
					? { image: templateBootImage(sandbox.templateBoot) }
					: {}),
				capabilities: placement.capabilities,
				health: "ok",
				startup,
				// What its root file system is now (a rebase moves it on); a backend that doesn't say leaves what it was.
				...placedBase(placement),
				...(placement.stickyDisks === undefined
					? {}
					: { stickyDisks: stickyAfter(sandbox.stickyDisks ?? [], placement.stickyDisks) }),
				...(sandbox.mounts === undefined
					? {}
					: {
							mounts: mountsAfter(sandbox.mounts, placement.mounts, {
								stored: sandbox.mountsAt,
								reported: placement.mountsAt,
							}),
							mountsAt: laterMountsAt(sandbox.mountsAt, placement.mountsAt),
						}),
				...(applied === undefined || (sandbox.egressApplied ?? Number.NEGATIVE_INFINITY) >= applied
					? {}
					: { egressApplied: applied }),
			});
		};
		const reconciles = sent !== undefined && backend.updateEgress !== undefined;
		// Running only if its egress is what its backend has (what the boot sent, at first), on every move to running:
		// the usual case, in one write.
		const upToDate = (sandbox: StoredSandbox) => !reconciles || sandbox.egressRevision === applied;
		// Its host revoked while it booted, by a scan that found it placed there (`strandOn`): its own move from `starting`
		// is its outcome, `error`, whenever it comes (now, or after its egress is reconciled), and its egress isn't waited
		// for. A host another attempt was placed on, or this one before it moved, isn't its host and doesn't count.
		const revokedUnder = (sandbox: StoredSandbox) => sandbox.strandedOn?.includes(placement.hostId) === true;
		const publish = (sandbox: StoredSandbox) =>
			revokedUnder(sandbox)
				? withState(published(sandbox), "error", { reason: HOST_REVOKED_REASON, ports: [] })
				: toRunning(sandbox);
		const ready = (sandbox: StoredSandbox) => revokedUnder(sandbox) || upToDate(sandbox);
		// Its record deleted, or being deleted, while it booted (a delete, or its account's deletion, whose destroy may have
		// come before this machine existed): what booted is destroyed, so no machine outlives its record.
		const orphaned = async () => {
			await backend.destroy(sandboxId).catch(() => undefined);
			return undefined;
		};
		let result: Awaited<ReturnType<typeof transition>>;
		try {
			result = await transition(sandboxId, "starting", publish, ready, written);
			// What its egress is made of changed while it started (a grant, its environment, the proxy settings): a change
			// skips a starting sandbox, so it is sent now, before it is running, and again for each change made while that
			// was sent. One whose egress can't be got there (its host can't enforce it, or it fails or keeps changing for
			// every round) never runs: it is stopped, as `enforceStop` does, never given up on.
			for (let round = 0; "lost" in result && result.lost.state === "starting"; round++) {
				const lost = result.lost;
				if (round >= BOOT_RECONCILE_ROUNDS) {
					const reason = "Its egress couldn't be applied to it while it started";
					if (await enforceStop(sandboxId, reason, false, lost, placement, publishing)) return undefined;
					result = await transition(sandboxId, "starting", publish, ready);
					continue;
				}
				try {
					await deliverEgress(lost);
					applied = lost.egressRevision;
				} catch (error) {
					// Refused for the egress it has still: stopped. One changed since is sent next round.
					if (unenforceable(error) && (await enforceStop(sandboxId, UNENFORCED, false, lost, placement, publishing))) {
						return undefined;
					}
					// A call that didn't get through: tried again, a moment on.
					await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** round));
				}
				result = await transition(sandboxId, "starting", publish, ready);
			}
		} catch (error) {
			if (error instanceof KantelError && error.code === "not_found") return orphaned();
			throw error;
		}
		// Deleted, or being deleted (whose destroy, on another replica, may have come before this machine existed): either
		// way the machine goes. Destroying is idempotent, so one the delete destroys too is no harm.
		if ("lost" in result && (result.lost.state === "deleted" || result.lost.state === "deleting")) return orphaned();
		if (!("moved" in result)) return undefined;
		const next = result.moved;
		if (next.state === "error") {
			await emit("sandbox.error", next.accountId, {
				sandbox: next,
				data: { previousState: "starting", reason: HOST_REVOKED_REASON },
			});
			return undefined;
		}
		// Changed again while that was sent: now it runs, an ordinary update.
		if (sent !== undefined && next.egressRevision !== applied) pushEgress([next]);
		// Its host uses its sticky disks: sent their new heads from now on.
		if (next.stickyDisks !== undefined && next.stickyDisks.length > 0) keepGoing(noteStickyRuns(next));
		await emit("sandbox.running", next.accountId, {
			sandbox: next,
			data: { previousState: "starting", ...(startup === undefined ? {} : { startup }) },
		});
		return next;
	}

	/**
	 * `ComputeService.reportHealth`: a running sandbox whose guest agent its host says doesn't answer stays `running`
	 * (its machine is up: its egress, auto-stop, idle stop and allocation go on as for any running sandbox) with `health`
	 * `unresponsive` and the host's reason, and its commands and files are refused at once (`sandbox_unresponsive`)
	 * rather than left to hang. Recover it (a reset that keeps its disk), or stop and start it; its agent answering
	 * again makes it `ok`. Reports are ordered by `healthAt`, the host's clock when it set them: one no later than the
	 * last taken is dropped, so a delayed report never undoes a newer one.
	 */
	async function reportHealth(
		hostId: string,
		sandboxId: string,
		health: string | undefined,
		reason: string | undefined,
		healthAt?: number,
	): Promise<void> {
		const unresponsive = health === "unresponsive";
		const at = typeof healthAt === "number" && Number.isSafeInteger(healthAt) && healthAt > 0 ? healthAt : undefined;
		let changed: "unresponsive" | "ok" | undefined;
		const written = await store.sandboxes.update(sandboxId, (current) => {
			changed = undefined;
			if (current.hostId !== hostId || current.state !== "running") return undefined;
			// Ordered: one no later than the last taken is older. An unstamped one (a host that doesn't stamp them) never
			// replaces a stamped one.
			if (current.healthAt !== undefined && (at === undefined || at <= current.healthAt)) return undefined;
			const stamped = at === undefined ? {} : { healthAt: at };
			if (unresponsive) {
				const why = unresponsiveReason(reason);
				if (current.health !== "unresponsive") changed = "unresponsive";
				else if (current.reason === why) return at === undefined ? undefined : { ...current, ...stamped };
				return { ...current, ...stamped, health: "unresponsive", reason: why };
			}
			if (current.health !== "unresponsive") return at === undefined ? undefined : { ...current, ...stamped };
			changed = "ok";
			return { ...current, ...stamped, health: "ok", reason: undefined };
		});
		if (changed === undefined || written === undefined) return;
		if (changed === "unresponsive") {
			await emit("sandbox.degraded", written.accountId, { sandbox: written, data: { reason: written.reason } });
		} else {
			await emit("sandbox.recovered", written.accountId, {
				sandbox: written,
				data: { reason: "Its guest agent answers again" },
			});
		}
	}

	/** `ComputeService.reportHostConnection`: its sandboxes, published as they are, for a console to read again. */
	async function reportHostConnection(hostId: string, _connected: boolean): Promise<void> {
		for (const sandbox of await store.sandboxes.list({ hostId })) {
			if (sandbox.state === "deleted") continue;
			live.publish({
				sandboxId: sandbox.id,
				accountId: sandbox.accountId,
				state: sandbox.state,
				previousState: sandbox.state,
				at: now(),
			});
		}
	}

	/**
	 * `ComputeService.reportExit`: a running sandbox whose host ended its VM is in `error`, saying why, rather than left
	 * `running` until something else touches it. Its run ends (`withState`), its ports go (an exposure ends with its next
	 * boot), and the commands Kantel had running on that machine are ended. Its disk is kept on its host, so a start
	 * boots it from there; a stop or delete works from `error` too.
	 */
	async function reportExit(
		hostId: string,
		sandboxId: string,
		error: string | undefined,
		healthAt?: number,
	): Promise<void> {
		const at = typeof healthAt === "number" && Number.isSafeInteger(healthAt) && healthAt > 0 ? healthAt : undefined;
		const reason = hostExitReason(error);
		// The machine's commands, read while it is still `running`: once it is `error` a start may boot another, whose
		// commands are its own.
		const commands = await store.commands.list({ sandboxId, state: "running" });
		const result = await transition(
			sandboxId,
			"running",
			(current) => withState(current, "error", { reason, ports: [] }),
			// Its host's, and this run's machine: both stamps are that host's clock, and a machine's stamps only move on, so
			// one before the run's machine started is an earlier machine's (a delayed event, or one from before a reconnect).
			// A run whose machine was stamped is on a host that stamps every exit, so a report without one is stale too;
			// only a run booted by a host that names no machine (one from before it did) takes an unstamped report.
			(current) =>
				current.hostId === hostId && (current.machineAt === undefined || (at !== undefined && at >= current.machineAt)),
		).catch((cause: unknown) => {
			if (cause instanceof KantelError && cause.code === "not_found") return undefined;
			throw cause;
		});
		if (result === undefined || !("moved" in result)) return;
		const next = result.moved;
		await emit("sandbox.error", next.accountId, { sandbox: next, data: { previousState: "running", reason } });
		// In the background: each is asked of its host first, which may take a while, and the report (a host's hello) needn't
		// wait for that.
		keepGoing(track([sandboxId], () => killCommandsOf(sandboxId, commands)));
	}

	/**
	 * Records `error` for work that failed, only while the sandbox is still in `from`, the passing state that work set: a
	 * stale step that lost to another call (a second stop, a delete) never writes `error` over the state that call left.
	 */
	async function fail(sandboxId: string, error: unknown, from: SandboxState): Promise<StoredSandbox | undefined> {
		const reason = messageOf(error);
		const placementReason = placementReasonOf(error);
		const result = await transition(sandboxId, from, (sandbox) =>
			withState(sandbox, "error", { reason, ...(placementReason === undefined ? {} : { placementReason }) }),
		).catch(() => undefined);
		if (result === undefined || !("moved" in result)) return undefined;
		const next = result.moved;
		await emit("sandbox.error", next.accountId, {
			sandbox: next,
			data: { previousState: from, reason, ...(placementReason === undefined ? {} : { placementReason }) },
		});
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
	): Promise<{ readonly work: Promise<void>; readonly stopping: StoredSandbox }> {
		// The record as the move to stopping found it: what is stopped (its type and machine, for its snapshot) and what a
		// handed-back stop puts back, never the caller's earlier read, which an upgrade may have changed since.
		let was = sandbox;
		const began = await transition(
			sandbox.id,
			sandbox.state,
			(current) => {
				was = current;
				return withState(current, "stopping", current.stopFor === undefined ? {} : { stopClaimedAt: now() });
			},
			still,
		);
		if (!("moved" in began)) throw new KantelError("conflict", `The sandbox is ${began.lost.state}`);
		const work = track([sandbox.id], async () => {
			try {
				await killCommandsOf(sandbox.id);
				// A stop someone asked for waits a while for a host that is away, rather than leaving the sandbox in error
				// (#737); a sweep's hands the sandbox back for a later sweep instead (`handBack`).
				const taken = await backend.stop(sandbox.id, { keepMemory, waitForHost: !handBack });
				// What it kept: a host that couldn't pause the machine (its Firecracker not answering) stops it cold, and says
				// so (`memory: false`); it is then stopped, not paused.
				const kept = keepMemory && taken.memory !== false;
				const at = now();
				const snapshot: StoredSnapshot = {
					id: randomId("snap"),
					accountId: sandbox.accountId,
					kind: "automatic",
					sandboxId: sandbox.id,
					sandboxType: was.type,
					state: "ready",
					trigger: "stop",
					memory: kept,
					...recordedMachine(was),
					sizeBytes: taken.sizeBytes,
					createdAt: at,
					expiresAt: at + AUTOMATIC_SNAPSHOT_TTL_MS,
					ref: taken.ref,
					...(taken.hostId === undefined ? {} : { hostId: taken.hostId }),
					...(taken.base === undefined ? {} : { base: taken.base }),
					...madeOnOf(taken),
					...pooled(await poolOfTaken(was, taken.ref)),
				};
				await store.snapshots.put(snapshot);
				await holdSnapshot(snapshot);
				const result = await transition(sandbox.id, "stopping", (current) =>
					withState(current, kept ? "paused" : "stopped", {
						latestSnapshotId: snapshot.id,
						latestSnapshotAt: snapshot.createdAt,
						ports: [],
						pausedSnapshotId: kept ? snapshot.id : undefined,
						// Why Kantel stopped it (its auto-stop time, a rule), for a call refused while it is stopped; until it starts.
						reason,
					}),
				);
				if (!("moved" in result)) return;
				const next = result.moved;
				await emit(kept ? "sandbox.paused" : "sandbox.stopped", next.accountId, {
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
						runs: was.runs,
						stopsAt: was.stopsAt,
						// The same machine: its guest agent's health (and why) as the stop found it.
						reason: current.health === "unresponsive" ? current.reason : undefined,
					}));
					return;
				}
				await fail(sandbox.id, error, "stopping");
				throw error;
			}
		});
		return { work, stopping: began.moved };
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
		// Not a refused save of the name still having its bytes deleted (`withdrawSave`).
		const [byName] = (await store.snapshots.list({ accountId, kind: "saved", name: from })).filter(
			(record) => record.state !== "deleting",
		);
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
		// One expiry is deleting is gone to every read.
		if (snapshot === undefined || snapshot.state === "deleting" || !(await canSeeSnapshot(principal, snapshot))) {
			throw notFound("snapshot");
		}
		requireScope(principal, scope, (await roleIn(store, principal, snapshot.accountId)) ?? "member");
		return snapshot;
	}

	/** A ready snapshot's ref naming its host (`hostRef`), for a call to that host. */
	const readyRef = (snapshot: StoredSnapshot): string => {
		const ref = hostRef(snapshot);
		if (snapshot.state !== "ready" || ref === undefined) {
			throw new KantelError("conflict", "The snapshot isn't ready");
		}
		return ref;
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
	/** The grant keys as the API answers them. */
	function grantKeysView(keys: GrantKeyring): computeSchema.GrantKeys {
		return {
			current: { id: keys.current.id, publicKey: keys.current.publicKey, since: keys.since },
			...(keys.next === undefined
				? {}
				: { next: { id: keys.next.id, publicKey: keys.next.publicKey, from: keys.next.from } }),
			retired: keys.retired.map((key) => ({ id: key.id, publicKey: key.publicKey, until: key.until })),
		};
	}

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
			readonly pool?: string;
			readonly expiresInMinutes?: number;
		},
		request: Request,
		owner?: { readonly accountId: string; readonly createdBy: string },
	): Promise<computeSchema.HostJoinToken> {
		// The pool it joins the host to, by ID: absent, its owner's default when it joins.
		const pool =
			body.pool === undefined ? undefined : await pools.poolIn(owner?.accountId ?? OPERATOR_POOLS, body.pool);
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
			...(pool === undefined ? {} : { poolId: pool.id }),
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

	/**
	 * The host a snapshot's bytes are on: its ref's (`<hostId>/<id>`, a host backend's), else its sandbox's while that
	 * is placed. Undefined when neither says.
	 */
	/**
	 * The pool a snapshot of `sandbox` at `ref` belongs to (`StoredSnapshot.poolId`): its host's, the host the ref names
	 * (else, a backend's opaque ref, the sandbox's host), where Kantel knows it; else the sandbox's pool. Absent only for a
	 * sandbox from before pools on a host with none.
	 */
	async function poolOfTaken(sandbox: StoredSandbox, ref: string | undefined): Promise<string | undefined> {
		const hostId = (ref === undefined ? undefined : refHost(ref)) ?? sandbox.hostId;
		const host = hostId === undefined ? undefined : await store.hosts.get(hostId);
		return host?.poolId ?? sandbox.poolId;
	}

	async function hostOfSnapshot(snapshot: StoredSnapshot): Promise<string | undefined> {
		const named = snapshot.hostId ?? (snapshot.ref === undefined ? undefined : refHost(snapshot.ref));
		if (named !== undefined) return named;
		if (snapshot.sandboxId === undefined) return undefined;
		return (await store.sandboxes.get(snapshot.sandboxId))?.hostId;
	}

	/**
	 * The refs of `hostId` that saved records of `saved` hold, each with its size by `sizeOf`; records of the same ref (a
	 * save that shares its source's) count once. A record being deleted holds nothing.
	 */
	async function savedRefsOn(
		hostId: string,
		saved: readonly StoredSnapshot[],
		sizeOf: (record: StoredSnapshot) => number = (record) => record.sizeBytes ?? 0,
	): Promise<Map<string, number>> {
		const held = new Map<string, number>();
		for (const record of saved) {
			if (record.kind !== "saved" || record.state === "deleting" || record.ref === undefined) continue;
			if ((await hostOfSnapshot(record)) !== hostId) continue;
			held.set(record.ref, Math.max(held.get(record.ref) ?? 0, sizeOf(record)));
		}
		return held;
	}

	/**
	 * `saved` with a full size for each live save on `hostId` recorded before full sizes were (`fullSizeBytes`), whose
	 * `sizeBytes` may count files it shares for another holder only: read from the host now (`snapshotSizes`, as the
	 * refresh reads it) and written back. A host that doesn't measure its snapshots never attributed their sizes, which
	 * stand. A host that can't answer refuses the save, `unavailable`, rather than count less than the saves keep.
	 */
	async function withFullSizes(hostId: string, saved: readonly StoredSnapshot[]): Promise<readonly StoredSnapshot[]> {
		const legacy: StoredSnapshot[] = [];
		for (const record of saved) {
			if (record.fullSizeBytes !== undefined || record.state === "deleting" || record.ref === undefined) continue;
			if ((await hostOfSnapshot(record)) === hostId) legacy.push(record);
		}
		if (legacy.length === 0 || backend.snapshotSizes === undefined) return saved;
		let sizes: ReadonlyMap<string, number> | undefined;
		try {
			sizes = await backend.snapshotSizes(hostId);
		} catch {
			throw new KantelError(
				"unavailable",
				"The host couldn't say how much its saved snapshots take, which its limit on saved snapshots needs. Try again once it's back.",
			);
		}
		if (sizes === undefined) return saved;
		const filled = new Map<string, StoredSnapshot>();
		for (const record of legacy) {
			const fullSizeBytes = record.ref === undefined ? undefined : sizes.get(record.ref);
			if (fullSizeBytes === undefined) continue;
			filled.set(record.id, { ...record, fullSizeBytes });
			await store.snapshots
				.update(record.id, (current) =>
					current.ref === record.ref && current.fullSizeBytes === undefined ? { ...current, fullSizeBytes } : undefined,
				)
				.catch(() => undefined);
		}
		return saved.map((record) => filled.get(record.id) ?? record);
	}

	/** A save's full size, its shared files included, which a host's limit counts it at (`fullSizeBytes`). */
	const fullSize = (record: StoredSnapshot): number => record.fullSizeBytes ?? record.sizeBytes ?? 0;

	/**
	 * A host's disk as the API answers it (`Host.diskUsage`): the snapshots the host measured, split by this plane's
	 * records, as the host can't tell (`BackendDiskUsage`). Saved: what the saved records on it hold of the files the
	 * host counted as snapshots, by its split by snapshot in this very measure (each saved ref's own files, and each
	 * group a saved one holds, once), so files it counted elsewhere first (a stop's memory, a bundle drive, another
	 * filesystem's) are in neither; automatic: the rest. A ref its split doesn't name (an isolate's, whose snapshots are
	 * its sandbox's files) counts nothing. From a backend that doesn't split, the records' sizes, at most the snapshots
	 * in all. For display only: the limit counts by full sizes (`savedBytesOver`).
	 */
	async function diskView(hostId: string, measure: BackendDiskUsage): Promise<computeSchema.HostDiskUsage> {
		const { snapshotsBytes, snapshotOwnBytes, snapshotShared, ...rest } = measure;
		const held = await savedRefsOn(hostId, await store.snapshots.list({ kind: "saved" }));
		let saved = 0;
		if (snapshotOwnBytes !== undefined) {
			for (const ref of held.keys()) saved += snapshotOwnBytes[ref] ?? 0;
			for (const group of snapshotShared ?? []) {
				if (group.refs.some((ref) => held.has(ref))) saved += group.bytes;
			}
		} else {
			// An isolate's snapshots are among its sandbox's files on the host, not its snapshots.
			const microvm = (await store.snapshots.list({ kind: "saved" })).filter(
				(record) => record.sandboxType !== "isolate",
			);
			for (const size of (await savedRefsOn(hostId, microvm)).values()) saved += size;
		}
		saved = Math.min(saved, snapshotsBytes);
		return { ...rest, savedSnapshotsBytes: saved, automaticSnapshotsBytes: snapshotsBytes - saved };
	}

	/**
	 * The `exhausted` error when an account's saved snapshots on a host are past the host's limit
	 * (`Host.savedSnapshotBytesLimit`), or undefined when they aren't or it sets none. Each saved snapshot counts at its
	 * full size (`fullSizeBytes`), the files it shares with others included: copies that share files count apart, so the
	 * total is never less than what they keep, however they share. Records of the same ref (a save that shares its
	 * source's) count once. A save being deleted counts nothing, nor does `replacing`, the save a new one replaces;
	 * others still `creating` count, as they may yet be let through.
	 *
	 * `adding`: a save's own record, stored already (`creating`, `admitSave`). Without one (a live save about to take
	 * its bytes), the limit reached already refuses.
	 */
	async function savedBytesOver(
		accountId: string,
		hostId: string | undefined,
		replacing: StoredSnapshot | undefined,
		adding?: StoredSnapshot,
	): Promise<KantelError | undefined> {
		if (hostId === undefined) return undefined;
		const limit = (await store.hosts.get(hostId))?.savedSnapshotBytesLimit;
		if (limit === undefined) return undefined;
		const records = await withFullSizes(
			hostId,
			(await store.snapshots.list({ accountId, kind: "saved" })).filter(
				(saved) => saved.id !== replacing?.id && saved.id !== adding?.id,
			),
		);
		const held = await savedRefsOn(hostId, records, fullSize);
		let total = 0;
		for (const size of held.values()) total += size;
		const own = adding?.ref === undefined || held.has(adding.ref) ? 0 : fullSize(adding);
		if (adding === undefined ? total < limit : total + own <= limit) return undefined;
		return new KantelError(
			"exhausted",
			`The account may keep ${bytesText(limit)} of saved snapshots on this host, and has ${bytesText(total)}` +
				(own > 0 ? `; this one is ${bytesText(own)}` : "") +
				". Delete saved snapshots you no longer need, and try again.",
		);
	}

	/**
	 * Admits a save's record against its host's limit on saved snapshot bytes (`savedBytesOver`): stored first,
	 * `creating`, so every other save counts it from then on, on any gateway; then the account's total read again with
	 * it in, and the record made `ready` only when that fits. Of two saves at once, the one that reads second counts
	 * both: both may be refused, never both let through. Refused, or failing on the way, the record is taken back
	 * (`withdrawSave`) and the error thrown. One whose gateway died on the way is taken back by the sweep once it is
	 * `SAVE_ADMISSION_LEASE_MS` old; `ready` is written only over `creating` (compare-and-set), so an admission the sweep
	 * took back meanwhile fails, `conflict`, its bytes already released.
	 */
	async function admitSave(snapshot: StoredSnapshot, replacing: StoredSnapshot | undefined): Promise<StoredSnapshot> {
		await store.snapshots.put({ ...snapshot, state: "creating" });
		try {
			const over = await savedBytesOver(snapshot.accountId, await hostOfSnapshot(snapshot), replacing, snapshot);
			if (over !== undefined) throw over;
			const ready = await store.snapshots.update(snapshot.id, (latest) =>
				latest.state === "creating" ? { ...latest, state: "ready" } : undefined,
			);
			if (ready === undefined) {
				throw new KantelError("conflict", "The snapshot was deleted, or given up on, while it was being saved");
			}
			return ready;
		} catch (error) {
			await withdrawSave(snapshot.id).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * Takes back a save's record that wasn't admitted (`admitSave`) as expiry deletes a snapshot: settling, then its
	 * bytes deleted unless another record has their ref (a save that shares its source's), then the record
	 * (`releaseBytes`). A host that can't delete them now leaves it settling, and the sweep (`expireSnapshots`) tries
	 * again, so bytes taken for a refused save are never left on the host unrecorded.
	 */
	async function withdrawSave(snapshotId: string, expiredBy?: number): Promise<void> {
		const settling = await store.snapshots.update(snapshotId, (latest) =>
			latest.state !== "creating" || (expiredBy !== undefined && latest.createdAt + SAVE_ADMISSION_LEASE_MS > expiredBy)
				? undefined
				: {
						...latest,
						state: "deleting",
						retiring: { by: retireOwner, token: randomId("ret"), at: now(), settling: true },
					},
		);
		if (settling !== undefined) await releaseBytes(settling);
	}

	async function changeHost(
		host: StoredHost,
		body: {
			readonly name?: string;
			readonly labels?: { readonly [key: string]: string };
			readonly draining?: boolean;
			readonly pool?: string;
			readonly savedSnapshotBytesLimit?: number | null;
		},
	): Promise<computeSchema.Host> {
		if (host.state === "revoked") throw new KantelError("conflict", "The host is revoked");
		// A move to another pool of its owner's (`moveHost`), made on its own.
		if (body.pool !== undefined) {
			if (
				body.name !== undefined ||
				body.labels !== undefined ||
				body.draining !== undefined ||
				body.savedSnapshotBytesLimit !== undefined
			) {
				throw new KantelError("invalid", "Move a host to another pool on its own, with no other change");
			}
			return hostView(await moveHost(host, await pools.poolIn(poolOwnerOf(host), body.pool)));
		}
		// A drain or undrain takes the next place in order here first (an undrain ending the drain here with it, so a move
		// checked under the drain won't land), then is told the registry with it, which takes it only over an older one.
		let epoch: number | undefined;
		if (body.draining !== undefined) {
			const draining = body.draining;
			const ordered = await store.hosts.update(host.id, (current) => {
				if (current.state === "revoked") return undefined;
				const next = (current.drainEpoch ?? 0) + 1;
				return {
					...current,
					drainEpoch: next,
					...(draining === false && current.state === "draining" ? { state: "online" as const } : {}),
				};
			});
			if (ordered === undefined) throw new KantelError("conflict", "The host is revoked");
			epoch = ordered.drainEpoch;
		}
		await backend.updateHost?.(host.id, {
			...(body.name === undefined ? {} : { name: body.name }),
			...(body.labels === undefined ? {} : { labels: { ...body.labels } }),
			...(body.draining === undefined ? {} : { draining: body.draining, drainEpoch: epoch }),
		});
		// On the record as it is now: a revocation that landed meanwhile stays (and the change is refused).
		let revoked = false;
		const updated = await store.hosts.update(host.id, (current) => {
			revoked = current.state === "revoked";
			if (revoked) return undefined;
			let state = current.state;
			// A drain only while it is still the latest: a later undrain stands.
			if (body.draining === true && current.drainEpoch === epoch) state = "draining";
			const { savedSnapshotBytesLimit: kept, ...rest } = current;
			const limit = body.savedSnapshotBytesLimit === undefined ? kept : (body.savedSnapshotBytesLimit ?? undefined);
			return {
				...rest,
				name: body.name ?? current.name,
				labels: body.labels === undefined ? current.labels : { ...body.labels },
				state,
				...(limit === undefined ? {} : { savedSnapshotBytesLimit: limit }),
			};
		});
		if (revoked) throw new KantelError("conflict", "The host is revoked");
		if (updated === undefined) throw new KantelError("not_found", "No such host");
		return hostView(updated);
	}

	/**
	 * Asks the backend to move a host to the version it should run, and records that it's on its way (`updating`) until
	 * the host connects on it.
	 */
	async function updateHostAgentOf(host: StoredHost): Promise<computeSchema.Host> {
		if (host.state === "revoked") throw new KantelError("conflict", "The host is revoked");
		if (backend.updateHostAgent === undefined) {
			throw new KantelError("not_supported", "This deployment's hosts aren't updated from the control plane");
		}
		const { version } = await backend.updateHostAgent(host.id);
		const updating = { version, requestedAt: now() };
		const updated = await store.hosts.update(host.id, (current) => ({ ...current, updating }));
		return hostView(updated ?? { ...host, updating });
	}

	/**
	 * Whether an account takes new records: it exists, and its person's account deletion hasn't closed it
	 * (`StoredAccount.closedAt`). Closing is for good, so what lands in a closed account is always the deletion's to
	 * clear: a write checks before it starts and again once it has written, and undoes itself if the account closed
	 * meanwhile. Of a write and a deletion that overlap, one always sees the other: the deletion's sweep finds what was
	 * written before its close, and anything written after finds the account closed.
	 */
	async function accountOpen(accountId: string): Promise<boolean> {
		const account = await store.accounts.get(accountId);
		return account !== undefined && account.closedAt === undefined;
	}

	const accountClosed = (): KantelError => new KantelError("conflict", "This account is being deleted");

	/**
	 * A sandbox of an account being deleted: its machine destroyed (a boot under way destroys what it makes once it finds
	 * the record gone), then its snapshots, commands and record.
	 */
	async function forgetSandbox(sandbox: StoredSandbox): Promise<void> {
		if (sandbox.state !== "deleted") {
			await killCommandsOf(sandbox.id);
			await backend.destroy(sandbox.id);
		}
		for (const snapshot of await store.snapshots.list({ sandboxId: sandbox.id })) {
			await forgetSnapshot(snapshot);
			await releaseRef(snapshot);
		}
		for (const command of await store.commands.list({ sandboxId: sandbox.id })) await store.commands.delete(command.id);
		await store.sandboxes.delete(sandbox.id);
	}

	/**
	 * One pass of a person's account deletion (`StoredDeletion`). Every step can be made again, and finds only what is
	 * left, so a pass that fails partway is finished by the next, and the last pass clears whatever writes already under
	 * way when the account closed stored since the first.
	 */
	async function deletionPass(job: StoredDeletion): Promise<void> {
		const userId = job.id;
		const principal: PersonPrincipal = {
			kind: "person",
			userId,
			name: job.name,
			superAdmin: false,
			personalAccountId: job.personalAccountId,
			...(job.email === undefined ? {} : { email: job.email }),
		};
		// Retired first, for good: from here nothing more is made for them (`PersonWrites`), so what the accounts below hold
		// is all there will be. Their record stays, with nothing of theirs but their ID, so no sign-in makes them afresh.
		await retireUser(job);
		// Every personal account of theirs: the one the deletion began with, the one a sign-in racing it would make
		// (`personalAccountIdOf`, written before the deletion was recorded, as one written after undid itself), and any other
		// their memberships name.
		const personal = new Set([job.personalAccountId, personalAccountIdOf(userId)]);
		const memberships = await store.members.list({ userId });
		for (const member of memberships) {
			const account = await store.accounts.get(member.accountId);
			if (account === undefined || account.kind === "personal") personal.add(member.accountId);
		}
		// No host joins with a token of theirs before the accounts' hosts are revoked below.
		for (const token of await store.joinTokens.list({ createdBy: userId })) {
			if (token.usedAt === undefined) await store.joinTokens.delete(token.id);
		}
		for (const accountId of personal) await clearPersonalAccount(accountId, job.startedAt);
		// They leave each organisation as `removeMember` has a member leave: their private sandboxes stay, stopped.
		for (const member of memberships) {
			if (personal.has(member.accountId)) continue;
			for (const sandbox of await store.sandboxes.list({ accountId: member.accountId, ownerUserId: userId })) {
				if (sandbox.visibility === "private" && sandbox.state === "running") {
					keepGoing((await beginStop(sandbox, false, "Its person deleted their account", principal)).work);
				}
			}
			await store.members.delete(member.id);
		}
		// Every key that acts for them, in any account (one stored after this works nowhere either: `ownerRemains`).
		const keys = await store.apiKeys.list({ ownerUserId: userId });
		for (const key of keys) {
			if (key.revokedAt === undefined) await store.apiKeys.put({ ...key, revokedAt: now() });
		}
		// And every personal access token of theirs.
		const tokens = await store.personalTokens.list({ userId });
		for (const token of tokens) {
			if (token.revokedAt === undefined) await store.personalTokens.put({ ...token, revokedAt: now() });
		}
		// And the answers kept for their retries (`once`), theirs, their keys' and their tokens': some hold what they made.
		const callers = [
			`user:${userId}:`,
			...keys.map((key) => `key:${key.id}:`),
			...tokens.map((token) => `pat:${token.id}:`),
		];
		for (const kept of await store.idempotency.list()) {
			if (callers.some((caller) => kept.id.startsWith(caller))) await store.idempotency.delete(kept.id);
		}
		// Signed out and forgotten by sign-in: on every pass, so a session made as the first ran goes in the last.
		await options.deletePerson?.(userId);
	}

	/** Retires a person's user record (`StoredUser.retiredAt`), making a retired one should theirs be missing. */
	async function retireUser(job: StoredDeletion): Promise<void> {
		const retired = (current?: StoredUser): StoredUser => ({
			id: job.id,
			name: "",
			superAdmin: false,
			personalAccountId: current?.personalAccountId ?? job.personalAccountId,
			createdAt: current?.createdAt ?? job.startedAt,
			retiredAt: now(),
		});
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await store.users.get(job.id);
			if (current?.retiredAt !== undefined) return;
			if (current === undefined) {
				if (await store.users.insert(retired())) return;
				continue;
			}
			if (
				(await store.users.update(job.id, (latest) =>
					latest.retiredAt === undefined ? retired(latest) : undefined,
				)) !== undefined
			) {
				return;
			}
		}
		throw new KantelError("unavailable", "The person kept changing while they were retired; the deletion tries again");
	}

	/**
	 * A personal account of a person being deleted, cleared and removed: closed for good first (`accountOpen`), then
	 * everything it holds. Every step finds only what is left, so it can be made again.
	 */
	async function clearPersonalAccount(accountId: string, startedAt: number): Promise<void> {
		await store.accounts.update(accountId, (account) =>
			account.closedAt === undefined ? { ...account, closedAt: now() } : undefined,
		);
		for (const token of await store.joinTokens.list({ accountId })) await store.joinTokens.delete(token.id);
		// Sandboxes (their machines destroyed), saved snapshots, bundles (bytes and all).
		for (const sandbox of await store.sandboxes.list({ accountId })) await forgetSandbox(sandbox);
		for (const snapshot of await store.snapshots.list({ accountId })) {
			await forgetSnapshot(snapshot);
			await releaseRef(snapshot);
		}
		for (const bundle of await store.bundles.list({ accountId })) {
			if (mounts === undefined) throw new KantelError("unavailable", "Bundles can't be deleted while mounts are off");
			await mounts.forgetBundle(bundle);
		}
		// Its templates before its hosts: a template cache's bytes go only over its host's connection, which revoking the
		// host ends for good. So the pass waits (fails, to be made again) while an entry on a host of the account's is still
		// being removed, connected now or not, as one away may come back and finish; for `DELETION_HOST_WAIT_MS` from the
		// deletion's start, after which a host that hasn't is revoked all the same.
		await templates.retireAccount(accountId);
		const own = (await ensureHosts()).filter((host) => host.accountId === accountId && host.state !== "revoked");
		if (own.length > 0 && now() - startedAt < DELETION_HOST_WAIT_MS) {
			const ownIds = new Set(own.map((host) => host.id));
			const waiting = (await store.templateSnapshots.list({ accountId })).filter(
				(entry) => entry.hostId !== undefined && ownIds.has(entry.hostId),
			);
			if (waiting.length > 0) {
				throw new KantelError("unavailable", "The account's template caches are still being removed from its hosts");
			}
		}
		// Its hosts: a revoke that can't be made fails the pass, to be made again.
		for (const host of own) await revokeStoredHost(host);
		for (const source of await store.bucketSources.list({ accountId })) await store.bucketSources.delete(source.id);
		for (const invite of await store.invites.list({ accountId })) await store.invites.delete(invite.id);
		for (const webhook of await store.webhooks.list({ accountId })) await store.webhooks.delete(webhook.id);
		for (const delivery of await store.deliveries.list({ accountId })) await store.deliveries.delete(delivery.id);
		// Its GitHub runners' and sticky disks' records: their sandboxes went with the account's.
		await forgetGithubRunners(accountId);
		await forgetStickyDisks(accountId);
		for (const environment of await store.environments.list({ accountId })) {
			await store.environments.delete(environment.id);
		}
		for (const event of await store.events.list({ accountId })) await store.events.delete(event.id);
		for (const entry of await store.egress.list({ accountId })) await store.egress.delete(entry.id);
		await store.telemetry.delete(accountId);
		await store.proxies.delete(accountId);
		for (const pool of await store.pools.list({ owner: accountId })) await store.pools.delete(pool.id);
		// The account before its memberships: should what follows fail, a membership left names it, for the next pass.
		await store.accounts.delete(accountId);
		for (const member of await store.members.list({ accountId })) await store.members.delete(member.id);
	}

	/**
	 * The soonest a running deletion's next pass can be taken, or undefined with none: its due time, or, while a pass
	 * holds it, when that pass's lease runs out (should it die, the next takes over then).
	 */
	async function nextDeletionDue(): Promise<number | undefined> {
		const due = (await store.deletions.list({ stage: "running" })).map((deletion) =>
			Math.max(deletion.dueAt, deletion.lease?.until ?? 0),
		);
		return due.length === 0 ? undefined : Math.min(...due);
	}

	/** Asks the deployment to wake at `at` (`ComputeServiceOptions.wakeAt`), and waits: a failure is the caller's. */
	async function wake(at: number): Promise<void> {
		await options.wakeAt?.(at);
	}

	/** Asks the deployment to wake for the soonest next deletion pass. */
	async function wakeForDeletions(): Promise<void> {
		const at = await nextDeletionDue();
		if (at !== undefined) await wake(at);
	}

	async function carryOnDeletion(userId: string): Promise<void> {
		const token = randomSlug(12);
		// Only a running deletion whose pass is due now, as stored now: a caller holding an older copy can't bring its last
		// pass forward, nor take one another gateway is carrying on.
		const job = await store.deletions.update(userId, (current) =>
			current.stage !== "running" ||
			current.dueAt > now() ||
			(current.lease !== undefined && current.lease.until > now())
				? undefined
				: { ...current, lease: { token, until: now() + DELETION_LEASE_MS } },
		);
		if (job === undefined) return;
		const mine = (current: StoredDeletion) => current.lease?.token === token;
		// A wake for when this lease runs out, before any work: should this pass die, the next takes over then.
		await wake(job.lease?.until ?? now() + DELETION_LEASE_MS);
		const released = ({ lease: _lease, ...current }: StoredDeletion) => current;
		try {
			await deletionPass(job);
		} catch (error) {
			const attempts = job.attempts + 1;
			await store.deletions.update(userId, (current) =>
				mine(current)
					? {
							...released(current),
							attempts,
							lastError: messageOf(error),
							dueAt: now() + Math.min(DELETION_RETRY_MS * 2 ** (attempts - 1), DELETION_RETRY_MAX_MS),
						}
					: undefined,
			);
			await wakeForDeletions();
			throw error;
		}
		if (job.clearedAt === undefined) {
			await store.deletions.update(userId, (current) => {
				if (!mine(current)) return undefined;
				const { lastError: _error, ...rest } = released(current);
				return { ...rest, clearedAt: now(), dueAt: now() + DELETION_LAST_PASS_MS, attempts: 0 };
			});
			await wakeForDeletions();
		} else {
			// Done: kept as the user ID alone, for good, so it is never let in or made afresh again.
			await store.deletions.update(userId, (current) =>
				mine(current)
					? {
							id: current.id,
							stage: "done",
							personalAccountId: current.personalAccountId,
							name: "",
							startedAt: current.startedAt,
							clearedAt: now(),
							dueAt: Number.MAX_SAFE_INTEGER,
							attempts: 0,
						}
					: undefined,
			);
		}
	}

	/**
	 * A snapshot, once stored: forgotten, its bytes released as a delete does (`forgetSnapshot`, `releaseRef`), if its
	 * account has closed or gone meanwhile, so a snapshot taken as the account was deleted never outlives it.
	 */
	async function holdSnapshot(snapshot: StoredSnapshot): Promise<void> {
		if (await accountOpen(snapshot.accountId)) return;
		await forgetSnapshot(snapshot);
		await releaseRef(snapshot);
		throw accountClosed();
	}

	/** New sandboxes, once stored: forgotten, before anything boots or anyone sees them, if their account has closed. */
	async function holdAccount(accountId: string, sandboxIds: readonly string[]): Promise<void> {
		if (await accountOpen(accountId)) return;
		for (const id of sandboxIds) await store.sandboxes.delete(id);
		throw accountClosed();
	}

	async function revokeStoredHost(host: StoredHost): Promise<computeSchema.Host> {
		if (backend.revokeHost !== undefined) await backend.revokeHost(host.id);
		else if (!(await backend.capabilities()).hosts.some((known) => known.id === host.id)) {
			// Its credential is with a backend that isn't running here now (account hosts, switched off): marked revoked,
			// it would still sign in once that backend is back.
			throw new KantelError("unavailable", HOST_NOT_REVOCABLE);
		}
		const revoked = await store.hosts.update(host.id, (current) => ({ ...current, state: "revoked" }));
		await strandOn(host.id);
		// Its copies of saved snapshots no longer count: each is made again on another host from the one left.
		keepGoing(keepEverySnapshotsCopies());
		return hostView(revoked ?? { ...host, state: "revoked" });
	}

	/**
	 * The sandboxes of a revoked host: it never connects again, so none of them can be reached, run or started there, and
	 * none is claimed to. Each whose record names the host is `error`, saying so, for its owner to delete, which writes it
	 * off; one being deleted is left to its delete. A first create or fork under way there doesn't name its host until
	 * its boot writes `running`: it is found by where its backend placed it (recorded before the host was asked to make
	 * it), and marked (`strandedOn`) rather than moved, because only its boot knows which host it ends up on. Its boot's
	 * one move from `starting` is then `error` if that host is marked (`boot`). A boot that writes `running` before the
	 * scan's write is found here by its host either way.
	 *
	 * A lookup or write that fails fails the revocation, which may be made again to finish, its host revoked already.
	 */
	async function strandOn(hostId: string): Promise<void> {
		const unattributed =
			backend.placedOn === undefined
				? []
				: (await store.sandboxes.list({ state: "starting" })).filter((sandbox) => sandbox.hostId === undefined);
		const placedHere: StoredSandbox[] = [];
		for (const sandbox of unattributed) {
			if ((await backend.placedOn?.(sandbox.id)) === hostId) placedHere.push(sandbox);
		}
		for (const sandbox of [...(await store.sandboxes.list({ hostId })), ...placedHere]) {
			// From whatever it is when written, not as listed: a boot or stop that lands in between is still caught.
			let previous: SandboxState | undefined;
			await store.sandboxes.update(sandbox.id, (current) => {
				previous = undefined;
				if (current.hostId === hostId && STRANDABLE.includes(current.state)) {
					previous = current.state;
					return withState(current, "error", { reason: HOST_REVOKED_REASON, ports: [] });
				}
				if (current.hostId === undefined && current.state === "starting") {
					if (current.strandedOn?.includes(hostId) === true) return undefined;
					return { ...current, strandedOn: [...(current.strandedOn ?? []), hostId] };
				}
				// Moved on since (deleted, being deleted, on another host now): left.
				return undefined;
			});
			const stranded = previous === undefined ? undefined : await store.sandboxes.get(sandbox.id);
			if (stranded === undefined || previous === undefined) continue;
			await emit("sandbox.error", stranded.accountId, {
				sandbox: stranded,
				data: { previousState: previous, reason: HOST_REVOKED_REASON },
			});
		}
	}

	/**
	 * Takes the key's claim for `claim` by inserting it. Answers the first call's stored record when it has answered, and
	 * `true` when the claim is now `claim`'s. A key kept for a different request (another `fingerprint`) is `refused`,
	 * whatever its state. A key another call holds is `conflict`: while it works, retry later; once its claim lapsed (its
	 * gateway stalled or died), for good (`CLAIM_LAPSED`). A lapsed claim is never taken over, because its holder may yet
	 * go on and do the work too: whether it took effect is the caller's to check, under a new key.
	 */
	async function claimKey(id: string, claim: string, fingerprint: string): Promise<StoredIdempotency | true> {
		const claimed = { id, createdAt: now(), fingerprint, claim, claimExpiresAt: now() + IDEMPOTENCY_CLAIM_MS };
		// Twice at most: the claim may be released (its call failed) between the insert and the read.
		for (let attempt = 0; attempt < 2; attempt++) {
			if (await store.idempotency.insert(claimed)) return true;
			const found = await store.idempotency.get(id);
			if (found === undefined) continue;
			if (!sameRequest(found, fingerprint)) throw keyReused();
			if (found.body !== undefined) return found;
			if ((found.claimExpiresAt ?? 0) <= now())
				throw new KantelError("conflict", CLAIM_LAPSED, { idempotencyKey: "held" });
			break;
		}
		throw new KantelError(
			"conflict",
			"A call with this Idempotency-Key is still in progress; retry it with the same key once that call has answered",
			{ idempotencyKey: "in_progress" },
		);
	}

	/** The first call's answer again, from its stored record. */
	async function storedAnswer<T>(record: StoredIdempotency): Promise<T> {
		const body = record.body as string;
		if (record.secret === "withheld")
			throw new KantelError("conflict", ANSWER_WITHHELD, { idempotencyKey: "withheld" });
		if (record.secret === "sealed") {
			const opened = await requireSealer().openText(JSON.parse(body) as SealedValue, idempotencyAad(record.id));
			return JSON.parse(opened) as T;
		}
		return JSON.parse(body) as T;
	}

	/**
	 * Answers an idempotent call's first answer again for the same caller, operation and key, on every gateway. The key is
	 * claimed before the work starts, so only one call does it: a call with the same key while it works waits for it on
	 * this gateway, and is `conflict` on another. The claim is renewed while the work runs and lapses
	 * `IDEMPOTENCY_CLAIM_MS` after the last renewal: a retry of a call whose gateway stalled or died is then `conflict` for
	 * good, never done again under the key, since the stalled call may still finish (`claimKey`). A call refused
	 * before it did anything (`REFUSALS`) releases the key, so a retry does the work; any other failure keeps it, lapsed.
	 *
	 * The key is kept with a fingerprint of the request (its path parameters, query and body), so the same key with a
	 * different request is `refused` rather than answered with another call's answer. An answer that holds a secret
	 * (`secret`), such as a new API key's, is kept sealed with the deployment's secrets key; where there is none it isn't
	 * kept at all, and a retry is `conflict`, saying so, rather than doing the work again.
	 */
	async function once<T>(
		principal: Principal,
		operation: string,
		input: {
			readonly params?: unknown;
			readonly query?: unknown;
			readonly body?: unknown;
			readonly idempotencyKey?: string;
		},
		work: () => Promise<T>,
		options: {
			readonly secret?: true;
			/** Keep no copy of the secret answer, as with no secrets key: for one no retry could sign in to fetch. */
			readonly withhold?: true;
		} = {},
	): Promise<T> {
		const key = input.idempotencyKey;
		if (key === undefined) return work();
		// Each credential its own: a personal token never gets an answer its person, or another of their tokens, was given,
		// which may hold a credential it couldn't make itself (and its default account may differ).
		const caller =
			principal.kind === "key"
				? `key:${principal.keyId}`
				: principal.token !== undefined
					? `pat:${principal.token.id}`
					: `user:${principal.userId}`;
		const id = `${caller}:${operation}:${key}`;
		const fingerprint = await sha256Hex(canonicalJson({ params: input.params, query: input.query, body: input.body }));
		const running = inflight.get(id);
		if (running !== undefined) {
			if (running.fingerprint !== fingerprint) throw keyReused();
			return running.promise as Promise<T>;
		}
		const promise = (async () => {
			const claim = randomId("claim");
			const held = await claimKey(id, claim, fingerprint);
			if (held !== true) return storedAnswer<T>(held);
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
			// Only while the claim is still this call's: one that lapsed (this gateway stalled) and was taken over is the
			// other call's to answer or release, so this one neither deletes nor overwrites what that one keeps.
			const holding = (current: StoredIdempotency) => current.claim === claim && current.body === undefined;
			let answer: T;
			try {
				answer = await work();
			} catch (error) {
				clearInterval(renew);
				// A refusal frees the key, for a retry to do the work. Any other failure may have come after an effect (a write
				// done, a host call sent and never answered): its key stays held, lapsed, so a retry is `CLAIM_LAPSED`.
				if (refusedBeforeEffects(error)) await store.idempotency.deleteIf(id, holding).catch(() => undefined);
				else {
					await store.idempotency
						.update(id, (current) => (holding(current) ? { ...current, claimExpiresAt: 0 } : undefined))
						.catch(() => undefined);
				}
				throw error;
			}
			clearInterval(renew);
			const text = JSON.stringify(answer);
			const kept: Pick<StoredIdempotency, "body" | "secret"> =
				options.secret !== true
					? { body: text }
					: sealer === undefined || options.withhold === true
						? { body: "null", secret: "withheld" }
						: { body: JSON.stringify(await sealer.seal(text, idempotencyAad(id))), secret: "sealed" };
			await store.idempotency.update(id, (current) =>
				holding(current) ? { id, ...kept, fingerprint, createdAt: now() } : undefined,
			);
			return answer;
		})();
		inflight.set(id, { fingerprint, promise });
		try {
			return await promise;
		} finally {
			inflight.delete(id);
		}
	}

	// Usage: what hosts report every tick (`recordUsage`), kept in `sandboxSeries` and `hostSeries` (usage-series.ts).
	// A sandbox's 5-minute means go into its record's `samples`, which its sparkline and `points` are read from.

	/**
	 * Keeps a sandbox's closed 5-minute mean in its record, oldest first, a day of them and hourly means before it
	 * (`keptSamples`). Only a replica that took
	 * some of its readings itself keeps one: one that was only passed them on may have joined part way through. Of two
	 * for the same 5 minutes (the host moved replica within them, and each kept what it had), the one of more readings.
	 */
	async function keepRollup(sandboxId: string, rollup: Rollup): Promise<void> {
		if (!rollup.local) return;
		await patchSandbox(sandboxId, (latest) => {
			const peak = peakWith(latest.peak, rollup);
			const peaked = peak === latest.peak ? undefined : { ...latest, peak };
			// A deleted sandbox keeps no more means, but its last 5 minutes (closed once it stopped reporting) may hold its peak.
			if (latest.state === "deleted") return peaked;
			const sample = sampleOf(rollup);
			const index = latest.samples.findIndex((each) => each.at >= rollup.at);
			if (index === -1) return { ...latest, peak, samples: keptSamples([...latest.samples, sample]) };
			const there = latest.samples[index];
			if (there?.at !== rollup.at) return peaked;
			// The fuller mean is kept, but the highest readings of both: the other may have seen a peak this one didn't.
			const fuller = (there.readings ?? Number.POSITIVE_INFINITY) >= rollup.readings ? there : sample;
			const merged = withHighest(fuller, there, sample);
			if (merged === there) return peaked;
			return { ...latest, peak, samples: latest.samples.map((each, at) => (at === index ? merged : each)) };
		});
	}

	/** `mean` with the higher of `a`'s and `b`'s highest CPU and memory (a mean stands for its own where it has none). */
	function withHighest(mean: StoredSample, a: StoredSample, b: StoredSample): StoredSample {
		const cpuMax = Math.max(a.cpuMax ?? a.cpu, b.cpuMax ?? b.cpu);
		const memoryMbMax = Math.max(a.memoryMbMax ?? a.memoryMb, b.memoryMbMax ?? b.memoryMb);
		if (mean.cpuMax === cpuMax && mean.memoryMbMax === memoryMbMax) return mean;
		return { ...mean, cpuMax, memoryMbMax };
	}

	/**
	 * Keeps the 5-minute means that ended with no point to close them (a sandbox that stopped), once every tick that
	 * could be in them is: the stub's are taken in first (`catchUpUsage`), and nothing is settled past the time they are
	 * in to (`settleTaken`), so a 5 minutes is never closed with its later ticks still to come. The one way to settle, but
	 * for the replay's own once its ticks are in (`replay`).
	 */
	async function settleUsage(): Promise<void> {
		await catchUpUsage();
		// A replay begun meanwhile settles when it ends.
		if (replaying !== undefined) return;
		await settleTaken();
	}

	/**
	 * Settles what the series hold, as of the time the backend's own ticks are in to (`pulledUntil`, for a backend that
	 * makes them; else now), however long taking them in took: a 5 minutes ending after that may have ticks still to
	 * fetch. Only after the stub's ticks are in (`settleUsage`, `replay`).
	 */
	async function settleTaken(): Promise<void> {
		settledAt = now();
		const asOf = backend.usageReports === undefined ? now() : Math.min(now(), pulledUntil);
		hostSeries.settle(asOf);
		for (const { key, rollup } of sandboxSeries.settle(asOf)) await keepRollup(key, rollup).catch(() => undefined);
		for (const [hostId, at] of tickArrivedAt) if (at < now() - RAW_WINDOW_MS) tickArrivedAt.delete(hostId);
		// A host's backlog is minutes long: an hour without a tick, none of what it would send again is still to come.
		for (const hostId of takenSeq.keys()) if (!tickArrivedAt.has(hostId)) takenSeq.delete(hostId);
		for (const hostId of heldUsage.keys()) if (!tickArrivedAt.has(hostId)) heldUsage.delete(hostId);
		sweepUsageClaims();
	}

	/**
	 * Takes a tick from `hostId`: its own readings, and those of its sandboxes it holds. Every reading goes into its
	 * series before anything is written, so a slow write can't let the next tick in ahead of this one; `recordUsage`
	 * takes a host's ticks one at a time. `settle`: close what stopped reporting, now and then (not while replaying the
	 * stub's past ticks, whose later ones would find their 5 minutes already closed). `shared`: it came from the replica
	 * holding the host, which exports it, so this one doesn't (`UsagePoint.shared`). `exports`, instead: asked whether this
	 * replica exports it (`claimUsage`), once nothing else can stop the tick going in. It throws only before any reading
	 * is in (the lookup of the host's sandboxes, or `exports`), so a tick that failed can be taken again whole.
	 */
	async function ingest(
		hostId: string,
		report: ReportedUsage,
		how: {
			readonly known?: ReadonlySet<string>;
			readonly settle?: boolean;
			readonly shared?: boolean;
			readonly exports?: () => Promise<boolean>;
		} = {},
	): Promise<void> {
		const meta = { intervalMs: report.intervalMs };
		// The host's own time, unless its clock runs ahead: a reading stamped in the future would hold back every one after
		// it (a series takes only newer points).
		const received = now();
		const at = report.at - received > MAX_CLOCK_SKEW_MS ? received : report.at;
		// Whether the host is reporting goes by when its ticks arrive, not by its clock.
		tickArrivedAt.set(hostId, received);
		// A host reports only its own sandboxes: one statement for all of them, not one per sandbox. Read before any
		// reading goes in, so a tick it fails for has none in.
		// Their records too, as read for this, for their OOM counts (`takeOOMKills`): no read of its own each tick.
		const records =
			report.sandboxes.length === 0 || how.known !== undefined ? undefined : await sandboxRecordsOn(hostId);
		const held = report.sandboxes.length === 0 ? new Set<string>() : (how.known ?? new Set(records?.keys()));
		const shared = how.exports === undefined ? how.shared === true : !(await how.exports());
		hostSeries.add(
			hostId,
			{
				at,
				cpu: report.host.cpu,
				memUsedBytes: report.host.memUsedBytes,
				diskUsedBytes: report.host.diskUsedBytes,
			},
			{ ...meta, memTotalBytes: report.host.memTotalBytes, diskTotalBytes: report.host.diskTotalBytes },
		);
		if (report.sandboxes.length > 0) {
			const closed: { readonly id: string; readonly rollup: Rollup }[] = [];
			const oomCounts: { readonly id: string; readonly count: number; readonly limit: number }[] = [];
			for (const reading of report.sandboxes) {
				if (!held.has(reading.id)) continue;
				// The last disk size a reading had: one without (a guest that didn't answer in time) keeps it.
				const diskTotal = reading.diskTotalBytes ?? sandboxSeries.meta(reading.id)?.diskTotalBytes;
				// Whether the series takes it (only a point newer than its newest): an older one leaves the OOM count be.
				const before = sandboxSeries.latest(reading.id);
				const inOrder = Number.isFinite(at) && (before === undefined || Math.round(at) > before.at);
				const rollup = sandboxSeries.add(
					reading.id,
					{
						at,
						cpu: reading.cpu,
						memUsedBytes: reading.memUsedBytes,
						...(reading.diskUsedBytes === undefined
							? { diskUsedBytes: 0, noDisk: true }
							: { diskUsedBytes: reading.diskUsedBytes }),
						...(reading.ioPressure === undefined ? {} : { ioPressure: reading.ioPressure }),
						...guestMemoryOf(reading),
						...(shared ? { shared: true } : {}),
					},
					{
						...meta,
						memLimitBytes: reading.memLimitBytes,
						...(diskTotal === undefined ? {} : { diskTotalBytes: diskTotal }),
					},
				);
				if (rollup !== undefined) closed.push({ id: reading.id, rollup });
				// Another replica's tick is that replica's to count. A count its record keeps already, as read for this tick,
				// needs nothing, unless an event for it is still to be stored.
				const count = reading.oomKills;
				const kept = records?.get(reading.id)?.oomKills;
				const due =
					records === undefined ||
					kept === undefined ||
					kept.pending !== undefined ||
					(kept.unreported ?? 0) > 0 ||
					(count !== kept.count && Math.round(at) > kept.at);
				if (inOrder && !shared && count !== undefined && due) {
					oomCounts.push({ id: reading.id, count, limit: reading.memLimitBytes });
				}
			}
			for (const { id, rollup } of closed) await keepRollup(id, rollup).catch(() => undefined);
			for (const each of oomCounts) {
				// Not taken: its record is as it was, so the next reading tries again.
				await takeOOMKills(each.id, each.count, Math.round(at), each.limit).catch(() => undefined);
			}
		}
		// The tick is in: settling that fails is tried again with the next.
		if (how.settle !== false && now() - settledAt >= SETTLE_EVERY_MS) await settleUsage().catch(() => undefined);
	}

	/**
	 * Takes a sandbox's guest's OOM-kill count since boot, read at `at`, against the one its record keeps
	 * (`StoredSandbox.oomKills`), which every gateway shares: so a rise is counted once, whichever gateway the host is on
	 * and however its readings were passed between them. The first count it keeps is a starting point (kills before it are
	 * not new); one lower than kept means the VM booted again since, so all of it is new; a reading no newer than the one
	 * kept is left out.
	 *
	 * One path for every reading, in one write: a newer, different count moves the count on and adds its kills to
	 * `unreported` (a rise, or a reset's whole count), whatever is pending; then, with no event pending, what is
	 * unreported becomes a pending `sandbox.oom_kill`, with its event's ID and all it says. The pending event is then
	 * stored under that ID and cleared, and each later reading stores it again until it is (written over under its ID,
	 * never changed). So no reading's kills are dropped, an event once tried never says anything else on any gateway,
	 * and none is lost to a write that failed.
	 */
	async function takeOOMKills(sandboxId: string, count: number, at: number, memLimitBytes: number): Promise<void> {
		let record: StoredSandbox | undefined;
		let pending: OOMPending | undefined;
		const written = await store.sandboxes.update(sandboxId, (current) => {
			record = current;
			pending = undefined;
			if (current.state === "deleted" || current.state === "deleting") return undefined;
			const kept = current.oomKills;
			if (kept === undefined) return { ...current, oomKills: { count, at } };
			// 1. The reading, if newer and different: the count moves on, and the kills it adds are unreported.
			const moves = at > kept.at && count !== kept.count;
			const added = !moves ? 0 : count < kept.count ? count : count - kept.count;
			let unreported = (kept.unreported ?? 0) + added;
			// 2. With no event pending, what is unreported becomes one, never changed after.
			pending = kept.pending;
			if (pending === undefined && unreported > 0) {
				pending = { eventId: randomId("evt"), kills: unreported, memLimitBytes, at: moves ? at : kept.at };
				unreported = 0;
			}
			if (!moves && pending === kept.pending) return undefined;
			return {
				...current,
				oomKills: {
					count: moves ? count : kept.count,
					at: moves ? at : kept.at,
					...(unreported > 0 ? { unreported } : {}),
					...(pending === undefined ? {} : { pending }),
				},
			};
		});
		const sandbox = written ?? record;
		const due: OOMPending | undefined = pending;
		if (sandbox === undefined || due === undefined) return;
		const memory = due.memLimitBytes > 0 ? ` (${Math.round((due.memLimitBytes / 1024 ** 3) * 10) / 10} GB)` : "";
		const processes = due.kills === 1 ? "a process" : `${due.kills} processes`;
		await emit(
			"sandbox.oom_kill",
			sandbox.accountId,
			{
				sandbox,
				data: {
					oomKills: due.kills,
					reason: `It ran out of memory${memory}, and its kernel killed ${processes}. Give it more memory, or run less at once.`,
				},
			},
			due.eventId,
		);
		// Cleared once stored; kills unreported since stay, for the next reading to make an event of.
		await store.sandboxes.update(sandboxId, (current) => {
			const kept = current.oomKills;
			if (kept?.pending?.eventId !== due.eventId) return undefined;
			const { pending: _, ...rest } = kept;
			return { ...current, oomKills: rest };
		});
	}

	/**
	 * A sandbox's guest's newest memory figures (`GuestMemory`): from the newest point of its series that has any, so a
	 * tick its agent missed doesn't hide them. None without one.
	 */
	function guestMemoryView(sandboxId: string): { memory?: computeSchema.GuestMemory } {
		// Most often the newest point has them: no copy of the series for each sandbox a list shows.
		const newest = sandboxSeries.latest(sandboxId);
		if (newest === undefined) return {};
		const { points } =
			newest.oomKills === undefined && newest.memPressureSome === undefined
				? sandboxSeries.read(sandboxId)
				: { points: [newest] };
		for (let index = points.length - 1; index >= 0; index -= 1) {
			const point = points[index];
			if (point === undefined) continue;
			const { oomKills, memPressureSome, memPressureFull } = point;
			if (oomKills === undefined && memPressureSome === undefined && memPressureFull === undefined) continue;
			return {
				memory: {
					at: point.at,
					...(oomKills === undefined ? {} : { oomKills }),
					...(memPressureSome === undefined ? {} : { pressureSome: memPressureSome }),
					...(memPressureFull === undefined ? {} : { pressureFull: memPressureFull }),
				},
			};
		}
		return {};
	}

	/** A reading's guest memory figures, those it has, for its series. */
	const guestMemoryOf = (reading: ReportedUsage["sandboxes"][number]) => ({
		...(reading.oomKills === undefined ? {} : { oomKills: reading.oomKills }),
		...(reading.memPressureSome === undefined ? {} : { memPressureSome: reading.memPressureSome }),
		...(reading.memPressureFull === undefined ? {} : { memPressureFull: reading.memPressureFull }),
	});

	/** Each host's tick being taken, so the next waits for it (`recordUsage`). */
	const ingesting = new Map<string, Promise<void>>();

	/**
	 * Whether a numbered tick is one already taken: its run's, at or before the newest taken. A series takes only newer
	 * points too, but a tick stamped with this process's clock (its host's ran ahead, `MAX_CLOCK_SKEW_MS`) would get a
	 * new time each time it came, and this doesn't depend on it.
	 */
	const takenAlready = (hostId: string, report: ReportedUsage): boolean => {
		if (report.seq === undefined || report.run === undefined) return false;
		const taken = takenSeq.get(hostId)?.get(report.run);
		return taken !== undefined && report.seq <= taken;
	};

	/** Notes a numbered tick as taken (`takenSeq`), its run as the host's newest. */
	const noteTaken = (hostId: string, report: NumberedUsage): void => {
		const runs = takenSeq.get(hostId) ?? new Map<string, number>();
		const taken = runs.get(report.run);
		if (taken !== undefined && taken >= report.seq) return;
		runs.delete(report.run);
		runs.set(report.run, report.seq);
		for (const run of runs.keys()) if (runs.size > MAX_RUNS_KEPT) runs.delete(run);
		takenSeq.set(hostId, runs);
	};

	/**
	 * Claims a numbered tick from its host for this process to export (`StoredUsageClaim`), and answers whether the claim
	 * is its own: made now, or by this process before (a claim written whose answer was lost, tried again). A claim of
	 * another's means that replica took the tick and exports it.
	 */
	async function claimUsage(hostId: string, report: NumberedUsage): Promise<boolean> {
		const id = usageClaimId(hostId, report.run, report.seq);
		// While the host could still send it again: its backlog is MAX_HELD_USAGE ticks; twice that, and an hour at least.
		const keepUntil = now() + Math.max(HOUR_MS, 2 * MAX_HELD_USAGE * report.intervalMs);
		const claim: StoredUsageClaim = { id, hostId, owner: usageOwner, keepUntil };
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (await store.usageClaims.insert(claim)) return true;
			const current = await store.usageClaims.get(id);
			// None any more (removed between the two, long past): claim it afresh.
			if (current !== undefined) return current.owner === usageOwner;
		}
		return false;
	}

	/**
	 * Removes the claims to ticks no host can send again, at most once an hour (`settleTaken`): in the background, so no
	 * tick and no export waits for it, a batch at a time, and stopped by `close`.
	 */
	function sweepUsageClaims(): void {
		if (now() - claimsSweptAt < HOUR_MS) return;
		claimsSweptAt = now();
		keepGoing(
			(async () => {
				const expired = (await store.usageClaims.list()).filter((claim) => claim.keepUntil < now());
				for (let from = 0; from < expired.length && !closing; from += CLAIM_SWEEP_BATCH) {
					const batch = expired.slice(from, from + CLAIM_SWEEP_BATCH);
					await Promise.all(batch.map((claim) => store.usageClaims.delete(claim.id).catch(() => false)));
					// Room for the ticks' own statements between batches.
					await new Promise((resolve) => setTimeout(resolve, CLAIM_SWEEP_PAUSE_MS));
				}
			})(),
		);
	}

	/**
	 * Takes a numbered tick unless it is taken already: exported here only if this process claims it (`claimUsage`),
	 * which it does once nothing else can stop the tick going in, so a claim made is a tick in.
	 */
	async function takeNumbered(hostId: string, entry: HeldUsage): Promise<void> {
		if (takenAlready(hostId, entry.report)) return;
		const exports = async () => {
			entry.exported ??= await claimUsage(hostId, entry.report);
			return entry.exported;
		};
		await ingest(hostId, entry.report, entry.shared ? { shared: true } : { exports });
		noteTaken(hostId, entry.report);
	}

	/** Takes the host's held ticks, oldest first; one that fails again stays, with every one after it. */
	async function takeHeld(hostId: string): Promise<void> {
		const held = heldUsage.get(hostId);
		while (held !== undefined && held.length > 0) {
			const [next] = held;
			if (next !== undefined) await takeNumbered(hostId, next);
			held.shift();
		}
		heldUsage.delete(hostId);
	}

	/** Holds a numbered tick that couldn't be taken, behind those held already, at most MAX_HELD_USAGE of them. */
	function hold(hostId: string, entry: HeldUsage): void {
		const held = heldUsage.get(hostId) ?? [];
		const { run, seq } = entry.report;
		if (held.some((each) => each.report.run === run && each.report.seq === seq)) return;
		held.push(entry);
		if (held.length > MAX_HELD_USAGE) held.splice(0, held.length - MAX_HELD_USAGE);
		heldUsage.set(hostId, held);
	}

	/**
	 * Takes a host's tick after the one before it from the same host. A numbered tick taken already isn't taken again,
	 * and one that can't be taken (the store failing) is held, with every numbered tick after it, until they can be, in
	 * order: so a tick's promise resolves only once it and every numbered tick before it from the host are in, which is
	 * what makes the hub's cumulative `usage.ack` true, and no later point gets into a series ahead of a held one (which
	 * the series would then refuse as older). The held ones are tried again before each tick and each export.
	 */
	function ingestInTurn(hostId: string, report: ReportedUsage, shared: boolean): Promise<void> {
		return inTurn(hostId, async () => {
			if (report.seq === undefined || report.run === undefined) {
				await ingest(hostId, report, { shared });
				return;
			}
			const entry: HeldUsage = { report: { ...report, seq: report.seq, run: report.run }, shared };
			try {
				await takeHeld(hostId);
				await takeNumbered(hostId, entry);
			} catch (error) {
				hold(hostId, entry);
				throw error;
			}
		});
	}

	/** Tries every host's held ticks again, each in its host's turn (before an export). */
	async function retryHeldUsage(): Promise<void> {
		await Promise.all(
			[...heldUsage.keys()].map((hostId) => inTurn(hostId, () => takeHeld(hostId)).catch(() => undefined)),
		);
	}

	/** Runs `work` after the host's tick before it, and before its next. */
	function inTurn(hostId: string, work: () => Promise<void>): Promise<void> {
		const before = ingesting.get(hostId) ?? Promise.resolve();
		const turn = before.then(work);
		const settled = turn.catch(() => undefined);
		ingesting.set(hostId, settled);
		void settled.then(() => {
			if (ingesting.get(hostId) === settled) ingesting.delete(hostId);
		});
		return turn;
	}

	/**
	 * Brings in the ticks a backend makes itself (the stub's), since the last time: at most once per tick's interval,
	 * on reads, so its graphs move with no timer running.
	 */
	async function catchUpUsage(): Promise<void> {
		const reportsOf = backend.usageReports;
		if (reportsOf === undefined) return;
		// One at a time: a caller while one is under way waits for it, so none reads (or settles) half a replay.
		if (replaying !== undefined) return replaying;
		const until = now();
		if (until - pulledUntil < USAGE_INTERVAL_MS) return;
		const since = pulledUntil;
		pulledUntil = until;
		const run = replay(() => reportsOf(since, until)).finally(() => {
			if (replaying === run) replaying = undefined;
		});
		replaying = run;
		return run;
	}

	/** Takes the stub's past ticks in order, then settles what they left closed. */
	async function replay(reportsOf: () => Promise<readonly BackendUsageReport[]>): Promise<void> {
		const reports = await reportsOf().catch(() => []);
		const held = new Map<string, ReadonlySet<string>>();
		for (const report of reports) {
			let known = held.get(report.hostId);
			if (known === undefined) {
				known = await sandboxesOn(report.hostId).catch(() => new Set<string>());
				held.set(report.hostId, known);
			}
			await ingest(report.hostId, report, { known, settle: false }).catch(() => undefined);
		}
		// Once every past tick is in: only now can a 5 minutes be closed for want of more.
		if (reports.length > 0 && now() - settledAt >= SETTLE_EVERY_MS) await settleTaken();
	}

	/** The sandboxes placed on a host and not deleted, by ID. */
	async function sandboxRecordsOn(hostId: string): Promise<ReadonlyMap<string, StoredSandbox>> {
		return new Map(
			(await store.sandboxes.list({ hostId }))
				.filter((sandbox) => sandbox.state !== "deleted" && sandbox.state !== "deleting")
				.map((sandbox) => [sandbox.id, sandbox]),
		);
	}

	/** The sandboxes placed on a host and not deleted. */
	async function sandboxesOn(hostId: string): Promise<ReadonlySet<string>> {
		return new Set(
			(await store.sandboxes.list({ hostId }))
				.filter((sandbox) => sandbox.state !== "deleted" && sandbox.state !== "deleting")
				.map((sandbox) => sandbox.id),
		);
	}

	/** Whether a sandbox's host sends its readings: then none is read by running a command in the sandbox. */
	const hostReports = (hostId: string | undefined) => {
		const arrived = hostId === undefined ? undefined : tickArrivedAt.get(hostId);
		if (hostId === undefined || arrived === undefined) return false;
		const intervalMs = hostSeries.meta(hostId)?.intervalMs ?? USAGE_INTERVAL_MS;
		return now() - arrived <= Math.max(3 * intervalMs, REPORTING_WITHIN_MS);
	};

	/**
	 * The hosts the backend names, read once however many sandboxes ask (`readUsage`); `undefined` when they can't be read.
	 */
	function hostsOnce(): () => Promise<readonly BackendHost[] | undefined> {
		let hosts: Promise<readonly BackendHost[] | undefined> | undefined;
		return () => {
			hosts ??= backend.capabilities().then(
				(capabilities) => capabilities.hosts,
				() => undefined,
			);
			return hosts;
		};
	}

	/**
	 * The fallback for a host that doesn't send its readings (an older kantel-host): one reading by running a command in
	 * the sandbox, at most once per `minGapMs`, added to its series as a host's tick would be. Never for a host that says
	 * it sends them (`usage`), even while its ticks are late: they wait on the host while it can't reach the control plane
	 * and come when it can, and a reading here, stamped later than they are, would keep them out of the series (it takes
	 * only newer points). Nor when the hosts can't be read: the host may well be one that sends them.
	 */
	async function readUsage(
		sandbox: StoredSandbox,
		minGapMs: number,
		hosts: () => Promise<readonly BackendHost[] | undefined> = hostsOnce(),
	): Promise<void> {
		if (sandbox.state !== "running" || hostReports(sandbox.hostId)) return;
		const at = now();
		if (at - (fallbackReadAt.get(sandbox.id) ?? Number.NEGATIVE_INFINITY) < minGapMs) return;
		fallbackReadAt.set(sandbox.id, at);
		const known = await hosts();
		if (known === undefined) return;
		const host = known.find((each) => each.id === sandbox.hostId);
		if (host?.features?.includes(USAGE_FEATURE) === true) return;
		const reading = await backend.usage(sandbox.id).catch(() => undefined);
		if (reading === undefined) return;
		const limit = sandbox.resources?.memoryMb === undefined ? {} : { memLimitBytes: sandbox.resources.memoryMb * MIB };
		const closed = sandboxSeries.add(
			sandbox.id,
			{ at, cpu: reading.cpu, memUsedBytes: reading.memoryBytes, diskUsedBytes: 0, noDisk: true },
			{ intervalMs: FALLBACK_INTERVAL_MS, ...limit },
		);
		if (closed !== undefined) await keepRollup(sandbox.id, closed);
	}

	/**
	 * A sandbox's sparklines: its kept 5-minute means and the one under way, the newest `SPARKLINE_POINTS`.
	 */
	function sparklines(sandbox: StoredSandbox): { recentCpu: number[]; recentMemory: number[] } {
		const recent = withPartial(sandbox).slice(-SPARKLINE_POINTS);
		return {
			recentCpu: recent.map((sample) => sample.cpu),
			recentMemory: recent.map((sample) => Math.round(sample.memoryMb * MIB)),
		};
	}

	/** A sandbox's kept 5-minute means, and the one under way in this process's memory, if any. */
	function withPartial(sandbox: StoredSandbox): readonly StoredSample[] {
		const partial = sandbox.state === "deleted" ? undefined : sandboxSeries.partial(sandbox.id);
		const last = sandbox.samples[sandbox.samples.length - 1];
		if (partial === undefined || (last !== undefined && partial.at <= last.at)) return sandbox.samples;
		return [...sandbox.samples, sampleOf(partial)];
	}

	/** A sandbox's peak with a 5-minute mean's highest readings in it: `peak` itself where they are no higher. */
	function peakWith(peak: StoredPeak | undefined, rollup: Rollup): StoredPeak | undefined {
		const memory = peak === undefined || rollup.memMaxBytes > peak.memoryBytes;
		const cpu = peak === undefined || rollup.cpuMax > peak.cpu;
		if (!memory && !cpu) return peak;
		return {
			memoryBytes: memory ? rollup.memMaxBytes : peak.memoryBytes,
			memoryAt: memory ? rollup.memMaxAt : peak.memoryAt,
			cpu: cpu ? rollup.cpuMax : peak.cpu,
		};
	}

	/** A sandbox's peak, with the 5-minute mean under way in this process's memory, if any. */
	function peakOf(sandbox: StoredSandbox): StoredPeak | undefined {
		// A deleted one's too: its last 5 minutes are still settled into its record (`keepRollup`).
		const partial = sandboxSeries.partial(sandbox.id);
		return partial === undefined ? sandbox.peak : peakWith(sandbox.peak, partial);
	}

	/** A peak as the API answers it, in `Sandbox.usage` and `SandboxUsage`. */
	function peakView(peak: StoredPeak | undefined): {
		peakMemoryBytes?: number;
		peakMemoryAt?: number;
		peakCpu?: number;
	} {
		if (peak === undefined) return {};
		return {
			peakMemoryBytes: Math.round(peak.memoryBytes),
			peakMemoryAt: peak.memoryAt,
			peakCpu: Math.min(1, peak.cpu),
		};
	}

	/** A 5-minute mean as a sandbox's record keeps it. */
	function sampleOf(rollup: Rollup): StoredSample {
		return {
			at: rollup.at,
			cpu: rollup.cpu,
			memoryMb: rollup.memUsedBytes / MIB,
			cpuMax: rollup.cpuMax,
			memoryMbMax: rollup.memMaxBytes / MIB,
			readings: rollup.readings,
			...(rollup.noDisk === true
				? {}
				: {
						diskMb: rollup.diskUsedBytes / MIB,
						...(rollup.diskReadings === rollup.readings ? {} : { diskReadings: rollup.diskReadings }),
					}),
			...(rollup.ioPressure === undefined
				? {}
				: {
						io: rollup.ioPressure,
						...(rollup.ioReadings === rollup.readings ? {} : { ioReadings: rollup.ioReadings }),
					}),
		};
	}

	function hostSparklines(hostId: string): computeSchema.UsageSparklines {
		const recent = hostSeries.rollups(hostId, SPARKLINE_POINTS);
		return { recentCpu: recent.map((point) => point.cpu), recentMemory: recent.map((point) => point.memUsedBytes) };
	}

	async function hostUsage(hostId: string, since: number | undefined): Promise<computeSchema.HostUsage> {
		await catchUpUsage();
		const { meta, points } = hostSeries.read(hostId, since);
		return {
			hostId,
			intervalMs: meta?.intervalMs ?? USAGE_INTERVAL_MS,
			memTotalBytes: Math.round(meta?.memTotalBytes ?? 0),
			diskTotalBytes: Math.round(meta?.diskTotalBytes ?? 0),
			points: points.map((point) => ({
				at: point.at,
				cpu: point.cpu,
				memUsedBytes: point.memUsedBytes,
				diskUsedBytes: point.diskUsedBytes,
			})),
		};
	}

	/** The cost and running time of an account's sandboxes since `since`. */
	async function accountUsage(account: StoredAccount, since: number) {
		const sandboxes = await store.sandboxes.list({ accountId: account.id });
		const at = now();
		let seconds = 0;
		let total = 0;
		for (const sandbox of sandboxes) {
			seconds += runningMs(sandbox.runs, since, at) / 1000;
			total += costOf(sandbox, since, at);
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
				// A record made while gateways named people by their user ID still has it: their email, then.
				name: personName({ userId: member.userId, name: user?.name, email: user?.email }),
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
			if (account === undefined || role === undefined) return [];
			const named =
				account.kind === "personal" && isPlaceholderName(account.name)
					? personalNamed(account, await nameOfUser(principal.userId))
					: account;
			return [accountView(named, role)];
		}
		const accounts: computeSchema.Account[] = [];
		for (const member of await store.members.list({ userId: principal.userId })) {
			const account = await store.accounts.get(member.accountId);
			// A personal token lists only the accounts it may act in.
			if (account === undefined || (await tokenRefusal(store, principal, account.id)) !== undefined) continue;
			accounts.push(accountView(personalNamed(account, personName(principal)), member.role));
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
		userCode: login.userCode ?? login.personalUserCode ?? "",
		clientName: login.clientName,
		...(login.personal === true ? { personal: true } : {}),
		state: login.state === "pending" && login.expiresAt <= now() ? "expired" : login.state,
		createdAt: login.createdAt,
		expiresAt: login.expiresAt,
	});

	/** The pending sign-in a person typed or followed the code of; `not_found` for an unknown or finished one. */
	async function pendingDeviceLogin(userCode: string): Promise<StoredDeviceLogin> {
		const typed = userCode.toUpperCase().replace(/[^A-Z]/g, "");
		const code = typed.length === 8 ? `${typed.slice(0, 4)}-${typed.slice(4)}` : userCode;
		const [keyed] = await store.deviceLogins.list({ userCode: code });
		const login = keyed ?? (await store.deviceLogins.list({ personalUserCode: code }))[0];
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
			const taken = async (code: string) =>
				(await store.deviceLogins.list({ userCode: code })).length > 0 ||
				(await store.deviceLogins.list({ personalUserCode: code })).length > 0;
			let userCode = randomUserCode();
			while (await taken(userCode)) userCode = randomUserCode();
			const login: StoredDeviceLogin = {
				id: await sha256Hex(deviceCode),
				// A personal sign-in's code where only a gateway that knows personal tokens looks (`personalUserCode`).
				...(body.personal === true ? { personalUserCode: userCode } : { userCode }),
				clientName: body.clientName ?? "kantel",
				...(body.personal === true ? { personal: true } : {}),
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
			// Only the first poll that sees it gets the secret, which is then dropped. The credential is read first: one an
			// approval hasn't stored yet (or that failed to store) leaves the secret for the next poll, never spent on nothing.
			if (login.state === "approved" && login.secret !== undefined && login.personalTokenId !== undefined) {
				const token = await store.personalTokens.get(login.personalTokenId);
				if (token === undefined) return { state: "pending" };
				const collected = await store.deviceLogins.update(id, (current) =>
					current.secret === undefined ? undefined : { ...current, secret: undefined, collectedAt: now() },
				);
				if (collected === undefined) return { state: "expired" };
				return { state: "approved", token: { token: personalTokenView(token), secret: login.secret } };
			}
			if (login.state === "approved" && login.secret !== undefined && login.apiKeyId !== undefined) {
				const key = await store.apiKeys.get(login.apiKeyId);
				if (key === undefined) return { state: "pending" };
				const collected = await store.deviceLogins.update(id, (current) =>
					current.secret === undefined ? undefined : { ...current, secret: undefined, collectedAt: now() },
				);
				if (collected === undefined) return { state: "expired" };
				return { state: "approved", issued: { key: apiKeyView(key), secret: login.secret } };
			}
			if (login.state === "approved") return { state: "expired" };
			return { state: deviceLoginView(login).state };
		},
	};

	const handlers: RouteHandlers<SignedInComputeRoutes, Principal> = {
		// Device sign-ins, which a person approves on the console's page.

		getDeviceLogin: async (principal, { params }) => {
			requireSignIn(principal, "Approving a sign-in");
			return deviceLoginView(await pendingDeviceLogin(params.userCode));
		},

		approveDeviceLogin: async (principal, { params, body }) => {
			const person = requireSignIn(principal, "Approving a sign-in");
			const login = await pendingDeviceLogin(params.userCode);
			if (login.state !== "pending") throw new KantelError("conflict", `The sign-in is already ${login.state}`);
			if (login.personal === true) {
				// Consent to a personal token must be explicit: a console from before them shows an API key in one account and
				// sends only `account`, and its approval mustn't hand out a token for all of the person's accounts.
				if (body.personal !== true) {
					throw new KantelError(
						"invalid",
						"This sign-in asks for a personal access token, which acts as you in your accounts: reload the page to approve it",
					);
				}
				// A personal token acts as its approver with their role, so any member may approve one: no account:admin.
				const { token, secret } = await newPersonalToken(person, {
					name: login.clientName,
					...(body.preset === undefined
						? {}
						: { scopes: computeSchema.API_KEY_PRESETS[body.preset].filter((scope) => scope !== "hosts:admin") }),
					...(body.accounts === undefined ? {} : { accounts: body.accounts }),
					expiresInDays: Math.min(body.expiresInDays ?? DEVICE_LOGIN_KEY_DAYS, computeSchema.PERSONAL_TOKEN_MAX_DAYS),
				});
				// The token is stored before the approval names it, so a poll never finds an approval without it; should the
				// approval lose to another decision, the token is revoked, never handed to anyone.
				await store.personalTokens.put(token);
				const approved = await store.deviceLogins.update(login.id, (current) =>
					current.state === "pending"
						? { ...current, state: "approved", personalTokenId: token.id, secret, decidedBy: person.userId }
						: undefined,
				);
				if (approved === undefined) {
					await store.personalTokens.put({ ...token, revokedAt: now() });
					throw new KantelError("conflict", "The sign-in was decided meanwhile");
				}
				return deviceLoginView(approved);
			}
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
			// The key is stored first, as a personal token is above.
			await store.apiKeys.put(key);
			const approved = await store.deviceLogins.update(login.id, (current) =>
				current.state === "pending"
					? { ...current, state: "approved", apiKeyId: key.id, secret, decidedBy: person.userId }
					: undefined,
			);
			if (approved === undefined) {
				await store.apiKeys.put({ ...key, revokedAt: now() });
				throw new KantelError("conflict", "The sign-in was decided meanwhile");
			}
			return deviceLoginView(approved);
		},

		denyDeviceLogin: async (principal, { params }) => {
			const person = requireSignIn(principal, "Denying a sign-in");
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
					...deploymentDomain,
					protectedValues: sealer !== undefined,
				};
			}
			return {
				user: { id: principal.userId, name: personName(principal), email: principal.email },
				...(principal.token === undefined
					? {}
					: {
							personalToken: {
								id: principal.token.id,
								name: principal.token.name,
								...(principal.token.scopes === undefined ? {} : { scopes: [...principal.token.scopes] }),
								...(principal.token.accounts === undefined ? {} : { accounts: [...principal.token.accounts] }),
								expiresAt: principal.token.expiresAt,
							},
						}),
				accountId: defaultAccountOf(principal),
				accounts,
				superAdmin: principal.superAdmin,
				mode,
				...deploymentDomain,
				protectedValues: sealer !== undefined,
			};
		},

		deleteCaller: async (principal) => {
			const person = requireSignIn(principal, "Deleting your account");
			// The deployment's own administrators are its operator's to remove, not their own: the deployment needs one.
			if (person.superAdmin || (await options.deploymentAdmin?.(person.userId)) === true) {
				throw new KantelError("forbidden", "A deployment super-admin can't delete their account");
			}
			const personal = person.personalAccountId;
			// The checks, before anything changes: a refusal leaves everything as it was. Once the deletion is recorded, it is
			// carried on to the end (`carryOnDeletion`), and the person can't sign in to change anything meanwhile.
			if ((await store.deletions.get(person.userId)) === undefined) {
				for (const member of await store.members.list({ userId: person.userId })) {
					if (member.role !== "owner" || member.accountId === personal) continue;
					if ((await ownerCount(member.accountId)) > 1) continue;
					const organisation = await store.accounts.get(member.accountId);
					if (organisation === undefined) continue;
					throw new KantelError(
						"conflict",
						`You're the last owner of ${organisation.name}: make someone else an owner, or delete it, first`,
					);
				}
				// Bundles too: deleting one (`deleteBundle`) removes its bytes from the deployment's store, which only it checks.
				if (
					(await store.sandboxes.list({ accountId: personal })).some((sandbox) => sandbox.state !== "deleted") ||
					(await store.snapshots.list({ accountId: personal, kind: "saved" })).length > 0 ||
					(await store.bundles.list({ accountId: personal })).length > 0
				) {
					throw new KantelError("conflict", "Delete your sandboxes, saved snapshots and bundles first");
				}
				// A wake first, covering the first pass's lease: should it be cut off, the deletion is carried on with no
				// request needed. One that can't be arranged refuses the deletion before anything changes.
				await wake(now() + DELETION_LEASE_MS);
				await store.deletions.insert({
					id: person.userId,
					stage: "running",
					personalAccountId: personal,
					name: person.name,
					...(person.email === undefined ? {} : { email: person.email }),
					startedAt: now(),
					dueAt: now(),
					attempts: 0,
				});
			}
			// Its first pass now; should it fail, the sweep carries it on.
			await carryOnDeletion(person.userId).catch(() => undefined);
			return undefined;
		},

		listAccounts: async (principal) => {
			requireScope(principal, "account:read");
			return { items: await accountsOf(principal) };
		},

		createOrganisation: async (principal, { body, idempotencyKey }) => {
			const person = requirePerson(principal);
			requireUnlimitedToken(principal, "Making an organisation");
			return once(principal, "createOrganisation", { body, idempotencyKey }, async () => {
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
			});
		},

		joinOrganisation: async (principal, { body }) => {
			const person = requirePerson(principal);
			requireUnlimitedToken(principal, "Joining an organisation");
			const [invite] = await store.invites.list({ codeHash: await sha256Hex(body.code) });
			if (invite === undefined) throw notFound("invite");
			if (invite.revokedAt !== undefined || invite.usedAt !== undefined || invite.expiresAt <= now()) {
				throw new KantelError("expired", "The invite has expired or been used");
			}
			if (invite.email !== undefined && normaliseEmail(invite.email) !== normaliseEmail(person.email ?? "")) {
				throw new KantelError("forbidden", inviteForSomeoneElse(invite.email, person.email));
			}
			const account = await store.accounts.get(invite.accountId);
			if (account === undefined) throw notFound("organisation");
			// An organisation that blocks personal tokens isn't joined with one: membership is changed at the console.
			const refusal = await tokenRefusal(store, principal, account.id);
			if (refusal !== undefined) throw new KantelError("forbidden", refusal);
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
			if (account.kind !== "personal" || !isPlaceholderName(account.name)) return accountView(account, role);
			// Only its person, or a key of theirs, gets here.
			return accountView(personalNamed(account, await nameOfUser(principal.userId)), role);
		},

		updateAccount: async (principal, { params, body }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", role);
			if (account.kind === "personal" && body.defaultVisibility === "organisation") {
				throw new KantelError("invalid", "A personal account's sandboxes are always private");
			}
			if (account.kind === "personal" && body.personalTokens === "blocked") {
				throw new KantelError("invalid", "Your personal tokens always work in your personal account");
			}
			// Only the fields asked for, on the account as it is when written: never a stale copy over a closure (`closedAt`)
			// written meanwhile, nor an account its deletion has removed.
			const updated = await store.accounts.update(account.id, (current) => ({
				...current,
				name: body.name ?? current.name,
				defaultVisibility: body.defaultVisibility ?? current.defaultVisibility,
				...(body.personalTokens === undefined && current.personalTokens === undefined
					? {}
					: { personalTokens: body.personalTokens ?? current.personalTokens }),
				...(body.snapshotCopies === undefined && current.snapshotCopies === undefined
					? {}
					: { snapshotCopies: body.snapshotCopies ?? current.snapshotCopies }),
			}));
			if (updated === undefined) throw notFound("account");
			// Turned on: its saved snapshots get their second copies now, not on the sweep's next pass.
			if (body.snapshotCopies === true && account.snapshotCopies === false) keepGoing(keepEverySnapshotsCopies());
			return accountView(updated, role);
		},

		deleteOrganisation: async (principal, { params }) => {
			requirePerson(principal);
			const acting = await accountById(store, principal, params.accountId);
			const { account, role } = acting;
			if (account.kind === "personal") throw new KantelError("invalid", "A personal account can't be deleted here");
			if (role !== "owner") throw new KantelError("forbidden", "Only an owner deletes an organisation");
			requireScope(principal, "account:admin", role);
			const sandboxes = (await store.sandboxes.list({ accountId: account.id })).filter(
				(sandbox) => sandbox.state !== "deleted",
			);
			const saved = await store.snapshots.list({ accountId: account.id, kind: "saved" });
			if (sandboxes.length > 0 || saved.length > 0) {
				throw new KantelError("conflict", "Delete the organisation's sandboxes and saved snapshots first");
			}
			// Its templates first, with their versions and cache: nothing is built for it once it has gone.
			await templates.retireAccount(account.id);
			for (const member of await store.members.list({ accountId: account.id })) await store.members.delete(member.id);
			for (const invite of await store.invites.list({ accountId: account.id })) await store.invites.delete(invite.id);
			for (const key of await store.apiKeys.list({ accountId: account.id })) {
				if (key.revokedAt === undefined) await store.apiKeys.put({ ...key, revokedAt: now() });
			}
			for (const webhook of await store.webhooks.list({ accountId: account.id })) {
				await store.webhooks.delete(webhook.id);
			}
			await forgetGithubRunners(account.id);
			await forgetStickyDisks(account.id);
			await store.telemetry.delete(account.id);
			await store.proxies.delete(account.id);
			for (const pool of await store.pools.list({ owner: account.id })) await store.pools.delete(pool.id);
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
			// The membership as it is now, never one an account deletion (or a removal) took away meanwhile put back.
			const changed = await store.members.update(target.id, (current) => ({ ...current, role: body.role }));
			if (changed === undefined) throw notFound("member");
			const [member] = (await membersView(params.accountId)).filter((entry) => entry.userId === params.userId);
			if (member === undefined) throw notFound("member");
			return member;
		},

		removeMember: async (principal, { params }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireOrganisation(acting);
			const leaving = principal.kind === "person" && params.userId === principal.userId;
			if (!leaving) requireScope(principal, "account:admin", acting.role);
			// Any member may leave, but a token held to scopes leaves only with account:admin among them: a leaked read-only
			// token mustn't take its person out of an organisation, nor revoke their keys there.
			const capped = principal.kind === "person" ? principal.token?.scopes : undefined;
			if (leaving && capped !== undefined && !capped.includes("account:admin")) {
				throw new KantelError("forbidden", "This personal access token lacks the account:admin scope");
			}
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

		createInvite: async (principal, { params, body, idempotencyKey }, request) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			requireOrganisation(acting);
			// Checked before `once`, so a retry answered the first call's code is held to the caller's role now too.
			const role = body.role ?? "member";
			if (role === "owner" && acting.role !== "owner") {
				throw new KantelError("forbidden", "Only an owner invites an owner");
			}
			// A retry would make a second invite and mail it again; with the key it answers the first, its code sealed.
			return once(
				principal,
				"createInvite",
				{ params, body, idempotencyKey },
				async () => {
					const email = body.email === undefined ? undefined : inviteEmail(body.email);
					const code = randomSecret("kji_", 32);
					const invite: StoredInvite = {
						id: randomId("inv"),
						accountId: params.accountId,
						role,
						...(email === undefined ? {} : { email }),
						codeHash: await sha256Hex(code),
						expiresAt: now() + (body.expiresInHours ?? 168) * 3_600_000,
						createdAt: now(),
					};
					await store.invites.put(invite);
					const emailed = email === undefined ? false : await mailInvite(principal, invite, email, code, request);
					return { ...inviteView(invite, code), emailed };
				},
				{ secret: true },
			);
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
			await catchUpUsage();
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:read", role);
			const active: readonly SandboxState[] = ["starting", "running", "stopping"];
			const hosts = new Map<string, Promise<StoredHost | undefined>>();
			const reach = new Map<string, Promise<boolean | undefined>>();
			const onHost =
				query.host === undefined
					? undefined
					: pinnableHost(principal, account.id, await ensureHosts(), query.host, { revoked: true }).id;
			const visible: StoredSandbox[] = [];
			const owned = query.mine === true ? { ownerUserId: principal.userId } : {};
			for (const sandbox of await store.sandboxes.list({ accountId: account.id, ...owned })) {
				if (sandbox.state === "deleted") continue;
				if (onHost !== undefined && sandbox.hostId !== onHost) continue;
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
			return {
				items: await withSnapshotTimes(
					await withMakersNamed(
						await Promise.all(page.items.map((sandbox) => sandboxView(sandbox, principal, hosts, reach))),
					),
				),
				nextCursor: page.nextCursor,
			};
		},

		getSandboxShapes: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:read", role);
			const read = backend.capabilities();
			const [records, capabilities, shared] = await Promise.all([ensureHosts(read), read, mayShare(principal)]);
			const byId = new Map(capabilities.hosts.map((host) => [host.id, host]));
			// requireHosts's rule, unlabelled: the account's own hosts that run the type, else the shared ones; or the one host
			// a sandbox is to be pinned to.
			const pinned = query.host === undefined ? undefined : pinnableHost(principal, account.id, records, query.host).id;
			// The pool a create would go in (`placementPool`): a pinned one, naming none, wherever its host is.
			const pool =
				pinned !== undefined && query.pool === undefined
					? undefined
					: await placementPool(account.id, query.pool, records, shared);
			const usableFor = (type: SandboxType) => {
				const running = records.filter(
					(record) =>
						record.state === "online" &&
						record.tiers.includes(type) &&
						(pinned === undefined || record.id === pinned) &&
						(pool === undefined ||
							(record.accountId === undefined ? record.poolId === pool.shared : record.poolId === pool.own)),
				);
				const own = running.filter((record) => record.accountId === account.id);
				const usable =
					pinned !== undefined
						? running
						: own.length > 0
							? own
							: shared
								? running.filter((record) => record.accountId === undefined)
								: [];
				return usable.flatMap((record) => {
					const host = byId.get(record.id);
					return host === undefined ? [] : [host];
				});
			};
			const microvm = microvmShapes(usableFor("microvm"), capabilities.sizes);
			// An isolate's memory is a hard limit only if it is wherever the isolate may go: every such host's runtime says so.
			const isolateHosts = usableFor("isolate");
			const enforced = isolateHosts.length > 0 && isolateHosts.every((host) => host.isolate?.memoryEnforced === true);
			return {
				isolate: { memoryMb: { ...computeSchema.ISOLATE_MEMORY_MB }, enforced },
				...(microvm === undefined ? {} : { microvm }),
				// Self-hosted, a sandbox costs its operator nothing per hour, so New sandbox shows no price.
				...(mode === "hosted"
					? {
							rates: {
								currency: rates.currency,
								microvmPerVcpuHour: rates.microvmPerVcpuHour,
								microvmPerGbHour: rates.microvmPerGbHour,
								isolatePerGbHour: rates.isolatePerGbHour,
							},
						}
					: {}),
			};
		},

		createSandbox: async (principal, { body, idempotencyKey }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "sandboxes:write", role);
			return once(principal, "createSandbox", { body, idempotencyKey }, async () => {
				const from = body.from === undefined ? undefined : await snapshotFrom(principal, account.id, body.from);
				const template =
					body.template === undefined ? undefined : await templates.templateIn(account.id, body.template);
				if (template !== undefined) {
					if (from !== undefined)
						throw new KantelError("invalid", "Make a sandbox from a template or a snapshot, not both");
					if (body.image !== undefined)
						throw new KantelError("invalid", "A template names its own image; leave image out");
					if (body.type === "isolate") throw new KantelError("invalid", "A template makes microVMs, not isolates");
					// Its setup runs as root with the env this call chooses (a shell reads functions from it) whenever it boots
					// fresh, which a host may do whatever snapshot it is given: only a caller that may run commands may have it run.
					if (template.spec.setup !== undefined) requireScope(principal, "exec", role);
				}
				const type = body.type ?? from?.sandboxType ?? (template === undefined ? "isolate" : "microvm");
				if (body.mounts !== undefined && body.mounts.length > 0 && mounts === undefined) {
					throw new KantelError("not_supported", MOUNTS_OFF);
				}
				const sandboxMounts = await mounts?.checkCreate(account.id, type, body.mounts);
				let sandboxSticky: computeSchema.SandboxStickyDisk[] | undefined;
				if (body.stickyDisks !== undefined && body.stickyDisks.length > 0) {
					requireSticky();
					if (type !== "microvm") throw new KantelError("invalid", "Sticky disks are a microVM's");
					sandboxSticky = await stickyDisksFor(
						account.id,
						body.stickyDisks,
						(body.mounts ?? []).map((mount) => mount.path),
					);
				}
				const environments = await environmentsNamed(account.id, body.environment, body.environments);
				// Their repositories are cloned with a command that runs with the env this call chooses (a shell reads functions
				// from it): only a caller that may run commands may have them cloned.
				if (environments.some((environment) => environment.repos.length > 0)) requireScope(principal, "exec", role);
				const resolution = resolved(environments);
				for (const name of Object.keys(body.env ?? {})) refuseReserved(name);
				refuseProtectedClashes(body.env ?? {}, resolution, environments.length);
				// The sandbox's own placeholder for each protected variable, minted now and never changed (a rotation changes
				// the value it stands for). Its env: its template's variables, its environments' plain variables and
				// placeholders in order, then its own.
				const envLayers = { base: { ...template?.spec.env }, own: { ...body.env } };
				const { env, placeholders } = composeEnv(envLayers, resolution, {}, newPlaceholder);
				const egressRevision = now();
				// Its own grants: its template's, if it has one.
				const grants = template === undefined ? [] : normaliseGrants(template.spec.network?.grants ?? []);
				const subject: EgressSubject = {
					...environmentFields(environments.map((environment) => environment.id)),
					placeholders,
					grants,
					egressRevision,
					env,
				};
				// The backend's hosts and the host records, read at once: one round trip, not one each. The backend's hosts
				// are read once, for the checks below and the host records alike.
				const read = backend.capabilities();
				const known = ensureHosts(read);
				// A check below may refuse the call before this is awaited.
				known.catch(() => undefined);
				const capabilities = await read;
				// The host it was asked to go on, resolved first: a host the caller may not name is `not_found` whatever the
				// fleet runs.
				const hostPin =
					body.host === undefined ? undefined : pinnableHost(principal, account.id, await known, body.host).id;
				// The pool it goes in, by name or the default (`placementPool`): one it named that the caller has none of is
				// `not_found`. Made from a snapshot, or on a host it named, it goes there, in a pool it named only.
				// From a snapshot, the snapshot's pool (below). With sticky disks that have a pool, theirs (`poolOfStickyDisks`),
				// naming none.
				const stickyPool =
					sandboxSticky === undefined ? undefined : await poolOfStickyDisks(sandboxSticky, await known);
				const pool =
					body.pool !== undefined
						? await placementPool(account.id, body.pool, await known, await mayShare(principal))
						: from !== undefined
							? undefined
							: stickyPool !== undefined
								? await poolChoiceOf(stickyPool.poolId)
								: hostPin !== undefined
									? undefined
									: await placementPool(account.id, undefined, await known, await mayShare(principal));
				const named = body.pool === undefined ? undefined : (pool?.own ?? pool?.shared);
				// From a snapshot, the snapshot's pool (`poolOfSnapshot`: refused where its host has since gone to another), which
				// must be the pool it named: one whose pool can't be told (from before pools, its host's ref opaque and its
				// sandbox gone) can't be, and isn't guessed.
				const snapshotPool =
					from === undefined
						? undefined
						: await poolOfSnapshot(
								from,
								await known,
								named === undefined ? undefined : { id: named, name: body.pool ?? named, instead: "name no pool" },
							);
				if (stickyPool !== undefined && named !== undefined && named !== stickyPool.poolId) {
					throw await stickyPoolRefusal(stickyPool.disk, stickyPool.poolId, named);
				}
				// Where a sandbox made from the snapshot can start: its holders, or a host that fetches it first.
				const copies = from === undefined ? undefined : await snapshotCopiesOf(from, await known, snapshotPool);
				// From a snapshot that can't be fetched, a pin can only be a host that holds it: refused now, before anything is
				// stored, rather than left as a sandbox that can never start.
				if (hostPin !== undefined && copies !== undefined && !copies.fetch) {
					const holder = (await known).find((host) => host.id === copies.holders[0]?.hostId);
					if (holder !== undefined && !copies.holders.some((each) => each.hostId === hostPin)) {
						throw placementError(
							"unavailable",
							"host_unavailable",
							`The snapshot is on another host (${mayKnowHost(principal, holder, account.id) ? holder.name : "not one you can name"}), and can't be fetched from it here: a sandbox made from it runs only there`,
						);
					}
				}
				if (!capabilities.types.includes(type)) {
					// Why, as `requireHosts` would say it: of the hosts the caller may use, and from a snapshot its own host.
					let reason: PlacementReason = "no_host_for_type";
					try {
						requireHosts(
							await known,
							account.id,
							type,
							{ ...body.hostLabels },
							from !== undefined,
							await mayShare(principal),
							hostPin,
							pool,
						);
					} catch (error) {
						reason = placementReasonOf(error) ?? reason;
					}
					throw placementError("unavailable", reason, `No host runs ${type} sandboxes`);
				}
				if (type === "isolate" && body.size !== undefined) throw new KantelError("invalid", "Isolates have no size");
				let autoUpgradeFrom: StoredSnapshot | undefined;
				if (body.autoUpgradeFrom !== undefined) {
					if (type !== "isolate")
						throw new KantelError("invalid", "autoUpgradeFrom is an isolate's: a microVM isn't upgraded");
					autoUpgradeFrom = await checkAutoUpgradeFrom(principal, account.id, body.autoUpgradeFrom);
				}
				// A size takes a disk beside it (`resources.diskGb` alone), but not vCPUs or memory.
				if (
					body.size !== undefined &&
					body.resources !== undefined &&
					(body.resources.vcpus !== undefined || body.resources.memoryMb !== undefined)
				) {
					throw new KantelError("invalid", "Give resources or a size, not both");
				}
				if (from !== undefined && body.resources?.diskGb !== undefined) {
					throw new KantelError(
						"invalid",
						"A sandbox made from a snapshot keeps the snapshot's disk; leave out diskGb",
					);
				}
				// A snapshot's own size is its machine, whatever the hosts name now (`restoreAsked` decides a snapshot's).
				if (
					body.size !== undefined &&
					body.size !== from?.size &&
					!capabilities.sizes.some((size) => size.name === body.size)
				) {
					throw placementError(
						"not_supported",
						"no_host_offers_size",
						`This deployment doesn't offer the size ${body.size}`,
					);
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
					hostPin,
					pool,
				);
				// From a snapshot, placed in its pool, where a copy of it may be fetched as well as on its holders. None there
				// now: the create is kept, and fails as it boots, to be made again once one is.
				const inSnapshotPool = new Set(
					(await known).filter((host) => host.poolId === snapshotPool).map((host) => host.id),
				);
				const placeOn =
					from === undefined || snapshotPool === undefined
						? hosts
						: hosts.filter((hostId) => inSnapshotPool.has(hostId));
				// The pool it is placed in: its eligible hosts' (one pool, as chosen), or from a snapshot the snapshot's.
				const placedPool =
					from === undefined ? (await known).find((host) => host.id === hosts[0])?.poolId : snapshotPool;
				// What its automatic upgrade is to start from, in the pool it is placed in, as its upgrade will check it.
				if (autoUpgradeFrom !== undefined) {
					await poolOfSnapshot(
						autoUpgradeFrom,
						await known,
						keptPool(placedPool === undefined ? undefined : await poolChoiceOf(placedPool), UPGRADE_IN_POOL),
					);
				}
				// Its sticky disks are in its pool (those with none yet are given it just before it is stored).
				if (stickyPool !== undefined && placedPool !== stickyPool.poolId) {
					throw await stickyPoolRefusal(stickyPool.disk, stickyPool.poolId, placedPool);
				}
				// Its shape, checked against the hosts it may go to, as placement will choose among them: what it asks for, else
				// its template's resources (unless it names a size), which a template snapshot was built as.
				const eligible = capabilities.hosts.filter((host) => hosts.includes(host.id));
				// A disk asked for alone goes to the machine its size, template or the default gives.
				const diskAlone =
					body.resources !== undefined && body.resources.vcpus === undefined && body.resources.memoryMb === undefined
						? checkDisk(type, body.resources.diskGb)
						: undefined;
				const asked =
					(diskAlone === undefined ? body.resources : undefined) ??
					(template !== undefined && body.size === undefined ? template.spec.resources : undefined);
				const shape = shapeFor(type, asked, eligible, capabilities.sizes, from === undefined);
				const presets = eligible.flatMap((host) => host.sizes ?? capabilities.sizes);
				// From a snapshot that holds memory: its own machine, and nothing else (`restoreAsked`), refused here rather than
				// by its host once the sandbox is stored.
				const wanted: AskedMachine = {
					...(body.size === undefined ? {} : { size: body.size }),
					...(shape === undefined ? {} : { shape }),
					...(diskAlone === undefined ? {} : { diskGb: diskAlone }),
				};
				const machineAsked =
					type === "microvm" && from !== undefined
						? restoreAsked({ ...from, memory: await holdsMemory(from) }, wanted)
						: wanted;
				// Its machine, as every create and fork decides it (`sandboxMachine`): the shape asked for, its template's, that of
				// the sandbox its snapshot was taken of, or its size's; a shape named by the preset it matches, so a host restores
				// that size's template snapshot rather than booting it.
				// A snapshot's disk is on the host its sandbox is on: another size or shape is that host's.
				// Named by its ref, else its sandbox's (`hostOfSnapshot`), so still known once that sandbox is deleted.
				const fromHostId = from === undefined ? undefined : await hostOfSnapshot(from);
				const fromOn =
					from === undefined
						? undefined
						: copiedOn(
								capabilities.hosts.find((host) => host.id === fromHostId),
								capabilities.sizes,
							);
				const machine =
					type !== "microvm"
						? undefined
						: sandboxMachine(
								template !== undefined
									? { template: template.spec.resources ?? DEFAULT_TEMPLATE_RESOURCES }
									: from === undefined
										? undefined
										: { copies: from, on: fromOn },
								machineAsked,
								presets,
							);
				if (type === "microvm" && machine === undefined) {
					throw placementError(
						"not_supported",
						"no_host_offers_size",
						`No host this sandbox may use offers the size ${body.size ?? "default"}`,
					);
				}
				// Not less memory than its snapshot's save asked for (`minMemoryMb`), refused before anything is stored.
				if (type === "microvm" && from !== undefined) {
					requireMinMemory(from, memoryOf(machine, fromOn?.presets ?? presets, from));
				}
				// A disk asked for alone, on the machine it went to: some host must give it, as `shapeFor` checks a whole shape.
				if (diskAlone !== undefined && machine?.shape !== undefined) {
					requireMaker(eligible, capabilities.sizes, machine.shape);
				}
				// From the template's newest ready snapshot built as that machine, on its host, or a fresh boot.
				const start =
					template === undefined || machine?.shape === undefined
						? undefined
						: await templates.startFor(template, {
								shape: machine.shape,
								eligibleHosts: hosts,
								hostPools: new Map((await known).map((host) => [host.id, host.poolId])),
								// A copy of its snapshot on another host is restored only where its memory restores.
								hostFingerprints: new Map((await known).map((host) => [host.id, host])),
								// A disk asked for is given from a template snapshot only by hosts that say their disk limits (this
								// kantel-host and later), which grow the snapshot's disk to it or boot fresh where it is bigger.
								restoreOn: eligible.filter((host) => host.disk !== undefined).map((host) => host.id),
							});
				const name = body.name ?? generatedName();
				const sandbox: StoredSandbox = {
					id: randomId("sbx"),
					accountId: account.id,
					name,
					subdomain: subdomainFor(name),
					type,
					size: machine?.size,
					...(machine?.shape === undefined ? {} : { shape: machine.shape }),
					// An isolate's memory is what it asked for (its host has no say); a microVM's is what its host gives it.
					...(type === "isolate" && shape !== undefined
						? { shape, resources: { vcpus: 0, memoryMb: shape.memoryMb, diskGb: 0 } }
						: {}),
					image: type === "microvm" ? (start?.image ?? body.image ?? capabilities.defaultImage) : undefined,
					state: "starting",
					visibility: account.kind === "personal" ? "private" : (body.visibility ?? account.defaultVisibility),
					capabilities: type === "microvm" ? MICROVM_CAPABILITIES : ISOLATE_CAPABILITIES,
					labels: { ...body.labels },
					autoStopMinutes: body.autoStopMinutes === undefined ? DEFAULT_AUTO_STOP_MINUTES : body.autoStopMinutes,
					idleStopMinutes: body.idleStopMinutes ?? null,
					...(body.autoUpgrade === true ? { autoUpgrade: true } : {}),
					...(body.autoUpgradeFrom === undefined ? {} : { autoUpgradeFrom: body.autoUpgradeFrom }),
					source: from === undefined ? undefined : { snapshotId: from.id },
					createdBy: actorOf(principal),
					createdAt: now(),
					ownerUserId: principal.userId,
					env,
					envLayers,
					// Its environments' set-up, done once it runs (and, if its boot fails, by its next start).
					...(environments.some((environment) => workFor(environment).length > 0)
						? { pendingProvision: environments.flatMap(workFor) }
						: {}),
					...environmentFields(environments.map((environment) => environment.id)),
					...(start === undefined
						? {}
						: {
								template: start.record,
								templateBoot: {
									...freshBoot(start.boot),
									// A custom image's holders, which a retry of the create keeps to.
									...(start.boot.rootfsKey === undefined ? {} : { holders: [...start.eligibleHosts] }),
								},
							}),
					grants,
					placeholders,
					egressRevision,
					hostLabels,
					...(hostPin === undefined ? {} : { hostPin }),
					...pooled(placedPool),
					runs: [],
					samples: [],
					ports: [],
					...(sandboxMounts === undefined ? {} : { mounts: sandboxMounts }),
					...(sandboxSticky === undefined ? {} : { stickyDisks: sandboxSticky }),
				};
				// Its sticky disks with no pool yet get its pool, once every check that could refuse it has passed: a create
				// refused never gives a disk its pool.
				if (sandboxSticky !== undefined && placedPool !== undefined) await bindStickyDisks(sandboxSticky, placedPool);
				// The record before its event: who may see an event is decided by its sandbox, so the event is never stored
				// (or delivered) before the sandbox is.
				const put = () => store.sandboxes.put(sandbox);
				if (from === undefined) await put();
				else if (!(await adopt(from.id, put, () => store.sandboxes.delete(sandbox.id).then(() => undefined)))) {
					throw deletedMeanwhile();
				}
				await holdAccount(account.id, [sandbox.id]);
				await dropDeleted(sandbox);
				// Its mounts' sources, still there now it is stored (so a delete from now on counts it): one deleted meanwhile
				// refuses the create, which forgets the sandbox before anything else saw it.
				if (sandboxMounts !== undefined && mounts !== undefined) {
					await mounts.holdSources(sandbox).catch(async (error: unknown) => {
						await store.sandboxes.delete(sandbox.id);
						throw error;
					});
				}
				// Its egress is read once it is stored: a change to its environment or the proxy settings from then on moves its
				// revision on (and its boot reconciles), which one read before couldn't promise. Read with the event's write.
				const [egress] = await Promise.all([
					egressFor(account.id, subject),
					emit("sandbox.created", account.id, { sandbox, data: { actor: actorOf(principal) } }),
				]);
				const work = track([sandbox.id], async () => {
					const sticky = await stickySpecOf(sandbox);
					const booted = await boot(
						sandbox.id,
						() =>
							backend.create({
								sandboxId: sandbox.id,
								accountId: account.id,
								type,
								subdomain: sandbox.subdomain,
								size: sandbox.size,
								...(sandbox.shape === undefined ? {} : { shape: sandbox.shape }),
								image: sandbox.image,
								env: sandbox.env,
								eligibleHosts: start?.eligibleHosts ?? placeOn,
								// Kept to its pool as the host admits it, from a snapshot too (its host's pool, as recorded).
								...pooled(sandbox.poolId),
								fromSnapshot: from?.ref,
								...(copies === undefined ? {} : { snapshotCopies: copies }),
								...(start === undefined ? {} : { template: start.boot }),
								...egress,
								...(sandboxMounts === undefined ? {} : { mounts: backendMounts(sandboxMounts) }),
								...sticky,
							}),
						sandbox,
						{ egressRevision },
					);
					// Queued with the boot, so a call after the create (an exec, a stop) finds the files and repositories there.
					if (booted?.state === "running" && environments.length > 0) {
						// As read when the call was authorised, not as they may be now.
						await provision(booted.id, environments).catch(() => undefined);
					}
					return booted;
				});
				// Its host's record from those read for placement, not read again.
				const placedOn = new Map((await known).map((host) => [host.id, Promise.resolve<StoredHost | undefined>(host)]));
				if (body.wait !== true) {
					keepGoing(work);
					// As written: it is starting.
					return sandboxView(sandbox, principal, placedOn);
				}
				// As the boot wrote it (`running` or `error`), unless something else moved it meanwhile, such as a delete.
				const booted = await work;
				return sandboxView(booted ?? (await mustGetSandbox(sandbox.id)), principal, placedOn);
			});
		},

		getSandbox: async (principal, { params }) => {
			await catchUpUsage();
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:read", true);
			const [view] = await withSnapshotTimes([await withMakerNamed(await sandboxView(sandbox, principal))]);
			return view as Sandbox;
		},

		updateSandbox: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			// `extendMinutes` and `autoStopMinutes` count from now: a retry with the key keeps the first call's stop time.
			return once(principal, "updateSandbox", { params, body, idempotencyKey }, async () => {
				const current = await settledFor(principal, sandbox.id);
				const account = await store.accounts.get(current.accountId);
				if (body.visibility === "organisation" && account?.kind === "personal") {
					throw new KantelError("invalid", "A personal account's sandboxes are always private");
				}
				if (typeof body.autoUpgradeFrom === "string") {
					if (current.type !== "isolate") {
						throw new KantelError("invalid", "autoUpgradeFrom is an isolate's: this sandbox is a microVM already");
					}
					await poolOfSnapshot(
						await checkAutoUpgradeFrom(principal, current.accountId, body.autoUpgradeFrom),
						await ensureHosts(),
						keptPool(await poolOfSandbox(current), UPGRADE_IN_POOL),
					);
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
						idleStopMinutes: body.idleStopMinutes === undefined ? latest.idleStopMinutes : body.idleStopMinutes,
						// A running sandbox's idle time counts from the change, as its auto-stop's does.
						...(body.idleStopMinutes !== undefined && latest.state === "running" ? { lastActiveAt: now() } : {}),
						visibility: body.visibility ?? latest.visibility,
						labels: body.labels === undefined ? latest.labels : { ...body.labels },
						autoUpgrade: body.autoUpgrade === undefined ? latest.autoUpgrade : body.autoUpgrade || undefined,
						autoUpgradeFrom:
							body.autoUpgradeFrom === undefined ? latest.autoUpgradeFrom : (body.autoUpgradeFrom ?? undefined),
						stopsAt,
					};
				});
				if (updated === undefined) throw notFound("sandbox");
				return sandboxView(updated, principal);
			});
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
			// One in `error` on a host (its host lost while it ran, a stop that failed) is stopped too, without its memory:
			// its host ends its machine, or answers its disk where it has none running, rather than the stop being refused
			// until a resume. One in `error` that never got a host has nothing to stop.
			const stopsError = current.state === "error" && current.hostId !== undefined && !keepMemory;
			if (current.state !== "running" && !(current.state === "paused" && !keepMemory) && !stopsError) {
				throw new KantelError("conflict", `The sandbox is ${current.state}`);
			}
			const { work } = await beginStop(current, keepMemory, undefined, principal);
			if (body.wait === true) await work;
			else keepGoing(work);
			return sandboxView(await mustGetSandbox(sandbox.id), principal);
		},

		resumeSandbox: async (principal, { params, body }) => restart(principal, params.sandboxId, body, "resume"),

		forkSandbox: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox: source, role } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			return once(principal, "forkSandbox", { params, body, idempotencyKey }, async () => {
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
				// What they are: what the snapshot was taken of (an upgraded sandbox's snapshots from before are an isolate's),
				// or forked live, what the source is now.
				const type = snapshot?.sandboxType ?? current.type;
				const sameType = type === current.type;
				if (type === "isolate" && body.size !== undefined) {
					throw new KantelError("invalid", "Isolates have no size");
				}
				const account = await store.accounts.get(current.accountId);
				if (account?.kind === "personal" && body.visibility === "organisation") {
					throw new KantelError("invalid", "A personal account's sandboxes are always private");
				}
				await requireCapacity(current.accountId, count);
				const known = await ensureHosts();
				// Their pool: from a snapshot, the snapshot's (refused where its host has since gone to another), else the
				// source's, whose host they stay on.
				const forkPool =
					snapshot === undefined ? current.poolId : ((await poolOfSnapshot(snapshot, known)) ?? current.poolId);
				const hosts = requireHosts(
					known,
					current.accountId,
					type,
					current.hostLabels,
					true,
					await mayShare(principal),
					current.hostPin,
				);
				const forks: StoredSandbox[] = [];
				// Their machine, as every create decides it (`sandboxMachine`): from a snapshot, that of the sandbox it was taken
				// of (the source's now, for one from before snapshots kept it) unless `size` names another. Forked live, the
				// source's own, whatever `size` says: a host copies the running machine as it is.
				const copies = snapshot !== undefined && recordsMachine(snapshot) ? snapshot : current;
				const machine =
					type !== "microvm"
						? undefined
						: snapshot === undefined
							? sandboxMachine({ copies: current }, {}, [])
							: sandboxMachine(
									{
										copies,
										// Its snapshot is on the source's host, which another size is then made as: its preset, keeping a
										// copied disk bigger than the preset's own.
										on: await backend.capabilities().then((capabilities) =>
											copiedOn(
												capabilities.hosts.find((host) => host.id === current.hostId),
												capabilities.sizes,
											),
										),
									},
									// From a snapshot holding memory, only its own machine (`restoreAsked`), refused before any fork is stored.
									restoreAsked(
										{ id: snapshot.id, memory: await holdsMemory(snapshot), ...recordedMachine(snapshot) },
										body.size === undefined ? {} : { size: body.size },
									),
									[],
								);
				// What they will be given, where that is the machine they copy: on their records from the start, so a fork never
				// reads as having no machine (shown as the smallest size) while it starts. Their placements then say what they got.
				const resources = type === "microvm" ? copiedResources(copies, machine) : undefined;
				// The source's exposed ports, as they are now: each fork gets them once it runs (`copyPorts`).
				// Only for a caller who may open them (`access`): a port is exposed as its caller, and stops working once they
				// may not (`stillAllowed`), so one copied for a key without the scope would be listed but refuse everyone. Such a
				// key still forks; its forks get no ports.
				const forkCapabilities = sameType ? current.capabilities : ISOLATE_CAPABILITIES;
				const sourcePorts =
					forkCapabilities.ports && mayUse(principal, "access", role) ? current.ports.map((port) => ({ ...port })) : [];
				const grantee = encodeGrantee(principal);
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
						type,
						size: machine?.size,
						...(machine?.shape === undefined ? {} : { shape: { ...machine.shape } }),
						...(resources === undefined ? {} : { resources: { ...resources } }),
						// An isolate asks for its source's memory, where its source is one; from an isolate's snapshot of a sandbox
						// since upgraded, the memory that isolate had, as its snapshot recorded it.
						...(type === "isolate" && sameType && current.shape !== undefined ? { shape: { ...current.shape } } : {}),
						...(type === "isolate" && sameType && current.resources !== undefined
							? { resources: current.resources }
							: {}),
						...(type === "isolate" && !sameType && snapshot?.resources !== undefined
							? {
									shape: { vcpus: 0, memoryMb: snapshot.resources.memoryMb },
									resources: { ...snapshot.resources },
								}
							: {}),
						// An isolate has no image: not the microVM's its source became.
						image: sameType ? current.image : undefined,
						state: "starting",
						visibility: account?.kind === "personal" ? "private" : (body.visibility ?? current.visibility),
						capabilities: forkCapabilities,
						labels: body.labels === undefined ? { ...current.labels } : { ...body.labels },
						autoStopMinutes: current.autoStopMinutes,
						idleStopMinutes: current.idleStopMinutes ?? null,
						source: { sandboxId: current.id, snapshotId: snapshot?.id },
						createdBy: actorOf(principal),
						createdAt: now(),
						ownerUserId: principal.userId,
						env,
						...environmentFields(environmentIdsOf(current)),
						...(current.envLayers === undefined ? {} : { envLayers: current.envLayers }),
						...(current.secretsFloor === undefined ? {} : { secretsFloor: current.secretsFloor }),
						...(current.pendingProvision === undefined ? {} : { pendingProvision: [...current.pendingProvision] }),
						grants: (current.grants ?? []).map(copyGrant),
						placeholders,
						egressRevision,
						hostLabels: { ...current.hostLabels },
						...(current.hostPin === undefined ? {} : { hostPin: current.hostPin }),
						...pooled(forkPool),
						runs: [],
						samples: [],
						ports: [],
						// A fork keeps its source's mounts, put in place afresh on its own machine.
						...(current.mounts === undefined ? {} : { mounts: pendingMounts(current.mounts), mountsAt: undefined }),
					});
				}
				const putForks = async () => {
					for (const fork of forks) await store.sandboxes.put(fork);
				};
				const dropForks = async () => {
					for (const fork of forks) await store.sandboxes.delete(fork.id);
				};
				if (snapshot === undefined) await putForks();
				else if (!(await adopt(snapshot.id, putForks, dropForks))) throw deletedMeanwhile();
				if (forks[0] !== undefined)
					await holdAccount(
						forks[0].accountId,
						forks.map((fork) => fork.id),
					);
				// Each fork holds its own reference to the source's mounts' sources: checked once they are all stored, as a
				// create's are, so the source's delete (and the sources' deletes) can't leave one mounting what is gone.
				const first = forks[0];
				if (mounts !== undefined && first?.mounts !== undefined) {
					try {
						await mounts.holdSources(first);
					} catch (error) {
						for (const fork of forks) await store.sandboxes.delete(fork.id);
						throw error;
					}
				}
				for (const fork of forks) {
					await dropDeleted(fork);
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
						const booted = await boot(
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
											...(fork.shape === undefined ? {} : { shape: fork.shape }),
											image: fork.image,
											env: fork.env,
											eligibleHosts: hosts,
											// Its pool, which its source's host (or its snapshot's) admits it only while in.
											...pooled(fork.poolId),
											...egress,
											...(fork.mounts === undefined ? {} : { mounts: backendMounts(fork.mounts) }),
										},
									],
								);
								if (placement === undefined) throw new KantelError("unavailable", "The fork was not placed");
								return placement;
							},
							undefined,
							{ egressRevision },
						);
						// An environment attached to its source while stopped: its files and repositories, which the copied disk
						// never had.
						if (booted?.state === "running" && (booted.pendingProvision?.length ?? 0) > 0) {
							const provisioning = await provisionedAgain(principal, role, booted, true).catch(() => undefined);
							if (provisioning !== undefined)
								await provision(booted.id, provisioning.environments).catch(() => undefined);
						}
						// Best effort, as each port is: a failure here (its records' store down, say) leaves this fork running without
						// them, and never stops the batch's other forks booting.
						if (booted?.state === "running") await copyPorts(booted, sourcePorts, grantee).catch(() => undefined);
					}
				});
				if (body.wait === true) await work;
				else keepGoing(work);
				const items: Sandbox[] = [];
				for (const fork of forks) items.push(await sandboxView(await mustGetSandbox(fork.id), principal));
				return { items };
			});
		},

		upgradeSandbox: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox, role } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			return once(principal, "upgradeSandbox", { params, body, idempotencyKey }, async () =>
				sandboxView(await upgradeIsolate(principal, role, sandbox.id, body), principal),
			);
		},

		recoverSandbox: async (principal, { params, idempotencyKey }) => {
			const { sandbox, role } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			// A running sandbox is recovered too, so a retry would restart it again: with the key it answers the first.
			return once(principal, "recoverSandbox", { params, idempotencyKey }, async () => {
				const current = await settledFor(principal, sandbox.id);
				if (current.state !== "running" && current.state !== "error") {
					throw new KantelError("conflict", `A ${current.state} sandbox is started or resumed, not recovered`);
				}
				const hosts = await hostsToBoot(principal, current);
				const fromSnapshot = await latestRef(current);
				requireSetupScope(principal, role, current);
				// Refused now, as its create would be; read again once it is starting, for an attach meanwhile.
				await provisionedAgain(principal, role, current);
				// A boot's egress is read afresh, so it gets a revision of its own: an update read before (from when it last ran,
				// say, still being retried) never equals it, and loses.
				const began = await transition(current.id, current.state, (latest) =>
					withState(latest, "starting", {
						ports: [],
						egressRevision: later(latest.egressRevision),
						...(latest.mounts === undefined ? {} : { mounts: pendingMounts(latest.mounts), mountsAt: undefined }),
					}),
				);
				if (!("moved" in began)) throw new KantelError("conflict", `The sandbox is ${began.lost.state}`);
				const starting = began.moved;
				const provisioning = await provisionedAgain(principal, role, starting, true);
				// As written now it is starting: a change from here on moves its revision on, and its boot reconciles.
				const egress = await egressFor(starting.accountId, starting);
				keepGoing(
					track([current.id], () =>
						bootProvisioned(
							current.id,
							() =>
								bootAgain(
									starting,
									{
										fromSnapshot,
										env: starting.env,
										eligibleHosts: hosts,
										...sizingOf(starting),
										...egress,
										...(starting.mounts === undefined ? {} : { mounts: backendMounts(starting.mounts) }),
									},
									(options) => backend.recover(current.id, options),
								),
							provisioning,
							{ egressRevision: starting.egressRevision },
						),
					),
				);
				return sandboxView(starting, principal);
			});
		},

		restartSandboxOnLatest: async (principal, { params, idempotencyKey }) => {
			requireImagePatching();
			const { sandbox, role } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			// Once it is running again, a retry would stop and reboot it a second time: with the key it answers the first.
			return once(principal, "restartSandboxOnLatest", { params, idempotencyKey }, async () => {
				// Mid-lifecycle (another restart's boot, a stop, a delete): refused as it is, rather than waited for and then
				// restarted again over what that work did.
				if (sandbox.state === "starting" || sandbox.state === "stopping" || sandbox.state === "deleting") {
					throw new KantelError("conflict", `The sandbox is ${sandbox.state}`);
				}
				let current = await settledFor(principal, sandbox.id);
				if (
					current.state !== "running" &&
					current.state !== "stopped" &&
					current.state !== "paused" &&
					current.state !== "error"
				) {
					throw new KantelError("conflict", `The sandbox is ${current.state}`);
				}
				// One never placed is made again from its template (`bootAgain`), its setup run: checked before anything moves.
				requireSetupScope(principal, role, current);
				// Its lifecycle as checked here: the stop and the boot below are claimed only while nothing else (another restart, a
				// recovery, on any gateway) has moved it since, even if it is back in the state read.
				const unmoved = (seen: StoredSandbox) => (latest: StoredSandbox) =>
					(latest.lifecycle ?? 0) === (seen.lifecycle ?? 0);
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
					current.hostPin,
				);
				// Where it is to land: the host images version the index's `stable` names, whatever base it reported (none, for
				// one from before image patching); a container's image (a digest) is its backend's to pick. Checked with the
				// machine its disk is on before anything stops, so a restart that can't get there (no stable host images in the
				// index, a host that isn't eligible, doesn't patch images, or hasn't taken that version yet) leaves the sandbox
				// as it is.
				await refreshBase();
				const onHostImages = current.base === undefined || baseImageOf(current.base) === HOST_BASE_IMAGE;
				const rebaseTo = onHostImages && baseIndex !== undefined ? hostImageChannel(baseIndex)?.version : undefined;
				const prepared = await backend.prepareRebase?.(current.id, {
					eligibleHosts: hosts,
					...(rebaseTo === undefined ? {} : { rebaseTo }),
				});
				// One recorded as `error` may still be running on its host (a boot that finished after its call gave up): it is
				// stopped as a running one is, since the host's start would otherwise find it running and not boot it anew.
				// Once this restart has stopped it, a move it then loses is `aborted` (409 too), not `conflict`: its key stays held
				// (`once`), so a retry never stops whatever started the sandbox since.
				let stoppedIt = false;
				if (current.state === "running" || (current.state === "error" && prepared?.running === true)) {
					// Its disk is saved first, as a stop saves it (without its memory, which a new base can't take): the boot below
					// starts from that snapshot. Waited for, as the boot needs it.
					const { work, stopping } = await beginStop(current, false, undefined, principal, unmoved(current));
					// Its stop has begun (its commands are ended): from here any failure is `aborted`, which keeps the key.
					stoppedIt = true;
					try {
						await work;
					} catch (error) {
						throw new KantelError("aborted", `The restart stopped part way: ${messageOf(error)}`);
					}
					current = await mustGetSandbox(current.id);
					// Stopped by this stop and nothing since: one step on from the `stopping` it wrote.
					if (current.state !== "stopped" || (current.lifecycle ?? 0) !== (stopping.lifecycle ?? 0) + 1) {
						throw new KantelError("aborted", `The sandbox is ${current.state}`);
					}
				}
				const fromSnapshot = await latestRef(current);
				// A boot's egress is read afresh, so it gets a revision of its own, as a recovery's does. A paused sandbox's memory
				// is let go: the machine boots cold on the new base.
				const began = await transition(
					current.id,
					current.state,
					(latest) =>
						withState(latest, "starting", {
							ports: [],
							pausedSnapshotId: undefined,
							egressRevision: later(latest.egressRevision),
							// Its mounts go with it, as a start's do, each pending until the boot says.
							...(latest.mounts === undefined ? {} : { mounts: pendingMounts(latest.mounts), mountsAt: undefined }),
						}),
					unmoved(current),
				);
				if (!("moved" in began))
					throw new KantelError(stoppedIt ? "aborted" : "conflict", `The sandbox is ${began.lost.state}`);
				const starting = began.moved;
				const stopped = current;
				// An environment attached while it was stopped: its files and repositories, once it runs.
				const provisioning = await provisionedAgain(principal, role, starting, true);
				// As written now it is starting: a change from here on moves its revision on, and its boot reconciles.
				const egress = await egressFor(starting.accountId, starting);
				keepGoing(
					track([stopped.id], () =>
						bootProvisioned(
							stopped.id,
							() =>
								bootAgain(
									stopped,
									{
										fromSnapshot,
										env: starting.env,
										eligibleHosts: hosts,
										// Its size and shape as recorded, as a start keeps them: only its base changes.
										...sizingOf(stopped),
										...egress,
										...(starting.mounts === undefined ? {} : { mounts: backendMounts(starting.mounts) }),
										rebase: true,
										...(rebaseTo === undefined ? {} : { rebaseTo }),
									},
									(options) => backend.start(stopped.id, options),
								),
							provisioning,
							{ egressRevision: starting.egressRevision },
						),
					),
				);
				return sandboxView(starting, principal);
			});
		},

		// Without a key, a delete once it is done is `not_found`, as a deleted sandbox is. With one, a retry answers the first
		// call's answer: the check is inside, as a deleted sandbox isn't found, and the key is the caller's own.
		deleteSandbox: async (principal, { params, idempotencyKey }) =>
			once(principal, "deleteSandbox", { params, idempotencyKey }, async () => {
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
								await forgetSnapshot(snapshot);
								await releaseRef(snapshot);
							} else {
								// As it is now: forgetting an automatic one may have just passed its memory flag on to it.
								await store.snapshots.update(snapshot.id, (latest) => ({ ...latest, sandboxId: undefined }));
							}
						}
						const result = await transition(current.id, "deleting", (latest) =>
							withState(latest, "deleted", {
								ports: [],
								latestSnapshotId: undefined,
								latestSnapshotAt: undefined,
								pausedSnapshotId: undefined,
							}),
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
			}),

		getSandboxUsage: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:read", true);
			await catchUpUsage();
			await readUsage(sandbox, FALLBACK_READ_GAP_MS);
			const current = await mustGetSandbox(sandbox.id);
			const kept = withPartial(current);
			const at = now();
			const intervalMs = (query.intervalSeconds ?? 300) * 1000;
			const since = Math.max(query.since ?? at - DAY_MS, current.createdAt - intervalMs);
			const rate = rateOf(current);
			const start = Math.max(since, at - 1000 * intervalMs);
			const points: computeSchema.SandboxUsagePoint[] = [];
			for (let from = start; from < at; from += intervalMs) {
				const to = Math.min(from + intervalMs, at);
				const seconds = runningMs(current.runs, from, to) / 1000;
				const mean = spanMean(kept, from, to);
				points.push({
					at: from,
					cpu: Math.min(1, mean.cpu),
					memoryMb: round(mean.memoryMb),
					runningSeconds: round(seconds),
					cost: round(costOf(current, from, to)),
					measured: mean.measured,
					...(mean.cpuMax === undefined ? {} : { cpuMax: Math.min(1, mean.cpuMax) }),
					...(mean.memoryMbMax === undefined ? {} : { memoryMbMax: round(mean.memoryMbMax) }),
					...(mean.diskMb === undefined ? {} : { diskUsedBytes: Math.round(mean.diskMb * MIB) }),
					...(mean.io === undefined ? {} : { ioPressure: Math.min(1, mean.io) }),
				});
			}
			const seconds = runningMs(current.runs, since, at) / 1000;
			const series = sandboxSeries.read(current.id, query.since);
			const memLimit =
				series.meta?.memLimitBytes ??
				(current.resources?.memoryMb === undefined ? undefined : current.resources.memoryMb * MIB);
			// The disk's size as its guest last counted it; else, where it has disk figures kept from before this process
			// started, its size's.
			const diskTotal =
				series.meta?.diskTotalBytes ??
				(current.resources?.diskGb !== undefined && kept.some((sample) => sample.diskMb !== undefined)
					? current.resources.diskGb * 1024 * MIB
					: undefined);
			return {
				sandboxId: current.id,
				intervalSeconds: intervalMs / 1000,
				points,
				totals: {
					runningSeconds: round(seconds),
					cpuSeconds: round(seconds * meanCpu(current, since, at)),
					cost: { currency: rates.currency, total: round(costOf(current, since, at)), ratePerHour: rate },
				},
				...(memLimit === undefined ? {} : { memLimitBytes: Math.round(memLimit) }),
				...(diskTotal === undefined ? {} : { diskTotalBytes: diskTotal }),
				...peakView(peakOf(current)),
				series: {
					intervalMs:
						series.meta?.intervalMs ?? (hostReports(current.hostId) ? USAGE_INTERVAL_MS : FALLBACK_INTERVAL_MS),
					points: series.points.map((point) => ({
						at: point.at,
						cpu: point.cpu,
						memUsedBytes: point.memUsedBytes,
						...(point.noDisk === true ? {} : { diskUsedBytes: point.diskUsedBytes }),
						...(point.ioPressure === undefined ? {} : { ioPressure: point.ioPressure }),
						...(point.oomKills === undefined ? {} : { oomKills: point.oomKills }),
						...(point.memPressureSome === undefined ? {} : { memPressureSome: point.memPressureSome }),
						...(point.memPressureFull === undefined ? {} : { memPressureFull: point.memPressureFull }),
					})),
				},
				...guestMemoryView(current.id),
			};
		},

		// Commands and files.

		runCommand: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox, role } = await sandboxFor(principal, params.sandboxId, "exec");
			return once(principal, "runCommand", { params, body, idempotencyKey }, async () => {
				let rerun: StoredCommand | undefined;
				// An isolate with `autoUpgrade` whose command needed a microVM: upgraded, and the command run again there,
				// once, where it ran (`/workspace` is the same files in the microVM), before the first is recorded as ended,
				// with the run again's ID (`rerunAs`). A detached one's run again is detached too, and followed by its ID.
				// Whichever command's upgrade made the microVM: one that ran in the isolate with it (`command.autoUpgrade`),
				// whose answer comes once another's upgrade has begun or ended, is run again in that microVM, still opted in.
				const beforeEnd = async (command: StoredCommand, result: ExecResult) => {
					// Only what the isolate's runtime says: an inferred one is text the command may have printed.
					if (result.needsMicrovm === undefined || result.needsMicrovm.inferred === true) return undefined;
					if (command.autoUpgrade !== true) return undefined;
					// Another command's upgrade under way (on another gateway, whose queue this one doesn't see): its outcome is
					// waited for as a command's is, start hold after start hold, for up to half the time a reader holds this
					// command's end for it (`RERUN_CLAIM_MS`), by the clock, then read again.
					const waitOutUpgrade = async () => {
						let latest = await store.sandboxes.get(sandbox.id);
						const until = Date.now() + RERUN_CLAIM_MS / 2;
						while (latest?.upgrading !== undefined && Date.now() < until) {
							await requireRunning(principal, sandbox.id).catch(() => delay(startPollMs).done);
							latest = await store.sandboxes.get(sandbox.id);
						}
						return latest;
					};
					const latest = await waitOutUpgrade();
					if (latest?.autoUpgrade !== true) return undefined;
					if (latest.type !== "isolate" && latest.upgradedFrom === undefined) return undefined;
					// Claimed before the upgrade, so another reader of its end leaves it to this one.
					const claimed = await store.commands.update(command.id, (stored) =>
						stored.state === "running" ? { ...stored, rerunPending: stored.rerunPending ?? now() } : undefined,
					);
					if (claimed === undefined) return undefined;
					try {
						// Into what it names, read afresh: a saved snapshot saved again under the name gives its newest.
						await upgradeIsolate(
							principal,
							role,
							sandbox.id,
							latest.autoUpgradeFrom === undefined ? {} : { from: latest.autoUpgradeFrom },
						);
					} catch (error) {
						// Another command's upgrade began between the read above and this one's (`conflict` while it starts): its
						// outcome is waited for, and its microVM, if it made one, runs this command again too, still opted in.
						const after =
							error instanceof KantelError && error.code === "conflict" ? await waitOutUpgrade() : undefined;
						if (after?.type === "isolate" || after?.upgradedFrom === undefined || after.autoUpgrade !== true) {
							// The isolate is as it was: the command's answer stands, saying why it wasn't upgraded.
							return { note: `kantel: the isolate couldn't be upgraded to a microVM: ${messageOf(error)}\n` };
						}
					}
					// Run again only if it wasn't killed while its sandbox upgraded (the upgrade stands either way): its run
					// again's ID is written first, while it still runs, so a kill from then on reaches that run too.
					const rerunId = randomId("cmd");
					const fenced = await store.commands.update(command.id, (stored) =>
						stored.state === "running" ? { ...stored, rerunStarting: rerunId } : undefined,
					);
					if (fenced?.rerunStarting !== rerunId) return undefined;
					rerun = await runCommandOnce(
						principal,
						sandbox.id,
						{ ...body, cwd: command.cwd },
						{ rerunOf: command.id, id: rerunId },
					);
					return { rerunAs: rerun.id };
				};
				const first = await runCommandOnce(principal, sandbox.id, body, { beforeEnd });
				return commandView(rerun ?? first);
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
			// A detached command no gateway here follows is brought up to date from its backend first, as getCommand does.
			const items = await Promise.all(page.items.map((command) => fetchedCommand(command)));
			return { items: items.map(commandView), nextCursor: page.nextCursor };
		},
		getCommand: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const command = await store.commands.get(params.commandId);
			if (command === undefined || command.sandboxId !== sandbox.id) throw notFound("command");
			const fetched = await fetchedCommand(command);
			// Following a command that still runs (`kantel exec --attach`, an MCP client's `command_get`) is a use.
			if (fetched.state === "running") noteActivity(sandbox.id);
			return commandView(fetched);
		},

		killCommand: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const stored = await store.commands.get(params.commandId);
			if (stored === undefined || stored.sandboxId !== sandbox.id) throw notFound("command");
			return commandView(await killStored(sandbox.id, stored));
		},
		readFile: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(principal, sandbox.id);
			const path = resolvePath(query.path, homeFor(sandbox.type));
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
			const path = resolvePath(body.path, homeFor(sandbox.type));
			refuseInMount(sandbox, path);
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
			const path = resolvePath(query.path, homeFor(sandbox.type));
			const touching = mountsTouching(sandbox.mounts, path);
			if (touching.length > 0) {
				throw new KantelError("conflict", `${path} is in or over the read-only mount at ${touching[0]?.path}`);
			}
			await backend.deleteFile(sandbox.id, path);
			return undefined;
		},

		listFiles: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(principal, sandbox.id);
			const path = resolvePath(query.path ?? homeFor(sandbox.type), homeFor(sandbox.type));
			const page = paginate(await backend.listFiles(sandbox.id, path), query.limit, query.cursor);
			return { path, items: page.items.map(fileEntry), nextCursor: page.nextCursor };
		},

		// Read from the sandbox's machine when asked (its guest agent samples its CPU for half a second) and kept nowhere. A
		// metrics dialog asks every few seconds while it's open, so it isn't a use of the sandbox: unlike `requireRunning`,
		// it neither waits for a start nor notes activity, which would hold off the sandbox's idle stop.
		listSandboxProcesses: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			if (sandbox.type === "isolate") {
				throw new KantelError(
					"not_supported",
					"An isolate's processes aren't listed: it shares its runtime with the account's other isolates",
				);
			}
			if (backend.processes === undefined) {
				throw new KantelError("not_supported", "This deployment's sandboxes can't list their processes");
			}
			if (sandbox.state !== "running") throw sandboxNotRunning(sandbox, apiBasePath);
			await requireHostReachable(sandbox);
			const { processes, total } = await backend.processes(sandbox.id, query.limit ?? 10);
			return {
				items: processes.map(({ pid, command, cpuPercent, memoryBytes }) => ({
					pid,
					command,
					cpuPercent,
					memoryBytes,
				})),
				total,
			};
		},

		// Ports, desktop, browser and SSH.

		listPorts: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			return { items: [...sandbox.ports] };
		},

		exposePort: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			if (!sandbox.capabilities.ports) throw new KantelError("not_supported", "This sandbox can't expose ports");
			// A gated port's URL holds its token, which each expose replaces: its answer is kept sealed.
			const secret = body.public === true ? {} : { secret: true as const };
			return once(
				principal,
				"exposePort",
				{ params, body, idempotencyKey },
				async () => {
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
				secret,
			);
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
			// The browser alone where the machine runs it on its own surface, as the backend finds it there (not the image's
			// report, which another boot of it made); else the desktop it runs on.
			const access = await backend.openBrowser(current.id, { viewOnly, ttlMinutes, grantee: encodeGrantee(principal) });
			return {
				url: access.url,
				embedUrl: access.url,
				cdpUrl: access.cdpUrl,
				surface: access.surface ?? "desktop",
				viewOnly,
				expiresAt: now() + ttlMinutes * 60_000,
			};
		},

		// Snapshots.

		listSnapshots: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "snapshots:read", role);
			const visible: StoredSnapshot[] = [];
			const all = await store.snapshots.list({ accountId: account.id });
			// The bytes that hold memory, from the same read (`holdsMemory`): a save shares its source's ref, in its account.
			const memoryRefs = new Set(all.flatMap((snapshot) => (snapshot.memory && snapshot.ref ? [snapshot.ref] : [])));
			for (const snapshot of all) {
				if (query.kind !== undefined && snapshot.kind !== query.kind) continue;
				if (query.sandboxId !== undefined && snapshot.sandboxId !== query.sandboxId) continue;
				if (snapshot.state === "deleting") continue;
				if (await canSeeSnapshot(principal, snapshot)) visible.push(snapshot);
			}
			const page = paginate(newestFirst(visible), query.limit, query.cursor);
			const uses = page.items.length === 0 ? new Map<string, number>() : await usesIn(account.id);
			const items = page.items.map((snapshot) =>
				snapshotView(
					{
						...snapshot,
						memory: snapshot.memory || (snapshot.ref !== undefined && memoryRefs.has(snapshot.ref)),
					},
					uses.get(snapshot.id) ?? 0,
				),
			);
			return { items, nextCursor: page.nextCursor };
		},

		takeSnapshot: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "snapshots:write");
			return once(principal, "takeSnapshot", { params, body, idempotencyKey }, async () => {
				const current = await requireRunning(principal, sandbox.id);
				const taken = await backend.takeSnapshot(current.id, { memory: body.memory === true });
				await requireSameTier(current, taken);
				const at = now();
				const snapshot: StoredSnapshot = {
					id: randomId("snap"),
					accountId: current.accountId,
					kind: "automatic",
					description: body.description,
					...(body.labels === undefined ? {} : { labels: body.labels }),
					sandboxId: current.id,
					sandboxType: current.type,
					state: "ready",
					trigger: "manual",
					memory: taken.memory === true,
					...recordedMachine(current),
					sizeBytes: taken.sizeBytes,
					createdAt: at,
					takenAt: at,
					createdBy: actorOf(principal),
					expiresAt: at + AUTOMATIC_SNAPSHOT_TTL_MS,
					ref: taken.ref,
					...(taken.hostId === undefined ? {} : { hostId: taken.hostId }),
					...(taken.base === undefined ? {} : { base: taken.base }),
					...madeOnOf(taken),
					...pooled(await poolOfTaken(current, taken.ref)),
				};
				await store.snapshots.put(snapshot);
				await holdSnapshot(snapshot);
				// What it resumes from, only while it is still what the snapshot is of (an upgrade since makes it a microVM).
				await patchSandbox(current.id, (latest) =>
					latest.type === snapshot.sandboxType
						? { ...latest, latestSnapshotId: snapshot.id, latestSnapshotAt: snapshot.createdAt }
						: undefined,
				);
				return snapshotView(snapshot);
			});
		},

		saveSnapshot: async (principal, { body, idempotencyKey }) => {
			const { sandbox } = await sandboxFor(principal, body.sandboxId, "snapshots:write");
			// A retry would be `conflict` on its own name, or with `replace` save it again and delete the first.
			return once(principal, "saveSnapshot", { body, idempotencyKey }, async () => {
				// Its host away: refused before waiting behind what's queued on it (a stop waits minutes for the host).
				await requireHostReachable(sandbox);
				const current = await settledFor(principal, sandbox.id);
				// Not a refused save of the name still having its bytes deleted (`withdrawSave`).
				const [existing] = (
					await store.snapshots.list({ accountId: current.accountId, kind: "saved", name: body.name })
				).filter((saved) => saved.state !== "deleting");
				if (existing !== undefined && body.replace !== true) {
					throw new KantelError("conflict", `A saved snapshot is already named ${body.name}`);
				}
				// A history entry, or a stopped sandbox's newest snapshot: its bytes kept under a ref of the saved snapshot's
				// own (`keepSnapshot`), since a host prunes automatic snapshots, and removes them with their sandbox. The
				// entry stays in the sandbox's history, automatic, on its own ref.
				const source =
					body.snapshotId !== undefined
						? await store.snapshots.get(body.snapshotId)
						: current.state === "running" || current.latestSnapshotId === undefined
							? undefined
							: await store.snapshots.get(current.latestSnapshotId);
				if (body.snapshotId !== undefined && (source === undefined || source.sandboxId !== current.id)) {
					throw notFound("snapshot of this sandbox");
				}
				// What its bytes are of: a copied snapshot's own (an upgraded sandbox's from before are an isolate's), else what
				// the sandbox is now.
				const type = source?.sandboxType ?? current.type;
				if (body.minMemoryMb !== undefined && body.minMemoryMb > 0 && type !== "microvm") {
					throw new KantelError("invalid", "Only a microVM's snapshot takes minMemoryMb");
				}
				// The least memory a sandbox made from it may have: as given, 0 for none, else the one it replaces keeps its own.
				const minMemoryMb =
					body.minMemoryMb === undefined ? existing?.minMemoryMb : body.minMemoryMb > 0 ? body.minMemoryMb : undefined;
				if (existing === undefined && limits.savedSnapshots !== undefined) {
					const saved = (await store.snapshots.list({ accountId: current.accountId, kind: "saved" })).filter(
						(record) => record.state !== "deleting",
					);
					if (saved.length >= limits.savedSnapshots) {
						throw new KantelError("exhausted", `The account may keep ${limits.savedSnapshots} saved snapshots`);
					}
				}
				let ref: string;
				// The host its bytes were taken on, where the backend said: where its ref names none, its first holder.
				let takenOn: string | undefined;
				let sizeBytes: number | undefined;
				// All its files take, shared ones included: what the host's limit counts it at.
				let fullSizeBytes: number | undefined;
				// The base its disk is on, from what it is saved from: kept so a template made from it shows how far behind it is.
				let base: string | undefined;
				// Whether the bytes hold memory: a copied snapshot's own say, or the host's for one taken now.
				let memory = false;
				// What its memory was made on, where its host said.
				let made: SnapshotMadeOn = {};
				// When the bytes were taken: a copied snapshot's own time (its source's, for one saved before this was kept), else now.
				let takenAt: number | undefined;
				// The machine of the sandbox when the bytes were taken: a copied snapshot's own, where it records one, else the
				// sandbox's where it is still what they were taken of (an isolate's records none).
				let machine = type === current.type ? recordedMachine(current) : {};
				if (source !== undefined) {
					const from = readyRef(source);
					await requireSnapshotHostReachable(from);
					const kept = await backend.keepSnapshot?.(from);
					// Sharing its source's bytes, it names them as its source does.
					ref = kept?.ref ?? source.ref ?? from;
					takenOn = kept === undefined ? source.hostId : kept.hostId;
					// Its new bytes are recorded (`admitSave`) whatever happens here: a size not worked out is its whole size.
					sizeBytes =
						kept === undefined ? source.sizeBytes : await keptSize(kept, existing).catch(() => kept.sizeBytes);
					// Sharing its source's ref: the source's full size, where recorded (else read from the host when counted).
					fullSizeBytes = kept === undefined ? source.fullSizeBytes : kept.sizeBytes;
					base = kept?.base ?? source.base;
					made = madeOnOf(kept?.runtime === undefined ? source : kept);
					memory = kept?.memory ?? (await holdsMemory(source));
					takenAt = source.takenAt ?? (source.kind === "automatic" ? source.createdAt : undefined);
					if (recordsMachine(source)) machine = recordedMachine(source);
				} else if (current.state === "running") {
					// Its host went while the save waited.
					await requireHostReachable(current);
					// At the host's limit already: nothing is taken.
					const full = await savedBytesOver(current.accountId, current.hostId, existing);
					if (full !== undefined) throw full;
					const taken = await backend.takeSnapshot(current.id, { memory: body.memory === true });
					await requireSameTier(current, taken);
					ref = taken.ref;
					takenOn = taken.hostId;
					sizeBytes = await keptSize(taken, existing).catch(() => taken.sizeBytes);
					fullSizeBytes = taken.sizeBytes;
					base = taken.base;
					made = madeOnOf(taken);
					memory = taken.memory === true;
				} else {
					throw new KantelError("conflict", "The sandbox has no state to save yet");
				}
				const savedAt = now();
				// Stored and counted before it's let through, so saves at once can't pass the limit together; refused, its
				// new bytes go again (a shared source's stay).
				const snapshot: StoredSnapshot = {
					id: randomId("snap"),
					accountId: current.accountId,
					kind: "saved",
					name: body.name,
					description: body.description,
					...(body.labels === undefined ? {} : { labels: body.labels }),
					sandboxId: current.id,
					sandboxType: type,
					state: "ready",
					trigger: "save",
					memory,
					...machine,
					...(minMemoryMb === undefined ? {} : { minMemoryMb }),
					sizeBytes,
					...(fullSizeBytes === undefined ? {} : { fullSizeBytes }),
					createdAt: savedAt,
					...(source === undefined ? { takenAt: savedAt } : takenAt === undefined ? {} : { takenAt }),
					createdBy: actorOf(principal),
					ref,
					...(takenOn === undefined ? {} : { hostId: takenOn }),
					...(base === undefined ? {} : { base }),
					...made,
					// A copy's is its source's: the pool it was taken in.
					...pooled(source?.poolId ?? (await poolOfTaken(current, ref))),
				};
				await admitSave(snapshot, existing);
				await holdSnapshot(snapshot);
				if (existing !== undefined) {
					await forgetSnapshot(existing);
					await releaseRef(existing);
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
			});
		},

		getSnapshot: async (principal, { params }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:read");
			const uses = (await usesIn(snapshot.accountId)).get(snapshot.id) ?? 0;
			const memory = await holdsMemory(snapshot);
			const hosts = await snapshotHostsView(principal, { ...snapshot, memory });
			return { ...snapshotView({ ...snapshot, memory }, uses), ...(hosts === undefined ? {} : { hosts }) };
		},

		listSnapshotFiles: async (principal, { params, query }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:read");
			const home = homeFor(snapshot.sandboxType);
			const path = resolvePath(query.path ?? home, home);
			const ref = readyRef(snapshot);
			// Its files are on its host: refused at once while that's away (its record and history are still answered).
			await requireSnapshotHostReachable(ref);
			const page = paginate(await backend.listSnapshotFiles(ref, path), query.limit, query.cursor);
			return { path, items: page.items.map(fileEntry), nextCursor: page.nextCursor };
		},

		readSnapshotFile: async (principal, { params, query }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:read");
			const path = resolvePath(query.path, homeFor(snapshot.sandboxType));
			const ref = readyRef(snapshot);
			await requireSnapshotHostReachable(ref);
			const bytes = await backend.readSnapshotFile(ref, path);
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
			await forgetSnapshot(snapshot);
			await releaseRef(snapshot);
			// Its running sandbox's newest moves back to the one before it, by `adopt` (expiry may be deleting that one): the
			// first still there, else none; a pointer another write moved meanwhile is left as it is. Only one of what the
			// sandbox is now: an upgraded sandbox's from before are an isolate's, which its microVM never starts from.
			if (current !== undefined && current.latestSnapshotId === snapshot.id) {
				const older = newestFirst(
					(await store.snapshots.list({ sandboxId: current.id, kind: "automatic" })).filter(
						(entry) => entry.state === "ready" && entry.sandboxType === current.type,
					),
				);
				const pointAt = async (to: StoredSnapshot | undefined, was: string | undefined) =>
					(await patchSandbox(current.id, (latest) =>
						latest.latestSnapshotId === was
							? { ...latest, latestSnapshotId: to?.id, latestSnapshotAt: to?.createdAt }
							: undefined,
					)) !== undefined;
				let was: string | undefined = snapshot.id;
				let pointed = false;
				for (const candidate of older) {
					let wrote = false;
					const kept = await adopt(
						candidate.id,
						async () => {
							wrote = await pointAt(candidate, was);
						},
						async () => {
							if (wrote) await pointAt(undefined, candidate.id);
						},
					);
					if (!wrote || kept) {
						pointed = true;
						break;
					}
					was = undefined;
				}
				if (!pointed) await pointAt(undefined, was);
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
			return {
				items: await withMakersNamed(newestFirst(await store.apiKeys.list({ accountId: account.id })).map(apiKeyView)),
			};
		},

		createApiKey: async (principal, { body, idempotencyKey }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			// Checked before `once`, so a retry answered the first call's secret is held to what the caller may grant now.
			const scopes = unique([
				...(body.scopes ?? []),
				...(body.preset === undefined ? [] : computeSchema.API_KEY_PRESETS[body.preset]),
			]);
			if (scopes.length === 0) throw new KantelError("invalid", "Give scopes or a preset");
			requireGrantable(principal, scopes);
			const sandboxIds = grantableSandboxes(principal, body.sandboxIds);
			return once(
				principal,
				"createApiKey",
				{ body, idempotencyKey },
				async () => {
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
				{ secret: true },
			);
		},

		getApiKey: async (principal, { params }) =>
			withMakerNamed(apiKeyView(await apiKeyFor(principal, params.apiKeyId, "account:read"))),

		rotateApiKey: async (principal, { params, idempotencyKey }) => {
			const key = await apiKeyFor(principal, params.apiKeyId, "account:admin");
			// Rotating answers the key's new secret, so it is as much as making the key: the caller must be able to grant
			// everything it holds. Checked before `once`, so a retry answered the first call's secret is held to it now too.
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
			// A key rotating itself can't sign in to a retry once it is done (its secret has changed), so its answer isn't
			// kept (`withhold`). Its key still holds the claim, so a retry while it works waits or is `conflict` rather than
			// rotating it again.
			const self = principal.kind === "key" && principal.keyId === key.id;
			// Each rotation ends the secret before: a retry with the key answers the first one's rather than ending it.
			return once(
				principal,
				"rotateApiKey",
				{ params, idempotencyKey },
				async () => {
					if (key.revokedAt !== undefined) throw new KantelError("conflict", "The key is revoked");
					const { secret, prefix, hash } = await newApiKeySecret();
					const rotated = await store.apiKeys.update(key.id, (current) =>
						current.revokedAt === undefined ? { ...current, prefix, secretHash: hash } : undefined,
					);
					if (rotated === undefined) throw new KantelError("conflict", "The key is revoked");
					return { key: apiKeyView(rotated), secret };
				},
				{ secret: true, ...(self ? { withhold: true as const } : {}) },
			);
		},

		revokeApiKey: async (principal, { params }) => {
			const key = await apiKeyFor(principal, params.apiKeyId, "account:admin");
			const revoked: StoredApiKey = key.revokedAt === undefined ? { ...key, revokedAt: now() } : key;
			await store.apiKeys.put(revoked);
			return apiKeyView(revoked);
		},

		// Personal access tokens: a person's own, whichever account they act in.

		listPersonalTokens: async (principal) => {
			const person = requirePerson(principal);
			return { items: newestFirst(await store.personalTokens.list({ userId: person.userId })).map(personalTokenView) };
		},

		createPersonalToken: async (principal, { body, idempotencyKey }) => {
			const person = requirePerson(principal);
			const scopes =
				body.scopes === undefined && body.preset === undefined
					? undefined
					: unique([
							...(body.scopes ?? []),
							...(body.preset === undefined
								? []
								: computeSchema.API_KEY_PRESETS[body.preset].filter((scope) => scope !== "hosts:admin")),
						]);
			// Checked before `once`, so a retry answered the first call's secret is held to what the caller may make now.
			await newPersonalToken(person, {
				name: body.name,
				...(scopes === undefined ? {} : { scopes }),
				...(body.accounts === undefined ? {} : { accounts: body.accounts }),
				...(body.expiresInDays === undefined ? {} : { expiresInDays: body.expiresInDays }),
			});
			return once(
				principal,
				"createPersonalToken",
				{ body, idempotencyKey },
				async () => {
					const { token, secret } = await newPersonalToken(person, {
						name: body.name,
						...(scopes === undefined ? {} : { scopes }),
						...(body.accounts === undefined ? {} : { accounts: body.accounts }),
						...(body.expiresInDays === undefined ? {} : { expiresInDays: body.expiresInDays }),
					});
					await store.personalTokens.put(token);
					return { token: personalTokenView(token), secret };
				},
				{ secret: true },
			);
		},

		revokePersonalToken: async (principal, { params }) => {
			const person = requirePerson(principal);
			const token = await store.personalTokens.get(params.tokenId);
			if (token === undefined || token.userId !== person.userId) throw notFound("personal access token");
			const revoked = await store.personalTokens.update(token.id, (current) =>
				current.revokedAt === undefined ? { ...current, revokedAt: now() } : undefined,
			);
			// Another revoke may have won: answer the token as it is stored now, revoked, not as it was read.
			return personalTokenView(revoked ?? (await store.personalTokens.get(token.id)) ?? token);
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

		createEnvironment: async (principal, { body, idempotencyKey }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			// Its name is the account's only once: a retry would be `conflict`, though the first call made it.
			return once(principal, "createEnvironment", { body, idempotencyKey }, async () => {
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
			});
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
			// Its sandboxes keep their env and files, but lose it from their environments: their placeholders for its
			// variables stop resolving at once, at a floor past any version it gave them, and its grants go. Deleted first,
			// then its sandboxes looked for: one attached meanwhile is either found here or sees it gone after its own write.
			await store.environments.delete(environment.id);
			const holding = await sandboxesWith(environment);
			const detached = await Promise.all(
				holding.map(async (sandbox) => {
					// Past the version its host was last given, from all its environments (this one included).
					const given = secretsVersionOf(await environmentsOf(sandbox), sandbox.secretsFloor) ?? 0;
					const floor = nextSecretsVersion(Math.max(given, environment.secretsVersion), now());
					return patchSandbox(sandbox.id, (current) => ({
						...current,
						...environmentFields(environmentIdsOf(current).filter((id) => id !== environment.id)),
						secretsFloor: Math.max(floor, current.secretsFloor ?? 0),
						...pendingWithout(current, environment.id),
						egressRevision: later(current.egressRevision),
					}));
				}),
			);
			const running = detached.filter((sandbox): sandbox is StoredSandbox => sandbox?.state === "running");
			const updateSecrets = backend.updateSecrets?.bind(backend);
			if (updateSecrets !== undefined) {
				for (const sandbox of running) {
					if (sandbox.secretsFloor !== undefined) keepGoing(updateSecrets(sandbox.id, sandbox.secretsFloor));
				}
			}
			pushEgress(running);
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
				await requireEnforcing(await liveFrom(environment));
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
			// A running sandbox with a placeholder of this name may take its protected value from another of its
			// environments, which this one, later, now shadows or no longer does: its host must fetch them again.
			const shadowing = await shadowsProtected(environment, name);
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
				touchesSecrets = wantProtected || existing?.protected === true || shadowing;
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
			if (touchesSecrets) await pushEnvironment(changed, changed.secretsVersion);
			return environmentView(changed);
		},

		deleteEnvironmentVariable: async (principal, { params }) => {
			const environment = await environmentFor(principal, params.environmentId, "account:admin");
			const existing = environment.variables.find((variable) => variable.name === params.name);
			if (existing === undefined) throw notFound("variable");
			const at = now();
			const touchesSecrets = existing.protected || (await shadowsProtected(environment, params.name));
			const changed = await changeEnvironment(environment.id, (current) => ({
				...current,
				variables: current.variables.filter((variable) => variable.name !== params.name),
				secretsVersion: touchesSecrets ? nextSecretsVersion(current.secretsVersion, at) : current.secretsVersion,
				updatedAt: at,
			}));
			if (touchesSecrets) await pushEnvironment(changed, changed.secretsVersion);
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
			if (grants.length > 0) await requireEnforcing(await liveFrom(environment));
			const expected = body.expected === undefined ? undefined : grantsKey(body.expected);
			const changed = await changeEnvironment(environment.id, (current) => {
				requireUnchanged(expected, grantsKey(current.grants), "The environment's grants");
				return { ...current, grants, updatedAt: later(current.updatedAt) };
			});
			await pushEnvironment(changed, undefined);
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

		listSandboxEnvironments: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:read");
			return sandboxEnvironmentsView(sandbox);
		},

		attachSandboxEnvironment: async (principal, { params, body }) => {
			// An environment's variables reach every command it runs, and its repositories are cloned with its env: as a
			// command it runs, so only for a caller that may run commands.
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const environment = await environmentIn(sandbox.accountId, body.environment);
			return changeSandboxEnvironments(
				sandbox,
				(ids) => {
					const others = ids.filter((id) => id !== environment.id);
					others.splice(Math.min(body.position ?? others.length, others.length), 0, environment.id);
					return others;
				},
				{ attached: environment },
			);
		},

		detachSandboxEnvironment: async (principal, { params }) => {
			const { sandbox, role } = await sandboxFor(principal, params.sandboxId, "exec");
			if (!environmentIdsOf(sandbox).includes(params.environmentId)) throw notFound("environment on the sandbox");
			// Its deny grants are egress rules only an admin may change (as its grants and the sandbox's own are): taking
			// them off the sandbox needs that too.
			const environment = await store.environments.get(params.environmentId);
			if (environment?.grants.some((grant) => grant.action === "deny")) requireScope(principal, "account:admin", role);
			return changeSandboxEnvironments(sandbox, (ids) => ids.filter((id) => id !== params.environmentId), {
				detached: params.environmentId,
			});
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

		watchEvents: async (principal, { query }, request) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:read", role);
			return watchResponse({
				feed: live,
				accountId: account.id,
				now,
				signal: request.signal,
				// Each change is checked as `listSandboxes` and `listEvents` check what they answer, against the caller as they
				// are now: one whose key or sign-in has ended, or who has left the account, watches no more.
				mayWatch: async (published): Promise<WatchVerdict> => {
					const current = await watcherNow(principal);
					if (current === undefined) return "end";
					const roleNow = await roleIn(store, current, account.id);
					if (roleNow === undefined) return "end";
					try {
						requireScope(current, "sandboxes:read", roleNow);
					} catch {
						return "end";
					}
					const sandbox = await published.sandbox();
					const limited = current.kind === "key" && current.limits.sandboxIds !== undefined;
					// One whose record is gone (a create that failed) stays with the account's admins and unlimited keys.
					if (sandbox === undefined) return !limited && (roleNow === "owner" || roleNow === "admin") ? "send" : "skip";
					return (await canSee(current, sandbox, roleNow)) ? "send" : "skip";
				},
			});
		},

		listWebhooks: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:admin", role);
			return { items: (await store.webhooks.list({ accountId: account.id })).map(webhookView) };
		},

		createWebhook: async (principal, { body, idempotencyKey }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			// Its signing secret is kept on the webhook as it is (deliveries are signed with it), so not sealed here either.
			return once(principal, "createWebhook", { body, idempotencyKey }, async () => {
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
			});
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

		// Sticky disks.

		listStickyDisks: async (principal, { query }) => {
			requireSticky();
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			const disks = (await store.stickyDisks.list({ accountId: account.id })).filter(
				(disk) => disk.deletedAt === undefined,
			);
			return { items: await Promise.all(disks.map((disk) => stickyDiskView(disk, false))) };
		},

		createStickyDisk: async (principal, { body, idempotencyKey }) => {
			requireSticky();
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			return once(principal, "createStickyDisk", { body, idempotencyKey }, async () => {
				// The pool it names, as a sandbox's create names one; naming none, the first sandbox's it is attached to.
				const pool =
					body.pool === undefined
						? undefined
						: await placementPool(account.id, body.pool, await ensureHosts(), await mayShare(principal));
				const t = now();
				const disk: StoredStickyDisk = {
					id: randomId("sdk"),
					accountId: account.id,
					name: body.name,
					...(body.description === undefined ? {} : { description: body.description }),
					sizeGb: body.sizeGb,
					...pooled(pool?.own ?? pool?.shared),
					createdAt: t,
					updatedAt: t,
				};
				// The disk with its name's claim, in one write: of two creates of one name only one lands, and an
				// interrupted create leaves neither.
				if (!(await store.stickyDiskWrites.create(disk))) {
					throw new KantelError("conflict", `The account has a sticky disk named ${body.name}`);
				}
				return stickyDiskView(disk, true);
			});
		},

		getStickyDisk: async (principal, { params }) => {
			requireSticky();
			const disk = await stickyDiskFor(principal, params.stickyDiskId, "account:read");
			return stickyDiskView(disk, true);
		},

		deleteStickyDisk: async (principal, { params }) => {
			requireSticky();
			const disk = await stickyDiskFor(principal, params.stickyDiskId, "account:admin");
			await deleteStickyDiskNow(disk.id);
			return undefined;
		},

		commitStickyDisk: async (principal, { params }) => {
			requireSticky();
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "snapshots:write");
			const attached = sandbox.stickyDisks?.find(
				(disk) => disk.diskId === params.stickyDiskId || disk.name === params.stickyDiskId,
			);
			if (attached === undefined) throw new KantelError("not_found", "The sandbox has no such sticky disk");
			if (attached.state !== "mounted") throw new KantelError("conflict", "Its sticky disk isn't mounted");
			const disk = await store.stickyDisks.get(attached.diskId);
			if (disk === undefined || disk.deletedAt !== undefined || disk.accountId !== sandbox.accountId) {
				throw new KantelError("not_found", "The sticky disk was deleted");
			}
			const running = await requireRunning(principal, sandbox.id);
			// Its versions are made in its pool only: one attached before disks had pools gets the sandbox's now (its host's,
			// for a sandbox from before pools), and one in another pool is refused.
			const inPool =
				running.poolId ?? (running.hostId === undefined ? undefined : (await store.hosts.get(running.hostId))?.poolId);
			if (inPool !== undefined) await bindStickyDisks([attached], inPool);
			const id = randomId("sdv");
			const committed = await backend.commitStickyDisk?.(sandbox.id, disk.id, id);
			if (committed === undefined) throw new KantelError("not_supported", STICKY_DISKS_OFF);
			const version: StoredStickyDiskVersion = {
				id,
				diskId: disk.id,
				accountId: disk.accountId,
				...(attached.version === undefined ? {} : { parent: attached.version }),
				hostId: committed.hostId,
				sandboxId: sandbox.id,
				sizeBytes: committed.sizeBytes,
				allocatedBytes: committed.allocatedBytes,
				...(committed.mapDigest === undefined ? {} : { mapDigest: committed.mapDigest }),
				seq: 0,
				createdAt: now(),
			};
			// The version and the disk's head, with the next place in its order, in one write that needs the disk live: two
			// commits from one version are both kept, and the later one wins. Deleted while it was made (an account's
			// teardown too): its version goes from its host again rather than outliving its disk, and the catalogue never
			// records it.
			const recorded = await store.stickyDiskWrites.commit(version, now());
			if (recorded === undefined) {
				await backend.deleteStickyDisk?.(disk.id).catch(() => undefined);
				throw new KantelError("not_found", "The sticky disk was deleted");
			}
			// Its host holds it from now; its reports keep that so (`recordHoldings`).
			await diskHolders.recordCommit("sticky", disk.id, recorded.id, recorded.hostId);
			// The hosts that use the disk fetch it now, not when their next sandbox asks.
			keepGoing(prefetchStickyHead(disk.id, recorded.id));
			return stickyVersionView(recorded);
		},

		// GitHub Actions runners.

		listGithubRunners: async (principal, { query }, request) => {
			requireGithubRunners();
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:admin", role);
			const records = (await store.githubRunners.list({ accountId: account.id })).filter(
				(record) => record.retiringAt === undefined,
			);
			return {
				items: await Promise.all(
					records.map(async (record) => githubRunners.view(record, await githubWebhookUrl(request, record.id), false)),
				),
			};
		},

		createGithubRunners: async (principal, { body, idempotencyKey }, request) => {
			requireGithubRunners();
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			const scope = body.scope ?? "organization";
			if (scope === "organization" && body.runnerGroupId === undefined) {
				throw new KantelError("invalid", "An organization's runners need runnerGroupId: the runner group they join");
			}
			await importAppKey(body.privateKey);
			// Its kinds, each in a pool: where its sticky disks are, else where its host labels select (`kindPool`).
			const kinds = await placedKinds(account.id, await mayShare(principal), unpooled(body.pools ?? []), [], body.name);
			await checkPools(account.id, kinds);
			// Its key acts for runners with what a create, a command and a delete need, and a commit where a pool commits,
			// and no more.
			const scopes = githubRunnerScopes(kinds);
			requireGrantable(principal, scopes);
			return once(
				principal,
				"createGithubRunners",
				{ body, idempotencyKey },
				async () => {
					const id = newGithubRunnersId();
					const sealed = await githubRunners.seal(id, body.privateKey);
					const { prefix, hash } = await newApiKeySecret();
					const t = now();
					const key: StoredApiKey = {
						id: randomId("key"),
						accountId: account.id,
						name: `GitHub runners: ${body.name}`.slice(0, 100),
						prefix,
						scopes,
						sandboxIds: undefined,
						createdBy: actorOf(principal),
						createdAt: t,
						expiresAt: undefined,
						// Its secret is never shown: only the broker acts as it, by its ID.
						secretHash: hash,
						ownerUserId: principal.userId,
					};
					await store.apiKeys.put(key);
					const record: StoredGithubRunners = {
						id,
						accountId: account.id,
						name: body.name,
						appId: body.appId,
						owner: body.owner,
						scope,
						...(body.runnerGroupId === undefined ? {} : { runnerGroupId: body.runnerGroupId }),
						...(body.repositories === undefined ? {} : { repositories: [...body.repositories] }),
						pools: kinds,
						enabled: true,
						keyId: key.id,
						privateKey: sealed.privateKey,
						webhookSecret: sealed.webhookSecret,
						createdAt: t,
						updatedAt: t,
					};
					await store.githubRunners.put(record);
					return {
						githubRunners: await githubRunners.view(record, await githubWebhookUrl(request, id), true),
						webhookSecret: sealed.secret,
					};
				},
				{ secret: true },
			);
		},

		getGithubRunners: async (principal, { params }, request) => {
			const record = await githubRunnersFor(principal, params.githubRunnersId);
			return githubRunners.view(record, await githubWebhookUrl(request, record.id), true);
		},

		updateGithubRunners: async (principal, { params, body }, request) => {
			const found = await githubRunnersFor(principal, params.githubRunnersId);
			if (body.privateKey !== undefined) await importAppKey(body.privateKey);
			// Its kinds as runner pools: each it has keeps its pool, and a new one goes where `kindPool` says.
			const record = body.pools === undefined ? found : await placeRunnerKinds(found);
			const key = body.pools === undefined ? undefined : await store.apiKeys.get(record.keyId);
			const kinds =
				body.pools === undefined
					? undefined
					: await placedKinds(
							record.accountId,
							key === undefined || (await mayShare(keyPrincipal(key))),
							unpooled(body.pools),
							record.pools,
							record.id,
						);
			if (kinds !== undefined) await checkPools(record.accountId, kinds);
			// Pools that commit need the key to commit: an integration made without that (or before it was granted) has its
			// key given it, by a caller who may grant it. Before the pools change, so no pool commits with a key that can't.
			if (kinds !== undefined && poolsCommit(kinds)) await grantRunnerCommits(principal, record.keyId);
			const resealed =
				body.privateKey === undefined
					? undefined
					: await requireSealer().seal(body.privateKey, sealedAt("githubRunners", record.id, "privateKey"));
			const updated = await store.githubRunners.update(record.id, (current) => {
				// Its kinds were placed and checked in the pools they were in then: a kind moved meanwhile (through a pool's
				// `runners`) isn't moved back, and the call is tried again from where it now is.
				const was = (pools: readonly RunnerPool[], label: string) => pools.find((kind) => kind.label === label)?.poolId;
				if (kinds?.some((kind) => was(current.pools, kind.label) !== was(record.pools, kind.label)) === true) {
					throw new KantelError("conflict", "The integration's runner kinds moved between pools meanwhile: try again");
				}
				const scope = body.scope ?? current.scope;
				const runnerGroupId = body.runnerGroupId === null ? undefined : (body.runnerGroupId ?? current.runnerGroupId);
				if (scope === "organization" && runnerGroupId === undefined) {
					throw new KantelError("invalid", "An organization's runners need runnerGroupId: the runner group they join");
				}
				const repositories = body.repositories === null ? undefined : (body.repositories ?? current.repositories);
				// Another owner or App: the installation is found again from that owner's next delivery.
				const moved =
					(body.owner !== undefined && body.owner.toLowerCase() !== current.owner.toLowerCase()) ||
					(body.appId !== undefined && body.appId !== current.appId);
				const { runnerGroupId: _group, repositories: _repositories, installationId, ...rest } = current;
				return {
					...rest,
					...(moved || installationId === undefined ? {} : { installationId }),
					...(body.name === undefined ? {} : { name: body.name }),
					...(body.appId === undefined ? {} : { appId: body.appId }),
					...(body.owner === undefined ? {} : { owner: body.owner }),
					...(kinds === undefined ? {} : { pools: kinds }),
					...(body.enabled === undefined ? {} : { enabled: body.enabled }),
					...(resealed === undefined ? {} : { privateKey: resealed }),
					scope,
					...(runnerGroupId === undefined ? {} : { runnerGroupId }),
					...(repositories === undefined ? {} : { repositories: [...repositories] }),
					updatedAt: now(),
				};
			});
			if (updated === undefined) throw new KantelError("not_found", "No such GitHub runner integration");
			return githubRunners.view(updated, await githubWebhookUrl(request, updated.id), true);
		},

		deleteGithubRunners: async (principal, { params }) => {
			const record = await githubRunnersFor(principal, params.githubRunnersId);
			// Its key first, so nothing makes another runner; the runners it made are still ended with it. The
			// integration is hidden from now, and kept until its runners have gone, which passes finish if this can't.
			const key = await store.apiKeys.get(record.keyId);
			if (key !== undefined && key.revokedAt === undefined) await store.apiKeys.put({ ...key, revokedAt: now() });
			await githubRunners.retire(record.id);
			return undefined;
		},

		listGithubRunnerJobs: async (principal, { params }) => {
			const record = await githubRunnersFor(principal, params.githubRunnersId);
			return { items: await githubRunners.jobs(record.id) };
		},

		rotateWebhookSecret: async (principal, { params, idempotencyKey }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			return once(principal, "rotateWebhookSecret", { params, idempotencyKey }, async () => {
				const rotated: StoredWebhook = { ...webhook, secret: newWebhookSecret() };
				await store.webhooks.put(rotated);
				return { webhook: webhookView(rotated), secret: rotated.secret };
			});
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

		createHostJoinToken: async (principal, { body, idempotencyKey }, request) => {
			requireScope(principal, "hosts:admin");
			return once(principal, "createHostJoinToken", { body, idempotencyKey }, () => mintJoinToken(body, request), {
				secret: true,
			});
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

		getGrantKeys: async (principal) => {
			requireScope(principal, "hosts:admin");
			const keys = await diskHolders.keys();
			if (keys === undefined) {
				throw new KantelError(
					"not_supported",
					options.stickyDisks === true ? GRANT_KEY_UNAVAILABLE : "Sticky disks are off here",
				);
			}
			return grantKeysView(keys);
		},

		rotateGrantKey: async (principal) => {
			requireScope(principal, "hosts:admin");
			return grantKeysView(await diskHolders.rotate(principal.userId));
		},

		getHost: async (principal, { params }) => hostView(await hostFor(principal, params.hostId)),

		getHostUsage: async (principal, { params, query }) =>
			hostUsage((await hostFor(principal, params.hostId)).id, query.since),

		updateHost: async (principal, { params, body }) => changeHost(await hostFor(principal, params.hostId), body),

		updateHostAgent: async (principal, { params }) => updateHostAgentOf(await hostFor(principal, params.hostId)),

		fetchHostStickyDisk: async (principal, { params, body }) => {
			const host = await hostFor(principal, params.hostId);
			if (host.state === "revoked") throw new KantelError("conflict", "The host is revoked");
			if (backend.fetchDisk === undefined) {
				throw new KantelError("not_supported", "This deployment's hosts don't fetch disks from each other");
			}
			const disk = await store.stickyDisks.get(body.stickyDiskId);
			if (disk === undefined || disk.deletedAt !== undefined) throw notFound("sticky disk");
			// Where it is, for this host: its pool's holders and a grant naming it, as its own disk.locate would get.
			const request = { kind: "sticky", objectId: disk.id, version: body.version };
			const location = await diskHolders.locate(host.id, request);
			if (location.holders.length === 0) {
				throw new KantelError("conflict", "No other host in the host's pool holds that version where it can fetch it");
			}
			await backend.fetchDisk(host.id, { ...request, ...location });
			return undefined;
		},

		fetchHostSnapshot: async (principal, { params, body }) => {
			const host = await hostFor(principal, params.hostId);
			if (host.state === "revoked") throw new KantelError("conflict", "The host is revoked");
			if (backend.fetchDisk === undefined) {
				throw new KantelError("not_supported", "This deployment's hosts don't fetch disks from each other");
			}
			const snapshot = await store.snapshots.get(body.snapshotId);
			const ref = snapshot?.ref;
			const objectId = ref === undefined ? undefined : refId(ref);
			if (
				snapshot === undefined ||
				snapshot.kind !== "saved" ||
				snapshot.state !== "ready" ||
				ref === undefined ||
				objectId === undefined
			) {
				throw notFound("saved snapshot");
			}
			// Not before its host has reported it: there is nowhere to fetch it from.
			const held = (await diskHolders.holdersOf("snapshot", objectId)).get("disk") ?? [];
			if (!held.some((holder) => holder.ref === ref && holder.state === "held" && holder.hostId !== host.id)) {
				throw new KantelError("conflict", "No other host in the host's pool holds that snapshot where it can fetch it");
			}
			await sendSnapshotFetch(host.id, ref);
			return undefined;
		},

		checkHostUpdates: async (principal) => {
			requireScope(principal, "hosts:admin");
			if (backend.checkHostUpdates === undefined) {
				throw new KantelError("not_supported", "This deployment doesn't read Kantel's latest kantel-host release");
			}
			const found = await backend.checkHostUpdates();
			return {
				checked: found.checked,
				...(found.latestVersion === undefined ? {} : { latestVersion: found.latestVersion }),
			};
		},

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

		// Templates (experimental): `templates.ts`.

		...templates.handlers,

		// An account's own hosts.

		createAccountJoinToken: async (principal, { body, idempotencyKey }, request) => {
			requireAccountHosts();
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			return once(
				principal,
				"createAccountJoinToken",
				{ body, idempotencyKey },
				async () => {
					const made = await mintJoinToken(body, request, { accountId: account.id, createdBy: principal.userId });
					return { ...made, accountId: account.id };
				},
				{ secret: true },
			);
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

		getAccountHostUsage: async (principal, { params, query }) =>
			hostUsage((await accountHostFor(principal, params.hostId, "account:read")).host.id, query.since),

		updateAccountHost: async (principal, { params, body }) =>
			changeHost((await accountHostFor(principal, params.hostId, "account:admin")).host, body),

		updateAccountHostAgent: async (principal, { params }) =>
			updateHostAgentOf((await accountHostFor(principal, params.hostId, "account:admin")).host),

		removeAccountHost: async (principal, { params }) =>
			revokeStoredHost((await accountHostFor(principal, params.hostId, "account:admin")).host),

		// Pools: `pools.ts`.

		...pools.handlers,

		...(mounts?.handlers ?? MOUNTS_OFF_HANDLERS),
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
		return user === undefined
			? undefined
			: { id: user.id, name: personName({ userId: user.id, name: user.name, email: user.email }), email: user.email };
	}

	/**
	 * Runs a command once in a running sandbox (`runCommand`): recorded, run by its backend, and answered once it ends
	 * (detached: at once, its end recorded later). `rerunOf`: it is a command run again in the microVM its isolate was
	 * just upgraded to (`autoUpgrade`). `beforeEnd`: what is done once its result is in and before it is recorded as
	 * ended, so a follower never sees it end without it (an upgrade and its run again), and what to add to its record.
	 */
	async function runCommandOnce(
		principal: Principal,
		sandboxId: string,
		body: computeSchema.RunCommandBody,
		how: {
			readonly rerunOf?: string;
			/** Its ID, given beforehand (a run again's, `rerunStarting`). */
			readonly id?: string;
			/** Run as root (`ExecRequest.asRoot`): Kantel's own commands only, never a caller's. */
			readonly asRoot?: boolean;
			readonly beforeEnd?: (
				command: StoredCommand,
				result: ExecResult,
			) => Promise<{ readonly rerunAs?: string; readonly note?: string } | undefined>;
		} = {},
	): Promise<StoredCommand> {
		const { rerunOf } = how;
		const current = await requireRunning(principal, sandboxId);
		if (!current.capabilities.exec) throw new KantelError("not_supported", "This sandbox runs no commands");
		const detached = body.detached === true;
		const command: StoredCommand = {
			id: how.id ?? randomId("cmd"),
			sandboxId: current.id,
			accountId: current.accountId,
			command: body.command,
			...(rerunOf === undefined ? {} : { rerunOf }),
			...(current.type === "isolate" && current.autoUpgrade === true ? { autoUpgrade: true } : {}),
			cwd: resolvePath(body.cwd ?? homeFor(current.type), homeFor(current.type)),
			state: "running",
			stdout: "",
			stderr: "",
			truncated: false,
			startedAt: now(),
			...(detached ? { detached: true } : {}),
		};
		await store.commands.put(command);
		// Checked once stored, as a create is: a command landing as its sandbox's account is deleted (its sandbox gone
		// or the account closed) is forgotten and never run.
		if ((await store.sandboxes.get(current.id)) === undefined || !(await accountOpen(current.accountId))) {
			await store.commands.delete(command.id);
			throw accountClosed();
		}
		const controller = new AbortController();
		runningCommands.set(command.id, controller);
		// A run again starts only while the command it runs again still runs: one killed meanwhile (the kill found no run
		// again recorded to reach, `reachRerun`) has it killed before it starts, as one killed since is.
		if (rerunOf !== undefined) {
			const original = await store.commands.get(rerunOf);
			if (original?.state !== "running") {
				runningCommands.delete(command.id);
				const at = now();
				const unrun = await settleCommand(command.id, (latest) => ({
					...latest,
					state: "killed",
					exitCode: 137,
					stderr: "kantel: not run again: the command it runs again was killed while its sandbox upgraded\n",
					endedAt: at,
					durationMs: at - latest.startedAt,
				}));
				// The kill found no run again to link (it wasn't recorded yet): link it now, leaving the original as it ended,
				// so the killed command still says which run again it had.
				if (original !== undefined) {
					await store.commands.update(original.id, (latest) =>
						latest.rerunAs === undefined && latest.sandboxId === command.sandboxId
							? { ...latest, rerunAs: command.id }
							: undefined,
					);
				}
				return unrun ?? (await store.commands.get(command.id)) ?? command;
			}
		}
		// Someone waits on an attached command for as long as it runs: it is a use of the sandbox throughout, so a
		// long build isn't stopped under them. A detached one counts only while it is followed (`getCommand`).
		const using: ReturnType<typeof setInterval> | undefined = detached
			? undefined
			: setInterval(() => noteActivity(current.id), ACTIVITY_WRITE_MS);
		(using as { unref?: () => void } | undefined)?.unref?.();
		const stopUsing = (): void => {
			if (using !== undefined) clearInterval(using);
		};
		const finish = async (result: ExecResult): Promise<StoredCommand> => {
			stopUsing();
			const more = await how.beforeEnd?.(command, result).catch(() => undefined);
			runningCommands.delete(command.id);
			const said = more?.note === undefined ? result : { ...result, stderr: `${result.stderr}${more.note}` };
			return (await endCommand(command.id, said, more?.rerunAs, true)) ?? command;
		};
		const failed = async (error: unknown): Promise<StoredCommand> => {
			// Only the wait ended (this gateway closing), and the backend can still be asked for the command's end:
			// it runs on, and getCommand fetches its end. A foreground one too, on a backend that keeps it past its call.
			// This gateway's wait is over either way, so its use ends; following the command counts on its own.
			if (isDetachedWaitEnded(error)) {
				stopUsing();
				runningCommands.delete(command.id);
				return (await store.commands.get(command.id)) ?? command;
			}
			return finish({ exitCode: 1, stdout: "", stderr: `${messageOf(error)}\n`, timedOut: false });
		};
		const run = backend.exec(current.id, {
			command: body.command,
			cwd: command.cwd,
			env: { ...current.env, ...body.env },
			stdin: body.stdin,
			// A detached command has no limit unless the caller gave one.
			timeoutMs: detached ? body.timeoutMs : (body.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			signal: controller.signal,
			commandId: command.id,
			...(detached ? { detached: true } : {}),
			...(how.asRoot === true ? { asRoot: true } : {}),
		});
		if (detached) {
			keepGoing(run.then(finish, failed));
			return command;
		}
		return run.then(finish, failed);
	}

	/**
	 * `POST /sandboxes/{id}/upgrade`: an isolate made a microVM with the same ID, its files, settings and history.
	 *
	 * The record goes `starting` with its upgrade (`upgrading`: an operation ID its backend does at most once, and what
	 * the record was), so its commands and file calls wait for it as they wait for a start (`requireRunning`), every
	 * other lifecycle call queues behind it (`track`), and a gateway that dies meanwhile leaves it for the sweep to settle
	 * (`settleStuckUpgrade`). Its isolate time ends there: every run it had is priced as an isolate's
	 * (`RunPeriod.ratePerHour`). Its backend's microVM is published as a boot's is (`commitUpgrade`, through `boot`), its
	 * egress reconciled first, so a grant revoked meanwhile is enforced before it runs. A failure the backend is sure of
	 * puts the record back exactly as it was (its state, runs and stop times): the isolate is untouched. An outcome the
	 * backend can't tell (`isUpgradeOutcomeUnknown`) is settled with it at once where it can say, else left `starting`
	 * for the sweep, never guessed. A microVM is answered as it is. Answers the record once the upgrade ends, or with
	 * `wait: false` as soon as it is `starting`.
	 */
	async function upgradeIsolate(
		principal: Principal,
		role: MemberRole,
		sandboxId: string,
		body: computeSchema.UpgradeSandboxBody,
	): Promise<StoredSandbox> {
		const current = await settledFor(principal, sandboxId);
		if (current.type === "microvm") return current;
		if (current.state !== "running" && current.state !== "stopped") {
			throw new KantelError(
				"conflict",
				`The sandbox is ${current.state}: an isolate is upgraded while it is running or stopped`,
			);
		}
		const upgrade = backend.upgrade;
		if (upgrade === undefined) throw new KantelError("not_supported", UPGRADE_UNSUPPORTED);
		// A microVM's snapshot to start from, as a create from it takes one.
		const from = body.from === undefined ? undefined : await snapshotFrom(principal, current.accountId, body.from);
		if (from !== undefined) requireMicrovmSnapshot(from);
		if (
			body.size !== undefined &&
			body.resources !== undefined &&
			(body.resources.vcpus !== undefined || body.resources.memoryMb !== undefined)
		) {
			throw new KantelError("invalid", "Give resources or a size, not both");
		}
		if (from !== undefined && body.resources?.diskGb !== undefined) {
			throw new KantelError("invalid", "A sandbox made from a snapshot keeps the snapshot's disk; leave out diskGb");
		}
		const read = backend.capabilities();
		const known = ensureHosts(read);
		known.catch(() => undefined);
		const capabilities = await read;
		if (!capabilities.types.includes("microvm")) {
			throw placementError("unavailable", "no_host_for_type", "No host runs microvm sandboxes");
		}
		// A snapshot's own size is its machine, whatever the hosts name now, as for a create from it.
		if (
			body.size !== undefined &&
			body.size !== from?.size &&
			!capabilities.sizes.some((size) => size.name === body.size)
		) {
			throw placementError(
				"not_supported",
				"no_host_offers_size",
				`This deployment doesn't offer the size ${body.size}`,
			);
		}
		// The hosts its microVM may go on, as a create of one would choose: its labels, pin and pool kept. From a snapshot,
		// as a create from it: its host draining too, where only that host holds it.
		const pool = await poolOfSandbox(current);
		const hosts = requireHosts(
			await known,
			current.accountId,
			"microvm",
			{ ...current.hostLabels },
			from !== undefined,
			await mayShare(principal),
			current.hostPin,
			pool,
		);
		// From a snapshot, in the pool the sandbox is kept to, as a create naming that pool takes one (`poolOfSnapshot`).
		if (from !== undefined) await poolOfSnapshot(from, await known, keptPool(pool, UPGRADE_IN_POOL));
		// From a snapshot, the microVM goes only on the host that holds it: refused now, the isolate untouched, when that
		// host isn't one the sandbox may use.
		const into = from === undefined ? undefined : hostRef(from);
		const holder = into === undefined ? undefined : refHost(into);
		if (holder !== undefined && !hosts.includes(holder)) {
			const named = (await known).find((host) => host.id === holder);
			throw placementError(
				"unavailable",
				"host_unavailable",
				`The snapshot is on a host this sandbox can't use now (${named !== undefined && mayKnowHost(principal, named, current.accountId) ? named.name : "not one you can name"}): it is offline, or outside the sandbox's host labels or pin`,
			);
		}
		const eligible = capabilities.hosts.filter((host) => hosts.includes(host.id));
		const diskAlone =
			body.resources !== undefined && body.resources.vcpus === undefined && body.resources.memoryMb === undefined
				? checkDisk("microvm", body.resources.diskGb)
				: undefined;
		const shape = shapeFor(
			"microvm",
			diskAlone === undefined ? body.resources : undefined,
			eligible,
			capabilities.sizes,
			from === undefined,
		);
		const presets = eligible.flatMap((host) => host.sizes ?? capabilities.sizes);
		const wanted: AskedMachine = {
			...(body.size === undefined ? {} : { size: body.size }),
			...(shape === undefined ? {} : { shape }),
			...(diskAlone === undefined ? {} : { diskGb: diskAlone }),
		};
		// Its machine as a create from the snapshot decides it: one that holds memory restores it, so it is that machine.
		const fromOn =
			from === undefined
				? undefined
				: copiedOn(
						capabilities.hosts.find((host) => host.id === holder),
						capabilities.sizes,
					);
		const machine = sandboxMachine(
			from === undefined ? undefined : { copies: from, on: fromOn },
			from === undefined ? wanted : restoreAsked({ ...from, memory: await holdsMemory(from) }, wanted),
			presets,
		);
		if (machine === undefined) {
			throw placementError(
				"not_supported",
				"no_host_offers_size",
				`No host this sandbox may use offers the size ${body.size ?? "default"}`,
			);
		}
		if (from !== undefined) requireMinMemory(from, memoryOf(machine, fromOn?.presets ?? presets, from));
		if (diskAlone !== undefined && machine.shape !== undefined)
			requireMaker(eligible, capabilities.sizes, machine.shape);
		// A stopped one comes back running, as a microVM: it counts against the account's sandboxes as a start does.
		if (current.state === "stopped") await requireCapacity(current.accountId, 1);
		// A stopped isolate's files, for a backend that keeps them in its stop's snapshot (the stub); a host keeps them.
		const fromSnapshot = current.state === "stopped" ? await latestRef(current) : undefined;
		const image = body.image ?? capabilities.defaultImage;
		const operationId = randomId("upg");
		const began = await transition(
			current.id,
			current.state,
			(latest) => {
				const at = now();
				const isolateRate = rateOf(latest);
				const egressRevision = later(latest.egressRevision);
				return {
					...latest,
					state: "starting",
					lifecycle: (latest.lifecycle ?? 0) + 1,
					// Its egress is read afresh for the microVM: an update read before it is older, and loses.
					egressRevision,
					// Its time as an isolate ends now, and every run it had is priced as an isolate's, so none is billed at the
					// microVM's rate once it is one.
					runs: latest.runs.map((run) => ({ ...run, to: run.to ?? at, ratePerHour: run.ratePerHour ?? isolateRate })),
					upgrading: {
						operationId,
						at,
						heartbeatAt: at,
						from: latest.state === "stopped" ? "stopped" : "running",
						before: {
							runs: latest.runs,
							...(latest.stopsAt === undefined ? {} : { stopsAt: latest.stopsAt }),
							...(latest.startedAt === undefined ? {} : { startedAt: latest.startedAt }),
							...(latest.stoppedAt === undefined ? {} : { stoppedAt: latest.stoppedAt }),
							...(latest.lastActiveAt === undefined ? {} : { lastActiveAt: latest.lastActiveAt }),
							// Whether the isolate's host had its egress as it was (an update not yet delivered, it hadn't).
							egressInSync:
								latest.egressRevision === undefined ||
								(latest.egressApplied ?? Number.NEGATIVE_INFINITY) >= latest.egressRevision,
						},
						...(machine.size === undefined ? {} : { size: machine.size }),
						...(machine.shape === undefined ? {} : { shape: machine.shape }),
						...(image === undefined ? {} : { image }),
						...(from === undefined ? {} : { snapshotId: from.id }),
						egressRevision,
					},
				};
			},
			(latest) => latest.type === "isolate" && latest.lifecycle === current.lifecycle,
		);
		if (!("moved" in began)) {
			if (began.lost.type === "microvm") return began.lost;
			throw new KantelError("conflict", `The sandbox is ${began.lost.state}; try the upgrade again`);
		}
		// Depending on its snapshot from the record on (`dependents`), as a create does (`adopt`): one deleted or expired
		// meanwhile puts the isolate back, nothing sent.
		if (
			from !== undefined &&
			!(await adopt(
				from.id,
				async () => undefined,
				() => restoreUpgrade(sandboxId, operationId),
			))
		) {
			throw deletedMeanwhile();
		}
		const starting = began.moved;
		const work = track([current.id], async (): Promise<StoredSandbox> => {
			// Said every so often while this gateway is at it: a record gone quiet is a gateway gone, settled by the sweep.
			const heartbeat = setInterval(() => {
				patchSandbox(sandboxId, (latest) =>
					latest.upgrading?.operationId === operationId
						? { ...latest, upgrading: { ...latest.upgrading, heartbeatAt: now() } }
						: undefined,
				).catch(() => undefined);
			}, UPGRADE_HEARTBEAT_MS);
			(heartbeat as { unref?: () => void }).unref?.();
			try {
				let egress: Awaited<ReturnType<typeof egressFor>>;
				try {
					egress = await egressFor(starting.accountId, starting);
				} catch (error) {
					await restoreUpgrade(sandboxId, operationId);
					throw error;
				}
				let placement: UpgradedPlacement;
				try {
					placement = await upgrade(
						current.id,
						{
							sandboxId: current.id,
							accountId: current.accountId,
							type: "microvm",
							subdomain: current.subdomain,
							...(machine.size === undefined ? {} : { size: machine.size }),
							...(machine.shape === undefined ? {} : { shape: machine.shape }),
							image,
							env: starting.env,
							eligibleHosts: hosts,
							// Its microVM in its pool: kept to it as its host admits it.
							...pooled(current.poolId),
							...(fromSnapshot === undefined ? {} : { fromSnapshot }),
							...(into === undefined ? {} : { intoSnapshot: into }),
							...egress,
						},
						operationId,
					);
				} catch (error) {
					if (!isUpgradeOutcomeUnknown(error)) {
						await restoreUpgrade(sandboxId, operationId);
						throw error;
					}
					// Sent, and not answered: asked what became of it, never guessed. One that can't be told yet stays
					// `starting`, for the sweep to settle once its host answers.
					let outcome: UpgradeOutcome | undefined;
					try {
						outcome = await backend.settleUpgrade?.(sandboxId, operationId);
					} catch {
						throw new KantelError("unavailable", UPGRADE_OUTCOME_UNKNOWN);
					}
					if (outcome?.state !== "done") {
						await restoreUpgrade(sandboxId, operationId);
						throw new KantelError("unavailable", `The upgrade didn't happen: ${outcome?.reason ?? messageOf(error)}`);
					}
					placement = outcome.placement;
				}
				return (
					(await commitUpgrade(sandboxId, operationId, placement, { principal, role })) ??
					(await mustGetSandbox(sandboxId))
				);
			} finally {
				clearInterval(heartbeat);
			}
		});
		if (body.wait === false) {
			keepGoing(work);
			return starting;
		}
		return work;
	}

	/**
	 * Puts an upgrading record back as it was before upgrade `operationId` (its state, runs and stop times), once its
	 * backend has said it didn't happen. Nothing happens to one no longer upgrading by that operation.
	 *
	 * A running isolate runs again only with its egress as it is now. A change made while it upgraded (a grant revoked, a
	 * protected variable unbound) skipped it, as one skips any starting sandbox, so it is sent to the isolate while the
	 * record is still `starting`, and again for each change made while that was sent, as a boot does (`boot`). Where its
	 * host refuses it, or it can't be got there in `BOOT_RECONCILE_ROUNDS`, the isolate is stopped instead (`enforceStop`),
	 * never run with what it had. Nothing changed meanwhile (its revision the one the upgrade read), it runs again at
	 * once. A stopped one is put back stopped: its next start sends its egress.
	 */
	async function restoreUpgrade(sandboxId: string, operationId: string): Promise<void> {
		const ours = (latest: StoredSandbox) => latest.upgrading?.operationId === operationId;
		/** What it was before the upgrade, but its state. */
		const before = (latest: StoredSandbox): Partial<StoredSandbox> => {
			const upgrading = latest.upgrading;
			if (upgrading === undefined) return {};
			const { before } = upgrading;
			return {
				runs: before.runs,
				stopsAt: before.stopsAt,
				startedAt: before.startedAt,
				stoppedAt: before.stoppedAt,
				lastActiveAt: before.lastActiveAt,
				upgrading: undefined,
			};
		};
		try {
			const read = await store.sandboxes.get(sandboxId);
			const upgrading = read?.upgrading;
			if (read === undefined || upgrading === undefined || !ours(read)) return;
			const reconciles = upgrading.from === "running" && backend.updateEgress !== undefined;
			// What the isolate's host has: the egress the upgrade read (the same as the isolate's before it), where its host
			// had taken that; else none it can be said to have, so it is sent whatever changed.
			let applied = upgrading.before.egressInSync === false ? undefined : upgrading.egressRevision;
			let sent = false;
			const restored = (latest: StoredSandbox): StoredSandbox => ({
				...latest,
				...before(latest),
				state: latest.upgrading?.from ?? latest.state,
				lifecycle: (latest.lifecycle ?? 0) + 1,
				...(sent && applied !== undefined && (latest.egressApplied ?? Number.NEGATIVE_INFINITY) < applied
					? { egressApplied: applied }
					: {}),
			});
			const ready = (latest: StoredSandbox) =>
				ours(latest) && (!reconciles || (applied !== undefined && latest.egressRevision === applied));
			let result = await transition(sandboxId, "starting", restored, ready);
			for (let round = 0; "lost" in result && result.lost.state === "starting" && ours(result.lost); round++) {
				const lost = result.lost;
				// Stopped, its isolate's time ending now, never running again with the egress it had.
				const stop = (reason: string) =>
					enforceStop(sandboxId, reason, false, lost, undefined, (latest) => {
						const at = now();
						const was = before(latest);
						return {
							...was,
							runs: (was.runs ?? latest.runs).map((run) => (run.to === undefined ? { ...run, to: at } : run)),
						};
					});
				if (round >= BOOT_RECONCILE_ROUNDS) {
					if (await stop("Its egress couldn't be applied to it as its upgrade was undone")) return;
				} else {
					try {
						await deliverEgress(lost);
						applied = lost.egressRevision ?? applied;
						sent = true;
					} catch (error) {
						// Refused for the egress it has still: stopped. One changed since is sent next round.
						if (unenforceable(error) && (await stop(UNENFORCED))) return;
						if (!unenforceable(error)) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** round));
					}
				}
				result = await transition(sandboxId, "starting", restored, ready);
			}
		} catch {
			// Deleted meanwhile, or its store away: an upgrade still on the record is the sweep's to settle.
		}
	}

	/**
	 * Publishes upgrade `operationId`'s microVM as a boot publishes one (`boot`): its egress reconciled before it runs, a
	 * delete meanwhile destroying it, then the record a microVM with its run begun; then `sandbox.upgraded`, its ports
	 * exposed again (for a caller who may open them) and its environments set up where a microVM keeps them. `by` is who
	 * asked; absent (the sweep), no ports, and only set-up that clones nothing.
	 */
	async function commitUpgrade(
		sandboxId: string,
		operationId: string,
		placement: UpgradedPlacement,
		by?: { readonly principal: Principal; readonly role: MemberRole },
	): Promise<StoredSandbox | undefined> {
		const latest = await store.sandboxes.get(sandboxId);
		const upgrading = latest?.upgrading;
		if (latest === undefined || upgrading?.operationId !== operationId) return latest;
		const environments = await environmentsOf(latest);
		const work = environments.flatMap(workFor);
		const becomes = () => ({
			type: "microvm" as const,
			size: upgrading.size,
			shape: upgrading.shape,
			image: upgrading.image,
			upgradedFrom: {
				type: "isolate" as const,
				at: upgrading.at,
				...(upgrading.snapshotId === undefined ? {} : { snapshotId: upgrading.snapshotId }),
			},
			upgrading: undefined,
			// The isolate's snapshots stay theirs, an isolate's: the microVM's own come with its first stop.
			latestSnapshotId: undefined,
			latestSnapshotAt: undefined,
			ports: [],
			// Its environments' files and repositories, where a microVM keeps them, once it runs.
			...(work.length > 0 ? { pendingProvision: work } : {}),
		});
		const committed = await boot(
			sandboxId,
			async () => placement,
			undefined,
			{ egressRevision: upgrading.egressRevision },
			becomes,
		);
		// Its host revoked after it replaced the isolate but before the microVM was published: the revocation put the record
		// in error (strandOn) while it still said isolate, and boot found it no longer starting. The isolate is gone all the
		// same, so the record says what replaced it, still in error (and not published: no ports, no set-up below).
		if (committed === undefined) {
			await store.sandboxes.update(sandboxId, (current) =>
				current.state === "error" && current.upgrading?.operationId === operationId
					? { ...current, ...becomes(), pendingProvision: undefined }
					: undefined,
			);
		}
		const upgraded = (sandbox: StoredSandbox) =>
			emit("sandbox.upgraded", sandbox.accountId, {
				sandbox,
				data: {
					...(by === undefined ? {} : { actor: actorOf(by.principal) }),
					from: "isolate",
					to: "microvm",
					previousState: upgrading.from,
					path: placement.path,
					files: placement.files,
					bytes: placement.bytes,
					durationMs: Math.max(0, now() - upgrading.at),
				},
			});
		if (committed === undefined) {
			// Not published running (stopped because its egress couldn't be got there, or its host revoked): the microVM
			// it became all the same, which its event says.
			const ended = await store.sandboxes.get(sandboxId);
			if (ended?.type === "microvm" && ended.upgradedFrom?.at === upgrading.at) await upgraded(ended);
			return ended;
		}
		await upgraded(committed);
		// Its isolate's exposed ports, on the microVM, where a caller who may open them asked.
		if (by !== undefined && latest.ports.length > 0 && mayUse(by.principal, "access", by.role)) {
			await copyPorts(committed, latest.ports, encodeGrantee(by.principal)).catch(() => undefined);
		}
		if (committed.pendingProvision !== undefined) {
			const authorised = environments.filter(
				(environment) => environment.repos.length === 0 || (by !== undefined && mayUse(by.principal, "exec", by.role)),
			);
			await provision(committed.id, authorised).catch(() => undefined);
		}
		return (await store.sandboxes.get(sandboxId)) ?? committed;
	}

	/**
	 * The sweep's settling of an upgrade whose gateway has gone quiet (`upgrading.heartbeatAt`), or whose outcome its
	 * backend couldn't tell: done, published; failed, put back. One its backend still can't tell is left for next time.
	 *
	 * Taken on in the store every gateway shares first: its heartbeat moved on from the quiet one this sweep read, as
	 * its upgrading gateway's would be, and kept moving while this gateway settles it. So another gateway's sweep finds
	 * it under way and leaves it, and only one settles it at a time; one already taken on, or settled, is left.
	 */
	async function settleStuckUpgrade(sandbox: StoredSandbox): Promise<void> {
		const upgrading = sandbox.upgrading;
		if (upgrading === undefined) return;
		const { operationId } = upgrading;
		// The heartbeat this gateway last wrote: moved on only from it, so a write by anyone else ends this one's hold.
		let mine = upgrading.heartbeatAt;
		const beat = async (to: number) => {
			const from = mine;
			const written = await patchSandbox(sandbox.id, (latest) =>
				latest.upgrading?.operationId === operationId && latest.upgrading.heartbeatAt === from
					? { ...latest, upgrading: { ...latest.upgrading, heartbeatAt: to } }
					: undefined,
			);
			if (written !== undefined) mine = to;
			return written !== undefined;
		};
		if (!(await beat(now()))) return;
		const heartbeat = setInterval(() => beat(now()).catch(() => undefined), UPGRADE_HEARTBEAT_MS);
		(heartbeat as { unref?: () => void }).unref?.();
		try {
			await track([sandbox.id], async () => {
				const outcome: UpgradeOutcome =
					backend.settleUpgrade === undefined
						? { state: "failed" }
						: await backend.settleUpgrade(sandbox.id, operationId);
				if (outcome.state === "done") await commitUpgrade(sandbox.id, operationId, outcome.placement);
				else await restoreUpgrade(sandbox.id, operationId);
			});
		} catch (error) {
			// Not settled (its backend can't tell yet): let go, quiet as it was, for the next sweep on any gateway.
			clearInterval(heartbeat);
			await beat(upgrading.heartbeatAt).catch(() => undefined);
			throw error;
		} finally {
			clearInterval(heartbeat);
		}
	}

	/** Starts (fresh from the newest snapshot) or resumes (from memory when paused) a sandbox. */
	async function restart(
		principal: Principal,
		sandboxId: string,
		body: { readonly size?: computeSchema.SandboxSizeName; readonly wait?: boolean },
		how: "start" | "resume",
	): Promise<Sandbox> {
		const { sandbox, role } = await sandboxFor(principal, sandboxId, "sandboxes:write");
		const current = await settledFor(principal, sandbox.id);
		if (current.state === "running") return sandboxView(current, principal);
		if (current.state !== "stopped" && current.state !== "paused" && current.state !== "error") {
			throw new KantelError("conflict", `The sandbox is ${current.state}`);
		}
		if (current.type === "isolate" && body.size !== undefined)
			throw new KantelError("invalid", "Isolates have no size");
		await requireCapacity(current.accountId, 1);
		const hosts = await hostsToBoot(principal, current);
		const fromSnapshot = await latestRef(current);
		requireSetupScope(principal, role, current);
		// Refused now, as its create would be; read again once it is starting, for an attach meanwhile.
		await provisionedAgain(principal, role, current);
		const began = await transition(current.id, current.state, (latest) =>
			withState(latest, "starting", {
				size: body.size ?? latest.size,
				// A size it names replaces the shape it had; without one it keeps its shape.
				shape: body.size === undefined ? latest.shape : undefined,
				pausedSnapshotId: how === "resume" ? latest.pausedSnapshotId : undefined,
				...(latest.mounts === undefined ? {} : { mounts: pendingMounts(latest.mounts), mountsAt: undefined }),
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
		const provisioning = await provisionedAgain(principal, role, starting, true);
		const bootOptions = {
			fromSnapshot,
			...sizingOf(starting),
			env: starting.env,
			eligibleHosts: hosts,
			// As written now it is starting: a change from here on moves its revision on, and its boot reconciles.
			...(await egressFor(starting.accountId, starting)),
			...(starting.mounts === undefined ? {} : { mounts: backendMounts(starting.mounts) }),
		};
		const work = track([current.id], () =>
			bootProvisioned(
				current.id,
				() =>
					bootAgain(starting, bootOptions, (options) =>
						how === "start" ? backend.start(current.id, options) : backend.resume(current.id, options),
					),
				provisioning,
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
			const principal = await granteePrincipal(text);
			if (principal === undefined) return false;
			try {
				await sandboxFor(principal, sandboxId, "access");
				return true;
			} catch (error) {
				if (error instanceof KantelError) return false;
				throw error;
			}
		},

		noteActivity,

		async portNotRunning(sandboxId) {
			const sandbox = await store.sandboxes.get(sandboxId);
			if (sandbox === undefined || sandbox.state === "running" || sandbox.state === "deleted") return undefined;
			return portNotRunningText(sandbox, apiBasePath);
		},

		async carryOnDeletions() {
			for (const deletion of await store.deletions.list({ stage: "running" })) {
				if (deletion.dueAt <= now()) await carryOnDeletion(deletion.id).catch(() => undefined);
			}
			return nextDeletionDue();
		},

		async githubWebhook(integrationId, request) {
			requireGithubRunners();
			return githubRunners.receive(integrationId, request);
		},

		async tickGithubRunners() {
			if (runnerSettings === undefined) return undefined;
			const next = await githubRunners.tick();
			runnersDueAt = next ?? now() + IDLE_RUNNER_PASS_MS;
			return next;
		},

		async sweep() {
			const at = now();
			keepGoing(sweepStickyDisks().catch(() => undefined));
			if (at - copiesKeptAt >= SNAPSHOT_COPIES_EVERY_MS) {
				copiesKeptAt = at;
				keepGoing(keepEverySnapshotsCopies());
			}
			// The GitHub runner broker's pass, when one is due: in the background, as it calls hosts and GitHub.
			if (runnerSettings !== undefined && at >= runnersDueAt) {
				runnersDueAt = at + IDLE_RUNNER_PASS_MS;
				keepGoing(
					githubRunners.tick().then(
						(next) => {
							runnersDueAt = next ?? now() + IDLE_RUNNER_PASS_MS;
						},
						() => undefined,
					),
				);
			}
			// Account deletions whose next pass is due: carried on in the background, one gateway each.
			for (const deletion of await store.deletions.list({ stage: "running" })) {
				if (deletion.dueAt <= at) keepGoing(carryOnDeletion(deletion.id));
			}
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
						// One whose host was revoked under its boot (`strandOn`) isn't handed back as running.
						(current.strandedOn ?? []).length === 0 &&
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
							// The same machine: its guest agent's health (and why) as the stop found it.
							reason: current.health === "unresponsive" ? current.reason : undefined,
						}),
						marker,
					).catch(() => undefined);
				}
			}
			// Upgrades whose gateway has gone quiet (gone mid-upgrade), or whose outcome wasn't known: settled with their
			// backend, one under way on this gateway left to it.
			for (const sandbox of await store.sandboxes.list({ state: "starting" })) {
				const upgrading = sandbox.upgrading;
				if (upgrading === undefined || pending.has(sandbox.id) || upgrading.heartbeatAt + UPGRADE_STALE_MS > at)
					continue;
				await settleStuckUpgrade(sandbox).catch(() => undefined);
			}
			// The use this gateway held back goes in first, so its own sweep never stops a sandbox that it saw used.
			await flushActivity();
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
				// Due: past its time, owed a stop (`stopFor`) whatever its time says, or gone its idle stop's time unused. A use
				// recorded before the stop moves it (`lastActiveAt`), or seen here and not yet stored, keeps it running:
				// `beginStop` asks again as it moves it.
				const timeUp = (current: StoredSandbox) => current.stopsAt !== undefined && current.stopsAt <= at;
				const due = (current: StoredSandbox) =>
					current.stopFor !== undefined || timeUp(current) || idleStopDue(current, at, seenActivity(current.id));
				if (!due(sandbox) || pending.has(sandbox.id)) continue;
				connected ??= await connectedHosts();
				if (sandbox.hostId === undefined || !connected.has(sandbox.hostId)) continue;
				// Every gateway sweeps: `beginStop` moves it only while it is still running, so one of them stops it and the
				// rest skip it. Its auto-stop's reason where both are due: a later resume for idleness alone may not undo it.
				const reason = sandbox.stopFor ?? (timeUp(sandbox) ? AUTO_STOP_REASON : IDLE_STOP_REASON);
				const began = await beginStop(sandbox, false, reason, undefined, due, true).catch(() => undefined);
				if (began !== undefined) keepGoing(began.work);
			}
			// Each template's cache, against the hosts' runtimes as they are now, in the background (one pass at a time).
			keepGoing(templates.reconcileAll());
			expireSnapshots();
		},

		publishTemplateBase: (input) => templates.publishTemplateBase(input),

		async sampleUsage() {
			await catchUpUsage();
			// Ticks held while the store failed go in first, so they are in this export, not left for a tick that may not come.
			await retryHeldUsage();
			const samples: TelemetryUsageSample[] = [];
			const running = await store.sandboxes.list({ state: "running" });
			// The export's own timer is the fallback's pace: one read per flush for a host that doesn't send its own.
			const hosts = hostsOnce();
			for (const sandbox of running) await readUsage(sandbox, 0, hosts);
			const byId = new Map(running.map((sandbox) => [sandbox.id, sandbox]));
			// Every reading not yet taken, whatever the sandbox's state now: one that stopped since still sends what it had.
			for (const id of sandboxSeries.keys()) {
				// A sandbox the export hasn't taken from yet (this process just began exporting): its last few minutes, not
				// the hour kept.
				const from = exportedUntil.get(id) ?? now() - EXPORT_LOOKBACK_MS;
				const { points } = sandboxSeries.read(id, from);
				const last = points[points.length - 1];
				if (last === undefined) continue;
				exportedUntil.set(id, last.at);
				// What another replica passed on, the one holding the host exports. A host that moved between replicas leaves
				// each its own points to send, and a newer passed-on point doesn't skip an older one taken here.
				const taken = points.filter((point) => point.shared !== true);
				if (taken.length === 0) continue;
				const sandbox = byId.get(id) ?? (await store.sandboxes.get(id));
				if (sandbox === undefined) continue;
				for (const point of taken) {
					samples.push({
						accountId: sandbox.accountId,
						sandboxId: sandbox.id,
						sandboxType: sandbox.type,
						cpu: point.cpu,
						memoryBytes: point.memUsedBytes,
						runningSeconds: runningMs(sandbox.runs, 0, point.at) / 1000,
						at: point.at,
						startedAt: sandbox.startedAt,
					});
				}
			}
			await settleUsage();
			// A cursor lasts as long as its series' points, so a sandbox resumed within the hour doesn't send them again.
			const kept = new Set(sandboxSeries.keys());
			for (const id of exportedUntil.keys()) if (!kept.has(id)) exportedUntil.delete(id);
			for (const id of fallbackReadAt.keys()) if (!byId.has(id)) fallbackReadAt.delete(id);
			return samples;
		},

		recordUsage(hostId, report, how) {
			return ingestInTurn(hostId, report, how?.shared === true);
		},

		async sandboxEnv(hostId, sandboxId) {
			const sandbox = await store.sandboxes.get(sandboxId);
			if (sandbox === undefined || sandbox.state === "deleted" || sandbox.hostId !== hostId) return undefined;
			return { env: { ...sandbox.env } };
		},

		async protectedTable(hostId, sandboxId) {
			const sandbox = await store.sandboxes.get(sandboxId);
			// Only the host the sandbox is on: another host asking learns nothing, not even that it exists.
			if (sandbox === undefined || sandbox.state === "deleted" || sandbox.hostId !== hostId) return undefined;
			const environments = await environmentsOf(sandbox);
			// No environment left (deleted, or detached): nothing resolves, at a version past any it was given.
			if (environments.length === 0) return { version: Math.max(now(), sandbox.secretsFloor ?? 0), entries: [] };
			const entries: ProtectedEntry[] = [];
			for (const { name, placeholder, winner } of protectedWinners(sandbox, resolved(environments))) {
				const variable = winner.item;
				if (variable.sealed === undefined) continue;
				const value = await requireSealer().openText(variable.sealed, variableAad(winner.environment.id, name));
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
			return { version: secretsVersionOf(environments, sandbox.secretsFloor) ?? now(), entries };
		},

		async recordBases(hostId, reports) {
			const valid = (base: unknown): base is string => typeof base === "string" && REPORTED_BASE.test(base);
			// A report replaces what the record has when the record has no base, or when the host says it put the sandbox on
			// this base after the time the record has (a boot whose answer was lost); one from before never does.
			const newer = (current: StoredSandbox, base: string, at: number | undefined) =>
				current.base === undefined || (at !== undefined && current.base !== base && at > (current.baseAt ?? 0));
			for (const { sandboxId, base, baseAt } of reports.sandboxes ?? []) {
				if (typeof sandboxId !== "string" || !valid(base)) continue;
				const at = typeof baseAt === "number" && Number.isFinite(baseAt) && baseAt > 0 ? baseAt : undefined;
				const sandbox = await store.sandboxes.get(sandboxId);
				if (sandbox === undefined || sandbox.hostId !== hostId || !newer(sandbox, base, at)) continue;
				// Decided again on the record as it is when written (the SQL store's conditional update reruns it): a boot that
				// recorded a later base meanwhile wins.
				await store.sandboxes.update(sandboxId, (current) =>
					current.hostId === hostId &&
					newer(current, base, at) &&
					current.state !== "deleted" &&
					current.state !== "deleting"
						? { ...current, base, baseAt: at ?? 0 }
						: undefined,
				);
			}
			// Snapshots by their ref, read in one pass (a host reports every one it has on each connection, and a ref isn't
			// indexed): only those with no base yet are written.
			const reported = new Map<string, string>();
			for (const { ref, base } of reports.snapshots ?? []) {
				if (typeof ref !== "string" || !reportsOwn(hostId, ref) || !valid(base)) continue;
				reported.set(ref, base);
			}
			if (reported.size === 0) return;
			for (const snapshot of await store.snapshots.list()) {
				const base = takenHere(hostId, snapshot) ? reported.get(snapshot.ref) : undefined;
				if (base === undefined || snapshot.base !== undefined) continue;
				const { ref } = snapshot;
				await store.snapshots.update(snapshot.id, (current) =>
					current.ref === ref && current.base === undefined ? { ...current, base } : undefined,
				);
			}
		},

		async recordSnapshotSizes(hostId, sizes, shared = []) {
			const own = (ref: unknown): ref is string => typeof ref === "string" && reportsOwn(hostId, ref);
			const whole = (value: unknown): value is number =>
				typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
			const reported = new Map<string, number>();
			const unique = new Map<string, number>();
			for (const { ref, sizeBytes, uniqueBytes } of sizes) {
				if (!own(ref) || !whole(sizeBytes)) continue;
				reported.set(ref, sizeBytes);
				if (whole(uniqueBytes)) unique.set(ref, uniqueBytes);
			}
			if (reported.size === 0) return;
			const full = new Map(reported);
			// Read in one pass, as `recordBases` does (a ref isn't indexed): only those whose size changed are written. A
			// saved snapshot's copy on another host is named as it is, and is that host's to measure, not the snapshot's.
			const records = (await store.snapshots.list()).filter((snapshot) => takenHere(hostId, snapshot));
			// Each snapshot whose host says what is its own (a microVM's; an isolate's says nothing): its shared files counted
			// once, by this plane's records. One that doesn't say keeps the size it was reported with.
			if (unique.size > 0) {
				const groups = shared.filter(
					(group) => whole(group.bytes) && group.refs.every((ref) => own(ref) && unique.has(ref)),
				);
				const attributed = attributeSnapshotBytes(records, unique, groups);
				for (const ref of unique.keys()) reported.set(ref, attributed.get(ref) ?? 0);
			}
			for (const snapshot of records) {
				const sizeBytes = reported.get(snapshot.ref);
				// All its files, shared ones included: what a host's limit on saved bytes counts it at.
				const fullSizeBytes = full.get(snapshot.ref);
				if (sizeBytes === undefined || fullSizeBytes === undefined) continue;
				if (snapshot.sizeBytes === sizeBytes && snapshot.fullSizeBytes === fullSizeBytes) continue;
				const { ref } = snapshot;
				await store.snapshots.update(snapshot.id, (current) =>
					current.ref === ref && (current.sizeBytes !== sizeBytes || current.fullSizeBytes !== fullSizeBytes)
						? { ...current, sizeBytes, fullSizeBytes }
						: undefined,
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
				// A host reports only its own sandboxes, in an open account; anything else is dropped.
				if (sandbox === undefined || sandbox.hostId !== hostId) continue;
				if (!(await accountOpen(sandbox.accountId))) continue;
				// Checked again once written (`accountOpen`): a report that lands as its account closes goes, and so does what
				// one that failed partway wrote, its error kept.
				const forget = async () => {
					for (const entry of await store.egress.list({ sandboxId })) await store.egress.delete(entry.id);
				};
				try {
					for (const record of batch.slice(-MAX_EGRESS_ENTRIES)) {
						await store.egress.put(egressEntryFrom(record, sandbox, now()));
					}
				} catch (error) {
					if (!(await accountOpen(sandbox.accountId))) await forget().catch(() => undefined);
					throw error;
				}
				if (!(await accountOpen(sandbox.accountId))) {
					await forget();
					continue;
				}
				const log = await egressLog(sandboxId);
				for (const stale of log.slice(MAX_EGRESS_ENTRIES)) await store.egress.delete(stale.id);
			}
		},

		async close() {
			closing = true;
			for (const controller of runningCommands.values()) controller.abort();
			await live.close();
			await idle();
		},

		async bundleForHost(hostId, sandboxId, digest) {
			return mounts?.bundleForHost(hostId, sandboxId, digest);
		},

		async bucketSourceForHost(hostId, sandboxId, bucketSourceId) {
			return mounts?.bucketSourceForHost(hostId, sandboxId, bucketSourceId);
		},

		async reportMounts(hostId, sandboxId, statuses, mountsAt) {
			// Kept even with mounts off now: a sandbox made while they were on still has them.
			await reportMountStatuses(store, hostId, sandboxId, statuses, mountsAt);
		},

		reportHealth,

		reportExit,
		reportHostConnection,

		async poolSync(poolId) {
			return (await store.pools.get(poolId))?.sync === true;
		},

		recordHoldings: (hostId, at, report) => diskHolders.recordHoldings(hostId, at, report),
		locateDisk: (hostId, request) => diskHolders.locate(hostId, request),
		grantPublicKey: async () => (await diskHolders.keys())?.current.publicKey,
		grantKeys: async () => {
			const keys = await diskHolders.keys();
			return keys === undefined
				? undefined
				: [keys.current, ...(keys.next === undefined ? [] : [keys.next]), ...keys.retired];
		},

		async serveFileUrl(token, request) {
			return mounts === undefined ? mountsOff() : mounts.serveFileUrl(token, request);
		},

		idle,
	};
}

/** A boot's base for the sandbox's record: the base and when it was put on it (0: not said); nothing when not said. */
function placedBase(placement: Placement): { base?: string; baseAt?: number } {
	return placement.base === undefined ? {} : { base: placement.base, baseAt: placement.baseAt ?? 0 };
}

/** A snapshot's size as its host measures it (`ComputeService.recordSnapshotSizes`), by its ref. */
export interface SnapshotSizeReport {
	readonly ref: string;
	/** All its files take, shared ones included. */
	readonly sizeBytes: number;
	/** What of that is in files no other snapshot holds; absent from a host that doesn't say. */
	readonly uniqueBytes?: number;
}

/**
 * Each ref's size with every shared file counted once (`ComputeService.recordSnapshotSizes`, and a keep's answer): its
 * own bytes (`unique`), and each group of shared files (`shared`) for one of its holders, chosen by the records: a ref
 * an API-saved record has first (a kept copy keeps its files once its automatic source expires; a manual take, which a
 * host keeps as saved, is automatic here), then the one recorded first, then by ref. A group none of whose holders has
 * a record counts for none of them.
 */
export function attributeSnapshotBytes(
	records: readonly Pick<StoredSnapshot, "ref" | "kind" | "createdAt" | "state">[],
	unique: ReadonlyMap<string, number>,
	shared: readonly SharedSnapshotBytes[],
): Map<string, number> {
	const saved = new Set<string>();
	const first = new Map<string, number>();
	for (const record of records) {
		if (record.ref === undefined || record.state === "deleting") continue;
		if (record.kind === "saved") saved.add(record.ref);
		first.set(record.ref, Math.min(first.get(record.ref) ?? Number.POSITIVE_INFINITY, record.createdAt));
	}
	const sizes = new Map(unique);
	for (const group of shared) {
		const [keeper] = group.refs
			.filter((ref) => first.has(ref))
			.sort(
				(a, b) =>
					Number(saved.has(b)) - Number(saved.has(a)) ||
					(first.get(a) ?? 0) - (first.get(b) ?? 0) ||
					a.localeCompare(b),
			);
		if (keeper !== undefined) sizes.set(keeper, (sizes.get(keeper) ?? 0) + group.bytes);
	}
	return sizes;
}

/** What a host says its sandboxes and snapshots are on (`ComputeService.recordBases`). */
export interface BaseReports {
	/** `baseAt`: when the host put it on `base` (`HostSandbox.baseAt`), which orders reports; absent from older hosts. */
	readonly sandboxes?: readonly { readonly sandboxId: string; readonly base: string; readonly baseAt?: number }[];
	/** By the snapshot's ref, `<hostId>/<snapshot ID on the host>`. */
	readonly snapshots?: readonly { readonly ref: string; readonly base: string }[];
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
