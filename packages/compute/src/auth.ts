/**
 * Who is calling the compute plane, and what they may do. A bearer `ksk_…` is an API key, found by the SHA-256 of its
 * secret and refused once revoked or expired; it acts in its own account with its scopes. Any other bearer is handed to
 * the host's `authenticatePerson` (a sign-in the deployment checks); a person is given a personal account the first
 * time they are seen, and acts in it unless a call's `account` names an organisation they belong to. A person's rights
 * follow their role there: a `member` lacks `account:admin`, an admin or owner has it, and only a deployment
 * super-admin has `hosts:admin`.
 */
import type { computeSchema } from "@kantel/api";
import { API_KEY_LAST_USED_PRECISION_MS, KantelError } from "@kantel/contracts";
import { isPlaceholderName, personName } from "./names.ts";
import type { ComputeStore, StoredAccount, StoredApiKey, StoredUser } from "./store.ts";
import { randomId, randomSecret, sha256Hex } from "./util.ts";

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
}

export type Principal = KeyPrincipal | PersonPrincipal;

/**
 * Who was given access a relay carries on with after the call (a tunnel ticket, an exposed port's URL): a key, or a
 * person and their sign-in. The relay asks `ComputeService.stillAllowed` while the access lasts, so revoking the key,
 * signing out or leaving the account ends it.
 */
export type Grantee =
	| { readonly kind: "key"; readonly keyId: string }
	| { readonly kind: "person"; readonly userId: string; readonly session?: string };

/** The grantee a principal is, as the relay keeps it. */
export function encodeGrantee(principal: Principal): string {
	const grantee: Grantee =
		principal.kind === "key"
			? { kind: "key", keyId: principal.keyId }
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
	const record = value as { kind?: unknown; keyId?: unknown; userId?: unknown; session?: unknown };
	if (record.kind === "key" && typeof record.keyId === "string") return { kind: "key", keyId: record.keyId };
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
export async function ensurePerson(store: ComputeStore, identity: PersonIdentity, now: number): Promise<StoredUser> {
	const existing = await store.users.get(identity.userId);
	const superAdmin = identity.superAdmin === true;
	const name = nameFor(identity, existing);
	if (existing !== undefined) {
		const email = identity.email ?? existing.email;
		if (existing.name !== name || existing.email !== email || existing.superAdmin !== superAdmin) {
			const updated: StoredUser = {
				...existing,
				name,
				superAdmin,
				...(email === undefined ? {} : { email }),
			};
			await store.users.put(updated);
			if (existing.name !== name) {
				const personal = await store.accounts.get(existing.personalAccountId);
				// Unless they renamed it themselves.
				const named = personal?.name === existing.name || isPlaceholderName(personal?.name, existing.id);
				if (personal !== undefined && personal.name !== name && named) {
					await store.accounts.put({ ...personal, name });
				}
			}
			return updated;
		}
		return existing;
	}
	const account: StoredAccount = {
		id: randomId("acc"),
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
	await store.accounts.put(account);
	await store.members.put({
		id: memberId(account.id, user.id),
		accountId: account.id,
		userId: user.id,
		role: "owner",
		joinedAt: now,
	});
	await store.users.put(user);
	return user;
}

export interface AuthenticateOptions {
	readonly store: ComputeStore;
	readonly authenticatePerson?: AuthenticatePerson;
	readonly now: number;
}

/** The API key a secret is, while it is neither revoked nor expired. */
export async function keyForSecret(
	store: ComputeStore,
	secret: string,
	now: number,
): Promise<StoredApiKey | undefined> {
	const [key] = await store.apiKeys.list({ secretHash: await sha256Hex(secret) });
	if (key === undefined || key.revokedAt !== undefined) return undefined;
	if (key.expiresAt !== undefined && key.expiresAt <= now) return undefined;
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
	return keyPrincipal(key);
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
	const identity = await options.authenticatePerson?.(request);
	if (identity === undefined) throw new UnauthenticatedError("The credentials are not valid");
	const user = await ensurePerson(store, identity, now);
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
	const member = await store.members.get(memberId(accountId, principal.userId));
	if (member !== undefined) return member.role;
	return principal.kind === "key" ? "member" : undefined;
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
	const own = principal.kind === "key" ? principal.accountId : principal.personalAccountId;
	if (principal.kind === "key" && requested !== undefined && requested !== principal.accountId) {
		throw new KantelError("forbidden", "An API key acts in its own account only");
	}
	const accountId = requested ?? own;
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
	if (scope === "hosts:admin" && !principal.superAdmin) {
		throw new KantelError("forbidden", "Only a deployment super-admin manages hosts");
	}
	if (scope === "account:admin" && role === "member") {
		throw new KantelError("forbidden", "This needs an admin or owner of the account");
	}
}

/** Refuses a key: for the routes only people may call. */
export function requirePerson(principal: Principal): PersonPrincipal {
	if (principal.kind !== "person") throw new KantelError("forbidden", "Only a person may do this, not an API key");
	return principal;
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
		if (scope === "hosts:admin" && !principal.superAdmin) {
			throw new KantelError("forbidden", "Only a deployment super-admin may grant hosts:admin");
		}
	}
}
