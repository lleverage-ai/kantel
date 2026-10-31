import { type AuditEventInput, type ConnectionSessionScope, KantelError, systemContext } from "@kantel/contracts";
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

function setup(
	options: {
		cimd?: boolean;
		dcr?: boolean;
		open?: boolean;
		clientMetadataPublic?: boolean;
		revocation?: "ok" | "refuse" | "down";
	} = {},
) {
	const provider = fakeProvider(options);
	const credentials = memoryCredentials();
	const events: AuditEventInput[] = [];
	let now = 1_000_000;
	const connections = createMemoryConnections({
		credentials,
		audit: {
			append: async (_ctx, batch) => {
				events.push(...batch);
			},
		},
		fetch: provider.fetch,
		access: fakeAccess(["admin"]),
		deployment: { origin: "https://harbour.test", clientMetadataPublic: options.clientMetadataPublic ?? false },
		clock: { now: () => now },
	});
	return { provider, credentials, connections, events, advance: (ms: number) => (now += ms) };
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
		// Read-only, so listing it gives it an allow rule (#332's defaults); an unannotated tool would ask.
		env.provider.tools = [{ name: "whoami", annotations: { readOnlyHint: true } }];
		await env.connections.listTools(SYSTEM, scope(), id);
		const result = await env.connections.callTool(SYSTEM, scope(), id, {
			name: "whoami",
			arguments: {},
			toolCallId: "call_1",
		});
		// The server saw the token; the agent gets the answer with it cut out.
		expect(env.provider.mcpAuthorizations.at(-1)).toBe(`Bearer ${env.provider.issued.access[0]}`);
		expect(JSON.stringify(result)).not.toContain(env.provider.issued.access[0]);
		expect(JSON.stringify(result)).toContain("[redacted]");
		// The vault's record of the open names the request it was for, not POST / (#483).
		expect(env.credentials.opened.at(-1)).toMatchObject({
			purpose: `connection ${id}: tools/call whoami`,
			request: { method: "POST", path: new URL(env.provider.mcpUrl).pathname },
		});
		const uses = await env.connections.listUses(alice, { connectionId: id });
		expect(uses.items.find((use) => "kind" in use && use.kind === "mcp_call")).toMatchObject({
			kind: "mcp_call",
			tool: "whoami",
			toolCallId: "call_1",
			outcome: "allowed",
			sessionId: "ses_1",
		});
	});

	it("gives an MCP server's tools their defaults from their annotations when listed: reads allow, destructive deny, the rest ask", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		const id = done.connectionId!;
		const made = await env.connections.getRules(alice, id);
		expect(made).toMatchObject({ rules: [], unmatched: "ask", version: 1, defaults: { reason: "created" } });
		// Alice's own session: a personal connection is for her private ones.
		const dry = (tool: string) => env.connections.dryRun(alice, id, { method: "POST", tool, audience: "private" });
		// Before a listing, nothing is known about a tool: it asks.
		expect((await dry("whoami")).action).toBe("ask");
		env.provider.tools = [
			{ name: "whoami", annotations: { readOnlyHint: true } },
			{ name: "wipe", annotations: { destructiveHint: true } },
			{ name: "edit" },
		];
		await env.connections.listTools(SYSTEM, scope(), id);
		const seeded = await env.connections.getRules(alice, id);
		expect(seeded.version).toBe(2);
		expect(seeded.rules.map((rule) => [rule.what, rule.action, rule.source])).toEqual([
			[{ kind: "tool", tool: "whoami" }, "allow", "default"],
			[{ kind: "tool", tool: "wipe" }, "deny", "default"],
		]);
		for (const [tool, action] of [
			["whoami", "allow"],
			["wipe", "deny"],
			["edit", "ask"],
		] as const) {
			expect((await dry(tool)).action).toBe(action);
		}
		await env.connections.callTool(SYSTEM, scope(), id, { name: "whoami" });
		await expect(env.connections.callTool(SYSTEM, scope(), id, { name: "wipe" })).rejects.toThrow(/blocked/);
		await expect(env.connections.callTool(SYSTEM, scope(), id, { name: "edit" })).rejects.toThrow(/approv/);
		// Listing again adds nothing.
		await env.connections.listTools(SYSTEM, scope(), id);
		expect((await env.connections.getRules(alice, id)).version).toBe(2);
		// Once a person has changed the rules, a listing never adds to them: a new read-only tool asks.
		await env.connections.updateRule(alice, id, seeded.rules[1]!.id, { action: "ask" });
		env.provider.tools = [...env.provider.tools, { name: "peek", annotations: { readOnlyHint: true } }];
		await env.connections.listTools(SYSTEM, scope(), id);
		const edited = await env.connections.getRules(alice, id);
		expect(edited.rules.map((rule) => rule.what)).not.toContainEqual({ kind: "tool", tool: "peek" });
		expect((await dry("peek")).action).toBe("ask");
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

	it("keeps a person's connection to that person, and shows only that it exists to an admin", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		await expect(env.connections.get(bob, done.connectionId!)).rejects.toMatchObject({ code: "not_found" });
		// #335: an organisation admin sees it exists, its template, account and rules, but can't use or share it.
		expect((await env.connections.get(human("admin"), done.connectionId!)).owner).toMatchObject({ userId: "alice" });
		await expect(env.connections.share(human("admin"), done.connectionId!, "prj_1")).rejects.toMatchObject({
			code: "forbidden",
		});
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
});

describe("disconnecting", () => {
	const removedEvent = (env: ReturnType<typeof setup>) =>
		env.events.find((event) => event.type === "connections.connection.removed");

	it("revokes the grant at the authorisation server's RFC 7009 endpoint, then deletes the tokens", async () => {
		const env = setup({ revocation: "ok" });
		const { done } = await connectAlice(env);
		const removal = await env.connections.remove(alice, done.connectionId!);
		expect(env.credentials.opened.at(-1)).toMatchObject({
			purpose: `connection ${done.connectionId}: revoke`,
			request: { method: "POST", path: "/revoke" },
		});
		expect(removal).toEqual({
			connectionId: done.connectionId,
			revocation: { outcome: "revoked", endpoint: "https://mcp.example.com/revoke" },
			rulesRemoved: 0,
			approvalsWithdrawn: 0,
		});
		// The refresh token, which ends the whole grant, as a public client.
		expect(env.provider.revocations).toHaveLength(1);
		const form = env.provider.revocations[0]!;
		expect(form.get("token")).toBe(env.provider.issued.refresh[0]);
		expect(form.get("token_type_hint")).toBe("refresh_token");
		expect(form.get("client_id")).toBe("dcr_1");
		expect(form.has("client_secret")).toBe(false);
		// The provider no longer honours it, and the vault holds neither token.
		const refreshed = await env.provider.fetch("https://mcp.example.com/token", {
			method: "POST",
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: env.provider.issued.refresh[0]!,
			}).toString(),
		});
		expect(refreshed.status).toBe(400);
		const values = [...env.credentials.inspect().values()].map((item) => item.value);
		expect(values).not.toContain(env.provider.issued.access[0]);
		expect(values).not.toContain(env.provider.issued.refresh[0]);
		await expect(env.connections.get(alice, done.connectionId!)).rejects.toMatchObject({ code: "not_found" });
		// The audit trail says the same, and carries no token.
		const event = removedEvent(env);
		expect(event?.data).toMatchObject({
			revocation: "revoked",
			revocationEndpoint: "https://mcp.example.com/revoke",
			rulesRemoved: 0,
			approvalsWithdrawn: 0,
		});
		const logged = JSON.stringify(env.events);
		for (const token of [...env.provider.issued.access, ...env.provider.issued.refresh])
			expect(logged).not.toContain(token);
	});

	it("says unsupported when the authorisation server names no revocation endpoint, and still removes it", async () => {
		const env = setup();
		const { done } = await connectAlice(env);
		const removal = await env.connections.remove(alice, done.connectionId!);
		expect(removal.revocation).toMatchObject({ outcome: "unsupported" });
		expect(removal.revocation.reason).toMatch(/no way for an app to revoke/);
		expect(env.provider.revocations).toHaveLength(0);
		expect(removedEvent(env)?.data).toMatchObject({ revocation: "unsupported" });
		await expect(env.connections.get(alice, done.connectionId!)).rejects.toMatchObject({ code: "not_found" });
	});

	it("says failed when the provider refuses, with its error and no token, and still deletes everything", async () => {
		const env = setup({ revocation: "refuse" });
		const { done } = await connectAlice(env);
		const removal = await env.connections.remove(alice, done.connectionId!);
		expect(removal.revocation).toMatchObject({ outcome: "failed", endpoint: "https://mcp.example.com/revoke" });
		expect(removal.revocation.reason).toContain("temporarily_unavailable");
		expect(JSON.stringify(removal)).not.toContain(env.provider.issued.refresh[0]);
		const values = [...env.credentials.inspect().values()].map((item) => item.value);
		expect(values).not.toContain(env.provider.issued.refresh[0]);
		expect(removedEvent(env)?.data).toMatchObject({ revocation: "failed" });
		await expect(env.connections.get(alice, done.connectionId!)).rejects.toMatchObject({ code: "not_found" });
	});

	it("says failed when the provider doesn't answer", async () => {
		const env = setup({ revocation: "down" });
		const { done } = await connectAlice(env);
		const removal = await env.connections.remove(alice, done.connectionId!);
		expect(removal.revocation).toEqual({
			outcome: "failed",
			endpoint: "https://mcp.example.com/revoke",
			reason: "The revocation endpoint did not answer",
		});
	});

	it("says there was nothing to revoke for an open server", async () => {
		const env = setup({ open: true, revocation: "ok" });
		const admin = human("admin");
		const attempt = await env.connections.startConnect(admin, {
			owner: { kind: "organisation", organisationId: ORG },
			mcpUrl: env.provider.mcpUrl,
			forUserId: "admin",
		});
		const removal = await env.connections.remove(admin, attempt.connectionId!);
		expect(removal.revocation).toEqual({ outcome: "none" });
		expect(env.provider.revocations).toHaveLength(0);
	});

	it("says a key can only be revoked at the service, removes its rules, and finishes a disconnect cut short", async () => {
		const env = setup();
		const admin = human("admin");
		const key = await env.connections.connectKey(admin, {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "bearer" }, kind: "http" },
			value: "sk-live-abcdefghijklmnop",
		});
		await env.connections.createRule(admin, key.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "GET", path: "/**" },
			action: "allow",
		});
		// A disconnect cut short leaves it disabled: it is refused at once, and disconnecting again finishes it.
		await env.connections.update(admin, key.id, { status: "disabled" });
		const removal = await env.connections.remove(admin, key.id);
		// Its three method defaults (#332) and the one added.
		expect(removal).toMatchObject({ revocation: { outcome: "unsupported" }, rulesRemoved: 4 });
		expect(removal.revocation.reason).toMatch(/only be revoked at api\.example\.com itself/);
		expect([...env.credentials.inspect().values()].map((item) => item.value)).not.toContain("sk-live-abcdefghijklmnop");
		await expect(env.connections.getRules(admin, key.id)).rejects.toMatchObject({ code: "not_found" });
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
