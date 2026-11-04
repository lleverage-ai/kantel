// The compute plane on the self-hosted gateway, through its fetch handler: the super-admin's key drives a sandbox
// through the SDK, makes a scoped key that works, and the gateway's own routes and keys are as they were.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type CallContext, EMAIL_OTP_ISSUER, type Role } from "@kantel/contracts";
import { createMemoryRelayStore } from "@kantel/hosts/relay-store";
import { createMemoryHostStore } from "@kantel/hosts/store";
import { createTunnelTickets } from "@kantel/hosts/tunnel";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { hashSessionToken, kantelSessionProvider } from "@kantel/identity/otp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import {
	computeConfig,
	DEFAULT_HOST_IMAGES,
	gatewayCompute,
	gatewayHosts,
	gatewayRelay,
	hostImages,
} from "../../src/gateway/compute.ts";
import { createGateway } from "../../src/gateway/gateway.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function serve(on: boolean, superAdminKey?: string) {
	const components = createGatewayComponents();
	cleanups.push(() => components.close());
	const seeded = await bootstrap(components, { organisation: "Compute", project: "compute" });
	const authenticator = createAuthenticator({
		identity: components.identity,
		providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
	});
	const compute = on
		? await gatewayCompute({
				authenticator,
				identity: components.identity,
				...(superAdminKey === undefined ? {} : { superAdminKey }),
			})
		: undefined;
	if (compute !== undefined) cleanups.push(() => compute.close());
	const gateway = createGateway({
		components,
		authenticator,
		...(compute === undefined ? {} : { compute: compute.api }),
	});
	cleanups.push(() => gateway.close());
	const client = (token: string) =>
		createKantelClient({
			baseUrl: "http://gateway.test/v1",
			token,
			fetch: (input, init) => gateway.fetch(new Request(input, init)),
		});
	/** A person with `role` across the organisation, signed in with a Kantel session: their bearer token. */
	const person = async (name: string, role: Role) => {
		const system: CallContext = { actor: { kind: "system", component: "test" }, organisationId: seeded.organisationId };
		const email = `${name}@kantel.example.com`;
		const user = await components.identity.createUser(system, { name, email });
		await components.identity.grantRole(system, { principal: { kind: "user", userId: user.id }, role });
		const token = `kts_${crypto.randomUUID().replaceAll("-", "")}`;
		await components.otp.sessions.create({
			id: `s_${name}`,
			tokenHash: await hashSessionToken(token),
			userId: user.id,
			issuer: EMAIL_OTP_ISSUER,
			subject: email,
			email,
			createdAt: Date.now(),
			expiresAt: Date.now() + 3_600_000,
		});
		return token;
	};
	return { gateway, seeded, compute, client, person };
}

async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

describe("the compute plane on the gateway", () => {
	it("answers none of its routes on a gateway made without it", async () => {
		const { gateway, seeded } = await serve(false);
		const response = await gateway.fetch(
			new Request("http://gateway.test/v1/sandboxes", { headers: { authorization: `Bearer ${seeded.apiKey}` } }),
		);
		expect(response.status).toBe(404);
	});

	it("runs a sandbox with the super-admin's key, makes a scoped key, and leaves the gateway's routes alone", async () => {
		const { gateway, seeded, compute, client } = await serve(true);
		const key = compute?.superAdminKey ?? "";
		expect(key).toMatch(/^ksk_/);
		const admin = client(key);
		const caller = await admin.getCaller();
		expect(caller.superAdmin).toBe(true);

		const sandbox = await admin.createSandbox({ wait: true });
		const run = await admin.runCommand(sandbox.id, { command: "echo on the gateway" });
		expect(run.stdout).toBe("on the gateway\n");
		expect((await admin.listHosts()).items.length).toBe(1);

		const issued = await admin.createApiKey({ name: "agent", preset: "agent" });
		const agent = client(issued.secret);
		expect((await agent.listSandboxes()).items.map((item) => item.id)).toEqual([sandbox.id]);
		expect((await failure(agent.listHosts())).code).toBe("forbidden");

		// The gateway's own key isn't a compute key or a person, and its own routes still answer it.
		expect((await failure(client(seeded.apiKey).listSandboxes())).status).toBe(401);
		const me = await gateway.fetch(
			new Request("http://gateway.test/v1/me", { headers: { authorization: `Bearer ${seeded.apiKey}` } }),
		);
		expect(me.status).toBe(200);
	});

	it("makes an organisation admin who signs in the super-admin, who sees the hosts, and nobody else", async () => {
		const { client, person } = await serve(true);
		const admin = client(await person("ada", "admin"));
		expect((await admin.getCaller()).superAdmin).toBe(true);
		expect((await admin.listHosts()).items.length).toBe(1);

		const operator = client(await person("otto", "operator"));
		expect((await operator.getCaller()).superAdmin).toBe(false);
		expect((await failure(operator.listHosts())).code).toBe("forbidden");
	});

	it("lets the person an invite was made for join with its code, and nobody else (#657)", async () => {
		const { client, person } = await serve(true);
		const tom = client(await person("tom", "admin"));
		const ann = client(await person("ann", "operator"));
		const bob = client(await person("bob", "operator"));
		const org = await tom.createOrganisation({ name: "Acme" });
		// The address as someone might type it: the match ignores case.
		const invite = await tom.createInvite(org.id, { email: "Ann@Kantel.Example.com", role: "member" });
		const code = invite.code ?? "";

		const refused = await failure(bob.joinOrganisation({ code }));
		expect(refused.code).toBe("forbidden");
		expect(refused.message).toBe("The invite is for someone else");
		expect(await ann.joinOrganisation({ code })).toMatchObject({ id: org.id, role: "member" });
	});

	it("is always on: on joined hosts wherever it knows where hosts reach it, else on the stub", () => {
		expect(computeConfig({})).toEqual({});
		// The old switch is no longer read: off or on, the same.
		expect(computeConfig({ KANTEL_COMPUTE: "experimental" })).toEqual({});
		expect(computeConfig({ KANTEL_COMPUTE: "", KANTEL_PUBLIC_URL: "", KANTEL_COMPUTE_PUBLIC_URL: "" })).toEqual({});
		expect(computeConfig({ KANTEL_COMPUTE_PUBLIC_URL: "http://127.0.0.1:58090" })).toEqual({
			hosts: { publicUrl: "http://127.0.0.1:58090", images: DEFAULT_HOST_IMAGES },
		});
		expect(computeConfig({ KANTEL_COMPUTE_PUBLIC_URL: "", KANTEL_PUBLIC_URL: "https://kantel.example.com" })).toEqual({
			hosts: { publicUrl: "https://kantel.example.com", images: DEFAULT_HOST_IMAGES },
		});
		// The stand-in on request, with an address or without.
		expect(computeConfig({ KANTEL_COMPUTE_BACKEND: "stub", KANTEL_PUBLIC_URL: "https://kantel.example.com" })).toEqual(
			{},
		);
		expect(() => computeConfig({ KANTEL_COMPUTE_BACKEND: "hosts" })).toThrow(/KANTEL_PUBLIC_URL/);
		expect(() => computeConfig({ KANTEL_COMPUTE_BACKEND: "cloud" })).toThrow();
		// Warm pools are gone: an install that still sets KANTEL_COMPUTE_POOLS starts, with a warning, and keeps none.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				computeConfig({
					KANTEL_COMPUTE_BACKEND: "hosts",
					KANTEL_PUBLIC_URL: "https://kantel.example.com/",
					KANTEL_COMPUTE_POOLS: '{"microvm/default": 2}',
				}),
			).toEqual({ hosts: { publicUrl: "https://kantel.example.com", images: DEFAULT_HOST_IMAGES } });
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/KANTEL_COMPUTE_POOLS is ignored/));
		} finally {
			warn.mockRestore();
		}
	});

	it("asks hosts to update only for KANTEL_HOST_VERSION, from its GitHub Release by default", () => {
		const env = { KANTEL_COMPUTE_BACKEND: "hosts", KANTEL_PUBLIC_URL: "https://kantel.example.com" };
		expect(computeConfig(env)?.hosts?.desiredVersion).toBeUndefined();
		expect(computeConfig({ ...env, KANTEL_HOST_VERSION: "0.2.0" })?.hosts).toMatchObject({
			desiredVersion: "0.2.0",
			updateUrl: "https://github.com/lleverage-ai/kantel/releases/download/v{version}/kantel-host-{os}-{arch}",
		});
		expect(
			computeConfig({ ...env, KANTEL_HOST_VERSION: "0.2.0", KANTEL_HOST_UPDATE_URL: "https://dl.example/{version}" })
				?.hosts?.updateUrl,
		).toBe("https://dl.example/{version}");
	});

	it("points hosts at Kantel's published images unless KANTEL_COMPUTE_IMAGES says otherwise", () => {
		const env = {
			KANTEL_COMPUTE_BACKEND: "hosts",
			KANTEL_PUBLIC_URL: "https://kantel.example.com",
		};
		expect(DEFAULT_HOST_IMAGES).toMatch(
			/^https:\/\/github\.com\/lleverage-ai\/kantel\/releases\/download\/host-images-/,
		);
		expect(computeConfig(env)?.hosts?.images).toBe(DEFAULT_HOST_IMAGES);
		expect(computeConfig({ ...env, KANTEL_COMPUTE_IMAGES: "/srv/images" })?.hosts?.images).toBe("/srv/images");
		expect(computeConfig({ ...env, KANTEL_COMPUTE_IMAGES: "off" })?.hosts?.images).toBeUndefined();
	});

	it("takes a domain for exposed ports that isn't the gateway's own name or a parent of it", () => {
		const env = {
			KANTEL_COMPUTE_BACKEND: "hosts",
			KANTEL_PUBLIC_URL: "https://kantel.example.com",
		};
		expect(computeConfig({ ...env, KANTEL_COMPUTE_PORTS_DOMAIN: "*.Kantel-Ports.example." })?.hosts?.portsDomain).toBe(
			"kantel-ports.example",
		);
		for (const domain of ["kantel.example.com", "example.com", "not a domain", "-x.example"]) {
			expect(() => computeConfig({ ...env, KANTEL_COMPUTE_PORTS_DOMAIN: domain })).toThrow(
				/KANTEL_COMPUTE_PORTS_DOMAIN/,
			);
		}
		expect(computeConfig(env)?.hosts?.portsDomain).toBeUndefined();
	});

	it("lets a host register with a join token the API minted, through the gateway, with no sign-in", async () => {
		const components = createGatewayComponents();
		cleanups.push(() => components.close());
		const authenticator = createAuthenticator({
			identity: components.identity,
			providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
		});
		const config = { publicUrl: "https://kantel.example.com" };
		const service = gatewayHosts(config, createMemoryHostStore(), () => undefined);
		cleanups.push(async () => service.close());
		const relay = createMemoryRelayStore();
		const compute = await gatewayCompute({
			authenticator,
			hosts: gatewayRelay(config, service, relay),
		});
		cleanups.push(() => compute.close());
		const gateway = createGateway({
			components,
			authenticator,
			compute: compute.api,
			...(compute.hostRoutes === undefined ? {} : { computeHosts: compute.hostRoutes }),
		});
		cleanups.push(() => gateway.close());
		const admin = createKantelClient({
			baseUrl: "http://gateway.test/v1",
			token: compute.superAdminKey,
			fetch: (input, init) => gateway.fetch(new Request(input, init)),
		});
		const token = await admin.createHostJoinToken({ name: "box" });
		const register = () =>
			gateway.fetch(
				new Request("http://gateway.test/v1/hosts/register", {
					method: "POST",
					headers: { "content-type": "application/json" },
					// As kantel-host 0.1.0-dev sends it: Go's nil map is null.
					body: JSON.stringify({ token: token.token, labels: null }),
				}),
			);
		const first = await register();
		expect(first.status).toBe(201);
		const { hostId, credential } = (await first.json()) as { hostId: string; credential: string };
		expect(credential).toMatch(/^khc_/);
		expect((await register()).status).toBe(403);
		expect((await service.get(hostId)).name).toBe("box");
		const hosts = (await admin.listHosts()).items;
		expect(hosts.map((host) => [host.id, host.state])).toEqual([[hostId, "unreachable"]]);
		// The registry's own admin routes aren't served: the API's are.
		const images = await gateway.fetch(new Request("http://gateway.test/v1/hosts/images/manifest.json"));
		expect(images.status).toBe(404);

		// A desktop's page answers only a live desktop ticket the relay issued, with no sign-in.
		const tickets = createTunnelTickets(relay);
		const ticket = (port: number, desktop?: "control" | "view", expiresAt = Date.now() + 60_000, grantee?: string) =>
			tickets.issue({
				sandboxId: "sbx_1",
				port,
				expiresAt,
				...(desktop === undefined ? {} : { desktop }),
				...(grantee === undefined ? {} : { grantee }),
			});
		const view = (path: string) => gateway.fetch(new Request(`http://gateway.test/v1/hosts/desktop/${path}`));
		const bare = await view(await ticket(6080, "view"));
		expect(bare.status).toBe(308);
		// No such sandbox on any host: the ticket is good, but there is no page to check and serve.
		expect((await view(`${await ticket(6080, "control")}/`)).status).toBe(502);
		expect((await view(`${await ticket(6080)}/`)).status).toBe(404);
		expect((await view(`${await ticket(22, "control")}/`)).status).toBe(404);
		expect((await view(`${await ticket(6080, "control", Date.now() - 1)}/`)).status).toBe(404);
		const elsewhere = await createTunnelTickets(createMemoryRelayStore()).issue({
			sandboxId: "sbx_1",
			port: 6080,
			expiresAt: Date.now() + 60_000,
			desktop: "control",
		});
		expect((await view(`${elsewhere}/`)).status).toBe(404);
		// Given to a key since revoked: no page.
		const gone = JSON.stringify({ kind: "key", keyId: "key_gone" });
		expect((await view(`${await ticket(6080, "control", undefined, gone)}/`)).status).toBe(404);
		// noVNC's page is gone with its route.
		expect(
			(await gateway.fetch(new Request(`http://gateway.test/v1/hosts/view/${await ticket(5901)}`))).status,
		).not.toBe(200);
	});

	it("turns account hosts on only for KANTEL_ACCOUNT_HOSTS=experimental, with hosts", () => {
		const env = { KANTEL_COMPUTE_BACKEND: "hosts", KANTEL_PUBLIC_URL: "https://kantel.example.com" };
		expect(computeConfig(env)?.hosts?.accountHosts).toBeUndefined();
		expect(computeConfig({ ...env, KANTEL_ACCOUNT_HOSTS: "off" })?.hosts?.accountHosts).toBeUndefined();
		expect(computeConfig({ ...env, KANTEL_ACCOUNT_HOSTS: " Experimental " })?.hosts?.accountHosts).toBe(true);
		expect(() => computeConfig({ ...env, KANTEL_ACCOUNT_HOSTS: "on" })).toThrow(/KANTEL_ACCOUNT_HOSTS/);
		// On the stub there are no hosts to add: nothing to turn on.
		expect(computeConfig({ KANTEL_ACCOUNT_HOSTS: "experimental" })).toEqual({});
	});

	it("lets a signed-in person who isn't a super-admin add a host of their own, with account hosts on", async () => {
		const components = createGatewayComponents();
		cleanups.push(() => components.close());
		const seeded = await bootstrap(components, { organisation: "Compute", project: "compute" });
		const authenticator = createAuthenticator({
			identity: components.identity,
			providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
		});
		const serveWith = async (accountHosts: boolean) => {
			const config = { publicUrl: "https://kantel.example.com", ...(accountHosts ? { accountHosts } : {}) };
			const service = gatewayHosts(config, createMemoryHostStore(), () => undefined);
			cleanups.push(async () => service.close());
			const compute = await gatewayCompute({
				authenticator,
				identity: components.identity,
				hosts: gatewayRelay(config, service, createMemoryRelayStore()),
			});
			cleanups.push(() => compute.close());
			const gateway = createGateway({
				components,
				authenticator,
				compute: compute.api,
				...(compute.hostRoutes === undefined ? {} : { computeHosts: compute.hostRoutes }),
			});
			cleanups.push(() => gateway.close());
			return { gateway, service };
		};
		const system: CallContext = { actor: { kind: "system", component: "test" }, organisationId: seeded.organisationId };
		const user = await components.identity.createUser(system, { name: "otto", email: "otto@kantel.example.com" });
		await components.identity.grantRole(system, { principal: { kind: "user", userId: user.id }, role: "operator" });
		const session = `kts_${crypto.randomUUID().replaceAll("-", "")}`;
		await components.otp.sessions.create({
			id: "s_otto",
			tokenHash: await hashSessionToken(session),
			userId: user.id,
			issuer: EMAIL_OTP_ISSUER,
			subject: "otto@kantel.example.com",
			email: "otto@kantel.example.com",
			createdAt: Date.now(),
			expiresAt: Date.now() + 3_600_000,
		});
		const as = (gateway: { fetch(request: Request): Promise<Response> }) =>
			createKantelClient({
				baseUrl: "http://gateway.test/v1",
				token: session,
				fetch: (input, init) => gateway.fetch(new Request(input, init)),
			});

		// Off (the default): 501.
		const off = as((await serveWith(false)).gateway);
		const refused = await failure(off.createAccountJoinToken({}));
		expect([refused.status, refused.code]).toEqual([501, "not_supported"]);

		const { gateway, service } = await serveWith(true);
		const otto = as(gateway);
		expect((await otto.getCaller()).superAdmin).toBe(false);
		const joinToken = await otto.createAccountJoinToken({ name: "otto-box" });
		expect(joinToken.command).toContain("--url https://kantel.example.com --token kth_");
		const registered = await gateway.fetch(
			new Request("http://gateway.test/v1/hosts/register", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: joinToken.token }),
			}),
		);
		expect(registered.status).toBe(201);
		const { hostId, credential } = (await registered.json()) as { hostId: string; credential: string };
		expect((await service.get(hostId)).accountId).toBe(joinToken.accountId);
		// Its account's E2E chain, on its credential (`kantel-host e2e join`): through the gateway, not only the hosts API.
		const chain = (auth: string) =>
			gateway.fetch(
				new Request(`http://gateway.test/v1/hosts/e2e/chain?space=${joinToken.accountId}`, {
					headers: { authorization: `Bearer ${auth}` },
				}),
			);
		const read = await chain(credential);
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({ entries: [] });
		expect((await chain("khc_wrong")).status).toBe(401);
		const listed = (await otto.listAccountHosts()).items;
		expect(listed.map((host) => [host.id, host.name, host.accountId])).toEqual([
			[hostId, "otto-box", joinToken.accountId],
		]);
		// Not a super-admin: the deployment's host routes stay closed to them.
		expect((await failure(otto.listHosts())).code).toBe("forbidden");
	});

	it("serves host images by plain file name only", async () => {
		const serve = hostImages("https://images.example.com/v1/");
		const moved = await serve(new Request("http://gateway.test/v1/hosts/images/manifest.json"));
		expect(moved?.status).toBe(302);
		expect(moved?.headers.get("location")).toBe("https://images.example.com/v1/manifest.json");
		const outside = await serve(new Request("http://gateway.test/v1/hosts/images/..%2Fsecret"));
		expect(outside?.status).toBe(404);
		expect(await serve(new Request("http://gateway.test/v1/other"))).toBeUndefined();
	});

	it("makes the super-admin's key again from the secret an earlier start kept", async () => {
		const first = await serve(true);
		const secret = first.compute?.superAdminKey ?? "";
		const second = await serve(true, secret);
		expect(second.compute?.superAdminKey).toBe(secret);
		expect((await second.client(secret).getCaller()).superAdmin).toBe(true);
	});
});
