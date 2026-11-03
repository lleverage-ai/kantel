/** A failure the CLI reports as `kantel: <message>` on stderr, exiting with `exitCode` (1 unless said otherwise). */
export class CliError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}

/** A usage mistake: a missing argument, an unknown flag, a bad value. Exits 2, with the command's usage line. */
export class UsageError extends CliError {
	constructor(message: string) {
		super(message, 2);
		this.name = "UsageError";
	}
}
