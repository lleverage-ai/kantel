// A release check: the latest kantel-host release read again at once, rather than within the hour. The release
// workflow asks for one when it publishes a release (`POST /v1/hosts/releases/check`, on the release token), and a
// super-admin's Check for updates does too. Every reader sharing the store (several replicas over one database, or one
// stack object's many requests) reads again too, and one check every `CHECK_GAP_MS` is all that's made.
import { isKantelError } from "@kantel/contracts";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostsApi, HOSTS_RELEASE_CHECK_PATH } from "../src/http.ts";
import {
	CHECK_GAP_MS,
	CHECK_POLL_MS,
	createHostReleases,
	createMemoryHostReleasesStore,
	createSqlHostReleasesStore,
	type HostReleasesStore,
} from "../src/releases.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore, migrateHosts } from "../src/store.ts";
import { facts } from "./fake-host.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** GitHub's `…/releases/latest`: a redirect to whichever tag `latest` names now. */
function github(initial: string) {
	const state = { latest: initial, reads: 0, fail: false };
	const fetcher = (async () => {
		state.reads += 1;
		if (state.fail) return new Response("unavailable", { status: 503 });
		return new Response(null, {
			status: 302,
			headers: { location: `https://github.com/lleverage-ai/kantel/releases/tag/v${state.latest}` },
		});
	}) as typeof fetch;
	return { state, fetcher };
}

/** A clock every reader shares, moved by hand. */
function clock(start = 1_000_000) {
	const state = { now: start };
	return { state, now: () => state.now };
}

describe("a release check", () => {
	it("reads the release again at once, whatever is kept, and at most once every 30 seconds", async () => {
		const { state, fetcher } = github("0.3.0");
		const time = clock();
		const releases = createHostReleases({ fetch: fetcher, now: time.now, log: () => {} });
		expect(await releases.latest()).toBe("0.3.0");
		expect(state.reads).toBe(1);

		// 0.3.1 is out: the hour isn't up, so what's kept stands until a check.
		state.latest = "0.3.1";
		time.state.now += 60_000;
		expect(await releases.latest()).toBe("0.3.0");
		expect(state.reads).toBe(1);
		expect(await releases.check?.()).toEqual({ checked: true, latestVersion: "0.3.1" });
		expect(state.reads).toBe(2);
		expect(await releases.latest()).toBe("0.3.1");
		expect(releases.known()).toBe("0.3.1");

		// Asked again within the gap (a retried workflow step, a second click): nothing more is read.
		time.state.now += CHECK_GAP_MS - 1;
		expect(await releases.check?.()).toEqual({ checked: false, latestVersion: "0.3.1" });
		expect(state.reads).toBe(2);
		time.state.now += 1;
		expect(await releases.check?.()).toEqual({ checked: true, latestVersion: "0.3.1" });
		expect(state.reads).toBe(3);
	});

	it("says when the release can't be read, keeping what it had", async () => {
		const { state, fetcher } = github("0.3.0");
		const time = clock();
		const releases = createHostReleases({ fetch: fetcher, now: time.now, log: () => {} });
		expect(await releases.latest()).toBe("0.3.0");
		state.fail = true;
		await expect(releases.check?.()).rejects.toThrow(/Couldn't read the latest kantel-host release: .*503/);
		expect(releases.known()).toBe("0.3.0");
	});

	it("isn't undone by a read that started before it", async () => {
		const time = clock();
		let release!: () => void;
		const answers = ["0.3.0", "0.3.1"];
		let reads = 0;
		// The first read is held until after the check has asked for its own.
		const fetcher = (async () => {
			const tag = answers[reads++];
			if (reads === 1) await new Promise<void>((resolve) => (release = resolve));
			return new Response(null, {
				status: 302,
				headers: { location: `https://github.com/lleverage-ai/kantel/releases/tag/v${tag}` },
			});
		}) as typeof fetch;
		const releases = createHostReleases({ fetch: fetcher, now: time.now, timeoutMs: 1 });
		expect(releases.known()).toBeUndefined();
		await tick();
		const checking = releases.check?.();
		await tick();
		release();
		expect(await checking).toEqual({ checked: true, latestVersion: "0.3.1" });
		expect(releases.known()).toBe("0.3.1");
		expect(reads).toBe(2);
	});
});

function sharedBy(name: string, open: () => Promise<HostReleasesStore>, timeout?: number) {
	describe(`readers sharing a store (${name})`, { ...(timeout === undefined ? {} : { timeout }) }, () => {
		it("has every reader read again once one of them checks", async () => {
			const store = await open();
			const { state, fetcher } = github("0.3.0");
			const time = clock();
			const made = () => createHostReleases({ fetch: fetcher, now: time.now, store, log: () => {} });
			// Two replicas (or isolates) each with what they read kept in memory.
			const [one, two, three] = [made(), made(), made()];
			for (const reader of [one, two, three]) expect(await reader.latest()).toBe("0.3.0");
			expect(state.reads).toBe(3);

			state.latest = "0.3.1";
			time.state.now += 60_000;
			expect(await one.check?.()).toEqual({ checked: true, latestVersion: "0.3.1" });
			expect(state.reads).toBe(4);
			// The others see the check on their next ask and read again, well inside the hour.
			expect(await two.latest()).toBe("0.3.1");
			expect(state.reads).toBe(5);
			// One that's only asked what it knows answers what it has, and has the new release by the next ask.
			expect(three.known()).toBe("0.3.0");
			await vi.waitFor(() => expect(three.known()).toBe("0.3.1"), { timeout: 5_000, interval: 5 });
			expect(state.reads).toBe(6);
			// And no reader reads again for that check after.
			time.state.now += CHECK_POLL_MS;
			for (const reader of [one, two, three]) expect(await reader.latest()).toBe("0.3.1");
			expect(state.reads).toBe(6);

			// The gap is shared: a check on another reader within it reads nothing.
			expect(await two.check?.()).toEqual({ checked: false, latestVersion: "0.3.1" });
			expect(state.reads).toBe(6);
		});

		it("answers a check within the gap with what the last one found, on any reader", async () => {
			const store = await open();
			const { state, fetcher } = github("0.3.0");
			const time = clock();
			const made = () => createHostReleases({ fetch: fetcher, now: time.now, store, log: () => {} });
			const [one, two] = [made(), made()];
			for (const reader of [one, two]) expect(await reader.latest()).toBe("0.3.0");
			state.latest = "0.3.1";
			time.state.now += 60_000;
			expect(await one.check?.()).toEqual({ checked: true, latestVersion: "0.3.1" });
			// A retried workflow step that lands on the other replica before it has looked: it catches up, not 0.3.0.
			time.state.now += 1_000;
			expect(await two.check?.()).toEqual({ checked: false, latestVersion: "0.3.1" });
		});

		it("looks for another's check at most every few seconds", async () => {
			const store = await open();
			let looks = 0;
			const counted: HostReleasesStore = {
				lastCheck: () => {
					looks += 1;
					return store.lastCheck();
				},
				claimCheck: (at, gap) => store.claimCheck(at, gap),
			};
			const { fetcher } = github("0.3.0");
			const time = clock();
			const reader = createHostReleases({ fetch: fetcher, now: time.now, store: counted });
			for (let i = 0; i < 20; i++) await reader.latest();
			expect(looks).toBe(1);
			time.state.now += CHECK_POLL_MS;
			await reader.latest();
			expect(looks).toBe(2);
		});

		it("lets only one of two checks at once through", async () => {
			const store = await open();
			const claims = await Promise.all([store.claimCheck(5_000, CHECK_GAP_MS), store.claimCheck(5_000, CHECK_GAP_MS)]);
			expect(claims.filter(Boolean)).toHaveLength(1);
			expect(await store.lastCheck()).toBe(5_000);
			expect(await store.claimCheck(5_000 + CHECK_GAP_MS - 1, CHECK_GAP_MS)).toBe(false);
			expect(await store.claimCheck(5_000 + CHECK_GAP_MS, CHECK_GAP_MS)).toBe(true);
			expect(await store.lastCheck()).toBe(5_000 + CHECK_GAP_MS);
		});
	});
}

sharedBy("memory", async () => createMemoryHostReleasesStore());

for (const kind of testDatabaseKinds()) {
	sharedBy(
		kind.name,
		async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			// The registry's migration makes the table, twice over as every start does.
			await migrateHosts(database.driver);
			await migrateHosts(database.driver);
			return createSqlHostReleasesStore(database.driver);
		},
		kind.testTimeoutMs,
	);
}

describe("POST /v1/hosts/releases/check", () => {
	const TOKEN = "a".repeat(64);

	function setup(options: { releaseToken?: string; desiredVersion?: string; releases?: boolean } = {}) {
		const gh = github("0.3.0");
		const service: HostsService = createHostsService({
			store: createMemoryHostStore(),
			publicUrl: "https://kantel.example.com/",
			log: () => {},
			...(options.desiredVersion === undefined ? {} : { desiredVersion: options.desiredVersion }),
			...(options.releases === false ? {} : { releases: createHostReleases({ fetch: gh.fetcher, log: () => {} }) }),
		});
		cleanups.push(() => service.close());
		const api = createHostsApi({
			hosts: service,
			authorizeAdmin: () => Promise.reject(new Error("not for these tests")),
			...(options.releaseToken === undefined ? {} : { releaseToken: options.releaseToken }),
		});
		const call = async (init: { bearer?: string; method?: string; body?: unknown } = {}) => {
			const response = await api.fetch(
				new Request(`https://kantel.example.com${HOSTS_RELEASE_CHECK_PATH}`, {
					method: init.method ?? "POST",
					headers: {
						...(init.bearer === undefined ? {} : { authorization: `Bearer ${init.bearer}` }),
						"content-type": "application/json",
					},
					...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				}),
			);
			if (response === undefined) throw new Error("not answered");
			return { status: response.status, body: (await response.json()) as Record<string, unknown> };
		};
		return { gh, call, service };
	}

	it("refuses every call while this control plane has no release token, or one too short to trust", async () => {
		for (const releaseToken of [undefined, "", "short-token"]) {
			const { gh, call } = setup(releaseToken === undefined ? {} : { releaseToken });
			// The service reads the release once as it starts; a refused call reads nothing more.
			await tick();
			const reads = gh.state.reads;
			for (const bearer of [undefined, "", "short-token", TOKEN]) {
				const answer = await call(bearer === undefined ? {} : { bearer });
				expect(answer.status).toBe(403);
				expect(answer.body).toMatchObject({ error: { code: "forbidden" } });
			}
			expect(gh.state.reads).toBe(reads);
		}
	});

	it("refuses a call without the token, or with a wrong one, and reads nothing", async () => {
		const { gh, call } = setup({ releaseToken: TOKEN });
		await tick();
		const reads = gh.state.reads;
		for (const bearer of [undefined, "", "b".repeat(64), `${TOKEN}x`, TOKEN.slice(1)]) {
			const answer = await call(bearer === undefined ? {} : { bearer });
			expect(answer.status).toBe(401);
			expect(answer.body).toMatchObject({ error: { code: "unauthenticated" } });
		}
		expect(gh.state.reads).toBe(reads);
		expect((await call({ bearer: TOKEN, method: "GET" })).status).toBe(405);
	});

	it("with the token, reads the release itself, never a version it's sent, and does nothing more when asked again", async () => {
		const { gh, call, service } = setup({ releaseToken: TOKEN });
		gh.state.latest = "0.3.1";
		const first = await call({ bearer: TOKEN, body: { version: "9.9.9", tag_name: "v9.9.9" } });
		expect(first).toEqual({ status: 200, body: { checked: true, latestVersion: "0.3.1" } });
		const reads = gh.state.reads;
		// A workflow step retried at once: answered, nothing more read.
		const again = await call({ bearer: TOKEN });
		expect(again).toEqual({ status: 200, body: { checked: false, latestVersion: "0.3.1" } });
		expect(gh.state.reads).toBe(reads);
		// A host on the release before shows as behind straight away.
		const token = await service.createJoinToken({ name: "box" });
		const { hostId } = await service.register({ token: token.token, facts: { ...facts(), version: "0.3.0" } });
		expect(await service.get(hostId)).toMatchObject({ latestVersion: "0.3.1", updateAvailable: true });
	});

	it("is not supported where no release is read, and unavailable when it can't be", async () => {
		const pinned = setup({ releaseToken: TOKEN, desiredVersion: "0.2.0" });
		expect(await pinned.call({ bearer: TOKEN })).toMatchObject({
			status: 501,
			body: { error: { code: "not_supported" } },
		});
		const off = setup({ releaseToken: TOKEN, releases: false });
		expect(await off.call({ bearer: TOKEN })).toMatchObject({
			status: 501,
			body: { error: { code: "not_supported" } },
		});
		const down = setup({ releaseToken: TOKEN });
		down.gh.state.fail = true;
		expect(await down.call({ bearer: TOKEN })).toMatchObject({ status: 503, body: { error: { code: "unavailable" } } });
		await expect(down.service.checkForUpdates()).resolves.toMatchObject({ checked: false });
		expect(isKantelError(await off.service.checkForUpdates().catch((error) => error), "not_supported")).toBe(true);
	});
});
