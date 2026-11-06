// Hosts out of date: the latest kantel-host release, read and kept; which hosts are behind it (or behind the version
// the operator set); and an update asked of one host over its connection.
import { isKantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareVersions,
	createHostReleases,
	DEFAULT_HOST_UPDATE_URL,
	type HostReleases,
	needsUpdate,
} from "../src/releases.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { FakeHost, facts } from "./fake-host.ts";

const services: HostsService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("release versions", () => {
	it("orders releases, prereleases before theirs, and leaves builds that aren't releases unordered", () => {
		expect(compareVersions("0.4.1", "0.4.2")).toBe(-1);
		expect(compareVersions("v0.10.0", "0.9.9")).toBe(1);
		expect(compareVersions("0.4.2", "v0.4.2")).toBe(0);
		expect(compareVersions("0.5.0-rc.1", "0.5.0")).toBe(-1);
		expect(compareVersions("0.5.0-rc.2", "0.5.0-rc.10")).toBe(-1);
		expect(compareVersions("0.5.0-beta", "0.5.0-alpha")).toBe(1);
		expect(compareVersions("dev", "0.4.2")).toBeUndefined();
	});

	it("says a host is out of date when it's older than the release, or on any other version than a pin", () => {
		expect(needsUpdate("0.4.1", "0.4.2", false)).toBe(true);
		expect(needsUpdate("0.4.2", "v0.4.2", false)).toBe(false);
		// Newer than the latest release, or a build of its own: left alone.
		expect(needsUpdate("0.5.0-rc.1", "0.4.2", false)).toBe(false);
		expect(needsUpdate("dev", "0.4.2", false)).toBe(false);
		// The operator's version is the one to run, an older one included.
		expect(needsUpdate("0.5.0", "0.4.2", true)).toBe(true);
		expect(needsUpdate("dev", "0.4.2", true)).toBe(true);
		// A host that hasn't said what it runs.
		expect(needsUpdate(undefined, "0.4.2", true)).toBe(false);
	});
});

describe("the latest release", () => {
	function github(answers: (() => Response | Promise<Response>)[]) {
		const urls: string[] = [];
		const fetcher = (async (input: string | URL | Request) => {
			urls.push(String(input));
			const next = answers.shift();
			if (next === undefined) throw new Error("no more answers");
			return next();
		}) as typeof fetch;
		return { urls, fetcher };
	}

	/** GitHub's answer to `…/releases/latest`: a redirect to the release's tag. */
	const redirect = (tag: string) =>
		new Response(null, {
			status: 302,
			headers: { location: `https://github.com/lleverage-ai/kantel/releases/tag/${tag}` },
		});

	it("reads GitHub's latest release once an hour, and a failed read again after a few minutes", async () => {
		let now = 1_000;
		const logs: string[] = [];
		const { urls, fetcher } = github([
			() => redirect("v0.4.2"),
			() => new Response("unavailable", { status: 503 }),
			() => redirect("v0.4.3"),
		]);
		const releases = createHostReleases({ fetch: fetcher, now: () => now, log: (line) => logs.push(line) });
		expect(releases.known()).toBeUndefined();
		expect(await releases.latest()).toBe("0.4.2");
		expect(urls).toEqual(["https://github.com/lleverage-ai/kantel/releases/latest"]);
		now += 59 * 60 * 1000;
		expect(await releases.latest()).toBe("0.4.2");
		expect(urls).toHaveLength(1);
		// An hour on, the read fails: what was read is kept, and it's tried again 5 minutes later.
		now += 2 * 60 * 1000;
		expect(await releases.latest()).toBe("0.4.2");
		expect(logs.join("\n")).toMatch(/couldn't read the latest kantel-host: .*503/);
		now += 4 * 60 * 1000;
		expect(await releases.latest()).toBe("0.4.2");
		expect(urls).toHaveLength(2);
		now += 2 * 60 * 1000;
		expect(await releases.latest()).toBe("0.4.3");
	});

	it("takes a mirror's {version} or GitHub API's {tag_name}, refuses one naming no release, and never waits long", async () => {
		const api = github([() => Response.json({ tag_name: "v0.5.1" })]);
		// A mirror that moved its JSON: the redirect is followed, as before.
		const moved = github([
			() => new Response(null, { status: 301, headers: { location: "/v2/latest.json" } }),
			() => Response.json({ version: "0.5.2" }),
		]);
		expect(await createHostReleases({ url: "https://dl.example/latest.json", fetch: moved.fetcher }).latest()).toBe(
			"0.5.2",
		);
		expect(moved.urls).toEqual(["https://dl.example/latest.json", "https://dl.example/v2/latest.json"]);
		expect(await createHostReleases({ url: "https://api.example/latest", fetch: api.fetcher }).latest()).toBe("0.5.1");
		const mirror = github([() => Response.json({ version: "0.6.0" })]);
		expect(await createHostReleases({ url: "https://dl.example/latest.json", fetch: mirror.fetcher }).latest()).toBe(
			"0.6.0",
		);
		expect(mirror.urls).toEqual(["https://dl.example/latest.json"]);
		const odd = github([() => Response.json({ tag_name: "host-images-20261104.1" })]);
		expect(await createHostReleases({ fetch: odd.fetcher, log: () => {} }).latest()).toBeUndefined();
		const slow = github([() => new Promise<Response>(() => {})]);
		const started = Date.now();
		expect(await createHostReleases({ fetch: slow.fetcher, timeoutMs: 20 }).latest()).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("doesn't wait when only asked what it knows, and reads once for many asking at once", async () => {
		let release!: (response: Response) => void;
		const { urls, fetcher } = github([() => new Promise<Response>((resolve) => (release = resolve))]);
		const releases = createHostReleases({ fetch: fetcher });
		expect(releases.known()).toBeUndefined();
		expect(releases.known()).toBeUndefined();
		const waiting = releases.latest();
		await tick();
		release(Response.json({ tag_name: "v1.0.0" }));
		expect(await waiting).toBe("1.0.0");
		expect(releases.known()).toBe("1.0.0");
		expect(urls).toHaveLength(1);
	});
});

describe("updating a host", () => {
	/** A release source that answers `version` at once. */
	const released = (version: string | undefined): HostReleases => ({
		latest: async () => version,
		known: () => version,
	});

	async function setup(options: { desiredVersion?: string; releases?: HostReleases; updateUrl?: string } = {}) {
		const service = createHostsService({
			store: createMemoryHostStore(),
			publicUrl: "https://kantel.example.com/",
			log: () => {},
			...options,
		});
		services.push(service);
		const join = async (name: string, version: string) => {
			const token = await service.createJoinToken({ name });
			const { hostId } = await service.register({ token: token.token, facts: { ...facts(), version } });
			const host = new FakeHost(service, hostId);
			host.moreFacts = { version };
			host.answer = (method) => (method === "host.update" ? { ok: true } : undefined);
			host.connect();
			await tick();
			return { hostId, host };
		};
		return { service, join };
	}

	it("flags a host older than the latest release, and moves it to it over its connection", async () => {
		const { service, join } = await setup({ releases: released("0.4.2") });
		const old = await join("old", "0.4.1");
		const current = await join("current", "0.4.2");
		const ahead = await join("ahead", "0.5.0-rc.1");
		const views = new Map((await service.list()).map((view) => [view.name, view]));
		expect(views.get("old")).toMatchObject({ version: "0.4.1", latestVersion: "0.4.2", updateAvailable: true });
		expect(views.get("current")).toMatchObject({ latestVersion: "0.4.2" });
		expect(views.get("current")?.updateAvailable).toBeUndefined();
		expect(views.get("ahead")?.updateAvailable).toBeUndefined();

		expect(await service.updateAgent(old.hostId)).toEqual({ version: "0.4.2" });
		expect(old.host.calls.filter((call) => call.method === "host.update")).toEqual([
			{ method: "host.update", params: { version: "0.4.2", url: DEFAULT_HOST_UPDATE_URL } },
		]);
		// Up to date, or ahead of the release: nothing to do.
		for (const { hostId } of [current, ahead]) {
			await expect(service.updateAgent(hostId)).rejects.toSatisfy((error) => isKantelError(error, "conflict"));
		}
	});

	it("moves a host to the operator's version from where the operator says, even back to an older one", async () => {
		const { service, join } = await setup({
			desiredVersion: "0.4.0",
			updateUrl: "https://dl.example/{version}/kantel-host-{os}-{arch}",
			releases: released("0.4.2"),
		});
		const { hostId, host } = await join("box", "0.4.2");
		expect(await service.get(hostId)).toMatchObject({ latestVersion: "0.4.0", updateAvailable: true });
		await service.updateAgent(hostId);
		expect(host.calls.find((call) => call.method === "host.update")?.params).toEqual({
			version: "0.4.0",
			url: "https://dl.example/{version}/kantel-host-{os}-{arch}",
		});
	});

	it("refuses a host that isn't connected or is revoked, and says why when no version is known", async () => {
		const { service, join } = await setup({ releases: released("0.4.2") });
		const { hostId, host } = await join("box", "0.4.1");
		host.connection.closed(1006, "gone");
		await tick();
		await expect(service.updateAgent(hostId)).rejects.toSatisfy((error) => isKantelError(error, "unavailable"));
		await service.revoke(hostId);
		await expect(service.updateAgent(hostId)).rejects.toSatisfy((error) => isKantelError(error, "conflict"));

		const unread = await setup({ releases: released(undefined) });
		const box = await unread.join("box", "0.4.1");
		expect((await unread.service.get(box.hostId)).latestVersion).toBeUndefined();
		await expect(unread.service.updateAgent(box.hostId)).rejects.toSatisfy((error) =>
			isKantelError(error, "unavailable"),
		);
		const none = await setup();
		const other = await none.join("box", "0.4.1");
		await expect(none.service.updateAgent(other.hostId)).rejects.toSatisfy((error) =>
			isKantelError(error, "not_supported"),
		);
	});

	it("takes a host that never answered to be updating, since it may still restart on the new version", async () => {
		const service = createHostsService({
			store: createMemoryHostStore(),
			publicUrl: "https://kantel.example.com/",
			log: () => {},
			releases: released("0.4.2"),
		});
		services.push(service);
		const token = await service.createJoinToken({ name: "slow" });
		const { hostId } = await service.register({ token: token.token, facts: { ...facts(), version: "0.4.1" } });
		const host = new FakeHost(service, hostId);
		host.moreFacts = { version: "0.4.1" };
		// Still downloading when the wait ends: it never answers.
		host.hold = (method) => (method === "host.update" ? new Promise<void>(() => {}) : undefined);
		host.connect();
		await tick();
		// The update's own wait is minutes long; this one ends it at once by dropping the link.
		const asked = service.updateAgent(hostId);
		await tick();
		host.connection.closed(1006, "gone");
		expect(await asked).toEqual({ version: "0.4.2" });
	});

	it("passes on the host's refusal", async () => {
		const { service, join } = await setup({ releases: released("0.4.2") });
		const { hostId, host } = await join("box", "0.4.1");
		host.refuse = (method) =>
			method === "host.update" ? { code: "unsupported", message: "this host is updated on the machine" } : undefined;
		await expect(service.updateAgent(hostId)).rejects.toSatisfy(
			(error) => isKantelError(error, "not_supported") && /updated on the machine/.test((error as Error).message),
		);
	});
});
