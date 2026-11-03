/**
 * Tunnel tickets: a short-lived, signed grant to one TCP port of one sandbox, carried in a WebSocket URL
 * (`/v1/hosts/tunnel/{ticket}`). The compute API checks who may open a sandbox's desktop or browser and mints the
 * ticket; the gateway's upgrade handler checks only the signature and expiry, then relays binary frames to the port
 * through the sandbox's host. Anyone holding the URL until it expires can use it, as with any share link.
 *
 * Expiry bounds when a connection may start, not how long it lasts: a desktop, CDP session or SSH connection opened in
 * time stays open, as boat.dev's do. A ticket can't be good for more than `MAX_TUNNEL_MINUTES`, whoever signed it.
 */

export const HOSTS_TUNNEL_PATH = "/v1/hosts/tunnel";

/** The longest a ticket may be good for; one that claims longer is refused. */
export const MAX_TUNNEL_MINUTES = 60;

/** What the HMAC covers besides the payload, so the gateway's secret signs nothing else that could pass for a ticket. */
const DOMAIN = "kantel-tunnel/v1";

export interface TunnelGrant {
	readonly sandboxId: string;
	readonly port: number;
	/** Epoch milliseconds. */
	readonly expiresAt: number;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret: Uint8Array, payload: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

/** A ticket for `grant`, signed with `secret` (32 random bytes the gateway holds). */
export async function signTunnel(secret: Uint8Array, grant: TunnelGrant): Promise<string> {
	const payload = base64url(encoder.encode(JSON.stringify([grant.sandboxId, grant.port, grant.expiresAt])));
	return `${payload}.${base64url(await hmac(secret, `${DOMAIN}.${payload}`))}`;
}

/**
 * The grant a ticket carries, or undefined when its signature is wrong, it is malformed, it has expired or it claims to
 * be good for longer than `MAX_TUNNEL_MINUTES` from now.
 */
export async function verifyTunnel(secret: Uint8Array, ticket: string, now: number): Promise<TunnelGrant | undefined> {
	const [payload, signature, extra] = ticket.split(".");
	if (payload === undefined || signature === undefined || extra !== undefined) return undefined;
	try {
		const expected = await hmac(secret, `${DOMAIN}.${payload}`);
		const given = fromBase64url(signature);
		if (given.length !== expected.length) return undefined;
		let diff = 0;
		for (let i = 0; i < given.length; i++) diff |= (given[i] ?? 0) ^ (expected[i] ?? 0);
		if (diff !== 0) return undefined;
		const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
		if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
		const [sandboxId, port, expiresAt] = parsed as [unknown, unknown, unknown];
		if (typeof sandboxId !== "string" || typeof port !== "number" || typeof expiresAt !== "number") return undefined;
		if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
		if (expiresAt <= now || expiresAt - now > MAX_TUNNEL_MINUTES * 60_000) return undefined;
		return { sandboxId, port, expiresAt };
	} catch {
		return undefined;
	}
}
