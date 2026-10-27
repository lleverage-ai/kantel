import { describe, expect, it } from "vitest";
import { webAuthnPasskey } from "./passkey.ts";

const request = { proposalId: "proposal_1", termsHash: "hash_1", action: "approve" as const };
const challenge = async () => new Uint8Array([1, 2, 3]);

describe("webAuthnPasskey", () => {
	it("asks for user verification with the host's challenge, and confirms once the host verifies", async () => {
		let asked: CredentialRequestOptions | undefined;
		const seen: unknown[] = [];
		const check = webAuthnPasskey({
			challenge,
			verify: async (got, credential) => {
				seen.push(got, credential);
				return true;
			},
			rpId: "vault.harbour.dev",
			credentials: {
				get: async (options) => {
					asked = options;
					return { id: "cred_1" } as Credential;
				},
			},
		});
		expect(await check(request)).toBe("confirmed");
		expect(asked?.publicKey?.userVerification).toBe("required");
		expect(asked?.publicKey?.rpId).toBe("vault.harbour.dev");
		expect(asked?.publicKey?.challenge).toEqual(new Uint8Array([1, 2, 3]));
		expect(seen).toEqual([request, { id: "cred_1" }]);
	});

	it("reads a dismissed prompt as cancelled", async () => {
		for (const name of ["NotAllowedError", "AbortError"]) {
			const check = webAuthnPasskey({
				challenge,
				verify: async () => true,
				credentials: { get: async () => Promise.reject(Object.assign(new Error("dismissed"), { name })) },
			});
			expect(await check(request)).toBe("cancelled");
		}
	});

	it("rejects when the host can't verify the assertion, so nothing is approved", async () => {
		const check = webAuthnPasskey({
			challenge,
			verify: async () => false,
			credentials: { get: async () => ({ id: "cred_1" }) as Credential },
		});
		await expect(check(request)).rejects.toThrow("couldn't be verified");
	});
});
