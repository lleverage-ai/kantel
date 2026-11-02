/**
 * The model providers API's wire shapes (docs/site/src/content/docs/api/model-providers.md), each mirroring a type in
 * `@kantel/contracts`'s `model-providers.ts`. `test/types.test.ts` checks that each matches its contract type. No
 * answer carries a provider's key or any part of it: the key is write-only, and goes into the organisation's vault.
 */
import Type from "typebox";

/** When, as ISO 8601. */
const Timestamp = Type.String({ format: "date-time", description: "ISO 8601, UTC." });

export const ModelProvider = Type.Union(
	[
		Type.Literal("cliproxyapi"),
		Type.Literal("litellm"),
		Type.Literal("cloudflare-ai-gateway"),
		Type.Literal("openrouter"),
	],
	{
		title: "ModelProvider",
		description:
			"The upstream: CLIProxyAPI, a LiteLLM proxy, Cloudflare AI Gateway or OpenRouter. Each speaks OpenAI's API " +
			"and lists its models.",
	},
);

const ConnectionId = Type.String({
	pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
	description: "The connection's ID, which is its model connector's: lowercase letters, digits and dashes.",
});

const inputProperties = {
	provider: ModelProvider,
	baseUrl: Type.Optional(
		Type.String({
			description:
				"For CLI Proxy API and LiteLLM: the OpenAI-compatible base URL, such as `http://host.docker.internal:4000/v1`. " +
				"`http` or `https`, with no credentials. OpenRouter's is fixed; Cloudflare's is built from the IDs.",
		}),
	),
	accountId: Type.Optional(Type.String({ description: "For Cloudflare AI Gateway: the Cloudflare account ID." })),
	gatewayId: Type.Optional(
		Type.String({ description: "For Cloudflare AI Gateway: the gateway's ID. Default `default`." }),
	),
	apiKey: Type.Optional(
		Type.String({
			description:
				"The provider's key. Write-only: it goes into the organisation's vault and no answer carries it. Required to " +
				"make a connection; leave it out to keep a saved connection's key while its host is unchanged.",
		}),
	),
};

export const ModelProviderInput = Type.Object(inputProperties, {
	title: "ModelProviderInput",
	description: "A connection to make or change.",
});

export const TestModelProviderBody = Type.Object(
	{
		...inputProperties,
		connectionId: Type.Optional(
			Type.String({ description: "A saved connection whose key to test with, when `apiKey` is left out." }),
		),
	},
	{ title: "TestModelProviderBody", description: "A connection to test, before or after it is saved." },
);

export const ModelProviderConnection = Type.Object(
	{
		id: Type.String({ description: "The connection's ID, which is its model connector's, such as `openrouter`." }),
		provider: ModelProvider,
		baseUrl: Type.String(),
		accountId: Type.Optional(Type.String()),
		gatewayId: Type.Optional(Type.String()),
		vaultItemId: Type.String({ description: "The vault item that holds the key. Never the key." }),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "ModelProviderConnection", description: "A saved connection: never its key." },
);

export const ModelProviderModel = Type.Object(
	{
		id: Type.String({ description: "The provider's model ID, such as `openai/gpt-5`." }),
		name: Type.Optional(Type.String()),
		contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ title: "ModelProviderModel", description: "One model the provider lists." },
);

export const ModelProviderModels = Type.Object(
	{ items: Type.Array(ModelProviderModel) },
	{ title: "ModelProviderModels", description: "The models the provider lists, by ID." },
);

export const ModelProviderDefault = Type.Object(
	{
		connectionId: Type.String(),
		modelId: Type.String(),
		updatedAt: Type.Optional(Timestamp),
	},
	{
		title: "ModelProviderDefault",
		description: "The organisation's default model: its `default` route, which the `assistant` profile names.",
	},
);

export const SetModelProviderDefaultBody = Type.Object(
	{
		connectionId: Type.String({ description: "A saved connection." }),
		modelId: Type.String({ description: "One of the models it lists. No `:`, which names a thinking level." }),
	},
	{ title: "SetModelProviderDefaultBody" },
);

export const ModelProvidersState = Type.Object(
	{
		configured: Type.Boolean({
			description: "Whether sessions have a model to call: the organisation's default, or one the deployment set.",
		}),
		canManage: Type.Boolean({
			description: "Whether the caller may change connections and the default: an organisation admin.",
		}),
		connections: Type.Array(ModelProviderConnection, {
			description: "The organisation's connections; empty for a caller who isn't an organisation viewer.",
		}),
		default: Type.Optional(ModelProviderDefault),
		platformDefault: Type.Optional(
			Type.Object(
				{ connectorId: Type.String(), modelId: Type.String() },
				{ description: "A default the deployment set, which the organisation's replaces." },
			),
		),
	},
	{ title: "ModelProvidersState" },
);

export const ModelProviderConnectionPath = Type.Object({ connectionId: ConnectionId });
