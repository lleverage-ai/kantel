// The console's sign-in against identity's real routes, in process: `/v1/me` and `/v1/projects`
// (`@kantel/identity/http`) and the email one-time PIN routes (`@kantel/identity/otp/http`) over an in-memory
// directory, stores and mailer, as a self-hosted deployment serves them.
import type { CallContext, SignInMethod } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createIdentityHandler } from "@kantel/identity/http";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createEmailOtp, createMemoryOtpStores, kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { createSignInFlow } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import { type ConsoleBoot, createConsoleIdentity, memoryChoice, memoryTokens, storageTokens } from "./identity.ts";

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

	it("fails the boot, rather than asking to sign in, when Kantel can't be reached", async () => {
		const consoleIdentity = createConsoleIdentity({
			baseUrl: ORIGIN,
			fetch: () => Promise.reject(new TypeError("offline")),
			tokens: memoryTokens(),
		});
		await expect(consoleIdentity.boot()).rejects.toMatchObject({ code: "unavailable" });
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
