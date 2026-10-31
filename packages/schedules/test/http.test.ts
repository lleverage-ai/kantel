// Contract tests for the public API's schedule routes (`@kantel/api`'s `scheduleRoutes`), called through the generated
// SDK against `createSchedulesApi` over the in-memory store, as a host app or the console calls a deployed Kantel.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type CallContext, KantelError } from "@kantel/contracts";
import { createSchedulesApi } from "@kantel/schedules/http";
import { createMemorySchedules } from "@kantel/schedules/memory";
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
			if (ctx === undefined) throw new KantelError("forbidden", "Unknown caller");
			return ctx;
		},
	});
	const fetchApi = async (input: string | URL | Request, init?: RequestInit) =>
		(await api.fetch(new Request(input, init))) ?? new Response("not mine", { status: 418 });
	const client = (token: string) => createKantelClient({ baseUrl: "https://harbour.test/v1", token, fetch: fetchApi });
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

async function failure(promise: Promise<unknown>): Promise<KantelApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
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

	it("clears at, repeat, until and count sent as null, and keeps a field left out", async () => {
		const { client, fetchApi } = setUp();
		const harbour = client("person");
		const until = START + 24 * 60 * MINUTE;
		const created = await harbour.createSchedule({ ...everyTen, until, count: 5 });

		const renamed = await harbour.updateSchedule(created.id, { title: "Weather again" });
		expect(renamed).toMatchObject({ repeat: everyTen.repeat, until, count: 5 });

		// Drop the run limit, then the end date: the recurrence stays.
		const unlimited = await harbour.updateSchedule(created.id, { count: null });
		expect(unlimited).not.toHaveProperty("count");
		expect(unlimited).toMatchObject({ until, repeat: everyTen.repeat, status: "active" });
		const endless = await harbour.updateSchedule(created.id, { until: null });
		expect(endless).not.toHaveProperty("until");
		expect(endless).toMatchObject({ repeat: everyTen.repeat, status: "active" });

		// Repeating to one-off, and back.
		const oneOff = await harbour.updateSchedule(created.id, { repeat: null, at: START + 30 * MINUTE });
		expect(oneOff).not.toHaveProperty("repeat");
		expect(oneOff).toMatchObject({ at: START + 30 * MINUTE, nextDueAt: START + 30 * MINUTE });
		const repeating = await harbour.updateSchedule(created.id, { at: null, repeat: everyTen.repeat });
		expect(repeating).not.toHaveProperty("at");
		expect(repeating).toMatchObject({ repeat: everyTen.repeat, nextDueAt: START + 10 * MINUTE });
		expect(await harbour.getSchedule(created.id)).toEqual(repeating);

		// The raw JSON a client sends, as the SDK does.
		const raw = await fetchApi(`https://harbour.test/v1/schedules/${created.id}`, {
			method: "PATCH",
			headers: { authorization: "Bearer person", "content-type": "application/json" },
			body: JSON.stringify({ count: 2, until: null }),
		});
		expect(raw.status).toBe(200);
		expect(await raw.json()).toMatchObject({ count: 2 });

		// Clearing both of at and repeat, or a field that can't be cleared, is refused.
		const neither = await failure(harbour.updateSchedule(created.id, { repeat: null }));
		expect([neither.status, neither.code]).toEqual([400, "invalid"]);
		const untitled = await failure(harbour.updateSchedule(created.id, { title: null } as never));
		expect([untitled.status, untitled.code]).toEqual([400, "invalid"]);
		expect(await harbour.getSchedule(created.id)).toMatchObject({ repeat: everyTen.repeat, count: 2 });
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

	it("answers a bad body, an unknown schedule and an agent with Kantel's error codes", async () => {
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
