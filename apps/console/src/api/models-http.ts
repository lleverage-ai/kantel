// The Models page's seam on a Kantel host: the model gateway's connectors and what each offers
// (`GET /v1/connectors?projectId=`), a test image (`POST /v1/connectors/:id/test-image`), and the agent profile whose
// image model the page sets (`GET` and `PUT /v1/profiles/:id`). Same-origin under /v1, like the session API: behind
// Cloudflare Access the browser's cookie signs each call in; signed in with an email code, `headers` adds the bearer.
//
// The server decides every call: listing needs viewer on the project, a test image admin, and saving the profile
// operator. The page shows what the server answers, including its refusals.

import type { AgentProfile, ConnectorModels, ModelChoice, ModelImagesResult } from "@kantel/contracts";

/** One model a picker offers for making images: the gateway ID a profile names, and where it comes from. */
export type ImageModelOption = {
	/** A route, or `<route>:<modelId>`: what `AgentProfile.imageModel` names. */
	readonly id: string;
	readonly choice: ModelChoice;
	readonly label: string;
	readonly connectorId: string;
};

export interface ConsoleModels {
	/** The connectors the person can see in the project, and their models. */
	connectors(projectId: string, signal?: AbortSignal): Promise<readonly ConnectorModels[]>;
	/** Makes one small image with a connector's model, recorded under the project. */
	testImage(
		connectorId: string,
		input: { readonly projectId: string; readonly modelId: string; readonly prompt?: string },
		signal?: AbortSignal,
	): Promise<ModelImagesResult>;
	profile(agentId: string, signal?: AbortSignal): Promise<AgentProfile>;
	saveProfile(profile: AgentProfile): Promise<AgentProfile>;
}

export interface ModelsApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
}

/** A refusal from the API, with its code and the message to show. */
export class ModelsApiError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ModelsApiError";
		this.code = code;
	}
}

export function apiModels(options: ModelsApiOptions = {}): ConsoleModels {
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
		const answer: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const error = (answer as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
			throw new ModelsApiError(
				typeof error?.code === "string" ? error.code : "unavailable",
				typeof error?.message === "string" ? error.message : `${response.status} ${response.statusText}`,
			);
		}
		return answer as T;
	};
	return {
		connectors: async (projectId, signal) =>
			(
				await call<{ items: readonly ConnectorModels[] }>(
					"GET",
					`/connectors?${new URLSearchParams({ projectId })}`,
					undefined,
					signal,
				)
			).items,
		testImage: (connectorId, input, signal) =>
			call<ModelImagesResult>("POST", `/connectors/${encodeURIComponent(connectorId)}/test-image`, input, signal),
		profile: (agentId, signal) =>
			call<AgentProfile>("GET", `/profiles/${encodeURIComponent(agentId)}`, undefined, signal),
		saveProfile: (profile) => call<AgentProfile>("PUT", `/profiles/${encodeURIComponent(profile.id)}`, profile),
	};
}

/** The gateway ID a choice names: its route, or `<route>:<modelId>`. */
export const choiceId = (choice: ModelChoice) =>
	choice.modelId === undefined ? choice.route : `${choice.route}:${choice.modelId}`;

/**
 * The image models a profile may name, from the connectors: each image model a route names, as that route, then each
 * other image model on a connector with a route, as `<route>:<model>` over the connector's first route. The gateway's
 * policy still decides at session start; a model it doesn't offer leaves the session without `generate_image`.
 */
export function imageModelOptions(connectors: readonly ConnectorModels[]): readonly ImageModelOption[] {
	const options: ImageModelOption[] = [];
	for (const connector of connectors) {
		const first = connector.routes[0];
		if (first === undefined) continue;
		for (const model of connector.models) {
			if (!model.output.includes("image")) continue;
			const named = connector.routes.find((route) => route.modelId === model.id);
			const choice: ModelChoice =
				named === undefined ? { route: first.name, modelId: model.id } : { route: named.name };
			options.push({
				id: choiceId(choice),
				choice,
				label: named === undefined ? `${model.name} (${connector.id})` : `${model.name} (route ${named.name})`,
				connectorId: connector.id,
			});
		}
	}
	return options;
}
