import { useCallback, useEffect, useState } from "react";

// Whether the sidebar is collapsed to its rail: remembered in this browser, and toggled by its button or Ctrl+B (⌘B
// on a Mac), as in editors. On a phone the sidebar is the list page, so the console ignores it there.

export const SIDEBAR_KEY = "kantel.sidebar.collapsed";

function stored(): boolean {
	try {
		return globalThis.localStorage?.getItem(SIDEBAR_KEY) === "1";
	} catch {
		return false;
	}
}

/** Ctrl+B, or ⌘B on a Mac, with no other modifier. */
export function isSidebarShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">) {
	return event.key.toLowerCase() === "b" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

export function useSidebarCollapse(enabled: boolean): { collapsed: boolean; toggle: () => void } {
	const [collapsed, setCollapsed] = useState(stored);
	const toggle = useCallback(() => {
		setCollapsed((was) => {
			const next = !was;
			try {
				globalThis.localStorage?.setItem(SIDEBAR_KEY, next ? "1" : "0");
			} catch {
				// Private browsing without storage: it just isn't remembered.
			}
			return next;
		});
	}, []);
	useEffect(() => {
		if (!enabled) return;
		const onKey = (event: KeyboardEvent) => {
			if (!isSidebarShortcut(event) || event.defaultPrevented) return;
			event.preventDefault();
			toggle();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [enabled, toggle]);
	return { collapsed: enabled && collapsed, toggle };
}

/** The shortcut's name for the toggle's tooltip, as this platform writes it. */
export const sidebarShortcut = (): string =>
	/Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘B" : "Ctrl+B";
