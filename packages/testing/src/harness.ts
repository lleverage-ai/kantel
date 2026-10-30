/**
 * The shared shape of every conformance suite, modelled on pi-durable's `registerEnvConformance`
 * (earendil-works/pi@973b74c55fcf096ad5976f8d8850c147ee2e62d4:packages/durable/src/testing/runner.ts:27-38):
 *
 * - `create<Contract>Conformance(options)` returns runner-independent cases.
 * - `register<Contract>Conformance(runner, name, provider)` registers them with any Vitest/Jest-compatible runner.
 * - The provider is called once per case with fresh dependencies and hands a fresh implementation to `use`, then
 *   cleans up. Every target (memory, Cloudflare, self-hosted) registers the same suite.
 */
import {
	type Actor,
	type AgentId,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	createProjectAccess,
	type ErrorCode,
	HarbourError,
	type IdentityDirectory,
	isHarbourError,
	isSystemActor,
	type OrganisationId,
	type ProjectAccess,
	type ProjectId,
	type Role,
	roleSatisfies,
	type SessionDirectory,
	type SessionId,
	type SessionRecord,
	type SystemContext,
	systemContext,
	type Timestamp,
} from "@harbour/contracts";

export type ExpectLike = (actual: unknown, message?: string) => unknown;

export interface ConformanceRunner {
	readonly describe: (name: string, suite: () => void) => unknown;
	readonly expect: ExpectLike;
	readonly it: (name: string, test: () => Promise<void>, timeoutMs?: number) => unknown;
}

export interface ConformanceAssertions {
	ok(value: unknown, message?: string): void;
	strictEqual(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	partialDeepEqual(actual: unknown, expected: unknown, message?: string): void;
	greaterThan(actual: number, expected: number, message?: string): void;
	/** Asserts that `operation` rejects with a HarbourError of `code`. */
	rejectsWithCode(operation: Promise<unknown>, code: ErrorCode, message?: string): Promise<void>;
}

type ExpectResult = {
	toBe(expected: unknown): unknown;
	toBeGreaterThan(expected: number): unknown;
	toEqual(expected: unknown): unknown;
	toMatchObject(expected: unknown): unknown;
	toBeTruthy(): unknown;
};

/** Adapts a Vitest/Jest-compatible `expect` without importing either runner. */
export function createExpectAssertions(expect: ExpectLike): ConformanceAssertions {
	const result = (actual: unknown, message?: string): ExpectResult => expect(actual, message) as ExpectResult;
	return {
		ok(value, message) {
			result(value, message).toBeTruthy();
		},
		strictEqual(actual, expected, message) {
			result(actual, message).toBe(expected);
		},
		deepEqual(actual, expected, message) {
			result(actual, message).toEqual(expected);
		},
		partialDeepEqual(actual, expected, message) {
			result(actual, message).toMatchObject(expected);
		},
		greaterThan(actual, expected, message) {
			result(actual, message).toBeGreaterThan(expected);
		},
		async rejectsWithCode(operation, code, message) {
			let caught: unknown;
			let rejected = false;
			try {
				await operation;
			} catch (error) {
				rejected = true;
				caught = error;
			}
			const label = message ?? `expected a rejection with code ${code}`;
			result(rejected, `${label}: it resolved`).toBe(true);
			const actual = isHarbourError(caught) ? caught.code : `non-Harbour error: ${String(caught)}`;
			result(actual, label).toBe(code);
		},
	};
}

export interface ConformanceCase {
	readonly name: string;
	readonly timeoutMs?: number;
	run(): Promise<void>;
}

/** Registers cases under one `describe`. */
export function registerCases(runner: ConformanceRunner, name: string, cases: readonly ConformanceCase[]): void {
	runner.describe(name, () => {
		for (const testCase of cases) runner.it(testCase.name, testCase.run, testCase.timeoutMs);
	});
}

/**
 * `runner` with `timeoutMs` for every case that sets none of its own, for a backend whose fixture is slow (such as
 * `TestDatabaseKind.testTimeoutMs`). Undefined returns `runner` unchanged.
 */
export function withTestTimeout(runner: ConformanceRunner, timeoutMs: number | undefined): ConformanceRunner {
	if (timeoutMs === undefined) return runner;
	return { ...runner, it: (name, test, caseTimeoutMs) => runner.it(name, test, caseTimeoutMs ?? timeoutMs) };
}

/** A clock the suite moves by hand. Implementations under test must read time only from the clock they are given. */
export class ManualClock implements Clock {
	#now: Timestamp;
	constructor(start: Timestamp = Date.UTC(2026, 9, 27, 9, 0, 0)) {
		this.#now = start;
	}
	now(): Timestamp {
		return this.#now;
	}
	advance(ms: number): Timestamp {
		this.#now += ms;
		return this.#now;
	}
	set(at: Timestamp): void {
		this.#now = at;
	}
}

/**
 * An `AuditSink` that keeps what it is given, idempotent by id, so suites can check what was audited. Like every sink,
 * it takes appends from Harbour's own components only (settled question 13): one without a system context throws, so
 * a component that appends as its caller fails its suite.
 */
export class RecordingAuditSink implements AuditSink {
	readonly #events = new Map<string, AuditEventInput>();
	async append(ctx: SystemContext, events: readonly AuditEventInput[]): Promise<void> {
		if (!isSystemActor(ctx?.actor)) throw new Error("An audit append needs a system context");
		for (const event of events) if (!this.#events.has(event.id)) this.#events.set(event.id, event);
	}
	get events(): readonly AuditEventInput[] {
		return [...this.#events.values()];
	}
	ofType(type: string): readonly AuditEventInput[] {
		return this.events.filter((event) => event.type === type);
	}
}

/**
 * A test double of the two directories `ProjectAccess` reads: identity's role bindings (`roleOf`) and the session
 * directory (`get`). Suites seed it with the roles and agent sessions their cases use. It follows identity's model:
 * a binding is on one project or, without a project, across the organisation, and the strongest one counts.
 */
export class TenancyFixture {
	readonly #clock: Clock;
	readonly #bindings: {
		readonly organisationId: OrganisationId;
		readonly projectId?: ProjectId;
		readonly principal: string;
		readonly role: Role;
	}[] = [];
	readonly #sessions = new Map<SessionId, SessionRecord>();

	constructor(clock: Clock) {
		this.#clock = clock;
	}

	/** Gives a human or service `role` on `projectId`, or across the organisation when `projectId` is absent. */
	bind(actor: Actor, organisationId: OrganisationId, role: Role, projectId?: ProjectId): void {
		const principal = principalOf(actor);
		if (principal === undefined) throw new Error("Only humans and services hold roles");
		this.#bindings.push({ organisationId, principal, role, ...(projectId === undefined ? {} : { projectId }) });
	}

	/** Removes `actor`'s binding on `projectId` (or its organisation-wide one), as `IdentityDirectory.revokeRole` does. */
	unbind(actor: Actor, organisationId: OrganisationId, projectId?: ProjectId): void {
		const principal = principalOf(actor);
		for (let at = this.#bindings.length - 1; at >= 0; at--) {
			const binding = this.#bindings[at]!;
			if (
				binding.organisationId === organisationId &&
				binding.principal === principal &&
				binding.projectId === projectId
			) {
				this.#bindings.splice(at, 1);
			}
		}
	}

	/**
	 * Records an open agent session in the directory and returns the agent actor acting in it. Without `projectId` the
	 * session is scoped to the organisation.
	 */
	session(input: {
		readonly id: SessionId;
		readonly organisationId: OrganisationId;
		readonly projectId?: ProjectId;
		readonly agentId: AgentId;
		readonly parentSessionId?: SessionId;
	}): Actor {
		const now = this.#clock.now();
		this.#sessions.set(input.id, {
			id: input.id,
			organisationId: input.organisationId,
			...(input.projectId === undefined ? {} : { projectId: input.projectId }),
			agentId: input.agentId,
			...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
			status: "idle",
			labels: {},
			createdBy: { kind: "system", component: "conformance" },
			createdAt: now,
			updatedAt: now,
		});
		return { kind: "agent", agentId: input.agentId, sessionId: input.id };
	}

	/** Marks a session closed (`done`); its agent acts nowhere after that. */
	close(sessionId: SessionId): void {
		const record = this.#sessions.get(sessionId);
		if (record !== undefined) this.#sessions.set(sessionId, { ...record, status: "done" });
	}

	readonly identity: Pick<IdentityDirectory, "roleOf"> = {
		roleOf: async (ctx, actor, organisationId, projectId) => {
			if (!isSystemActor(ctx?.actor)) throw new HarbourError("forbidden", "roleOf is a worker call");
			if (actor.kind === "system") return "admin";
			const principal = principalOf(actor);
			if (principal === undefined) return undefined;
			let strongest: Role | undefined;
			for (const binding of this.#bindings) {
				if (binding.organisationId !== organisationId || binding.principal !== principal) continue;
				if (binding.projectId !== undefined && binding.projectId !== projectId) continue;
				if (strongest === undefined || roleSatisfies(binding.role, strongest)) strongest = binding.role;
			}
			return strongest;
		},
	};

	readonly sessions: Pick<SessionDirectory, "get"> = {
		get: async (ctx, sessionId) => {
			const record = this.#sessions.get(sessionId);
			if (record === undefined || record.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No session ${sessionId}`);
			}
			return record;
		},
	};
}

function principalOf(actor: Actor): string | undefined {
	if (actor.kind === "human") return `user:${actor.userId}`;
	if (actor.kind === "service") return `service:${actor.serviceId}`;
	return undefined;
}

/**
 * What every provider receives, fresh per case: a manual clock, a recording audit sink, and a `ProjectAccess` (the
 * reference `createProjectAccess` over `tenancy`, auditing into `audit`). Wire `access` into the component under test.
 */
export interface ConformanceDeps {
	readonly clock: ManualClock;
	readonly audit: RecordingAuditSink;
	readonly access: ProjectAccess;
	readonly tenancy: TenancyFixture;
}

export function createDeps(): ConformanceDeps {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const tenancy = new TenancyFixture(clock);
	const access = createProjectAccess({ identity: tenancy.identity, sessions: tenancy.sessions, audit, clock });
	return { clock, audit, access, tenancy };
}

/** Options every `register<X>Conformance` takes. */
export interface ConformanceOptions {
	/**
	 * Runs the project-access cases (settled question 7): the component must refuse, through `deps.access`, an operator
	 * outside the project and an agent whose session belongs to another project. Off by default only until the
	 * Cloudflare and self-hosted targets wire `deps.access`; every in-memory implementation runs with it on.
	 */
	readonly projectAccess?: boolean;
}

/**
 * Asserts that `call` rejects with `forbidden`, that the refusal holds no canary secret, and that `ProjectAccess`
 * audited it once as `access.denied` for `operation` without the canary.
 */
export async function assertAccessDenied(
	a: ConformanceAssertions,
	deps: Pick<ConformanceDeps, "audit">,
	call: Promise<unknown>,
	expected: { readonly operation: string; readonly message?: string },
): Promise<void> {
	const label = expected.message ?? `${expected.operation} is refused`;
	const before = deps.audit.ofType("access.denied").length;
	let caught: unknown;
	let rejected = false;
	try {
		await call;
	} catch (error) {
		rejected = true;
		caught = error;
	}
	a.strictEqual(rejected, true, `${label}: it resolved`);
	a.strictEqual(isHarbourError(caught) ? caught.code : `non-Harbour error: ${String(caught)}`, "forbidden", label);
	const refusal = isHarbourError(caught) ? { message: caught.message, details: caught.details ?? null } : null;
	a.ok(!containsCanary(refusal), `${label}: the refusal holds no secret`);
	const events = deps.audit.ofType("access.denied").slice(before);
	a.strictEqual(events.length, 1, `${label}: audited once as access.denied`);
	a.strictEqual(events[0]?.data?.operation, expected.operation, `${label}: the audit names the operation`);
	a.ok(!containsCanary(events), `${label}: the audit holds no secret`);
}

/** Builds call contexts for suites. */
export function contextFor(
	actor: Actor,
	organisationId: OrganisationId,
	projectId?: ProjectId,
	extra?: { readonly requestId?: string; readonly signal?: AbortSignal },
): CallContext {
	return {
		actor,
		organisationId,
		...(projectId === undefined ? {} : { projectId }),
		...(extra?.requestId === undefined ? {} : { requestId: extra.requestId }),
		...(extra?.signal === undefined ? {} : { signal: extra.signal }),
	};
}

export const actors = {
	human: (userId: string): Actor => ({ kind: "human", userId }),
	service: (serviceId: string, keyId?: string): Actor =>
		keyId === undefined ? { kind: "service", serviceId } : { kind: "service", serviceId, keyId },
	agent: (agentId: string, sessionId: string): Actor => ({ kind: "agent", agentId, sessionId }),
	system: (component = "conformance"): Actor => ({ kind: "system", component }),
};

/** The context suites make worker calls with: Harbour's own, as `system`. */
export const WORKER: SystemContext = systemContext("conformance.worker");

/**
 * The callers a worker call must refuse (settled question 13): no caller at all, and a human, a service and an agent,
 * each with a full call context in `organisationId`. The agent's session is open in the tenancy fixture when the suite
 * seeds one, so the refusal cannot come from a closed session.
 */
export function nonSystemCallers(
	organisationId: OrganisationId,
	agent: { readonly agentId: AgentId; readonly sessionId: SessionId } = {
		agentId: "agent-worker-call",
		sessionId: "sess-worker-call",
	},
): readonly { readonly label: string; readonly ctx: SystemContext }[] {
	return [
		{ label: "no caller", ctx: undefined as unknown as SystemContext },
		{ label: "a human", ctx: contextFor(actors.human("user-worker-call"), organisationId) },
		{ label: "a service", ctx: contextFor(actors.service("svc-worker-call"), organisationId) },
		{ label: "an agent", ctx: contextFor(actors.agent(agent.agentId, agent.sessionId), organisationId) },
	];
}

/**
 * Asserts that a worker call refuses every caller `nonSystemCallers` lists: `forbidden`, no secret, and audited once as
 * `access.denied` for `operation` (see `assertAccessDenied`). `call` makes the call with the given context.
 */
export async function assertWorkerCallRefused(
	a: ConformanceAssertions,
	deps: Pick<ConformanceDeps, "audit">,
	operation: string,
	call: (ctx: SystemContext) => Promise<unknown>,
	organisationId: OrganisationId,
	agent?: { readonly agentId: AgentId; readonly sessionId: SessionId },
): Promise<void> {
	for (const caller of nonSystemCallers(organisationId, agent)) {
		// Started after `assertAccessDenied` counts the audit: a refusal may be audited before the call first awaits.
		const deferred = Promise.resolve().then(() => call(caller.ctx));
		await assertAccessDenied(a, deps, deferred, {
			operation,
			message: `${operation} refuses ${caller.label}`,
		});
	}
}

/** Waits until `predicate` holds, polling with real time; for suites that watch asynchronous work. */
export async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000, label = "condition") {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A canary credential value. Suites assert it never appears outside the egress decision. */
export const CANARY_SECRET = "harbour-canary-6f1d2c9e-do-not-leak";

export function containsCanary(value: unknown, canary = CANARY_SECRET): boolean {
	return (
		JSON.stringify(value, (_key, inner) => (inner instanceof Uint8Array ? [...inner] : inner))?.includes(canary) ??
		false
	);
}
