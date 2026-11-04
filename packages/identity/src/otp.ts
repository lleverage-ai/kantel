/**
 * Email one-time PIN sign-in (self-hosted) and the Kantel sessions it issues. Portable: WebCrypto and
 * globals only. The stores are interfaces, so a deployment keeps codes and sessions in its database
 * (`./otp-sql.ts`) and tests keep them in memory.
 *
 * - `start(email)` does the same work for every well-formed email: it asks `canSignIn`, then records a code row
 *   (a real code for an invited user, an unguessable decoy for anyone else) under the per-email rate limit. Only an
 *   invited user's code is mailed, and the mail is sent after `start` returns, so neither its outcome nor its
 *   duration reaches the caller.
 * - `verify(email, code)` claims one attempt on the email's live code atomically before comparing it, so concurrent
 *   guesses never exceed the attempt limit; a match is consumed atomically, so a code signs in once. It then calls
 *   `signIn` with `EMAIL_OTP_ISSUER` and starts a session. Every failure is the same `invalid` authentication error.
 * - Sessions are `kts_` bearer tokens; only their SHA-256 is stored. `kantelSessionProvider` lets the authenticator
 *   accept them; the person is re-resolved through `signIn` on every call, so a removed user's session stops working.
 */
import {
	type AuditEventInput,
	type AuditSink,
	type AuthenticatorRequest,
	authenticationError,
	type Clock,
	EMAIL_OTP_ISSUER,
	type ExternalIdentity,
	hasTokenPrefix,
	type IdentityDirectory,
	isKantelError,
	KantelError,
	normaliseEmail,
	type SignIn,
	systemClock,
	systemContext,
	type Timestamp,
	TOKEN_PREFIXES,
	type UserId,
} from "@kantel/contracts";
import { hashApiKeySecret } from "./index.ts";
import type { SignInProvider } from "./jwt.ts";

const OTP_CONTEXT = systemContext("identity.otp");

/** Every Kantel session token starts with this. */
export const SESSION_TOKEN_PREFIX = TOKEN_PREFIXES.session.current;

/** Whether a bearer is a Kantel session token: `kts_…`, or `hbs_…` as sessions started before the rename are. */
export const isSessionToken = (token: string): boolean => hasTokenPrefix(token, "session");

export const OTP_CODE_DIGITS = 6;
/** How long a code is valid. */
export const OTP_CODE_TTL_MILLISECONDS = 10 * 60 * 1000;
/** How many tries a code allows; the last wrong one burns it. */
export const OTP_MAX_ATTEMPTS = 5;
/** How many codes one email may be sent per `OTP_RATE_WINDOW_MILLISECONDS`. */
export const OTP_MAX_CODES_PER_WINDOW = 5;
export const OTP_RATE_WINDOW_MILLISECONDS = 60 * 60 * 1000;
/** How long a session lasts unless configured otherwise. */
export const DEFAULT_SESSION_TTL_MILLISECONDS = 12 * 60 * 60 * 1000;

const INVALID_CODE_MESSAGE = "The code is not valid";
const INVALID_SESSION_MESSAGE = "The credentials are not valid";

/** What an `OtpMailer` sends. */
export interface OtpMessage {
	/** The address the person typed, trimmed. */
	readonly to: string;
	readonly code: string;
	readonly expiresAt: Timestamp;
}

/** Delivers sign-in codes. `send` rejects when the message could not be handed to the mail system. */
export interface OtpMailer {
	send(message: OtpMessage): Promise<void>;
}

/** The subject and plain-text body of a sign-in email. */
export function otpEmail(message: OtpMessage): { readonly subject: string; readonly text: string } {
	const expires = new Date(message.expiresAt).toISOString().replace("T", " ").slice(0, 16);
	return {
		subject: "Your Kantel sign-in code",
		text: [
			`Your Kantel sign-in code is ${message.code}.`,
			"",
			`It works once and expires at ${expires} UTC.`,
			"If you didn't ask to sign in, you can ignore this email.",
			"",
		].join("\n"),
	};
}

/** An `OtpMailer` that keeps what it sends, for tests. */
export class MemoryOtpMailer implements OtpMailer {
	readonly sent: OtpMessage[] = [];
	async send(message: OtpMessage): Promise<void> {
		this.sent.push(message);
	}
	/** The last code sent to `to` (compared normalised), or undefined. */
	lastCodeFor(to: string): string | undefined {
		const wanted = normaliseEmail(to);
		return this.sent.findLast((message) => normaliseEmail(message.to) === wanted)?.code;
	}
}

/** A stored code. `codeHash` is `hashOtpCode(id, email, code)`; a decoy's matches no code. */
export interface OtpCodeRecord {
	readonly id: string;
	/** Normalised. */
	readonly email: string;
	readonly codeHash: string;
	readonly createdAt: Timestamp;
	readonly expiresAt: Timestamp;
}

/** Where codes live. Each method is atomic on its own; implementations hold no process-local state they rely on. */
export interface OtpCodeStore {
	/**
	 * Records `code` unless its email already has `limit.max` codes created after `limit.since`, and resolves whether
	 * it did. Recording it burns the email's other live codes, and may forget codes created before `limit.since`.
	 */
	issue(code: OtpCodeRecord, limit: { readonly since: Timestamp; readonly max: number }): Promise<boolean>;
	/**
	 * Claims one attempt on `email`'s live code (not consumed, not burned, not expired at `now`, fewer than
	 * `maxAttempts` attempts) and resolves it, or undefined when there is none to claim.
	 */
	claimAttempt(
		email: string,
		now: Timestamp,
		maxAttempts: number,
	): Promise<{ readonly id: string; readonly codeHash: string } | undefined>;
	/** Consumes the code if it is still live at `now`; resolves whether this call consumed it. */
	consume(id: string, now: Timestamp): Promise<boolean>;
}

export interface SessionRecord {
	readonly id: string;
	/** `hashSessionToken(token)`. */
	readonly tokenHash: string;
	readonly userId: UserId;
	/** The identity `signIn` resolved; the authenticator resolves it again on every call. */
	readonly issuer: string;
	readonly subject: string;
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

function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A uniformly random code of `OTP_CODE_DIGITS` digits, leading zeroes kept. */
export function generateOtpCode(): string {
	const limit = 10 ** OTP_CODE_DIGITS;
	// Rejection sampling keeps every code equally likely.
	const ceiling = Math.floor(0x1_0000_0000 / limit) * limit;
	const word = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(word);
		const value = word[0] ?? 0;
		if (value < ceiling) return String(value % limit).padStart(OTP_CODE_DIGITS, "0");
	}
}

/** The stored hash of a code: hex SHA-256 over the code's ID, its email and the code, so equal codes hash apart. */
export function hashOtpCode(id: string, email: string, code: string): Promise<string> {
	return hashApiKeySecret(`harbour-otp\u0000${id}\u0000${email}\u0000${code}`);
}

/** The stored hash of a session token: its hex SHA-256. */
export function hashSessionToken(token: string): Promise<string> {
	return hashApiKeySecret(token);
}

/** Compares two equal-length hex digests without stopping at the first difference. */
function digestsEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

/** Longest address SMTP carries. */
const MAX_EMAIL_LENGTH = 254;

/** `email` trimmed, or an `invalid` error when it is not plausibly one address. */
function plausibleEmail(email: unknown): string {
	if (typeof email !== "string") throw new KantelError("invalid", "email must be a string");
	const trimmed = email.trim();
	const at = trimmed.lastIndexOf("@");
	if (
		trimmed.length === 0 ||
		trimmed.length > MAX_EMAIL_LENGTH ||
		at < 1 ||
		at === trimmed.length - 1 ||
		/[\s,;<>"]/.test(trimmed) ||
		// The address goes into mail headers; no control characters.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
		/[\u0000-\u001f\u007f]/.test(trimmed)
	) {
		throw new KantelError("invalid", "email is not an email address");
	}
	return trimmed;
}

/** Resolves on a later macrotask, after everything already queued (the response included) has run. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const otpIdentity = (email: string): ExternalIdentity => ({
	issuer: EMAIL_OTP_ISSUER,
	subject: email,
	email,
	emailVerified: true,
});

export interface EmailOtpOptions {
	readonly identity: Pick<IdentityDirectory, "canSignIn" | "signIn">;
	readonly codes: OtpCodeStore;
	readonly sessions: SessionStore;
	readonly mailer: OtpMailer;
	readonly clock?: Clock;
	/** Where `identity.session.started` and `identity.session.ended` go. */
	readonly audit?: AuditSink;
	/** How long a session lasts. Defaults to `DEFAULT_SESSION_TTL_MILLISECONDS`. */
	readonly sessionTtlMilliseconds?: number;
	/**
	 * Keeps work that must not hold up the response alive: sending the mail, which begins on a later task. A Worker
	 * passes `ctx.waitUntil`; the default lets it run.
	 */
	readonly defer?: (work: Promise<unknown>) => void;
	/** Told when a mail could not be sent. Never given the code. Defaults to `console.error`. */
	readonly onMailError?: (error: unknown, to: string) => void;
}

export interface StartedSession {
	/** The bearer token, shown once. */
	readonly token: string;
	readonly expiresAt: Timestamp;
	readonly signIn: SignIn;
}

export interface EmailOtp {
	/** Sends a code if `email` is an invited user's and its rate limit allows. Resolves the same way either way. */
	start(email: string): Promise<void>;
	/** Signs the person in and starts a session, or rejects with an `invalid` authentication error. */
	verify(email: string, code: string): Promise<StartedSession>;
	/** Ends the session `token` names, if it is live. Resolves either way. */
	endSession(token: string): Promise<void>;
}

export interface SessionStarterOptions {
	readonly sessions: SessionStore;
	readonly clock?: Clock;
	/** Where `identity.session.started` and `identity.session.ended` go. */
	readonly audit?: AuditSink;
	/** How long a session lasts. Defaults to `DEFAULT_SESSION_TTL_MILLISECONDS`. */
	readonly sessionTtlMilliseconds?: number;
}

/** Starts and audits Kantel sessions: for email codes here, and for GitHub and Google (`oauth.ts`). */
export interface SessionStarter {
	/** A new session for the person `signedIn` resolved `external` to. */
	start(external: ExternalIdentity, signedIn: SignIn): Promise<StartedSession>;
	/** Audits `identity.session.ended` for `session` in each of `organisationIds`. */
	ended(session: SessionRecord, organisationIds: readonly string[]): Promise<void>;
}

export function createSessionStarter(options: SessionStarterOptions): SessionStarter {
	const { sessions, audit } = options;
	const clock = options.clock ?? systemClock;
	const sessionTtl = options.sessionTtlMilliseconds ?? DEFAULT_SESSION_TTL_MILLISECONDS;
	if (!(Number.isFinite(sessionTtl) && sessionTtl > 0)) {
		throw new KantelError("invalid", "sessionTtlMilliseconds must be a positive number");
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
		await audit.append(OTP_CONTEXT, events);
	}

	return {
		async start(external, signedIn) {
			const now = clock.now();
			const token = `${SESSION_TOKEN_PREFIX}${base64url(randomBytes(32))}`;
			const email = typeof external.email === "string" ? normaliseEmail(external.email) : undefined;
			const session: SessionRecord = {
				id: `ses_${crypto.randomUUID()}`,
				tokenHash: await hashSessionToken(token),
				userId: signedIn.user.id,
				issuer: external.issuer,
				subject: external.subject,
				...(email === undefined || external.emailVerified !== true ? {} : { email }),
				createdAt: now,
				expiresAt: now + sessionTtl,
			};
			await sessions.create(session);
			await auditSession("identity.session.started", session, signedIn.organisationIds);
			return { token, expiresAt: session.expiresAt, signIn: signedIn };
		},
		ended: (session, organisationIds) => auditSession("identity.session.ended", session, organisationIds),
	};
}

export function createEmailOtp(options: EmailOtpOptions): EmailOtp {
	const { identity, codes, sessions, mailer } = options;
	const clock = options.clock ?? systemClock;
	const starter = createSessionStarter({
		sessions,
		clock,
		...(options.audit === undefined ? {} : { audit: options.audit }),
		...(options.sessionTtlMilliseconds === undefined ? {} : { sessionTtlMilliseconds: options.sessionTtlMilliseconds }),
	});
	const onMailError =
		options.onMailError ??
		((error: unknown) => {
			console.error("kantel: a sign-in code could not be sent", error instanceof Error ? error.message : error);
		});
	const defer =
		options.defer ??
		((work: Promise<unknown>) => {
			void work;
		});

	const invalidCode = () => authenticationError("invalid", INVALID_CODE_MESSAGE);

	return {
		async start(rawEmail) {
			const to = plausibleEmail(rawEmail);
			const email = normaliseEmail(to);
			const invited = await identity.canSignIn(OTP_CONTEXT, otpIdentity(email));
			const id = `otp_${crypto.randomUUID()}`;
			const now = clock.now();
			const code = generateOtpCode();
			// A stranger's row hashes 32 random bytes, so no code ever matches it, and the work is the same.
			const codeHash = await hashOtpCode(id, email, invited ? code : hex(randomBytes(32)));
			const expiresAt = now + OTP_CODE_TTL_MILLISECONDS;
			const issued = await codes.issue(
				{ id, email, codeHash, createdAt: now, expiresAt },
				{ since: now - OTP_RATE_WINDOW_MILLISECONDS, max: OTP_MAX_CODES_PER_WINDOW },
			);
			if (!invited || !issued) return;
			// The send starts on a later task, so not even the mailer's synchronous work (building the message) runs before
			// the response.
			defer(
				nextTask()
					.then(() => mailer.send({ to, code, expiresAt }))
					.catch((error: unknown) => {
						onMailError(error, to);
					}),
			);
		},

		async verify(rawEmail, code) {
			const email = normaliseEmail(plausibleEmail(rawEmail));
			if (typeof code !== "string") throw new KantelError("invalid", "code must be a string");
			const digits = code.trim();
			if (!new RegExp(`^[0-9]{${OTP_CODE_DIGITS}}$`).test(digits)) throw invalidCode();
			const now = clock.now();
			const claimed = await codes.claimAttempt(email, now, OTP_MAX_ATTEMPTS);
			if (claimed === undefined) throw invalidCode();
			if (!digestsEqual(await hashOtpCode(claimed.id, email, digits), claimed.codeHash)) throw invalidCode();
			if (!(await codes.consume(claimed.id, now))) throw invalidCode();

			const external = otpIdentity(email);
			let signedIn: SignIn;
			try {
				signedIn = await identity.signIn(OTP_CONTEXT, external);
			} catch (error) {
				if (isKantelError(error, "forbidden")) throw invalidCode();
				throw error;
			}
			return starter.start(external, signedIn);
		},

		async endSession(token) {
			if (typeof token !== "string" || !isSessionToken(token)) return;
			const ended = await sessions.end(await hashSessionToken(token), clock.now());
			if (ended === undefined) return;
			let organisationIds: readonly string[] = [];
			try {
				organisationIds = (
					await identity.signIn(OTP_CONTEXT, {
						issuer: ended.issuer,
						subject: ended.subject,
						...(ended.email === undefined ? {} : { email: ended.email }),
					})
				).organisationIds;
			} catch (error) {
				// A user who can no longer sign in still has their session ended; there is no organisation to audit in.
				if (!isKantelError(error, "forbidden")) throw error;
			}
			await starter.ended(ended, organisationIds);
		},
	};
}

/** The session token in `request`: an `Authorization: Bearer kts_…` (or `hbs_…`, before the rename) header, or undefined. */
function sessionBearer(request: AuthenticatorRequest): string | undefined {
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
		issuer: EMAIL_OTP_ISSUER,
		token: sessionBearer,
		async verify(token) {
			const session = await options.sessions.find(await hashSessionToken(token), clock.now());
			if (session === undefined) throw authenticationError("invalid", INVALID_SESSION_MESSAGE);
			return {
				issuer: session.issuer,
				subject: session.subject,
				...(session.email === undefined ? {} : { email: session.email, emailVerified: true }),
			};
		},
	};
}

/** In-memory code and session stores, for tests and single-process development. */
export function createMemoryOtpStores(): { readonly codes: OtpCodeStore; readonly sessions: SessionStore } {
	interface StoredCode extends OtpCodeRecord {
		attempts: number;
		consumed: boolean;
		burned: boolean;
	}
	let stored: StoredCode[] = [];
	const live = (code: StoredCode, now: Timestamp) => !code.consumed && !code.burned && code.expiresAt > now;
	const sessionsByHash = new Map<string, SessionRecord & { ended: boolean }>();

	return {
		codes: {
			async issue(code, limit) {
				stored = stored.filter((candidate) => candidate.createdAt > limit.since);
				const recent = stored.filter((candidate) => candidate.email === code.email).length;
				if (recent >= limit.max) return false;
				for (const candidate of stored) if (candidate.email === code.email) candidate.burned = true;
				stored.push({ ...code, attempts: 0, consumed: false, burned: false });
				return true;
			},
			async claimAttempt(email, now, maxAttempts) {
				const code = stored.findLast((candidate) => candidate.email === email && live(candidate, now));
				if (code === undefined || code.attempts >= maxAttempts) return undefined;
				code.attempts += 1;
				return { id: code.id, codeHash: code.codeHash };
			},
			async consume(id, now) {
				const code = stored.find((candidate) => candidate.id === id);
				if (code === undefined || !live(code, now)) return false;
				code.consumed = true;
				return true;
			},
		},
		sessions: {
			async create(session) {
				sessionsByHash.set(session.tokenHash, { ...session, ended: false });
			},
			async find(tokenHash, now) {
				const session = sessionsByHash.get(tokenHash);
				if (session === undefined || session.ended || session.expiresAt <= now) return undefined;
				const { ended: _ended, ...record } = session;
				return record;
			},
			async end(tokenHash, now) {
				const session = sessionsByHash.get(tokenHash);
				if (session === undefined || session.ended || session.expiresAt <= now) return undefined;
				session.ended = true;
				const { ended: _ended, ...record } = session;
				return record;
			},
		},
	};
}
