// The console's routes, on the History API with no router library: a handful of paths, parsed by one pure function
// so they can be tested without a page.
//
//   /                                         the first project
//   /projects/:projectId                      a project's sessions
//   /projects/:projectId/sessions/:sessionId  one session
//   /vault                                    the vault page: your active grants
//   /vault/requests/:proposalId               one vault request to decide, beside your active grants
//   /audit                                    the audit log
//
// Query strings are kept as they are (?profile=1 turns on the profiler).

import { useSyncExternalStore } from "react";

export type Route =
	| { readonly name: "home" }
	| { readonly name: "project"; readonly projectId: string }
	| { readonly name: "session"; readonly projectId: string; readonly sessionId: string }
	| { readonly name: "vault" }
	| { readonly name: "vault-request"; readonly proposalId: string }
	| { readonly name: "audit" }
	| { readonly name: "not-found"; readonly path: string };

const segment = (value: string): string | undefined => {
	try {
		const decoded = decodeURIComponent(value);
		return decoded === "" ? undefined : decoded;
	} catch {
		return undefined;
	}
};

export function parseRoute(pathname: string): Route {
	const parts = pathname.split("/").filter((part) => part !== "");
	if (parts.length === 0) return { name: "home" };
	if (parts[0] === "vault") {
		if (parts.length === 1) return { name: "vault" };
		const proposalId = parts[2] === undefined ? undefined : segment(parts[2]);
		if (parts[1] === "requests" && proposalId !== undefined && parts.length === 3)
			return { name: "vault-request", proposalId };
	}
	if (parts[0] === "audit" && parts.length === 1) return { name: "audit" };
	if (parts[0] === "projects") {
		const projectId = parts[1] === undefined ? undefined : segment(parts[1]);
		if (projectId !== undefined && parts.length === 2) return { name: "project", projectId };
		const sessionId = parts[3] === undefined ? undefined : segment(parts[3]);
		if (projectId !== undefined && parts[2] === "sessions" && sessionId !== undefined && parts.length === 4)
			return { name: "session", projectId, sessionId };
	}
	return { name: "not-found", path: pathname };
}

export const projectPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}`;
export const sessionPath = (projectId: string, sessionId: string): string =>
	`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
export const VAULT_PATH = "/vault";
export const vaultRequestPath = (proposalId: string): string => `/vault/requests/${encodeURIComponent(proposalId)}`;
export const AUDIT_PATH = "/audit";

const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0) window.addEventListener("popstate", notify);
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) window.removeEventListener("popstate", notify);
	};
}

/** Goes to `path`, keeping the query string. `replace` swaps the current history entry instead of adding one. */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
	const target = `${path}${location.search}`;
	if (`${location.pathname}${location.search}` === target) return;
	if (replace) history.replaceState(null, "", target);
	else history.pushState(null, "", target);
	notify();
}

/** The current pathname, re-rendering on navigation. */
export function usePathname(): string {
	return useSyncExternalStore(
		subscribe,
		() => location.pathname,
		() => "/",
	);
}

/**
 * Handles a click on an in-app link without reloading the page, as a router's Link would. Install once on the root:
 * every plain left click on an `<a href="/...">` in the app becomes a `navigate`. Modified clicks (a new tab) and
 * links to other origins behave as normal links.
 */
export function interceptLinks(root: HTMLElement): () => void {
	const onClick = (event: MouseEvent) => {
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const anchor = (event.target as Element | null)?.closest?.("a");
		if (anchor === null || anchor === undefined || anchor.target === "_blank" || anchor.hasAttribute("download"))
			return;
		const url = new URL(anchor.href, location.href);
		if (url.origin !== location.origin) return;
		event.preventDefault();
		navigate(url.pathname);
	};
	root.addEventListener("click", onClick);
	return () => root.removeEventListener("click", onClick);
}
