/**
 * The session-end hook, portable across targets: components register their teardown once, and
 * the runtime runs every teardown, in registration order, when a session is closed or aborted. One failing teardown
 * never stops the others; its failure is audited with the teardown's name and error code, never its message.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	isKantelError,
	KantelError,
	type SessionEnd,
	type SessionEndHook,
	type SessionTeardown,
	type Subscription,
	systemClock,
	systemContext,
} from "@kantel/contracts";

export interface SessionEndRunner {
	/** What components register with. */
	readonly hook: SessionEndHook;
	/**
	 * Runs every registered teardown for `end`. `runId` makes the audit ids of this run stable, so a retried run never
	 * records the same failure twice. Resolves once every teardown has settled, whether or not one failed.
	 */
	run(end: SessionEnd, runId: string): Promise<void>;
	/** The registered teardown names, in the order they run. */
	names(): readonly string[];
}

const SESSION_END_ACTOR: Actor = { kind: "system", component: "session-end" };

export function createSessionEndHook(
	options: { readonly audit?: AuditSink; readonly clock?: Clock } = {},
): SessionEndRunner {
	const clock = options.clock ?? systemClock;
	const registrations: { readonly name: string; readonly teardown: SessionTeardown }[] = [];

	const hook: SessionEndHook = {
		register(name, teardown): Subscription {
			if (name === "") throw new KantelError("invalid", "A teardown needs a name");
			if (registrations.some((registration) => registration.name === name)) {
				throw new KantelError("conflict", `A teardown named ${name} is already registered`);
			}
			const registration = { name, teardown };
			registrations.push(registration);
			return {
				async close() {
					const index = registrations.indexOf(registration);
					if (index >= 0) registrations.splice(index, 1);
				},
			};
		},
	};

	const runner: SessionEndRunner = {
		hook,
		async run(end, runId) {
			const ctx: CallContext = { actor: SESSION_END_ACTOR, organisationId: end.organisationId };
			const failures: AuditEventInput[] = [];
			for (const { name, teardown } of [...registrations]) {
				try {
					await teardown(ctx, end);
				} catch (error) {
					failures.push({
						id: `session:${end.sessionId}:end:${runId}:teardown:${name}:failed`,
						at: clock.now(),
						source: "session",
						type: "session.teardown.failed",
						actor: SESSION_END_ACTOR,
						organisationId: end.organisationId,
						projectId: end.projectId,
						sessionId: end.sessionId,
						agentId: end.agentId,
						subject: { kind: "session", id: end.sessionId },
						data: { teardown: name, reason: end.reason, code: isKantelError(error) ? error.code : "unknown" },
					});
				}
			}
			// Audited after every teardown has run, so a failing audit sink cannot stop one.
			if (failures.length > 0) await options.audit?.append(systemContext("session.end"), failures);
		},
		names: () => registrations.map((registration) => registration.name),
	};
	return runner;
}
