// Pure logic for the vault page: what state a request is in, the approver's narrowing draft and what it turns into,
// what the agent would be told, and how a refusal from the vault reads. No React and no I/O, so it is tested on its own
// and shared with whatever host drives the page.

import {
	CODE_REQUIRED_KINDS,
	type Decision,
	type Grant,
	type HttpMethod,
	isHarbourError,
	type Narrowing,
	type Proposal,
	type ProposalKind,
	type UserId,
} from "@harbour/contracts";
import { narrow, pathUnder } from "@harbour/vault";
import { DAY, HOUR, MINUTE } from "../primitives/format.ts";

/** Who asked, in names a person reads. The host resolves them from the identity and session directories. */
export interface RequesterLabels {
	readonly organisation: string;
	readonly project?: string;
	/** The agent's name, or the service or person that proposed it. */
	readonly agent?: string;
	readonly session?: string;
	/** A link to the session the request came from, so the approver can check its card. */
	readonly sessionHref?: string;
	/** The person behind the session, when known. */
	readonly person?: string;
	readonly personId?: UserId;
}

/** The item a proposal is for, without its value (the vault never returns one). */
export interface RequestItem {
	readonly name: string;
	readonly description?: string;
	/** The header template, such as `Authorization: Bearer {key}`. */
	readonly injection: string;
	/**
	 * The person a user's own (personal) item belongs to. Only that person decides a request for it, and only sessions
	 * working for them may use it (docs/design/org-scope.md, decision 6).
	 */
	readonly personalTo?: string;
}

/** Everything the vault page shows for one proposal. Built by `loadVaultRequest` from any `Vault`. */
export interface VaultRequest {
	readonly proposal: Proposal;
	/** The codes to pick from, the real one among decoys. Absent when the viewer may only view the request. */
	readonly codeChoices?: readonly string[];
	/** Whether approving needs the matching code: writes, route grants and secret pastes. */
	readonly codeRequired: boolean;
	/** Set when the viewer cannot decide: they can see the request but lack the operator role on its project. */
	readonly readOnly?: "role";
	readonly requester: RequesterLabels;
	readonly item?: RequestItem;
	/** The decision, when the host knows it (the vault contract has no read for a past decision yet). */
	readonly decision?: Decision;
	/** The decider's name, when the host knows it. */
	readonly decider?: string;
	/** The grant an approval created, when the viewer may see it. */
	readonly grant?: Grant;
}

export interface Viewer {
	readonly userId: UserId;
	readonly name: string;
}

/**
 * The lifecycle states the page draws. `proposed` and `pending` are both open: `proposed` is a request nobody has
 * touched, `pending` one the approver has started on (a narrowed draft or a picked code). `narrowed` is an approval
 * whose terms are tighter than the agent asked for; `revoked` an approval whose grant was stopped.
 */
export type VaultLifecycle =
	| "proposed"
	| "pending"
	| "approved"
	| "narrowed"
	| "denied"
	| "expired"
	| "revoked"
	| "withdrawn";

/** The settled state of a request, or `open` while it can still be decided. Expiry is read from `now`. */
export function settledState(
	request: VaultRequest,
	now: number,
): "open" | "approved" | "narrowed" | "denied" | "expired" | "revoked" | "withdrawn" {
	const { proposal } = request;
	switch (proposal.status) {
		case "pending":
			return now >= proposal.expiresAt ? "expired" : "open";
		case "approved": {
			if (request.grant?.status === "revoked") return "revoked";
			return wasNarrowed(request) ? "narrowed" : "approved";
		}
		default:
			return proposal.status;
	}
}

/** Whether an approved request's terms are tighter than the proposal's. Reads the grant, else the decision. */
export function wasNarrowed(request: VaultRequest): boolean {
	const proposed = request.proposal.terms;
	const route = request.grant?.route ?? request.decision?.effectiveTerms?.route;
	if (route === undefined) return false;
	const maxUses = request.grant?.maxUses ?? request.decision?.effectiveTerms?.maxUses;
	const decidedAt = request.grant?.createdAt ?? request.decision?.decidedAt;
	const expiresAt = request.grant?.expiresAt ?? request.decision?.effectiveTerms?.expiresAt;
	const ttl = expiresAt === undefined || decidedAt === undefined ? undefined : expiresAt - decidedAt;
	return (
		route.pathPrefix !== proposed.route.pathPrefix ||
		route.methods.length !== proposed.route.methods.length ||
		maxUses !== proposed.lifetime.maxUses ||
		ttl !== proposed.lifetime.ttlMs
	);
}

/** "Write", "Read", "Route grant" or "Secret paste": the kind in words, for a badge. */
export const kindLabel: Readonly<Record<ProposalKind, string>> = {
	read: "Read",
	write: "Write",
	route: "Route grant",
	secret: "Secret paste",
};

/** The kind in a sentence, under the title. */
export const kindText: Readonly<Record<ProposalKind, string>> = {
	read: "A read, used once. The code is shown so you can check it matches the card; you don't need to pick it.",
	write: "A write, used once. Pick the code the card in your session shows before you approve.",
	route:
		"A route grant: the agent's requests within these terms go through until it expires or is stopped. Pick the code the card in your session shows before you approve.",
	secret:
		"A new secret, pasted here and stored in the vault. Pick the code the card in your session shows before you paste.",
};

/** Whether approving `proposal` needs the matching code, as the vault decides it from the kind. */
export function codeRequiredFor(proposal: Pick<Proposal, "kind">): boolean {
	return CODE_REQUIRED_KINDS.includes(proposal.kind);
}

// The narrowing draft.

/** What the approver has in the editable terms. `maxUses` is the field's text, so a half-typed value can be shown. */
export interface NarrowingDraft {
	readonly methods: readonly HttpMethod[];
	readonly pathPrefix: string;
	/** Milliseconds from approval; undefined for no expiry. */
	readonly ttlMs: number | undefined;
	readonly maxUses: string;
}

export function initialDraft(proposal: Proposal): NarrowingDraft {
	const { route, lifetime } = proposal.terms;
	return {
		methods: [...route.methods],
		pathPrefix: route.pathPrefix,
		ttlMs: lifetime.ttlMs,
		maxUses: lifetime.maxUses === undefined ? "" : String(lifetime.maxUses),
	};
}

export interface DraftErrors {
	readonly methods?: string;
	readonly pathPrefix?: string;
	readonly maxUses?: string;
}

/** Which terms the draft narrows, so each can be tagged "Proposed" or "Narrowed". */
export interface DraftChanges {
	readonly methods: boolean;
	readonly pathPrefix: boolean;
	readonly ttlMs: boolean;
	readonly maxUses: boolean;
}

export interface DraftResult {
	/** The narrowing to send, or undefined when the draft is the proposal as it stands. */
	readonly narrowing: Narrowing | undefined;
	readonly changes: DraftChanges;
	readonly errors: DraftErrors;
	readonly valid: boolean;
}

function parseUses(text: string): number | undefined | "invalid" {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	if (!/^\d+$/.test(trimmed)) return "invalid";
	const value = Number(trimmed);
	return Number.isSafeInteger(value) && value >= 1 ? value : "invalid";
}

/**
 * Checks a draft against the proposal and turns it into the narrowing the vault takes. Each field is checked with the
 * vault's own `narrow`, so the page refuses exactly what the vault would. Narrowing only tightens: a method can be
 * dropped, the path made longer (by whole segments), the lifetime shortened and the uses lowered.
 */
export function draftNarrowing(proposal: Proposal, draft: NarrowingDraft): DraftResult {
	const { route, lifetime } = proposal.terms;
	const errors: { methods?: string; pathPrefix?: string; maxUses?: string } = {};
	const methods = route.methods.filter((method) => draft.methods.includes(method));
	const methodsChanged = methods.length !== route.methods.length;
	if (methods.length === 0) errors.methods = "Keep at least one method, or deny the request.";

	const path = draft.pathPrefix.trim();
	const pathChanged = path !== route.pathPrefix;
	if (pathChanged) {
		if (!path.startsWith("/")) errors.pathPrefix = "A path starts with /.";
		else if (!pathUnder(path, route.pathPrefix)) errors.pathPrefix = `Keep the path under ${route.pathPrefix}.`;
	}

	const ttlChanged = draft.ttlMs !== lifetime.ttlMs;
	const uses = parseUses(draft.maxUses);
	let usesChanged = false;
	if (uses === "invalid") errors.maxUses = "A whole number, 1 or more.";
	else if (uses === undefined) {
		if (lifetime.maxUses !== undefined) errors.maxUses = `At most ${lifetime.maxUses}.`;
	} else if (lifetime.maxUses !== undefined && uses > lifetime.maxUses) errors.maxUses = `At most ${lifetime.maxUses}.`;
	else usesChanged = uses !== lifetime.maxUses;

	const narrowing: { methods?: HttpMethod[]; pathPrefix?: string; ttlMs?: number; maxUses?: number } = {};
	if (methodsChanged && methods.length > 0) narrowing.methods = methods;
	if (pathChanged && errors.pathPrefix === undefined) narrowing.pathPrefix = path;
	if (ttlChanged && draft.ttlMs !== undefined) narrowing.ttlMs = draft.ttlMs;
	if (usesChanged && typeof uses === "number") narrowing.maxUses = uses;

	const changes = { methods: methodsChanged, pathPrefix: pathChanged, ttlMs: ttlChanged, maxUses: usesChanged };
	const hasNarrowing = Object.keys(narrowing).length > 0;
	if (Object.keys(errors).length === 0 && hasNarrowing) {
		// The vault's own check, in case a rule here and there ever drift apart.
		try {
			narrow(proposal.terms, narrowing);
		} catch (error) {
			return {
				narrowing: undefined,
				changes,
				errors: { pathPrefix: error instanceof Error ? error.message : String(error) },
				valid: false,
			};
		}
	}
	return {
		narrowing: hasNarrowing ? narrowing : undefined,
		changes,
		errors,
		valid: Object.keys(errors).length === 0,
	};
}

/** The terms the agent would be told if the draft were approved at `now`: what the page promises before approval. */
export interface PreviewTerms {
	readonly host: string;
	readonly methods: readonly HttpMethod[];
	readonly pathPrefix: string;
	readonly expiresAt?: number;
	readonly maxUses?: number;
}

export function previewTerms(proposal: Proposal, narrowing: Narrowing | undefined, now: number): PreviewTerms {
	const terms = narrow(proposal.terms, narrowing);
	return {
		host: terms.route.host,
		methods: terms.route.methods,
		pathPrefix: terms.route.pathPrefix,
		...(terms.lifetime.ttlMs === undefined ? {} : { expiresAt: now + terms.lifetime.ttlMs }),
		...(terms.lifetime.maxUses === undefined ? {} : { maxUses: terms.lifetime.maxUses }),
	};
}

/** The preview in one sentence: "POST to api.linear.app under /graphql, for 1 day, once." */
export function termsSentence(terms: {
	host: string;
	methods: readonly string[];
	pathPrefix: string;
	ttlMs?: number;
	maxUses?: number;
}): string {
	const methods = terms.methods.length === 0 ? "Any method" : terms.methods.join(", ");
	const where = terms.pathPrefix === "/" ? `anywhere on ${terms.host}` : `to ${terms.host} under ${terms.pathPrefix}`;
	const lifetime = terms.ttlMs === undefined ? "with no expiry" : `for ${lifetimeLabel(terms.ttlMs)}`;
	const uses =
		terms.maxUses === undefined ? "as often as needed" : terms.maxUses === 1 ? "once" : `${terms.maxUses} times`;
	return `${methods} ${where}, ${lifetime}, ${uses}.`;
}

// Lifetimes.

const LIFETIMES: readonly number[] = [15 * MINUTE, HOUR, 8 * HOUR, DAY, 7 * DAY, 30 * DAY];

/** "15 minutes", "1 hour", "8 hours", "1 day", "7 days", or the nearest whole unit for anything else. */
export function lifetimeLabel(ms: number): string {
	const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
	if (ms >= DAY && ms % DAY === 0) return plural(ms / DAY, "day");
	if (ms >= HOUR && ms % HOUR === 0) return plural(ms / HOUR, "hour");
	if (ms >= MINUTE) return plural(Math.round(ms / MINUTE), "minute");
	return plural(Math.max(1, Math.round(ms / 1000)), "second");
}

export interface LifetimeOption {
	/** `none` is no expiry; otherwise milliseconds as a string, for a segmented control's value. */
	readonly value: string;
	readonly label: string;
	readonly ttlMs: number | undefined;
}

/**
 * Up to four lifetimes the approver may choose: shorter ones first, then the proposal's own ("As asked, 30 days"). A
 * lifetime can only be shortened, so nothing longer than the proposal's is offered; with no expiry asked for, the
 * longest offered is no expiry.
 */
export function lifetimeOptions(proposedTtlMs: number | undefined): readonly LifetimeOption[] {
	const shorter = LIFETIMES.filter((ms) => proposedTtlMs === undefined || ms < proposedTtlMs);
	const picked = shorter.slice(-3);
	const options: LifetimeOption[] = picked.map((ms) => ({ value: String(ms), label: lifetimeLabel(ms), ttlMs: ms }));
	options.push(
		proposedTtlMs === undefined
			? { value: "none", label: "No expiry", ttlMs: undefined }
			: { value: String(proposedTtlMs), label: lifetimeLabel(proposedTtlMs), ttlMs: proposedTtlMs },
	);
	return options;
}

export function lifetimeValue(ttlMs: number | undefined): string {
	return ttlMs === undefined ? "none" : String(ttlMs);
}

// Refusals.

/** Why the vault refused a decision, in the terms the page shows it. */
export type DecisionRefusal =
	| { readonly kind: "code"; readonly message: string }
	| { readonly kind: "role"; readonly message: string }
	| { readonly kind: "expired"; readonly message: string }
	| { readonly kind: "decided"; readonly message: string }
	| { readonly kind: "terms"; readonly message: string }
	| { readonly kind: "invalid"; readonly message: string }
	| { readonly kind: "passkey"; readonly message: string }
	| { readonly kind: "unavailable"; readonly message: string };

/**
 * Reads an error from `decide` (or the passkey step). The vault refuses a wrong binding code and a stale terms hash
 * with the same code, `refused`; the page tells them apart by what it sent: it always cites the hash it showed, so a
 * refusal with a code picked is the code, unless the vault's message names the terms.
 */
export function decisionRefusal(error: unknown, context: { project?: string } = {}): DecisionRefusal {
	// The host's server refused the passkey (#132): the refusal names why in `details.passkey`.
	if (isHarbourError(error, "refused") && typeof error.details?.passkey === "string") {
		return {
			kind: "passkey",
			message:
				error.details.passkey === "missing"
					? "Approving needs your passkey. Nothing was approved, and the attempt was recorded."
					: "Your passkey didn't match this request, so nothing was approved, and the attempt was recorded. Try again.",
		};
	}
	if (isHarbourError(error, "refused")) {
		if (/terms/i.test(error.message) && !/code/i.test(error.message)) {
			return {
				kind: "terms",
				message: "The request changed after you opened it. Nothing was approved. Reload to see its terms now.",
			};
		}
		return {
			kind: "code",
			message:
				"That isn't the code on the card. Nothing was approved, and the wrong pick was recorded. Check the card in your own session and pick again. If it shows none of these codes, deny the request: it isn't from your agent.",
		};
	}
	if (isHarbourError(error, "forbidden")) {
		const where = context.project === undefined ? "this project" : context.project;
		return {
			kind: "role",
			message: `You need the operator role on ${where} to decide this request. Nothing was approved.`,
		};
	}
	if (isHarbourError(error, "expired")) {
		return { kind: "expired", message: "This request expired while you were deciding. Nothing was approved." };
	}
	if (isHarbourError(error, "conflict")) {
		return { kind: "decided", message: "This request was decided elsewhere first. Reload to see the outcome." };
	}
	if (isHarbourError(error, "invalid")) {
		return { kind: "invalid", message: `The vault refused the terms: ${error.message}. Nothing was approved.` };
	}
	return {
		kind: "unavailable",
		message: "The vault didn't answer, so nothing was approved. Try again in a moment.",
	};
}

/** Whether the viewer is someone other than the person behind the requesting session: a forwarded link. */
export function isForwarded(request: VaultRequest, viewer: Viewer): boolean {
	const behind = request.requester.personId ?? request.proposal.requester.onBehalfOf;
	return behind !== undefined && behind !== viewer.userId;
}

/** "3 of 10 uses", "1 use left", "No use limit". */
export function usesText(grant: Pick<Grant, "uses" | "maxUses">): string {
	if (grant.maxUses === undefined)
		return grant.uses === 1 ? "Used once, no limit" : `Used ${grant.uses} times, no limit`;
	return `${grant.uses} of ${grant.maxUses} ${grant.maxUses === 1 ? "use" : "uses"}`;
}
