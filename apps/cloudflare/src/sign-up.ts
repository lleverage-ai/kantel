/**
 * Open sign-up on the public origin: anyone who proves an email address with a code is let in, and someone new gets a
 * user of their own and a personal space (an organisation they administer, with a Default project).
 *
 * It wraps the directory only where the email-code sign-in reaches it (`createEmailOtp`'s `canSignIn` and `signIn`).
 * Everything else, the authenticator included, uses the directory as it is: by the time a session is used the user
 * exists. Behind Access nothing changes, and an invited person still joins the organisation that invited them.
 *
 * Making a space is three commits (the organisation, its project, the record), and the object may stop between any
 * two. A sign-up record is saved before the first and after each, so the next sign-in finishes what an earlier one
 * started rather than leaving a space with no project or making a second space. One person's sign-ins provision one
 * at a time, so two that overlap can't both start from the same unfinished record.
 */
import {
	type CallContext,
	EMAIL_OTP_ISSUER,
	type ExternalIdentity,
	externalSubjectOf,
	type IdentityDirectory,
	isKantelError,
	normaliseEmail,
	type SignIn,
} from "@kantel/contracts";

/** The organisation ID the sign-up's system context names; identity records it on the users that context makes. */
export const SIGN_UP_ORGANISATION = "sign-up";

const SIGN_UP: CallContext = {
	actor: { kind: "system", component: "cloudflare.sign-up" },
	organisationId: SIGN_UP_ORGANISATION,
};

/** The name a new personal space is given. */
export const PERSONAL_SPACE_NAME = "Personal";

const isEmailCode = (identity: ExternalIdentity): identity is ExternalIdentity & { email: string } =>
	identity.issuer === EMAIL_OTP_ISSUER && identity.emailVerified === true && typeof identity.email === "string";

/** How far a person's sign-up has got: begun, the space made, its project made. */
export interface SignUpRecord {
	readonly organisationId?: string;
	readonly projectId?: string;
}

/** Each person's sign-up record, by user ID; the stack object keeps them in its storage. */
export interface SignUpStore {
	load(userId: string): Promise<SignUpRecord | undefined>;
	save(userId: string, record: SignUpRecord): Promise<void>;
}

export function createMemorySignUpStore(): SignUpStore {
	const records = new Map<string, SignUpRecord>();
	return {
		load: async (userId) => records.get(userId),
		save: async (userId, record) => {
			records.set(userId, record);
		},
	};
}

/** Only a refusal or a miss means "not this one": any other failure is thrown, so a failed read never makes a space. */
const notThisOne = (error: unknown): false => {
	if (isKantelError(error, "forbidden") || isKantelError(error, "not_found")) return false;
	throw error;
};

const withSpace = (signedIn: SignIn, organisationId: string): SignIn =>
	signedIn.organisationIds.includes(organisationId)
		? signedIn
		: { user: signedIn.user, organisationIds: [...signedIn.organisationIds, organisationId] };

export function openSignUp(
	identity: IdentityDirectory,
	options: {
		readonly records?: SignUpStore;
		readonly onSignUp?: (userId: string, organisationId: string) => void;
	} = {},
): Pick<IdentityDirectory, "canSignIn" | "signIn"> {
	const records = options.records ?? createMemorySignUpStore();

	/** The space an earlier attempt made but didn't record: an organisation of theirs by that name that they administer. */
	async function unrecordedSpace(userId: string, organisationIds: readonly string[]): Promise<string | undefined> {
		for (const organisationId of organisationIds) {
			const ctx: CallContext = { actor: { kind: "human", userId }, organisationId };
			const named = await identity
				.getOrganisation(ctx, organisationId)
				.then((organisation) => organisation.name === PERSONAL_SPACE_NAME, notThisOne);
			if (named && (await identity.authorize(ctx, "admin").then(() => true, notThisOne))) return organisationId;
		}
		return undefined;
	}

	/** One provisioning at a time for each person. The stack is one object, so a lock in its memory covers them all. */
	const busy = new Map<string, Promise<void>>();
	async function oneAtATime<T>(userId: string, work: () => Promise<T>): Promise<T> {
		const before = busy.get(userId) ?? Promise.resolve();
		const mine = before.then(work);
		const settled = mine.then(
			() => {},
			() => {},
		);
		busy.set(userId, settled);
		try {
			return await mine;
		} finally {
			if (busy.get(userId) === settled) busy.delete(userId);
		}
	}

	/** Makes `signedIn`'s space, or finishes one an earlier sign-in started, from their record. */
	async function provision(signedIn: SignIn): Promise<SignIn> {
		const userId = signedIn.user.id;
		let record = await records.load(userId);
		if (record === undefined) {
			// Someone already in an organisation (invited) who never signed up has no space to make.
			if (signedIn.organisationIds.length > 0) return signedIn;
			record = {};
			await records.save(userId, record);
		}
		if (record.organisationId !== undefined && record.projectId !== undefined) {
			return withSpace(signedIn, record.organisationId);
		}
		const organisationId =
			record.organisationId ??
			(await unrecordedSpace(userId, signedIn.organisationIds)) ??
			(await identity.createOrganisation(SIGN_UP, { name: PERSONAL_SPACE_NAME, admin: { kind: "user", userId } })).id;
		await records.save(userId, { organisationId });
		const inSpace: CallContext = { actor: { kind: "human", userId }, organisationId };
		const [existing] = (await identity.listProjects(inSpace, { limit: 1 })).items;
		const projectId = existing?.id ?? (await identity.createProject(inSpace, { name: "Default" })).id;
		await records.save(userId, { organisationId, projectId });
		options.onSignUp?.(userId, organisationId);
		return withSpace(signedIn, organisationId);
	}

	/** A user for this proven address, linked to the code's subject. A concurrent first sign-in may have made it. */
	async function makeUser(external: ExternalIdentity & { email: string }): Promise<void> {
		try {
			await identity.createUser(SIGN_UP, {
				name: external.email,
				email: external.email,
				externalSubject: externalSubjectOf(external.issuer, external.subject),
			});
		} catch (error) {
			if (!isKantelError(error, "conflict")) throw error;
		}
	}

	return {
		async canSignIn(ctx, external) {
			// Every proven address may sign in: someone new signs up.
			if (isEmailCode(external) && normaliseEmail(external.email) !== "") return true;
			return identity.canSignIn(ctx, external);
		},
		async signIn(ctx, external): Promise<SignIn> {
			if (!isEmailCode(external)) return identity.signIn(ctx, external);
			let signedIn: SignIn;
			try {
				signedIn = await identity.signIn(ctx, external);
			} catch (error) {
				// No user matches, and no invite waits for them: someone new.
				if (!isKantelError(error, "forbidden")) throw error;
				await makeUser(external);
				signedIn = await identity.signIn(ctx, external);
			}
			return oneAtATime(signedIn.user.id, () => provision(signedIn));
		},
	};
}
