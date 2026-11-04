// Sign-in with GitHub and Google (`@kantel/identity/oauth`) against the mock providers: the code flow with PKCE and the
// state cookie, each way it is turned back, the session it hands the console, and linking by verified email.
import {
	type CallContext,
	EMAIL_OTP_ISSUER,
	externalSubjectOf,
	GITHUB_ISSUER,
	GOOGLE_ISSUER,
	OAUTH_SESSION_PATH,
	type OtpVerifyResponse,
	systemContext,
} from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createOAuthSignIn, OAUTH_SCOPES, oauthClientsFromEnv, pkceChallenge } from "@kantel/identity/oauth";
import { createMemoryOtpStores, kantelSessionProvider } from "@kantel/identity/otp";
import {
	createMockOAuth,
	type MockCookieJar,
	type MockGitHubAccount,
	type MockGoogleAccount,
	mockOAuthSignIn,
} from "@kantel/identity/testing/oauth";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://kantel.test";
const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };

const ADA_GITHUB: MockGitHubAccount = {
	id: 583231,
	login: "ada",
	name: "Ada Lovelace",
	emails: [
		{ email: "ada@old.test", primary: false, verified: true },
		{ email: "Ada@Kantel.test", primary: true, verified: true },
	],
};
const ADA_GOOGLE: MockGoogleAccount = {
	sub: "10769150350006150715113082367",
	email: "ada@kantel.test",
	email_verified: true,
	// A Google Workspace account: Google is authoritative for its address.
	hd: "kantel.test",
	name: "Ada L.",
};

async function setUp(options: { clients?: "both" | "github" | "none" } = {}) {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const identity = createMemoryIdentity({ clock, audit });
	const stores = createMemoryOtpStores();
	const oauth = createMockOAuth();
	const which = options.clients ?? "both";
	const signIn = createOAuthSignIn({
		clients: which === "none" ? {} : which === "github" ? { github: oauth.clients.github } : oauth.clients,
		publicUrl: ORIGIN,
		identity,
		sessions: stores.sessions,
		audit,
		clock,
		fetch: oauth.fetch,
		endpoints: oauth.endpoints,
		onFailure: () => {},
	});
	const authenticator = createAuthenticator({
		identity,
		providers: [kantelSessionProvider({ sessions: stores.sessions, clock })],
	});
	// Ada signs in with an email code already; she has an organisation.
	const ada = await identity.createUser(bootstrap, {
		name: "Ada",
		email: "ada@kantel.test",
		externalSubject: externalSubjectOf(EMAIL_OTP_ISSUER, "ada@kantel.test"),
	});
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Analytical Engines",
		admin: { kind: "user", userId: ada.id },
	});
	const pickUp = async (jar: MockCookieJar) => {
		const cookie = jar.header();
		const response = await signIn.fetch(
			new Request(`${ORIGIN}${OAUTH_SESSION_PATH}`, {
				method: "POST",
				headers: cookie === undefined ? {} : { cookie },
			}),
		);
		jar.take(response);
		return { status: response.status, body: (await response.json()) as OtpVerifyResponse };
	};
	return { clock, audit, identity, stores, oauth, signIn, authenticator, ada, organisation, pickUp };
}

describe("sign-in with GitHub and Google", () => {
	it("starts with a state cookie and a PKCE S256 challenge, asking only for who the person is", async () => {
		const { signIn } = await setUp();
		for (const provider of ["github", "google"] as const) {
			const response = await signIn.fetch(new Request(`${ORIGIN}/auth/oauth/${provider}/start`));
			expect(response.status).toBe(303);
			const location = new URL(response.headers.get("location") ?? "");
			expect(location.searchParams.get("scope")).toBe(OAUTH_SCOPES[provider]);
			expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/oauth/${provider}/callback`);
			expect(location.searchParams.get("code_challenge_method")).toBe("S256");
			const [cookie] = response.headers.getSetCookie();
			expect(cookie).toMatch(/^__Host-kantel_oauth=/);
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("Secure");
			expect(cookie).toContain("SameSite=Lax");
			expect(cookie).toContain("Max-Age=600");
			// The cookie holds the state the provider is sent and the verifier the challenge is of.
			const [, state, verifier] = (cookie ?? "").split(";")[0]?.split("=")[1]?.split(".") ?? [];
			expect(location.searchParams.get("state")).toBe(state);
			expect(location.searchParams.get("code_challenge")).toBe(await pkceChallenge(verifier ?? ""));
		}
		expect(OAUTH_SCOPES.github).toBe("read:user user:email");
	});

	it("links GitHub to the person who signs in with an email code, by the primary verified email", async () => {
		const { signIn, oauth, ada, organisation, pickUp, authenticator, audit } = await setUp();
		const { landing, jar } = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "github",
			oauth,
			account: ADA_GITHUB,
		});
		expect(landing.toString()).toBe(`${ORIGIN}/?signed_in=github`);
		expect(jar.get("__Host-kantel_oauth")).toBeUndefined();
		expect(jar.get("__Host-kantel_oauth_session")).toMatch(/^kts_/);

		const { status, body } = await pickUp(jar);
		expect(status).toBe(200);
		expect(body.user.id).toBe(ada.id);
		expect(body.organisationIds).toEqual([organisation.id]);
		expect(jar.get("__Host-kantel_oauth_session")).toBeUndefined();
		// Picked up once.
		expect((await pickUp(jar)).status).toBe(401);

		// The session is a bearer like an email code's.
		const signedIn = await authenticator.authenticate({
			headers: new Headers({ authorization: `Bearer ${body.token}` }),
		});
		expect(signedIn.actor).toEqual({ kind: "human", userId: ada.id });
		expect(audit.ofType("identity.user.linked").at(-1)?.data).toEqual({ issuer: GITHUB_ISSUER });
		expect(audit.ofType("identity.session.started").at(-1)?.data).toMatchObject({ issuer: GITHUB_ISSUER });
	});

	it("links Google the same way, and both stay one user", async () => {
		const { signIn, oauth, ada, pickUp, identity } = await setUp();
		for (const [provider, account] of [
			["google", ADA_GOOGLE],
			["github", ADA_GITHUB],
			["google", ADA_GOOGLE],
		] as const) {
			const { landing, jar } = await mockOAuthSignIn(signIn.fetch, { origin: ORIGIN, provider, oauth, account });
			expect(landing.searchParams.get("signed_in")).toBe(provider);
			expect((await pickUp(jar)).body.user.id).toBe(ada.id);
		}
		const bySubject = await identity.signIn(systemContext("test"), { issuer: GOOGLE_ISSUER, subject: ADA_GOOGLE.sub });
		expect(bySubject.user.id).toBe(ada.id);
	});

	it("turns back an account with no verified email", async () => {
		const { signIn, oauth } = await setUp();
		const unverifiedPrimary: MockGitHubAccount = {
			...ADA_GITHUB,
			emails: [
				{ email: "ada@kantel.test", primary: true, verified: false },
				{ email: "other@kantel.test", primary: false, verified: true },
			],
		};
		const github = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "github",
			oauth,
			account: unverifiedPrimary,
		});
		expect(Object.fromEntries(github.landing.searchParams)).toEqual({
			sign_in_error: "unverified_email",
			provider: "github",
		});
		expect(github.jar.header()).toBeUndefined();

		const google = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "google",
			oauth,
			account: { ...ADA_GOOGLE, email_verified: false },
		});
		expect(google.landing.searchParams.get("sign_in_error")).toBe("unverified_email");
	});

	it("trusts a Google email only where Google is authoritative for it: Gmail or Workspace", async () => {
		const { signIn, oauth, ada, organisation, identity, pickUp } = await setUp();
		// A consumer Google account on an address elsewhere: verified once, but it may have changed hands since.
		const consumer: MockGoogleAccount = { sub: "g-consumer", email: "ada@kantel.test", email_verified: true };
		const refused = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "google",
			oauth,
			account: consumer,
		});
		expect(Object.fromEntries(refused.landing.searchParams)).toEqual({
			sign_in_error: "unverified_email",
			provider: "google",
		});
		// It took nothing: the subject isn't linked, and Ada is as she was.
		await expect(
			identity.signIn(systemContext("test"), { issuer: GOOGLE_ISSUER, subject: "g-consumer" }),
		).rejects.toMatchObject({ code: "forbidden" });

		// Nor does it accept an invite to that address.
		await identity.createInvite(
			{ actor: { kind: "human", userId: ada.id }, organisationId: organisation.id },
			{ email: "newcomer@elsewhere.test", role: "viewer" },
		);
		const invitee = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "google",
			oauth,
			account: { sub: "g-newcomer", email: "newcomer@elsewhere.test", email_verified: true },
		});
		expect(invitee.landing.searchParams.get("sign_in_error")).toBe("unverified_email");

		// Gmail is Google's own.
		await identity.createUser(bootstrap, {
			name: "Grace",
			email: "grace.hopper@gmail.com",
			externalSubject: externalSubjectOf(EMAIL_OTP_ISSUER, "grace.hopper@gmail.com"),
		});
		const gmail = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "google",
			oauth,
			account: { sub: "g-grace", email: "Grace.Hopper@gmail.com", email_verified: true },
		});
		expect(gmail.landing.searchParams.get("signed_in")).toBe("google");
		expect((await pickUp(gmail.jar)).body.user.name).toBe("Grace");

		// Once linked through Workspace, the subject signs in by itself, even if the account later loses `hd`.
		const linked = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "google",
			oauth,
			account: ADA_GOOGLE,
		});
		expect((await pickUp(linked.jar)).body.user.id).toBe(ada.id);
		const { hd: _hd, ...noLongerWorkspace } = ADA_GOOGLE;
		const later = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "google",
			oauth,
			account: noLongerWorkspace,
		});
		expect(later.landing.searchParams.get("signed_in")).toBe("google");
		expect((await pickUp(later.jar)).body.user.id).toBe(ada.id);
	});

	it("lands on the error page, with the state cleared, when the directory or the session store fails", async () => {
		const oauth = createMockOAuth();
		const identity = createMemoryIdentity();
		await identity.createUser(bootstrap, {
			name: "Ada",
			email: "ada@kantel.test",
			externalSubject: externalSubjectOf(EMAIL_OTP_ISSUER, "ada@kantel.test"),
		});
		const stores = createMemoryOtpStores();
		const failures: string[] = [];
		for (const broken of [
			{
				identity: { ...identity, signIn: async () => Promise.reject(new Error("database is down")) },
				sessions: stores.sessions,
			},
			{
				identity,
				sessions: { ...stores.sessions, create: async () => Promise.reject(new Error("session store is down")) },
			},
		]) {
			const signIn = createOAuthSignIn({
				clients: oauth.clients,
				publicUrl: ORIGIN,
				identity: broken.identity,
				sessions: broken.sessions,
				fetch: oauth.fetch,
				endpoints: oauth.endpoints,
				onFailure: (_provider, reason) => failures.push(reason),
			});
			const { landing, jar } = await mockOAuthSignIn(signIn.fetch, {
				origin: ORIGIN,
				provider: "github",
				oauth,
				account: ADA_GITHUB,
			});
			expect(Object.fromEntries(landing.searchParams)).toEqual({ sign_in_error: "failed", provider: "github" });
			expect(jar.header()).toBeUndefined();
		}
		expect(failures).toEqual(["signing in failed: database is down", "signing in failed: session store is down"]);
	});

	it("says a declined consent was cancelled", async () => {
		const { signIn, oauth } = await setUp();
		const { landing } = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "google",
			oauth,
			account: "decline",
		});
		expect(Object.fromEntries(landing.searchParams)).toEqual({ sign_in_error: "cancelled", provider: "google" });
		expect(oauth.exchanges).toEqual([]);
	});

	it("refuses a callback whose state doesn't match this browser's, before exchanging anything", async () => {
		const { signIn, oauth, clock } = await setUp();
		const cases: [string, (callback: URL, jar: MockCookieJar) => URL | undefined][] = [
			[
				"a forged state",
				(callback) => {
					callback.searchParams.set("state", "forged");
					return callback;
				},
			],
			["no cookie", (_callback, jar) => void jar.delete("__Host-kantel_oauth")],
			[
				"a bare cookie a sibling could set",
				(_callback, jar) => {
					jar.set("kantel_oauth", jar.get("__Host-kantel_oauth") ?? "");
					jar.delete("__Host-kantel_oauth");
					return undefined;
				},
			],
			[
				"another provider's cookie",
				(callback, jar) => {
					jar.set("__Host-kantel_oauth", (jar.get("__Host-kantel_oauth") ?? "").replace(/^github\./, "google."));
					return callback;
				},
			],
			["a lapsed one", () => void clock.advance(10 * 60 * 1000)],
		];
		for (const [name, tamper] of cases) {
			const { landing } = await mockOAuthSignIn(signIn.fetch, {
				origin: ORIGIN,
				provider: "github",
				oauth,
				account: ADA_GITHUB,
				tamper,
			});
			expect(landing.searchParams.get("sign_in_error"), name).toBe("state_mismatch");
		}
		expect(oauth.exchanges, "no code was exchanged").toEqual([]);
	});

	it("fails when the PKCE verifier isn't the one the challenge was made from", async () => {
		const { signIn, oauth } = await setUp();
		const { landing } = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "github",
			oauth,
			account: ADA_GITHUB,
			tamper: (_callback, jar) => {
				// Same state, another verifier: the provider refuses the exchange.
				const [provider, state, , expires] = (jar.get("__Host-kantel_oauth") ?? "").split(".");
				jar.set("__Host-kantel_oauth", `${provider}.${state}.${"x".repeat(64)}.${expires}`);
				return undefined;
			},
		});
		expect(landing.searchParams.get("sign_in_error")).toBe("failed");
		expect(oauth.exchanges).toEqual([{ provider: "github", ok: false }]);
	});

	it("doesn't let in someone the directory doesn't (no open sign-up here)", async () => {
		const { signIn, oauth } = await setUp();
		const { landing } = await mockOAuthSignIn(signIn.fetch, {
			origin: ORIGIN,
			provider: "github",
			oauth,
			account: { id: 9, login: "stranger", emails: [{ email: "stranger@kantel.test", primary: true, verified: true }] },
		});
		expect(landing.searchParams.get("sign_in_error")).toBe("not_allowed");
	});

	it("is off for a provider without its client: no routes, and not named", async () => {
		const { signIn } = await setUp({ clients: "github" });
		expect(signIn.providers).toEqual(["github"]);
		expect(signIn.handles("/auth/oauth/github/start")).toBe(true);
		expect(signIn.handles("/auth/oauth/google/start")).toBe(false);
		expect(signIn.handles("/auth/oauth/google/callback")).toBe(false);
		expect((await signIn.fetch(new Request(`${ORIGIN}/auth/oauth/google/start`))).status).toBe(404);
		expect((await signIn.fetch(new Request(`${ORIGIN}/auth/oauth/github/elsewhere`))).status).toBe(404);

		const none = (await setUp({ clients: "none" })).signIn;
		expect(none.providers).toEqual([]);
		expect(none.handles(OAUTH_SESSION_PATH)).toBe(false);
		expect((await none.fetch(new Request(`${ORIGIN}/auth/oauth/github/start`))).status).toBe(404);
	});

	it("over plain http, keeps its cookies without the __Host- prefix or Secure", async () => {
		const oauth = createMockOAuth();
		const signIn = createOAuthSignIn({
			clients: oauth.clients,
			publicUrl: "http://127.0.0.1:58090",
			identity: createMemoryIdentity(),
			...createMemoryOtpStores(),
			fetch: oauth.fetch,
			endpoints: oauth.endpoints,
		});
		const [cookie] = (
			await signIn.fetch(new Request("http://127.0.0.1:58090/auth/oauth/github/start"))
		).headers.getSetCookie();
		expect(cookie).toMatch(/^kantel_oauth=/);
		expect(cookie).not.toContain("Secure");
	});

	it("reads a provider's client only when both its ID and secret are set", () => {
		const warnings: string[] = [];
		const clients = oauthClientsFromEnv(
			{
				KANTEL_GITHUB_CLIENT_ID: " Ov23li0123456789abcd ",
				KANTEL_GITHUB_CLIENT_SECRET: "s3cret-github",
				KANTEL_GOOGLE_CLIENT_ID: "only-the-id.apps.googleusercontent.com",
			},
			(message) => warnings.push(message),
		);
		expect(clients).toEqual({ github: { clientId: "Ov23li0123456789abcd", clientSecret: "s3cret-github" } });
		expect(warnings).toEqual(["kantel: KANTEL_GOOGLE_CLIENT_SECRET is not set, so sign-in with google is off"]);
		expect(oauthClientsFromEnv({}, () => {})).toEqual({});
	});
});
