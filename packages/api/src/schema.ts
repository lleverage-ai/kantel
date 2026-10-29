/**
 * The public API's wire shapes as JSON Schema (TypeBox), each mirroring a type in `@harbour/contracts`. A schema with a
 * `title` is a named type: a component in the OpenAPI document and a named type in the SDK. `test/types.test.ts`
 * checks at compile time that each schema's static type and its contract type match, so the two can't drift.
 */
import Type from "typebox";

const id = (description: string) => Type.String({ minLength: 1, description });

export const Timestamp = Type.Integer({ description: "Epoch milliseconds, UTC." });

export const SessionStatus = Type.Union(
	[
		Type.Literal("idle"),
		Type.Literal("running"),
		Type.Literal("waiting"),
		Type.Literal("done"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	],
	{ title: "SessionStatus" },
);

export const Labels = Type.Record(Type.String(), Type.String(), {
	title: "Labels",
	description: 'Host labels, such as `{ docketTask: "TASK-3347" }`.',
});

export const Actor = Type.Union(
	[
		Type.Object({ kind: Type.Literal("human"), userId: Type.String() }),
		Type.Object({ kind: Type.Literal("service"), serviceId: Type.String(), keyId: Type.Optional(Type.String()) }),
		Type.Object({ kind: Type.Literal("agent"), agentId: Type.String(), sessionId: Type.String() }),
		Type.Object({ kind: Type.Literal("system"), component: Type.String() }),
	],
	{ title: "Actor", description: "Who acted: a person, a host app's API key, an agent or Harbour itself." },
);

export const SessionRecord = Type.Object(
	{
		id: id("The session's ID."),
		organisationId: Type.String(),
		projectId: Type.String(),
		agentId: Type.String({ description: "The agent profile the session runs." }),
		parentSessionId: Type.Optional(Type.String()),
		workspaceId: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		status: SessionStatus,
		labels: Labels,
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "SessionRecord" },
);

export const CreateSessionBody = Type.Object(
	{
		projectId: id("The project the session runs in."),
		agentId: id("The agent profile it runs."),
		title: Type.Optional(Type.String()),
		labels: Type.Optional(Labels),
		workspaceId: Type.Optional(Type.String({ description: "An existing workspace to run in." })),
		parentSessionId: Type.Optional(
			Type.String({ description: "Creates a child session owned by this parent; aborting the parent aborts it." }),
		),
	},
	{ title: "CreateSessionBody" },
);

export const SessionPage = Type.Object(
	{
		items: Type.Array(SessionRecord),
		nextCursor: Type.Optional(Type.String({ description: "Present when more items follow." })),
	},
	{ title: "SessionPage" },
);

export const ListSessionsQuery = Type.Object(
	{
		projectId: Type.Optional(Type.String()),
		agentId: Type.Optional(Type.String()),
		status: Type.Optional(SessionStatus),
		parentSessionId: Type.Optional(Type.String()),
		label: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					"Sessions with every one of these labels, each sent as `label.<key>=<value>`, such as `label.docketTask=TASK-3347`.",
			}),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		cursor: Type.Optional(Type.String({ description: "A previous page's `nextCursor`." })),
	},
	{ title: "ListSessionsQuery" },
);

export const AbortSessionBody = Type.Object(
	{ reason: Type.Optional(Type.String({ description: "Recorded in the audit trail." })) },
	{ title: "AbortSessionBody" },
);

export const SessionPath = Type.Object({ sessionId: id("The session's ID.") });

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
	{ title: "ErrorBody", description: "Every error: the HarbourError's code and message." },
);
