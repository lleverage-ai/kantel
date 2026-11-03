import {
	API_KEYS_PATH,
	apiKeyRevokePath,
	authenticationFailureOf,
	type CallContext,
	type CreateApiKeyResponse,
	isKantelError,
	ORGANISATION_HEADER,
} from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import {
	API_KEY_BODY_LIMIT,
	createIdentityClient,
	createIdentityHandler,
	type IdentityClient,
} from "@kantel/identity/http";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createTestSignIn } from "@kantel/identity/testing/github";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };
const ORIGIN = "http://kantel.test";
const DAY = 86_400_000;

/**
 * One organisation with two projects. Ada administers the organisation; Lin operates on Website and administers
 * nothing; Grace views Billing; Max administers Website only. A host app's key (made by Ada) operates on Website.
 */
async function world() {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const identity = createMemoryIdentity({ clock, audit });
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: "ada@kantel.test" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Kantel",
		admin: { kind: "user", userId: ada.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: organisation.id };
	const website = await identity.createProject(admin, { name: "Website" });
	const billing = await identity.createProject(admin, { name: "Billing" });
	const member = async (name: string, email: string, role: "viewer" | "operator" | "admin", projectId: string) => {
		const user = await identity.createUser(admin, { name, email });
		await identity.grantRole(admin, { principal: { kind: "user", userId: user.id }, role, projectId });
		return user;
	};
	await member("Lin Operator", "lin@kantel.test", "operator", website.id);
	await member("Grace Hopper", "grace@kantel.test", "viewer", billing.id);
	await member("Max Admin", "max@kantel.test", "admin", website.id);
	const service = await identity.createServiceIdentity(admin, { name: "Atlas" });
	const hostKey = await identity.issueApiKey(admin, {
		serviceId: service.id,
		projectIds: [website.id],
		role: "operator",
		name: "Atlas",
	});

	const signInRoutes = createTestSignIn({ identity, clock });
	const authenticator = createAuthenticator({ identity, providers: [signInRoutes.sessionProvider] });
	const identityHandler = createIdentityHandler({ identity, authenticator, clock });
	const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/api/auth/")
			? signInRoutes.handler(request)
			: identityHandler(request);
	};
	const clientWith = (headers: Record<string, string> = {}): IdentityClient =>
		createIdentityClient({ baseUrl: ORIGIN, fetch: serve, headers: () => headers });

	/** A signed-in person's bearer header and client. */
	const signIn = async (email: string) => {
		const token = await signInRoutes.tokenFor(email);
		const headers = { authorization: `Bearer ${token}` };
		return { headers, client: clientWith(headers) };
	};

	/** A raw call to the key routes, as `headers`. */
	const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
		const { json, ...rest } = init;
		return serve(`${ORIGIN}${path}`, {
			...rest,
			...(json === undefined
				? {}
				: { body: JSON.stringify(json), headers: { "content-type": "application/json", ...rest.headers } }),
		});
	};

	/** How many service identities have been made, by their audit events. */
	const services = () => audit.events.filter((event) => event.type === "identity.service.created").length;

	return {
		identity,
		clock,
		audit,
		admin,
		website,
		billing,
		service,
		hostKey,
		serve,
		clientWith,
		signIn,
		call,
		services,
	};
}

type ErrorBody = { readonly error: { readonly code: string; readonly message: string } };

/** A failed response's error body. */
const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error;

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to be refused");
}

describe("the key routes' gate", () => {
	it("is 401 for an anonymous caller on every key route, and never reads the body", async () => {
		const { call, hostKey } = await world();
		for (const response of [
			await call(API_KEYS_PATH),
			await call(API_KEYS_PATH, { method: "POST", json: { name: "x", projectIds: ["p"], role: "viewer" } }),
			await call(apiKeyRevokePath(hostKey.key.id), { method: "POST", json: {} }),
		]) {
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toBe(`Bearer realm="kantel"`);
			expect((await errorOf(response)).code).toBe("unauthenticated");
		}
	});

	it("is 403 for a viewer, as a role refusal rather than an authentication failure", async () => {
		const { signIn, call, hostKey } = await world();
		const grace = await signIn("grace@kantel.test");
		const listed = await call(API_KEYS_PATH, { headers: grace.headers });
		expect(listed.status).toBe(403);
		expect(await listed.json()).toEqual({
			error: { code: "forbidden", message: "API keys need the operator role or stronger" },
		});
		const revoked = await call(apiKeyRevokePath(hostKey.key.id), { method: "POST", headers: grace.headers, json: {} });
		expect(revoked.status).toBe(403);

		const error = await refusal(grace.client.listApiKeys());
		expect(isKantelError(error, "forbidden")).toBe(true);
		expect(authenticationFailureOf(error)).toBeUndefined();
	});

	it("is 403 with the organisation failure for an organisation the person may not act in", async () => {
		const { signIn, clientWith } = await world();
		const ada = await signIn("ada@kantel.test");
		const error = await refusal(clientWith({ ...ada.headers, [ORGANISATION_HEADER]: "org_elsewhere" }).listApiKeys());
		expect(authenticationFailureOf(error)).toBe("organisation");
	});

	it("lets a host app's operator key through the gate; the directory then shows it no key it does not administer", async () => {
		const { clientWith, hostKey } = await world();
		const host = clientWith({ authorization: `Bearer ${hostKey.secret}` });
		expect(await host.listApiKeys()).toEqual([]);
	});
});

describe("an operator who is not an admin", () => {
	it("lists no keys, and is refused each create and revoke with forbidden, leaving nothing behind", async () => {
		const { signIn, call, website, hostKey, identity, admin, services } = await world();
		const lin = await signIn("lin@kantel.test");
		expect(await lin.client.listApiKeys()).toEqual([]);

		const before = services();
		const created = await call(API_KEYS_PATH, {
			method: "POST",
			headers: lin.headers,
			json: { name: "Lin's bot", projectIds: [website.id], role: "viewer" },
		});
		expect(created.status).toBe(403);
		expect(await created.json()).toEqual({ error: { code: "forbidden", message: "needs admin on the organisation" } });
		expect(services()).toBe(before);

		const withService = await refusal(
			lin.client.createApiKey({
				name: "Lin's bot",
				projectIds: [website.id],
				role: "viewer",
				serviceId: hostKey.key.serviceId,
			}),
		);
		expect(isKantelError(withService, "forbidden")).toBe(true);
		expect((withService as Error).message).toBe("needs admin on the project");

		const revoked = await call(apiKeyRevokePath(hostKey.key.id), { method: "POST", headers: lin.headers, json: {} });
		expect(revoked.status).toBe(403);
		expect(await errorOf(revoked)).toEqual({ code: "forbidden", message: "needs admin on the project" });
		expect((await identity.listApiKeys(admin)).find((key) => key.id === hostKey.key.id)?.revokedAt).toBeUndefined();
	});
});

describe("an admin managing keys", () => {
	it("creates a key, sees its secret once, lists it without the secret, revokes it, and the key is refused on its next use", async () => {
		const { signIn, call, clientWith, website, clock, audit } = await world();
		const ada = await signIn("ada@kantel.test");

		const response = await call(API_KEYS_PATH, {
			method: "POST",
			headers: ada.headers,
			json: { name: "  GitHub app ", projectIds: [website.id, website.id], role: "operator" },
		});
		expect(response.status).toBe(201);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const issued = (await response.json()) as CreateApiKeyResponse;
		expect(issued.secret).toMatch(/^ktk_/);
		expect(issued.key).toMatchObject({
			name: "GitHub app",
			projectIds: [website.id],
			role: "operator",
			prefix: issued.secret.slice(0, 12),
			createdAt: clock.now(),
		});
		expect(issued.key).not.toHaveProperty("secret");
		expect(issued.key).not.toHaveProperty("lastUsedAt");

		// The key works, and its use is listed.
		const app = clientWith({ authorization: `Bearer ${issued.secret}` });
		expect((await app.me()).actor).toMatchObject({ kind: "service", keyId: issued.key.id });
		const listing = await call(API_KEYS_PATH, { headers: ada.headers });
		const text = await listing.text();
		expect(listing.status).toBe(200);
		expect(text).not.toContain(issued.secret);
		expect(text).not.toContain("secret");
		const listed = JSON.parse(text).items.find((key: { id: string }) => key.id === issued.key.id);
		expect(listed).toEqual({ ...issued.key, lastUsedAt: clock.now() });

		// Revoked: 204, and the key's very next call is a 401.
		clock.advance(1_000);
		const revoked = await call(apiKeyRevokePath(issued.key.id), { method: "POST", headers: ada.headers, json: {} });
		expect(revoked.status).toBe(204);
		expect(await revoked.text()).toBe("");
		expect(authenticationFailureOf(await refusal(app.me()))).toBe("invalid");
		expect(authenticationFailureOf(await refusal(app.listApiKeys()))).toBe("invalid");
		expect((await ada.client.listApiKeys()).find((key) => key.id === issued.key.id)?.revokedAt).toBe(clock.now());

		// Revoking again is fine; nothing the server said after creation or wrote to audit holds the secret.
		await ada.client.revokeApiKey(issued.key.id);
		expect(JSON.stringify(await ada.client.listApiKeys())).not.toContain(issued.secret);
		expect(JSON.stringify(audit.events)).not.toContain(issued.secret);
	});

	it("gives the client the same: a secret on create only, the list, a filtered list, and revoke", async () => {
		const { signIn, website, billing, service, clock } = await world();
		const ada = await signIn("ada@kantel.test");
		const issued = await ada.client.createApiKey({
			name: "Nightly",
			projectIds: [website.id, billing.id],
			role: "viewer",
			expiresAt: clock.now() + 30 * DAY,
		});
		expect(issued.key.expiresAt).toBe(clock.now() + 30 * DAY);
		const onService = await ada.client.createApiKey({
			name: "Atlas again",
			projectIds: [website.id],
			role: "operator",
			serviceId: service.id,
		});
		expect(onService.key.serviceId).toBe(service.id);

		const all = await ada.client.listApiKeys();
		expect(all.map((key) => key.name)).toEqual(["Atlas", "Nightly", "Atlas again"]);
		expect(JSON.stringify(all)).not.toContain(issued.secret);
		expect((await ada.client.listApiKeys({ serviceId: service.id })).map((key) => key.name)).toEqual([
			"Atlas",
			"Atlas again",
		]);
		await ada.client.revokeApiKey(onService.key.id);
		expect((await ada.client.listApiKeys({ serviceId: service.id })).at(-1)?.revokedAt).toBe(clock.now());
	});

	it("a key that expires is refused from then on", async () => {
		const { signIn, clientWith, website, clock } = await world();
		const ada = await signIn("ada@kantel.test");
		const issued = await ada.client.createApiKey({
			name: "Short",
			projectIds: [website.id],
			role: "viewer",
			expiresAt: clock.now() + DAY,
		});
		const app = clientWith({ authorization: `Bearer ${issued.secret}` });
		await app.me();
		clock.advance(DAY);
		expect(authenticationFailureOf(await refusal(app.me()))).toBe("invalid");
	});

	it("lets a project admin issue keys for an existing service on its project, but not mint a new service", async () => {
		const { signIn, website, billing, service, services } = await world();
		const max = await signIn("max@kantel.test");
		expect((await max.client.listApiKeys()).map((key) => key.name)).toEqual(["Atlas"]);
		const issued = await max.client.createApiKey({
			name: "Website deploys",
			projectIds: [website.id],
			role: "viewer",
			serviceId: service.id,
		});
		expect(issued.key.projectIds).toEqual([website.id]);
		const before = services();
		expect(
			isKantelError(
				await refusal(max.client.createApiKey({ name: "New app", projectIds: [website.id], role: "viewer" })),
				"forbidden",
			),
		).toBe(true);
		expect(
			isKantelError(
				await refusal(
					max.client.createApiKey({ name: "Billing", projectIds: [billing.id], role: "viewer", serviceId: service.id }),
				),
				"forbidden",
			),
		).toBe(true);
		expect(services()).toBe(before);
	});

	it("lets an organisation admin issue a key with the import permission, and no project admin", async () => {
		const { signIn, identity, website, service, services } = await world();
		const ada = await signIn("ada@kantel.test");
		const issued = await ada.client.createApiKey({
			name: "Atlas import",
			projectIds: [website.id],
			role: "operator",
			permissions: ["import"],
		});
		expect(issued.key.permissions).toEqual(["import"]);
		expect((await ada.client.listApiKeys()).find((key) => key.id === issued.key.id)?.permissions).toEqual(["import"]);
		const { actor, organisationId } = await identity.authenticateApiKey(bootstrap, issued.secret);
		expect(await identity.keyPermits(bootstrap, actor, organisationId, "import")).toBe(true);

		const max = await signIn("max@kantel.test");
		const before = services();
		for (const input of [
			{ name: "Website import", projectIds: [website.id], role: "operator" as const, permissions: ["import" as const] },
			{
				name: "Website import",
				projectIds: [website.id],
				role: "operator" as const,
				serviceId: service.id,
				permissions: ["import" as const],
			},
		]) {
			expect(isKantelError(await refusal(max.client.createApiKey(input)), "forbidden")).toBe(true);
		}
		expect(services()).toBe(before);
	});

	it("lets an organisation admin issue an organisation key, listed with its scope, and nobody else", async () => {
		const { signIn, identity, website, services, audit, clientWith } = await world();
		const ada = await signIn("ada@kantel.test");
		const issued = await ada.client.createApiKey({
			name: "Host app",
			scope: "organisation",
			role: "operator",
			permissions: ["create_projects"],
		});
		expect(issued.key).toMatchObject({ scope: "organisation", projectIds: [], role: "operator" });
		expect((await ada.client.listApiKeys()).find((key) => key.id === issued.key.id)?.scope).toBe("organisation");
		const auth = await identity.authenticateApiKey(bootstrap, issued.secret);
		expect(auth.scope).toBe("organisation");
		expect(audit.ofType("identity.key.issued").at(-1)?.data).toMatchObject({
			scope: "organisation",
			role: "operator",
			permissions: ["create_projects"],
		});

		// Capped at operator, refused before a service is made for it.
		const before = services();
		const admin = await refusal(ada.client.createApiKey({ name: "Too strong", scope: "organisation", role: "admin" }));
		expect(isKantelError(admin, "invalid")).toBe(true);
		const projectWide = await refusal(
			ada.client.createApiKey({
				name: "x",
				projectIds: [website.id],
				role: "operator",
				permissions: ["create_projects"],
			}),
		);
		expect(isKantelError(projectWide, "invalid")).toBe(true);

		// A project admin, and any key, are refused one; the project admin doesn't see it.
		const max = await signIn("max@kantel.test");
		const orgKey = { name: "Mine", scope: "organisation" as const, role: "viewer" as const };
		expect(isKantelError(await refusal(max.client.createApiKey(orgKey)), "forbidden")).toBe(true);
		const asKey = clientWith({ authorization: `Bearer ${issued.secret}` });
		expect(isKantelError(await refusal(asKey.createApiKey(orgKey)), "forbidden")).toBe(true);
		expect(services()).toBe(before);
		expect((await max.client.listApiKeys()).some((key) => key.id === issued.key.id)).toBe(false);
		expect(isKantelError(await refusal(max.client.revokeApiKey(issued.key.id)), "forbidden")).toBe(true);
		await ada.client.revokeApiKey(issued.key.id);
		expect(audit.ofType("identity.key.revoked").at(-1)?.data).toMatchObject({
			scope: "organisation",
			role: "operator",
			projectIds: [],
		});
	});
});

describe("the key routes' requests", () => {
	it("refuses malformed creates as invalid, naming what is wrong", async () => {
		const { signIn, call, website, clock } = await world();
		const ada = await signIn("ada@kantel.test");
		const create = async (json: unknown) => {
			const response = await call(API_KEYS_PATH, { method: "POST", headers: ada.headers, json });
			return { status: response.status, error: await errorOf(response) };
		};
		const good = { name: "App", projectIds: [website.id], role: "viewer" };
		expect(await create({ ...good, name: " " })).toEqual({
			status: 400,
			error: { code: "invalid", message: "name must be a non-empty string" },
		});
		expect((await create({ ...good, name: "x".repeat(101) })).error.message).toBe("name is at most 100 characters");
		expect((await create({ ...good, projectIds: [] })).error.message).toBe("projectIds must list 1 to 100 project IDs");
		expect((await create({ ...good, projectIds: [7] })).status).toBe(400);
		expect((await create({ ...good, role: "owner" })).error.message).toBe("role must be viewer, operator or admin");
		expect((await create({ ...good, expiresAt: clock.now() })).error.message).toBe("expiresAt must be in the future");
		expect((await create({ ...good, expiresAt: "soon" })).status).toBe(400);
		expect((await create({ ...good, serviceId: "" })).status).toBe(400);
		expect((await create({ ...good, permissions: ["admin"] })).error.message).toBe(
			"permissions must list only import, create_projects",
		);
		expect((await create({ ...good, scope: "everywhere" })).error.message).toBe(
			"scope must be projects or organisation",
		);
		expect((await create({ ...good, scope: "organisation" })).error.message).toBe(
			"An organisation key names no projects: leave projectIds out",
		);
		expect((await create({ ...good, scope: "projects", projectIds: undefined })).error.message).toBe(
			"projectIds must list 1 to 100 project IDs",
		);
		expect((await create({ ...good, permissions: "import" })).status).toBe(400);
		expect((await create({ ...good, secret: "ktk_mine" })).error.message).toBe("Unknown field secret");
		expect((await create([good])).status).toBe(400);
		expect((await create({ ...good, projectIds: ["prj_nowhere"] })).status).toBe(404);
	});

	it("needs JSON for a POST, refuses a body past the limit, and takes {} to revoke", async () => {
		const { signIn, call, hostKey, website } = await world();
		const ada = await signIn("ada@kantel.test");
		const form = await call(API_KEYS_PATH, {
			method: "POST",
			headers: { ...ada.headers, "content-type": "application/x-www-form-urlencoded" },
			body: "name=App",
		});
		expect(form.status).toBe(415);
		const huge = await call(API_KEYS_PATH, {
			method: "POST",
			headers: ada.headers,
			json: { name: "App", projectIds: [website.id], role: "viewer", pad: "x".repeat(API_KEY_BODY_LIMIT) },
		});
		expect(huge.status).toBe(400);
		expect((await errorOf(huge)).message).toBe("The body is too large");
		const notJson = await call(API_KEYS_PATH, {
			method: "POST",
			headers: { ...ada.headers, "content-type": "application/json" },
			body: "{",
		});
		expect(notJson.status).toBe(400);
		const withBody = await call(apiKeyRevokePath(hostKey.key.id), {
			method: "POST",
			headers: ada.headers,
			json: { reason: "x" },
		});
		expect(withBody.status).toBe(400);
		const empty = await call(apiKeyRevokePath(hostKey.key.id), {
			method: "POST",
			headers: { ...ada.headers, "content-type": "application/json" },
		});
		expect(empty.status).toBe(204);
	});

	it("is 404 for an unknown key or path, 405 for another method, and refuses an unknown list parameter", async () => {
		const { signIn, call } = await world();
		const ada = await signIn("ada@kantel.test");
		expect(
			(await call(apiKeyRevokePath("key_nowhere"), { method: "POST", headers: ada.headers, json: {} })).status,
		).toBe(404);
		expect((await call(`${API_KEYS_PATH}/key_x`, { headers: ada.headers })).status).toBe(404);
		expect((await call(`${API_KEYS_PATH}/a/b/revoke`, { method: "POST", headers: ada.headers })).status).toBe(404);
		const put = await call(API_KEYS_PATH, { method: "PUT", headers: ada.headers });
		expect(put.status).toBe(405);
		expect(put.headers.get("allow")).toBe("GET, POST");
		expect((await call(apiKeyRevokePath("key_x"), { headers: ada.headers })).headers.get("allow")).toBe("POST");
		expect((await call(`${API_KEYS_PATH}?limit=5`, { headers: ada.headers })).status).toBe(400);
	});
});
