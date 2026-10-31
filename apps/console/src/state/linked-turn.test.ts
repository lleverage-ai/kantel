import { readFileSync } from "node:fs";
import { parseFixture, type ServerFrame } from "@kantel/protocol";
import { findTurn } from "@kantel/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnOfHash } from "../app/router.ts";
import { FixtureHost } from "../server-sim/fixture-host.ts";
import { followTurn, type TurnSearch, turnSearch } from "./linked-turn.ts";
import { SessionClient } from "./session-client.ts";

const root = new URL("../../../../fixtures/", import.meta.url);
const long: ServerFrame[] = parseFixture(readFileSync(new URL("sessions/long-2000.jsonl", root), "utf8"));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Opens the long recording's session and follows `turn` until the search settles. */
async function follow(turn: string): Promise<{ client: SessionClient; searches: TurnSearch[] }> {
	const host = new FixtureHost(long, { latencyMs: 5 });
	const client = new SessionClient(host, host.sessionId);
	const searches: TurnSearch[] = [];
	const stop = followTurn(client, turn, (search) => {
		if (searches.at(-1) !== search) searches.push(search);
	});
	client.start();
	for (let step = 0; step < 200 && (searches.at(-1) === "paging" || searches.length === 0); step++) {
		await vi.advanceTimersByTimeAsync(50);
	}
	stop();
	client.stop();
	return { client, searches };
}

describe("a #turn= link", () => {
	it("reads the turn from the hash, decoded", () => {
		expect(turnOfHash("#turn=u%3A271")).toBe("u:271");
		expect(turnOfHash("#turn=s1%2F4")).toBe("s1/4");
		expect(turnOfHash("turn=call-3")).toBe("call-3");
		expect(turnOfHash("#turn=")).toBeUndefined();
		expect(turnOfHash("#other=1")).toBeUndefined();
		expect(turnOfHash("")).toBeUndefined();
	});

	it("finds a turn already on the first page without paging", async () => {
		const host = new FixtureHost(long, { latencyMs: 5 });
		const client = new SessionClient(host, host.sessionId);
		client.start();
		await vi.advanceTimersByTimeAsync(100);
		const last = client.getState().items.findLast((item) => item.kind === "user");
		expect(last).toBeDefined();
		const loaded = client.getState().items.length;
		const searches: TurnSearch[] = [];
		const stop = followTurn(client, last?.id, (search) => searches.push(search));
		await vi.advanceTimersByTimeAsync(200);
		stop();
		client.stop();
		expect(searches.at(-1)).toBe("found");
		expect(client.getState().items.length).toBe(loaded);
	});

	it("pages back through the history until the turn is loaded", async () => {
		const { client, searches } = await follow("u:1");
		expect(searches).toEqual(["paging", "found"]);
		const state = client.getState();
		expect(findTurn(state.items, "u:1")?.id).toBe("u:1");
		// The first message is the session's first item: every page before it was read.
		expect(state.items[0]?.id).toBe("u:1");
		expect(state.hasEarlier).toBe(false);
	});

	it("finds a tool call by its call ID", async () => {
		const { client, searches } = await follow("call-3");
		expect(searches.at(-1)).toBe("found");
		expect(findTurn(client.getState().items, "call-3")?.id).toBe("tool:call-3");
	});

	it("says the turn is missing once the whole session is loaded without it", async () => {
		const { client, searches } = await follow("u:no-such-turn");
		expect(searches).toEqual(["paging", "missing"]);
		expect(client.getState().hasEarlier).toBe(false);
	});

	it("has nothing to look for without a turn", () => {
		expect(turnSearch({ items: [], hasEarlier: true, cursor: "c1" }, undefined)).toBe("none");
		// Before the first snapshot nothing is known yet: the session may well hold the turn.
		expect(turnSearch({ items: [], hasEarlier: false, cursor: undefined }, "u:1")).toBe("paging");
		// A page that wouldn't load ends the search rather than asking again and again.
		expect(turnSearch({ items: [], hasEarlier: true, cursor: "c1", olderError: "history" }, "u:1")).toBe("missing");
	});
});
