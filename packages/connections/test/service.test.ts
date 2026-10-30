import { type ConnectionSessionScope, HarbourError, systemContext } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryConnections, memoryCredentials } from "../src/memory.ts";
import { fakeAccess, fakeProvider, human, ORG } from "../src/testing.ts";

const SYSTEM = systemContext("test");
const alice = human("alice");
const bob = human("bob");

const scope = (overrides: Partial<ConnectionSessionScope> = {}): ConnectionSessionScope => ({
	organisationId: ORG,
	sessionId: "ses_1",
	agentId: "agt_1",
	actingUserId: "alice",
	audience: { kind: "private", userId: "alice" },
	...overrides,
});

function setup(options: { cimd?: boolean; dcr?: boolean; open?: boolean; clientMetadataPublic?: boolean } = {}) {
	const provider = fakeProvider(options);
	const credentials = memoryCredentials();
	let now = 1_000_000;
	const connections = createMemoryConnections({
		credentials,
		fetch: provider.fetch,
		access: fakeAccess(["admin"]),
		deployment: { origin: "https://harbour.test", clientMetadataPublic: options.clientMetadataPublic ?? false },
		clock: { now: () => now },
	});
	return { provider, credentials, connections, advance: (ms: number) => (now += ms) };
}

/** Starts a personal connect for alice to the fake MCP server and finishes it through the provider. */
async function connectAlice(env: ReturnType<typeof setup>) {
	const attempt = await env.connections.startConnect(alice, {
		owner: { kind: "user", organisationId: ORG, userId: "alice" },
		mcpUrl: env.provider.mcpUrl,
	});
	expect(attempt.status).toBe("pending");
	const { url } = await env.connections.authorize(alice, attempt.id);
	const state = new URL(url).searchParams.get("state")!;
	const done = await env.connections.completeConnect(alice, { state, code: env.provider.codeFor(url) });
	return { attempt, url, state, done };
}

describe("remote MCP OAuth connect", () => {
	it("discovers the server, registers by DCR, signs in with PKCE and stores the tokens only in the vault", async () => {
		const env = setup();
		const { url, done } = await connectAlice(env);
		const authorize = new URL(url);
		expect(authorize.origin + authorize.pathname).toBe("https://mcp.example.com/authorize");
		expect(authorize.searchParams.get("client_id")).toBe("dcr_1");
		expect(authorize.searchParams.get("redirect_uri")).toBe("https://harbour.test/v1/connections/callback");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
		expect(authorize.searchParams.get("scope")).toBe("read write");
		expect(done.status).toBe("completed");
		const connection = await env.connections.get(alice, done.connectionId!);
		expect(connection).toMatchObject({
			kind: "mcp",
			auth: "oauth2",
			hosts: ["mcp.example.com"],
			client: { via: "dcr", clientId: "dcr_1" },
			credential: { set: true, refreshable: true },
			usage: { visibility: "private" },
		});
		// No token appears in the connection, the attempt, or anything the API returns.
		const exposed = JSON.stringify([connection, done, await env.connections.getAttempt(alice, done.id)]);
		for (const token of [...env.provider.issued.access, ...env.provider.issued.refresh])
			expect(exposed).not.toContain(token);
		// The token request carried the verifier and the resource.
		const exchange = env.provider.tokenRequests[0]!;
		expect(exchange.get("code_verifier")).toBeTruthy();
		expect(exchange.get("resource")).toBe("https://mcp.example.com/mcp");
		// The refresh token is bound to the token endpoint's host only.
		const items = [...env.credentials.inspect().values()];
		expect(items.find((item) => item.value === env.provider.issued.refresh[0])?.hosts).toEqual(["mcp.example.com"]);
	});

	it("reuses one DCR registration per authorisation server", async () => {
		const env = setup();
		await connectAlice(env);
		await connectAlice(env);
		expect(env.provider.registrations).toHaveLength(1);
	});

	it("prefers CIMD when the server supports it and the metadata document is public", async () => {
		const env = setup({ cimd: true, clientMetadataPublic: true });
		const { url } = await connectAlice(env);
		expect(new URL(url).searchParams.get("client_id")).toBe(
			"https://harbour.test/v1/connections/oauth/client-metadata.json",
		);
		expect(env.provider.registrations).toHaveLength(0);
		expect(env.connections.clientMetadata()).toMatchObject({
			client_id: "https://harbour.test/v1/connections/oauth/client-metadata.json",
			redirect_uris: ["https://harbour.test/v1/connections/callback"],
			token_endpoint_auth_method: "none",
		});
	});

	it("prefers a pre-registered client over CIMD and DCR, and pins the connection to it", async () => {
		const env = setup({ cimd: true, clientMetadataPublic: true });
		const client = await env.connections.createClient(human("admin"), {
			owner: { kind: "organisation", organisationId: ORG },
			issuer: "https://mcp.example.com",
			label: "Our app",
			clientId: "registered-client",
		});
		const { url, done } = await connectAlice(env);
		expect(new URL(url).searchParams.get("client_id")).toBe("registered-client");
		const connection = await env.connections.get(alice, done.connectionId!);
		expect(connection.client).toMatchObject({ via: "client", oauthClientId: client.id, tier: "organisation" });
		expect((await env.connections.getClient(human("admin"), client.id)).connections).toBe(1);
		await expect(env.connections.removeClient(human("admin"), client.id)).rejects.toMatchObject({ code: "conflict" });
	});

	it("refuses a server with no client route", async () => {
		const env = setup({ dcr: false });
		await expect(
			env.connections.startConnect(alice, {
				owner: { kind: "user", organisationId: ORG, userId: "alice" },
				mcpUrl: env.provider.mcpUrl,
			}),
		).rejects.toMatchObject({ details: { failure: "no_client" } });
	});

	it("uses a state once, and only for the person it was made for", async () => {
		const env = setup();
		const attempt = await env.connections.startConnect(alice, {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			mcpUrl: env.provider.mcpUrl,
		});
		await expect(env.connections.authorize(bob, attempt.id)).rejects.toMatchObject({ code: "forbidden" });
		expect((await env.connections.getAttempt(alice, attempt.id)).status).toBe("failed");

		const second = await env.connections.startConnect(alice, {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			mcpUrl: env.provider.mcpUrl,
		});
		const { url } = await env.connections.authorize(alice, second.id);
		const state = new URL(url).searchParams.get("state")!;
		await expect(
			env.connections.completeConnect(bob, { state, code: env.provider.codeFor(url) }),
		).rejects.toMatchObject({
			code: "forbidden",
		});
		await expect(
			env.connections.completeConnect(alice, { state, code: env.provider.codeFor(url) }),
		).rejects.toMatchObject({
			details: { failure: "invalid_state" },
		});
	});

	it("expires a connect link", async () => {
		const env = setup();
		const attempt = await env.connections.startConnect(alice, {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			mcpUrl: env.provider.mcpUrl,
		});
		env.advance(16 * 60 * 1000);
		expect((await env.connections.getAttempt(alice, attempt.id)).status).toBe("expired");
		await expect(env.connections.authorize(alice, attempt.id)).rejects.toMatchObject({ code: "expired" });
	});

	it("records a provider's refusal", async () => {
		const env = setup();
		const attempt = await env.connections.startConnect(alice, {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			mcpUrl: env.provider.mcpUrl,
		});
		const { url } = await env.connections.authorize(alice, attempt.id);
		const done = await env.connections.completeConnect(alice, {
			state: new URL(url).searchParams.get("state")!,
			error: "access_denied",
		});
		expect(done).toMatchObject({ status: "failed", failure: { code: "denied" } });
	});

	it("connects an open MCP server with no sign-in", async () => {
		const env = setup({ open: true });
		const attempt = await env.connections
			.startConnect(alice, {
				owner: { kind: "organisation", organisationId: ORG },
				mcpUrl: env.provider.mcpUrl,
			})
			.catch((error: unknown) => error);
		// Only an admin may make an organisation connection.
		expect(attempt).toBeInstanceOf(HarbourError);
		const made = await env.connections.startConnect(human("admin"), {
			owner: { kind: "organisation", organisationId: ORG },
			mcpUrl: env.provider.mcpUrl,
			forUserId: "admin",
		});
		expect(made.status).toBe("completed");
		const tools = await env.connections.listTools(SYSTEM, scope({ audience: { kind: "shared" } }), made.connectionId!);
		expect(tools.map((tool) => tool.name)).toEqual(["whoami"]);
	});
});

describe("using a connection", () => {
	it("calls an MCP tool with the credential added on the way out, and records the use", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		const id = done.connectionId!;
		env.provider.echoToken = true;
		const result = await env.connections.callTool(SYSTEM, scope(), id, {
			name: "whoami",
			arguments: {},
			toolCallId: "call_1",
		});
		// The server saw the token; the agent gets the answer with it cut out.
		expect(env.provider.mcpAuthorizations.at(-1)).toBe(`Bearer ${env.provider.issued.access[0]}`);
		expect(JSON.stringify(result)).not.toContain(env.provider.issued.access[0]);
		expect(JSON.stringify(result)).toContain("[redacted]");
		const uses = await env.connections.listUses(alice, { connectionId: id });
		expect(uses.items[0]).toMatchObject({
			kind: "mcp_call",
			tool: "whoami",
			toolCallId: "call_1",
			outcome: "allowed",
			sessionId: "ses_1",
		});
	});

	it("refuses a personal connection in a session others can see, and records the refusal", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		const shared = scope({ audience: { kind: "shared" } });
		expect(await env.connections.usable(SYSTEM, shared)).toEqual([]);
		await expect(
			env.connections.callTool(SYSTEM, shared, done.connectionId!, { name: "whoami" }),
		).rejects.toMatchObject({
			code: "forbidden",
		});
		const uses = await env.connections.listUses(alice, { connectionId: done.connectionId! });
		expect(uses.items[0]).toMatchObject({ outcome: "denied" });
		// Bob's session never sees alice's connection.
		expect(
			await env.connections.usable(
				SYSTEM,
				scope({ actingUserId: "bob", audience: { kind: "private", userId: "bob" } }),
			),
		).toEqual([]);
	});

	it("refreshes an expired token and retries once on a 401", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		env.provider.expireAccessTokens();
		const tools = await env.connections.listTools(SYSTEM, scope(), done.connectionId!);
		expect(tools).toHaveLength(1);
		expect(env.provider.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
		expect(env.provider.mcpAuthorizations.at(-1)).toBe(`Bearer ${env.provider.issued.access[1]}`);
	});

	it("refreshes ahead of expiry", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		env.advance(3600 * 1000);
		await env.connections.listTools(SYSTEM, scope(), done.connectionId!);
		expect(env.provider.tokenRequests.filter((params) => params.get("grant_type") === "refresh_token")).toHaveLength(1);
	});

	it("sends a key connection's key only to its hosts", async () => {
		const sent: { url: string; headers: Headers }[] = [];
		const credentials = memoryCredentials();
		const connections = createMemoryConnections({
			credentials,
			access: fakeAccess(["admin"]),
			deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
			fetch: async (url, init) => {
				sent.push({ url, headers: new Headers(init?.headers) });
				return new Response(JSON.stringify({ echo: new Headers(init?.headers).get("x-api-key") }), {
					headers: { "content-type": "application/json" },
				});
			},
		});
		const connection = await connections.connectKey(human("admin"), {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "header", header: "X-Api-Key" }, kind: "http" },
			value: "sk-live-abcdefghijklmnop",
			usage: { unattended: true, visibility: "shared" },
		});
		expect(connection.credential).toMatchObject({ set: true, last4: "mnop" });
		expect(JSON.stringify(connection)).not.toContain("sk-live-abcdefghijklmnop");
		const response = await connections.send(SYSTEM, scope({ audience: { kind: "shared" } }), connection.id, {
			method: "GET",
			url: "https://api.example.com/v1/me",
			headers: { authorization: "Bearer forged" },
			kind: "http",
		});
		expect(sent[0]!.headers.get("x-api-key")).toBe("sk-live-abcdefghijklmnop");
		expect(sent[0]!.headers.get("authorization")).toBeNull();
		expect(response.body).not.toContain("sk-live-abcdefghijklmnop");
		await expect(
			connections.send(SYSTEM, scope({ audience: { kind: "shared" } }), connection.id, {
				method: "GET",
				url: "https://evil.example.net/",
				kind: "http",
			}),
		).rejects.toMatchObject({ code: "refused" });
		expect(sent).toHaveLength(1);
		const rotated = await connections.rotateKey(human("admin"), connection.id, { value: "sk-live-zyxwvutsrqponm42" });
		expect(rotated.credential.last4).toBe("nm42");
	});
});

describe("managing connections", () => {
	it("refuses agents", async () => {
		const env = setup();
		const agent = { actor: { kind: "agent" as const, agentId: "agt_1", sessionId: "ses_1" }, organisationId: ORG };
		await expect(
			env.connections.startConnect(agent, {
				owner: { kind: "organisation", organisationId: ORG },
				mcpUrl: env.provider.mcpUrl,
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			env.connections.connectKey(agent, {
				owner: { kind: "organisation", organisationId: ORG },
				custom: { hosts: ["api.example.com"], injection: { kind: "bearer" }, kind: "http" },
				value: "abc",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
	});

	it("keeps a person's connection to that person", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		await expect(env.connections.get(bob, done.connectionId!)).rejects.toMatchObject({ code: "not_found" });
		await expect(env.connections.get(human("admin"), done.connectionId!)).rejects.toMatchObject({ code: "not_found" });
		expect((await env.connections.list(bob)).items).toEqual([]);
		await expect(
			env.connections.startConnect(bob, {
				owner: { kind: "user", organisationId: ORG, userId: "alice" },
				mcpUrl: env.provider.mcpUrl,
			}),
		).rejects.toMatchObject({ code: "forbidden" });
	});

	it("removes a connection's secrets with it", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		await env.connections.remove(alice, done.connectionId!);
		const values = [...env.credentials.inspect().values()].map((item) => item.value);
		expect(values).not.toContain(env.provider.issued.access[0]);
		expect(values).not.toContain(env.provider.issued.refresh[0]);
	});

	it("lists the catalogue with setup state", async () => {
		const env = setup();
		const page = await env.connections.listCatalogue(alice, { q: "linear" });
		expect(page.items.some((entry) => entry.id === "linear")).toBe(true);
		const github = (await env.connections.listCatalogue(alice, { q: "github" })).items.find(
			(entry) => entry.id === "github",
		);
		expect(github?.setup).toBe("needs_client");
	});
});
