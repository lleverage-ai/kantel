// The Tool servers page's API source: each of the page's calls is one call to `/v1/tool-servers` (two to turn a tool
// on or off), a new server's token comes back once, and a gateway with the switch off lists no page.
import type { IssuedToolServerToken, ToolServer, ToolServerToken } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { AUDIT_PATH } from "../app/router.ts";
import { apiToolServers, disabledToolsWith } from "./tool-servers-http.ts";

const ORG = "org_a";
const ME = { organisationId: ORG } as const;

const SERVER: ToolServer = {
	id: "ts_1",
	organisationId: ORG,
	name: "warehouse",
	transport: "tunnel",
	snapshot: {
		tools: [
			{ name: "query", description: "Runs a query.", inputSchema: { type: "object" }, replay: "safe" },
			{ name: "drop", description: "Drops a table.", inputSchema: { type: "object" }, replay: "unsafe" },
		],
		hash: "sha256:abc",
		takenAt: 1,
	},
	disabledTools: ["drop"],
	connection: { status: "connected", connectedAt: 1, lastSeenAt: 2 },
	createdBy: { kind: "human", userId: "usr_tom" },
	createdAt: 1,
	updatedAt: 1,
};
const TOKEN: ToolServerToken = {
	id: "tst_1",
	toolServerId: "ts_1",
	prefix: "hbt_abcd",
	createdBy: { kind: "human", userId: "usr_tom" },
	createdAt: 1,
};
const ISSUED: IssuedToolServerToken = { token: TOKEN, secret: "hbt_abcdefgh" };

/** A fetch that answers each route the page uses, and records what it was asked. */
function fakeApi(options: { switchedOff?: boolean } = {}) {
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://harbour.test"), init);
		const url = new URL(request.url);
		const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
		calls.push(`${request.method} ${url.pathname}${url.search}${body === "" ? "" : ` ${body}`}`);
		const path = url.pathname;
		if (path.startsWith("/v1/tool-servers") && options.switchedOff === true)
			return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
		if (path === "/v1/projects")
			return Response.json({ items: [{ id: "prj_web", organisationId: ORG, name: "Website", createdAt: 0 }] });
		if (path === "/v1/organisations") return Response.json({ items: [{ id: ORG, name: "Acme" }], current: ORG });
		if (path === "/v1/tool-servers" && request.method === "GET") return Response.json({ items: [SERVER] });
		if (path === "/v1/tool-servers" && request.method === "POST") {
			const made = JSON.parse(body) as { name: string; projectId?: string };
			return Response.json(
				{ server: { ...SERVER, id: "ts_2", name: made.name, projectId: made.projectId }, token: ISSUED },
				{ status: 201 },
			);
		}
		if (path === "/v1/tool-servers/ts_1" && request.method === "GET") return Response.json(SERVER);
		if (path === "/v1/tool-servers/ts_1" && request.method === "PATCH") return Response.json(SERVER);
		if (path === "/v1/tool-servers/ts_1/tokens" && request.method === "GET") return Response.json({ items: [TOKEN] });
		if (path === "/v1/tool-servers/ts_1/tokens/tst_1" && request.method === "DELETE")
			return new Response(null, { status: 204 });
		return new Response(null, { status: 404 });
	};
	return { calls, fetch: fetcher as typeof fetch };
}

describe("the Tool servers page over the API", () => {
	it("isn't offered on a gateway that answers 404, the switch off", async () => {
		await expect(apiToolServers(ME, { fetch: fakeApi({ switchedOff: true }).fetch })).rejects.toThrow();
	});

	it("names the organisation and the projects the viewer may see, and Harbour's address", async () => {
		const toolServers = await apiToolServers(ME, { fetch: fakeApi().fetch, origin: "https://harbour.test" });
		expect(toolServers.organisation).toBe("Acme");
		expect(toolServers.projects).toEqual([{ id: "prj_web", name: "Website" }]);
		expect(toolServers.origin).toBe("https://harbour.test");
		expect(toolServers.source.stats).toBeUndefined();
	});

	it("lists the servers, for a project its own and the organisation's", async () => {
		const api = fakeApi();
		const { source } = await apiToolServers(ME, { fetch: api.fetch });
		expect((await source.list()).map((server) => server.id)).toEqual(["ts_1"]);
		await source.list({ projectId: "prj_web" });
		expect(api.calls).toContain("GET /v1/tool-servers?limit=200");
		expect(api.calls).toContain("GET /v1/tool-servers?limit=200&projectId=prj_web");
	});

	it("registers a server and gives its one-time token", async () => {
		const api = fakeApi();
		const { source } = await apiToolServers(ME, { fetch: api.fetch });
		const created = await source.create({ name: "billing", transport: "tunnel", projectId: "prj_web" });
		expect(created.server).toMatchObject({ id: "ts_2", name: "billing", projectId: "prj_web" });
		expect(created.token?.secret).toBe("hbt_abcdefgh");
		expect(api.calls).toContain('POST /v1/tool-servers {"name":"billing","transport":"tunnel","projectId":"prj_web"}');
	});

	it("turns a tool on or off by replacing the server's disabled list as it is now", async () => {
		const api = fakeApi();
		const { source } = await apiToolServers(ME, { fetch: api.fetch });
		await source.setToolEnabled("ts_1", "query", false);
		await source.setToolEnabled("ts_1", "drop", true);
		expect(api.calls.filter((call) => call.startsWith("PATCH"))).toEqual([
			'PATCH /v1/tool-servers/ts_1 {"disabledTools":["drop","query"]}',
			'PATCH /v1/tool-servers/ts_1 {"disabledTools":[]}',
		]);
		expect(disabledToolsWith(["drop"], "drop", false)).toEqual(["drop"]);
	});

	it("lists and revokes a server's tunnel tokens", async () => {
		const api = fakeApi();
		const { source } = await apiToolServers(ME, { fetch: api.fetch });
		expect(await source.listTokens("ts_1")).toEqual([TOKEN]);
		await source.revokeToken("ts_1", "tst_1");
		expect(api.calls).toContain("DELETE /v1/tool-servers/ts_1/tokens/tst_1");
	});

	it("lists no calls, which the audit API can't filter by server, and opens the audit log", async () => {
		const { source } = await apiToolServers(ME, { fetch: fakeApi().fetch });
		expect(await source.recentCalls("ts_1")).toEqual([]);
		expect(source.auditHref("ts_1")).toBe(AUDIT_PATH);
	});

	it("says when the sign-in has ended", async () => {
		let ended = 0;
		await expect(
			apiToolServers(ME, {
				fetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
				onUnauthenticated: () => ended++,
			}),
		).rejects.toThrow();
		expect(ended).toBeGreaterThan(0);
	});
});
