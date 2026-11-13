/**
 * Runs a command, `wrangler deploy` in the deploy (.github/workflows/cloudflare-deploy.yml), and runs it again when it
 * failed only because Cloudflare's container registry timed out or dropped the connection while an image was pushed,
 * as `net/http: timeout awaiting response headers` on a blob upload to registry.cloudflare.com. Any other failure, a
 * build error or a refused deploy, ends it at once with the command's own exit code.
 *
 * Running `wrangler deploy` again is safe: it builds the same images from Docker's cache, and the registry keeps every
 * layer the failed push finished by its digest (`Layer already exists`), so only the rest are sent. Wrangler uploads the
 * Worker before it pushes the images, so each attempt makes a version of it again (and resets its Durable Objects
 * again); the failed attempt has done that already, and without a retry the containers and routes stay behind it.
 *
 * Usage:
 *   node scripts/retry-registry.ts [--attempts 3] [--delay 20] -- <command> [args...]
 *     --attempts  how many times to run the command at most
 *     --delay     seconds to wait before the second attempt, doubling before each after it
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The registry's host: a network failure counts only on a line that names it. */
export const REGISTRY_HOST = "registry.cloudflare.com";

/** The network failures Docker reports from a push that was cut off, rather than refused. */
export const NETWORK_FAILURES: readonly string[] = [
	"timeout awaiting response headers",
	"TLS handshake timeout",
	"i/o timeout",
	"Client.Timeout exceeded",
	"context deadline exceeded",
	"connection reset by peer",
];

/** How much of the command's latest output is kept to look for the failure in. */
const KEPT = 64 * 1024;

/** Whether `output` shows the registry timing out or dropping the connection, on one line that names it. */
export function isRegistryNetworkFailure(output: string): boolean {
	return output
		.split("\n")
		.some((line) => line.includes(REGISTRY_HOST) && NETWORK_FAILURES.some((failure) => line.includes(failure)));
}

/** How one attempt ended: its exit code, and whether a registry network failure was in its output. */
export interface Attempt {
	readonly code: number;
	readonly registryFailure: boolean;
}

/** Runs `command` once, passing its output through and watching it for a registry network failure. */
export function attempt(command: string, args: readonly string[]): Promise<Attempt> {
	return new Promise((done) => {
		const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
		let registryFailure = false;
		// Each stream is read on its own, so a line from one never runs into a line from the other.
		const watch = (from: NodeJS.ReadableStream, to: NodeJS.WriteStream) => {
			let tail = "";
			from.setEncoding("utf8");
			from.on("data", (chunk: string) => {
				to.write(chunk);
				tail = (tail + chunk).slice(-KEPT);
				if (!registryFailure && isRegistryNetworkFailure(tail)) registryFailure = true;
			});
		};
		watch(child.stdout, process.stdout);
		watch(child.stderr, process.stderr);
		child.on("error", (error) => {
			console.error(`${command} didn't start: ${error.message}`);
			done({ code: 127, registryFailure: false });
		});
		// A command ended by a signal was stopped, not failed by the registry: exit 1 and no retry.
		child.on("close", (code) =>
			done({ code: code ?? 1, registryFailure: code !== null && code !== 0 && registryFailure }),
		);
	});
}

export interface RetryOptions {
	/** How many times to run the command at most. */
	readonly attempts: number;
	/** Seconds before the second attempt; each later one waits twice as long as the one before. */
	readonly delaySeconds: number;
	/** Runs one attempt: `attempt` above unless a test stands in for it. */
	readonly run?: (command: string, args: readonly string[]) => Promise<Attempt>;
	/** Waits that many milliseconds: a timer unless a test stands in for it. */
	readonly wait?: (ms: number) => Promise<unknown>;
	/** Where a retry is announced. */
	readonly log?: (line: string) => void;
}

/** Runs `command` until it succeeds, fails for any reason but the registry, or has had every attempt; its exit code. */
export async function runWithRetry(command: string, args: readonly string[], options: RetryOptions): Promise<number> {
	const run = options.run ?? attempt;
	const wait = options.wait ?? sleep;
	const log = options.log ?? console.error;
	let delay = options.delaySeconds;
	for (let n = 1; ; n++) {
		const result = await run(command, args);
		if (result.code === 0 || !result.registryFailure) return result.code;
		if (n >= options.attempts) {
			log(`::error::${REGISTRY_HOST} failed the image push on all ${options.attempts} attempts`);
			return result.code;
		}
		log(
			`::warning::${REGISTRY_HOST} timed out pushing an image (attempt ${n} of ${options.attempts}); again in ${delay}s`,
		);
		await wait(delay * 1000);
		delay *= 2;
	}
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		options: {
			attempts: { type: "string", default: "3" },
			delay: { type: "string", default: "20" },
		},
		allowPositionals: true,
	});
	const attempts = Number(values.attempts);
	const delaySeconds = Number(values.delay);
	if (!Number.isInteger(attempts) || attempts < 1) throw new Error("Pass --attempts <a whole number, at least 1>");
	if (!Number.isFinite(delaySeconds) || delaySeconds < 0) throw new Error("Pass --delay <seconds>");
	const [command, ...args] = positionals;
	if (command === undefined) throw new Error("Pass the command after --");
	return runWithRetry(command, args, { attempts, delaySeconds });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		},
	);
}
