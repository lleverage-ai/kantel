// The sharing page's fixtures: one project that shares a skill and a memory space, has a workspace shared with it, and
// has a request waiting on the viewer, over a source kept in the page.

import type { AccessRequest, OwnerRef, ResourceShare } from "@harbour/contracts";
import { DAY, HOUR } from "../primitives/format.ts";
import type { SharingDirectory, SharingSource } from "./sharing-model.ts";

export const FIXTURE_NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const ORG = "org_harbour";
const support: OwnerRef = { kind: "project", organisationId: ORG, projectId: "proj_support" };
const billing: OwnerRef = { kind: "project", organisationId: ORG, projectId: "proj_billing" };
const tom = { kind: "human", userId: "usr_tom" } as const;
const ana = { kind: "human", userId: "usr_ana" } as const;

export const PROJECTS = [
	{ id: "proj_support", name: "Support" },
	{ id: "proj_billing", name: "Billing" },
];

const names = (entries: Record<string, string>) => (key: string) => entries[key];
const resources = names({
	"skills.skill:skill_review": "review-checklist",
	"memory.space:space_tone": "Tone of voice",
	"workspace:ws_refunds": "Refund playbooks",
});

export const directory: SharingDirectory = {
	person: names({ usr_tom: "Tom Davies", usr_ana: "Ana Silva" }),
	agent: names({ agent_triage: "Triage" }),
	resource: (kind, id) => resources(`${kind}:${id}`),
};

export function fixtureShares(): ResourceShare[] {
	return [
		{
			id: "share_skill",
			organisationId: ORG,
			resource: { kind: "skills.skill", id: "skill_review", revision: 3 },
			owner: support,
			grantee: { kind: "project", projectId: "proj_billing" },
			permission: "use",
			grantedBy: tom,
			grantedAt: FIXTURE_NOW - 2 * DAY,
		},
		{
			id: "share_memory",
			organisationId: ORG,
			resource: { kind: "memory.space", id: "space_tone" },
			owner: support,
			grantee: { kind: "agent", agentId: "agent_triage" },
			permission: "propose",
			grantedBy: tom,
			grantedAt: FIXTURE_NOW - DAY,
			expiresAt: FIXTURE_NOW + 6 * DAY,
		},
		{
			id: "share_workspace",
			organisationId: ORG,
			resource: { kind: "workspace", id: "ws_refunds" },
			owner: billing,
			grantee: { kind: "project", projectId: "proj_support" },
			permission: "edit",
			grantedBy: ana,
			grantedAt: FIXTURE_NOW - 3 * HOUR,
		},
	];
}

export function fixtureRequests(): AccessRequest[] {
	return [
		{
			id: "request_skill",
			organisationId: ORG,
			resource: { kind: "skills.skill", id: "skill_review" },
			owner: support,
			grantee: { kind: "project", projectId: "proj_billing" },
			permission: "edit",
			reason: "We'd like to add the refund checks to the review checklist.",
			requestedBy: ana,
			status: "pending",
			createdAt: FIXTURE_NOW - HOUR,
		},
	];
}

/** A source over the fixtures, in the page: decisions, revocations and withdrawals change what it lists next. */
export function createSharingScenario(): SharingSource {
	const shares = fixtureShares();
	const requests = fixtureRequests();
	const ownerProject = (owner: OwnerRef) => (owner.kind === "project" ? owner.projectId : undefined);
	const sameGrantee = (a: ResourceShare["grantee"], b: ResourceShare["grantee"]) =>
		JSON.stringify(a) === JSON.stringify(b);
	return {
		async listShares(query) {
			const items = shares.filter(
				(share) =>
					(query.includeInactive === true || share.revokedAt === undefined) &&
					(query.ownerProjectId === undefined || ownerProject(share.owner) === query.ownerProjectId) &&
					(query.grantee === undefined || sameGrantee(share.grantee, query.grantee)),
			);
			return { items };
		},
		async listRequests(query) {
			const items = requests.filter(
				(request) =>
					(query.status === undefined || request.status === query.status) &&
					(query.decidable !== true || ownerProject(request.owner) === "proj_support") &&
					(query.grantee === undefined || sameGrantee(request.grantee, query.grantee)),
			);
			return { items };
		},
		async revokeShare(shareId) {
			const index = shares.findIndex((share) => share.id === shareId);
			const share = shares[index];
			if (share === undefined) throw new Error("No such share");
			const revoked = { ...share, revokedAt: FIXTURE_NOW, revokedBy: tom };
			shares[index] = revoked;
			return revoked;
		},
		async decideRequest(requestId, input) {
			const index = requests.findIndex((request) => request.id === requestId);
			const request = requests[index];
			if (request === undefined) throw new Error("No such request");
			const decided: AccessRequest = {
				...request,
				status: input.decision === "grant" ? "granted" : "rejected",
				decision: { decidedBy: tom, decidedAt: FIXTURE_NOW },
			};
			requests[index] = decided;
			if (input.decision === "reject") return { request: decided };
			const share: ResourceShare = {
				id: `share_${requestId}`,
				organisationId: ORG,
				resource: request.resource,
				owner: request.owner,
				grantee: request.grantee,
				permission: input.permission ?? request.permission,
				grantedBy: tom,
				grantedAt: FIXTURE_NOW,
				requestId,
			};
			shares.push(share);
			return { request: decided, share };
		},
		async withdrawRequest(requestId) {
			const index = requests.findIndex((request) => request.id === requestId);
			const request = requests[index];
			if (request === undefined) throw new Error("No such request");
			const withdrawn: AccessRequest = { ...request, status: "withdrawn" };
			requests[index] = withdrawn;
			return withdrawn;
		},
	};
}
