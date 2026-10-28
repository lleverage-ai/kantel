// Contract tests for the public API's schedule routes (`@harbour/api`'s `scheduleRoutes`), called through the generated
// SDK against `createSchedulesApi` over the in-memory store, as a host app or the console calls a deployed Harbour.
import { createHarbourClient, HarbourApiError } from "@harbour/api/sdk";
import { type CallContext, HarbourError } from "@harbour/contracts";
import { createSchedulesApi } from "@harbour/schedules/http";
import { createMemorySchedules } from "@harbour/schedules/memory";
import { describe, expect, it } from "vitest";

const ORG = "org-1";
const START = Date.UTC(2026, 9, 28, 22, 0);
const MINUTE = 60_000;
const person: CallContext = { actor: { kind: "human", userId: "u1" }, organisationId: ORG };
const agent: CallContext = { actor: { kind: "agent", agentId: "a1", sessionId: "s1" }, organisationId: ORG };

function setUp() {
	const now = { value: START };
	const schedules = createMemorySchedules({ clock: { now: () => now.value } });
	const callers: { [token: string]: CallContext } = { person, agent };
	const api = createSchedulesApi({
		schedules,
		authenticate: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			const ctx = callers[token];
			if (ctx === undefined) throw new HarbourError("forbidden", "Unknown caller");
			return ctx;
		},
	});
	const fetchApi = async (input: string | URL | Request, init?: RequestInit) =>
		(await api.fetch(new Request(input, init))) ?? new Response("not mine", { status: 418 });
	const client = (token: string) => createHarbourClient({ baseUrl: "https://harbour.test/v1", token, fetch: fetchApi });
	return { schedules, now, api, fetchApi, client };
}

const everyTen = {
	owner: { kind: "organisation", organisationId: ORG },
	kind: "task",
	title: "Weather",
	timezone: "Europe/London",
	repeat: { every: "minutes", interval: 10, from: START + 10 * MINUTE },
	payload: { agentId: "assistant", prompt: "What's the weather?" },
} as const;

async function failure(promise: Promise<unknown>): Promise<HarbourApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof HarbourApiError) return error;
		throw error;
	}
	throw new Error("expected the call to fail");
}

describe("the schedule routes", () => {
	it("create, get, list, change, pause, resume, preview and end a schedule", async () => {
		const { client } = setUp();
		const harbour = client("person");
		const created = await harbour.createSchedule(everyTen);
		expect(created).toMatchObject({ title: "Weather", status: "active", nextDueAt: START + 10 * MINUTE });
		expect(created.payload).toEqual(everyTen.payload);

		expect(await harbour.getSchedule(created.id)).toEqual(created);
		expect((await harbour.listSchedules({ status: "active" })).items.map((s) => s.id)).toEqual([created.id]);
		expect((await harbour.listSchedules({ kind: "check" })).items).toEqual([]);

		const changed = await harbour.updateSchedule(created.id, {
			title: "Weather, hourly",
			repeat: { every: "hours", interval: 1, from: START + 60 * MINUTE },
		});
		expect(changed).toMatchObject({ title: "Weather, hourly", nextDueAt: START + 60 * MINUTE });
		expect(changed.payload).toEqual(everyTen.payload);

		expect((await harbour.previewSchedule(created.id, { n: 3 })).dueAt).toEqual([
			START + 60 * MINUTE,
			START + 120 * MINUTE,
			START + 180 * MINUTE,
		]);

		expect(await harbour.pauseSchedule(created.id)).toMatchObject({ status: "paused" });
		expect(await harbour.resumeSchedule(created.id)).toMatchObject({ status: "active" });
		expect(await harbour.deleteSchedule(created.id)).toMatchObject({ status: "ended" });
		// Ended, not gone: it stays listed with its history.
		expect((await harbour.listSchedules({ status: "ended" })).items.map((s) => s.id)).toEqual([created.id]);
	});

	it("lists a schedule's runs, with what each run's result says", async () => {
		const { client, schedules, now } = setUp();
		const harbour = client("person");
		const created = await harbour.createSchedule(everyTen);
		now.value = START + 10 * MINUTE;
		const system = { actor: { kind: "system", component: "scheduler" } } as const;
		await schedules.tick(system);
		const claimed = await schedules.claim(system, "runner", MINUTE);
		await schedules.complete(system, claimed!.id, "runner", {
			status: "succeeded",
			result: { sessionId: "s-1", submissionId: "sub-1" },
		});
		const runs = await harbour.listScheduleRuns(created.id, { limit: 10 });
		expect(runs.items).toMatchObject([
			{ id: `${created.id}@${START + 10 * MINUTE}`, status: "succeeded", result: { sessionId: "s-1" } },
		]);
	});

	it("answers a bad body, an unknown schedule and an agent with Harbour's error codes", async () => {
		const { client } = setUp();
		const invalid = await failure(client("person").createSchedule({ ...everyTen, timezone: "Mars/Olympus" }));
		expect([invalid.status, invalid.code]).toEqual([400, "invalid"]);
		const schemaFailure = await failure(
			client("person").createSchedule({ ...everyTen, repeat: { every: "fortnight" } } as never),
		);
		expect([schemaFailure.status, schemaFailure.code]).toEqual([400, "invalid"]);
		const missing = await failure(client("person").getSchedule("nope"));
		expect([missing.status, missing.code]).toEqual([404, "not_found"]);
		const refused = await failure(client("agent").createSchedule(everyTen));
		expect([refused.status, refused.code]).toEqual([403, "forbidden"]);
		const stranger = await failure(client("stranger").listSchedules());
		expect(stranger.code).toBe("forbidden");
	});

	it("leaves every other path to the server's other routes", async () => {
		const { api } = setUp();
		expect(await api.fetch(new Request("https://harbour.test/v1/sessions"))).toBeUndefined();
		expect(await api.fetch(new Request("https://harbour.test/v1/schedulesx"))).toBeUndefined();
		const unknown = await api.fetch(
			new Request("https://harbour.test/v1/schedules/x/nothing", { headers: { authorization: "Bearer person" } }),
		);
		expect(unknown?.status).toBe(404);
	});
});
