// The console's routes, on the History API with no router library: a handful of paths, parsed by one pure function
// so they can be tested without a page.
//
//   /                                         the first project
//   /projects/:projectId                      a project's sessions
//   /projects/:projectId/new                  a new session in the project: the composer, before it exists
//   /projects/:projectId/sessions/:sessionId  one session
//   /connections/requests                     the connection request page: your active grants
//   /connections/requests/:proposalId         one connection request to decide, beside your active grants: the link
//                                             the vault gives each proposal (`Proposal.link`)
//   /vault, /vault/proposals/:proposalId, /vault/requests/:proposalId
//                                             the same pages as earlier consoles and older proposals' links name
//                                             them: shown, and the address replaced with the new one (#324)
//   /audit                                    the audit log
//   /keys                                     host apps' API keys
//   /members                                  the organisation's members, and an admin's passkey reset
//   /skills                                   the agent's skills
//   /skills/:skillId                          one skill: its revisions and files
//   /memory                                   the agent's memory: concepts by scope, search and recall
//   /memory/:conceptId                        one concept: the rest of the path, slashes and all, is its ID
//                                             (`projects/harbour/placement`). Not one encoded segment, as Workers
//                                             static assets redirect an encoded slash to a plain one.
//   /schedules                                the organisation's schedules
//   /schedules/new                            the schedules page with the form for a new one open
//   /schedules/:scheduleId                    one schedule: its timing, what it runs and its run history
//   /sharing                                  what a project shares and is shared, and the requests waiting on you
//   /connections                              the connector catalogue, what's connected and the OAuth clients (#339)
//   /tool-servers                             the organisation's tool servers: MCP servers for agents' tools
//                                             (docs/design/private-mcp-tools.md)
//   /projects/:projectId/tool-servers         a project's tool servers: its own and the organisation's
//   /rules                                    prompt rules: the platform's, the organisation's, a project's and yours,
//                                             and what a new session would get
//   /sessions/:sessionId                      a session whose project the link doesn't know (a schedule's run):
//                                             replaced by its /projects/... path once the session's project is read
//   /projects/:projectId/sessions/:sessionId/files        the session's workspace files
//   /projects/:projectId/sessions/:sessionId/files/:path  one file, its whole path as one encoded segment
//   /organisation, /organisation/new, /organisation/sessions/:sessionId[/files[/:path]]
//                                             the same for sessions scoped to the organisation, in no project
//                                             (docs/design/org-scope.md): their routes carry `ORGANISATION_SCOPE`
//                                             as the project ID
//
// Query strings are kept as they are (?profile=1 turns on the profiler). A link's hash goes with it: a session at a
// turn is `#turn=<id>`, as the audit log links one.

import { useSyncExternalStore } from "react";
import { ORGANISATION_SCOPE } from "../api/client.ts";

export { isOrganisationScope, ORGANISATION_SCOPE } from "../api/client.ts";

export type Route =
	| { readonly name: "home" }
	| { readonly name: "project"; readonly projectId: string }
	| { readonly name: "new-session"; readonly projectId: string }
	| { readonly name: "session"; readonly projectId: string; readonly sessionId: string }
	| { readonly name: "connection-requests" }
	| { readonly name: "connection-request"; readonly proposalId: string }
	| { readonly name: "audit" }
	| { readonly name: "keys" }
	| { readonly name: "members" }
	| { readonly name: "models"; readonly projectId: string }
	| { readonly name: "skills"; readonly skillId?: string }
	| { readonly name: "memory"; readonly conceptId?: string }
	| { readonly name: "schedules"; readonly scheduleId?: string; readonly creating?: true }
	| { readonly name: "sharing" }
	| { readonly name: "connections" }
	| { readonly name: "tool-servers" }
	| { readonly name: "project-tool-servers"; readonly projectId: string }
	| { readonly name: "rules" }
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
	if (parts[0] === "connections" && parts[1] === "requests") {
		if (parts.length === 2) return { name: "connection-requests" };
		const proposalId = parts[2] === undefined ? undefined : segment(parts[2]);
		if (proposalId !== undefined && parts.length === 3) return { name: "connection-request", proposalId };
	}
	// The old vault page's paths, which `canonicalPath` moves to the ones above.
	if (parts[0] === "vault") {
		if (parts.length === 1) return { name: "connection-requests" };
		const proposalId = parts[2] === undefined ? undefined : segment(parts[2]);
		if ((parts[1] === "proposals" || parts[1] === "requests") && proposalId !== undefined && parts.length === 3)
			return { name: "connection-request", proposalId };
	}
	if (parts[0] === "audit" && parts.length === 1) return { name: "audit" };
	if (parts[0] === "keys" && parts.length === 1) return { name: "keys" };
	if (parts[0] === "members" && parts.length === 1) return { name: "members" };
	if (parts[0] === "sharing" && parts.length === 1) return { name: "sharing" };
	if (parts[0] === "connections" && parts.length === 1) return { name: "connections" };
	if (parts[0] === "tool-servers" && parts.length === 1) return { name: "tool-servers" };
	if (parts[0] === "rules" && parts.length === 1) return { name: "rules" };
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
	// The organisation's sessions: the project routes, one segment shorter, under the organisation's key.
	if (parts[0] === "organisation") {
		if (parts.length === 1) return { name: "project", projectId: ORGANISATION_SCOPE };
		if (parts[1] === "new" && parts.length === 2) return { name: "new-session", projectId: ORGANISATION_SCOPE };
		const sessionId = parts[2] === undefined ? undefined : segment(parts[2]);
		if (parts[1] === "sessions" && sessionId !== undefined) {
			if (parts.length === 3) return { name: "session", projectId: ORGANISATION_SCOPE, sessionId };
			if (parts[3] === "files" && parts.length === 4)
				return { name: "files", projectId: ORGANISATION_SCOPE, sessionId };
			const path = parts[4] === undefined ? undefined : segment(parts[4]);
			if (parts[3] === "files" && path !== undefined && parts.length === 5)
				return { name: "files", projectId: ORGANISATION_SCOPE, sessionId, path };
		}
	}
	if (parts[0] === "projects") {
		const projectId = parts[1] === undefined ? undefined : segment(parts[1]);
		if (projectId === ORGANISATION_SCOPE) return { name: "not-found", path: pathname };
		if (projectId !== undefined && parts.length === 2) return { name: "project", projectId };
		if (projectId !== undefined && parts[2] === "new" && parts.length === 3) return { name: "new-session", projectId };
		if (projectId !== undefined && parts[2] === "models" && parts.length === 3) return { name: "models", projectId };
		if (projectId !== undefined && parts[2] === "tool-servers" && parts.length === 3)
			return { name: "project-tool-servers", projectId };
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

/** A project's sessions, or the organisation's for `ORGANISATION_SCOPE`. */
export const projectPath = (projectId: string): string =>
	projectId === ORGANISATION_SCOPE ? "/organisation" : `/projects/${encodeURIComponent(projectId)}`;
export const newSessionPath = (projectId: string): string => `${projectPath(projectId)}/new`;
/** A project's Models page: its connectors' models, and the agent's image model. */
export const modelsPath = (projectId: string): string => `${projectPath(projectId)}/models`;
export const sessionPath = (projectId: string, sessionId: string): string =>
	`${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
/** A session at one turn: the submission or tool call an audit event names, as the session's `#turn=<id>`. */
export const sessionTurnPath = (projectId: string, sessionId: string, turn?: string): string =>
	`${sessionPath(projectId, sessionId)}${turn === undefined || turn === "" ? "" : `#turn=${encodeURIComponent(turn)}`}`;
/** A session at one of its browsers, as the audit log links a browser event: `#browser=<browserSessionId>`. */
export const sessionBrowserPath = (projectId: string, sessionId: string, browserSessionId: string): string =>
	`${sessionPath(projectId, sessionId)}#browser=${encodeURIComponent(browserSessionId)}`;
/** The browser session a `#browser=<id>` hash names, if any. */
export function browserFromHash(hash: string): string | undefined {
	const value = new URLSearchParams(hash.replace(/^#/, "")).get("browser");
	return value === null || value === "" ? undefined : value;
}
/** The connection request page: the viewer's active grants. */
export const CONNECTION_REQUESTS_PATH = "/connections/requests";
/** One connection request: the path the vault's own links use (`Proposal.link`, its `linkBase`). */
export const connectionRequestPath = (proposalId: string): string =>
	`${CONNECTION_REQUESTS_PATH}/${encodeURIComponent(proposalId)}`;

/**
 * The path an old address has now, for the console to replace it with: the vault page's `/vault/...` paths, which
 * earlier consoles and older proposals' links use, become the connection request page's. Undefined for any other path.
 */
export function canonicalPath(pathname: string): string | undefined {
	const parts = pathname.split("/").filter((part) => part !== "");
	if (parts[0] !== "vault") return undefined;
	const route = parseRoute(pathname);
	if (route.name === "connection-requests") return CONNECTION_REQUESTS_PATH;
	if (route.name === "connection-request") return connectionRequestPath(route.proposalId);
	return undefined;
}
export const AUDIT_PATH = "/audit";
export const KEYS_PATH = "/keys";
export const MEMBERS_PATH = "/members";
/** Prompt rules, and what a new session would get. */
export const RULES_PATH = "/rules";
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
/** The sharing page. */
export const SHARING_PATH = "/sharing";
/** The Connections page. */
export const CONNECTIONS_PATH = "/connections";
/** The organisation's tool servers, or a project's: its own and the organisation's. */
export const toolServersPath = (projectId?: string): string =>
	projectId === undefined ? "/tool-servers" : `${projectPath(projectId)}/tool-servers`;
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

/** The turn a hash names: `#turn=<id>`, decoded; undefined for any other hash, or an empty or malformed ID. */
export function turnOfHash(hash: string): string | undefined {
	const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
	const turn = params.get("turn");
	return turn === null || turn === "" ? undefined : turn;
}

function subscribeHash(listener: () => void): () => void {
	const unsubscribe = subscribe(listener);
	window.addEventListener("hashchange", listener);
	return () => {
		unsubscribe();
		window.removeEventListener("hashchange", listener);
	};
}

/** The current hash (`#turn=x`), re-rendering on navigation and when only the hash changes. */
export function useHash(): string {
	return useSyncExternalStore(
		subscribeHash,
		() => location.hash,
		() => "",
	);
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
