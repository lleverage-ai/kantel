import type { SessionSnapshot, TranscriptItem } from "@kantel/protocol";
import { describe, expect, it } from "vitest";
import { withLocalCache } from "../api/cached.ts";
import type { ConsoleClient, SessionListState } from "../api/client.ts";
import {
	CACHED_ITEMS,
	CACHED_SESSIONS,
	cacheSwitch,
	memoryCacheStore,
	openLocalCache,
	trimSnapshot,
} from "./local-cache.ts";
import { SessionClient, type Transport } from "./session-client.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const item = (index: number): TranscriptItem => ({
	kind: "user",
	id: `u:${index}`,
	at: index,
	text: `Message ${index}`,
	via: "prompt",
});

const snapshotOf = (sessionId: string, count: number, cursor = "g1.c9"): SessionSnapshot => ({
	v: 1,
	sessionId,
	cursor,
	status: "idle",
	attention: "done",
	title: `Session ${sessionId}`,
	items: Array.from({ length: count }, (_, index) => item(index)),
	hasEarlier: false,
	updatedAt: 1,
});

describe("the console's local cache", () => {
	it("keeps each person's entries apart, and deletes everyone else's when someone opens it", async () => {
		const store = memoryCacheStore();
		const tom = await openLocalCache(store, "org/tom");
		tom.setProjects([{ id: "p1", name: "Tom's project" }]);
		tom.setSession(snapshotOf("s1", 3));
		await settle();
		expect(await tom.projects()).toEqual([{ id: "p1", name: "Tom's project" }]);

		const ann = await openLocalCache(store, "org/ann");
		expect(await ann.projects()).toBeUndefined();
		expect(await ann.session("s1")).toBeUndefined();
		// Nothing of Tom's is left on the browser once Ann has opened it.
		expect([...store.entries.values()].filter((entry) => entry.owner === "org/tom")).toEqual([]);
	});

	it("stops reading and writing once cleared, so nothing queued lands after a sign-out", async () => {
		const store = memoryCacheStore();
		let open = true;
		const cache = await openLocalCache(store, "org/tom", { open: () => open });
		cache.setProjects([{ id: "p1", name: "One" }]);
		await settle();
		open = false;
		await store.clear();
		cache.setProjects([{ id: "p2", name: "Two" }]);
		await settle();
		expect(store.entries.size).toBe(0);
		expect(await cache.projects()).toBeUndefined();
	});

	it("keeps the newest items of the last few sessions only", async () => {
		const store = memoryCacheStore();
		const cache = await openLocalCache(store, "org/tom");
		for (let index = 0; index <= CACHED_SESSIONS; index++) cache.setSession(snapshotOf(`s${index}`, 2));
		cache.setSession(snapshotOf("long", CACHED_ITEMS + 50));
		await settle();
		await settle();
		expect(await cache.session("s0")).toBeUndefined();
		expect(await cache.session("s1")).toBeUndefined();
		expect(await cache.session(`s${CACHED_SESSIONS}`)).toBeDefined();
		const long = await cache.session("long");
		expect(long?.items).toHaveLength(CACHED_ITEMS);
		expect(long?.items[0]?.id).toBe("u:50");
		expect(long?.hasEarlier).toBe(true);
		expect(trimSnapshot(snapshotOf("short", 3)).hasEarlier).toBe(false);
	});

	it("is on unless ?cache=off said otherwise, and remembers it", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value),
		} as Storage;
		expect(cacheSwitch(new URLSearchParams(), storage)).toBe(true);
		expect(cacheSwitch(new URLSearchParams("cache=off"), storage)).toBe(false);
		expect(cacheSwitch(new URLSearchParams(), storage)).toBe(false);
		expect(cacheSwitch(new URLSearchParams("cache=on"), storage)).toBe(true);
	});
});

describe("the client with the cache in front", () => {
	const listing = (sessions: SessionListState["sessions"]) => {
		let tell: ((state: SessionListState) => void) | undefined;
		const client = {
			projects: async () => [{ id: "p1", name: "Fresh" }],
			watchSessions: (_projectId: string, onChange: (state: SessionListState) => void) => {
				tell = onChange;
				return () => {};
			},
		} as unknown as ConsoleClient;
		return { client, answer: () => tell?.({ sessions, loading: false }) };
	};

	it("shows the list last shown at once, then the API's, and keeps that without unread marks", async () => {
		const store = memoryCacheStore();
		const opening = openLocalCache(store, "org/tom");
		(await opening).setSessions("p1", [{ id: "old", title: "Old", status: "done", startedAt: 1, updatedAt: 1 }]);
		await settle();
		const { client, answer } = listing([
			{ id: "new", title: "New", status: "done", startedAt: 2, updatedAt: 2, unread: true },
		]);
		const cached = withLocalCache(client, opening);
		const states: SessionListState[] = [];
		cached.watchSessions("p1", (state) => states.push(state));
		await settle();
		await settle();
		expect(states.map((state) => state.sessions.map((session) => session.id))).toEqual([["old"]]);
		answer();
		await settle();
		await settle();
		expect(states.at(-1)?.sessions[0]?.id).toBe("new");
		expect(await (await opening).sessions("p1")).toEqual([
			{ id: "new", title: "New", status: "done", startedAt: 2, updatedAt: 2 },
		]);
		expect(await cached.projects()).toEqual([{ id: "p1", name: "Fresh" }]);
		await settle();
		expect(await cached.cachedProjects?.()).toEqual([{ id: "p1", name: "Fresh" }]);
	});

	it("doesn't show the cached list once the API has answered", async () => {
		const store = memoryCacheStore();
		let open: (cache: Awaited<ReturnType<typeof openLocalCache>>) => void = () => {};
		const opening = new Promise<Awaited<ReturnType<typeof openLocalCache>>>((resolve) => {
			open = resolve;
		});
		const { client, answer } = listing([{ id: "new", title: "New", status: "done", startedAt: 2, updatedAt: 2 }]);
		const states: SessionListState[] = [];
		withLocalCache(client, opening).watchSessions("p1", (state) => states.push(state));
		answer();
		const cache = await openLocalCache(store, "org/tom");
		cache.setSessions("p1", [{ id: "old", title: "Old", status: "done", startedAt: 1, updatedAt: 1 }]);
		await settle();
		open(cache);
		await settle();
		await settle();
		expect(states.map((state) => state.sessions.map((session) => session.id))).toEqual([["new"]]);
	});
});

describe("a session seeded from the cache", () => {
	const recording = () => {
		const sent: unknown[] = [];
		let receive: Parameters<Transport["connect"]>[0] = () => {};
		const transport: Transport = {
			connect(onFrame) {
				receive = onFrame;
				return { send: (frame) => sent.push(frame), close: () => {} };
			},
		};
		return { transport, sent, receive: (frame: Parameters<typeof receive>[0]) => receive(frame) };
	};

	it("shows the cached transcript at once and resumes after it", () => {
		const { transport, sent, receive } = recording();
		const session = new SessionClient(transport, "s1");
		session.seed(snapshotOf("s1", 3, "g1.c9"));
		expect(session.getState().items).toHaveLength(3);
		expect(session.getState().freshness.state).toBe("stale");
		session.start();
		expect(sent[0]).toMatchObject({ type: "hello", after: "g1.c9" });
		receive({ type: "hello", v: 1, sessionId: "s1", cursor: "g1.c10", resumed: true });
		receive({
			type: "delta",
			delta: { sessionId: "s1", cursor: "g1.c10", at: 2, ops: [{ op: "append", item: item(3) }] },
		});
		expect(session.getState().items.map((entry) => entry.id)).toEqual(["u:0", "u:1", "u:2", "u:3"]);
		expect(session.getState().freshness.state).toBe("current");
		expect(session.kept()?.items).toHaveLength(4);
	});

	it("takes the host's snapshot over the cached one, and ignores a cache that comes after it", () => {
		const { transport, receive } = recording();
		const session = new SessionClient(transport, "s1");
		session.seed(snapshotOf("s1", 3, "g0.c1"));
		session.start();
		receive({ type: "hello", v: 1, sessionId: "s1", cursor: "g2.c4", resumed: false });
		receive({ type: "snapshot", snapshot: snapshotOf("s1", 1, "g2.c4") });
		expect(session.getState().items).toHaveLength(1);
		session.seed(snapshotOf("s1", 5, "g0.c1"));
		expect(session.getState().items).toHaveLength(1);
		expect(session.getState().freshness.state).toBe("current");
	});

	it("never takes another session's snapshot", () => {
		const { transport } = recording();
		const session = new SessionClient(transport, "s1");
		session.seed(snapshotOf("s2", 3));
		expect(session.getState().items).toHaveLength(0);
	});
});
