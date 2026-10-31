// The sharing page's API source: each of the page's calls is one call to the public API's sharing routes, with the
// contract's queries as the routes' paired filters, and the page's projects and names come from the gateway.
import type { Project } from "@kantel/contracts";
import { readOverview } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import { apiSharing, granteeQuery } from "./sharing-http.ts";

const ORG = "org_a";
const project = (id: string, name: string): Project => ({ id, organisationId: ORG, name, createdAt: 0 });
const SHARE = {
	id: "share_1",
	organisationId: ORG,
	resource: { kind: "skills.skill", id: "skill_1" },
	owner: { kind: "project", organisationId: ORG, projectId: "prj_web" },
	grantee: { kind: "project", projectId: "prj_app" },
	permission: "use",
	agentWrites: false,
	grantedBy: { kind: "human", userId: "usr_tom" },
	grantedAt: 1,
};
const REQUEST = {
	id: "req_1",
	organisationId: ORG,
	resource: { kind: "memory.space", id: "space_1" },
	owner: { kind: "project", organisationId: ORG, projectId: "prj_web" },
	grantee: { kind: "project", projectId: "prj_app" },
	permission: "propose",
	reason: "Support's tone",
	requestedBy: { kind: "human", userId: "usr_ana" },
	status: "pending",
	createdAt: 2,
};

/** A fetch that answers each route the page uses, and records what it was asked. */
function fakeApi(options: { projects?: number } = {}) {
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://harbour.test"), init);
		const url = new URL(request.url);
		const body = request.method === "GET" ? "" : await request.text();
		calls.push(`${request.method} ${url.pathname}${url.search}${body === "" ? "" : ` ${body}`}`);
		const path = url.pathname;
		if (path === "/v1/projects") {
			if (options.projects === 401) return new Response(null, { status: 401 });
			return Response.json({ items: [project("prj_web", "Website"), project("prj_app", "App")] });
		}
		if (path === "/v1/organisations") return Response.json({ items: [{ id: ORG, name: "Acme" }], current: ORG });
		if (path === "/v1/members") return Response.json({ items: [{ userId: "usr_tom", name: "Tom Davies" }] });
		if (path === "/v1/sharing/shares") return Response.json({ items: [SHARE] });
		if (path === "/v1/sharing/requests") return Response.json({ items: [REQUEST] });
		if (path === "/v1/sharing/shares/share_1/revoke") return Response.json({ ...SHARE, revokedAt: 3 });
		if (path === "/v1/sharing/requests/req_1/decision")
			return Response.json({ request: { ...REQUEST, status: "granted" }, share: SHARE });
		if (path === "/v1/sharing/requests/req_1/withdraw") return Response.json({ ...REQUEST, status: "withdrawn" });
		return new Response(null, { status: 404 });
	};
	return { calls, fetch: fetcher as typeof fetch };
}

describe("the sharing page over the API", () => {
	it("lists the projects by name and names people", async () => {
		const api = fakeApi();
		const sharing = await apiSharing({ fetch: api.fetch });
		expect(sharing.projects).toEqual([
			{ id: "prj_app", name: "App" },
			{ id: "prj_web", name: "Website" },
		]);
		expect(sharing.directory.person?.("usr_tom")).toBe("Tom Davies");
	});

	it("reads a project's four lists through the paired filters", async () => {
		const api = fakeApi();
		const { source } = await apiSharing({ fetch: api.fetch });
		api.calls.length = 0;
		const overview = await readOverview(source, "prj_app");
		expect(overview.outgoing.map((share) => share.id)).toEqual(["share_1"]);
		expect(overview.inbox.map((request) => request.id)).toEqual(["req_1"]);
		expect([...api.calls].sort()).toEqual([
			"GET /v1/sharing/requests?granteeKind=project&granteeId=prj_app&limit=100",
			"GET /v1/sharing/requests?status=pending&decidable=true&limit=100",
			"GET /v1/sharing/shares?granteeKind=project&granteeId=prj_app&limit=100",
			"GET /v1/sharing/shares?ownerProjectId=prj_app&limit=100",
		]);
	});

	it("revokes, decides and withdraws through one route each", async () => {
		const api = fakeApi();
		const { source } = await apiSharing({ fetch: api.fetch });
		api.calls.length = 0;
		expect((await source.revokeShare("share_1", "done")).revokedAt).toBe(3);
		expect((await source.decideRequest("req_1", { decision: "grant", permission: "use" })).share?.id).toBe("share_1");
		expect((await source.withdrawRequest("req_1")).status).toBe("withdrawn");
		await source.decideRequest("req_1", { decision: "grant", permission: "edit", agentWrites: true });
		expect(api.calls).toEqual([
			'POST /v1/sharing/shares/share_1/revoke {"reason":"done"}',
			'POST /v1/sharing/requests/req_1/decision {"decision":"grant","permission":"use"}',
			"POST /v1/sharing/requests/req_1/withdraw",
			'POST /v1/sharing/requests/req_1/decision {"decision":"grant","permission":"edit","agentWrites":true}',
		]);
	});

	it("says when the sign-in has ended", async () => {
		let ended = 0;
		await expect(
			apiSharing({ fetch: fakeApi({ projects: 401 }).fetch, onUnauthenticated: () => ended++ }),
		).rejects.toThrow("401");
		expect(ended).toBe(1);
	});

	it("turns each grantee into the routes' kind and ID", () => {
		expect(granteeQuery(undefined)).toEqual({});
		expect(granteeQuery({ kind: "agent", agentId: "agt_1" })).toEqual({ granteeKind: "agent", granteeId: "agt_1" });
		expect(granteeQuery({ kind: "session", sessionId: "ses_1" })).toEqual({
			granteeKind: "session",
			granteeId: "ses_1",
		});
	});
});
