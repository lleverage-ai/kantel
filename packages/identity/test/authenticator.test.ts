import {
	authenticationFailureOf,
	type CallContext,
	callContextFor,
	isHarbourError,
	systemContext,
} from "@harbour/contracts";
import {
	authenticationFailureResponse,
	createAuthenticator,
	withAuthentication,
} from "@harbour/identity/authenticator";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { ManualClock } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

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
				name: "HarbourError",
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
			expect(isHarbourError(refused, "forbidden")).toBe(true);
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
