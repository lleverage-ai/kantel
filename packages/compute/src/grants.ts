/**
 * Fetch grants for host-to-host sync (docs/design/disk-store.md, 2c): the control plane's word that one host may fetch
 * one version of a disk from others, for 15 minutes. A grant is signed with the control plane's Ed25519 grant key, whose
 * public key hosts get in their welcome (`HostWelcome.grantKey`); a holder serves a fetch only with a grant naming it in
 * `from` and the mesh peer asking as `to`.
 *
 * A signed grant is one string, `<payload>.<signature>`: the payload is the grant's JSON in base64url, and the
 * signature is Ed25519 over the payload's ASCII text, in base64url, so a verifier checks the bytes it was given and
 * never has to write the JSON again. Keys are base64url too: the public key its 32 raw bytes, the private key its PKCS #8
 * bytes (kept sealed, never sent). WebCrypto only, so it runs on Node, Bun and Cloudflare Workers alike.
 */
import { base64ToBytes, bytesToBase64 } from "./util.ts";

/** What a disk store object is: sticky disks now; templates' root filesystems and snapshots, saved snapshots and sandboxes' disks later. */
export const DISK_KINDS = ["sticky", "rootfs", "template", "snapshot", "sandbox"] as const;
export type DiskKind = (typeof DISK_KINDS)[number];

/** How long a grant is valid from when it is signed. */
export const GRANT_TTL_MS = 15 * 60_000;

/** The control plane's word that host `to` may fetch `version` of an object from the hosts in `from`, until `exp`. */
export interface DiskGrant {
	readonly kind: DiskKind;
	readonly objectId: string;
	readonly version: string;
	/** The account the object is the data of. */
	readonly accountId: string;
	/** The hosts it may fetch from. */
	readonly from: readonly string[];
	/** The host that may fetch. */
	readonly to: string;
	/** When it stops being valid, in milliseconds since the epoch. */
	readonly exp: number;
}

/** A grant key: its public key (base64url, 32 bytes) and a signer over its private key. */
export interface GrantKey {
	readonly publicKey: string;
	/** `grant`, signed: `<payload>.<signature>`. */
	sign(grant: DiskGrant): Promise<string>;
}

type CryptoKeyOf = Parameters<typeof crypto.subtle.sign>[1];

const encoder = new TextEncoder();

const toBase64url = (bytes: Uint8Array): string =>
	bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> => {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url");
	const padded = text.replaceAll("-", "+").replaceAll("_", "/");
	return base64ToBytes(padded + "=".repeat((4 - (padded.length % 4)) % 4));
};

function signerOver(publicKey: string, privateKey: CryptoKeyOf): GrantKey {
	return {
		publicKey,
		async sign(grant) {
			const payload = toBase64url(encoder.encode(JSON.stringify(grant)));
			const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(payload)));
			return `${payload}.${toBase64url(signature)}`;
		},
	};
}

/** A new grant key, with its private key's PKCS #8 bytes to keep (sealed). */
export async function createGrantKey(): Promise<{ readonly key: GrantKey; readonly privateKey: Uint8Array }> {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as {
		readonly publicKey: CryptoKeyOf;
		readonly privateKey: CryptoKeyOf;
	};
	// Exports are bytes for these formats (Workers' types allow a JWK for any format).
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
	return { key: signerOver(toBase64url(raw), pair.privateKey), privateKey: pkcs8 };
}

/** The grant key `createGrantKey` made, from its public key and its private key's PKCS #8 bytes. */
export async function grantKeyFrom(publicKey: string, privateKey: Uint8Array): Promise<GrantKey> {
	const key = (await crypto.subtle.importKey("pkcs8", new Uint8Array(privateKey), { name: "Ed25519" }, false, [
		"sign",
	])) as unknown as CryptoKeyOf;
	return signerOver(publicKey, key);
}

/**
 * The grant `token` carries, when `publicKey` signed it and it is still valid at `now`; undefined when it isn't signed by
 * that key, isn't a grant, or has expired.
 */
export async function verifyGrant(publicKey: string, token: string, now: number): Promise<DiskGrant | undefined> {
	const [payload, signature, ...rest] = token.split(".");
	if (payload === undefined || signature === undefined || rest.length > 0) return undefined;
	try {
		const key = await crypto.subtle.importKey("raw", fromBase64url(publicKey), { name: "Ed25519" }, false, ["verify"]);
		const signed = await crypto.subtle.verify("Ed25519", key, fromBase64url(signature), encoder.encode(payload));
		if (!signed) return undefined;
		const grant = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as unknown;
		if (!isGrant(grant) || grant.exp <= now) return undefined;
		return grant;
	} catch {
		return undefined;
	}
}

function isGrant(value: unknown): value is DiskGrant {
	if (typeof value !== "object" || value === null) return false;
	const grant = value as { readonly [key: string]: unknown };
	return (
		typeof grant.kind === "string" &&
		(DISK_KINDS as readonly string[]).includes(grant.kind) &&
		typeof grant.objectId === "string" &&
		typeof grant.version === "string" &&
		typeof grant.accountId === "string" &&
		Array.isArray(grant.from) &&
		grant.from.every((host) => typeof host === "string") &&
		typeof grant.to === "string" &&
		typeof grant.exp === "number"
	);
}
