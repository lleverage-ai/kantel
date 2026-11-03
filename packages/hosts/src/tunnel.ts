/**
 * Tunnel tickets: a short-lived grant to one TCP port of one sandbox, carried in a WebSocket URL
 * (`/v1/hosts/tunnel/{ticket}`). The compute API checks who may open a sandbox's desktop or browser and issues the
 * ticket; the gateway's upgrade handler checks only that the ticket is one it issued and hasn't expired, then relays
 * binary frames to the port through the sandbox's host. Anyone holding the URL until it expires can use it, as with
 * any share link.
 *
 * A ticket is `{id}.{secret}`: the ID finds its row in the relay store (`relay-store.ts`), shared by every gateway
 * replica and kept across restarts, and the row holds only the SHA-256 of the 32-byte secret. Nothing that could pass
 * for a ticket can be made without a row, so the gateway has no signing key to keep, share or rotate.
 *
 * Expiry bounds when a connection may start, not how long it lasts: a desktop, CDP session or SSH connection opened in
 * time stays open, as boat.dev's do. A ticket can't be good for more than `MAX_TUNNEL_MINUTES`, whoever issued it.
 *
 * A desktop ticket (`desktop.ts`) also carries its mode, drive or watch, in its row, so nobody holding the URL can turn
 * a view-only ticket into one that drives. It opens only the desktop's route, and a ticket without a mode only the
 * tunnels, so a view-only ticket can't reach the desktop's port as raw TCP either.
 */
import type { RelayStore } from "./relay-store.ts";

export const HOSTS_TUNNEL_PATH = "/v1/hosts/tunnel";

/** The longest a ticket may be good for; one that claims longer is refused. */
export const MAX_TUNNEL_MINUTES = 60;

/** How long an expired ticket's row is kept before a sweep removes it. */
const KEEP_EXPIRED_MS = 60 * 60_000;

/** What a desktop ticket's holder may do: drive the desktop (keyboard, mouse, clipboard), or only watch it. */
export type DesktopMode = "control" | "view";

export interface TunnelGrant {
	readonly sandboxId: string;
	readonly port: number;
	/** Epoch milliseconds. */
	readonly expiresAt: number;
	/** Set on a desktop ticket only. */
	readonly desktop?: DesktopMode;
	/** Who it was given to, as JSON (`@kantel/compute`'s `Grantee`); absent when nobody was named. */
	readonly grantee?: string;
}

/** A grant a ticket carries, with the ticket's ID. */
export interface IssuedGrant extends TunnelGrant {
	readonly ticketId: string;
}

export interface TunnelTickets {
	/** A ticket for `grant`. */
	issue(grant: TunnelGrant): Promise<string>;
	/**
	 * The grant a ticket carries, or undefined when it isn't one the relay issued, it is malformed, it has expired or it
	 * claims to be good for longer than `MAX_TUNNEL_MINUTES` from now.
	 */
	verify(ticket: string, now: number): Promise<IssuedGrant | undefined>;
	/** Forgets tickets that expired long enough ago. */
	sweep(now: number): Promise<void>;
}

/** A ticket's shape: two base64url parts. The gateway's route takes nothing else. */
export const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A secret's SHA-256, hex. */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares in time that doesn't depend on where the strings differ. */
export function sameSecret(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

/** Tickets kept in `store`. */
export function createTunnelTickets(store: RelayStore, clock: () => number = Date.now): TunnelTickets {
	return {
		async issue(grant) {
			const id = base64url(crypto.getRandomValues(new Uint8Array(12)));
			const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
			await store.putTicket({
				id,
				secretHash: await sha256Hex(secret),
				sandboxId: grant.sandboxId,
				port: grant.port,
				expiresAt: grant.expiresAt,
				createdAt: clock(),
				...(grant.grantee === undefined ? {} : { grantee: grant.grantee }),
				...(grant.desktop === undefined ? {} : { desktop: grant.desktop }),
			});
			return `${id}.${secret}`;
		},
		async verify(ticket, now) {
			if (!TICKET_PATTERN.test(ticket)) return undefined;
			const [id = "", secret = ""] = ticket.split(".");
			const record = await store.getTicket(id);
			if (record === undefined || !sameSecret(record.secretHash, await sha256Hex(secret))) return undefined;
			const { expiresAt, desktop } = record;
			if (expiresAt <= now || expiresAt - now > MAX_TUNNEL_MINUTES * 60_000) return undefined;
			if (desktop !== undefined && desktop !== "control" && desktop !== "view") return undefined;
			return {
				ticketId: record.id,
				sandboxId: record.sandboxId,
				port: record.port,
				expiresAt,
				...(desktop === undefined ? {} : { desktop }),
				...(record.grantee === undefined ? {} : { grantee: record.grantee }),
			};
		},
		sweep(now) {
			return store.sweepTickets(now - KEEP_EXPIRED_MS);
		},
	};
}
