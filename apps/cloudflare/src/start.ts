/**
 * How `KantelStack` starts: once, shared by every request and alarm that arrives while it starts. Portable, so the
 * tests drive it with a stand-in for the object's reset.
 *
 * - A configuration error is answered and retried in place by the next call: nothing has started yet.
 * - A start that fails is not retried in place. The session core may already have opened sessions (resumed due work),
 *   and a core whose `ready` rejected cannot close them, so the object is reset (`ctx.abort()`, which application code
 *   cannot catch) and the next request or alarm gets a fresh instance over the same storage.
 */
export interface StartOnceOptions<C, T> {
	/** Reads the configuration; throws when it is wrong. */
	readonly configure: () => C;
	readonly start: (config: C) => Promise<T>;
	/** Resets the object: `(reason) => ctx.abort(reason)`. On the platform it does not return. */
	readonly reset: (reason: string) => void;
	/** Told of a failed start before the reset. Default: ignored. */
	readonly onStartError?: (error: unknown) => void;
}

export const START_FAILED = "harbour: the stack did not start";

export function startOnce<C, T>(options: StartOnceOptions<C, T>): () => Promise<T> {
	let ready: Promise<T> | undefined;
	return () => {
		if (ready === undefined) {
			const attempt = (async () => {
				const config = options.configure();
				try {
					return await options.start(config);
				} catch (error) {
					options.onStartError?.(error);
					options.reset(START_FAILED);
					// Reached only where the reset returns (tests); on the platform the instance is already gone.
					throw error;
				}
			})();
			ready = attempt;
			attempt.catch(() => {
				if (ready === attempt) ready = undefined;
			});
		}
		return ready;
	};
}
