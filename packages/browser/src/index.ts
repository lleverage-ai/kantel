/**
 * Portable browser-broker logic shared by every target: site matching, site coverage and the supervisor rule. No
 * storage and no clock here.
 */
import {
	type Actor,
	type Browser,
	type BrowserAction,
	type BrowserGoal,
	KantelError,
	type SessionId,
	type SessionTeardown,
} from "@kantel/contracts";

/** The step kinds `browser.act` takes, in the order the capability lists them. */
export const BROWSER_ACTION_KINDS = [
	"look",
	"goto",
	"click",
	"fill",
	"select",
	"check",
	"slide",
	"press",
	"scroll",
	"wait",
] as const satisfies readonly BrowserAction["kind"][];

/** How long a share link may last, in minutes; the first is the default. */
export const SHARE_MINUTES = [15, 60] as const;

/** How long an embed link may last (the embed API, docs/design/browser-runtime.md): 5 to 60 minutes, 15 by default. */
export const EMBED_MINUTES = { min: 5, max: 60, default: 15 } as const;

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
		throw new KantelError("invalid", `Unknown browser step ${String(raw.kind)}`);
	}
	const text = (key: string, max: number, allowEmpty = false) => {
		const value = raw[key];
		if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > max) {
			throw new KantelError("invalid", `A ${action.kind} step needs ${key} (at most ${max} characters)`);
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
		case "slide":
			text("element", 20);
			text("value", MAX_VALUE_LENGTH, action.kind === "fill");
			return;
		case "press":
			if (typeof action.key !== "string" || !KEY_PATTERN.test(action.key)) {
				throw new KantelError("invalid", "A press step needs a key name, such as Enter or Control+A");
			}
			return;
		default:
			return;
	}
}

/** The most steps one goal run may take, and the most values its `data` may hold. */
export const MAX_RUN_STEPS = 60;
const MAX_GOAL_LENGTH = 2000;
const MAX_GOAL_DATA = 30;
const DATA_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_ -]{0,63}$/;

/**
 * Rejects with `invalid` unless `goal` is a well-formed goal run: a goal of 1 to 2,000 characters, at most 30 named
 * string values of at most 2,000 each, a `stopBefore` and `url` within 2,000, and `maxSteps` a whole number from 1 to
 * `MAX_RUN_STEPS`.
 */
export function assertValidGoal(goal: BrowserGoal): void {
	const raw = goal as unknown as { readonly [key: string]: unknown };
	if (typeof raw.goal !== "string" || raw.goal.trim() === "" || raw.goal.length > MAX_GOAL_LENGTH) {
		throw new KantelError("invalid", `A goal is a sentence of at most ${MAX_GOAL_LENGTH} characters`);
	}
	for (const key of ["stopBefore", "url"] as const) {
		const value = raw[key];
		if (value !== undefined && (typeof value !== "string" || value.trim() === "" || value.length > MAX_URL_LENGTH)) {
			throw new KantelError("invalid", `${key} is text of at most ${MAX_URL_LENGTH} characters`);
		}
	}
	if (raw.data !== undefined) {
		if (typeof raw.data !== "object" || raw.data === null || Array.isArray(raw.data)) {
			throw new KantelError("invalid", "data is an object of named values");
		}
		const entries = Object.entries(raw.data);
		if (entries.length > MAX_GOAL_DATA) throw new KantelError("invalid", `data holds at most ${MAX_GOAL_DATA} values`);
		for (const [name, value] of entries) {
			if (!DATA_NAME_PATTERN.test(name) || typeof value !== "string" || value.length > MAX_VALUE_LENGTH) {
				throw new KantelError(
					"invalid",
					`data.${name} is a named text value of at most ${MAX_VALUE_LENGTH} characters`,
				);
			}
		}
	}
	if (
		raw.maxSteps !== undefined &&
		(typeof raw.maxSteps !== "number" ||
			!Number.isInteger(raw.maxSteps) ||
			raw.maxSteps < 1 ||
			raw.maxSteps > MAX_RUN_STEPS)
	) {
		throw new KantelError("invalid", `maxSteps is a whole number from 1 to ${MAX_RUN_STEPS}`);
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
		throw new KantelError("invalid", `"${site}" is not a lower-case host or a *.host wildcard`);
	}
	if (site.startsWith("*.") && !site.slice(2).includes(".")) {
		throw new KantelError("invalid", `"${site}" is a wildcard over a single label`);
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

/** Google's own hosts in one country, `google.com`, `www.google.co.uk` or `*.google.de`, with that country's suffix. */
const GOOGLE_SITE = /^(?:\*\.|www\.)?google\.(com|[a-z]{2}|com?\.[a-z]{2})$/;

/**
 * A grant's sites with the consent pages they redirect through. Google sends a visitor without its consent cookie
 * (`www.google.com/travel/flights`, `www.google.co.uk/maps`) to `consent.google.<the same suffix>` first, so a grant
 * for Google also admits that one consent host, and nothing else on Google or any other site.
 */
export function sitesWithConsent(allowedSites: readonly string[]): string[] {
	const sites = new Set(allowedSites);
	for (const site of allowedSites) {
		const google = GOOGLE_SITE.exec(site.toLowerCase());
		if (google) sites.add(`consent.google.${google[1]}`);
	}
	return [...sites];
}

/**
 * Whether `url` (http or https) is on one of `allowedSites`, or on the consent page one of them redirects through
 * (`sitesWithConsent`). An exact site matches that host and, unless it already starts with `www.`, its `www.` host,
 * and nothing else under it: a person who allows `google.com` means the site, and most sites send their bare host to
 * `www.` straight away. `*.example.com` matches every subdomain of `example.com` but not `example.com` itself. Ports
 * are ignored; an invalid URL is never allowed.
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
	return sitesWithConsent(allowedSites).some((site) => {
		const pattern = site.toLowerCase();
		if (pattern.startsWith("*.")) {
			const suffix = pattern.slice(1);
			return host.length > suffix.length && host.endsWith(suffix);
		}
		return host === pattern || (!pattern.startsWith("www.") && host === `www.${pattern}`);
	});
}

/**
 * Whether `actor` may supervise `targetSessionId`: a human, a service, or an agent acting in the target session's
 * parent. An agent never supervises its own session, and Kantel's own system actors are not supervisors.
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
