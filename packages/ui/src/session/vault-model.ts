// Pure helpers for the vault approval card and the vault page: what to call the vault, how long is left, and when the
// approver must pick the binding code before approving.

import { DAY, duration, HOUR, MINUTE } from "../primitives/format.ts";

/** The countdown turns urgent (amber) with less than this left. */
export const URGENT_MS = 2 * MINUTE;

/** The window a countdown is measured against when the card does not say when the request started. */
export const DEFAULT_WINDOW_MS = 15 * MINUTE;

/** The vault's host from the card's link ("vault.harbour.dev"), or undefined when the link is not a URL. */
export function vaultHost(link: string): string | undefined {
	try {
		const host = new URL(link).host;
		return host === "" ? undefined : host;
	} catch {
		return undefined;
	}
}

/**
 * How long the terms last, coarsely, for the Lifetime term: "15 minutes left", "2h 10m left", "3 days left". The
 * countdown says the seconds; this says the order of magnitude without ticking every second in the reader's ear.
 */
export function lifetimeText(expiresAt: number, now: number): string {
	const left = expiresAt - now;
	if (left <= 0) return "Expired";
	if (left < MINUTE) return "Less than a minute left";
	if (left < HOUR) {
		const minutes = Math.ceil(left / MINUTE);
		return minutes === 1 ? "1 minute left" : `${minutes} minutes left`;
	}
	if (left < DAY) return `${duration(left)} left`;
	const days = Math.floor(left / DAY);
	return days === 1 ? "1 day left" : `${days} days left`;
}

/** True while a request is still open but has less than two minutes left. */
export function isUrgent(expiresAt: number, now: number): boolean {
	const left = expiresAt - now;
	return left > 0 && left < URGENT_MS;
}

/**
 * How much of the window is left, from 1 (just opened) to 0 (expired), for the countdown bar. The window runs from
 * `startedAt` when known, otherwise it is the 15 minutes before `expiresAt`.
 */
export function countdownFraction(expiresAt: number, now: number, startedAt?: number): number {
	const total = startedAt === undefined ? DEFAULT_WINDOW_MS : expiresAt - startedAt;
	if (total <= 0) return 0;
	return Math.min(1, Math.max(0, (expiresAt - now) / total));
}

/** "POST", "GET, POST", or "Any method" for an empty list or a wildcard. */
export function methodText(methods: readonly string[]): string {
	if (methods.length === 0 || methods.includes("*")) return "Any method";
	return methods.map((method) => method.toUpperCase()).join(", ");
}

/** A route grant lets matching requests through without injecting a secret: the card has no injection template. */
export function isRouteGrant(terms: { injectionTemplate?: string }): boolean {
	return terms.injectionTemplate === undefined || terms.injectionTemplate.trim() === "";
}

const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The binding-code rule for the vault page. Writes (any method other than GET, HEAD or OPTIONS, including "any
 * method"), route grants and secret pastes must have the approver pick the code that matches the card before
 * Approve or Paste is enabled. Reads only display the code.
 */
export function mustPickCode(request: {
	methods: readonly string[];
	injectionTemplate?: string;
	secretPaste?: boolean;
}): boolean {
	if (request.secretPaste === true) return true;
	if (isRouteGrant(request)) return true;
	if (request.methods.length === 0 || request.methods.includes("*")) return true;
	return request.methods.some((method) => !readMethods.has(method.toUpperCase()));
}
