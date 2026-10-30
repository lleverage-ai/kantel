/**
 * Conformance suite for `OnboardingService` (packages/contracts/src/onboarding.ts). Every target registers it with a
 * provider that builds a fresh service on the suite's clock, audit sink and access.
 */
import {
	type CallContext,
	freshOnboarding,
	type OnboardingService,
	type OnboardingStepId,
	type OnboardingStepStatus,
	systemContext,
} from "@harbour/contracts";
import {
	actors,
	assertAccessDenied,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface OnboardingSubject {
	readonly onboarding: OnboardingService;
}

export type OnboardingConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: OnboardingSubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-onboarding";
const OTHER_ORG = "org-onboarding-elsewhere";
const PROJECT = "proj-onboarding";

/** An admin across the organisation. */
const admin = contextFor(actors.human("admin-1"), ORG);
/** An admin on the project only: not enough to change the organisation's onboarding. */
const projectAdmin = contextFor(actors.human("padmin-1"), ORG, PROJECT);
/** An operator across the organisation: not enough either. */
const orgOperator = contextFor(actors.human("operator-1"), ORG);
/** A viewer across the organisation. */
const viewer = contextFor(actors.human("viewer-1"), ORG);
const projectAgent = contextFor(actors.agent("agent-p", "sess-project"), ORG, PROJECT);
const orgAgent = contextFor(actors.agent("agent-o", "sess-org"), ORG);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);
const harbour: CallContext = { ...systemContext("onboarding-seed"), organisationId: ORG };

function seedTenancy(deps: ConformanceDeps): void {
	const { tenancy } = deps;
	tenancy.bind(admin.actor, ORG, "admin");
	tenancy.bind(projectAdmin.actor, ORG, "admin", PROJECT);
	tenancy.bind(orgOperator.actor, ORG, "operator");
	tenancy.bind(viewer.actor, ORG, "viewer");
	tenancy.bind(outsider.actor, OTHER_ORG, "admin");
	tenancy.session({ id: "sess-project", organisationId: ORG, projectId: PROJECT, agentId: "agent-p" });
	tenancy.session({ id: "sess-org", organisationId: ORG, agentId: "agent-o" });
}

const steps = (models: OnboardingStepStatus, connectors: OnboardingStepStatus, session: OnboardingStepStatus) => ({
	models,
	connectors,
	session,
});

export function createOnboardingConformance(options: {
	assertions: ConformanceAssertions;
	provider: OnboardingConformanceProvider;
	projectAccess?: boolean;
}): readonly ConformanceCase[] {
	const a = options.assertions;
	const withOnboarding = (run: (onboarding: OnboardingService, deps: ConformanceDeps) => Promise<void>) => async () => {
		const deps = createDeps();
		seedTenancy(deps);
		await options.provider(deps, ({ onboarding }) => run(onboarding, deps));
	};

	const cases: ConformanceCase[] = [
		{
			name: "a fresh organisation reads as active at models with every step pending, and nothing stored or audited",
			run: withOnboarding(async (onboarding, deps) => {
				const fresh = await onboarding.get(admin);
				a.deepEqual(fresh, freshOnboarding(ORG));
				a.strictEqual(fresh.updatedAt, undefined, "nothing is stored yet");
				a.deepEqual(await onboarding.get(outsider), freshOnboarding(OTHER_ORG));
				a.deepEqual(deps.audit.ofType("onboarding.changed"), []);
			}),
		},
		{
			name: "settling each step moves current to the next pending one and completes the onboarding when none is left",
			run: withOnboarding(async (onboarding, deps) => {
				const first = await onboarding.setStep(admin, "models", "done");
				a.deepEqual(first, {
					organisationId: ORG,
					status: "active",
					current: "connectors",
					steps: steps("done", "pending", "pending"),
					updatedAt: deps.clock.now(),
				});
				deps.clock.advance(1000);
				// Skipping a step settles it as finishing one does.
				a.partialDeepEqual(await onboarding.setStep(admin, "connectors", "skipped"), {
					status: "active",
					current: "session",
					steps: steps("done", "skipped", "pending"),
					updatedAt: deps.clock.now(),
				});
				const last = await onboarding.setStep(admin, "session", "done");
				a.partialDeepEqual(last, { status: "completed", current: "session", steps: steps("done", "skipped", "done") });
				a.deepEqual(await onboarding.get(viewer), last, "the change is stored");
			}),
		},
		{
			name: "settling a later step goes back to an earlier pending one, and marking a step pending again reopens it",
			run: withOnboarding(async (onboarding) => {
				a.partialDeepEqual(await onboarding.setStep(admin, "session", "done"), {
					status: "active",
					current: "models",
				});
				await onboarding.setStep(admin, "models", "done");
				a.partialDeepEqual(await onboarding.setStep(admin, "connectors", "skipped"), {
					status: "completed",
					current: "connectors",
				});
				a.partialDeepEqual(await onboarding.setStep(admin, "models", "pending"), {
					status: "active",
					current: "models",
					steps: steps("pending", "skipped", "done"),
				});
			}),
		},
		{
			name: "goTo, dismiss and reopen move between steps and keep each step's status",
			run: withOnboarding(async (onboarding) => {
				await onboarding.setStep(admin, "models", "done");
				const kept = steps("done", "pending", "pending");
				// Back to the first step.
				a.partialDeepEqual(await onboarding.goTo(admin, "models"), {
					status: "active",
					current: "models",
					steps: kept,
				});
				a.partialDeepEqual(await onboarding.dismiss(admin), { status: "dismissed", current: "models", steps: kept });
				a.partialDeepEqual(await onboarding.get(admin), { status: "dismissed" });
				a.partialDeepEqual(await onboarding.reopen(admin), { status: "active", current: "models", steps: kept });
				await onboarding.dismiss(admin);
				a.partialDeepEqual(await onboarding.reopen(admin, "session"), {
					status: "active",
					current: "session",
					steps: kept,
				});
				await onboarding.dismiss(admin);
				a.partialDeepEqual(await onboarding.goTo(admin, "connectors"), {
					status: "active",
					current: "connectors",
					steps: kept,
				});
			}),
		},
		{
			name: "rejects an unknown step or status as invalid and changes nothing",
			run: withOnboarding(async (onboarding) => {
				const step = "billing" as OnboardingStepId;
				await a.rejectsWithCode(onboarding.setStep(admin, step, "done"), "invalid");
				await a.rejectsWithCode(onboarding.setStep(admin, "models", "finished" as OnboardingStepStatus), "invalid");
				await a.rejectsWithCode(onboarding.goTo(admin, step), "invalid");
				await a.rejectsWithCode(onboarding.reopen(admin, step), "invalid");
				a.deepEqual(await onboarding.get(admin), freshOnboarding(ORG));
			}),
		},
		{
			name: "audits each change as onboarding.changed with the operation, the step and the new status",
			run: withOnboarding(async (onboarding, deps) => {
				await onboarding.setStep(admin, "models", "done");
				await onboarding.goTo(admin, "models");
				await onboarding.dismiss(admin);
				await onboarding.reopen(admin, "connectors");
				const events = deps.audit.ofType("onboarding.changed");
				a.strictEqual(events.length, 4);
				for (const event of events) {
					a.partialDeepEqual(event, {
						source: "onboarding",
						type: "onboarding.changed",
						actor: admin.actor,
						organisationId: ORG,
						subject: { kind: "onboarding", id: ORG },
					});
				}
				a.deepEqual(
					events.map((event) => event.data),
					[
						{ operation: "setStep", step: "models", stepStatus: "done", status: "active" },
						{ operation: "goTo", step: "models", status: "active" },
						{ operation: "dismiss", status: "dismissed" },
						{ operation: "reopen", step: "connectors", status: "active" },
					],
				);
			}),
		},
		{
			name: "each organisation has its own onboarding",
			run: withOnboarding(async (onboarding) => {
				await onboarding.dismiss(admin);
				a.deepEqual(await onboarding.get(outsider), freshOnboarding(OTHER_ORG));
				await onboarding.setStep(outsider, "models", "skipped");
				a.partialDeepEqual(await onboarding.get(admin), { status: "dismissed", steps: freshOnboarding(ORG).steps });
			}),
		},
		{
			name: "Harbour itself may change it",
			run: withOnboarding(async (onboarding) => {
				a.partialDeepEqual(await onboarding.setStep(harbour, "models", "done"), { current: "connectors" });
				a.partialDeepEqual(await onboarding.dismiss(harbour), { status: "dismissed" });
			}),
		},
	];
	if (options.projectAccess !== true) return cases;

	cases.push(
		{
			name: "changes need an organisation-wide admin: an operator, a viewer or a project's admin is refused",
			run: withOnboarding(async (onboarding, deps) => {
				for (const caller of [orgOperator, viewer, projectAdmin]) {
					await assertAccessDenied(a, deps, onboarding.setStep(caller, "models", "done"), {
						operation: "onboarding.setStep",
					});
					await assertAccessDenied(a, deps, onboarding.goTo(caller, "session"), { operation: "onboarding.goTo" });
					await assertAccessDenied(a, deps, onboarding.dismiss(caller), { operation: "onboarding.dismiss" });
					await assertAccessDenied(a, deps, onboarding.reopen(caller), { operation: "onboarding.reopen" });
				}
				a.deepEqual(await onboarding.get(viewer), freshOnboarding(ORG), "nothing changed");
				a.deepEqual(deps.audit.ofType("onboarding.changed"), []);
			}),
		},
		{
			name: "agents never change it, an organisation session's agent included, but read it; each refusal is audited",
			run: withOnboarding(async (onboarding, deps) => {
				await onboarding.setStep(admin, "models", "done");
				const stored = await onboarding.get(admin);
				for (const agent of [projectAgent, orgAgent]) {
					await assertAccessDenied(a, deps, onboarding.setStep(agent, "connectors", "done"), {
						operation: "onboarding.setStep",
					});
					await assertAccessDenied(a, deps, onboarding.goTo(agent, "models"), { operation: "onboarding.goTo" });
					await assertAccessDenied(a, deps, onboarding.dismiss(agent), { operation: "onboarding.dismiss" });
					await assertAccessDenied(a, deps, onboarding.reopen(agent), { operation: "onboarding.reopen" });
					a.deepEqual(await onboarding.get(agent), stored);
				}
			}),
		},
	);
	return cases;
}

export function registerOnboardingConformance(
	runner: ConformanceRunner,
	name: string,
	provider: OnboardingConformanceProvider,
	options?: ConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createOnboardingConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
		}),
	);
}
