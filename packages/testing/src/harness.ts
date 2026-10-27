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
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type ErrorCode,
	isHarbourError,
	type OrganisationId,
	type ProjectId,
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

/** An `AuditSink` that keeps what it is given, idempotent by id, so suites can check what was audited. */
export class RecordingAuditSink implements AuditSink {
	readonly #events = new Map<string, AuditEventInput>();
	async append(events: readonly AuditEventInput[]): Promise<void> {
		for (const event of events) if (!this.#events.has(event.id)) this.#events.set(event.id, event);
	}
	get events(): readonly AuditEventInput[] {
		return [...this.#events.values()];
	}
	ofType(type: string): readonly AuditEventInput[] {
		return this.events.filter((event) => event.type === type);
	}
}

/** What every provider receives: a manual clock and a recording audit sink, fresh per case. */
export interface ConformanceDeps {
	readonly clock: ManualClock;
	readonly audit: RecordingAuditSink;
}

export function createDeps(): ConformanceDeps {
	return { clock: new ManualClock(), audit: new RecordingAuditSink() };
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
