/**
 * Who a signed-in call is: the one place a gateway route (the compute API, Kantel Connect) turns a request into a
 * person. See `SignedInPerson` in `@kantel/contracts` (`sign-in.ts`) for the model.
 */
import {
	type AuthenticatedCaller,
	type Authenticator,
	callContextFor,
	type IdentityDirectory,
	type SignedInPerson,
} from "@kantel/contracts";
import { hashSessionToken, sessionBearer } from "./sessions.ts";

/**
 * The person `request` is signed in as, or undefined for an API key, no credentials or credentials that don't verify.
 * `identity` says whether they administer the organisation they act in (a sign-in carries no role of its own) and
 * gives their name and email; without `getUser` the name is their user ID.
 */
export async function signedInPerson(
	authenticator: Authenticator,
	identity: Pick<IdentityDirectory, "authorize"> & Partial<Pick<IdentityDirectory, "getUser">>,
	request: Request,
): Promise<SignedInPerson | undefined> {
	let caller: AuthenticatedCaller;
	try {
		caller = await authenticator.authenticate(request);
	} catch {
		return undefined;
	}
	if (caller.actor.kind !== "human") return undefined;
	const userId = caller.actor.userId;
	const ctx = callContextFor(caller);
	const [admin, user] = await Promise.all([
		identity.authorize(ctx, "admin").then(
			() => true,
			() => false,
		),
		identity.getUser?.(ctx, userId).catch(() => undefined),
	]);
	// A Kantel session can be ended (signing out), so access given under it records which one, to end with it.
	const bearer = sessionBearer(request);
	const session = bearer === undefined ? undefined : await hashSessionToken(bearer);
	const email = user?.email === undefined || user.email === "" ? undefined : user.email;
	return {
		userId,
		name: user?.name ?? userId,
		...(email === undefined ? {} : { email }),
		method: caller.method,
		organisationId: caller.organisationId,
		admin,
		...(session === undefined ? {} : { session }),
	};
}
