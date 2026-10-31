// The Connections page's API source: each of the page's calls is one or two calls to `/v1/connections`, the contract's
// shapes become the page's, and nothing secret comes back.
import type {
	CatalogueEntry,
	ConnectAttempt,
	Connection,
	ConnectionUse,
	OAuthClient,
	ProviderTemplate,
} from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import {
	apiConnections,
	connectionView,
	disconnectResult,
	entryView,
	failureOf,
	serverNameOf,
	summaryOf,
} from "./connections-http.ts";

const ORG = "org_a";
const ME = {
	actor: { kind: "human", userId: "usr_tom" },
	organisationId: ORG,
	name: "Tom Davies",
	roles: [{ role: "admin" }],
} as const;

const ENTRY: CatalogueEntry = {
	id: "github",
	version: 1,
	name: "GitHub",
	description: "Repositories, issues and pull requests. Every request goes out as you.",
	icon: "data:image/svg+xml,x",
	docsUrl: "https://docs.github.com",
	category: "developer",
	kind: "http",
	authTypes: ["oauth2", "bearer"],
	source: "shipped",
	setup: "ready",
	tier: "public_client",
	signIn: "device",
	scopeSets: [],
	client: { tier: "platform", ownerLabel: "Kantel", public: true },
};
const LINEAR: CatalogueEntry = {
	...ENTRY,
	id: "linear-mcp",
	name: "Linear",
	kind: "mcp",
	authTypes: ["oauth2"],
	mcpUrl: "https://mcp.linear.app/mcp",
	category: "project_management",
	setup: "ready",
};
const TEMPLATE: ProviderTemplate = {
	id: "github",
	version: 1,
	name: "GitHub",
	description: ENTRY.description,
	icon: ENTRY.icon,
	docsUrl: ENTRY.docsUrl,
	category: "developer",
	kind: "http",
	authTypes: ["oauth2", "bearer"],
	apiHosts: ["api.github.com"],
	scopeSets: [{ id: "read", label: "Read", access: "read", scopes: ["repo:read"], default: true }],
	endpointHints: [],
	key: { injection: { kind: "bearer" }, shapes: [{ label: "a GitHub token", prefix: "ghp_" }] },
	source: "shipped",
};
const CONNECTION: Connection = {
	id: "conn_1",
	organisationId: ORG,
	owner: { kind: "organisation", organisationId: ORG },
	name: "Release bot",
	templateId: "github",
	kind: "http",
	auth: "oauth2",
	hosts: ["api.github.com"],
	account: { name: "acme-release-bot" },
	scopes: { requested: ["repo:read"], granted: ["repo:read"] },
	usage: { projects: ["prj_web"], unattended: true, visibility: "shared" },
	status: "needs_reauth",
	credential: { set: true, refreshable: true },
	createdBy: { kind: "human", userId: "usr_tom" },
	createdAt: 1,
	updatedAt: 1,
};
const KEY_CONNECTION: Connection = {
	...CONNECTION,
	id: "conn_key",
	name: "Status API",
	templateId: undefined as unknown as string,
	auth: "key",
	account: undefined as unknown as Connection["account"],
	status: "failing_test",
	credential: { set: true, last4: "9z9z", refreshable: false },
};
const PENDING: ConnectAttempt = {
	id: "ca_1",
	organisationId: ORG,
	status: "pending",
	connectUrl: "https://harbour.test/v1/connections/authorize/ca_1",
	owner: { kind: "user", organisationId: ORG, userId: "usr_tom" },
	templateId: "github",
	createdBy: { kind: "human", userId: "usr_tom" },
	createdAt: 1,
	expiresAt: 900_001,
};
const CLIENT: OAuthClient = {
	id: "oc_1",
	owner: { kind: "platform" },
	templateId: "github",
	label: "Kantel's GitHub app",
	clientId: "Iv1.abc",
	secret: { set: true, last4: "41b0", refreshable: false },
	redirectUri: "https://harbour.test/v1/connections/callback",
	disabled: false,
	connections: 2,
	createdBy: { kind: "system", component: "deploy" },
	createdAt: 1,
	updatedAt: 1,
};

const strip = <T extends object>(value: T): T =>
	Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** A fetch that answers each route the page uses, and records what it was asked. */
function fakeApi(
	options: {
		catalogue?: number;
		attempt?: ConnectAttempt;
		uses?: { items: ConnectionUse[]; nextCursor?: string };
		refuse?: { message: string; failure: string };
		/** `GET /v1/connections/settings`'s answer; absent, a gateway without the route. */
		settings?: { personal: boolean };
	} = {},
) {
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://harbour.test"), init);
		const url = new URL(request.url);
		const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
		calls.push(`${request.method} ${url.pathname}${url.search}${body === "" ? "" : ` ${body}`}`);
		const path = url.pathname;
		if (path === "/v1/connections/catalogue") {
			if (options.catalogue !== undefined) return new Response(null, { status: options.catalogue });
			return Response.json({ items: [ENTRY, LINEAR] });
		}
		if (path === "/v1/connections/catalogue/github") return Response.json(TEMPLATE);
		if (path === "/v1/connections/settings" && options.settings !== undefined) return Response.json(options.settings);
		if (path === "/v1/projects")
			return Response.json({ items: [{ id: "prj_web", organisationId: ORG, name: "Website", createdAt: 0 }] });
		if (path === "/v1/organisations") return Response.json({ items: [{ id: ORG, name: "Acme" }], current: ORG });
		if (path === "/v1/members") return Response.json({ items: [{ userId: "usr_tom", name: "Tom Davies" }] });
		if (path === "/v1/connections" && request.method === "GET")
			return Response.json({ items: [CONNECTION, strip(KEY_CONNECTION)] });
		if (path === "/v1/connections/conn_1" && request.method === "GET") return Response.json(CONNECTION);
		if (path === "/v1/connections/ceiling") return Response.json({ set: false, routes: [] });
		if (path === "/v1/connections/conn_1/shares" && request.method === "POST") {
			const { projectId } = JSON.parse(body) as { projectId: string };
			return Response.json({
				...CONNECTION,
				owner: { kind: "user", organisationId: ORG, userId: "usr_tom" },
				shares: [{ projectId, sharedBy: { kind: "human", userId: "usr_tom" }, sharedAt: 5 }],
			});
		}
		if (path === "/v1/connections/conn_1/shares/prj_web" && request.method === "DELETE")
			return Response.json({ ...CONNECTION, shares: [] });
		if (path === "/v1/connections/eligible") {
			const asked = url.searchParams.get("visibility");
			return Response.json({
				items: [
					{
						connection: {
							id: "conn_1",
							name: "GitHub",
							kind: "http",
							templateId: "github",
							owner: "user",
							account: { name: "tvdavies" },
							hosts: ["api.github.com"],
						},
						ownerId: "usr_tom",
						usable: asked === "private",
						...(asked === "private" ? {} : { reason: "It is private" }),
					},
					{
						connection: { id: "conn_9", name: "Linear", kind: "mcp", owner: "user", hosts: [] },
						ownerId: "usr_ana",
						usable: true,
						viaShare: true,
					},
				],
			});
		}
		if (path.startsWith("/v1/sessions/")) {
			const id = path.slice("/v1/sessions/".length);
			if (request.method === "PATCH") return Response.json({ id, ...JSON.parse(body) });
			const records: Record<string, object> = {
				ses_mine: { id, userId: "usr_tom", visibility: "private" },
				ses_shared: { id, userId: "usr_tom" },
				ses_theirs: { id, userId: "usr_ana", visibility: "shared" },
				ses_child: { id, userId: "usr_tom", parentSessionId: "ses_mine", visibility: "private" },
			};
			const found = records[id];
			if (found !== undefined)
				return Response.json({
					organisationId: ORG,
					projectId: "prj_web",
					agentId: "a",
					status: "idle",
					labels: {},
					createdBy: { kind: "human", userId: "usr_tom" },
					createdAt: 0,
					updatedAt: 0,
					...found,
				});
		}
		if (path === "/v1/connections/conn_1/rules/dry-run")
			return Response.json({
				action: "deny",
				by: { kind: "rule", ruleId: "cr_1" },
				reason: "Any agent: DELETE /repos/** is blocked",
				rulesVersion: 2,
			});
		if (path === "/v1/connections/conn_1/rules/cr_1" && request.method === "DELETE")
			return new Response(null, { status: 204 });
		if (path.startsWith("/v1/connections/conn_1/rules")) {
			const rule = {
				id: "cr_1",
				connectionId: "conn_1",
				who: { kind: "any" },
				what: { kind: "endpoint", method: "DELETE", path: "/repos/**" },
				action: "deny",
				uses: 0,
				source: "person",
				createdBy: { kind: "human", userId: "usr_tom" },
				createdAt: 1,
				updatedAt: 1,
			};
			if (request.method === "POST") return Response.json(rule, { status: 201 });
			if (path.endsWith("/cr_1")) return Response.json(rule);
			return Response.json({ connectionId: "conn_1", rules: [], unmatched: "allow", version: 0 });
		}
		if (path.startsWith("/v1/connections/conn_") && request.method === "DELETE") {
			const connectionId = path.split("/")[3]!;
			const revocation =
				connectionId === "conn_key"
					? { outcome: "unsupported", reason: "A key can only be revoked at Linear itself; Kantel deleted its copy" }
					: connectionId === "conn_failed"
						? {
								outcome: "failed",
								endpoint: "https://oauth2.googleapis.com/revoke",
								reason: "The provider refused the revocation (temporarily_unavailable)",
								manageUrl: "https://myaccount.google.com/connections",
							}
						: { outcome: "revoked", endpoint: "https://api.github.com/applications/Iv1.abc/grant" };
			return Response.json({ connectionId, revocation, rulesRemoved: 0, approvalsWithdrawn: 0 });
		}
		if (path === "/v1/connections/uses") {
			const connectionId = url.searchParams.get("connectionId");
			const items = options.uses?.items ?? [];
			return connectionId === null
				? Response.json(options.uses ?? { items: [] })
				: Response.json({ items: items.filter((use) => use.connectionId === connectionId) });
		}
		if (path === "/v1/connections/connect" && options.refuse !== undefined)
			return Response.json(
				{ error: { code: "refused", message: options.refuse.message, details: { failure: options.refuse.failure } } },
				{ status: 409 },
			);
		if (path === "/v1/connections/connect") return Response.json(PENDING, { status: 201 });
		if (path === "/v1/connections/connect/ca_1") return Response.json(options.attempt ?? PENDING);
		if (path === "/v1/connections/keys")
			return Response.json(strip({ ...KEY_CONNECTION, status: "active", account: { name: "Acme" } }), { status: 201 });
		if (path === "/v1/connections/discover")
			return Response.json({ url: "https://mcp.notion.com/mcp", auth: "oauth", registration: ["cimd"] });
		if (path === "/v1/connections/clients" && request.method === "GET") return Response.json({ items: [CLIENT] });
		if (path === "/v1/connections/clients" && request.method === "POST")
			return Response.json(
				{ ...CLIENT, id: "oc_2", owner: { kind: "organisation", organisationId: ORG } },
				{ status: 201 },
			);
		return new Response(null, { status: 404 });
	};
	return { calls, fetch: fetcher as typeof fetch };
}

describe("the Connections page over the API", () => {
	it("isn't offered on a gateway that doesn't serve the routes", async () => {
		await expect(apiConnections(ME, { fetch: fakeApi({ catalogue: 404 }).fetch })).rejects.toThrow();
	});

	it("knows the viewer: their name, projects, organisation and admin role", async () => {
		const connections = await apiConnections(ME, { fetch: fakeApi().fetch, origin: "https://harbour.test" });
		expect(connections.viewer).toEqual({
			userId: "usr_tom",
			name: "Tom Davies",
			organisation: "Acme",
			projects: [{ id: "prj_web", name: "Website" }],
			admin: true,
			host: "Kantel",
			personal: false,
		});
		expect(connections.redirectUri).toBe("https://harbour.test/v1/connections/callback");
	});

	it("shares and unshares a person's connection, showing its shares by project and who shared it (#335)", async () => {
		const api = fakeApi();
		const { source } = await apiConnections(ME, { fetch: api.fetch });
		const shared = await source.sharing!.share("conn_1", "prj_web");
		expect(shared.shares).toEqual([{ projectId: "prj_web", sharedAt: 5, sharedBy: "Tom Davies" }]);
		expect((await source.sharing!.unshare("conn_1", "prj_web")).shares).toBeUndefined();
		expect(api.calls).toEqual(
			expect.arrayContaining([
				'POST /v1/connections/conn_1/shares {"projectId":"prj_web"}',
				"DELETE /v1/connections/conn_1/shares/prj_web",
			]),
		);
	});

	it("reads and changes who can see a session, with the connections each choice allows (#335)", async () => {
		const api = fakeApi({ settings: { personal: false } });
		const connections = await apiConnections(ME, { fetch: api.fetch });
		const mine = connections.sessionVisibility!("ses_mine");
		expect(await mine.read()).toEqual({ visibility: "private" });
		expect(await connections.sessionVisibility!("ses_shared").read()).toEqual({ visibility: "shared" });
		expect(await connections.sessionVisibility!("ses_theirs").read()).toEqual({
			visibility: "shared",
			locked: "Only the person this session acts for can change who sees it.",
		});
		expect((await connections.sessionVisibility!("ses_child").read())?.locked).toMatch(/subagent/);
		expect(await connections.sessionVisibility!("ses_missing").read()).toBeUndefined();
		const shared = await mine.source.connections("shared");
		expect(shared).toEqual([
			{
				id: "conn_1",
				name: "GitHub",
				account: "tvdavies",
				owner: "user",
				ownerLabel: "Yours",
				usable: false,
				reason: "It is private",
			},
			{ id: "conn_9", name: "Linear", owner: "user", ownerLabel: "A teammate's", usable: true, viaShare: true },
		]);
		expect((await mine.source.connections("private"))[0]).toMatchObject({ usable: true });
		await mine.source.setVisibility("shared");
		expect(api.calls).toEqual(
			expect.arrayContaining([
				"GET /v1/connections/eligible?sessionId=ses_mine&visibility=shared",
				'PATCH /v1/sessions/ses_mine {"visibility":"shared"}',
			]),
		);
	});

	it("offers no session visibility in a one-person deployment, where every session is the person's own", async () => {
		const connections = await apiConnections(ME, { fetch: fakeApi({ settings: { personal: true } }).fetch });
		expect(connections.sessionVisibility).toBeUndefined();
	});

	it("asks the deployment whether a person's own connections work in their sessions", async () => {
		const on = await apiConnections(ME, { fetch: fakeApi({ settings: { personal: true } }).fetch });
		expect(on.viewer.personal).toBe(true);
		const off = await apiConnections(ME, { fetch: fakeApi({ settings: { personal: false } }).fetch });
		expect(off.viewer.personal).toBe(false);
	});

	it("marks a server that needs no sign-in, so the OAuth clients form leaves it out", () => {
		const open: CatalogueEntry = { ...LINEAR, id: "deepwiki", name: "DeepWiki", authTypes: ["none"] };
		expect(entryView(open)).toMatchObject({ authTypes: ["mcp_oauth"], open: true });
		expect(entryView(LINEAR).open).toBeUndefined();
		expect(entryView(ENTRY).open).toBeUndefined();
	});

	it("lists the catalogue as cards and reads a template in full for its page", async () => {
		const { source } = await apiConnections(ME, { fetch: fakeApi().fetch });
		const cards = await source.catalogue();
		expect(cards.map((card) => [card.id, card.category, card.authTypes])).toEqual([
			["github", "Developer tools", ["oauth2", "bearer"]],
			["linear-mcp", "Project management", ["mcp_oauth"]],
		]);
		const full = await source.template?.("github");
		expect(full?.apiHosts).toEqual(["api.github.com"]);
		expect(full?.keyShapes).toEqual([{ label: "a GitHub token", prefix: "ghp_" }]);
		expect(full?.setup).toBe("ready");
	});

	it("shows a connection named other than its template under the template's name, with its label", async () => {
		const { source } = await apiConnections(ME, { fetch: fakeApi().fetch });
		const [oauth, key] = await source.connections();
		expect(oauth).toMatchObject({
			name: "GitHub",
			label: "Release bot",
			account: "acme-release-bot",
			health: "needs_reconnect",
			kind: "oauth",
			onlyProjects: ["prj_web"],
		});
		expect(key).toMatchObject({ name: "Status API", kind: "key", key: { set: true, last4: "9z9z" } });
	});

	it("says when each connection was last used, from its newest allowed use", async () => {
		const use = (connectionId: string, at: number, outcome: ConnectionUse["outcome"] = "allowed"): ConnectionUse => ({
			id: `cu_${connectionId}_${at}`,
			connectionId,
			organisationId: ORG,
			sessionId: "ses_1",
			kind: "http",
			method: "GET",
			host: "api.github.com",
			path: "/user",
			audience: { kind: "shared" },
			outcome,
			at,
		});
		// The first page holds conn_1's uses only, newest first, and says there are more: conn_key is asked after alone.
		const api = fakeApi({
			uses: { items: [use("conn_1", 30, "denied"), use("conn_1", 20), use("conn_1", 10)], nextCursor: "next" },
		});
		const { source } = await apiConnections(ME, { fetch: api.fetch });
		let [oauth, key] = await source.connections();
		expect(oauth?.lastUsedAt).toBe(20);
		expect(key?.lastUsedAt).toBeUndefined();
		expect(api.calls).toContain("GET /v1/connections/uses?connectionId=conn_key&limit=20");
		// A gateway that can't list uses still lists the connections.
		const failing = fakeApi();
		const bare = await apiConnections(ME, {
			fetch: (async (input: string | URL | Request, init?: RequestInit) =>
				String(input).includes("/connections/uses")
					? new Response(null, { status: 500 })
					: failing.fetch(input, init)) as typeof fetch,
		});
		[oauth, key] = await bare.source.connections();
		expect(oauth?.lastUsedAt).toBeUndefined();
		expect(key?.name).toBe("Status API");
	});

	it("puts a refused connect start in the page's words", async () => {
		const api = fakeApi({
			refuse: { failure: "no_client", message: "GitHub needs an OAuth app registered first" },
		});
		const { source } = await apiConnections(ME, { fetch: api.fetch });
		await expect(source.connect({ templateId: "github", owner: { kind: "user" } })).rejects.toThrow(
			"There's no OAuth client for this service yet. An admin can add one in OAuth clients. (GitHub needs an OAuth app registered first)",
		);
		const other = fakeApi({ refuse: { failure: "something_else", message: "No" } });
		const second = await apiConnections(ME, { fetch: other.fetch });
		await expect(second.source.connect({ templateId: "github", owner: { kind: "user" } })).rejects.toThrow("No");
	});

	it("starts a connect for the viewer and follows it to the connection", async () => {
		const api = fakeApi({ attempt: { ...PENDING, status: "completed", connectionId: "conn_1" } });
		const { source } = await apiConnections(ME, { fetch: api.fetch });
		api.calls.length = 0;
		const start = await source.connect({ templateId: "github", owner: { kind: "user" }, scopeSets: ["read"] });
		expect(start).toEqual({ attemptId: "ca_1", url: PENDING.connectUrl, expiresAt: 900_001 });
		const settled = await source.attempt("ca_1");
		expect(settled.status === "connected" ? settled.connection.id : undefined).toBe("conn_1");
		expect(api.calls[0]).toBe(
			`POST /v1/connections/connect {"templateId":"github","owner":{"kind":"user","organisationId":"${ORG}","userId":"usr_tom"},"scopeSets":["read"]}`,
		);
	});

	it("stores a custom key once, with its hosts and header, and says the test passed", async () => {
		const api = fakeApi();
		const { source } = await apiConnections(ME, { fetch: api.fetch });
		api.calls.length = 0;
		const result = await source.connectKey({
			name: "Status API",
			hosts: ["status.acme.dev"],
			injection: { kind: "header", name: "X-Api-Key" },
			owner: { kind: "organisation" },
			key: "sk_secret_value",
		});
		expect(result.test).toEqual({ ok: true, account: "Acme" });
		expect(JSON.parse(api.calls[0]?.replace(/^POST \/v1\/connections\/keys /, "") ?? "{}")).toEqual({
			owner: { kind: "organisation", organisationId: ORG },
			value: "sk_secret_value",
			name: "Status API",
			custom: { kind: "http", hosts: ["status.acme.dev"], injection: { kind: "header", header: "X-Api-Key" } },
		});
		expect(JSON.stringify(result)).not.toContain("sk_secret_value");
	});

	it("adds a remote MCP server: discovers it, then starts its connect", async () => {
		const api = fakeApi();
		const { source } = await apiConnections(ME, { fetch: api.fetch });
		api.calls.length = 0;
		const start = await source.addMcpServer({ url: "https://mcp.notion.com/mcp", owner: { kind: "user" } });
		expect(start).toMatchObject({ auth: "oauth", serverName: "Notion", attemptId: "ca_1" });
		expect(api.calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
			"POST /v1/connections/discover",
			"POST /v1/connections/connect",
		]);
	});

	it("disconnects, and says what the provider did with the access (#329)", async () => {
		const { source } = await apiConnections(ME, { fetch: fakeApi().fetch });
		expect(await source.disconnect("conn_1")).toEqual({ revoked: true });
		expect(await source.disconnect("conn_key")).toEqual({
			revoked: "unsupported",
			reason: "A key can only be revoked at Linear itself; Kantel deleted its copy",
		});
		expect(await source.disconnect("conn_failed")).toEqual({
			revoked: false,
			reason: "The provider refused the revocation (temporarily_unavailable)",
			revokeUrl: "https://myaccount.google.com/connections",
		});
	});

	it("reads an answer with no revocation, from a server before #329, as unknown", () => {
		expect(disconnectResult(undefined)).toEqual({ revoked: "unknown" });
		expect(
			disconnectResult({
				connectionId: "c",
				revocation: { outcome: "none" },
				rulesRemoved: 0,
				approvalsWithdrawn: 0,
			}),
		).toEqual({ revoked: "none" });
	});

	it("names the host's own clients and keeps only a secret's last four", async () => {
		const { source } = await apiConnections(ME, { fetch: fakeApi().fetch, hostName: "Lleverage" });
		const [client] = await source.clients();
		expect(client).toMatchObject({
			tier: "deployment",
			ownerLabel: "Lleverage",
			secret: { set: true, last4: "41b0" },
			pinnedConnections: 2,
		});
		const made = await source.createClient({
			templateId: "github",
			tier: "organisation",
			clientId: "Iv1.abc",
			clientSecret: "shh-secret",
		});
		expect(made.tier).toBe("organisation");
		expect(JSON.stringify(made)).not.toContain("shh-secret");
	});
});

describe("mapping the contract", () => {
	it("takes a card's summary from the first sentence", () => {
		expect(summaryOf("Repositories and issues. More here.")).toBe("Repositories and issues.");
		expect(summaryOf("No full stop")).toBe("No full stop");
		expect(entryView(ENTRY).summary).toBe("Repositories, issues and pull requests.");
	});

	it("names a server from its host", () => {
		expect(serverNameOf("https://mcp.notion.com/mcp")).toBe("Notion");
		expect(serverNameOf("https://api.example.co/mcp", " Mine ")).toBe("Mine");
	});

	it("turns failure codes into the page's reasons", () => {
		expect(failureOf({ ...PENDING, status: "expired" })).toEqual({ status: "failed", reason: "expired" });
		expect(failureOf({ ...PENDING, status: "failed", failure: { code: "user_mismatch", message: "x" } })).toEqual({
			status: "failed",
			reason: "user_mismatch",
		});
		expect(
			failureOf({ ...PENDING, status: "failed", failure: { code: "exchange_failed", message: "Token refused" } }),
		).toEqual({ status: "failed", reason: "provider_error", message: "Token refused" });
	});

	it("shows a disabled connection as disabled", () => {
		expect(connectionView({ ...CONNECTION, status: "disabled" }, { templates: new Map() }).health).toBe("disabled");
		expect(
			connectionView(
				{ ...CONNECTION, status: "disabled", health: { state: "needs_reconnect", since: 1 } },
				{ templates: new Map() },
			).health,
		).toBe("disabled");
	});

	it("shows the health Kantel's refreshes found (#328): failing for now with its retry, or needing a reconnect", () => {
		const failing = connectionView(
			{
				...CONNECTION,
				status: "active",
				health: {
					state: "refresh_failing",
					since: 1,
					reason: "The token endpoint answered 503",
					failures: 2,
					retryAt: 120_000,
				},
			},
			{ templates: new Map() },
		);
		expect(failing).toMatchObject({
			health: "refresh_failing",
			lastError: "The token endpoint answered 503",
			retryAt: 120_000,
		});
		const refused = connectionView(
			{
				...CONNECTION,
				health: { state: "needs_reconnect", since: 1, reason: "GitHub refused the refresh token (invalid_grant)" },
			},
			{ templates: new Map() },
		);
		expect(refused).toMatchObject({
			health: "needs_reconnect",
			lastError: "GitHub refused the refresh token (invalid_grant)",
		});
		expect(refused.retryAt).toBeUndefined();
		const ok = connectionView(
			{ ...CONNECTION, status: "active", health: { state: "ok", since: 1, refreshedAt: 1 } },
			{ templates: new Map() },
		);
		expect(ok.health).toBe("healthy");
		expect(ok.lastError).toBeUndefined();
	});

	it("edits a connection's rules with one API call each, and tries a request through the dry run", async () => {
		const api = fakeApi();
		const { source } = await apiConnections(ME, { fetch: api.fetch });
		const rules = source.rules;
		if (rules === undefined) throw new Error("no rules source");
		api.calls.length = 0;
		const got = await rules.get("conn_1");
		expect(got).toMatchObject({ connectionId: "conn_1", unmatched: "allow", version: 0 });
		await rules.update("conn_1", { unmatched: "deny" });
		await rules.create("conn_1", {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "DELETE", path: "/repos/**" },
			action: "deny",
		});
		await rules.updateRule("conn_1", "cr_1", { maxUses: null });
		await rules.remove("conn_1", "cr_1");
		const decision = await rules.dryRun("conn_1", { method: "DELETE", url: "https://api.github.com/repos/a/b" });
		expect(decision).toMatchObject({ action: "deny", by: { kind: "rule", ruleId: "cr_1" } });
		expect(await rules.ceiling()).toEqual({ set: false, routes: [] });
		expect(api.calls).toEqual([
			"GET /v1/connections/conn_1/rules",
			'PATCH /v1/connections/conn_1/rules {"unmatched":"deny"}',
			'POST /v1/connections/conn_1/rules {"who":{"kind":"any"},"what":{"kind":"endpoint","method":"DELETE","path":"/repos/**"},"action":"deny"}',
			'PATCH /v1/connections/conn_1/rules/cr_1 {"maxUses":null}',
			"DELETE /v1/connections/conn_1/rules/cr_1",
			'POST /v1/connections/conn_1/rules/dry-run {"method":"DELETE","url":"https://api.github.com/repos/a/b"}',
			"GET /v1/connections/ceiling",
		]);
	});
});
