import { useSyncExternalStore } from "react";

/** The phone layout's breakpoint: one pane at a time, as the library's session header switches at 640px. */
export const NARROW_QUERY = "(max-width: 640px)";

/** Whether a media query matches, re-rendering when that changes. */
export function useMedia(query: string): boolean {
	return useSyncExternalStore(
		(listener) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", listener);
			return () => list.removeEventListener("change", listener);
		},
		() => window.matchMedia(query).matches,
		() => false,
	);
}
