import {
	type AuthenticatedCaller,
	type Authenticator,
	authenticationError,
	type CallContext,
	isKantelError,
	type KantelError,
	KantelError as KantelErrorClass,
	PASSKEY_CONFIRMATION_PATH,
	PASSKEY_REGISTRATION_PATH,
	PASSKEYS_PATH,
	type PasskeyBinding,
	type PasskeyChange,
	type PasskeyRegistrationOptions,
	type PasskeysResponse,
	passkeyRemovePath,
	passkeyResetPath,
	type RelyingParty,
} from "@kantel/contracts";
import {
	createMemoryPasskeyStores,
	createPasskeys,
	PASSKEY_CHALLENGE_TTL_MILLISECONDS,
	type PasskeyChallengeStore,
	type PasskeyCredentialStore,
	type Passkeys,
	type PasskeysOptions,
} from "@kantel/identity/passkey";
import { createPasskeyClient, createPasskeyHandler, isPasskeyPath } from "@kantel/identity/passkey/http";
import { createSoftwareAuthenticator, type SoftwareAlgorithm } from "@kantel/identity/passkey/testing";
import { createSqlPasskeyStores, migrateIdentity } from "@kantel/identity/sql";
import { decodeCbor, derToRawSignature, fromBase64url, toBase64url } from "@kantel/identity/webauthn";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
const RP: RelyingParty = { id: "harbour.test", name: "Kantel", origin: "https://harbour.test" };
const ada: CallContext = { actor: { kind: "human", userId: "user-ada" }, organisationId: ORG };
const lin: CallContext = { actor: { kind: "human", userId: "user-lin" }, organisationId: ORG };
const hostApp: CallContext = {
	actor: { kind: "service", serviceId: "svc-atlas", keyId: "key-1" },
	organisationId: ORG,
};
const admin: CallContext = { actor: { kind: "human", userId: "user-admin" }, organisationId: ORG };

/** Identity as `reset` reads it: `user-admin` is the organisation's admin; Ada, Lin and the admin are its members. */
const directory: NonNullable<PasskeysOptions["identity"]> = {
	async getUser(_ctx, id) {
		if (!["user-ada", "user-lin", "user-admin"].includes(id)) throw new KantelErrorClass("not_found", "No such user");
		return { id, name: id, createdAt: 0 };
	},
	async authorize(ctx, needed) {
		const isAdmin = ctx.actor.kind === "human" && ctx.actor.userId === "user-admin";
		if (needed !== "admin" || !isAdmin || ctx.projectId !== undefined) {
			throw new KantelErrorClass("forbidden", "Needs admin");
		}
	},
};

const binding: PasskeyBinding = {
	proposalId: "proposal-1",
	termsHash: "terms-1",
	action: "approve",
	narrowing: { methods: ["GET"], ttlMs: 600_000 },
};

interface Stores {
	readonly credentials: PasskeyCredentialStore;
	readonly challenges: PasskeyChallengeStore;
}

interface Backend {
	readonly name: string;
	/** The database kind's longer timeout, when its fixture is slow (`TestDatabaseKind.testTimeoutMs`). */
	readonly testTimeoutMs?: number;
	/** Opens the stores; `again` opens a second set over the same database, as another process would. */
	open(): Promise<{ readonly stores: Stores; again(): Stores; close(): Promise<void> }>;
}

const backends: Backend[] = [
	{
		name: "memory",
		async open() {
			const stores = createMemoryPasskeyStores();
			return { stores, again: () => stores, close: async () => {} };
		},
	},
	...testDatabaseKinds().map(
		(kind): Backend => ({
			name: kind.name,
			testTimeoutMs: kind.testTimeoutMs,
			async open() {
				const database = await kind.open();
				await migrateIdentity(database.driver);
				return {
					stores: createSqlPasskeyStores(database.driver),
					again: () => createSqlPasskeyStores(database.driver),
					close: () => database.close(),
				};
			},
		}),
	),
];

async function refusal(promise: Promise<unknown>): Promise<KantelError> {
	try {
		await promise;
	} catch (error) {
		if (isKantelError(error)) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

const reasonOf = async (promise: Promise<unknown>) => {
	const error = await refusal(promise);
	expect(error.code).toBe("refused");
	return error.details?.passkey;
};

// `describe.each` gives every backend the same options, so the suite takes the slowest backend's timeout.
const suiteTimeout = Math.max(0, ...backends.map((backend) => backend.testTimeoutMs ?? 0)) || undefined;

describe.each(backends)("passkeys on $name", { timeout: suiteTimeout }, (backend) => {
	async function world(options: Partial<PasskeysOptions> & { algorithm?: SoftwareAlgorithm; counting?: boolean } = {}) {
		const clock = new ManualClock();
		const audit = new RecordingAuditSink();
		const opened = await backend.open();
		const passkeys = createPasskeys({ ...opened.stores, clock, audit, ...options });
		const device = createSoftwareAuthenticator({
			origin: RP.origin,
			...(options.algorithm === undefined ? {} : { algorithm: options.algorithm }),
			...(options.counting === undefined ? {} : { counting: options.counting }),
		});
		const register = async (ctx: CallContext = ada) => {
			const creation = await passkeys.registrationOptions(ctx, RP);
			return passkeys.register(ctx, await device.create(creation), "Laptop");
		};
		/** An assertion from the device over a challenge for `change`. */
		const confirmation = async (change: PasskeyChange, ctx: CallContext = ada) =>
			device.get(await passkeys.changeChallenge(ctx, RP, change));
		return { clock, audit, passkeys, device, register, confirmation, opened };
	}

	it.each(["ES256", "EdDSA", "RS256"] as const)(
		"registers a %s passkey and approves with it once, audited as identity.passkey.registered",
		async (algorithm) => {
			const { passkeys, device, register, audit, opened } = await world({ algorithm });
			const registered = await register();
			expect(registered).toMatchObject({ userId: "user-ada", name: "Laptop", rpId: RP.id, transports: ["internal"] });
			expect(registered).not.toHaveProperty("publicKey");
			expect(await passkeys.list(ada)).toEqual([registered]);
			expect(audit.ofType("identity.passkey.registered")).toMatchObject([
				{ actor: ada.actor, organisationId: ORG, subject: { kind: "identity.passkey", id: registered.id } },
			]);

			const challenge = await passkeys.approvalChallenge(ada, RP, binding);
			expect(challenge.allowCredentials).toEqual([
				{ type: "public-key", id: registered.credentialId, transports: ["internal"] },
			]);
			const assertion = await device.get(challenge);
			const used = await passkeys.verifyApproval(ada, binding, assertion);
			expect(used.id).toBe(registered.id);
			expect(used.lastUsedAt).toBeDefined();
			await opened.close();
		},
	);

	it("issues registration options for the person, excluding the passkeys they have", async () => {
		const { passkeys, register, opened } = await world();
		const first = await passkeys.registrationOptions(ada, RP);
		expect(first).toMatchObject({
			rp: { id: RP.id, name: "Kantel" },
			user: { id: toBase64url(new TextEncoder().encode("user-ada")) },
			attestation: "none",
			authenticatorSelection: { userVerification: "required" },
			excludeCredentials: [],
		});
		expect(first.pubKeyCredParams.map((param) => param.alg)).toEqual([-8, -7, -257]);
		const registered = await register();
		const second = await passkeys.registrationOptions(ada, RP);
		expect(second.excludeCredentials.map((descriptor) => descriptor.id)).toEqual([registered.credentialId]);
		expect(second.challenge).not.toBe(first.challenge);
		await opened.close();
	});

	it("uses a registration challenge once, and refuses another person's, an expired one and a stranger's", async () => {
		const { passkeys, device, clock, opened } = await world();
		const creation = await passkeys.registrationOptions(ada, RP);
		const response = await device.create(creation);
		expect(await reasonOf(passkeys.register(lin, response))).toBe("challenge");
		// Lin's attempt used it up: Ada's own is refused now.
		expect(await reasonOf(passkeys.register(ada, response))).toBe("challenge");

		const late = await device.create(await passkeys.registrationOptions(ada, RP));
		clock.advance(PASSKEY_CHALLENGE_TTL_MILLISECONDS);
		expect(await reasonOf(passkeys.register(ada, late))).toBe("challenge");

		const forged = await device.create(await passkeys.registrationOptions(ada, RP), { challenge: "AAAA" });
		expect(await reasonOf(passkeys.register(ada, forged))).toBe("challenge");
		expect(await passkeys.list(ada)).toEqual([]);
		await opened.close();
	});

	it("refuses a registration from another origin or relying party, or without user verification", async () => {
		const { passkeys, device, opened } = await world();
		const make = async (overrides: Parameters<typeof device.create>[1]) =>
			passkeys.register(ada, await device.create(await passkeys.registrationOptions(ada, RP), overrides));
		expect(await reasonOf(make({ origin: "https://evil.test" }))).toBe("origin");
		expect(await reasonOf(make({ rpId: "evil.test" }))).toBe("origin");
		expect(await reasonOf(make({ crossOrigin: true }))).toBe("origin");
		expect(await reasonOf(make({ userVerified: false }))).toBe("user_verification");
		expect(await reasonOf(make({ type: "webauthn.get" }))).toBe("malformed");
		expect(await passkeys.list(ada)).toEqual([]);
		await opened.close();
	});

	it("refuses to register one passkey twice, to the same person or another", async () => {
		const { passkeys, device, confirmation, opened } = await world();
		const first = await device.create(await passkeys.registrationOptions(ada, RP));
		await passkeys.register(ada, first);
		// The same authenticator data under a new challenge: with no attestation, nothing else ties it to a session.
		const replayed = async (ctx: CallContext) => {
			const { challenge } = await passkeys.registrationOptions(ctx, RP);
			const client = JSON.parse(new TextDecoder().decode(fromBase64url(first.response.clientDataJSON)));
			const clientDataJSON = toBase64url(new TextEncoder().encode(JSON.stringify({ ...client, challenge })));
			return { ...first, response: { ...first.response, clientDataJSON } };
		};
		const again = await replayed(ada);
		const confirmed = await confirmation({ change: "register" });
		expect((await refusal(passkeys.register(ada, again, undefined, confirmed))).code).toBe("conflict");
		expect((await refusal(passkeys.register(lin, await replayed(lin)))).code).toBe("conflict");
		expect(await passkeys.list(lin)).toEqual([]);
		await opened.close();
	});

	it("removes a passkey for its owner only, audited as identity.passkey.removed", async () => {
		const { passkeys, register, confirmation, audit, opened } = await world();
		const registered = await register();
		const change = { change: "remove", passkeyId: registered.id } as const;
		expect((await refusal(passkeys.remove(lin, registered.id))).code).toBe("not_found");
		await passkeys.remove(ada, registered.id, await confirmation(change));
		expect(await passkeys.list(ada)).toEqual([]);
		expect(audit.ofType("identity.passkey.removed")).toHaveLength(1);
		expect((await refusal(passkeys.remove(ada, registered.id))).code).toBe("not_found");
		await opened.close();
	});

	it("enrols a first passkey on the sign-in alone, then needs one to add another or remove one", async () => {
		const { passkeys, device, register, confirmation, audit, opened } = await world();
		const first = await register();
		const second = async () => device.create(await passkeys.registrationOptions(ada, RP));

		// Another passkey: refused without a confirmation, or with one for another change, or with one used already.
		expect(await reasonOf(passkeys.register(ada, await second()))).toBe("missing");
		const forRemoving = await confirmation({ change: "remove", passkeyId: first.id });
		expect(await reasonOf(passkeys.register(ada, await second(), undefined, forRemoving))).toBe("binding");
		const confirmed = await confirmation({ change: "register" });
		const added = await passkeys.register(ada, await second(), "Phone", confirmed);
		expect(added.name).toBe("Phone");
		expect(await reasonOf(passkeys.register(ada, await second(), undefined, confirmed))).toBe("challenge");

		// Removing one: refused without, or with a confirmation for removing another; then removed.
		const removeFirst = { change: "remove", passkeyId: first.id } as const;
		expect(await reasonOf(passkeys.remove(ada, first.id))).toBe("missing");
		const forOther = await confirmation({ change: "remove", passkeyId: added.id });
		expect(await reasonOf(passkeys.remove(ada, first.id, forOther))).toBe("binding");
		await passkeys.remove(ada, first.id, await confirmation(removeFirst));
		expect((await passkeys.list(ada)).map((passkey) => passkey.id)).toEqual([added.id]);

		const refused = audit.ofType("identity.passkey.refused");
		expect(refused.map((event) => event.data?.reason)).toEqual([
			"missing",
			"binding",
			"challenge",
			"missing",
			"binding",
		]);
		expect(refused[0]).toMatchObject({
			source: "identity",
			actor: ada.actor,
			subject: { kind: "identity.user", id: "user-ada" },
			data: { change: "register" },
		});
		expect(refused[3]).toMatchObject({
			subject: { kind: "identity.passkey", id: first.id },
			data: { change: "remove" },
		});
		await opened.close();
	});

	it("refuses a confirmation from another person's passkey, and a registration challenge from before the first", async () => {
		const { passkeys, device, register, opened } = await world();
		const early = await device.create(await passkeys.registrationOptions(ada, RP));
		await register();
		// Issued while Ada had no passkey, used after: it still needs a confirmation.
		expect(await reasonOf(passkeys.register(ada, early))).toBe("missing");

		const linDevice = createSoftwareAuthenticator({ origin: RP.origin });
		await passkeys.register(lin, await linDevice.create(await passkeys.registrationOptions(lin, RP)));
		const forAda = await passkeys.changeChallenge(ada, RP, { change: "register" });
		const linSigned = await linDevice.get({ ...forAda, allowCredentials: [] });
		const another = await device.create(await passkeys.registrationOptions(ada, RP));
		expect(await reasonOf(passkeys.register(ada, another, undefined, linSigned))).toBe("credential");
		await opened.close();
	});

	it("issues a change challenge only to a person with a passkey, for one of theirs", async () => {
		const { passkeys, register, opened } = await world();
		expect((await refusal(passkeys.changeChallenge(ada, RP, { change: "register" }))).code).toBe("invalid");
		const registered = await register();
		const challenge = await passkeys.changeChallenge(ada, RP, { change: "register" });
		expect(challenge.allowCredentials.map((descriptor) => descriptor.id)).toEqual([registered.credentialId]);
		expect((await refusal(passkeys.changeChallenge(ada, RP, { change: "remove", passkeyId: "pk_x" }))).code).toBe(
			"not_found",
		);
		expect((await refusal(passkeys.changeChallenge(hostApp, RP, { change: "register" }))).code).toBe("forbidden");
		await opened.close();
	});

	it("lets an organisation admin reset a member's passkeys, audited, so they enrol again on a sign-in", async () => {
		const { passkeys, device, register, confirmation, audit, opened } = await world({ identity: directory });
		const first = await register();
		const second = await passkeys.register(
			ada,
			await device.create(await passkeys.registrationOptions(ada, RP)),
			"Phone",
			await confirmation({ change: "register" }),
		);

		expect((await refusal(passkeys.reset(lin, "user-ada"))).code).toBe("forbidden");
		expect((await refusal(passkeys.reset(hostApp, "user-ada"))).code).toBe("forbidden");
		expect((await refusal(passkeys.reset(admin, "user-stranger"))).code).toBe("not_found");
		// The organisation's admin, even on a call that names a project.
		expect(await passkeys.reset({ ...admin, projectId: "project-1" }, "user-ada")).toBe(2);
		expect(await passkeys.list(ada)).toEqual([]);
		const resets = audit.ofType("identity.passkey.reset");
		expect(resets).toMatchObject([
			{
				source: "identity",
				actor: admin.actor,
				organisationId: ORG,
				subject: { kind: "identity.user", id: "user-ada" },
				data: { removed: 2 },
			},
		]);
		// Both registered at the same instant, so in either order.
		const passkeyIds = (resets[0]?.data?.passkeyIds ?? []) as string[];
		expect([...passkeyIds].sort()).toEqual([first.id, second.id].sort());
		expect(await passkeys.required(ada)).toBe(false);
		await register();
		expect(await passkeys.list(ada)).toHaveLength(1);

		const without = createPasskeys({ ...opened.again() });
		expect((await refusal(without.reset(admin, "user-ada"))).code).toBe("not_supported");
		await opened.close();
	});

	it("has no passkeys for anyone but a person", async () => {
		const { passkeys, opened } = await world();
		expect((await refusal(passkeys.list(hostApp))).code).toBe("forbidden");
		expect((await refusal(passkeys.registrationOptions(hostApp, RP))).code).toBe("forbidden");
		expect((await refusal(passkeys.approvalChallenge(hostApp, RP, binding))).code).toBe("forbidden");
		await opened.close();
	});

	it("uses an approval challenge once: a replayed assertion is refused", async () => {
		const { passkeys, device, register, opened } = await world();
		await register();
		const assertion = await device.get(await passkeys.approvalChallenge(ada, RP, binding));
		await passkeys.verifyApproval(ada, binding, assertion);
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, assertion))).toBe("challenge");
		await opened.close();
	});

	it("lets one of two concurrent uses of an assertion through, on any process", async () => {
		const { passkeys, device, register, opened, clock } = await world();
		await register();
		const other = createPasskeys({ ...opened.again(), clock });
		const assertion = await device.get(await passkeys.approvalChallenge(ada, RP, binding));
		const results = await Promise.allSettled([
			passkeys.verifyApproval(ada, binding, assertion),
			other.verifyApproval(ada, binding, assertion),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		await opened.close();
	});

	it.each([
		["another proposal", { proposalId: "proposal-2" }],
		["other terms", { termsHash: "terms-2" }],
		["another action", { action: "paste" }],
		["a wider narrowing", { narrowing: { methods: ["GET", "POST"], ttlMs: 600_000 } }],
		["no narrowing", { narrowing: undefined }],
	] as const)("refuses an assertion for %s than the decision cites", async (_, change) => {
		const { passkeys, device, register, opened } = await world();
		await register();
		const assertion = await device.get(await passkeys.approvalChallenge(ada, RP, binding));
		const cited: PasskeyBinding = { ...binding, ...change };
		expect(await reasonOf(passkeys.verifyApproval(ada, cited, assertion))).toBe("binding");
		await opened.close();
	});

	it("binds the narrowing whatever order its methods were listed in", async () => {
		const { passkeys, device, register, opened } = await world();
		await register();
		const shown: PasskeyBinding = { ...binding, narrowing: { methods: ["POST", "GET"] } };
		const assertion = await device.get(await passkeys.approvalChallenge(ada, RP, shown));
		await passkeys.verifyApproval(ada, { ...binding, narrowing: { methods: ["GET", "POST"] } }, assertion);
		await opened.close();
	});

	it("refuses a bad signature, another person's passkey, a challenge issued to another person and an expired one", async () => {
		const { passkeys, device, register, clock, opened } = await world();
		await register();
		const signed = async (overrides: Parameters<typeof device.get>[1] = {}, ctx = ada) =>
			device.get(await passkeys.approvalChallenge(ctx, RP, binding), overrides);

		expect(await reasonOf(passkeys.verifyApproval(ada, binding, await signed({ corruptSignature: true })))).toBe(
			"signature",
		);

		// Lin signs Ada's challenge with Lin's own passkey.
		const linDevice = createSoftwareAuthenticator({ origin: RP.origin });
		await passkeys.register(lin, await linDevice.create(await passkeys.registrationOptions(lin, RP)));
		const adaChallenge = await passkeys.approvalChallenge(ada, RP, binding);
		const linSigned = await linDevice.get({ ...adaChallenge, allowCredentials: [] });
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, linSigned))).toBe("credential");

		// Ada's passkey on a challenge Lin was issued: Lin may not borrow it, and Ada may not use Lin's challenge.
		const forLin = await passkeys.approvalChallenge(lin, RP, binding);
		const adaOnLins = await device.get({ ...forLin, allowCredentials: [] });
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, adaOnLins))).toBe("challenge");

		const late = await signed();
		clock.advance(PASSKEY_CHALLENGE_TTL_MILLISECONDS);
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, late))).toBe("challenge");
		await opened.close();
	});

	it("refuses an assertion without user verification, from another origin or for another relying party", async () => {
		const { passkeys, device, register, opened } = await world();
		await register();
		const signed = async (overrides: Parameters<typeof device.get>[1]) =>
			device.get(await passkeys.approvalChallenge(ada, RP, binding), overrides);
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, await signed({ userVerified: false })))).toBe(
			"user_verification",
		);
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, await signed({ origin: "https://evil.test" })))).toBe(
			"origin",
		);
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, await signed({ rpId: "evil.test" })))).toBe("origin");
		await opened.close();
	});

	it("refuses an assertion whose counter went backwards: a cloned passkey", async () => {
		const { passkeys, device, register, opened } = await world({ counting: true });
		await register();
		await passkeys.verifyApproval(ada, binding, await device.get(await passkeys.approvalChallenge(ada, RP, binding)));
		await passkeys.verifyApproval(ada, binding, await device.get(await passkeys.approvalChallenge(ada, RP, binding)));
		const cloned = await device.get(await passkeys.approvalChallenge(ada, RP, binding), { signCount: 1 });
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, cloned))).toBe("counter");
		await opened.close();
	});

	it("refuses a malformed assertion as malformed or an unknown challenge, never as an error", async () => {
		const { passkeys, register, opened } = await world();
		await register();
		const bad = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "!!" } } as never;
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, bad))).toBe("malformed");
		expect(await reasonOf(passkeys.verifyApproval(ada, binding, {} as never))).toBe("malformed");
		await opened.close();
	});

	it("requires a passkey to approve once the person has one, or always", async () => {
		const { passkeys, register, opened, clock } = await world();
		expect(passkeys.approvals).toBe("registered");
		expect(await passkeys.required(ada)).toBe(false);
		await register();
		expect(await passkeys.required(ada)).toBe(true);
		expect(await passkeys.required(lin)).toBe(false);
		const always = createPasskeys({ ...opened.again(), clock, approvals: "always" });
		expect(await always.required(lin)).toBe(true);
		await opened.close();
	});
});

describe("webauthn encoding", () => {
	it("reads base64url, padded or not, and refuses anything else", () => {
		expect([...fromBase64url("AQID")]).toEqual([1, 2, 3]);
		expect([...fromBase64url("AQ==")]).toEqual([1]);
		expect(() => fromBase64url("A+/=")).toThrow();
		expect(() => fromBase64url(3)).toThrow();
	});

	it("decodes the CBOR authenticators write and refuses indefinite lengths and truncation", () => {
		const map = decodeCbor(new Uint8Array([0xa2, 0x01, 0x02, 0x63, 0x66, 0x6d, 0x74, 0x40])).value as Map<
			unknown,
			unknown
		>;
		expect(map.get(1)).toBe(2);
		expect(map.get("fmt")).toEqual(new Uint8Array());
		expect(() => decodeCbor(new Uint8Array([0x9f, 0xff]))).toThrow(/Indefinite/);
		expect(() => decodeCbor(new Uint8Array([0x62, 0x61]))).toThrow(/ends early/);
		expect(() => decodeCbor(new Uint8Array([0xa2, 0x01, 0x02, 0x01, 0x03]))).toThrow(/repeats/);
	});

	it("turns a DER ECDSA signature into WebCrypto's raw form", () => {
		const r = new Uint8Array(32).fill(0x81);
		const s = new Uint8Array(32).fill(0x01);
		const der = new Uint8Array([0x30, 0x45, 0x02, 0x21, 0x00, ...r, 0x02, 0x20, ...s]);
		expect([...derToRawSignature(der)]).toEqual([...r, ...s]);
		expect(() => derToRawSignature(new Uint8Array([0x31, 0x00]))).toThrow();
	});
});

describe("passkey routes", () => {
	/** Stands in for a sign-in: `x-user` signs in a person, `x-key` a host app's key. */
	const authenticator: Authenticator = {
		async authenticate(request): Promise<AuthenticatedCaller> {
			const user = request.headers.get("x-user");
			if (user !== null)
				return { method: "cloudflare_access", actor: { kind: "human", userId: user }, organisationId: ORG };
			if (request.headers.get("x-key") !== null) return { method: "api_key", ...hostApp };
			throw authenticationError("missing", "No credentials");
		},
	};

	function routes(passkeys: Passkeys) {
		const handler = createPasskeyHandler({ passkeys, authenticator, signIn: ["cloudflare_access"] });
		const serve = (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new Request(input, init));
		const client = (headers: Record<string, string>) =>
			createPasskeyClient({ baseUrl: RP.origin, fetch: serve, headers: () => headers });
		return { handler, serve, client };
	}

	it("registers, lists and removes the signed-in person's passkeys", async () => {
		const passkeys = createPasskeys({ ...createMemoryPasskeyStores(), clock: new ManualClock() });
		const { client } = routes(passkeys);
		const device = createSoftwareAuthenticator({ origin: RP.origin });
		const asAda = client({ "x-user": "user-ada" });
		const options: PasskeyRegistrationOptions = await asAda.registrationOptions();
		// The relying party is the origin the request was made to.
		expect(options.rp).toEqual({ id: RP.id, name: "Kantel" });
		const registered = await asAda.register({ response: await device.create(options), name: "  Phone " });
		expect(registered.name).toBe("Phone");
		const listed: PasskeysResponse = await asAda.list();
		expect(listed).toEqual({ items: [registered], approvals: "registered" });
		expect((await client({ "x-user": "user-lin" }).list()).items).toEqual([]);

		// Another needs one of Ada's to confirm it.
		const unconfirmed = await refusal(
			asAda.register({ response: await device.create(await asAda.registrationOptions()) }),
		);
		expect(unconfirmed.details).toEqual({ passkey: "missing" });
		const added = await asAda.register({
			response: await device.create(await asAda.registrationOptions()),
			confirmation: await device.get(await asAda.confirmation({ change: "register" })),
		});
		const removing = { change: "remove", passkeyId: registered.id } as const;
		expect((await refusal(asAda.remove(registered.id))).details).toEqual({ passkey: "missing" });
		await asAda.remove(registered.id, await device.get(await asAda.confirmation(removing)));
		expect((await asAda.list()).items).toEqual([added]);
	});

	it("resets a member's passkeys for the organisation's admin only", async () => {
		const passkeys = createPasskeys({ ...createMemoryPasskeyStores(), clock: new ManualClock(), identity: directory });
		const { client } = routes(passkeys);
		const device = createSoftwareAuthenticator({ origin: RP.origin });
		const asAda = client({ "x-user": "user-ada" });
		await asAda.register({ response: await device.create(await asAda.registrationOptions()) });
		expect((await refusal(asAda.reset("user-ada"))).code).toBe("forbidden");
		expect((await refusal(client({ "x-key": "1" }).reset("user-ada"))).code).toBe("forbidden");
		expect(await client({ "x-user": "user-admin" }).reset("user-ada")).toEqual({ removed: 1 });
		expect((await asAda.list()).items).toEqual([]);
	});

	it("answers a refused registration with its reason", async () => {
		const passkeys = createPasskeys({ ...createMemoryPasskeyStores(), clock: new ManualClock() });
		const { client } = routes(passkeys);
		const device = createSoftwareAuthenticator({ origin: "https://evil.test" });
		const asAda = client({ "x-user": "user-ada" });
		const error = await refusal(asAda.register({ response: await device.create(await asAda.registrationOptions()) }));
		expect(error.code).toBe("refused");
		expect(error.details).toEqual({ passkey: "origin" });
	});

	it("refuses strangers, host apps, other methods, other content types and stray fields", async () => {
		const passkeys = createPasskeys({ ...createMemoryPasskeyStores(), clock: new ManualClock() });
		const { serve } = routes(passkeys);
		const url = (path: string) => `${RP.origin}${path}`;
		const anonymous = await serve(url(PASSKEYS_PATH));
		expect(anonymous.status).toBe(401);
		expect(await anonymous.json()).toMatchObject({ error: { code: "unauthenticated", signIn: ["cloudflare_access"] } });
		expect((await serve(url(PASSKEYS_PATH), { headers: { "x-key": "1" } })).status).toBe(403);
		expect((await serve(url(PASSKEY_REGISTRATION_PATH), { headers: { "x-user": "user-ada" } })).status).toBe(405);
		const notJson = await serve(url(PASSKEY_REGISTRATION_PATH), {
			method: "POST",
			headers: { "x-user": "user-ada", "content-type": "text/plain" },
			body: "{}",
		});
		expect(notJson.status).toBe(415);
		const stray = await serve(url(PASSKEYS_PATH), {
			method: "POST",
			headers: { "x-user": "user-ada", "content-type": "application/json" },
			body: JSON.stringify({ response: {}, extra: 1 }),
		});
		expect(stray.status).toBe(400);
		const missing = await serve(url(passkeyRemovePath("pk_nope")), {
			method: "POST",
			headers: { "x-user": "user-ada", "content-type": "application/json" },
			body: "{}",
		});
		expect(missing.status).toBe(404);
		expect((await serve(url(`${PASSKEYS_PATH}/a/b/remove`))).status).toBe(404);
	});

	it("names its own paths for a router", () => {
		expect(isPasskeyPath(PASSKEYS_PATH)).toBe(true);
		expect(isPasskeyPath(PASSKEY_REGISTRATION_PATH)).toBe(true);
		expect(isPasskeyPath(passkeyRemovePath("pk_1"))).toBe(true);
		expect(isPasskeyPath(PASSKEY_CONFIRMATION_PATH)).toBe(true);
		expect(isPasskeyPath(passkeyResetPath("user-ada"))).toBe(true);
		expect(isPasskeyPath("/v1/members")).toBe(false);
		expect(isPasskeyPath("/v1/members/a/b/passkeys/reset")).toBe(false);
		expect(isPasskeyPath("/v1/me")).toBe(false);
		expect(isPasskeyPath(`${PASSKEYS_PATH}/pk_1`)).toBe(false);
	});

	it("turns a 404 for the routes into not_supported, so a console knows the deployment has no passkeys", async () => {
		const client = createPasskeyClient({
			baseUrl: RP.origin,
			fetch: async () => Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 }),
		});
		expect((await refusal(client.list())).code).toBe("not_supported");
	});
});
