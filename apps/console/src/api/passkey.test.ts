// The console's passkeys end to end, in-process: identity's passkey routes and the approval API with real passkey checks
// over an in-memory vault, and the console's `apiVault` driving them through a stand-in for the browser's
// `navigator.credentials` that signs with real keys (identity's software authenticator, behind WebAuthn's binary forms).
import type {
	AuthenticatedCaller,
	CallContext,
	PasskeyAssertion,
	PasskeyAttestation,
	PasskeyRegistrationOptions,
} from "@kantel/contracts";
import { createMemoryPasskeyStores, createPasskeys } from "@kantel/identity/passkey";
import { createPasskeyClient, createPasskeyHandler } from "@kantel/identity/passkey/http";
import { createSoftwareAuthenticator } from "@kantel/identity/passkey/testing";
import { createVaultApprovalApi } from "@kantel/vault/approval-api";
import { createMemoryVault } from "@kantel/vault/memory";
import { describe, expect, it } from "vitest";
import { fromBase64url, toBase64url } from "./passkey.ts";
import { apiVault } from "./vault-http.ts";

const ORG = "org-a";
const PROJECT = "proj-a";
const ORIGIN = "https://harbour.test";
const tom: CallContext = { actor: { kind: "human", userId: "user-tom" }, organisationId: ORG };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: ORG,
	projectId: PROJECT,
};

const buffer = (text: string): ArrayBuffer => fromBase64url(text).buffer;
const b64 = (source: BufferSource): string =>
	toBase64url(
		source instanceof ArrayBuffer ? source : new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
	);

/**
 * `navigator.credentials` over the software authenticator: WebAuthn's binary options in, a `PublicKeyCredential`-shaped
 * object with `ArrayBuffer`s out, as a browser gives. `dismiss` makes the next prompt a `NotAllowedError`.
 */
function browserCredentials() {
	const device = createSoftwareAuthenticator({ origin: ORIGIN });
	const state = { dismiss: false, asked: [] as CredentialRequestOptions[] };
	const dismissed = () => {
		state.dismiss = false;
		return Object.assign(new Error("The user dismissed the prompt"), { name: "NotAllowedError" });
	};
	const credentials: Pick<CredentialsContainer, "get" | "create"> = {
		async create(options) {
			if (state.dismiss) throw dismissed();
			const publicKey = options!.publicKey!;
			const json: PasskeyRegistrationOptions = {
				challenge: b64(publicKey.challenge),
				rp: { id: publicKey.rp.id!, name: publicKey.rp.name },
				user: { id: b64(publicKey.user.id), name: publicKey.user.name, displayName: publicKey.user.displayName },
				pubKeyCredParams: publicKey.pubKeyCredParams.map((param) => ({ type: "public-key", alg: param.alg })),
				timeout: publicKey.timeout ?? 0,
				attestation: "none",
				authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
				excludeCredentials: (publicKey.excludeCredentials ?? []).map((item) => ({
					type: "public-key",
					id: b64(item.id),
				})),
			};
			const made: PasskeyAttestation = await device.create(json);
			return {
				id: made.id,
				rawId: buffer(made.rawId),
				type: "public-key",
				authenticatorAttachment: "platform",
				response: {
					clientDataJSON: buffer(made.response.clientDataJSON),
					attestationObject: buffer(made.response.attestationObject),
					getTransports: () => ["internal"],
				},
				getClientExtensionResults: () => ({}),
			} as unknown as Credential;
		},
		async get(options) {
			if (state.dismiss) throw dismissed();
			state.asked.push(options!);
			const publicKey = options!.publicKey!;
			const signed: PasskeyAssertion = await device.get({
				challenge: b64(publicKey.challenge),
				rpId: publicKey.rpId!,
				allowCredentials: (publicKey.allowCredentials ?? []).map((item) => ({ type: "public-key", id: b64(item.id) })),
			});
			return {
				id: signed.id,
				rawId: buffer(signed.rawId),
				type: "public-key",
				authenticatorAttachment: "platform",
				response: {
					clientDataJSON: buffer(signed.response.clientDataJSON),
					authenticatorData: buffer(signed.response.authenticatorData),
					signature: buffer(signed.response.signature),
					userHandle: signed.response.userHandle === undefined ? null : buffer(signed.response.userHandle),
				},
				getClientExtensionResults: () => ({}),
			} as unknown as Credential;
		},
	};
	return { credentials, state };
}

async function setUp() {
	const vault = createMemoryVault();
	const item = await vault.putItem(tom, {
		owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
		name: "GitHub token",
		hosts: ["api.github.com"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: "passkey-console-test-value",
	});
	const proposal = await vault.propose(agent, {
		itemId: item.id,
		route: { host: "api.github.com", methods: ["GET", "POST"], pathPrefix: "/repos" },
		lifetime: { ttlMs: 3_600_000 },
		reason: "Open the release pull request",
	});
	const passkeys = createPasskeys(createMemoryPasskeyStores());
	const approvals = createVaultApprovalApi({ vault, authenticate: async () => tom, passkeys });
	const passkeyRoutes = createPasskeyHandler({
		passkeys,
		authenticator: {
			authenticate: async (): Promise<AuthenticatedCaller> => ({ ...tom, method: "cloudflare_access" }),
		},
	});
	const browser = browserCredentials();
	const fetchVia: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/v1/vault") ? approvals(request) : passkeyRoutes(request);
	};
	const open = () =>
		apiVault({
			baseUrl: `${ORIGIN}/v1/vault`,
			host: "harbour.test",
			fetch: fetchVia,
			passkeys: createPasskeyClient({ baseUrl: ORIGIN, fetch: fetchVia }),
			credentials: browser.credentials,
		});
	return { vault, proposal, open, browser };
}

describe("passkeys in the console", () => {
	it("offers a person without a passkey to set one up, then asks for it and approves with the narrowing shown", async () => {
		const { proposal, open, browser } = await setUp();
		const before = await open();
		expect(before.passkey).toBeUndefined();
		expect(before.registerPasskey).toBeDefined();

		const check = await before.registerPasskey!();
		expect(check).toBeDefined();

		// A fresh vault page now knows approving needs the passkey, and offers no set-up.
		const tomsVault = await open();
		expect(tomsVault.passkey).toBeDefined();
		expect(tomsVault.registerPasskey).toBeUndefined();

		const narrowing = { methods: ["GET" as const], pathPrefix: "/repos/acme" };
		const request = { proposalId: proposal.id, termsHash: proposal.termsHash, action: "approve" as const, narrowing };
		expect(await tomsVault.passkey!(request)).toBe("confirmed");
		// The browser was asked for Tom's own passkey, with user verification, on the vault's host.
		expect(browser.state.asked.at(-1)?.publicKey).toMatchObject({ rpId: "harbour.test", userVerification: "required" });
		expect(browser.state.asked.at(-1)?.publicKey?.allowCredentials).toHaveLength(1);

		const decision = await tomsVault.decide({
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
			narrowing,
		});
		expect(decision.outcome).toBe("approved");
		expect(decision.effectiveTerms?.route).toMatchObject({ methods: ["GET"], pathPrefix: "/repos/acme" });
	});

	it("is refused, with the passkey's reason, when the decision narrows differently than the passkey confirmed", async () => {
		const { proposal, open } = await setUp();
		await (await open()).registerPasskey!();
		const tomsVault = await open();
		const confirmed = { methods: ["GET" as const] };
		await tomsVault.passkey!({
			proposalId: proposal.id,
			termsHash: proposal.termsHash,
			action: "approve",
			narrowing: confirmed,
		});
		const refused = await tomsVault
			.decide({
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: proposal.bindingCode,
			})
			.catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "refused", details: { passkey: "binding" } });
		// The assertion went with that decision: the next one has none, and is refused as missing.
		const again = await tomsVault
			.decide({
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: proposal.bindingCode,
			})
			.catch((error: unknown) => error);
		expect(again).toMatchObject({ code: "refused", details: { passkey: "missing" } });
	});

	it("treats a dismissed prompt as cancelled, for setting up and for approving", async () => {
		const { proposal, open, browser } = await setUp();
		browser.state.dismiss = true;
		expect(await (await open()).registerPasskey!()).toBeUndefined();
		await (await open()).registerPasskey!();
		const tomsVault = await open();
		browser.state.dismiss = true;
		expect(
			await tomsVault.passkey!({ proposalId: proposal.id, termsHash: proposal.termsHash, action: "approve" }),
		).toBe("cancelled");
	});

	it("round-trips base64url", () => {
		const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
		expect([...fromBase64url(toBase64url(bytes))]).toEqual([...bytes]);
		expect(toBase64url(new Uint8Array([251, 255]))).toBe("-_8");
	});
});
