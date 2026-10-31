import {
	type AccessCheck,
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
	type InvokeInput,
	type JournalEntry,
	type JsonValue,
	KantelError,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type ProjectId,
	type SessionEndHook,
	type SessionId,
	type Subscription,
	systemClock,
	systemContext,
} from "@kantel/contracts";

/** The registry appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("capability");

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
	/**
	 * Project access, checked on every project-scoped call. Without it the registry checks only the
	 * organisation; every target and every conformance run passes one.
	 */
	readonly access?: ProjectAccess;
	/** When given, the registry registers its session-end teardown (`endSession`) under the name `capability`, once. */
	readonly sessionEnd?: SessionEndHook;
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
	if (ctx.actor.kind === "agent") throw new KantelError("forbidden", `An agent cannot ${what}`);
}

function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new KantelError("invalid", "Unknown page cursor");
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
		throw new KantelError("invalid", `${label} must be an object with an output`);
	}
	const { output, isError } = result as { readonly output: JsonValue; readonly isError?: unknown };
	canonicalJson(output);
	if (isError !== undefined && typeof isError !== "boolean") {
		throw new KantelError("invalid", `${label}'s isError must be a boolean`);
	}
	return isError === undefined ? { output } : { output, isError };
}

/** The project-scoped part of a grant's selector, as an access check; empty when it names neither project nor session. */
function selectorScope(selector: CapabilitySelector): Pick<AccessCheck, "projectId" | "sessionId"> {
	return {
		...(selector.projectId === undefined ? {} : { projectId: selector.projectId }),
		...(selector.sessionId === undefined ? {} : { sessionId: selector.sessionId }),
	};
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
	const access = options.access;

	async function requireAccess(ctx: CallContext, check: AccessCheck): Promise<void> {
		if (access !== undefined) await access.require(ctx, check);
	}

	async function allowsAccess(ctx: CallContext, check: Omit<AccessCheck, "operation" | "subject">): Promise<boolean> {
		return access === undefined || (await access.allows(ctx, check));
	}

	/** Viewer on each entry's session, asked once per session. */
	async function visibleSessions(ctx: CallContext, sessionIds: Iterable<SessionId>): Promise<Set<SessionId>> {
		const visible = new Set<SessionId>();
		for (const sessionId of new Set(sessionIds)) {
			if (await allowsAccess(ctx, { sessionId, needed: "viewer" })) visible.add(sessionId);
		}
		return visible;
	}

	/** Live registrations by organisation and capability name. */
	const registered = new Map<string, StoredRegistration>();
	const grants = new Map<string, StoredGrant>();
	/** Journal entries by organisation and call ID. */
	const journalEntries = new Map<string, StoredEntry>();

	async function emit(event: Omit<AuditEventInput, "at" | "source">): Promise<void> {
		if (audit === undefined) return;
		await audit.append(AUDIT_CONTEXT, [{ ...event, at: clock.now(), source: "capability" }]);
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
			throw new KantelError("not_found", `No journal entry for call ${callId}`);
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
			// Session and capability too, so refusals for different capabilities or sessions under one call ID each keep a row.
			id: eventId(ctx.organisationId, input.callId, `refused:${caller.sessionId}:${input.capability}:${reason}`),
			type: "capability.call.refused",
			...callFields(ctx, caller, input.callId),
			data: { capability: input.capability, reason },
		});
		throw new KantelError(code, message, { callId: input.callId, capability: input.capability });
	}

	/**
	 * Runs the handler for a `started` entry, then settles it unless a newer run or a resolution got there first. An
	 * `unsafe` handler that throws (aborted or not) may have run, so its entry stays `started` and the error is rethrown.
	 */
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
		let thrownError: unknown;
		try {
			result = assertResult(await registration.handler(invocation, controller.signal), "A handler result");
		} catch (thrown) {
			thrownError = thrown;
			error = thrown instanceof Error ? thrown.message : String(thrown);
			result = { output: error, isError: true };
		} finally {
			ctx.signal?.removeEventListener("abort", forwardAbort);
		}
		if (crashBeforeCommit?.(invocation.callId)) {
			throw new KantelError("unavailable", `Simulated crash before committing call ${invocation.callId}`);
		}
		if (stored.attempt !== attempt || stored.entry.status !== "started") {
			// A newer run or an operator settled it while this run was out: the journal holds the answer.
			return stored.entry.result ?? result;
		}
		if (error !== undefined && stored.entry.replay === "unsafe") {
			await emit({
				id: eventId(ctx.organisationId, invocation.callId, "settled"),
				type: "capability.call.settled",
				...callFields(ctx, caller, invocation.callId),
				data: { capability: invocation.capability, status: stored.entry.status, outcome: "uncertain" },
			});
			throw thrownError;
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

	const registry: CapabilityRegistry = {
		async register(ctx, definitions, handler) {
			forbidAgent(ctx, "register capabilities");
			await requireAccess(ctx, { needed: "operator", operation: "capability.register" });
			if (definitions.length === 0) throw new KantelError("invalid", "Register at least one capability");
			const names = new Set<CapabilityName>();
			for (const definition of definitions) {
				if (!isCapabilityName(definition.name)) {
					throw new KantelError("invalid", `"${definition.name}" is not a dotted capability name`);
				}
				if (names.has(definition.name)) throw new KantelError("invalid", `${definition.name} is listed twice`);
				if (definition.version.length === 0) throw new KantelError("invalid", `${definition.name} needs a version`);
				if (!REPLAY_POLICIES.has(definition.replay) || !RUNS_IN.has(definition.runsIn)) {
					throw new KantelError("invalid", `${definition.name} has an unknown replay policy or runsIn`);
				}
				names.add(definition.name);
			}
			for (const name of names) {
				if (registered.has(scopedKey(ctx.organisationId, name))) {
					throw new KantelError("conflict", `${name} is already registered`, { capability: name });
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
			// An agent's grants are selected by `ctx.projectId` too, so its session must be in that project.
			await requireAccess(ctx, {
				...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId } : {}),
				...(ctx.actor.kind === "agent" && ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
				needed: "viewer",
				operation: "capability.discover",
			});
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
			await requireAccess(ctx, {
				...selectorScope(input.selector),
				needed: "operator",
				operation: "capability.grant",
			});
			if (input.capabilities.length === 0) throw new KantelError("invalid", "A grant needs at least one capability");
			for (const pattern of input.capabilities) {
				if (!isCapabilityPattern(pattern)) {
					throw new KantelError("invalid", `"${pattern}" is neither a capability name nor a namespace ending in .*`);
				}
			}
			if (input.ttlMs !== undefined && (!Number.isInteger(input.ttlMs) || input.ttlMs < 1)) {
				throw new KantelError("invalid", "ttlMs must be a positive integer");
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
				throw new KantelError("not_found", `No capability grant ${grantId}`);
			}
			await requireAccess(ctx, {
				...selectorScope(stored.grant.selector),
				needed: "operator",
				operation: "capability.revokeGrant",
				subject: { kind: "capability.grant", id: grantId },
			});
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
			const matching = orgGrants(ctx.organisationId).filter(
				(grant) => caller === undefined || selectorMatches(grant.selector, caller),
			);
			// A grant whose selector names a project or session lists only for a viewer there; others list as before.
			const visible: CapabilityGrant[] = [];
			for (const grant of matching) {
				const scope = selectorScope(grant.selector);
				const scoped = scope.projectId !== undefined || scope.sessionId !== undefined;
				if (!scoped || (await allowsAccess(ctx, { ...scope, needed: "viewer" }))) visible.push(grant);
			}
			return paginate(visible, page);
		},

		async invoke(ctx, input) {
			if (ctx.actor.kind !== "agent") throw new KantelError("forbidden", "Only an agent invokes capabilities");
			if (ctx.projectId === undefined) throw new KantelError("invalid", "Invoking a capability needs a projectId");
			if (typeof input.callId !== "string" || input.callId.length === 0) {
				throw new KantelError("invalid", "A call needs a call ID");
			}
			if (ctx.signal?.aborted) throw new KantelError("aborted", "The call was aborted before it started");
			// The agent's own session and the project it names, together: a call naming another project is refused.
			await requireAccess(ctx, {
				projectId: ctx.projectId,
				sessionId: ctx.actor.sessionId,
				needed: "operator",
				operation: "capability.invoke",
				subject: { kind: "capability.call", id: input.callId },
			});
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
					throw new KantelError("conflict", `Call ${input.callId} was made with other arguments or capability`, {
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
			if (registration === undefined) throw new KantelError("not_found", `No capability ${input.capability}`);
			const { definition } = registration;
			if (input.expectVersion !== undefined && input.expectVersion !== definition.version) {
				throw new KantelError("conflict", `${input.capability} is version ${definition.version}`, {
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
			const stored = entryFor(ctx, callId);
			await requireAccess(ctx, {
				sessionId: stored.entry.sessionId,
				needed: "viewer",
				operation: "capability.journal",
				subject: { kind: "capability.call", id: callId },
			});
			return stored.entry;
		},

		async listJournal(ctx, filter, page) {
			const caller = agentCaller(ctx);
			// An agent lists only its own session (the existing rule, first): naming another session lists nothing.
			const checkFilter =
				filter.sessionId !== undefined && (caller === undefined || filter.sessionId === caller.sessionId);
			if (checkFilter) {
				await requireAccess(ctx, {
					sessionId: filter.sessionId,
					needed: "viewer",
					operation: "capability.listJournal",
				});
			}
			const matching = [...journalEntries.values()]
				.filter((stored) => stored.organisationId === ctx.organisationId)
				.map((stored) => stored.entry)
				.filter(
					(entry) =>
						(caller === undefined || entry.sessionId === caller.sessionId) &&
						(filter.sessionId === undefined || entry.sessionId === filter.sessionId) &&
						(filter.status === undefined || entry.status === filter.status),
				);
			if (checkFilter) return paginate(matching, page);
			const sessions = await visibleSessions(
				ctx,
				matching.map((entry) => entry.sessionId),
			);
			return paginate(
				matching.filter((entry) => sessions.has(entry.sessionId)),
				page,
			);
		},

		async resolve(ctx, callId, result) {
			forbidAgent(ctx, "resolve a call");
			const stored = entryFor(ctx, callId);
			await requireAccess(ctx, {
				sessionId: stored.entry.sessionId,
				needed: "operator",
				operation: "capability.resolve",
				subject: { kind: "capability.call", id: callId },
			});
			if (stored.entry.status !== "started") {
				throw new KantelError("conflict", `Call ${callId} is already ${stored.entry.status}`, { callId });
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

		async endSession(ctx, sessionId, reason) {
			await requireAccess(ctx, { sessionId, needed: "operator", operation: "capability.endSession" });
			const now = clock.now();
			const ended: StoredGrant[] = [];
			for (const stored of grants.values()) {
				if (stored.grant.organisationId !== ctx.organisationId || stored.grant.selector.sessionId !== sessionId)
					continue;
				if (grantView(stored).status !== "active") continue;
				stored.revokedAt = now;
				ended.push(stored);
			}
			for (const { grant } of ended) {
				await emit({
					id: `capability:${ctx.organisationId}:grant:${grant.id}:revoked`,
					type: "capability.grant.revoked",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(grant.selector.projectId === undefined ? {} : { projectId: grant.selector.projectId }),
					sessionId,
					subject: { kind: "capability.grant", id: grant.id },
					data: { reason },
				});
			}
		},
	};

	options.sessionEnd?.register("capability", (ctx, end) => registry.endSession(ctx, end.sessionId, end.reason));
	return registry;
}
