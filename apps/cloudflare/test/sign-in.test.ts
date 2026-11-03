// Email-code sign-in and open sign-up on the public origin (KANTEL_PUBLIC_URL), in Node over node:sqlite: someone new
// gets a personal space of their own, sees nothing of anyone else's, and is not the compute plane's super-admin; the
// Access hostname answers as before; the daily mail cap holds.
import { DatabaseSync } from "node:sqlite";
import { createMockAccess } from "@kantel/identity/testing";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { describe, expect, it } from "vitest";
import { DEFAULT_DAILY_MAIL_CAP, type GatewayVars, gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { dailyMailBudget, memoryMailCounts, type SendEmailBinding } from "../src/mail.ts";
import { createStack } from "../src/stack.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
const ACCESS_HOST = "https://harbour.kantel.test";
const PUBLIC = "https://app.kantel.test";
const FROM = "sign-in@kantel.test";

type Sent = Parameters<SendEmailBinding["send"]>[0];

async function start(vars: GatewayVars = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const sent: Sent[] = [];
	const pending: Promise<unknown>[] = [];
	const stack = await createStack({
		config: gatewayConfig({
			KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
			KANTEL_ACCESS_AUD: AUD,
			KANTEL_ADMIN_EMAIL: ADMIN,
			KANTEL_PUBLIC_URL: PUBLIC,
			KANTEL_SIGN_IN_FROM: FROM,
			...vars,
		}),
		accessFetch: mock.fetch,
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
	const accessToken = await mock.sign({ sub: "access-subject-1", email: ADMIN });

	const call = async (
		origin: string,
		method: string,
		path: string,
		options: { body?: unknown; token?: string; access?: boolean; headers?: Record<string, string> } = {},
	) => {
		const headers: Record<string, string> = { ...options.headers };
		if (options.body !== undefined) headers["content-type"] = "application/json";
		if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
		if (options.access === true) headers["cf-access-jwt-assertion"] = accessToken;
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

	/** The code the last mail to `email` carried, once its deferred send has run. */
	const codeFor = async (email: string): Promise<string> => {
		await Promise.all(pending.splice(0));
		const mail = sent.findLast((message) => message.to === email);
		const code = /code is (\d{6})/.exec(mail?.text ?? "")?.[1];
		if (code === undefined) throw new Error(`no code was sent to ${email}`);
		return code;
	};

	/** Signs `email` in on the public origin; the session token. */
	const signIn = async (email: string): Promise<string> => {
		const started = await call(PUBLIC, "POST", "/auth/otp/start", { body: { email } });
		expect(started.status).toBe(202);
		const verified = await call(PUBLIC, "POST", "/auth/otp/verify", { body: { email, code: await codeFor(email) } });
		expect(verified.status).toBe(200);
		return String(verified.body.token);
	};

	return { stack, call, signIn, sent, close: () => stack.compute.close() };
}

describe("the public origin's configuration", () => {
	it("needs both KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM, and caps mail at 100 a day by default", () => {
		expect(() => gatewayConfig({ KANTEL_PUBLIC_URL: PUBLIC })).toThrow(/both/);
		expect(() => gatewayConfig({ KANTEL_SIGN_IN_FROM: FROM })).toThrow(/both/);
		expect(() => gatewayConfig({ KANTEL_PUBLIC_URL: `${PUBLIC}/console`, KANTEL_SIGN_IN_FROM: FROM })).toThrow(
			/origin/,
		);
		expect(() =>
			gatewayConfig({ KANTEL_PUBLIC_URL: PUBLIC, KANTEL_SIGN_IN_FROM: FROM, KANTEL_SIGN_IN_DAILY_CAP: "lots" }),
		).toThrow(/whole number/);
		expect(gatewayConfig({ KANTEL_PUBLIC_URL: `${PUBLIC}/`, KANTEL_SIGN_IN_FROM: FROM }).emailSignIn).toEqual({
			publicUrl: PUBLIC,
			from: FROM,
			dailyCap: DEFAULT_DAILY_MAIL_CAP,
		});
		expect(DEFAULT_DAILY_MAIL_CAP).toBe(100);
		expect(gatewayConfig({}).emailSignIn).toBeUndefined();
	});
});

describe("email-code sign-in on the public origin", () => {
	it("names email codes in a 401 there, and Access on the Access hostname", async () => {
		const { call, close } = await start();
		const onPublic = await call(PUBLIC, "GET", "/v1/me");
		expect(onPublic.status).toBe(401);
		expect(onPublic.body.error).toMatchObject({ signIn: ["email_otp"] });
		const behindAccess = await call(ACCESS_HOST, "GET", "/v1/me");
		expect(behindAccess.status).toBe(401);
		expect(behindAccess.body.error).toMatchObject({ signIn: ["cloudflare_access"] });
		// The sign-in routes are the public origin's only.
		expect((await call(ACCESS_HOST, "POST", "/auth/otp/start", { body: { email: "a@x.test" } })).status).toBe(404);
		await close();
	});

	it("signs someone new up into a personal space of their own, sent from the one sender", async () => {
		const { call, signIn, sent, close } = await start();
		const token = await signIn("ada@example.test");
		expect(sent[0]).toMatchObject({
			to: "ada@example.test",
			from: { email: FROM },
			subject: "Your Kantel sign-in code",
		});
		const me = await call(PUBLIC, "GET", "/v1/me", { token });
		expect(me.status).toBe(200);
		expect(me.body).toMatchObject({ method: "harbour_session", name: "ada@example.test", email: "ada@example.test" });
		expect(me.body.roles).toContainEqual({ role: "admin" });
		const organisations = await call(PUBLIC, "GET", "/v1/organisations", { token });
		expect((organisations.body.items as { name: string }[]).map((organisation) => organisation.name)).toEqual([
			"Personal",
		]);
		const projects = await call(PUBLIC, "GET", "/v1/projects", { token });
		expect((projects.body.items as { name: string }[]).map((project) => project.name)).toEqual(["Default"]);
		// Signing in again finds the same space rather than making another.
		const again = await signIn("ada@example.test");
		const meAgain = await call(PUBLIC, "GET", "/v1/me", { token: again });
		expect(meAgain.body.organisationId).toBe(me.body.organisationId);
		await close();
	});

	it("keeps each space apart, and makes nobody who signs up a super-admin", async () => {
		const { call, signIn, close } = await start();
		const ada = await signIn("ada@example.test");
		const bob = await signIn("bob@example.test");
		const adaMe = await call(PUBLIC, "GET", "/v1/me", { token: ada });
		const bobMe = await call(PUBLIC, "GET", "/v1/me", { token: bob });
		expect(adaMe.body.organisationId).not.toBe(bobMe.body.organisationId);
		// Bob sees only himself, and may not act in Ada's space.
		const members = await call(PUBLIC, "GET", "/v1/members", { token: bob });
		expect((members.body.items as { name: string }[]).map((member) => member.name)).toEqual(["bob@example.test"]);
		const intoAda = await call(PUBLIC, "GET", "/v1/members", {
			token: bob,
			headers: { "kantel-organisation": String(adaMe.body.organisationId) },
		});
		expect(intoAda.status).toBe(403);
		// Administering their own space doesn't make them the deployment's super-admin.
		const whoami = await call(PUBLIC, "GET", "/v1/whoami", { token: ada });
		expect(whoami.status).toBe(200);
		expect(whoami.body).toMatchObject({ superAdmin: false });
		expect((await call(PUBLIC, "GET", "/v1/admin/hosts", { token: ada })).status).toBe(403);
		// Their sandboxes are their own.
		const made = await call(PUBLIC, "POST", "/v1/sandboxes", { token: ada, body: { name: "adas", wait: true } });
		expect(made.status).toBe(201);
		const bobsList = await call(PUBLIC, "GET", "/v1/sandboxes", { token: bob });
		expect(bobsList.body.items).toEqual([]);
		expect((await call(PUBLIC, "GET", `/v1/sandboxes/${made.body.id}`, { token: bob })).status).toBe(404);
		// The Access admin is still the super-admin.
		const admin = await call(ACCESS_HOST, "GET", "/v1/whoami", { access: true });
		expect(admin.body).toMatchObject({ superAdmin: true });
		await close();
	});

	it("lets an invited person join the organisation that invited them, with no personal space", async () => {
		const { stack, call, signIn, close } = await start();
		await stack.identity.createInvite(stack.admin, { email: "carol@example.test", role: "viewer" });
		const carol = await signIn("carol@example.test");
		const me = await call(PUBLIC, "GET", "/v1/me", { token: carol });
		expect(me.body.organisationId).toBe(stack.organisation.id);
		expect((await call(PUBLIC, "GET", "/v1/whoami", { token: carol })).body).toMatchObject({ superAdmin: false });
		await close();
	});

	it("refuses a start once the day's mail cap is reached", async () => {
		const { call, signIn, sent, close } = await start({ KANTEL_SIGN_IN_DAILY_CAP: "2" });
		await signIn("ada@example.test");
		await signIn("bob@example.test");
		const third = await call(PUBLIC, "POST", "/auth/otp/start", { body: { email: "cy@example.test" } });
		expect(third.status).toBe(503);
		expect(sent).toHaveLength(2);
		await close();
	});
});

describe("the daily mail budget", () => {
	it("counts per UTC day, and starts again the next day", async () => {
		let now = Date.parse("2026-11-03T23:59:00Z");
		const budget = dailyMailBudget({ cap: 1, counts: memoryMailCounts(), now: () => now });
		expect(await budget.take()).toBe(true);
		expect(await budget.take()).toBe(false);
		now = Date.parse("2026-11-04T00:01:00Z");
		expect(await budget.take()).toBe(true);
	});
});
