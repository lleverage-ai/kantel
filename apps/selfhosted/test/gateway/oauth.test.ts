// Sign-in with GitHub and Google on a self-hosted gateway, against the mock providers: invite-only as email codes are,
// one user for the invited admin however they sign in, the same per-address limit, and nothing at all when a provider's
// client or KANTEL_PUBLIC_URL isn't set.
import { OAUTH_SESSION_PATH } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import {
	createMockOAuth,
	type MockCookieJar,
	type MockGitHubAccount,
	type MockGoogleAccount,
	mockOAuthSignIn,
} from "@kantel/identity/testing/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { createGateway, type GatewayOptions } from "../../src/gateway/gateway.ts";
import { oauthConfig } from "../../src/gateway/main.ts";

const PUBLIC = "https://kantel.example.test";
const ADMIN_EMAIL = "admin@kantel.example.test";
const ADMIN_GITHUB: MockGitHubAccount = {
	id: 42,
	login: "admin",
	name: "The Admin",
	emails: [{ email: ADMIN_EMAIL, primary: true, verified: true }],
};
const ADMIN_GOOGLE: MockGoogleAccount = {
	sub: "g-42",
	email: ADMIN_EMAIL,
	email_verified: true,
	hd: "kantel.example.test",
	name: "Admin",
};

async function start(options: Partial<GatewayOptions> = {}) {
	const components = createGatewayComponents();
	const seeded = await bootstrap(components, { organisation: "Test", project: "test", adminEmail: ADMIN_EMAIL });
	const authenticator = createAuthenticator({
		identity: components.identity,
		providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
	});
	const oauth = createMockOAuth();
	const gateway = createGateway({
		components,
		authenticator,
		mailer: new MemoryOtpMailer(),
		publicOrigin: PUBLIC,
		oauth: oauth.clients,
		oauthProviders: { fetch: oauth.fetch, endpoints: oauth.endpoints },
		...options,
	});
	// Behind its TLS proxy the gateway sees http: on the public host.
	const fetchGateway = (request: Request) =>
		gateway.fetch(new Request(request.url.replace(/^https:/, "http:"), request), { address: "192.0.2.7" });
	const pickUp = async (jar: MockCookieJar) => {
		const cookie = jar.header();
		const response = await fetchGateway(
			new Request(`${PUBLIC}${OAUTH_SESSION_PATH}`, {
				method: "POST",
				headers: { origin: PUBLIC, "sec-fetch-site": "same-origin", ...(cookie === undefined ? {} : { cookie }) },
			}),
		);
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};
	const me = async (token: string) =>
		(
			await fetchGateway(new Request(`${PUBLIC}/v1/me`, { headers: { authorization: `Bearer ${token}` } }))
		).json() as Promise<Record<string, unknown>>;
	return {
		oauth,
		seeded,
		fetchGateway,
		pickUp,
		me,
		close: async () => {
			await gateway.close();
			await components.close();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sign-in with GitHub and Google, self-hosted", () => {
	it("lets the invited admin in with either, as one user in the deployment's organisation", async () => {
		const { oauth, seeded, fetchGateway, pickUp, me, close } = await start();
		const unauthenticated = (await (await fetchGateway(new Request(`${PUBLIC}/v1/me`))).json()) as { error: unknown };
		expect(unauthenticated.error).toMatchObject({ signIn: ["email_otp", "github", "google"] });

		const actors = [];
		for (const [provider, account] of [
			["github", ADMIN_GITHUB],
			["google", ADMIN_GOOGLE],
		] as const) {
			const { landing, jar } = await mockOAuthSignIn(fetchGateway, { origin: PUBLIC, provider, oauth, account });
			expect(landing.toString()).toBe(`${PUBLIC}/?signed_in=${provider}`);
			const picked = await pickUp(jar);
			expect(picked.status).toBe(200);
			const signedIn = await me(String(picked.body.token));
			expect(signedIn.organisationId).toBe(seeded.organisationId);
			expect(signedIn.roles).toContainEqual({ role: "admin" });
			actors.push(signedIn.actor);
		}
		expect(actors[1]).toEqual(actors[0]);
		await close();
	});

	it("ends a GitHub session on sign-out with no mailer, while email codes stay off", async () => {
		const { oauth, fetchGateway, pickUp, close } = await start({ mailer: undefined });
		const unauthenticated = (await (await fetchGateway(new Request(`${PUBLIC}/v1/me`))).json()) as { error: unknown };
		expect(unauthenticated.error).toMatchObject({ signIn: ["github", "google"] });
		const { jar } = await mockOAuthSignIn(fetchGateway, {
			origin: PUBLIC,
			provider: "github",
			oauth,
			account: ADMIN_GITHUB,
		});
		const token = String((await pickUp(jar)).body.token);
		const me = () => fetchGateway(new Request(`${PUBLIC}/v1/me`, { headers: { authorization: `Bearer ${token}` } }));
		expect((await me()).status).toBe(200);
		const end = () =>
			fetchGateway(
				new Request(`${PUBLIC}/auth/session/end`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, origin: PUBLIC, "sec-fetch-site": "same-origin" },
				}),
			);
		expect((await end()).status).toBe(204);
		expect((await me()).status).toBe(401);
		expect((await end()).status).toBe(204);
		// Email codes are still off.
		const started = await fetchGateway(
			new Request(`${PUBLIC}/auth/otp/start`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: PUBLIC, "sec-fetch-site": "same-origin" },
				body: JSON.stringify({ email: ADMIN_EMAIL }),
			}),
		);
		expect(started.status).toBe(503);
		await close();
	});

	it("is invite-only: a stranger with a verified email is turned back", async () => {
		const { oauth, fetchGateway, close } = await start();
		const { landing, jar } = await mockOAuthSignIn(fetchGateway, {
			origin: PUBLIC,
			provider: "github",
			oauth,
			account: {
				id: 7,
				login: "stranger",
				emails: [{ email: "stranger@example.test", primary: true, verified: true }],
			},
		});
		expect(Object.fromEntries(landing.searchParams)).toEqual({ sign_in_error: "not_allowed", provider: "github" });
		expect(jar.header()).toBeUndefined();
		await close();
	});

	it("shares the per-address sign-in limit with email codes", async () => {
		const { fetchGateway, close } = await start({ signInLimit: { requests: 2, windowMilliseconds: 60_000 } });
		const statuses = [];
		for (let i = 0; i < 3; i += 1) {
			statuses.push((await fetchGateway(new Request(`${PUBLIC}/auth/oauth/github/start`))).status);
		}
		expect(statuses).toEqual([303, 303, 429]);
		await close();
	});

	it("is off without a client or without KANTEL_PUBLIC_URL", async () => {
		const googleOff = await start({ oauth: { github: createMockOAuth().clients.github } });
		expect((await googleOff.fetchGateway(new Request(`${PUBLIC}/auth/oauth/google/start`))).status).toBe(404);
		const body = (await (await googleOff.fetchGateway(new Request(`${PUBLIC}/v1/me`))).json()) as { error: unknown };
		expect(body.error).toMatchObject({ signIn: ["email_otp", "github"] });
		await googleOff.close();

		const noOrigin = await start({ publicOrigin: undefined });
		expect((await noOrigin.fetchGateway(new Request(`${PUBLIC}/auth/oauth/github/start`))).status).toBe(404);
		await noOrigin.close();
	});

	it("reads the clients from the environment only in pairs, and only with KANTEL_PUBLIC_URL", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = { KANTEL_GITHUB_CLIENT_ID: "Ov23li0123456789abcd", KANTEL_GITHUB_CLIENT_SECRET: "github-secret" };
		expect(oauthConfig(env, true)).toEqual({
			github: { clientId: "Ov23li0123456789abcd", clientSecret: "github-secret" },
		});
		expect(oauthConfig(env, false)).toBeUndefined();
		expect(oauthConfig({ KANTEL_GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com" }, true)).toBeUndefined();
		expect(oauthConfig({}, true)).toBeUndefined();
		expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
			"[gateway] sign-in with GitHub and Google needs KANTEL_PUBLIC_URL, their callbacks' origin; it is off",
			"[gateway] KANTEL_GOOGLE_CLIENT_SECRET is not set, so sign-in with google is off",
		]);
	});
});
