// Onboarding's seam on a Harbour host: the organisation's first-run progress over the public API's onboarding routes
// (`/v1/onboarding`, `@harbour/api`'s generated SDK). Same-origin under /v1, like the session API: behind Cloudflare
// Access the browser's cookie signs each call in; signed in with an email code, `headers` adds the session's bearer.
//
// The server decides every call (packages/onboarding/CONTRACT.md): anyone in the organisation reads it, and only an
// organisation-wide admin changes it. A refusal rejects with the server's own message, for the page to show.

import { createHarbourClient } from "@harbour/api/sdk";
import type { Onboarding, OnboardingStepId, OnboardingStepStatus } from "@harbour/contracts";

/** The organisation's onboarding as the signed-in person may read and change it. */
export interface ConsoleOnboarding {
	/** Where the organisation is: on a fresh install, `active` at `models` with every step pending. */
	get(signal?: AbortSignal): Promise<Onboarding>;
	/** Marks a step done, skipped or pending again; settling it moves on to the next pending step. */
	setStep(step: OnboardingStepId, status: OnboardingStepStatus): Promise<Onboarding>;
	/** Shows another step, such as Back, without changing any step's status. */
	goTo(step: OnboardingStepId): Promise<Onboarding>;
	/** Skips the whole onboarding: it isn't offered again until it is reopened. */
	dismiss(): Promise<Onboarding>;
	/** Offers it again, at `step` or the first step, keeping each step's status. */
	reopen(step?: OnboardingStepId): Promise<Onboarding>;
}

export interface OnboardingHttpOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
}

/** Onboarding on the gateway this console is served by (`source=api`). */
export function createOnboardingHttp(options: OnboardingHttpOptions = {}): ConsoleOnboarding {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const watched: typeof fetch = async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) options.onUnauthenticated?.();
		return response;
	};
	const api = createHarbourClient({
		baseUrl: options.baseUrl ?? "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	});
	return {
		get: async (signal) => (await api.getOnboarding(signal === undefined ? undefined : { signal })) as Onboarding,
		setStep: async (step, status) => (await api.setOnboardingStep(step, { status })) as Onboarding,
		goTo: async (step) => (await api.setOnboardingCurrent({ step })) as Onboarding,
		dismiss: async () => (await api.dismissOnboarding()) as Onboarding,
		reopen: async (step) => (await api.reopenOnboarding(step === undefined ? {} : { step })) as Onboarding,
	};
}
