/**
 * The WebAuthn checks Kantel makes as a relying party (Web Authentication Level 3, "Registering a New Credential" and
 * "Verifying an Authentication Assertion"), with no attestation: Kantel asks for `attestation: "none"` and trusts a
 * passkey because the signed-in person registered it, never because of who made the authenticator. Portable
 * (WebCrypto only), so it runs on Workers, Bun and Node.
 *
 * Takes ES256 (P-256), EdDSA (Ed25519) and RS256 keys: between them every platform authenticator and security key in
 * use. User verification (a fingerprint, a face or a PIN) is required for registering and for every assertion.
 *
 * The challenge itself is the caller's: `verifyRegistration` and `verifyAssertion` return the challenge the client
 * signed (`clientChallenge`) for the caller to look up and use up in its own store. Every other check is made here,
 * and a failure throws `WebAuthnError` with a `PasskeyRefusal` reason.
 */
import type { PasskeyAssertion, PasskeyAttestation, PasskeyRefusal } from "@kantel/contracts";

/** COSE algorithm identifiers Kantel takes, in the order it prefers them. */
export const COSE_ALGORITHMS = { EdDSA: -8, ES256: -7, RS256: -257 } as const;
export const SUPPORTED_COSE_ALGORITHMS: readonly number[] = [
	COSE_ALGORITHMS.EdDSA,
	COSE_ALGORITHMS.ES256,
	COSE_ALGORITHMS.RS256,
];

export class WebAuthnError extends Error {
	readonly reason: PasskeyRefusal;
	constructor(reason: PasskeyRefusal, message: string) {
		super(message);
		this.name = "WebAuthnError";
		this.reason = reason;
	}
}

const malformed = (message: string) => new WebAuthnError("malformed", message);

/** Text must be valid UTF-8: a decoder that throws rather than substitutes. */
const STRICT_UTF8 = { fatal: true, ignoreBOM: false };

// Base64url.

/** Unpadded base64url of `bytes`. */
export function toBase64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of unpadded (or padded) base64url; throws `malformed` on anything else. */
export function fromBase64url(text: unknown): Uint8Array<ArrayBuffer> {
	if (typeof text !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw malformed("Not base64url");
	const base64 = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
	let binary: string;
	try {
		binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	} catch {
		throw malformed("Not base64url");
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** A fresh random challenge: 32 bytes, in base64url. */
export function randomChallenge(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return toBase64url(bytes);
}

// CBOR (RFC 8949): the subset authenticators write. Definite lengths only, as CTAP2's canonical CBOR requires.

type Cbor = number | bigint | string | boolean | null | undefined | Uint8Array | Cbor[] | CborMap;
type CborMap = Map<number | string, Cbor>;

/** The most nesting a CBOR item may have here: an attestation object nests three deep. */
const CBOR_MAX_DEPTH = 16;

/** Decodes one CBOR item from `bytes` at `offset`; returns it and where it ends. */
export function decodeCbor(bytes: Uint8Array, offset = 0, depth = 0): { readonly value: Cbor; readonly end: number } {
	if (depth > CBOR_MAX_DEPTH) throw malformed("CBOR nests too deep");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const need = (count: number, at: number) => {
		if (at + count > bytes.length) throw malformed("CBOR ends early");
	};
	need(1, offset);
	const initial = bytes[offset]!;
	const major = initial >> 5;
	const info = initial & 0x1f;
	let at = offset + 1;
	let argument: number;
	if (info < 24) argument = info;
	else if (info === 24) {
		need(1, at);
		argument = bytes[at]!;
		at += 1;
	} else if (info === 25) {
		need(2, at);
		argument = view.getUint16(at);
		at += 2;
	} else if (info === 26) {
		need(4, at);
		argument = view.getUint32(at);
		at += 4;
	} else if (info === 27) {
		need(8, at);
		const big = view.getBigUint64(at);
		at += 8;
		if (major === 7) {
			return { value: view.getFloat64(at - 8), end: at };
		}
		if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed("CBOR integer too large");
		argument = Number(big);
	} else {
		throw malformed("Indefinite or reserved CBOR lengths are not taken");
	}
	switch (major) {
		case 0:
			return { value: argument, end: at };
		case 1:
			return { value: -1 - argument, end: at };
		case 2:
			need(argument, at);
			return { value: bytes.slice(at, at + argument), end: at + argument };
		case 3:
			need(argument, at);
			try {
				return {
					value: new TextDecoder("utf-8", STRICT_UTF8).decode(bytes.subarray(at, at + argument)),
					end: at + argument,
				};
			} catch {
				throw malformed("CBOR text is not UTF-8");
			}
		case 4: {
			const items: Cbor[] = [];
			for (let index = 0; index < argument; index++) {
				const item = decodeCbor(bytes, at, depth + 1);
				items.push(item.value);
				at = item.end;
			}
			return { value: items, end: at };
		}
		case 5: {
			const map: CborMap = new Map();
			for (let index = 0; index < argument; index++) {
				const key = decodeCbor(bytes, at, depth + 1);
				if (typeof key.value !== "number" && typeof key.value !== "string") throw malformed("CBOR map key");
				if (map.has(key.value)) throw malformed("CBOR map repeats a key");
				const value = decodeCbor(bytes, key.end, depth + 1);
				map.set(key.value, value.value);
				at = value.end;
			}
			return { value: map, end: at };
		}
		case 6:
			// A tag: the tagged item stands for itself here.
			return decodeCbor(bytes, at, depth + 1);
		default:
			if (info === 20) return { value: false, end: at };
			if (info === 21) return { value: true, end: at };
			if (info === 22) return { value: null, end: at };
			if (info === 23) return { value: undefined, end: at };
			if (info === 25) return { value: halfFloat(argument), end: at };
			if (info === 26) return { value: view.getFloat32(at - 4), end: at };
			throw malformed("Unknown CBOR simple value");
	}
}

function halfFloat(bits: number): number {
	const exponent = (bits >> 10) & 0x1f;
	const fraction = bits & 0x3ff;
	const sign = bits & 0x8000 ? -1 : 1;
	if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
	if (exponent === 31) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
	return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

// Authenticator data.

export interface AuthenticatorData {
	readonly rpIdHash: Uint8Array;
	readonly userPresent: boolean;
	readonly userVerified: boolean;
	readonly backupEligible: boolean;
	readonly backedUp: boolean;
	readonly signCount: number;
	/** Present when the authenticator attested a new credential (registration). */
	readonly attested?: { readonly credentialId: Uint8Array; readonly publicKey: CborMap };
}

/** Reads authenticator data: the RP ID hash, flags, counter and, on registration, the new credential and its key. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
	if (bytes.length < 37) throw malformed("Authenticator data is too short");
	const flags = bytes[32]!;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const signCount = view.getUint32(33);
	const base = {
		rpIdHash: bytes.slice(0, 32),
		userPresent: (flags & 0x01) !== 0,
		userVerified: (flags & 0x04) !== 0,
		backupEligible: (flags & 0x08) !== 0,
		backedUp: (flags & 0x10) !== 0,
		signCount,
	};
	if ((flags & 0x40) === 0) return base;
	// Attested credential data: AAGUID (16), credential ID length (2), credential ID, COSE key.
	if (bytes.length < 55) throw malformed("Attested credential data is too short");
	const length = view.getUint16(53);
	if (length === 0 || length > 1023 || bytes.length < 55 + length) throw malformed("Bad credential ID length");
	const credentialId = bytes.slice(55, 55 + length);
	const key = decodeCbor(bytes, 55 + length);
	if (!(key.value instanceof Map)) throw malformed("The credential's public key is not a COSE key");
	return { ...base, attested: { credentialId, publicKey: key.value } };
}

// Public keys.

/** A public key as a JWK: the members WebCrypto imports for EC, OKP and RSA keys. */
export interface PublicJwk {
	readonly kty: "EC" | "OKP" | "RSA";
	readonly crv?: string;
	readonly x?: string;
	readonly y?: string;
	readonly n?: string;
	readonly e?: string;
}

/** A credential's public key as Kantel stores it: its COSE algorithm and the key as a JWK. */
export interface StoredPublicKey {
	readonly algorithm: number;
	readonly jwk: PublicJwk;
}

const bytesOf = (map: CborMap, key: number): Uint8Array => {
	const value = map.get(key);
	if (!(value instanceof Uint8Array)) throw malformed(`COSE key parameter ${key} is missing`);
	return value;
};

/** The JWK for a COSE key, for ES256, EdDSA (Ed25519) and RS256 only. */
export function coseToStoredKey(cose: CborMap): StoredPublicKey {
	const kty = cose.get(1);
	const alg = cose.get(3);
	if (typeof alg !== "number" || !SUPPORTED_COSE_ALGORITHMS.includes(alg)) {
		throw new WebAuthnError("algorithm", "The passkey's algorithm is not one Kantel takes");
	}
	if (alg === COSE_ALGORITHMS.ES256) {
		if (kty !== 2 || cose.get(-1) !== 1) throw new WebAuthnError("algorithm", "ES256 needs a P-256 key");
		const x = bytesOf(cose, -2);
		const y = bytesOf(cose, -3);
		if (x.length !== 32 || y.length !== 32) throw malformed("A P-256 key's coordinates are 32 bytes");
		return { algorithm: alg, jwk: { kty: "EC", crv: "P-256", x: toBase64url(x), y: toBase64url(y) } };
	}
	if (alg === COSE_ALGORITHMS.EdDSA) {
		if (kty !== 1 || cose.get(-1) !== 6) throw new WebAuthnError("algorithm", "EdDSA needs an Ed25519 key");
		const x = bytesOf(cose, -2);
		if (x.length !== 32) throw malformed("An Ed25519 key is 32 bytes");
		return { algorithm: alg, jwk: { kty: "OKP", crv: "Ed25519", x: toBase64url(x) } };
	}
	if (kty !== 3) throw new WebAuthnError("algorithm", "RS256 needs an RSA key");
	const n = bytesOf(cose, -1);
	const e = bytesOf(cose, -2);
	if (n.length < 256) throw new WebAuthnError("algorithm", "RSA keys must be at least 2048 bits");
	return { algorithm: alg, jwk: { kty: "RSA", n: toBase64url(n), e: toBase64url(e) } };
}

/** An ECDSA signature's DER `SEQUENCE { r, s }` as WebCrypto's raw `r || s`, each `size` bytes. */
export function derToRawSignature(der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> {
	const fail = () => new WebAuthnError("signature", "The signature is not a DER ECDSA signature");
	let at = 0;
	if (der[at++] !== 0x30) throw fail();
	let length = der[at++] ?? 0;
	if (length & 0x80) {
		if (length !== 0x81) throw fail();
		length = der[at++] ?? 0;
	}
	if (at + length !== der.length) throw fail();
	const raw = new Uint8Array(size * 2);
	for (const half of [0, 1]) {
		if (der[at++] !== 0x02) throw fail();
		const intLength = der[at++] ?? 0;
		if (intLength === 0 || at + intLength > der.length) throw fail();
		let value = der.subarray(at, at + intLength);
		at += intLength;
		while (value.length > size && value[0] === 0) value = value.subarray(1);
		if (value.length > size) throw fail();
		raw.set(value, half * size + (size - value.length));
	}
	if (at !== der.length) throw fail();
	return raw;
}

async function verifySignature(
	key: StoredPublicKey,
	signature: Uint8Array<ArrayBuffer>,
	data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
	// Node's and Workers' libraries type a JWK differently; the members imported are the same.
	const jwk = key.jwk as never;
	try {
		if (key.algorithm === COSE_ALGORITHMS.ES256) {
			const imported = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
				"verify",
			]);
			const raw = derToRawSignature(signature);
			return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, imported, raw, data);
		}
		if (key.algorithm === COSE_ALGORITHMS.EdDSA) {
			const imported = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
			return await crypto.subtle.verify({ name: "Ed25519" }, imported, signature, data);
		}
		if (key.algorithm === COSE_ALGORITHMS.RS256) {
			const imported = await crypto.subtle.importKey(
				"jwk",
				jwk,
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			);
			return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, imported, signature, data);
		}
	} catch (error) {
		if (error instanceof WebAuthnError) throw error;
		return false;
	}
	throw new WebAuthnError("algorithm", "The passkey's algorithm is not one Kantel takes");
}

// Client data.

interface ClientData {
	readonly challenge: string;
	readonly origin: string;
}

function readClientData(encoded: unknown, type: "webauthn.create" | "webauthn.get"): ClientData {
	const bytes = fromBase64url(encoded);
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", STRICT_UTF8).decode(bytes));
	} catch {
		throw malformed("The client data is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null) throw malformed("The client data is not an object");
	const data = parsed as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
	if (data.type !== type) throw malformed(`The client data is not ${type}`);
	if (typeof data.challenge !== "string" || data.challenge === "") throw malformed("The client data has no challenge");
	if (typeof data.origin !== "string") throw malformed("The client data has no origin");
	// A passkey asked for from inside another site's frame is never one of Kantel's approvals.
	if (data.crossOrigin === true) throw new WebAuthnError("origin", "The passkey was asked for from another site");
	return { challenge: data.challenge.replace(/=+$/, ""), origin: data.origin };
}

/** The client data's challenge, read before any other check, so the caller can find and use up its own record. */
export function clientChallengeOf(encoded: unknown, type: "webauthn.create" | "webauthn.get"): string {
	return readClientData(encoded, type).challenge;
}

/** Where a credential must come from: the relying party's ID and its one origin. */
export interface ExpectedRelyingParty {
	readonly id: string;
	readonly origin: string;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
	return difference === 0;
}

async function checkRelyingParty(
	clientData: ClientData,
	authData: AuthenticatorData,
	expected: ExpectedRelyingParty,
): Promise<void> {
	if (clientData.origin !== expected.origin)
		throw new WebAuthnError("origin", "The passkey was used on another origin");
	const rpIdHash = await sha256(new TextEncoder().encode(expected.id));
	if (!equalBytes(authData.rpIdHash, rpIdHash)) {
		throw new WebAuthnError("origin", "The passkey is for another relying party");
	}
	if (!authData.userPresent) throw new WebAuthnError("user_verification", "The authenticator saw no one present");
	if (!authData.userVerified) {
		throw new WebAuthnError("user_verification", "The authenticator did not verify the person");
	}
}

// Registration.

export interface VerifiedRegistration {
	/** The credential ID, base64url. */
	readonly credentialId: string;
	readonly publicKey: StoredPublicKey;
	readonly signCount: number;
	readonly backedUp: boolean;
	readonly transports?: readonly string[];
}

/**
 * Checks a new passkey from `navigator.credentials.create` against the relying party and the challenge Kantel issued
 * for it (`expectedChallenge`, which the caller has already taken from its store). The attestation statement is not
 * checked: Kantel asks for none.
 */
export async function verifyRegistration(
	attestation: PasskeyAttestation,
	expectedChallenge: string,
	expected: ExpectedRelyingParty,
): Promise<VerifiedRegistration> {
	if (attestation?.type !== "public-key" || typeof attestation.response !== "object") {
		throw malformed("Not a public key credential");
	}
	const clientData = readClientData(attestation.response.clientDataJSON, "webauthn.create");
	if (clientData.challenge !== expectedChallenge) throw new WebAuthnError("challenge", "The challenge doesn't match");
	const object = decodeCbor(fromBase64url(attestation.response.attestationObject)).value;
	if (!(object instanceof Map)) throw malformed("The attestation object is not a CBOR map");
	const authDataBytes = object.get("authData");
	if (!(authDataBytes instanceof Uint8Array)) throw malformed("The attestation object has no authenticator data");
	const authData = parseAuthenticatorData(authDataBytes);
	await checkRelyingParty(clientData, authData, expected);
	const attested = authData.attested;
	if (attested === undefined) throw malformed("The authenticator attested no credential");
	const credentialId = toBase64url(attested.credentialId);
	if (fromBase64urlSafe(attestation.rawId) !== credentialId || fromBase64urlSafe(attestation.id) !== credentialId) {
		throw malformed("The credential ID doesn't match the authenticator's");
	}
	const transports = attestation.response.transports;
	const known =
		Array.isArray(transports) && transports.every((transport) => typeof transport === "string")
			? transports.slice(0, 8)
			: undefined;
	return {
		credentialId,
		publicKey: coseToStoredKey(attested.publicKey),
		signCount: authData.signCount,
		backedUp: authData.backedUp,
		...(known === undefined || known.length === 0 ? {} : { transports: known }),
	};
}

/** `text` re-encoded as unpadded base64url, or `undefined` when it isn't base64url. */
function fromBase64urlSafe(text: unknown): string | undefined {
	try {
		return toBase64url(fromBase64url(text));
	} catch {
		return undefined;
	}
}

// Assertions.

/** The credential an assertion must be signed by, as stored. */
export interface ExpectedCredential {
	readonly credentialId: string;
	readonly publicKey: StoredPublicKey;
	readonly signCount: number;
}

/**
 * Checks an assertion from `navigator.credentials.get`: the client data's type, challenge and origin, the RP ID hash,
 * user presence and verification, the signature over the authenticator data and the client data's hash, and the
 * counter. Returns the counter to store. `expectedChallenge` is the one the caller took from its store.
 */
export async function verifyAssertion(
	assertion: PasskeyAssertion,
	expectedChallenge: string,
	expected: ExpectedRelyingParty,
	credential: ExpectedCredential,
): Promise<{ readonly signCount: number; readonly backedUp: boolean }> {
	if (assertion?.type !== "public-key" || typeof assertion.response !== "object") {
		throw malformed("Not a public key credential");
	}
	if (fromBase64urlSafe(assertion.rawId) !== credential.credentialId) {
		throw new WebAuthnError("credential", "The assertion is from another passkey");
	}
	const clientDataBytes = fromBase64url(assertion.response.clientDataJSON);
	const clientData = readClientData(assertion.response.clientDataJSON, "webauthn.get");
	if (clientData.challenge !== expectedChallenge) throw new WebAuthnError("challenge", "The challenge doesn't match");
	const authDataBytes = fromBase64url(assertion.response.authenticatorData);
	const authData = parseAuthenticatorData(authDataBytes);
	await checkRelyingParty(clientData, authData, expected);
	const signature = fromBase64url(assertion.response.signature);
	const signed = new Uint8Array(authDataBytes.length + 32);
	signed.set(authDataBytes, 0);
	signed.set(await sha256(clientDataBytes), authDataBytes.length);
	if (!(await verifySignature(credential.publicKey, signature, signed))) {
		throw new WebAuthnError("signature", "The passkey's signature doesn't verify");
	}
	// A counter that doesn't move on, when either side counts at all, means two copies of one key are in use.
	if ((authData.signCount !== 0 || credential.signCount !== 0) && authData.signCount <= credential.signCount) {
		throw new WebAuthnError("counter", "The passkey's counter went backwards");
	}
	return { signCount: authData.signCount, backedUp: authData.backedUp };
}
