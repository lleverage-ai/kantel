/**
 * Pure TypeScript + WebCrypto parsing and validation of OpenPGP and OpenSSH private keys used for host-side Git
 * commit and tag signing. Runs identically on Cloudflare Workers, Node and Bun with no external dependencies.
 *
 * Extracts the public key, fingerprint, short key ID, encryption status and (for OpenPGP) User ID email addresses so
 * Kantel can reject malformed or mismatched keys at upload time and hand only public metadata to sandboxes.
 */
import type { computeSchema } from "@kantel/api";
import { KantelError } from "@kantel/contracts";
import { base64ToBytes, bytesToBase64 } from "./util.ts";

export interface ParsedGitSigningKey {
	readonly format: computeSchema.GitSigningFormat;
	readonly keyId: string;
	readonly fingerprint: string;
	readonly publicKey: string;
	readonly userIdEmails: readonly string[];
	readonly encrypted: boolean;
}

const PGP_PRIVATE_BEGIN = "-----BEGIN PGP PRIVATE KEY BLOCK-----";
const PGP_PRIVATE_END = "-----END PGP PRIVATE KEY BLOCK-----";
const PGP_PUBLIC_BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
const PGP_PUBLIC_END = "-----END PGP PUBLIC KEY BLOCK-----";
const SSH_PRIVATE_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const SSH_PRIVATE_END = "-----END OPENSSH PRIVATE KEY-----";
const OPENSSH_MAGIC = "openssh-key-v1\0";

const EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_ALLOWED_EMAILS = 64;

function isValidEmail(value: string): boolean {
	if (value.length === 0 || value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();

/** Normalises, validates and deduplicates allowed committer/tagger email addresses. */
export function normaliseAllowedEmails(emails: readonly string[]): string[] {
	if (emails.length === 0) {
		throw new KantelError("invalid", "At least one allowed email address is required");
	}
	if (emails.length > MAX_ALLOWED_EMAILS) {
		throw new KantelError("invalid", `At most ${MAX_ALLOWED_EMAILS} allowed email addresses may be set`);
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of emails) {
		const email = raw.trim().toLowerCase();
		if (!isValidEmail(email)) {
			throw new KantelError("invalid", `Invalid email address: ${raw}`);
		}
		if (!seen.has(email)) {
			seen.add(email);
			out.push(email);
		}
	}
	return out;
}

/** Parses and validates an ASCII-armored OpenPGP secret key or an OpenSSH private key. */
export async function parseGitSigningKey(
	raw: string,
	requestedFormat?: computeSchema.GitSigningFormat,
): Promise<ParsedGitSigningKey> {
	const text = raw.replace(/\r\n/g, "\n").trim();
	let detected: computeSchema.GitSigningFormat;
	if (text.includes(PGP_PRIVATE_BEGIN)) {
		detected = "gpg";
	} else if (text.includes(SSH_PRIVATE_BEGIN)) {
		detected = "ssh";
	} else {
		throw new KantelError(
			"invalid",
			"Private key must be an ASCII-armored OpenPGP secret key or an OpenSSH private key",
		);
	}
	if (requestedFormat !== undefined && requestedFormat !== detected) {
		throw new KantelError("invalid", `Private key is ${detected}, not ${requestedFormat}`);
	}
	return detected === "gpg" ? parseOpenPgpPrivateKey(text) : parseOpenSshPrivateKey(text);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenPGP (RFC 4880 / RFC 6637 / RFC 9580)

interface PgpPacket {
	readonly tag: number;
	readonly body: Uint8Array;
}

function crc24(bytes: Uint8Array): number {
	let crc = 0xb704ce;
	for (const byte of bytes) {
		crc ^= byte << 16;
		for (let bit = 0; bit < 8; bit++) {
			crc <<= 1;
			if ((crc & 0x1000000) !== 0) crc ^= 0x1864cfb;
		}
	}
	return crc & 0xffffff;
}

function encodeCrc24(bytes: Uint8Array): string {
	const value = crc24(bytes);
	return bytesToBase64(new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]));
}

function decodePgpArmor(text: string): Uint8Array {
	const startIdx = text.indexOf(PGP_PRIVATE_BEGIN);
	const endIdx = text.indexOf(PGP_PRIVATE_END, startIdx + PGP_PRIVATE_BEGIN.length);
	if (startIdx < 0 || endIdx < 0) {
		throw new KantelError("invalid", "OpenPGP private key is missing its armor delimiters");
	}
	const inner = text.slice(startIdx + PGP_PRIVATE_BEGIN.length, endIdx);
	const lines = inner.split("\n").map((line) => line.trim());

	// Skip armor header lines (e.g. `Version: ...`) up to the first blank line after the begin marker.
	let idx = 0;
	while (idx < lines.length && lines[idx] === "") idx++;
	while (idx < lines.length && lines[idx] !== "") {
		// If the first non-empty line isn't an armor header (`Key: value`), treat it as body directly.
		if (!lines[idx]?.includes(":")) break;
		idx++;
	}
	while (idx < lines.length && lines[idx] === "") idx++;

	const payloadLines: string[] = [];
	let expectedCrc: string | undefined;
	for (; idx < lines.length; idx++) {
		const line = lines[idx];
		if (!line) continue;
		if (line.startsWith("=")) {
			expectedCrc = line.slice(1);
			break;
		}
		payloadLines.push(line);
	}
	if (payloadLines.length === 0) {
		throw new KantelError("invalid", "OpenPGP private key armor contains no key data");
	}
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(payloadLines.join(""));
	} catch {
		throw new KantelError("invalid", "OpenPGP private key armor has invalid base64");
	}
	if (expectedCrc !== undefined && expectedCrc !== encodeCrc24(bytes)) {
		throw new KantelError("invalid", "OpenPGP private key armor checksum is invalid");
	}
	return bytes;
}

function parsePgpPackets(bytes: Uint8Array): PgpPacket[] {
	const packets: PgpPacket[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const header = bytes[offset++];
		if (header === undefined || (header & 0x80) === 0) {
			throw new KantelError("invalid", "Invalid OpenPGP packet header");
		}
		if ((header & 0x40) !== 0) {
			// New format packet (RFC 4880 §4.2.2)
			const tag = header & 0x3f;
			const chunks: Uint8Array[] = [];
			let total = 0;
			while (true) {
				const first = bytes[offset++];
				if (first === undefined) throw new KantelError("invalid", "Truncated OpenPGP packet length");
				let length: number;
				let partial = false;
				if (first < 192) {
					length = first;
				} else if (first <= 223) {
					const second = bytes[offset++];
					if (second === undefined) throw new KantelError("invalid", "Truncated OpenPGP packet length");
					length = ((first - 192) << 8) + second + 192;
				} else if (first === 255) {
					if (offset + 4 > bytes.length) throw new KantelError("invalid", "Truncated OpenPGP packet length");
					length =
						((bytes[offset] ?? 0) * 0x1000000 +
							((bytes[offset + 1] ?? 0) << 16) +
							((bytes[offset + 2] ?? 0) << 8) +
							(bytes[offset + 3] ?? 0)) >>>
						0;
					offset += 4;
				} else {
					length = 1 << (first & 0x1f);
					partial = true;
				}
				if (offset + length > bytes.length) throw new KantelError("invalid", "Truncated OpenPGP packet body");
				chunks.push(bytes.subarray(offset, offset + length));
				total += length;
				offset += length;
				if (!partial) break;
			}
			const body = chunks.length === 1 ? (chunks[0] as Uint8Array) : concatBytes(chunks, total);
			packets.push({ tag, body });
		} else {
			// Old format packet (RFC 4880 §4.2.1)
			const tag = (header >> 2) & 0x0f;
			const lenType = header & 0x03;
			let length: number;
			if (lenType === 0) {
				if (offset + 1 > bytes.length) throw new KantelError("invalid", "Truncated OpenPGP packet length");
				length = bytes[offset++] ?? 0;
			} else if (lenType === 1) {
				if (offset + 2 > bytes.length) throw new KantelError("invalid", "Truncated OpenPGP packet length");
				length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
				offset += 2;
			} else if (lenType === 2) {
				if (offset + 4 > bytes.length) throw new KantelError("invalid", "Truncated OpenPGP packet length");
				length =
					((bytes[offset] ?? 0) * 0x1000000 +
						((bytes[offset + 1] ?? 0) << 16) +
						((bytes[offset + 2] ?? 0) << 8) +
						(bytes[offset + 3] ?? 0)) >>>
					0;
				offset += 4;
			} else {
				length = bytes.length - offset;
			}
			if (offset + length > bytes.length) throw new KantelError("invalid", "Truncated OpenPGP packet body");
			packets.push({ tag, body: bytes.subarray(offset, offset + length) });
			offset += length;
		}
	}
	return packets;
}

function skipPgpMpi(body: Uint8Array, pos: number): number {
	if (pos + 2 > body.length) throw new KantelError("invalid", "Truncated OpenPGP MPI");
	const bits = ((body[pos] ?? 0) << 8) | (body[pos + 1] ?? 0);
	const byteLen = Math.ceil(bits / 8);
	const next = pos + 2 + byteLen;
	if (next > body.length) throw new KantelError("invalid", "Truncated OpenPGP MPI data");
	return next;
}

function skipPgpOid(body: Uint8Array, pos: number): number {
	if (pos + 1 > body.length) throw new KantelError("invalid", "Truncated OpenPGP curve OID");
	const oidLen = body[pos] ?? 0;
	if (oidLen === 0 || oidLen === 255 || pos + 1 + oidLen > body.length) {
		throw new KantelError("invalid", "Invalid OpenPGP curve OID");
	}
	return pos + 1 + oidLen;
}

function splitSecretKeyPacket(body: Uint8Array): {
	readonly version: number;
	readonly pubBody: Uint8Array;
	readonly encrypted: boolean;
	readonly dummy: boolean;
} {
	if (body.length < 7) throw new KantelError("invalid", "Truncated OpenPGP secret key packet");
	const version = body[0] ?? 0;
	let pos: number;
	if (version === 4) {
		const algo = body[5] ?? 0;
		pos = 6;
		switch (algo) {
			case 1: // RSA (Encrypt or Sign)
			case 2: // RSA Encrypt-Only
			case 3: // RSA Sign-Only
				pos = skipPgpMpi(body, pos);
				pos = skipPgpMpi(body, pos);
				break;
			case 16: // Elgamal
			case 20:
				pos = skipPgpMpi(body, pos);
				pos = skipPgpMpi(body, pos);
				pos = skipPgpMpi(body, pos);
				break;
			case 17: // DSA
				pos = skipPgpMpi(body, pos);
				pos = skipPgpMpi(body, pos);
				pos = skipPgpMpi(body, pos);
				pos = skipPgpMpi(body, pos);
				break;
			case 18: // ECDH
				pos = skipPgpOid(body, pos);
				pos = skipPgpMpi(body, pos);
				if (pos + 1 > body.length) throw new KantelError("invalid", "Truncated OpenPGP ECDH KDF");
				{
					const kdfLen = body[pos] ?? 0;
					if (kdfLen === 0 || kdfLen === 255 || pos + 1 + kdfLen > body.length) {
						throw new KantelError("invalid", "Invalid OpenPGP ECDH KDF");
					}
					pos += 1 + kdfLen;
				}
				break;
			case 19: // ECDSA
			case 22: // EdDSA legacy (Ed25519)
				pos = skipPgpOid(body, pos);
				pos = skipPgpMpi(body, pos);
				break;
			case 25: // X25519
			case 27: // Ed25519 (RFC 9580)
				pos += 32;
				break;
			case 26: // X448
				pos += 56;
				break;
			case 28: // Ed448
				pos += 57;
				break;
			default:
				throw new KantelError("invalid", `Unsupported OpenPGP key algorithm (${algo})`);
		}
	} else if (version === 6) {
		if (body.length < 11) throw new KantelError("invalid", "Truncated OpenPGP v6 secret key packet");
		const keyLen = ((body[6] ?? 0) * 0x1000000 + ((body[7] ?? 0) << 16) + ((body[8] ?? 0) << 8) + (body[9] ?? 0)) >>> 0;
		pos = 10 + keyLen;
	} else {
		throw new KantelError("invalid", `Unsupported OpenPGP key version (${version})`);
	}

	if (pos >= body.length) {
		throw new KantelError("invalid", "OpenPGP secret key packet is missing private key parameters");
	}
	const pubBody = body.subarray(0, pos);
	const s2kUsage = body[pos] ?? 0;
	if (s2kUsage === 0) {
		return { version, pubBody, encrypted: false, dummy: false };
	}
	// Detect GnuPG's offline primary stub (`gnu-dummy`: s2kUsage 254/255, cipher, s2kType 101, hash, "GNU", mode 1).
	if (
		(s2kUsage === 254 || s2kUsage === 255) &&
		pos + 7 < body.length &&
		body[pos + 2] === 101 &&
		body[pos + 4] === 0x47 && // 'G'
		body[pos + 5] === 0x4e && // 'N'
		body[pos + 6] === 0x55 && // 'U'
		body[pos + 7] === 1
	) {
		return { version, pubBody, encrypted: false, dummy: true };
	}
	return { version, pubBody, encrypted: true, dummy: false };
}

function encodePgpPacket(tag: number, body: Uint8Array): Uint8Array {
	const len = body.length;
	let header: Uint8Array;
	if (len < 192) {
		header = new Uint8Array([0xc0 | (tag & 0x3f), len]);
	} else if (len <= 8383) {
		const adj = len - 192;
		header = new Uint8Array([0xc0 | (tag & 0x3f), ((adj >> 8) & 0xff) + 192, adj & 0xff]);
	} else {
		header = new Uint8Array([
			0xc0 | (tag & 0x3f),
			255,
			(len >>> 24) & 0xff,
			(len >>> 16) & 0xff,
			(len >>> 8) & 0xff,
			len & 0xff,
		]);
	}
	return concatBytes([header, body], header.length + body.length);
}

function armorPgpPublicKey(bytes: Uint8Array): string {
	const b64 = bytesToBase64(bytes);
	const wrapped: string[] = [];
	for (let i = 0; i < b64.length; i += 64) {
		wrapped.push(b64.slice(i, i + 64));
	}
	return `${PGP_PUBLIC_BEGIN}\n\n${wrapped.join("\n")}\n=${encodeCrc24(bytes)}\n${PGP_PUBLIC_END}\n`;
}

function extractUidEmail(uid: string): string | undefined {
	const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(uid);
	const candidate = (angle?.[1] ?? uid.trim()).toLowerCase();
	return isValidEmail(candidate) ? candidate : undefined;
}

async function pgpFingerprint(version: number, pubBody: Uint8Array): Promise<{ fingerprint: string; keyId: string }> {
	if (version === 4) {
		const input = new Uint8Array(3 + pubBody.length);
		input[0] = 0x99;
		input[1] = (pubBody.length >> 8) & 0xff;
		input[2] = pubBody.length & 0xff;
		input.set(pubBody, 3);
		const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
		const fingerprint = toUpperHex(hash);
		return { fingerprint, keyId: fingerprint.slice(-16) };
	}
	const input = new Uint8Array(5 + pubBody.length);
	input[0] = 0x9b;
	input[1] = (pubBody.length >>> 24) & 0xff;
	input[2] = (pubBody.length >>> 16) & 0xff;
	input[3] = (pubBody.length >>> 8) & 0xff;
	input[4] = pubBody.length & 0xff;
	input.set(pubBody, 5);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
	const fingerprint = toUpperHex(hash);
	return { fingerprint, keyId: fingerprint.slice(0, 16) };
}

async function parseOpenPgpPrivateKey(text: string): Promise<ParsedGitSigningKey> {
	const raw = decodePgpArmor(text);
	const packets = parsePgpPackets(raw);
	const first = packets[0];
	if (first === undefined || first.tag !== 5) {
		throw new KantelError("invalid", "OpenPGP input must begin with a Secret-Key packet");
	}
	const primary = splitSecretKeyPacket(first.body);
	const { fingerprint, keyId } = await pgpFingerprint(primary.version, primary.pubBody);

	let encrypted = primary.encrypted;
	let hasRealSecret = !primary.dummy;
	const userIdEmails: string[] = [];
	const seenEmails = new Set<string>();
	const publicChunks: Uint8Array[] = [];
	let publicTotal = 0;

	const pushPacket = (tag: number, body: Uint8Array) => {
		const encoded = encodePgpPacket(tag, body);
		publicChunks.push(encoded);
		publicTotal += encoded.length;
	};

	for (let i = 0; i < packets.length; i++) {
		const packet = packets[i];
		if (packet === undefined) continue;
		if (packet.tag === 5) {
			if (i > 0) {
				throw new KantelError("invalid", "Supply a single OpenPGP private key, not a keyring with multiple keys");
			}
			pushPacket(6, primary.pubBody);
		} else if (packet.tag === 7) {
			const sub = splitSecretKeyPacket(packet.body);
			if (sub.encrypted) encrypted = true;
			if (!sub.dummy) hasRealSecret = true;
			pushPacket(14, sub.pubBody);
		} else if (packet.tag === 13) {
			const email = extractUidEmail(textDecoder.decode(packet.body));
			if (email !== undefined && !seenEmails.has(email)) {
				seenEmails.add(email);
				userIdEmails.push(email);
			}
			pushPacket(13, packet.body);
		} else if (packet.tag === 2 || packet.tag === 17) {
			pushPacket(packet.tag, packet.body);
		}
	}

	if (!hasRealSecret) {
		throw new KantelError("invalid", "OpenPGP key contains no usable secret key material");
	}

	return {
		format: "gpg",
		keyId,
		fingerprint,
		publicKey: armorPgpPublicKey(concatBytes(publicChunks, publicTotal)),
		userIdEmails,
		encrypted,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenSSH (openssh-key-v1)

function readSshUint32(bytes: Uint8Array, offset: number): { value: number; next: number } {
	if (offset + 4 > bytes.length) throw new KantelError("invalid", "Truncated OpenSSH private key");
	const value =
		((bytes[offset] ?? 0) * 0x1000000 +
			((bytes[offset + 1] ?? 0) << 16) +
			((bytes[offset + 2] ?? 0) << 8) +
			(bytes[offset + 3] ?? 0)) >>>
		0;
	return { value, next: offset + 4 };
}

function readSshString(bytes: Uint8Array, offset: number): { data: Uint8Array; next: number } {
	const { value: length, next: start } = readSshUint32(bytes, offset);
	if (start + length > bytes.length) throw new KantelError("invalid", "Truncated OpenSSH key field");
	return { data: bytes.subarray(start, start + length), next: start + length };
}

async function parseOpenSshPrivateKey(text: string): Promise<ParsedGitSigningKey> {
	const startIdx = text.indexOf(SSH_PRIVATE_BEGIN);
	const endIdx = text.indexOf(SSH_PRIVATE_END, startIdx + SSH_PRIVATE_BEGIN.length);
	if (startIdx < 0 || endIdx < 0) {
		throw new KantelError("invalid", "OpenSSH private key is missing its PEM delimiters");
	}
	const bodyText = text.slice(startIdx + SSH_PRIVATE_BEGIN.length, endIdx).replace(/\s+/g, "");
	if (bodyText.length === 0) {
		throw new KantelError("invalid", "OpenSSH private key contains no key data");
	}
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(bodyText);
	} catch {
		throw new KantelError("invalid", "OpenSSH private key has invalid base64");
	}
	const magicBytes = textEncoder.encode(OPENSSH_MAGIC);
	if (bytes.length < magicBytes.length) {
		throw new KantelError("invalid", "Not a valid OpenSSH v1 private key");
	}
	for (let i = 0; i < magicBytes.length; i++) {
		if (bytes[i] !== magicBytes[i]) {
			throw new KantelError("invalid", "Not a valid OpenSSH v1 private key");
		}
	}
	let offset = magicBytes.length;
	const cipher = readSshString(bytes, offset);
	offset = cipher.next;
	const kdf = readSshString(bytes, offset);
	offset = kdf.next;
	const kdfOpts = readSshString(bytes, offset);
	offset = kdfOpts.next;

	const cipherName = textDecoder.decode(cipher.data);
	const kdfName = textDecoder.decode(kdf.data);

	const { value: numKeys, next: afterCount } = readSshUint32(bytes, offset);
	offset = afterCount;
	if (numKeys !== 1) {
		throw new KantelError("invalid", "OpenSSH private key must contain exactly one key");
	}

	const pubKey = readSshString(bytes, offset);
	offset = pubKey.next;
	const privSection = readSshString(bytes, offset);

	const keyTypeField = readSshString(pubKey.data, 0);
	const keyType = textDecoder.decode(keyTypeField.data);
	if (!/^[a-z0-9@._-]+$/i.test(keyType)) {
		throw new KantelError("invalid", "OpenSSH public key type is invalid");
	}

	const encrypted = cipherName !== "none" || kdfName !== "none";
	if (!encrypted) {
		if (privSection.data.length < 8) {
			throw new KantelError("invalid", "OpenSSH private key section is truncated");
		}
		const c1 = readSshUint32(privSection.data, 0).value;
		const c2 = readSshUint32(privSection.data, 4).value;
		if (c1 !== c2) {
			throw new KantelError("invalid", "OpenSSH private key integrity check failed");
		}
	}

	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(pubKey.data)));
	const b64NoPad = bytesToBase64(digest).replace(/=+$/, "");
	const fingerprint = `SHA256:${b64NoPad}`;
	const keyId = b64NoPad.slice(0, 16);
	const publicKey = `${keyType} ${bytesToBase64(pubKey.data)}`;

	return {
		format: "ssh",
		keyId,
		fingerprint,
		publicKey,
		userIdEmails: [],
		encrypted,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Byte utilities

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let pos = 0;
	for (const chunk of chunks) {
		out.set(chunk, pos);
		pos += chunk.length;
	}
	return out;
}

function toUpperHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, "0");
	}
	return out.toUpperCase();
}
