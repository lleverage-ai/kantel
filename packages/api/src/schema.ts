/**
 * The public API's shared wire shapes as JSON Schema (TypeBox), each mirroring a type in `@kantel/contracts`. A schema
 * with a `title` is a named type: a component in the OpenAPI document and a named type in the SDK. `test/types.test.ts`
 * checks at compile time that each schema's static type and its contract type match, so the two can't drift. The
 * compute plane's own shapes are in `compute-schema.ts`, and the environments' in `environments-schema.ts`.
 */
import Type from "typebox";

const id = (description: string) => Type.String({ minLength: 1, description });

export const Timestamp = Type.Integer({ description: "Epoch milliseconds, UTC." });

export const Actor = Type.Union(
	[
		Type.Object({ kind: Type.Literal("human"), userId: Type.String() }),
		Type.Object({ kind: Type.Literal("service"), serviceId: Type.String(), keyId: Type.Optional(Type.String()) }),
		Type.Object({ kind: Type.Literal("agent"), agentId: Type.String(), sessionId: Type.String() }),
		Type.Object({ kind: Type.Literal("system"), component: Type.String() }),
	],
	{ title: "Actor", description: "Who acted: a person, a host app's API key, an agent or Kantel itself." },
);

export const ErrorCode = Type.Union(
	[
		Type.Literal("invalid"),
		Type.Literal("not_found"),
		Type.Literal("forbidden"),
		Type.Literal("conflict"),
		Type.Literal("expired"),
		Type.Literal("refused"),
		Type.Literal("exhausted"),
		Type.Literal("aborted"),
		Type.Literal("not_supported"),
		Type.Literal("unavailable"),
		Type.Literal("unauthenticated"),
	],
	{ title: "ErrorCode" },
);

export const PlacementReason = Type.Union(
	[
		Type.Literal("no_host"),
		Type.Literal("no_host_for_type"),
		Type.Literal("no_host_with_labels"),
		Type.Literal("no_host_offers_size"),
		Type.Literal("no_host_enforces_egress"),
		Type.Literal("no_host_for_template"),
		Type.Literal("insufficient_capacity"),
		Type.Literal("host_unavailable"),
		Type.Literal("account_limit"),
	],
	{
		title: "PlacementReason",
		description:
			"Why a sandbox couldn't be placed on a host. `no_host`: no host it may use is connected. `no_host_for_type`: " +
			"none runs its type. `no_host_with_labels`: none has every label in `hostLabels`. `no_host_offers_size`: none " +
			"offers its size or can make its resources. `no_host_enforces_egress`: none that could take it enforces egress " +
			"grants or protected variables. `no_host_for_template`: none that could take it runs templates, or builds the " +
			"template's custom image. `insufficient_capacity`: hosts match but none has the memory or disk free now; " +
			"retry later. `host_unavailable`: the host its disk or snapshot is on can't take it now (offline, draining or " +
			"not one it may use, or gone during the boot). `account_limit`: the account runs as many sandboxes as it may.",
	},
);

export const ErrorBody = Type.Object(
	{
		error: Type.Object({
			code: ErrorCode,
			message: Type.String(),
			details: Type.Optional(
				Type.Object(
					{
						reason: Type.Optional(PlacementReason),
					},
					{
						additionalProperties: true,
						description:
							"More about the error, by code. A sandbox that can't be placed (on create, start, resume or fork) " +
							"has `reason`.",
					},
				),
			),
		}),
	},
	{ title: "ErrorBody", description: "Every error: the KantelError's code and message." },
);

export const Project = Type.Object(
	{
		id: id("The project's ID."),
		organisationId: Type.String({ description: "The organisation the project is in: always the caller's." }),
		name: Type.String(),
		createdAt: Timestamp,
	},
	{ title: "Project" },
);

// The length is `PROJECT_NAME_MAX_LENGTH` in `@kantel/contracts`; `test/types.test.ts` checks they agree.
export const CreateProjectBody = Type.Object(
	{
		name: Type.String({
			minLength: 1,
			maxLength: 100,
			description: "The project's name, trimmed: not empty, and at most 100 characters.",
		}),
	},
	{ title: "CreateProjectBody", description: "Any other field is refused as `invalid`." },
);

// Browsers (the embed API, packages/browser/CONTRACT.md).

export const BrowserSessionPath = Type.Object({
	sessionId: id("The session's ID."),
	browserSessionId: id("The browser session's ID, as the session's browser tool items name it."),
});

export const EmbedBrowserBody = Type.Object(
	{
		mode: Type.Union([Type.Literal("live"), Type.Literal("replay")], {
			description: "`live`: the open browser as it is now, watch-only. `replay`: its recording.",
		}),
		minutes: Type.Optional(
			Type.Integer({ minimum: 5, maximum: 60, description: "How long the link lasts. Default 15." }),
		),
	},
	{ title: "EmbedBrowserBody" },
);

export const BrowserEmbed = Type.Object(
	{
		url: Type.String({
			description:
				"The page to frame. It holds its token after `#`, so the token reaches no server; treat the URL as a secret.",
		}),
		mode: Type.Union([Type.Literal("live"), Type.Literal("replay")]),
		expiresAt: Type.Optional(Timestamp),
		endMessage: Type.Optional(
			Type.String({ description: "What the page posts to its parent once its stream is over." }),
		),
	},
	{ title: "BrowserEmbed" },
);
