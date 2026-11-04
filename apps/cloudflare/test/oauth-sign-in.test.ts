// Sign-in with GitHub and Google on the public origin (KANTEL_PUBLIC_URL), in Node over node:sqlite, against the mock
// providers: open sign-up into a personal space as with an email code, one user however someone signs in, the Access
// hostname untouched, and nothing at all when a provider's client isn't set.
import { DatabaseSync } from "node:sqlite";
import { OAUTH_SESSION_PATH } from "@kantel/contracts";
import { createMockAccess } from "@kantel/identity/testing";
import {
	createMockOAuth,
	type MockCookieJar,
	type MockGitHubAccount,
	type MockGoogleAccount,
	mockOAuthSignIn,
} from "@kantel/identity/testing/oauth";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { describe, expect, it } from "vitest";
import { vaultSecrets } from "../scripts/vault-secrets.ts";
import { type GatewayVars, gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { memoryMailCounts, type SendEmailBinding } from "../src/mail.ts";
import { createStack } from "../src/stack.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
const ACCESS_HOST = "https://harbour.kantel.test";
const PUBLIC = "https://app.kantel.test";
const FROM = "sign-in@kantel.test";

const ADA_GITHUB: MockGitHubAccount = {
	id: 1,
	login: "ada",
	name: "Ada Lovelace",
	emails: [{ email: "ada@example.test", primary: true, verified: true }],
};
const ADA_GOOGLE: MockGoogleAccount = { sub: "g-1", email: "ada@example.test", email_verified: true, name: "Ada" };

async function start(vars: GatewayVars = {}) {
	const oauth = createMockOAuth();
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const sent: Parameters<SendEmailBinding["send"]>[0][] = [];
	const pending: Promise<unknown>[] = [];
	const stack = await createStack({
		config: gatewayConfig({
			KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
			KANTEL_ACCESS_AUD: AUD,
			KANTEL_ADMIN_EMAIL: ADMIN,
			KANTEL_PUBLIC_URL: PUBLIC,
			KANTEL_SIGN_IN_FROM: FROM,
			KANTEL_GITHUB_CLIENT_ID: oauth.clients.github.clientId,
			KANTEL_GITHUB_CLIENT_SECRET: oauth.clients.github.clientSecret,
			KANTEL_GOOGLE_CLIENT_ID: oauth.clients.google.clientId,
			KANTEL_GOOGLE_CLIENT_SECRET: oauth.clients.google.clientSecret,
			...vars,
		}),
		accessFetch: mock.fetch,
		oauthProviders: { fetch: oauth.fetch, endpoints: oauth.endpoints },
		storage: { sql: syncSqliteDriver(new DatabaseSync(":memory:")) },
		mail: {
			binding: {
				send: async (message) => {
					sent.push(message);
					return { messageId: `m${sent.length}` };
				},
			},
			counts: memoryMailCounts(),
			defer: (work) => {
				pending.push(work);
			},
		},
	});
	const gateway = createGateway(stack);
	const fetchGateway = (request: Request) => gateway.fetch(request);

	const call = async (
		origin: string,
		method: string,
		path: string,
		options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
	) => {
		const headers: Record<string, string> = { ...options.headers };
		if (options.body !== undefined) headers["content-type"] = "application/json";
		if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
		const response = await gateway.fetch(
			new Request(`${origin}${path}`, {
				method,
				headers,
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
	};

	/** The console's `POST /auth/oauth/session`, from its own page unless `from` says otherwise. */
	const pickUp = async (jar: MockCookieJar, from = PUBLIC) => {
		const cookie = jar.header();
		return call(PUBLIC, "POST", OAUTH_SESSION_PATH, {
			headers: {
				origin: from,
				"sec-fetch-site": from === PUBLIC ? "same-origin" : "cross-site",
				...(cookie === undefined ? {} : { cookie }),
			},
		});
	};

	/** Signs in with `provider` as `account` on the public origin; the session token. */
	const signIn = async (provider: "github" | "google", account: MockGitHubAccount | MockGoogleAccount) => {
		const { landing, jar } = await mockOAuthSignIn(fetchGateway, { origin: PUBLIC, provider, oauth, account });
		expect(landing.toString()).toBe(`${PUBLIC}/?signed_in=${provider}`);
		const picked = await pickUp(jar);
		expect(picked.status).toBe(200);
		return String(picked.body.token);
	};

	const signInWithCode = async (email: string) => {
		await call(PUBLIC, "POST", "/auth/otp/start", { body: { email } });
		await Promise.all(pending.splice(0));
		const code = /code is (\d{6})/.exec(sent.findLast((message) => message.to === email)?.text ?? "")?.[1];
		const verified = await call(PUBLIC, "POST", "/auth/otp/verify", { body: { email, code } });
		expect(verified.status).toBe(200);
		return String(verified.body.token);
	};

	return { stack, oauth, call, fetchGateway, pickUp, signIn, signInWithCode, close: () => stack.compute.close() };
}

describe("sign-in with GitHub and Google on the public origin", () => {
	it("names the providers in a 401 there, and only Access on the Access hostname", async () => {
		const { call, close } = await start();
		expect((await call(PUBLIC, "GET", "/v1/me")).body.error).toMatchObject({
			signIn: ["email_otp", "github", "google"],
		});
		expect((await call(ACCESS_HOST, "GET", "/v1/me")).body.error).toMatchObject({ signIn: ["cloudflare_access"] });
		for (const path of ["/auth/oauth/github/start", "/auth/oauth/google/callback?code=x&state=y"]) {
			expect((await call(ACCESS_HOST, "GET", path)).status, path).toBe(404);
		}
		expect((await call(ACCESS_HOST, "POST", OAUTH_SESSION_PATH)).status).toBe(404);
		await close();
	});

	it("signs someone new up into a personal space, as an email code does", async () => {
		const { call, signIn, close } = await start();
		const token = await signIn("github", ADA_GITHUB);
		const me = await call(PUBLIC, "GET", "/v1/me", { token });
		expect(me.status).toBe(200);
		expect(me.body).toMatchObject({ method: "harbour_session", name: "Ada Lovelace", email: "ada@example.test" });
		expect(me.body.roles).toContainEqual({ role: "admin" });
		const organisations = await call(PUBLIC, "GET", "/v1/organisations", { token });
		expect((organisations.body.items as { name: string }[]).map((organisation) => organisation.name)).toEqual([
			"Personal",
		]);
		const projects = await call(PUBLIC, "GET", "/v1/projects", { token });
		expect((projects.body.items as { name: string }[]).map((project) => project.name)).toEqual(["Default"]);
		await close();
	});

	it("keeps one user and one space whichever way the same verified email signs in", async () => {
		const { call, signIn, signInWithCode, close } = await start();
		const byCode = await signInWithCode("ada@example.test");
		const first = (await call(PUBLIC, "GET", "/v1/me", { token: byCode })).body;
		for (const token of [await signIn("github", ADA_GITHUB), await signIn("google", ADA_GOOGLE)]) {
			const me = (await call(PUBLIC, "GET", "/v1/me", { token })).body;
			expect(first.actor).toMatchObject({ kind: "human" });
			expect(me.actor).toEqual(first.actor);
			expect(me.organisationId).toBe(first.organisationId);
			const organisations = await call(PUBLIC, "GET", "/v1/organisations", { token });
			expect((organisations.body.items as unknown[]).length).toBe(1);
		}
		await close();
	});

	it("lets an invited person join the organisation that invited them, by GitHub", async () => {
		const { stack, call, signIn, close } = await start();
		await stack.identity.createInvite(stack.admin, { email: "carol@example.test", role: "viewer" });
		const token = await signIn("github", {
			id: 3,
			login: "carol",
			emails: [{ email: "carol@example.test", primary: true, verified: true }],
		});
		const me = await call(PUBLIC, "GET", "/v1/me", { token });
		expect(me.body.organisationId).toBe(stack.organisation.id);
		expect(me.body.roles).toContainEqual({ role: "viewer" });
		await close();
	});

	it("hands the session only to the console's own page", async () => {
		const { fetchGateway, oauth, pickUp, close } = await start();
		const { jar } = await mockOAuthSignIn(fetchGateway, {
			origin: PUBLIC,
			provider: "github",
			oauth,
			account: ADA_GITHUB,
		});
		expect((await pickUp(jar, "https://evil.test")).status).toBe(403);
		// Still there for the console, once.
		expect((await pickUp(jar)).status).toBe(200);
		await close();
	});

	it("turns back an unverified Google email with no account made", async () => {
		const { fetchGateway, oauth, close } = await start();
		const { landing, jar } = await mockOAuthSignIn(fetchGateway, {
			origin: PUBLIC,
			provider: "google",
			oauth,
			account: { ...ADA_GOOGLE, email: "eve@example.test", email_verified: false },
		});
		expect(landing.searchParams.get("sign_in_error")).toBe("unverified_email");
		expect(jar.header()).toBeUndefined();
		await close();
	});

	it("is off without a provider's client: no routes, and not named", async () => {
		const { call, close } = await start({ KANTEL_GOOGLE_CLIENT_ID: "", KANTEL_GOOGLE_CLIENT_SECRET: "" });
		expect((await call(PUBLIC, "GET", "/v1/me")).body.error).toMatchObject({ signIn: ["email_otp", "github"] });
		expect((await call(PUBLIC, "GET", "/auth/oauth/google/start")).status).toBe(404);
		expect((await call(PUBLIC, "GET", "/auth/oauth/github/start")).status).toBe(303);
		await close();

		const none = await start({
			KANTEL_GITHUB_CLIENT_ID: "",
			KANTEL_GITHUB_CLIENT_SECRET: "",
			KANTEL_GOOGLE_CLIENT_ID: "",
			KANTEL_GOOGLE_CLIENT_SECRET: "",
		});
		expect((await none.call(PUBLIC, "GET", "/v1/me")).body.error).toMatchObject({ signIn: ["email_otp"] });
		expect((await none.call(PUBLIC, "GET", "/auth/oauth/github/start")).status).toBe(404);
		expect((await none.call(PUBLIC, "POST", OAUTH_SESSION_PATH)).status).toBe(404);
		await none.close();
	});

	it("leaves a half-set client off on the Worker, and the deploy refuses one", () => {
		const halfSet = gatewayConfig({
			KANTEL_PUBLIC_URL: PUBLIC,
			KANTEL_SIGN_IN_FROM: FROM,
			KANTEL_GITHUB_CLIENT_ID: "Ov23li0123456789abcd",
		});
		expect(halfSet.emailSignIn?.oauth).toBeUndefined();
		expect(() => vaultSecrets({ KANTEL_GITHUB_CLIENT_ID: "Ov23li0123456789abcd" })).toThrow(
			"KANTEL_GITHUB_CLIENT_SECRET must be set with KANTEL_GITHUB_CLIENT_ID",
		);
		expect(() => vaultSecrets({ KANTEL_GOOGLE_CLIENT_SECRET: "GOCSPX-0123456789abcdef" })).toThrow(
			"KANTEL_GOOGLE_CLIENT_ID must be set with KANTEL_GOOGLE_CLIENT_SECRET",
		);
		expect(
			vaultSecrets({
				KANTEL_GITHUB_CLIENT_ID: "Ov23li0123456789abcd",
				KANTEL_GITHUB_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567",
			}),
		).toEqual({
			KANTEL_GITHUB_CLIENT_ID: "Ov23li0123456789abcd",
			KANTEL_GITHUB_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567",
		});
	});

	it("stays off on the Access hostname alone, with the secrets set", async () => {
		const config = gatewayConfig({
			KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
			KANTEL_ACCESS_AUD: AUD,
			KANTEL_GITHUB_CLIENT_ID: "Ov23li0123456789abcd",
			KANTEL_GITHUB_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567",
		});
		expect(config.emailSignIn).toBeUndefined();
	});
});
