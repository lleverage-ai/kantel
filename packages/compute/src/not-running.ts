/**
 * The `conflict` a call that needs a running sandbox (commands, files, ports, file URLs, archives) answers when the
 * sandbox isn't running, with a `SandboxNotRunning` in its details: a stable code, the state, why it stopped where that
 * was recorded, and what to do. A sandbox is never resumed for such a call: its auto-stop is a lifetime from its start,
 * not idleness, so a call reviving it would undo the stop its owner set.
 */
import type { computeSchema } from "@kantel/api";
import { KantelError } from "@kantel/contracts";

/** How long a call waits for a sandbox that is starting to run, before it answers `sandbox_starting`. */
export const START_HOLD_MS = 60_000;
/** How often a call waiting on a start reads the sandbox again, for a start another gateway is carrying out. */
export const START_POLL_MS = 250;

/** A timer as a promise, which `cancel` stops (the promise then never settles), so a finished wait leaves none behind. */
export function delay(ms: number): { readonly done: Promise<void>; cancel(): void } {
	let cancel = () => {};
	const done = new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		cancel = () => clearTimeout(timer);
	});
	return { done, cancel: () => cancel() };
}

const CODES: { readonly [state in computeSchema.SandboxState]?: computeSchema.SandboxNotRunningCode } = {
	starting: "sandbox_starting",
	stopping: "sandbox_stopping",
	stopped: "sandbox_stopped",
	paused: "sandbox_paused",
	error: "sandbox_error",
	deleting: "sandbox_deleting",
};

/** The parts of a sandbox the refusal reports. */
interface NotRunningSandbox {
	readonly id: string;
	readonly state: computeSchema.SandboxState;
	readonly reason?: string;
}

/**
 * The refusal for `sandbox`, not running. `apiBasePath` is where the API's routes are served (such as `/v1`), for the
 * resume call it names; `heldMs` is how long the call waited for a start that didn't finish.
 */
export function sandboxNotRunning(sandbox: NotRunningSandbox, apiBasePath: string, heldMs?: number): KantelError {
	const code = CODES[sandbox.state] ?? "sandbox_error";
	const resume = `kantel resume ${sandbox.id} or POST ${apiBasePath.replace(/\/+$/, "")}/sandboxes/${sandbox.id}/resume`;
	const why = sandbox.reason === undefined || sandbox.reason === "" ? "" : ` (${sandbox.reason.replace(/\.$/, "")})`;
	let message: string;
	let hint: string;
	switch (code) {
		case "sandbox_starting": {
			const waited =
				heldMs === undefined ? "" : ` after ${heldMs < 1000 ? `${heldMs} ms` : `${Math.round(heldMs / 1000)} seconds`}`;
			message = `The sandbox is still starting${waited}; send the call again`;
			hint = "It is still starting: send the call again in a moment";
			break;
		}
		case "sandbox_stopping":
			message = `The sandbox is stopping${why}; once it has stopped, resume it first`;
			hint = `Once it has stopped, resume it with ${resume}, then try again`;
			break;
		case "sandbox_deleting":
			message = "The sandbox is being deleted";
			hint = "It is being deleted: use another sandbox";
			break;
		default:
			message = `The sandbox is ${sandbox.state === "error" ? "in error" : sandbox.state}${why}; resume it first`;
			hint = `Resume it with ${resume}, then try again`;
	}
	const details: computeSchema.SandboxNotRunning = {
		code,
		sandboxId: sandbox.id,
		state: sandbox.state,
		...(sandbox.reason === undefined || code === "sandbox_starting" ? {} : { stopReason: sandbox.reason }),
		hint,
	};
	return new KantelError("conflict", message, { ...details });
}
