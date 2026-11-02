/**
 * `bash` with an `env` argument: without it, the session's own `bash` (its sandbox, tiers 1 and 2) exactly as before;
 * with it, the command runs on the environment the session calls that name, in the session's own worktree there,
 * through the broker. `read`, `write` and `edit` are unchanged: they stay on the session's workspace.
 *
 * The model sees only aliases and their one-line descriptions, never a provider, a machine or an address. The result
 * has the same shape as `bash`'s own: the retained tail of the output, an error result with the exit code for a
 * nonzero exit, and a thrown error for a timeout.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { isKantelError } from "@kantel/contracts";
import type { EnvironmentBroker, EnvironmentSession } from "./broker.ts";

/** What `env` says to the model. */
export const ENV_ARGUMENT_DESCRIPTION =
	"Run the command on one of your environments instead of your own sandbox, by its name (such as dev). An environment is a long-lived machine with Docker that your project's sessions share; you get your own worktree on it, with COMPOSE_PROJECT_NAME and KANTEL_PORT_BASE set for you. Files you read, write or edit with the other tools stay in your own workspace, not on the environment. Leave it out for your own sandbox.";

const bashWithEnvSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	env: Type.Optional(Type.String({ description: ENV_ARGUMENT_DESCRIPTION })),
});

const structuredOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr: the retained tail, as the model sees it" }),
	truncated: Type.Boolean({ description: "Whether earlier output was dropped" }),
	fullOutputPath: Type.Optional(Type.String({ description: "File with the complete output, when it was spilled" })),
	exitCode: Type.Number(),
});

export interface EnvironmentBashOptions {
	/** The session's own `bash`, which a call without `env` goes to. */
	readonly base: ToolRegistration;
	/** The broker; asked at each call, so it may be built after the runtime. */
	readonly broker: () => EnvironmentBroker;
	readonly session: EnvironmentSession;
}

/** `bash` for one session, with `env`. Keeps the base tool's execution mode, so it stays a barrier in its round. */
export function environmentBashTool(options: EnvironmentBashOptions): ToolRegistration {
	const { base } = options;
	const tool = defineTool({
		name: "bash",
		description: `${base.description} Optionally give env to run it on one of your environments.`,
		parameters: bashWithEnvSchema,
		structuredOutputSchema,
		outputLimits: { retain: "tail" },
		async execute(args, api, context) {
			if (args.env === undefined || args.env.trim() === "") {
				const { env: _, ...rest } = args;
				return base.execute(rest, api, context);
			}
			if (args.timeout !== undefined && (!Number.isFinite(args.timeout) || args.timeout <= 0)) {
				throw new Error("Invalid timeout: must be a finite number of seconds");
			}
			let result: Awaited<ReturnType<EnvironmentBroker["exec"]>>;
			try {
				result = await options.broker().exec(options.session, args.env.trim().toLowerCase(), {
					command: args.command,
					...(args.timeout === undefined ? {} : { timeoutMs: args.timeout * 1000 }),
					...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
					onOutput: (_stream, chunk) => api.output(chunk),
				});
			} catch (error) {
				// The broker's refusals are for the model to read; anything else is a failure of the tool.
				if (isKantelError(error)) throw new Error(error.message);
				throw error;
			}
			if (result.timedOut) throw new Error(`Command timed out after ${args.timeout ?? "its"} seconds`);
			const retained = api.retainedOutput();
			const exitCode = result.exitCode ?? 1;
			const structuredOutput = { output: retained.text, truncated: retained.truncated, exitCode };
			if (exitCode === 0) return { structuredOutput };
			return {
				structuredOutput,
				isError: true,
				diagnostics: [{ severity: "error", code: "exit_code", message: `Command exited with code ${exitCode}` }],
			};
		},
	});
	return base.executionMode === undefined ? tool : { ...tool, executionMode: base.executionMode };
}
