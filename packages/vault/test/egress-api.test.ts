import { type CallContext, type KantelError, isKantelError, systemContext } from "@kantel/contracts";
import {
	createEgressDecisionApi,
	createEgressDecisionClient,
	createSharedKeyAuthenticator,
	EGRESS_API_PATHS,
} from "@kantel/vault/egress-api";
import { createMemoryVault } from "@kantel/vault/memory";
import { describe, expect, it } from "vitest";

const VALUE = "egress-api-test-value-91c4";
const GATEWAY_KEY = "gateway-shared-key-0123456789";
const human: CallContext = { actor: { kind: "human", userId: "admin-1" }, organisationId: "org-a" };
const scope = { organisationId: "org-a", projectId: "proj-a", agentId: "agent-1", sessionId: "session-1" } as const;

async function setUp(basePath?: string) {
	const vault = createMemoryVault();
	const item = await vault.putItem(human, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name: "llm-key",
		hosts: ["llm.example.com", "api.example.com"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: VALUE,
	});
	await vault.putPolicy(human, {
		itemId: item.id,
		selector: { organisationId: "org-a" },
		route: { host: "api.example.com", methods: ["GET"], pathPrefix: "/" },
	});
	const handler = createEgressDecisionApi({
		vault,
		authenticate: createSharedKeyAuthenticator({ keys: { "egress-gateway": GATEWAY_KEY } }),
		...(basePath === undefined ? {} : { basePath }),
	});
	const fetchVia: typeof fetch = async (input, init) => handler(new Request(input, init));
	const client = (token: string) =>
		createEgressDecisionClient({ baseUrl: `https://vault.internal${basePath ?? ""}`, token, fetch: fetchVia });
	return { vault, item, handler, client };
}

function post(path: string, body: unknown, token = GATEWAY_KEY): Request {
	return new Request(`https://vault.internal${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("createEgressDecisionApi and createEgressDecisionClient", () => {
	it("decides egress and reads a connector credential for an authenticated component", async () => {
		const { item, client } = await setUp("/vault");
		const gateway = client(GATEWAY_KEY);
		const allowed = await gateway.decideEgress({
			organisationId: "org-a",
			method: "GET",
			url: "https://api.example.com/things",
		});
		expect(allowed).toMatchObject({ allow: true, inject: { header: "Authorization", value: `Bearer ${VALUE}` } });
		const denied = await gateway.decideEgress({
			organisationId: "org-a",
			method: "POST",
			url: "https://api.example.com/",
		});
		expect(denied).toMatchObject({ allow: false, fix: { action: "propose" } });
		const credential = await gateway.readConnectorCredential({
			connectorId: "org-llm",
			owner: { kind: "organisation", organisationId: "org-a" },
			vaultItemId: item.id,
			baseUrl: "https://llm.example.com/v1",
			scope,
		});
		expect(credential).toMatchObject({ itemId: item.id, value: VALUE, valueVersion: 1 });
	});

	it("issues placeholders, swaps one only in the auth header's decision and on its own host, and checks a session is open", async () => {
		const { item, client, vault } = await setUp();
		const gateway = client(GATEWAY_KEY);
		const issued = await gateway.issueSessionPlaceholders({ organisationId: "org-a", sessionId: "session-1" });
		expect(issued.placeholders.map((entry) => entry.itemId)).toEqual([item.id]);
		expect(JSON.stringify(issued)).not.toContain(VALUE);
		const placeholder = issued.placeholders[0]!.placeholder;
		const request = { organisationId: "org-a", sessionId: "session-1", method: "GET" as const, placeholder };
		expect(await gateway.decideEgress({ ...request, url: "https://api.example.com/things" })).toMatchObject({
			allow: true,
			inject: { header: "Authorization", value: `Bearer ${VALUE}` },
		});
		const elsewhere = await gateway.decideEgress({ ...request, url: "https://elsewhere.example/collect" });
		expect(elsewhere.allow).toBe(false);
		expect(JSON.stringify(elsewhere)).not.toContain(VALUE);

		await gateway.assertSessionOpen(scope);
		await vault.setSessionAccess(human, "session-1", { blocked: true });
		const refused = await gateway.assertSessionOpen(scope).catch((error: unknown) => error);
		expect(isKantelError(refused, "refused")).toBe(true);
		expect((await gateway.decideEgress({ ...request, url: "https://api.example.com/things" })).allow).toBe(false);
		const agent = await client("not-the-key-0123456789")
			.issueSessionPlaceholders({ organisationId: "org-a", sessionId: "session-1" })
			.catch((error: unknown) => error);
		expect(isKantelError(agent, "forbidden")).toBe(true);
	});

	it("sends no-store on every response and answers errors as JSON with one status per code", async () => {
		const { handler, item } = await setUp();
		const ok = await handler(
			post(EGRESS_API_PATHS.decisions, { organisationId: "org-a", method: "GET", url: "https://x.example/" }),
		);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("cache-control")).toBe("no-store");
		const cases: readonly [Request, number, string][] = [
			[new Request("https://vault.internal/v1/other", { method: "POST" }), 404, "not_found"],
			[new Request(`https://vault.internal${EGRESS_API_PATHS.decisions}`), 405, "not_supported"],
			[post(EGRESS_API_PATHS.decisions, "{not json"), 400, "invalid"],
			[post(EGRESS_API_PATHS.decisions, { organisationId: "org-a", method: "BREW", url: "x" }), 400, "invalid"],
			[post(EGRESS_API_PATHS.connectorCredentials, [1, 2]), 400, "invalid"],
			[post(EGRESS_API_PATHS.decisions, {}, "wrong-key-0123456789"), 403, "forbidden"],
			[
				new Request(`https://vault.internal${EGRESS_API_PATHS.decisions}`, { method: "POST", body: "{}" }),
				403,
				"forbidden",
			],
			[
				post(EGRESS_API_PATHS.connectorCredentials, {
					connectorId: "org-llm",
					owner: { kind: "organisation", organisationId: "org-a" },
					vaultItemId: item.id,
					baseUrl: "https://evil.example/v1",
					scope,
				}),
				403,
				"refused",
			],
		];
		for (const [request, status, code] of cases) {
			const response = await handler(request);
			expect(response.status, `${request.method} ${request.url}`).toBe(status);
			expect(response.headers.get("cache-control")).toBe("no-store");
			const body = await response.text();
			expect(JSON.parse(body)).toMatchObject({ error: { code } });
			expect(body).not.toContain(VALUE);
		}
	});

	it("rebuilds a KantelError from the error JSON on the client", async () => {
		const { client, item } = await setUp();
		const refused = await client(GATEWAY_KEY)
			.readConnectorCredential({
				connectorId: "platform-llm",
				owner: { kind: "platform" },
				vaultItemId: item.id,
				baseUrl: "https://llm.example.com/v1",
				scope,
			})
			.catch((error: unknown) => error);
		expect(isKantelError(refused, "refused")).toBe(true);
		expect(String((refused as KantelError).message)).not.toContain(VALUE);
		const forbidden = await client("not-the-key-0123456789")
			.decideEgress({ organisationId: "org-a", method: "GET", url: "https://api.example.com/" })
			.catch((error: unknown) => error);
		expect(isKantelError(forbidden, "forbidden")).toBe(true);
	});

	it("lets the vault refuse an authenticated caller that is not a system component", async () => {
		const vault = createMemoryVault();
		const handler = createEgressDecisionApi({
			vault,
			authenticate: async () => ({ actor: { kind: "human", userId: "someone" }, organisationId: "org-a" }),
		});
		const response = await handler(
			post(EGRESS_API_PATHS.decisions, { organisationId: "org-a", method: "GET", url: "https://x.example/" }),
		);
		expect(response.status).toBe(403);
		expect(await vault.listUses(human)).toEqual({ items: [] });
	});

	it("answers 500 without detail for an error that is not a KantelError", async () => {
		const handler = createEgressDecisionApi({
			vault: {
				decideEgress: async () => {
					throw new Error(`boom ${VALUE}`);
				},
				readConnectorCredential: async () => {
					throw new Error("boom");
				},
			},
			authenticate: async () => systemContext("egress-gateway"),
		});
		const response = await handler(
			post(EGRESS_API_PATHS.decisions, { organisationId: "org-a", method: "GET", url: "https://x.example/" }),
		);
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain(VALUE);
	});
});

describe("createSharedKeyAuthenticator", () => {
	const authenticate = createSharedKeyAuthenticator({
		keys: { "egress-gateway": GATEWAY_KEY, "model-gateway": "model-gateway-key-0123456789" },
	});
	const withHeader = (value?: string) =>
		new Request("https://vault.internal/", value === undefined ? {} : { headers: { authorization: value } });

	it("resolves the component whose key is presented", async () => {
		expect(await authenticate(withHeader(`Bearer ${GATEWAY_KEY}`))).toEqual(systemContext("egress-gateway"));
		expect(await authenticate(withHeader("Bearer model-gateway-key-0123456789"))).toEqual(
			systemContext("model-gateway"),
		);
	});

	it("refuses a missing, malformed or unknown key as forbidden without echoing it", async () => {
		for (const header of [undefined, "", GATEWAY_KEY, `Basic ${GATEWAY_KEY}`, `Bearer ${GATEWAY_KEY}x`]) {
			const error = await authenticate(withHeader(header)).catch((caught: unknown) => caught);
			expect(isKantelError(error, "forbidden"), String(header)).toBe(true);
			expect((error as KantelError).message).not.toContain(GATEWAY_KEY);
		}
	});

	it("refuses to start with a short key", () => {
		expect(() => createSharedKeyAuthenticator({ keys: { gateway: "short" } })).toThrow(
			expect.objectContaining({ code: "invalid" }),
		);
	});
});
