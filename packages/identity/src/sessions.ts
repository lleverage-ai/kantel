/**
 * Kantel sessions: what every sign-in (a provider's, such as GitHub's, or a one-time sign-in link) starts, and what the
 * authenticator then accepts on every call. Portable: WebCrypto and globals only. The store is an interface, so a
 * deployment keeps sessions in its database (`./sessions-sql.ts`'s `identity_sessions`) and tests keep them in memory.
 *
 * - A session is a `kts_` bearer token (`hbs_` before the rename); only its SHA-256 is stored.
 * - `kantelSessionProvider` lets `createAuthenticator` accept them. The person is resolved through `signIn` on every
 *   call with the identity the session was started for, so a removed user's session stops working.
 * - `startSession` and `endSession` audit `identity.session.started` and `identity.session.ended` in each of the
 *   person's organisations.
 */
import {
	type AuditEventInput,
	type AuditSink,
	type AuthenticatorRequest,
	authenticationError,
	type Clock,
	type ExternalIdentity,
	hasTokenPrefix,
	type IdentityDirectory,
	isKantelError,
	KantelError,
	type SignIn,
	systemClock,
	systemContext,
	type Timestamp,
	TOKEN_PREFIXES,
	type UserId,
} from "@kantel/contracts";
import { hashApiKeySecret } from "./index.ts";
import type { SignInProvider } from "./jwt.ts";

const SESSIONS_CONTEXT = systemContext("identity.sessions");

/** Every Kantel session token starts with this. */
export const SESSION_TOKEN_PREFIX = TOKEN_PREFIXES.session.current;

/** Whether a bearer is a Kantel session token: `kts_…`, or `hbs_…` as sessions started before the rename are. */
export const isSessionToken = (token: string): boolean => hasTokenPrefix(token, "session");

/** How long a session lasts unless configured otherwise: 12 hours. */
export const DEFAULT_SESSION_TTL_MILLISECONDS = 12 * 60 * 60 * 1000;

/**
 * The issuer the session provider reports when asked which issuer it vouches for. A session vouches for whatever
 * identity it was started with (GitHub's, a sign-in link's), so this names Kantel itself, not one provider.
 */
export const KANTEL_SESSION_ISSUER = "kantel:session";

const INVALID_SESSION_MESSAGE = "The credentials are not valid";

export interface SessionRecord {
	readonly id: string;
	/** `hashSessionToken(token)`. */
	readonly tokenHash: string;
	readonly userId: UserId;
	/** The identity `signIn` resolved; the authenticator resolves it again on every call. */
	readonly issuer: string;
	readonly subject: string;
	/** The email the provider verified, if any. */
	readonly email?: string;
	readonly createdAt: Timestamp;
	readonly expiresAt: Timestamp;
}

/** Where sessions live. */
export interface SessionStore {
	create(session: SessionRecord): Promise<void>;
	/** The session with `tokenHash` if it has not ended or expired at `now`. */
	find(tokenHash: string, now: Timestamp): Promise<SessionRecord | undefined>;
	/** Ends the session with `tokenHash`; resolves it if this call ended a live one. */
	end(tokenHash: string, now: Timestamp): Promise<SessionRecord | undefined>;
}

/** The stored hash of a session token: its hex SHA-256. */
export function hashSessionToken(token: string): Promise<string> {
	return hashApiKeySecret(token);
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `prefix` and 32 random bytes in unpadded base64url: a session token, or a sign-in link's. */
export function randomToken(prefix: string): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `${prefix}${base64url(bytes)}`;
}

export interface StartedSession {
	/** The bearer token, shown once. */
	readonly token: string;
	readonly expiresAt: Timestamp;
	readonly signIn: SignIn;
}

export interface SessionsOptions {
	readonly identity: Pick<IdentityDirectory, "signIn">;
	readonly sessions: SessionStore;
	readonly clock?: Clock;
	/** Where `identity.session.started` and `identity.session.ended` go. */
	readonly audit?: AuditSink;
	/** How long a session lasts. Defaults to `DEFAULT_SESSION_TTL_MILLISECONDS`. */
	readonly ttlMilliseconds?: number;
}

export interface Sessions {
	/** Starts a session for a person `signIn` resolved from `external`. */
	start(external: ExternalIdentity, signIn: SignIn): Promise<StartedSession>;
	/** Ends the session `token` names, if it is live. Resolves either way. */
	end(token: string): Promise<void>;
}

/** Starts and ends Kantel sessions over a store. */
export function createSessions(options: SessionsOptions): Sessions {
	const { identity, sessions, audit } = options;
	const clock = options.clock ?? systemClock;
	const ttl = options.ttlMilliseconds ?? DEFAULT_SESSION_TTL_MILLISECONDS;
	if (!(Number.isFinite(ttl) && ttl > 0)) {
		throw new KantelError("invalid", "a session's lifetime must be a positive number of milliseconds");
	}

	async function auditSession(
		type: "identity.session.started" | "identity.session.ended",
		session: SessionRecord,
		organisationIds: readonly string[],
	): Promise<void> {
		if (audit === undefined || organisationIds.length === 0) return;
		const events: AuditEventInput[] = organisationIds.map((organisationId) => ({
			id: `identity:${type}:${session.id}:${organisationId}`,
			at: clock.now(),
			source: "identity",
			type,
			actor: { kind: "human", userId: session.userId },
			organisationId,
			subject: { kind: "identity.session", id: session.id },
			data: { issuer: session.issuer, expiresAt: session.expiresAt },
		}));
		await audit.append(SESSIONS_CONTEXT, events);
	}

	return {
		async start(external, signedIn) {
			const now = clock.now();
			const token = randomToken(SESSION_TOKEN_PREFIX);
			const email = external.emailVerified === true ? external.email : undefined;
			const session: SessionRecord = {
				id: `ses_${crypto.randomUUID()}`,
				tokenHash: await hashSessionToken(token),
				userId: signedIn.user.id,
				issuer: external.issuer,
				subject: external.subject,
				...(email === undefined ? {} : { email }),
				createdAt: now,
				expiresAt: now + ttl,
			};
			await sessions.create(session);
			await auditSession("identity.session.started", session, signedIn.organisationIds);
			return { token, expiresAt: session.expiresAt, signIn: signedIn };
		},

		async end(token) {
			if (typeof token !== "string" || !isSessionToken(token)) return;
			const ended = await sessions.end(await hashSessionToken(token), clock.now());
			if (ended === undefined) return;
			let organisationIds: readonly string[] = [];
			try {
				organisationIds = (await identity.signIn(SESSIONS_CONTEXT, sessionIdentity(ended))).organisationIds;
			} catch (error) {
				// A user who can no longer sign in still has their session ended; there is no organisation to audit in.
				if (!isKantelError(error, "forbidden")) throw error;
			}
			await auditSession("identity.session.ended", ended, organisationIds);
		},
	};
}

/** The identity a session was started for, as the authenticator resolves it again on each call. */
export function sessionIdentity(session: SessionRecord): ExternalIdentity {
	return {
		issuer: session.issuer,
		subject: session.subject,
		...(session.email === undefined ? {} : { email: session.email, emailVerified: true }),
	};
}

/** The session token in `request`: an `Authorization: Bearer kts_…` (or `hbs_…`, before the rename) header, or undefined. */
export function sessionBearer(request: AuthenticatorRequest): string | undefined {
	const header = request.headers.get("authorization");
	if (header === null) return undefined;
	const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
	return match?.[1] !== undefined && isSessionToken(match[1]) ? match[1] : undefined;
}

export interface KantelSessionProviderOptions {
	readonly sessions: Pick<SessionStore, "find">;
	readonly clock?: Clock;
}

/**
 * The sign-in provider for Kantel sessions, for `createAuthenticator({ providers })`. A live session vouches for
 * the identity it was started with; the authenticator then resolves the user through `signIn` as for any provider.
 */
export function kantelSessionProvider(options: KantelSessionProviderOptions): SignInProvider {
	const clock = options.clock ?? systemClock;
	return {
		method: "harbour_session",
		issuer: KANTEL_SESSION_ISSUER,
		token: sessionBearer,
		async verify(token) {
			const session = await options.sessions.find(await hashSessionToken(token), clock.now());
			if (session === undefined) throw authenticationError("invalid", INVALID_SESSION_MESSAGE);
			return sessionIdentity(session);
		},
	};
}

/** An in-memory session store, for tests and single-process development. */
export function createMemorySessionStore(): SessionStore {
	const byHash = new Map<string, SessionRecord & { ended: boolean }>();
	const live = (session: (SessionRecord & { ended: boolean }) | undefined, now: Timestamp) =>
		session !== undefined && !session.ended && session.expiresAt > now;
	return {
		async create(session) {
			byHash.set(session.tokenHash, { ...session, ended: false });
		},
		async find(tokenHash, now) {
			const session = byHash.get(tokenHash);
			if (!live(session, now) || session === undefined) return undefined;
			const { ended: _ended, ...record } = session;
			return record;
		},
		async end(tokenHash, now) {
			const session = byHash.get(tokenHash);
			if (!live(session, now) || session === undefined) return undefined;
			session.ended = true;
			const { ended: _ended, ...record } = session;
			return record;
		},
	};
}
