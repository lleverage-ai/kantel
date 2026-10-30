import type { CallContext } from "@harbour/contracts";
import { createMemoryOnboarding } from "@harbour/onboarding/memory";
import { registerOnboardingConformance } from "@harbour/testing/onboarding";
import { describe, expect, it } from "vitest";

registerOnboardingConformance(
	{ describe, expect, it },
	"in-memory onboarding",
	async (deps, use) => {
		await use({ onboarding: createMemoryOnboarding({ access: deps.access, audit: deps.audit, clock: deps.clock }) });
	},
	{ projectAccess: true },
);

// Without `access`, the base cases still hold: anyone in the organisation but an agent may change it.
registerOnboardingConformance({ describe, expect, it }, "in-memory onboarding without access", async (deps, use) => {
	await use({ onboarding: createMemoryOnboarding({ audit: deps.audit, clock: deps.clock }) });
});

describe("onboarding without access", () => {
	const ORG = "org-open";
	const person: CallContext = { actor: { kind: "human", userId: "someone" }, organisationId: ORG };
	const agent: CallContext = { actor: { kind: "agent", agentId: "a", sessionId: "s" }, organisationId: ORG };

	it("lets a person change it and refuses an agent, who may still read it", async () => {
		const onboarding = createMemoryOnboarding();
		await onboarding.setStep(person, "models", "done");
		await expect(onboarding.setStep(agent, "connectors", "done")).rejects.toMatchObject({ code: "forbidden" });
		await expect(onboarding.goTo(agent, "models")).rejects.toMatchObject({ code: "forbidden" });
		await expect(onboarding.dismiss(agent)).rejects.toMatchObject({ code: "forbidden" });
		await expect(onboarding.reopen(agent)).rejects.toMatchObject({ code: "forbidden" });
		expect(await onboarding.get(agent)).toMatchObject({ status: "active", current: "connectors" });
	});
});
