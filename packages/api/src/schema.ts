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

export const ErrorBody = Type.Object(
	{
		error: Type.Object({
			code: ErrorCode,
			message: Type.String(),
			details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
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
