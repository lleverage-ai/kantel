// The sharing page's model (docs/design/sharing.md): the client it reads and writes through, and the words it shows for
// resources, grantees and permissions. Pure, so it is tested without a page.

import {
	type AccessRequest,
	type AccessRequestQuery,
	type Actor,
	type DecideRequestInput,
	type Page,
	type PageRequest,
	permissionSatisfies,
	type ResourceSelector,
	type ResourceShare,
	SHARE_PERMISSIONS,
	type ShareGrantee,
	type SharePermission,
	type ShareQuery,
	shareActive,
} from "@harbour/contracts";
import { type AuditDirectory, actorName } from "../audit/audit-model.ts";
import { DAY, timeLeft } from "../primitives/format.ts";
import { ownerName } from "../primitives/owner.ts";

/** One call per sharing route the page uses (`/v1/sharing/...`), so the API's client fits as it is. */
export interface SharingSource {
	listShares(query: ShareQuery, page?: PageRequest): Promise<Page<ResourceShare>>;
	listRequests(query: AccessRequestQuery, page?: PageRequest): Promise<Page<AccessRequest>>;
	revokeShare(shareId: string, reason?: string): Promise<ResourceShare>;
	decideRequest(
		requestId: string,
		input: DecideRequestInput,
	): Promise<{ readonly request: AccessRequest; readonly share?: ResourceShare }>;
	withdrawRequest(requestId: string): Promise<AccessRequest>;
}

/** Names for what the page shows: people, agents, sessions and projects, and resources by kind and ID. */
export interface SharingDirectory extends AuditDirectory {
	resource?(kind: string, id: string): string | undefined;
}

/** Everything the page shows for one project, read at once. */
export interface SharingOverview {
	/** Pending requests the viewer may decide: their inbox, from any project. */
	readonly inbox: readonly AccessRequest[];
	/** Shares of the project's resources, to others. */
	readonly outgoing: readonly ResourceShare[];
	/** Shares into the project, from others. */
	readonly incoming: readonly ResourceShare[];
	/** The project's own requests, newest first. */
	readonly requests: readonly AccessRequest[];
}

/** Every page of a list, up to `limit` items (a page shows a project's sharing, not an archive). */
export async function readAll<T>(read: (page: PageRequest) => Promise<Page<T>>, limit = 500): Promise<readonly T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	do {
		const page = await read({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined && items.length < limit);
	return items.slice(0, limit);
}

/** The page's four lists for `projectId`. */
export async function readOverview(source: SharingSource, projectId: string): Promise<SharingOverview> {
	const project: ShareGrantee = { kind: "project", projectId };
	const [inbox, outgoing, incoming, requests] = await Promise.all([
		readAll((page) => source.listRequests({ decidable: true, status: "pending" }, page)),
		readAll((page) => source.listShares({ ownerProjectId: projectId }, page)),
		readAll((page) => source.listShares({ grantee: project }, page)),
		readAll((page) => source.listRequests({ grantee: project }, page)),
	]);
	return { inbox, outgoing, incoming, requests };
}

export const PERMISSION_LABELS: Readonly<Record<SharePermission, string>> = {
	use: "Use",
	propose: "Propose changes",
	edit: "Edit",
	approve: "Approve",
};

/** What each permission lets the grantee do, in a sentence. */
export const PERMISSION_HINTS: Readonly<Record<SharePermission, string>> = {
	use: "Read it and use it in sessions.",
	propose: "Use it and suggest changes for the owner to review.",
	edit: "Use it and change it. Agents still only propose.",
	approve: "Change it and publish or apply others' changes.",
};

/** The permissions a decider may grant for a request: what was asked, or anything weaker. */
export function grantablePermissions(asked: SharePermission): readonly SharePermission[] {
	return SHARE_PERMISSIONS.filter((permission) => permissionSatisfies(asked, permission));
}

const KIND_LABELS: Readonly<Record<string, string>> = {
	"skills.skill": "Skill",
	"memory.space": "Memory space",
	"vault.item": "Vault item",
	workspace: "Workspace",
	"models.connector": "Model connector",
};

/** "Skill", "Memory space", or a host's kind as it is ("workflows.workflow"). */
export function kindLabel(kind: string): string {
	return KIND_LABELS[kind] ?? kind;
}

/** "Skill review-checklist, revision 3". */
export function resourceText(resource: ResourceSelector, directory: SharingDirectory = {}): string {
	const name = directory.resource?.(resource.kind, resource.id) ?? resource.id;
	const revision = resource.revision === undefined ? "" : `, revision ${resource.revision}`;
	return `${kindLabel(resource.kind)} ${name}${revision}`;
}

/** "Billing project", "agent Reviewer", "Tom Davies", "session sess_1". */
export function granteeText(grantee: ShareGrantee, directory: SharingDirectory = {}): string {
	switch (grantee.kind) {
		case "project":
			return ownerName({ kind: "project", organisationId: "", projectId: grantee.projectId }, directory);
		case "agent":
			return `agent ${directory.agent?.(grantee.agentId) ?? grantee.agentId}`;
		case "user":
			return directory.person?.(grantee.userId) ?? grantee.userId;
		case "session":
			return `session ${directory.session?.(grantee.sessionId) ?? grantee.sessionId}`;
	}
}

export function actorText(actor: Actor, directory: SharingDirectory = {}): string {
	return actorName(actor, directory);
}

/** "6 days left", "1 day left", then as the clock counts it ("2h 10m left"). */
export function expiryText(expiresAt: number, now: number): string {
	const days = Math.floor((expiresAt - now) / DAY);
	if (days >= 1) return `${days} ${days === 1 ? "day" : "days"} left`;
	return timeLeft(expiresAt, now);
}

export type ShareState = "active" | "expired" | "revoked";

export function shareState(share: ResourceShare, now: number): ShareState {
	if (share.revokedAt !== undefined) return "revoked";
	return shareActive(share, now) ? "active" : "expired";
}

/** Active shares first, newest first within each state. */
export function sortShares(shares: readonly ResourceShare[], now: number): readonly ResourceShare[] {
	const rank = (share: ResourceShare) => (shareState(share, now) === "active" ? 0 : 1);
	return [...shares].sort((a, b) => rank(a) - rank(b) || b.grantedAt - a.grantedAt || a.id.localeCompare(b.id));
}

export const REQUEST_STATUS_LABELS: Readonly<Record<AccessRequest["status"], string>> = {
	pending: "Waiting",
	granted: "Granted",
	rejected: "Rejected",
	withdrawn: "Withdrawn",
};

/** The decision a grant sends: only what narrows the request (a weaker permission, an earlier expiry). */
export function grantInput(
	request: AccessRequest,
	draft: { readonly permission: SharePermission; readonly expiresAt?: number; readonly note?: string },
): DecideRequestInput {
	const note = draft.note?.trim();
	return {
		decision: "grant",
		...(draft.permission === request.permission ? {} : { permission: draft.permission }),
		...(draft.expiresAt === undefined || draft.expiresAt === request.expiresAt ? {} : { expiresAt: draft.expiresAt }),
		...(note === undefined || note === "" ? {} : { note }),
	};
}
