// The console's sign-in against identity's real routes, in process: `/v1/me` and `/v1/projects`
// (`@kantel/identity/http`) and the email one-time PIN routes (`@kantel/identity/otp/http`) over an in-memory
// directory, stores and mailer, as a self-hosted deployment serves them.
import type { CallContext, SignInMethod } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createIdentityHandler } from "@kantel/identity/http";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createOAuthSignIn } from "@kantel/identity/oauth";
import { createEmailOtp, createMemoryOtpStores, kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { createMockOAuth, MockCookieJar, mockOAuthSignIn } from "@kantel/identity/testing/oauth";
import { createSignInFlow } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import { orderedSaves } from "../state/theme-sync.ts";
import {
	type ConsoleBoot,
	createConsoleIdentity,
	type LandingPage,
	memoryChoice,
	memoryTokens,
	storageTokens,
	takeProviderLanding,
} from "./identity.ts";

const bootstrap: CallContext = { actor: { kind: "system", component: "test" }, organisationId: "bootstrap" };
const ORIGIN = "https://kantel.test";
const ADA = "ada@kantel.test";

async function world(signIn: readonly SignInMethod[] = ["email_otp"]) {
	const identity = createMemoryIdentity();
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: ADA });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Kantel",
		admin: { kind: "user", userId: ada.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: organisation.id };
	await identity.createProject(admin, { name: "Website" });
	await identity.createProject(admin, { name: "Billing" });
	const stores = createMemoryOtpStores();
	const mailer = new MemoryOtpMailer();
	const sending: Promise<unknown>[] = [];
	const otp = createEmailOtp({ identity, ...stores, mailer, defer: (work) => sending.push(work) });
	const otpRoutes = createOtpHandler({ otp });
	const identityRoutes = createIdentityHandler({
		identity,
		authenticator: createAuthenticator({ identity, providers: [kantelSessionProvider(stores)] }),
		signIn,
	});
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		if (path.startsWith("/auth/")) return otpRoutes(request);
		if (path === "/v1/me" || path === "/v1/projects") return identityRoutes(request);
		// The session API, for the projects' recency: no sessions yet.
		return Response.json({ items: [] });
	};
	const tokens = memoryTokens();
	const consoleIdentity = createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens });
	const mailed = async () => {
		await Promise.all(sending.splice(0));
		return mailer.lastCodeFor(ADA) ?? "";
	};
	return { consoleIdentity, tokens, mailed, fetch };
}

function expectKind<K extends ConsoleBoot["kind"]>(boot: ConsoleBoot, kind: K): Extract<ConsoleBoot, { kind: K }> {
	expect(boot.kind).toBe(kind);
	return boot as Extract<ConsoleBoot, { kind: K }>;
}

describe("the console's sign-in", () => {
	it("asks for an email code after a 401 that names it, then knows who is signed in", async () => {
		const { consoleIdentity, tokens, mailed } = await world();
		const signIn = expectKind(await consoleIdentity.boot(), "sign-in");

		// The screen's flow, on the routes the console calls.
		const flow = createSignInFlow({ api: signIn.api });
		flow.setEmail(ADA);
		await flow.requestCode();
		flow.setCode(await mailed());
		await flow.verify();
		expect(flow.getState().step).toBe("signed-in");
		expect(tokens.get()).toMatch(/^kts_/);

		const booted = expectKind(await consoleIdentity.boot(), "signed-in");
		expect(booted.actor).toMatchObject({ name: "Ada Lovelace", email: ADA, stubbed: false });
		expect(booted.actor.signOut).toBeDefined();
		expect(booted.me.method).toBe("harbour_session");
		expect(booted.headers()).toEqual({ authorization: `Bearer ${tokens.get()}` });
	});

	it("signs out: the session ends at the server and the next boot asks again", async () => {
		const { consoleIdentity, tokens, mailed } = await world();
		const signIn = expectKind(await consoleIdentity.boot(), "sign-in");
		await signIn.api.start(ADA);
		await signIn.api.verify(ADA, await mailed());
		const token = tokens.get();
		const booted = expectKind(await consoleIdentity.boot(), "signed-in");
		await booted.actor.signOut?.();
		expect(tokens.get()).toBeUndefined();
		// The old token no longer works, even if something kept it.
		tokens.set(token ?? "", Date.now() + 60_000);
		expectKind(await consoleIdentity.boot(), "sign-in");
		expect(tokens.get()).toBeUndefined();
	});

	it("drops a token the server no longer takes", async () => {
		const { consoleIdentity, tokens } = await world();
		tokens.set("kts_not-a-session", Date.now() + 60_000);
		expectKind(await consoleIdentity.boot(), "sign-in");
		expect(tokens.get()).toBeUndefined();
	});

	it("doesn't offer an email code where Access signs people in", async () => {
		const { consoleIdentity } = await world(["cloudflare_access"]);
		expect(await consoleIdentity.boot()).toEqual({ kind: "signed-out", methods: ["cloudflare_access"] });
	});

	it("doesn't offer an email code where the deployment named no way in", async () => {
		const { consoleIdentity } = await world([]);
		expect(await consoleIdentity.boot()).toEqual({ kind: "signed-out", methods: [] });
	});

	it("asks someone in two organisations which to act in, sends it, and forgets it on sign-out", async () => {
		const identity = createMemoryIdentity();
		const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: ADA });
		const bob = await identity.createUser(bootstrap, { name: "Bob", email: "bob@kantel.test" });
		const personal = await identity.createOrganisation(bootstrap, {
			name: "Personal",
			admin: { kind: "user", userId: ada.id },
		});
		const team = await identity.createOrganisation(bootstrap, {
			name: "Team",
			admin: { kind: "user", userId: bob.id },
		});
		const foreign = await identity.createOrganisation(bootstrap, {
			name: "Foreign",
			admin: { kind: "user", userId: bob.id },
		});
		await identity.grantRole(
			{ actor: { kind: "human", userId: bob.id }, organisationId: team.id },
			{ principal: { kind: "user", userId: ada.id }, role: "viewer" },
		);
		const stores = createMemoryOtpStores();
		const mailer = new MemoryOtpMailer();
		const sending: Promise<unknown>[] = [];
		const otp = createEmailOtp({ identity, ...stores, mailer, defer: (work) => sending.push(work) });
		const otpRoutes = createOtpHandler({ otp });
		const identityRoutes = createIdentityHandler({
			identity,
			authenticator: createAuthenticator({ identity, providers: [kantelSessionProvider(stores)] }),
			signIn: ["email_otp"],
		});
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			return new URL(request.url).pathname.startsWith("/auth/") ? otpRoutes(request) : identityRoutes(request);
		};
		const tokens = memoryTokens();
		const choice = memoryChoice();
		const consoleIdentity = createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens, choice });
		const signIn = expectKind(await consoleIdentity.boot(), "sign-in");
		await signIn.api.start(ADA);
		await Promise.all(sending.splice(0));
		await signIn.api.verify(ADA, mailer.lastCodeFor(ADA) ?? "");

		const asked = expectKind(await consoleIdentity.boot(), "choose-organisation");
		expect(asked.organisations.map((organisation) => organisation.name)).toEqual(["Personal", "Team"]);
		asked.choose(team.id);
		const booted = expectKind(await consoleIdentity.boot(), "signed-in");
		expect(booted.me.organisationId).toBe(team.id);
		expect(booted.headers()).toEqual({ authorization: `Bearer ${tokens.get()}`, "kantel-organisation": team.id });

		// One that isn't theirs (or no longer is) is dropped, and they're asked again.
		choice.set(foreign.id);
		expectKind(await consoleIdentity.boot(), "choose-organisation");
		expect(choice.get()).toBeUndefined();
		choice.set(personal.id);
		expect(expectKind(await consoleIdentity.boot(), "signed-in").me.organisationId).toBe(personal.id);

		await consoleIdentity.signOut();
		expect(choice.get()).toBeUndefined();
	});

	it("sends a sign-in's preference writes as that sign-in only: one queued past sign-out is never sent as the next person", async () => {
		const identity = createMemoryIdentity();
		const GRACE = "grace@kantel.test";
		for (const [name, email] of [
			["Ada Lovelace", ADA],
			["Grace Hopper", GRACE],
		] as const) {
			const user = await identity.createUser(bootstrap, { name, email });
			await identity.createOrganisation(bootstrap, { name, admin: { kind: "user", userId: user.id } });
		}
		const stores = createMemoryOtpStores();
		const mailer = new MemoryOtpMailer();
		const sending: Promise<unknown>[] = [];
		const otp = createEmailOtp({ identity, ...stores, mailer, defer: (work) => sending.push(work) });
		const otpRoutes = createOtpHandler({ otp });
		const identityRoutes = createIdentityHandler({
			identity,
			authenticator: createAuthenticator({ identity, providers: [kantelSessionProvider(stores)] }),
			signIn: ["email_otp"],
		});
		// Preference writes wait until the test lets each one through, as a slow network would hold them.
		const patches: { bearer: string | null; body: string }[] = [];
		const held: (() => void)[] = [];
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (new URL(request.url).pathname.startsWith("/auth/")) return otpRoutes(request);
			if (request.method === "PATCH") {
				patches.push({ bearer: request.headers.get("authorization"), body: await request.clone().text() });
				await new Promise<void>((release) => held.push(release));
			}
			return identityRoutes(request);
		};
		const tokens = memoryTokens();
		const consoleIdentity = createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens });
		const signInAs = async (email: string) => {
			const signIn = expectKind(await consoleIdentity.boot(), "sign-in");
			await signIn.api.start(email);
			await Promise.all(sending.splice(0));
			await signIn.api.verify(email, mailer.lastCodeFor(email) ?? "");
			return { boot: expectKind(await consoleIdentity.boot(), "signed-in"), bearer: `Bearer ${tokens.get()}` };
		};
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

		const ada = await signInAs(ADA);
		const failed: unknown[] = [];
		const save = orderedSaves(
			(theme) => ada.boot.setPreferences({ theme }),
			(error) => failed.push(error),
		);
		save("light"); // in flight, held
		save("dark"); // queued behind it
		await settle();
		expect(patches).toEqual([{ bearer: ada.bearer, body: JSON.stringify({ theme: "light" }) }]);

		// Ada signs out and Grace signs in before Ada's first write answers.
		await ada.boot.actor.signOut?.();
		const grace = await signInAs(GRACE);
		held.shift()?.();
		await settle();
		await settle();
		// Ada's queued choice was dropped, not sent with Grace's session.
		expect(patches.map((patch) => patch.bearer)).toEqual([ada.bearer]);
		expect(failed).toHaveLength(2);
		expect(expectKind(await consoleIdentity.boot(), "signed-in").me.preferences).toEqual({});

		// Grace's own writes go out as her.
		const now = expectKind(await consoleIdentity.boot(), "signed-in");
		const saving = now.setPreferences({ theme: "light" });
		await settle();
		held.shift()?.();
		expect(await saving).toEqual({ theme: "light" });
		expect(patches.at(-1)?.bearer).toBe(grace.bearer);
		// And an ended boot refuses without sending.
		await expect(grace.boot.setPreferences({ theme: "dark" })).rejects.toThrow("ended");
		expect(patches).toHaveLength(2);
	});

	it("fails the boot, rather than asking to sign in, when Kantel can't be reached", async () => {
		const consoleIdentity = createConsoleIdentity({
			baseUrl: ORIGIN,
			fetch: () => Promise.reject(new TypeError("offline")),
			tokens: memoryTokens(),
		});
		await expect(consoleIdentity.boot()).rejects.toMatchObject({ code: "unavailable" });
	});
});

/** A page whose address the console reads and rewrites. */
function landingAt(search: string): LandingPage & { readonly current: () => string } {
	let now = search;
	return {
		search: () => now,
		replaceSearch: (next) => {
			now = next;
		},
		current: () => now,
	};
}

describe("the console's sign-in with GitHub and Google", () => {
	async function providerWorld(signIn: readonly SignInMethod[] = ["email_otp", "github", "google"]) {
		const identity = createMemoryIdentity();
		const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: ADA });
		await identity.createOrganisation(bootstrap, { name: "Kantel", admin: { kind: "user", userId: ada.id } });
		const stores = createMemoryOtpStores();
		const oauth = createMockOAuth();
		const providers = createOAuthSignIn({
			clients: oauth.clients,
			publicUrl: ORIGIN,
			identity,
			sessions: stores.sessions,
			fetch: oauth.fetch,
			endpoints: oauth.endpoints,
		});
		const identityRoutes = createIdentityHandler({
			identity,
			authenticator: createAuthenticator({ identity, providers: [kantelSessionProvider(stores)] }),
			signIn,
		});
		// The browser: its cookies go with each request to the origin, and what the gateway sets is kept.
		const jar = new MockCookieJar();
		const gateway = async (request: Request) => {
			const path = new URL(request.url).pathname;
			if (providers.handles(path)) return providers.fetch(request);
			if (path === "/v1/me" || path === "/v1/projects") return identityRoutes(request);
			return Response.json({ items: [] });
		};
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const cookie = jar.header();
			if (cookie !== undefined) request.headers.set("cookie", cookie);
			const response = await gateway(request);
			jar.take(response);
			return response;
		};
		return { oauth, jar, gateway, fetch };
	}

	it("offers each provider the 401 names, as a link to its start", async () => {
		const { fetch } = await providerWorld();
		const consoleIdentity = createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens: memoryTokens() });
		const signIn = expectKind(await consoleIdentity.boot(), "sign-in");
		expect(signIn.emailCode).toBe(true);
		expect(signIn.providers).toEqual([
			{ provider: "github", href: `${ORIGIN}/auth/oauth/github/start` },
			{ provider: "google", href: `${ORIGIN}/auth/oauth/google/start` },
		]);
		expect(signIn.providerProblem).toBeUndefined();
	});

	it("shows the sign-in screen with providers alone when codes are off", async () => {
		const { fetch } = await providerWorld(["github"]);
		const signIn = expectKind(
			await createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens: memoryTokens() }).boot(),
			"sign-in",
		);
		expect(signIn.emailCode).toBe(false);
		expect(signIn.providers.map((link) => link.provider)).toEqual(["github"]);
	});

	it("picks up the session the provider's sign-in left, once, and takes the parameters off the address", async () => {
		const { oauth, jar, gateway, fetch } = await providerWorld();
		const { landing } = await mockOAuthSignIn(gateway, {
			origin: ORIGIN,
			provider: "github",
			oauth,
			account: { id: 1, login: "ada", emails: [{ email: ADA, primary: true, verified: true }] },
			jar,
		});
		const page = landingAt(`${landing.search}&tab=keys`);
		const tokens = memoryTokens();
		const consoleIdentity = createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens, landing: page });
		expect(page.current()).toBe("?tab=keys");
		const booted = expectKind(await consoleIdentity.boot(), "signed-in");
		expect(booted.actor).toMatchObject({ name: "Ada Lovelace", email: ADA });
		expect(tokens.get()).toMatch(/^kts_/);
		expect(jar.header()).toBeUndefined();
		// A reload doesn't ask again.
		expect(expectKind(await consoleIdentity.boot(), "signed-in").actor.email).toBe(ADA);
	});

	it("says the sign-in lapsed when there is no session to pick up", async () => {
		const { fetch } = await providerWorld();
		const page = landingAt("?signed_in=google");
		const consoleIdentity = createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens: memoryTokens(), landing: page });
		const signIn = expectKind(await consoleIdentity.boot(), "sign-in");
		expect(signIn.providerProblem).toEqual({ error: "state_mismatch", provider: "google" });
		expect(page.current()).toBe("");
		// Said once: the next boot asks plainly.
		expect(expectKind(await consoleIdentity.boot(), "sign-in").providerProblem).toBeUndefined();
	});

	it("says why a provider's sign-in failed", async () => {
		const { fetch } = await providerWorld();
		const page = landingAt("?sign_in_error=unverified_email&provider=github");
		const signIn = expectKind(
			await createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens: memoryTokens(), landing: page }).boot(),
			"sign-in",
		);
		expect(signIn.providerProblem).toEqual({ error: "unverified_email", provider: "github" });
		expect(page.current()).toBe("");
	});

	it("leaves an address that names nothing Kantel knows as it is", () => {
		for (const search of ["", "?tab=keys", "?signed_in=gitlab", "?sign_in_error=<script>"]) {
			const page = landingAt(search);
			expect(takeProviderLanding(page), search).toBeUndefined();
			expect(page.current()).toBe(search);
		}
		expect(takeProviderLanding(landingAt("?sign_in_error=failed&provider=gitlab"))).toEqual({
			kind: "failed",
			problem: { error: "failed" },
		});
	});
});

describe("the session token store", () => {
	it("keeps the token until it expires, and drops what it can't read", () => {
		let now = 1000;
		const items = new Map<string, string>();
		const storage = {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => items.set(key, value),
			removeItem: (key: string) => items.delete(key),
		} as unknown as Storage;
		const tokens = storageTokens(storage, () => now);
		tokens.set("kts_a", 2000);
		expect(tokens.get()).toBe("kts_a");
		now = 2000;
		expect(tokens.get()).toBeUndefined();
		expect(items.size).toBe(0);
		items.set("kantel.console.session", "{not json");
		expect(tokens.get()).toBeUndefined();
		expect(items.size).toBe(0);
	});
});
