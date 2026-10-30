// What the onboarding page calls. Every method is one public API route (@harbour/api): the console binds them to its
// SDK, a story to a fixture. Nothing here is onboarding's own path: a host app or a packaged agent makes the same calls
// to do the same steps headless.

import type {
	CatalogueEntry,
	ConnectAttempt,
	Connection,
	ConnectModelKeyInput,
	ModelProvider,
	ModelProviderId,
	ModelProviderList,
	ModelSignIn,
	Onboarding,
	OnboardingStepId,
	OnboardingStepStatus,
} from "@harbour/contracts";

/** The connectors step's calls: the Connections API (`/v1/connections/...`). */
export interface OnboardingConnectionsApi {
	/** `GET /connections/catalogue`. */
	catalogue(): Promise<readonly CatalogueEntry[]>;
	/** `GET /connections`: the caller's, to mark what is already connected. */
	connections(): Promise<readonly Connection[]>;
	/** `POST /connections/connect` for a template, owned by the person setting up. */
	connect(templateId: string): Promise<ConnectAttempt>;
	/** `GET /connections/connect/{attemptId}`. */
	attempt(attemptId: string): Promise<ConnectAttempt>;
	/** `POST /connections/keys` for a template with a key. The key is write-only. */
	connectKey(templateId: string, value: string): Promise<Connection>;
}

export interface OnboardingApi {
	/** `GET /onboarding`. */
	get(): Promise<Onboarding>;
	/** `PUT /onboarding/steps/{step}`. */
	setStep(step: OnboardingStepId, status: OnboardingStepStatus): Promise<Onboarding>;
	/** `PUT /onboarding/current`. */
	goTo(step: OnboardingStepId): Promise<Onboarding>;
	/** `POST /onboarding/dismiss`. */
	dismiss(): Promise<Onboarding>;

	/** `GET /model-providers`. */
	modelProviders(): Promise<ModelProviderList>;
	/** `PUT /model-providers/{providerId}/key`. */
	connectModelKey(providerId: ModelProviderId, input: ConnectModelKeyInput): Promise<ModelProvider>;
	/** `POST /model-providers/{providerId}/sign-ins`. */
	startSignIn(providerId: ModelProviderId): Promise<ModelSignIn>;
	/** `GET /model-providers/{providerId}/sign-ins/{signInId}`. */
	signInStatus(providerId: ModelProviderId, signInId: string): Promise<ModelSignIn>;
	/** `POST /model-providers/{providerId}/sign-ins/{signInId}/finish`. */
	finishSignIn(providerId: ModelProviderId, signInId: string, redirectUrl: string): Promise<ModelSignIn>;
	/** `DELETE /model-providers/{providerId}`. */
	disconnectModel(providerId: ModelProviderId): Promise<void>;

	/** The connectors step's calls; absent where the deployment serves no Connections API yet. */
	readonly connections?: OnboardingConnectionsApi;

	/** `POST /sessions` with the first message, in a project. Resolves the new session. */
	startSession(input: { readonly projectId: string; readonly text: string }): Promise<{ readonly sessionId: string }>;
}

/** A project the first session can start in. */
export interface OnboardingProject {
	readonly id: string;
	readonly name: string;
}

/** How a step's request failed, as a sentence to show. */
export const problemOf = (reason: unknown): string =>
	reason instanceof Error && reason.message !== "" ? reason.message : "Something went wrong. Try again.";
