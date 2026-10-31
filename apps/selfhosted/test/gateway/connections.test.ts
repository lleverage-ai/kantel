// Connections on the self-hosted gateway (epic #322): on with a public URL and a vault, served at /v1/connections, the
// client metadata document public, and the session tools in the bootstrap's profile.
import { describe, expect, test } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { connectionsConfig, privateAddress, publicFetch } from "../../src/gateway/connections.ts";
import { createGateway } from "../../src/gateway/gateway.ts";

const ORIGIN = "https://harbour.example.com";

describe("connections on the self-hosted gateway", () => {
	test("are on with a public URL, and off when asked", () => {
		expect(connectionsConfig({}, undefined)).toBeUndefined();
		expect(connectionsConfig({ KANTEL_CONNECTIONS: "off" }, ORIGIN)).toBeUndefined();
		expect(connectionsConfig({ KANTEL_CONNECTIONS_CIMD: "on" }, ORIGIN)).toEqual({
			origin: ORIGIN,
			clientMetadataPublic: true,
			personal: false,
		});
	});

	test("serve the API to a signed-in caller, the metadata document to anyone, and the tools to sessions", async () => {
		const components = createGatewayComponents({
			connections: { origin: ORIGIN, clientMetadataPublic: true, personal: false },
		});
		const seeded = await bootstrap(components, { organisation: "Connections", project: "connections" });
		const gateway = createGateway({ components });
		try {
			expect(components.connections).toBeDefined();
			const catalogue = await gateway.fetch(
				new Request(`${ORIGIN}/v1/connections/catalogue?q=notion`, {
					headers: { authorization: `Bearer ${seeded.apiKey}` },
				}),
			);
			expect(catalogue.status).toBe(200);
			const listed = (await catalogue.json()) as { items: { id: string }[] };
			expect(listed.items.map((entry) => entry.id)).toContain("notion");

			const settings = await gateway.fetch(
				new Request(`${ORIGIN}/v1/connections/settings`, { headers: { authorization: `Bearer ${seeded.apiKey}` } }),
			);
			expect(await settings.json()).toEqual({ personal: false });

			const anonymous = await gateway.fetch(new Request(`${ORIGIN}/v1/connections`));
			expect(anonymous.status).toBe(401);

			const metadata = await gateway.fetch(new Request(`${ORIGIN}/v1/connections/oauth/client-metadata.json`));
			expect(metadata.status).toBe(200);
			expect(await metadata.json()).toMatchObject({
				client_id: `${ORIGIN}/v1/connections/oauth/client-metadata.json`,
				redirect_uris: [`${ORIGIN}/v1/connections/callback`],
			});

			const profile = await components.runtime.profiles.get(
				{
					actor: { kind: "system", component: "test" },
					organisationId: seeded.organisationId,
					projectId: seeded.projectId,
				},
				"echo",
			);
			expect(profile.tools).toEqual(
				expect.arrayContaining(["connections_list", "connection_call", "connection_request"]),
			);
		} finally {
			await gateway.close();
			await components.close();
		}
	});
});

describe("the connections fetch", () => {
	test("refuses private, loopback and link-local addresses", async () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.20.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"::1",
			"fd00::1",
			"::ffff:127.0.0.1",
		]) {
			expect(privateAddress(address)).toBe(true);
		}
		expect(privateAddress("1.1.1.1")).toBe(false);
		expect(privateAddress("2606:4700:4700::1111")).toBe(false);
		let reached = 0;
		const guarded = publicFetch(async () => {
			reached += 1;
			return new Response("ok");
		});
		await expect(guarded("https://127.0.0.1/mcp")).rejects.toThrow(/not on the internet/);
		await expect(guarded("https://[::1]/mcp")).rejects.toThrow(/not on the internet/);
		await expect(guarded("https://localhost/mcp")).rejects.toThrow(/not on the internet/);
		expect(reached).toBe(0);
		expect(await (await guarded("https://1.1.1.1/")).text()).toBe("ok");
	});
});
