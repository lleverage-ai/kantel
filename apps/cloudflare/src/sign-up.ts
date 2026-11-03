/**
 * Open sign-up on the public origin: anyone who proves an email address with a code is let in, and someone new gets a
 * user of their own and a personal space (an organisation they administer, with a Default project).
 *
 * It wraps the directory only where the email-code sign-in reaches it (`createEmailOtp`'s `canSignIn` and `signIn`).
 * Everything else, the authenticator included, uses the directory as it is: by the time a session is used the user
 * exists. Behind Access nothing changes, and an invited person still joins the organisation that invited them.
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

export function openSignUp(
	identity: IdentityDirectory,
	options: { readonly onSignUp?: (userId: string, organisationId: string) => void } = {},
): Pick<IdentityDirectory, "canSignIn" | "signIn"> {
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
			if (signedIn.organisationIds.length > 0) return signedIn;
			// In no organisation: someone new, or one whose earlier sign-up stopped before its space was made.
			const userId = signedIn.user.id;
			const space = await identity.createOrganisation(SIGN_UP, {
				name: PERSONAL_SPACE_NAME,
				admin: { kind: "user", userId },
			});
			await identity.createProject({ actor: { kind: "human", userId }, organisationId: space.id }, { name: "Default" });
			options.onSignUp?.(userId, space.id);
			return { user: signedIn.user, organisationIds: [space.id] };
		},
	};
}
