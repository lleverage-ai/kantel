/**
 * The model providers API's routes (docs/site/src/content/docs/api/model-providers.md): an organisation connecting its
 * own inference, as the console's first-run onboarding and its Models page do. A connection is an organisation model
 * connector on CLI Proxy API, LiteLLM, Cloudflare AI Gateway or OpenRouter, its key in the organisation's vault; the
 * default model is the organisation's `default` route. The self-hosted gateway serves them where it has a vault.
 */
import {
	ModelProviderConnection,
	ModelProviderConnectionPath,
	ModelProviderDefault,
	ModelProviderInput,
	ModelProviderModels,
	ModelProvidersState,
	SetModelProviderDefaultBody,
	TestModelProviderBody,
} from "./model-providers-schema.ts";
import { defineRoute } from "./route.ts";

const tag = "model-providers";
const ADMIN = "Needs admin on the organisation.";

export const getModelProviders = defineRoute({
	operationId: "getModelProviders",
	method: "GET",
	path: "/model-providers",
	tag,
	summary: "Get the organisation's model providers",
	description:
		"Whether sessions have a model to call, whether the caller may change that, the organisation's connections and " +
		"its default model. Anyone in the organisation may ask; only its viewers see the connections.",
	answer: { status: 200, description: "The state.", schema: ModelProvidersState },
	errors: ["forbidden"],
});

export const testModelProvider = defineRoute({
	operationId: "testModelProvider",
	method: "POST",
	path: "/model-providers/test",
	tag,
	summary: "Test a connection",
	description:
		"Reads the provider's model list with the key (or a saved connection's, with `connectionId`) and answers the " +
		"models. The provider refusing the key is `refused`; one that can't be reached or answers badly is " +
		`\`unavailable\`. Saves nothing. ${ADMIN}`,
	body: TestModelProviderBody,
	answer: { status: 200, description: "The models the provider lists.", schema: ModelProviderModels },
	errors: ["invalid", "forbidden", "not_found", "refused", "unavailable"],
});

export const putModelProviderConnection = defineRoute({
	operationId: "putModelProviderConnection",
	method: "PUT",
	path: "/model-providers/connections/{connectionId}",
	tag,
	summary: "Save a connection",
	description:
		"Makes or changes the connection: its key into the organisation's vault, bound to the provider's host, and an " +
		`organisation model connector on the gateway. The answer never carries the key. ${ADMIN}`,
	params: ModelProviderConnectionPath,
	body: ModelProviderInput,
	answer: { status: 200, description: "The connection.", schema: ModelProviderConnection },
	errors: ["invalid", "forbidden", "unavailable"],
});

export const deleteModelProviderConnection = defineRoute({
	operationId: "deleteModelProviderConnection",
	method: "DELETE",
	path: "/model-providers/connections/{connectionId}",
	tag,
	summary: "Remove a connection",
	description:
		"Removes the connection and its connector, and the default model if it was on it. The deployment's default, if " +
		"any, applies again; without one, sessions on the `assistant` profile fail with `no_model` until another default " +
		`is chosen. The key's vault item is kept. ${ADMIN}`,
	params: ModelProviderConnectionPath,
	answer: { status: 204, description: "Removed." },
	errors: ["forbidden", "not_found"],
});

export const listModelProviderModels = defineRoute({
	operationId: "listModelProviderModels",
	method: "GET",
	path: "/model-providers/connections/{connectionId}/models",
	tag,
	summary: "List a connection's models",
	description: `Reads the provider's model list with the saved key. ${ADMIN}`,
	params: ModelProviderConnectionPath,
	answer: { status: 200, description: "The models the provider lists.", schema: ModelProviderModels },
	errors: ["forbidden", "not_found", "refused", "unavailable"],
});

export const setModelProviderDefault = defineRoute({
	operationId: "setModelProviderDefault",
	method: "PUT",
	path: "/model-providers/default",
	tag,
	summary: "Choose the default model",
	description:
		"Makes the model the organisation's `default` route, which the `assistant` profile names, so a new session uses " +
		`it. ${ADMIN}`,
	body: SetModelProviderDefaultBody,
	answer: { status: 200, description: "The default model.", schema: ModelProviderDefault },
	errors: ["invalid", "forbidden", "not_found"],
});

export const modelProviderRoutes = {
	getModelProviders,
	testModelProvider,
	putModelProviderConnection,
	deleteModelProviderConnection,
	listModelProviderModels,
	setModelProviderDefault,
} as const;
