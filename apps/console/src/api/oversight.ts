// The vault page's and the audit view's seams to a Harbour host, beside `ConsoleClient`'s for sessions. Each is
// optional: a console without one shows no link to its page. On `source=api` they run over the vault approval API
// (`vault-http.ts`) and the audit query API (`audit-http.ts`); on `source=recorded`, `recorded/oversight.ts` serves
// both from the in-memory vault and audit store, in the page.

import type { Decision, DecisionInput, HeldRole, MemorySpace } from "@harbour/contracts";
import type {
	ApiKeysApi,
	AuditDirectory,
	AuditLinks,
	AuditSource,
	AuditViewProps,
	Choice,
	GrantSummary,
	MemoryPageSource,
	OwnerChoice,
	PasskeyCheck,
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
	 * Asks for a passkey before an approval: WebAuthn in a browser, behind the host's challenge and check. Absent on a
	 * host with no passkeys yet; the page then approves on the sign-in alone and says so.
	 */
	readonly passkey?: PasskeyCheck;
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
	/** Check for newer events this often (ms). */
	readonly pollMs?: number;
}
