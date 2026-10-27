/**
 * Vault and egress. The vault holds credentials, decides every outbound request and injects credentials on the way
 * out. Agents and sandboxes never hold credential values.
 *
 * Records: item (encrypted, per owner), injection rule (on the item), policy, proposal, decision, grant and use.
 * Each organisation has a ceiling that bounds what any policy or grant may allow.
 *
 * Settled 27 Oct 2026, part of the contract and not an option:
 * - Every proposal carries a binding code, derived from the proposal ID and a hash of its terms. The agent's card and
 *   the vault page always show it.
 * - Approving a write or a route grant, or pasting a secret, is refused (`refused`) unless the approver submits the
 *   code that matches the proposal. The vault checks the match server-side and audits a wrong pick
 *   (`vault.binding_code.mismatch`). Reads only display the code.
 * - The approval is bound to the hash of the terms the approver saw: a decision citing any other hash is refused.
 * - The proposal's kind is derived by the vault from its terms, never taken from the agent, so a write cannot be
 *   proposed as a read to skip the code.
 */
import type {
	Actor,
	AgentId,
	CallContext,
	OrganisationId,
	OwnerRef,
	Page,
	PageRequest,
	ProjectId,
	SessionId,
	Timestamp,
	UserId,
} from "./common.ts";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export const READ_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "OPTIONS"];

/**
 * Where a credential may be used: one host over https, some methods, and paths under `pathPrefix`. The prefix matches
 * whole path segments: `/repos` covers `/repos` and `/repos/x`, never `/repositories`. Plain http is never injected.
 */
export interface RouteScope {
	/** Exact host name, lower case, such as `api.github.com`. */
	readonly host: string;
	readonly methods: readonly HttpMethod[];
	/** A path prefix starting with `/`; `/` allows every path. */
	readonly pathPrefix: string;
}

/** How a credential is placed on a request, such as `Authorization: Bearer {key}`. */
export interface InjectionRule {
	readonly header: string;
	/** Must contain `{key}`, replaced with the item's value by the proxy. */
	readonly template: string;
}

export interface VaultItem {
	readonly id: string;
	readonly owner: OwnerRef;
	readonly name: string;
	readonly description?: string;
	/** Hosts the item is bound to. Nothing injects it anywhere else. */
	readonly hosts: readonly string[];
	readonly injection: InjectionRule;
	/**
	 * The stand-in a sandbox may hold, such as `harbour://github-token/4f91c2`. The egress proxy swaps it for the real
	 * value only on the way to one of `hosts`.
	 */
	readonly placeholder: string;
	/** Whether a value is stored. The value itself is never returned by any read. */
	readonly hasValue: boolean;
	readonly valueVersion: number;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

/** Which sessions a policy or grant applies to. Narrower fields must all match when present. */
export interface PolicySelector {
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly agentId?: AgentId;
	readonly sessionId?: SessionId;
}

export interface Lifetime {
	readonly expiresAt?: Timestamp;
	readonly maxUses?: number;
}

/** A standing rule, set by an admin or imported from a host's grants. */
export interface VaultPolicy {
	readonly id: string;
	readonly itemId: string;
	readonly selector: PolicySelector;
	readonly route: RouteScope;
	readonly lifetime: Lifetime;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly revokedAt?: Timestamp;
}

/** The organisation's ceiling: no policy or grant may allow a host or method outside it. */
export interface VaultCeiling {
	readonly organisationId: OrganisationId;
	readonly routes: readonly RouteScope[];
}

/**
 * What a proposal asks for:
 * - `read`: one use of read methods only.
 * - `write`: any non-read method, used once.
 * - `route`: a reusable route grant (more than one use, or no use limit).
 * - `secret`: a human pastes a value for a new or valueless item on the vault page.
 */
export type ProposalKind = "read" | "write" | "route" | "secret";

/** Kinds whose approval requires picking the matching binding code. */
export const CODE_REQUIRED_KINDS: readonly ProposalKind[] = ["write", "route", "secret"];

export interface ProposalTerms {
	/** An existing item, or for a `secret` proposal the item to create. */
	readonly itemId?: string;
	readonly secret?: {
		readonly name: string;
		readonly description?: string;
		readonly hosts: readonly string[];
		readonly injection: InjectionRule;
	};
	readonly route: RouteScope;
	/** Requested lifetime. `ttlMs` is from approval. */
	readonly lifetime: { readonly ttlMs?: number; readonly maxUses?: number };
	/** Why the agent needs it, shown on the card. */
	readonly reason: string;
}

export type ProposalStatus = "pending" | "approved" | "denied" | "expired" | "withdrawn";

export interface Proposal {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	/** The agent (and session) asking, and the human behind the session when known. */
	readonly requester: {
		readonly actor: Actor;
		readonly sessionId?: SessionId;
		readonly agentId?: AgentId;
		readonly onBehalfOf?: UserId;
	};
	/** Derived by the vault from `terms`. */
	readonly kind: ProposalKind;
	readonly terms: ProposalTerms;
	/** Hex SHA-256 of the canonical terms. */
	readonly termsHash: string;
	/** Short code derived from the proposal ID and `termsHash`; always shown on the card and the vault page. */
	readonly bindingCode: string;
	readonly status: ProposalStatus;
	readonly createdAt: Timestamp;
	/** A pending proposal past this time is `expired`. */
	readonly expiresAt: Timestamp;
	/** The vault page for this proposal. */
	readonly link: string;
	readonly decisionId?: string;
}

/** What the vault page shows the approver: the proposal and the codes to pick from (the real one among decoys). */
export interface ApprovalView {
	readonly proposal: Proposal;
	readonly codeChoices: readonly string[];
	readonly codeRequired: boolean;
}

/** Narrowing an approval may only tighten the proposed terms. */
export interface Narrowing {
	readonly methods?: readonly HttpMethod[];
	readonly pathPrefix?: string;
	readonly ttlMs?: number;
	readonly maxUses?: number;
}

export interface DecisionInput {
	readonly proposalId: string;
	readonly outcome: "approve" | "deny";
	/** The hash of the terms the approver saw. Required to approve. */
	readonly termsHash?: string;
	/** The binding code the approver picked. Required to approve a write, route or secret proposal. */
	readonly pickedCode?: string;
	readonly narrowing?: Narrowing;
	/** For a `secret` proposal: the pasted value. Never stored outside the item, never returned. */
	readonly secretValue?: string;
	readonly note?: string;
}

/** The terms in force after a decision: what the agent is told, never the proposed terms. */
export interface EffectiveTerms {
	readonly itemId: string;
	readonly route: RouteScope;
	readonly expiresAt?: Timestamp;
	readonly maxUses?: number;
}

export interface Decision {
	readonly id: string;
	readonly proposalId: string;
	readonly outcome: "approved" | "denied";
	readonly decidedBy: Actor;
	readonly decidedAt: Timestamp;
	readonly effectiveTerms?: EffectiveTerms;
	readonly grantId?: string;
	readonly note?: string;
}

export type GrantStatus = "active" | "exhausted" | "expired" | "revoked";

export interface Grant {
	readonly id: string;
	readonly proposalId: string;
	readonly decisionId: string;
	readonly itemId: string;
	readonly selector: PolicySelector;
	readonly route: RouteScope;
	readonly expiresAt?: Timestamp;
	readonly maxUses?: number;
	readonly uses: number;
	readonly status: GrantStatus;
	readonly endReason?: "exhausted" | "expired" | "revoked";
	readonly createdAt: Timestamp;
	readonly endedAt?: Timestamp;
}

/** One outbound request the vault decided. */
export interface VaultUse {
	readonly id: string;
	readonly at: Timestamp;
	readonly organisationId: OrganisationId;
	readonly sessionId?: SessionId;
	readonly itemId?: string;
	readonly grantId?: string;
	readonly policyId?: string;
	readonly method: HttpMethod;
	readonly host: string;
	readonly path: string;
	readonly outcome: "injected" | "denied";
	readonly reason?: string;
}

/** What a refused request tells the agent: never a dead end, always the next step. */
export interface EgressFix {
	/** `propose` when a proposal could allow it; `none` when nothing can (outside the ceiling). */
	readonly action: "propose" | "none";
	/** Plain-language next step, such as "Ask for a route grant to api.github.com". Never includes a value. */
	readonly message: string;
}

export interface EgressRequest {
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly agentId?: AgentId;
	readonly sessionId?: SessionId;
	readonly method: HttpMethod;
	readonly url: string;
}

/**
 * The proxy-side decision. `inject` carries the credential and is only ever given to the egress proxy, never to a
 * sandbox, a transcript or a log.
 */
export interface EgressDecision {
	readonly allow: boolean;
	readonly reason: string;
	readonly useId: string;
	readonly grantId?: string;
	readonly policyId?: string;
	readonly inject?: { readonly header: string; readonly value: string };
	/** Present on every denial. */
	readonly fix?: EgressFix;
}

/** Delivered to a waiting agent. Says plainly that no request has run. */
export interface ProposalOutcome {
	readonly proposalId: string;
	readonly status: "approved" | "denied" | "expired" | "withdrawn";
	readonly effectiveTerms?: EffectiveTerms;
	readonly message: string;
}

export interface Vault {
	// Items and policies (admins, or a host importing its grants).
	/** Creates an item. A value given here is set directly by an admin on the vault page, not pasted for a proposal. */
	putItem(
		ctx: CallContext,
		input: {
			readonly owner: OwnerRef;
			readonly name: string;
			readonly description?: string;
			readonly hosts: readonly string[];
			readonly injection: InjectionRule;
			readonly value?: string;
		},
	): Promise<VaultItem>;
	getItem(ctx: CallContext, itemId: string): Promise<VaultItem>;
	listItems(ctx: CallContext, page?: PageRequest): Promise<Page<VaultItem>>;

	setCeiling(ctx: CallContext, routes: readonly RouteScope[]): Promise<VaultCeiling>;
	getCeiling(ctx: CallContext): Promise<VaultCeiling>;

	/** Rejects with `refused` when the route is outside the item's hosts or the organisation's ceiling. */
	putPolicy(
		ctx: CallContext,
		input: {
			readonly itemId: string;
			readonly selector: PolicySelector;
			readonly route: RouteScope;
			readonly lifetime?: Lifetime;
		},
	): Promise<VaultPolicy>;
	revokePolicy(ctx: CallContext, policyId: string): Promise<void>;
	listPolicies(ctx: CallContext, page?: PageRequest): Promise<Page<VaultPolicy>>;

	// Proposals and decisions.
	/**
	 * An agent asks for access. The vault derives the kind, hashes the terms, derives the binding code and stores a
	 * pending proposal. No access has changed yet. Refused outright when the route is outside the ceiling.
	 */
	propose(ctx: CallContext, terms: ProposalTerms): Promise<Proposal>;
	getProposal(ctx: CallContext, proposalId: string): Promise<Proposal>;
	listProposals(
		ctx: CallContext,
		filter?: { readonly status?: ProposalStatus; readonly sessionId?: SessionId },
		page?: PageRequest,
	): Promise<Page<Proposal>>;
	/** What the vault page shows. Needs a human (or service acting for one); never an agent. */
	approvalView(ctx: CallContext, proposalId: string): Promise<ApprovalView>;
	/**
	 * A human decides. Rejects with `forbidden` for agent actors, `expired` past the proposal's expiry, `conflict` if
	 * already decided, `invalid` for a narrowing that widens the terms, and `refused` when the binding code or terms
	 * hash does not match (a wrong code is audited).
	 */
	decide(ctx: CallContext, input: DecisionInput): Promise<Decision>;
	/** The agent withdraws its own pending proposal. */
	withdraw(ctx: CallContext, proposalId: string): Promise<Proposal>;
	/**
	 * Resolves when the proposal leaves `pending` (or at once if it has). Durable in real targets: a restarted agent
	 * calls it again and gets the same outcome. Aborting the signal stops the wait, not the proposal.
	 */
	waitForOutcome(ctx: CallContext, proposalId: string): Promise<ProposalOutcome>;

	// Grants and uses.
	getGrant(ctx: CallContext, grantId: string): Promise<Grant>;
	listGrants(
		ctx: CallContext,
		filter?: { readonly status?: GrantStatus; readonly sessionId?: SessionId },
		page?: PageRequest,
	): Promise<Page<Grant>>;
	/** Stops a grant; the next request using it is denied. */
	revokeGrant(ctx: CallContext, grantId: string, reason?: string): Promise<Grant>;
	listUses(ctx: CallContext, filter?: { readonly sessionId?: SessionId }, page?: PageRequest): Promise<Page<VaultUse>>;

	/**
	 * Decides one outbound request for the egress proxy: the first active grant or policy whose selector and route
	 * match allows it and returns the header to inject; anything else is denied. Every call records a use.
	 */
	decideEgress(request: EgressRequest): Promise<EgressDecision>;
}
