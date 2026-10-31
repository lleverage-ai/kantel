// The API keys flow against the real thing: the identity routes' handler and client over an in-memory directory, with
// people signed in through the email one-time PIN routes. No server, no DOM: the page renders what the flow says.

import { type CallContext, type HeldRole, KantelError } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createIdentityClient, createIdentityHandler } from "@kantel/identity/http";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createEmailOtp, createMemoryOtpStores, kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { describe, expect, it } from "vitest";
import {
	type ApiKeysApi,
	administeredProjects,
	apiKeysProblem,
	createApiKeysFlow,
	draftRequest,
	expiryText,
	keyCreatesProjects,
	keyScope,
	lastUsedText,
	mayIssueOrganisationKeys,
	rolesForScope,
	sortKeys,
} from "./api-keys-model.ts";

const bootstrap: CallContext = { actor: { kind: "system", component: "test" }, organisationId: "bootstrap" };
const ORIGIN = "https://harbour.test";
const DAY = 86_400_000;

/** Ada administers the organisation; Lin operates on Website. Each gets the page's API over the real routes. */
async function world() {
	let at = Date.UTC(2026, 9, 28, 9, 0);
	const clock = { now: () => at };
	const identity = createMemoryIdentity({ clock });
	const ada = await identity.createUser(bootstrap, { name: "Ada", email: "ada@harbour.test" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Kantel",
		admin: { kind: "user", userId: ada.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: organisation.id };
	const website = await identity.createProject(admin, { name: "Website" });
	const lin = await identity.createUser(admin, { name: "Lin", email: "lin@harbour.test" });
	await identity.grantRole(admin, {
		principal: { kind: "user", userId: lin.id },
		role: "operator",
		projectId: website.id,
	});

	const stores = createMemoryOtpStores();
	const mailer = new MemoryOtpMailer();
	const sending: Promise<unknown>[] = [];
	const otp = createOtpHandler({
		otp: createEmailOtp({ identity, ...stores, mailer, clock, defer: (work) => sending.push(work) }),
	});
	const routes = createIdentityHandler({
		identity,
		authenticator: createAuthenticator({ identity, providers: [kantelSessionProvider({ ...stores, clock })] }),
		clock,
	});
	const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/auth/") ? otp(request) : routes(request);
	};
	const clientAs = (token?: string) =>
		createIdentityClient({
			baseUrl: ORIGIN,
			fetch: serve,
			headers: (): Record<string, string> => (token === undefined ? {} : { authorization: `Bearer ${token}` }),
		});
	const signIn = async (email: string) => {
		await clientAs().startOtp(email);
		await Promise.all(sending);
		const { token } = await clientAs().verifyOtp(email, mailer.lastCodeFor(email) ?? "");
		const client = clientAs(token);
		const api: ApiKeysApi = {
			list: () => client.listApiKeys(),
			create: (input) => client.createApiKey(input),
			revoke: (keyId) => client.revokeApiKey(keyId),
		};
		return { client, api, me: await client.me() };
	};
	const projects = [{ id: website.id, name: "Website" }];
	return { clock, advance: (ms: number) => (at += ms), serve, signIn, projects, website };
}

describe("the API keys flow", () => {
	it("issues a key, shows its secret until Done and never again, then revokes it so its next call is refused", async () => {
		const { clock, signIn, projects, serve } = await world();
		const ada = await signIn("ada@harbour.test");
		const flow = createApiKeysFlow({ api: ada.api, projects: () => projects, now: clock.now });
		await flow.load();
		expect(flow.getState()).toMatchObject({ keys: [], loading: false });

		flow.openCreate();
		flow.editDraft({ name: " CI runner ", role: "viewer", expiry: "30d" });
		await flow.create();
		const { issued, keys, draft } = flow.getState();
		expect(draft).toBeUndefined();
		expect(issued?.key).toMatchObject({ name: "CI runner", role: "viewer", expiresAt: clock.now() + 30 * DAY });
		const secret = issued?.secret ?? "";
		expect(secret).toMatch(/^hbr_/);
		expect(keys?.map((key) => key.name)).toEqual(["CI runner"]);

		// The list read after issuing has no secret in it; Done drops the only copy.
		await flow.load();
		expect(JSON.stringify(flow.getState().keys)).not.toContain(secret);
		flow.dismissSecret();
		expect(JSON.stringify(flow.getState())).not.toContain(secret);

		const call = () => serve(`${ORIGIN}/v1/me`, { headers: { authorization: `Bearer ${secret}` } });
		expect((await call()).status).toBe(200);
		const keyId = issued?.key.id ?? "";
		flow.askRevoke(keyId);
		expect(flow.getState().confirming).toBe(keyId);
		await flow.revoke();
		expect(flow.getState().confirming).toBeUndefined();
		expect(flow.getState().keys?.[0]?.revokedAt).toBe(clock.now());
		expect((await call()).status).toBe(401);
	});

	it("shows an operator who is not an admin no keys and no project to issue for, and a refused create as forbidden", async () => {
		const { clock, signIn, projects, website } = await world();
		const lin = await signIn("lin@harbour.test");
		expect(lin.me.roles).toEqual([{ projectId: website.id, role: "operator" }]);
		expect(administeredProjects(projects, lin.me.roles)).toEqual([]);

		const flow = createApiKeysFlow({ api: lin.api, projects: () => projects, now: clock.now });
		await flow.load();
		expect(flow.getState()).toMatchObject({ keys: [], loading: false });
		expect(flow.getState().loadProblem).toBeUndefined();

		// The page offers no form here; were one sent anyway, the directory refuses it and the flow says why.
		flow.openCreate(website.id);
		flow.editDraft({ name: "Lin's bot" });
		await flow.create();
		expect(flow.getState().draft).toMatchObject({ busy: false, problem: { kind: "forbidden" } });
		expect(flow.getState().issued).toBeUndefined();
	});

	it("reads a viewer's refusal as forbidden, a lost session as signed out, and keeps the form on a failure", async () => {
		const { clock, projects } = await world();
		const refuse = (error: unknown): ApiKeysApi => ({
			list: () => Promise.reject(error),
			create: () => Promise.reject(error),
			revoke: () => Promise.reject(error),
		});
		const viewer = createApiKeysFlow({
			api: refuse(new KantelError("forbidden", "API keys need the operator role or stronger")),
			projects: () => projects,
			now: clock.now,
		});
		await viewer.load();
		expect(viewer.getState().loadProblem).toEqual({ kind: "forbidden" });

		const gone = createApiKeysFlow({
			api: refuse(new KantelError("forbidden", "x", { authentication: "invalid" })),
			projects: () => projects,
			now: clock.now,
		});
		gone.openCreate();
		gone.editDraft({ name: "App" });
		await gone.create();
		expect(gone.getState().draft).toMatchObject({ name: "App", problem: { kind: "signed-out" } });

		const down = createApiKeysFlow({
			api: refuse(new Error("network")),
			projects: () => projects,
			now: clock.now,
			initial: { keys: [], loading: false, confirming: "key_x" },
		});
		await down.revoke();
		expect(down.getState()).toMatchObject({
			confirming: "key_x",
			revokeProblem: { keyId: "key_x", problem: { kind: "unavailable" } },
		});
	});

	it("issues an organisation key that creates projects, lowering a stronger role to operator", async () => {
		const { clock, signIn, projects, serve } = await world();
		const ada = await signIn("ada@harbour.test");
		expect(mayIssueOrganisationKeys(ada.me.roles)).toBe(true);
		const flow = createApiKeysFlow({ api: ada.api, projects: () => projects, now: clock.now });
		await flow.load();
		flow.openCreate();
		flow.editDraft({ name: "Lleverage", role: "admin" });
		flow.editDraft({ scope: "organisation", createProjects: true });
		expect(flow.getState().draft?.role).toBe("operator");
		await flow.create();
		const issued = flow.getState().issued;
		expect(issued?.key).toMatchObject({ scope: "organisation", projectIds: [], role: "operator" });
		expect(keyCreatesProjects(issued?.key ?? {})).toBe(true);

		const created = await serve(`${ORIGIN}/v1/projects`, {
			method: "POST",
			headers: { authorization: `Bearer ${issued?.secret}`, "content-type": "application/json" },
			body: JSON.stringify({ name: "Customer 42" }),
		});
		expect(created.status).toBe(201);
	});

	it("opens an organisation key's form when there is no project to pick", () => {
		const flow = createApiKeysFlow({
			api: { list: async () => [], create: () => Promise.reject(new Error("unused")), revoke: async () => undefined },
			projects: () => [],
		});
		flow.openCreate();
		expect(flow.getState().draft).toMatchObject({ scope: "organisation", projectId: "" });
	});

	it("does not send a draft without a name", async () => {
		const { clock, projects } = await world();
		let calls = 0;
		const flow = createApiKeysFlow({
			api: {
				list: async () => [],
				create: () => {
					calls += 1;
					return Promise.reject(new Error("unreachable"));
				},
				revoke: async () => undefined,
			},
			projects: () => projects,
			now: clock.now,
		});
		flow.openCreate();
		await flow.create();
		expect(flow.getState().draft?.nameError).toBe("Name the key after what will use it.");
		expect(calls).toBe(0);
	});
});

describe("the API keys helpers", () => {
	const projects = [
		{ id: "a", name: "A" },
		{ id: "b", name: "B" },
	];

	it("finds the projects a caller may issue keys for from its roles", () => {
		const roles = (held: HeldRole[]) => administeredProjects(projects, held);
		expect(roles([{ role: "admin" }])).toEqual(projects);
		expect(roles([{ role: "operator" }, { projectId: "b", role: "admin" }])).toEqual([projects[1]]);
		expect(roles([{ role: "operator" }])).toEqual([]);
		expect(administeredProjects(projects, undefined)).toEqual(projects);
	});

	it("says who may issue organisation keys, which roles they hold, and what a key covers", () => {
		expect(mayIssueOrganisationKeys([{ role: "admin" }])).toBe(true);
		expect(mayIssueOrganisationKeys([{ role: "operator" }, { projectId: "a", role: "admin" }])).toBe(false);
		expect(mayIssueOrganisationKeys(undefined)).toBe(true);
		expect(rolesForScope("organisation", ["viewer", "operator", "admin"])).toEqual(["viewer", "operator"]);
		expect(rolesForScope("projects", ["viewer", "operator", "admin"])).toEqual(["viewer", "operator", "admin"]);
		expect(keyScope({})).toBe("projects");
		expect(keyScope({ scope: "organisation" })).toBe("organisation");
		expect(keyCreatesProjects({ permissions: ["import"] })).toBe(false);
	});

	it("builds an organisation key's request with no projects, capped at operator", () => {
		const draft = {
			name: "Host",
			scope: "organisation",
			projectId: "a",
			role: "admin",
			expiry: "never",
			createProjects: true,
		} as const;
		expect(draftRequest(draft, 0)).toEqual({
			request: { name: "Host", scope: "organisation", role: "operator", permissions: ["create_projects"] },
		});
		expect(draftRequest({ ...draft, role: "viewer", createProjects: false }, 0)).toEqual({
			request: { name: "Host", scope: "organisation", role: "viewer" },
		});
	});

	it("builds a request from a draft, with an expiry from now", () => {
		const draft = {
			name: " App ",
			scope: "projects",
			projectId: "a",
			role: "operator",
			expiry: "90d",
			createProjects: false,
		} as const;
		expect(draftRequest(draft, 1_000)).toEqual({
			request: { name: "App", projectIds: ["a"], role: "operator", expiresAt: 1_000 + 90 * DAY },
		});
		expect(draftRequest({ ...draft, expiry: "never" }, 0)).toEqual({
			request: { name: "App", projectIds: ["a"], role: "operator" },
		});
		expect(draftRequest({ ...draft, name: "x".repeat(101) }, 0)).toEqual({
			nameError: "Keep the name to 100 characters.",
		});
	});

	it("words expiry and last use, and sorts active keys before ended ones", () => {
		const now = 10 * DAY;
		expect(expiryText({}, now)).toBe("No expiry");
		expect(expiryText({ expiresAt: now + 3 * DAY + 5 }, now)).toBe("Expires in 3d");
		expect(expiryText({ expiresAt: now + 2 * 3_600_000 }, now)).toBe("Expires in 2h");
		expect(expiryText({ expiresAt: now - DAY }, now)).toBe("Expired 1d ago");
		expect(lastUsedText({}, now)).toBe("Never used");
		const key = (id: string, createdAt: number, rest = {}) => ({
			id,
			serviceId: "s",
			organisationId: "o",
			projectIds: ["a"],
			role: "viewer" as const,
			prefix: "hbr_x",
			createdAt,
			...rest,
		});
		const { active, ended } = sortKeys(
			[key("old", 1), key("new", 2), key("gone", 3, { revokedAt: 4 }), key("over", 4, { expiresAt: now })],
			now,
		);
		expect(active.map((k) => k.id)).toEqual(["new", "old"]);
		expect(ended.map((k) => k.id)).toEqual(["over", "gone"]);
	});

	it("maps errors to what the page says", () => {
		expect(apiKeysProblem(new KantelError("not_found", "x"))).toEqual({ kind: "not-found" });
		expect(apiKeysProblem(new KantelError("invalid", "name is at most 100 characters"))).toEqual({
			kind: "invalid",
			message: "name is at most 100 characters",
		});
		expect(apiKeysProblem(new TypeError("fetch failed"))).toEqual({ kind: "unavailable" });
	});
});
