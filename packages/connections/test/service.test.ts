import { type ConnectionSessionScope, KantelError, systemContext } from "@kantel/contracts";
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

	it("sends the redirect URI a client was registered with, on its own redirect domain", async () => {
		const env = setup();
		const client = await env.connections.createClient(human("admin"), {
			owner: { kind: "organisation", organisationId: ORG },
			issuer: "https://mcp.example.com",
			label: "Our app",
			clientId: "registered-client",
			redirectDomain: "connect.acme.test",
		});
		expect(client.redirectUri).toBe("https://connect.acme.test/v1/connections/callback");
		const { url, done } = await connectAlice(env);
		expect(new URL(url).searchParams.get("redirect_uri")).toBe(client.redirectUri);
		expect(done.status).toBe("completed");
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
		expect(attempt).toBeInstanceOf(KantelError);
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

	it("cuts an echoed Basic header and its encoding out of the answer, and refuses a short key", async () => {
		const connections = createMemoryConnections({
			credentials: memoryCredentials(),
			access: fakeAccess(["admin"]),
			deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
			fetch: async (_url, init) =>
				new Response(new Headers(init?.headers).get("authorization") ?? "", { headers: { echo: "x" } }),
		});
		await expect(
			connections.connectKey(human("admin"), {
				owner: { kind: "organisation", organisationId: ORG },
				custom: { hosts: ["api.example.com"], injection: { kind: "bearer" }, kind: "http" },
				value: "short",
			}),
		).rejects.toMatchObject({ code: "invalid" });
		const connection = await connections.connectKey(human("admin"), {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "basic" }, kind: "http" },
			value: "user:pa55word-long",
			usage: { unattended: true, visibility: "shared" },
		});
		const response = await connections.send(SYSTEM, scope({ audience: { kind: "shared" } }), connection.id, {
			method: "GET",
			url: "https://api.example.com/",
			kind: "http",
		});
		expect(response.body).toBe("[redacted]");
		expect(response.body).not.toContain(btoa("user:pa55word-long"));
	});

	it("sends a basic key's UTF-8 bytes, split at the first colon", async () => {
		const sent: string[] = [];
		const connections = createMemoryConnections({
			credentials: memoryCredentials(),
			access: fakeAccess(["admin"]),
			deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
			fetch: async (_url, init) => {
				sent.push(new Headers(init?.headers).get("authorization") ?? "");
				return new Response("ok");
			},
		});
		const connection = await connections.connectKey(human("admin"), {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "basic" }, kind: "http" },
			value: "zoë:pässwörd:with-colon",
			usage: { unattended: true, visibility: "shared" },
		});
		await connections.send(SYSTEM, scope({ audience: { kind: "shared" } }), connection.id, {
			method: "GET",
			url: "https://api.example.com/",
			kind: "http",
		});
		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(sent[0]!.replace(/^Basic /, "")), (char) => char.charCodeAt(0)),
		);
		expect(decoded).toBe("zoë:pässwörd:with-colon");
	});

	it("tests a template's key the way it goes out, and keeps a refused key as failing_test", async () => {
		const sent: Headers[] = [];
		const connections = createMemoryConnections({
			credentials: memoryCredentials(),
			access: fakeAccess(["admin"]),
			deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
			templates: [
				{
					id: "acme-api",
					version: 1,
					name: "Acme API",
					description: "Acme's API with a key.",
					icon: "data:image/svg+xml,x",
					docsUrl: "https://acme.test/docs",
					category: "developer",
					kind: "http",
					authTypes: ["header"],
					apiHosts: ["api.acme.test"],
					key: { injection: { kind: "header", header: "Authorization" } },
					scopeSets: [],
					endpointHints: [],
					testRequest: { method: "GET", url: "https://api.acme.test/me", account: { name: "name" } },
					source: "deployment",
				},
			],
			fetch: async (_url, init) => {
				const headers = new Headers(init?.headers);
				sent.push(headers);
				return headers.get("authorization") === "acme_good_key_1234"
					? Response.json({ name: "Release bot" })
					: new Response("no", { status: 401 });
			},
		});
		const owner = { kind: "organisation", organisationId: ORG } as const;
		const good = await connections.connectKey(human("admin"), {
			owner,
			templateId: "acme-api",
			value: "acme_good_key_1234",
		});
		expect(sent[0]!.get("authorization")).toBe("acme_good_key_1234");
		expect(good).toMatchObject({ status: "active", account: { name: "Release bot" } });
		const bad = await connections.connectKey(human("admin"), {
			owner,
			templateId: "acme-api",
			value: "acme_revoked_key_99",
		});
		expect(bad.status).toBe("failing_test");
		expect(bad.account).toBeUndefined();
		const fixed = await connections.rotateKey(human("admin"), bad.id, { value: "acme_good_key_1234" });
		expect(fixed).toMatchObject({ status: "active", account: { name: "Release bot" } });
		const broken = await connections.rotateKey(human("admin"), good.id, { value: "acme_revoked_key_99" });
		expect(broken.status).toBe("failing_test");
	});

	it("never sends a key to a test URL outside the template's API hosts", async () => {
		const sent: string[] = [];
		const connections = createMemoryConnections({
			credentials: memoryCredentials(),
			access: fakeAccess(["admin"]),
			deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
			templates: [
				{
					id: "acme-api",
					version: 1,
					name: "Acme API",
					description: "Acme's API with a key.",
					icon: "data:image/svg+xml,x",
					docsUrl: "https://acme.test/docs",
					category: "developer",
					kind: "http",
					authTypes: ["bearer"],
					apiHosts: ["api.acme.test"],
					key: { injection: { kind: "bearer" } },
					scopeSets: [],
					endpointHints: [],
					testRequest: { method: "GET", url: "https://elsewhere.test/me" },
					source: "deployment",
				},
			],
			fetch: async (url) => {
				sent.push(String(url));
				return new Response("no", { status: 401 });
			},
		});
		const connection = await connections.connectKey(human("admin"), {
			owner: { kind: "organisation", organisationId: ORG },
			templateId: "acme-api",
			value: "acme_key_12345678",
		});
		expect(sent).toEqual([]);
		expect(connection.status).toBe("active");
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
