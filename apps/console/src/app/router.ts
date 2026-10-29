// The console's routes, on the History API with no router library: a handful of paths, parsed by one pure function
// so they can be tested without a page.
//
//   /                                         the first project
//   /projects/:projectId                      a project's sessions
//   /projects/:projectId/new                  a new session in the project: the composer, before it exists
//   /projects/:projectId/sessions/:sessionId  one session
//   /vault                                    the vault page: your active grants
//   /vault/proposals/:proposalId              one vault request to decide, beside your active grants: the link the
//                                             vault gives each proposal (`Proposal.link`)
//   /vault/requests/:proposalId               the same, as earlier consoles linked it
//   /audit                                    the audit log
//   /keys                                     host apps' API keys
//   /skills                                   the agent's skills
//   /skills/:skillId                          one skill: its revisions and files
//   /memory                                   the agent's memory: concepts by scope, search and recall
//   /memory/:conceptId                        one concept: the rest of the path, slashes and all, is its ID
//                                             (`projects/harbour/placement`). Not one encoded segment, as Workers
//                                             static assets redirect an encoded slash to a plain one.
//   /schedules                                the organisation's schedules
//   /schedules/new                            the schedules page with the form for a new one open
//   /schedules/:scheduleId                    one schedule: its timing, what it runs and its run history
//   /sessions/:sessionId                      a session whose project the link doesn't know (a schedule's run):
//                                             replaced by its /projects/... path once the session's project is read
//   /projects/:projectId/sessions/:sessionId/files        the session's workspace files
//   /projects/:projectId/sessions/:sessionId/files/:path  one file, its whole path as one encoded segment
//
// Query strings are kept as they are (?profile=1 turns on the profiler). A link's hash goes with it: a session at a
// turn is `#turn=<id>`, as the audit log links one.

import { useSyncExternalStore } from "react";

export type Route =
	| { readonly name: "home" }
	| { readonly name: "project"; readonly projectId: string }
	| { readonly name: "new-session"; readonly projectId: string }
	| { readonly name: "session"; readonly projectId: string; readonly sessionId: string }
	| { readonly name: "vault" }
	| { readonly name: "vault-request"; readonly proposalId: string }
	| { readonly name: "audit" }
	| { readonly name: "keys" }
	| { readonly name: "skills"; readonly skillId?: string }
	| { readonly name: "memory"; readonly conceptId?: string }
	| { readonly name: "schedules"; readonly scheduleId?: string; readonly creating?: true }
	| { readonly name: "session-link"; readonly sessionId: string }
	| { readonly name: "files"; readonly projectId: string; readonly sessionId: string; readonly path?: string }
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
		if ((parts[1] === "proposals" || parts[1] === "requests") && proposalId !== undefined && parts.length === 3)
			return { name: "vault-request", proposalId };
	}
	if (parts[0] === "audit" && parts.length === 1) return { name: "audit" };
	if (parts[0] === "keys" && parts.length === 1) return { name: "keys" };
	if (parts[0] === "skills") {
		if (parts.length === 1) return { name: "skills" };
		const skillId = parts[1] === undefined ? undefined : segment(parts[1]);
		if (skillId !== undefined && parts.length === 2) return { name: "skills", skillId };
	}
	if (parts[0] === "memory") {
		if (parts.length === 1) return { name: "memory" };
		const ids = parts.slice(1).map(segment);
		if (ids.every((id) => id !== undefined)) return { name: "memory", conceptId: ids.join("/") };
	}
	if (parts[0] === "schedules") {
		if (parts.length === 1) return { name: "schedules" };
		if (parts[1] === "new" && parts.length === 2) return { name: "schedules", creating: true };
		const scheduleId = parts[1] === undefined ? undefined : segment(parts[1]);
		if (scheduleId !== undefined && parts.length === 2) return { name: "schedules", scheduleId };
	}
	if (parts[0] === "sessions") {
		const sessionId = parts[1] === undefined ? undefined : segment(parts[1]);
		if (sessionId !== undefined && parts.length === 2) return { name: "session-link", sessionId };
	}
	if (parts[0] === "projects") {
		const projectId = parts[1] === undefined ? undefined : segment(parts[1]);
		if (projectId !== undefined && parts.length === 2) return { name: "project", projectId };
		if (projectId !== undefined && parts[2] === "new" && parts.length === 3) return { name: "new-session", projectId };
		const sessionId = parts[3] === undefined ? undefined : segment(parts[3]);
		if (projectId !== undefined && parts[2] === "sessions" && sessionId !== undefined) {
			if (parts.length === 4) return { name: "session", projectId, sessionId };
			if (parts[4] === "files" && parts.length === 5) return { name: "files", projectId, sessionId };
			const path = parts[5] === undefined ? undefined : segment(parts[5]);
			if (parts[4] === "files" && path !== undefined && parts.length === 6)
				return { name: "files", projectId, sessionId, path };
		}
	}
	return { name: "not-found", path: pathname };
}

export const projectPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}`;
export const newSessionPath = (projectId: string): string => `${projectPath(projectId)}/new`;
export const sessionPath = (projectId: string, sessionId: string): string =>
	`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
/** A session at one turn: the submission or tool call an audit event names, as the session's `#turn=<id>`. */
export const sessionTurnPath = (projectId: string, sessionId: string, turn?: string): string =>
	`${sessionPath(projectId, sessionId)}${turn === undefined || turn === "" ? "" : `#turn=${encodeURIComponent(turn)}`}`;
export const VAULT_PATH = "/vault";
/** One vault request: the path the vault's own links use (`Proposal.link`, `@harbour/vault`'s `approvalLink`). */
export const vaultRequestPath = (proposalId: string): string => `/vault/proposals/${encodeURIComponent(proposalId)}`;
export const AUDIT_PATH = "/audit";
export const KEYS_PATH = "/keys";
/** The skills page, or one skill on it. */
export const skillsPath = (skillId?: string): string =>
	skillId === undefined ? "/skills" : `/skills/${encodeURIComponent(skillId)}`;
/** The memory page, or one concept on it; the concept's ID keeps its slashes, each part encoded. */
export const memoryPath = (conceptId?: string): string =>
	conceptId === undefined ? "/memory" : `/memory/${conceptId.split("/").map(encodeURIComponent).join("/")}`;
/** The schedules page, or one schedule on it. A schedule's ID may be `new` only as `/schedules/new`'s. */
export const schedulesPath = (scheduleId?: string): string =>
	scheduleId === undefined ? "/schedules" : `/schedules/${encodeURIComponent(scheduleId)}`;
export const NEW_SCHEDULE_PATH = "/schedules/new";
/** A session by its ID alone, for a link that doesn't know its project; the console finds the project and goes there. */
export const sessionLinkPath = (sessionId: string): string => `/sessions/${encodeURIComponent(sessionId)}`;
/** A session's files, or one file in them; the file's path is one segment, its slashes encoded. */
export const filesPath = (projectId: string, sessionId: string, path?: string): string =>
	`${sessionPath(projectId, sessionId)}/files${path === undefined ? "" : `/${encodeURIComponent(path)}`}`;

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

/**
 * Goes to `path`, keeping the query string; a hash on `path` (`/projects/p/sessions/s#turn=x`) follows it. `replace`
 * swaps the current history entry instead of adding one.
 */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
	const hashAt = path.indexOf("#");
	const target =
		hashAt === -1 ? `${path}${location.search}` : `${path.slice(0, hashAt)}${location.search}${path.slice(hashAt)}`;
	if (`${location.pathname}${location.search}${hashAt === -1 ? "" : location.hash}` === target) return;
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
		navigate(`${url.pathname}${url.hash}`);
	};
	root.addEventListener("click", onClick);
	return () => root.removeEventListener("click", onClick);
}
