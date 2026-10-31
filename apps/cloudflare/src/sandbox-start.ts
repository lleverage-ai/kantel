/**
 * Starting a session's sandbox container (`KantelSandbox`, `src/sandbox-object.ts`): start it, give it its inactivity
 * timeout, and wait for the agent's `/health`.
 *
 * - **No free instance**: Cloudflare answers "There is no container instance that can be provided to this Durable
 *   Object, try again later" when every instance it has ready is in use (deployed, 8 sessions starting at once got it
 *   twice, TASK-3922). Nothing has run yet, so asking again is safe: the start retries for up to `instanceWaitMs`,
 *   backing off, as Cloudflare's own `Container` class does for 8 s. A command is never retried; only its container's
 *   start.
 * - **No `monitor()`**: a pending `monitor()` keeps the Durable Object from being evicted for up to 15 minutes, and the
 *   inactivity timeout only counts once the object is inactive (Cloudflare's Durable Object Container API), so a
 *   container could run up to 25 minutes after its start rather than 10 after its last call. A failed start shows up
 *   here instead: `/health` never answers, or the start says so.
 */

/** What `ctx.container.start` is given here (a part of Workers' `ContainerStartupOptions`, kept to plain types so the
 * tests compile without the Workers types). */
export interface ContainerStartup {
	readonly enableInternet: boolean;
	readonly entrypoint?: string[];
	readonly env?: Record<string, string>;
}

/** The part of the Durable Object's `ctx.container` a start uses. */
export interface StartableContainer {
	readonly running: boolean;
	start(options?: ContainerStartup): void;
	setInactivityTimeout(durationMs: number): Promise<void>;
	getTcpPort(port: number): { fetch(input: string): Promise<Response> };
}

export interface StartOptions {
	readonly startup: ContainerStartup;
	readonly port: number;
	readonly inactivityMs: number;
	/** How long the agent has to answer `/health` once the container has an instance. */
	readonly readyTimeoutMs: number;
	/** How long to keep asking for an instance while Cloudflare has none free. */
	readonly instanceWaitMs: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
}

const NO_INSTANCE = "there is no container instance that can be provided to this durable object";

/** Cloudflare had no container instance free for this Durable Object: worth asking again. */
export function isNoInstanceError(error: unknown): boolean {
	return error instanceof Error && error.message.toLowerCase().includes(NO_INSTANCE);
}

/** Starts the container and waits until its agent answers; answers the start's timings in milliseconds. */
export async function startContainer(
	container: StartableContainer,
	options: StartOptions,
): Promise<Record<string, number>> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = options.now ?? (() => performance.now());
	const began = now();
	for (let attempt = 0; ; attempt++) {
		try {
			const timings: Record<string, number> = {};
			let at = now();
			if (!container.running) container.start(options.startup);
			await container.setInactivityTimeout(options.inactivityMs);
			timings["container.start"] = round(now() - at);
			at = now();
			await ready(container, options, sleep, now);
			timings["container.ready"] = round(now() - at);
			if (attempt > 0) {
				timings["container.instanceWait"] = round(at - began - timings["container.start"]);
				timings["container.instanceAttempts"] = attempt + 1;
			}
			return timings;
		} catch (error) {
			if (!isNoInstanceError(error) || now() - began >= options.instanceWaitMs) throw error;
			await sleep(Math.min(250 * 2 ** attempt, 2000));
		}
	}
}

async function ready(
	container: StartableContainer,
	options: StartOptions,
	sleep: (ms: number) => Promise<void>,
	now: () => number,
): Promise<void> {
	const port = container.getTcpPort(options.port);
	const at = now();
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await port.fetch("http://sandbox/health");
			if (response.ok) return;
		} catch (error) {
			// No instance after all: the start asks again. Anything else: not listening yet.
			if (isNoInstanceError(error) && !container.running) throw error;
		}
		if (now() - at > options.readyTimeoutMs) {
			throw new Error(`the sandbox container did not start in ${Math.round(options.readyTimeoutMs / 1000)} s`);
		}
		await sleep(attempt < 40 ? 50 : 250);
	}
}

function round(ms: number): number {
	return Math.round(ms * 10) / 10;
}
