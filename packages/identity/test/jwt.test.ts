import { authenticationFailureOf, type ExternalIdentity, isHarbourError } from "@harbour/contracts";
import { cloudflareAccessIssuer, cloudflareAccessProvider, oidcProvider } from "@harbour/identity/jwt";
import { createMockAccess, createMockIdp } from "@harbour/identity/testing";
import { ManualClock } from "@harbour/testing/harness";
import { type CryptoKey, exportSPKI, importJWK, SignJWT, UnsecuredJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttpIdp } from "./http-idp.ts";

const ISSUER = "https://idp.harbour.test";
const AUDIENCE = "harbour-console";

const pathOf = (input: Parameters<typeof fetch>[0]) => new URL(input instanceof Request ? input.url : input).pathname;

/** A fetch that records the paths it passes on. */
function counting(inner: typeof fetch) {
	const paths: string[] = [];
	const counted: typeof fetch = async (input, init) => {
		paths.push(pathOf(input));
		return inner(input, init);
	};
	return { fetch: counted, paths, count: (path: string) => paths.filter((seen) => seen === path).length };
}

/** How `verify` rejected, having checked the error never carries the token. */
async function rejection(verify: Promise<ExternalIdentity>, token: string) {
	try {
		await verify;
	} catch (error) {
		expect(error instanceof Error ? error.message : String(error)).not.toContain(token);
		expect(JSON.stringify(error)).not.toContain(token);
		return { failure: authenticationFailureOf(error), unavailable: isHarbourError(error, "unavailable") };
	}
	throw new Error("expected the provider to reject");
}

function oidcSetup(options: { algorithm?: "RS256" | "ES256" } = {}) {
	const clock = new ManualClock();
	const idp = createMockIdp({ issuer: ISSUER, audience: AUDIENCE, clock, ...options });
	const network = counting(idp.fetch);
	const provider = oidcProvider({ issuer: ISSUER, audience: AUDIENCE, fetch: network.fetch, clock });
	return { clock, idp, network, provider };
}

describe("oidcProvider", () => {
	it("verifies a token with discovery's keys and maps its claims", async () => {
		const { idp, provider, network } = oidcSetup();
		const token = await idp.sign({ sub: "alice", email: "alice@example.com", email_verified: true, name: "Alice" });
		expect(await provider.verify(token)).toEqual({
			issuer: ISSUER,
			subject: "alice",
			email: "alice@example.com",
			emailVerified: true,
			name: "Alice",
		});
		await provider.verify(token);
		expect(network.paths).toEqual(["/.well-known/openid-configuration", "/.well-known/jwks.json"]);
	});

	it('reads email_verified true or "true" as verified, and anything else as not', async () => {
		const { idp, provider } = oidcSetup();
		const verified = async (email_verified: unknown) =>
			(await provider.verify(await idp.sign({ email: "a@example.com", email_verified }))).emailVerified;
		expect(await verified(true)).toBe(true);
		expect(await verified("true")).toBe(true);
		expect(await verified(false)).toBe(false);
		expect(await verified("yes")).toBe(false);
		expect(await verified(undefined)).toBe(false);
	});

	it("accepts ES256 by default, and only the algorithms it is configured with", async () => {
		const { idp, provider, clock } = oidcSetup({ algorithm: "ES256" });
		expect((await provider.verify(await idp.sign({ sub: "es" }))).subject).toBe("es");
		const rsaOnly = oidcProvider({
			issuer: ISSUER,
			audience: AUDIENCE,
			algorithms: ["RS256"],
			fetch: idp.fetch,
			clock,
		});
		const token = await idp.sign({ sub: "es" });
		expect((await rejection(rsaOnly.verify(token), token)).failure).toBe("invalid");
	});

	it("refuses to be configured with none or HMAC algorithms", () => {
		for (const algorithms of [["none"], ["HS256"], ["RS256", "HS512"], []]) {
			expect(() => oidcProvider({ issuer: ISSUER, audience: AUDIENCE, algorithms }), algorithms.join()).toThrow(
				/algorithms/,
			);
		}
	});

	it("rejects a wrong issuer, a wrong audience and a missing subject", async () => {
		const { idp, provider } = oidcSetup();
		for (const claims of [
			{ iss: "https://evil.test" },
			{ iss: `${ISSUER}/` },
			{ iss: undefined },
			{ aud: "another-client" },
			{ aud: ["another-client", "third"] },
			{ aud: undefined },
			{ sub: undefined },
			{ sub: "" },
		]) {
			const token = await idp.sign(claims);
			expect((await rejection(provider.verify(token), token)).failure, JSON.stringify(claims)).toBe("invalid");
		}
		const token = await idp.sign({ aud: ["another-client", AUDIENCE] });
		expect((await provider.verify(token)).subject).toBe("user-1");
	});

	it("rejects an expired token, a token not yet valid and a token without exp", async () => {
		const { idp, provider, clock } = oidcSetup();
		const expiring = await idp.sign({}, { expiresInSeconds: 60 });
		expect((await provider.verify(expiring)).subject).toBe("user-1");
		clock.advance(60_000);
		expect((await rejection(provider.verify(expiring), expiring)).failure).toBe("invalid");

		const later = await idp.sign({ nbf: Math.floor(clock.now() / 1000) + 120 });
		expect((await rejection(provider.verify(later), later)).failure).toBe("invalid");
		clock.advance(120_000);
		expect((await provider.verify(later)).subject).toBe("user-1");

		const forever = await idp.sign({ exp: undefined });
		expect((await rejection(provider.verify(forever), forever)).failure).toBe("invalid");
	});

	it("allows the configured clock skew and no more", async () => {
		const { idp, clock } = oidcSetup();
		const tolerant = oidcProvider({
			issuer: ISSUER,
			audience: AUDIENCE,
			fetch: idp.fetch,
			clock,
			clockToleranceSeconds: 30,
		});
		const token = await idp.sign({}, { expiresInSeconds: 10 });
		clock.advance(30_000);
		expect((await tolerant.verify(token)).subject).toBe("user-1");
		clock.advance(11_000);
		expect((await rejection(tolerant.verify(token), token)).failure).toBe("invalid");
	});

	it("rejects a bad signature: a token signed by another key under the same kid", async () => {
		const { idp, provider } = oidcSetup();
		await provider.verify(await idp.sign());
		const [published] = idp.jwks().keys;
		const impostor = createMockIdp({ issuer: ISSUER, audience: AUDIENCE, clock: new ManualClock() });
		const token = await impostor.sign({}, { kid: published?.kid as string });
		expect((await rejection(provider.verify(token), token)).failure).toBe("invalid");
	});

	it("rejects alg none, and HS256 signed with the provider's public key (key confusion)", async () => {
		const { idp, provider, clock } = oidcSetup();
		const now = Math.floor(clock.now() / 1000);
		const claims = { iss: ISSUER, aud: AUDIENCE, sub: "user-1", iat: now, exp: now + 300 };
		await provider.verify(await idp.sign());

		const unsigned = new UnsecuredJWT(claims).encode();
		expect((await rejection(provider.verify(unsigned), unsigned)).failure).toBe("invalid");

		const [published] = idp.jwks().keys;
		if (published === undefined) throw new Error("expected a published key");
		const pem = await exportSPKI((await importJWK(published, "RS256")) as CryptoKey);
		for (const secret of [new TextEncoder().encode(pem), new TextEncoder().encode(JSON.stringify(published))]) {
			const confused = await new SignJWT(claims)
				.setProtectedHeader({ alg: "HS256", kid: published.kid as string })
				.sign(secret);
			expect((await rejection(provider.verify(confused), confused)).failure).toBe("invalid");
		}
		expect((await rejection(provider.verify("not.a.jwt"), "not.a.jwt")).failure).toBe("invalid");
	});

	it("refetches keys once for an unknown kid after rotation, and not again within the cooldown", async () => {
		const { idp, provider, network, clock } = oidcSetup();
		await provider.verify(await idp.sign());
		expect(network.count("/.well-known/jwks.json")).toBe(1);

		await idp.rotate();
		clock.advance(31_000);
		const rotated = await idp.sign({ sub: "after-rotation" });
		expect((await provider.verify(rotated)).subject).toBe("after-rotation");
		expect(network.count("/.well-known/jwks.json")).toBe(2);

		for (const kid of ["unknown-1", "unknown-2", "unknown-3"]) {
			const token = await idp.sign({}, { kid });
			expect((await rejection(provider.verify(token), token)).failure).toBe("invalid");
		}
		expect(network.count("/.well-known/jwks.json")).toBe(2);

		clock.advance(30_000);
		const token = await idp.sign({}, { kid: "unknown-4" });
		expect((await rejection(provider.verify(token), token)).failure).toBe("invalid");
		expect(network.count("/.well-known/jwks.json")).toBe(3);
		expect(network.count("/.well-known/openid-configuration")).toBe(1);
	});

	it("keeps keys for ten minutes, then refetches and drops the keys the provider removed", async () => {
		const { idp, provider, network, clock } = oidcSetup();
		const old = await idp.sign({}, { expiresInSeconds: 3600 });
		await provider.verify(old);
		await idp.rotate();
		idp.removeOld();
		clock.advance(10 * 60 * 1000 - 1);
		await provider.verify(old);
		expect(network.count("/.well-known/jwks.json")).toBe(1);
		clock.advance(1);
		expect((await rejection(provider.verify(old), old)).failure).toBe("invalid");
		expect(network.count("/.well-known/jwks.json")).toBe(2);
	});

	it("rejects discovery that names another issuer, as unavailable", async () => {
		const clock = new ManualClock();
		const idp = createMockIdp({ issuer: ISSUER, audience: AUDIENCE, clock });
		const lying = oidcProvider({
			issuer: ISSUER,
			audience: AUDIENCE,
			clock,
			fetch: async (input, init) => {
				const response = await idp.fetch(input, init);
				if (pathOf(input) !== "/.well-known/openid-configuration") return response;
				return Response.json({ ...((await response.json()) as object), issuer: "https://evil.test" });
			},
		});
		const token = await idp.sign();
		expect(await rejection(lying.verify(token), token)).toEqual({ failure: undefined, unavailable: true });
	});

	it("treats a JWKS endpoint that is down as unavailable, not an authentication failure", async () => {
		const clock = new ManualClock();
		const idp = createMockIdp({ issuer: ISSUER, audience: AUDIENCE, clock });
		const token = await idp.sign();
		const outages: (typeof fetch)[] = [
			async () => new Response("Bad gateway", { status: 502 }),
			async () => {
				throw new TypeError("fetch failed");
			},
			async () => new Response("<html>", { status: 200 }),
			async () => Response.json({ keys: "none" }),
		];
		for (const outage of outages) {
			const down = oidcProvider({
				issuer: ISSUER,
				audience: AUDIENCE,
				jwksUri: `${ISSUER}/.well-known/jwks.json`,
				fetch: outage,
				clock,
			});
			expect(await rejection(down.verify(token), token)).toEqual({ failure: undefined, unavailable: true });
		}
	});

	it("fetches at most once per cooldown while the provider is down, cold or stale, and recovers after it", async () => {
		const clock = new ManualClock();
		const idp = createMockIdp({ issuer: ISSUER, audience: AUDIENCE, clock });
		let up = false;
		const network = counting(async (input, init) =>
			up ? idp.fetch(input, init) : new Response("Bad gateway", { status: 502 }),
		);
		const provider = oidcProvider({ issuer: ISSUER, audience: AUDIENCE, fetch: network.fetch, clock });
		const token = await idp.sign({}, { expiresInSeconds: 3600 });

		// Cold: nothing cached, discovery down.
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(await rejection(provider.verify(token), token)).toEqual({ failure: undefined, unavailable: true });
		}
		const concurrent = await Promise.all(Array.from({ length: 5 }, () => rejection(provider.verify(token), token)));
		expect(concurrent.every((result) => result.unavailable)).toBe(true);
		expect(network.paths).toHaveLength(1);

		clock.advance(30_000);
		up = true;
		expect((await provider.verify(token)).subject).toBe("user-1");
		const afterRecovery = network.paths.length;

		// Stale: keys expire while the provider is down.
		up = false;
		clock.advance(10 * 60 * 1000);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(await rejection(provider.verify(token), token)).toEqual({ failure: undefined, unavailable: true });
		}
		expect(network.paths.length).toBe(afterRecovery + 1);
		clock.advance(30_000);
		up = true;
		expect((await provider.verify(token)).subject).toBe("user-1");
	});

	it("treats a published key that will not import as unavailable, not a bad token", async () => {
		const clock = new ManualClock();
		const idp = createMockIdp({ issuer: ISSUER, audience: AUDIENCE, clock });
		const token = await idp.sign();
		const broken = oidcProvider({
			issuer: ISSUER,
			audience: AUDIENCE,
			jwksUri: `${ISSUER}/.well-known/jwks.json`,
			clock,
			fetch: async () =>
				Response.json({
					keys: idp.jwks().keys.map((key) => {
						const { n: _n, ...rest } = key as { n?: string };
						return rest;
					}),
				}),
		});
		expect(await rejection(broken.verify(token), token)).toEqual({ failure: undefined, unavailable: true });
	});

	it("uses jwksUri without discovery when given", async () => {
		const { idp, clock } = oidcSetup();
		const network = counting(idp.fetch);
		const direct = oidcProvider({
			issuer: ISSUER,
			audience: AUDIENCE,
			jwksUri: `${ISSUER}/.well-known/jwks.json`,
			fetch: network.fetch,
			clock,
		});
		await direct.verify(await idp.sign());
		expect(network.paths).toEqual(["/.well-known/jwks.json"]);
	});

	it("reads a bearer token that is not an API key", () => {
		const { provider } = oidcSetup();
		const request = (authorization?: string) =>
			new Request("https://harbour.test", authorization === undefined ? {} : { headers: { authorization } });
		expect(provider.token(request("Bearer eyJ.a.b"))).toBe("eyJ.a.b");
		expect(provider.token(request("Bearer hbr_secret"))).toBeUndefined();
		expect(provider.token(request())).toBeUndefined();
	});
});

describe("oidcProvider against a local HTTP identity provider", () => {
	const clock = new ManualClock();
	let http: Awaited<ReturnType<typeof startHttpIdp>>;

	beforeAll(async () => {
		http = await startHttpIdp({ audience: AUDIENCE, clock });
	});

	afterAll(async () => {
		await http.close();
	});

	it("discovers keys over HTTP with the global fetch and verifies a token", async () => {
		const { idp } = http;
		const provider = oidcProvider({ issuer: idp.issuer, audience: AUDIENCE, clock });
		const token = await idp.sign({ sub: "over-http", email: "h@example.com", email_verified: "true" });
		expect(await provider.verify(token)).toEqual({
			issuer: idp.issuer,
			subject: "over-http",
			email: "h@example.com",
			emailVerified: true,
		});
		expect(http.served).toEqual(["/.well-known/openid-configuration", "/.well-known/jwks.json"]);
	});
});

describe("cloudflareAccessProvider", () => {
	const TEAM = "harbour.cloudflareaccess.com";
	const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

	function accessSetup() {
		const clock = new ManualClock();
		const access = createMockAccess({ teamDomain: TEAM, audience: AUD, clock });
		const network = counting(access.fetch);
		const provider = cloudflareAccessProvider({ teamDomain: TEAM, audience: AUD, fetch: network.fetch, clock });
		return { clock, access, network, provider };
	}

	it("normalises the team domain into the issuer", () => {
		for (const teamDomain of [TEAM, `https://${TEAM}`, `https://${TEAM}/`, ` ${TEAM}/ `, `http://${TEAM}`]) {
			expect(cloudflareAccessIssuer(teamDomain), teamDomain).toBe(`https://${TEAM}`);
		}
		expect(() => cloudflareAccessIssuer("")).toThrow();
		expect(() => cloudflareAccessIssuer(`https://${TEAM}/path`)).toThrow();
	});

	it("verifies an Access token with the team's certs, its email verified", async () => {
		const { access, provider, network } = accessSetup();
		const token = await access.sign({ sub: "7335d417", email: "alice@example.com", type: "app" });
		expect(await provider.verify(token)).toEqual({
			issuer: `https://${TEAM}`,
			subject: "7335d417",
			email: "alice@example.com",
			emailVerified: true,
		});
		expect(network.paths).toEqual(["/cdn-cgi/access/certs"]);
	});

	it("reads only the Cf-Access-Jwt-Assertion header", () => {
		const { provider } = accessSetup();
		const request = (headers: Record<string, string>) => new Request("https://harbour.test", { headers });
		expect(provider.token(request({ "cf-access-jwt-assertion": "a.b.c" }))).toBe("a.b.c");
		expect(provider.token(request({ authorization: "Bearer a.b.c" }))).toBeUndefined();
		expect(provider.token(request({ cookie: "CF_Authorization=a.b.c" }))).toBeUndefined();
	});

	it("rejects a service token, a wrong issuer, a wrong AUD tag, a missing exp and any algorithm but RS256", async () => {
		const { access, provider } = accessSetup();
		const cases = [
			access.sign({ sub: "", common_name: "abc.access", type: "app" }),
			access.sign({ sub: undefined, common_name: "abc.access" }),
			access.sign({ sub: "u", email: "" }),
			access.sign({ sub: "u", email: "a@example.com", iss: "https://other.cloudflareaccess.com" }),
			access.sign({ sub: "u", email: "a@example.com", aud: ["another-application"] }),
			access.sign({ sub: "u", email: "a@example.com", exp: undefined }),
			access.sign({ sub: "u", email: "a@example.com" }, { algorithm: "ES256" }),
		];
		for (const [index, pending] of cases.entries()) {
			const token = await pending;
			expect((await rejection(provider.verify(token), token)).failure, `case ${index}`).toBe("invalid");
		}
	});

	it("treats certs that cannot be fetched as unavailable", async () => {
		const clock = new ManualClock();
		const access = createMockAccess({ teamDomain: TEAM, audience: AUD, clock });
		const provider = cloudflareAccessProvider({
			teamDomain: TEAM,
			audience: AUD,
			clock,
			fetch: async () => new Response("Service unavailable", { status: 503 }),
		});
		const token = await access.sign({ email: "a@example.com" });
		expect(await rejection(provider.verify(token), token)).toEqual({ failure: undefined, unavailable: true });
	});
});
