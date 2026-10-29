/**
 * Passkeys (#132): a person's registered passkeys, and the single-use challenges that register one or approve a vault
 * proposal with one. Portable: WebCrypto and globals only. The stores are interfaces, so a deployment keeps them in its
 * database (`./passkey-sql.ts`, on D1 or Postgres) and tests keep them in memory.
 *
 * - `registrationOptions` issues a registration challenge for the person; `register` verifies the browser's new
 *   passkey against it (`./webauthn.ts`), uses it up and stores the public key. Audited `identity.passkey.registered`.
 * - `approvalChallenge` issues a challenge bound to the person, the relying party, and a `PasskeyBinding` (proposal,
 *   terms hash, action, narrowing). `verifyApproval` takes the challenge the assertion signed out of the store first,
 *   so it is used once whatever happens next, then checks that it was issued to this person for this binding, and that
 *   the assertion is a valid one from one of the person's passkeys. Refusals are `refused` with `details.passkey` (a
 *   `PasskeyRefusal`); the caller audits them (the approval API does, as `vault.passkey.refused`).
 * - `required` says whether the person must use a passkey to approve: always (`approvals: "always"`), or once they
 *   have registered one (`"registered"`, the default, so a deployment's people are not locked out on the day passkeys
 *   arrive).
 */
import {
	type AuditSink,
	type CallContext,
	type Clock,
	HarbourError,
	type IdentityDirectory,
	type Narrowing,
	PASSKEY_NAME_MAX_LENGTH,
	type Passkey,
	type PasskeyAssertion,
	type PasskeyAttestation,
	type PasskeyBinding,
	type PasskeyChallenge,
	type PasskeyDescriptor,
	type PasskeyRefusal,
	type PasskeyRegistrationOptions,
	type RelyingParty,
	type SystemContext,
	systemClock,
	systemContext,
	type Timestamp,
	type UserId,
} from "@harbour/contracts";
import {
	clientChallengeOf,
	fromBase64url,
	randomChallenge,
	type StoredPublicKey,
	SUPPORTED_COSE_ALGORITHMS,
	toBase64url,
	verifyAssertion,
	verifyRegistration,
	WebAuthnError,
} from "./webauthn.ts";

const PASSKEY_CONTEXT: SystemContext = systemContext("identity.passkey");

/** How long a challenge is accepted: the browser's prompt waits two minutes, and the round trips need a little more. */
export const PASSKEY_CHALLENGE_TTL_MILLISECONDS = 5 * 60_000;
/** How long the browser waits for the person, as the options say. */
export const PASSKEY_TIMEOUT_MILLISECONDS = 120_000;
/** The most passkeys one person may register. */
export const PASSKEYS_PER_PERSON = 20;

/** A passkey as stored: the public record and its public key and counter. */
export interface StoredPasskey extends Passkey {
	readonly publicKey: StoredPublicKey;
	readonly signCount: number;
}

/** What a challenge is for. */
export type ChallengePurpose = "registration" | "approval";

export interface PasskeyChallengeRecord {
	/** The challenge, base64url: what the client signs, and the record's key. */
	readonly challenge: string;
	readonly userId: UserId;
	readonly purpose: ChallengePurpose;
	readonly rpId: string;
	readonly origin: string;
	/** For an approval: what the assertion approves. */
	readonly binding?: PasskeyBinding;
	readonly createdAt: Timestamp;
	readonly expiresAt: Timestamp;
}

/** Single-use challenges. */
export interface PasskeyChallengeStore {
	/** Stores a new challenge, and drops those expired by `now`. */
	put(record: PasskeyChallengeRecord, now: Timestamp): Promise<void>;
	/**
	 * Removes the challenge and returns it, if it was there: atomically, so of two concurrent takes only one gets it.
	 * The caller checks its expiry.
	 */
	take(challenge: string): Promise<PasskeyChallengeRecord | undefined>;
}

/** A person's passkeys. */
export interface PasskeyCredentialStore {
	/** Adds a passkey; false when its credential ID is registered already (to anyone). */
	add(passkey: StoredPasskey): Promise<boolean>;
	listByUser(userId: UserId): Promise<readonly StoredPasskey[]>;
	findByCredentialId(credentialId: string): Promise<StoredPasskey | undefined>;
	/**
	 * Records a use: the new counter and when, only while the counter is still `from`. False when another use moved it
	 * first, so two racing assertions cannot both pass the counter check.
	 */
	recordUse(id: string, use: { readonly from: number; readonly to: number; readonly at: Timestamp }): Promise<boolean>;
	/** Removes one of the person's passkeys; the removed one, or `undefined` when they have none with that ID. */
	remove(userId: UserId, id: string): Promise<StoredPasskey | undefined>;
}

/** The stores in memory, for tests and the in-memory stack. */
export function createMemoryPasskeyStores(): {
	readonly credentials: PasskeyCredentialStore;
	readonly challenges: PasskeyChallengeStore;
} {
	const passkeys = new Map<string, StoredPasskey>();
	const challenges = new Map<string, PasskeyChallengeRecord>();
	return {
		credentials: {
			async add(passkey) {
				for (const existing of passkeys.values()) if (existing.credentialId === passkey.credentialId) return false;
				passkeys.set(passkey.id, passkey);
				return true;
			},
			async listByUser(userId) {
				return [...passkeys.values()].filter((passkey) => passkey.userId === userId);
			},
			async findByCredentialId(credentialId) {
				return [...passkeys.values()].find((passkey) => passkey.credentialId === credentialId);
			},
			async recordUse(id, use) {
				const passkey = passkeys.get(id);
				if (passkey === undefined || passkey.signCount !== use.from) return false;
				passkeys.set(id, { ...passkey, signCount: use.to, lastUsedAt: use.at });
				return true;
			},
			async remove(userId, id) {
				const passkey = passkeys.get(id);
				if (passkey === undefined || passkey.userId !== userId) return undefined;
				passkeys.delete(id);
				return passkey;
			},
		},
		challenges: {
			async put(record, now) {
				for (const [key, existing] of challenges) if (existing.expiresAt <= now) challenges.delete(key);
				challenges.set(record.challenge, record);
			},
			async take(challenge) {
				const record = challenges.get(challenge);
				challenges.delete(challenge);
				return record;
			},
		},
	};
}

export interface PasskeysOptions {
	readonly credentials: PasskeyCredentialStore;
	readonly challenges: PasskeyChallengeStore;
	/** For the name and display name a new passkey is saved under on the person's device. Default their user ID. */
	readonly identity?: Pick<IdentityDirectory, "getUser">;
	readonly clock?: Clock;
	/** Where `identity.passkey.registered` and `identity.passkey.removed` go. */
	readonly audit?: AuditSink;
	/**
	 * When approving needs a passkey: `"registered"` (default) once the person has one, so nobody is locked out before
	 * they register; `"always"` for every approval.
	 */
	readonly approvals?: "always" | "registered";
}

export interface Passkeys {
	readonly approvals: "always" | "registered";
	/** The person's passkeys. */
	list(ctx: CallContext): Promise<readonly Passkey[]>;
	/** A registration challenge for the person, as the options the browser's `create` takes. */
	registrationOptions(ctx: CallContext, rp: RelyingParty): Promise<PasskeyRegistrationOptions>;
	/** Verifies a new passkey against the registration challenge it signed, which it uses up, and stores it. */
	register(ctx: CallContext, response: PasskeyAttestation, name?: string): Promise<Passkey>;
	/** Removes one of the person's passkeys. `not_found` for anyone else's. */
	remove(ctx: CallContext, passkeyId: string): Promise<void>;
	/** Whether the person must confirm an approval with a passkey. */
	required(ctx: CallContext): Promise<boolean>;
	/** A single-use challenge for approving `binding`, as the options the browser's `get` takes. */
	approvalChallenge(ctx: CallContext, rp: RelyingParty, binding: PasskeyBinding): Promise<PasskeyChallenge>;
	/**
	 * Verifies an approval's assertion: its challenge (used up here, whatever the outcome) was issued to this person for
	 * exactly `binding`, and one of their passkeys signed it with their verification. Resolves the passkey used;
	 * rejects `refused` with `details.passkey`.
	 */
	verifyApproval(ctx: CallContext, binding: PasskeyBinding, assertion: PasskeyAssertion): Promise<Passkey>;
}

/** The person behind a call; anyone else has no passkeys. */
function personOf(ctx: CallContext): UserId {
	if (ctx.actor.kind !== "human") throw new HarbourError("forbidden", "Only a person has passkeys");
	return ctx.actor.userId;
}

/** A refusal, as `verifyApproval` and `register` reject. */
export function passkeyRefusal(reason: PasskeyRefusal, message: string): HarbourError {
	return new HarbourError("refused", message, { passkey: reason });
}

/** The public record of a stored passkey. */
export function publicPasskey(stored: StoredPasskey): Passkey {
	const { publicKey: _key, signCount: _count, ...passkey } = stored;
	return passkey;
}

/** A credential ID as stored (unpadded base64url), or "" when it isn't one. */
function canonicalId(id: unknown): string {
	try {
		return toBase64url(fromBase64url(id));
	} catch {
		return "";
	}
}

const descriptorOf = (passkey: Passkey): PasskeyDescriptor => ({
	type: "public-key",
	id: passkey.credentialId,
	...(passkey.transports === undefined ? {} : { transports: passkey.transports }),
});

/** A narrowing in one canonical form, so the one the page showed and the one the decision cites compare as text. */
export function canonicalNarrowing(narrowing: Narrowing | undefined): string {
	if (narrowing === undefined) return "{}";
	return JSON.stringify({
		...(narrowing.methods === undefined ? {} : { methods: [...narrowing.methods].sort() }),
		...(narrowing.pathPrefix === undefined ? {} : { pathPrefix: narrowing.pathPrefix }),
		...(narrowing.ttlMs === undefined ? {} : { ttlMs: narrowing.ttlMs }),
		...(narrowing.maxUses === undefined ? {} : { maxUses: narrowing.maxUses }),
	});
}

/** Whether two bindings name the same proposal, terms, action and narrowing. */
export function sameBinding(a: PasskeyBinding, b: PasskeyBinding): boolean {
	return (
		a.proposalId === b.proposalId &&
		a.termsHash === b.termsHash &&
		a.action === b.action &&
		canonicalNarrowing(a.narrowing) === canonicalNarrowing(b.narrowing)
	);
}

function passkeyName(name: unknown): string {
	if (name === undefined) return "Passkey";
	if (typeof name !== "string" || name.trim() === "") throw new HarbourError("invalid", "A passkey's name is text");
	const trimmed = name.trim();
	if (trimmed.length > PASSKEY_NAME_MAX_LENGTH) {
		throw new HarbourError("invalid", `A passkey's name is at most ${PASSKEY_NAME_MAX_LENGTH} characters`);
	}
	return trimmed;
}

export function createPasskeys(options: PasskeysOptions): Passkeys {
	const { credentials, challenges, audit } = options;
	const clock = options.clock ?? systemClock;
	const approvals = options.approvals ?? "registered";

	async function issue(
		userId: UserId,
		purpose: ChallengePurpose,
		rp: RelyingParty,
		binding?: PasskeyBinding,
	): Promise<PasskeyChallengeRecord> {
		const now = clock.now();
		const record: PasskeyChallengeRecord = {
			challenge: randomChallenge(),
			userId,
			purpose,
			rpId: rp.id,
			origin: rp.origin,
			...(binding === undefined ? {} : { binding }),
			createdAt: now,
			expiresAt: now + PASSKEY_CHALLENGE_TTL_MILLISECONDS,
		};
		await challenges.put(record, now);
		return record;
	}

	/** Takes the challenge the client signed out of the store, and checks it was this person's, for `purpose`. */
	async function takeChallenge(
		userId: UserId,
		purpose: ChallengePurpose,
		clientDataJSON: unknown,
		type: "webauthn.create" | "webauthn.get",
	): Promise<PasskeyChallengeRecord> {
		let signed: string;
		try {
			signed = clientChallengeOf(clientDataJSON, type);
		} catch (error) {
			if (error instanceof WebAuthnError) throw passkeyRefusal(error.reason, error.message);
			throw error;
		}
		const record = await challenges.take(signed);
		if (
			record === undefined ||
			record.expiresAt <= clock.now() ||
			record.userId !== userId ||
			record.purpose !== purpose
		) {
			throw passkeyRefusal("challenge", "The passkey challenge is unknown, used or expired");
		}
		return record;
	}

	async function emit(
		ctx: CallContext,
		type: "identity.passkey.registered" | "identity.passkey.removed",
		passkey: Passkey,
	): Promise<void> {
		await audit?.append(PASSKEY_CONTEXT, [
			{
				id: `identity:${type}:${passkey.id}`,
				at: clock.now(),
				source: "identity",
				type,
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				subject: { kind: "identity.passkey", id: passkey.id },
				data: { name: passkey.name, rpId: passkey.rpId, backedUp: passkey.backedUp },
			},
		]);
	}

	return {
		approvals,

		async list(ctx) {
			const userId = personOf(ctx);
			return (await credentials.listByUser(userId)).map(publicPasskey);
		},

		async registrationOptions(ctx, rp) {
			const userId = personOf(ctx);
			const user = await options.identity?.getUser(ctx, userId).catch(() => undefined);
			const existing = await credentials.listByUser(userId);
			if (existing.length >= PASSKEYS_PER_PERSON) {
				throw new HarbourError("exhausted", `A person may register at most ${PASSKEYS_PER_PERSON} passkeys`);
			}
			const record = await issue(userId, "registration", rp);
			return {
				challenge: record.challenge,
				rp: { id: rp.id, name: rp.name },
				user: {
					id: toBase64url(new TextEncoder().encode(userId)),
					name: user?.email ?? user?.name ?? userId,
					displayName: user?.name ?? userId,
				},
				pubKeyCredParams: SUPPORTED_COSE_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
				timeout: PASSKEY_TIMEOUT_MILLISECONDS,
				attestation: "none",
				authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
				excludeCredentials: existing.map(descriptorOf),
			};
		},

		async register(ctx, response, name) {
			const userId = personOf(ctx);
			const label = passkeyName(name);
			const record = await takeChallenge(userId, "registration", response?.response?.clientDataJSON, "webauthn.create");
			let verified: Awaited<ReturnType<typeof verifyRegistration>>;
			try {
				verified = await verifyRegistration(response, record.challenge, { id: record.rpId, origin: record.origin });
			} catch (error) {
				if (error instanceof WebAuthnError) throw passkeyRefusal(error.reason, error.message);
				throw error;
			}
			if ((await credentials.listByUser(userId)).length >= PASSKEYS_PER_PERSON) {
				throw new HarbourError("exhausted", `A person may register at most ${PASSKEYS_PER_PERSON} passkeys`);
			}
			const stored: StoredPasskey = {
				id: `pk_${crypto.randomUUID()}`,
				userId,
				credentialId: verified.credentialId,
				name: label,
				rpId: record.rpId,
				...(verified.transports === undefined ? {} : { transports: verified.transports }),
				backedUp: verified.backedUp,
				createdAt: clock.now(),
				publicKey: verified.publicKey,
				signCount: verified.signCount,
			};
			if (!(await credentials.add(stored))) {
				throw new HarbourError("conflict", "That passkey is registered already");
			}
			const passkey = publicPasskey(stored);
			await emit(ctx, "identity.passkey.registered", passkey);
			return passkey;
		},

		async remove(ctx, passkeyId) {
			const userId = personOf(ctx);
			const removed = await credentials.remove(userId, passkeyId);
			if (removed === undefined) throw new HarbourError("not_found", "No such passkey");
			await emit(ctx, "identity.passkey.removed", publicPasskey(removed));
		},

		async required(ctx) {
			if (ctx.actor.kind !== "human") return approvals === "always";
			if (approvals === "always") return true;
			return (await credentials.listByUser(ctx.actor.userId)).length > 0;
		},

		async approvalChallenge(ctx, rp, binding) {
			const userId = personOf(ctx);
			const passkeys = (await credentials.listByUser(userId)).filter((passkey) => passkey.rpId === rp.id);
			const record = await issue(userId, "approval", rp, {
				proposalId: binding.proposalId,
				termsHash: binding.termsHash,
				action: binding.action,
				...(binding.narrowing === undefined ? {} : { narrowing: binding.narrowing }),
			});
			return {
				challenge: record.challenge,
				rpId: rp.id,
				allowCredentials: passkeys.map(descriptorOf),
				userVerification: "required",
				timeout: PASSKEY_TIMEOUT_MILLISECONDS,
				expiresAt: record.expiresAt,
			};
		},

		async verifyApproval(ctx, binding, assertion) {
			const userId = personOf(ctx);
			const record = await takeChallenge(userId, "approval", assertion?.response?.clientDataJSON, "webauthn.get");
			if (record.binding === undefined || !sameBinding(record.binding, binding)) {
				throw passkeyRefusal("binding", "The passkey confirmed other terms than the decision cites");
			}
			const stored = await credentials.findByCredentialId(canonicalId(assertion.rawId));
			if (stored === undefined || stored.userId !== userId || stored.rpId !== record.rpId) {
				throw passkeyRefusal("credential", "That passkey is not one of yours");
			}
			let verified: Awaited<ReturnType<typeof verifyAssertion>>;
			try {
				verified = await verifyAssertion(
					assertion,
					record.challenge,
					{ id: record.rpId, origin: record.origin },
					stored,
				);
			} catch (error) {
				if (error instanceof WebAuthnError) throw passkeyRefusal(error.reason, error.message);
				throw error;
			}
			const at = clock.now();
			if (!(await credentials.recordUse(stored.id, { from: stored.signCount, to: verified.signCount, at }))) {
				throw passkeyRefusal("counter", "The passkey was used twice at once");
			}
			return publicPasskey({ ...stored, signCount: verified.signCount, lastUsedAt: at });
		},
	};
}
