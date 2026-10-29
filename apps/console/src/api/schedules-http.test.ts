// The schedules page's API source: each of the page's calls is one call to the public API's schedule routes, and the
// form's settings come from the person's roles, projects and agent profiles.
import type { AgentProfile, MeResponse, Project, ScheduleInput } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { apiSchedules, formSettings, operableProject, scheduleDirectory } from "./schedules-http.ts";

const ORG = "org_a";
const project = (id: string, name: string): Project => ({ id, organisationId: ORG, name, createdAt: 0 });
const profile = (id: string, name: string) => ({ id, name }) as AgentProfile;
const me = (roles: MeResponse["roles"]): MeResponse => ({
	actor: { kind: "human", userId: "usr_tom" },
	organisationId: ORG,
	method: "cloudflare_access",
	name: "Tom",
	roles,
});

const SCHEDULE = {
	id: "sch_1",
	organisationId: ORG,
	owner: { kind: "project", organisationId: ORG, projectId: "prj_web" },
	kind: "task",
	title: "Triage",
	timezone: "Europe/London",
	repeat: { every: "day", at: "09:00" },
	payload: { agentId: "agt_1", prompt: "Triage the new issues." },
	status: "active",
	occurrences: 0,
	createdAt: 0,
	updatedAt: 0,
};

/** A fetch that answers each route the page uses, and records what it was asked. */
function fakeApi() {
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://harbour.test"), init);
		const url = new URL(request.url);
		const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
		calls.push(`${request.method} ${url.pathname}${url.search}${body === "" ? "" : ` ${body}`}`);
		const path = url.pathname;
		if (path === "/v1/projects") return Response.json({ items: [project("prj_web", "Website")] });
		if (path === "/v1/profiles") return Response.json({ items: [profile("agt_1", "Triage")] });
		if (path === "/v1/organisations") return Response.json({ items: [{ id: ORG, name: "Acme" }], current: ORG });
		if (path === "/v1/members") return Response.json({ items: [{ userId: "usr_tom", name: "Tom Davies" }] });
		if (path === "/v1/schedules" && request.method === "GET")
			return Response.json({ items: [SCHEDULE], nextCursor: "c2" });
		if (path === "/v1/schedules/sch_1/preview") return Response.json({ dueAt: [1, 2, 3] });
		if (path === "/v1/schedules/sch_1/runs") {
			return Response.json({
				items: [{ id: "sch_1@1", scheduleId: "sch_1", dueAt: 1, coalesced: 1, status: "succeeded", attempt: 1 }],
			});
		}
		if (path === "/v1/schedules/sch_1/pause") return Response.json({ ...SCHEDULE, status: "paused" });
		if (path === "/v1/schedules/sch_1/resume") return Response.json(SCHEDULE);
		if (path === "/v1/schedules/sch_1" && request.method === "DELETE")
			return Response.json({ ...SCHEDULE, status: "ended" });
		if (path.startsWith("/v1/schedules"))
			return Response.json(SCHEDULE, { status: request.method === "POST" ? 201 : 200 });
		return new Response(null, { status: 404 });
	};
	return { calls, fetch: fetcher as typeof fetch };
}

describe("the schedules page on the API", () => {
	it("makes each of the page's calls one call to the schedule routes", async () => {
		const api = fakeApi();
		const schedules = await apiSchedules(me([{ role: "operator" }]), { fetch: api.fetch });
		api.calls.length = 0;
		const { source } = schedules;

		expect(await source.list({ status: "active" }, { limit: 50 })).toEqual({ items: [SCHEDULE], nextCursor: "c2" });
		expect(await source.get("sch_1")).toEqual(SCHEDULE);
		expect(await source.preview("sch_1", 3)).toEqual([1, 2, 3]);
		expect((await source.listOccurrences("sch_1", { cursor: "c1" })).items).toHaveLength(1);
		const input: ScheduleInput = {
			owner: { kind: "project", organisationId: ORG, projectId: "prj_web" },
			kind: "task",
			title: "Triage",
			timezone: "Europe/London",
			at: 5,
			payload: { agentId: "agt_1", prompt: "Triage the new issues." },
		};
		await source.create(input);
		await source.update("sch_1", { title: "Triage again", until: null });
		expect((await source.pause("sch_1")).status).toBe("paused");
		expect((await source.resume("sch_1")).status).toBe("active");
		expect((await source.end("sch_1")).status).toBe("ended");

		expect(api.calls).toEqual([
			"GET /v1/schedules?status=active&limit=50",
			"GET /v1/schedules/sch_1",
			"GET /v1/schedules/sch_1/preview?n=3",
			"GET /v1/schedules/sch_1/runs?cursor=c1",
			`POST /v1/schedules ${JSON.stringify(input)}`,
			'PATCH /v1/schedules/sch_1 {"title":"Triage again","until":null}',
			"POST /v1/schedules/sch_1/pause",
			"POST /v1/schedules/sch_1/resume",
			"DELETE /v1/schedules/sch_1",
		]);
	});

	it("offers New schedule in the first project the person operates, with the agents by name", async () => {
		const api = fakeApi();
		const schedules = await apiSchedules(me([{ role: "operator" }]), { fetch: api.fetch });
		expect(schedules.form).toEqual({
			owner: { kind: "project", organisationId: ORG, projectId: "prj_web" },
			agents: [{ id: "agt_1", name: "Triage" }],
		});
		expect(schedules.directory.person?.("usr_tom")).toBe("Tom Davies");
		expect(schedules.directory.project?.("prj_web")).toBe("Website");
		expect(schedules.directory.agent?.("agt_1")).toBe("Triage");
	});

	it("reads, pauses and resumes only for a viewer, or with no agent to ask", () => {
		const projects = [project("prj_b", "Billing"), project("prj_a", "Analytics"), project("prj_w", "Website")];
		const agents = [profile("agt_2", "Writer"), profile("agt_1", "Reviewer")];
		expect(formSettings(me([{ role: "viewer" }]), projects, agents)).toBeUndefined();
		expect(formSettings(me([{ role: "admin" }]), projects, [])).toBeUndefined();
		expect(formSettings(me([{ role: "admin" }]), projects, agents)?.agents.map((agent) => agent.name)).toEqual([
			"Reviewer",
			"Writer",
		]);
	});

	it("picks the first project by name the person may operate in, by the organisation's role or the project's", () => {
		const projects = [project("prj_w", "Website"), project("prj_b", "Billing"), project("prj_a", "Analytics")];
		expect(operableProject(me([{ role: "admin" }]), projects)?.id).toBe("prj_a");
		expect(operableProject(me([{ role: "viewer" }, { projectId: "prj_w", role: "operator" }]), projects)?.id).toBe(
			"prj_w",
		);
		expect(operableProject(me([{ projectId: "prj_b", role: "viewer" }]), projects)).toBeUndefined();
		expect(operableProject(me([]), projects)).toBeUndefined();
	});

	it("names only what it could read", () => {
		const directory = scheduleDirectory(new Map(), [], []);
		expect(directory.person?.("usr_x")).toBeUndefined();
		expect(directory.project?.("prj_x")).toBeUndefined();
	});
});
