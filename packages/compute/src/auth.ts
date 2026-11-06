/**
 * Who is calling the compute plane, and what they may do. A bearer `ksk_…` is an API key, found by the SHA-256 of its
 * secret and refused once revoked or expired; it acts in its own account with its scopes. Any other bearer is handed to
 * the host's `authenticatePerson` (a sign-in the deployment checks); a person is given a personal account the first
 * time they are seen, and acts in it unless a call's `account` names an organisation they belong to. A person's rights
 * follow their role there: a `member` lacks `account:admin`, an admin or owner has it, and only a deployment
 * super-admin has `hosts:admin`.
 *
 * A bearer `kpt_…` is a personal access token: it signs in as its person, as a sign-in does, with limits of its own
 * (`PersonPrincipal.token`): only the accounts it names, if it names any, and none whose organisation blocks personal
 * tokens; no scope it doesn't hold, when it holds a set; never as a deployment super-admin; and never for what only a
 * person at the console does (`requireSignIn`): approving a device's sign-in, or deleting their account.
 */
import type { computeSchema } from "@kantel/api";
import { API_KEY_LAST_USED_PRECISION_MS, KantelError } from "@kantel/contracts";
import { isPlaceholderName, personName } from "./names.ts";
import {
	type ComputeStore,
	PERSONAL_ACCOUNT_PREFIX,
	type StoredAccount,
	type StoredApiKey,
	type StoredPersonalToken,
	type StoredUser,
} from "./store.ts";
import { randomSecret, sha256Hex } from "./util.ts";

/** A signed-in person, as the host's authenticator reports them. */
export interface PersonIdentity {
	readonly userId: string;
	readonly email?: string;
	/** Their name as sign-in has it. Empty or their user ID when it has none: they are then called by their email. */
	readonly name: string;
	readonly superAdmin?: boolean;
	/**
	 * The sign-in itself, when the deployment can end it (a Kantel session's token hash): access relayed for this
	 * sign-in ends when it does, as `sessionLive` reports.
	 */
	readonly session?: string;
}

/** Checks a request's sign-in (any bearer but an API key); `undefined` when it is not one. */
export type AuthenticatePerson = (request: Request) => Promise<PersonIdentity | undefined>;

/** A call signed in with an API key. */
export interface KeyPrincipal {
	readonly kind: "key";
	readonly keyId: string;
	readonly keyName: string;
	readonly accountId: string;
	readonly scopes: readonly computeSchema.ApiKeyScope[];
	/** What the key is limited to besides its scopes. */
	readonly limits: { readonly sandboxIds?: readonly string[] };
	/** The person the key acts for. */
	readonly userId: string;
	readonly superAdmin: boolean;
}

/** What a personal access token limits its person to (`PersonPrincipal.token`). */
export interface PersonalTokenLimits {
	readonly id: string;
	readonly name: string;
	/** At most these scopes, on top of the person's role. Absent: whatever their role allows. */
	readonly scopes?: readonly computeSchema.ApiKeyScope[];
	/** Only these accounts. Absent: every account the person belongs to. */
	readonly accounts?: readonly string[];
	readonly expiresAt: number;
}

/** A call signed in as a person. */
export interface PersonPrincipal {
	readonly kind: "person";
	readonly userId: string;
	readonly email?: string;
	readonly name: string;
	readonly superAdmin: boolean;
	readonly personalAccountId: string;
	/** The sign-in, when it can be ended (`PersonIdentity.session`). */
	readonly session?: string;
	/** Signed in with a personal access token: its limits. */
	readonly token?: PersonalTokenLimits;
}

export type Principal = KeyPrincipal | PersonPrincipal;

/**
 * Who was given access a relay carries on with after the call (a tunnel ticket, an exposed port's URL): a key, or a
 * person and their sign-in. The relay asks `ComputeService.stillAllowed` while the access lasts, so revoking the key,
 * signing out or leaving the account ends it.
 */
export type Grantee =
	| { readonly kind: "key"; readonly keyId: string }
	| { readonly kind: "person"; readonly userId: string; readonly session?: string }
	/**
	 * A personal access token's: a kind of its own, not a `person` with a token beside it, so a gateway from before
	 * personal tokens can't read it as its person, unlimited, and refuses it instead.
	 */
	| { readonly kind: "token"; readonly userId: string; readonly tokenId: string };

/** The grantee a principal is, as the relay keeps it. */
export function encodeGrantee(principal: Principal): string {
	const grantee: Grantee =
		principal.kind === "key"
			? { kind: "key", keyId: principal.keyId }
			: principal.token !== undefined
				? { kind: "token", userId: principal.userId, tokenId: principal.token.id }
				: {
						kind: "person",
						userId: principal.userId,
						...(principal.session === undefined ? {} : { session: principal.session }),
					};
	return JSON.stringify(grantee);
}

/** A grantee `encodeGrantee` wrote, or undefined for anything else. */
export function decodeGrantee(text: string): Grantee | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { kind?: unknown; keyId?: unknown; userId?: unknown; session?: unknown; tokenId?: unknown };
	if (record.kind === "key" && typeof record.keyId === "string") return { kind: "key", keyId: record.keyId };
	if (record.kind === "token" && typeof record.userId === "string" && typeof record.tokenId === "string") {
		return { kind: "token", userId: record.userId, tokenId: record.tokenId };
	}
	if (record.kind === "person" && typeof record.userId === "string") {
		if (record.session !== undefined && typeof record.session !== "string") return undefined;
		return {
			kind: "person",
			userId: record.userId,
			...(record.session === undefined ? {} : { session: record.session }),
		};
	}
	return undefined;
}

/** The principal a key is now, as `authenticate` would make it. */
export function keyPrincipal(key: StoredApiKey): KeyPrincipal {
	return {
		kind: "key",
		keyId: key.id,
		keyName: key.name,
		accountId: key.accountId,
		scopes: key.scopes,
		limits: key.sandboxIds === undefined ? {} : { sandboxIds: key.sandboxIds },
		userId: key.ownerUserId,
		superAdmin: key.scopes.includes("hosts:admin"),
	};
}

/** The call has no valid credential: answered 401 `unauthenticated`. */
export class UnauthenticatedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnauthenticatedError";
	}
}

/** The prefix of every API key's secret. */
export const API_KEY_PREFIX = "ksk_";
/** A personal access token's secret starts with this. */
export const PERSONAL_TOKEN_PREFIX = "kpt_";

/** A new personal access token's secret, `kpt_` and 32 base62 characters, with its prefix and hash. */
export async function newPersonalTokenSecret(): Promise<{ secret: string; prefix: string; hash: string }> {
	const secret = randomSecret(PERSONAL_TOKEN_PREFIX, 32);
	return { secret, prefix: secret.slice(0, 8), hash: await sha256Hex(secret) };
}

/** A new API key secret, `ksk_` and 32 base62 characters, with its prefix and hash. */
export async function newApiKeySecret(): Promise<{ secret: string; prefix: string; hash: string }> {
	const secret = randomSecret(API_KEY_PREFIX, 32);
	return { secret, prefix: secret.slice(0, 8), hash: await sha256Hex(secret) };
}

/** The request's bearer token, or undefined. */
export function bearerOf(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (header === null) return undefined;
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match?.[1];
}

/**
 * The ID of the personal account a person is given when first seen: theirs alone, so a deletion of theirs knows it
 * without looking for it, however far a sign-in racing the deletion got.
 */
export const personalAccountIdOf = (userId: string): string => `${PERSONAL_ACCOUNT_PREFIX}${userId}`;

/** A membership's ID. */
export const memberId = (accountId: string, userId: string): string => `${accountId}:${userId}`;

/**
 * The name a person's record should have: the one sign-in gives, else the real one stored (a sign-in that carries no
 * name never wipes it), else their email, else their user ID. A stored name that was only their email stands in for a
 * name, so a later sign-in's email replaces it.
 */
function nameFor(identity: PersonIdentity, existing: StoredUser | undefined): string {
	if (!isPlaceholderName(identity.name, identity.userId)) return identity.name.trim();
	const email = identity.email ?? existing?.email;
	if (existing !== undefined && !isPlaceholderName(existing.name, existing.id) && existing.name !== existing.email) {
		return existing.name;
	}
	return personName({ userId: identity.userId, email });
}

/**
 * The person's user record, made with their personal account the first time they are seen, and kept up to date. Their
 * personal account is named as they are, and renamed with them unless they renamed it (one made while gateways named
 * people by their user ID is).
 */
/**
 * A person's owner membership and personal account, each only while they are active (`PersonWrites`) and only if
 * absent: a retirement landing in between stops the rest, and the deletion that retired them finds whatever had landed
 * before (by its ID, which is theirs: `personalAccountIdOf`).
 */
async function provisionPersonal(
	store: ComputeStore,
	user: StoredUser,
	account: StoredAccount,
	now: number,
): Promise<void> {
	await store.personWrites.insertMember({
		id: memberId(account.id, user.id),
		accountId: account.id,
		userId: user.id,
		role: "owner",
		joinedAt: now,
	});
	await store.personWrites.insertAccount(account, user.id);
}

export async function ensurePerson(
	store: ComputeStore,
	identity: PersonIdentity,
	now: number,
	again = true,
): Promise<StoredUser> {
	const existing = await store.users.get(identity.userId);
	const superAdmin = identity.superAdmin === true;
	const name = nameFor(identity, existing);
	if (existing !== undefined) {
		// Retired by their account deletion: never let in, nor made again.
		if (existing.retiredAt !== undefined) throw new KantelError("forbidden", "This account has been deleted");
		// A first sign-in that stopped after making them, before their membership or account: finished now, as it would
		// have been (both inserts are only-if-absent and only while they are active, so this can be made any number of
		// times).
		if (existing.personalAccountId === personalAccountIdOf(existing.id)) {
			const [account, member] = await Promise.all([
				store.accounts.get(existing.personalAccountId),
				store.members.get(memberId(existing.personalAccountId, existing.id)),
			]);
			if (account === undefined || member === undefined) {
				await provisionPersonal(
					store,
					existing,
					{
						id: existing.personalAccountId,
						kind: "personal",
						name: existing.name,
						defaultVisibility: "private",
						createdAt: now,
					},
					now,
				);
			}
		}
		const email = identity.email ?? existing.email;
		if (existing.name !== name || existing.email !== email || existing.superAdmin !== superAdmin) {
			// An update of the record as it is, never a write over a retirement that landed meanwhile.
			const updated = await store.users.update(existing.id, (current) =>
				current.retiredAt !== undefined
					? undefined
					: { ...current, name, superAdmin, ...(email === undefined ? {} : { email }) },
			);
			if (updated === undefined) throw new KantelError("forbidden", "This account has been deleted");
			if (existing.name !== name) {
				// Unless they renamed it themselves, as the account is when the write lands: a name saved meanwhile stays.
				await store.accounts.update(existing.personalAccountId, (personal) =>
					personal.name !== name && (personal.name === existing.name || isPlaceholderName(personal.name, existing.id))
						? { ...personal, name }
						: undefined,
				);
			}
			return updated;
		}
		return existing;
	}
	const account: StoredAccount = {
		id: personalAccountIdOf(identity.userId),
		kind: "personal",
		name,
		defaultVisibility: "private",
		createdAt: now,
	};
	const user: StoredUser = {
		id: identity.userId,
		name,
		superAdmin,
		personalAccountId: account.id,
		createdAt: now,
		...(identity.email === undefined ? {} : { email: identity.email }),
	};
	// The person first, unique by their ID: two first sign-ins make one, and the other carries on as an existing person.
	if (!(await store.users.insert(user))) {
		if (!again) throw new KantelError("conflict", "This person was being made by another call; try again");
		return ensurePerson(store, identity, now, false);
	}
	await provisionPersonal(store, user, account, now);
	const current = await store.users.get(user.id);
	if (current === undefined || current.retiredAt !== undefined) {
		throw new KantelError("forbidden", "This account has been deleted");
	}
	return user;
}

export interface AuthenticateOptions {
	readonly store: ComputeStore;
	readonly authenticatePerson?: AuthenticatePerson;
	readonly now: number;
}

/**
 * Whether the person a key acts for hasn't deleted their account. Deleting an account revokes the keys it finds, but a
 * key made while the deletion ran may be stored after that: from the moment the deletion is accepted (its record, kept
 * for good, `StoredDeletion`), it works nowhere.
 */
async function ownerRemains(store: ComputeStore, key: StoredApiKey): Promise<boolean> {
	return (await store.deletions.get(key.ownerUserId)) === undefined;
}

/** The API key a secret is, while it is neither revoked nor expired and its person exists. */
export async function keyForSecret(
	store: ComputeStore,
	secret: string,
	now: number,
): Promise<StoredApiKey | undefined> {
	const [key] = await store.apiKeys.list({ secretHash: await sha256Hex(secret) });
	if (key === undefined || key.revokedAt !== undefined) return undefined;
	if (key.expiresAt !== undefined && key.expiresAt <= now) return undefined;
	if (!(await ownerRemains(store, key))) return undefined;
	return key;
}

/** The principal the key with `keyId` is, while it is neither revoked nor expired. */
export async function liveKeyPrincipal(
	store: ComputeStore,
	keyId: string,
	now: number,
): Promise<KeyPrincipal | undefined> {
	const key = await store.apiKeys.get(keyId);
	if (key === undefined || key.revokedAt !== undefined) return undefined;
	if (key.expiresAt !== undefined && key.expiresAt <= now) return undefined;
	if (!(await ownerRemains(store, key))) return undefined;
	return keyPrincipal(key);
}

/**
 * A personal access token while it is neither revoked nor expired and its person is still here: not retired, and with
 * no account deletion recorded (a token made while the deletion ran works nowhere either).
 */
async function liveToken(
	store: ComputeStore,
	token: StoredPersonalToken | undefined,
	now: number,
): Promise<{ token: StoredPersonalToken; user: StoredUser } | undefined> {
	if (token === undefined || token.revokedAt !== undefined || token.expiresAt <= now) return undefined;
	const [user, deletion] = await Promise.all([store.users.get(token.userId), store.deletions.get(token.userId)]);
	if (user === undefined || user.retiredAt !== undefined || deletion !== undefined) return undefined;
	return { token, user };
}

/** The principal a personal access token signs in as. Never a super-admin: a token doesn't manage the deployment. */
export function tokenPrincipal(token: StoredPersonalToken, user: StoredUser): PersonPrincipal {
	return {
		kind: "person",
		userId: user.id,
		name: personName({ userId: user.id, name: user.name, email: user.email }),
		superAdmin: false,
		personalAccountId: user.personalAccountId,
		...(user.email === undefined ? {} : { email: user.email }),
		token: {
			id: token.id,
			name: token.name,
			...(token.scopes === undefined ? {} : { scopes: token.scopes }),
			...(token.accounts === undefined ? {} : { accounts: token.accounts }),
			expiresAt: token.expiresAt,
		},
	};
}

/** The principal the personal access token with `tokenId` is now, while it works. */
export async function liveTokenPrincipal(
	store: ComputeStore,
	tokenId: string,
	now: number,
): Promise<PersonPrincipal | undefined> {
	const live = await liveToken(store, await store.personalTokens.get(tokenId), now);
	return live === undefined ? undefined : tokenPrincipal(live.token, live.user);
}

/** Who is calling; rejects with `UnauthenticatedError` for no bearer or one that is not valid. */
export async function authenticate(request: Request, options: AuthenticateOptions): Promise<Principal> {
	const { store, now } = options;
	const token = bearerOf(request);
	if (token === undefined) throw new UnauthenticatedError("This call needs a bearer: an API key or a sign-in");
	if (token.startsWith(API_KEY_PREFIX)) {
		const key = await keyForSecret(store, token, now);
		if (key === undefined) throw new UnauthenticatedError("The API key is not valid");
		// The use is recorded at most once a minute (`API_KEY_LAST_USED_PRECISION_MS`), off the call's path: a busy key
		// costs one write a minute, and no call waits for it. It is written only while the key is still this secret and
		// unrevoked, so a revoke or a rotation that lands meanwhile is never undone, and only while the stored use is still
		// a minute old, so of many calls that saw it stale one writes; a write that fails is dropped, as the next use
		// records it.
		const stale = (lastUsedAt: number | undefined) =>
			lastUsedAt === undefined || now - lastUsedAt >= API_KEY_LAST_USED_PRECISION_MS;
		if (stale(key.lastUsedAt)) {
			void store.apiKeys
				.update(key.id, (current) =>
					current.revokedAt === undefined && current.secretHash === key.secretHash && stale(current.lastUsedAt)
						? { ...current, lastUsedAt: now }
						: undefined,
				)
				.catch(() => undefined);
		}
		return keyPrincipal(key);
	}
	if (token.startsWith(PERSONAL_TOKEN_PREFIX)) {
		const [found] = await store.personalTokens.list({ secretHash: await sha256Hex(token) });
		const live = await liveToken(store, found, now);
		if (live === undefined) throw new UnauthenticatedError("The personal access token is not valid");
		// Its use is recorded as a key's is: at most once a minute, off the call's path, never over a revoke.
		const stale = (lastUsedAt: number | undefined) =>
			lastUsedAt === undefined || now - lastUsedAt >= API_KEY_LAST_USED_PRECISION_MS;
		if (stale(live.token.lastUsedAt)) {
			void store.personalTokens
				.update(live.token.id, (current) =>
					current.revokedAt === undefined && stale(current.lastUsedAt) ? { ...current, lastUsedAt: now } : undefined,
				)
				.catch(() => undefined);
		}
		return tokenPrincipal(live.token, live.user);
	}
	const identity = await options.authenticatePerson?.(request);
	if (identity === undefined) throw new UnauthenticatedError("The credentials are not valid");
	// Someone whose account deletion is under way is never let in again, nor made afresh by `ensurePerson`.
	if ((await store.deletions.get(identity.userId)) !== undefined) {
		throw new UnauthenticatedError("This account is being deleted");
	}
	let user: StoredUser;
	try {
		user = await ensurePerson(store, identity, now);
	} catch (error) {
		// Refused by the store's fence (`fenceClosedAccounts`): their deletion was recorded as this ran.
		if ((await store.deletions.get(identity.userId)) !== undefined) {
			throw new UnauthenticatedError("This account is being deleted");
		}
		throw error;
	}
	// Checked again once made: a deletion that began as this sign-in ran leaves it nothing, not even what it just made
	// (a personal account apart from the one the deletion clears, or the user record put back).
	// Checked again once made: a deletion that began as this sign-in ran never gets a principal back. What the sign-in
	// wrote is no one's to clear here: a write after the deletion was recorded undid itself (`fenceClosedAccounts`), and
	// one before it is found by the deletion's passes (`personalAccountIdOf`).
	if ((await store.deletions.get(identity.userId)) !== undefined) {
		throw new UnauthenticatedError("This account is being deleted");
	}
	return {
		kind: "person",
		userId: user.id,
		name: personName({ userId: user.id, name: user.name, email: user.email }),
		superAdmin: user.superAdmin,
		personalAccountId: user.personalAccountId,
		...(user.email === undefined ? {} : { email: user.email }),
		...(identity.session === undefined ? {} : { session: identity.session }),
	};
}

/**
 * The caller's role in an account, or undefined when they may not act in it. A key acts only in its own account, with
 * its person's role there (`member` when they have left it).
 */
export async function roleIn(
	store: ComputeStore,
	principal: Principal,
	accountId: string,
): Promise<computeSchema.MemberRole | undefined> {
	if (principal.kind === "key" && principal.accountId !== accountId) return undefined;
	if ((await tokenRefusal(store, principal, accountId)) !== undefined) return undefined;
	const member = await store.members.get(memberId(accountId, principal.userId));
	if (member !== undefined) return member.role;
	return principal.kind === "key" ? "member" : undefined;
}

/**
 * Why a personal access token may not act in an account, or undefined when it may (or the caller isn't one): it names
 * other accounts, or the account is an organisation that blocks personal tokens.
 */
export async function tokenRefusal(
	store: ComputeStore,
	principal: Principal,
	accountId: string,
): Promise<string | undefined> {
	if (principal.kind !== "person" || principal.token === undefined) return undefined;
	const { accounts } = principal.token;
	if (accounts !== undefined && !accounts.includes(accountId)) {
		return accountId === principal.personalAccountId
			? `The personal access token ${principal.token.name} can't act in your personal account; name one of its accounts (${accounts.join(", ")})`
			: `The personal access token ${principal.token.name} can't act in that account`;
	}
	const account = await store.accounts.get(accountId);
	if (account?.kind === "organisation" && account.personalTokens === "blocked") {
		return `${account.name} doesn't allow personal access tokens: use the console, or one of its API keys`;
	}
	return undefined;
}

/** The account a call acts in when it names none: a key's own; a person's personal account, or a token's one account. */
export function defaultAccountOf(principal: Principal): string {
	if (principal.kind === "key") return principal.accountId;
	const accounts = principal.token?.accounts;
	if (accounts?.length === 1 && accounts[0] !== undefined && accounts[0] !== principal.personalAccountId) {
		return accounts[0];
	}
	return principal.personalAccountId;
}

/** An account the caller acts in, and their role there. */
export interface Acting {
	readonly account: StoredAccount;
	readonly role: computeSchema.MemberRole;
}

/**
 * The account a call acts in: a key's own (naming another is `forbidden`), or a person's personal account unless
 * `requested` names an account they belong to (`forbidden` otherwise).
 */
export async function actingAccount(
	store: ComputeStore,
	principal: Principal,
	requested: string | undefined,
): Promise<Acting> {
	if (principal.kind === "key" && requested !== undefined && requested !== principal.accountId) {
		throw new KantelError("forbidden", "An API key acts in its own account only");
	}
	const accountId = requested ?? defaultAccountOf(principal);
	const refusal = await tokenRefusal(store, principal, accountId);
	if (refusal !== undefined) throw new KantelError("forbidden", refusal);
	// Two reads that don't depend on each other: one round trip.
	const [role, account] = await Promise.all([roleIn(store, principal, accountId), store.accounts.get(accountId)]);
	if (role === undefined || account === undefined) {
		throw new KantelError("forbidden", "You are not a member of that account");
	}
	return { account, role };
}

/**
 * An account by ID, for a route that names it in its path: `not_found` when it doesn't exist or the caller may not act
 * in it, so its existence isn't given away.
 */
export async function accountById(store: ComputeStore, principal: Principal, accountId: string): Promise<Acting> {
	const [role, account] = await Promise.all([roleIn(store, principal, accountId), store.accounts.get(accountId)]);
	if (role === undefined || account === undefined) throw new KantelError("not_found", "No such account");
	return { account, role };
}

/**
 * Refuses (`forbidden`) a call the caller may not make in an account where they have `role`: a key needs the scope; a
 * person needs admin or owner for `account:admin`, and to be a super-admin for `hosts:admin`.
 */
export function requireScope(
	principal: Principal,
	scope: computeSchema.ApiKeyScope,
	role: computeSchema.MemberRole = "member",
): void {
	if (principal.kind === "key") {
		if (!principal.scopes.includes(scope)) throw new KantelError("forbidden", `This key lacks the ${scope} scope`);
		return;
	}
	const capped = principal.token?.scopes;
	if (capped !== undefined && !capped.includes(scope)) {
		throw new KantelError("forbidden", `This personal access token lacks the ${scope} scope`);
	}
	if (scope === "hosts:admin" && !principal.superAdmin) {
		throw new KantelError("forbidden", "Only a deployment super-admin manages hosts");
	}
	if (scope === "account:admin" && role === "member") {
		throw new KantelError("forbidden", "This needs an admin or owner of the account");
	}
}

/** Refuses a key: for the routes only people may call (a person's personal access token may). */
export function requirePerson(principal: Principal): PersonPrincipal {
	if (principal.kind !== "person") throw new KantelError("forbidden", "Only a person may do this, not an API key");
	return principal;
}

/**
 * Refuses a key and a personal access token: for what only a person signed in at the console does, such as approving
 * another device's sign-in or deleting their account, so a leaked token can do neither.
 */
export function requireSignIn(principal: Principal, what: string): PersonPrincipal {
	const person = requirePerson(principal);
	if (person.token !== undefined) {
		throw new KantelError("forbidden", `${what} needs you signed in at the console, not a personal access token`);
	}
	return person;
}

/**
 * Refuses a personal access token limited to some accounts, or lacking `account:admin` when it has scopes: for what
 * reaches past the accounts a token names, such as making or joining an organisation.
 */
export function requireUnlimitedToken(principal: Principal, what: string): void {
	const token = principal.kind === "person" ? principal.token : undefined;
	if (token === undefined) return;
	if (token.accounts !== undefined) {
		throw new KantelError("forbidden", `${what} needs a personal access token for all your accounts`);
	}
	if (token.scopes !== undefined && !token.scopes.includes("account:admin")) {
		throw new KantelError("forbidden", `This personal access token lacks the account:admin scope`);
	}
}

/**
 * Refuses (`forbidden`) scopes the caller may not grant a key: a key only the ones it holds, a person no `hosts:admin`
 * unless a super-admin.
 */
export function requireGrantable(principal: Principal, scopes: readonly computeSchema.ApiKeyScope[]): void {
	for (const scope of scopes) {
		if (principal.kind === "key" && !principal.scopes.includes(scope)) {
			throw new KantelError("forbidden", `A key can't grant ${scope}, which it doesn't hold`);
		}
		const capped = principal.kind === "person" ? principal.token?.scopes : undefined;
		if (capped !== undefined && !capped.includes(scope)) {
			throw new KantelError("forbidden", `A personal access token can't grant ${scope}, which it doesn't hold`);
		}
		if (scope === "hosts:admin" && !principal.superAdmin) {
			throw new KantelError("forbidden", "Only a deployment super-admin may grant hosts:admin");
		}
	}
}
