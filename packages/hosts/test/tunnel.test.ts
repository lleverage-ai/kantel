// Tunnel tickets: only the gateway's secret signs one, for one sandbox's port, until it expires and for an hour at
// most; anything else, forged, altered, expired or malformed, is refused.
import { describe, expect, it } from "vitest";
import { MAX_TUNNEL_MINUTES, signTunnel, verifyTunnel } from "../src/tunnel.ts";

const secret = crypto.getRandomValues(new Uint8Array(32));
const now = 1_800_000_000_000;
const grant = { sandboxId: "sbx_4kq9x2mt", port: 22, expiresAt: now + 10 * 60_000 };

const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
const payloadOf = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
async function hmac(key: Uint8Array, text: string): Promise<string> {
	const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(text))));
}
/** Signed as the gateway signs, whatever the payload: what's refused is then the payload's, not the signature's. */
const signed = async (value: unknown) => {
	const payload = payloadOf(value);
	return `${payload}.${await hmac(secret, `kantel-tunnel/v1.${payload}`)}`;
};

describe("tunnel tickets", () => {
	it("carry their grant until it expires", async () => {
		const ticket = await signTunnel(secret, grant);
		expect(await verifyTunnel(secret, ticket, now)).toEqual(grant);
		expect(await verifyTunnel(secret, ticket, grant.expiresAt - 1)).toEqual(grant);
		expect(await verifyTunnel(secret, ticket, grant.expiresAt)).toBeUndefined();
		expect(await verifyTunnel(secret, ticket, grant.expiresAt + 60_000)).toBeUndefined();
	});

	it("refuse a ticket another secret signed", async () => {
		const forged = await signTunnel(crypto.getRandomValues(new Uint8Array(32)), grant);
		expect(await verifyTunnel(secret, forged, now)).toBeUndefined();
		expect(await verifyTunnel(secret, await signTunnel(new Uint8Array(32), grant), now)).toBeUndefined();
	});

	it("refuse a ticket whose grant was changed under its signature", async () => {
		const ticket = await signTunnel(secret, grant);
		const signature = ticket.split(".")[1];
		for (const changed of [
			{ ...grant, sandboxId: "sbx_someone" },
			{ ...grant, port: 2375 },
			{ ...grant, expiresAt: grant.expiresAt + 60_000 },
		]) {
			const altered = `${payloadOf([changed.sandboxId, changed.port, changed.expiresAt])}.${signature}`;
			expect(await verifyTunnel(secret, altered, now)).toBeUndefined();
		}
		expect(await verifyTunnel(secret, `${ticket.slice(0, -2)}AA`, now)).toBeUndefined();
		expect(await verifyTunnel(secret, `${ticket.split(".")[0]}.`, now)).toBeUndefined();
	});

	it("refuse a ticket signed without the tunnel's domain, as one signed for something else would be", async () => {
		const payload = payloadOf([grant.sandboxId, grant.port, grant.expiresAt]);
		expect(await verifyTunnel(secret, `${payload}.${await hmac(secret, payload)}`, now)).toBeUndefined();
	});

	it(`refuse a ticket good for more than ${MAX_TUNNEL_MINUTES} minutes, even one the gateway signed`, async () => {
		const longest = await signTunnel(secret, { ...grant, expiresAt: now + MAX_TUNNEL_MINUTES * 60_000 });
		expect(await verifyTunnel(secret, longest, now)).toBeDefined();
		const longer = await signTunnel(secret, { ...grant, expiresAt: now + MAX_TUNNEL_MINUTES * 60_000 + 1 });
		expect(await verifyTunnel(secret, longer, now)).toBeUndefined();
		const day = await signTunnel(secret, { ...grant, expiresAt: now + 24 * 3_600_000 });
		expect(await verifyTunnel(secret, day, now)).toBeUndefined();
	});

	it("refuse malformed tickets", async () => {
		const valid = await signTunnel(secret, grant);
		for (const ticket of ["", ".", "abc", `${valid}.extra`, "!!!.???", `${valid.split(".")[0]}`]) {
			expect(await verifyTunnel(secret, ticket, now)).toBeUndefined();
		}
		for (const value of [
			"not an array",
			[grant.sandboxId, grant.port],
			[grant.sandboxId, grant.port, grant.expiresAt, "extra"],
			[42, grant.port, grant.expiresAt],
			[grant.sandboxId, "22", grant.expiresAt],
			[grant.sandboxId, 0, grant.expiresAt],
			[grant.sandboxId, 65_536, grant.expiresAt],
			[grant.sandboxId, 22.5, grant.expiresAt],
			[grant.sandboxId, grant.port, String(grant.expiresAt)],
		]) {
			expect(await verifyTunnel(secret, await signed(value), now)).toBeUndefined();
		}
		const notJson = base64url(encoder.encode("{nope"));
		expect(await verifyTunnel(secret, `${notJson}.${await hmac(secret, `kantel-tunnel/v1.${notJson}`)}`, now)).toBe(
			undefined,
		);
	});
});
