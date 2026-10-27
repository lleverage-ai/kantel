// "Which sessions used the Linear key yesterday, and who approved it?" One credential's uses in a time range, by
// session, each with the approvals (or standing policy) that let it through. Built from the audit log alone: the uses
// name their grant or policy, and each approval names the grant it made.
//
// The contract's query can't filter on a credential or a grant, so both reads page through a type and match here:
// the uses in the range, then every approval up to the range's end. Lane 6's query API could take `itemId` and
// `grantId` filters to make both reads exact; see docs/audit.md.

import type { Actor, AuditEvent } from "@harbour/contracts";
import { type AuditSource, readAll } from "./audit-model.ts";

export interface SessionUse {
	readonly sessionId: string;
	readonly agentId?: string;
	readonly projectId?: string;
	readonly injected: number;
	readonly refused: number;
	readonly first: number;
	readonly last: number;
	/** The grants and policies its uses went through, in first-use order. */
	readonly via: readonly string[];
}

export interface Approval {
	readonly grantId: string;
	readonly approvedBy: Actor;
	readonly approvedAt: number;
	readonly proposalId?: string;
	/** The terms approved, as the event recorded them. */
	readonly route?: AuditEvent["data"];
}

export interface CredentialUsage {
	readonly itemId: string;
	readonly sessions: readonly SessionUse[];
	/** Approvals by grant ID, for the grants the uses went through. */
	readonly approvals: ReadonlyMap<string, Approval>;
	/** Uses under a standing policy rather than a grant, by policy ID. */
	readonly policies: readonly string[];
	/** Uses with no session (the system's own egress). */
	readonly unattributed: number;
}

interface Building {
	sessionId: string;
	agentId?: string;
	projectId?: string;
	injected: number;
	refused: number;
	first: number;
	last: number;
	via: string[];
}

export async function credentialUsage(
	source: AuditSource,
	request: { itemId: string; organisationId?: string; from?: number; to?: number; signal?: AbortSignal },
): Promise<CredentialUsage> {
	const bySession = new Map<string, Building>();
	const grants = new Set<string>();
	const policies = new Set<string>();
	let unattributed = 0;
	const scope = request.organisationId === undefined ? {} : { organisationId: request.organisationId };
	const range = {
		...scope,
		...(request.from === undefined ? {} : { from: request.from }),
		...(request.to === undefined ? {} : { to: request.to }),
	};
	const signal = request.signal === undefined ? {} : { signal: request.signal };

	for await (const page of readAll(
		source,
		{ type: "vault.use.", ...range },
		{ credential: request.itemId, ...signal },
	)) {
		for (const event of page) {
			const grantId = typeof event.data?.grantId === "string" ? event.data.grantId : undefined;
			const policyId = typeof event.data?.policyId === "string" ? event.data.policyId : undefined;
			if (grantId !== undefined) grants.add(grantId);
			if (policyId !== undefined) policies.add(policyId);
			if (event.sessionId === undefined) {
				unattributed += 1;
				continue;
			}
			let entry = bySession.get(event.sessionId);
			if (entry === undefined) {
				entry = {
					sessionId: event.sessionId,
					...(event.agentId === undefined ? {} : { agentId: event.agentId }),
					...(event.projectId === undefined ? {} : { projectId: event.projectId }),
					injected: 0,
					refused: 0,
					first: event.at,
					last: event.at,
					via: [],
				};
				bySession.set(event.sessionId, entry);
			}
			if (event.type === "vault.use.injected") entry.injected += 1;
			else entry.refused += 1;
			entry.first = Math.min(entry.first, event.at);
			entry.last = Math.max(entry.last, event.at);
			const via = grantId ?? policyId;
			if (via !== undefined && !entry.via.includes(via)) entry.via.push(via);
		}
	}
	const approvals = new Map<string, Approval>();
	if (grants.size > 0) {
		// A grant used in the range was approved before its end, perhaps long before its start.
		const before = { ...scope, ...(request.to === undefined ? {} : { to: request.to }) };
		for await (const page of readAll(
			source,
			{ type: "vault.decision.approved", ...before },
			{ credential: request.itemId, ...signal },
		)) {
			for (const event of page) {
				const grantId = event.data?.grantId;
				if (typeof grantId !== "string" || !grants.has(grantId) || approvals.has(grantId)) continue;
				approvals.set(grantId, {
					grantId,
					approvedBy: event.actor,
					approvedAt: event.at,
					...(event.subject?.kind === "vault.proposal" ? { proposalId: event.subject.id } : {}),
					...(event.data?.route === undefined ? {} : { route: { route: event.data.route } }),
				});
			}
			if (approvals.size === grants.size) break;
		}
	}

	// Most used first, then most recent.
	const sessions = [...bySession.values()].sort((a, b) => b.injected - a.injected || b.last - a.last);
	return { itemId: request.itemId, sessions, approvals, policies: [...policies], unattributed };
}
