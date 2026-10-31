import { type CatalogueEntry, systemContext } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryConnections, memoryCredentials } from "../src/memory.ts";
import type { PlatformOAuthClient } from "../src/ports.ts";
import { fakeAccess, human, ORG } from "../src/testing.ts";

const alice = human("alice");
const bob = human("bob");
const admin = human("admin");
const ORIGIN = "https://harbour.test";
const REDIRECT = `${ORIGIN}/v1/connections/callback`;
const DEVICE_CODE = "device-code-secret-0001";

/** GitHub as far as these flows reach it: the device flow, the token endpoint, `/user` and manifest conversions. */
function fakeGitHub() {
	const requests: { url: string; init?: RequestInit; body: URLSearchParams }[] = [];
	const tokenAnswers: { body: unknown; status?: number }[] = [];
	const state = {
		device: {
			device_code: DEVICE_CODE,
			user_code: "WDJB-MJHT",
			verification_uri: "https://github.com/login/device",
			expires_in: 900,
			interval: 5,
		} as Record<string, unknown>,
		conversion: {
			status: 201,
			body: {
				id: 42,
				slug: "harbour-3f9a1c",
				client_id: "Iv23-app-client",
				client_secret: "app-client-secret-value",
				html_url: "https://github.com/apps/harbour-3f9a1c",
				owner: { login: "alice" },
				pem: "-----BEGIN RSA PRIVATE KEY-----pem-secret-value",
				webhook_secret: "webhook-secret-value",
			} as unknown,
		},
	};
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input);
		requests.push({
			url: url.href,
			...(init === undefined ? {} : { init }),
			body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
		});
		if (url.href === "https://github.com/login/device/code") return json(state.device);
		if (url.href === "https://github.com/login/oauth/access_token") {
			const next = tokenAnswers.shift() ?? { body: { error: "authorization_pending" } };
			return json(next.body, next.status ?? 200);
		}
		if (url.href === "https://api.github.com/user") return json({ id: 7, login: "alice", email: "alice@example.com" });
		if (url.hostname === "api.github.com" && url.pathname.startsWith("/app-manifests/")) {
			return json(state.conversion.body, state.conversion.status);
		}
		return new Response("not found", { status: 404 });
	};
	return { fetch, requests, tokenAnswers, state };
}

function setup(options: { platformClients?: readonly PlatformOAuthClient[]; clientMetadataPublic?: boolean } = {}) {
	const github = fakeGitHub();
	const credentials = memoryCredentials();
	let now = 1_000_000;
	const connections = createMemoryConnections({
		credentials,
		fetch: github.fetch,
		access: fakeAccess(["admin"]),
		deployment: {
			origin: ORIGIN,
			clientMetadataPublic: options.clientMetadataPublic ?? false,
			clientName: "Lleverage",
			...(options.platformClients === undefined ? {} : { platformClients: options.platformClients }),
		},
		clock: { now: () => now },
	});
	return { github, credentials, connections, advance: (ms: number) => (now += ms), now: () => now };
}

async function entry(env: ReturnType<typeof setup>, id: string): Promise<CatalogueEntry> {
	const found = (await env.connections.listCatalogue(alice, {}, { limit: 500 })).items.find((item) => item.id === id);
	if (found === undefined) throw new Error(`No catalogue entry ${id}`);
	return found;
}

const tokenCalls = (env: ReturnType<typeof setup>) =>
	env.github.requests.filter((request) => request.url === "https://github.com/login/oauth/access_token").length;

describe("catalogue setup tiers", () => {
	it("needs an app for GitHub and Gmail with nothing set up, with their guides", async () => {
		const env = setup();
		const github = await entry(env, "github");
		expect(github).toMatchObject({ setup: "needs_client", tier: "own_app" });
		expect(github.client).toBeUndefined();
		expect(github.clientGuidance).toContain("GitHub App");
		expect(github.guide).toMatchObject({ kind: "github_app_manifest", provider: "GitHub", redirectUri: REDIRECT });
		expect(JSON.stringify(github.guide)).toContain(REDIRECT);

		const gmail = await entry(env, "gmail");
		expect(gmail).toMatchObject({ setup: "needs_client", tier: "own_app" });
		const guide = gmail.guide!;
		expect(guide).toMatchObject({ kind: "steps", provider: "Google Cloud", redirectUri: REDIRECT });
		const values = guide.steps.flatMap((step) => step.values ?? []);
		expect(values).toContainEqual({ label: "Authorised redirect URI", value: REDIRECT });
		const scopes = values.filter((value) => value.label === "Scope").map((value) => value.value);
		expect(scopes).toEqual([
			"openid",
			"email",
			"profile",
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/gmail.compose",
		]);
		expect(guide.steps.some((step) => step.link?.url.endsWith("/apis/library/gmail.googleapis.com"))).toBe(true);
		expect(guide.notes?.some((note) => note.level === "warning" && note.text.includes("seven days"))).toBe(true);
		expect(guide.notes?.some((note) => note.text.includes("restricted"))).toBe(true);
		expect(gmail.scopeSets.map((set) => set.id)).toEqual(["identity", "mail-read", "mail-compose"]);

		// Drive's API library entry is its own name, not the host it is served from.
		const drive = await entry(env, "google-drive");
		expect(drive.guide?.steps.some((step) => step.link?.url.endsWith("/apis/library/drive.googleapis.com"))).toBe(true);
	});

	it("says none for a server Harbour registers with, and key for a key-only service", async () => {
		const env = setup();
		expect(await entry(env, "linear")).toMatchObject({ setup: "ready", tier: "none" });
		expect(await entry(env, "openai")).toMatchObject({ setup: "ready", tier: "key" });
		expect((await entry(env, "openai")).guide).toBeUndefined();
	});

	it("names the deployment's public client, signing in with the device flow where the provider has one", async () => {
		const env = setup({
			platformClients: [
				{ templateId: "github", clientId: "Iv23-public", label: "Harbour for GitHub" },
				{ templateId: "gmail", clientId: "gmail-client", clientSecret: "gmail-secret-value" },
			],
		});
		const github = await entry(env, "github");
		expect(github).toMatchObject({
			setup: "ready",
			tier: "public_client",
			signIn: "device",
			client: { tier: "platform", ownerLabel: "Lleverage", label: "Harbour for GitHub", public: true },
		});
		const gmail = await entry(env, "gmail");
		expect(gmail).toMatchObject({
			setup: "ready",
			tier: "host_client",
			signIn: "browser",
			client: { tier: "platform", ownerLabel: "Lleverage", public: false },
		});
		expect(JSON.stringify(gmail)).not.toContain("gmail-secret-value");
	});

	it("prefers the person's or organisation's own client to the deployment's", async () => {
		const env = setup({ platformClients: [{ templateId: "github", clientId: "Iv23-public" }] });
		await env.connections.createClient(admin, {
			owner: { kind: "organisation", organisationId: ORG },
			templateId: "github",
			label: "Acme GitHub app",
			clientId: "org-client",
			clientSecret: "org-secret-value",
		});
		expect(await entry(env, "github")).toMatchObject({
			tier: "host_client",
			signIn: "browser",
			client: { tier: "organisation", ownerLabel: "your organisation", label: "Acme GitHub app", public: false },
		});
		await env.connections.createClient(alice, {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			templateId: "github",
			label: "My GitHub app",
			clientId: "alice-client",
			clientSecret: "alice-secret-value",
		});
		expect(await entry(env, "github")).toMatchObject({
			tier: "own_app",
			client: { tier: "user", ownerLabel: "you", label: "My GitHub app", public: false },
		});
	});
});

describe("the device flow", () => {
	const github = (env: ReturnType<typeof setup>) =>
		env.connections.startConnect(alice, {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			templateId: "github",
		});
	const publicGitHub = () => setup({ platformClients: [{ templateId: "github", clientId: "Iv23-public" }] });

	it("signs in with a code, polls once per interval, slows down when told and makes the connection", async () => {
		const env = publicGitHub();
		const attempt = await github(env);
		expect(attempt).toMatchObject({
			status: "pending",
			connectUrl: "https://github.com/login/device",
			device: { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", interval: 5 },
		});
		const asked = env.github.requests.find((request) => request.url === "https://github.com/login/device/code")!;
		expect(asked.body.get("client_id")).toBe("Iv23-public");
		expect(asked.body.get("scope")).toBe("read:user user:email");
		expect(asked.body.has("client_secret")).toBe(false);
		expect(asked.init?.redirect).toBe("manual");

		// Not yet: the interval hasn't passed.
		expect((await env.connections.getAttempt(alice, attempt.id)).status).toBe("pending");
		expect(tokenCalls(env)).toBe(0);

		env.advance(5_000);
		expect((await env.connections.getAttempt(alice, attempt.id)).status).toBe("pending");
		expect(tokenCalls(env)).toBe(1);
		// Asked again at once: no second poll.
		await env.connections.getAttempt(alice, attempt.id);
		expect(tokenCalls(env)).toBe(1);

		env.advance(5_000);
		env.github.tokenAnswers.push({ body: { error: "slow_down", interval: 10 } });
		expect((await env.connections.getAttempt(alice, attempt.id)).device?.interval).toBe(10);
		expect(tokenCalls(env)).toBe(2);
		env.advance(5_000);
		await env.connections.getAttempt(alice, attempt.id);
		expect(tokenCalls(env)).toBe(2);

		env.advance(5_000);
		env.github.tokenAnswers.push({
			body: {
				access_token: "gho_access-token-secret",
				refresh_token: "ghr_refresh-token-secret",
				expires_in: 28_800,
				token_type: "bearer",
				scope: "read:user,user:email",
			},
		});
		const done = await env.connections.getAttempt(alice, attempt.id);
		expect(done.status).toBe("completed");
		expect(done.device).toBeUndefined();
		expect(done.connectUrl).toBeUndefined();
		const connection = await env.connections.get(alice, done.connectionId!);
		expect(connection).toMatchObject({
			templateId: "github",
			auth: "oauth2",
			account: { name: "alice", email: "alice@example.com" },
			client: { via: "client", clientId: "Iv23-public", tier: "platform" },
			credential: { set: true, refreshable: true },
			createdBy: { kind: "human", userId: "alice" },
		});
		// The device code and the tokens are in no answer; no request carried a client secret.
		const exposed = JSON.stringify([attempt, done, connection, await env.connections.getAttempt(alice, attempt.id)]);
		for (const secret of [DEVICE_CODE, "gho_access-token-secret", "ghr_refresh-token-secret"]) {
			expect(exposed).not.toContain(secret);
		}
		for (const request of env.github.requests) expect(request.body.has("client_secret")).toBe(false);
		const polls = env.github.requests.filter(
			(request) => request.url === "https://github.com/login/oauth/access_token",
		);
		expect(polls.every((request) => request.body.get("device_code") === DEVICE_CODE)).toBe(true);
		expect(polls[0]?.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		const vault = [...env.credentials.inspect().values()].map((item) => item.value);
		expect(vault).toContain("gho_access-token-secret");
	});

	it("fails as denied when the person declines, and expires when GitHub says so", async () => {
		const env = publicGitHub();
		const declined = await github(env);
		const lapsed = await github(env);
		env.advance(5_000);
		env.github.tokenAnswers.push({ body: { error: "access_denied" } });
		expect(await env.connections.getAttempt(alice, declined.id)).toMatchObject({
			status: "failed",
			failure: { code: "denied" },
		});
		env.github.tokenAnswers.push({ body: { error: "expired_token" } });
		const expired = await env.connections.getAttempt(alice, lapsed.id);
		expect(expired.status).toBe("expired");
		expect(expired.device).toBeUndefined();
	});

	it("says plainly when the app has the device flow turned off", async () => {
		const env = publicGitHub();
		const attempt = await github(env);
		env.advance(5_000);
		env.github.tokenAnswers.push({ body: { error: "device_flow_disabled" } });
		expect((await env.connections.getAttempt(alice, attempt.id)).failure).toEqual({
			code: "exchange_failed",
			message: "Device flow is turned off for this GitHub app: enable it in the app's settings",
		});
	});

	it("expires with the provider's codes when they last less than the connect", async () => {
		const env = publicGitHub();
		env.github.state.device = { ...env.github.state.device, expires_in: 60 };
		const attempt = await github(env);
		expect(attempt.expiresAt).toBe(env.now() + 60_000);
		env.advance(61_000);
		expect((await env.connections.getAttempt(alice, attempt.id)).status).toBe("expired");
		expect(tokenCalls(env)).toBe(0);
	});

	it("has no connect link to open", async () => {
		const env = publicGitHub();
		const attempt = await github(env);
		await expect(env.connections.authorize(alice, attempt.id)).rejects.toMatchObject({ code: "conflict" });
	});

	it("keeps the browser sign-in for a confidential client", async () => {
		const env = setup({
			platformClients: [{ templateId: "github", clientId: "Iv23-secret", clientSecret: "platform-secret-value" }],
		});
		const attempt = await github(env);
		expect(attempt.device).toBeUndefined();
		expect(attempt.connectUrl).toBe(`${ORIGIN}/v1/connections/authorize/${attempt.id}`);
		expect(env.github.requests.some((request) => request.url.includes("/login/device/code"))).toBe(false);
	});
});

describe("the GitHub App manifest flow", () => {
	const decodeHtml = (text: string) =>
		text
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");
	const manifestOf = (html: string) =>
		JSON.parse(decodeHtml(/name="manifest" value="([^"]*)"/.exec(html)![1]!)) as Record<string, unknown>;
	const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

	it("posts a manifest to GitHub, converts the code and stores the client with its secret write-only", async () => {
		const env = setup();
		const started = await env.connections.startGitHubApp(alice, { owner: "user", returnTo: "/connections/github" });
		expect(started).toMatchObject({ status: "pending", expiresAt: env.now() + 60 * 60 * 1000 });
		const url = new URL(started.url!);
		expect(url.origin + url.pathname).toBe(`${ORIGIN}/v1/connections/github-app/${started.id}/start`);
		const state = stateOf(started.url!);
		// The state is handed out once: reading the flow again never shows it.
		expect(JSON.stringify(await env.connections.getGitHubApp(alice, started.id))).not.toContain(state);

		const html = await env.connections.gitHubAppManifestPage(started.id, state);
		expect(html).toContain(`action="https://github.com/settings/apps/new?state=${state}"`);
		const manifest = manifestOf(html);
		expect(manifest).toMatchObject({
			url: ORIGIN,
			redirect_url: `${ORIGIN}/v1/connections/github-app/callback`,
			callback_urls: [REDIRECT],
			public: false,
			hook_attributes: { active: false },
			default_permissions: {
				contents: "write",
				issues: "write",
				pull_requests: "write",
				actions: "read",
				metadata: "read",
				members: "read",
			},
			default_events: [],
		});
		expect(String(manifest.name).length).toBeLessThanOrEqual(34);
		expect(String(manifest.name)).toMatch(/^Lleverage /);

		const { redirectTo } = await env.connections.completeGitHubApp({ code: "abc123", state });
		expect(redirectTo).toBe(`${ORIGIN}/connections/github?githubApp=${started.id}`);
		const conversion = env.github.requests.find((request) => request.url.includes("/app-manifests/"))!;
		expect(conversion.url).toBe("https://api.github.com/app-manifests/abc123/conversions");
		expect(conversion.init?.method).toBe("POST");
		expect(conversion.init?.redirect).toBe("manual");

		const setupNow = await env.connections.getGitHubApp(alice, started.id);
		expect(setupNow).toMatchObject({
			status: "created",
			githubApp: {
				slug: "harbour-3f9a1c",
				appId: 42,
				htmlUrl: "https://github.com/apps/harbour-3f9a1c",
				installUrl: "https://github.com/apps/harbour-3f9a1c/installations/new",
			},
		});
		const client = await env.connections.getClient(alice, setupNow.clientId!);
		expect(client).toMatchObject({
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			templateId: "github",
			label: "GitHub App harbour-3f9a1c",
			clientId: "Iv23-app-client",
			secret: { set: true, last4: "alue" },
			githubApp: { slug: "harbour-3f9a1c", appId: 42 },
		});
		expect(client.public).toBeUndefined();
		const exposed = JSON.stringify([setupNow, client, await env.connections.listClients(alice)]);
		expect(exposed).not.toContain("app-client-secret-value");
		// The client secret is in the vault, bound to GitHub's token endpoint; the app's key and webhook secret nowhere.
		const items = [...env.credentials.inspect().values()];
		expect(items.find((item) => item.value === "app-client-secret-value")?.hosts).toEqual(["github.com"]);
		const values = items.map((item) => item.value ?? "");
		expect(values.some((value) => value.includes("pem-secret-value"))).toBe(false);
		expect(values).not.toContain("webhook-secret-value");
		// And the catalogue now connects GitHub through it.
		expect(await entry(env, "github")).toMatchObject({ setup: "ready", tier: "own_app", client: { tier: "user" } });

		// The state works once.
		await expect(env.connections.completeGitHubApp({ code: "abc123", state })).rejects.toMatchObject({
			code: "refused",
		});
		await expect(env.connections.gitHubAppManifestPage(started.id, state)).rejects.toMatchObject({
			code: "refused",
		});
	});

	it("posts to a GitHub organisation's settings when one is named", async () => {
		const env = setup();
		const started = await env.connections.startGitHubApp(admin, {
			owner: "organisation",
			githubOrganisation: "acme-inc",
		});
		const state = stateOf(started.url!);
		const html = await env.connections.gitHubAppManifestPage(started.id, state);
		expect(html).toContain(`action="https://github.com/organizations/acme-inc/settings/apps/new?state=${state}"`);
		expect(String(manifestOf(html).name)).toMatch(/^Lleverage for acme-inc /);
	});

	it("refuses a wrong state, an expired flow, someone else's flow and a caller without the right", async () => {
		const env = setup();
		const started = await env.connections.startGitHubApp(alice, { owner: "user" });
		await expect(env.connections.gitHubAppManifestPage(started.id, "not-the-state")).rejects.toMatchObject({
			code: "refused",
		});
		await expect(env.connections.getGitHubApp(bob, started.id)).rejects.toMatchObject({ code: "not_found" });
		await expect(env.connections.startGitHubApp(alice, { owner: "organisation" })).rejects.toMatchObject({
			code: "forbidden",
		});
		await expect(
			env.connections.startGitHubApp(systemContext("test") as never, { owner: "organisation" }),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			env.connections.startGitHubApp(alice, { owner: "user", githubOrganisation: "not/an org" }),
		).rejects.toMatchObject({ code: "invalid" });
		await expect(
			env.connections.startGitHubApp(alice, { owner: "user", returnTo: "javascript:alert(1)" }),
		).rejects.toMatchObject({ code: "invalid" });

		env.advance(60 * 60 * 1000 + 1);
		const state = stateOf(started.url!);
		expect((await env.connections.getGitHubApp(alice, started.id)).status).toBe("expired");
		await expect(env.connections.gitHubAppManifestPage(started.id, state)).rejects.toMatchObject({
			code: "expired",
		});
		const { redirectTo } = await env.connections.completeGitHubApp({ code: "abc123", state });
		expect(new URL(redirectTo).searchParams.get("githubAppError")).toBe("expired");
		expect(env.github.requests.some((request) => request.url.includes("/app-manifests/"))).toBe(false);
	});

	it("marks the flow failed when GitHub won't hand the app over", async () => {
		const env = setup();
		env.github.state.conversion = { status: 422, body: { message: "Validation failed" } };
		const started = await env.connections.startGitHubApp(alice, { owner: "user" });
		const { redirectTo } = await env.connections.completeGitHubApp({ code: "abc123", state: stateOf(started.url!) });
		const back = new URL(redirectTo);
		expect(back.origin + back.pathname).toBe(`${ORIGIN}/connections`);
		expect(back.searchParams.get("githubAppError")).toBe("conversion");
		const failed = await env.connections.getGitHubApp(alice, started.id);
		expect(failed.status).toBe("failed");
		expect(failed.failure?.message).toContain("422");
		expect((await env.connections.listClients(alice)).items).toHaveLength(0);
	});
});
