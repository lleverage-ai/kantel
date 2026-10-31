// Who is signed in, for the console on the API: `GET /v1/me` before anything else, and Kantel's own email-code
// sign-in when the deployment signs people in that way.
//
// Two ways in, and the 401 says which (`signIn` in its body):
// - `cloudflare_access`: Access signs the browser in at the edge with its cookie, so the console sends no credential.
//   A 401 means that cookie has lapsed; reloading the page goes back through Access.
// - `email_otp` (self-hosted): the console signs in with `POST /auth/otp/start` and `/auth/otp/verify` and sends the
//   session it gets back as a bearer token. The token is kept in localStorage, so a reload or another tab stays signed
//   in, until it expires (12 hours) or the person signs out.

import type { MeResponse, SignInMethod } from "@kantel/contracts";
import { authenticationFailureOf } from "@kantel/contracts";
import { createIdentityClient, type IdentityClient, signInMethodsOf } from "@kantel/identity/http";
import type { SignInApi } from "@kantel/ui";
import type { ConsoleActor } from "./client.ts";

const SESSION_KEY = "harbour.console.session";

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
	const headers = (): Record<string, string> => {
		const token = tokens.get();
		return token === undefined ? {} : { authorization: `Bearer ${token}` };
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
				if (authenticationFailureOf(error) !== "invalid") throw error;
				// The session we had (if any) is over.
				tokens.clear();
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
			if (token !== undefined) await client.endSession(token).catch(() => {});
		},
		forget: () => tokens.clear(),
	};
	return identity;
}
