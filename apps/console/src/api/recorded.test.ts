import { applyFrames, PROTOCOL_VERSION, type ServerFrame } from "@harbour/protocol";
import { groupSessions, type SessionSummary } from "@harbour/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogue } from "../recorded/catalogue.ts";
import { SessionClient } from "../state/session-client.ts";
import type { SessionListState } from "./client.ts";
import { createRecordedClient, RECORDED_REASON } from "./recorded.ts";

const NOW = 1_793_100_000_000;

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

/** Follows a project's list, keeping the latest state. */
function follow(client: ReturnType<typeof createRecordedClient>, projectId: string) {
	const seen: { state?: SessionListState } = {};
	const stop = client.watchSessions(projectId, (state) => {
		seen.state = state;
	});
	return { seen, stop };
}

const hello = (sessionId: string) => ({ type: "hello" as const, v: PROTOCOL_VERSION, sessionId });

const byId = (sessions: readonly SessionSummary[] | undefined, id: string) =>
	sessions?.find((session) => session.id === id);

describe("the recorded catalogue", () => {
	it("makes every session's frames apply cleanly, each under its own id", async () => {
		const catalogue = createCatalogue(NOW);
		const ids = new Set<string>();
		for (const session of catalogue.sessions) {
			const frames: readonly ServerFrame[] = await session.frames();
			expect(frames[0]?.type).toBe("hello");
			const end = applyFrames(frames);
			expect(end?.sessionId).toBe(session.id);
			expect(end?.items.length).toBeGreaterThan(0);
			ids.add(session.id);
		}
		expect(ids.size).toBe(catalogue.sessions.length);
	});

	it("puts a session in each attention group", async () => {
		const client = createRecordedClient(createCatalogue(NOW));
		const sal = follow(client, "sal");
		const harbour = follow(client, "harbour");
		await vi.advanceTimersByTimeAsync(200);
		const all = [...(sal.seen.state?.sessions ?? []), ...(harbour.seen.state?.sessions ?? [])];
		expect(groupSessions(all).map((group) => group.group)).toEqual(["needs-you", "working", "done"]);
		expect(byId(all, "s-linear-key")).toMatchObject({ status: "waiting", needs: "approval" });
		expect(byId(all, "s-digest")).toMatchObject({ status: "waiting", needs: "answer" });
		expect(byId(all, "s-flaky")).toMatchObject({ status: "running", branch: "fix/composer-flake" });
		expect(byId(all, "s-seed")).toMatchObject({ status: "failed" });
		expect(byId(all, "s-gvisor")).toMatchObject({ status: "done", unread: true });
		client.dispose();
	});

	it("shows an empty project as loaded with no sessions", async () => {
		const client = createRecordedClient(createCatalogue(NOW));
		const brwsr = follow(client, "brwsr");
		await vi.advanceTimersByTimeAsync(10);
		expect(brwsr.seen.state).toEqual({ sessions: [], loading: false });
		client.dispose();
	});
});

describe("the recorded client", () => {
	it("moves a working session to done, unread, when it finishes while closed", async () => {
		const client = createRecordedClient(createCatalogue(NOW), { latencyMs: 0 });
		const harbour = follow(client, "harbour");
		await vi.advanceTimersByTimeAsync(200);
		expect(byId(harbour.seen.state?.sessions, "s-flaky")?.status).toBe("running");
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(byId(harbour.seen.state?.sessions, "s-flaky")).toMatchObject({ status: "done", unread: true });
		client.markRead("s-flaky");
		expect(byId(harbour.seen.state?.sessions, "s-flaky")?.unread).toBe(false);
		client.dispose();
	});

	it("keeps a session read while it is shown, and not once it has been left", async () => {
		const shown = createRecordedClient(createCatalogue(NOW), { latencyMs: 0 });
		const a = follow(shown, "harbour");
		shown.markRead("s-flaky");
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(byId(a.seen.state?.sessions, "s-flaky")).toMatchObject({ status: "done", unread: false });
		shown.dispose();

		const left = createRecordedClient(createCatalogue(NOW), { latencyMs: 0 });
		const b = follow(left, "harbour");
		const release = left.markRead("s-flaky");
		await vi.advanceTimersByTimeAsync(200);
		release();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(byId(b.seen.state?.sessions, "s-flaky")).toMatchObject({ status: "done", unread: true });
		left.dispose();
	});

	it("calls nobody back and plays nothing once stopped or disposed", async () => {
		const client = createRecordedClient(createCatalogue(NOW), { latencyMs: 0 });
		const onChange = vi.fn();
		client.watchSessions("harbour", onChange)();
		const receive = vi.fn();
		client.transport("s-none").connect(receive).close();
		client.dispose();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(onChange).not.toHaveBeenCalled();
		expect(receive).not.toHaveBeenCalled();
		expect(client.hostFor("s-flaky")?.finished).toBe(false);
	});

	it("calls nobody back once disposed, even while still subscribed or connected", async () => {
		const client = createRecordedClient(createCatalogue(NOW), { latencyMs: 0 });
		const onChange = vi.fn();
		client.watchSessions("harbour", onChange);
		const unknown = vi.fn();
		client.transport("s-none").connect(unknown);
		const known = vi.fn();
		client.transport("s-flaky").connect(known).send(hello("s-flaky"));
		client.dispose();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(onChange).not.toHaveBeenCalled();
		expect(unknown).not.toHaveBeenCalled();
		expect(known).not.toHaveBeenCalled();
	});

	it("drops frames still in flight at dispose", async () => {
		const client = createRecordedClient(createCatalogue(NOW), { latencyMs: 50 });
		const onChange = vi.fn();
		client.watchSessions("harbour", onChange);
		const receive = vi.fn();
		client.transport("s-flaky").connect(receive).send(hello("s-flaky"));
		await vi.advanceTimersByTimeAsync(10);
		const lists = onChange.mock.calls.length;
		client.dispose();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(receive).not.toHaveBeenCalled();
		expect(onChange.mock.calls.length).toBe(lists);
	});

	it("stops calling a connected session back at dispose", async () => {
		const client = createRecordedClient(createCatalogue(NOW), { latencyMs: 0, openDelayMs: 100 });
		const receive = vi.fn();
		client.transport("s-flaky").connect(receive).send(hello("s-flaky"));
		await vi.advanceTimersByTimeAsync(50);
		expect(receive).toHaveBeenCalled();
		const calls = receive.mock.calls.length;
		client.dispose();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(receive.mock.calls.length).toBe(calls);
	});

	it("keeps unchanged sessions' objects, so the list re-renders only what changed", async () => {
		const client = createRecordedClient(createCatalogue(NOW), { latencyMs: 0 });
		const harbour = follow(client, "harbour");
		await vi.advanceTimersByTimeAsync(200);
		const before = byId(harbour.seen.state?.sessions, "s-seed");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(byId(harbour.seen.state?.sessions, "s-seed")).toBe(before);
		expect(byId(harbour.seen.state?.sessions, "s-flaky")).not.toBe(undefined);
		client.dispose();
	});

	it("serves a session over the protocol: a snapshot, then its live part once opened", async () => {
		const client = createRecordedClient(createCatalogue(NOW), { latencyMs: 0, openDelayMs: 100 });
		const session = new SessionClient(client.transport("s-linear-key"), "s-linear-key");
		session.start();
		await vi.advanceTimersByTimeAsync(50);
		const state = session.getState();
		expect(state.title).toBe("Rotate the Linear API key");
		expect(state.status).toBe("waiting");
		expect(state.items.at(-1)?.kind).toBe("card");
		expect(state.connection).toEqual({ status: "open" });
		session.stop();
		client.dispose();
	});

	it("answers an unknown session with an error", async () => {
		const client = createRecordedClient(createCatalogue(NOW));
		const session = new SessionClient(client.transport("nope"), "nope");
		session.start();
		await vi.advanceTimersByTimeAsync(10);
		expect(session.getState().error).toMatch(/not_found/);
		expect(client.projectOf("nope")).toBeUndefined();
		expect(client.projectOf("s-flaky")).toBe("harbour");
		session.stop();
		client.dispose();
	});

	it("can't steer, follow up or cancel a recording, and says why", async () => {
		const client = createRecordedClient(createCatalogue(NOW));
		expect(client.control("s-flaky")).toEqual({ live: false, reason: RECORDED_REASON });
		await expect(client.steer("s-flaky", "stop")).rejects.toThrow(RECORDED_REASON);
		await expect(client.followUp("s-flaky", "then this")).rejects.toThrow(RECORDED_REASON);
		await expect(client.prompt("s-flaky", "hello")).rejects.toThrow(RECORDED_REASON);
		await expect(client.cancel("s-flaky")).rejects.toThrow(RECORDED_REASON);
		expect(client.actor.stubbed).toBe(true);
		client.dispose();
	});
});
