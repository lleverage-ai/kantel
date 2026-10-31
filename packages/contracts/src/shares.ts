/**
 * Sharing a file an agent made (a document, a PDF, any file in a session's workspace), after Claude's Share popover:
 * people invited by email, and general access, either the people who can already see the session ("Only you" in the
 * console) or anyone with the link. A share names one file and always shows its newest version: an edit after sharing
 * is what a link holder sees.
 *
 * A link is a secret token in the URL; it reads that one file and nothing else, never the session or its workspace.
 * Revoking the share, or setting general access back to `restricted`, stops the link at once.
 *
 * Invites are stored and listed. Kantel sends no email, and an invite grants nothing on its own yet: an invited person
 * reads the file through the link (so it needs `link` access) or through their own role on the session's project.
 */
import type { CallContext, OrganisationId, SystemContext, Timestamp, UserId, WorkspaceId } from "./common.ts";

export type ShareId = string;

/** `restricted`: only those who can see the session's workspace. `link`: anyone with the link, signed in or not. */
export type ShareAccess = "restricted" | "link";

export interface ShareInvite {
	/** As given, trimmed; compared case-insensitively. */
	readonly email: string;
	readonly invitedBy: UserId;
	readonly invitedAt: Timestamp;
}

export interface FileShare {
	readonly id: ShareId;
	readonly organisationId: OrganisationId;
	readonly workspaceId: WorkspaceId;
	/** The file's path in the workspace. */
	readonly path: string;
	/** What the link's page calls the file: a document's title, or else its name. */
	readonly title?: string;
	readonly access: ShareAccess;
	/** The link's secret, the last part of `/shared/<token>`. Only those who may see the workspace see it. */
	readonly token: string;
	/** The person who shared the file, the share's owner. */
	readonly createdBy: UserId;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
	readonly invites: readonly ShareInvite[];
	/** Set once revoked: the link no longer opens and nothing changes the share again. */
	readonly revokedAt?: Timestamp;
}

export interface ShareInput {
	readonly workspaceId: WorkspaceId;
	readonly path: string;
	readonly title?: string;
	/** Default `restricted`. */
	readonly access?: ShareAccess;
}

export interface ShareUpdate {
	readonly access?: ShareAccess;
	readonly title?: string;
}

/** The most invites one share holds. */
export const MAX_SHARE_INVITES = 50;

/**
 * The shares of the files in workspaces. Reads need viewer on the workspace, as reading its files does; every change
 * needs operator, is a person's (agents and API keys can't share), and is audited.
 */
export interface FileShares {
	/** The file's share, made if it has none (one live share per file). An existing one is returned unchanged. */
	share(ctx: CallContext, input: ShareInput): Promise<FileShare>;
	/** A workspace's live shares, or one file's, oldest first. */
	list(
		ctx: CallContext,
		query: { readonly workspaceId: WorkspaceId; readonly path?: string },
	): Promise<readonly FileShare[]>;
	get(ctx: CallContext, id: ShareId): Promise<FileShare>;
	update(ctx: CallContext, id: ShareId, change: ShareUpdate): Promise<FileShare>;
	/** Adds an invite (an email already invited is left as it is). */
	invite(ctx: CallContext, id: ShareId, email: string): Promise<FileShare>;
	removeInvite(ctx: CallContext, id: ShareId, email: string): Promise<FileShare>;
	/** Revokes the share: its link stops. Revoking a revoked share does nothing. */
	revoke(ctx: CallContext, id: ShareId): Promise<FileShare>;
	/**
	 * Kantel's own, for the link's page: the live share with this token, while its general access is `link`;
	 * `undefined` otherwise, whatever the reason, so a page can't tell a revoked link from one that never was.
	 */
	open(ctx: SystemContext, token: string): Promise<FileShare | undefined>;
}
