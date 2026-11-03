// The compute plane on the self-hosted gateway, through its fetch handler: off without KANTEL_COMPUTE=experimental;
// with it, the super-admin's key drives a sandbox through the SDK, makes a scoped key that works, and the gateway's own
// routes and keys are as they were.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { createMemoryHostStore } from "@kantel/hosts/store";
import { signTunnel } from "@kantel/hosts/tunnel";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { kantelSessionProvider } from "@kantel/identity/otp";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { computeConfig, computeEnabled, gatewayCompute, gatewayHosts, hostImages } from "../../src/gateway/compute.ts";
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
		? await gatewayCompute({ authenticator, ...(superAdminKey === undefined ? {} : { superAdminKey }) })
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
	return { gateway, seeded, compute, client };
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
	it("is on only with KANTEL_COMPUTE=experimental", () => {
		expect(computeEnabled({})).toBe(false);
		expect(computeEnabled({ KANTEL_COMPUTE: "on" })).toBe(false);
		expect(computeEnabled({ KANTEL_COMPUTE: " Experimental " })).toBe(true);
	});

	it("answers none of its routes when off", async () => {
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

	it("runs on the stub unless KANTEL_COMPUTE_BACKEND=hosts, which needs a public URL", () => {
		expect(computeConfig({})).toBeUndefined();
		expect(computeConfig({ KANTEL_COMPUTE: "experimental" })).toEqual({});
		expect(() => computeConfig({ KANTEL_COMPUTE: "experimental", KANTEL_COMPUTE_BACKEND: "hosts" })).toThrow(
			/KANTEL_PUBLIC_URL/,
		);
		expect(() => computeConfig({ KANTEL_COMPUTE: "experimental", KANTEL_COMPUTE_BACKEND: "cloud" })).toThrow();
		expect(
			computeConfig({
				KANTEL_COMPUTE: "experimental",
				KANTEL_COMPUTE_BACKEND: "hosts",
				KANTEL_PUBLIC_URL: "https://kantel.example.com/",
				KANTEL_COMPUTE_POOLS: '{"microvm/default": 2}',
			}),
		).toEqual({ hosts: { publicUrl: "https://kantel.example.com", pools: { "microvm/default": 2 } } });
	});

	it("takes a domain for exposed ports that isn't the gateway's own name or a parent of it", () => {
		const env = {
			KANTEL_COMPUTE: "experimental",
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
		const compute = await gatewayCompute({
			authenticator,
			hosts: { service, config, tunnelSecret: new Uint8Array(32) },
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

		// A desktop's page answers only a live desktop ticket signed with the gateway's secret.
		const secret = new Uint8Array(32);
		const ticket = (port: number, expiresAt = Date.now() + 60_000) =>
			signTunnel(secret, { sandboxId: "sbx_1", port, expiresAt });
		const view = (path: string) => gateway.fetch(new Request(`http://gateway.test/v1/hosts/view/${path}`));
		const page = await view(await ticket(5901));
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(await page.text()).toContain("@novnc/novnc@");
		expect((await view(await ticket(22))).status).toBe(404);
		expect((await view(await ticket(5901, Date.now() - 1))).status).toBe(404);
		const forged = await signTunnel(new Uint8Array(32).fill(1), {
			sandboxId: "sbx_1",
			port: 5901,
			expiresAt: Date.now() + 60_000,
		});
		expect((await view(forged)).status).toBe(404);
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
