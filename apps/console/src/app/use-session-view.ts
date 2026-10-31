import { defaultSessionListView, type SessionListView, sessionListViewOf } from "@kantel/ui";
import { useCallback, useState } from "react";

// How the session list is filtered, grouped and sorted (the filter button by Recents): remembered in this browser, as
// the sidebar's collapse is.

export const SESSION_VIEW_KEY = "harbour.sessions.view";

function stored(): SessionListView {
	try {
		const text = globalThis.localStorage?.getItem(SESSION_VIEW_KEY);
		return text === null || text === undefined ? defaultSessionListView : sessionListViewOf(JSON.parse(text));
	} catch {
		return defaultSessionListView;
	}
}

export function useSessionView(): { view: SessionListView; setView: (view: SessionListView) => void } {
	const [view, setState] = useState(stored);
	const setView = useCallback((next: SessionListView) => {
		setState(next);
		try {
			globalThis.localStorage?.setItem(SESSION_VIEW_KEY, JSON.stringify(next));
		} catch {
			// Private browsing without storage: it just isn't remembered.
		}
	}, []);
	return { view, setView };
}
