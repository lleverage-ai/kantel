import {
	type AccessCheck,
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	CODE_REQUIRED_KINDS,
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
	type PolicySelector,
	type ProjectAccess,
	type ProjectId,
	type Proposal,
	type ProposalOutcome,
	type ProposalTerms,
	type RouteScope,
	type SessionEndHook,
	systemClock,
	type Vault,
	type VaultCeiling,
	type VaultItem,
	type VaultPolicy,
	type VaultUse,
} from "@harbour/contracts";
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

export interface MemoryVaultOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** How long a proposal stays pending. Default 15 minutes. */
	readonly proposalTtlMs?: number;
	/** Base of the vault page links; a proposal's link is `<linkBase>/proposals/<id>`. Default `/vault`. */
	readonly linkBase?: string;
	/** How often a waiting agent's proposal is checked against the clock for expiry. Default 25 ms. */
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
const NO_REQUEST_HAS_RUN = "No request has run.";

interface StoredItem {
	readonly organisationId: OrganisationId;
	item: VaultItem;
}

interface StoredGrant {
	readonly organisationId: OrganisationId;
	readonly grant: Omit<Grant, "uses" | "status" | "endReason" | "endedAt">;
	uses: number;
	exhaustedAt?: number;
	revokedAt?: number;
}

interface StoredPolicy {
	readonly organisationId: OrganisationId;
	policy: VaultPolicy;
	uses: number;
}

/** A use, with the project the egress request named, so lists can be scoped without changing the record. */
interface StoredUse {
	readonly use: VaultUse;
	readonly projectId?: ProjectId;
}

/** The project and session a record is scoped to; empty for an organisation's own records. */
type Scope = Pick<AccessCheck, "projectId" | "sessionId">;

function itemScope(item: VaultItem): Scope {
	return item.owner.kind === "project" ? { projectId: item.owner.projectId } : {};
}

function proposalScope(proposal: Proposal): Scope {
	return {
		...(proposal.projectId === undefined ? {} : { projectId: proposal.projectId }),
		...(proposal.requester.sessionId === undefined ? {} : { sessionId: proposal.requester.sessionId }),
	};
}

function selectorScope(selector: PolicySelector): Scope {
	return {
		...(selector.projectId === undefined ? {} : { projectId: selector.projectId }),
		...(selector.sessionId === undefined ? {} : { sessionId: selector.sessionId }),
	};
}

function scoped(scope: Scope): boolean {
	return scope.projectId !== undefined || scope.sessionId !== undefined;
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

/**
 * The reference `Vault`: everything in maps, per organisation. Item values live in a private map and are only read to
 * build an allowed egress decision's `inject`.
 */
export function createMemoryVault(options: MemoryVaultOptions = {}): Vault {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const proposalTtlMs = options.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
	const linkBase = options.linkBase ?? "/vault";
	const expiryPollMs = options.expiryPollMs ?? 25;
	const access = options.access;

	const items = new Map<string, StoredItem>();
	const values = new Map<string, string>();
	const ceilings = new Map<OrganisationId, VaultCeiling>();
	const policies = new Map<string, StoredPolicy>();
	const proposals = new Map<string, Proposal>();
	const decisions = new Map<string, Decision>();
	const grants = new Map<string, StoredGrant>();
	const uses: StoredUse[] = [];
	const waiters = new Map<string, Set<Waiter>>();
	/** Proposals being decided now: a second decision while one is in flight is a `conflict`, never a second outcome. */
	const deciding = new Set<string>();
	/**
	 * Expiry has no event of its own, so a proposal with waiters is checked against the clock: reading it through
	 * proposalFor marks it expired, which resolves every waiter. One unref'd timer per proposal, stopped when its last
	 * waiter leaves.
	 */
	const polls = new Map<string, ReturnType<typeof setInterval>>();
	function startPoll(organisationId: OrganisationId, proposalId: string): void {
		if (polls.has(proposalId)) return;
		const timer = setInterval(() => proposalFor(organisationId, proposalId), expiryPollMs);
		(timer as { unref?: () => void }).unref?.();
		polls.set(proposalId, timer);
	}
	function stopPoll(proposalId: string): void {
		const timer = polls.get(proposalId);
		if (timer === undefined) return;
		clearInterval(timer);
		polls.delete(proposalId);
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
		await audit.append([{ ...event, id: event.id ?? `vault:${randomHex(16)}`, at: clock.now(), source: "vault" }]);
	}

	function contextFields(ctx: CallContext): Pick<AuditEventInput, "projectId" | "sessionId" | "agentId"> {
		return {
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			...(ctx.actor.kind === "agent" ? { agentId: ctx.actor.agentId, sessionId: ctx.actor.sessionId } : {}),
		};
	}

	function itemFor(organisationId: OrganisationId, itemId: string): VaultItem {
		const stored = items.get(itemId);
		if (stored === undefined || stored.organisationId !== organisationId) {
			throw new HarbourError("not_found", `No vault item ${itemId}`);
		}
		return stored.item;
	}

	function assertWithinCeiling(organisationId: OrganisationId, route: RouteScope): void {
		const ceiling = ceilings.get(organisationId);
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

	function createItem(
		organisationId: OrganisationId,
		input: {
			readonly owner: OwnerRef;
			readonly name: string;
			readonly description?: string;
			readonly hosts: readonly string[];
			readonly injection: VaultItem["injection"];
		},
		value: string | undefined,
	): VaultItem {
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
		items.set(item.id, { organisationId, item });
		if (value !== undefined) values.set(item.id, value);
		return item;
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

	function outcomeOf(proposal: Proposal): ProposalOutcome {
		switch (proposal.status) {
			case "approved": {
				const decision = decisions.get(proposal.decisionId ?? "");
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

	function store(proposal: Proposal): Proposal {
		proposals.set(proposal.id, proposal);
		if (proposal.status !== "pending") {
			const waiting = waiters.get(proposal.id);
			waiters.delete(proposal.id);
			if (waiting !== undefined) {
				const outcome = outcomeOf(proposal);
				for (const waiter of waiting) waiter.resolve(outcome);
			}
		}
		return proposal;
	}

	/** The proposal as of now: a pending one past its expiry is marked `expired` here. */
	function proposalFor(organisationId: OrganisationId, proposalId: string): Proposal {
		const proposal = proposals.get(proposalId);
		if (proposal === undefined || proposal.organisationId !== organisationId) {
			throw new HarbourError("not_found", `No proposal ${proposalId}`);
		}
		if (proposal.status === "pending" && clock.now() >= proposal.expiresAt) {
			return store({ ...proposal, status: "expired" });
		}
		return proposal;
	}

	function assertPending(proposal: Proposal): void {
		if (proposal.status === "expired") throw new HarbourError("expired", `Proposal ${proposal.id} has expired`);
		if (proposal.status !== "pending") {
			throw new HarbourError("conflict", `Proposal ${proposal.id} is already ${proposal.status}`);
		}
	}

	async function recordEgress(
		request: EgressRequest,
		use: Omit<VaultUse, "id" | "at" | "organisationId" | "method" | "sessionId">,
	): Promise<VaultUse> {
		const record: VaultUse = {
			id: newId("use"),
			at: clock.now(),
			organisationId: request.organisationId,
			...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
			method: request.method,
			...use,
		};
		uses.push({ use: record, ...(request.projectId === undefined ? {} : { projectId: request.projectId }) });
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
		const use = await recordEgress(request, { ...target, outcome: "denied", reason });
		return { allow: false, reason, useId: use.id, fix };
	}

	const vault: Vault = {
		async putItem(ctx, input) {
			forbidAgent(ctx, "create vault items");
			const owner = input.owner;
			if (owner.kind === "platform" || owner.organisationId !== ctx.organisationId) {
				throw new HarbourError("invalid", "An item must be owned within the caller's organisation");
			}
			if (access !== undefined) {
				const scope: Scope = owner.kind === "project" ? { projectId: owner.projectId } : {};
				await access.require(ctx, { ...scope, needed: "admin", operation: "vault.putItem" });
			}
			assertItemInput(input);
			if (input.value !== undefined && input.value.length === 0) {
				throw new HarbourError("invalid", "An item value cannot be empty");
			}
			const item = createItem(ctx.organisationId, input, input.value);
			await emit({
				id: `vault:item:${item.id}:created`,
				type: "vault.item.created",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "vault.item", id: item.id },
				data: { name: item.name, hosts: [...item.hosts], hasValue: item.hasValue },
			});
			return item;
		},

		async getItem(ctx, itemId) {
			const scope = itemScope(itemFor(ctx.organisationId, itemId));
			if (access !== undefined && scoped(scope)) {
				const subject = { kind: "vault.item", id: itemId };
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getItem", subject });
			}
			return itemFor(ctx.organisationId, itemId);
		},

		async listItems(ctx, page) {
			const own = [...items.values()]
				.filter((stored) => stored.organisationId === ctx.organisationId)
				.map((stored) => stored.item);
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
			ceilings.set(ctx.organisationId, ceiling);
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
			const ceiling = ceilings.get(ctx.organisationId);
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
			const item = itemFor(ctx.organisationId, input.itemId);
			if (access !== undefined) {
				const subject = { kind: "vault.item", id: item.id };
				await access.require(ctx, { ...itemScope(item), needed: "admin", operation: "vault.putPolicy", subject });
			}
			assertItemHost(item.hosts, input.route);
			assertWithinCeiling(ctx.organisationId, input.route);
			const policy: VaultPolicy = {
				id: newId("policy"),
				itemId: item.id,
				selector: { ...input.selector },
				route: { ...input.route, methods: [...input.route.methods] },
				lifetime: { ...lifetime },
				createdBy: ctx.actor,
				createdAt: clock.now(),
			};
			policies.set(policy.id, { organisationId: ctx.organisationId, policy, uses: 0 });
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
			const stored = policies.get(policyId);
			if (stored === undefined || stored.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No policy ${policyId}`);
			}
			if (access !== undefined) {
				const scope = itemScope(itemFor(ctx.organisationId, stored.policy.itemId));
				const subject = { kind: "vault.policy", id: policyId };
				await access.require(ctx, { ...scope, needed: "admin", operation: "vault.revokePolicy", subject });
			}
			if (stored.policy.revokedAt !== undefined) return;
			stored.policy = { ...stored.policy, revokedAt: clock.now() };
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
			const own = [...policies.values()]
				.filter((stored) => stored.organisationId === ctx.organisationId)
				.map((stored) => stored.policy);
			return paginate(await visibleOnly(ctx, own, (policy) => selectorScope(policy.selector)), page);
		},

		async propose(ctx, proposed) {
			// A private copy, so the caller cannot change the terms after they are hashed.
			const terms: ProposalTerms = structuredClone(proposed);
			if (terms.reason.trim().length === 0) throw new HarbourError("invalid", "A proposal needs a reason");
			assertValidRoute(terms.route);
			assertLifetime(terms.lifetime);
			if (terms.secret !== undefined) assertItemInput(terms.secret);
			else if (terms.itemId === undefined) throw new HarbourError("invalid", "A proposal needs an item or a secret");
			const named = terms.itemId === undefined ? undefined : itemFor(ctx.organisationId, terms.itemId);
			const actor = ctx.actor;
			// With access, the proposal's project is the one the check resolved: an agent's own session's project, which must
			// be the item's when the item belongs to a project.
			let projectId = ctx.projectId;
			if (access !== undefined) {
				const itemProject = named === undefined ? undefined : itemScope(named).projectId;
				// An agent acts through its own session; a human or service on the item's project, else the call's.
				const checked = actor.kind === "agent" ? itemProject : (itemProject ?? ctx.projectId);
				const scope: Scope = {
					...(checked === undefined ? {} : { projectId: checked }),
					...(actor.kind === "agent" ? { sessionId: actor.sessionId } : {}),
				};
				const subject = named === undefined ? {} : { subject: { kind: "vault.item", id: named.id } };
				const resolved = await access.require(ctx, {
					...scope,
					needed: "operator",
					operation: "vault.propose",
					...subject,
				});
				projectId = resolved.projectId;
			}
			if (named !== undefined) {
				const existing = itemFor(ctx.organisationId, named.id);
				if (terms.secret !== undefined && existing.hasValue) {
					throw new HarbourError("conflict", `Item ${existing.id} already has a value`);
				}
				assertItemHost(existing.hosts, terms.route);
			} else {
				assertItemHost(terms.secret!.hosts, terms.route);
			}
			assertWithinCeiling(ctx.organisationId, terms.route);

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
				link: `${linkBase}/proposals/${id}`,
			};
			proposals.set(id, proposal);
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
			const scope = proposalScope(proposalFor(ctx.organisationId, proposalId));
			if (access !== undefined && scoped(scope)) {
				const subject = { kind: "vault.proposal", id: proposalId };
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getProposal", subject });
			}
			return proposalFor(ctx.organisationId, proposalId);
		},

		async listProposals(ctx, filter, page) {
			const sessionId = filter?.sessionId;
			if (access !== undefined && sessionId !== undefined) {
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.listProposals" });
			}
			const own = [...proposals.values()]
				.filter((proposal) => proposal.organisationId === ctx.organisationId)
				.map((proposal) => proposalFor(ctx.organisationId, proposal.id))
				.filter(
					(proposal) =>
						(filter?.status === undefined || proposal.status === filter.status) &&
						(sessionId === undefined || proposal.requester.sessionId === sessionId),
				);
			return paginate(sessionId === undefined ? await visibleOnly(ctx, own, proposalScope) : own, page);
		},

		async approvalView(ctx, proposalId) {
			forbidAgent(ctx, "open the approval view");
			const found = proposalFor(ctx.organisationId, proposalId);
			if (access !== undefined) {
				const scope: Scope = found.projectId === undefined ? {} : { projectId: found.projectId };
				const subject = { kind: "vault.proposal", id: proposalId };
				await access.require(ctx, { ...scope, needed: "operator", operation: "vault.approvalView", subject });
			}
			const proposal = proposalFor(ctx.organisationId, proposalId);
			return {
				proposal,
				codeChoices: codeChoices(proposal.bindingCode, proposal.id),
				codeRequired: CODE_REQUIRED_KINDS.includes(proposal.kind),
			};
		},

		async decide(ctx, input) {
			forbidAgent(ctx, "decide proposals");
			const found = proposalFor(ctx.organisationId, input.proposalId);
			if (access !== undefined) {
				const scope: Scope = found.projectId === undefined ? {} : { projectId: found.projectId };
				const subject = { kind: "vault.proposal", id: found.id };
				await access.require(ctx, { ...scope, needed: "operator", operation: "vault.decide", subject });
			}
			// Read again: the proposal may have been decided, withdrawn or expired during the check.
			const proposal = proposalFor(ctx.organisationId, input.proposalId);
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

				if (input.outcome === "deny") {
					const decision: Decision = {
						id: newId("decision"),
						proposalId: proposal.id,
						outcome: "denied",
						decidedBy: ctx.actor,
						decidedAt: now,
						...(input.note === undefined ? {} : { note: input.note }),
					};
					decisions.set(decision.id, decision);
					store({ ...proposal, status: "denied", decisionId: decision.id });
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
				assertWithinCeiling(ctx.organisationId, terms.route);
				const secret = terms.secret;
				if (secret !== undefined) {
					if (input.secretValue === undefined || input.secretValue.length === 0) {
						throw new HarbourError("invalid", "Approving a secret proposal needs the pasted value");
					}
					if (terms.itemId !== undefined && itemFor(ctx.organisationId, terms.itemId).hasValue) {
						throw new HarbourError("conflict", `Item ${terms.itemId} already has a value`);
					}
				}

				// Every state change below happens before the first await, so nothing (an expiry, a withdrawal) can land
				// between them. Audit events are written afterwards.
				const afterwards: Parameters<typeof emit>[0][] = [];
				let itemId: string;
				if (secret === undefined) {
					itemId = itemFor(ctx.organisationId, terms.itemId!).id;
				} else if (terms.itemId !== undefined) {
					const stored = items.get(terms.itemId)!;
					stored.item = { ...stored.item, hasValue: true, valueVersion: stored.item.valueVersion + 1, updatedAt: now };
					values.set(stored.item.id, input.secretValue!);
					itemId = stored.item.id;
				} else {
					const owner: OwnerRef =
						proposal.projectId === undefined
							? { kind: "organisation", organisationId: ctx.organisationId }
							: { kind: "project", organisationId: ctx.organisationId, projectId: proposal.projectId };
					const item = createItem(ctx.organisationId, { ...secret, owner }, input.secretValue);
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
				grants.set(grantId, {
					organisationId: ctx.organisationId,
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
				});
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
				decisions.set(decisionId, decision);
				store({ ...proposal, status: "approved", decisionId });
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
			const found = proposalFor(ctx.organisationId, proposalId);
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
			const proposal = proposalFor(ctx.organisationId, proposalId);
			assertPending(proposal);
			if (deciding.has(proposal.id)) {
				throw new HarbourError("conflict", `Proposal ${proposal.id} is being decided`);
			}
			const withdrawn = store({ ...proposal, status: "withdrawn" });
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
			const scope = proposalScope(proposalFor(ctx.organisationId, proposalId));
			if (access !== undefined && scoped(scope)) {
				const subject = { kind: "vault.proposal", id: proposalId };
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.waitForOutcome", subject });
				if (signal?.aborted) throw new HarbourError("aborted", "The wait was aborted");
			}
			const proposal = proposalFor(ctx.organisationId, proposalId);
			if (proposal.status !== "pending") return outcomeOf(proposal);
			return new Promise<ProposalOutcome>((resolve, reject) => {
				const set = waiters.get(proposalId) ?? new Set<Waiter>();
				waiters.set(proposalId, set);
				const onAbort = () => {
					set.delete(waiter);
					if (set.size === 0) stopPoll(proposalId);
					reject(new HarbourError("aborted", "The wait was aborted"));
				};
				const waiter: Waiter = {
					resolve(outcome) {
						stopPoll(proposalId);
						signal?.removeEventListener("abort", onAbort);
						resolve(outcome);
					},
				};
				set.add(waiter);
				startPoll(ctx.organisationId, proposalId);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},

		async getGrant(ctx, grantId) {
			const stored = grants.get(grantId);
			if (stored === undefined || stored.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No grant ${grantId}`);
			}
			const scope = selectorScope(stored.grant.selector);
			if (access !== undefined && scoped(scope)) {
				const subject = { kind: "vault.grant", id: grantId };
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getGrant", subject });
			}
			return grantView(stored);
		},

		async listGrants(ctx, filter, page) {
			const sessionId = filter?.sessionId;
			if (access !== undefined && sessionId !== undefined) {
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.listGrants" });
			}
			const own = [...grants.values()]
				.filter((stored) => stored.organisationId === ctx.organisationId)
				.map(grantView)
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
			const stored = grants.get(grantId);
			if (stored === undefined || stored.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No grant ${grantId}`);
			}
			if (access !== undefined) {
				const scope = selectorScope(stored.grant.selector);
				const subject = { kind: "vault.grant", id: grantId };
				await access.require(ctx, { ...scope, needed: "operator", operation: "vault.revokeGrant", subject });
			}
			if (grantView(stored).status !== "active") return grantView(stored);
			stored.revokedAt = clock.now();
			await emit({
				id: `vault:grant:${grantId}:revoked`,
				type: "vault.grant.revoked",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "vault.grant", id: grantId },
				...(reason === undefined ? {} : { data: { reason } }),
			});
			return grantView(stored);
		},

		async listUses(ctx, filter, page) {
			const sessionId = filter?.sessionId;
			if (access !== undefined && sessionId !== undefined) {
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.listUses" });
			}
			const own = uses.filter(
				({ use }) =>
					use.organisationId === ctx.organisationId && (sessionId === undefined || use.sessionId === sessionId),
			);
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
			// Every change happens here, before the first audit await; audit events are written afterwards.
			const now = clock.now();
			const afterwards: Parameters<typeof emit>[0][] = [];
			for (const stored of grants.values()) {
				const { id, selector } = stored.grant;
				if (stored.organisationId !== ctx.organisationId || selector.sessionId !== sessionId) continue;
				if (grantView(stored).status !== "active") continue;
				stored.revokedAt = now;
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
				for (const candidate of [...proposals.values()]) {
					if (candidate.organisationId !== ctx.organisationId || candidate.requester.sessionId !== sessionId) continue;
					const proposal = proposalFor(ctx.organisationId, candidate.id);
					if (proposal.status !== "pending") continue;
					// An in-flight decision on it changes nothing more (see decide), so it is withdrawn regardless.
					store({ ...proposal, status: "withdrawn" });
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
			for (const event of afterwards) await emit(event);
		},

		async decideEgress(request) {
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
			if (url.protocol !== "https:") {
				return denyEgress(request, target, "Credentials are only injected over https", {
					action: "none",
					message: `Use https://${host}${path} instead.`,
				});
			}

			const ceiling = ceilings.get(request.organisationId);
			if (ceiling !== undefined && !ceiling.routes.some((route) => routeAllows(route, method, host, path))) {
				return denyEgress(request, target, `The organisation's ceiling does not allow ${method} ${host}${path}`, {
					action: "none",
					message: `Nothing can allow ${method} ${host}${path}: it is outside the organisation's ceiling.`,
				});
			}

			const itemOf = (itemId: string): VaultItem | undefined => {
				const stored = items.get(itemId);
				return stored?.organisationId === request.organisationId && stored.item.hosts.includes(host)
					? stored.item
					: undefined;
			};
			let valueless: VaultItem | undefined;
			const candidates = [
				...[...grants.values()]
					.filter((stored) => stored.organisationId === request.organisationId)
					.map((stored) => ({ grant: stored, policy: undefined, itemId: stored.grant.itemId })),
				...[...policies.values()]
					.filter((stored) => stored.organisationId === request.organisationId)
					.map((stored) => ({ grant: undefined, policy: stored, itemId: stored.policy.itemId })),
			];
			for (const candidate of candidates) {
				const active = candidate.grant
					? grantView(candidate.grant).status === "active"
					: policyActive(candidate.policy!);
				const selector = candidate.grant ? candidate.grant.grant.selector : candidate.policy!.policy.selector;
				const route = candidate.grant ? candidate.grant.grant.route : candidate.policy!.policy.route;
				if (!active || !selectorMatches(selector, request) || !routeAllows(route, method, host, path)) continue;
				const item = itemOf(candidate.itemId);
				if (item === undefined) continue;
				const value = values.get(item.id);
				if (value === undefined) {
					valueless ??= item;
					continue;
				}
				const now = clock.now();
				if (candidate.grant) {
					candidate.grant.uses += 1;
					if (candidate.grant.grant.maxUses !== undefined && candidate.grant.uses >= candidate.grant.grant.maxUses) {
						candidate.grant.exhaustedAt = now;
					}
				} else {
					candidate.policy!.uses += 1;
				}
				const grantId = candidate.grant?.grant.id;
				const policyId = candidate.policy?.policy.id;
				const reason = grantId !== undefined ? `Allowed by grant ${grantId}` : `Allowed by policy ${policyId}`;
				const use = await recordEgress(request, {
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
			const bound = [...items.values()].find(
				(stored) => stored.organisationId === request.organisationId && stored.item.hosts.includes(host),
			);
			return denyEgress(
				request,
				target,
				`No active grant or policy allows ${method} ${host}${path}`,
				bound === undefined
					? { action: "propose", message: `Ask for a secret for ${host}: no vault item is bound to it yet.` }
					: { action: "propose", message: `Ask for a route grant to ${host} using ${bound.item.name}.` },
			);
		},
	};
	options.sessionEnd?.register("vault", (ctx, end) => vault.endSession(ctx, end.sessionId, end.reason));
	return vault;
}
