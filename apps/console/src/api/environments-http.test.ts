// The Environments page's API source: each of the page's calls is one call to `/v1/environments`, projects show by
// name, a session links into its project, and a gateway with the switch off lists no page.
import { DEV_ENV } from "@kantel/ui/environments/fixtures";
import { describe, expect, it } from "vitest";
import { apiEnvironments } from "./environments-http.ts";

function fakeApi(options: { switchedOff?: boolean } = {}) {
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://kantel.test"), init);
		const url = new URL(request.url);
		calls.push(`${request.method} ${url.pathname}${url.search}`);
		const path = url.pathname;
		if (path.startsWith("/v1/environments") && options.switchedOff === true)
			return Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
		if (path === "/v1/projects")
			return Response.json({ items: [{ id: DEV_ENV.owner.projectId, name: "Lleverage", organisationId: "org_acme" }] });
		if (path === "/v1/environments") return Response.json({ items: [DEV_ENV] });
		if (path === `/v1/environments/${DEV_ENV.id}`)
			return Response.json({ environment: DEV_ENV, leases: [], grants: [], events: [] });
		if (path === `/v1/environments/${DEV_ENV.id}/stop`) return Response.json({ ...DEV_ENV, state: "stopping" });
		if (path === `/v1/environments/${DEV_ENV.id}/start`) return Response.json({ ...DEV_ENV, state: "starting" });
		return Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
	};
	return { calls, fetch: fetcher as typeof fetch };
}

describe("the Environments page's API source", () => {
	it("lists, reads, starts and stops through /v1/environments", async () => {
		const api = fakeApi();
		const environments = await apiEnvironments({ fetch: api.fetch });
		expect((await environments.source.list({ projectId: DEV_ENV.owner.projectId })).map((env) => env.id)).toEqual([
			DEV_ENV.id,
		]);
		expect((await environments.source.get(DEV_ENV.id)).environment.id).toBe(DEV_ENV.id);
		expect((await environments.source.stop(DEV_ENV.id)).state).toBe("stopping");
		expect((await environments.source.start(DEV_ENV.id)).state).toBe("starting");
		expect(api.calls).toEqual([
			"GET /v1/environments",
			"GET /v1/projects?limit=200",
			`GET /v1/environments?projectId=${DEV_ENV.owner.projectId}`,
			`GET /v1/environments/${DEV_ENV.id}`,
			`POST /v1/environments/${DEV_ENV.id}/stop`,
			`POST /v1/environments/${DEV_ENV.id}/start`,
		]);
		expect(environments.directory.project(DEV_ENV.owner.projectId)).toBe("Lleverage");
		expect(environments.links.session("ses_1", DEV_ENV.owner.projectId)).toBe(
			`/projects/${DEV_ENV.owner.projectId}/sessions/ses_1`,
		);
	});

	it("lists no page when the gateway's switch is off", async () => {
		await expect(apiEnvironments({ fetch: fakeApi({ switchedOff: true }).fetch })).rejects.toThrow();
	});
});
