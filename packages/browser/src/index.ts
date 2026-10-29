/**
 * Portable browser-broker logic shared by every target: site matching, site coverage and the supervisor rule. No
 * storage and no clock here.
 */
import {
	type Actor,
	type Browser,
	type BrowserAction,
	HarbourError,
	type SessionId,
	type SessionTeardown,
} from "@harbour/contracts";

/** The step kinds `browser.act` takes, in the order the capability lists them. */
export const BROWSER_ACTION_KINDS = [
	"look",
	"goto",
	"click",
	"fill",
	"select",
	"check",
	"press",
	"scroll",
	"wait",
] as const satisfies readonly BrowserAction["kind"][];

/** How long a share link may last, in minutes; the first is the default. */
export const SHARE_MINUTES = [15, 60] as const;

const MAX_VALUE_LENGTH = 2000;
const MAX_URL_LENGTH = 2000;
const KEY_PATTERN = /^[A-Za-z0-9+]{1,20}$/;

/**
 * Rejects with `invalid` unless `action` is a well-formed step: a known kind, a non-empty element ID where one is
 * needed, a value or URL within 2,000 characters and a key name such as `Enter` or `Control+A`.
 */
export function assertValidAction(action: BrowserAction): void {
	const raw = action as { readonly [key: string]: unknown };
	if (!(BROWSER_ACTION_KINDS as readonly unknown[]).includes(raw.kind)) {
		throw new HarbourError("invalid", `Unknown browser step ${String(raw.kind)}`);
	}
	const text = (key: string, max: number, allowEmpty = false) => {
		const value = raw[key];
		if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > max) {
			throw new HarbourError("invalid", `A ${action.kind} step needs ${key} (at most ${max} characters)`);
		}
	};
	switch (action.kind) {
		case "goto":
			text("url", MAX_URL_LENGTH);
			return;
		case "click":
		case "check":
			text("element", 20);
			return;
		case "fill":
		case "select":
			text("element", 20);
			text("value", MAX_VALUE_LENGTH, action.kind === "fill");
			return;
		case "press":
			if (typeof action.key !== "string" || !KEY_PATTERN.test(action.key)) {
				throw new HarbourError("invalid", "A press step needs a key name, such as Enter or Control+A");
			}
			return;
		default:
			return;
	}
}

/** Whether a browser on `url` may be shown to its caller: a page on the grant's sites, or a blank one. */
export function pageAllowed(allowedSites: readonly string[], url: string): boolean {
	return url === "about:blank" || siteAllowed(allowedSites, url);
}

/**
 * The broker's session-end teardown as a function the runtime can call or register itself (`sessionEnd.register(
 * "browser", browserTeardown(browser))`), for a broker built without `sessionEnd`. It closes every browser of the
 * ended session and ends its grants, through `Browser.endSession`, which refuses any caller but `system`.
 */
export function browserTeardown(browser: Pick<Browser, "endSession">): SessionTeardown {
	return (ctx, end) => browser.endSession(ctx, end.sessionId, end.reason);
}

/** Tells the broker a session's parent session; the runtime's session directory supplies it in production. */
export type ParentOf = (sessionId: SessionId) => SessionId | undefined;

const HOST_PATTERN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * Rejects with `invalid` unless `site` is a lower-case host (`github.com`) or a leading wildcard (`*.github.com`). A
 * wildcard must sit over at least two labels, so `*.com` is invalid. There is no public suffix list, so `*.co.uk` is
 * accepted.
 */
export function assertValidSite(site: string): void {
	if (!HOST_PATTERN.test(site)) {
		throw new HarbourError("invalid", `"${site}" is not a lower-case host or a *.host wildcard`);
	}
	if (site.startsWith("*.") && !site.slice(2).includes(".")) {
		throw new HarbourError("invalid", `"${site}" is a wildcard over a single label`);
	}
}

/**
 * Whether `site` (a valid site) is no wider than `parentSites`. An exact host must be in the list or under one of its
 * wildcards; a wildcard must equal one of its wildcards or sit under one.
 */
export function siteCovered(parentSites: readonly string[], site: string): boolean {
	const host = site.startsWith("*.") ? site.slice(2) : site;
	return parentSites.some((parent) => {
		if (!parent.startsWith("*.")) return parent === site;
		const suffix = parent.slice(1);
		return site === parent || (host.length > suffix.length && host.endsWith(suffix));
	});
}

/**
 * Whether `url` (http or https) is on one of `allowedSites`. An exact site matches only that host; `*.example.com`
 * matches every subdomain of `example.com` but not `example.com` itself. Ports are ignored; an invalid URL is never
 * allowed.
 */
export function siteAllowed(allowedSites: readonly string[], url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
	const host = parsed.hostname.toLowerCase();
	if (host.length === 0) return false;
	return allowedSites.some((site) => {
		const pattern = site.toLowerCase();
		if (pattern.startsWith("*.")) {
			const suffix = pattern.slice(1);
			return host.length > suffix.length && host.endsWith(suffix);
		}
		return host === pattern;
	});
}

/**
 * Whether `actor` may supervise `targetSessionId`: a human, a service, or an agent acting in the target session's
 * parent. An agent never supervises its own session, and Harbour's own system actors are not supervisors.
 */
export function isSupervisor(actor: Actor, targetSessionId: SessionId, parentOf: ParentOf): boolean {
	switch (actor.kind) {
		case "human":
		case "service":
			return true;
		case "agent": {
			if (actor.sessionId === targetSessionId) return false;
			const parent = parentOf(targetSessionId);
			return parent !== undefined && parent === actor.sessionId;
		}
		default:
			return false;
	}
}
