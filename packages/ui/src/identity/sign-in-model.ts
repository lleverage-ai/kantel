// Email one-time PIN sign-in, as a screen walks through it: an email, then the 6-digit code mailed to it. Plain
// state and a small flow object with no React in it, so the steps are tested against the real OTP handler
// (`@harbour/identity/otp/http`) and the screen only renders what the flow says.
//
// The server says as little as it can on purpose: start answers 202 whoever the email names, and every bad code is
// the same 401. So the screen works out what it can from what it knows itself: a code is valid for 10 minutes from
// when it asked for it, 5 wrong tries burn it, and an email gets 5 codes an hour. A deployment's own limit per client
// address answers 429 with Retry-After.

import { authenticationFailureOf, isHarbourError, normaliseEmail } from "@harbour/contracts";

export const SIGN_IN_CODE_DIGITS = 6;
/** How long a code works, from when it was asked for (`OTP_CODE_TTL_MILLISECONDS` in @harbour/identity/otp). */
export const SIGN_IN_CODE_TTL_MS = 10 * 60_000;
/** How many tries a code allows; the last wrong one burns it (`OTP_MAX_ATTEMPTS`). */
export const SIGN_IN_MAX_TRIES = 5;
/** How many codes one email may be sent an hour (`OTP_MAX_CODES_PER_WINDOW`). */
export const SIGN_IN_MAX_CODES = 5;
export const SIGN_IN_CODE_WINDOW_MS = 60 * 60_000;
/** How long to wait after a 429 that didn't say. */
const DEFAULT_RETRY_MS = 60_000;

/**
 * What the screen calls: `POST /auth/otp/start` and `POST /auth/otp/verify`. Failures reject with the identity
 * client's `HarbourError`s: `invalid` for a malformed email, `forbidden` with an `invalid` authentication failure for
 * a bad code, `exhausted` (with `details.retryAfterSeconds`) when rate-limited, anything else when Harbour can't sign
 * people in right now. `verify` keeps the session itself; the screen only needs to know it worked.
 */
export interface SignInApi {
	start(email: string): Promise<void>;
	verify(email: string, code: string): Promise<void>;
}

export type SignInProblem =
	/** The email isn't one: the server's own words. */
	| { readonly kind: "invalid-email"; readonly message: string }
	/** Fewer than six digits; not sent, so not a try. */
	| { readonly kind: "short-code" }
	| { readonly kind: "wrong-code"; readonly triesLeft: number }
	/** The code's 10 minutes are up. */
	| { readonly kind: "expired" }
	/** Five wrong tries burned the code. */
	| { readonly kind: "used-up" }
	/** No more codes until `until`: this email's hourly limit, or the deployment's limit on this address. */
	| { readonly kind: "rate-limited"; readonly until: number }
	| { readonly kind: "unavailable" };

export type SignInState =
	| {
			readonly step: "email";
			readonly email: string;
			readonly busy: boolean;
			readonly problem?: SignInProblem;
	  }
	| {
			readonly step: "code";
			readonly email: string;
			readonly code: string;
			readonly sentAt: number;
			readonly expiresAt: number;
			/** Wrong tries on this code. */
			readonly tries: number;
			/** What is in flight: checking the code or sending a new one. */
			readonly busy: "verify" | "resend" | false;
			/** Set once a second code has been sent, so the screen can say so. */
			readonly resent: boolean;
			readonly problem?: SignInProblem;
	  }
	| { readonly step: "signed-in"; readonly email: string };

export const initialSignIn = (email = ""): SignInState => ({ step: "email", email, busy: false });

/** The code as typed, digits only and at most six of them: pasting "123 456" or "Code: 123456" works. */
export const codeDigits = (typed: string): string => typed.replace(/[^0-9]/g, "").slice(0, SIGN_IN_CODE_DIGITS);

/** Whether `email` looks enough like an address to send: the server decides for real. */
export const plausibleEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+$/.test(email.trim());

/** What a failed call means for the screen. */
export function signInProblem(error: unknown, now: number): SignInProblem {
	if (isHarbourError(error, "exhausted")) {
		const seconds = error.details?.retryAfterSeconds;
		const wait = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
		return { kind: "rate-limited", until: now + (wait || DEFAULT_RETRY_MS) };
	}
	if (isHarbourError(error, "invalid")) return { kind: "invalid-email", message: error.message };
	return { kind: "unavailable" };
}

/** Whether the code step's code can no longer be used: expired or burned. */
export const codeIsDead = (problem: SignInProblem | undefined): boolean =>
	problem?.kind === "expired" || problem?.kind === "used-up";

export interface SignInFlow {
	getState(): SignInState;
	subscribe(listener: () => void): () => void;
	setEmail(email: string): void;
	setCode(typed: string): void;
	/** Sends a code to the email, or a new one from the code step. */
	requestCode(): Promise<void>;
	/** Checks the code. */
	verify(): Promise<void>;
	/** Back to the email step, keeping what was typed. */
	changeEmail(): void;
	/** Marks the code expired once its time is up, and lifts a rate limit that has passed. The screen calls it as its clock ticks. */
	tick(): void;
}

export interface SignInFlowOptions {
	readonly api: SignInApi;
	readonly now?: () => number;
	readonly initial?: SignInState;
	/** Called once, when the code signs the person in. */
	readonly onSignedIn?: (email: string) => void;
}

export function createSignInFlow(options: SignInFlowOptions): SignInFlow {
	const { api } = options;
	const now = options.now ?? Date.now;
	let state: SignInState = options.initial ?? initialSignIn();
	const listeners = new Set<() => void>();
	/** When each code was asked for, by normalised email: the hourly limit the server keeps silently. */
	const asked = new Map<string, number[]>();

	const set = (next: SignInState) => {
		state = next;
		for (const listener of listeners) listener();
	};

	/** When this email may next be sent a code, if its hourly limit is spent. */
	const limitedUntil = (email: string, at: number): number | undefined => {
		const key = normaliseEmail(email);
		const recent = (asked.get(key) ?? []).filter((time) => time > at - SIGN_IN_CODE_WINDOW_MS);
		asked.set(key, recent);
		const oldest = recent[0];
		return recent.length >= SIGN_IN_MAX_CODES && oldest !== undefined ? oldest + SIGN_IN_CODE_WINDOW_MS : undefined;
	};

	const flow: SignInFlow = {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		setEmail(email) {
			if (state.step !== "email") return;
			const { problem, ...rest } = state;
			// A rate limit outlives typing; an email's own error doesn't.
			set(problem?.kind === "rate-limited" ? { ...rest, email, problem } : { ...rest, email });
		},

		setCode(typed) {
			if (state.step !== "code" || codeIsDead(state.problem)) return;
			const code = codeDigits(typed);
			const { problem, ...rest } = state;
			const stale = problem === undefined || problem.kind === "wrong-code" || problem.kind === "short-code";
			set(stale ? { ...rest, code } : { ...rest, code, problem });
		},

		async requestCode() {
			const from = state;
			if (from.step === "signed-in" || from.busy !== false) return;
			const email = from.email.trim();
			const at = now();
			if (from.step === "email" && !plausibleEmail(email)) {
				set({ ...from, problem: { kind: "invalid-email", message: "Enter your email address." } });
				return;
			}
			const waiting = from.problem?.kind === "rate-limited" && from.problem.until > at ? from.problem : undefined;
			const until = waiting?.until ?? limitedUntil(email, at);
			if (until !== undefined) {
				set({ ...from, problem: { kind: "rate-limited", until } });
				return;
			}
			set(from.step === "email" ? { ...from, busy: true } : { ...from, busy: "resend" });
			try {
				await api.start(email);
			} catch (error) {
				// From the code step, a new code that wasn't sent leaves the old one as it was.
				set({ ...from, busy: false, problem: signInProblem(error, now()) });
				return;
			}
			const sentAt = now();
			asked.set(normaliseEmail(email), [...(asked.get(normaliseEmail(email)) ?? []), sentAt]);
			set({
				step: "code",
				email,
				code: "",
				sentAt,
				expiresAt: sentAt + SIGN_IN_CODE_TTL_MS,
				tries: 0,
				busy: false,
				resent: from.step === "code",
			});
		},

		async verify() {
			const from = state;
			if (from.step !== "code" || from.busy !== false || codeIsDead(from.problem)) return;
			if (from.code.length !== SIGN_IN_CODE_DIGITS) {
				set({ ...from, problem: { kind: "short-code" } });
				return;
			}
			if (now() >= from.expiresAt) {
				set({ ...from, problem: { kind: "expired" } });
				return;
			}
			const { problem: _problem, ...rest } = from;
			set({ ...rest, busy: "verify" });
			try {
				await api.verify(from.email, from.code);
			} catch (error) {
				const at = now();
				if (authenticationFailureOf(error) === "invalid") {
					const tries = from.tries + 1;
					const problem: SignInProblem =
						at >= from.expiresAt
							? { kind: "expired" }
							: tries >= SIGN_IN_MAX_TRIES
								? { kind: "used-up" }
								: { kind: "wrong-code", triesLeft: SIGN_IN_MAX_TRIES - tries };
					set({ ...rest, busy: false, tries, problem });
				} else {
					set({ ...rest, busy: false, problem: signInProblem(error, at) });
				}
				return;
			}
			set({ step: "signed-in", email: from.email });
			options.onSignedIn?.(from.email);
		},

		changeEmail() {
			if (state.step !== "code" || state.busy !== false) return;
			set({ step: "email", email: state.email, busy: false });
		},

		tick() {
			const at = now();
			if (state.step === "signed-in") return;
			if (state.problem?.kind === "rate-limited" && state.problem.until <= at) {
				const { problem: _problem, ...rest } = state;
				set(rest);
				return;
			}
			if (state.step === "code" && state.busy === false && state.problem === undefined && at >= state.expiresAt) {
				set({ ...state, problem: { kind: "expired" } });
			}
		},
	};
	return flow;
}
