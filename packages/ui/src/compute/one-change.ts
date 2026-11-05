// One change at a time to each thing (a port, a sandbox's auto-stop), so a later change can't be undone by an earlier
// one landing after it. The guard outlives the view that started a change: one that mounts again, or another view of
// the same sandbox, finds the change still on its way.

export interface Changes<K> {
	/** Runs `call` as the one change to `key`, or refuses if another is on its way; frees `key` once it answers. */
	run<T>(key: K, call: () => Promise<T>): Promise<T>;
	/** The keys with a change on their way: the same set until one starts or ends. */
	changing(): ReadonlySet<K>;
	subscribe(listener: () => void): () => void;
}

/**
 * One change at a time to each key: `run` refuses a key with one on its way, with `busy`'s message, and frees it once
 * that answers, either way. Listeners hear each start and end. Other keys go on as they like.
 */
export function oneChangeEach<K>(busy: (key: K) => string): Changes<K> {
	let changing: ReadonlySet<K> = new Set();
	const listeners = new Set<() => void>();
	const set = (next: ReadonlySet<K>) => {
		changing = next;
		for (const listener of listeners) listener();
	};
	return {
		async run<T>(key: K, call: () => Promise<T>): Promise<T> {
			if (changing.has(key)) throw new Error(busy(key));
			set(new Set([...changing, key]));
			try {
				return await call();
			} finally {
				set(new Set([...changing].filter((other) => other !== key)));
			}
		},
		changing: () => changing,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** Each sandbox's auto-stop, for as long as the console runs: its page's menu and its row's share it. */
export const autoStopChanges: Changes<string> = oneChangeEach(
	() => "Its auto-stop is still changing. Try again in a moment.",
);

/** Each sandbox's idle stop, for as long as the console runs: its page's menu and its row's share it. */
export const idleStopChanges: Changes<string> = oneChangeEach(
	() => "Its idle stop is still changing. Try again in a moment.",
);
