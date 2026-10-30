/**
 * First-run onboarding (`OnboardingService`, `@harbour/contracts/onboarding`) over any `OnboardingStore`: every check,
 * every move between steps and the audit events live here, so the in-memory store (`./memory.ts`) and the SQL one
 * (`./sql.ts`) cannot drift apart. A store only keeps one state per organisation.
 */
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	freshOnboarding,
	HarbourError,
	isOnboardingStep,
	nextOnboardingStep,
	ONBOARDING_STEPS,
	type Onboarding,
	type OnboardingService,
	type OnboardingStatus,
	type OnboardingStepId,
	type OnboardingStepStatus,
	type OrganisationId,
	type ProjectAccess,
	systemClock,
	systemContext,
} from "@harbour/contracts";

/** Onboarding appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("onboarding");

/** What a store keeps: one state per organisation. Checks, the moves between steps and audit are `createOnboarding`'s. */
export interface OnboardingStore {
	/** The organisation's stored state, or undefined while nothing has been stored (a fresh install). */
	get(organisationId: OrganisationId): Promise<Onboarding | undefined>;
	/** Writes the organisation's state, replacing what was stored. */
	save(onboarding: Onboarding): Promise<void>;
}

export interface OnboardingOptions {
	readonly store: OnboardingStore;
	/** Checks organisation roles. Without it only agents are refused. */
	readonly access?: ProjectAccess;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
}

const STEP_STATUSES: readonly OnboardingStepStatus[] = ["pending", "done", "skipped"];

const isStepStatus = (value: unknown): value is OnboardingStepStatus =>
	typeof value === "string" && (STEP_STATUSES as readonly string[]).includes(value);

/** The step as an `OnboardingStepId`, or `invalid`. */
function checkStep(step: unknown): OnboardingStepId {
	if (!isOnboardingStep(step)) {
		throw new HarbourError("invalid", `An onboarding step is one of ${ONBOARDING_STEPS.join(", ")}`);
	}
	return step;
}

export function createOnboarding(options: OnboardingOptions): OnboardingService {
	const { store, access } = options;
	const clock = options.clock ?? systemClock;

	/** The organisation's state: as stored, else a fresh one. */
	const read = async (ctx: CallContext): Promise<Onboarding> =>
		(await store.get(ctx.organisationId)) ?? freshOnboarding(ctx.organisationId);

	/** Who may change it: Harbour, or an organisation-wide admin, which no agent holds. Each refusal is audited once. */
	async function requireWrite(ctx: CallContext, operation: string): Promise<void> {
		if (ctx.actor.kind === "system") return;
		if (access === undefined) {
			if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "Agents may not change onboarding");
			return;
		}
		await access.require(ctx, { needed: "admin", operation });
	}

	async function audit(
		ctx: CallContext,
		operation: string,
		onboarding: Onboarding,
		detail: { readonly step?: OnboardingStepId; readonly stepStatus?: OnboardingStepStatus },
	): Promise<void> {
		if (options.audit === undefined) return;
		const event: AuditEventInput = {
			id: `onboarding:changed:${onboarding.organisationId}:${crypto.randomUUID()}`,
			at: clock.now(),
			source: "onboarding",
			type: "onboarding.changed",
			actor: ctx.actor,
			organisationId: onboarding.organisationId,
			...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId, agentId: ctx.actor.agentId } : {}),
			subject: { kind: "onboarding", id: onboarding.organisationId },
			// The step acted on and the onboarding's new status; for `setStep`, the step's new status too.
			data: {
				operation,
				...(detail.step === undefined ? {} : { step: detail.step }),
				...(detail.stepStatus === undefined ? {} : { stepStatus: detail.stepStatus }),
				status: onboarding.status,
			},
		};
		await options.audit.append(AUDIT_CONTEXT, [event]);
	}

	/** Checks the caller, applies `change` to the current state, stores and audits it. */
	async function write(
		ctx: CallContext,
		operation: string,
		change: (before: Onboarding) => Pick<Onboarding, "status" | "current" | "steps">,
		detail: { readonly step?: OnboardingStepId; readonly stepStatus?: OnboardingStepStatus } = {},
	): Promise<Onboarding> {
		await requireWrite(ctx, `onboarding.${operation}`);
		const { status, current, steps } = change(await read(ctx));
		const onboarding: Onboarding = {
			organisationId: ctx.organisationId,
			status,
			current,
			steps,
			updatedAt: clock.now(),
		};
		await store.save(onboarding);
		await audit(ctx, operation, onboarding, detail);
		return onboarding;
	}

	return {
		get: (ctx) => read(ctx),

		async setStep(ctx, step, status) {
			const checked = checkStep(step);
			if (!isStepStatus(status)) {
				throw new HarbourError("invalid", `A step's status is one of ${STEP_STATUSES.join(", ")}`);
			}
			return write(
				ctx,
				"setStep",
				(before) => {
					const steps = { ...before.steps, [checked]: status };
					// Marking a step pending again goes back to it.
					if (status === "pending") return { steps, current: checked, status: "active" };
					const open = ONBOARDING_STEPS.some((each) => steps[each] === "pending");
					const next: OnboardingStatus = open ? "active" : "completed";
					return { steps, current: nextOnboardingStep(steps, checked) ?? checked, status: next };
				},
				{ step: checked, stepStatus: status },
			);
		},

		async goTo(ctx, step) {
			const checked = checkStep(step);
			return write(ctx, "goTo", (before) => ({ steps: before.steps, current: checked, status: "active" }), {
				step: checked,
			});
		},

		async dismiss(ctx) {
			return write(ctx, "dismiss", (before) => ({ steps: before.steps, current: before.current, status: "dismissed" }));
		},

		async reopen(ctx, step) {
			const checked = step === undefined ? "models" : checkStep(step);
			return write(ctx, "reopen", (before) => ({ steps: before.steps, current: checked, status: "active" }), {
				step: checked,
			});
		},
	};
}
