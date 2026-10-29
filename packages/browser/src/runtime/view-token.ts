/**
 * View tokens: what a live-view or replay link carries instead of a credential. A token names one browser (the host's
 * ID for it), whether it is a live view or a replay, whether its viewer may control the browser, and when it expires.
 * It is an HMAC-SHA256-signed claim under `HARBOUR_BROWSER_VIEW_KEY`, so the gateway checks it without a lookup, and it
 * opens that one view and nothing else: it is not an API credential. Tokens never go into tool results, transcripts,
 * logs or audit events; the person or app that asked for one gets it in the link.
 *
 * Portable: WebCrypto only.
 */
import { HarbourError } from "@harbour/contracts";

export type BrowserViewMode = "live" | "replay";

export interface BrowserViewClaims {
	/** The host's ID for the browser (the provider session ID). */
	readonly browser: string;
	readonly mode: BrowserViewMode;
	/** Whether the viewer's input reaches the browser (live only). Embeds are always watch-only. */
	readonly control: boolean;
	/** Epoch milliseconds. */
	readonly expiresAt: number;
}

export interface BrowserViewSigner {
	sign(claims: BrowserViewClaims): Promise<string>;
	/** The token's claims, or `undefined` when it is malformed, forged or expired. */
	verify(token: string, now: number): Promise<BrowserViewClaims | undefined>;
}

/** The longest a view token may last. */
export const MAX_VIEW_MINUTES = 60;
/** A token is ASCII base64url: `<claims>.<signature>`. Anything longer is refused before any crypto. */
const MAX_TOKEN_LENGTH = 512;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
	try {
		const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return undefined;
	}
}

export function createBrowserViewSigner(secret: string): BrowserViewSigner {
	if (secret.length < 32) throw new HarbourError("invalid", "The browser view key must be at least 32 characters");
	const key = crypto.subtle.importKey(
		"raw",
		encoder.encode(`harbour-browser-view:${secret}`),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	return {
		async sign(claims) {
			const body = base64url(
				encoder.encode(
					JSON.stringify({ b: claims.browser, m: claims.mode, c: claims.control ? 1 : 0, e: claims.expiresAt }),
				),
			);
			const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key, encoder.encode(body)));
			return `${body}.${base64url(signature)}`;
		},
		async verify(token, now) {
			if (token.length > MAX_TOKEN_LENGTH) return undefined;
			const [body, signature, extra] = token.split(".");
			if (body === undefined || signature === undefined || extra !== undefined) return undefined;
			const signatureBytes = fromBase64url(signature);
			if (signatureBytes === undefined) return undefined;
			const valid = await crypto.subtle.verify(
				"HMAC",
				await key,
				signatureBytes as Uint8Array<ArrayBuffer>,
				encoder.encode(body),
			);
			if (!valid) return undefined;
			const bytes = fromBase64url(body);
			if (bytes === undefined) return undefined;
			let raw: { b?: unknown; m?: unknown; c?: unknown; e?: unknown };
			try {
				raw = JSON.parse(decoder.decode(bytes));
			} catch {
				return undefined;
			}
			if (typeof raw.b !== "string" || raw.b === "" || (raw.m !== "live" && raw.m !== "replay")) return undefined;
			if (typeof raw.e !== "number" || raw.e <= now) return undefined;
			return { browser: raw.b, mode: raw.m, control: raw.c === 1 && raw.m === "live", expiresAt: raw.e };
		},
	};
}
