/**
 * First-run onboarding: the few steps that get a fresh install going (connect a model, add connectors, start a first
 * session), and where an organisation is in them. The console's onboarding is one client of this; the API serves the
 * same calls to a host app, a packaged agent or a script, so any of them can read the state, finish a step or skip
 * the lot.
 *
 * - One state per organisation, the install's: a fresh organisation reads as `active` at its first step with nothing
 *   stored, so there is nothing to seed.
 * - Each step is `pending`, `done` or `skipped`. Finishing or skipping one moves `current` to the next step still
 *   pending after it (or before it, when the later ones are settled); when none is pending, the onboarding is
 *   `completed`.
 * - `dismissed` is the whole thing skipped. Neither `completed` nor `dismissed` is offered again until someone reopens
 *   it (`reopen`), which keeps each step's status and starts at the first step.
 * - Reads are open to the organisation's members; changes need an organisation-wide admin, which no agent holds. A
 *   host app's key with admin may change it. Every change is audited (`onboarding.changed`) with the step and the new
 *   status.
 *
 * Harbour adds no prompt and no setting of its own here: onboarding only records progress. What a step does (a model
 * connector, a connection, a session) is made through that resource's own API.
 */
import type { CallContext, OrganisationId, Timestamp } from "./common.ts";

export type OnboardingStepId = "models" | "connectors" | "session";

/** The steps, in order. */
export const ONBOARDING_STEPS: readonly OnboardingStepId[] = ["models", "connectors", "session"];

export type OnboardingStepStatus = "pending" | "done" | "skipped";

/** `active` while it is offered; `completed` once no step is pending; `dismissed` when someone skipped the lot. */
export type OnboardingStatus = "active" | "completed" | "dismissed";

export interface Onboarding {
	readonly organisationId: OrganisationId;
	readonly status: OnboardingStatus;
	/** The step to show: where the person left off. */
	readonly current: OnboardingStepId;
	readonly steps: { readonly [step in OnboardingStepId]: OnboardingStepStatus };
	/** When it last changed; absent while nothing has been stored (a fresh install). */
	readonly updatedAt?: Timestamp;
}

export interface OnboardingService {
	/** The organisation's onboarding: on a fresh install, `active` at `models` with every step pending. */
	get(ctx: CallContext): Promise<Onboarding>;
	/**
	 * Marks one step `done`, `skipped` or `pending` again. Settling it moves `current` on to the next pending step and
	 * completes the onboarding when none is left; marking a step pending makes it `current` and the onboarding active.
	 */
	setStep(ctx: CallContext, step: OnboardingStepId, status: OnboardingStepStatus): Promise<Onboarding>;
	/** Shows another step, such as Back, without changing any step's status. Reopens a completed or dismissed one. */
	goTo(ctx: CallContext, step: OnboardingStepId): Promise<Onboarding>;
	/** Skips the whole onboarding: it is not offered again until `reopen`. */
	dismiss(ctx: CallContext): Promise<Onboarding>;
	/** Offers it again (the console's settings), at `step` or the first step, keeping each step's status. */
	reopen(ctx: CallContext, step?: OnboardingStepId): Promise<Onboarding>;
}

export const isOnboardingStep = (value: unknown): value is OnboardingStepId =>
	typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);

/** A fresh organisation's onboarding: nothing done, at the first step. */
export function freshOnboarding(organisationId: OrganisationId): Onboarding {
	return {
		organisationId,
		status: "active",
		current: "models",
		steps: { models: "pending", connectors: "pending", session: "pending" },
	};
}

/**
 * The step to go to once `settled` is settled: the next pending step after it, else the first pending one before it,
 * else undefined (every step is settled).
 */
export function nextOnboardingStep(
	steps: Onboarding["steps"],
	settled: OnboardingStepId,
): OnboardingStepId | undefined {
	const at = ONBOARDING_STEPS.indexOf(settled);
	const after = ONBOARDING_STEPS.slice(at + 1).find((step) => steps[step] === "pending");
	return after ?? ONBOARDING_STEPS.slice(0, at).find((step) => steps[step] === "pending");
}

/** Whether the console should open onboarding on its own: only while it is active. */
export const onboardingOffered = (onboarding: Pick<Onboarding, "status">) => onboarding.status === "active";
