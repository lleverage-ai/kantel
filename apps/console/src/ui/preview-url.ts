import { useEffect, useRef } from "react";

// The open file in the session's URL, as `#file=<key>` beside any other hash parameter (`#turn=`, `#browser=`): a
// link to a session with a file opens it, and the browser's Back closes the preview rather than leaving the session.
// Opening from closed adds a history entry; moving between files while open replaces it, so Back closes the panel in
// one step whatever was looked at; closing goes back over the entry it added.

const PARAM = "file";
/** Marks the history entry the preview added, so closing knows it may go back over it. */
const MARK = "hbPreview";

/** The file key a hash names, if any. */
export function fileOfHash(hash: string): string | undefined {
	const value = new URLSearchParams(hash.replace(/^#/, "")).get(PARAM);
	return value === null || value === "" ? undefined : value;
}

/** The hash with the file key set, or removed for `undefined`; other parameters kept. */
export function hashWithFile(hash: string, key: string | undefined): string {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	if (key === undefined) params.delete(PARAM);
	else params.set(PARAM, key);
	const text = params.toString();
	return text === "" ? "" : `#${text}`;
}

/**
 * Keeps `#file=` in step with the open file's `key`, and calls `onUrl` when the URL changes it (Back, Forward, a
 * followed link): with the key it names, or `undefined` when it names none.
 */
export function useFileInUrl(key: string | undefined, onUrl: (key: string | undefined) => void): void {
	const latest = useRef(onUrl);
	latest.current = onUrl;
	const shown = useRef(key);
	const first = useRef(true);
	useEffect(() => {
		const before = fileOfHash(location.hash);
		shown.current = key;
		// On arrival the URL leads: a `#file=` link waits for its file to be found rather than being cleared.
		const arriving = first.current;
		first.current = false;
		if (key === before || (arriving && key === undefined)) return;
		const url = (next: string | undefined) =>
			`${location.pathname}${location.search}${hashWithFile(location.hash, next)}`;
		if (key !== undefined && before === undefined) history.pushState({ [MARK]: true }, "", url(key));
		else if (key !== undefined) history.replaceState(history.state, "", url(key));
		else if ((history.state as { [MARK]?: boolean } | null)?.[MARK] === true) history.back();
		else history.replaceState(history.state, "", url(undefined));
	}, [key]);
	useEffect(() => {
		const onPop = () => {
			const named = fileOfHash(location.hash);
			if (named !== shown.current) latest.current(named);
		};
		window.addEventListener("popstate", onPop);
		window.addEventListener("hashchange", onPop);
		return () => {
			window.removeEventListener("popstate", onPop);
			window.removeEventListener("hashchange", onPop);
		};
	}, []);
}
