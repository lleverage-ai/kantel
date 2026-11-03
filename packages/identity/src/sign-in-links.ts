/**
 * One-time sign-in links: how a deployment's first admin signs in before any sign-in provider is set up, and how an
 * operator gets back in if one breaks. Someone with access to the deployment's database makes a link for a user
 * (`createSignInLink`); the console redeems it once, within `SIGN_IN_LINK_TTL_MILLISECONDS`, for a Kantel session.
 *
 * - The token is `ktl_` and 32 random bytes; only its SHA-256 is stored, and redeeming it is one guarded write, so a
 *   link signs in once however many tabs race for it.
 * - The session's identity is `{ issuer: SIGN_IN_LINK_ISSUER, subject: <user ID> }`: `signIn` finds that user by ID and
 *   links nothing, so the user may still link GitHub (by a verified email) later.
 * - Nothing here logs the token. Whoever makes the link prints it once, to the operator who asked.
 */
import {
	type Clock,
	type ExternalIdentity,
	KantelError,
	SIGN_IN_LINK_ISSUER,
	SIGN_IN_LINK_PREFIX,
	SIGN_IN_LINK_TTL_MILLISECONDS,
	systemClock,
	type Timestamp,
	type UserId,
} from "@kantel/contracts";
import { hashSessionToken, randomToken } from "./sessions.ts";

export interface SignInLinkRecord {
	readonly id: string;
	/** `hashSignInLink(token)`. */
	readonly tokenHash: string;
	readonly userId: UserId;
	readonly createdAt: Timestamp;
	readonly expiresAt: Timestamp;
}

/** Where sign-in links live. */
export interface SignInLinkStore {
	create(link: SignInLinkRecord): Promise<void>;
	/** Uses the link with `tokenHash` if it is unused and unexpired at `now`, and resolves it; else undefined. */
	redeem(tokenHash: string, now: Timestamp): Promise<SignInLinkRecord | undefined>;
}

/** Whether `token` looks like a sign-in link's token. */
export const isSignInLinkToken = (token: unknown): token is string =>
	typeof token === "string" && token.startsWith(SIGN_IN_LINK_PREFIX) && token.length > SIGN_IN_LINK_PREFIX.length;

/** The stored hash of a link's token: its hex SHA-256. */
export const hashSignInLink = (token: string): Promise<string> => hashSessionToken(token);

/** The identity a link's session signs in as. */
export const signInLinkIdentity = (userId: UserId): ExternalIdentity => ({
	issuer: SIGN_IN_LINK_ISSUER,
	subject: userId,
});

export interface CreatedSignInLink {
	/** The token, shown once: the console's `CONSOLE_SIGN_IN_LINK_PATH#<token>` redeems it. */
	readonly token: string;
	readonly expiresAt: Timestamp;
}

/** Makes a one-time sign-in link for `userId`. */
export async function createSignInLink(
	store: SignInLinkStore,
	userId: UserId,
	options: { readonly clock?: Clock; readonly ttlMilliseconds?: number } = {},
): Promise<CreatedSignInLink> {
	if (typeof userId !== "string" || userId === "") throw new KantelError("invalid", "a sign-in link needs a user");
	const clock = options.clock ?? systemClock;
	const ttl = options.ttlMilliseconds ?? SIGN_IN_LINK_TTL_MILLISECONDS;
	const now = clock.now();
	const token = randomToken(SIGN_IN_LINK_PREFIX);
	await store.create({
		id: `sil_${crypto.randomUUID()}`,
		tokenHash: await hashSignInLink(token),
		userId,
		createdAt: now,
		expiresAt: now + ttl,
	});
	return { token, expiresAt: now + ttl };
}

/** An in-memory sign-in link store, for tests and single-process development. */
export function createMemorySignInLinkStore(): SignInLinkStore {
	const byHash = new Map<string, SignInLinkRecord & { used: boolean }>();
	return {
		async create(link) {
			byHash.set(link.tokenHash, { ...link, used: false });
		},
		async redeem(tokenHash, now) {
			const link = byHash.get(tokenHash);
			if (link === undefined || link.used || link.expiresAt <= now) return undefined;
			link.used = true;
			const { used: _used, ...record } = link;
			return record;
		},
	};
}
