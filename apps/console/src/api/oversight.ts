// The vault page's and the audit view's seams to a Harbour host, beside `ConsoleClient`'s for sessions. Each is
// optional: a console without one shows no link to its page. On `source=api` they run over the vault approval API
// (`vault-http.ts`) and the audit query API (`audit-http.ts`); on `source=recorded`, `recorded/oversight.ts` serves
// both from the in-memory vault and audit store, in the page.

import type { ConnectionRuleInput, Decision, DecisionInput, HeldRole, MemorySpace } from "@harbour/contracts";
import type {
	ApiKeysApi,
	AuditDirectory,
	AuditLinks,
	AuditSource,
	AuditViewProps,
	Choice,
	ConnectionsSource,
	ConnectionsViewer,
	GrantSummary,
	MemoryPageSource,
	OwnerChoice,
	PasskeyCheck,
	ScheduleFormSettings,
	SchedulesSource,
	SharingDirectory,
	SharingSource,
	SkillsAuthor,
	SkillsSource,
	VaultRequest,
	Viewer,
} from "@harbour/ui";

/** The vault as the signed-in person sees it: one request to decide, and their active grants. */
export interface ConsoleVault {
	/** The vault's own host, shown in the page header so the approver can check it. */
	readonly host: string;
	readonly viewer: Viewer;
	/** One request, read-only when the viewer may see it but not decide it. Throws the vault's `forbidden` or `not_found`. */
	request(proposalId: string): Promise<VaultRequest>;
	grants(): Promise<readonly GrantSummary[]>;
	/** Approves or denies; the vault refuses a wrong binding code with `refused`. */
	decide(input: DecisionInput): Promise<Decision>;
	stop(grantId: string): Promise<void>;
	/**
	 * "Always allow requests like this" for an approved exact request (#333): saves the allow rule on its connection
	 * (`POST /v1/connections/{id}/rules/from-approval`). Absent where the page shouldn't offer it.
	 */
	alwaysAllow?(connectionId: string, approvalId: string, rule: ConnectionRuleInput): Promise<void>;
	/**
	 * Asks for a passkey before an approval: WebAuthn in a browser, behind the host's challenge and check. Absent on a
	 * host with no passkeys yet; the page then approves on the sign-in alone and says so.
	 */
	readonly passkey?: PasskeyCheck;
	/**
	 * Sets up a passkey for a person who has none yet, on a host that takes them. Resolves the passkey check approving
	 * then needs, or `undefined` when the person dismissed the prompt.
	 */
	readonly registerPasskey?: () => Promise<PasskeyCheck | undefined>;
}

/**
 * Host apps' API keys, as the signed-in person may manage them: the key routes, and the person's roles from
 * `GET /v1/me`, which say which projects they may issue keys for. Listed for an operator or above.
 */
export interface ConsoleKeys {
	readonly api: ApiKeysApi;
	readonly roles: readonly HeldRole[];
}

/** The projects, agents and sessions the audit log may be filtered by, each as a value and its name. */
export interface AuditScope {
	readonly projects: readonly Choice[];
	readonly agents: readonly Choice[];
	readonly sessions: readonly Choice[];
}

/** Who the audit log's filters and rows name: the people, by `actorKey`, and the organisations the viewer may read. */
export interface AuditPeople {
	/** The people, a `human:<userId>` key each, by name. */
	readonly actors: readonly Choice[];
	/** The organisations, the current one first; absent when they couldn't be read. */
	readonly organisations?: readonly Choice[];
}

/**
 * The agent's skills and memory as the signed-in person may read them: the skills page's and memory page's sources.
 * On `source=api` they run over the public API's skills and memory routes (`agent-http.ts`), read-only; on
 * `source=recorded`, over in-memory stores in the page, with authoring and proposals.
 */
export interface ConsoleAgent {
	readonly skills: SkillsSource;
	/** The signed-in person's user ID, so the skills page lists their own skills as theirs. */
	readonly viewer?: string;
	/** Skills' writes, where the host serves them; absent, the skills page is read-only. */
	readonly author?: SkillsAuthor;
	/** The owners a new skill may go under, with `author`. */
	readonly owners?: readonly OwnerChoice[];
	readonly memory: MemoryPageSource;
	/** The memory spaces the person may read, oldest first. */
	spaces(): Promise<readonly MemorySpace[]>;
	/** The projects the pages name and switch between, where they aren't the console's own (recorded fixtures). */
	readonly projects?: readonly { readonly id: string; readonly name: string }[];
	/** Concept IDs recalled whatever the query, where the host names a profile. */
	readonly profile?: readonly string[];
}

/**
 * The organisation's schedules as the signed-in person may see and change them. `source` is one call per schedule
 * route in the public API (`/v1/schedules`, see `SchedulesSource`), so the API's client fits as it is; on
 * `source=recorded` it is @harbour/ui's fixtures, in the page (`recorded/schedules.ts`).
 */
export interface ConsoleSchedules {
	readonly source: SchedulesSource;
	/** Names for the people, agents and projects schedules name. */
	readonly directory: AuditDirectory;
	/** New schedule and Edit, for a person who may make them; absent, the page reads, pauses and resumes only. */
	readonly form?: ScheduleFormSettings;
	/** The time the page measures from, for a fixture host whose store keeps its own clock. Default now. */
	readonly now?: number;
}

/**
 * Sharing across projects as the signed-in person may see and decide it (docs/design/sharing.md): `source` is one call
 * per sharing route the page uses (`/v1/sharing`, `sharing-http.ts`).
 */
export interface ConsoleSharing {
	readonly source: SharingSource;
	/** The projects the page shows sharing for, by name. */
	readonly projects: readonly { readonly id: string; readonly name: string }[];
	readonly directory: SharingDirectory;
	/** The time the page measures from, for a fixture host. Default now. */
	readonly now?: number;
}

/**
 * The Connections page (#339) as the signed-in person sees it: `source` is one or two calls per `/v1/connections` route
 * (`connections-http.ts`), or the UI's fixtures on `source=recorded`.
 */
export interface ConsoleConnections {
	readonly source: ConnectionsSource;
	readonly viewer: ConnectionsViewer;
	/** People's names, for connections other people own. */
	readonly people?: (userId: string) => string | undefined;
	/** The redirect URI an OAuth client registers with its provider. */
	readonly redirectUri: string;
	/** The time the page measures from, for a fixture host. Default now. */
	readonly now?: number;
}

/** The audit log as the signed-in person may read it, with names and links for what it shows. */
export interface ConsoleAudit {
	readonly source: AuditSource;
	readonly directory: AuditDirectory;
	readonly links: AuditLinks;
	readonly choices: NonNullable<AuditViewProps["choices"]>;
	/**
	 * Reads the credentials to filter by, each time the audit log opens, for a host with no list of them up front. They
	 * become the *Credential* choices and name the items in rows. A failed read leaves both as they were.
	 */
	readonly credentials?: () => Promise<readonly Choice[]>;
	/**
	 * Reads the projects, agents and sessions to filter by, each time the audit log opens, for a host with no list of them
	 * up front. They become the *Project*, *Agent* and *Session* choices and name them in rows. A failed read leaves both
	 * as they were.
	 */
	readonly scope?: () => Promise<AuditScope>;
	/**
	 * Reads the people and organisations to filter by, each time the audit log opens, for a host with no list of them up
	 * front. They become the *Who* and *Organisation* choices, and rows name people by them. A failed read leaves both as
	 * they were.
	 */
	readonly people?: () => Promise<AuditPeople>;
	/** Check for newer events this often (ms). */
	readonly pollMs?: number;
}
