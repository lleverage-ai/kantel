/**
 * How a run ended, for the result route: what a host app polls to learn that the message it sent has been answered,
 * without holding the session's stream open. Separate from `schema.ts` because it carries `@harbour/protocol`'s
 * `Usage`, whose schema (`protocol-schema.ts`) builds on `schema.ts`.
 */
import Type from "typebox";
import { Usage } from "./protocol-schema.ts";

export const RunResult = Type.Object(
	{
		sessionId: Type.String(),
		submissionId: Type.String({ description: "The submission the message was answered as (`Submission.id`)." }),
		status: Type.Union([Type.Literal("answered"), Type.Literal("failed"), Type.Literal("aborted")], {
			description:
				"`answered`: the run reached its final answer; `failed`: a model or tool error ended it (`error` says " +
				"which); `aborted`: someone aborted the session's run. Files it changed stay changed.",
		}),
		answer: Type.Optional(Type.String({ description: "The final answer's text, when it was answered." })),
		error: Type.Optional(Type.String()),
		usage: Type.Optional(Usage),
	},
	{ title: "RunResult", description: "How the run a message started or joined ended." },
);

export const PendingRun = Type.Object(
	{
		status: Type.Literal("pending"),
		sessionId: Type.String(),
		submissionId: Type.String(),
	},
	{ title: "PendingRun", description: "The run is still going (or queued): ask again." },
);

export const RunResultQuery = Type.Object(
	{
		submission: Type.String({
			minLength: 1,
			description: "The submission's ID, as `sendMessage` answered it. It holds a `/`, so it goes in the query.",
		}),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"How long to wait, in milliseconds, for the run to end before answering 202 (`pending`). Default 25 s, cut " +
					"to the server's most (120 s).",
			}),
		),
	},
	{ title: "RunResultQuery" },
);
