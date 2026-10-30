// The console's onboarding seam: who may change it, which routes the connectors step calls, how a finished onboarding
// is reopened from the sidebar, and that the first session starts as New session starts one.
import type { Onboarding } from "@harbour/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ConsoleClient } from "./client.ts";
import { apiOnboarding, connectionsForOnboarding, onboardingApi, organisationAdmin } from "./onboarding-seam.ts";

const COMPLETED: Onboarding = {
	organisationId: "org_a",
	status: "completed",
	current: "session",
	steps: { models: "done", connectors: "skipped", session: "done" },
	updatedAt: 1,
};

function fakeApi(answer: (request: Request) => Response) {
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(new URL(String(input), "https://harbour.test"), init);
		const url = new URL(request.url);
		const body = request.method === "GET" ? "" : await request.clone().text();
		calls.push(`${request.method} ${url.pathname}${url.search}${body === "" ? "" : ` ${body}`}`);
		return answer(request);
	};
	return { calls, fetch: fetcher as typeof fetch };
}

const ME = {
	actor: { kind: "human" as const, userId: "usr_a" },
	organisationId: "org_a",
	roles: [{ role: "admin" as const }],
};

describe("the console's onboarding seam", () => {
	it("lets only an organisation-wide admin change it", () => {
		expect(organisationAdmin([{ role: "admin" }])).toBe(true);
		expect(organisationAdmin([{ role: "admin", projectId: "prj_a" }])).toBe(false);
		expect(organisationAdmin([{ role: "viewer" }])).toBe(false);
		expect(organisationAdmin(undefined)).toBe(false);
		expect(apiOnboarding(ME).canChange).toBe(true);
		expect(apiOnboarding({ ...ME, roles: [{ role: "operator" }] }).canChange).toBe(false);
		const agent = apiOnboarding({ ...ME, actor: { kind: "agent", agentId: "a", sessionId: "s" } } as never);
		expect(agent.canChange).toBe(false);
		expect(agent.connections).toBeUndefined();
	});

	it("connects connectors for the signed-in person through the Connections API", async () => {
		const api = fakeApi((request) =>
			Response.json(new URL(request.url).pathname.endsWith("/catalogue") ? { items: [] } : { id: "ca_1" }),
		);
		const owner = { kind: "user" as const, organisationId: "org_a", userId: "usr_a" };
		const connections = connectionsForOnboarding(owner, { fetch: api.fetch });
		await connections.catalogue();
		await connections.connect("github");
		await connections.attempt("ca_1");
		expect(api.calls).toEqual([
			"GET /v1/connections/catalogue?limit=100",
			`POST /v1/connections/connect {"templateId":"github","owner":${JSON.stringify(owner)}}`,
			"GET /v1/connections/connect/ca_1",
		]);
	});

	it("tells the page when it is signed out", async () => {
		const onUnauthenticated = vi.fn();
		const api = fakeApi(() => Response.json({ error: { code: "unauthenticated", message: "no" } }, { status: 401 }));
		const connections = connectionsForOnboarding(
			{ kind: "user", organisationId: "org_a", userId: "usr_a" },
			{ fetch: api.fetch, onUnauthenticated },
		);
		await expect(connections.catalogue()).rejects.toThrow();
		expect(onUnauthenticated).toHaveBeenCalled();
	});

	it("reopens a finished onboarding when asked to, and starts the first session like New session", async () => {
		const reopened = { ...COMPLETED, status: "active" as const, current: "models" as const };
		const state = {
			get: vi.fn(async () => COMPLETED),
			reopen: vi.fn(async () => reopened),
			setStep: vi.fn(),
			goTo: vi.fn(),
			dismiss: vi.fn(),
		};
		const seam = { state, providers: {} as never, canChange: true };
		const client = {
			startOptions: vi.fn(async () => ({ agentId: "agent_default" })),
			create: vi.fn(async () => "ses_1"),
		} as unknown as ConsoleClient;

		expect(await onboardingApi(seam, client, false).get()).toEqual(COMPLETED);
		expect(state.reopen).not.toHaveBeenCalled();
		expect(await onboardingApi(seam, client, true).get()).toEqual(reopened);
		expect(await onboardingApi({ ...seam, canChange: false }, client, true).get()).toEqual(COMPLETED);

		const started = await onboardingApi(seam, client, false).startSession({ projectId: "prj_a", text: "Hello there" });
		expect(started).toEqual({ sessionId: "ses_1" });
		expect(client.create).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "prj_a", agentId: "agent_default" }),
		);
	});
});
