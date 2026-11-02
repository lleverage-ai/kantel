/**
 * How long the stack keeps an idle session open (`KANTEL_SESSION_IDLE_SECONDS`). Portable (no `cloudflare:workers`), so
 * the tests read it in Node.
 *
 * One stack object hosts every session, in one isolate with a 128 MB limit. A session left open (an eval run that never
 * closes its sessions, a console tab read once) used to keep its whole transcript, its stream's resume window and its
 * projection in that memory until the object was evicted. Putting idle ones away keeps the object to the sessions at
 * work; the next call opens one again from SQLite.
 */
import { KantelError } from "@kantel/contracts";

export interface SessionIdleVars {
	readonly KANTEL_SESSION_IDLE_SECONDS?: string;
}

/** The default: two minutes, well past a console's reconnect and a prompt's admission, well short of an eval's run. */
export const DEFAULT_SESSION_IDLE_SECONDS = 120;

/** The stack's `sessionIdleMs`: absent when the variable is `off`. Refuses (`invalid`) anything but seconds or `off`. */
export function sessionIdleFrom(vars: SessionIdleVars): { readonly sessionIdleMs?: number } {
	const value = (vars.KANTEL_SESSION_IDLE_SECONDS ?? "").trim();
	if (value === "off") return {};
	if (value === "") return { sessionIdleMs: DEFAULT_SESSION_IDLE_SECONDS * 1000 };
	const seconds = Number(value);
	if (!/^\d+$/.test(value) || !(seconds >= 1) || seconds > 86_400) {
		throw new KantelError(
			"invalid",
			"KANTEL_SESSION_IDLE_SECONDS must be a whole number of seconds (1 to 86400) or off",
		);
	}
	return { sessionIdleMs: seconds * 1000 };
}
