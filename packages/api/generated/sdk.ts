// Kantel's public API: the TypeScript SDK. Generated from packages/api/src/routes.ts by
// `pnpm --filter @kantel/api generate`; don't edit it by hand. CI fails while it is stale.

// Types

/** An account the caller may act in, with the caller's role in it. */
export interface Account {
	/** The account's ID, such as `acc_7f3k2m9q`. */
	readonly id: string;
	/** `personal`: one person's own account, made at their first sign-in; what they create is theirs alone unless they move it. `organisation`: an account people create or join, where sandboxes and snapshots are shared. */
	readonly kind: AccountKind;
	readonly name: string;
	/** `member`: uses the organisation's shared sandboxes and snapshots and makes their own. `admin`: also manages members, API keys, webhooks, telemetry and the proxy. `owner`: also renames or deletes the organisation. A personal account's person is its `owner`. */
	readonly role: MemberRole;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly defaultVisibility: SandboxVisibility;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
}

export interface AccountJoinToken {
	/** The token's ID. */
	readonly id: string;
	/** The account the host joins: only its sandboxes will run there. */
	readonly accountId: string;
	/** `kth_…`, shown once. It joins one host, once, before `expiresAt`. */
	readonly token: string;
	/** The one-line command that installs the host agent on a Linux machine and joins it with the token. The host dials out to this deployment and keeps that connection open, so it needs no inbound port. */
	readonly command: string;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

/** `personal`: one person's own account, made at their first sign-in; what they create is theirs alone unless they move it. `organisation`: an account people create or join, where sandboxes and snapshots are shared. */
export type AccountKind = "personal" | "organisation";

/** The account's limits, where the deployment sets any. */
export interface AccountLimits {
	readonly concurrentSandboxes?: number;
	readonly startsPerMinute?: number;
	readonly savedSnapshots?: number;
}

export interface AccountList {
	readonly items: readonly Account[];
}

export interface AccountScopedQuery {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
}

export interface AccountUsage {
	readonly accountId: string;
	/** Epoch milliseconds, UTC. */
	readonly since: number;
	/** Sandboxes running now. */
	readonly running: number;
	readonly runningSeconds: number;
	/** What a sandbox costs at the deployment's rates. A self-hosted install's rates are 0 unless its operator sets them. */
	readonly cost: Cost;
	/** The account's limits, where the deployment sets any. */
	readonly limits?: AccountLimits;
}

/** A scoped API key. Its secret is never stored or shown after it is made. */
export interface ApiKey {
	/** The key's ID, such as `key_5n2p8r`. */
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	/** The secret's first characters, such as `ksk_5n2p`, to tell keys apart. */
	readonly prefix: string;
	readonly scopes: readonly ApiKeyScope[];
	/** Limited to these sandboxes (and the ones it creates). */
	readonly sandboxIds?: readonly string[];
	readonly createdBy: CreatedBy;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** When the key last signed a call in, to within a minute. Absent until its first use. */
	readonly lastUsedAt?: number;
	/** Epoch milliseconds, UTC. */
	readonly revokedAt?: number;
}

export interface ApiKeyList {
	readonly items: readonly ApiKey[];
}

/** A named set of scopes. `read-only`: the `:read` scopes. `agent`: what a coding agent needs to make and drive its own sandboxes, everything but `sandboxes:delete` and the account and host scopes. `ci`: `agent` plus `sandboxes:delete`. `admin`: every scope but `hosts:admin`. */
export type ApiKeyPreset = "read-only" | "agent" | "ci" | "admin";

/** What a key may do. `sandboxes:read`: list and inspect sandboxes, their usage and events. `sandboxes:write`: create, change, start, stop, pause, resume, fork and recover. `sandboxes:delete`: delete for good. `exec`: run commands. `files`: read and write files. `access`: SSH, desktop, browser and public ports. `snapshots:read`, `snapshots:write`: snapshots and saved snapshots. `account:read`: the account, its members, keys, environments, templates and sandboxes' egress. `account:admin`: members, keys, webhooks, telemetry, the proxy, environments, templates and sandboxes' grants. `hosts:admin`: the deployment's hosts and template bases, for a super-admin's key only. */
export type ApiKeyScope =
	| "sandboxes:read"
	| "sandboxes:write"
	| "sandboxes:delete"
	| "exec"
	| "files"
	| "access"
	| "snapshots:read"
	| "snapshots:write"
	| "account:read"
	| "account:admin"
	| "hosts:admin";

/** The key the device gets, in the approver's personal account unless `account` names an organisation. Without `preset`, every scope the approver may grant there, `hosts:admin` included for a super-admin. */
export interface ApproveDeviceLoginBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** A named set of scopes. `read-only`: the `:read` scopes. `agent`: what a coding agent needs to make and drive its own sandboxes, everything but `sandboxes:delete` and the account and host scopes. `ci`: `agent` plus `sandboxes:delete`. `admin`: every scope but `hosts:admin`. */
	readonly preset?: ApiKeyPreset;
	/** Default 90. The key stops working after it. */
	readonly expiresInDays?: number;
}

export interface BaseImage {
	/** `sandbox`, `browser`, `isolate-host`, or `host` for the microVM host images. */
	readonly name: string;
	/** Where it is pulled from, such as `ghcr.io/lleverage-ai/kantel-sandbox`; for `host`, the release's. */
	readonly repository: string;
	/** The channel `latest` is of. */
	readonly channel: "stable";
	/** One build of a base image. */
	readonly latest?: BaseImageVersion;
	/** Its newest versions, newest first, at most 10. */
	readonly versions: readonly BaseImageVersion[];
}

/** One vulnerability a scan found in an image. */
export interface BaseImageFinding {
	/** `CVE-2026-1234`, or the scanner's own ID where there is no CVE. */
	readonly id: string;
	readonly severity: ScanSeverity;
	/** The package it is in, such as `openssl`. */
	readonly package: string;
	/** The package's version in the image. */
	readonly installed: string;
	/** The version that fixes it, where one is out. */
	readonly fixed?: string;
	readonly title?: string;
}

/** Kantel's base images as the index CI publishes them: each image's latest version, its newest versions and what their CVE scans found. */
export interface BaseImageList {
	readonly images: readonly BaseImage[];
	/** Templates and their bases; empty until templates exist. */
	readonly templates: readonly BaseImageTemplate[];
	/** Where the deployment reads the base image index (`KANTEL_BASE_IMAGE_INDEX`). */
	readonly indexUrl: string;
	/** When the index was last written, ISO 8601. */
	readonly generatedAt?: string;
	/** Why the index couldn't be read; `images` is empty then. It is tried again soon. */
	readonly error?: string;
}

/** What the newest CVE scan of a version found. */
export interface BaseImageScan {
	/** What scanned it, such as `trivy 0.68.1`. */
	readonly scanner: string;
	/** When, ISO 8601. */
	readonly scannedAt: string;
	/** Every finding, by severity. */
	readonly counts: BaseImageScanCounts;
	/** Critical and High findings with a fix out: what makes Kantel rebuild the image at once. */
	readonly fixable: BaseImageScanFixable;
	/** The Critical and High findings, most severe first, at most 50. */
	readonly findings: readonly BaseImageFinding[];
}

/** Every finding, by severity. */
export interface BaseImageScanCounts {
	/** Critical findings. */
	readonly critical: number;
	/** High findings. */
	readonly high: number;
	/** Medium findings. */
	readonly medium: number;
	/** Low findings. */
	readonly low: number;
	/** Findings of no known severity. */
	readonly unknown: number;
}

/** Critical and High findings with a fix out: what makes Kantel rebuild the image at once. */
export interface BaseImageScanFixable {
	/** Critical findings with a fix out. */
	readonly critical: number;
	/** High findings with a fix out. */
	readonly high: number;
}

/** A template and the base it is built on. */
export interface BaseImageTemplate {
	readonly id: string;
	readonly name: string;
	/** The base image it is built on. */
	readonly image: string;
	/** The channel it follows, such as `stable`. */
	readonly channel?: string;
	/** The digest it is pinned to, when it doesn't follow a channel. */
	readonly pinned?: string;
	/** The base image a sandbox's (or a snapshot's) root file system is, and how far behind it is. A running sandbox is never patched underneath: an outdated one stays on its base until it is restarted on the latest (`restartSandboxOnLatest`) or made again. Experimental: present only where the deployment has image patching on (`KANTEL_IMAGE_PATCHING`) and knows the version. */
	readonly base: SandboxBase;
	/** Whether it is being rebuilt on the latest base now. */
	readonly rebuilding: boolean;
}

/** One build of a base image. */
export interface BaseImageVersion {
	/** Its tag, such as `2026.11.04.1`. */
	readonly version: string;
	/** `sha256:…`: the digest it is pulled by. A version's digest never changes. */
	readonly digest: string;
	/** When it was built, ISO 8601. */
	readonly builtAt: string;
	/** Signed with cosign, keyless, by Kantel's build. */
	readonly signed: boolean;
	/** Why it was built: the daily build, a fixable Critical or High finding, by hand, or a change. */
	readonly reason?: "daily" | "cve" | "manual" | "push";
	/** What the newest CVE scan of a version found. */
	readonly scan?: BaseImageScan;
}

export interface BrowserAccess {
	/** Watch and drive the sandbox's Chromium in a browser: the browser alone where `surface` is `browser`, else the desktop it runs on. */
	readonly url: string;
	/** The same view, for an `<iframe>` in your own app. */
	readonly embedUrl: string;
	/** Experimental. What `url` shows: `browser`, the browser alone on a display of its own, sized to the viewer and streamed only while someone watches; `desktop`, the sandbox's desktop with Chromium on it (an image without a browser surface). */
	readonly surface: "browser" | "desktop";
	/** A Chrome DevTools Protocol WebSocket URL, for Playwright's `connectOverCDP` or Puppeteer. */
	readonly cdpUrl: string;
	readonly viewOnly: boolean;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

export interface BrowserEmbed {
	/** The page to frame. It holds its token after `#`, so the token reaches no server; treat the URL as a secret. */
	readonly url: string;
	readonly mode: "live" | "replay";
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** What the page posts to its parent once its stream is over. */
	readonly endMessage?: string;
}

/** An S3 access key, or a GCS HMAC key. */
export interface BucketAccessKey {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
}

/** Write-only: kept encrypted, given only to the host of a sandbox that mounts the bucket, never answered. */
export type BucketCredentials = BucketAccessKey | BucketServiceAccountKey;

/** An object-store prefix, through a bucket source the account holds. The host reads objects as they are opened; the bucket source's credentials stay on the host, never in the sandbox. */
export interface BucketMountSource {
	readonly kind: "bucket";
	/** A bucket source of the sandbox's account, such as `bks_4kq9x2mt`. */
	readonly bucketSourceId: string;
	/** The objects under this key prefix, such as `org/42/skills/`; empty for the whole bucket. */
	readonly prefix: string;
	/** How long the host trusts its listing of the prefix before it looks again, so objects added later appear. 0: never look again. Default: the host's. */
	readonly refreshTtlSeconds?: number;
}

/** `s3`: Amazon S3 or an S3-compatible store (with `endpoint`). `gcs`: Google Cloud Storage. */
export type BucketProvider = "s3" | "gcs";

export interface BucketServiceAccountKey {
	/** A GCS service account's JSON key, as Google gives it. */
	readonly serviceAccountKey: string;
}

/** A bucket an account's sandboxes may mount prefixes of, with the credentials that read it. The credentials are write-only. */
export interface BucketSource {
	/** The bucket source's ID, such as `bks_4kq9x2mt`. */
	readonly id: string;
	readonly accountId: string;
	/** A name for people, such as `org files`. */
	readonly name: string;
	/** `s3`: Amazon S3 or an S3-compatible store (with `endpoint`). `gcs`: Google Cloud Storage. */
	readonly provider: BucketProvider;
	/** The bucket's name. */
	readonly bucket: string;
	/** An S3-compatible store's HTTPS endpoint, such as `https://<account>.r2.cloudflarestorage.com`. */
	readonly endpoint?: string;
	/** Such as `eu-west-1`. */
	readonly region?: string;
	/** Whether it was given credentials; they are never answered. */
	readonly hasCredentials: boolean;
	/** How many of the account's sandboxes that still exist mount it. */
	readonly mountedBy: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
}

export interface BucketSourceList {
	readonly items: readonly BucketSource[];
}

/** A tar of files uploaded to an account once, named by its digest, which sandboxes mount read-only. It never changes: other files are another bundle. */
export interface Bundle {
	/** `sha256:` and the hex SHA-256 of the tar: the bundle's name and its ID. */
	readonly digest: string;
	readonly accountId: string;
	/** The tar's size. */
	readonly sizeBytes: number;
	/** How many of the account's sandboxes that still exist mount it. */
	readonly mountedBy: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
}

export interface BundleList {
	readonly items: readonly Bundle[];
}

/** A bundle's files: the tar the account uploaded (`POST /bundles`), unpacked read-only at the mount's path. */
export interface BundleMountSource {
	readonly kind: "bundle";
	/** A bundle uploaded to the sandbox's account, by its digest: `sha256:` and 64 hex digits. */
	readonly digest: string;
}

/** Who is calling, the accounts they may act in, and the deployment's mode and what it supports. */
export interface Caller {
	readonly user?: CallerUser;
	/** The key the call was signed in with, when it was a key. */
	readonly apiKey?: CallerApiKey;
	/** The account the call acts in when it names none. */
	readonly accountId: string;
	readonly accounts: readonly Account[];
	/** Whether the caller may manage the deployment's hosts. */
	readonly superAdmin: boolean;
	/** `selfhosted`: an install someone runs for themselves. `hosted`: a hosted service with plans. */
	readonly mode: DeploymentMode;
	/** The domain sandboxes' addresses are under: a sandbox's is `<subdomain>.<sandboxDomain>` and its exposed ports `<port>-<subdomain>.<sandboxDomain>`, such as `kantel.run` on Kantel's hosted service. Absent when the deployment names none. */
	readonly sandboxDomain?: string;
	/** Whether the deployment keeps environments' protected variables and secret files (and bucket sources' credentials). `false`: setting one is refused with `not_supported`, and plain variables still work. Absent from a deployment older than this field: try, and read the error. */
	readonly protectedValues?: boolean;
}

/** The key the call was signed in with, when it was a key. */
export interface CallerApiKey {
	readonly id: string;
	readonly name: string;
	readonly scopes: readonly ApiKeyScope[];
}

export interface CallerUser {
	readonly id: string;
	readonly name: string;
	readonly email?: string;
}

export interface Command {
	/** The command's ID, such as `cmd_9a8b7c`. */
	readonly id: string;
	readonly sandboxId: string;
	readonly command: string;
	readonly cwd?: string;
	readonly state: CommandState;
	readonly exitCode?: number;
	/** Its output, up to 1 MiB; `truncated` says if there was more. While it runs, its output so far where its sandbox reports it (a microVM on a current kantel-host), and empty elsewhere. */
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated: boolean;
	/** Epoch milliseconds, UTC. */
	readonly startedAt: number;
	/** Epoch milliseconds, UTC. */
	readonly endedAt?: number;
	readonly durationMs?: number;
}

export interface CommandPage {
	readonly items: readonly Command[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export type CommandState = "running" | "exited" | "killed" | "timed_out";

export interface ComputePageQuery {
	/** At most this many; default 50. */
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

/** What a sandbox costs at the deployment's rates. A self-hosted install's rates are 0 unless its operator sets them. */
export interface Cost {
	/** ISO 4217, such as `USD`. */
	readonly currency: string;
	/** What it has cost so far, in `currency`. */
	readonly total: number;
	/** What an hour of running costs at its size, in `currency`. */
	readonly ratePerHour: number;
}

export interface CreateAccountJoinTokenBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** The host's name. Default: the machine's hostname. */
	readonly name?: string;
	readonly labels?: {
		readonly [key: string]: string;
	};
	/** Default 60. */
	readonly expiresInMinutes?: number;
}

/** Give `scopes` or a `preset` (or both, which adds them). A key can't hold a scope its maker lacks. */
export interface CreateApiKeyBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	readonly name: string;
	readonly scopes?: readonly ApiKeyScope[];
	/** A named set of scopes. `read-only`: the `:read` scopes. `agent`: what a coding agent needs to make and drive its own sandboxes, everything but `sandboxes:delete` and the account and host scopes. `ci`: `agent` plus `sandboxes:delete`. `admin`: every scope but `hosts:admin`. */
	readonly preset?: ApiKeyPreset;
	readonly sandboxIds?: readonly string[];
	/** Absent: it never expires. */
	readonly expiresInDays?: number;
}

export interface CreateBucketSourceBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** A name for people, such as `org files`. */
	readonly name: string;
	/** `s3`: Amazon S3 or an S3-compatible store (with `endpoint`). `gcs`: Google Cloud Storage. */
	readonly provider: BucketProvider;
	/** The bucket's name. */
	readonly bucket: string;
	/** An S3-compatible store's HTTPS endpoint, such as `https://<account>.r2.cloudflarestorage.com`. */
	readonly endpoint?: string;
	/** Such as `eu-west-1`. */
	readonly region?: string;
	/** Write-only: kept encrypted, given only to the host of a sandbox that mounts the bucket, never answered. */
	readonly credentials?: BucketCredentials;
}

export interface CreatedBy {
	readonly kind: "user" | "api_key";
	/** The user's or the API key's ID. */
	readonly id: string;
	readonly name?: string;
}

export interface CreateEnvironmentBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** Unique in the account: lower-case letters, digits and dashes, at most 63. */
	readonly name: string;
	readonly description?: string;
}

export interface CreateHostJoinTokenBody {
	readonly name?: string;
	readonly labels?: {
		readonly [key: string]: string;
	};
	/** Default 60. */
	readonly expiresInMinutes?: number;
}

export interface CreateInviteBody {
	/** `member`: uses the organisation's shared sandboxes and snapshots and makes their own. `admin`: also manages members, API keys, webhooks, telemetry and the proxy. `owner`: also renames or deletes the organisation. A personal account's person is its `owner`. */
	readonly role?: MemberRole;
	/** Only this person may use it. Absent: anyone with the code. */
	readonly email?: string;
	/** Default 168 (a week). */
	readonly expiresInHours?: number;
}

export interface CreateOrganisationBody {
	readonly name: string;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly defaultVisibility?: SandboxVisibility;
}

/** Any other field is refused as `invalid`. */
export interface CreateProjectBody {
	/** The project's name, trimmed: not empty, and at most 100 characters. */
	readonly name: string;
}

/** Every field is optional: `{}` makes a running isolate in the caller's account. */
export interface CreateSandboxBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** Default: a generated name, such as `brave-otter`. */
	readonly name?: string;
	/** `isolate`: a workerd isolate with a JavaScript shell over the sandbox's files. Starts in milliseconds and costs almost nothing, but runs no native binaries, has no desktop and no SSH. `microvm`: a Firecracker microVM with a full Linux, root, Docker and `/dev/kvm` inside, a desktop, a browser and SSH. */
	readonly type?: SandboxType;
	/** A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: a named size is still taken for now. */
	readonly size?: SandboxSizeName;
	/** What a new sandbox gets. A microVM restores a template snapshot on its host: by default the one its host keeps for its vCPU count, whatever its memory, so a shape off the presets is as fast as a preset once that count's template is made. A host with shared templates turned off keeps one per preset, and a shape off the presets boots from scratch. */
	readonly resources?: SandboxShapeInput;
	/** A microVM's base image. Default: the deployment's. */
	readonly image?: string;
	/** Start from this snapshot: a snapshot's ID or a saved snapshot's name in the account. */
	readonly from?: string;
	/** Default 60. `null`: never stop by itself. */
	readonly autoStopMinutes?: number | null;
	/** Stop it once it has gone this long without use (`idle-stop`), whatever its auto-stop says; with `autoStopMinutes: null`, it runs while it is used. Default `null`: no idle stop. See the sandbox's `idleStopMinutes` for what counts as use. */
	readonly idleStopMinutes?: number | null;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly visibility?: SandboxVisibility;
	readonly labels?: {
		readonly [key: string]: string;
	};
	/** Environment variables every command sees, after the environment's. Not secrets: they are shown to anyone who may exec. Kantel's own names (`KANTEL_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, in any case) are refused. */
	readonly env?: {
		readonly [key: string]: string;
	};
	/** Start with this environment, an environment's ID or name in the account: its plain variables, a placeholder for each protected one, its secret files and repositories, and its grants. `env` may not name one of its protected variables. */
	readonly environment?: string;
	/** Make a microVM from this template, a template's ID or name in the account (experimental, `KANTEL_TEMPLATES`): from its newest built snapshot when one is ready, else by booting its image and running its setup. A Dockerfile or image reference boots only once its current version's image is built (`unavailable` until then), on the host that built it. Its variables go under the environment's and `env`, its grants with the sandbox's own, and with `size` left out its resources are the machine's, exactly (`resources`), named by the smallest size with them. Not with `from` or `image`. A template with setup needs a key with `exec` too: a host may boot it fresh whatever its snapshot, running the setup with the sandbox's variables. */
	readonly template?: string;
	/** Place it only on a host with each label, such as `{ site: "home" }`. */
	readonly hostLabels?: {
		readonly [key: string]: string;
	};
	/** Place it on this host, a host's ID or name: one of the account's own hosts, or for a super-admin a shared one (any other is `not_found`). It stays on that host, as every sandbox stays where it was placed. `unavailable` (`host_unavailable`) when that host is offline, draining, doesn't run the type, lacks a `hostLabels` label or (for a create from a snapshot) doesn't hold the snapshot. Default: whichever host placement picks. */
	readonly host?: string;
	/** Files from outside the sandbox, read-only inside it: at most 16, at paths that don't overlap. A bundle or bucket source it names must be the account's. microVMs only: an isolate is refused (`not_supported`). A host that can't mount a source marks that mount `failed`, and the sandbox runs without it. A fork keeps its source's mounts. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). */
	readonly mounts?: readonly Mount[];
	/** Answer once it is `running` (or `error`) rather than as soon as it is placed. */
	readonly wait?: boolean;
}

export interface CreateTemplateBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** Unique in the account: lower-case letters, digits and dashes, at most 63. */
	readonly name: string;
	readonly description?: string;
	/** A template version's definition, never changed once made. Answered with every default filled in. */
	readonly spec: TemplateSpec;
}

export interface CreateWebhookBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	readonly name: string;
	/** HTTPS; a self-hosted install may allow `http://` to a private address. */
	readonly url: string;
	readonly events: readonly EventType[];
}

/** `selfhosted`: an install someone runs for themselves. `hosted`: a hosted service with plans. */
export type DeploymentMode = "selfhosted" | "hosted";

export interface DesktopAccess {
	/** Opens the desktop in a browser. Anyone holding it may use it until it expires. */
	readonly url: string;
	/** The same, for an iframe. */
	readonly embedUrl: string;
	readonly viewOnly: boolean;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

/** Where a protected variable's value may go: the host's egress proxy swaps the sandbox's placeholder for the value only on a request that matches, and refuses a request that carries the placeholder anywhere else. */
export interface DestinationBinding {
	/** The host, on port 443: `api.github.com`, or `*.example.com` for its subdomains (not `example.com` itself). */
	readonly host: string;
	/** Only paths under these, such as `/repos/`. Absent or empty: any path. */
	readonly pathPrefixes?: readonly string[];
	/** Only these methods. Absent or empty: any method. */
	readonly methods?: readonly string[];
}

/** A sign-in in the browser under way, as RFC 8628's device authorisation grant. */
export interface DeviceLogin {
	/** `kdc_…`: the device's secret, which it polls with. Never show it. */
	readonly deviceCode: string;
	/** `ABCD-EFGH`: the code the person checks in the browser. */
	readonly userCode: string;
	/** The console's page where a signed-in person approves it. */
	readonly verificationUrl: string;
	/** The same page with the code filled in. */
	readonly verificationUrlComplete: string;
	/** Poll no more often than this. */
	readonly intervalSeconds: number;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

/** A device waiting for a person to approve it, as the approval page shows it. */
export interface DeviceLoginRequest {
	readonly userCode: string;
	readonly clientName: string;
	/** `pending`: no one has approved it yet. `approved`: the poll that sees it first gets the key; later polls are `expired`. `denied`: the person refused it. `expired`: too late, or already collected. */
	readonly state: DeviceLoginState;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

/** With `approved`, the new key and its secret, shown this once. */
export interface DeviceLoginResult {
	/** `pending`: no one has approved it yet. `approved`: the poll that sees it first gets the key; later polls are `expired`. `denied`: the person refused it. `expired`: too late, or already collected. */
	readonly state: DeviceLoginState;
	readonly issued?: IssuedApiKey;
}

/** `pending`: no one has approved it yet. `approved`: the poll that sees it first gets the key; later polls are `expired`. `denied`: the person refused it. `expired`: too late, or already collected. */
export type DeviceLoginState = "pending" | "approved" | "denied" | "expired";

export interface E2EAccess {
	/** A WebSocket URL to the sandbox's host that carries a Noise session as binary frames. The gateway relays it and can't read it: the device checks the host's key against the space's chain, and the host checks the device's. */
	readonly url: string;
	/** The host the sandbox is on: the chain's entry for it has its key. */
	readonly hostId: string;
	/** The sandbox's organisation: the space whose chain the session is in. */
	readonly accountId: string;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

export interface E2EAccessBody {
	/** How long a session can be started with this URL; one started in time stays open. Default 10. */
	readonly ttlMinutes?: number;
	/** The person whose device will open the session. Refused (`forbidden`) unless the call is that person's, so a browser whose sign-in may have changed under it (a cookie it can't read) never gets a URL for someone else's sign-in to use with its keys. */
	readonly user?: string;
}

export interface E2EChain {
	/** Oldest first; an entry's `seq` is its index. */
	readonly entries: readonly E2EEntry[];
}

export interface E2EChainAppend {
	/** The seq of the first entry given: the chain's length as the caller last saw it. */
	readonly from: number;
	readonly entries: readonly E2EEntry[];
}

export interface E2EEntry {
	/** Base64url of the entry's JSON, exactly the bytes that were signed. */
	readonly payload: string;
	/** Base64url of its Ed25519 signature. */
	readonly sig: string;
}

/** One request or connection a sandbox made through its host's egress proxy. Never a value. */
export interface EgressEntry {
	/** The entry's ID. */
	readonly id: string;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	/** `CONNECT` for a tunnel the proxy didn't look inside. */
	readonly method: string;
	readonly host: string;
	readonly port: number;
	/** The path, when the proxy saw it (plain HTTP or inspected HTTPS); never the query. */
	readonly path?: string;
	readonly decision: "allowed" | "denied";
	/** Why it was denied, or what failed, in words. */
	readonly reason?: string;
	/** The rule that decided it, such as `deny DELETE api.github.com /repos/*`. */
	readonly rule?: string;
	/** A refusal's `X-Kantel-Proxy-Error` code, such as `placeholder-unbound`. */
	readonly code?: string;
	/** The protected variables whose values the proxy put in, by name. */
	readonly swapped: readonly string[];
	/** Whether the proxy looked inside the HTTPS. */
	readonly inspected: boolean;
	/** The answer's status, when the proxy saw one. */
	readonly status?: number;
	readonly bytesUp: number;
	readonly bytesDown: number;
}

/** An egress rule on top of the account's proxy settings: let a sandbox reach a host, or refuse it. Deny wins. A grant naming methods or paths makes the proxy look inside that host's HTTPS, as a protected variable's host does. */
export interface EgressGrant {
	/** The grant's ID, such as `grt_4kq9x2mt`. */
	readonly id: string;
	readonly action: "allow" | "deny";
	/** The host: `api.github.com`, or `*.example.com` for its subdomains (not `example.com` itself). */
	readonly host: string;
	/** Only these methods. Absent or empty: every method. */
	readonly methods?: readonly string[];
	/** Path patterns, `*` one segment and `**` the rest, such as `/repos/lleverage-ai/*`. Absent or empty: every path. */
	readonly paths?: readonly string[];
}

export interface EgressGrantInput {
	/** Keep a grant's ID; absent, a new one is made. */
	readonly id?: string;
	readonly action: "allow" | "deny";
	/** The host: `api.github.com`, or `*.example.com` for its subdomains (not `example.com` itself). */
	readonly host: string;
	/** Only these methods. Absent or empty: every method. */
	readonly methods?: readonly string[];
	/** Path patterns, `*` one segment and `**` the rest, such as `/repos/lleverage-ai/*`. Absent or empty: every path. */
	readonly paths?: readonly string[];
}

export interface EmbedBrowserBody {
	/** `live`: the open browser as it is now, watch-only. `replay`: its recording. */
	readonly mode: "live" | "replay";
	/** How long the link lasts. Default 15. */
	readonly minutes?: number;
}

/** What a sandbox starts with: variables, secret files, repositories and egress grants. A change reaches sandboxes made after it, except a protected variable's value, bindings and the grants, which reach running ones at once. */
export interface Environment {
	/** The environment's ID, such as `env_4kq9x2mt`. */
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly description?: string;
	readonly variables: readonly EnvironmentVariable[];
	readonly files: readonly EnvironmentFile[];
	readonly repos: readonly EnvironmentRepo[];
	readonly grants: readonly EgressGrant[];
	/** How many sandboxes were made from it and still exist. */
	readonly sandboxCount: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** A secret file every new sandbox starts with. Its contents are write-only, and kept encrypted. */
export interface EnvironmentFile {
	/** Absolute, such as `/home/user/.npmrc`. */
	readonly path: string;
	/** Its permissions, such as 384 (0o600). */
	readonly mode: number;
	readonly sizeBytes: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface EnvironmentFileQuery {
	readonly path: string;
}

export interface EnvironmentList {
	readonly items: readonly Environment[];
}

/** A repository every new sandbox starts with, cloned through the egress proxy once it is running. */
export interface EnvironmentRepo {
	/** HTTPS with no credentials in it, such as `https://github.com/lleverage-ai/kantel`. */
	readonly url: string;
	/** Where it is cloned; default `~/<name>`. */
	readonly path?: string;
	/** A branch or tag; default the repository's default branch. */
	readonly ref?: string;
}

export interface EnvironmentVariable {
	readonly name: string;
	/** A protected variable is a `kph_` placeholder in the sandbox, its own per sandbox, which the host's egress proxy swaps for the value on requests to its bindings: the value never enters the sandbox. */
	readonly protected: boolean;
	/** A plain variable's value. Never answered for a protected one. */
	readonly value?: string;
	/** A protected variable's destinations, at least one. Empty for a plain one. */
	readonly bindings: readonly DestinationBinding[];
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** Something that happened in an account: what webhooks deliver and the history shows. */
export interface Event {
	/** The event's ID, such as `evt_8x7w6v`: a webhook's delivery ID, so deduplicate on it. */
	readonly id: string;
	/** `sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call, its auto-stop or its idle stop), or paused. `sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; `sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason says which), which leaves it running. `sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted. */
	readonly type: EventType;
	readonly accountId: string;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	readonly sandboxId?: string;
	readonly snapshotId?: string;
	readonly data: EventData;
}

export interface EventData {
	readonly name?: string;
	/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
	readonly state?: SandboxState;
	/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
	readonly previousState?: SandboxState;
	readonly reason?: string;
	/** Why a sandbox couldn't be placed on a host. `no_host`: no host it may use is connected. `no_host_for_type`: none runs its type. `no_host_with_labels`: none has every label in `hostLabels`. `no_host_offers_size`: none offers its size or can make its resources. `no_host_enforces_egress`: none that could take it enforces egress grants or protected variables. `no_host_for_template`: none that could take it runs templates, or builds the template's custom image. `insufficient_capacity`: hosts match but none has the memory or disk free now; retry later. `host_unavailable`: the host its disk or snapshot is on can't take it now (offline, draining or not one it may use, or gone during the boot). `account_limit`: the account runs as many sandboxes as it may. */
	readonly placementReason?: PlacementReason;
	readonly actor?: CreatedBy;
}

export interface EventPage {
	readonly items: readonly Event[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** `sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call, its auto-stop or its idle stop), or paused. `sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; `sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason says which), which leaves it running. `sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted. */
export type EventType =
	| "sandbox.created"
	| "sandbox.running"
	| "sandbox.stopped"
	| "sandbox.paused"
	| "sandbox.error"
	| "sandbox.degraded"
	| "sandbox.recovered"
	| "sandbox.deleted"
	| "snapshot.saved"
	| "snapshot.deleted";

export interface ExposedPort {
	readonly port: number;
	/** Its HTTPS URL. Unless `public`, the answer to exposing it carries a token anyone holding it may use, shown only then (Kantel keeps its hash); listed, the URL has none. Exposing the port again gives a new token and ends the old. Access through it ends when the key or sign-in that exposed it loses access to the sandbox. */
	readonly url: string;
	readonly public: boolean;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
}

export interface ExposedPortList {
	readonly items: readonly ExposedPort[];
}

export interface ExposePortBody {
	readonly port: number;
	/** Anyone with the URL may open it, with no token. Default false. */
	readonly public?: boolean;
}

export interface ExtractArchiveQuery {
	/** The directory to extract into, made if missing: absolute, or relative to the user's home. Not in or over a mount. */
	readonly path: string;
}

export interface ExtractedArchive {
	/** The absolute directory it was extracted into. */
	readonly path: string;
	/** Files written. */
	readonly files: number;
	/** Directories made. */
	readonly directories: number;
	/** Symbolic links made. */
	readonly symlinks: number;
	/** Bytes of the files written. */
	readonly bytes: number;
}

/** A file of at most 1 MiB, or a part of at most 1 MiB of a larger one, read with `offset` and `length`. */
export interface FileContent {
	readonly path: string;
	readonly encoding: FileEncoding;
	/** The file, or with `offset` or `length`, the part read. */
	readonly content: string;
	/** The whole file's size in bytes. */
	readonly size: number;
	/** With `offset` or `length`: the byte `content` starts at. At `size`, it's empty. */
	readonly offset?: number;
}

export type FileEncoding = "utf8" | "base64";

export interface FileEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly size: number;
	/** Epoch milliseconds, UTC. */
	readonly modifiedAt?: number;
}

export interface FileList {
	readonly path: string;
	readonly items: readonly FileEntry[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface FilePathQuery {
	/** An absolute path, or one relative to the user's home. */
	readonly path: string;
}

/** A short-lived URL for one file of one sandbox, streamed to or from the sandbox's host, so a file of any size moves without base64. */
export interface FileUrl {
	/** The signed URL. Send the request straight to it, with no `Authorization` header. Treat it as a secret until it expires. */
	readonly url: string;
	/** `GET` downloads the file. `PUT` uploads the request's raw body as the file. */
	readonly method: "GET" | "PUT";
	/** The absolute path the URL is bound to. */
	readonly path: string;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

export interface FileUrlBody {
	/** An absolute path, or one relative to the user's home. */
	readonly path: string;
	/** How long the URL may be used: default 900 (15 minutes), at most 3600. */
	readonly ttlSeconds?: number;
}

export interface ForkedSandboxes {
	readonly items: readonly Sandbox[];
}

export interface ForkSandboxBody {
	readonly name?: string;
	/** Fork from this snapshot of the sandbox. Default: its newest, or its live state. */
	readonly snapshotId?: string;
	/** A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: a named size is still taken for now. */
	readonly size?: SandboxSizeName;
	/** How many copies; default 1. */
	readonly count?: number;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly visibility?: SandboxVisibility;
	readonly labels?: {
		readonly [key: string]: string;
	};
	readonly wait?: boolean;
}

export interface GuestAgent {
	readonly version: string;
	/** Kantel put its guest agent into the image at boot (any Linux image), rather than the image shipping it. */
	readonly injected: boolean;
}

/** What a microVM's image has, as its guest agent found it when it last started: its OS, and whether it has a desktop, a browser (and `browserSurface`, the browser alone on a display of its own) and Docker. */
export interface GuestCapabilities {
	/** Epoch milliseconds, UTC. */
	readonly reportedAt: number;
	readonly agent: GuestAgent;
	readonly os: GuestOs;
	/** The machine, as `uname -m` says it: `x86_64` or `aarch64`. */
	readonly arch: string;
	/** The image's C library; `none` for a static userland such as busybox's. */
	readonly libc: "glibc" | "musl" | "none";
	/** The shell a `command` runs in, such as `/bin/bash`; absent: `argv` only. */
	readonly shell?: string;
	/** PID 1: the image's systemd, or Kantel's own init when the image has none. */
	readonly init: "systemd" | "kantel";
	/** One thing a microVM's image has or lacks. */
	readonly desktop: GuestFeature;
	/** One thing a microVM's image has or lacks. */
	readonly browser: GuestFeature;
	/** One thing a microVM's image has or lacks. */
	readonly browserSurface?: GuestFeature;
	readonly docker: GuestDocker;
}

export interface GuestDocker {
	readonly available: boolean;
	/** What the guest agent found, such as `Xtigervnc, Openbox, Selkies`. */
	readonly detail?: string;
	/** Why it isn't available, in words, such as `No desktop in this image`. */
	readonly reason?: string;
	/** `/dev/kvm` opens inside, so containers and VMs in it can nest. */
	readonly kvm: boolean;
}

/** One thing a microVM's image has or lacks. */
export interface GuestFeature {
	readonly available: boolean;
	/** What the guest agent found, such as `Xtigervnc, Openbox, Selkies`. */
	readonly detail?: string;
	/** Why it isn't available, in words, such as `No desktop in this image`. */
	readonly reason?: string;
}

export interface GuestOs {
	/** `/etc/os-release`'s `ID`, such as `debian`, `alpine` or `ubuntu`. */
	readonly id: string;
	/** Its pretty name, such as `Debian GNU/Linux 13 (trixie)`. */
	readonly name: string;
	/** `VERSION_ID`, such as `13` or `3.22.2`. */
	readonly version?: string;
}

/** A machine that runs sandboxes. It dials out to the control plane; it takes no inbound ports. */
export interface Host {
	/** The host's ID, such as `host_6t5r4e`. */
	readonly id: string;
	readonly name: string;
	/** `online`: connected and taking sandboxes. `unreachable`: its connection dropped; its sandboxes can't be reached until it is back. `draining`: connected, but takes no new sandboxes. `revoked`: its credential is revoked. */
	readonly state: HostState;
	/** Its host agent's version. */
	readonly version?: string;
	/** The version hosts should run: the deployment's `KANTEL_HOST_VERSION` when it sets one, otherwise Kantel's latest release. Absent when neither is known. */
	readonly latestVersion?: string;
	/** True when it runs an older version than `latestVersion` (any other, when the deployment sets `KANTEL_HOST_VERSION`), so it can be updated. Absent otherwise. */
	readonly updateAvailable?: boolean;
	/** An update asked for in the last 10 minutes that the host hasn't connected on yet. Absent once it has, or after 10 minutes, when it didn't take. */
	readonly updating?: HostUpdate;
	readonly os?: string;
	readonly arch?: "x86_64" | "aarch64";
	/** The sandbox types it runs. */
	readonly tiers: readonly SandboxType[];
	readonly kvm: boolean;
	readonly nestedVirtualisation: boolean;
	readonly capacity: HostCapacity;
	readonly allocated: HostAllocated;
	readonly labels: {
		readonly [key: string]: string;
	};
	/** The account the host belongs to, when it was added to one by its people: only that account's sandboxes run on it. Absent for a host the deployment's super-admin joined, which any account's sandboxes may use. */
	readonly accountId?: string;
	/** Epoch milliseconds, UTC. */
	readonly joinedAt: number;
	/** Epoch milliseconds, UTC. */
	readonly lastSeenAt?: number;
	/** A host's recent CPU and memory, for sparklines. */
	readonly usage?: UsageSparklines;
}

export interface HostAllocated {
	readonly sandboxes: number;
	readonly vcpus: number;
	readonly memoryMb: number;
	readonly diskGb: number;
}

export interface HostCapacity {
	readonly vcpus: number;
	readonly memoryMb: number;
	readonly diskGb: number;
}

export interface HostJoinToken {
	/** The token's ID. */
	readonly id: string;
	/** `kth_…`, shown once. It joins one host. */
	readonly token: string;
	/** The one-line command that installs and registers a host with it. */
	readonly command: string;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

export interface HostList {
	readonly items: readonly Host[];
}

/** `online`: connected and taking sandboxes. `unreachable`: its connection dropped; its sandboxes can't be reached until it is back. `draining`: connected, but takes no new sandboxes. `revoked`: its credential is revoked. */
export type HostState = "online" | "unreachable" | "draining" | "revoked";

/** An update asked for in the last 10 minutes that the host hasn't connected on yet. Absent once it has, or after 10 minutes, when it didn't take. */
export interface HostUpdate {
	/** The version it's moving to. */
	readonly version: string;
	/** Epoch milliseconds, UTC. */
	readonly requestedAt: number;
}

/** A host's readings as they came, for a live graph: poll with `since` set to the last point's `at` for only the newer ones. */
export interface HostUsage {
	readonly hostId: string;
	/** How far apart the points are: 5000 from a current host. */
	readonly intervalMs: number;
	/** 0 until the host has sent a reading. */
	readonly memTotalBytes: number;
	/** 0 until the host has sent a reading. */
	readonly diskTotalBytes: number;
	/** Oldest first, at most the last hour; with `since`, only those after it. Empty for a host that doesn't send its readings yet (an older kantel-host). */
	readonly points: readonly HostUsagePoint[];
}

export interface HostUsagePoint {
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	/** CPU utilisation over the interval ending at `at`, 0 to 1 of all the host's CPUs. */
	readonly cpu: number;
	readonly memUsedBytes: number;
	readonly diskUsedBytes: number;
}

export interface HostUsageQuery {
	/** Only the points after this time (epoch milliseconds). */
	readonly since?: number;
}

/** A way into an organisation: whoever joins with its code becomes a member. */
export interface Invite {
	/** The invite's ID. */
	readonly id: string;
	readonly accountId: string;
	/** `member`: uses the organisation's shared sandboxes and snapshots and makes their own. `admin`: also manages members, API keys, webhooks, telemetry and the proxy. `owner`: also renames or deletes the organisation. A personal account's person is its `owner`. */
	readonly role: MemberRole;
	readonly email?: string;
	/** The join code, such as `kji_…`. Shown once, when the invite is made. */
	readonly code?: string;
	/** Only when the invite is made: whether Kantel emailed it, with a link that joins with its code. False without an email, where the deployment sends no mail, or when the send failed. */
	readonly emailed?: boolean;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
}

export interface InviteList {
	readonly items: readonly Invite[];
}

export interface IsolateShapes {
	readonly memoryMb: ShapeRange;
	/** Whether an isolate's memory is a hard limit. False today: the runtime records it, and the account VM's memory, shared by its isolates, is the limit. */
	readonly enforced: boolean;
}

export interface IssuedApiKey {
	/** A scoped API key. Its secret is never stored or shown after it is made. */
	readonly key: ApiKey;
	/** The key itself, `ksk_…`. Shown once: store it now. */
	readonly secret: string;
}

export interface JoinOrganisationBody {
	/** An invite's join code. */
	readonly code: string;
}

export interface ListEventsQuery {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	readonly sandboxId?: string;
	/** `sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call, its auto-stop or its idle stop), or paused. `sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; `sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason says which), which leaves it running. `sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted. */
	readonly type?: EventType;
	readonly since?: number;
	/** At most this many; default 50. */
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListFilesQuery {
	/** Default: the user's home. */
	readonly path?: string;
	/** At most this many; default 50. */
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSandboxesQuery {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
	readonly state?: SandboxState;
	/** Include stopped, paused and errored sandboxes. Default: only active ones. */
	readonly all?: boolean;
	/** Only those with each label: `label.ticket=PROJ-12`. */
	readonly label?: {
		readonly [key: string]: string;
	};
	/** Only those on this host, a host's ID or name: one of the account's own hosts, or for a super-admin any host. */
	readonly host?: string;
	/** At most this many; default 50. */
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSnapshotsQuery {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** `automatic`: one of a sandbox's own history, taken as it runs and at each stop; the newest is what a resume or fork uses, and older ones expire. `saved`: kept under a name until deleted, and usable as a template for new sandboxes, even after its sandbox is deleted. */
	readonly kind?: SnapshotKind;
	readonly sandboxId?: string;
	/** At most this many; default 50. */
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListTemplatesQuery {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** Only those with a snapshot built from this base digest, or pinned to it. */
	readonly baseDigest?: string;
}

/** One frame of the account's live stream. */
export type LiveFrame = LiveHello | LiveSandboxChange;

/** The stream is open. Read what you show again after each one: changes made while no stream was open (before the first, between a drop and the reconnection) are not sent. */
export interface LiveHello {
	readonly type: "hello";
	/** Epoch milliseconds, UTC. */
	readonly at: number;
}

/** A sandbox moved to `state`, whoever moved it (a call from the console, the CLI, the API or an SDK, its auto-stop, its host). No `previousState`: it was just made. Read the sandbox for the rest. */
export interface LiveSandboxChange {
	readonly type: "sandbox";
	readonly sandboxId: string;
	readonly accountId: string;
	/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
	readonly state: SandboxState;
	/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
	readonly previousState?: SandboxState;
	/** Epoch milliseconds, UTC. */
	readonly at: number;
}

export interface Member {
	readonly userId: string;
	readonly name: string;
	readonly email?: string;
	/** `member`: uses the organisation's shared sandboxes and snapshots and makes their own. `admin`: also manages members, API keys, webhooks, telemetry and the proxy. `owner`: also renames or deletes the organisation. A personal account's person is its `owner`. */
	readonly role: MemberRole;
	/** Epoch milliseconds, UTC. */
	readonly joinedAt: number;
}

export interface MemberList {
	readonly items: readonly Member[];
}

/** `member`: uses the organisation's shared sandboxes and snapshots and makes their own. `admin`: also manages members, API keys, webhooks, telemetry and the proxy. `owner`: also renames or deletes the organisation. A personal account's person is its `owner`. */
export type MemberRole = "member" | "admin" | "owner";

/** Absent when no host the account may use runs microVMs. */
export interface MicrovmShapes {
	readonly vcpus: ShapeRange;
	readonly memoryMb: ShapeRange;
	/** Memory follows vCPUs: each vCPU has at least `min` and at most `max` MB. */
	readonly memoryMbPerVcpu: {
		readonly min: number;
		readonly max: number;
	};
	/** Each shape a host makes by name. Hosts may give one name different shapes: each is its own entry. */
	readonly presets: readonly ShapePreset[];
	/** Whether a host takes shapes off the presets; when false, only the presets. A shape's disk is its host's to give; the sandbox's `resources` say what it got. */
	readonly custom: boolean;
}

/** Files from outside the sandbox, read-only inside it: nothing in the sandbox can change them. */
export interface Mount {
	/** Where it appears in the sandbox: absolute and normalised, not `/`, not at or under a system directory (`/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/lib` and the like), and not overlapping another mount. */
	readonly path: string;
	readonly source: MountSource;
}

export type MountSource = BundleMountSource | BucketMountSource;

/** `pending`: its host is still putting it in place. `ready`: its files are there. `failed`: they aren't, and `error` says why; the sandbox runs without it. */
export type MountStatus = "pending" | "ready" | "failed";

/** Why a sandbox couldn't be placed on a host. `no_host`: no host it may use is connected. `no_host_for_type`: none runs its type. `no_host_with_labels`: none has every label in `hostLabels`. `no_host_offers_size`: none offers its size or can make its resources. `no_host_enforces_egress`: none that could take it enforces egress grants or protected variables. `no_host_for_template`: none that could take it runs templates, or builds the template's custom image. `insufficient_capacity`: hosts match but none has the memory or disk free now; retry later. `host_unavailable`: the host its disk or snapshot is on can't take it now (offline, draining or not one it may use, or gone during the boot). `account_limit`: the account runs as many sandboxes as it may. */
export type PlacementReason =
	| "no_host"
	| "no_host_for_type"
	| "no_host_with_labels"
	| "no_host_offers_size"
	| "no_host_enforces_egress"
	| "no_host_for_template"
	| "insufficient_capacity"
	| "host_unavailable"
	| "account_limit";

export interface PollDeviceLoginBody {
	readonly deviceCode: string;
}

export interface Project {
	/** The project's ID. */
	readonly id: string;
	/** The organisation the project is in: always the caller's. */
	readonly organisationId: string;
	readonly name: string;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
}

/** Where sandboxes' outbound traffic may go, and through what, for one account. Experimental. */
export interface ProxySettings {
	readonly accountId: string;
	/** Send sandboxes' outbound traffic through the proxy. */
	readonly enabled: boolean;
	/** What happens to a host no rule names. */
	readonly defaultAction: "allow" | "deny";
	/** Hosts always let through: `api.github.com`, `*.npmjs.org`. */
	readonly allow: readonly string[];
	/** Hosts always refused; deny wins over allow. */
	readonly deny: readonly string[];
	readonly upstream?: ProxyUpstream;
	/** Tell the upstream which sandbox and account each request came from, in signed `Kantel-Sandbox` and `Kantel-Account` headers. */
	readonly attribution: boolean;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** The settings as you last read them: `GET /proxy`'s answer will do. Given, the write is refused with `conflict` if they have changed since, so an edit made from an older read can't undo someone else's: read them again and redo the edit. Left out, the settings are replaced whatever they hold. */
export interface ProxySettingsExpected {
	readonly enabled: boolean;
	readonly defaultAction: "allow" | "deny";
	readonly allow: readonly string[];
	readonly deny: readonly string[];
	readonly upstream?: {
		readonly url: string;
		readonly headerNames: readonly string[];
	};
	readonly attribution: boolean;
}

export interface ProxyUpstream {
	/** Another proxy every allowed request goes on to, such as a Mehen. */
	readonly url: string;
	/** The names of the headers Kantel sends it; their values are never shown. */
	readonly headerNames: readonly string[];
}

export interface PublicUrl {
	/** Where hosts reach this control plane: the address in every join command, such as `https://kantel.example.com`. */
	readonly publicUrl: string;
	/** `console`: a super-admin set it here. `deployment`: the deployment's own (`KANTEL_PUBLIC_URL`, or the address the call came in at). */
	readonly source: "console" | "deployment";
	/** The deployment's own, which `publicUrl` goes back to when cleared. */
	readonly deploymentUrl: string;
	/** `publicUrl` is a loopback address (`127.0.0.1`, `localhost`): only a host on the same machine can join. */
	readonly loopback: boolean;
}

export interface PublishTemplateBaseBody {
	/** The base image, such as `kantel/sandbox`. */
	readonly image: string;
	/** A channel, such as `stable`. */
	readonly channel: string;
	/** The digest the channel publishes from now. */
	readonly digest: string;
}

export interface PutEgressGrantsBody {
	readonly grants: readonly EgressGrantInput[];
	/** The list as you last read it. Given, the write is refused with `conflict` if the list has changed since, so an edit made from an older read can't undo someone else's: read it again and redo the edit. Left out, the list is replaced whatever it holds. */
	readonly expected?: readonly EgressGrantInput[];
}

export interface PutEnvironmentReposBody {
	readonly repos: readonly EnvironmentRepo[];
	/** The list as you last read it. Given, the write is refused with `conflict` if the list has changed since, so an edit made from an older read can't undo someone else's: read it again and redo the edit. Left out, the list is replaced whatever it holds. */
	readonly expected?: readonly EnvironmentRepo[];
}

export interface PutProxySettingsBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	readonly enabled: boolean;
	readonly defaultAction?: "allow" | "deny";
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
	readonly upstream?: {
		readonly url: string;
		/** Kept encrypted, never shown again. */
		readonly headers?: {
			readonly [key: string]: string;
		};
	} | null;
	readonly attribution?: boolean;
	/** The settings as you last read them: `GET /proxy`'s answer will do. Given, the write is refused with `conflict` if they have changed since, so an edit made from an older read can't undo someone else's: read them again and redo the edit. Left out, the settings are replaced whatever they hold. */
	readonly expected?: ProxySettingsExpected;
}

export interface PutTelemetryBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	readonly endpoint: string;
	readonly headers?: {
		readonly [key: string]: string;
	};
	readonly signals?: readonly ("metrics" | "logs")[];
}

export interface ReadFileQuery {
	readonly path: string;
	readonly encoding?: FileEncoding;
	/** Read from this byte (default 0). With `offset` or `length`, a file of any size is read a part at a time. */
	readonly offset?: number;
	/** Read at most this many bytes: default, and at most, 1 MiB (1048576). */
	readonly length?: number;
}

export interface ReadSnapshotFileQuery {
	readonly path: string;
	readonly encoding?: FileEncoding;
}

export interface ResumeSandboxBody {
	/** A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: a named size is still taken for now. */
	readonly size?: SandboxSizeName;
	/** Answer once it is `running` (or `error`). */
	readonly wait?: boolean;
}

export interface RunCommandBody {
	/** A shell command line, run with `bash -lc` (or the isolate's shell). */
	readonly command: string;
	/** Default: the sandbox user's home. */
	readonly cwd?: string;
	readonly env?: {
		readonly [key: string]: string;
	};
	readonly stdin?: string;
	/** Default 30 000; at most 600 000 (10 minutes). A detached command has no limit unless this gives one. */
	readonly timeoutMs?: number;
	/** Start it and answer at once; it runs with no time limit unless `timeoutMs` gives one. Read it back by its ID. */
	readonly detached?: boolean;
}

export interface Sandbox {
	/** The sandbox's ID, such as `sbx_4kq9x2mt`. */
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	/** Its name under the deployment's sandbox domain, which its public port URLs start with. */
	readonly subdomain: string;
	/** `isolate`: a workerd isolate with a JavaScript shell over the sandbox's files. Starts in milliseconds and costs almost nothing, but runs no native binaries, has no desktop and no SSH. `microvm`: a Firecracker microVM with a full Linux, root, Docker and `/dev/kvm` inside, a desktop, a browser and SSH. */
	readonly type: SandboxType;
	/** A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: a named size is still taken for now. */
	readonly size?: SandboxSizeName;
	/** The vCPUs and memory a sandbox asked for: the shape it was made with (a fork, its source's), and once its host places it, what it runs as. Known from the moment it's made, before its host says what it got (`resources`, with its disk). Absent: made by a named size and not yet placed, or made before shapes. */
	readonly shape?: SandboxShape;
	readonly resources?: SandboxResources;
	/** The base image a microVM was made from, such as `ubuntu-24.04`. */
	readonly image?: string;
	/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
	readonly state: SandboxState;
	/** `degraded`: the machine is up but its host can't fully reach it; it keeps running. */
	readonly health?: SandboxHealth;
	/** Why it is in `error` or `degraded`, in words; or why Kantel stopped or paused it: `auto-stop` when its auto-stop time came, `idle-stop` when it went `idleStopMinutes` without use, or a rule's reason. A stop someone asked for has none. */
	readonly reason?: string;
	/** Why a sandbox couldn't be placed on a host. `no_host`: no host it may use is connected. `no_host_for_type`: none runs its type. `no_host_with_labels`: none has every label in `hostLabels`. `no_host_offers_size`: none offers its size or can make its resources. `no_host_enforces_egress`: none that could take it enforces egress grants or protected variables. `no_host_for_template`: none that could take it runs templates, or builds the template's custom image. `insufficient_capacity`: hosts match but none has the memory or disk free now; retry later. `host_unavailable`: the host its disk or snapshot is on can't take it now (offline, draining or not one it may use, or gone during the boot). `account_limit`: the account runs as many sandboxes as it may. */
	readonly placementReason?: PlacementReason;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly visibility: SandboxVisibility;
	/** What this sandbox can do, from its type and its host, and for a microVM from what its guest agent found in its image (`guest`): `desktop`, `browser`, `docker` and `kvm` are false where the image lacks them. */
	readonly capabilities: SandboxCapabilities;
	/** The caller's own labels. */
	readonly labels: {
		readonly [key: string]: string;
	};
	/** How long after a start or resume it stops by itself; `null` never. */
	readonly autoStopMinutes: number | null;
	/** When it will stop by itself, while running; the console's stops-in. */
	readonly stopsAt?: number;
	/** How long it may go without use before it stops by itself (`idle-stop`), beside its auto-stop; `null` or absent never. Use is a command (run, followed or killed), and traffic over SSH, the desktop or browser, and its hosted ports. Stopping keeps its disk, as any stop does. */
	readonly idleStopMinutes?: number | null;
	/** When it was last used, while running with an idle stop: its start, or its latest use, to within about 20 seconds. */
	readonly lastActiveAt?: number;
	/** When its idle stop will stop it if it isn't used before then, while running with one: `lastActiveAt` plus `idleStopMinutes`. It stops within about 30 seconds after, once every gateway's record of use is in. */
	readonly idleStopsAt?: number;
	/** The snapshot a resume or fork would use. */
	readonly latestSnapshotId?: string;
	/** When `latestSnapshotId` was taken (its `createdAt`), in milliseconds. Absent from a gateway before it, and where that snapshot's record is gone. */
	readonly latestSnapshotAt?: number;
	/** What it was made from. */
	readonly source?: SandboxSource;
	/** The environment it was made from. */
	readonly environmentId?: string;
	/** The template a sandbox was made from. */
	readonly template?: SandboxTemplate;
	/** Its own egress grants, on top of its environment's. */
	readonly grants: readonly EgressGrant[];
	/** Its read-only mounts, as its create named them, each with its status. Absent: none. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). */
	readonly mounts?: readonly SandboxMount[];
	readonly createdBy: CreatedBy;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly startedAt?: number;
	/** Epoch milliseconds, UTC. */
	readonly stoppedAt?: number;
	/** What a sandbox costs at the deployment's rates. A self-hosted install's rates are 0 unless its operator sets them. */
	readonly cost: Cost;
	readonly usage: UsageSummary;
	/** The host it runs on (or last ran on): shown to a super-admin, and to anyone who can see the sandbox when it is one of its account's own hosts. Absent until it is placed, and for a shared host to anyone else. */
	readonly hostId?: string;
	/** That host's name, with `hostId`. */
	readonly hostName?: string;
	/** The base image a sandbox's (or a snapshot's) root file system is, and how far behind it is. A running sandbox is never patched underneath: an outdated one stays on its base until it is restarted on the latest (`restartSandboxOnLatest`) or made again. Experimental: present only where the deployment has image patching on (`KANTEL_IMAGE_PATCHING`) and knows the version. */
	readonly base?: SandboxBase;
}

/** The base image a sandbox's (or a snapshot's) root file system is, and how far behind it is. A running sandbox is never patched underneath: an outdated one stays on its base until it is restarted on the latest (`restartSandboxOnLatest`) or made again. Experimental: present only where the deployment has image patching on (`KANTEL_IMAGE_PATCHING`) and knows the version. */
export interface SandboxBase {
	/** The base image it is on, by its name in Kantel's base image index: `host` for a microVM (the host images: kernel and root file system), `sandbox` for the container tier. */
	readonly image: string;
	/** The version of the base it is on, such as `host-images-20261104.812`. */
	readonly version?: string;
	/** Its base isn't the version its channel (`stable`) names now. */
	readonly outdated: boolean;
	/** The version its channel names now. */
	readonly latest?: SandboxBaseLatest;
	/** How far behind its channel it is, while outdated. */
	readonly behind?: SandboxBaseBehind;
	/** A newer version fixes Critical or High vulnerabilities this one has: restart it on the latest. */
	readonly security?: boolean;
}

/** How far behind its channel it is, while outdated. */
export interface SandboxBaseBehind {
	/** Whole days since the version after its own was built: how long it has been superseded. */
	readonly days: number;
	/** How many versions are newer. */
	readonly versions: number;
}

/** The version its channel names now. */
export interface SandboxBaseLatest {
	readonly version: string;
	/** When it was built, ISO 8601. */
	readonly builtAt: string;
}

/** What this sandbox can do, from its type and its host, and for a microVM from what its guest agent found in its image (`guest`): `desktop`, `browser`, `docker` and `kvm` are false where the image lacks them. */
export interface SandboxCapabilities {
	readonly exec: boolean;
	readonly files: boolean;
	readonly ssh: boolean;
	readonly desktop: boolean;
	readonly browser: boolean;
	/** Experimental. Whether `openBrowser`'s `url` shows the browser alone rather than the desktop it runs on: the image has a display and a stream for its browser. Absent: false. */
	readonly browserSurface?: boolean;
	readonly ports: boolean;
	readonly docker: boolean;
	/** `/dev/kvm` inside, for nested virtualisation. */
	readonly kvm: boolean;
	/** Whether it can be paused with its memory kept. */
	readonly pause: boolean;
	/** What a microVM's image has, as its guest agent found it when it last started: its OS, and whether it has a desktop, a browser (and `browserSurface`, the browser alone on a display of its own) and Docker. */
	readonly guest?: GuestCapabilities;
}

/** A sandbox's egress: what it was made with, its own grants and its log. */
export interface SandboxEgress {
	readonly sandboxId: string;
	readonly sandboxName: string;
	readonly accountId: string;
	readonly environment?: SandboxEgressEnvironment;
	readonly protectedVariables: readonly SandboxProtectedVariable[];
	/** Its environment's grants, which it has too. */
	readonly environmentGrants: readonly EgressGrant[];
	/** Its own grants, on top of its environment's. */
	readonly grants: readonly EgressGrant[];
	/** Newest first; Kantel keeps the newest 1000. */
	readonly entries: readonly EgressEntry[];
}

export interface SandboxEgressEnvironment {
	readonly id: string;
	readonly name: string;
}

export interface SandboxEgressQuery {
	/** At most this many entries; default 100. */
	readonly limit?: number;
}

/** `degraded`: the machine is up but its host can't fully reach it; it keeps running. */
export type SandboxHealth = "ok" | "degraded";

/** A mount of a sandbox's, and whether its files are in place. */
export interface SandboxMount {
	readonly path: string;
	readonly source: MountSource;
	/** `pending`: its host is still putting it in place. `ready`: its files are there. `failed`: they aren't, and `error` says why; the sandbox runs without it. */
	readonly status: MountStatus;
	/** Why it is `failed`, in words. */
	readonly error?: string;
}

/** The `details` of the `conflict` (409) a call that needs a running sandbox (commands, files, ports, file URLs, archives) answers when the sandbox isn't running. A call made while it is starting waits for it, up to 60 seconds, before it answers `sandbox_starting`. Kantel never resumes a stopped sandbox for such a call. */
export interface SandboxNotRunning {
	/** Why a call that needs a running sandbox was refused. `sandbox_starting`: it was still starting when the call's wait for it ran out; send the call again. `sandbox_stopping`, `sandbox_stopped`, `sandbox_paused`, `sandbox_error`: resume it (`POST /sandboxes/{sandboxId}/resume`), then send the call again. `sandbox_deleting`: it is being deleted. */
	readonly code: SandboxNotRunningCode;
	readonly sandboxId: string;
	/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
	readonly state: SandboxState;
	/** Why it stopped, paused or failed, where Kantel recorded it (the sandbox's `reason`): `auto-stop` when its auto-stop time came, `idle-stop` when it went `idleStopMinutes` without use, a rule's reason when Kantel stopped it, or what failed. A stop someone asked for has none. Not `details.reason`, which is a placement's. */
	readonly stopReason?: string;
	/** What to do, in words, such as `Resume it with kantel resume sbx_4kq9x2mt or POST /v1/sandboxes/sbx_4kq9x2mt/resume, then try again`. */
	readonly hint: string;
}

/** Why a call that needs a running sandbox was refused. `sandbox_starting`: it was still starting when the call's wait for it ran out; send the call again. `sandbox_stopping`, `sandbox_stopped`, `sandbox_paused`, `sandbox_error`: resume it (`POST /sandboxes/{sandboxId}/resume`), then send the call again. `sandbox_deleting`: it is being deleted. */
export type SandboxNotRunningCode =
	| "sandbox_starting"
	| "sandbox_stopping"
	| "sandbox_stopped"
	| "sandbox_paused"
	| "sandbox_error"
	| "sandbox_deleting";

export interface SandboxPage {
	readonly items: readonly Sandbox[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** A protected variable as one sandbox has it: never its value. */
export interface SandboxProtectedVariable {
	readonly name: string;
	/** The first 8 characters of its placeholder, such as `kph_7Qx2`. */
	readonly placeholderPrefix: string;
	readonly bindings: readonly DestinationBinding[];
}

export interface SandboxResources {
	readonly vcpus: number;
	readonly memoryMb: number;
	readonly diskGb: number;
}

export interface SandboxSeriesPoint {
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	/** CPU utilisation over the interval ending at `at`, 0 to 1 of the sandbox's own vCPUs. */
	readonly cpu: number;
	/** Memory in use at `at`. For a microVM, what its guest counts as used (total less available, page cache not counted), so it falls when the guest frees memory; from a host or VM that can't report that, the memory the VM holds on its host, which stays near its high point. For an isolate, its share of its account's runtime. */
	readonly memUsedBytes: number;
	/** A microVM's own disk in use at `at`, as its guest counts it (df's used). Absent for an isolate, and where the host or the guest's agent doesn't send it. */
	readonly diskUsedBytes?: number;
	/** The share of the interval ending at `at` in which at least one of a microVM's tasks waited on IO (its guest kernel's IO pressure, `some`). Absent where the guest has no pressure figures. */
	readonly ioPressure?: number;
}

/** The vCPUs and memory a sandbox asked for: the shape it was made with (a fork, its source's), and once its host places it, what it runs as. Known from the moment it's made, before its host says what it got (`resources`, with its disk). Absent: made by a named size and not yet placed, or made before shapes. */
export interface SandboxShape {
	/** vCPUs: 0 for an isolate, which shares its account's VM's CPU. */
	readonly vcpus: number;
	readonly memoryMb: number;
}

/** What a new sandbox gets. A microVM restores a template snapshot on its host: by default the one its host keeps for its vCPU count, whatever its memory, so a shape off the presets is as fast as a preset once that count's template is made. A host with shared templates turned off keeps one per preset, and a shape off the presets boots from scratch. */
export interface SandboxShapeInput {
	/** A microVM's vCPUs. An isolate has none of its own: it shares its account's VM's CPU. */
	readonly vcpus?: number;
	/** Memory in MB. An isolate takes 128 to 512 in steps of 64; a microVM up to what a host offers (`getSandboxShapes`). */
	readonly memoryMb: number;
}

/** What a new sandbox in the account may be: the ranges its hosts offer, their presets and the rates. */
export interface SandboxShapes {
	readonly isolate: IsolateShapes;
	/** Absent when no host the account may use runs microVMs. */
	readonly microvm?: MicrovmShapes;
	/** What an hour costs, per vCPU and GB; absent where it is free. */
	readonly rates?: ShapeRates;
}

export interface SandboxShapesQuery {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** The shapes a sandbox pinned to this host (`CreateSandboxBody.host`, its ID or name) may be, from that host alone. Default: from every host the account's sandboxes may use. */
	readonly host?: string;
}

/** A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: a named size is still taken for now. */
export type SandboxSizeName = "small" | "default" | "large" | "xlarge";

/** What it was made from. */
export interface SandboxSource {
	readonly snapshotId?: string;
	/** Set when it was forked from another sandbox. */
	readonly sandboxId?: string;
}

/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
export type SandboxState =
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "paused"
	| "error"
	| "deleting"
	| "deleted";

/** The template a sandbox was made from. */
export interface SandboxTemplate {
	/** The template's ID, `tpl_…`. */
	readonly id: string;
	readonly name: string;
	/** The template's version it was made from. */
	readonly version: number;
	/** The template snapshot it started from, `tsn_…`; absent for a fresh boot. */
	readonly snapshotId?: string;
	/** `snapshot`: it started from the template's built snapshot. `boot`: none was ready, so it booted the template's image and ran its setup itself (a custom image: the one its build made). */
	readonly start: "snapshot" | "boot";
}

/** `isolate`: a workerd isolate with a JavaScript shell over the sandbox's files. Starts in milliseconds and costs almost nothing, but runs no native binaries, has no desktop and no SSH. `microvm`: a Firecracker microVM with a full Linux, root, Docker and `/dev/kvm` inside, a desktop, a browser and SSH. */
export type SandboxType = "isolate" | "microvm";

export interface SandboxUsage {
	readonly sandboxId: string;
	readonly intervalSeconds: number;
	readonly points: readonly SandboxUsagePoint[];
	readonly totals: {
		readonly runningSeconds: number;
		readonly cpuSeconds: number;
		/** What a sandbox costs at the deployment's rates. A self-hosted install's rates are 0 unless its operator sets them. */
		readonly cost: Cost;
	};
	/** The memory it may use, when its host reports it or its size sets it. */
	readonly memLimitBytes?: number;
	/** Its own disk's size, as its guest counts it, when its host sends disk figures. */
	readonly diskTotalBytes?: number;
	/** The sandbox's readings as they came, for a live graph: poll with `since` set to the last point's `at` for only the newer ones. */
	readonly series: SandboxUsageSeries;
}

/** One interval's means. A sandbox keeps a day of 5-minute means and hourly ones for the six days before, so an interval within the day can be as fine as 5 minutes, and one before it is an hour's mean at best. */
export interface SandboxUsagePoint {
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	/** CPU utilisation over the interval. */
	readonly cpu: number;
	readonly memoryMb: number;
	readonly runningSeconds: number;
	readonly cost: number;
	/** Whether any kept reading covers the interval: false where there is none (stopped, or older than the week kept), and `cpu` and `memoryMb` are then 0 for want of a figure, not measured as 0. Absent from a gateway before it. */
	readonly measured?: boolean;
	/** The sandbox's own disk in use, its mean over the interval; absent where its host doesn't send it. */
	readonly diskUsedBytes?: number;
	/** The share of the interval in which at least one of its tasks waited on IO, its mean; absent where its guest has no pressure figures. */
	readonly ioPressure?: number;
}

/** The sandbox's readings as they came, for a live graph: poll with `since` set to the last point's `at` for only the newer ones. */
export interface SandboxUsageSeries {
	/** How far apart the points are: 5000 from a host that sends its readings, longer from one that doesn't yet. */
	readonly intervalMs: number;
	/** Oldest first, at most the last hour; with `since`, only those after it. */
	readonly points: readonly SandboxSeriesPoint[];
}

/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
export type SandboxVisibility = "private" | "organisation";

export interface SaveSnapshotBody {
	readonly name: string;
	/** The sandbox to save, running or stopped. */
	readonly sandboxId: string;
	/** Save this snapshot of the sandbox's history. Default: its state now. */
	readonly snapshotId?: string;
	readonly description?: string;
	/** Replace a saved snapshot of the same name. */
	readonly replace?: boolean;
}

export type ScanSeverity = "critical" | "high" | "medium" | "low" | "unknown";

/** `encoding` says how `content` is written: `utf8` (the default) or `base64`. */
export interface SetEnvironmentFileBody {
	/** Absolute, or relative to `/home/user`. */
	readonly path: string;
	/** Default 384 (0o600). */
	readonly mode?: number;
	/** At most 1 MiB, in `encoding`. Required for a new file; left out, the file keeps its contents. */
	readonly content?: string;
	readonly encoding?: FileEncoding;
}

export interface SetEnvironmentVariableBody {
	/** Default false. */
	readonly protected?: boolean;
	/** Required for a new variable and when it becomes protected or plain. Left out on a protected one, it keeps its value (to change its bindings); a new value for a protected one is a rotation. */
	readonly value?: string;
	/** A protected variable's destinations, at least one. Left out, a protected one keeps its own. */
	readonly bindings?: readonly DestinationBinding[];
}

export interface SetPublicUrlBody {
	/** An http(s) origin, such as `https://kantel.example.com`; `null` goes back to the deployment's own. */
	readonly publicUrl: string | null;
}

export interface ShapePreset {
	/** A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: a named size is still taken for now. */
	readonly name: SandboxSizeName;
	readonly vcpus: number;
	readonly memoryMb: number;
	/** The disk the host gives a fresh sandbox of this size. One made from a snapshot keeps that snapshot's disk. */
	readonly diskGb: number;
}

export interface ShapeRange {
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly default: number;
}

/** What an hour costs, per vCPU and GB; absent where it is free. */
export interface ShapeRates {
	readonly currency: string;
	readonly microvmPerVcpuHour: number;
	readonly microvmPerGbHour: number;
	readonly isolatePerGbHour: number;
}

export interface Snapshot {
	/** The snapshot's ID, such as `snap_2h8d6f`. */
	readonly id: string;
	readonly accountId: string;
	/** `automatic`: one of a sandbox's own history, taken as it runs and at each stop; the newest is what a resume or fork uses, and older ones expire. `saved`: kept under a name until deleted, and usable as a template for new sandboxes, even after its sandbox is deleted. */
	readonly kind: SnapshotKind;
	/** A saved snapshot's name, unique in its account. */
	readonly name?: string;
	readonly description?: string;
	/** The sandbox it was taken of; absent once that is deleted. */
	readonly sandboxId?: string;
	/** `isolate`: a workerd isolate with a JavaScript shell over the sandbox's files. Starts in milliseconds and costs almost nothing, but runs no native binaries, has no desktop and no SSH. `microvm`: a Firecracker microVM with a full Linux, root, Docker and `/dev/kvm` inside, a desktop, a browser and SSH. */
	readonly sandboxType: SandboxType;
	readonly state: SnapshotState;
	/** What took it. */
	readonly trigger?: "periodic" | "stop" | "manual" | "save";
	/** Whether it holds the sandbox's memory as well as its disk (a pause). */
	readonly memory: boolean;
	/** A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: a named size is still taken for now. */
	readonly size?: SandboxSizeName;
	readonly resources?: SandboxResources;
	readonly sizeBytes?: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
	/** The base image a sandbox's (or a snapshot's) root file system is, and how far behind it is. A running sandbox is never patched underneath: an outdated one stays on its base until it is restarted on the latest (`restartSandboxOnLatest`) or made again. Experimental: present only where the deployment has image patching on (`KANTEL_IMAGE_PATCHING`) and knows the version. */
	readonly base?: SandboxBase;
}

export interface SnapshotFilesQuery {
	/** A directory; default the user's home. */
	readonly path?: string;
	/** At most this many; default 50. */
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

/** `automatic`: one of a sandbox's own history, taken as it runs and at each stop; the newest is what a resume or fork uses, and older ones expire. `saved`: kept under a name until deleted, and usable as a template for new sandboxes, even after its sandbox is deleted. */
export type SnapshotKind = "automatic" | "saved";

export interface SnapshotPage {
	readonly items: readonly Snapshot[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export type SnapshotState = "creating" | "ready" | "failed" | "deleting";

export interface SshAccess {
	/** The SSH gateway's host name. */
	readonly host: string;
	readonly port: number;
	/** Names the sandbox to the gateway. */
	readonly user: string;
	/** A command line that connects, such as `ssh -p 2222 sbx_4kq9x2mt@ssh.example`. */
	readonly command: string;
	/** When there is no SSH gateway to dial: a WebSocket URL carrying the sandbox's SSH as binary frames, for an `ssh -o ProxyCommand=…` (`kantel ssh-proxy` is one). Anyone holding it can start a connection until `expiresAt`. */
	readonly proxyUrl?: string;
	/** When Kantel made the key pair: its private key, shown once. */
	readonly privateKey?: string;
	readonly hostKeyFingerprint?: string;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt: number;
}

export interface SshAccessBody {
	/** An OpenSSH public key to let in. Absent: Kantel makes a key pair for this access. */
	readonly publicKey?: string;
	/** How long a connection can be started with this access; one started in time stays open. Default 10. */
	readonly ttlMinutes?: number;
}

export interface StartDeviceLoginBody {
	/** What is signing in, shown to the person who approves it and given to its key: `kantel on build-01`. */
	readonly clientName?: string;
}

export interface StopSandboxBody {
	/** Pause instead: keep its memory as well as its disk (`paused`). microVMs only. Default false. */
	readonly keepMemory?: boolean;
	/** Answer once it is `stopped` or `paused`. */
	readonly wait?: boolean;
}

export interface TakeSnapshotBody {
	readonly description?: string;
}

/** Where an account's telemetry goes: sandbox metrics (`kantel.sandbox.cpu`, `kantel.sandbox.memory_bytes` and `kantel.sandbox.running_seconds`) every 60 seconds, and each lifecycle event as an OTLP log record when it happens. */
export interface TelemetryExport {
	readonly accountId: string;
	/** An OTLP/HTTP collector's base URL; `/v1/metrics` and `/v1/logs` are added. */
	readonly endpoint: string;
	/** The headers sent with each export; values never shown. */
	readonly headerNames: readonly string[];
	readonly signals: readonly ("metrics" | "logs")[];
	readonly lastExport?: TelemetryLastExport;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface TelemetryLastExport {
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly ok: boolean;
	readonly status?: number;
	readonly error?: string;
}

export interface TelemetryTest {
	/** Where an account's telemetry goes: sandbox metrics (`kantel.sandbox.cpu`, `kantel.sandbox.memory_bytes` and `kantel.sandbox.running_seconds`) every 60 seconds, and each lifecycle event as an OTLP log record when it happens. */
	readonly telemetry: TelemetryExport;
	/** What the collector answered to an empty export sent on save. */
	readonly test: TelemetryTestResult;
}

/** What the collector answered to an empty export sent on save. */
export interface TelemetryTestResult {
	readonly ok: boolean;
	readonly status?: number;
	readonly error?: string;
}

/** A microVM profile: image, base, resources, variables, setup and egress, versioned. */
export interface Template {
	/** The template's ID, such as `tpl_4kq9x2mt`. */
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly description?: string;
	/** Its current version; a new spec makes the next. */
	readonly version: number;
	/** A template version's definition, never changed once made. Answered with every default filled in. */
	readonly spec: TemplateSpec;
	readonly build: TemplateBuildStatus;
	/** How many sandboxes were made from it and still exist. */
	readonly sandboxCount: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
	readonly createdBy: CreatedBy;
}

/** The Kantel base image it boots: a channel the deployment publishes (`/v1/template-bases`), or a digest one published. Default: `kantel/sandbox`'s `stable` channel; until that channel publishes a digest, each host's own sandbox image. */
export type TemplateBase = TemplateBaseChannelRef | TemplateBasePinned;

/** A base image's channel and the digests it has published. */
export interface TemplateBaseChannel {
	readonly image: string;
	readonly channel: string;
	/** The digest it publishes now. */
	readonly digest: string;
	/** Epoch milliseconds, UTC. */
	readonly publishedAt: number;
	/** Every digest it has published, newest first. */
	readonly history: readonly TemplateBaseRelease[];
}

/** Follow a channel: rebuilt when it publishes a new digest. */
export interface TemplateBaseChannelRef {
	/** The base image, such as `kantel/sandbox`. */
	readonly image: string;
	/** A channel, such as `stable`. */
	readonly channel: string;
}

export interface TemplateBaseList {
	readonly items: readonly TemplateBaseChannel[];
}

/** Pin an exact digest, one its channels published: never rebuilt for a new release. */
export interface TemplateBasePinned {
	/** The base image, such as `kantel/sandbox`. */
	readonly image: string;
	/** The digest pinned. */
	readonly digest: string;
}

export interface TemplateBaseRelease {
	readonly digest: string;
	/** Epoch milliseconds, UTC. */
	readonly publishedAt: number;
}

/** How far a pinned base is behind its channel. */
export interface TemplateBehind {
	/** How many digests the base's channel has published since the pinned one. */
	readonly releases: number;
	/** Epoch milliseconds, UTC. */
	readonly since: number;
	readonly latestDigest: string;
}

export interface TemplateBuildStatus {
	/** `none`: nothing built yet; sandboxes boot fresh. `stale`: what is built is for an older key, and used until its replacement is ready if it is of the template's current version. A `ready` snapshot of an older version starts no sandbox: they boot fresh until the current version's is ready. A template with a Dockerfile or image reference doesn't boot fresh before its current version's image is built: its sandboxes wait for that build (`unavailable` until then). */
	readonly state: "none" | "building" | "ready" | "stale" | "failed";
	/** A built template: its image booted once, its setup run, then snapshotted. A cache entry Kantel throws away and rebuilds at will, never one of the account's snapshots. */
	readonly ready?: TemplateSnapshot;
	/** A built template: its image booted once, its setup run, then snapshotted. A cache entry Kantel throws away and rebuilds at will, never one of the account's snapshots. */
	readonly building?: TemplateSnapshot;
	readonly error?: string;
	/** How far a pinned base is behind its channel. */
	readonly behind?: TemplateBehind;
}

/** What a template snapshot was built from. */
export interface TemplateBuiltFrom {
	readonly baseImage: string;
	/** The channel it followed; absent when pinned. */
	readonly channel?: string;
	/** Empty while the channel has no published digest. */
	readonly baseDigest: string;
	readonly pinned: boolean;
	/** The digest of the image its host booted, as the host reported it: for an `image`, the digest the reference resolved to; for a `dockerfile`, the built image's ID. */
	readonly imageDigest?: string;
	/** The template image's kind it was built from. Absent: `kantel-base`. */
	readonly source?: "kantel-base" | "dockerfile" | "image";
	/** For a `dockerfile`, the SHA-256 of the Dockerfile built, `sha256:…`. */
	readonly dockerfileDigest?: string;
	/** For an `image`, the reference pulled. */
	readonly imageRef?: string;
	readonly kernel: string;
	readonly firecracker: string;
}

/** What a template snapshot is for: a change to any part builds another. A create starts from it only when it gets the same vCPUs and memory. */
export interface TemplateCacheKey {
	/** `<templateId>@<version>`. */
	readonly templateVersion: string;
	readonly baseDigest: string;
	/** A custom image's source: `dockerfile:sha256:…` (the Dockerfile's digest) or `image:<ref>`. Absent for `kantel-base`. */
	readonly source?: string;
	/** A custom image's digest: the one an `image` pins from the start, else the one its build made or resolved, recorded once the build answers. Absent for `kantel-base`. */
	readonly imageDigest?: string;
	readonly kernel: string;
	readonly firecracker: string;
	readonly vcpus: number;
	/** With `vcpus`, the machine it was built as: the template's resources, which a fresh boot from it gets too. */
	readonly memoryMb: number;
}

/** Built in an isolated build microVM whose only way out is the sandbox egress proxy: its pulls, `RUN` steps and remote `ADD`s reach the template's egress grants and the registries the host's operator allows, and never a host, private or metadata address. */
export interface TemplateDockerfileImage {
	readonly kind: "dockerfile";
	/** A Dockerfile, built with no build context. `ARG KANTEL_BASE` then `FROM $KANTEL_BASE` starts from the template's `base`; any other `FROM` image is pulled. */
	readonly dockerfile: string;
}

/** What a template's machines boot: `kantel-base`, Kantel's base image customised by the setup script; a `dockerfile`; or an `image` reference. Custom images are built only on hosts that build them in a build microVM. Default: `kantel-base`. */
export type TemplateImage = TemplateKantelBaseImage | TemplateDockerfileImage | TemplateImageRef;

/** Pulled in an isolated build microVM, as a Dockerfile's images are. The template's `base` isn't used. An image that isn't one of Kantel's boots through the guest agent the host injects. */
export interface TemplateImageRef {
	readonly kind: "image";
	/** An image reference, such as `python:3.13-slim` or `ghcr.io/acme/ci@sha256:…`. A tag is resolved when the template is built, and again on a rebuild. */
	readonly ref: string;
}

/** The template's `base` itself, as its deployment publishes it; the setup script adds the rest. */
export interface TemplateKantelBaseImage {
	readonly kind: "kantel-base";
}

export interface TemplateList {
	readonly items: readonly Template[];
}

/** Egress grants for its sandboxes and for its build's boot. */
export interface TemplateNetwork {
	readonly grants: readonly EgressGrantInput[];
}

/** Its sandboxes' and its builds' vCPUs and memory, exactly, unless a create names a size; a deployment must offer a size with at least them. Default 2 vCPUs and 4096 MB. */
export interface TemplateResources {
	readonly vcpus: number;
	readonly memoryMb: number;
}

/** A built template: its image booted once, its setup run, then snapshotted. A cache entry Kantel throws away and rebuilds at will, never one of the account's snapshots. */
export interface TemplateSnapshot {
	/** The template snapshot's ID, `tsn_…`. */
	readonly id: string;
	readonly templateId: string;
	readonly version: number;
	/** What a template snapshot is for: a change to any part builds another. A create starts from it only when it gets the same vCPUs and memory. */
	readonly key: TemplateCacheKey;
	/** The SHA-256 hex of the key's canonical JSON. */
	readonly keyHash: string;
	/** `stale`: built for a key no longer wanted, and used while its replacement builds only if it is of the template's current version. `failed`: not tried again until its key changes or the template is rebuilt. `discarded`: thrown away. */
	readonly state: TemplateSnapshotState;
	/** The host it was built on, which holds it. */
	readonly hostId?: string;
	/** What a template snapshot was built from. */
	readonly builtFrom: TemplateBuiltFrom;
	/** Epoch milliseconds, UTC. */
	readonly startedAt: number;
	/** Epoch milliseconds, UTC. */
	readonly readyAt?: number;
	/** Why the build failed. */
	readonly error?: string;
	readonly sizeBytes?: number;
}

export interface TemplateSnapshotList {
	/** Newest first. */
	readonly items: readonly TemplateSnapshot[];
}

/** `stale`: built for a key no longer wanted, and used while its replacement builds only if it is of the template's current version. `failed`: not tried again until its key changes or the template is rebuilt. `discarded`: thrown away. */
export type TemplateSnapshotState = "queued" | "building" | "ready" | "stale" | "failed" | "discarded";

/** A template version's definition, never changed once made. Answered with every default filled in. */
export interface TemplateSpec {
	/** What a template's machines boot: `kantel-base`, Kantel's base image customised by the setup script; a `dockerfile`; or an `image` reference. Custom images are built only on hosts that build them in a build microVM. Default: `kantel-base`. */
	readonly image?: TemplateImage;
	/** The Kantel base image it boots: a channel the deployment publishes (`/v1/template-bases`), or a digest one published. Default: `kantel/sandbox`'s `stable` channel; until that channel publishes a digest, each host's own sandbox image. */
	readonly base?: TemplateBase;
	/** Its sandboxes' and its builds' vCPUs and memory, exactly, unless a create names a size; a deployment must offer a size with at least them. Default 2 vCPUs and 4096 MB. */
	readonly resources?: TemplateResources;
	/** Plain variables, not secrets: under the environment's and the create's own. */
	readonly env?: {
		readonly [key: string]: string;
	};
	/** A shell script run once, as root, when the snapshot is built (or at a fresh boot). */
	readonly setup?: string;
	/** Egress grants for its sandboxes and for its build's boot. */
	readonly network?: TemplateNetwork;
}

export interface TemplateVersion {
	readonly version: number;
	/** A template version's definition, never changed once made. Answered with every default filled in. */
	readonly spec: TemplateSpec;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	readonly createdBy: CreatedBy;
}

export interface TemplateVersionList {
	/** Newest first. */
	readonly items: readonly TemplateVersion[];
}

export interface UpdateAccountBody {
	readonly name?: string;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly defaultVisibility?: SandboxVisibility;
}

export interface UpdateEnvironmentBody {
	readonly name?: string;
	/** Empty clears it. */
	readonly description?: string;
}

export interface UpdateHostBody {
	readonly name?: string;
	readonly labels?: {
		readonly [key: string]: string;
	};
	/** Stop placing new sandboxes on it. */
	readonly draining?: boolean;
}

export interface UpdateMemberBody {
	/** `member`: uses the organisation's shared sandboxes and snapshots and makes their own. `admin`: also manages members, API keys, webhooks, telemetry and the proxy. `owner`: also renames or deletes the organisation. A personal account's person is its `owner`. */
	readonly role: MemberRole;
}

export interface UpdateSandboxBody {
	readonly name?: string;
	readonly autoStopMinutes?: number | null;
	/** Its idle stop; `null` turns it off. A running sandbox's idle time counts from now. */
	readonly idleStopMinutes?: number | null;
	/** Move `stopsAt` to this long from now. */
	readonly extendMinutes?: number;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly visibility?: SandboxVisibility;
	/** Replaces its labels. */
	readonly labels?: {
		readonly [key: string]: string;
	};
}

/** A `spec` that differs from the current one makes a new version. */
export interface UpdateTemplateBody {
	readonly name?: string;
	/** Empty clears it. */
	readonly description?: string;
	/** A template version's definition, never changed once made. Answered with every default filled in. */
	readonly spec?: TemplateSpec;
}

export interface UpdateWebhookBody {
	readonly name?: string;
	readonly url?: string;
	readonly events?: readonly EventType[];
	readonly enabled?: boolean;
}

export interface UploadBundleQuery {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	/** The digest the tar should have: an upload whose bytes don't match is refused (`invalid`). */
	readonly digest?: string;
}

export interface UsageQuery {
	/** From this time; default 24 hours ago. `series` then holds only the points after it, so a client polls with the last point's `at`. */
	readonly since?: number;
	/** Default 300. */
	readonly intervalSeconds?: number;
}

/** A host's recent CPU and memory, for sparklines. */
export interface UsageSparklines {
	/** CPU utilisation, 0 to 1, over the last 24 intervals of 5 minutes, oldest first. The last may be the interval under way. */
	readonly recentCpu: readonly number[];
	/** Memory in use, in bytes, over the same intervals as `recentCpu` (the same length), oldest first. */
	readonly recentMemory: readonly number[];
}

export interface UsageSummary {
	readonly runningSeconds: number;
	readonly cpuSeconds: number;
	/** CPU utilisation, 0 to 1, over the last 24 intervals of 5 minutes, oldest first: a sparkline. The last may be the interval under way. */
	readonly recentCpu: readonly number[];
	/** Memory in use, in bytes, over the same intervals as `recentCpu` (the same length), oldest first. */
	readonly recentMemory: readonly number[];
}

export interface ViewAccessBody {
	/** Watch only: no keyboard or mouse. Default false. */
	readonly viewOnly?: boolean;
	/** How long the URLs can be opened for; a view or connection opened in time stays open. Default 10. */
	readonly ttlMinutes?: number;
}

/** An HTTPS endpoint that gets an account's events, signed as Standard Webhooks are: `webhook-id`, `webhook-timestamp` and `webhook-signature` (`v1,` and the base64 HMAC-SHA256 of `id.timestamp.body`, keyed by the secret after its `whsec_`). Failed deliveries are retried with backoff, up to 8 attempts. */
export interface Webhook {
	/** The webhook's ID, such as `whk_3m4n5b`. */
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly url: string;
	readonly events: readonly EventType[];
	readonly enabled: boolean;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	readonly lastDelivery?: WebhookLastDelivery;
}

export interface WebhookDelivery {
	/** The delivery's ID. */
	readonly id: string;
	readonly webhookId: string;
	readonly eventId: string;
	/** `sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call, its auto-stop or its idle stop), or paused. `sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; `sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason says which), which leaves it running. `sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted. */
	readonly eventType: EventType;
	readonly state: "pending" | "delivered" | "failed";
	readonly attempts: number;
	readonly lastStatus?: number;
	readonly lastError?: string;
	/** Epoch milliseconds, UTC. */
	readonly nextAttemptAt?: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly deliveredAt?: number;
}

export interface WebhookDeliveryPage {
	readonly items: readonly WebhookDelivery[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface WebhookLastDelivery {
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	readonly ok: boolean;
	readonly status?: number;
}

export interface WebhookList {
	readonly items: readonly Webhook[];
}

export interface WebhookWithSecret {
	/** An HTTPS endpoint that gets an account's events, signed as Standard Webhooks are: `webhook-id`, `webhook-timestamp` and `webhook-signature` (`v1,` and the base64 HMAC-SHA256 of `id.timestamp.body`, keyed by the secret after its `whsec_`). Failed deliveries are retried with backoff, up to 8 attempts. */
	readonly webhook: Webhook;
	/** The signing secret, `whsec_…`. Shown once. */
	readonly secret: string;
}

export interface WriteFileBody {
	readonly path: string;
	readonly content: string;
	readonly encoding?: FileEncoding;
	/** Octal permissions, such as `0755`. */
	readonly mode?: string;
}

// Runtime

// The SDK's runtime, copied into `generated/sdk.ts` as it is, so the SDK is one file with no imports. Keep it free of
// imports and of anything but `fetch`.

export interface KantelClientOptions {
	/** The API's base URL with its version, such as `https://kantel.example/v1`, or `/v1` on the same origin. */
	readonly baseUrl: string;
	/**
	 * The bearer for every call: a host app's API key (`ktk_…`), or a function that gives one per call. Absent when the
	 * browser is signed in another way, such as Cloudflare Access's cookie.
	 */
	readonly token?: string | (() => string | undefined | Promise<string | undefined>);
	/** More headers for every call. */
	readonly headers?: () => { readonly [name: string]: string } | Promise<{ readonly [name: string]: string }>;
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * Opens a stream's WebSocket. Default the global `WebSocket`; with a bearer it passes `{ headers }`, which Node's
	 * (undici's) takes. A browser can't put a header on a socket, so in a browser the page must be signed in by cookie.
	 */
	readonly webSocket?: (url: string, headers: { readonly [name: string]: string }) => WebSocketLike;
	/**
	 * Makes the `Idempotency-Key` for each call to a route that takes one and wasn't given one (`options.idempotencyKey`),
	 * such as `() => crypto.randomUUID()`. It is made once per call, so a `fetch` that retries the request sends the
	 * same key and the call is done once.
	 */
	readonly idempotencyKey?: () => string;
}

/** The parts of a WHATWG WebSocket a stream uses. */
export interface WebSocketLike {
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	close(code?: number, reason?: string): void;
}

/** What a stream calls as frames arrive. */
export interface StreamHandlers<Frame> {
	/** The frames of one message, in order: `hello`, then a snapshot or the deltas after `after`, then live deltas. */
	onFrames(frames: readonly Frame[]): void;
	onOpen?(): void;
	/**
	 * The socket closed, by either side. Reconnect with `{ after: handle.cursor }` to resume. A server-sent events stream
	 * that Kantel refused closes with 4000 and the HTTP status (4401 for a sign-in that ended), one that ended with 1000,
	 * and one that failed with 1006.
	 */
	onClose?(event: { readonly code: number; readonly reason: string }): void;
}

/** An open stream. */
export interface StreamHandle {
	/** The latest cursor the stream has sent (a hello's, a snapshot's or a delta's), to resume from. */
	readonly cursor: string | undefined;
	close(): void;
}

/** Per call. */
export interface CallOptions {
	readonly signal?: AbortSignal;
	/** Sent as `kantel-request-id`, which correlates the call in Kantel's audit trail. */
	readonly requestId?: string;
	/**
	 * Sent as `Idempotency-Key` on the calls that take one (their docs say so): a retry with the same key gets the first
	 * call's answer and does nothing again. A `conflict` with `details.idempotencyKey` `"in_progress"` means the first call is
	 * still working (retry with the same key); `"held"` means it didn't finish and is never done again under the key (check,
	 * then use a new key). The same key with a different request is `refused`. Use a new key, such as a UUID, for each new
	 * call.
	 */
	readonly idempotencyKey?: string;
	readonly headers?: { readonly [name: string]: string };
}

/**
 * An error Kantel answered with: its KantelError code (or `unauthenticated`), message and HTTP status, and its details.
 * A sandbox that can't be placed has `reason` (`details.reason`), such as `insufficient_capacity`: retry later.
 */
export class KantelApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: { readonly [key: string]: unknown };
	/** Why a sandbox couldn't be placed, a `PlacementReason` such as `no_host_for_type`; absent for other errors. */
	readonly reason?: string;
	constructor(status: number, code: string, message: string, details?: { readonly [key: string]: unknown }) {
		super(message);
		this.name = "KantelApiError";
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
		if (typeof details?.reason === "string") this.reason = details.reason;
	}
}

/** A raw request body: bytes, a `Blob` (such as a `File`), or a stream of bytes. */
export type RawBody = Blob | ArrayBuffer | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;

/** One call, as the generated methods describe it. */
export interface ApiCall {
	readonly method: string;
	/** Relative to the base URL, with path parameters already encoded. */
	readonly path: string;
	/** Query parameters; a record value, such as `label`, is sent as `label.<key>=<value>`. */
	readonly query?: object;
	readonly body?: unknown;
	/** A raw body, such as a tar, sent as it is with this media type rather than as JSON. */
	readonly raw?: { readonly body: RawBody; readonly type: string };
	readonly headers?: { readonly [name: string]: string | undefined };
	/** The answer is bytes, such as an image, not JSON: the call resolves with a `Blob`. */
	readonly binary?: boolean;
	/** A stream served as server-sent events only: read over `fetch`, never a WebSocket. */
	readonly events?: boolean;
	/** The route takes an `Idempotency-Key`. */
	readonly idempotent?: boolean;
}

const queryString = (query: object | undefined): string => {
	if (query === undefined) return "";
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "object") {
			// A record, such as `label`: `label.<key>=<value>`.
			for (const [key, item] of Object.entries(value as { [key: string]: unknown })) {
				if (item !== undefined) params.append(`${name}.${key}`, String(item));
			}
		} else params.append(name, String(value));
	}
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
};

async function errorOf(response: Response): Promise<KantelApiError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
	const code =
		typeof error?.code === "string" ? error.code : response.status === 401 ? "unauthenticated" : "unavailable";
	const message = typeof error?.message === "string" ? error.message : `Kantel answered ${response.status}`;
	const details =
		typeof error?.details === "object" && error.details !== null
			? (error.details as { [key: string]: unknown })
			: undefined;
	return new KantelApiError(response.status, code, message, details);
}

/**
 * Sends one call and reads its JSON answer, or its bytes as a `Blob` for a `binary` call; a 204 resolves undefined.
 * Rejects with a `KantelApiError`.
 */
export async function send<T>(options: KantelClientOptions, call: ApiCall, callOptions: CallOptions = {}): Promise<T> {
	const headers: { [name: string]: string } = { accept: call.binary === true ? "*/*" : "application/json" };
	Object.assign(headers, (await options.headers?.()) ?? {});
	const token = typeof options.token === "function" ? await options.token() : options.token;
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	if (call.body !== undefined) headers["content-type"] = "application/json";
	if (call.raw !== undefined) headers["content-type"] = call.raw.type;
	if (callOptions.requestId !== undefined) headers["kantel-request-id"] = callOptions.requestId;
	const idempotencyKey =
		callOptions.idempotencyKey ?? (call.idempotent === true ? options.idempotencyKey?.() : undefined);
	if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
	for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
	Object.assign(headers, callOptions.headers ?? {});
	const doFetch = options.fetch ?? fetch;
	const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}${call.path}${queryString(call.query)}`, {
		method: call.method,
		headers,
		...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
		// A stream is sent as it comes (`duplex: "half"`, which fetch needs for one).
		...(call.raw === undefined
			? {}
			: call.raw.body instanceof ReadableStream
				? { body: call.raw.body, duplex: "half" }
				: { body: call.raw.body }),
		...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
	});
	if (!response.ok) throw await errorOf(response);
	if (response.status === 204) return undefined as T;
	if (call.binary === true) return (await response.blob()) as T;
	return (await response.json()) as T;
}

const cursorOf = (frame: unknown): string | undefined => {
	const value = frame as {
		type?: string;
		cursor?: string;
		snapshot?: { cursor?: string };
		delta?: { cursor?: string };
	};
	if (value.type === "snapshot") return value.snapshot?.cursor;
	if (value.type === "delta") return value.delta?.cursor;
	if (value.type === "hello") return value.cursor;
	return undefined;
};

function defaultWebSocket(url: string, headers: { readonly [name: string]: string }): WebSocketLike {
	const Socket = (globalThis as { WebSocket?: unknown }).WebSocket as
		| (new (
				url: string,
				init?: { headers: { readonly [name: string]: string } },
		  ) => WebSocketLike)
		| undefined;
	if (Socket === undefined) throw new KantelApiError(0, "not_supported", "This platform has no WebSocket");
	return Object.keys(headers).length === 0 ? new Socket(url) : new Socket(url, { headers });
}

/**
 * The frame of one server-sent event (`data:` lines, joined), or undefined for a comment, a keep-alive or anything
 * that isn't JSON.
 */
function eventFrame(block: string): unknown {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
	if (data.length === 0) return undefined;
	try {
		return JSON.parse(data.join("\n"));
	} catch {
		return undefined;
	}
}

/**
 * Reads a stream route's server-sent events over `fetch`, with the client's headers as any call has them, and hands each
 * event's frame to `handlers`.
 */
function openEvents<Frame>(
	options: KantelClientOptions,
	call: ApiCall,
	handlers: StreamHandlers<Frame>,
	callOptions: CallOptions,
): StreamHandle {
	const aborter = new AbortController();
	let closed = false;
	const finish = (code: number, reason: string) => {
		if (closed) return;
		closed = true;
		aborter.abort();
		handlers.onClose?.({ code, reason });
	};
	const handle: StreamHandle = {
		cursor: undefined,
		close() {
			if (closed) return;
			closed = true;
			aborter.abort();
		},
	};
	callOptions.signal?.addEventListener("abort", () => handle.close(), { once: true });
	void (async () => {
		const headers: { [name: string]: string } = { accept: "text/event-stream" };
		Object.assign(headers, (await options.headers?.()) ?? {});
		const token = typeof options.token === "function" ? await options.token() : options.token;
		if (token !== undefined) headers.authorization = `Bearer ${token}`;
		if (callOptions.requestId !== undefined) headers["kantel-request-id"] = callOptions.requestId;
		Object.assign(headers, callOptions.headers ?? {});
		if (closed) return;
		const doFetch = options.fetch ?? fetch;
		const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}${call.path}${queryString(call.query)}`, {
			method: call.method,
			headers,
			signal: aborter.signal,
		});
		if (!response.ok) {
			const error = await errorOf(response);
			return finish(4000 + response.status, error.message);
		}
		if (response.body === null) return finish(1006, "The stream had no body");
		handlers.onOpen?.();
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
			for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
				const frame = eventFrame(buffer.slice(0, end));
				buffer = buffer.slice(end + 2);
				if (frame !== undefined && !closed) handlers.onFrames([frame as Frame]);
			}
		}
		finish(1000, "The server ended the stream");
	})().catch((error: unknown) => {
		finish(1006, error instanceof Error ? error.message : "The stream failed");
	});
	return handle;
}

/**
 * Opens a stream route and hands each message's frames to `handlers`: over a WebSocket, or a route served as
 * server-sent events only (`events`) over `fetch`.
 */
export function openStream<Frame>(
	options: KantelClientOptions,
	call: ApiCall,
	handlers: StreamHandlers<Frame>,
	callOptions: CallOptions = {},
): StreamHandle {
	if (call.events === true) return openEvents(options, call, handlers, callOptions);
	const base = options.baseUrl.replace(/\/+$/, "");
	const origin = (globalThis as { location?: { href?: string } }).location?.href;
	const url = new URL(`${base}${call.path}${queryString(call.query)}`, origin);
	url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
	let cursor: string | undefined;
	let socket: WebSocketLike | undefined;
	let closed = false;
	const handle: StreamHandle = {
		get cursor() {
			return cursor;
		},
		close() {
			closed = true;
			socket?.close(1000, "The client closed the stream");
		},
	};
	void (async () => {
		const headers: { [name: string]: string } = {};
		Object.assign(headers, (await options.headers?.()) ?? {});
		const token = typeof options.token === "function" ? await options.token() : options.token;
		if (token !== undefined) headers.authorization = `Bearer ${token}`;
		if (callOptions.requestId !== undefined) headers["kantel-request-id"] = callOptions.requestId;
		Object.assign(headers, callOptions.headers ?? {});
		if (closed) return;
		socket = (options.webSocket ?? defaultWebSocket)(url.href, headers);
		socket.onopen = () => handlers.onOpen?.();
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			let frames: unknown;
			try {
				frames = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!Array.isArray(frames) || frames.length === 0) return;
			for (const frame of frames) cursor = cursorOf(frame) ?? cursor;
			handlers.onFrames(frames as Frame[]);
		};
		socket.onerror = () => undefined;
		socket.onclose = (event) => {
			closed = true;
			handlers.onClose?.({ code: event.code, reason: event.reason });
		};
		callOptions.signal?.addEventListener("abort", () => handle.close(), { once: true });
	})().catch((error: unknown) => {
		closed = true;
		handlers.onClose?.({ code: 1006, reason: error instanceof Error ? error.message : "The stream failed to open" });
	});
	return handle;
}

// Client

/** Kantel's public API, one method per route. */
export interface KantelClient {
	/** Embed a session's browser. A link for an iframe: a watch-only live view of one of the session's open browsers, or a replay of one, open or closed. Needs viewer on the session; never an agent. The link carries a short-lived token scoped to that one view (never control), lasting `minutes`. A closed browser has no live view (`expired`); a deployment whose browsers keep no recordings has no replay (`unavailable`), and a recording past its retention is `expired`. Audited as `browser.session.embedded`, without the link. `POST /sessions/{sessionId}/browsers/{browserSessionId}/embed` */
	embedBrowserSession(
		sessionId: string,
		browserSessionId: string,
		body: EmbedBrowserBody,
		options?: CallOptions,
	): Promise<BrowserEmbed>;
	/** Create a project. Creates a project in the caller's organisation, which the `kantel-organisation` header names for a person in more than one. Needs an organisation-wide admin, or an organisation API key with the `create_projects` permission; a project key is refused, whatever its role. An organisation key holds its role on the new project at once. Audited as `identity.project.created`, with the caller as its actor. `POST /projects` */
	createProject(body: CreateProjectBody, options?: CallOptions): Promise<Project>;
	/** Who is calling. The person or key calling, the accounts they may act in (their personal account first), the deployment's mode, and whether it keeps protected variables and secret files (`protectedValues`), so a client can check before it makes an environment that needs them. Any key may call it. `GET /whoami` */
	getCaller(options?: CallOptions): Promise<Caller>;
	/** List accounts. The caller's personal account and every organisation they belong to; for a key, its own account. A key needs `account:read`. `GET /accounts` */
	listAccounts(options?: CallOptions): Promise<AccountList>;
	/** Create an organisation. Makes an organisation account with the caller as its owner. People only: a key is refused. Idempotent with `options.idempotencyKey`. `POST /accounts` */
	createOrganisation(body: CreateOrganisationBody, options?: CallOptions): Promise<Account>;
	/** Join an organisation. Joins the organisation an invite's code is for, with the invite's role. People only. An expired or used code is `expired`. `POST /accounts/join` */
	joinOrganisation(body: JoinOrganisationBody, options?: CallOptions): Promise<Account>;
	/** Get an account. A key needs `account:read`. `GET /accounts/{accountId}` */
	getAccount(accountId: string, options?: CallOptions): Promise<Account>;
	/** Change an account. Renames it or sets new sandboxes' default visibility; needs admin. A key needs `account:admin`. `PATCH /accounts/{accountId}` */
	updateAccount(accountId: string, body?: UpdateAccountBody, options?: CallOptions): Promise<Account>;
	/** Delete an organisation. Deletes an organisation with no sandboxes or saved snapshots left (`conflict` otherwise); needs its owner. A personal account can't be deleted here. People only. `DELETE /accounts/{accountId}` */
	deleteOrganisation(accountId: string, options?: CallOptions): Promise<void>;
	/** Get an account's usage. Running time and cost since `since`, and the account's limits. A key needs `account:read`. `GET /accounts/{accountId}/usage` */
	getAccountUsage(accountId: string, query?: UsageQuery, options?: CallOptions): Promise<AccountUsage>;
	/** List an organisation's members. A key needs `account:read`. `GET /accounts/{accountId}/members` */
	listMembers(accountId: string, options?: CallOptions): Promise<MemberList>;
	/** Change a member's role. Needs admin; only an owner makes or unmakes an owner, and the last owner stays. A key needs `account:admin`. `PATCH /accounts/{accountId}/members/{userId}` */
	updateMember(accountId: string, userId: string, body: UpdateMemberBody, options?: CallOptions): Promise<Member>;
	/** Remove a member. Removes a member, or lets a member leave. Their private sandboxes in the organisation stay, stopped, for an admin to delete or share. The last owner can't leave. A key needs `account:admin`. `DELETE /accounts/{accountId}/members/{userId}` */
	removeMember(accountId: string, userId: string, options?: CallOptions): Promise<void>;
	/** List an organisation's open invites. Codes are not shown again. A key needs `account:admin`. `GET /accounts/{accountId}/invites` */
	listInvites(accountId: string, options?: CallOptions): Promise<InviteList>;
	/** Invite someone to an organisation. Makes a join code, shown once, for one person or for anyone holding it; needs admin. A key needs `account:admin`. Idempotent with `options.idempotencyKey`. `POST /accounts/{accountId}/invites` */
	createInvite(accountId: string, body?: CreateInviteBody, options?: CallOptions): Promise<Invite>;
	/** Revoke an invite. A key needs `account:admin`. `DELETE /accounts/{accountId}/invites/{inviteId}` */
	revokeInvite(accountId: string, inviteId: string, options?: CallOptions): Promise<void>;
	/** List sandboxes. The account's sandboxes the caller may see, newest first: by default the ones starting, running or stopping; `all` adds stopped, paused and errored ones. Deleted ones are left out. A key needs `sandboxes:read`. `GET /sandboxes` */
	listSandboxes(query?: ListSandboxesQuery, options?: CallOptions): Promise<SandboxPage>;
	/** Get the shapes a sandbox may be. What a new sandbox in the account may be, from the hosts it may use: an isolate's memory, a microVM's vCPUs and memory, the hosts' presets and what an hour costs. With `host`, from that host alone. A key needs `sandboxes:read`. `GET /sandbox-shapes` */
	getSandboxShapes(query?: SandboxShapesQuery, options?: CallOptions): Promise<SandboxShapes>;
	/** Create a sandbox. Makes a sandbox and starts it: an isolate unless `type` says `microvm`, from a snapshot when `from` names one. `resources` sets its vCPUs and memory (`getSandboxShapes` says what may be asked); `size`, a named size, still works for now. Answers as soon as it is placed (`starting`), or once it runs with `wait`. A full deployment is `exhausted`; no host able to run the type is `unavailable`. `mounts` (experimental) are for microVMs only: an isolate's are refused (`not_supported`), because an isolate is a JavaScript shell over files the host keeps, with no file system of its own to mount a drive or a bucket into. A mount whose bundle or bucket source isn't the account's is `not_found`; with the deployment's `KANTEL_MOUNTS` switch off, any `mounts` are `not_supported`. A key needs `sandboxes:write`. Idempotent with `options.idempotencyKey`. `POST /sandboxes` */
	createSandbox(body?: CreateSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Get a sandbox. A key needs `sandboxes:read`. `GET /sandboxes/{sandboxId}` */
	getSandbox(sandboxId: string, options?: CallOptions): Promise<Sandbox>;
	/** Change a sandbox. Renames it, changes its auto-stop or idle stop or moves its stop time (`extendMinutes`), shares it with its organisation or makes it private again, or replaces its labels. A key needs `sandboxes:write`. Idempotent with `options.idempotencyKey`. `PATCH /sandboxes/{sandboxId}` */
	updateSandbox(sandboxId: string, body?: UpdateSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Start a sandbox. Boots a stopped, paused or errored sandbox fresh from its newest disk snapshot: programs start again, and a paused sandbox's memory is let go. To carry on where a paused sandbox left off, `resume` it instead. A running sandbox is answered as it is. A key needs `sandboxes:write`. `POST /sandboxes/{sandboxId}/start` */
	startSandbox(sandboxId: string, body?: ResumeSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Stop or pause a sandbox. Saves its disk as a snapshot and lets the machine go; running programs end. With `keepMemory`, pauses it instead, keeping its memory too (microVMs only; `not_supported` on an isolate). A stopped sandbox costs nothing to run. A key needs `sandboxes:write`. `POST /sandboxes/{sandboxId}/stop` */
	stopSandbox(sandboxId: string, body?: StopSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Resume a sandbox. Carries on a paused sandbox from its memory, or starts a stopped one from its newest snapshot, on the same size or the one given. Same ID; a new machine. A key needs `sandboxes:write`. `POST /sandboxes/{sandboxId}/resume` */
	resumeSandbox(sandboxId: string, body?: ResumeSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Fork a sandbox. Makes `count` new sandboxes, each a copy of this one's newest snapshot (or `snapshotId`); a running microVM on a host that can fork live is copied with its memory. The source doesn't change. A microVM fork is its source's machine (its `resources` from the start) unless `size` names another, and gets the source's exposed ports, each public or gated as it was, at its own URLs once it runs (only for a caller with `access`, as they are exposed as the caller). A key needs `sandboxes:write`. Idempotent with `options.idempotencyKey`. `POST /sandboxes/{sandboxId}/fork` */
	forkSandbox(sandboxId: string, body?: ForkSandboxBody, options?: CallOptions): Promise<ForkedSandboxes>;
	/** Recover a sandbox. Restarts the machine of a sandbox that doesn't answer or is in `error`, on its disk as it is. Memory is lost. A key needs `sandboxes:write`. Idempotent with `options.idempotencyKey`. `POST /sandboxes/{sandboxId}/recover` */
	recoverSandbox(sandboxId: string, options?: CallOptions): Promise<Sandbox>;
	/** Restart a sandbox on the latest base. Restarts the machine on the newest base image, on its disk as it is: a running sandbox's disk is saved and it is stopped first (as `stop` does, without its memory), then it boots cold on the latest base. Memory is lost, and so are running programs. A running sandbox is never patched underneath: this is how an outdated one (`base.outdated`) moves on. Answers once it is starting. A sandbox starting, stopping or being deleted is `conflict`; one another call moves after this restart has stopped it is `aborted`. A key needs `sandboxes:write`. Experimental: `not_supported` unless the deployment has turned image patching on (`KANTEL_IMAGE_PATCHING`). Idempotent with `options.idempotencyKey`. `POST /sandboxes/{sandboxId}/restart-on-latest` */
	restartSandboxOnLatest(sandboxId: string, options?: CallOptions): Promise<Sandbox>;
	/** Delete a sandbox permanently. Erases it and its automatic snapshots for good; saved snapshots of it stay. It can't be undone. A key needs `sandboxes:delete`. Idempotent with `options.idempotencyKey`. `DELETE /sandboxes/{sandboxId}` */
	deleteSandbox(sandboxId: string, options?: CallOptions): Promise<Sandbox>;
	/** Get a sandbox's usage. CPU, memory, running time and cost per interval, and in `series` its readings as they came (every 5 seconds over the last hour from a current host). Poll with `since` set to the last series point's `at` for only the newer points. A key needs `sandboxes:read`. `GET /sandboxes/{sandboxId}/usage` */
	getSandboxUsage(sandboxId: string, query?: UsageQuery, options?: CallOptions): Promise<SandboxUsage>;
	/** Run a command. Runs a command line in a running sandbox and answers when it ends, with its exit code and output, or at `timeoutMs` (`timed_out`, the command killed). `detached` answers at once and lets it run with no limit unless `timeoutMs` gives one. A call to a sandbox that is starting waits for it to run, up to 60 seconds, apart from `timeoutMs`. A stopped, paused or failed sandbox is `conflict`, with a `SandboxNotRunning` in `details`: resume it first. A key needs `exec`. Idempotent with `options.idempotencyKey`. `POST /sandboxes/{sandboxId}/commands` */
	runCommand(sandboxId: string, body: RunCommandBody, options?: CallOptions): Promise<Command>;
	/** List a sandbox's commands. Its commands, newest first, also while it is stopped. A key needs `exec`. `GET /sandboxes/{sandboxId}/commands` */
	listCommands(sandboxId: string, query?: ComputePageQuery, options?: CallOptions): Promise<CommandPage>;
	/** Get a command. Its state, and once it has ended its exit code and output. While it runs, its output so far, where its sandbox reports it (a microVM on a current kantel-host), detached or not. A key needs `exec`. `GET /sandboxes/{sandboxId}/commands/{commandId}` */
	getCommand(sandboxId: string, commandId: string, options?: CallOptions): Promise<Command>;
	/** Kill a command. Ends a running command and the processes it started; one that has ended is answered as it is. Where its host's kantel-host is too old to stop it, it is marked killed all the same and its `stderr` says it may still be running. A key needs `exec`. `DELETE /sandboxes/{sandboxId}/commands/{commandId}` */
	killCommand(sandboxId: string, commandId: string, options?: CallOptions): Promise<Command>;
	/** Read a file. A file of up to 1 MiB, as UTF-8 text unless `encoding` asks for base64. A larger file is read in parts of up to 1 MiB with `offset` and `length`; `size` in the answer is the whole file's. Use base64 for a part of a binary file, or of a text file cut mid-character. A key needs `files`. `GET /sandboxes/{sandboxId}/files` */
	readFile(sandboxId: string, query: ReadFileQuery, options?: CallOptions): Promise<FileContent>;
	/** Write a file. Writes a file, making its directories, replacing what was there. A key needs `files`. `PUT /sandboxes/{sandboxId}/files` */
	writeFile(sandboxId: string, body: WriteFileBody, options?: CallOptions): Promise<FileEntry>;
	/** Delete a file. Deletes a file, or a directory and everything in it. A key needs `files`. `DELETE /sandboxes/{sandboxId}/files` */
	deleteFile(sandboxId: string, query: FilePathQuery, options?: CallOptions): Promise<void>;
	/** List a directory. A key needs `files`. `GET /sandboxes/{sandboxId}/files/list` */
	listFiles(sandboxId: string, query?: ListFilesQuery, options?: CallOptions): Promise<FileList>;
	/** Get an upload URL for a file. A short-lived URL on the API, streamed straight to the sandbox's host: `PUT` the file to it as the raw request body, of any size, with no `Authorization` header; the answer is `{ path, size }`. Missing directories are made, and a file already there is replaced only once the upload is complete. The URL is bound to this sandbox and path, and expires after `ttlSeconds`. A path in a read-only mount is refused (`conflict`). The sandbox must be running when the URL is used. Treat it as a secret. A key needs `files`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `POST /sandboxes/{sandboxId}/files/upload-url` */
	createUploadUrl(sandboxId: string, body: FileUrlBody, options?: CallOptions): Promise<FileUrl>;
	/** Get a download URL for a file. A short-lived URL on the API, streamed straight from the sandbox's host: `GET` it, with no `Authorization` header, for the file's bytes as they are when it is fetched, whatever its size (`HEAD` for its size alone). The URL is bound to this sandbox and path, and expires after `ttlSeconds`. The sandbox must be running when the URL is used. Treat it as a secret. A key needs `files`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `POST /sandboxes/{sandboxId}/files/download-url` */
	createDownloadUrl(sandboxId: string, body: FileUrlBody, options?: CallOptions): Promise<FileUrl>;
	/** Extract an archive into a directory. Writes every file, directory and symbolic link of a tar (or a gzipped tar) into `path`, in one call. An entry whose name is absolute or climbs out of `path` (`..`), a link that points out of it, an entry under such a link, and hard links, devices and FIFOs are refused (`invalid`) before anything is written. A `path` in a read-only mount, or with one under it, is refused (`conflict`). Files are owned by the sandbox's user, with their modes from the tar. A key needs `files`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `PUT /sandboxes/{sandboxId}/files/archive` */
	extractArchive(
		sandboxId: string,
		body: RawBody,
		query: ExtractArchiveQuery,
		options?: CallOptions,
	): Promise<ExtractedArchive>;
	/** List a sandbox's public ports. A key needs `access`. `GET /sandboxes/{sandboxId}/ports` */
	listPorts(sandboxId: string, options?: CallOptions): Promise<ExposedPortList>;
	/** Expose a port. Gives a port in the sandbox an HTTPS URL through its host's tunnel. The app must listen on the port; on `0.0.0.0` or `localhost` both work. Exposing it again answers its URL. A key needs `access`. Idempotent with `options.idempotencyKey`. `POST /sandboxes/{sandboxId}/ports` */
	exposePort(sandboxId: string, body: ExposePortBody, options?: CallOptions): Promise<ExposedPort>;
	/** Hide a port. Its URL stops working at once. A key needs `access`. `DELETE /sandboxes/{sandboxId}/ports/{port}` */
	hidePort(sandboxId: string, port: string, options?: CallOptions): Promise<void>;
	/** Get SSH access. Lets a key in to the sandbox's SSH gateway for a while, and answers the command that connects. microVMs only. A key needs `access`. `POST /sandboxes/{sandboxId}/ssh` */
	openSsh(sandboxId: string, body?: SshAccessBody, options?: CallOptions): Promise<SshAccess>;
	/** Open the desktop. A short-lived URL that streams the sandbox's Linux desktop to a browser, to watch or drive. microVMs only. A key needs `access`. `POST /sandboxes/{sandboxId}/desktop` */
	openDesktop(sandboxId: string, body?: ViewAccessBody, options?: CallOptions): Promise<DesktopAccess>;
	/** Open the browser. Starts the sandbox's Chromium if it isn't running, and answers a live view URL and a CDP URL for Playwright or Puppeteer. microVMs only. A key needs `access`. `POST /sandboxes/{sandboxId}/browser` */
	openBrowser(sandboxId: string, body?: ViewAccessBody, options?: CallOptions): Promise<BrowserAccess>;
	/** Open an end-to-end encrypted session. A short-lived WebSocket URL to the sandbox's host for a Noise session (`kantel e2e`), which the gateway relays and can't read. In an organisation with end-to-end encryption on, the host runs commands, files and ports only in one. It opens for a stopped or paused sandbox too, whose command history the host still has; what needs a running guest is refused in the session. A key needs `access`. `POST /sandboxes/{sandboxId}/e2e` */
	openE2E(sandboxId: string, body?: E2EAccessBody, options?: CallOptions): Promise<E2EAccess>;
	/** Get an organisation's E2E chain. Its signed entries, oldest first: empty until an admin starts it with `kantel e2e init`. A key needs `account:read`. `GET /accounts/{accountId}/e2e/chain` */
	getE2EChain(accountId: string, options?: CallOptions): Promise<E2EChain>;
	/** Add entries to an organisation's E2E chain. Entries a member's device signed, from the chain's length. The whole chain must still verify; `conflict` when another entry got there first. Only an admin starts a chain. A key needs `account:read`. `POST /accounts/{accountId}/e2e/chain` */
	appendE2EChain(accountId: string, body: E2EChainAppend, options?: CallOptions): Promise<E2EChain>;
	/** List snapshots. The account's snapshots, newest first: saved ones, one sandbox's history (`sandboxId`), or both. A key needs `snapshots:read`. `GET /snapshots` */
	listSnapshots(query?: ListSnapshotsQuery, options?: CallOptions): Promise<SnapshotPage>;
	/** Take a snapshot now. Adds a snapshot of the sandbox's disk to its history now, without stopping it. Kantel also takes them by itself. A key needs `snapshots:write`. Idempotent with `options.idempotencyKey`. `POST /sandboxes/{sandboxId}/snapshots` */
	takeSnapshot(sandboxId: string, body?: TakeSnapshotBody, options?: CallOptions): Promise<Snapshot>;
	/** Save a snapshot. Keeps a sandbox's state now, or one snapshot of its history, under a name until it is deleted. New sandboxes start from it with `from: <name>`. A name in use is `conflict` unless `replace`. A key needs `snapshots:write`. Idempotent with `options.idempotencyKey`. `POST /snapshots` */
	saveSnapshot(body: SaveSnapshotBody, options?: CallOptions): Promise<Snapshot>;
	/** Get a snapshot. A key needs `snapshots:read`. `GET /snapshots/{snapshotId}` */
	getSnapshot(snapshotId: string, options?: CallOptions): Promise<Snapshot>;
	/** List a snapshot's files. One directory of the snapshot's disk, for a file browser. A key needs `snapshots:read`. `GET /snapshots/{snapshotId}/files` */
	listSnapshotFiles(snapshotId: string, query?: SnapshotFilesQuery, options?: CallOptions): Promise<FileList>;
	/** Read a file from a snapshot. A file of up to 1 MiB from the snapshot's disk. A key needs `snapshots:read`. `GET /snapshots/{snapshotId}/file` */
	readSnapshotFile(snapshotId: string, query: ReadSnapshotFileQuery, options?: CallOptions): Promise<FileContent>;
	/** Delete a snapshot. Deletes a saved snapshot, or one of a sandbox's history. A sandbox's newest snapshot, which a resume needs, is `conflict` while the sandbox is stopped. A key needs `snapshots:write`. `DELETE /snapshots/{snapshotId}` */
	deleteSnapshot(snapshotId: string, options?: CallOptions): Promise<void>;
	/** List API keys. The account's keys, revoked ones included. A key needs `account:read`. `GET /api-keys` */
	listApiKeys(query?: AccountScopedQuery, options?: CallOptions): Promise<ApiKeyList>;
	/** Create an API key. Makes a scoped key in the account. Its secret is answered once. A key can only make keys with scopes it holds itself. A key needs `account:admin`. Idempotent with `options.idempotencyKey`. `POST /api-keys` */
	createApiKey(body: CreateApiKeyBody, options?: CallOptions): Promise<IssuedApiKey>;
	/** Get an API key. A key needs `account:read`. `GET /api-keys/{apiKeyId}` */
	getApiKey(apiKeyId: string, options?: CallOptions): Promise<ApiKey>;
	/** Rotate an API key. Replaces its secret; the old one stops working at once. A key needs `account:admin`. Idempotent with `options.idempotencyKey`. `POST /api-keys/{apiKeyId}/rotate` */
	rotateApiKey(apiKeyId: string, options?: CallOptions): Promise<IssuedApiKey>;
	/** Revoke an API key. It stops working at once. A key needs `account:admin`. `DELETE /api-keys/{apiKeyId}` */
	revokeApiKey(apiKeyId: string, options?: CallOptions): Promise<ApiKey>;
	/** Start a device sign-in. Answers a code to show the person and the console page to open, where a signed-in person approves it. Then poll `pollDeviceLogin` with the `deviceCode`. Takes no credential. A code lasts 15 minutes. `POST /auth/device` */
	startDeviceLogin(body?: StartDeviceLoginBody, options?: CallOptions): Promise<DeviceLogin>;
	/** Poll a device sign-in. Its state, and once approved the new key's secret, answered to the first poll that sees it. Takes no credential: the `deviceCode` is the secret. `POST /auth/device/token` */
	pollDeviceLogin(body: PollDeviceLoginBody, options?: CallOptions): Promise<DeviceLoginResult>;
	/** Get a device sign-in. What is asking to sign in with this code, for the approval page. A person only. `GET /auth/device/{userCode}` */
	getDeviceLogin(userCode: string, options?: CallOptions): Promise<DeviceLoginRequest>;
	/** Approve a device sign-in. Makes an API key for the person, named after the device, and hands it to the device's next poll. A person only, who needs admin or owner in the account (`account:admin`), as for `createApiKey`. `POST /auth/device/{userCode}/approve` */
	approveDeviceLogin(
		userCode: string,
		body?: ApproveDeviceLoginBody,
		options?: CallOptions,
	): Promise<DeviceLoginRequest>;
	/** Deny a device sign-in. The device's next poll is `denied`. A person only. `POST /auth/device/{userCode}/deny` */
	denyDeviceLogin(userCode: string, options?: CallOptions): Promise<DeviceLoginRequest>;
	/** Get the proxy settings. Where the account's sandboxes' outbound traffic may go. A key needs `account:read`. `GET /proxy` */
	getProxySettings(query?: AccountScopedQuery, options?: CallOptions): Promise<ProxySettings>;
	/** Set the proxy settings. Replaces them. Running sandboxes pick them up within a minute. An upstream's header values are kept encrypted and never shown again; leave `upstream.headers` out to keep the ones it has. With `expected`, the settings as you read them, a write made from an older read is refused with `conflict`. A key needs `account:admin`. `PUT /proxy` */
	putProxySettings(body: PutProxySettingsBody, options?: CallOptions): Promise<ProxySettings>;
	/** List environments. The account's environments, oldest first. A key needs `account:read`. `GET /environments` */
	listEnvironments(query?: AccountScopedQuery, options?: CallOptions): Promise<EnvironmentList>;
	/** Create an environment. An empty environment, named uniquely in the account. A sandbox starts with it when its create names it. A key needs `account:admin`. Idempotent with `options.idempotencyKey`. `POST /environments` */
	createEnvironment(body: CreateEnvironmentBody, options?: CallOptions): Promise<Environment>;
	/** Get an environment. Never a protected variable's value nor a secret file's contents. A key needs `account:read`. `GET /environments/{environmentId}` */
	getEnvironment(environmentId: string, options?: CallOptions): Promise<Environment>;
	/** Change an environment. Renames it or changes its description. A key needs `account:admin`. `PATCH /environments/{environmentId}` */
	updateEnvironment(environmentId: string, body?: UpdateEnvironmentBody, options?: CallOptions): Promise<Environment>;
	/** Delete an environment. Sandboxes made from it keep what they started with, but their protected variables stop resolving at once. A key needs `account:admin`. `DELETE /environments/{environmentId}` */
	deleteEnvironment(environmentId: string, options?: CallOptions): Promise<void>;
	/** Set an environment variable. Adds or changes a variable. A protected one needs at least one binding, and its value is kept encrypted and never shown again; leave `value` out to change only its bindings. A new value for a protected variable is a rotation: sandboxes keep their placeholders, and their next request carries the new value. Running sandboxes made from it pick the change up at once. Kantel's own names (`KANTEL_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, in any case) are refused. Protected values need the deployment's secrets key (`not_supported` without one). A key needs `account:admin`. `PUT /environments/{environmentId}/variables/{name}` */
	setEnvironmentVariable(
		environmentId: string,
		name: string,
		body?: SetEnvironmentVariableBody,
		options?: CallOptions,
	): Promise<Environment>;
	/** Delete an environment variable. A protected variable stops resolving in the sandboxes made from the environment at once. A key needs `account:admin`. `DELETE /environments/{environmentId}/variables/{name}` */
	deleteEnvironmentVariable(environmentId: string, name: string, options?: CallOptions): Promise<Environment>;
	/** Set a secret file. Adds or replaces a file new sandboxes start with, written once they are running. Its contents are kept encrypted and never shown again; leave `content` out to change only its mode. Needs the deployment's secrets key (`not_supported` without one). A key needs `account:admin`. `PUT /environments/{environmentId}/files` */
	setEnvironmentFile(environmentId: string, body: SetEnvironmentFileBody, options?: CallOptions): Promise<Environment>;
	/** Delete a secret file. Sandboxes made from the environment keep their copy. A key needs `account:admin`. `DELETE /environments/{environmentId}/files` */
	deleteEnvironmentFile(
		environmentId: string,
		query: EnvironmentFileQuery,
		options?: CallOptions,
	): Promise<Environment>;
	/** Set an environment's repositories. Replaces them. New sandboxes clone each once they are running (`git clone --depth 1`), through the egress proxy. A key needs `account:admin`. `PUT /environments/{environmentId}/repos` */
	putEnvironmentRepos(
		environmentId: string,
		body: PutEnvironmentReposBody,
		options?: CallOptions,
	): Promise<Environment>;
	/** Set an environment's egress grants. Replaces them. Running sandboxes made from it pick the change up at once. A key needs `account:admin`. `PUT /environments/{environmentId}/grants` */
	putEnvironmentGrants(environmentId: string, body: PutEgressGrantsBody, options?: CallOptions): Promise<Environment>;
	/** Get a sandbox's egress. Its environment, its protected variables (each placeholder's first 8 characters, never a value), its grants and the newest of its egress log: what its host's proxy let through or refused. A key needs `account:read`. `GET /sandboxes/{sandboxId}/egress` */
	getSandboxEgress(sandboxId: string, query?: SandboxEgressQuery, options?: CallOptions): Promise<SandboxEgress>;
	/** Set a sandbox's egress grants. Replaces its own grants, on top of its environment's. A running sandbox picks them up at once. A key needs `account:admin`. `PUT /sandboxes/{sandboxId}/grants` */
	putSandboxGrants(sandboxId: string, body: PutEgressGrantsBody, options?: CallOptions): Promise<SandboxEgress>;
	/** List templates. The account's templates, oldest first, each with its build. With `baseDigest`, only those built from or pinned to that base. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). `GET /templates` */
	listTemplates(query?: ListTemplatesQuery, options?: CallOptions): Promise<TemplateList>;
	/** Create a template. A template at version 1, named uniquely in the account. Its snapshot builds in the background on each kind of host the account may use; until one is ready, sandboxes made from it boot its image and run its setup themselves. A Dockerfile or image reference is built first, on a host that builds custom images: its sandboxes wait for that build (`unavailable` until then), as nothing else holds the image. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). Idempotent with `options.idempotencyKey`. `POST /templates` */
	createTemplate(body: CreateTemplateBody, options?: CallOptions): Promise<Template>;
	/** Get a template. With its build, and how far behind a pinned base is. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). `GET /templates/{templateId}` */
	getTemplate(templateId: string, options?: CallOptions): Promise<Template>;
	/** Change a template. Renames it or changes its description; a new `spec` makes the next version, which builds in the background. Sandboxes start only from a snapshot of the template's current version, so they boot fresh until it's ready; a Dockerfile's or image reference's wait for the new version's image to build. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). `PATCH /templates/{templateId}` */
	updateTemplate(templateId: string, body?: UpdateTemplateBody, options?: CallOptions): Promise<Template>;
	/** Delete a template. Deletes it, its versions and its built snapshots. Sandboxes made from it keep running. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). `DELETE /templates/{templateId}` */
	deleteTemplate(templateId: string, options?: CallOptions): Promise<void>;
	/** List a template's versions. Newest first. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). `GET /templates/{templateId}/versions` */
	listTemplateVersions(templateId: string, options?: CallOptions): Promise<TemplateVersionList>;
	/** List a template's snapshots. Its built snapshots and builds, newest first, discarded ones included: a cache, not the account's snapshots. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). `GET /templates/{templateId}/snapshots` */
	listTemplateSnapshots(templateId: string, options?: CallOptions): Promise<TemplateSnapshotList>;
	/** Rebuild a template. Builds its snapshots again, failed ones included. A ready one is kept, stale, and sandboxes go on starting from it until its replacement is ready, and after a rebuild that fails; with none, they boot fresh until the new ones are ready, or, for a Dockerfile or image reference, wait for its image to build. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). Idempotent with `options.idempotencyKey`. `POST /templates/{templateId}/rebuild` */
	rebuildTemplate(templateId: string, options?: CallOptions): Promise<Template>;
	/** List base images' channels. Every base channel templates may follow, with the digests it has published. Any signed-in caller. Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). `GET /template-bases` */
	listTemplateBases(options?: CallOptions): Promise<TemplateBaseList>;
	/** Publish a base image's digest. Makes `digest` the channel's current one, made if it is new. Every template following the channel rebuilds in the background; pinned ones don't, and say how far behind they are. A deployment super-admin only (a key needs `hosts:admin`). Experimental: `not_supported` unless the deployment has turned templates on (`KANTEL_TEMPLATES`). `POST /template-bases` */
	publishTemplateBase(body: PublishTemplateBaseBody, options?: CallOptions): Promise<TemplateBaseChannel>;
	/** List events. The account's events, newest first: what webhooks deliver, and a sandbox's history with `sandboxId`. A key needs `sandboxes:read`. `GET /events` */
	listEvents(query?: ListEventsQuery, options?: CallOptions): Promise<EventPage>;
	/** Watch sandboxes live. Server-sent events, one frame each, as the account's sandboxes change state: who changed one makes no difference (the console, the CLI, the API or an SDK, an auto-stop, a host). First a `hello`, then a `sandbox` frame per change, of the sandboxes the caller may see. A comment line every 25 s keeps it open. The server ends it after 10 minutes, or once the caller may no longer watch, and nothing is replayed: reconnect, and read what you show again on each `hello`. A key needs `sandboxes:read`. `GET /events/live` */
	watchEvents(handlers: StreamHandlers<LiveFrame>, query?: AccountScopedQuery, options?: CallOptions): StreamHandle;
	/** List webhooks. A key needs `account:admin`. `GET /webhooks` */
	listWebhooks(query?: AccountScopedQuery, options?: CallOptions): Promise<WebhookList>;
	/** Create a webhook. Its signing secret is answered once. A key needs `account:admin`. Idempotent with `options.idempotencyKey`. `POST /webhooks` */
	createWebhook(body: CreateWebhookBody, options?: CallOptions): Promise<WebhookWithSecret>;
	/** Get a webhook. A key needs `account:admin`. `GET /webhooks/{webhookId}` */
	getWebhook(webhookId: string, options?: CallOptions): Promise<Webhook>;
	/** Change a webhook. A key needs `account:admin`. `PATCH /webhooks/{webhookId}` */
	updateWebhook(webhookId: string, body?: UpdateWebhookBody, options?: CallOptions): Promise<Webhook>;
	/** Delete a webhook. Its queued deliveries are dropped. A key needs `account:admin`. `DELETE /webhooks/{webhookId}` */
	deleteWebhook(webhookId: string, options?: CallOptions): Promise<void>;
	/** Rotate a webhook's signing secret. Deliveries are signed with the new secret from now; one already under way may carry the old signature. A key needs `account:admin`. Idempotent with `options.idempotencyKey`. `POST /webhooks/{webhookId}/rotate` */
	rotateWebhookSecret(webhookId: string, options?: CallOptions): Promise<WebhookWithSecret>;
	/** Send a test delivery. Sends a signed `sandbox.created` event for a made-up sandbox now. A key needs `account:admin`. `POST /webhooks/{webhookId}/test` */
	testWebhook(webhookId: string, options?: CallOptions): Promise<WebhookDelivery>;
	/** List a webhook's deliveries. The last 30 days, newest first. A key needs `account:admin`. `GET /webhooks/{webhookId}/deliveries` */
	listWebhookDeliveries(
		webhookId: string,
		query?: ComputePageQuery,
		options?: CallOptions,
	): Promise<WebhookDeliveryPage>;
	/** Get the OpenTelemetry export. Absent: `not_found`. A key needs `account:admin`. `GET /telemetry` */
	getTelemetry(query?: AccountScopedQuery, options?: CallOptions): Promise<TelemetryExport>;
	/** Set the OpenTelemetry export. Sets or replaces the account's one OTLP/HTTP endpoint, sends an empty export to test it, and answers what the collector said. Header values are kept encrypted and never shown again. A key needs `account:admin`. `PUT /telemetry` */
	putTelemetry(body: PutTelemetryBody, options?: CallOptions): Promise<TelemetryTest>;
	/** Remove the OpenTelemetry export. A key needs `account:admin`. `DELETE /telemetry` */
	deleteTelemetry(query?: AccountScopedQuery, options?: CallOptions): Promise<void>;
	/** List base images. Kantel's base images as the index its build publishes them: each image's latest version on the `stable` channel, its newest versions and what their CVE scans found, and the templates built on them. An index that can't be read is answered as `error`, with no images. A deployment super-admin only (a key needs `hosts:admin`). Experimental: `not_supported` unless the deployment has turned image patching on (`KANTEL_IMAGE_PATCHING`). `GET /admin/hosts/images` */
	listBaseImages(options?: CallOptions): Promise<BaseImageList>;
	/** List hosts. Every host that has joined, revoked ones included. A deployment super-admin only (a key needs `hosts:admin`). `GET /admin/hosts` */
	listHosts(options?: CallOptions): Promise<HostList>;
	/** Make a host join token. A one-use token, shown once, and the one-line command that installs the host agent on a Linux machine and joins it with the token. A deployment super-admin only (a key needs `hosts:admin`). Idempotent with `options.idempotencyKey`. `POST /admin/hosts/join-tokens` */
	createHostJoinToken(body?: CreateHostJoinTokenBody, options?: CallOptions): Promise<HostJoinToken>;
	/** Get a host. A deployment super-admin only (a key needs `hosts:admin`). `GET /admin/hosts/{hostId}` */
	getHost(hostId: string, options?: CallOptions): Promise<Host>;
	/** Get a host's usage. Its CPU, memory and disk as it reported them, every 5 seconds over the last hour. Poll with `since` set to the last point's `at` for only the newer points. A deployment super-admin only (a key needs `hosts:admin`). `GET /admin/hosts/{hostId}/usage` */
	getHostUsage(hostId: string, query?: HostUsageQuery, options?: CallOptions): Promise<HostUsage>;
	/** Change a host. Renames it, replaces its labels, or drains it. A deployment super-admin only (a key needs `hosts:admin`). `PATCH /admin/hosts/{hostId}` */
	updateHost(hostId: string, body?: UpdateHostBody, options?: CallOptions): Promise<Host>;
	/** Update a host's agent. Asks the host to update its host agent to `latestVersion`, which it does when `updateAvailable` says so: it fetches that release's `kantel-host`, checks it against the release's `SHA256SUMS` and restarts into it. Its sandboxes keep running, but connections to them through Kantel (SSH, terminals, ports) drop for the few seconds it takes to connect again. Answers once the host has the new binary, with `updating` set until it connects on it. `conflict` when it's revoked or already up to date, `unavailable` when it isn't connected or the latest release can't be read, and `not_supported` when the host refuses: one in an E2E space is updated on the machine, with `sudo kantel-host update`. A deployment super-admin only (a key needs `hosts:admin`). `POST /admin/hosts/{hostId}/update` */
	updateHostAgent(hostId: string, options?: CallOptions): Promise<Host>;
	/** Revoke a host. Revokes its credential and closes its connection. Its sandboxes keep their disks but can't be reached until it joins again. `unavailable`, and not revoked, when its credential is kept by a part of the deployment that is off (an account's own host, with account hosts switched off). A deployment super-admin only (a key needs `hosts:admin`). `DELETE /admin/hosts/{hostId}` */
	revokeHost(hostId: string, options?: CallOptions): Promise<Host>;
	/** Get the public URL. Where hosts reach this control plane: the address join commands give them, and whether only a host on the same machine could use it. A deployment super-admin only (a key needs `hosts:admin`). `GET /admin/public-url` */
	getPublicUrl(options?: CallOptions): Promise<PublicUrl>;
	/** Set the public URL. Sets where hosts reach this control plane, for the join commands made from now on, ahead of the deployment's own `KANTEL_PUBLIC_URL`. `null` goes back to the deployment's own. Hosts that have joined keep the address they joined with. A deployment super-admin only (a key needs `hosts:admin`). `PUT /admin/public-url` */
	setPublicUrl(body: SetPublicUrlBody, options?: CallOptions): Promise<PublicUrl>;
	/** Make a join token for one of your own hosts. A one-use token, shown once, and the one-line command that installs the host agent on a Linux machine and joins it to the account (the caller's personal account unless `account` names an organisation). The host dials out to this deployment and keeps the connection open, so it needs no inbound port. Once it has joined, the account's new sandboxes go on its own hosts, and no other account's sandboxes ever do. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). Idempotent with `options.idempotencyKey`. `POST /hosts/join-tokens` */
	createAccountJoinToken(body?: CreateAccountJoinTokenBody, options?: CallOptions): Promise<AccountJoinToken>;
	/** List an account's hosts. The hosts joined to the account, revoked ones included. The deployment's shared hosts aren't listed. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `GET /hosts` */
	listAccountHosts(query?: AccountScopedQuery, options?: CallOptions): Promise<HostList>;
	/** Get one of an account's hosts. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `GET /hosts/{hostId}` */
	getAccountHost(hostId: string, options?: CallOptions): Promise<Host>;
	/** Get one of an account's hosts' usage. Its CPU, memory and disk as it reported them, every 5 seconds over the last hour. Poll with `since` set to the last point's `at` for only the newer points. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `GET /hosts/{hostId}/usage` */
	getAccountHostUsage(hostId: string, query?: HostUsageQuery, options?: CallOptions): Promise<HostUsage>;
	/** Change one of an account's hosts. Renames it, replaces its labels, or drains it. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `PATCH /hosts/{hostId}` */
	updateAccountHost(hostId: string, body?: UpdateHostBody, options?: CallOptions): Promise<Host>;
	/** Update the agent of one of an account's hosts. Asks the host to update its host agent to `latestVersion`, which it does when `updateAvailable` says so: it fetches that release's `kantel-host`, checks it against the release's `SHA256SUMS` and restarts into it. Its sandboxes keep running, but connections to them through Kantel (SSH, terminals, ports) drop for the few seconds it takes to connect again. Answers once the host has the new binary, with `updating` set until it connects on it. `conflict` when it's revoked or already up to date, `unavailable` when it isn't connected or the latest release can't be read, and `not_supported` when the host refuses: one in an E2E space is updated on the machine, with `sudo kantel-host update`. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `POST /hosts/{hostId}/update` */
	updateAccountHostAgent(hostId: string, options?: CallOptions): Promise<Host>;
	/** Remove one of an account's hosts. Revokes its credential and closes its connection. Its sandboxes keep their disks but can't be reached until it joins again. Run `sudo kantel-host uninstall` on the machine to take the agent off it. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `DELETE /hosts/{hostId}` */
	removeAccountHost(hostId: string, options?: CallOptions): Promise<Host>;
	/** Upload a bundle. Stores a tar of files once in the account (the caller's personal account unless `account` names an organisation), named by its SHA-256, for sandboxes to mount read-only (`mounts` on create). Uploading a tar the account has already is answered with that bundle (200), and stores nothing again. With `digest`, bytes that don't match are refused. A key needs `sandboxes:write`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `POST /bundles` */
	uploadBundle(body: RawBody, query?: UploadBundleQuery, options?: CallOptions): Promise<Bundle>;
	/** List bundles. The account's bundles, newest first. A key needs `sandboxes:read`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `GET /bundles` */
	listBundles(query?: AccountScopedQuery, options?: CallOptions): Promise<BundleList>;
	/** Get a bundle. A key needs `sandboxes:read`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `GET /bundles/{digest}` */
	getBundle(digest: string, query?: AccountScopedQuery, options?: CallOptions): Promise<Bundle>;
	/** Delete a bundle. Removes it from the account. Refused (`conflict`) while a sandbox of the account that still exists mounts it, stopped ones included, since they mount it again when they start: delete those sandboxes first. A key needs `sandboxes:write`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `DELETE /bundles/{digest}` */
	deleteBundle(digest: string, query?: AccountScopedQuery, options?: CallOptions): Promise<void>;
	/** Create a bucket source. A bucket the account's sandboxes may mount prefixes of (`mounts` on create), with the credentials that read it. The credentials are kept encrypted and never shown again; only the host of a sandbox that mounts the bucket is given them, and never the sandbox. Credentials need the deployment's secrets key (`not_supported` without one). A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). Idempotent with `options.idempotencyKey`. `POST /bucket-sources` */
	createBucketSource(body: CreateBucketSourceBody, options?: CallOptions): Promise<BucketSource>;
	/** List bucket sources. The account's bucket sources, oldest first. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `GET /bucket-sources` */
	listBucketSources(query?: AccountScopedQuery, options?: CallOptions): Promise<BucketSourceList>;
	/** Get a bucket source. Never its credentials. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `GET /bucket-sources/{bucketSourceId}` */
	getBucketSource(bucketSourceId: string, options?: CallOptions): Promise<BucketSource>;
	/** Delete a bucket source. Removes it and its credentials. Refused (`conflict`) while a sandbox of the account that still exists mounts it, stopped ones included: delete those sandboxes first. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned mounts on (`KANTEL_MOUNTS=experimental`). `DELETE /bucket-sources/{bucketSourceId}` */
	deleteBucketSource(bucketSourceId: string, options?: CallOptions): Promise<void>;
}

/** A client for Kantel's public API over `fetch`. */
export function createKantelClient(options: KantelClientOptions): KantelClient {
	return {
		embedBrowserSession: (sessionId, browserSessionId, body, callOptions) =>
			send(
				options,
				{
					method: "POST",
					path: `/sessions/${encodeURIComponent(sessionId)}/browsers/${encodeURIComponent(browserSessionId)}/embed`,
					body,
				},
				callOptions,
			),
		createProject: (body, callOptions) => send(options, { method: "POST", path: "/projects", body }, callOptions),
		getCaller: (callOptions) => send(options, { method: "GET", path: "/whoami" }, callOptions),
		listAccounts: (callOptions) => send(options, { method: "GET", path: "/accounts" }, callOptions),
		createOrganisation: (body, callOptions) =>
			send(options, { method: "POST", path: "/accounts", body, idempotent: true }, callOptions),
		joinOrganisation: (body, callOptions) =>
			send(options, { method: "POST", path: "/accounts/join", body }, callOptions),
		getAccount: (accountId, callOptions) =>
			send(options, { method: "GET", path: `/accounts/${encodeURIComponent(accountId)}` }, callOptions),
		updateAccount: (accountId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/accounts/${encodeURIComponent(accountId)}`, body }, callOptions),
		deleteOrganisation: (accountId, callOptions) =>
			send(options, { method: "DELETE", path: `/accounts/${encodeURIComponent(accountId)}` }, callOptions),
		getAccountUsage: (accountId, query, callOptions) =>
			send(options, { method: "GET", path: `/accounts/${encodeURIComponent(accountId)}/usage`, query }, callOptions),
		listMembers: (accountId, callOptions) =>
			send(options, { method: "GET", path: `/accounts/${encodeURIComponent(accountId)}/members` }, callOptions),
		updateMember: (accountId, userId, body, callOptions) =>
			send(
				options,
				{
					method: "PATCH",
					path: `/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(userId)}`,
					body,
				},
				callOptions,
			),
		removeMember: (accountId, userId, callOptions) =>
			send(
				options,
				{ method: "DELETE", path: `/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(userId)}` },
				callOptions,
			),
		listInvites: (accountId, callOptions) =>
			send(options, { method: "GET", path: `/accounts/${encodeURIComponent(accountId)}/invites` }, callOptions),
		createInvite: (accountId, body = {}, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/accounts/${encodeURIComponent(accountId)}/invites`, body, idempotent: true },
				callOptions,
			),
		revokeInvite: (accountId, inviteId, callOptions) =>
			send(
				options,
				{
					method: "DELETE",
					path: `/accounts/${encodeURIComponent(accountId)}/invites/${encodeURIComponent(inviteId)}`,
				},
				callOptions,
			),
		listSandboxes: (query, callOptions) => send(options, { method: "GET", path: "/sandboxes", query }, callOptions),
		getSandboxShapes: (query, callOptions) =>
			send(options, { method: "GET", path: "/sandbox-shapes", query }, callOptions),
		createSandbox: (body = {}, callOptions) =>
			send(options, { method: "POST", path: "/sandboxes", body, idempotent: true }, callOptions),
		getSandbox: (sandboxId, callOptions) =>
			send(options, { method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}` }, callOptions),
		updateSandbox: (sandboxId, body = {}, callOptions) =>
			send(
				options,
				{ method: "PATCH", path: `/sandboxes/${encodeURIComponent(sandboxId)}`, body, idempotent: true },
				callOptions,
			),
		startSandbox: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/start`, body }, callOptions),
		stopSandbox: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/stop`, body }, callOptions),
		resumeSandbox: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/resume`, body }, callOptions),
		forkSandbox: (sandboxId, body = {}, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/fork`, body, idempotent: true },
				callOptions,
			),
		recoverSandbox: (sandboxId, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/recover`, idempotent: true },
				callOptions,
			),
		restartSandboxOnLatest: (sandboxId, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/restart-on-latest`, idempotent: true },
				callOptions,
			),
		deleteSandbox: (sandboxId, callOptions) =>
			send(
				options,
				{ method: "DELETE", path: `/sandboxes/${encodeURIComponent(sandboxId)}`, idempotent: true },
				callOptions,
			),
		getSandboxUsage: (sandboxId, query, callOptions) =>
			send(options, { method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}/usage`, query }, callOptions),
		runCommand: (sandboxId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/commands`, body, idempotent: true },
				callOptions,
			),
		listCommands: (sandboxId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}/commands`, query },
				callOptions,
			),
		getCommand: (sandboxId, commandId, callOptions) =>
			send(
				options,
				{
					method: "GET",
					path: `/sandboxes/${encodeURIComponent(sandboxId)}/commands/${encodeURIComponent(commandId)}`,
				},
				callOptions,
			),
		killCommand: (sandboxId, commandId, callOptions) =>
			send(
				options,
				{
					method: "DELETE",
					path: `/sandboxes/${encodeURIComponent(sandboxId)}/commands/${encodeURIComponent(commandId)}`,
				},
				callOptions,
			),
		readFile: (sandboxId, query, callOptions) =>
			send(options, { method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}/files`, query }, callOptions),
		writeFile: (sandboxId, body, callOptions) =>
			send(options, { method: "PUT", path: `/sandboxes/${encodeURIComponent(sandboxId)}/files`, body }, callOptions),
		deleteFile: (sandboxId, query, callOptions) =>
			send(
				options,
				{ method: "DELETE", path: `/sandboxes/${encodeURIComponent(sandboxId)}/files`, query },
				callOptions,
			),
		listFiles: (sandboxId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}/files/list`, query },
				callOptions,
			),
		createUploadUrl: (sandboxId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/files/upload-url`, body },
				callOptions,
			),
		createDownloadUrl: (sandboxId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/files/download-url`, body },
				callOptions,
			),
		extractArchive: (sandboxId, body, query, callOptions) =>
			send(
				options,
				{
					method: "PUT",
					path: `/sandboxes/${encodeURIComponent(sandboxId)}/files/archive`,
					query,
					raw: { body, type: "application/x-tar" },
				},
				callOptions,
			),
		listPorts: (sandboxId, callOptions) =>
			send(options, { method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}/ports` }, callOptions),
		exposePort: (sandboxId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/ports`, body, idempotent: true },
				callOptions,
			),
		hidePort: (sandboxId, port, callOptions) =>
			send(
				options,
				{ method: "DELETE", path: `/sandboxes/${encodeURIComponent(sandboxId)}/ports/${encodeURIComponent(port)}` },
				callOptions,
			),
		openSsh: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/ssh`, body }, callOptions),
		openDesktop: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/desktop`, body }, callOptions),
		openBrowser: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/browser`, body }, callOptions),
		openE2E: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/e2e`, body }, callOptions),
		getE2EChain: (accountId, callOptions) =>
			send(options, { method: "GET", path: `/accounts/${encodeURIComponent(accountId)}/e2e/chain` }, callOptions),
		appendE2EChain: (accountId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/accounts/${encodeURIComponent(accountId)}/e2e/chain`, body },
				callOptions,
			),
		listSnapshots: (query, callOptions) => send(options, { method: "GET", path: "/snapshots", query }, callOptions),
		takeSnapshot: (sandboxId, body = {}, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, body, idempotent: true },
				callOptions,
			),
		saveSnapshot: (body, callOptions) =>
			send(options, { method: "POST", path: "/snapshots", body, idempotent: true }, callOptions),
		getSnapshot: (snapshotId, callOptions) =>
			send(options, { method: "GET", path: `/snapshots/${encodeURIComponent(snapshotId)}` }, callOptions),
		listSnapshotFiles: (snapshotId, query, callOptions) =>
			send(options, { method: "GET", path: `/snapshots/${encodeURIComponent(snapshotId)}/files`, query }, callOptions),
		readSnapshotFile: (snapshotId, query, callOptions) =>
			send(options, { method: "GET", path: `/snapshots/${encodeURIComponent(snapshotId)}/file`, query }, callOptions),
		deleteSnapshot: (snapshotId, callOptions) =>
			send(options, { method: "DELETE", path: `/snapshots/${encodeURIComponent(snapshotId)}` }, callOptions),
		listApiKeys: (query, callOptions) => send(options, { method: "GET", path: "/api-keys", query }, callOptions),
		createApiKey: (body, callOptions) =>
			send(options, { method: "POST", path: "/api-keys", body, idempotent: true }, callOptions),
		getApiKey: (apiKeyId, callOptions) =>
			send(options, { method: "GET", path: `/api-keys/${encodeURIComponent(apiKeyId)}` }, callOptions),
		rotateApiKey: (apiKeyId, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/api-keys/${encodeURIComponent(apiKeyId)}/rotate`, idempotent: true },
				callOptions,
			),
		revokeApiKey: (apiKeyId, callOptions) =>
			send(options, { method: "DELETE", path: `/api-keys/${encodeURIComponent(apiKeyId)}` }, callOptions),
		startDeviceLogin: (body = {}, callOptions) =>
			send(options, { method: "POST", path: "/auth/device", body }, callOptions),
		pollDeviceLogin: (body, callOptions) =>
			send(options, { method: "POST", path: "/auth/device/token", body }, callOptions),
		getDeviceLogin: (userCode, callOptions) =>
			send(options, { method: "GET", path: `/auth/device/${encodeURIComponent(userCode)}` }, callOptions),
		approveDeviceLogin: (userCode, body = {}, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/auth/device/${encodeURIComponent(userCode)}/approve`, body },
				callOptions,
			),
		denyDeviceLogin: (userCode, callOptions) =>
			send(options, { method: "POST", path: `/auth/device/${encodeURIComponent(userCode)}/deny` }, callOptions),
		getProxySettings: (query, callOptions) => send(options, { method: "GET", path: "/proxy", query }, callOptions),
		putProxySettings: (body, callOptions) => send(options, { method: "PUT", path: "/proxy", body }, callOptions),
		listEnvironments: (query, callOptions) =>
			send(options, { method: "GET", path: "/environments", query }, callOptions),
		createEnvironment: (body, callOptions) =>
			send(options, { method: "POST", path: "/environments", body, idempotent: true }, callOptions),
		getEnvironment: (environmentId, callOptions) =>
			send(options, { method: "GET", path: `/environments/${encodeURIComponent(environmentId)}` }, callOptions),
		updateEnvironment: (environmentId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/environments/${encodeURIComponent(environmentId)}`, body }, callOptions),
		deleteEnvironment: (environmentId, callOptions) =>
			send(options, { method: "DELETE", path: `/environments/${encodeURIComponent(environmentId)}` }, callOptions),
		setEnvironmentVariable: (environmentId, name, body = {}, callOptions) =>
			send(
				options,
				{
					method: "PUT",
					path: `/environments/${encodeURIComponent(environmentId)}/variables/${encodeURIComponent(name)}`,
					body,
				},
				callOptions,
			),
		deleteEnvironmentVariable: (environmentId, name, callOptions) =>
			send(
				options,
				{
					method: "DELETE",
					path: `/environments/${encodeURIComponent(environmentId)}/variables/${encodeURIComponent(name)}`,
				},
				callOptions,
			),
		setEnvironmentFile: (environmentId, body, callOptions) =>
			send(
				options,
				{ method: "PUT", path: `/environments/${encodeURIComponent(environmentId)}/files`, body },
				callOptions,
			),
		deleteEnvironmentFile: (environmentId, query, callOptions) =>
			send(
				options,
				{ method: "DELETE", path: `/environments/${encodeURIComponent(environmentId)}/files`, query },
				callOptions,
			),
		putEnvironmentRepos: (environmentId, body, callOptions) =>
			send(
				options,
				{ method: "PUT", path: `/environments/${encodeURIComponent(environmentId)}/repos`, body },
				callOptions,
			),
		putEnvironmentGrants: (environmentId, body, callOptions) =>
			send(
				options,
				{ method: "PUT", path: `/environments/${encodeURIComponent(environmentId)}/grants`, body },
				callOptions,
			),
		getSandboxEgress: (sandboxId, query, callOptions) =>
			send(options, { method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}/egress`, query }, callOptions),
		putSandboxGrants: (sandboxId, body, callOptions) =>
			send(options, { method: "PUT", path: `/sandboxes/${encodeURIComponent(sandboxId)}/grants`, body }, callOptions),
		listTemplates: (query, callOptions) => send(options, { method: "GET", path: "/templates", query }, callOptions),
		createTemplate: (body, callOptions) =>
			send(options, { method: "POST", path: "/templates", body, idempotent: true }, callOptions),
		getTemplate: (templateId, callOptions) =>
			send(options, { method: "GET", path: `/templates/${encodeURIComponent(templateId)}` }, callOptions),
		updateTemplate: (templateId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/templates/${encodeURIComponent(templateId)}`, body }, callOptions),
		deleteTemplate: (templateId, callOptions) =>
			send(options, { method: "DELETE", path: `/templates/${encodeURIComponent(templateId)}` }, callOptions),
		listTemplateVersions: (templateId, callOptions) =>
			send(options, { method: "GET", path: `/templates/${encodeURIComponent(templateId)}/versions` }, callOptions),
		listTemplateSnapshots: (templateId, callOptions) =>
			send(options, { method: "GET", path: `/templates/${encodeURIComponent(templateId)}/snapshots` }, callOptions),
		rebuildTemplate: (templateId, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/templates/${encodeURIComponent(templateId)}/rebuild`, idempotent: true },
				callOptions,
			),
		listTemplateBases: (callOptions) => send(options, { method: "GET", path: "/template-bases" }, callOptions),
		publishTemplateBase: (body, callOptions) =>
			send(options, { method: "POST", path: "/template-bases", body }, callOptions),
		listEvents: (query, callOptions) => send(options, { method: "GET", path: "/events", query }, callOptions),
		watchEvents: (handlers, query, callOptions) =>
			openStream(options, { method: "GET", path: "/events/live", query, events: true }, handlers, callOptions),
		listWebhooks: (query, callOptions) => send(options, { method: "GET", path: "/webhooks", query }, callOptions),
		createWebhook: (body, callOptions) =>
			send(options, { method: "POST", path: "/webhooks", body, idempotent: true }, callOptions),
		getWebhook: (webhookId, callOptions) =>
			send(options, { method: "GET", path: `/webhooks/${encodeURIComponent(webhookId)}` }, callOptions),
		updateWebhook: (webhookId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/webhooks/${encodeURIComponent(webhookId)}`, body }, callOptions),
		deleteWebhook: (webhookId, callOptions) =>
			send(options, { method: "DELETE", path: `/webhooks/${encodeURIComponent(webhookId)}` }, callOptions),
		rotateWebhookSecret: (webhookId, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/webhooks/${encodeURIComponent(webhookId)}/rotate`, idempotent: true },
				callOptions,
			),
		testWebhook: (webhookId, callOptions) =>
			send(options, { method: "POST", path: `/webhooks/${encodeURIComponent(webhookId)}/test` }, callOptions),
		listWebhookDeliveries: (webhookId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/webhooks/${encodeURIComponent(webhookId)}/deliveries`, query },
				callOptions,
			),
		getTelemetry: (query, callOptions) => send(options, { method: "GET", path: "/telemetry", query }, callOptions),
		putTelemetry: (body, callOptions) => send(options, { method: "PUT", path: "/telemetry", body }, callOptions),
		deleteTelemetry: (query, callOptions) =>
			send(options, { method: "DELETE", path: "/telemetry", query }, callOptions),
		listBaseImages: (callOptions) => send(options, { method: "GET", path: "/admin/hosts/images" }, callOptions),
		listHosts: (callOptions) => send(options, { method: "GET", path: "/admin/hosts" }, callOptions),
		createHostJoinToken: (body = {}, callOptions) =>
			send(options, { method: "POST", path: "/admin/hosts/join-tokens", body, idempotent: true }, callOptions),
		getHost: (hostId, callOptions) =>
			send(options, { method: "GET", path: `/admin/hosts/${encodeURIComponent(hostId)}` }, callOptions),
		getHostUsage: (hostId, query, callOptions) =>
			send(options, { method: "GET", path: `/admin/hosts/${encodeURIComponent(hostId)}/usage`, query }, callOptions),
		updateHost: (hostId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/admin/hosts/${encodeURIComponent(hostId)}`, body }, callOptions),
		updateHostAgent: (hostId, callOptions) =>
			send(options, { method: "POST", path: `/admin/hosts/${encodeURIComponent(hostId)}/update` }, callOptions),
		revokeHost: (hostId, callOptions) =>
			send(options, { method: "DELETE", path: `/admin/hosts/${encodeURIComponent(hostId)}` }, callOptions),
		getPublicUrl: (callOptions) => send(options, { method: "GET", path: "/admin/public-url" }, callOptions),
		setPublicUrl: (body, callOptions) => send(options, { method: "PUT", path: "/admin/public-url", body }, callOptions),
		createAccountJoinToken: (body = {}, callOptions) =>
			send(options, { method: "POST", path: "/hosts/join-tokens", body, idempotent: true }, callOptions),
		listAccountHosts: (query, callOptions) => send(options, { method: "GET", path: "/hosts", query }, callOptions),
		getAccountHost: (hostId, callOptions) =>
			send(options, { method: "GET", path: `/hosts/${encodeURIComponent(hostId)}` }, callOptions),
		getAccountHostUsage: (hostId, query, callOptions) =>
			send(options, { method: "GET", path: `/hosts/${encodeURIComponent(hostId)}/usage`, query }, callOptions),
		updateAccountHost: (hostId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/hosts/${encodeURIComponent(hostId)}`, body }, callOptions),
		updateAccountHostAgent: (hostId, callOptions) =>
			send(options, { method: "POST", path: `/hosts/${encodeURIComponent(hostId)}/update` }, callOptions),
		removeAccountHost: (hostId, callOptions) =>
			send(options, { method: "DELETE", path: `/hosts/${encodeURIComponent(hostId)}` }, callOptions),
		uploadBundle: (body, query, callOptions) =>
			send(options, { method: "POST", path: "/bundles", query, raw: { body, type: "application/x-tar" } }, callOptions),
		listBundles: (query, callOptions) => send(options, { method: "GET", path: "/bundles", query }, callOptions),
		getBundle: (digest, query, callOptions) =>
			send(options, { method: "GET", path: `/bundles/${encodeURIComponent(digest)}`, query }, callOptions),
		deleteBundle: (digest, query, callOptions) =>
			send(options, { method: "DELETE", path: `/bundles/${encodeURIComponent(digest)}`, query }, callOptions),
		createBucketSource: (body, callOptions) =>
			send(options, { method: "POST", path: "/bucket-sources", body, idempotent: true }, callOptions),
		listBucketSources: (query, callOptions) =>
			send(options, { method: "GET", path: "/bucket-sources", query }, callOptions),
		getBucketSource: (bucketSourceId, callOptions) =>
			send(options, { method: "GET", path: `/bucket-sources/${encodeURIComponent(bucketSourceId)}` }, callOptions),
		deleteBucketSource: (bucketSourceId, callOptions) =>
			send(options, { method: "DELETE", path: `/bucket-sources/${encodeURIComponent(bucketSourceId)}` }, callOptions),
	};
}
