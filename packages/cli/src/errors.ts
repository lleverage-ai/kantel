import type { KantelApiError, SandboxNotRunning } from "@kantel/api/sdk";

/** A failure the CLI reports as `kantel: <message>` on stderr, exiting with `exitCode` (1 unless said otherwise). */
export class CliError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}

/**
 * A host's own answer refusing an E2E call, with its code (`invalid` for a path outside the sandbox, `not_found` for one
 * that isn't there): not the session failing to open or dropping, which stay plain `CliError`s.
 */
export class HostAnswerError extends CliError {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "HostAnswerError";
		this.code = code;
	}
}

/** A usage mistake: a missing argument, an unknown flag, a bad value. Exits 2, with the command's usage line. */
export class UsageError extends CliError {
	constructor(message: string) {
		super(message, 2);
		this.name = "UsageError";
	}
}

/**
 * The `SandboxNotRunning` details of a `conflict` that refused a call because its sandbox isn't running (stopped,
 * paused, in error, or still starting once the call's wait ran out), or undefined for any other error.
 */
export function notRunningOf(error: KantelApiError): SandboxNotRunning | undefined {
	const details = error.details;
	if (error.code !== "conflict" || details === undefined) return undefined;
	const { code, sandboxId, state, hint } = details;
	if (typeof code !== "string" || !code.startsWith("sandbox_")) return undefined;
	if (typeof sandboxId !== "string" || typeof state !== "string" || typeof hint !== "string") return undefined;
	return details as unknown as SandboxNotRunning;
}
