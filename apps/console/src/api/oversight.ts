// The vault page's and the audit view's seams to a Harbour host, beside `ConsoleClient`'s for sessions. Each is
// optional: a console without one shows no link to its page. On `source=api` they run over the vault approval API
// (`vault-http.ts`) and the audit query API (`audit-http.ts`); on `source=recorded`, `recorded/oversight.ts` serves
// both from the in-memory vault and audit store, in the page.

import type { Decision, DecisionInput } from "@harbour/contracts";
import type {
	AuditDirectory,
	AuditLinks,
	AuditSource,
	AuditViewProps,
	Choice,
	GrantSummary,
	PasskeyCheck,
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
	/** Check for newer events this often (ms). */
	readonly pollMs?: number;
}
