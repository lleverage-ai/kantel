// Who is signed in, for the console on the API: `GET /v1/me` before anything else, and Kantel's own email-code
// sign-in when the deployment signs people in that way.
//
// Two ways in, and the 401 says which (`signIn` in its body):
// - `cloudflare_access`: Access signs the browser in at the edge with its cookie, so the console sends no credential.
//   A 401 means that cookie has lapsed; reloading the page goes back through Access.
// - `email_otp` (self-hosted): the console signs in with `POST /auth/otp/start` and `/auth/otp/verify` and sends the
//   session it gets back as a bearer token. The token is kept in localStorage, so a reload or another tab stays signed
//   in, until it expires (12 hours) or the person signs out.
//
// Someone in more than one organisation (on the public origin, someone with a personal space who was invited to
// another) must name one: `/v1/me` answers 403 `organisation` until they do. The console then lists theirs
// (`GET /v1/organisations`), keeps the one they choose in localStorage beside the session, and sends it as
// `Kantel-Organisation` on every call. Signing out forgets it.

import type { MeResponse, SignInMethod } from "@kantel/contracts";
import { authenticationFailureOf, ORGANISATION_HEADER } from "@kantel/contracts";
import {
	createIdentityClient,
	type IdentityClient,
	type OrganisationSummary,
	signInMethodsOf,
} from "@kantel/identity/http";
import type { SignInApi } from "@kantel/ui";

/** Who is signed in to the console. */
export type ConsoleActor = {
	readonly id: string;
	readonly name: string;
	readonly email?: string;
	/** True while sign-in is a stand-in, so the shell can say so. */
	readonly stubbed: boolean;
	/** Ends the session, when the console signed in itself (an email code). Access ends its own at the edge. */
	readonly signOut?: () => Promise<void>;
};

const SESSION_KEY = "kantel.console.session";
const ORGANISATION_KEY = "kantel.console.organisation";

/** Where the organisation a person chose to act in is kept between page loads. */
export interface ChoiceStore {
	get(): string | undefined;
	set(organisationId: string): void;
	clear(): void;
}

/** The chosen organisation in `storage` (the page's localStorage). */
export function storageChoice(storage: Storage): ChoiceStore {
	return {
		get: () => storage.getItem(ORGANISATION_KEY) ?? undefined,
		set: (organisationId) => storage.setItem(ORGANISATION_KEY, organisationId),
		clear: () => storage.removeItem(ORGANISATION_KEY),
	};
}

/** An in-memory choice, for tests and a page without storage. */
export function memoryChoice(): ChoiceStore {
	let chosen: string | undefined;
	return {
		get: () => chosen,
		set: (organisationId) => {
			chosen = organisationId;
		},
		clear: () => {
			chosen = undefined;
		},
	};
}

/** Where a Kantel session token is kept between page loads. */
export interface TokenStore {
	get(): string | undefined;
	set(token: string, expiresAt: number): void;
	clear(): void;
}

type Stored = { readonly token: string; readonly expiresAt: number };

/** The session token in `storage` (the page's localStorage), dropped once it has expired. */
export function storageTokens(storage: Storage, now: () => number = Date.now): TokenStore {
	return {
		get() {
			const raw = storage.getItem(SESSION_KEY);
			if (raw === null) return undefined;
			try {
				const stored = JSON.parse(raw) as Partial<Stored>;
				if (typeof stored.token === "string" && typeof stored.expiresAt === "number" && stored.expiresAt > now()) {
					return stored.token;
				}
			} catch {
				// Not ours, or from an older console: start again.
			}
			storage.removeItem(SESSION_KEY);
			return undefined;
		},
		set(token, expiresAt) {
			storage.setItem(SESSION_KEY, JSON.stringify({ token, expiresAt } satisfies Stored));
		},
		clear() {
			storage.removeItem(SESSION_KEY);
		},
	};
}

/** An in-memory store, for tests and a page without storage. */
export function memoryTokens(): TokenStore {
	let stored: string | undefined;
	return {
		get: () => stored,
		set: (token) => {
			stored = token;
		},
		clear: () => {
			stored = undefined;
		},
	};
}

export type ConsoleIdentityOptions = {
	/** Kantel's origin. Default `""`, the console's own. */
	readonly baseUrl?: string;
	readonly fetch?: typeof fetch;
	readonly tokens: TokenStore;
	/** The organisation chosen, for someone in several. Default in memory. */
	readonly choice?: ChoiceStore;
};

/** What the console should show first. */
export type ConsoleBoot =
	| {
			readonly kind: "signed-in";
			readonly me: MeResponse;
			readonly actor: ConsoleActor;
			/** Headers every API call sends: the session's bearer when signed in with a code, else none. */
			readonly headers: () => Record<string, string>;
	  }
	/** Signed in to several organisations and none chosen: ask which, then boot again. */
	| {
			readonly kind: "choose-organisation";
			readonly organisations: readonly OrganisationSummary[];
			readonly choose: (organisationId: string) => void;
	  }
	/** Signed out, and the deployment signs people in with an email code: show the sign-in screen. */
	| { readonly kind: "sign-in"; readonly api: SignInApi }
	/** Signed out somewhere the console can't sign in itself (Access, or not said): reloading signs in. */
	| { readonly kind: "signed-out"; readonly methods: readonly SignInMethod[] };

export interface ConsoleIdentity {
	readonly client: IdentityClient;
	/** Asks `/v1/me`, and what to show for the answer. Rejects only when Kantel can't be reached or fails. */
	boot(signal?: AbortSignal): Promise<ConsoleBoot>;
	/** Ends this tab's Kantel session (an email code's), and forgets it. */
	signOut(): Promise<void>;
	/** Forgets the session after a 401 elsewhere, so the next boot asks to sign in. */
	forget(): void;
}

export function createConsoleIdentity(options: ConsoleIdentityOptions): ConsoleIdentity {
	const { tokens } = options;
	const choice = options.choice ?? memoryChoice();
	const headers = (): Record<string, string> => {
		const token = tokens.get();
		const chosen = choice.get();
		return {
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
			...(chosen === undefined ? {} : { [ORGANISATION_HEADER]: chosen }),
		};
	};
	const client = createIdentityClient({
		baseUrl: options.baseUrl ?? "",
		headers,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});

	const signInApi: SignInApi = {
		start: (email) => client.startOtp(email),
		async verify(email, code) {
			const session = await client.verifyOtp(email, code);
			tokens.set(session.token, session.expiresAt);
		},
	};

	const identity: ConsoleIdentity = {
		client,
		async boot(signal) {
			let me: MeResponse;
			try {
				me = await client.me(signal);
			} catch (error) {
				const failure = authenticationFailureOf(error);
				if (failure === "organisation") {
					// In several organisations and none chosen, or the one chosen is no longer theirs: ask which.
					choice.clear();
					const { items } = await client.organisations(signal);
					if (items.length === 0) throw error;
					return { kind: "choose-organisation", organisations: items, choose: (id) => choice.set(id) };
				}
				if (failure !== "invalid") throw error;
				// The session we had (if any) is over.
				tokens.clear();
				choice.clear();
				const methods = signInMethodsOf(error) ?? [];
				return methods.includes("email_otp") ? { kind: "sign-in", api: signInApi } : { kind: "signed-out", methods };
			}
			const ownSession = me.method === "harbour_session" && tokens.get() !== undefined;
			const actor: ConsoleActor = {
				id: me.actor.kind === "human" ? me.actor.userId : me.name,
				name: me.name,
				...(me.email === undefined ? {} : { email: me.email }),
				stubbed: false,
				...(ownSession ? { signOut: () => identity.signOut() } : {}),
			};
			return { kind: "signed-in", me, actor, headers };
		},
		async signOut() {
			const token = tokens.get();
			tokens.clear();
			choice.clear();
			if (token !== undefined) await client.endSession(token).catch(() => {});
		},
		forget: () => {
			tokens.clear();
			choice.clear();
		},
	};
	return identity;
}
