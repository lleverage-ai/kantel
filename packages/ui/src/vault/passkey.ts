// Approving on the vault page needs a passkey. The page never talks WebAuthn itself: the host passes a `PasskeyCheck`
// callback, and `webAuthnPasskey` builds one from the browser's WebAuthn API and the host's own challenge and
// verification endpoints. The workbench passes a stand-in.

import type { Narrowing } from "@kantel/contracts";

/** What the approver is about to confirm. The host binds its challenge to these, so an assertion can't be replayed. */
export interface PasskeyRequest {
	readonly proposalId: string;
	readonly termsHash: string;
	readonly action: "approve" | "paste";
	/** The narrowing the approval will carry, when the approver narrowed: the challenge binds it too. */
	readonly narrowing?: Narrowing;
}

/**
 * Asks the approver for their passkey. Resolves `confirmed` once the host has verified the assertion, `cancelled` when
 * the approver dismissed the prompt; rejects when the check could not be made at all.
 */
export type PasskeyCheck = (request: PasskeyRequest) => Promise<"confirmed" | "cancelled">;

export interface WebAuthnPasskeyOptions {
	/** The host's challenge for this request, from its server: random, single use, bound to the request. */
	readonly challenge: (request: PasskeyRequest) => Promise<BufferSource>;
	/** Sends the assertion to the host's server, which verifies it and the user. Resolves false when it fails. */
	readonly verify: (request: PasskeyRequest, credential: PublicKeyCredential) => Promise<boolean>;
	/** The relying party: the vault's own origin's host. Defaults to the page's. */
	readonly rpId?: string;
	/** The approver's registered passkeys, when the host knows them. */
	readonly allowCredentials?: readonly PublicKeyCredentialDescriptor[];
	readonly timeoutMs?: number;
	/** For tests: the credentials container. Defaults to `navigator.credentials`. */
	readonly credentials?: Pick<CredentialsContainer, "get">;
}

/**
 * A `PasskeyCheck` over WebAuthn. Asks for user verification every time (a fingerprint, a face or a PIN), so a passkey
 * on an unlocked device is not enough on its own. A dismissed prompt (`NotAllowedError` or `AbortError`) is
 * `cancelled`; a failed server verification rejects.
 */
export function webAuthnPasskey(options: WebAuthnPasskeyOptions): PasskeyCheck {
	return async (request) => {
		const credentials = options.credentials ?? globalThis.navigator?.credentials;
		if (credentials === undefined) throw new Error("This browser can't use passkeys");
		const challenge = await options.challenge(request);
		let credential: Credential | null;
		try {
			credential = await credentials.get({
				publicKey: {
					challenge,
					userVerification: "required",
					timeout: options.timeoutMs ?? 120_000,
					...(options.rpId === undefined ? {} : { rpId: options.rpId }),
					...(options.allowCredentials === undefined ? {} : { allowCredentials: [...options.allowCredentials] }),
				},
			});
		} catch (error) {
			const name = (error as { name?: unknown } | null)?.name;
			if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
			throw error;
		}
		if (credential === null) return "cancelled";
		const verified = await options.verify(request, credential as PublicKeyCredential);
		if (!verified) throw new Error("The passkey couldn't be verified");
		return "confirmed";
	};
}
