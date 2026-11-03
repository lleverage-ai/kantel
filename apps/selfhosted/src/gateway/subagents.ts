// Subagents on the gateway (`@kantel/subagents`): the `subagent` tool hands a task to a child session of the same agent,
// on the parent's workspace, and answers with the child's final answer. The same tool as Cloudflare's stack, on this
// gateway's runtime. On unless KANTEL_SUBAGENTS says otherwise (`off`, or anything but `on`): a local install has them
// from its first start.
import type { SessionRuntime } from "@kantel/contracts";
import type { SessionRuntimeOptions } from "@kantel/runtime/core";
import { subagentsEnabled, withSubagentTool } from "@kantel/subagents";

/** Whether the gateway's sessions get the `subagent` tool: on unless KANTEL_SUBAGENTS is set to anything but `on`. */
export function subagentsConfig(env: NodeJS.ProcessEnv = process.env): boolean {
	return subagentsEnabled({ KANTEL_SUBAGENTS: env.KANTEL_SUBAGENTS }, true);
}

/** What `/v1/deployment` says of subagents. */
export const subagentsBinding = (on: boolean): string => (on ? "on" : "off");

/**
 * The runtime's tools with `subagent` after them when `on`. The runtime is built after its tools, so it is asked for at
 * call time: `runtime()` throws until it is set.
 */
export function withGatewaySubagents(
	tools: SessionRuntimeOptions["tools"],
	on: boolean,
	runtime: () => SessionRuntime,
): SessionRuntimeOptions["tools"] {
	return on ? withSubagentTool(tools, runtime) : tools;
}

/** A runtime set once it's built, for the tools made before it (`withGatewaySubagents`). */
export function lateRuntime(): { get: () => SessionRuntime; set(runtime: SessionRuntime): void } {
	let built: SessionRuntime | undefined;
	return {
		get: () => {
			if (built === undefined) throw new Error("the session runtime is not ready");
			return built;
		},
		set: (runtime) => {
			built = runtime;
		},
	};
}
