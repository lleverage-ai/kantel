// The sign-in flow against the real thing: the identity lane's OTP handler and client over an in-memory directory,
// stores and mailer, on one clock the test moves. No server, no DOM: the screen renders what the flow says.

import { type CallContext, HarbourError } from "@harbour/contracts";
import { createIdentityClient } from "@harbour/identity/http";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createEmailOtp, createMemoryOtpStores, MemoryOtpMailer } from "@harbour/identity/otp";
import { createOtpHandler } from "@harbour/identity/otp/http";
import { describe, expect, it, vi } from "vitest";
import {
	codeDigits,
	createSignInFlow,
	plausibleEmail,
	SIGN_IN_CODE_TTL_MS,
	SIGN_IN_CODE_WINDOW_MS,
	SIGN_IN_MAX_CODES,
	type SignInApi,
	type SignInState,
	signInProblem,
} from "./sign-in-model.ts";

const bootstrap: CallContext = { actor: { kind: "system", component: "test" }, organisationId: "bootstrap" };
const ADA = "ada@harbour.test";

async function world() {
	let at = Date.UTC(2026, 9, 28, 9, 0);
	const clock = { now: () => at };
	const identity = createMemoryIdentity();
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: ADA });
	await identity.createOrganisation(bootstrap, { name: "Harbour", admin: { kind: "user", userId: ada.id } });
	const mailer = new MemoryOtpMailer();
	// The mail goes on a later task; the test waits for it after each call.
	const sending: Promise<unknown>[] = [];
	const otp = createEmailOtp({
		identity,
		...createMemoryOtpStores(),
		mailer,
		clock,
		defer: (work) => sending.push(work),
	});
	const routes = createOtpHandler({ otp });
	const client = createIdentityClient({
		baseUrl: "https://harbour.test",
		fetch: (input, init) => routes(new Request(input, init)),
	});
	const sessions: string[] = [];
	const api: SignInApi = {
		start: (email) => client.startOtp(email),
		async verify(email, code) {
			sessions.push((await client.verifyOtp(email, code)).token);
		},
	};
	const signedIn = vi.fn();
	const inner = createSignInFlow({ api, now: clock.now, onSignedIn: signedIn });
	const flow = {
		...inner,
		async requestCode() {
			await inner.requestCode();
			await Promise.all(sending.splice(0));
		},
	};
	return {
		flow,
		mailer,
		sessions,
		signedIn,
		advance: (ms: number) => {
			at += ms;
		},
		now: clock.now,
	};
}

/** Narrows to the code step, failing the test otherwise. */
function codeStep(state: SignInState): Extract<SignInState, { step: "code" }> {
	if (state.step !== "code") throw new Error(`expected the code step, got ${state.step}`);
	return state;
}

/** A six-digit code that isn't `code`. */
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

describe("sign-in flow", () => {
	it("signs in with the emailed code", async () => {
		const { flow, mailer, sessions, signedIn, now } = await world();
		flow.setEmail(` ${ADA} `);
		await flow.requestCode();
		const step = codeStep(flow.getState());
		expect(step).toMatchObject({ email: ADA, code: "", tries: 0, resent: false, busy: false });
		expect(step.expiresAt).toBe(now() + SIGN_IN_CODE_TTL_MS);
		const code = mailer.lastCodeFor(ADA);
		expect(code).toMatch(/^\d{6}$/);
		flow.setCode(`Code: ${code}`);
		await flow.verify();
		expect(flow.getState()).toEqual({ step: "signed-in", email: ADA });
		expect(signedIn).toHaveBeenCalledWith(ADA);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatch(/^hbs_/);
	});

	it("doesn't send for an email that can't be one", async () => {
		const { flow, mailer } = await world();
		flow.setEmail("ada at harbour");
		await flow.requestCode();
		expect(flow.getState()).toMatchObject({ step: "email", problem: { kind: "invalid-email" } });
		expect(mailer.sent).toHaveLength(0);
		flow.setEmail(ADA);
		expect(flow.getState()).not.toHaveProperty("problem");
	});

	it("shows the code step for an email no one was invited with, as the server can't say otherwise", async () => {
		const { flow, mailer } = await world();
		flow.setEmail("eve@harbour.test");
		await flow.requestCode();
		expect(flow.getState().step).toBe("code");
		expect(mailer.sent).toHaveLength(0);
		flow.setCode("123456");
		await flow.verify();
		expect(flow.getState()).toMatchObject({ step: "code", problem: { kind: "wrong-code", triesLeft: 4 } });
	});

	it("counts wrong codes and burns the code on the fifth", async () => {
		const { flow, mailer } = await world();
		flow.setEmail(ADA);
		await flow.requestCode();
		const wrong = wrongCode(mailer.lastCodeFor(ADA) ?? "");
		for (const triesLeft of [4, 3, 2, 1]) {
			flow.setCode(wrong);
			await flow.verify();
			expect(codeStep(flow.getState()).problem).toEqual({ kind: "wrong-code", triesLeft });
		}
		flow.setCode(wrong);
		await flow.verify();
		expect(codeStep(flow.getState()).problem).toEqual({ kind: "used-up" });
		// A burned code takes no more typing or tries; the right one would fail at the server anyway.
		flow.setCode(mailer.lastCodeFor(ADA) ?? "");
		expect(codeStep(flow.getState()).code).toBe(wrong);
		await flow.verify();
		expect(codeStep(flow.getState()).problem).toEqual({ kind: "used-up" });
		// A new code starts over.
		await flow.requestCode();
		const fresh = codeStep(flow.getState());
		expect(fresh).toMatchObject({ tries: 0, code: "", resent: true });
		expect(fresh).not.toHaveProperty("problem");
		flow.setCode(mailer.lastCodeFor(ADA) ?? "");
		await flow.verify();
		expect(flow.getState().step).toBe("signed-in");
	});

	it("doesn't send fewer than six digits, or count them as a try", async () => {
		const { flow } = await world();
		flow.setEmail(ADA);
		await flow.requestCode();
		flow.setCode("1234");
		await flow.verify();
		expect(codeStep(flow.getState())).toMatchObject({ tries: 0, problem: { kind: "short-code" } });
		flow.setCode("12345");
		expect(codeStep(flow.getState())).not.toHaveProperty("problem");
	});

	it("marks the code expired after ten minutes, by the clock and at the server", async () => {
		const { flow, mailer, advance } = await world();
		flow.setEmail(ADA);
		await flow.requestCode();
		advance(SIGN_IN_CODE_TTL_MS - 1);
		flow.tick();
		expect(codeStep(flow.getState())).not.toHaveProperty("problem");
		advance(1);
		flow.tick();
		expect(codeStep(flow.getState()).problem).toEqual({ kind: "expired" });

		// Typed in time but answered late: the server's 401 reads as expired, not wrong.
		const late = await world();
		late.flow.setEmail(ADA);
		await late.flow.requestCode();
		late.advance(SIGN_IN_CODE_TTL_MS + 1);
		late.flow.setCode(late.mailer.lastCodeFor(ADA) ?? "");
		await late.flow.verify();
		expect(codeStep(late.flow.getState()).problem).toEqual({ kind: "expired" });
		expect(mailer.sent).toHaveLength(1);
	});

	it("knows the email's hourly limit, which the server keeps without saying", async () => {
		const { flow, mailer, advance, now } = await world();
		flow.setEmail(ADA);
		const first = now();
		await flow.requestCode();
		for (let sent = 1; sent < SIGN_IN_MAX_CODES; sent++) {
			advance(60_000);
			await flow.requestCode();
		}
		expect(mailer.sent).toHaveLength(SIGN_IN_MAX_CODES);
		advance(60_000);
		await flow.requestCode();
		expect(codeStep(flow.getState()).problem).toEqual({ kind: "rate-limited", until: first + SIGN_IN_CODE_WINDOW_MS });
		expect(mailer.sent).toHaveLength(SIGN_IN_MAX_CODES);
		// The code already sent still works while the limit stands.
		flow.setCode(mailer.lastCodeFor(ADA) ?? "");
		await flow.verify();
		expect(flow.getState().step).toBe("signed-in");
	});

	it("lifts the limit once the window has passed", async () => {
		const { flow, mailer, advance } = await world();
		flow.setEmail(ADA);
		for (let sent = 0; sent < SIGN_IN_MAX_CODES; sent++) await flow.requestCode();
		flow.changeEmail();
		await flow.requestCode();
		expect(flow.getState()).toMatchObject({ step: "email", problem: { kind: "rate-limited" } });
		advance(SIGN_IN_CODE_WINDOW_MS);
		flow.tick();
		expect(flow.getState()).not.toHaveProperty("problem");
		await flow.requestCode();
		expect(flow.getState().step).toBe("code");
		expect(mailer.sent).toHaveLength(SIGN_IN_MAX_CODES + 1);
	});

	it("waits out a deployment's 429 for as long as it says", async () => {
		const at = 1_000_000;
		const api: SignInApi = {
			start: () => Promise.reject(new HarbourError("exhausted", "Slow down", { retryAfterSeconds: 90 })),
			verify: () => Promise.resolve(),
		};
		const flow = createSignInFlow({ api, now: () => at });
		flow.setEmail(ADA);
		await flow.requestCode();
		expect(flow.getState()).toMatchObject({
			step: "email",
			busy: false,
			problem: { kind: "rate-limited", until: at + 90_000 },
		});
		// Typing doesn't clear it; asking again before then doesn't call the server.
		flow.setEmail("ada@harbour.test");
		const start = vi.spyOn(api, "start");
		await flow.requestCode();
		expect(start).not.toHaveBeenCalled();
		expect(flow.getState()).toMatchObject({ problem: { kind: "rate-limited" } });
	});

	it("says so when Harbour can't sign people in, and keeps what was typed", async () => {
		const flow = createSignInFlow({
			api: {
				start: () => Promise.reject(new HarbourError("unavailable", "Can't reach Harbour")),
				verify: () => Promise.resolve(),
			},
		});
		flow.setEmail(ADA);
		await flow.requestCode();
		expect(flow.getState()).toEqual({ step: "email", email: ADA, busy: false, problem: { kind: "unavailable" } });
	});

	it("is busy while a call is in flight, and ignores another", async () => {
		let release: () => void = () => {};
		const start = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
		const flow = createSignInFlow({ api: { start, verify: () => Promise.resolve() } });
		flow.setEmail(ADA);
		const pending = flow.requestCode();
		expect(flow.getState()).toMatchObject({ step: "email", busy: true });
		await flow.requestCode();
		expect(start).toHaveBeenCalledTimes(1);
		release();
		await pending;
		expect(flow.getState().step).toBe("code");
	});

	it("goes back to the email, keeping it", async () => {
		const { flow } = await world();
		flow.setEmail(ADA);
		await flow.requestCode();
		flow.changeEmail();
		expect(flow.getState()).toEqual({ step: "email", email: ADA, busy: false });
	});

	it("tells subscribers of each change", async () => {
		const { flow } = await world();
		const seen: string[] = [];
		const stop = flow.subscribe(() => seen.push(flow.getState().step));
		flow.setEmail(ADA);
		await flow.requestCode();
		stop();
		flow.setCode("1");
		expect(seen).toEqual(["email", "email", "code"]);
	});
});

describe("sign-in helpers", () => {
	it("keeps only the code's digits", () => {
		expect(codeDigits("123 456")).toBe("123456");
		expect(codeDigits("Your code: 123-4567")).toBe("123456");
		expect(codeDigits("abc")).toBe("");
	});

	it("checks an email looks like one", () => {
		expect(plausibleEmail(" ada@harbour.test ")).toBe(true);
		expect(plausibleEmail("ada")).toBe(false);
		expect(plausibleEmail("ada @harbour.test")).toBe(false);
	});

	it("reads a failure", () => {
		expect(signInProblem(new HarbourError("exhausted", "x"), 0)).toEqual({ kind: "rate-limited", until: 60_000 });
		expect(signInProblem(new HarbourError("invalid", "Not an email"), 0)).toEqual({
			kind: "invalid-email",
			message: "Not an email",
		});
		expect(signInProblem(new Error("boom"), 0)).toEqual({ kind: "unavailable" });
	});
});
