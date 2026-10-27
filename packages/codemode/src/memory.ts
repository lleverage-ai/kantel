import {
	type AgentId,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type CapabilityDefinition,
	type CapabilityGrant,
	type CapabilityHandler,
	type CapabilityInvocation,
	type CapabilityName,
	type CapabilityRegistry,
	type CapabilityResult,
	type CapabilitySelector,
	type Clock,
	HarbourError,
	type InvokeInput,
	type JournalEntry,
	type JsonValue,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectId,
	type SessionId,
	type Subscription,
	systemClock,
} from "@harbour/contracts";
import {
	canonicalJson,
	capabilityCovered,
	fingerprint,
	isCapabilityName,
	isCapabilityPattern,
	selectorMatches,
} from "./index.ts";

export interface MemoryCapabilityRegistryOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** Test hooks; never set in production. */
	readonly testing?: {
		/**
		 * When it returns true for a call ID, `invoke` writes the `started` entry, runs the handler, then rejects with
		 * `unavailable` without settling, as if the process died before the commit.
		 */
		readonly crashBeforeCommit?: (callId: string) => boolean;
	};
}

interface Caller {
	readonly agentId: AgentId;
	readonly sessionId: SessionId;
	readonly projectId: ProjectId;
}

interface StoredRegistration {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly definition: CapabilityDefinition;
	readonly handler: CapabilityHandler;
}

interface StoredGrant {
	readonly grant: Omit<CapabilityGrant, "status">;
	revokedAt?: number;
}

interface StoredEntry {
	readonly organisationId: OrganisationId;
	entry: JournalEntry;
	/** Bumped by every handler run, so a run that finishes after a newer one or a resolution never settles. */
	attempt: number;
}

const REPLAY_POLICIES = new Set(["safe", "idempotent", "unsafe"]);
const RUNS_IN = new Set(["isolate", "container", "host"]);

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

function scopedKey(organisationId: OrganisationId, key: string): string {
	return `${organisationId}\u0000${key}`;
}

function assertResult(result: unknown, label: string): CapabilityResult {
	if (typeof result !== "object" || result === null || !("output" in result)) {
		throw new HarbourError("invalid", `${label} must be an object with an output`);
	}
	const { output, isError } = result as { readonly output: JsonValue; readonly isError?: unknown };
	canonicalJson(output);
	if (isError !== undefined && typeof isError !== "boolean") {
		throw new HarbourError("invalid", `${label}'s isError must be a boolean`);
	}
	return isError === undefined ? { output } : { output, isError };
}

function selectorJson(selector: CapabilitySelector): JsonValue {
	return {
		...(selector.projectId === undefined ? {} : { projectId: selector.projectId }),
		...(selector.agentId === undefined ? {} : { agentId: selector.agentId }),
		...(selector.sessionId === undefined ? {} : { sessionId: selector.sessionId }),
	};
}

/**
 * The reference `CapabilityRegistry`: registrations, grants and the journal in maps, per organisation. Every
 * `invoke` decides and writes its `started` entry synchronously after one await (the fingerprint), so concurrent
 * calls never interleave between the checks and the write.
 */
export function createMemoryCapabilityRegistry(options: MemoryCapabilityRegistryOptions = {}): CapabilityRegistry {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const crashBeforeCommit = options.testing?.crashBeforeCommit;

	/** Live registrations by organisation and capability name. */
	const registered = new Map<string, StoredRegistration>();
	const grants = new Map<string, StoredGrant>();
	/** Journal entries by organisation and call ID. */
	const journalEntries = new Map<string, StoredEntry>();

	async function emit(event: Omit<AuditEventInput, "at" | "source">): Promise<void> {
		if (audit === undefined) return;
		await audit.append([{ ...event, at: clock.now(), source: "capability" }]);
	}

	function grantView(stored: StoredGrant): CapabilityGrant {
		if (stored.revokedAt !== undefined) return { ...stored.grant, status: "revoked" };
		const { expiresAt } = stored.grant;
		if (expiresAt !== undefined && clock.now() >= expiresAt) return { ...stored.grant, status: "expired" };
		return { ...stored.grant, status: "active" };
	}

	function orgGrants(organisationId: OrganisationId): CapabilityGrant[] {
		return [...grants.values()].filter((stored) => stored.grant.organisationId === organisationId).map(grantView);
	}

	function grantsFor(organisationId: OrganisationId, caller: Omit<Caller, "projectId"> & { projectId?: ProjectId }) {
		return orgGrants(organisationId).filter(
			(grant) => grant.status === "active" && selectorMatches(grant.selector, caller),
		);
	}

	function agentCaller(ctx: CallContext): (Omit<Caller, "projectId"> & { projectId?: ProjectId }) | undefined {
		if (ctx.actor.kind !== "agent") return undefined;
		return {
			agentId: ctx.actor.agentId,
			sessionId: ctx.actor.sessionId,
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
		};
	}

	function entryFor(ctx: CallContext, callId: string): StoredEntry {
		const stored = journalEntries.get(scopedKey(ctx.organisationId, callId));
		const caller = agentCaller(ctx);
		if (stored === undefined || (caller !== undefined && stored.entry.sessionId !== caller.sessionId)) {
			throw new HarbourError("not_found", `No journal entry for call ${callId}`);
		}
		return stored;
	}

	function callFields(ctx: CallContext, caller: Caller, callId: string) {
		return {
			actor: ctx.actor,
			organisationId: ctx.organisationId,
			projectId: caller.projectId,
			sessionId: caller.sessionId,
			agentId: caller.agentId,
			subject: { kind: "capability.call", id: callId },
		};
	}

	function eventId(organisationId: OrganisationId, callId: string, suffix: string): string {
		return `capability:${organisationId}:call:${callId}:${suffix}`;
	}

	async function refuse(
		ctx: CallContext,
		caller: Caller,
		input: InvokeInput,
		code: "forbidden" | "refused",
		reason: string,
		message: string,
	): Promise<never> {
		await emit({
			id: eventId(ctx.organisationId, input.callId, `refused:${reason}`),
			type: "capability.call.refused",
			...callFields(ctx, caller, input.callId),
			data: { capability: input.capability, reason },
		});
		throw new HarbourError(code, message, { callId: input.callId, capability: input.capability });
	}

	/** Runs the handler for a `started` entry, then settles it unless a newer run or a resolution got there first. */
	async function runHandler(
		ctx: CallContext,
		caller: Caller,
		stored: StoredEntry,
		registration: StoredRegistration,
		invocation: CapabilityInvocation,
	): Promise<CapabilityResult> {
		const attempt = stored.attempt;
		await emit({
			id: eventId(ctx.organisationId, invocation.callId, "started"),
			type: "capability.call.started",
			...callFields(ctx, caller, invocation.callId),
			data: {
				capability: invocation.capability,
				version: invocation.version,
				inputFingerprint: stored.entry.inputFingerprint,
			},
		});
		const controller = new AbortController();
		const forwardAbort = () => controller.abort(ctx.signal?.reason);
		ctx.signal?.addEventListener("abort", forwardAbort, { once: true });
		if (ctx.signal?.aborted) forwardAbort();
		let result: CapabilityResult;
		let error: string | undefined;
		try {
			result = assertResult(await registration.handler(invocation, controller.signal), "A handler result");
		} catch (thrown) {
			error = thrown instanceof Error ? thrown.message : String(thrown);
			result = { output: error, isError: true };
		} finally {
			ctx.signal?.removeEventListener("abort", forwardAbort);
		}
		if (crashBeforeCommit?.(invocation.callId)) {
			throw new HarbourError("unavailable", `Simulated crash before committing call ${invocation.callId}`);
		}
		if (stored.attempt !== attempt || stored.entry.status !== "started") {
			// A newer run or an operator settled it while this run was out: the journal holds the answer.
			return stored.entry.result ?? result;
		}
		stored.entry = {
			...stored.entry,
			status: error === undefined ? "committed" : "failed",
			result,
			...(error === undefined ? {} : { error }),
			settledAt: clock.now(),
		};
		await emit({
			id: eventId(ctx.organisationId, invocation.callId, "settled"),
			type: "capability.call.settled",
			...callFields(ctx, caller, invocation.callId),
			data: { capability: invocation.capability, status: stored.entry.status },
		});
		return result;
	}

	return {
		async register(ctx, definitions, handler) {
			forbidAgent(ctx, "register capabilities");
			if (definitions.length === 0) throw new HarbourError("invalid", "Register at least one capability");
			const names = new Set<CapabilityName>();
			for (const definition of definitions) {
				if (!isCapabilityName(definition.name)) {
					throw new HarbourError("invalid", `"${definition.name}" is not a dotted capability name`);
				}
				if (names.has(definition.name)) throw new HarbourError("invalid", `${definition.name} is listed twice`);
				if (definition.version.length === 0) throw new HarbourError("invalid", `${definition.name} needs a version`);
				if (!REPLAY_POLICIES.has(definition.replay) || !RUNS_IN.has(definition.runsIn)) {
					throw new HarbourError("invalid", `${definition.name} has an unknown replay policy or runsIn`);
				}
				names.add(definition.name);
			}
			for (const name of names) {
				if (registered.has(scopedKey(ctx.organisationId, name))) {
					throw new HarbourError("conflict", `${name} is already registered`, { capability: name });
				}
			}
			const registrationId = `capreg_${crypto.randomUUID()}`;
			const keys = definitions.map((definition) => {
				const key = scopedKey(ctx.organisationId, definition.name);
				registered.set(key, { id: registrationId, organisationId: ctx.organisationId, definition, handler });
				return key;
			});
			await emit({
				id: `capability:${ctx.organisationId}:registration:${registrationId}:registered`,
				type: "capability.registered",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				subject: { kind: "capability.registration", id: registrationId },
				data: { capabilities: [...names] },
			});
			const subscription: Subscription = {
				async close() {
					for (const key of keys) if (registered.get(key)?.id === registrationId) registered.delete(key);
				},
			};
			return subscription;
		},

		async discover(ctx) {
			const live = [...registered.values()]
				.filter((registration) => registration.organisationId === ctx.organisationId)
				.map((registration) => registration.definition);
			const caller = agentCaller(ctx);
			const visible =
				caller === undefined
					? live
					: (() => {
							const patterns = grantsFor(ctx.organisationId, caller).flatMap((grant) => grant.capabilities);
							return live.filter((definition) => capabilityCovered(patterns, definition.name));
						})();
			return [...visible].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		},

		async grant(ctx, input) {
			forbidAgent(ctx, "grant capabilities");
			if (input.capabilities.length === 0) throw new HarbourError("invalid", "A grant needs at least one capability");
			for (const pattern of input.capabilities) {
				if (!isCapabilityPattern(pattern)) {
					throw new HarbourError("invalid", `"${pattern}" is neither a capability name nor a namespace ending in .*`);
				}
			}
			if (input.ttlMs !== undefined && (!Number.isInteger(input.ttlMs) || input.ttlMs < 1)) {
				throw new HarbourError("invalid", "ttlMs must be a positive integer");
			}
			const now = clock.now();
			const selector: CapabilitySelector = {
				...(input.selector.projectId === undefined ? {} : { projectId: input.selector.projectId }),
				...(input.selector.agentId === undefined ? {} : { agentId: input.selector.agentId }),
				...(input.selector.sessionId === undefined ? {} : { sessionId: input.selector.sessionId }),
			};
			const stored: StoredGrant = {
				grant: {
					id: `capgrant_${crypto.randomUUID()}`,
					organisationId: ctx.organisationId,
					selector,
					capabilities: [...input.capabilities],
					grantedBy: ctx.actor,
					createdAt: now,
					...(input.ttlMs === undefined ? {} : { expiresAt: now + input.ttlMs }),
				},
			};
			grants.set(stored.grant.id, stored);
			await emit({
				id: `capability:${ctx.organisationId}:grant:${stored.grant.id}:created`,
				type: "capability.grant.created",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(selector.projectId === undefined ? {} : { projectId: selector.projectId }),
				...(selector.sessionId === undefined ? {} : { sessionId: selector.sessionId }),
				...(selector.agentId === undefined ? {} : { agentId: selector.agentId }),
				subject: { kind: "capability.grant", id: stored.grant.id },
				data: {
					selector: selectorJson(selector),
					capabilities: [...stored.grant.capabilities],
					...(stored.grant.expiresAt === undefined ? {} : { expiresAt: stored.grant.expiresAt }),
				},
			});
			return grantView(stored);
		},

		async revokeGrant(ctx, grantId) {
			forbidAgent(ctx, "revoke capability grants");
			const stored = grants.get(grantId);
			if (stored === undefined || stored.grant.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No capability grant ${grantId}`);
			}
			if (stored.revokedAt !== undefined) return grantView(stored);
			stored.revokedAt = clock.now();
			await emit({
				id: `capability:${ctx.organisationId}:grant:${grantId}:revoked`,
				type: "capability.grant.revoked",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				subject: { kind: "capability.grant", id: grantId },
			});
			return grantView(stored);
		},

		async listGrants(ctx, page) {
			const caller = agentCaller(ctx);
			const visible = orgGrants(ctx.organisationId).filter(
				(grant) => caller === undefined || selectorMatches(grant.selector, caller),
			);
			return paginate(visible, page);
		},

		async invoke(ctx, input) {
			if (ctx.actor.kind !== "agent") throw new HarbourError("forbidden", "Only an agent invokes capabilities");
			if (ctx.projectId === undefined) throw new HarbourError("invalid", "Invoking a capability needs a projectId");
			if (typeof input.callId !== "string" || input.callId.length === 0) {
				throw new HarbourError("invalid", "A call needs a call ID");
			}
			if (ctx.signal?.aborted) throw new HarbourError("aborted", "The call was aborted before it started");
			const caller: Caller = { agentId: ctx.actor.agentId, sessionId: ctx.actor.sessionId, projectId: ctx.projectId };
			const inputFingerprint = await fingerprint(input.args);
			// From here to the `started` write there is no await: checks and the write happen as one step.

			// 1. The grant, on every call, retries included.
			const patterns = grantsFor(ctx.organisationId, caller).flatMap((grant) => grant.capabilities);
			if (!capabilityCovered(patterns, input.capability)) {
				return refuse(ctx, caller, input, "forbidden", "no_grant", `No active grant covers ${input.capability}`);
			}

			// 2. The journal, by call ID.
			const key = scopedKey(ctx.organisationId, input.callId);
			const existing = journalEntries.get(key);
			if (existing !== undefined) {
				const entry = existing.entry;
				if (
					entry.capability !== input.capability ||
					entry.inputFingerprint !== inputFingerprint ||
					entry.sessionId !== caller.sessionId ||
					entry.agentId !== caller.agentId
				) {
					throw new HarbourError("conflict", `Call ${input.callId} was made with other arguments or capability`, {
						callId: input.callId,
					});
				}
				if (entry.status !== "started") return entry.result!;
				if (entry.replay === "unsafe") {
					return refuse(
						ctx,
						caller,
						input,
						"refused",
						"uncertain",
						`Call ${input.callId} began and never committed; it may have run, so an operator must resolve it`,
					);
				}
			}

			// 3. The live registration and its version.
			const registration = registered.get(scopedKey(ctx.organisationId, input.capability));
			if (registration === undefined) throw new HarbourError("not_found", `No capability ${input.capability}`);
			const { definition } = registration;
			if (input.expectVersion !== undefined && input.expectVersion !== definition.version) {
				throw new HarbourError("conflict", `${input.capability} is version ${definition.version}`, {
					capability: input.capability,
					version: definition.version,
					expectVersion: input.expectVersion,
				});
			}

			// 4. The `started` entry, before the handler runs.
			let stored: StoredEntry;
			if (existing === undefined) {
				stored = {
					organisationId: ctx.organisationId,
					attempt: 1,
					entry: {
						callId: input.callId,
						capability: input.capability,
						version: definition.version,
						inputFingerprint,
						sessionId: caller.sessionId,
						agentId: caller.agentId,
						replay: definition.replay,
						status: "started",
						startedAt: clock.now(),
					},
				};
				journalEntries.set(key, stored);
			} else {
				stored = existing;
				stored.attempt += 1;
				stored.entry = { ...stored.entry, version: definition.version, replay: definition.replay };
			}
			const invocation: CapabilityInvocation = {
				callId: input.callId,
				capability: input.capability,
				version: definition.version,
				args: input.args,
				organisationId: ctx.organisationId,
				projectId: caller.projectId,
				sessionId: caller.sessionId,
				agentId: caller.agentId,
			};
			return runHandler(ctx, caller, stored, registration, invocation);
		},

		async journal(ctx, callId) {
			return entryFor(ctx, callId).entry;
		},

		async listJournal(ctx, filter, page) {
			const caller = agentCaller(ctx);
			const visible = [...journalEntries.values()]
				.filter((stored) => stored.organisationId === ctx.organisationId)
				.map((stored) => stored.entry)
				.filter(
					(entry) =>
						(caller === undefined || entry.sessionId === caller.sessionId) &&
						(filter.sessionId === undefined || entry.sessionId === filter.sessionId) &&
						(filter.status === undefined || entry.status === filter.status),
				);
			return paginate(visible, page);
		},

		async resolve(ctx, callId, result) {
			forbidAgent(ctx, "resolve a call");
			const stored = entryFor(ctx, callId);
			if (stored.entry.status !== "started") {
				throw new HarbourError("conflict", `Call ${callId} is already ${stored.entry.status}`, { callId });
			}
			const resolution = assertResult(result, "A resolution");
			stored.attempt += 1;
			stored.entry = {
				...stored.entry,
				status: "resolved",
				result: resolution,
				settledAt: clock.now(),
				resolvedBy: ctx.actor,
			};
			await emit({
				id: eventId(ctx.organisationId, callId, "resolved"),
				type: "capability.call.resolved",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				sessionId: stored.entry.sessionId,
				agentId: stored.entry.agentId,
				subject: { kind: "capability.call", id: callId },
				data: { capability: stored.entry.capability, isError: resolution.isError ?? false },
			});
			return stored.entry;
		},
	};
}
