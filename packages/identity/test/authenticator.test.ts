import {
	authenticationFailureOf,
	type CallContext,
	callContextFor,
	isKantelError,
	systemContext,
} from "@kantel/contracts";
import { authenticationFailureResponse, createAuthenticator, withAuthentication } from "@kantel/identity/authenticator";
import { cloudflareAccessProvider, oidcProvider } from "@kantel/identity/jwt";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createMockAccess, createMockIdp } from "@kantel/identity/testing";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { ManualClock } from "@kantel/testing/harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttpIdp } from "./http-idp.ts";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };

async function tenant(clock = new ManualClock()) {
	const identity = createMemoryIdentity({ clock });
	const founder = await identity.createUser(bootstrap, { name: "Founder" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Org",
		admin: { kind: "user", userId: founder.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: founder.id }, organisationId: organisation.id };
	const alpha = await identity.createProject(admin, { name: "alpha" });
	const beta = await identity.createProject(admin, { name: "beta" });
	const service = await identity.createServiceIdentity(admin, { name: "Sal's supervisor" });
	return { identity, organisation, admin, alpha, beta, service, clock };
}

const request = (headers: Record<string, string>) => new Request("https://harbour.test/v1/sessions", { headers });

async function failureOf(operation: Promise<unknown>) {
	try {
		await operation;
	} catch (error) {
		return authenticationFailureOf(error);
	}
	throw new Error("expected the authenticator to reject");
}

describe("createAuthenticator with API keys", () => {
	it("resolves a key to its service, key, organisation, projects and role", async () => {
		const { identity, organisation, admin, alpha, service } = await tenant();
		const issued = await identity.issueApiKey(admin, {
			serviceId: service.id,
			projectIds: [alpha.id],
			role: "operator",
		});
		const caller = await createAuthenticator({ identity }).authenticate(
			request({ authorization: `Bearer ${issued.secret}` }),
		);
		expect(caller).toEqual({
			method: "api_key",
			actor: { kind: "service", serviceId: service.id, keyId: issued.key.id },
			organisationId: organisation.id,
			projectIds: [alpha.id],
			role: "operator",
		});
		expect(callContextFor(caller, { projectId: alpha.id, requestId: "r1" })).toEqual({
			actor: caller.actor,
			organisationId: organisation.id,
			projectId: alpha.id,
			requestId: "r1",
		});
	});

	it("tells missing credentials from invalid ones, and never says which keys exist", async () => {
		const { identity, admin, alpha, service, clock } = await tenant();
		const authenticator = createAuthenticator({ identity });
		const revoked = await identity.issueApiKey(admin, {
			serviceId: service.id,
			projectIds: [alpha.id],
			role: "viewer",
		});
		await identity.revokeApiKey(admin, revoked.key.id);
		const expiring = await identity.issueApiKey(admin, {
			serviceId: service.id,
			projectIds: [alpha.id],
			role: "viewer",
			expiresAt: clock.now() + 1000,
		});
		clock.advance(1000);

		expect(await failureOf(authenticator.authenticate(request({})))).toBe("missing");
		expect(await failureOf(authenticator.authenticate(request({ authorization: "  " })))).toBe("missing");
		for (const authorization of [
			"Basic dXNlcjpwYXNz",
			"Bearer",
			"Bearer a b",
			"Bearer hbr_unknown",
			"Bearer not-a-key",
			`Bearer ${revoked.secret}`,
			`Bearer ${expiring.secret}`,
		]) {
			expect(await failureOf(authenticator.authenticate(request({ authorization }))), authorization).toBe("invalid");
		}
	});

	it("passes on errors that are not about the credentials", async () => {
		const authenticator = createAuthenticator({
			identity: {
				async authenticateApiKey() {
					throw new Error("database down");
				},
			},
		});
		await expect(authenticator.authenticate(request({ authorization: "Bearer hbr_x" }))).rejects.toThrow(
			"database down",
		);
	});
});

const AUDIENCE = "harbour-console";
const TEAM = "harbour.cloudflareaccess.com";
const AUD_TAG = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

type HttpIdp = Awaited<ReturnType<typeof startHttpIdp>> & { readonly clock: ManualClock };

/** A tenant with Alice invited by email, the local OIDC provider over HTTP and a mock Access team, all on one clock. */
async function signInSetup(http: HttpIdp) {
	const setup = await tenant(http.clock);
	const alice = await setup.identity.createUser(setup.admin, { name: "Alice", email: "Alice@Example.com" });
	const { idp } = http;
	const access = createMockAccess({ teamDomain: TEAM, audience: AUD_TAG, clock: setup.clock });
	const oidc = oidcProvider({ issuer: idp.issuer, audience: AUDIENCE, clock: setup.clock });
	const cloudflare = cloudflareAccessProvider({
		teamDomain: TEAM,
		audience: AUD_TAG,
		fetch: access.fetch,
		clock: setup.clock,
	});
	return { ...setup, alice, idp, access, oidc, cloudflare };
}

describe("createAuthenticator with sign-in providers", () => {
	let http: HttpIdp;

	beforeAll(async () => {
		const clock = new ManualClock();
		http = { ...(await startHttpIdp({ audience: AUDIENCE, clock })), clock };
	});

	afterAll(async () => {
		await http.close();
	});

	it("signs an invited user in with an OIDC token: the first sign-in links by verified email, the next by subject", async () => {
		const { identity, organisation, admin, alice, idp, oidc } = await signInSetup(http);
		const authenticator = createAuthenticator({ identity, providers: [oidc] });

		const first = await idp.sign({ sub: "oidc-alice", email: "alice@example.com", email_verified: true });
		expect(await authenticator.authenticate(request({ authorization: `Bearer ${first}` }))).toEqual({
			method: "oidc",
			actor: { kind: "human", userId: alice.id },
			organisationId: organisation.id,
		});
		expect((await identity.getUser(admin, alice.id)).externalSubject).toBe(`${idp.issuer} oidc-alice`);

		const second = await idp.sign({ sub: "oidc-alice" });
		const caller = await authenticator.authenticate(request({ authorization: `Bearer ${second}` }));
		expect(caller.actor).toEqual({ kind: "human", userId: alice.id });
		expect(callContextFor(caller)).toEqual({ actor: caller.actor, organisationId: organisation.id });
	});

	it("signs an invited user in with a Cloudflare Access token, linking once and then by subject", async () => {
		const { identity, organisation, admin, alice, access, cloudflare } = await signInSetup(http);
		const authenticator = createAuthenticator({ identity, providers: [cloudflare] });

		for (const claims of [
			{ sub: "cf-alice", email: "alice@example.com" },
			{ sub: "cf-alice", email: "alias@example.com" },
		]) {
			const token = await access.sign(claims);
			expect(await authenticator.authenticate(request({ "cf-access-jwt-assertion": token }))).toEqual({
				method: "cloudflare_access",
				actor: { kind: "human", userId: alice.id },
				organisationId: organisation.id,
			});
		}
		expect((await identity.getUser(admin, alice.id)).externalSubject).toBe(`https://${TEAM} cf-alice`);
	});

	it("refuses a stranger, an unverified email, a service token and tokens that do not verify, as invalid", async () => {
		const { identity, idp, access, oidc, cloudflare, clock } = await signInSetup(http);
		const authenticator = createAuthenticator({ identity, providers: [oidc, cloudflare] });
		const bearer = async (claims: Record<string, unknown>, options?: { expiresInSeconds?: number }) => ({
			authorization: `Bearer ${await idp.sign(claims, options)}`,
		});
		const assertion = async (claims: Record<string, unknown>) => ({
			"cf-access-jwt-assertion": await access.sign(claims),
		});
		const expired = await bearer(
			{ sub: "x", email: "alice@example.com", email_verified: true },
			{ expiresInSeconds: 1 },
		);
		const cases = [
			await bearer({ sub: "stranger", email: "stranger@example.com", email_verified: true }),
			await bearer({ sub: "unverified", email: "alice@example.com", email_verified: false }),
			await bearer({ sub: "wrong-audience", email: "alice@example.com", email_verified: true, aud: "other" }),
			await assertion({ sub: "", common_name: "host.access" }),
			await assertion({ sub: "cf-stranger", email: "stranger@example.com" }),
		];
		clock.advance(1000);
		for (const [index, headers] of [...cases, expired].entries()) {
			expect(await failureOf(authenticator.authenticate(request(headers))), `case ${index}`).toBe("invalid");
		}
	});

	it("selects the organisation: a named one the user is in, or their only one", async () => {
		const { identity, organisation, alice, idp, oidc } = await signInSetup(http);
		const authenticator = createAuthenticator({ identity, providers: [oidc] });
		const token = await idp.sign({ sub: "org-alice", email: "alice@example.com", email_verified: true });
		const signIn = (headers: Record<string, string> = {}) =>
			authenticator.authenticate(request({ authorization: `Bearer ${token}`, ...headers }));

		expect((await signIn()).organisationId).toBe(organisation.id);
		expect((await signIn({ "harbour-organisation": organisation.id })).organisationId).toBe(organisation.id);
		expect(await failureOf(signIn({ "harbour-organisation": "org_elsewhere" }))).toBe("organisation");

		const other = await identity.createOrganisation(bootstrap, {
			name: "Other",
			admin: { kind: "user", userId: alice.id },
		});
		expect(await failureOf(signIn())).toBe("organisation");
		expect((await signIn({ "harbour-organisation": other.id })).organisationId).toBe(other.id);
		expect((await signIn({ "harbour-organisation": organisation.id })).organisationId).toBe(organisation.id);
	});

	it("still takes API keys, and reads each credential with its own provider when both are configured", async () => {
		const { identity, organisation, admin, alpha, service, alice, idp, access, oidc, cloudflare } =
			await signInSetup(http);
		const authenticator = createAuthenticator({ identity, providers: [cloudflare, oidc] });
		const issued = await identity.issueApiKey(admin, { serviceId: service.id, projectIds: [alpha.id], role: "viewer" });

		const key = await authenticator.authenticate(request({ authorization: `Bearer ${issued.secret}` }));
		expect(key).toMatchObject({ method: "api_key", actor: { kind: "service", serviceId: service.id } });
		// A host app behind Access carries an Access service token as well: its API key still decides.
		const serviceToken = await access.sign({ sub: "", common_name: "host" });
		const behindAccess = await authenticator.authenticate(
			request({ authorization: `Bearer ${issued.secret}`, "cf-access-jwt-assertion": serviceToken }),
		);
		expect(behindAccess).toMatchObject({ method: "api_key", actor: { kind: "service", serviceId: service.id } });

		const viaOidc = await idp.sign({ sub: "both-oidc", email: "alice@example.com", email_verified: true });
		expect(await authenticator.authenticate(request({ authorization: `Bearer ${viaOidc}` }))).toEqual({
			method: "oidc",
			actor: { kind: "human", userId: alice.id },
			organisationId: organisation.id,
		});

		// Alice is linked to her OIDC subject now, so an Access token with her email would not match her; Bob uses Access.
		const bob = await identity.createUser(admin, { name: "Bob", email: "bob@example.com" });
		const viaAccess = await access.sign({ sub: "both-cf", email: "bob@example.com" });
		expect(await authenticator.authenticate(request({ "cf-access-jwt-assertion": viaAccess }))).toEqual({
			method: "cloudflare_access",
			actor: { kind: "human", userId: bob.id },
			organisationId: organisation.id,
		});

		expect(await failureOf(authenticator.authenticate(request({})))).toBe("missing");
		expect(await failureOf(authenticator.authenticate(request({ authorization: "Bearer hbr_unknown" })))).toBe(
			"invalid",
		);
	});

	it("picks between OIDC providers by the token's issuer", async () => {
		const { identity, alice, idp, oidc, clock } = await signInSetup(http);
		const second = createMockIdp({ issuer: "https://login.second.test", audience: AUDIENCE, clock });
		const secondProvider = oidcProvider({ issuer: second.issuer, audience: AUDIENCE, fetch: second.fetch, clock });
		const authenticator = createAuthenticator({ identity, providers: [oidc, secondProvider] });

		const fromSecond = await second.sign({ sub: "second-alice", email: "alice@example.com", email_verified: true });
		const caller = await authenticator.authenticate(request({ authorization: `Bearer ${fromSecond}` }));
		expect(caller).toMatchObject({ method: "oidc", actor: { kind: "human", userId: alice.id } });

		const fromFirst = await idp.sign({ sub: "first-alice" });
		const unknownIssuer = await second.sign({ iss: "https://nobody.test" });
		expect(await failureOf(authenticator.authenticate(request({ authorization: `Bearer ${fromFirst}` })))).toBe(
			"invalid",
		);
		for (const token of [unknownIssuer, "not-a-jwt"]) {
			expect(await failureOf(authenticator.authenticate(request({ authorization: `Bearer ${token}` })))).toBe(
				"invalid",
			);
		}
	});

	it("treats a bearer JWT as invalid without an OIDC provider, and ignores an Access header without an Access provider", async () => {
		const { identity, idp, access } = await signInSetup(http);
		const keysOnly = createAuthenticator({ identity });
		const token = await idp.sign({ sub: "x" });
		expect(await failureOf(keysOnly.authenticate(request({ authorization: `Bearer ${token}` })))).toBe("invalid");
		const assertion = await access.sign({ sub: "x", email: "alice@example.com" });
		expect(await failureOf(keysOnly.authenticate(request({ "cf-access-jwt-assertion": assertion })))).toBe("missing");
	});

	it("needs signIn to take providers, and passes on errors that are not about the credentials", async () => {
		const { idp, oidc } = await signInSetup(http);
		expect(() =>
			createAuthenticator({
				identity: {
					async authenticateApiKey() {
						throw new Error("unused");
					},
				},
				providers: [oidc],
			}),
		).toThrow(/signIn/);

		const authenticator = createAuthenticator({
			identity: {
				async authenticateApiKey() {
					throw new Error("unused");
				},
				async signIn() {
					throw new Error("database down");
				},
			},
			providers: [oidc],
		});
		const token = await idp.sign({ sub: "x" });
		await expect(authenticator.authenticate(request({ authorization: `Bearer ${token}` }))).rejects.toThrow(
			"database down",
		);
	});

	it("passes on an identity provider that is down as unavailable, not a 401", async () => {
		const { identity, idp } = await signInSetup(http);
		const down = oidcProvider({
			issuer: idp.issuer,
			audience: AUDIENCE,
			clock: http.clock,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		const handler = withAuthentication(createAuthenticator({ identity, providers: [down] }), () => new Response("ok"));
		const token = await idp.sign({ sub: "x" });
		let thrown: unknown;
		try {
			await handler(request({ authorization: `Bearer ${token}` }));
		} catch (error) {
			thrown = error;
		}
		expect(isKantelError(thrown, "unavailable")).toBe(true);
		expect(String((thrown as Error).message)).not.toContain(token);
	});

	it("never echoes a token in an error or a response body", async () => {
		const { identity, idp, access, oidc, cloudflare } = await signInSetup(http);
		const authenticator = createAuthenticator({ identity, providers: [oidc, cloudflare] });
		const handler = withAuthentication(authenticator, (_request, caller) => Response.json({ actor: caller.actor }));
		const tokens: Record<string, string>[] = [
			{ authorization: `Bearer ${await idp.sign({ sub: "stranger", email: "s@example.com", email_verified: true })}` },
			{ authorization: `Bearer ${await idp.sign({ sub: "y" }, { kid: "unknown" })}` },
			{ authorization: `Bearer ${await idp.sign({ aud: "other" })}` },
			{ "cf-access-jwt-assertion": await access.sign({ sub: "", common_name: "host" }) },
			{
				authorization: `Bearer ${await idp.sign({ sub: "alice", email: "alice@example.com", email_verified: true })}`,
				"harbour-organisation": "org_elsewhere",
			},
		];
		for (const headers of tokens) {
			const token = headers.authorization?.slice("Bearer ".length) ?? headers["cf-access-jwt-assertion"] ?? "";
			expect(token).not.toBe("");
			try {
				await authenticator.authenticate(request(headers));
			} catch (error) {
				expect((error as Error).message).not.toContain(token);
				expect(JSON.stringify(error)).not.toContain(token);
			}
			const response = await handler(request(headers));
			expect([401, 403]).toContain(response.status);
			const body = await response.text();
			expect(body).not.toContain(token);
			expect(body).not.toContain(token.split(".")[2] ?? token);
		}
	});
});

describe("withAuthentication", () => {
	it("calls the handler with the caller, and answers 401 with a challenge otherwise, never echoing the credential", async () => {
		const { identity, admin, alpha, service } = await tenant();
		const issued = await identity.issueApiKey(admin, { serviceId: service.id, projectIds: [alpha.id], role: "viewer" });
		const handler = withAuthentication(createAuthenticator({ identity }), async (_request, caller) =>
			Response.json({ actor: caller.actor }),
		);

		const ok = await handler(request({ authorization: `Bearer ${issued.secret}` }));
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ actor: { kind: "service", serviceId: service.id, keyId: issued.key.id } });

		const missing = await handler(request({}));
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toBe(`Bearer realm="harbour"`);
		expect(await missing.json()).toMatchObject({ error: { code: "unauthenticated", failure: "missing" } });

		const wrong = `${issued.secret.slice(0, -2)}xx`;
		const invalid = await handler(request({ authorization: `Bearer ${wrong}` }));
		expect(invalid.status).toBe(401);
		const body = await invalid.text();
		expect(body).toContain('"failure":"invalid"');
		expect(body).not.toContain(wrong);
	});

	it("maps an organisation failure to 403 and leaves other errors alone", () => {
		const response = authenticationFailureResponse(
			Object.assign(new Error("x"), {
				name: "KantelError",
				code: "forbidden",
				details: { authentication: "organisation" },
			}),
		);
		expect(response?.status).toBe(403);
		expect(response?.headers.get("www-authenticate")).toBeNull();
		expect(authenticationFailureResponse(new Error("boom"))).toBeUndefined();
	});
});

describe("M1-BE7 definition of done: a host key scoped to one project", () => {
	it("cannot read another project's sessions, by ID or in a list, though its service could", async () => {
		const { identity, organisation, admin, alpha, beta, service } = await tenant();
		const { models } = createScriptedModel();
		const memory = createMemoryRuntime({ models, identity });
		try {
			// The service holds operator across the whole organisation; its key is still limited to alpha.
			await identity.grantRole(admin, { principal: { kind: "service", serviceId: service.id }, role: "operator" });
			const issued = await identity.issueApiKey(admin, {
				serviceId: service.id,
				projectIds: [alpha.id],
				role: "operator",
			});
			const system = { ...systemContext("test"), organisationId: organisation.id };
			await memory.profiles.put(system, {
				id: "worker",
				organisationId: organisation.id,
				name: "Worker",
				model: { route: "default" },
				promptLayers: [],
				tools: [],
				skills: [],
				sandbox: { tiers: ["isolate"] },
				memoryScopes: [],
			});
			const inAlpha = await memory.runtime.create(system, { projectId: alpha.id, agentId: "worker" });
			const inBeta = await memory.runtime.create(system, { projectId: beta.id, agentId: "worker" });

			const caller = await createAuthenticator({ identity }).authenticate(
				request({ authorization: `Bearer ${issued.secret}` }),
			);
			const ctx = callContextFor(caller);

			expect((await memory.directory.get(callContextFor(caller, { projectId: alpha.id }), inAlpha.id)).id).toBe(
				inAlpha.id,
			);
			let refused: unknown;
			try {
				await memory.directory.get(callContextFor(caller, { projectId: beta.id }), inBeta.id);
			} catch (error) {
				refused = error;
			}
			expect(isKantelError(refused, "forbidden")).toBe(true);
			const listed = await memory.directory.list(ctx);
			expect(listed.items.map((session) => session.id)).toEqual([inAlpha.id]);
			await expect(memory.runtime.create(ctx, { projectId: beta.id, agentId: "worker" })).rejects.toMatchObject({
				code: "forbidden",
			});
		} finally {
			await memory.close();
		}
	});
});
