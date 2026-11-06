// Email-code sign-in and open sign-up on the public origin (KANTEL_PUBLIC_URL), in Node over node:sqlite: someone new
// gets a personal space of their own, sees nothing of anyone else's, and is not the compute plane's super-admin; the
// Access hostname answers as before; the daily mail cap holds.
import { DatabaseSync } from "node:sqlite";
import { EMAIL_OTP_ISSUER, type IdentityDirectory } from "@kantel/contracts";
import { createSqlIdentity, migrateIdentity } from "@kantel/identity/sql";
import { createMockAccess } from "@kantel/identity/testing";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { describe, expect, it } from "vitest";
import { COMPUTE_MEMBERS_ONLY } from "../src/compute.ts";
import { DEFAULT_DAILY_MAIL_CAP, type GatewayVars, gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { dailyMailBudget, memoryMailCounts, type SendEmailBinding } from "../src/mail.ts";
import { createMemorySignUpStore, openSignUp, type SignUpRecord, type SignUpStore } from "../src/sign-up.ts";
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

	it("keeps each space apart, and lets nobody who signs up use the stub's compute or be its super-admin", async () => {
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
		// The stub keeps sandboxes in the object's memory: someone who signed up may not fill it, by any way in.
		for (const [method, path, body] of [
			["GET", "/v1/whoami", undefined],
			["POST", "/v1/sandboxes", { name: "adas", wait: true }],
			["GET", "/v1/sandboxes", undefined],
			["POST", "/v1/api-keys", { name: "cli" }],
			["GET", "/v1/admin/hosts", undefined],
		] as const) {
			const refused = await call(PUBLIC, method, path, { token: ada, ...(body === undefined ? {} : { body }) });
			expect(refused.status, `${method} ${path}`).toBe(403);
			expect(refused.body.error).toMatchObject({ code: "forbidden", message: COMPUTE_MEMBERS_ONLY });
		}
		// Their own identity still answers.
		expect((await call(PUBLIC, "GET", "/v1/projects", { token: ada })).status).toBe(200);
		// The Access admin is still the super-admin, and still uses compute.
		const admin = await call(ACCESS_HOST, "GET", "/v1/whoami", { access: true });
		expect(admin.body).toMatchObject({ superAdmin: true });
		const made = await call(ACCESS_HOST, "POST", "/v1/sandboxes", { access: true, body: { name: "toms", wait: true } });
		expect(made.status).toBe(201);
		await close();
	});

	it("lets an invited person join the organisation that invited them, with no personal space", async () => {
		const { stack, call, signIn, close } = await start();
		await stack.identity.createInvite(stack.admin, { email: "carol@example.test", role: "viewer" });
		const carol = await signIn("carol@example.test");
		const me = await call(PUBLIC, "GET", "/v1/me", { token: carol });
		expect(me.body.organisationId).toBe(stack.organisation.id);
		const whoami = await call(PUBLIC, "GET", "/v1/whoami", { token: carol });
		expect(whoami.status).toBe(200);
		expect(whoami.body).toMatchObject({ superAdmin: false });
		expect((await call(PUBLIC, "GET", "/v1/organisations", { token: carol })).body.items).toHaveLength(1);
		await close();
	});

	it("lets someone with a space who is invited elsewhere list both and act in each they name", async () => {
		const { stack, call, signIn, close } = await start();
		const ada = await signIn("ada@example.test");
		const bob = await signIn("bob@example.test");
		const personal = String((await call(PUBLIC, "GET", "/v1/me", { token: ada })).body.organisationId);
		const bobs = String((await call(PUBLIC, "GET", "/v1/me", { token: bob })).body.organisationId);
		await stack.identity.createInvite(stack.admin, { email: "ada@example.test", role: "viewer" });
		const again = await signIn("ada@example.test");
		// Naming none, she's asked to (the console then lists hers).
		const unnamed = await call(PUBLIC, "GET", "/v1/me", { token: again });
		expect(unnamed.status).toBe(403);
		expect(unnamed.body.error).toMatchObject({ failure: "organisation" });
		const listed = await call(PUBLIC, "GET", "/v1/organisations", { token: again });
		expect(listed.status).toBe(200);
		expect((listed.body.items as { id: string }[]).map((item) => item.id).sort()).toEqual(
			[personal, stack.organisation.id].sort(),
		);
		const as = (organisationId: string) => ({ token: again, headers: { "kantel-organisation": organisationId } });
		expect((await call(PUBLIC, "GET", "/v1/me", as(personal))).body.organisationId).toBe(personal);
		expect((await call(PUBLIC, "GET", "/v1/me", as(stack.organisation.id))).body.organisationId).toBe(
			stack.organisation.id,
		);
		// In the deployment's organisation she may use compute, though not as its super-admin.
		expect((await call(PUBLIC, "GET", "/v1/whoami", as(stack.organisation.id))).body).toMatchObject({
			superAdmin: false,
		});
		expect((await call(PUBLIC, "GET", "/v1/whoami", as(personal))).status).toBe(403);
		// Bob's is still not hers.
		expect((await call(PUBLIC, "GET", "/v1/me", as(bobs))).status).toBe(403);
		await close();
	});

	it("emails a compute invite with a link, which only the person it was made for can join with (#657)", async () => {
		const { call, signIn, sent, close } = await start({ KANTEL_ACCOUNT_HOSTS: "experimental" });
		const ada = await signIn("ada@example.test");
		const ann = await signIn("ann@example.test");
		const bob = await signIn("bob@example.test");
		const org = await call(PUBLIC, "POST", "/v1/accounts", { token: ada, body: { name: "Acme" } });
		expect(org.status).toBe(201);
		const invite = await call(PUBLIC, "POST", `/v1/accounts/${org.body.id}/invites`, {
			token: ada,
			body: { email: "Ann@Example.test", role: "member" },
		});
		expect(invite.status).toBe(201);
		expect(invite.body.emailed).toBe(true);
		// Sent through the sign-in mail binding: the console's link, the code in its fragment.
		const mail = sent.findLast((message) => message.to === "ann@example.test");
		expect(mail?.subject).toBe("ada@example.test invited you to Acme on Kantel");
		const link = /https:\S+/.exec(mail?.text ?? "")?.[0] ?? "";
		expect(link).toBe(`${PUBLIC}/organisation#join=${invite.body.code}`);
		const join = { body: { code: decodeURIComponent(new URL(link).hash.slice("#join=".length)) } };

		const refused = await call(PUBLIC, "POST", "/v1/accounts/join", { token: bob, ...join });
		expect(refused.status).toBe(403);
		expect(refused.body.error).toMatchObject({
			code: "forbidden",
			message:
				"This invite is for ann@example.test, but you're signed in as bob@example.test. Sign in as ann@example.test to join.",
		});
		const joined = await call(PUBLIC, "POST", "/v1/accounts/join", { token: ann, ...join });
		expect(joined.status).toBe(200);
		expect(joined.body).toMatchObject({ id: org.body.id, role: "member" });
		await close();
	});

	it("names the people in a compute organisation as they signed up, never by their user ID", async () => {
		const { call, signIn, close } = await start({ KANTEL_ACCOUNT_HOSTS: "experimental" });
		const ada = await signIn("ada@example.test");
		const ann = await signIn("ann@example.test");
		const org = await call(PUBLIC, "POST", "/v1/accounts", { token: ada, body: { name: "Acme" } });
		const invite = await call(PUBLIC, "POST", `/v1/accounts/${org.body.id}/invites`, {
			token: ada,
			body: { email: "ann@example.test", role: "member" },
		});
		expect(
			(await call(PUBLIC, "POST", "/v1/accounts/join", { token: ann, body: { code: invite.body.code } })).status,
		).toBe(200);

		const members = await call(PUBLIC, "GET", `/v1/accounts/${org.body.id}/members`, { token: ada });
		expect(members.status).toBe(200);
		// An email code's sign-up is named by the address.
		expect((members.body.items as { name: string }[]).map((member) => member.name).sort()).toEqual([
			"ada@example.test",
			"ann@example.test",
		]);
		await close();
	});
});

describe("deleting an account", () => {
	it("signs the person out everywhere, and signing up again is someone new whom no old session reaches", async () => {
		const { call, signIn, close } = await start({ KANTEL_ACCOUNT_HOSTS: "experimental" });
		const first = await signIn("ada@example.test");
		const second = await signIn("ada@example.test");
		const before = await call(PUBLIC, "GET", "/v1/whoami", { token: first });
		expect(before.status).toBe(200);
		const key = await call(PUBLIC, "POST", "/v1/api-keys", {
			token: first,
			body: { name: "cli", preset: "read-only" },
		});
		expect(key.status).toBe(201);

		expect((await call(PUBLIC, "DELETE", "/v1/whoami", { token: String(key.body.secret) })).status).toBe(403);
		expect((await call(PUBLIC, "DELETE", "/v1/whoami", { token: first })).status).toBe(204);

		for (const token of [first, second, String(key.body.secret)]) {
			expect((await call(PUBLIC, "GET", "/v1/whoami", { token })).status).toBe(401);
		}
		const fresh = await signIn("ada@example.test");
		const after = await call(PUBLIC, "GET", "/v1/whoami", { token: fresh });
		expect(after.status).toBe(200);
		const user = (body: Record<string, unknown>) => (body.user as { id: string }).id;
		expect(user(after.body)).not.toBe(user(before.body));
		expect(after.body.accountId).not.toBe(before.body.accountId);
		// The sessions from before stay gone, though the same email signs in again.
		for (const token of [first, second]) {
			expect((await call(PUBLIC, "GET", "/v1/whoami", { token })).status).toBe(401);
		}
		await close();
	});

	it("is refused to the deployment's super-admin", async () => {
		const { call, close } = await start();
		const refused = await call(ACCESS_HOST, "DELETE", "/v1/whoami", { access: true });
		expect(refused.status).toBe(403);
		await close();
	});
});

describe("a sign-up that stopped part-way", () => {
	it("is finished on the next sign-in, with one space and one Default project", async () => {
		const identity = await sqlDirectory();
		const records = createMemorySignUpStore();
		const external = {
			issuer: EMAIL_OTP_ISSUER,
			subject: "ada@example.test",
			email: "ada@example.test",
			emailVerified: true,
		};
		const ctx = { actor: { kind: "system" as const, component: "test" }, organisationId: "test" };
		// The first attempt made the space, then failed before its project.
		let failProject = true;
		const flaky: IdentityDirectory = {
			...identity,
			createProject: (...args) =>
				failProject ? Promise.reject(new Error("D1 went away")) : identity.createProject(...args),
		};
		const signUp = openSignUp(flaky, { records });
		await expect(signUp.signIn(ctx, external)).rejects.toThrow("D1 went away");
		failProject = false;
		const signedIn = await signUp.signIn(ctx, external);
		expect(signedIn.organisationIds).toHaveLength(1);
		const [organisationId] = signedIn.organisationIds;
		const as = { actor: { kind: "human" as const, userId: signedIn.user.id }, organisationId: organisationId ?? "" };
		expect((await identity.listProjects(as)).items.map((project) => project.name)).toEqual(["Default"]);
		// And again: nothing more is made.
		const third = await signUp.signIn(ctx, external);
		expect(third.organisationIds).toEqual(signedIn.organisationIds);
		expect((await identity.listProjects(as)).items).toHaveLength(1);
	});

	it("also finishes when the space was made but never recorded", async () => {
		const identity = await sqlDirectory();
		const saved: SignUpRecord[] = [];
		const inner = createMemorySignUpStore();
		let dropSpace = true;
		const records: SignUpStore = {
			load: (userId) => inner.load(userId),
			delete: (userId) => inner.delete(userId),
			async save(userId, record) {
				saved.push(record);
				// The object stopped after the organisation committed, before its record did.
				if (record.organisationId !== undefined && dropSpace) throw new Error("reset");
				await inner.save(userId, record);
			},
		};
		const external = { issuer: EMAIL_OTP_ISSUER, subject: "b@x.test", email: "b@x.test", emailVerified: true };
		const ctx = { actor: { kind: "system" as const, component: "test" }, organisationId: "test" };
		const signUp = openSignUp(identity, { records });
		await expect(signUp.signIn(ctx, external)).rejects.toThrow("reset");
		dropSpace = false;
		const signedIn = await signUp.signIn(ctx, external);
		expect(signedIn.organisationIds).toHaveLength(1);
		expect(saved.at(-1)).toMatchObject({ organisationId: signedIn.organisationIds[0] });
		expect(saved.at(-1)?.projectId).toBeDefined();
		expect(await organisationsNamed(identity, signedIn.user.id, signedIn.organisationIds)).toEqual(["Personal"]);
	});

	it("makes no space for someone who was only invited", async () => {
		const identity = await sqlDirectory();
		const records = createMemorySignUpStore();
		const system = { actor: { kind: "system" as const, component: "test" }, organisationId: "test" };
		const owner = await identity.createUser(system, { name: "Owner", email: "o@x.test" });
		const team = await identity.createOrganisation(system, {
			name: "Team",
			admin: { kind: "user", userId: owner.id },
		});
		await identity.createInvite(
			{ actor: { kind: "human", userId: owner.id }, organisationId: team.id },
			{ email: "c@x.test", role: "viewer" },
		);
		const external = { issuer: EMAIL_OTP_ISSUER, subject: "c@x.test", email: "c@x.test", emailVerified: true };
		const signedIn = await openSignUp(identity, { records }).signIn(system, external);
		expect(signedIn.organisationIds).toEqual([team.id]);
		expect(await records.load(signedIn.user.id)).toBeUndefined();
	});

	it("doesn't make a second space when the look for an unrecorded one fails", async () => {
		const identity = await sqlDirectory();
		const inner = createMemorySignUpStore();
		let dropSpace = true;
		const records: SignUpStore = {
			load: (userId) => inner.load(userId),
			delete: (userId) => inner.delete(userId),
			async save(userId, record) {
				if (record.organisationId !== undefined && dropSpace) throw new Error("reset");
				await inner.save(userId, record);
			},
		};
		let readFails = false;
		const flaky: IdentityDirectory = {
			...identity,
			getOrganisation: (...args) =>
				readFails ? Promise.reject(new Error("D1 went away")) : identity.getOrganisation(...args),
		};
		const external = { issuer: EMAIL_OTP_ISSUER, subject: "d@x.test", email: "d@x.test", emailVerified: true };
		const ctx = { actor: { kind: "system" as const, component: "test" }, organisationId: "test" };
		const signUp = openSignUp(flaky, { records });
		await expect(signUp.signIn(ctx, external)).rejects.toThrow("reset");
		dropSpace = false;
		readFails = true;
		await expect(signUp.signIn(ctx, external)).rejects.toThrow("D1 went away");
		readFails = false;
		const signedIn = await signUp.signIn(ctx, external);
		expect(signedIn.organisationIds).toHaveLength(1);
		expect(await organisationsNamed(identity, signedIn.user.id, signedIn.organisationIds)).toEqual(["Personal"]);
	});

	it("finishes the space an overlapping sign-in made and failed to record, rather than making another", async () => {
		const identity = await sqlDirectory();
		const inner = createMemorySignUpStore();
		let drops = 1;
		const records: SignUpStore = {
			load: (userId) => inner.load(userId),
			delete: (userId) => inner.delete(userId),
			async save(userId, record) {
				if (record.organisationId !== undefined && drops > 0) {
					drops -= 1;
					throw new Error("reset");
				}
				await inner.save(userId, record);
			},
		};
		const external = { issuer: EMAIL_OTP_ISSUER, subject: "f@x.test", email: "f@x.test", emailVerified: true };
		const ctx = { actor: { kind: "system" as const, component: "test" }, organisationId: "test" };
		const signUp = openSignUp(identity, { records });
		// Both read no memberships before either takes the lock.
		const settled = await Promise.allSettled([signUp.signIn(ctx, external), signUp.signIn(ctx, external)]);
		// Whichever took the lock first failed; the other finished its space.
		expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		const after = await identity.signIn(ctx, external);
		expect(after.organisationIds).toHaveLength(1);
		expect(await organisationsNamed(identity, after.user.id, after.organisationIds)).toEqual(["Personal"]);
		const as = {
			actor: { kind: "human" as const, userId: after.user.id },
			organisationId: after.organisationIds[0] ?? "",
		};
		expect((await identity.listProjects(as)).items.map((project) => project.name)).toEqual(["Default"]);
	});

	it("makes one space when two sign-ins overlap", async () => {
		const identity = await sqlDirectory();
		const records = createMemorySignUpStore();
		const external = { issuer: EMAIL_OTP_ISSUER, subject: "e@x.test", email: "e@x.test", emailVerified: true };
		const ctx = { actor: { kind: "system" as const, component: "test" }, organisationId: "test" };
		const signUp = openSignUp(identity, { records });
		const [one, two] = await Promise.all([signUp.signIn(ctx, external), signUp.signIn(ctx, external)]);
		expect(one?.organisationIds).toHaveLength(1);
		expect(two?.organisationIds).toEqual(one?.organisationIds);
		const after = await identity.signIn(ctx, external);
		expect(after.organisationIds).toEqual(one?.organisationIds);
		const as = {
			actor: { kind: "human" as const, userId: after.user.id },
			organisationId: after.organisationIds[0] ?? "",
		};
		expect((await identity.listProjects(as)).items.map((project) => project.name)).toEqual(["Default"]);
	});
});

describe("the daily mail cap", () => {
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

/** The SQL directory the deployment uses, over node:sqlite. */
async function sqlDirectory(): Promise<IdentityDirectory> {
	const driver = syncSqliteDriver(new DatabaseSync(":memory:"));
	await migrateIdentity(driver);
	return createSqlIdentity({ driver });
}

/** The names of `organisationIds`, as `userId` sees them. */
async function organisationsNamed(
	identity: IdentityDirectory,
	userId: string,
	organisationIds: readonly string[],
): Promise<string[]> {
	return Promise.all(
		organisationIds.map(
			async (organisationId) =>
				(await identity.getOrganisation({ actor: { kind: "human", userId }, organisationId }, organisationId)).name,
		),
	);
}

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
