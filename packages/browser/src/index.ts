/**
 * Portable browser-broker logic shared by every target: site matching and the supervisor rule. No storage and no clock
 * here.
 */
import { type Actor, HarbourError, type SessionId } from "@harbour/contracts";

/** Tells the broker a session's parent session; the runtime's session directory supplies it in production. */
export type ParentOf = (sessionId: SessionId) => SessionId | undefined;

const HOST_PATTERN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** Rejects with `invalid` unless `site` is a lower-case host (`github.com`) or a leading wildcard (`*.github.com`). */
export function assertValidSite(site: string): void {
	if (!HOST_PATTERN.test(site)) {
		throw new HarbourError("invalid", `"${site}" is not a lower-case host or a *.host wildcard`);
	}
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
