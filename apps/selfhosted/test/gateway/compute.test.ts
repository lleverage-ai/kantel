// The compute plane on the self-hosted gateway, through its fetch handler: off without KANTEL_COMPUTE=experimental;
// with it, the super-admin's key drives a sandbox through the SDK, makes a scoped key that works, and the gateway's own
// routes and keys are as they were.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { kantelSessionProvider } from "@kantel/identity/otp";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { computeEnabled, gatewayCompute } from "../../src/gateway/compute.ts";
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

	it("makes the super-admin's key again from the secret an earlier start kept", async () => {
		const first = await serve(true);
		const secret = first.compute?.superAdminKey ?? "";
		const second = await serve(true, secret);
		expect(second.compute?.superAdminKey).toBe(secret);
		expect((await second.client(secret).getCaller()).superAdmin).toBe(true);
	});
});
