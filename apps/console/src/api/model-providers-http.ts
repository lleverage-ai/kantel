// Model providers' seam on a Harbour host: an organisation's keys and subscriptions over the public API's model
// provider routes (`/v1/model-providers`, `@harbour/api`'s generated SDK), as onboarding-http.ts does for onboarding.
//
// The server decides every call (packages/models/CONTRACT.md): the organisation reads the list, and only an
// organisation-wide admin connects, signs in or disconnects. A key is sent once and never comes back.

import { createHarbourClient } from "@harbour/api/sdk";
import type {
	ConnectModelKeyInput,
	ModelProvider,
	ModelProviderId,
	ModelProviderList,
	ModelSignIn,
} from "@harbour/contracts";

export interface ConsoleModelProviders {
	list(signal?: AbortSignal): Promise<ModelProviderList>;
	connectKey(providerId: ModelProviderId, input: ConnectModelKeyInput): Promise<ModelProvider>;
	startSignIn(providerId: ModelProviderId): Promise<ModelSignIn>;
	signInStatus(providerId: ModelProviderId, signInId: string): Promise<ModelSignIn>;
	finishSignIn(providerId: ModelProviderId, signInId: string, redirectUrl: string): Promise<ModelSignIn>;
	disconnect(providerId: ModelProviderId): Promise<void>;
}

export interface ModelProvidersHttpOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
}

/** Model providers on the gateway this console is served by (`source=api`). */
export function createModelProvidersHttp(options: ModelProvidersHttpOptions = {}): ConsoleModelProviders {
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
		list: async (signal) =>
			(await api.listModelProviders(signal === undefined ? undefined : { signal })) as ModelProviderList,
		connectKey: async (providerId, input) =>
			(await api.connectModelProviderKey(providerId, input)) as ModelProvider,
		startSignIn: async (providerId) => (await api.startModelSignIn(providerId)) as ModelSignIn,
		signInStatus: async (providerId, signInId) => (await api.getModelSignIn(providerId, signInId)) as ModelSignIn,
		finishSignIn: async (providerId, signInId, redirectUrl) =>
			(await api.finishModelSignIn(providerId, signInId, { redirectUrl })) as ModelSignIn,
		disconnect: (providerId) => api.disconnectModelProvider(providerId),
	};
}
