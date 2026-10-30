/** The reference `OnboardingService`: one state per organisation in a map, every rule in `createOnboarding`. */
import type { Onboarding, OnboardingService, OrganisationId } from "@harbour/contracts";
import { createOnboarding, type OnboardingOptions, type OnboardingStore } from "./index.ts";

export function createMemoryOnboardingStore(): OnboardingStore {
	const states = new Map<OrganisationId, Onboarding>();
	return {
		async get(organisationId) {
			return states.get(organisationId);
		},
		async save(onboarding) {
			states.set(onboarding.organisationId, onboarding);
		},
	};
}

export function createMemoryOnboarding(options: Omit<OnboardingOptions, "store"> = {}): OnboardingService {
	return createOnboarding({ ...options, store: createMemoryOnboardingStore() });
}
