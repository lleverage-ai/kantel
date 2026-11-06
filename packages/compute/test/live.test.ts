import { createKantelClient, type KantelClient, type LiveFrame } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import { type ComputeApi, type ComputeApiOptions, createComputeApi } from "../src/http.ts";
import { createLiveFeed, type LiveRelay, type SandboxChange, watchResponse, watchSandboxes } from "../src/live.ts";
import { createMemoryStore, type StoredSandbox } from "../src/store.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
};

const opened: ComputeApi[] = [];
const watching: Watch[] = [];

afterEach(async () => {
	for (const watch of watching.splice(0)) watch.close();
	for (const api of opened.splice(0)) await api.close();
});

function setup(extra: Partial<ComputeApiOptions> = {}) {
	const api = createComputeApi({
		backend: createStubBackend(),
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
		...extra,
	});
	opened.push(api);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, client, tom: client("tom-token"), ann: client("ann-token") };
}

interface Watch {
	readonly frames: LiveFrame[];
	readonly closed: { code: number; reason: string } | undefined;
	/** The sandbox frames' states for one sandbox, in order. */
	states(sandboxId: string): string[];
	until(done: () => boolean, what: string): Promise<void>;
	close(): void;
}

function watch(client: KantelClient, account?: string): Watch {
	const frames: LiveFrame[] = [];
	let closed: { code: number; reason: string } | undefined;
	const handle = client.watchEvents(
		{
			onFrames: (some) => frames.push(...some),
			onClose: (event) => {
				closed = event;
			},
		},
		account === undefined ? {} : { account },
	);
	const watched: Watch = {
		frames,
		get closed() {
			return closed;
		},
		states: (sandboxId) =>
			frames.flatMap((frame) => (frame.type === "sandbox" && frame.sandboxId === sandboxId ? [frame.state] : [])),
		async until(done, what) {
			const deadline = Date.now() + 3_000;
			while (!done()) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(frames)}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		},
		close: () => handle.close(),
	};
	watching.push(watched);
	return watched;
}

const hellos = (watched: Watch) => watched.frames.filter((frame) => frame.type === "hello").length;

describe("the live feed", () => {
	it("tells a watching console of a sandbox another caller starts, stops, resumes and deletes", async () => {
		const { tom, client } = setup();
		const console = watch(tom);
		await console.until(() => hellos(console) === 1, "the hello");
		// The CLI: a key of Tom's, not the console's sign-in.
		const cli = client((await tom.createApiKey({ name: "cli", preset: "ci" })).secret);

		const sandbox = await cli.createSandbox({ wait: true });
		await console.until(() => console.states(sandbox.id).includes("running"), "running");
		await cli.stopSandbox(sandbox.id, {});
		await console.until(() => console.states(sandbox.id).includes("stopped"), "stopped");
		await cli.resumeSandbox(sandbox.id, {});
		await console.until(() => console.states(sandbox.id).filter((state) => state === "running").length === 2, "again");
		await cli.deleteSandbox(sandbox.id);
		await console.until(() => console.states(sandbox.id).includes("deleted"), "deleted");

		expect(console.states(sandbox.id)).toEqual([
			"starting",
			"running",
			"stopping",
			"stopped",
			"starting",
			"running",
			"deleting",
			"deleted",
		]);
		const created = console.frames.find((frame) => frame.type === "sandbox" && frame.sandboxId === sandbox.id);
		expect(created).toMatchObject({ type: "sandbox", accountId: sandbox.accountId, state: "starting" });
		expect(created).not.toHaveProperty("previousState");
		expect(console.frames).toContainEqual(
			expect.objectContaining({ sandboxId: sandbox.id, state: "stopped", previousState: "stopping" }),
		);
	});

	it("tells it of an auto-stop, which no call asked for", async () => {
		let clock = Date.UTC(2026, 10, 5);
		const { api, tom } = setup({ now: () => clock });
		const sandbox = await tom.createSandbox({ autoStopMinutes: 5, wait: true });
		const console = watch(tom);
		await console.until(() => hellos(console) === 1, "the hello");
		clock += 6 * 60_000;
		await api.service.sweep();
		await api.service.idle();
		await console.until(() => console.states(sandbox.id).includes("stopped"), "the auto-stop");
		expect(console.states(sandbox.id)).toEqual(["stopping", "stopped"]);
	});

	it("sends nothing for a write that leaves the state as it was", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const console = watch(tom);
		await console.until(() => hellos(console) === 1, "the hello");
		await tom.updateSandbox(sandbox.id, { labels: { team: "infra" }, autoStopMinutes: 30 });
		const marker = await tom.createSandbox({ wait: true });
		await console.until(() => console.states(marker.id).includes("running"), "the marker");
		expect(console.states(sandbox.id)).toEqual([]);
	});

	it("sends each watcher only the sandboxes they may see", async () => {
		const { tom, ann, client } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "member" })).code ?? "" });
		const annWatch = watch(ann, org.id);
		const tomWatch = watch(tom, org.id);
		const tomPersonal = watch(tom);
		await annWatch.until(() => hellos(annWatch) === 1 && hellos(tomWatch) === 1 && hellos(tomPersonal) === 1, "hellos");

		const mine = await tom.createSandbox({ account: org.id, visibility: "private", wait: true });
		const shared = await tom.createSandbox({ account: org.id, visibility: "organisation", wait: true });
		await tomWatch.until(() => tomWatch.states(shared.id).includes("running"), "tom's");
		await annWatch.until(() => annWatch.states(shared.id).includes("running"), "the shared one");
		// Ann, a member, sees the organisation's shared sandbox and not Tom's private one; Tom sees both.
		expect(annWatch.states(mine.id)).toEqual([]);
		expect(tomWatch.states(mine.id)).toEqual(["starting", "running"]);
		// Another account's watcher hears nothing of the organisation's.
		expect(tomPersonal.frames.filter((frame) => frame.type === "sandbox")).toEqual([]);

		// A key limited to one sandbox hears of that one only.
		const limitedKey = await tom.createApiKey({
			account: org.id,
			name: "one",
			scopes: ["sandboxes:read"],
			sandboxIds: [shared.id],
		});
		const limited = watch(client(limitedKey.secret));
		await limited.until(() => hellos(limited) === 1, "the key's hello");
		await tom.stopSandbox(mine.id, {});
		await tom.stopSandbox(shared.id, {});
		await limited.until(() => limited.states(shared.id).includes("stopped"), "the key's sandbox");
		await tomWatch.until(() => tomWatch.states(mine.id).includes("stopped"), "tom's private one");
		expect(limited.states(mine.id)).toEqual([]);
	});

	it("sends nothing of a sandbox it couldn't read, not even to an admin, and carries on", async () => {
		// The sandboxes' reads fail from the moment one is stopped, as a database blip would.
		const store = createMemoryStore();
		const sandboxes = store.sandboxes;
		let armed = false;
		let failReads = false;
		const { api, tom, ann } = setup({
			store: {
				...store,
				sandboxes: {
					...sandboxes,
					get: (id) => (failReads ? Promise.reject(new Error("the database is away")) : sandboxes.get(id)),
					async update(id, change, expected) {
						const written = await sandboxes.update(id, change, expected);
						if (armed && written?.state === "stopped") failReads = true;
						return written;
					},
				},
			},
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "admin" })).code ?? "" });
		const mine = await tom.createSandbox({ account: org.id, visibility: "private", wait: true });
		const annWatch = watch(ann, org.id);
		await annWatch.until(() => hellos(annWatch) === 1, "the hello");

		armed = true;
		await tom.stopSandbox(mine.id, {}).catch(() => undefined);
		// The stop ends after the call answers.
		await annWatch.until(() => failReads, "the stop");
		await api.service.idle();
		await new Promise((resolve) => setTimeout(resolve, 50));
		failReads = false;
		armed = false;
		const shared = await tom.createSandbox({ account: org.id, visibility: "organisation", wait: true });
		await annWatch.until(() => annWatch.states(shared.id).includes("running"), "the shared one");
		// Ann, an admin, may not see Tom's private sandbox: a read that failed doesn't let it through.
		expect(annWatch.states(mine.id)).toEqual([]);
		expect(annWatch.closed).toBeUndefined();
	});

	it("refuses an account the caller isn't in, and ends once they leave it or their key is revoked", async () => {
		const { tom, ann, client } = setup();
		const refused = watch(ann, (await tom.getCaller()).accounts[0]?.id);
		await refused.until(() => refused.closed !== undefined, "the refusal");
		expect(refused.closed?.code).toBe(4403);
		expect(refused.frames).toEqual([]);

		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "member" })).code ?? "" });
		const annWatch = watch(ann, org.id);
		const key = await tom.createApiKey({ name: "cli", preset: "ci" });
		const keyWatch = watch(client(key.secret));
		await annWatch.until(() => hellos(annWatch) === 1 && hellos(keyWatch) === 1, "hellos");

		await tom.removeMember(org.id, "usr_ann");
		await tom.revokeApiKey(key.key.id);
		await tom.createSandbox({ account: org.id, visibility: "organisation", wait: true });
		await tom.createSandbox({ wait: true });
		await annWatch.until(() => annWatch.closed !== undefined, "ann's end");
		await keyWatch.until(() => keyWatch.closed !== undefined, "the key's end");
		expect(annWatch.frames.filter((frame) => frame.type === "sandbox")).toEqual([]);
		expect(keyWatch.frames.filter((frame) => frame.type === "sandbox")).toEqual([]);
		expect(annWatch.closed?.code).toBe(1000);
	});

	it("ends a deleted person's watch, though a membership of theirs is put back, and tells others still", async () => {
		const store = createMemoryStore();
		const { api, tom, ann } = setup({ store });
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "member" })).code ?? "" });
		const annWatch = watch(ann, org.id);
		const tomWatch = watch(tom, org.id);
		await annWatch.until(() => hellos(annWatch) === 1 && hellos(tomWatch) === 1, "hellos");
		const membership = await store.members.get(`${org.id}:usr_ann`);
		await ann.deleteCaller();
		// As a write that read her membership before the deletion and landed after would: it is back.
		if (membership !== undefined) await store.members.put(membership);
		const made = await tom.createSandbox({ account: org.id, visibility: "organisation", wait: true });
		await tomWatch.until(() => tomWatch.states(made.id).length > 0, "tom's frame");
		await annWatch.until(() => annWatch.closed !== undefined, "ann's end");
		expect(annWatch.states(made.id)).toEqual([]);
		// And once her deletion has finished, its record kept for good, a watch of hers is refused outright.
		for (let round = 0; round < 5 && (await store.deletions.get("usr_ann"))?.stage === "running"; round++) {
			await store.deletions.update("usr_ann", ({ lease: _lease, ...current }) => ({ ...current, dueAt: 0 }));
			await api.service.carryOnDeletions();
		}
		expect((await store.deletions.get("usr_ann"))?.stage).toBe("done");
		const again = watch(ann, org.id);
		await again.until(() => again.closed !== undefined, "the refusal");
		expect(again.frames.filter((frame) => frame.type === "sandbox")).toEqual([]);
	});

	it("passes changes to the other gateways through a relay, takes theirs, and says hello again after a gap", async () => {
		const relayed: SandboxChange[] = [];
		let receive: ((change: SandboxChange) => void) | undefined;
		let resync: (() => void) | undefined;
		const relay: LiveRelay = {
			send: (change) => void relayed.push(change),
			start: (taken, gap) => {
				receive = taken;
				resync = gap;
			},
			stop: () => undefined,
		};
		const store = createMemoryStore();
		const { tom } = setup({ store, liveRelay: relay });
		const sandbox = await tom.createSandbox({ wait: true });
		expect(relayed.map((change) => change.state)).toEqual(["starting", "running"]);

		const console = watch(tom);
		await console.until(() => hellos(console) === 1, "the hello");
		// Another gateway stopped it, over the same database.
		const record = (await store.sandboxes.get(sandbox.id)) as StoredSandbox;
		await store.sandboxes.put({ ...record, state: "stopped" });
		receive?.({ sandboxId: sandbox.id, accountId: sandbox.accountId, state: "stopped", at: Date.now() });
		await console.until(() => console.states(sandbox.id).includes("stopped"), "the relayed change");
		// What the relay carried in is not sent back out.
		expect(relayed).toHaveLength(2);

		resync?.();
		await console.until(() => hellos(console) === 2, "the second hello");
	});
});

describe("watchSandboxes", () => {
	const record = (state: StoredSandbox["state"], lifecycle = 1): StoredSandbox =>
		({ id: "sbx_1", accountId: "acc_1", state, lifecycle }) as StoredSandbox;

	it("publishes a new record, each change of state, and a delete, and nothing else", async () => {
		const changes: SandboxChange[] = [];
		const sandboxes = watchSandboxes(
			createMemoryStore().sandboxes,
			(change) => void changes.push(change),
			() => 7,
		);
		await sandboxes.put(record("starting"));
		await sandboxes.update("sbx_1", (current) => ({ ...current, state: "running", lifecycle: 2 }));
		await sandboxes.update("sbx_1", (current) => ({ ...current, labels: { a: "b" } }));
		await sandboxes.update("sbx_1", () => undefined);
		await sandboxes.get("sbx_1");
		await sandboxes.list({ accountId: "acc_1" });
		await sandboxes.deleteIf("sbx_1", () => false);
		await sandboxes.delete("sbx_1");
		await sandboxes.delete("sbx_1");
		expect(changes).toEqual([
			{ sandboxId: "sbx_1", accountId: "acc_1", state: "starting", at: 7 },
			{ sandboxId: "sbx_1", accountId: "acc_1", state: "running", previousState: "starting", at: 7 },
			{ sandboxId: "sbx_1", accountId: "acc_1", state: "deleted", previousState: "running", at: 7 },
		]);
	});

	it("publishes a restart in the same state as a change, by its lifecycle", async () => {
		const changes: SandboxChange[] = [];
		const sandboxes = watchSandboxes(
			createMemoryStore().sandboxes,
			(change) => void changes.push(change),
			() => 7,
		);
		expect(await sandboxes.insert(record("running", 3))).toBe(true);
		expect(await sandboxes.insert(record("running", 3))).toBe(false);
		await sandboxes.update("sbx_1", (current) => ({ ...current, lifecycle: 4 }));
		expect(changes.map((change) => [change.state, change.previousState])).toEqual([
			["running", undefined],
			["running", "running"],
		]);
	});
});

describe("watchResponse", () => {
	async function read(response: Response, until: (text: string) => boolean): Promise<string> {
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let text = "";
		while (!until(text)) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		reader.releaseLock();
		return text;
	}

	it("is server-sent events with keep-alives, and ends after its lifetime and with its request", async () => {
		const feed = createLiveFeed({ read: async () => undefined });
		const aborter = new AbortController();
		const response = watchResponse({
			feed,
			accountId: "acc_1",
			mayWatch: async () => "send",
			signal: aborter.signal,
			now: () => 1,
			keepAliveMs: 10,
			lifetimeMs: 60_000,
		});
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		expect(feed.watchers).toBe(1);
		const text = await read(response, (sofar) => sofar.includes(": keep-alive"));
		expect(text.startsWith('event: hello\ndata: {"type":"hello","at":1}\n\n')).toBe(true);
		aborter.abort();
		expect(feed.watchers).toBe(0);

		const short = watchResponse({
			feed,
			accountId: "acc_1",
			mayWatch: async () => "send",
			now: () => 1,
			lifetimeMs: 20,
		});
		expect(feed.watchers).toBe(1);
		await read(short, () => false);
		expect(feed.watchers).toBe(0);
	});

	it("sends the changes it may, in order, and ends when it may watch no more", async () => {
		const feed = createLiveFeed({ read: async () => undefined });
		const verdicts = ["send", "skip", "send", "end"] as const;
		let asked = 0;
		const response = watchResponse({
			feed,
			accountId: "acc_1",
			// The first check is the slowest: the frames still go in the order the changes came.
			mayWatch: async () => {
				const verdict = verdicts[asked] ?? "end";
				await new Promise((resolve) => setTimeout(resolve, asked === 0 ? 20 : 0));
				asked += 1;
				return verdict;
			},
			now: () => 1,
		});
		for (const state of ["starting", "running", "stopping", "stopped"] as const) {
			feed.publish({ sandboxId: "sbx_1", accountId: "acc_1", state, at: 2 });
		}
		feed.publish({ sandboxId: "sbx_2", accountId: "acc_other", state: "running", at: 2 });
		const text = await read(response, () => false);
		const states = [...text.matchAll(/"state":"(\w+)"/g)].map((match) => match[1]);
		expect(states).toEqual(["starting", "stopping"]);
		expect(feed.watchers).toBe(0);
	});
});
