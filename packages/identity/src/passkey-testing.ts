/**
 * A software authenticator for tests: it makes passkeys and signs assertions as a browser and a platform authenticator
 * would, with real keys, so `@harbour/identity/passkey` and the vault's approval API can be tested end to end without
 * a browser. Portable (WebCrypto only). Every knob a test needs to make a bad response is an option.
 */
import type {
	PasskeyAssertion,
	PasskeyAttestation,
	PasskeyChallenge,
	PasskeyRegistrationOptions,
} from "@harbour/contracts";
import type { CryptoKey } from "jose";
import { COSE_ALGORITHMS, toBase64url } from "./webauthn.ts";

interface CryptoKeyPair {
	readonly privateKey: CryptoKey;
	readonly publicKey: CryptoKey;
}

type CborValue = number | string | boolean | Uint8Array | CborValue[] | Map<number | string, CborValue>;

function head(major: number, value: number): number[] {
	if (value < 24) return [(major << 5) | value];
	if (value < 0x100) return [(major << 5) | 24, value];
	if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
	return [(major << 5) | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** CBOR for the values an authenticator writes. */
export function encodeCbor(value: CborValue): Uint8Array<ArrayBuffer> {
	const out: number[] = [];
	const write = (item: CborValue): void => {
		if (typeof item === "number") {
			out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)));
		} else if (typeof item === "string") {
			const bytes = new TextEncoder().encode(item);
			out.push(...head(3, bytes.length), ...bytes);
		} else if (typeof item === "boolean") {
			out.push(item ? 0xf5 : 0xf4);
		} else if (item instanceof Uint8Array) {
			out.push(...head(2, item.length), ...item);
		} else if (Array.isArray(item)) {
			out.push(...head(4, item.length));
			for (const element of item) write(element);
		} else {
			out.push(...head(5, item.size));
			for (const [key, element] of item) {
				write(key);
				write(element);
			}
		}
	};
	write(value);
	return new Uint8Array(out);
}

export type SoftwareAlgorithm = "ES256" | "EdDSA" | "RS256";

export interface SoftwarePasskey {
	readonly credentialId: Uint8Array<ArrayBuffer>;
	readonly algorithm: SoftwareAlgorithm;
	readonly privateKey: CryptoKey;
	readonly rpId: string;
	readonly userHandle: string;
	signCount: number;
}

export interface SoftwareAuthenticatorOptions {
	/** The origin the "browser" is on. */
	readonly origin: string;
	/** The algorithm new passkeys use. Default ES256. */
	readonly algorithm?: SoftwareAlgorithm;
	/** Whether the counter moves on with each use (a security key) or stays 0 (a synced passkey). Default 0. */
	readonly counting?: boolean;
}

/** What a test may change about one ceremony, to make a bad response. */
export interface CeremonyOverrides {
	readonly origin?: string;
	readonly rpId?: string;
	readonly challenge?: string;
	readonly type?: string;
	readonly crossOrigin?: boolean;
	readonly userVerified?: boolean;
	readonly userPresent?: boolean;
	readonly signCount?: number;
	/** Flip a byte of the signature. */
	readonly corruptSignature?: boolean;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const fromB64url = (text: string): Uint8Array<ArrayBuffer> => {
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** WebCrypto's raw ECDSA signature as the DER `SEQUENCE { r, s }` authenticators send. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
	const integer = (bytes: Uint8Array): number[] => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		const trimmed = [...bytes.subarray(start)];
		if ((trimmed[0] ?? 0) & 0x80) trimmed.unshift(0);
		return [0x02, trimmed.length, ...trimmed];
	};
	const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
	return new Uint8Array([0x30, body.length, ...body]);
}

async function keyPair(algorithm: SoftwareAlgorithm): Promise<CryptoKeyPair> {
	if (algorithm === "ES256") {
		return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
			"verify",
		])) as CryptoKeyPair;
	}
	if (algorithm === "EdDSA") {
		return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
	}
	return (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
}

async function coseKey(algorithm: SoftwareAlgorithm, publicKey: CryptoKey): Promise<Map<number, CborValue>> {
	const jwk = await crypto.subtle.exportKey("jwk", publicKey);
	if (algorithm === "ES256") {
		return new Map<number, CborValue>([
			[1, 2],
			[3, COSE_ALGORITHMS.ES256],
			[-1, 1],
			[-2, fromB64url(jwk.x!)],
			[-3, fromB64url(jwk.y!)],
		]);
	}
	if (algorithm === "EdDSA") {
		return new Map<number, CborValue>([
			[1, 1],
			[3, COSE_ALGORITHMS.EdDSA],
			[-1, 6],
			[-2, fromB64url(jwk.x!)],
		]);
	}
	return new Map<number, CborValue>([
		[1, 3],
		[3, COSE_ALGORITHMS.RS256],
		[-1, fromB64url(jwk.n!)],
		[-2, fromB64url(jwk.e!)],
	]);
}

async function sign(passkey: SoftwarePasskey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	if (passkey.algorithm === "ES256") {
		const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, passkey.privateKey, data));
		return rawToDer(raw);
	}
	const name = passkey.algorithm === "EdDSA" ? "Ed25519" : "RSASSA-PKCS1-v1_5";
	return new Uint8Array(await crypto.subtle.sign({ name }, passkey.privateKey, data));
}

function clientData(
	type: string,
	challenge: string,
	origin: string,
	overrides: CeremonyOverrides,
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		JSON.stringify({
			type: overrides.type ?? type,
			challenge: overrides.challenge ?? challenge,
			origin: overrides.origin ?? origin,
			...(overrides.crossOrigin === undefined ? {} : { crossOrigin: overrides.crossOrigin }),
		}),
	);
}

async function authenticatorData(
	rpId: string,
	signCount: number,
	overrides: CeremonyOverrides,
	attested?: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
	const rpIdHash = await sha256(new TextEncoder().encode(overrides.rpId ?? rpId));
	let flags = 0;
	if (overrides.userPresent !== false) flags |= 0x01;
	if (overrides.userVerified !== false) flags |= 0x04;
	if (attested !== undefined) flags |= 0x40;
	const count = overrides.signCount ?? signCount;
	const bytes = [
		...rpIdHash,
		flags,
		(count >>> 24) & 0xff,
		(count >>> 16) & 0xff,
		(count >>> 8) & 0xff,
		count & 0xff,
		...(attested ?? []),
	];
	return new Uint8Array(bytes);
}

export interface SoftwareAuthenticator {
	/** Every passkey it has made. */
	readonly passkeys: readonly SoftwarePasskey[];
	/** Makes a passkey for the options, as `navigator.credentials.create` would answer. */
	create(options: PasskeyRegistrationOptions, overrides?: CeremonyOverrides): Promise<PasskeyAttestation>;
	/**
	 * Signs the challenge with the first of its passkeys `allowCredentials` names (or `passkey`), as
	 * `navigator.credentials.get` would answer.
	 */
	get(
		challenge: Pick<PasskeyChallenge, "challenge" | "rpId" | "allowCredentials">,
		overrides?: CeremonyOverrides & { readonly passkey?: SoftwarePasskey },
	): Promise<PasskeyAssertion>;
}

export function createSoftwareAuthenticator(options: SoftwareAuthenticatorOptions): SoftwareAuthenticator {
	const passkeys: SoftwarePasskey[] = [];
	const counting = options.counting ?? false;
	return {
		passkeys,
		async create(creation, overrides = {}) {
			const algorithm = options.algorithm ?? "ES256";
			const pair = await keyPair(algorithm);
			const credentialId = crypto.getRandomValues(new Uint8Array(16));
			const passkey: SoftwarePasskey = {
				credentialId,
				algorithm,
				privateKey: pair.privateKey,
				rpId: creation.rp.id,
				userHandle: creation.user.id,
				signCount: 0,
			};
			passkeys.push(passkey);
			const key = encodeCbor(await coseKey(algorithm, pair.publicKey));
			const attested = new Uint8Array([
				...new Uint8Array(16),
				credentialId.length >> 8,
				credentialId.length & 0xff,
				...credentialId,
				...key,
			]);
			const authData = await authenticatorData(creation.rp.id, 0, overrides, attested);
			const attestationObject = encodeCbor(
				new Map<string, CborValue>([
					["fmt", "none"],
					["attStmt", new Map()],
					["authData", authData],
				]),
			);
			const id = toBase64url(credentialId);
			return {
				id,
				rawId: id,
				type: "public-key",
				response: {
					clientDataJSON: toBase64url(clientData("webauthn.create", creation.challenge, options.origin, overrides)),
					attestationObject: toBase64url(attestationObject),
					transports: ["internal"],
				},
				authenticatorAttachment: "platform",
				clientExtensionResults: {},
			};
		},

		async get(request, overrides = {}) {
			const allowed = new Set(request.allowCredentials.map((descriptor) => descriptor.id));
			const passkey =
				overrides.passkey ??
				passkeys.find(
					(candidate) =>
						candidate.rpId === request.rpId && (allowed.size === 0 || allowed.has(toBase64url(candidate.credentialId))),
				);
			if (passkey === undefined) throw new Error("The software authenticator has no passkey for this request");
			if (counting) passkey.signCount += 1;
			const authData = await authenticatorData(passkey.rpId, passkey.signCount, overrides);
			const client = clientData("webauthn.get", request.challenge, options.origin, overrides);
			const signed = new Uint8Array([...authData, ...(await sha256(client))]);
			const signature = await sign(passkey, signed);
			if (overrides.corruptSignature === true) signature[signature.length - 1]! ^= 0x01;
			const id = toBase64url(passkey.credentialId);
			return {
				id,
				rawId: id,
				type: "public-key",
				response: {
					clientDataJSON: toBase64url(client),
					authenticatorData: toBase64url(authData),
					signature: toBase64url(signature),
					userHandle: passkey.userHandle,
				},
				authenticatorAttachment: "platform",
				clientExtensionResults: {},
			};
		},
	};
}
