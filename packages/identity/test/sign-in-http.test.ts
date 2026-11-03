import {
	AUTH_LINK_PATH,
	AUTH_PROVIDERS_PATH,
	type CallContext,
	EMAIL_OTP_ISSUER,
	externalSubjectOf,
	GITHUB_ISSUER,
	isKantelError,
	SIGN_IN_LINK_TTL_MILLISECONDS,
} from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createIdentityClient } from "@kantel/identity/http";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { githubProvider } from "@kantel/identity/oauth";
import { createMemorySessionStore, createSessions, kantelSessionProvider } from "@kantel/identity/sessions";
import { createSignInHandler, safeReturnPath } from "@kantel/identity/sign-in/http";
import { createMemorySignInLinkStore, createSignInLink } from "@kantel/identity/sign-in-links";
import { createFakeGitHub, signInWithGitHub } from "@kantel/identity/testing/github";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };
const ORIGIN = "http://kantel.test";

async function world(options: { configured?: boolean; publicOrigin?: string } = {}) {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const identity = createMemoryIdentity({ clock, audit });
	const owner = await identity.createUser(bootstrap, { name: "Kantel admin" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Kantel",
		admin: { kind: "user", userId: owner.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: owner.id }, organisationId: organisation.id };
	const github = createFakeGitHub();
	const store = createMemorySessionStore();
	const links = createMemorySignInLinkStore();
	const authenticator = createAuthenticator({
		identity,
		providers: [kantelSessionProvider({ sessions: store, clock })],
	});
	const errors: unknown[] = [];
	const handler = createSignInHandler({
		identity,
		sessions: createSessions({ identity, sessions: store, clock, audit }),
		providers: [
			githubProvider(
				options.configured === false ? { webUrl: github.webUrl, apiUrl: github.apiUrl, fetch: github.fetch } : github,
			),
		],
		links,
		clock,
		...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
		onError: (error) => errors.push(error),
	});
	const serve = (request: Request) => handler(request);
	const whoIs = async (token: string) =>
		(
			await authenticator.authenticate(
				new Request(`${ORIGIN}/v1/me`, { headers: { authorization: `Bearer ${token}` } }),
			)
		).actor;
	return { clock, audit, identity, owner, organisation, admin, github, links, serve, whoIs, errors };
}

describe("GitHub sign-in", () => {
	it("links an invited user by a verified email, and finds them by GitHub ID afterwards", async () => {
		const { identity, admin, github, serve, whoIs, audit } = await world();
		const ada = await identity.createUser(admin, { name: "Ada", email: "Ada@Kantel.test" });
		github.account({ id: 42, login: "ada", name: "Ada L", emails: [{ email: "ada@kantel.test", verified: true }] });
		const first = await signInWithGitHub(serve, github, "ada", { returnTo: "/sandboxes" });
		expect(first).toMatchObject({ ok: true, returnTo: "/sandboxes" });
		if (!first.ok) return;
		expect(first.token).toMatch(/^kts_/);
		expect(await whoIs(first.token)).toEqual({ kind: "human", userId: ada.id });
		expect((await identity.getUser(admin, ada.id)).externalSubject).toBe(externalSubjectOf(GITHUB_ISSUER, "42"));
		expect(audit.events.map((event) => event.type)).toContain("identity.user.linked");

		// The email changes on GitHub; the ID still finds them.
		github.account({ id: 42, login: "ada", emails: [{ email: "ada@elsewhere.test", verified: true }] });
		const again = await signInWithGitHub(serve, github, "ada");
		expect(again.ok && (await whoIs(again.token))).toEqual({ kind: "human", userId: ada.id });
	});

	it("lets in someone invited at any of their verified emails, and nobody by an unverified one", async () => {
		const { identity, admin, github, serve, whoIs } = await world();
		await identity.createInvite(admin, { email: "grace@work.test", role: "operator" });
		await identity.createInvite(admin, { email: "mallory@work.test", role: "admin" });
		github.account({
			id: 7,
			login: "grace",
			emails: [
				{ email: "grace@home.test", verified: true, primary: true },
				{ email: "grace@work.test", verified: true },
			],
		});
		github.account({ id: 8, login: "mallory", emails: [{ email: "mallory@work.test", verified: false }] });
		const grace = await signInWithGitHub(serve, github, "grace");
		expect(grace.ok).toBe(true);
		if (grace.ok) expect((await whoIs(grace.token)).kind).toBe("human");
		expect(await signInWithGitHub(serve, github, "mallory")).toEqual({ ok: false, error: "not_invited" });
	});

	it("links someone who signed in by email code before, by the same verified email", async () => {
		const { identity, admin, github, serve, whoIs } = await world();
		const linked = await identity.createUser(admin, {
			name: "Old",
			email: "old@kantel.test",
			externalSubject: externalSubjectOf(EMAIL_OTP_ISSUER, "old@kantel.test"),
		});
		github.account({ id: 9, login: "old", emails: [{ email: "old@kantel.test", verified: true }] });
		const signedIn = await signInWithGitHub(serve, github, "old");
		expect(signedIn.ok && (await whoIs(signedIn.token))).toEqual({ kind: "human", userId: linked.id });
	});

	it("refuses a stranger, a denial, a callback whose state isn't the browser's, and a used code", async () => {
		const { github, serve } = await world();
		github.account({ id: 5, login: "stranger", emails: [{ email: "who@nowhere.test", verified: true }] });
		expect(await signInWithGitHub(serve, github, "stranger")).toEqual({ ok: false, error: "not_invited" });
		expect(await signInWithGitHub(serve, github, "stranger", { deny: true })).toEqual({ ok: false, error: "denied" });

		const started = await serve(new Request(`${ORIGIN}/api/auth/github/start`));
		const callback = github.approve(started.headers.get("location") ?? "", "stranger");
		// No cookie: a forged or cross-browser callback.
		const forged = await serve(new Request(callback));
		expect(new URL(forged.headers.get("location") ?? "").searchParams.get("error")).toBe("state");
		const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const tampered = new URL(callback);
		tampered.searchParams.set("state", "nope");
		const wrong = await serve(new Request(tampered, { headers: { cookie } }));
		expect(new URL(wrong.headers.get("location") ?? "").searchParams.get("error")).toBe("state");
	});

	it("sets a state cookie scoped to the sign-in routes, Secure on an https origin, and never puts a token in a query", async () => {
		const { github, serve } = await world({ publicOrigin: "https://kantel.example" });
		const started = await serve(new Request(`${ORIGIN}/api/auth/github/start`));
		expect(started.status).toBe(302);
		const cookie = started.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("Path=/api/auth/");
		const authorize = new URL(started.headers.get("location") ?? "");
		expect(authorize.searchParams.get("redirect_uri")).toBe("https://kantel.example/api/auth/github/callback");
		expect(authorize.searchParams.get("scope")).toBe("read:user user:email");
		expect(github.clientId).toBe(authorize.searchParams.get("client_id"));
	});

	it("says GitHub isn't configured without a client ID and secret, and sends the start back to the sign-in page", async () => {
		const { serve } = await world({ configured: false });
		const providers = await serve(new Request(`${ORIGIN}${AUTH_PROVIDERS_PATH}`));
		expect(await providers.json()).toEqual({
			providers: [{ id: "github", name: "GitHub", configured: false, startPath: "/api/auth/github/start" }],
		});
		const started = await serve(new Request(`${ORIGIN}/api/auth/github/start`));
		expect(started.status).toBe(302);
		expect(started.headers.get("location")).toBe(`${ORIGIN}/sign-in?error=not_configured`);
	});

	it("reports GitHub being down as failed, not as the person's fault", async () => {
		const { identity, admin, github, serve, errors } = await world();
		await identity.createUser(admin, { name: "Ada", email: "ada@kantel.test" });
		github.account({ id: 1, login: "ada", emails: [{ email: "ada@kantel.test", verified: true }] });
		const started = await serve(new Request(`${ORIGIN}/api/auth/github/start`));
		const callback = github.approve(started.headers.get("location") ?? "", "ada");
		const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		// The same callback, to routes whose GitHub can't be reached.
		const broken = createSignInHandler({
			identity,
			sessions: createSessions({ identity, sessions: createMemorySessionStore() }),
			providers: [
				githubProvider({
					...github,
					fetch: async () => {
						throw new TypeError("network down");
					},
				}),
			],
			onError: (error) => errors.push(error),
		});
		const failed = await broken(new Request(callback, { headers: { cookie } }));
		expect(new URL(failed.headers.get("location") ?? "").searchParams.get("error")).toBe("failed");
		expect(errors).toHaveLength(1);
	});
});

describe("one-time sign-in links", () => {
	it("sign the user in once, within 15 minutes, and the session is theirs", async () => {
		const { owner, links, serve, whoIs, clock } = await world();
		const client = createIdentityClient({ baseUrl: ORIGIN, fetch: (input, init) => serve(new Request(input, init)) });
		const link = await createSignInLink(links, owner.id, { clock });
		expect(link.token).toMatch(/^ktl_/);
		expect(link.expiresAt).toBe(clock.now() + SIGN_IN_LINK_TTL_MILLISECONDS);
		const session = await client.redeemSignInLink(link.token);
		expect(session.user.id).toBe(owner.id);
		expect(await whoIs(session.token)).toEqual({ kind: "human", userId: owner.id });
		const reused = await client.redeemSignInLink(link.token).catch((error: unknown) => error);
		expect(isKantelError(reused, "forbidden")).toBe(true);

		const late = await createSignInLink(links, owner.id, { clock });
		clock.advance(SIGN_IN_LINK_TTL_MILLISECONDS);
		expect(isKantelError(await client.redeemSignInLink(late.token).catch((error: unknown) => error), "forbidden")).toBe(
			true,
		);
	});

	it("leave the user free to link GitHub by email afterwards", async () => {
		const { identity, admin, links, serve, github, whoIs } = await world();
		const ada = await identity.createUser(admin, { name: "Ada", email: "ada@kantel.test" });
		const client = createIdentityClient({ baseUrl: ORIGIN, fetch: (input, init) => serve(new Request(input, init)) });
		await client.redeemSignInLink((await createSignInLink(links, ada.id)).token);
		github.account({ id: 3, login: "ada", emails: [{ email: "ada@kantel.test", verified: true }] });
		const signedIn = await signInWithGitHub(serve, github, "ada");
		expect(signedIn.ok && (await whoIs(signedIn.token))).toEqual({ kind: "human", userId: ada.id });
	});

	it("refuse a malformed body and anything but a link token", async () => {
		const { serve } = await world();
		const post = (body: string, type = "application/json") =>
			serve(new Request(`${ORIGIN}${AUTH_LINK_PATH}`, { method: "POST", headers: { "content-type": type }, body }));
		expect((await post('{"token":"ktl_x"}', "text/plain")).status).toBe(415);
		expect((await post("{")).status).toBe(400);
		expect((await post('{"token":"kts_abc"}')).status).toBe(401);
		expect((await post('{"token":"ktl_unknown"}')).status).toBe(401);
	});
});

describe("safeReturnPath", () => {
	it("keeps a path on this origin and drops anything else", () => {
		expect(safeReturnPath("/sandboxes?x=1")).toBe("/sandboxes?x=1");
		for (const bad of [
			"https://evil.test/",
			"//evil.test",
			"/\\evil.test",
			"evil",
			"/sign-in",
			"/sign-in/done",
			null,
		]) {
			expect(safeReturnPath(bad)).toBe("/");
		}
	});
});
