/**
 * The vault engine: every rule of CONTRACT.md over a `VaultStore` and a `VaultCipher`. Each target builds its vault
 * with `createVault`; `createMemoryVault` is this engine over maps and a random key.
 *
 * Every decision reads the store, so a change made through one vault instance holds at once for every other instance
 * over the same store. Every change that races (settling a proposal, spending a grant or policy use, revoking) is one
 * `commit` conditional on the revision it read; a lost race reads again and answers from what won.
 */
import {
	type AccessCheck,
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	CODE_REQUIRED_KINDS,
	type ConnectionSecretCall,
	type ConnectionSecretResult,
	type ConnectionSecrets,
	type ConnectorCredential,
	type ConnectorCredentialRequest,
	type ConnectorCredentials,
	type Decision,
	type EffectiveTerms,
	type EgressDecision,
	type EgressFix,
	type EgressRequest,
	type Grant,
	HarbourError,
	type HttpMethod,
	type JsonValue,
	type Lifetime,
	type OrganisationId,
	type OwnerRef,
	type Page,
	type PageRequest,
	PLATFORM_ORGANISATION,
	type PolicySelector,
	type ProjectAccess,
	type ProjectId,
	type Proposal,
	type ProposalOutcome,
	type ProposalTerms,
	type RouteScope,
	requireSystem,
	type SessionAccess,
	type SessionEgressUsage,
	type SessionEndHook,
	type SessionId,
	type SessionPlaceholder,
	type SessionPlaceholderRequest,
	type SessionPlaceholders,
	systemClock,
	systemContext,
	type Vault,
	type VaultCeiling,
	type VaultItem,
	type VaultPolicy,
	type VaultUse,
} from "@harbour/contracts";
import type { VaultCipher } from "./cipher.ts";
import {
	assertValidHost,
	assertValidRoute,
	classifyProposal,
	codeChoices,
	deriveBindingCode,
	hashTerms,
	narrow,
	routeAllows,
	routeWithin,
} from "./index.ts";
import type { VaultRow, VaultStore, VaultTable, VaultWrite } from "./store.ts";

/**
 * The vault every target builds: the `Vault` contract, the connector credential read the model gateway makes, and the
 * connection secrets the connections service keeps (epic #322).
 */
export type HarbourVault = Vault & Required<ConnectorCredentials> & ConnectionSecrets;

export interface VaultOptions {
	/** Where every record is kept. Two vaults over one store behave as one. */
	readonly store: VaultStore;
	/** Seals item values before they reach the store and opens them for an allowed egress decision or a connector read. */
	readonly cipher: VaultCipher;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** How long a proposal stays pending. Default 15 minutes. */
	readonly proposalTtlMs?: number;
	/**
	 * Base of the connection request page's links; a proposal's link is `<linkBase>/requests/<id>`. Default
	 * `/connections`, the console's. A proposal made before #324 keeps the `/vault/proposals/<id>` link it was given,
	 * which the console redirects.
	 */
	readonly linkBase?: string;
	/**
	 * How often a pending wait reads its proposal again from the store: to hear of a decision made through another vault
	 * instance, and of expiry by the clock. Default 25 ms. A decision made through this instance wakes it at once.
	 */
	readonly expiryPollMs?: number;
	/**
	 * Project access (settled question 7): when given, every project-scoped call is checked with it after the
	 * organisation lookup (see CONTRACT.md for which call needs which role on which project). Without it the vault
	 * checks only the organisation; every target and every conformance run passes one.
	 */
	readonly access?: ProjectAccess;
	/** When given, the vault registers `endSession` with it once, as `vault` (settled question 8). */
	readonly sessionEnd?: SessionEndHook;
}

const DEFAULT_PROPOSAL_TTL_MS = 15 * 60 * 1000;
/** How many times a compare-and-set that keeps losing is retried before the call gives up as `unavailable`. */
const MAX_RETRIES = 100;
/** The vault appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("vault");
const NO_REQUEST_HAS_RUN = "No request has run.";

/** An item row: the item and, once it has a value, the value sealed by the cipher for its `valueVersion`. */
interface StoredItem {
	readonly item: VaultItem;
	readonly sealed?: string;
}

interface StoredGrant {
	readonly grant: Omit<Grant, "uses" | "status" | "endReason" | "endedAt">;
	readonly uses: number;
	readonly exhaustedAt?: number;
	readonly revokedAt?: number;
}

interface StoredPolicy {
	readonly policy: VaultPolicy;
	readonly uses: number;
}

/** A use, with the project the egress request named, so lists can be scoped without changing the record. */
interface StoredUse {
	readonly use: VaultUse;
	readonly projectId?: ProjectId;
}

/**
 * What the vault knows of one session (row ID `<organisation>:<session>`): the placeholders of its current start,
 * whether an operator has blocked it, and whether it has ended for good. Only what the session is issued, and blocking
 * or ending it, writes one; a session with no row is open and has no placeholders.
 */
interface StoredSession {
	readonly sessionId: SessionId;
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly generation: number;
	readonly issuedAt?: number;
	readonly placeholders: readonly { readonly itemId: string; readonly placeholder: string }[];
	readonly blocked?: { readonly at: number; readonly by: Actor; readonly reason?: string };
	readonly endedAt?: number;
}

const sessionRowId = (organisationId: OrganisationId, sessionId: SessionId) => `${organisationId}:${sessionId}`;

/** The longest reason a block keeps. */
const MAX_BLOCK_REASON = 500;

/** A record as read, with the row it came from (for its revision). */
interface Read<T> {
	readonly row: VaultRow;
	readonly value: T;
}

/**
 * The project, session and user a record is scoped to; empty for an organisation's own records. A user's own item is
 * scoped to its user (docs/design/org-scope.md, decision 6): only that user, a service with an organisation-wide role
 * and agents whose session works for that user pass.
 */
export type Scope = Pick<AccessCheck, "projectId" | "sessionId" | "userId">;

/** Where an owner puts its item: in a project for a project's, with its user for a user's, else the organisation's. */
export function ownerScope(owner: OwnerRef): Scope {
	if (owner.kind === "project") return { projectId: owner.projectId };
	if (owner.kind === "user") return { userId: owner.userId };
	return {};
}

/** An item is in a project when a project owns it, and its user's when a user does. */
export function itemScope(item: VaultItem): Scope {
	return ownerScope(item.owner);
}

/** The user an item belongs to, when a user owns it. */
export function itemUser(item: VaultItem | undefined): string | undefined {
	return item?.owner.kind === "user" ? item.owner.userId : undefined;
}

/**
 * Who decides a proposal: for a user's own item, its user (no project's operator approves someone else's
 * credential); otherwise operators on the proposal's project, or the organisation's for a proposal in none.
 */
export function decisionScope(proposal: Proposal, item: VaultItem | undefined): Scope {
	const userId = itemUser(item);
	if (userId !== undefined) return { userId };
	return proposal.projectId === undefined ? {} : { projectId: proposal.projectId };
}

/** A proposal is in its `projectId` and its requester's session. */
export function proposalScope(proposal: Proposal): Scope {
	return {
		...(proposal.projectId === undefined ? {} : { projectId: proposal.projectId }),
		...(proposal.requester.sessionId === undefined ? {} : { sessionId: proposal.requester.sessionId }),
	};
}

/** A grant or policy is in its selector's project and session. */
export function selectorScope(selector: PolicySelector): Scope {
	return {
		...(selector.projectId === undefined ? {} : { projectId: selector.projectId }),
		...(selector.sessionId === undefined ? {} : { sessionId: selector.sessionId }),
	};
}

/** Whether a record is in a project or session at all; one in neither is the organisation's own. */
export function scoped(scope: Scope): boolean {
	return scope.projectId !== undefined || scope.sessionId !== undefined || scope.userId !== undefined;
}

interface Waiter {
	resolve(outcome: ProposalOutcome): void;
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function routeJson(route: RouteScope): JsonValue {
	return { host: route.host, methods: [...route.methods], pathPrefix: route.pathPrefix };
}

function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new HarbourError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

function selectorMatches(selector: PolicySelector, request: EgressRequest): boolean {
	return (
		selector.organisationId === request.organisationId &&
		(selector.projectId === undefined || selector.projectId === request.projectId) &&
		(selector.agentId === undefined || selector.agentId === request.agentId) &&
		(selector.sessionId === undefined || selector.sessionId === request.sessionId)
	);
}

function insert(table: VaultTable, id: string, organisationId: OrganisationId | null, value: unknown): VaultWrite {
	return { kind: "insert", table, id, organisationId, data: JSON.stringify(value) };
}

function update(table: VaultTable, row: VaultRow, value: unknown): VaultWrite {
	return { kind: "update", table, id: row.id, revision: row.revision, data: JSON.stringify(value) };
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Rejects with `invalid` unless `request` has the shape of a `ConnectorCredentialRequest`. */
function assertConnectorRequest(request: ConnectorCredentialRequest): void {
	const candidate = request as Partial<ConnectorCredentialRequest> | undefined;
	const owner = candidate?.owner as Partial<{ kind: string; organisationId: string }> | undefined;
	const scope = candidate?.scope as Partial<ConnectorCredentialRequest["scope"]> | undefined;
	const ownerValid = owner?.kind === "platform" || (owner?.kind === "organisation" && isString(owner.organisationId));
	if (
		!isString(candidate?.connectorId) ||
		!isString(candidate?.vaultItemId) ||
		!isString(candidate?.baseUrl) ||
		!ownerValid ||
		!isString(scope?.organisationId) ||
		// An organisation session has no project (docs/design/org-scope.md); a project named is never blank.
		(scope?.projectId !== undefined && !isString(scope.projectId)) ||
		!isString(scope?.agentId) ||
		!isString(scope?.sessionId)
	) {
		throw new HarbourError(
			"invalid",
			"A connector credential request needs a connector, owner, vault item, base URL and scope",
		);
	}
}

/**
 * The vault over `options.store`. Item values are sealed before they reach the store and opened only to build an
 * allowed egress decision's `inject` or to answer `readConnectorCredential`.
 */
export function createVault(options: VaultOptions): HarbourVault {
	const { store, cipher } = options;
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const proposalTtlMs = options.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
	const linkBase = options.linkBase ?? "/connections";
	const expiryPollMs = options.expiryPollMs ?? 25;
	const access = options.access;

	const waiters = new Map<string, Set<Waiter>>();
	/**
	 * Proposals being decided through this instance: a second decision or a withdrawal here while one is in flight is a
	 * `conflict` at once. Across instances the conditional commit settles the race instead.
	 */
	const deciding = new Set<string>();
	/**
	 * A proposal with waiters is read again from the store on an interval, which hears of a decision made elsewhere and,
	 * since reading a proposal past its expiry marks it expired, of expiry. One unref'd timer per proposal, stopped when
	 * its last waiter leaves.
	 */
	const polls = new Map<string, ReturnType<typeof setInterval>>();
	function startPoll(organisationId: OrganisationId, proposalId: string): void {
		if (polls.has(proposalId)) return;
		let reading = false;
		const timer = setInterval(() => {
			if (reading) return;
			reading = true;
			proposalFor(organisationId, proposalId)
				.then((proposal) => (proposal.status === "pending" ? undefined : wake(proposal)))
				// A failed read is tried again on the next tick; the wait stays open.
				.catch(() => undefined)
				.finally(() => {
					reading = false;
				});
		}, expiryPollMs);
		(timer as { unref?: () => void }).unref?.();
		polls.set(proposalId, timer);
	}
	function stopPoll(proposalId: string): void {
		const timer = polls.get(proposalId);
		if (timer === undefined) return;
		clearInterval(timer);
		polls.delete(proposalId);
	}

	async function read<T>(table: VaultTable, id: string): Promise<Read<T> | undefined> {
		const row = await store.get(table, id);
		return row === undefined ? undefined : { row, value: JSON.parse(row.data) as T };
	}

	async function readAll<T>(table: VaultTable, organisationId: OrganisationId | null): Promise<Read<T>[]> {
		return (await store.list(table, organisationId)).map((row) => ({ row, value: JSON.parse(row.data) as T }));
	}

	async function commit(writes: readonly VaultWrite[]): Promise<void> {
		if (!(await store.commit(writes))) {
			throw new HarbourError("conflict", "The vault changed while this call was being made; try again");
		}
	}

	/**
	 * Reads a record, works out its next state and commits it if the record has not changed since, reading again after a
	 * lost race. `next` returns undefined to leave the record as it is. Resolves the record as stored afterwards and
	 * whether this call changed it.
	 */
	async function updateWith<T>(
		table: VaultTable,
		id: string,
		next: (value: T) => T | undefined,
	): Promise<{ readonly value: T; readonly changed: boolean }> {
		for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
			const current = await read<T>(table, id);
			if (current === undefined) throw new HarbourError("not_found", `No ${table} record ${id}`);
			const changed = next(current.value);
			if (changed === undefined) return { value: current.value, changed: false };
			if (await store.commit([update(table, current.row, changed)])) return { value: changed, changed: true };
		}
		throw new HarbourError("unavailable", `The vault could not update ${id}: too many concurrent changes`);
	}

	/**
	 * Whether a grant may use `item` for `request`: always for an item of the request's own project or of no project;
	 * for another project's item, only while an active share covers the request's session. Without `access`, as before.
	 */
	async function stillShared(request: EgressRequest, item: VaultItem): Promise<boolean> {
		if (access === undefined || item.owner.kind !== "project" || item.owner.projectId === request.projectId)
			return true;
		if (request.agentId === undefined || request.sessionId === undefined) return false;
		const ctx: CallContext = {
			actor: { kind: "agent", agentId: request.agentId, sessionId: request.sessionId },
			organisationId: request.organisationId,
			...(request.projectId === undefined ? {} : { projectId: request.projectId }),
		};
		const allowed = await access.allowsResource(ctx, {
			resource: { kind: "vault.item", id: item.id },
			owner: item.owner,
			permission: "use",
			needed: "operator",
		});
		return allowed !== undefined;
	}

	/** Keeps the records the caller may view: an organisation's own records always, the rest as `access` allows. */
	async function visibleOnly<T>(ctx: CallContext, records: readonly T[], scopeOf: (record: T) => Scope): Promise<T[]> {
		if (access === undefined) return [...records];
		const kept: T[] = [];
		for (const record of records) {
			const scope = scopeOf(record);
			if (!scoped(scope) || (await access.allows(ctx, { ...scope, needed: "viewer" }))) kept.push(record);
		}
		return kept;
	}

	async function emit(event: Omit<AuditEventInput, "id" | "at" | "source"> & { readonly id?: string }): Promise<void> {
		if (audit === undefined) return;
		await audit.append(AUDIT_CONTEXT, [
			{ ...event, id: event.id ?? `vault:${randomHex(16)}`, at: clock.now(), source: "vault" },
		]);
	}

	function contextFields(ctx: CallContext): Pick<AuditEventInput, "projectId" | "sessionId" | "agentId"> {
		return {
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			...(ctx.actor.kind === "agent" ? { agentId: ctx.actor.agentId, sessionId: ctx.actor.sessionId } : {}),
		};
	}

	/** The item row, if it belongs to `organisationId`; platform items (stored under `null`) never do. */
	async function itemRecord(organisationId: OrganisationId, itemId: string): Promise<Read<StoredItem>> {
		const found = await read<StoredItem>("items", itemId);
		if (found === undefined || found.row.organisationId !== organisationId) {
			throw new HarbourError("not_found", `No vault item ${itemId}`);
		}
		return found;
	}

	async function itemFor(organisationId: OrganisationId, itemId: string): Promise<VaultItem> {
		return (await itemRecord(organisationId, itemId)).value.item;
	}

	/** The item a proposal names, if it names one that is still there. */
	async function proposalItem(organisationId: OrganisationId, proposal: Proposal): Promise<VaultItem | undefined> {
		const itemId = proposal.terms.itemId;
		if (itemId === undefined) return undefined;
		const found = await read<StoredItem>("items", itemId);
		return found === undefined || found.row.organisationId !== organisationId ? undefined : found.value.item;
	}

	/**
	 * Whether egress may use `item` for `request`. A user's own item only for a request whose agent's open session works
	 * for that user, checked through `access` on every decision; without `access`, or without the request's agent and
	 * session, never. Any other item as its grant or policy says.
	 */
	async function usableFor(request: EgressRequest, item: VaultItem): Promise<boolean> {
		const userId = itemUser(item);
		if (userId === undefined) return true;
		if (access === undefined || request.agentId === undefined || request.sessionId === undefined) return false;
		const ctx: CallContext = {
			actor: { kind: "agent", agentId: request.agentId, sessionId: request.sessionId },
			organisationId: request.organisationId,
		};
		return access.allows(ctx, { userId, sessionId: request.sessionId, needed: "operator" });
	}

	async function ceilingOf(organisationId: OrganisationId): Promise<VaultCeiling | undefined> {
		return (await read<VaultCeiling>("ceilings", organisationId))?.value;
	}

	async function assertWithinCeiling(organisationId: OrganisationId, route: RouteScope): Promise<void> {
		const ceiling = await ceilingOf(organisationId);
		if (ceiling !== undefined && !ceiling.routes.some((outer) => routeWithin(route, outer))) {
			throw new HarbourError("refused", `The organisation's ceiling does not allow this route to ${route.host}`);
		}
	}

	function assertItemHost(hosts: readonly string[], route: RouteScope): void {
		if (!hosts.includes(route.host)) {
			throw new HarbourError("refused", `The item is not bound to ${route.host}`);
		}
	}

	function assertLifetime(lifetime: { readonly ttlMs?: number; readonly maxUses?: number }): void {
		for (const [label, value] of [
			["ttlMs", lifetime.ttlMs],
			["maxUses", lifetime.maxUses],
		] as const) {
			if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
				throw new HarbourError("invalid", `${label} must be a positive integer`);
			}
		}
	}

	/** A new item and the write that stores it, its value (if any) sealed for version 1. */
	async function newItem(
		input: {
			readonly owner: OwnerRef;
			readonly name: string;
			readonly description?: string;
			readonly hosts: readonly string[];
			readonly injection: VaultItem["injection"];
		},
		value: string | undefined,
	): Promise<{ readonly item: VaultItem; readonly write: VaultWrite }> {
		const now = clock.now();
		const item: VaultItem = {
			id: newId("item"),
			owner: input.owner,
			name: input.name,
			...(input.description === undefined ? {} : { description: input.description }),
			hosts: [...input.hosts],
			injection: { header: input.injection.header, template: input.injection.template },
			placeholder: `harbour://${input.name}/${randomHex(3)}`,
			hasValue: value !== undefined,
			valueVersion: value === undefined ? 0 : 1,
			createdAt: now,
			updatedAt: now,
		};
		const stored: StoredItem = {
			item,
			...(value === undefined ? {} : { sealed: await cipher.seal(value, { itemId: item.id, valueVersion: 1 }) }),
		};
		const organisationId = input.owner.kind === "platform" ? null : input.owner.organisationId;
		return { item, write: insert("items", item.id, organisationId, stored) };
	}

	function assertItemInput(input: {
		readonly name: string;
		readonly hosts: readonly string[];
		readonly injection: VaultItem["injection"];
	}): void {
		if (input.name.trim().length === 0) throw new HarbourError("invalid", "An item needs a name");
		if (input.hosts.length === 0) throw new HarbourError("invalid", "An item needs at least one host");
		for (const host of input.hosts) assertValidHost(host);
		if (input.injection.header.trim().length === 0 || !input.injection.template.includes("{key}")) {
			throw new HarbourError("invalid", "An injection rule needs a header and a template containing {key}");
		}
	}

	function grantView(stored: StoredGrant): Grant {
		const base = { ...stored.grant, uses: stored.uses };
		if (stored.revokedAt !== undefined) {
			return { ...base, status: "revoked", endReason: "revoked", endedAt: stored.revokedAt };
		}
		if (stored.grant.maxUses !== undefined && stored.uses >= stored.grant.maxUses) {
			return {
				...base,
				status: "exhausted",
				endReason: "exhausted",
				...(stored.exhaustedAt === undefined ? {} : { endedAt: stored.exhaustedAt }),
			};
		}
		if (stored.grant.expiresAt !== undefined && clock.now() >= stored.grant.expiresAt) {
			return { ...base, status: "expired", endReason: "expired", endedAt: stored.grant.expiresAt };
		}
		return { ...base, status: "active" };
	}

	function policyActive(stored: StoredPolicy): boolean {
		const { policy } = stored;
		if (policy.revokedAt !== undefined) return false;
		if (policy.lifetime.expiresAt !== undefined && clock.now() >= policy.lifetime.expiresAt) return false;
		return policy.lifetime.maxUses === undefined || stored.uses < policy.lifetime.maxUses;
	}

	/** What a waiting agent hears. An approval's terms come from its decision, read from the store unless given. */
	async function outcomeOf(proposal: Proposal, decided?: Decision): Promise<ProposalOutcome> {
		switch (proposal.status) {
			case "approved": {
				const decision = decided ?? (await read<Decision>("decisions", proposal.decisionId ?? ""))?.value;
				const effectiveTerms = decision?.effectiveTerms;
				const route = effectiveTerms?.route;
				const scope = route === undefined ? "" : ` for ${route.methods.join(", ")} ${route.host}${route.pathPrefix}`;
				return {
					proposalId: proposal.id,
					status: "approved",
					...(effectiveTerms === undefined ? {} : { effectiveTerms }),
					message: `Approved${scope}. ${NO_REQUEST_HAS_RUN} Send the request again to use the grant.`,
				};
			}
			case "denied":
				return { proposalId: proposal.id, status: "denied", message: `Denied. ${NO_REQUEST_HAS_RUN}` };
			case "expired":
				return {
					proposalId: proposal.id,
					status: "expired",
					message: `The proposal expired before anyone decided. ${NO_REQUEST_HAS_RUN}`,
				};
			case "withdrawn":
				return { proposalId: proposal.id, status: "withdrawn", message: `Withdrawn. ${NO_REQUEST_HAS_RUN}` };
			default:
				throw new HarbourError("conflict", `Proposal ${proposal.id} is still pending`);
		}
	}

	/** Resolves this instance's waiters on a settled proposal: the in-process fast path beside the store poll. */
	async function wake(proposal: Proposal, decision?: Decision): Promise<void> {
		if (proposal.status === "pending" || !waiters.has(proposal.id)) return;
		const outcome = await outcomeOf(proposal, decision);
		const waiting = waiters.get(proposal.id);
		waiters.delete(proposal.id);
		if (waiting !== undefined) for (const waiter of waiting) waiter.resolve(outcome);
	}

	async function proposalRecord(organisationId: OrganisationId, proposalId: string): Promise<Read<Proposal>> {
		const found = await read<Proposal>("proposals", proposalId);
		if (found === undefined || found.value.organisationId !== organisationId) {
			throw new HarbourError("not_found", `No proposal ${proposalId}`);
		}
		return found;
	}

	/**
	 * The proposal as of now, with the row it came from: a pending one past its expiry is marked `expired` here, unless
	 * a decision wins the race to settle it, in which case that decision is what is returned.
	 */
	async function currentProposal(organisationId: OrganisationId, proposalId: string): Promise<Read<Proposal>> {
		for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
			const current = await proposalRecord(organisationId, proposalId);
			const proposal = current.value;
			if (proposal.status !== "pending" || clock.now() < proposal.expiresAt) return current;
			const expired: Proposal = { ...proposal, status: "expired" };
			const write = update("proposals", current.row, expired);
			if (await store.commit([write])) {
				await wake(expired);
				return { row: { ...current.row, revision: current.row.revision + 1, data: write.data }, value: expired };
			}
		}
		throw new HarbourError(
			"unavailable",
			`The vault could not read proposal ${proposalId}: too many concurrent changes`,
		);
	}

	async function proposalFor(organisationId: OrganisationId, proposalId: string): Promise<Proposal> {
		return (await currentProposal(organisationId, proposalId)).value;
	}

	function assertPending(proposal: Proposal): void {
		if (proposal.status === "expired") throw new HarbourError("expired", `Proposal ${proposal.id} has expired`);
		if (proposal.status !== "pending") {
			throw new HarbourError("conflict", `Proposal ${proposal.id} is already ${proposal.status}`);
		}
	}

	/** After a settling commit lost its race: answers as the winner left the proposal. */
	async function lostSettlement(organisationId: OrganisationId, proposalId: string): Promise<never> {
		assertPending(await proposalFor(organisationId, proposalId));
		throw new HarbourError("conflict", `Proposal ${proposalId} changed while it was being decided`);
	}

	/** Stores and audits one use: an egress decision or a connector credential read. Never holds a value. */
	async function recordUse(
		request: {
			readonly organisationId: OrganisationId;
			readonly projectId?: ProjectId;
			readonly agentId?: string;
			readonly sessionId?: SessionId;
			readonly method: HttpMethod;
		},
		use: Omit<VaultUse, "id" | "at" | "organisationId" | "method" | "sessionId">,
		extra: { readonly [key: string]: JsonValue } = {},
	): Promise<VaultUse> {
		const record: VaultUse = {
			id: newId("use"),
			at: clock.now(),
			organisationId: request.organisationId,
			...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
			method: request.method,
			...use,
		};
		const stored: StoredUse = {
			use: record,
			...(request.projectId === undefined ? {} : { projectId: request.projectId }),
		};
		await commit([insert("uses", record.id, request.organisationId, stored)]);
		const actor: Actor =
			request.agentId !== undefined && request.sessionId !== undefined
				? { kind: "agent", agentId: request.agentId, sessionId: request.sessionId }
				: { kind: "system", component: "egress" };
		await emit({
			id: `vault:use:${record.id}`,
			type: record.outcome === "injected" ? "vault.use.injected" : "vault.use.denied",
			actor,
			organisationId: request.organisationId,
			...(request.projectId === undefined ? {} : { projectId: request.projectId }),
			...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
			...(request.agentId === undefined ? {} : { agentId: request.agentId }),
			subject: { kind: "vault.use", id: record.id },
			data: {
				method: record.method,
				host: record.host,
				path: record.path,
				...(record.itemId === undefined ? {} : { itemId: record.itemId }),
				...(record.grantId === undefined ? {} : { grantId: record.grantId }),
				...(record.policyId === undefined ? {} : { policyId: record.policyId }),
				...(record.reason === undefined ? {} : { reason: record.reason }),
				...extra,
			},
		});
		return record;
	}

	async function denyEgress(
		request: EgressRequest,
		target: { readonly host: string; readonly path: string; readonly itemId?: string },
		reason: string,
		fix: EgressFix,
	): Promise<EgressDecision> {
		const use = await recordUse(request, { ...target, outcome: "denied", reason });
		return { allow: false, reason, useId: use.id, fix };
	}

	/** Spends one use of a grant, if it is still active when the conditional commit lands. */
	async function spendGrant(grantId: string): Promise<boolean> {
		const { changed } = await updateWith<StoredGrant>("grants", grantId, (stored) => {
			if (grantView(stored).status !== "active") return undefined;
			const uses = stored.uses + 1;
			const spent = stored.grant.maxUses !== undefined && uses >= stored.grant.maxUses;
			return { ...stored, uses, ...(spent ? { exhaustedAt: clock.now() } : {}) };
		});
		return changed;
	}

	/** Spends one use of a policy, if it is still active when the conditional commit lands. */
	async function spendPolicy(policyId: string): Promise<boolean> {
		const { changed } = await updateWith<StoredPolicy>("policies", policyId, (stored) =>
			policyActive(stored) ? { ...stored, uses: stored.uses + 1 } : undefined,
		);
		return changed;
	}

	/** Revokes a grant if it is still active; resolves the grant as stored and whether this call revoked it. */
	async function revokeIfActive(grantId: string, at: number): Promise<{ grant: Grant; revoked: boolean }> {
		const { value, changed } = await updateWith<StoredGrant>("grants", grantId, (stored) =>
			grantView(stored).status === "active" ? { ...stored, revokedAt: at } : undefined,
		);
		return { grant: grantView(value), revoked: changed };
	}

	async function sessionOf(organisationId: OrganisationId, sessionId: SessionId): Promise<StoredSession | undefined> {
		const found = await read<StoredSession>("sessions", sessionRowId(organisationId, sessionId));
		return found !== undefined && found.row.organisationId === organisationId ? found.value : undefined;
	}

	/**
	 * Writes a session's next state, inserting its row the first time: `next` gets the stored session (undefined when
	 * there is none yet) and returns the new one, or undefined to leave it. Conditional on the row read, read again after
	 * a lost race. Resolves the session as stored afterwards and whether this call changed it.
	 */
	async function writeSession(
		organisationId: OrganisationId,
		sessionId: SessionId,
		next: (current: StoredSession | undefined) => StoredSession | undefined,
	): Promise<{ readonly session: StoredSession | undefined; readonly changed: boolean }> {
		const id = sessionRowId(organisationId, sessionId);
		for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
			const current = await read<StoredSession>("sessions", id);
			if (current !== undefined && current.row.organisationId !== organisationId) {
				throw new HarbourError("conflict", `Session ${sessionId} is recorded for another organisation`);
			}
			const changed = next(current?.value);
			if (changed === undefined) return { session: current?.value, changed: false };
			const write =
				current === undefined
					? insert("sessions", id, organisationId, changed)
					: update("sessions", current.row, changed);
			if (await store.commit([write])) return { session: changed, changed: true };
		}
		throw new HarbourError(
			"unavailable",
			`The vault could not update session ${sessionId}: too many concurrent changes`,
		);
	}

	function emptySession(organisationId: OrganisationId, sessionId: SessionId): StoredSession {
		return { sessionId, organisationId, generation: 0, placeholders: [] };
	}

	function sessionAccessView(sessionId: SessionId, stored: StoredSession | undefined): SessionAccess {
		const blocked = stored?.blocked;
		return {
			sessionId,
			blocked: blocked !== undefined,
			...(blocked === undefined ? {} : { blockedAt: blocked.at, blockedBy: blocked.by }),
			...(blocked?.reason === undefined ? {} : { reason: blocked.reason }),
			...(stored?.endedAt === undefined ? {} : { endedAt: stored.endedAt }),
			generation: stored?.generation ?? 0,
		};
	}

	/** Why nothing the session holds works now, if that is so: it has ended, or an operator blocked it. */
	function sessionClosed(stored: StoredSession | undefined): string | undefined {
		if (stored === undefined) return undefined;
		if (stored.endedAt !== undefined) return `Session ${stored.sessionId} has ended`;
		if (stored.blocked !== undefined) return `Session ${stored.sessionId} is blocked`;
		return undefined;
	}

	/** A new placeholder: random, never derived from a value or an earlier placeholder. */
	function newPlaceholder(): string {
		return `harbour-ph-${randomHex(16)}`;
	}

	const vault: HarbourVault = {
		async putItem(ctx, input) {
			forbidAgent(ctx, "create vault items");
			const owner = input.owner;
			if (owner.kind === "platform") {
				// Platform items are Harbour's operator's: only a system caller creates one, outside any organisation.
				await requireSystem(ctx, "vault.putItem", { ...(audit === undefined ? {} : { audit }), clock });
			} else if (owner.organisationId !== ctx.organisationId) {
				throw new HarbourError("invalid", "An item must be owned within the caller's organisation");
			} else if (owner.kind === "user" && owner.userId.trim() === "") {
				throw new HarbourError("invalid", "A user's item must name its user");
			} else if (access !== undefined) {
				// A user's own item is made by that user, or a service acting for its users; never by another person.
				await access.require(ctx, { ...ownerScope(owner), needed: "admin", operation: "vault.putItem" });
			}
			assertItemInput(input);
			if (input.value !== undefined && input.value.length === 0) {
				throw new HarbourError("invalid", "An item value cannot be empty");
			}
			const { item, write } = await newItem(input, input.value);
			await commit([write]);
			await emit({
				id: `vault:item:${item.id}:created`,
				type: "vault.item.created",
				actor: ctx.actor,
				organisationId: owner.kind === "platform" ? PLATFORM_ORGANISATION : ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "vault.item", id: item.id },
				data: {
					name: item.name,
					hosts: [...item.hosts],
					hasValue: item.hasValue,
					...(owner.kind === "platform" ? { owner: "platform" } : {}),
				},
			});
			return item;
		},

		async getItem(ctx, itemId) {
			const scope = itemScope(await itemFor(ctx.organisationId, itemId));
			if (access !== undefined && scoped(scope)) {
				const subject = { kind: "vault.item", id: itemId };
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getItem", subject });
			}
			return itemFor(ctx.organisationId, itemId);
		},

		async listItems(ctx, page) {
			const own = (await readAll<StoredItem>("items", ctx.organisationId)).map((found) => found.value.item);
			return paginate(await visibleOnly(ctx, own, itemScope), page);
		},

		async setCeiling(ctx, routes) {
			forbidAgent(ctx, "set the organisation's ceiling");
			if (access !== undefined) await access.require(ctx, { needed: "admin", operation: "vault.setCeiling" });
			for (const route of routes) assertValidRoute(route);
			const ceiling: VaultCeiling = {
				organisationId: ctx.organisationId,
				routes: routes.map((route) => ({ ...route, methods: [...route.methods] })),
			};
			let stored = false;
			for (let attempt = 0; attempt < MAX_RETRIES && !stored; attempt += 1) {
				const current = await store.get("ceilings", ctx.organisationId);
				stored = await store.commit([
					current === undefined
						? insert("ceilings", ctx.organisationId, ctx.organisationId, ceiling)
						: update("ceilings", current, ceiling),
				]);
			}
			if (!stored) throw new HarbourError("unavailable", "The ceiling could not be set: too many concurrent changes");
			await emit({
				type: "vault.ceiling.set",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				data: { routes: ceiling.routes.map(routeJson) },
			});
			return ceiling;
		},

		async getCeiling(ctx) {
			if (access !== undefined) await access.require(ctx, { needed: "viewer", operation: "vault.getCeiling" });
			const ceiling = await ceilingOf(ctx.organisationId);
			if (ceiling === undefined) throw new HarbourError("not_found", "The organisation has no ceiling");
			return ceiling;
		},

		async putPolicy(ctx, input) {
			forbidAgent(ctx, "create vault policies");
			if (input.selector.organisationId !== ctx.organisationId) {
				throw new HarbourError("invalid", "A policy selector must name the caller's organisation");
			}
			assertValidRoute(input.route);
			const lifetime: Lifetime = input.lifetime ?? {};
			if (lifetime.maxUses !== undefined && (!Number.isInteger(lifetime.maxUses) || lifetime.maxUses < 1)) {
				throw new HarbourError("invalid", "maxUses must be a positive integer");
			}
			const item = await itemFor(ctx.organisationId, input.itemId);
			if (access !== undefined) {
				const subject = { kind: "vault.item", id: item.id };
				await access.require(ctx, { ...itemScope(item), needed: "admin", operation: "vault.putPolicy", subject });
			}
			assertItemHost(item.hosts, input.route);
			await assertWithinCeiling(ctx.organisationId, input.route);
			const policy: VaultPolicy = {
				id: newId("policy"),
				itemId: item.id,
				selector: { ...input.selector },
				route: { ...input.route, methods: [...input.route.methods] },
				lifetime: { ...lifetime },
				createdBy: ctx.actor,
				createdAt: clock.now(),
			};
			const stored: StoredPolicy = { policy, uses: 0 };
			await commit([insert("policies", policy.id, ctx.organisationId, stored)]);
			await emit({
				id: `vault:policy:${policy.id}:created`,
				type: "vault.policy.created",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "vault.policy", id: policy.id },
				data: { itemId: item.id, route: routeJson(policy.route) },
			});
			return policy;
		},

		async revokePolicy(ctx, policyId) {
			forbidAgent(ctx, "revoke vault policies");
			const found = await read<StoredPolicy>("policies", policyId);
			if (found === undefined || found.row.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No policy ${policyId}`);
			}
			if (access !== undefined) {
				const scope = itemScope(await itemFor(ctx.organisationId, found.value.policy.itemId));
				const subject = { kind: "vault.policy", id: policyId };
				await access.require(ctx, { ...scope, needed: "admin", operation: "vault.revokePolicy", subject });
			}
			const at = clock.now();
			const { changed } = await updateWith<StoredPolicy>("policies", policyId, (stored) =>
				stored.policy.revokedAt === undefined ? { ...stored, policy: { ...stored.policy, revokedAt: at } } : undefined,
			);
			if (!changed) return;
			await emit({
				id: `vault:policy:${policyId}:revoked`,
				type: "vault.policy.revoked",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "vault.policy", id: policyId },
			});
		},

		async listPolicies(ctx, page) {
			const own = (await readAll<StoredPolicy>("policies", ctx.organisationId)).map((found) => found.value.policy);
			// A policy on a user's own item is that user's to see, as the item is.
			const users = new Map<string, string>();
			for (const { value } of await readAll<StoredItem>("items", ctx.organisationId)) {
				const userId = itemUser(value.item);
				if (userId !== undefined) users.set(value.item.id, userId);
			}
			const scopeOf = (policy: VaultPolicy): Scope => {
				const userId = users.get(policy.itemId);
				return { ...selectorScope(policy.selector), ...(userId === undefined ? {} : { userId }) };
			};
			return paginate(await visibleOnly(ctx, own, scopeOf), page);
		},

		async propose(ctx, proposed) {
			// A private copy, so the caller cannot change the terms after they are hashed.
			const terms: ProposalTerms = structuredClone(proposed);
			if (terms.reason.trim().length === 0) throw new HarbourError("invalid", "A proposal needs a reason");
			assertValidRoute(terms.route);
			assertLifetime(terms.lifetime);
			if (terms.secret !== undefined) assertItemInput(terms.secret);
			else if (terms.itemId === undefined) throw new HarbourError("invalid", "A proposal needs an item or a secret");
			const named = terms.itemId === undefined ? undefined : await itemFor(ctx.organisationId, terms.itemId);
			const actor = ctx.actor;
			// With access, the proposal's project is the one the check resolved: an agent's own session's project, which must
			// be the item's when the item belongs to a project.
			let projectId = ctx.projectId;
			if (access !== undefined) {
				const itemProject = named === undefined ? undefined : itemScope(named).projectId;
				// A user's own item: only through a session that works for that user, or as that user.
				const userId = itemUser(named);
				// An agent acts through its own session; a human or service on the item's project, else the call's.
				const checked = actor.kind === "agent" ? itemProject : (itemProject ?? ctx.projectId);
				const scope: Scope = {
					...(checked === undefined ? {} : { projectId: checked }),
					...(actor.kind === "agent" ? { sessionId: actor.sessionId } : {}),
					...(userId === undefined ? {} : { userId }),
				};
				const subject = named === undefined ? {} : { subject: { kind: "vault.item", id: named.id } };
				if (
					named !== undefined &&
					named.owner.kind === "project" &&
					!(await access.allows(ctx, { ...scope, needed: "operator" }))
				) {
					// Another project's item, shared into where the caller acts (docs/design/sharing.md): the proposal is in the
					// caller's project and decided there, with its route, binding code and the ceiling as for any other.
					const resolved = await access.resource(ctx, {
						resource: { kind: "vault.item", id: named.id },
						owner: named.owner,
						permission: "use",
						needed: "operator",
						...(actor.kind !== "agent" && ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
						operation: "vault.propose",
					});
					if (resolved.via !== "share" || resolved.projectId === undefined) {
						throw new HarbourError("forbidden", "The caller may not do this in this project", {
							operation: "vault.propose",
						});
					}
					projectId = resolved.projectId;
				} else {
					const resolved = await access.require(ctx, {
						...scope,
						needed: "operator",
						operation: "vault.propose",
						...subject,
					});
					projectId = resolved.projectId;
				}
			}
			if (named !== undefined) {
				const existing = await itemFor(ctx.organisationId, named.id);
				if (terms.secret !== undefined && existing.hasValue) {
					throw new HarbourError("conflict", `Item ${existing.id} already has a value`);
				}
				assertItemHost(existing.hosts, terms.route);
			} else {
				assertItemHost(terms.secret!.hosts, terms.route);
			}
			await assertWithinCeiling(ctx.organisationId, terms.route);

			const id = newId("proposal");
			const termsHash = await hashTerms(terms);
			const now = clock.now();
			const proposal: Proposal = {
				id,
				organisationId: ctx.organisationId,
				...(projectId === undefined ? {} : { projectId }),
				requester: actor.kind === "agent" ? { actor, agentId: actor.agentId, sessionId: actor.sessionId } : { actor },
				kind: classifyProposal(terms),
				terms,
				termsHash,
				bindingCode: await deriveBindingCode(id, termsHash),
				status: "pending",
				createdAt: now,
				expiresAt: now + proposalTtlMs,
				link: `${linkBase}/requests/${id}`,
			};
			await commit([insert("proposals", id, ctx.organisationId, proposal)]);
			await emit({
				id: `vault:proposal:${id}:created`,
				type: "vault.proposal.created",
				actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				...(projectId === undefined ? {} : { projectId }),
				subject: { kind: "vault.proposal", id },
				data: {
					kind: proposal.kind,
					termsHash,
					bindingCode: proposal.bindingCode,
					route: routeJson(terms.route),
					...(terms.itemId === undefined ? {} : { itemId: terms.itemId }),
				},
			});
			return proposal;
		},

		async getProposal(ctx, proposalId) {
			const found = await proposalFor(ctx.organisationId, proposalId);
			const scope = proposalScope(found);
			if (access !== undefined && scoped(scope)) {
				// The user whose own item it names reads it too, to decide it, wherever the session runs.
				const userId = itemUser(await proposalItem(ctx.organisationId, found));
				const owner =
					userId !== undefined &&
					ctx.actor.kind !== "agent" &&
					(await access.allows(ctx, { userId, needed: "viewer" }));
				const subject = { kind: "vault.proposal", id: proposalId };
				if (!owner) await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getProposal", subject });
			}
			return proposalFor(ctx.organisationId, proposalId);
		},

		async listProposals(ctx, filter, page) {
			const sessionId = filter?.sessionId;
			if (access !== undefined && sessionId !== undefined) {
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.listProposals" });
			}
			const own: Proposal[] = [];
			for (const { value } of await readAll<Proposal>("proposals", ctx.organisationId)) {
				const expiring = value.status === "pending" && clock.now() >= value.expiresAt;
				own.push(expiring ? await proposalFor(ctx.organisationId, value.id) : value);
			}
			const matching = own.filter(
				(proposal) =>
					(filter?.status === undefined || proposal.status === filter.status) &&
					(sessionId === undefined || proposal.requester.sessionId === sessionId),
			);
			return paginate(sessionId === undefined ? await visibleOnly(ctx, matching, proposalScope) : matching, page);
		},

		async approvalView(ctx, proposalId) {
			forbidAgent(ctx, "open the approval view");
			const found = await proposalFor(ctx.organisationId, proposalId);
			if (access !== undefined) {
				const scope = decisionScope(found, await proposalItem(ctx.organisationId, found));
				const subject = { kind: "vault.proposal", id: proposalId };
				await access.require(ctx, { ...scope, needed: "operator", operation: "vault.approvalView", subject });
			}
			const proposal = await proposalFor(ctx.organisationId, proposalId);
			return {
				proposal,
				codeChoices: codeChoices(proposal.bindingCode, proposal.id),
				codeRequired: CODE_REQUIRED_KINDS.includes(proposal.kind),
			};
		},

		async decide(ctx, input) {
			forbidAgent(ctx, "decide proposals");
			const found = await proposalFor(ctx.organisationId, input.proposalId);
			if (access !== undefined) {
				const scope = decisionScope(found, await proposalItem(ctx.organisationId, found));
				const subject = { kind: "vault.proposal", id: found.id };
				await access.require(ctx, { ...scope, needed: "operator", operation: "vault.decide", subject });
			}
			// Read again: the proposal may have been decided, withdrawn or expired during the check.
			const current = await currentProposal(ctx.organisationId, input.proposalId);
			const proposal = current.value;
			assertPending(proposal);
			if (deciding.has(proposal.id)) {
				throw new HarbourError("conflict", `Proposal ${proposal.id} is already being decided`);
			}
			deciding.add(proposal.id);
			try {
				const now = clock.now();
				const auditBase = {
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(proposal.projectId === undefined ? {} : { projectId: proposal.projectId }),
					...(proposal.requester.sessionId === undefined ? {} : { sessionId: proposal.requester.sessionId }),
					...(proposal.requester.agentId === undefined ? {} : { agentId: proposal.requester.agentId }),
					subject: { kind: "vault.proposal", id: proposal.id },
				};
				/**
				 * Commits the settlement and everything that comes with it at once, only while the proposal is still the
				 * pending one read above and the clock reads before its expiry: one decision ever wins. The commit's condition
				 * is the row's revision, not the clock, so a commit already under way as the expiry passes may land; an expiry
				 * stored first makes it lose (CONTRACT.md, "Races across processes").
				 */
				const settle = async (settled: Proposal, writes: readonly VaultWrite[]): Promise<void> => {
					if (clock.now() >= proposal.expiresAt) await lostSettlement(ctx.organisationId, proposal.id);
					if (!(await store.commit([update("proposals", current.row, settled), ...writes]))) {
						await lostSettlement(ctx.organisationId, proposal.id);
					}
				};

				if (input.outcome === "deny") {
					const decision: Decision = {
						id: newId("decision"),
						proposalId: proposal.id,
						outcome: "denied",
						decidedBy: ctx.actor,
						decidedAt: now,
						...(input.note === undefined ? {} : { note: input.note }),
					};
					const denied: Proposal = { ...proposal, status: "denied", decisionId: decision.id };
					await settle(denied, [insert("decisions", decision.id, ctx.organisationId, decision)]);
					await wake(denied, decision);
					await emit({ ...auditBase, id: `vault:decision:${decision.id}`, type: "vault.decision.denied" });
					return decision;
				}

				if (input.termsHash !== proposal.termsHash) {
					throw new HarbourError("refused", "The decision cites terms other than the proposal's");
				}
				const codeRequired = CODE_REQUIRED_KINDS.includes(proposal.kind);
				if ((codeRequired || input.pickedCode !== undefined) && input.pickedCode !== proposal.bindingCode) {
					await emit({
						...auditBase,
						type: "vault.binding_code.mismatch",
						data: { kind: proposal.kind, pickedCode: input.pickedCode ?? null },
					});
					throw new HarbourError("refused", "The picked code does not match the proposal's binding code");
				}
				const terms = narrow(proposal.terms, input.narrowing);
				await assertWithinCeiling(ctx.organisationId, terms.route);
				const secret = terms.secret;
				if (secret !== undefined) {
					if (input.secretValue === undefined || input.secretValue.length === 0) {
						throw new HarbourError("invalid", "Approving a secret proposal needs the pasted value");
					}
					if (terms.itemId !== undefined && (await itemFor(ctx.organisationId, terms.itemId)).hasValue) {
						throw new HarbourError("conflict", `Item ${terms.itemId} already has a value`);
					}
				}

				// Everything the approval changes is committed together below; audit events are written afterwards.
				const writes: VaultWrite[] = [];
				const afterwards: Parameters<typeof emit>[0][] = [];
				let itemId: string;
				if (secret === undefined) {
					itemId = (await itemFor(ctx.organisationId, terms.itemId!)).id;
				} else if (terms.itemId !== undefined) {
					// The pasted value goes onto the valueless item, conditional on its row being the one read here.
					const existing = await itemRecord(ctx.organisationId, terms.itemId);
					// Checked again on the very row the conditional update is built from: another approval may have given the
					// item a value since the check above, and that value must not be overwritten.
					if (existing.value.item.hasValue) {
						throw new HarbourError("conflict", `Item ${terms.itemId} already has a value`);
					}
					const valueVersion = existing.value.item.valueVersion + 1;
					const item: VaultItem = { ...existing.value.item, hasValue: true, valueVersion, updatedAt: now };
					const sealed = await cipher.seal(input.secretValue!, { itemId: item.id, valueVersion });
					writes.push(update("items", existing.row, { item, sealed } satisfies StoredItem));
					itemId = item.id;
				} else {
					const owner: OwnerRef =
						proposal.projectId === undefined
							? { kind: "organisation", organisationId: ctx.organisationId }
							: { kind: "project", organisationId: ctx.organisationId, projectId: proposal.projectId };
					const { item, write } = await newItem({ ...secret, owner }, input.secretValue);
					writes.push(write);
					itemId = item.id;
					afterwards.push({
						...auditBase,
						id: `vault:item:${item.id}:created`,
						type: "vault.item.created",
						subject: { kind: "vault.item", id: item.id },
						data: { name: item.name, hosts: [...item.hosts], hasValue: true, proposalId: proposal.id },
					});
				}

				const effectiveTerms: EffectiveTerms = {
					itemId,
					route: terms.route,
					...(terms.lifetime.ttlMs === undefined ? {} : { expiresAt: now + terms.lifetime.ttlMs }),
					...(terms.lifetime.maxUses === undefined ? {} : { maxUses: terms.lifetime.maxUses }),
				};
				const decisionId = newId("decision");
				const grantId = newId("grant");
				const selector: PolicySelector = {
					organisationId: ctx.organisationId,
					...(proposal.projectId === undefined ? {} : { projectId: proposal.projectId }),
					...(proposal.requester.agentId === undefined ? {} : { agentId: proposal.requester.agentId }),
					...(proposal.requester.sessionId === undefined ? {} : { sessionId: proposal.requester.sessionId }),
				};
				const grant: StoredGrant = {
					grant: {
						id: grantId,
						proposalId: proposal.id,
						decisionId,
						itemId,
						selector,
						route: effectiveTerms.route,
						...(effectiveTerms.expiresAt === undefined ? {} : { expiresAt: effectiveTerms.expiresAt }),
						...(effectiveTerms.maxUses === undefined ? {} : { maxUses: effectiveTerms.maxUses }),
						createdAt: now,
					},
					uses: 0,
				};
				const decision: Decision = {
					id: decisionId,
					proposalId: proposal.id,
					outcome: "approved",
					decidedBy: ctx.actor,
					decidedAt: now,
					effectiveTerms,
					grantId,
					...(input.note === undefined ? {} : { note: input.note }),
				};
				writes.push(insert("grants", grantId, ctx.organisationId, grant));
				writes.push(insert("decisions", decisionId, ctx.organisationId, decision));
				const approved: Proposal = { ...proposal, status: "approved", decisionId };
				await settle(approved, writes);
				await wake(approved, decision);
				for (const event of afterwards) await emit(event);
				await emit({
					...auditBase,
					id: `vault:decision:${decisionId}`,
					type: "vault.decision.approved",
					data: {
						kind: proposal.kind,
						termsHash: proposal.termsHash,
						itemId,
						grantId,
						route: routeJson(effectiveTerms.route),
						...(effectiveTerms.expiresAt === undefined ? {} : { expiresAt: effectiveTerms.expiresAt }),
						...(effectiveTerms.maxUses === undefined ? {} : { maxUses: effectiveTerms.maxUses }),
					},
				});
				return decision;
			} finally {
				deciding.delete(proposal.id);
			}
		},

		async withdraw(ctx, proposalId) {
			const found = await proposalFor(ctx.organisationId, proposalId);
			const actor = ctx.actor;
			if (
				actor.kind === "agent" &&
				(actor.agentId !== found.requester.agentId || actor.sessionId !== found.requester.sessionId)
			) {
				throw new HarbourError("forbidden", "An agent can only withdraw its own proposals");
			}
			if (access !== undefined) {
				const subject = { kind: "vault.proposal", id: proposalId };
				await access.require(ctx, {
					...proposalScope(found),
					needed: "operator",
					operation: "vault.withdraw",
					subject,
				});
			}
			const current = await currentProposal(ctx.organisationId, proposalId);
			const proposal = current.value;
			assertPending(proposal);
			if (deciding.has(proposal.id)) {
				throw new HarbourError("conflict", `Proposal ${proposal.id} is being decided`);
			}
			const withdrawn: Proposal = { ...proposal, status: "withdrawn" };
			if (!(await store.commit([update("proposals", current.row, withdrawn)]))) {
				await lostSettlement(ctx.organisationId, proposalId);
			}
			await wake(withdrawn);
			await emit({
				id: `vault:proposal:${proposalId}:withdrawn`,
				type: "vault.proposal.withdrawn",
				actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "vault.proposal", id: proposalId },
			});
			return withdrawn;
		},

		async waitForOutcome(ctx, proposalId) {
			const signal = ctx.signal;
			if (signal?.aborted) throw new HarbourError("aborted", "The wait was aborted");
			const scope = proposalScope(await proposalFor(ctx.organisationId, proposalId));
			if (access !== undefined && scoped(scope)) {
				const subject = { kind: "vault.proposal", id: proposalId };
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.waitForOutcome", subject });
			}
			if (signal?.aborted) throw new HarbourError("aborted", "The wait was aborted");
			const set = waiters.get(proposalId) ?? new Set<Waiter>();
			waiters.set(proposalId, set);
			const leave = (waiter: Waiter) => {
				set.delete(waiter);
				if (set.size > 0) return;
				if (waiters.get(proposalId) === set) waiters.delete(proposalId);
				stopPoll(proposalId);
			};
			// Registered before the last read, so a decision committed meanwhile through this instance wakes it too.
			let registered: Waiter | undefined;
			const waiting = new Promise<ProposalOutcome>((resolve, reject) => {
				const onAbort = () => {
					leave(waiter);
					reject(new HarbourError("aborted", "The wait was aborted"));
				};
				const waiter: Waiter = {
					resolve(outcome) {
						stopPoll(proposalId);
						signal?.removeEventListener("abort", onAbort);
						resolve(outcome);
					},
				};
				registered = waiter;
				set.add(waiter);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			// An abort during the read below rejects `waiting` before it is returned; the caller still sees the rejection.
			waiting.catch(() => undefined);
			try {
				const proposal = await proposalFor(ctx.organisationId, proposalId);
				if (proposal.status !== "pending") await wake(proposal);
				else if (set.has(registered!)) startPoll(ctx.organisationId, proposalId);
			} catch (error) {
				leave(registered!);
				throw error;
			}
			return waiting;
		},

		async getGrant(ctx, grantId) {
			const found = await read<StoredGrant>("grants", grantId);
			if (found === undefined || found.row.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No grant ${grantId}`);
			}
			const scope = selectorScope(found.value.grant.selector);
			if (access !== undefined && scoped(scope)) {
				const subject = { kind: "vault.grant", id: grantId };
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getGrant", subject });
			}
			return grantView(found.value);
		},

		async listGrants(ctx, filter, page) {
			const sessionId = filter?.sessionId;
			if (access !== undefined && sessionId !== undefined) {
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.listGrants" });
			}
			const own = (await readAll<StoredGrant>("grants", ctx.organisationId))
				.map((found) => grantView(found.value))
				.filter(
					(grant) =>
						(filter?.status === undefined || grant.status === filter.status) &&
						(sessionId === undefined || grant.selector.sessionId === sessionId),
				);
			const visible =
				sessionId === undefined ? await visibleOnly(ctx, own, (grant) => selectorScope(grant.selector)) : own;
			return paginate(visible, page);
		},

		async revokeGrant(ctx, grantId, reason) {
			forbidAgent(ctx, "revoke grants");
			const found = await read<StoredGrant>("grants", grantId);
			if (found === undefined || found.row.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No grant ${grantId}`);
			}
			if (access !== undefined) {
				const scope = selectorScope(found.value.grant.selector);
				const subject = { kind: "vault.grant", id: grantId };
				await access.require(ctx, { ...scope, needed: "operator", operation: "vault.revokeGrant", subject });
			}
			const { grant, revoked } = await revokeIfActive(grantId, clock.now());
			if (!revoked) return grant;
			await emit({
				id: `vault:grant:${grantId}:revoked`,
				type: "vault.grant.revoked",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "vault.grant", id: grantId },
				...(reason === undefined ? {} : { data: { reason } }),
			});
			return grant;
		},

		async listUses(ctx, filter, page) {
			const sessionId = filter?.sessionId;
			if (access !== undefined && sessionId !== undefined) {
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.listUses" });
			}
			const own = (await readAll<StoredUse>("uses", ctx.organisationId))
				.map((found) => found.value)
				.filter(({ use }) => sessionId === undefined || use.sessionId === sessionId);
			const visible =
				sessionId === undefined
					? await visibleOnly(ctx, own, (stored) => ({
							...(stored.projectId === undefined ? {} : { projectId: stored.projectId }),
							...(stored.use.sessionId === undefined ? {} : { sessionId: stored.use.sessionId }),
						}))
					: own;
			return paginate(
				visible.map((stored) => stored.use),
				page,
			);
		},

		async endSession(ctx, sessionId, reason) {
			if (access !== undefined) {
				await access.require(ctx, { sessionId, needed: "operator", operation: "vault.endSession" });
			}
			// Each change is its own conditional commit, so a grant or proposal another call ends first is left to it and
			// audited once, by whoever ended it. Audit events are written after every change.
			//
			// Pending proposals are withdrawn before the grants are scanned, never after: an approval racing the teardown
			// either loses its conditional commit to the withdrawal, or wins it and so has stored its grant before the
			// scan below reads the grants, which then revokes it. Scanning grants first would let an approval landing
			// between the two phases escape both.
			const now = clock.now();
			const afterwards: Parameters<typeof emit>[0][] = [];
			if (reason === "session_ended") {
				for (const { value: candidate } of await readAll<Proposal>("proposals", ctx.organisationId)) {
					if (candidate.requester.sessionId !== sessionId || candidate.status !== "pending") continue;
					const current = await currentProposal(ctx.organisationId, candidate.id);
					const proposal = current.value;
					if (proposal.status !== "pending") continue;
					// A decision in flight on it loses its conditional commit (see decide), so it is withdrawn regardless.
					const withdrawn: Proposal = { ...proposal, status: "withdrawn" };
					if (!(await store.commit([update("proposals", current.row, withdrawn)]))) continue;
					await wake(withdrawn);
					afterwards.push({
						id: `vault:proposal:${proposal.id}:withdrawn`,
						type: "vault.proposal.withdrawn",
						actor: ctx.actor,
						organisationId: ctx.organisationId,
						...(proposal.projectId === undefined ? {} : { projectId: proposal.projectId }),
						sessionId,
						...(proposal.requester.agentId === undefined ? {} : { agentId: proposal.requester.agentId }),
						subject: { kind: "vault.proposal", id: proposal.id },
						data: { reason },
					});
				}
			}
			for (const { value } of await readAll<StoredGrant>("grants", ctx.organisationId)) {
				const { id, selector } = value.grant;
				if (selector.sessionId !== sessionId || grantView(value).status !== "active") continue;
				if (!(await revokeIfActive(id, now)).revoked) continue;
				afterwards.push({
					id: `vault:grant:${id}:revoked`,
					type: "vault.grant.revoked",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(selector.projectId === undefined ? {} : { projectId: selector.projectId }),
					sessionId,
					...(selector.agentId === undefined ? {} : { agentId: selector.agentId }),
					subject: { kind: "vault.grant", id },
					data: { reason },
				});
			}
			if (reason === "session_ended") {
				// Closed for good: its placeholders stop working and nothing it sends gets a credential again, whatever policy
				// would match. Not audited on its own: the session's end is.
				await writeSession(ctx.organisationId, sessionId, (current) =>
					current?.endedAt !== undefined
						? undefined
						: { ...(current ?? emptySession(ctx.organisationId, sessionId)), placeholders: [], endedAt: now },
				);
			}
			for (const event of afterwards) await emit(event);
		},

		async issueSessionPlaceholders(ctx, request) {
			const named: unknown = typeof request === "object" && request !== null ? request.organisationId : undefined;
			await requireSystem(ctx, "vault.issueSessionPlaceholders", {
				...(audit === undefined ? {} : { audit }),
				clock,
				...(typeof named === "string" ? { organisationId: named } : {}),
			});
			const candidate = request as Partial<SessionPlaceholderRequest> | undefined;
			if (
				!isString(candidate?.organisationId) ||
				!isString(candidate?.sessionId) ||
				(candidate.projectId !== undefined && !isString(candidate.projectId)) ||
				(candidate.agentId !== undefined && !isString(candidate.agentId))
			) {
				throw new HarbourError("invalid", "Placeholders are issued for an organisation's session");
			}
			const { organisationId, sessionId, projectId } = request;
			// Every item with a value the session could be granted: its organisation's own, and its project's. Never a
			// person's own item or another project's, whose names the sandbox has no business seeing.
			const items = (await readAll<StoredItem>("items", organisationId))
				.map((found) => found.value.item)
				.filter(
					(item) =>
						item.hasValue &&
						(item.owner.kind === "organisation" ||
							(item.owner.kind === "project" && item.owner.projectId === projectId)),
				);
			const issuedAt = clock.now();
			const issued = items.map((item) => ({ item, placeholder: newPlaceholder() }));
			const { session } = await writeSession(organisationId, sessionId, (current) => {
				if (current?.endedAt !== undefined) {
					throw new HarbourError("refused", `Session ${sessionId} has ended: it gets no placeholders`);
				}
				const base = current ?? emptySession(organisationId, sessionId);
				return {
					...base,
					...(projectId === undefined ? {} : { projectId }),
					generation: base.generation + 1,
					issuedAt,
					placeholders: issued.map(({ item, placeholder }) => ({ itemId: item.id, placeholder })),
				};
			});
			const generation = session?.generation ?? 1;
			await emit({
				type: "vault.session.placeholders_issued",
				actor: ctx.actor,
				organisationId,
				...(projectId === undefined ? {} : { projectId }),
				sessionId,
				...(request.agentId === undefined ? {} : { agentId: request.agentId }),
				subject: { kind: "vault.session", id: sessionId },
				// The items only: a placeholder is a credential of a kind, and the audit trail never holds one.
				data: { generation, itemIds: issued.map(({ item }) => item.id) },
			});
			const placeholders: SessionPlaceholder[] = issued.map(({ item, placeholder }) => ({
				itemId: item.id,
				name: item.name,
				hosts: [...item.hosts],
				header: item.injection.header,
				placeholder,
			}));
			const result: SessionPlaceholders = { sessionId, generation, issuedAt, placeholders };
			return result;
		},

		async setSessionAccess(ctx, sessionId, input) {
			forbidAgent(ctx, "block or unblock sessions");
			const blocked: unknown = (input as { blocked?: unknown } | undefined)?.blocked;
			const reason: unknown = (input as { reason?: unknown } | undefined)?.reason;
			if (typeof blocked !== "boolean" || (reason !== undefined && typeof reason !== "string")) {
				throw new HarbourError("invalid", "Session access is { blocked, reason? }: a boolean and a string");
			}
			if (!isString(sessionId)) throw new HarbourError("invalid", "Name the session to block or unblock");
			let projectId: ProjectId | undefined;
			if (access !== undefined) {
				const operation = "vault.setSessionAccess";
				const subject = { kind: "vault.session", id: sessionId };
				projectId = (await access.require(ctx, { sessionId, needed: "operator", operation, subject })).projectId;
			}
			const at = clock.now();
			const kept = reason === undefined ? undefined : reason.trim().slice(0, MAX_BLOCK_REASON);
			const { session, changed } = await writeSession(ctx.organisationId, sessionId, (current) => {
				if (blocked === (current?.blocked !== undefined)) return undefined;
				const base = current ?? {
					...emptySession(ctx.organisationId, sessionId),
					...(projectId === undefined ? {} : { projectId }),
				};
				if (!blocked) {
					const { blocked: _unblocked, ...open } = base;
					return open;
				}
				return {
					...base,
					blocked: { at, by: ctx.actor, ...(kept === undefined || kept === "" ? {} : { reason: kept }) },
				};
			});
			if (changed) {
				await emit({
					type: blocked ? "vault.session.blocked" : "vault.session.unblocked",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...contextFields(ctx),
					...(session?.projectId === undefined ? {} : { projectId: session.projectId }),
					sessionId,
					subject: { kind: "vault.session", id: sessionId },
					...(blocked && kept !== undefined && kept !== "" ? { data: { reason: kept } } : {}),
				});
			}
			return sessionAccessView(sessionId, session);
		},

		async getSessionAccess(ctx, sessionId) {
			if (!isString(sessionId)) throw new HarbourError("invalid", "Name the session");
			if (access !== undefined) {
				const subject = { kind: "vault.session", id: sessionId };
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.getSessionAccess", subject });
			}
			return sessionAccessView(sessionId, await sessionOf(ctx.organisationId, sessionId));
		},

		async getSessionUsage(ctx, sessionId) {
			if (!isString(sessionId)) throw new HarbourError("invalid", "Name the session");
			if (access !== undefined) {
				const subject = { kind: "vault.session", id: sessionId };
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.getSessionUsage", subject });
			}
			const uses = (await readAll<StoredUse>("uses", ctx.organisationId))
				.map((found) => found.value.use)
				.filter((use) => use.sessionId === sessionId);
			const hosts = new Map<string, { host: string; injected: number; denied: number }>();
			let injected = 0;
			let firstAt: number | undefined;
			let lastAt: number | undefined;
			for (const use of uses) {
				const entry = hosts.get(use.host) ?? { host: use.host, injected: 0, denied: 0 };
				if (use.outcome === "injected") {
					injected += 1;
					entry.injected += 1;
				} else {
					entry.denied += 1;
				}
				hosts.set(use.host, entry);
				firstAt = firstAt === undefined ? use.at : Math.min(firstAt, use.at);
				lastAt = lastAt === undefined ? use.at : Math.max(lastAt, use.at);
			}
			const usage: SessionEgressUsage = {
				sessionId,
				requests: uses.length,
				injected,
				denied: uses.length - injected,
				hosts: [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host)),
				...(firstAt === undefined ? {} : { firstAt }),
				...(lastAt === undefined ? {} : { lastAt }),
			};
			return usage;
		},

		async assertSessionOpen(ctx, scope) {
			const named: unknown = typeof scope === "object" && scope !== null ? scope.organisationId : undefined;
			await requireSystem(ctx, "vault.assertSessionOpen", {
				...(audit === undefined ? {} : { audit }),
				clock,
				...(typeof named === "string" ? { organisationId: named } : {}),
			});
			if (!isString(scope?.organisationId) || !isString(scope?.sessionId)) {
				throw new HarbourError("invalid", "Name the session's organisation and session");
			}
			const closed = sessionClosed(await sessionOf(scope.organisationId, scope.sessionId));
			if (closed !== undefined) throw new HarbourError("refused", `${closed}: its model calls are refused`);
		},

		async decideEgress(ctx, request) {
			// Only the egress gateway asks, as system; anyone else learns nothing and records no use (question 13).
			const named: unknown = typeof request === "object" && request !== null ? request.organisationId : undefined;
			await requireSystem(ctx, "vault.decideEgress", {
				...(audit === undefined ? {} : { audit }),
				clock,
				...(typeof named === "string" ? { organisationId: named } : {}),
			});
			const method: HttpMethod = request.method;
			let url: URL;
			try {
				url = new URL(request.url);
			} catch {
				return denyEgress(request, { host: "", path: "" }, "The URL is not valid", {
					action: "none",
					message: "Send an absolute URL, such as https://api.example.com/path.",
				});
			}
			const host = url.hostname.toLowerCase();
			const path = url.pathname.length === 0 ? "/" : url.pathname;
			const target = { host, path };
			// A blocked or ended session gets nothing, whatever grant or policy would match.
			const session =
				request.sessionId === undefined ? undefined : await sessionOf(request.organisationId, request.sessionId);
			const closed = sessionClosed(session);
			if (closed !== undefined) {
				return denyEgress(request, target, closed, {
					action: "none",
					message:
						session?.endedAt !== undefined
							? "Nothing a session holds works once it has ended."
							: "An operator has blocked this session's credentials; nothing it sends gets one until it is unblocked.",
				});
			}
			if (url.protocol !== "https:") {
				return denyEgress(request, target, "Credentials are only injected over https", {
					action: "none",
					message: `Use https://${host}${path} instead.`,
				});
			}

			const ceiling = await ceilingOf(request.organisationId);
			if (ceiling !== undefined && !ceiling.routes.some((route) => routeAllows(route, method, host, path))) {
				return denyEgress(request, target, `The organisation's ceiling does not allow ${method} ${host}${path}`, {
					action: "none",
					message: `Nothing can allow ${method} ${host}${path}: it is outside the organisation's ceiling.`,
				});
			}

			const items = await readAll<StoredItem>("items", request.organisationId);
			const itemOf = (itemId: string): StoredItem | undefined => {
				const found = items.find((candidate) => candidate.value.item.id === itemId)?.value;
				return found?.item.hosts.includes(host) ? found : undefined;
			};
			// A placeholder the proxy found in the auth header names the one item this request may get, and only while it is
			// one of the session's current placeholders and its item is bound to this host. Anything else is refused rather
			// than injected: a stale or copied placeholder, or a key sent towards another host.
			let placeholderItem: string | undefined;
			if (request.placeholder !== undefined) {
				const entry =
					typeof request.placeholder === "string"
						? session?.placeholders.find((issued) => issued.placeholder === request.placeholder)
						: undefined;
				if (entry === undefined) {
					return denyEgress(request, target, "The placeholder is not one of this session's current placeholders", {
						action: "none",
						message:
							"A placeholder works only in the session and sandbox start it was issued for: use the one in this sandbox's environment.",
					});
				}
				const named = items.find((candidate) => candidate.value.item.id === entry.itemId)?.value.item;
				if (named === undefined || !named.hosts.includes(host)) {
					const what = named === undefined ? "an item that no longer exists" : named.name;
					return denyEgress(
						request,
						{ ...target, ...(named === undefined ? {} : { itemId: named.id }) },
						`The placeholder is for ${what}, which is not bound to ${host}`,
						{
							action: "none",
							message: `A credential goes only to its own hosts${named === undefined ? "" : ` (${named.hosts.join(", ")})`}.`,
						},
					);
				}
				placeholderItem = named.id;
			}
			let valueless: VaultItem | undefined;
			const candidates = [
				...(await readAll<StoredGrant>("grants", request.organisationId)).map(({ value }) => ({
					grant: value,
					policy: undefined,
					itemId: value.grant.itemId,
				})),
				...(await readAll<StoredPolicy>("policies", request.organisationId)).map(({ value }) => ({
					grant: undefined,
					policy: value,
					itemId: value.policy.itemId,
				})),
			];
			for (const candidate of candidates) {
				if (placeholderItem !== undefined && candidate.itemId !== placeholderItem) continue;
				const active = candidate.grant
					? grantView(candidate.grant).status === "active"
					: policyActive(candidate.policy!);
				const selector = candidate.grant ? candidate.grant.grant.selector : candidate.policy!.policy.selector;
				const route = candidate.grant ? candidate.grant.grant.route : candidate.policy!.policy.route;
				if (!active || !selectorMatches(selector, request) || !routeAllows(route, method, host, path)) continue;
				const stored = itemOf(candidate.itemId);
				if (stored === undefined) continue;
				// A grant on another project's item is used only while the item is still shared into the session
				// (docs/design/sharing.md). A policy is that item's project admin's own, so it stands as set.
				if (candidate.grant !== undefined && !(await stillShared(request, stored.item))) continue;
				// A user's own item goes out only for a session that works for its user.
				if (!(await usableFor(request, stored.item))) continue;
				const { item, sealed } = stored;
				if (sealed === undefined) {
					valueless ??= item;
					continue;
				}
				// The use is spent by a conditional commit: if another decision spent the last one (or a revocation
				// landed) first, this candidate no longer applies and the next is tried.
				// The value is opened first, so a cipher that cannot open it (a wrong or missing key) fails the decision
				// without spending a use the grant or policy cannot get back.
				const grantId = candidate.grant?.grant.id;
				const policyId = candidate.policy?.policy.id;
				const value = await cipher.open(sealed, { itemId: item.id, valueVersion: item.valueVersion });
				const spent = grantId !== undefined ? await spendGrant(grantId) : await spendPolicy(policyId!);
				if (!spent) continue;
				const reason = grantId !== undefined ? `Allowed by grant ${grantId}` : `Allowed by policy ${policyId}`;
				const use = await recordUse(request, {
					...target,
					itemId: item.id,
					...(grantId === undefined ? {} : { grantId }),
					...(policyId === undefined ? {} : { policyId }),
					outcome: "injected",
					reason,
				});
				return {
					allow: true,
					reason,
					useId: use.id,
					...(grantId === undefined ? {} : { grantId }),
					...(policyId === undefined ? {} : { policyId }),
					inject: { header: item.injection.header, value: item.injection.template.replace("{key}", () => value) },
				};
			}

			if (valueless !== undefined) {
				return denyEgress(request, { ...target, itemId: valueless.id }, `Item ${valueless.name} has no value yet`, {
					action: "propose",
					message: `Ask for the secret for ${valueless.name} to be pasted on the vault page.`,
				});
			}
			// The item the fix names: never another user's own, which the agent may not know of.
			let bound: VaultItem | undefined;
			for (const { value } of items) {
				if (!value.item.hosts.includes(host) || !(await usableFor(request, value.item))) continue;
				bound = value.item;
				break;
			}
			return denyEgress(
				request,
				target,
				`No active grant or policy allows ${method} ${host}${path}`,
				bound === undefined
					? { action: "propose", message: `Ask for a secret for ${host}: no vault item is bound to it yet.` }
					: { action: "propose", message: `Ask for a route grant to ${host} using ${bound.name}.` },
			);
		},

		async readConnectorCredential(ctx, request) {
			// Only the model gateway asks, as system; anyone else learns nothing and records no use (question 13).
			const named: unknown =
				typeof request === "object" && request !== null && typeof request.scope === "object" && request.scope !== null
					? request.scope.organisationId
					: undefined;
			await requireSystem(ctx, "vault.readConnectorCredential", {
				...(audit === undefined ? {} : { audit }),
				clock,
				...(typeof named === "string" ? { organisationId: named } : {}),
			});
			assertConnectorRequest(request);
			const { scope, owner } = request;
			const caller = {
				organisationId: scope.organisationId,
				...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
				agentId: scope.agentId,
				sessionId: scope.sessionId,
				method: "POST" as const,
			};
			const connectorData = { connectorId: request.connectorId };
			let url: URL | undefined;
			try {
				url = new URL(request.baseUrl);
			} catch {
				url = undefined;
			}
			const target = {
				host: url?.hostname.toLowerCase() ?? "",
				path: url === undefined || url.pathname.length === 0 ? "/" : url.pathname,
			};
			const refuse = async (code: "invalid" | "refused", reason: string, itemId?: string): Promise<never> => {
				await recordUse(
					caller,
					{ ...target, ...(itemId === undefined ? {} : { itemId }), outcome: "denied", reason },
					connectorData,
				);
				throw new HarbourError(code, reason);
			};
			if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
				return refuse("invalid", "The connector's base URL is not an http(s) URL");
			}

			const found = await read<StoredItem>("items", request.vaultItemId);
			const item = found?.value.item;
			// A platform connector reads a platform item; an organisation's reads one its organisation or a project of it
			// owns, and only for that organisation's sessions.
			const owned =
				item !== undefined &&
				(owner.kind === "platform"
					? found!.row.organisationId === null && item.owner.kind === "platform"
					: owner.organisationId === scope.organisationId &&
						found!.row.organisationId === owner.organisationId &&
						(item.owner.kind === "organisation" || item.owner.kind === "project") &&
						item.owner.organisationId === owner.organisationId);
			if (!owned) {
				return refuse(
					"refused",
					`Item ${request.vaultItemId} does not belong to connector ${request.connectorId}'s owner`,
				);
			}
			if (!item.hosts.includes(target.host)) {
				return refuse("refused", `Item ${item.name} is not bound to ${target.host}`, item.id);
			}
			const closed = sessionClosed(await sessionOf(scope.organisationId, scope.sessionId));
			if (closed !== undefined) return refuse("refused", closed, item.id);
			const sealed = found!.value.sealed;
			if (sealed === undefined) return refuse("refused", `Item ${item.name} has no value yet`, item.id);
			const value = await cipher.open(sealed, { itemId: item.id, valueVersion: item.valueVersion });
			const use = await recordUse(
				caller,
				{ ...target, itemId: item.id, outcome: "injected", reason: `Read for connector ${request.connectorId}` },
				connectorData,
			);
			const credential: ConnectorCredential = {
				itemId: item.id,
				valueVersion: item.valueVersion,
				value,
				useId: use.id,
			};
			return credential;
		},

		async connectionSecret(ctx, call) {
			await requireSystem(ctx, "vault.connectionSecret", {
				...(audit === undefined ? {} : { audit }),
				clock,
				...(call?.op === "open" && typeof call.organisationId === "string"
					? { organisationId: call.organisationId }
					: {}),
			});
			return connectionSecret(call);
		},
	};

	/** `ConnectionSecrets.connectionSecret`, for a caller already known to be system. Never logs or emits a value. */
	async function connectionSecret(call: ConnectionSecretCall): Promise<ConnectionSecretResult> {
		if (typeof call !== "object" || call === null)
			throw new HarbourError("invalid", "A connection secret call is an object");
		if (call.op === "put") {
			if (typeof call.value !== "string" || call.value.length === 0) {
				throw new HarbourError("invalid", "A connection secret cannot be empty");
			}
			const injection = { header: "Authorization", template: "Bearer {key}" };
			assertItemInput({ name: call.name, hosts: call.hosts, injection });
			const { item, write } = await newItem(
				{
					owner: call.owner,
					name: call.name,
					description: "A connection's secret (connections)",
					hosts: call.hosts,
					injection,
				},
				call.value,
			);
			await commit([write]);
			await emit({
				id: `vault:item:${item.id}:created`,
				type: "vault.item.created",
				actor: { kind: "system", component: "connections" },
				organisationId: call.owner.kind === "platform" ? PLATFORM_ORGANISATION : call.owner.organisationId,
				subject: { kind: "vault.item", id: item.id },
				data: { name: item.name, hosts: [...item.hosts], hasValue: true, connection: true },
			});
			return { itemId: item.id };
		}
		if (typeof call.itemId !== "string" || call.itemId.length === 0) {
			throw new HarbourError("invalid", "A connection secret call names its item");
		}
		if (call.op === "replace" || call.op === "clear") {
			const value = call.op === "replace" ? call.value : undefined;
			if (call.op === "replace" && (typeof value !== "string" || value.length === 0)) {
				throw new HarbourError("invalid", "A connection secret cannot be empty");
			}
			for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
				const found = await read<StoredItem>("items", call.itemId);
				if (found === undefined) {
					if (call.op === "clear") return {};
					throw new HarbourError("not_found", `No item ${call.itemId}`);
				}
				const { item } = found.value;
				const valueVersion = item.valueVersion + 1;
				const next: StoredItem = {
					item: { ...item, hasValue: value !== undefined, valueVersion, updatedAt: clock.now() },
					...(value === undefined ? {} : { sealed: await cipher.seal(value, { itemId: item.id, valueVersion }) }),
				};
				if (await store.commit([update("items", found.row, next)])) return { itemId: item.id };
			}
			throw new HarbourError(
				"unavailable",
				`The vault could not update item ${call.itemId}: too many concurrent changes`,
			);
		}
		if (call.op !== "open") throw new HarbourError("invalid", "Unknown connection secret call");
		const host = typeof call.host === "string" ? call.host.toLowerCase() : "";
		const session = call.session;
		const caller = {
			organisationId: call.organisationId,
			...(session?.projectId === undefined ? {} : { projectId: session.projectId }),
			...(session?.agentId === undefined ? {} : { agentId: session.agentId }),
			...(session === undefined ? {} : { sessionId: session.sessionId }),
			method: "POST" as const,
		};
		const purpose = { connectionPurpose: String(call.purpose ?? "") };
		const refuse = async (reason: string, itemId?: string): Promise<never> => {
			await recordUse(
				caller,
				{ host, path: "/", ...(itemId === undefined ? {} : { itemId }), outcome: "denied", reason },
				purpose,
			);
			throw new HarbourError("refused", reason);
		};
		const found = await read<StoredItem>("items", call.itemId);
		const item = found?.value.item;
		if (item === undefined) return refuse(`No item ${call.itemId}`);
		const owned =
			item.owner.kind === "platform"
				? found!.row.organisationId === null
				: found!.row.organisationId === call.organisationId;
		// Recorded in the asking organisation, so it names nothing of the other's.
		if (!owned) return refuse(`No item ${call.itemId}`);
		if (!item.hosts.includes(host)) return refuse(`Item ${item.name} is not bound to ${host}`, item.id);
		if (session !== undefined) {
			const closed = sessionClosed(await sessionOf(call.organisationId, session.sessionId));
			if (closed !== undefined) return refuse(closed, item.id);
		}
		const sealed = found!.value.sealed;
		if (sealed === undefined) return refuse(`Item ${item.name} has no value`, item.id);
		const value = await cipher.open(sealed, { itemId: item.id, valueVersion: item.valueVersion });
		await recordUse(
			caller,
			{ host, path: "/", itemId: item.id, outcome: "injected", reason: String(call.purpose ?? "") },
			purpose,
		);
		return { itemId: item.id, value };
	}
	options.sessionEnd?.register("vault", (ctx, end) => vault.endSession(ctx, end.sessionId, end.reason));
	return vault;
}
