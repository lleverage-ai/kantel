// The model providers' seam on a Kantel host: the organisation's connections to its own inference and its default
// model, for the console's first-run onboarding and the Models page (`/v1/model-providers`). Same-origin under /v1, like
// the session API: behind Cloudflare Access the browser's cookie signs each call in; signed in with an email code,
// `headers` adds the bearer.
//
// The server decides every call: reading needs a member of the organisation, testing, saving and removing a
// connection and setting the default an organisation admin (`ModelProvidersState.canManage`). A key goes out once, in
// a test or a save, and never comes back.

import type {
	ModelProviderConnection,
	ModelProviderDefault,
	ModelProviderInput,
	ModelProviderModel,
	ModelProviderModels,
	ModelProvidersState,
} from "@kantel/contracts";

/** A test of a connection's details: a saved connection's ID tests with its saved key when the input has none. */
export type ModelProviderTestInput = ModelProviderInput & { readonly connectionId?: string };

export interface ConsoleModelProviders {
	/** The organisation's connections, its default model and whether the person may change them. */
	state(signal?: AbortSignal): Promise<ModelProvidersState>;
	/** Connects with the details and lists the provider's models, saving nothing. */
	test(input: ModelProviderTestInput, signal?: AbortSignal): Promise<readonly ModelProviderModel[]>;
	/** Saves a connection under `id`, its key into the vault. */
	save(id: string, input: ModelProviderInput): Promise<ModelProviderConnection>;
	remove(id: string): Promise<void>;
	/** The models a saved connection lists now. */
	models(id: string, signal?: AbortSignal): Promise<readonly ModelProviderModel[]>;
	/** Sets the organisation's default model. */
	setDefault(input: { readonly connectionId: string; readonly modelId: string }): Promise<ModelProviderDefault>;
}

export interface ModelProvidersApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
}

/** A refusal from the API, with its code and the message to show. */
export class ModelProvidersApiError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ModelProvidersApiError";
		this.code = code;
	}
}

export function apiModelProviders(options: ModelProvidersApiOptions = {}): ConsoleModelProviders {
	const base = options.baseUrl ?? "/v1";
	const call = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
		const response = await (options.fetch ?? globalThis.fetch)(`${base}${path}`, {
			method,
			headers: {
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...options.headers?.(),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...(signal === undefined ? {} : { signal }),
		});
		if (response.status === 401) options.onUnauthenticated?.();
		// No content: nothing to read.
		const answer: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
		if (!response.ok) {
			const error = (answer as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
			throw new ModelProvidersApiError(
				typeof error?.code === "string" ? error.code : "unavailable",
				typeof error?.message === "string" ? error.message : `${response.status} ${response.statusText}`,
			);
		}
		return answer as T;
	};
	const connection = (id: string) => `/model-providers/connections/${encodeURIComponent(id)}`;
	return {
		state: (signal) => call<ModelProvidersState>("GET", "/model-providers", undefined, signal),
		test: async (input, signal) =>
			(await call<ModelProviderModels>("POST", "/model-providers/test", input, signal)).items,
		save: (id, input) => call<ModelProviderConnection>("PUT", connection(id), input),
		remove: async (id) => {
			await call<undefined>("DELETE", connection(id));
		},
		models: async (id, signal) =>
			(await call<ModelProviderModels>("GET", `${connection(id)}/models`, undefined, signal)).items,
		setDefault: (input) =>
			call<ModelProviderDefault>("PUT", "/model-providers/default", {
				connectionId: input.connectionId,
				modelId: input.modelId,
			}),
	};
}
