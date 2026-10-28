/**
 * Portable identity helpers shared by every `IdentityDirectory` target: API key secrets, their prefixes and hashes,
 * and role ordering. Uses only WebCrypto and other globals, so it runs on Workers, Bun and Node.
 */
import {
	API_KEY_LAST_USED_PRECISION_MS,
	API_KEY_NAME_MAX_LENGTH,
	HarbourError,
	ROLES,
	type Role,
} from "@harbour/contracts";

/** Every API key secret starts with this, so leaked keys are easy to spot and scan for. */
export const API_KEY_SECRET_PREFIX = "hbr_";

/** How many characters of a secret are kept as its displayable prefix. */
export const API_KEY_PREFIX_LENGTH = 12;

const API_KEY_RANDOM_BYTES = 32;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh API key secret: `hbr_` followed by 32 random bytes in unpadded base64url. */
export function generateApiKeySecret(): string {
	const bytes = new Uint8Array(API_KEY_RANDOM_BYTES);
	crypto.getRandomValues(bytes);
	return `${API_KEY_SECRET_PREFIX}${base64url(bytes)}`;
}

/** The part of a secret that may be stored and shown: its first 12 characters. */
export function apiKeyPrefix(secret: string): string {
	return secret.slice(0, API_KEY_PREFIX_LENGTH);
}

/** The lowercase hex SHA-256 of a secret; what a directory stores and looks keys up by. */
export async function hashApiKeySecret(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/** The strongest of `roles`, or undefined when there are none. */
export function strongestRole(roles: Iterable<Role>): Role | undefined {
	let strongest: Role | undefined;
	for (const role of roles) {
		if (strongest === undefined || ROLES.indexOf(role) > ROLES.indexOf(strongest)) strongest = role;
	}
	return strongest;
}

/**
 * An API key's name as issued: trimmed, or undefined when none was given. Rejects with `invalid` one that is not a
 * string, is empty once trimmed or is longer than `API_KEY_NAME_MAX_LENGTH`.
 */
export function apiKeyName(name: unknown): string | undefined {
	if (name === undefined) return undefined;
	if (typeof name !== "string" || name.trim() === "")
		throw new HarbourError("invalid", "a key's name must not be empty");
	const trimmed = name.trim();
	if (trimmed.length > API_KEY_NAME_MAX_LENGTH) {
		throw new HarbourError("invalid", `a key's name is at most ${API_KEY_NAME_MAX_LENGTH} characters`);
	}
	return trimmed;
}

/** Whether a use at `now` should be recorded over `recorded`: none yet, or one older than the precision. */
export function lastUsedIsStale(recorded: number | undefined, now: number): boolean {
	return recorded === undefined || now - recorded >= API_KEY_LAST_USED_PRECISION_MS;
}
