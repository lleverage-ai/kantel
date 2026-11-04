// One read, as a page shows it: loading, the value, or the error, and a way to read it again. For pages that read a
// few records from an API when they open (schedules, skills, memory); a feed that pages or polls has its own hook.

import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

export type Loaded<T> =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: unknown }
	| { readonly status: "ready"; readonly value: T };

/**
 * Reads `load()` when `deps` change and on `reload()`. A read that a newer one replaced, or that finishes after the
 * component unmounted, never touches the state. While a reload runs the last value stays on screen.
 */
export function useLoad<T>(
	load: () => Promise<T>,
	deps: DependencyList,
): { readonly state: Loaded<T>; readonly reload: () => void } {
	const [state, setState] = useState<Loaded<T>>({ status: "loading" });
	const [generation, setGeneration] = useState(0);
	const latest = useRef(load);
	latest.current = load;
	const seen = useRef<number | undefined>(undefined);
	// `deps` are the caller's, as for useEffect; `generation` is reload.
	useEffect(() => {
		let live = true;
		// A change of what is read shows the skeleton again; a reload of the same thing keeps the last value.
		const reloading = seen.current !== undefined && seen.current !== generation;
		if (seen.current !== undefined && !reloading) setState({ status: "loading" });
		seen.current = generation;
		latest.current().then(
			(value) => {
				if (live) setState({ status: "ready", value });
			},
			(error: unknown) => {
				if (live) setState({ status: "error", error });
			},
		);
		return () => {
			live = false;
		};
	}, [...deps, generation]);
	const reload = useCallback(() => setGeneration((value) => value + 1), []);
	return { state, reload };
}

/**
 * Calls `reload` each time `key` changes after the first render, so a read that `useLoad` keeps on screen follows
 * something its deps don't name (a sandbox's newest snapshot, a parent's poll) without showing the skeleton again.
 */
export function useReloadOn(key: unknown, reload: () => void): void {
	const last = useRef(key);
	useEffect(() => {
		if (Object.is(last.current, key)) return;
		last.current = key;
		reload();
	}, [key, reload]);
}
