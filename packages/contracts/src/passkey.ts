/**
 * Passkeys (#132, part of M1-FE2): a person registers passkeys with identity, and the vault's approval API asks for one
 * before an approval reaches the vault. The wire types follow WebAuthn's JSON forms (`PublicKeyCredentialCreationOptionsJSON`,
 * `RegistrationResponseJSON`, `AuthenticationResponseJSON`), with every binary field in unpadded base64url, so a
 * browser, a host app or a test can build them without Harbour's code.
 *
 * Harbour is the relying party: the passkey's `rpId` is the host the console is served on, and every challenge is
 * random, single use, short-lived and bound to the person (and, for an approval, to the proposal, its terms and the
 * narrowing shown), so an assertion approves exactly what the approver saw, once.
 */

import type { Timestamp, UserId } from "./common.ts";
import type { Narrowing } from "./vault.ts";

/** Where passkeys are registered, as the relying party sees them. */
export interface RelyingParty {
	/** The WebAuthn relying party ID: the host the console is served on, such as `harbour.example.com`. */
	readonly id: string;
	/** The name a browser shows when it creates a passkey. */
	readonly name: string;
	/** The one origin assertions must come from, such as `https://harbour.example.com`. */
	readonly origin: string;
}

/** The relying party for the origin a request was made to: its host is the ID, and Harbour the name. */
export function relyingPartyFor(url: string, name = "Harbour"): RelyingParty {
	const { hostname, origin } = new URL(url);
	return { id: hostname, name, origin };
}

/** A person's registered passkey. Only its public key is kept; this record holds neither. */
export interface Passkey {
	readonly id: string;
	readonly userId: UserId;
	/** The WebAuthn credential ID, unpadded base64url. Not a secret: the browser is told it to find the passkey. */
	readonly credentialId: string;
	readonly name: string;
	/** The relying party ID it was made for. */
	readonly rpId: string;
	/** How the browser reaches the authenticator (`internal`, `hybrid`, `usb`…), when it said. */
	readonly transports?: readonly string[];
	/** Whether the authenticator said the passkey is synced to other devices. */
	readonly backedUp: boolean;
	readonly createdAt: Timestamp;
	readonly lastUsedAt?: Timestamp;
}

/** The longest name a passkey may have. */
export const PASSKEY_NAME_MAX_LENGTH = 100;

/** A credential descriptor, as `allowCredentials` and `excludeCredentials` take it. */
export interface PasskeyDescriptor {
	readonly type: "public-key";
	readonly id: string;
	readonly transports?: readonly string[];
}

/** `PublicKeyCredentialCreationOptionsJSON`: what the browser needs to create a passkey. Binary fields in base64url. */
export interface PasskeyRegistrationOptions {
	readonly challenge: string;
	readonly rp: { readonly id: string; readonly name: string };
	readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
	readonly pubKeyCredParams: readonly { readonly type: "public-key"; readonly alg: number }[];
	readonly timeout: number;
	readonly attestation: "none";
	readonly authenticatorSelection: {
		readonly residentKey: "required" | "preferred" | "discouraged";
		readonly userVerification: "required";
	};
	/** The person's passkeys already registered, so the browser won't make a second on the same authenticator. */
	readonly excludeCredentials: readonly PasskeyDescriptor[];
}

/** `RegistrationResponseJSON`: the browser's new passkey, from `navigator.credentials.create`. */
export interface PasskeyAttestation {
	readonly id: string;
	readonly rawId: string;
	readonly type: "public-key";
	readonly response: {
		readonly clientDataJSON: string;
		readonly attestationObject: string;
		readonly transports?: readonly string[];
	};
	readonly authenticatorAttachment?: string;
	readonly clientExtensionResults?: { readonly [name: string]: unknown };
}

/** `AuthenticationResponseJSON`: the browser's assertion, from `navigator.credentials.get`. */
export interface PasskeyAssertion {
	readonly id: string;
	readonly rawId: string;
	readonly type: "public-key";
	readonly response: {
		readonly clientDataJSON: string;
		readonly authenticatorData: string;
		readonly signature: string;
		readonly userHandle?: string;
	};
	readonly authenticatorAttachment?: string;
	readonly clientExtensionResults?: { readonly [name: string]: unknown };
}

/**
 * What an approval's passkey is bound to: the proposal, the hash of the terms the approver saw, whether they approve or
 * paste a secret, and the narrowing they chose. The decision must cite the same, or the assertion is refused.
 */
export interface PasskeyBinding {
	readonly proposalId: string;
	readonly termsHash: string;
	readonly action: "approve" | "paste";
	readonly narrowing?: Narrowing;
}

/** `PublicKeyCredentialRequestOptionsJSON` for one approval: what the browser needs to ask for the passkey. */
export interface PasskeyChallenge {
	readonly challenge: string;
	readonly rpId: string;
	/** The person's passkeys. Empty when they have none yet: they register one first. */
	readonly allowCredentials: readonly PasskeyDescriptor[];
	readonly userVerification: "required";
	readonly timeout: number;
	/** When the challenge stops being accepted. */
	readonly expiresAt: Timestamp;
}

/** Why a passkey was refused, in `HarbourError.details.passkey` and in the audit event's `data.reason`. */
export type PasskeyRefusal =
	/** Approving needs a passkey and the decision carried none. */
	| "missing"
	/** The assertion or registration could not be read. */
	| "malformed"
	/** The challenge is unknown, used already, expired, for another purpose or another person. */
	| "challenge"
	/** The challenge was issued for another proposal, terms, action or narrowing than the decision cites. */
	| "binding"
	/** The assertion came from another origin, or for another relying party. */
	| "origin"
	/** The passkey is not one of this person's. */
	| "credential"
	/** The authenticator did not verify the person (no fingerprint, face or PIN). */
	| "user_verification"
	| "signature"
	/** The authenticator's counter went backwards: the passkey may have been cloned. */
	| "counter"
	/** The passkey uses an algorithm Harbour does not take. */
	| "algorithm";

/*
 * A person's passkeys over HTTP, behind the authenticator. Only a person (a human actor) has passkeys: a host app's
 * key is 403 `forbidden`.
 *
 * - `GET PASSKEYS_PATH` answers 200 with `PasskeysResponse`: the person's passkeys.
 * - `POST PASSKEY_REGISTRATION_PATH` with `{}` answers 200 with `PasskeyRegistrationOptions`, holding a new
 *   registration challenge for the person.
 * - `POST PASSKEYS_PATH` with `RegisterPasskeyRequest` verifies the browser's response against that challenge
 *   (which it uses up) and answers 201 with the new `Passkey`. A refused registration is 422 `refused`, with the
 *   `PasskeyRefusal` in `error.passkey`; a passkey registered already is 409 `conflict`.
 * - `POST passkeyRemovePath(id)` with `RemovePasskeyRequest` removes one of the person's passkeys and answers 204.
 *
 * Changing passkeys needs a passkey (#132): a person with none enrols their first on their sign-in alone, but adding
 * another or removing one needs a fresh assertion from one they have, as `confirmation`. `POST
 * PASSKEY_CONFIRMATION_PATH` with a `PasskeyChange` answers 200 with a single-use `PasskeyChallenge` bound to that
 * change, which the person signs. A change without one, or with one that fails, is 422 `refused` with the
 * `PasskeyRefusal` in `error.passkey`, audited as `identity.passkey.refused`.
 *
 * Someone who has lost their passkeys asks an admin: `POST passkeyResetPath(userId)` with `{}` removes every passkey a
 * member of the caller's organisation has, so they can enrol again with a sign-in, and answers 200 with
 * `PasskeyResetResponse`. It needs the organisation's `admin` role (else 403) and is audited as
 * `identity.passkey.reset`, naming the admin as actor and the person as subject.
 *
 * Every POST needs `Content-Type: application/json` (else 415), as the key routes do.
 */
export const PASSKEYS_PATH = "/v1/me/passkeys";
export const PASSKEY_REGISTRATION_PATH = "/v1/me/passkeys/registration";
export const PASSKEY_CONFIRMATION_PATH = "/v1/me/passkeys/confirmation";
/** `/v1/me/passkeys/:id/remove`. */
export const passkeyRemovePath = (passkeyId: string): string =>
	`${PASSKEYS_PATH}/${encodeURIComponent(passkeyId)}/remove`;
/** `/v1/members/:userId/passkeys/reset`: an admin's reset of a member's passkeys. */
export const passkeyResetPath = (userId: UserId): string => `/v1/members/${encodeURIComponent(userId)}/passkeys/reset`;

/** A change to a person's passkeys that needs one of them to confirm it. */
export type PasskeyChange = { readonly change: "register" } | { readonly change: "remove"; readonly passkeyId: string };

export interface RemovePasskeyRequest {
	/** An assertion over a `PasskeyChange` challenge for removing this passkey. */
	readonly confirmation?: PasskeyAssertion;
}

export interface PasskeyResetResponse {
	/** How many passkeys were removed. */
	readonly removed: number;
}

export interface PasskeysResponse {
	readonly items: readonly Passkey[];
	/** Whether approving on the vault page needs a passkey: always, or once the person has one. */
	readonly approvals: "always" | "registered";
}

export interface RegisterPasskeyRequest {
	readonly response: PasskeyAttestation;
	/** What the person calls it, such as "MacBook". Default "Passkey". */
	readonly name?: string;
	/**
	 * Once the person has a passkey: an assertion from one of them over a `{ change: "register" }` challenge. Not needed
	 * for their first.
	 */
	readonly confirmation?: PasskeyAssertion;
}
