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

/** What a key may do. `sandboxes:read`: list and inspect sandboxes, their usage and events. `sandboxes:write`: create, change, start, stop, pause, resume, fork and recover. `sandboxes:delete`: delete for good. `exec`: run commands. `files`: read and write files. `access`: SSH, desktop, browser and public ports. `snapshots:read`, `snapshots:write`: snapshots and saved snapshots. `account:read`: the account, its members, keys, environments and sandboxes' egress. `account:admin`: members, keys, webhooks, telemetry, the proxy, environments and sandboxes' grants. `hosts:admin`: the deployment's hosts, for a super-admin's key only. */
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

export interface BrowserAccess {
	/** Watch and drive the sandbox's Chromium in a browser. */
	readonly url: string;
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

/** Who is calling, the accounts they may act in, and the deployment's mode. */
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
	/** Its output so far, up to 1 MiB; `truncated` says if there was more. */
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
	/** What a new sandbox gets. A shape off the hosts' presets boots from scratch where a preset may come from a host's warm pool. */
	readonly resources?: SandboxShapeInput;
	/** A microVM's base image. Default: the deployment's. */
	readonly image?: string;
	/** Start from this snapshot: a snapshot's ID or a saved snapshot's name in the account. */
	readonly from?: string;
	/** Default 60. `null`: never stop by itself. */
	readonly autoStopMinutes?: number | null;
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
	/** Place it only on a host with each label, such as `{ site: "home" }`. */
	readonly hostLabels?: {
		readonly [key: string]: string;
	};
	/** Answer once it is `running` (or `error`) rather than as soon as it is placed. */
	readonly wait?: boolean;
}

export interface CreateWebhookBody {
	/** The account to act in: the caller's personal account (the default for a person) or an organisation they belong to. An API key always acts in its own account, and naming another is `forbidden`. */
	readonly account?: string;
	readonly name: string;
	/** HTTPS; a self-hosted install may allow `http://` to a private address. */
	readonly url: string;
	readonly events: readonly EventType[];
}

export interface CustomDiskStep {
	readonly memoryMb: number;
	readonly diskGb: number;
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
	/** `sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call or its auto-stop), or paused. `sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; `sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason says which), which leaves it running. `sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted. */
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
	readonly actor?: CreatedBy;
}

export interface EventPage {
	readonly items: readonly Event[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** `sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call or its auto-stop), or paused. `sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; `sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason says which), which leaves it running. `sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted. */
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

/** A machine that runs sandboxes. It dials out to the control plane; it takes no inbound ports. */
export interface Host {
	/** The host's ID, such as `host_6t5r4e`. */
	readonly id: string;
	readonly name: string;
	/** `online`: connected and taking sandboxes. `unreachable`: its connection dropped; its sandboxes can't be reached until it is back. `draining`: connected, but takes no new sandboxes. `revoked`: its credential is revoked. */
	readonly state: HostState;
	/** Its host agent's version. */
	readonly version?: string;
	/** The newest version the control plane offers. */
	readonly latestVersion?: string;
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
	/** The warm machines it keeps ready, by `<type>/<size>`: its own setting, else the deployment's. Empty: none. */
	readonly pools?: {
		readonly [key: string]: number;
	};
	/** The account the host belongs to, when it was added to one by its people: only that account's sandboxes run on it. Absent for a host the deployment's super-admin joined, which any account's sandboxes may use. */
	readonly accountId?: string;
	/** Epoch milliseconds, UTC. */
	readonly joinedAt: number;
	/** Epoch milliseconds, UTC. */
	readonly lastSeenAt?: number;
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

/** Warm machines the host keeps ready, by `<type>/<size>`, such as `{"microvm/default": 1}`: a create of that shape is then a restore. They hold memory while idle, so a host keeps none unless asked. `null`: the deployment's default (none unless its operator set `KANTEL_COMPUTE_POOLS`). */
export type HostPools = {
	readonly [key: string]: number;
} | null;

/** `online`: connected and taking sandboxes. `unreachable`: its connection dropped; its sandboxes can't be reached until it is back. `draining`: connected, but takes no new sandboxes. `revoked`: its credential is revoked. */
export type HostState = "online" | "unreachable" | "draining" | "revoked";

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
	/** `sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call or its auto-stop), or paused. `sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; `sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason says which), which leaves it running. `sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted. */
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
	/** Each shape a host makes by name. Hosts may give one name different shapes: each is its own entry, warm only where a host keeps that very shape warm. */
	readonly presets: readonly ShapePreset[];
	/** Whether a host takes shapes off the presets; when false, only the presets. */
	readonly custom: boolean;
	/** The disk a shape off the presets gets: the first step, by memory, with at least its memory, else the last. Only where every host that makes such shapes gives the same; absent where it depends on the host. */
	readonly customDisk?: readonly CustomDiskStep[];
}

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
	/** Default 30 000; at most 600 000 (10 minutes). */
	readonly timeoutMs?: number;
	/** Start it and answer at once, with no time limit; read it back by its ID. */
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
	readonly resources?: SandboxResources;
	/** The base image a microVM was made from, such as `ubuntu-24.04`. */
	readonly image?: string;
	/** `starting`: being placed and booted. `running`: commands run now. `stopping`: its disk is being saved. `stopped`: no machine; its disk is kept as its newest snapshot, and running programs are gone. `paused`: like `stopped`, but its memory is kept too, so `resume` carries on where it left off (microVMs only). `error`: the last operation failed or the machine was lost; `recover` or `resume` it. `deleting`, `deleted`: erased for good, with its snapshots. */
	readonly state: SandboxState;
	/** `degraded`: the machine is up but its host can't fully reach it; it keeps running. */
	readonly health?: SandboxHealth;
	/** Why it is in `error` or `degraded`, in words. */
	readonly reason?: string;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly visibility: SandboxVisibility;
	/** What this sandbox can do, from its type and its host. */
	readonly capabilities: SandboxCapabilities;
	/** The caller's own labels. */
	readonly labels: {
		readonly [key: string]: string;
	};
	/** How long after a start or resume it stops by itself; `null` never. */
	readonly autoStopMinutes: number | null;
	/** When it will stop by itself, while running; the console's stops-in. */
	readonly stopsAt?: number;
	/** The snapshot a resume or fork would use. */
	readonly latestSnapshotId?: string;
	/** What it was made from. */
	readonly source?: SandboxSource;
	/** The environment it was made from. */
	readonly environmentId?: string;
	/** Its own egress grants, on top of its environment's. */
	readonly grants: readonly EgressGrant[];
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
	/** The host it runs on; only a super-admin is shown it. */
	readonly hostId?: string;
}

/** What this sandbox can do, from its type and its host. */
export interface SandboxCapabilities {
	readonly exec: boolean;
	readonly files: boolean;
	readonly ssh: boolean;
	readonly desktop: boolean;
	readonly browser: boolean;
	readonly ports: boolean;
	readonly docker: boolean;
	/** `/dev/kvm` inside, for nested virtualisation. */
	readonly kvm: boolean;
	/** Whether it can be paused with its memory kept. */
	readonly pause: boolean;
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

/** What a new sandbox gets. A shape off the hosts' presets boots from scratch where a preset may come from a host's warm pool. */
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
}

export interface SandboxUsagePoint {
	/** Epoch milliseconds, UTC. */
	readonly at: number;
	/** CPU utilisation over the interval. */
	readonly cpu: number;
	readonly memoryMb: number;
	readonly runningSeconds: number;
	readonly cost: number;
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

export interface ShapePreset {
	/** A microVM's named size; a deployment may offer fewer. Isolates have none. Superseded by `resources` on create: a named size is still taken for now. */
	readonly name: SandboxSizeName;
	readonly vcpus: number;
	readonly memoryMb: number;
	readonly diskGb: number;
	/** A host the account may use keeps machines of it ready (a warm pool); off by default. */
	readonly warm: boolean;
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
	readonly sizeBytes?: number;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly expiresAt?: number;
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

/** Where an account's telemetry goes: sandbox metrics (`kantel.sandbox.running`, `kantel.sandbox.cpu.seconds`, `kantel.sandbox.cost`, …) every 60 seconds, and each lifecycle event as an OTLP log record when it happens. */
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
	/** Where an account's telemetry goes: sandbox metrics (`kantel.sandbox.running`, `kantel.sandbox.cpu.seconds`, `kantel.sandbox.cost`, …) every 60 seconds, and each lifecycle event as an OTLP log record when it happens. */
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
	/** Warm machines the host keeps ready, by `<type>/<size>`, such as `{"microvm/default": 1}`: a create of that shape is then a restore. They hold memory while idle, so a host keeps none unless asked. `null`: the deployment's default (none unless its operator set `KANTEL_COMPUTE_POOLS`). */
	readonly pools?: HostPools;
}

export interface UpdateMemberBody {
	/** `member`: uses the organisation's shared sandboxes and snapshots and makes their own. `admin`: also manages members, API keys, webhooks, telemetry and the proxy. `owner`: also renames or deletes the organisation. A personal account's person is its `owner`. */
	readonly role: MemberRole;
}

export interface UpdateSandboxBody {
	readonly name?: string;
	readonly autoStopMinutes?: number | null;
	/** Move `stopsAt` to this long from now. */
	readonly extendMinutes?: number;
	/** `private`: only the person who made it (and API keys of theirs) may see or use it. `organisation`: every member of its organisation may. A personal account's sandboxes are always `private`. */
	readonly visibility?: SandboxVisibility;
	/** Replaces its labels. */
	readonly labels?: {
		readonly [key: string]: string;
	};
}

export interface UpdateWebhookBody {
	readonly name?: string;
	readonly url?: string;
	readonly events?: readonly EventType[];
	readonly enabled?: boolean;
}

export interface UsageQuery {
	/** From this time; default 24 hours ago. */
	readonly since?: number;
	/** Default 300. */
	readonly intervalSeconds?: number;
}

export interface UsageSummary {
	readonly runningSeconds: number;
	readonly cpuSeconds: number;
	/** CPU utilisation, 0 to 1, over the last 24 intervals of 5 minutes, oldest first: a sparkline. */
	readonly recentCpu: readonly number[];
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
	/** `sandbox.created`: made, before it runs. `sandbox.running`: it runs commands now, after a create, resume, fork or recovery. `sandbox.stopped`, `sandbox.paused`: it stopped (by a call or its auto-stop), or paused. `sandbox.error`: it entered `error`. `sandbox.degraded`, `sandbox.recovered`: its host lost and regained it; `sandbox.degraded` also when its environment's secret file or repository couldn't be set up (its reason says which), which leaves it running. `sandbox.deleted`: erased. `snapshot.saved`, `snapshot.deleted`: a saved snapshot was made or deleted. */
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
	/** The socket closed, by either side. Reconnect with `{ after: handle.cursor }` to resume. */
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
	 * call's answer and does nothing again; while the first call is still working, a retry may be `conflict`. Use a new key,
	 * such as a UUID, for each new call.
	 */
	readonly idempotencyKey?: string;
	readonly headers?: { readonly [name: string]: string };
}

/** An error Kantel answered with: its KantelError code (or `unauthenticated`), message and HTTP status. */
export class KantelApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: { readonly [key: string]: unknown };
	constructor(status: number, code: string, message: string, details?: { readonly [key: string]: unknown }) {
		super(message);
		this.name = "KantelApiError";
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

/** One call, as the generated methods describe it. */
export interface ApiCall {
	readonly method: string;
	/** Relative to the base URL, with path parameters already encoded. */
	readonly path: string;
	/** Query parameters; a record value, such as `label`, is sent as `label.<key>=<value>`. */
	readonly query?: object;
	readonly body?: unknown;
	readonly headers?: { readonly [name: string]: string | undefined };
	/** The answer is bytes, such as an image, not JSON: the call resolves with a `Blob`. */
	readonly binary?: boolean;
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
	if (callOptions.requestId !== undefined) headers["kantel-request-id"] = callOptions.requestId;
	if (callOptions.idempotencyKey !== undefined) headers["idempotency-key"] = callOptions.idempotencyKey;
	for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
	Object.assign(headers, callOptions.headers ?? {});
	const doFetch = options.fetch ?? fetch;
	const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}${call.path}${queryString(call.query)}`, {
		method: call.method,
		headers,
		...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
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

/** Opens a stream route's WebSocket and hands each message's frames to `handlers`. */
export function openStream<Frame>(
	options: KantelClientOptions,
	call: ApiCall,
	handlers: StreamHandlers<Frame>,
	callOptions: CallOptions = {},
): StreamHandle {
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
	/** Who is calling. The person or key calling, the accounts they may act in (their personal account first), and the deployment's mode. Any key may call it. `GET /whoami` */
	getCaller(options?: CallOptions): Promise<Caller>;
	/** List accounts. The caller's personal account and every organisation they belong to; for a key, its own account. A key needs `account:read`. `GET /accounts` */
	listAccounts(options?: CallOptions): Promise<AccountList>;
	/** Create an organisation. Makes an organisation account with the caller as its owner. People only: a key is refused. `POST /accounts` */
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
	/** Invite someone to an organisation. Makes a join code, shown once, for one person or for anyone holding it; needs admin. A key needs `account:admin`. `POST /accounts/{accountId}/invites` */
	createInvite(accountId: string, body?: CreateInviteBody, options?: CallOptions): Promise<Invite>;
	/** Revoke an invite. A key needs `account:admin`. `DELETE /accounts/{accountId}/invites/{inviteId}` */
	revokeInvite(accountId: string, inviteId: string, options?: CallOptions): Promise<void>;
	/** List sandboxes. The account's sandboxes the caller may see, newest first: by default the ones starting, running or stopping; `all` adds stopped, paused and errored ones. Deleted ones are left out. A key needs `sandboxes:read`. `GET /sandboxes` */
	listSandboxes(query?: ListSandboxesQuery, options?: CallOptions): Promise<SandboxPage>;
	/** Get the shapes a sandbox may be. What a new sandbox in the account may be, from the hosts it may use: an isolate's memory, a microVM's vCPUs and memory, the hosts' presets (and which a host keeps warm) and what an hour costs. A key needs `sandboxes:read`. `GET /sandbox-shapes` */
	getSandboxShapes(query?: AccountScopedQuery, options?: CallOptions): Promise<SandboxShapes>;
	/** Create a sandbox. Makes a sandbox and starts it: an isolate unless `type` says `microvm`, from a snapshot when `from` names one. `resources` sets its vCPUs and memory (`getSandboxShapes` says what may be asked); `size`, a named size, still works for now. Answers as soon as it is placed (`starting`), or once it runs with `wait`. A full deployment is `exhausted`; no host able to run the type is `unavailable`. A key needs `sandboxes:write`. Idempotent with `options.idempotencyKey`. `POST /sandboxes` */
	createSandbox(body?: CreateSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Get a sandbox. A key needs `sandboxes:read`. `GET /sandboxes/{sandboxId}` */
	getSandbox(sandboxId: string, options?: CallOptions): Promise<Sandbox>;
	/** Change a sandbox. Renames it, changes its auto-stop or moves its stop time (`extendMinutes`), shares it with its organisation or makes it private again, or replaces its labels. A key needs `sandboxes:write`. `PATCH /sandboxes/{sandboxId}` */
	updateSandbox(sandboxId: string, body?: UpdateSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Start a sandbox. Boots a stopped, paused or errored sandbox fresh from its newest disk snapshot: programs start again, and a paused sandbox's memory is let go. To carry on where a paused sandbox left off, `resume` it instead. A running sandbox is answered as it is. A key needs `sandboxes:write`. `POST /sandboxes/{sandboxId}/start` */
	startSandbox(sandboxId: string, body?: ResumeSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Stop or pause a sandbox. Saves its disk as a snapshot and lets the machine go; running programs end. With `keepMemory`, pauses it instead, keeping its memory too (microVMs only; `not_supported` on an isolate). A stopped sandbox costs nothing to run. A key needs `sandboxes:write`. `POST /sandboxes/{sandboxId}/stop` */
	stopSandbox(sandboxId: string, body?: StopSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Resume a sandbox. Carries on a paused sandbox from its memory, or starts a stopped one from its newest snapshot, on the same size or the one given. Same ID; a new machine. A key needs `sandboxes:write`. `POST /sandboxes/{sandboxId}/resume` */
	resumeSandbox(sandboxId: string, body?: ResumeSandboxBody, options?: CallOptions): Promise<Sandbox>;
	/** Fork a sandbox. Makes `count` new sandboxes, each a copy of this one's newest snapshot (or `snapshotId`); a running microVM on a host that can fork live is copied with its memory. The source doesn't change. A key needs `sandboxes:write`. Idempotent with `options.idempotencyKey`. `POST /sandboxes/{sandboxId}/fork` */
	forkSandbox(sandboxId: string, body?: ForkSandboxBody, options?: CallOptions): Promise<ForkedSandboxes>;
	/** Recover a sandbox. Restarts the machine of a sandbox that doesn't answer or is in `error`, on its disk as it is. Memory is lost. A key needs `sandboxes:write`. `POST /sandboxes/{sandboxId}/recover` */
	recoverSandbox(sandboxId: string, options?: CallOptions): Promise<Sandbox>;
	/** Delete a sandbox permanently. Erases it and its automatic snapshots for good; saved snapshots of it stay. It can't be undone. A key needs `sandboxes:delete`. `DELETE /sandboxes/{sandboxId}` */
	deleteSandbox(sandboxId: string, options?: CallOptions): Promise<Sandbox>;
	/** Get a sandbox's usage. CPU, memory, running time and cost per interval. A key needs `sandboxes:read`. `GET /sandboxes/{sandboxId}/usage` */
	getSandboxUsage(sandboxId: string, query?: UsageQuery, options?: CallOptions): Promise<SandboxUsage>;
	/** Run a command. Runs a command line in a running sandbox and answers when it ends, with its exit code and output, or at `timeoutMs` (`timed_out`, the command killed). `detached` answers at once and lets it run with no limit. A stopped sandbox is `conflict`: resume it first. A key needs `exec`. Idempotent with `options.idempotencyKey`. `POST /sandboxes/{sandboxId}/commands` */
	runCommand(sandboxId: string, body: RunCommandBody, options?: CallOptions): Promise<Command>;
	/** List a sandbox's commands. Its commands, newest first, also while it is stopped. A key needs `exec`. `GET /sandboxes/{sandboxId}/commands` */
	listCommands(sandboxId: string, query?: ComputePageQuery, options?: CallOptions): Promise<CommandPage>;
	/** Get a command. Its state and its output so far. A key needs `exec`. `GET /sandboxes/{sandboxId}/commands/{commandId}` */
	getCommand(sandboxId: string, commandId: string, options?: CallOptions): Promise<Command>;
	/** Kill a command. Ends a running command; one that has ended is answered as it is. A key needs `exec`. `DELETE /sandboxes/{sandboxId}/commands/{commandId}` */
	killCommand(sandboxId: string, commandId: string, options?: CallOptions): Promise<Command>;
	/** Read a file. A file of up to 1 MiB, as UTF-8 text unless `encoding` asks for base64. A larger file is read in parts of up to 1 MiB with `offset` and `length`; `size` in the answer is the whole file's. Use base64 for a part of a binary file, or of a text file cut mid-character. A key needs `files`. `GET /sandboxes/{sandboxId}/files` */
	readFile(sandboxId: string, query: ReadFileQuery, options?: CallOptions): Promise<FileContent>;
	/** Write a file. Writes a file, making its directories, replacing what was there. A key needs `files`. `PUT /sandboxes/{sandboxId}/files` */
	writeFile(sandboxId: string, body: WriteFileBody, options?: CallOptions): Promise<FileEntry>;
	/** Delete a file. Deletes a file, or a directory and everything in it. A key needs `files`. `DELETE /sandboxes/{sandboxId}/files` */
	deleteFile(sandboxId: string, query: FilePathQuery, options?: CallOptions): Promise<void>;
	/** List a directory. A key needs `files`. `GET /sandboxes/{sandboxId}/files/list` */
	listFiles(sandboxId: string, query?: ListFilesQuery, options?: CallOptions): Promise<FileList>;
	/** List a sandbox's public ports. A key needs `access`. `GET /sandboxes/{sandboxId}/ports` */
	listPorts(sandboxId: string, options?: CallOptions): Promise<ExposedPortList>;
	/** Expose a port. Gives a port in the sandbox an HTTPS URL through its host's tunnel. The app must listen on the port; on `0.0.0.0` or `localhost` both work. Exposing it again answers its URL. A key needs `access`. `POST /sandboxes/{sandboxId}/ports` */
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
	/** Take a snapshot now. Adds a snapshot of the sandbox's disk to its history now, without stopping it. Kantel also takes them by itself. A key needs `snapshots:write`. `POST /sandboxes/{sandboxId}/snapshots` */
	takeSnapshot(sandboxId: string, body?: TakeSnapshotBody, options?: CallOptions): Promise<Snapshot>;
	/** Save a snapshot. Keeps a sandbox's state now, or one snapshot of its history, under a name until it is deleted. New sandboxes start from it with `from: <name>`. A name in use is `conflict` unless `replace`. A key needs `snapshots:write`. `POST /snapshots` */
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
	/** Create an API key. Makes a scoped key in the account. Its secret is answered once. A key can only make keys with scopes it holds itself. A key needs `account:admin`. `POST /api-keys` */
	createApiKey(body: CreateApiKeyBody, options?: CallOptions): Promise<IssuedApiKey>;
	/** Get an API key. A key needs `account:read`. `GET /api-keys/{apiKeyId}` */
	getApiKey(apiKeyId: string, options?: CallOptions): Promise<ApiKey>;
	/** Rotate an API key. Replaces its secret; the old one stops working at once. A key needs `account:admin`. `POST /api-keys/{apiKeyId}/rotate` */
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
	/** Create an environment. An empty environment, named uniquely in the account. A sandbox starts with it when its create names it. A key needs `account:admin`. `POST /environments` */
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
	/** List events. The account's events, newest first: what webhooks deliver, and a sandbox's history with `sandboxId`. A key needs `sandboxes:read`. `GET /events` */
	listEvents(query?: ListEventsQuery, options?: CallOptions): Promise<EventPage>;
	/** List webhooks. A key needs `account:admin`. `GET /webhooks` */
	listWebhooks(query?: AccountScopedQuery, options?: CallOptions): Promise<WebhookList>;
	/** Create a webhook. Its signing secret is answered once. A key needs `account:admin`. `POST /webhooks` */
	createWebhook(body: CreateWebhookBody, options?: CallOptions): Promise<WebhookWithSecret>;
	/** Get a webhook. A key needs `account:admin`. `GET /webhooks/{webhookId}` */
	getWebhook(webhookId: string, options?: CallOptions): Promise<Webhook>;
	/** Change a webhook. A key needs `account:admin`. `PATCH /webhooks/{webhookId}` */
	updateWebhook(webhookId: string, body?: UpdateWebhookBody, options?: CallOptions): Promise<Webhook>;
	/** Delete a webhook. Its queued deliveries are dropped. A key needs `account:admin`. `DELETE /webhooks/{webhookId}` */
	deleteWebhook(webhookId: string, options?: CallOptions): Promise<void>;
	/** Rotate a webhook's signing secret. Deliveries are signed with the new secret from now; one already under way may carry the old signature. A key needs `account:admin`. `POST /webhooks/{webhookId}/rotate` */
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
	/** List hosts. Every host that has joined, revoked ones included. A deployment super-admin only (a key needs `hosts:admin`). `GET /admin/hosts` */
	listHosts(options?: CallOptions): Promise<HostList>;
	/** Make a host join token. A one-use token, shown once, and the one-line command that installs the host agent on a Linux machine and joins it with the token. A deployment super-admin only (a key needs `hosts:admin`). `POST /admin/hosts/join-tokens` */
	createHostJoinToken(body?: CreateHostJoinTokenBody, options?: CallOptions): Promise<HostJoinToken>;
	/** Get a host. A deployment super-admin only (a key needs `hosts:admin`). `GET /admin/hosts/{hostId}` */
	getHost(hostId: string, options?: CallOptions): Promise<Host>;
	/** Change a host. Renames it, replaces its labels, drains it, or sets its warm pools. A deployment super-admin only (a key needs `hosts:admin`). `PATCH /admin/hosts/{hostId}` */
	updateHost(hostId: string, body?: UpdateHostBody, options?: CallOptions): Promise<Host>;
	/** Revoke a host. Revokes its credential and closes its connection. Its sandboxes keep their disks but can't be reached until it joins again. `unavailable`, and not revoked, when its credential is kept by a part of the deployment that is off (an account's own host, with account hosts switched off). A deployment super-admin only (a key needs `hosts:admin`). `DELETE /admin/hosts/{hostId}` */
	revokeHost(hostId: string, options?: CallOptions): Promise<Host>;
	/** Make a join token for one of your own hosts. A one-use token, shown once, and the one-line command that installs the host agent on a Linux machine and joins it to the account (the caller's personal account unless `account` names an organisation). The host dials out to this deployment and keeps the connection open, so it needs no inbound port. Once it has joined, the account's new sandboxes go on its own hosts, and no other account's sandboxes ever do. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `POST /hosts/join-tokens` */
	createAccountJoinToken(body?: CreateAccountJoinTokenBody, options?: CallOptions): Promise<AccountJoinToken>;
	/** List an account's hosts. The hosts joined to the account, revoked ones included. The deployment's shared hosts aren't listed. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `GET /hosts` */
	listAccountHosts(query?: AccountScopedQuery, options?: CallOptions): Promise<HostList>;
	/** Get one of an account's hosts. A key needs `account:read`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `GET /hosts/{hostId}` */
	getAccountHost(hostId: string, options?: CallOptions): Promise<Host>;
	/** Change one of an account's hosts. Renames it, replaces its labels, drains it, or sets its warm pools. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `PATCH /hosts/{hostId}` */
	updateAccountHost(hostId: string, body?: UpdateHostBody, options?: CallOptions): Promise<Host>;
	/** Remove one of an account's hosts. Revokes its credential and closes its connection. Its sandboxes keep their disks but can't be reached until it joins again. Run `sudo kantel-host uninstall` on the machine to take the agent off it. A key needs `account:admin`. Experimental: `not_supported` unless the deployment has turned account hosts on (`KANTEL_ACCOUNT_HOSTS`). `DELETE /hosts/{hostId}` */
	removeAccountHost(hostId: string, options?: CallOptions): Promise<Host>;
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
		createOrganisation: (body, callOptions) => send(options, { method: "POST", path: "/accounts", body }, callOptions),
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
			send(options, { method: "POST", path: `/accounts/${encodeURIComponent(accountId)}/invites`, body }, callOptions),
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
		createSandbox: (body = {}, callOptions) => send(options, { method: "POST", path: "/sandboxes", body }, callOptions),
		getSandbox: (sandboxId, callOptions) =>
			send(options, { method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}` }, callOptions),
		updateSandbox: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/sandboxes/${encodeURIComponent(sandboxId)}`, body }, callOptions),
		startSandbox: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/start`, body }, callOptions),
		stopSandbox: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/stop`, body }, callOptions),
		resumeSandbox: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/resume`, body }, callOptions),
		forkSandbox: (sandboxId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/fork`, body }, callOptions),
		recoverSandbox: (sandboxId, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/recover` }, callOptions),
		deleteSandbox: (sandboxId, callOptions) =>
			send(options, { method: "DELETE", path: `/sandboxes/${encodeURIComponent(sandboxId)}` }, callOptions),
		getSandboxUsage: (sandboxId, query, callOptions) =>
			send(options, { method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}/usage`, query }, callOptions),
		runCommand: (sandboxId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/commands`, body },
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
		listPorts: (sandboxId, callOptions) =>
			send(options, { method: "GET", path: `/sandboxes/${encodeURIComponent(sandboxId)}/ports` }, callOptions),
		exposePort: (sandboxId, body, callOptions) =>
			send(options, { method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/ports`, body }, callOptions),
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
				{ method: "POST", path: `/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, body },
				callOptions,
			),
		saveSnapshot: (body, callOptions) => send(options, { method: "POST", path: "/snapshots", body }, callOptions),
		getSnapshot: (snapshotId, callOptions) =>
			send(options, { method: "GET", path: `/snapshots/${encodeURIComponent(snapshotId)}` }, callOptions),
		listSnapshotFiles: (snapshotId, query, callOptions) =>
			send(options, { method: "GET", path: `/snapshots/${encodeURIComponent(snapshotId)}/files`, query }, callOptions),
		readSnapshotFile: (snapshotId, query, callOptions) =>
			send(options, { method: "GET", path: `/snapshots/${encodeURIComponent(snapshotId)}/file`, query }, callOptions),
		deleteSnapshot: (snapshotId, callOptions) =>
			send(options, { method: "DELETE", path: `/snapshots/${encodeURIComponent(snapshotId)}` }, callOptions),
		listApiKeys: (query, callOptions) => send(options, { method: "GET", path: "/api-keys", query }, callOptions),
		createApiKey: (body, callOptions) => send(options, { method: "POST", path: "/api-keys", body }, callOptions),
		getApiKey: (apiKeyId, callOptions) =>
			send(options, { method: "GET", path: `/api-keys/${encodeURIComponent(apiKeyId)}` }, callOptions),
		rotateApiKey: (apiKeyId, callOptions) =>
			send(options, { method: "POST", path: `/api-keys/${encodeURIComponent(apiKeyId)}/rotate` }, callOptions),
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
			send(options, { method: "POST", path: "/environments", body }, callOptions),
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
		listEvents: (query, callOptions) => send(options, { method: "GET", path: "/events", query }, callOptions),
		listWebhooks: (query, callOptions) => send(options, { method: "GET", path: "/webhooks", query }, callOptions),
		createWebhook: (body, callOptions) => send(options, { method: "POST", path: "/webhooks", body }, callOptions),
		getWebhook: (webhookId, callOptions) =>
			send(options, { method: "GET", path: `/webhooks/${encodeURIComponent(webhookId)}` }, callOptions),
		updateWebhook: (webhookId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/webhooks/${encodeURIComponent(webhookId)}`, body }, callOptions),
		deleteWebhook: (webhookId, callOptions) =>
			send(options, { method: "DELETE", path: `/webhooks/${encodeURIComponent(webhookId)}` }, callOptions),
		rotateWebhookSecret: (webhookId, callOptions) =>
			send(options, { method: "POST", path: `/webhooks/${encodeURIComponent(webhookId)}/rotate` }, callOptions),
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
		listHosts: (callOptions) => send(options, { method: "GET", path: "/admin/hosts" }, callOptions),
		createHostJoinToken: (body = {}, callOptions) =>
			send(options, { method: "POST", path: "/admin/hosts/join-tokens", body }, callOptions),
		getHost: (hostId, callOptions) =>
			send(options, { method: "GET", path: `/admin/hosts/${encodeURIComponent(hostId)}` }, callOptions),
		updateHost: (hostId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/admin/hosts/${encodeURIComponent(hostId)}`, body }, callOptions),
		revokeHost: (hostId, callOptions) =>
			send(options, { method: "DELETE", path: `/admin/hosts/${encodeURIComponent(hostId)}` }, callOptions),
		createAccountJoinToken: (body = {}, callOptions) =>
			send(options, { method: "POST", path: "/hosts/join-tokens", body }, callOptions),
		listAccountHosts: (query, callOptions) => send(options, { method: "GET", path: "/hosts", query }, callOptions),
		getAccountHost: (hostId, callOptions) =>
			send(options, { method: "GET", path: `/hosts/${encodeURIComponent(hostId)}` }, callOptions),
		updateAccountHost: (hostId, body = {}, callOptions) =>
			send(options, { method: "PATCH", path: `/hosts/${encodeURIComponent(hostId)}`, body }, callOptions),
		removeAccountHost: (hostId, callOptions) =>
			send(options, { method: "DELETE", path: `/hosts/${encodeURIComponent(hostId)}` }, callOptions),
	};
}
