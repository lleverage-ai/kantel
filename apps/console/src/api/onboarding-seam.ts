// The onboarding page's calls in the console: the organisation's onboarding (`onboarding-http.ts`), its model
// providers (`model-providers-http.ts`), the Connections API for the connectors step, and the console's own session
// client for the first session. Each one is a public API route, so a host app can make the same calls.

import { createHarbourClient } from "@harbour/api/sdk";
import type {
	CatalogueEntry,
	ConnectAttempt,
	Connection,
	ConnectionOwner,
	HeldRole,
	MeResponse,
} from "@harbour/contracts";
import type { OnboardingApi, OnboardingConnectionsApi } from "@harbour/ui";
import { handOver } from "../app/first-message.ts";
import { titleFrom } from "../ui/actions.ts";
import type { ConsoleClient } from "./client.ts";
import type { ConsoleModelProviders } from "./model-providers-http.ts";
import { createModelProvidersHttp } from "./model-providers-http.ts";
import type { ConsoleOnboarding } from "./onboarding-http.ts";
import { createOnboardingHttp } from "./onboarding-http.ts";

/** What the console needs to offer onboarding: its seams, and whether the person may change it. */
export interface ConsoleOnboardingSeam {
	readonly state: ConsoleOnboarding;
	readonly providers: ConsoleModelProviders;
	/** The connectors step's calls; the page says when the deployment doesn't serve them. */
	readonly connections?: OnboardingConnectionsApi;
	/** An organisation-wide admin: only they change the setup, as the server checks too. */
	readonly canChange: boolean;
}

/** Whether `roles` (as `GET /v1/me` lists them) hold admin across the organisation. */
export const organisationAdmin = (roles: readonly HeldRole[] | undefined): boolean =>
	roles?.some((held) => held.projectId === undefined && held.role === "admin") ?? false;

export interface OnboardingSeamOptions {
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly onUnauthenticated?: () => void;
	readonly fetch?: typeof fetch;
}

/** The Connections API's calls, for connections the signed-in person owns. */
export function connectionsForOnboarding(
	owner: ConnectionOwner,
	options: OnboardingSeamOptions = {},
): OnboardingConnectionsApi {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const watched: typeof fetch = async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) options.onUnauthenticated?.();
		return response;
	};
	const api = createHarbourClient({
		baseUrl: "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	});
	return {
		catalogue: async () => (await api.listCatalogue({ limit: 100 })).items as readonly CatalogueEntry[],
		connections: async () => (await api.listConnections({ limit: 100 })).items as readonly Connection[],
		// No `returnTo`: the provider's tab ends on the callback's result page, as from the Connections page, while the
		// onboarding page polls the attempt.
		connect: async (templateId) => (await api.startConnect({ templateId, owner })) as ConnectAttempt,
		attempt: async (attemptId) => (await api.getConnectAttempt(attemptId)) as ConnectAttempt,
		connectKey: async (templateId, value) => (await api.connectKey({ templateId, owner, value })) as Connection,
	};
}

/** The seam for the signed-in person, from what `GET /v1/me` said. */
export function apiOnboarding(
	me: Pick<MeResponse, "actor" | "organisationId" | "roles">,
	options: OnboardingSeamOptions = {},
): ConsoleOnboardingSeam {
	const http = {
		...(options.headers === undefined ? {} : { headers: options.headers }),
		...(options.onUnauthenticated === undefined ? {} : { onUnauthenticated: options.onUnauthenticated }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	};
	const owner: ConnectionOwner | undefined =
		me.actor.kind === "human"
			? { kind: "user", organisationId: me.organisationId, userId: me.actor.userId }
			: undefined;
	return {
		state: createOnboardingHttp(http),
		providers: createModelProvidersHttp(http),
		...(owner === undefined ? {} : { connections: connectionsForOnboarding(owner, options) }),
		canChange: me.actor.kind === "human" && organisationAdmin(me.roles),
	};
}

/**
 * The page's calls: the seam's, and the first session through the console's own client, as New session starts one.
 * With `reopen`, a completed or dismissed onboarding is offered again when the page reads it: the person came to it
 * on purpose, from the sidebar.
 */
export function onboardingApi(seam: ConsoleOnboardingSeam, client: ConsoleClient, reopen: boolean): OnboardingApi {
	const { state, providers } = seam;
	return {
		get: async () => {
			const found = await state.get();
			return reopen && seam.canChange && found.status !== "active" ? state.reopen() : found;
		},
		setStep: (step, status) => state.setStep(step, status),
		goTo: (step) => state.goTo(step),
		dismiss: () => state.dismiss(),
		modelProviders: () => providers.list(),
		connectModelKey: (providerId, input) => providers.connectKey(providerId, input),
		startSignIn: (providerId) => providers.startSignIn(providerId),
		signInStatus: (providerId, signInId) => providers.signInStatus(providerId, signInId),
		finishSignIn: (providerId, signInId, redirectUrl) => providers.finishSignIn(providerId, signInId, redirectUrl),
		disconnectModel: (providerId) => providers.disconnect(providerId),
		...(seam.connections === undefined ? {} : { connections: seam.connections }),
		startSession: async ({ projectId, text }) => {
			const options = await client.startOptions(projectId);
			const title = titleFrom(text);
			const sessionId = await client.create({
				projectId,
				agentId: options.agentId,
				...(title === undefined ? {} : { title }),
			});
			handOver(sessionId, { text, choice: {} });
			return { sessionId };
		},
	};
}
