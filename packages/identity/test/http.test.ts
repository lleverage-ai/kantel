import {
	authenticationFailureOf,
	type CallContext,
	isHarbourError,
	ME_PATH,
	ORGANISATION_HEADER,
	PROJECTS_PATH,
	type SignInMethod,
} from "@harbour/contracts";
import { createAuthenticator } from "@harbour/identity/authenticator";
import {
	createIdentityClient,
	createIdentityHandler,
	type IdentityClient,
	signInMethodsOf,
} from "@harbour/identity/http";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createEmailOtp, createMemoryOtpStores, harbourSessionProvider, MemoryOtpMailer } from "@harbour/identity/otp";
import { createOtpHandler } from "@harbour/identity/otp/http";
import { ManualClock } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };
const ORIGIN = "http://harbour.test";

/** Lets the mail, sent on a later task, go out. */
const mailed = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * One organisation with two projects: Ada administers it, Grace views Billing only, and a host app's key operates on
 * Website only. The identity routes and the OTP routes are served in-process, and every client calls them through a
 * fetch that hands the request straight to the handler.
 */
async function world(options: { signIn?: readonly SignInMethod[] } = {}) {
	const clock = new ManualClock();
	const identity = createMemoryIdentity({ clock });
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: "ada@harbour.test" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Harbour",
		admin: { kind: "user", userId: ada.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: organisation.id };
	const website = await identity.createProject(admin, { name: "Website" });
	const billing = await identity.createProject(admin, { name: "Billing" });
	const grace = await identity.createUser(admin, { name: "Grace Hopper", email: "grace@harbour.test" });
	await identity.grantRole(admin, {
		principal: { kind: "user", userId: grace.id },
		role: "viewer",
		projectId: billing.id,
	});
	const service = await identity.createServiceIdentity(admin, { name: "Sal" });
	const key = await identity.issueApiKey(admin, { serviceId: service.id, projectIds: [website.id], role: "operator" });

	const stores = createMemoryOtpStores();
	const mailer = new MemoryOtpMailer();
	const otp = createEmailOtp({ identity, ...stores, mailer, clock });
	const authenticator = createAuthenticator({ identity, providers: [harbourSessionProvider({ ...stores, clock })] });
	const otpHandler = createOtpHandler({ otp });
	const identityHandler = createIdentityHandler({
		identity,
		authenticator,
		...(options.signIn === undefined ? {} : { signIn: options.signIn }),
	});
	const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/auth/") ? otpHandler(request) : identityHandler(request);
	};
	const clientWith = (headers: Record<string, string> = {}): IdentityClient =>
		createIdentityClient({ baseUrl: ORIGIN, fetch: serve, headers: () => headers });

	/** Signs `email` in through the OTP routes with the code the mailer got, and a client that sends the session. */
	const signIn = async (email: string) => {
		const anonymous = clientWith();
		await anonymous.startOtp(email);
		await mailed();
		const code = mailer.lastCodeFor(email);
		if (code === undefined) throw new Error(`no code was sent to ${email}`);
		const session = await anonymous.verifyOtp(email, code);
		return { session, client: clientWith({ authorization: `Bearer ${session.token}` }) };
	};

	return { identity, admin, organisation, website, billing, ada, service, key, mailer, serve, clientWith, signIn };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to be refused");
}

describe("GET /v1/me", () => {
	it("names a person signed in with an email code, their organisation-wide role and how they signed in", async () => {
		const { signIn, organisation, ada } = await world();
		const { client } = await signIn("ada@harbour.test");
		expect(await client.me()).toEqual({
			actor: { kind: "human", userId: ada.id },
			organisationId: organisation.id,
			method: "harbour_session",
			name: "Ada Lovelace",
			email: "ada@harbour.test",
			roles: [{ role: "admin" }],
			preferences: {},
		});
	});

	it("lists a project role only where it is the person's", async () => {
		const { signIn, billing } = await world();
		const { client } = await signIn("grace@harbour.test");
		const me = await client.me();
		expect(me.name).toBe("Grace Hopper");
		expect(me.roles).toEqual([{ projectId: billing.id, role: "viewer" }]);
	});

	it("names a host app's key by its service, with its role on each of its projects", async () => {
		const { clientWith, key, service, website } = await world();
		const me = await clientWith({ authorization: `Bearer ${key.secret}` }).me();
		expect(me.actor).toEqual({ kind: "service", serviceId: service.id, keyId: key.key.id });
		expect(me.method).toBe("api_key");
		expect(me.name).toBe(service.id);
		expect(me.email).toBeUndefined();
		expect(me.roles).toEqual([{ projectId: website.id, role: "operator" }]);
	});

	it("is 401 with the deployment's sign-in methods when there are no credentials", async () => {
		const { clientWith, serve } = await world({ signIn: ["email_otp"] });
		const error = await refusal(clientWith().me());
		expect(authenticationFailureOf(error)).toBe("invalid");
		expect(signInMethodsOf(error)).toEqual(["email_otp"]);

		const response = await serve(`${ORIGIN}${ME_PATH}`);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(`Bearer realm="harbour"`);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			error: { code: "unauthenticated", message: "This call needs credentials", signIn: ["email_otp"] },
		});
	});

	it("names no sign-in method when the deployment gave none, and never echoes a bad credential", async () => {
		const { clientWith, serve } = await world();
		const error = await refusal(clientWith({ authorization: "Bearer hbs_not-a-session" }).me());
		expect(authenticationFailureOf(error)).toBe("invalid");
		expect(signInMethodsOf(error)).toBeUndefined();
		const response = await serve(`${ORIGIN}${ME_PATH}`, { headers: { authorization: "Bearer hbs_not-a-session" } });
		expect(await response.text()).not.toContain("hbs_not-a-session");
	});

	it("is 403 for an organisation the person may not act in", async () => {
		const { signIn, clientWith } = await world();
		const { session } = await signIn("ada@harbour.test");
		const error = await refusal(
			clientWith({ authorization: `Bearer ${session.token}`, [ORGANISATION_HEADER]: "org_elsewhere" }).me(),
		);
		expect(authenticationFailureOf(error)).toBe("organisation");
	});

	it("stops answering once the session has ended", async () => {
		const { signIn, clientWith } = await world();
		const { client, session } = await signIn("ada@harbour.test");
		await client.me();
		await clientWith().endSession(session.token);
		expect(authenticationFailureOf(await refusal(client.me()))).toBe("invalid");
	});
});

describe("PATCH /v1/me/preferences", () => {
	it("keeps a person's theme, which GET /v1/me then carries", async () => {
		const { signIn } = await world();
		const { client } = await signIn("grace@harbour.test");
		expect(await client.setPreferences({ theme: "tokyo-night" })).toEqual({ theme: "tokyo-night" });
		expect((await client.me()).preferences).toEqual({ theme: "tokyo-night" });
		expect(await client.setPreferences({ theme: null })).toEqual({});
		expect((await client.me()).preferences).toEqual({});
	});

	it("keeps the model and thinking level a person last chose, which GET /v1/me then carries", async () => {
		const { signIn } = await world();
		const { client } = await signIn("grace@harbour.test");
		const chosen = { lastModel: "default:gpt-5", lastThinking: "high" } as const;
		expect(await client.setPreferences(chosen)).toEqual(chosen);
		expect((await client.me()).preferences).toEqual(chosen);
		const bad = await refusal(client.setPreferences({ lastThinking: "lots" as never }));
		expect(isHarbourError(bad, "invalid")).toBe(true);
		expect((await client.me()).preferences).toEqual(chosen);
	});

	it("refuses a bad theme, a body that isn't JSON, and another method", async () => {
		const { signIn, serve } = await world();
		const { client, session } = await signIn("ada@harbour.test");
		const bad = await refusal(client.setPreferences({ theme: "<script>" }));
		expect(isHarbourError(bad, "invalid")).toBe(true);
		const url = `${ORIGIN}/v1/me/preferences`;
		const authorization = `Bearer ${session.token}`;
		const plain = await serve(url, { method: "PATCH", headers: { authorization }, body: '{"theme":"nord"}' });
		expect(plain.status).toBe(415);
		const get = await serve(url, { headers: { authorization } });
		expect([get.status, get.headers.get("allow")]).toEqual([405, "PATCH"]);
		const anonymous = await serve(url, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(anonymous.status).toBe(401);
	});

	it("refuses a host app's key: only a person has settings, and its /v1/me has none", async () => {
		const { clientWith, key } = await world();
		const client = clientWith({ authorization: `Bearer ${key.secret}` });
		const error = await refusal(client.setPreferences({ theme: "nord" }));
		expect(isHarbourError(error, "forbidden")).toBe(true);
		expect((await client.me()).preferences).toBeUndefined();
	});
});

describe("/v1/projects/{id}/settings", () => {
	it("keeps a project's goal mode and decision model beside the platform's defaults, for an admin to change", async () => {
		const { signIn, website } = await world();
		const { client } = await signIn("ada@harbour.test");
		expect(await client.projectSettings(website.id)).toEqual({
			settings: {},
			defaults: { browserGoalMode: "off", browserDecisionModel: "clef" },
		});
		expect(await client.setProjectSettings(website.id, { browserGoalMode: "on", browserDecisionModel: "jev" })).toEqual(
			{
				settings: { browserGoalMode: "on", browserDecisionModel: "jev" },
				defaults: { browserGoalMode: "off", browserDecisionModel: "clef" },
			},
		);
		expect((await client.setProjectSettings(website.id, { browserDecisionModel: null })).settings).toEqual({
			browserGoalMode: "on",
		});
		const bad = await refusal(client.setProjectSettings(website.id, { browserDecisionModel: "gpt" as "jev" }));
		expect(isHarbourError(bad, "invalid")).toBe(true);
		const unknown = await refusal(client.setProjectSettings(website.id, { colour: "red" } as never));
		expect(isHarbourError(unknown, "invalid")).toBe(true);
	});

	it("lets a viewer read them but not change them, and hides a project the caller has no role on", async () => {
		const { signIn, website, billing } = await world();
		const { client } = await signIn("grace@harbour.test");
		expect((await client.projectSettings(billing.id)).settings).toEqual({});
		expect(
			isHarbourError(await refusal(client.setProjectSettings(billing.id, { browserGoalMode: "on" })), "forbidden"),
		).toBe(true);
		expect(isHarbourError(await refusal(client.projectSettings(website.id)), "not_found")).toBe(true);
	});
});

describe("GET /v1/projects", () => {
	it("lists the projects the caller holds a role on, by name", async () => {
		const { signIn, clientWith, key } = await world();
		const ada = (await signIn("ada@harbour.test")).client;
		expect((await ada.allProjects()).map((project) => project.name)).toEqual(["Website", "Billing"]);
		const grace = (await signIn("grace@harbour.test")).client;
		expect((await grace.allProjects()).map((project) => project.name)).toEqual(["Billing"]);
		const host = clientWith({ authorization: `Bearer ${key.secret}` });
		expect((await host.allProjects()).map((project) => project.name)).toEqual(["Website"]);
	});

	it("pages with limit and cursor, and the client follows every page", async () => {
		const { signIn, identity, admin } = await world();
		for (const name of ["Docs", "Search", "Mobile"]) await identity.createProject(admin, { name });
		const { client } = await signIn("ada@harbour.test");
		const first = await client.listProjects({ limit: 2 });
		expect(first.items.map((project) => project.name)).toEqual(["Website", "Billing"]);
		const cursor = first.nextCursor;
		if (cursor === undefined) throw new Error("expected a second page");
		const second = await client.listProjects({ limit: 2, cursor });
		expect(second.items.map((project) => project.name)).toEqual(["Docs", "Search"]);
		expect((await client.allProjects()).map((project) => project.name)).toEqual([
			"Website",
			"Billing",
			"Docs",
			"Search",
			"Mobile",
		]);
	});

	it("refuses a malformed limit, an empty cursor or an unknown parameter as invalid", async () => {
		const { signIn, serve, key } = await world();
		const { session } = await signIn("ada@harbour.test");
		const headers = { authorization: `Bearer ${session.token}` };
		for (const query of ["limit=0", "limit=ten", "limit=-1", "cursor=", "page=2"]) {
			const response = await serve(`${ORIGIN}${PROJECTS_PATH}?${query}`, { headers });
			expect(response.status, query).toBe(400);
			expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid");
		}
		const host = await serve(`${ORIGIN}${PROJECTS_PATH}?limit=1`, {
			headers: { authorization: `Bearer ${key.secret}` },
		});
		expect(host.status).toBe(200);
	});

	it("is 401 without credentials, 405 for another method and 404 for another path", async () => {
		const { serve } = await world({ signIn: ["cloudflare_access"] });
		const anonymous = await serve(`${ORIGIN}${PROJECTS_PATH}`);
		expect(anonymous.status).toBe(401);
		expect(((await anonymous.json()) as { error: { signIn: string[] } }).error.signIn).toEqual(["cloudflare_access"]);
		const posted = await serve(`${ORIGIN}${PROJECTS_PATH}`, { method: "POST", body: "{}" });
		expect(posted.status, "a create is authenticated first").toBe(401);
		const deleted = await serve(`${ORIGIN}${PROJECTS_PATH}`, { method: "DELETE" });
		expect(deleted.status).toBe(405);
		expect(deleted.headers.get("allow")).toBe("GET, POST");
		expect((await serve(`${ORIGIN}/v1/projects/elsewhere`)).status).toBe(404);
	});
});

describe("POST /v1/projects", () => {
	/** An organisation key over the world's organisation, with `create_projects` unless `permissions` says otherwise. */
	async function organisationKey(
		identity: Awaited<ReturnType<typeof world>>["identity"],
		admin: CallContext,
		serviceId: string,
		permissions: readonly "create_projects"[] = ["create_projects"],
	) {
		return identity.issueApiKey(admin, {
			serviceId,
			scope: "organisation",
			role: "operator",
			...(permissions.length === 0 ? {} : { permissions }),
		});
	}

	it("lets an organisation admin create a project, named as trimmed", async () => {
		const { signIn, organisation } = await world();
		const { client } = await signIn("ada@harbour.test");
		const project = await client.createProject({ name: "  Mobile " });
		expect(project).toMatchObject({ name: "Mobile", organisationId: organisation.id });
		expect((await client.allProjects()).map((listed) => listed.id)).toContain(project.id);
	});

	it("lets an organisation key with create_projects create one and act in it, and names it on /v1/me", async () => {
		const { identity, admin, clientWith, service, organisation, website, billing } = await world();
		const issued = await organisationKey(identity, admin, service.id);
		const host = clientWith({ authorization: `Bearer ${issued.secret}` });
		const project = await host.createProject({ name: "Customer 42" });
		expect(project.organisationId).toBe(organisation.id);
		expect((await host.allProjects()).map((listed) => listed.id)).toEqual([website.id, billing.id, project.id]);
		const me = await host.me();
		expect(me.actor).toEqual({ kind: "service", serviceId: service.id, keyId: issued.key.id });
		expect(me.roles).toEqual([{ role: "operator" }]);
	});

	it("refuses a project key, an organisation key without the permission and a viewer with 403", async () => {
		const { identity, admin, clientWith, key, service, signIn } = await world();
		const plain = await organisationKey(identity, admin, service.id, []);
		const { client: grace } = await signIn("grace@harbour.test");
		for (const client of [
			clientWith({ authorization: `Bearer ${key.secret}` }),
			clientWith({ authorization: `Bearer ${plain.secret}` }),
			grace,
		]) {
			expect(isHarbourError(await refusal(client.createProject({ name: "No" })), "forbidden")).toBe(true);
		}
		expect((await identity.listProjects(admin)).items.map((project) => project.name)).toEqual(["Website", "Billing"]);
	});

	it("refuses a malformed body as invalid, and one not sent as JSON as 415", async () => {
		const { signIn, serve } = await world();
		const { session } = await signIn("ada@harbour.test");
		const post = (body: string, contentType = "application/json") =>
			serve(`${ORIGIN}${PROJECTS_PATH}`, {
				method: "POST",
				headers: { authorization: `Bearer ${session.token}`, "content-type": contentType },
				body,
			});
		for (const body of ['{"name":" "}', `{"name":"${"x".repeat(101)}"}`, '{"name":7}', '{"name":"A","x":1}', "[]"]) {
			const response = await post(body);
			expect(response.status, body).toBe(400);
			expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid");
		}
		expect((await post('{"name":"A"}', "text/plain")).status).toBe(415);
		const query = await serve(`${ORIGIN}${PROJECTS_PATH}?limit=1`, {
			method: "POST",
			headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
			body: '{"name":"A"}',
		});
		expect(query.status).toBe(400);
	});
});

describe("the client's email one-time PIN calls", () => {
	it("signs in with the mailed code, and refuses a wrong one as invalid credentials", async () => {
		const { clientWith, mailer, ada } = await world();
		const client = clientWith();
		await client.startOtp("Ada@Harbour.test ");
		await mailed();
		const code = mailer.lastCodeFor("ada@harbour.test") ?? "";
		expect(code).toMatch(/^[0-9]{6}$/);
		const wrong = code === "000000" ? "111111" : "000000";
		expect(authenticationFailureOf(await refusal(client.verifyOtp("ada@harbour.test", wrong)))).toBe("invalid");
		const session = await client.verifyOtp("ada@harbour.test", code);
		expect(session.token).toMatch(/^hbs_/);
		expect(session.user.id).toBe(ada.id);
	});

	it("starts the same for a stranger, who gets no mail", async () => {
		const { clientWith, mailer } = await world();
		await clientWith().startOtp("stranger@elsewhere.test");
		await mailed();
		expect(mailer.sent).toEqual([]);
	});

	it("reads a 429 as exhausted with the seconds to wait, a bad email as invalid and no answer as unavailable", async () => {
		const limited = createIdentityClient({
			baseUrl: ORIGIN,
			fetch: async () =>
				Response.json(
					{ error: { code: "exhausted", message: "Too many sign-in requests" } },
					{ status: 429, headers: { "retry-after": "120" } },
				),
		});
		const exhausted = await refusal(limited.startOtp("ada@harbour.test"));
		expect(isHarbourError(exhausted, "exhausted")).toBe(true);
		expect((exhausted as { details?: unknown }).details).toEqual({ retryAfterSeconds: 120 });

		const { clientWith } = await world();
		expect(isHarbourError(await refusal(clientWith().startOtp("not an email")), "invalid")).toBe(true);

		const offline = createIdentityClient({
			baseUrl: ORIGIN,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		expect(isHarbourError(await refusal(offline.me()), "unavailable")).toBe(true);
	});
});
