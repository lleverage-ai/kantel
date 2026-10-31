// KANTEL_CALLBACK_ORIGINS: which host-tool callback URLs the gateway may call, and a host app on a loopback port the
// OS picked (as a host app's worker may serve its tools) registering through the gateway.
import type { HostToolDefinition } from "@kantel/contracts";
import { bearer, createSessionApiClient } from "@kantel/runtime/http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { callbackUrlAllowed, parseCallbackOrigin, parseCallbackOrigins } from "../../src/gateway/callbacks.ts";
import { type Bootstrap, bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { gatewayConfig } from "../../src/gateway/main.ts";
import { type Listening, listen } from "../../src/gateway/node-http.ts";

describe("parsing", () => {
	test("an origin, and an origin with any port", () => {
		expect(parseCallbackOrigin("https://sal.example")).toEqual({
			protocol: "https:",
			hostname: "sal.example",
			port: "",
		});
		expect(parseCallbackOrigin("http://127.0.0.1:8787/")).toEqual({
			protocol: "http:",
			hostname: "127.0.0.1",
			port: "8787",
		});
		expect(parseCallbackOrigin("http://127.0.0.1:*")).toEqual({ protocol: "http:", hostname: "127.0.0.1", port: "*" });
		expect(parseCallbackOrigin("http://[::1]:*")).toEqual({ protocol: "http:", hostname: "[::1]", port: "*" });
		expect(parseCallbackOrigin("HTTP://LocalHost:*")).toEqual({ protocol: "http:", hostname: "localhost", port: "*" });
	});

	test.each([
		"127.0.0.1:8787",
		"ftp://127.0.0.1",
		"http://127.0.0.1/hosts",
		"http://127.0.0.1:*/hosts",
		"http://user@127.0.0.1:*",
		"http://127.0.0.1?x=1",
		"http://127.0.0.1:8787:*",
		"http://*:8787",
		"http://127.0.0.1:80",
	])("refuses %s", (entry) => {
		expect(() => parseCallbackOrigin(entry)).toThrow(/KANTEL_CALLBACK_ORIGINS/);
	});

	test("the list skips blank entries, and the gateway's configuration refuses a bad one at start", () => {
		expect(parseCallbackOrigins(" http://127.0.0.1:* , ,https://sal.example ")).toHaveLength(2);
		expect(parseCallbackOrigins(undefined)).toEqual([]);
		expect(gatewayConfig({ KANTEL_CALLBACK_ORIGINS: "http://127.0.0.1:*" }).callbackOrigins).toHaveLength(1);
		expect(() => gatewayConfig({ KANTEL_CALLBACK_ORIGINS: "http://127.0.0.1/x" })).toThrow(/origin only/);
	});
});

describe("matching", () => {
	const allowed = callbackUrlAllowed(parseCallbackOrigins("http://127.0.0.1:*,https://sal.example:8443"));
	test.each([
		["http://127.0.0.1:41234/hosts/sal", true],
		["http://127.0.0.1/hosts/sal", true],
		["https://127.0.0.1:41234/hosts/sal", false],
		["http://localhost:41234/hosts/sal", false],
		["http://127.0.0.2:41234/hosts/sal", false],
		["https://sal.example:8443/hosts/sal", true],
		["https://sal.example/hosts/sal", false],
		["https://evil.example/hosts/sal", false],
	])("%s: %s", (url, expected) => {
		expect(allowed(new URL(url))).toBe(expected);
	});
});

describe("a host app with its callbacks on a loopback port", () => {
	let components: ReturnType<typeof createGatewayComponents>;
	let gateway: ReturnType<typeof createGateway>;
	let server: Listening;
	let host: Listening;
	let seeded: Bootstrap;
	const endpoints = new Map<string, (request: Request) => Promise<Response>>();
	const ping: HostToolDefinition = {
		name: "ping",
		description: "Answers pong",
		inputSchema: { type: "object" },
		replay: "safe",
	};

	beforeAll(async () => {
		components = createGatewayComponents();
		seeded = await bootstrap(components, { organisation: "Callbacks", project: "callbacks" });
		gateway = createGateway({
			components,
			allowCallbackUrl: callbackUrlAllowed(parseCallbackOrigins("http://127.0.0.1:*")),
		});
		server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
		// As a host app's worker may: one server on a port the OS picks, a route per host.
		host = await listen(
			async (request) => {
				const match = /^\/hosts\/([^/]+)$/.exec(new URL(request.url).pathname);
				const endpoint = match === null ? undefined : endpoints.get(decodeURIComponent(match[1] as string));
				return endpoint === undefined ? new Response("not found", { status: 404 }) : endpoint(request);
			},
			0,
			{ host: "127.0.0.1" },
		);
	});

	afterAll(async () => {
		await gateway.close();
		await server.close();
		await host.close();
		await components.close();
	});

	const client = (callbackHost: string) =>
		createSessionApiClient({
			baseUrl: `${server.url}/v1`,
			credentials: bearer(seeded.apiKey),
			hostCallbacks: {
				url: (hostId) => `http://${callbackHost}:${new URL(host.url).port}/hosts/${encodeURIComponent(hostId)}`,
				serve: (hostId, endpoint) => {
					if (endpoint === undefined) endpoints.delete(hostId);
					else endpoints.set(hostId, endpoint);
				},
			},
		});
	const ctx = () => ({
		actor: { kind: "service" as const, serviceId: "sal" },
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	});

	test("registers on http://127.0.0.1 at the port it got, and is refused on another host name", async () => {
		const handler = async () => ({ output: "pong" });
		const subscription = await client("127.0.0.1").hostTools.register(ctx(), "sal-loopback", [ping], handler);
		expect(await client("127.0.0.1").hostTools.list(ctx(), "sal-loopback")).toMatchObject([{ name: "ping" }]);
		await subscription.close();

		await expect(client("localhost").hostTools.register(ctx(), "sal-by-name", [ping], handler)).rejects.toMatchObject({
			code: "refused",
		});
	});
});
