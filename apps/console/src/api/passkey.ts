// Passkeys in the console (#132): the vault page's `PasskeyCheck` over the approval API's challenge, and registering a
// passkey with identity. The browser's WebAuthn calls take and give `ArrayBuffer`s; Kantel's routes take WebAuthn's
// JSON forms (base64url), so this file turns one into the other.
//
// The approval API verifies the assertion with the decision, not on its own: `verify` keeps it for the proposal, and
// the vault seam's `decide` sends it as `passkeyAssertion`. A refusal then comes back from `decide` with its reason.

import type {
	PasskeyAssertion,
	PasskeyAttestation,
	PasskeyChallenge,
	PasskeyDescriptor,
	PasskeyRegistrationOptions,
} from "@kantel/contracts";
import type { PasskeyClient } from "@kantel/identity/passkey/http";
import { type PasskeyCheck, webAuthnPasskey } from "@kantel/ui";
import type { PasskeyChallengeBody } from "@kantel/vault/approval-api";

export function toBase64url(bytes: ArrayBuffer | ArrayBufferView): string {
	const view =
		bytes instanceof ArrayBuffer
			? new Uint8Array(bytes)
			: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let binary = "";
	for (const byte of view) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const descriptor = (passkey: PasskeyDescriptor): PublicKeyCredentialDescriptor => ({
	type: "public-key",
	id: fromBase64url(passkey.id),
	...(passkey.transports === undefined ? {} : { transports: [...passkey.transports] as AuthenticatorTransport[] }),
});

/** The browser's assertion as the approval API takes it. */
export function assertionJson(credential: PublicKeyCredential): PasskeyAssertion {
	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		rawId: toBase64url(credential.rawId),
		type: "public-key",
		response: {
			clientDataJSON: toBase64url(response.clientDataJSON),
			authenticatorData: toBase64url(response.authenticatorData),
			signature: toBase64url(response.signature),
			...(response.userHandle === null ? {} : { userHandle: toBase64url(response.userHandle) }),
		},
		...(credential.authenticatorAttachment === null
			? {}
			: { authenticatorAttachment: credential.authenticatorAttachment }),
		clientExtensionResults: {},
	};
}

/** A new passkey as identity's registration route takes it. */
export function attestationJson(credential: PublicKeyCredential): PasskeyAttestation {
	const response = credential.response as AuthenticatorAttestationResponse;
	const transports = typeof response.getTransports === "function" ? response.getTransports() : undefined;
	return {
		id: credential.id,
		rawId: toBase64url(credential.rawId),
		type: "public-key",
		response: {
			clientDataJSON: toBase64url(response.clientDataJSON),
			attestationObject: toBase64url(response.attestationObject),
			...(transports === undefined ? {} : { transports }),
		},
		...(credential.authenticatorAttachment === null
			? {}
			: { authenticatorAttachment: credential.authenticatorAttachment }),
		clientExtensionResults: {},
	};
}

/** Identity's registration options as `navigator.credentials.create` takes them. */
export function creationOptions(options: PasskeyRegistrationOptions): PublicKeyCredentialCreationOptions {
	return {
		challenge: fromBase64url(options.challenge),
		rp: { ...options.rp },
		user: { ...options.user, id: fromBase64url(options.user.id) },
		pubKeyCredParams: options.pubKeyCredParams.map((param) => ({ ...param })),
		timeout: options.timeout,
		attestation: options.attestation,
		authenticatorSelection: { ...options.authenticatorSelection },
		excludeCredentials: options.excludeCredentials.map(descriptor),
	};
}

/** What the passkey check needs of the approval API. */
export interface ApprovalChallenger {
	passkeyChallenge(proposalId: string, body: PasskeyChallengeBody): Promise<PasskeyChallenge>;
}

export interface ConsolePasskeyOptions {
	readonly approvals: ApprovalChallenger;
	/** Keeps the assertion for the decision on this proposal. */
	readonly keep: (proposalId: string, assertion: PasskeyAssertion) => void;
	/** For tests: the credentials container. Defaults to `navigator.credentials`. */
	readonly credentials?: Pick<CredentialsContainer, "get">;
}

/**
 * The vault page's passkey: `webAuthnPasskey` over a challenge the approval API binds to the proposal, the terms hash
 * and the narrowing, asking only for the person's own passkeys. The assertion is kept for `decide`, which the API
 * verifies it with.
 */
export function consolePasskey(options: ConsolePasskeyOptions): PasskeyCheck {
	return async (request) => {
		const issued = await options.approvals.passkeyChallenge(request.proposalId, {
			termsHash: request.termsHash,
			...(request.narrowing === undefined ? {} : { narrowing: request.narrowing }),
		});
		const check = webAuthnPasskey({
			challenge: async () => fromBase64url(issued.challenge),
			verify: async (_request, credential) => {
				options.keep(request.proposalId, assertionJson(credential));
				return true;
			},
			rpId: issued.rpId,
			timeoutMs: issued.timeout,
			...(issued.allowCredentials.length === 0 ? {} : { allowCredentials: issued.allowCredentials.map(descriptor) }),
			...(options.credentials === undefined ? {} : { credentials: options.credentials }),
		});
		return check(request);
	};
}

/**
 * Registers a passkey for the signed-in person: identity's challenge, the browser's prompt, then identity's check.
 * Resolves false when the person dismissed the prompt; rejects when the passkey couldn't be made or was refused.
 */
export async function registerPasskey(
	client: Pick<PasskeyClient, "registrationOptions" | "register">,
	credentials: Pick<CredentialsContainer, "create"> | undefined = globalThis.navigator?.credentials,
): Promise<boolean> {
	if (credentials === undefined) throw new Error("This browser can't use passkeys");
	const options = await client.registrationOptions();
	let created: Credential | null;
	try {
		created = await credentials.create({ publicKey: creationOptions(options) });
	} catch (error) {
		const name = (error as { name?: unknown } | null)?.name;
		if (name === "NotAllowedError" || name === "AbortError") return false;
		throw error;
	}
	if (created === null) return false;
	await client.register({ response: attestationJson(created as PublicKeyCredential) });
	return true;
}

/** Whether this browser can make and use passkeys at all. */
export function browserHasPasskeys(): boolean {
	return typeof globalThis.PublicKeyCredential === "function" && globalThis.navigator?.credentials !== undefined;
}
