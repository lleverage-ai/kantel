import { describe, expect, it } from "vitest";
import {
	BASE_IMAGE_INDEX_FAILURE_TTL_MS,
	BASE_IMAGE_INDEX_TTL_MS,
	baseImageIndexReader,
	baseImageIndexUrl,
	baseImageOf,
	baseStatus,
	DEFAULT_BASE_IMAGE_INDEX,
	hostImageChannel,
	hostSnapshotLinks,
	imagePatchingSwitch,
} from "../src/base-status.ts";
import { digest, HOST_BEHIND, HOST_LATEST, HOST_OLDEST, HOST_REPOSITORY, INDEX, NOW } from "./base-index-fixture.ts";

const LATEST = { version: HOST_LATEST, builtAt: "2026-11-04T00:00:00.000Z" };

describe("baseStatus", () => {
	it("matches the host images by version and says a current one is current", () => {
		expect(baseStatus(INDEX, "host", HOST_LATEST, NOW)).toEqual({
			image: "host",
			version: HOST_LATEST,
			outdated: false,
			latest: LATEST,
		});
	});

	it("says how far behind an outdated host images version is, and whether a newer one fixes its findings", () => {
		expect(baseStatus(INDEX, "host", HOST_BEHIND, NOW)).toEqual({
			image: "host",
			version: HOST_BEHIND,
			outdated: true,
			latest: LATEST,
			behind: { days: 1, versions: 1 },
			security: true,
		});
		// Superseded on 2 November, by the version after it; no scan of its own, so nothing said of its security.
		expect(baseStatus(INDEX, "host", HOST_OLDEST, NOW)).toEqual({
			image: "host",
			version: HOST_OLDEST,
			outdated: true,
			latest: LATEST,
			behind: { days: 3, versions: 2 },
		});
	});

	it("counts a version the index no longer lists as at least its history behind, keeping its name", () => {
		expect(baseStatus(INDEX, "host", "host-images-20250101.1", NOW)).toEqual({
			image: "host",
			version: "host-images-20250101.1",
			outdated: true,
			latest: LATEST,
			behind: { days: 4, versions: 30 },
		});
	});

	it("matches the container image by digest", () => {
		expect(baseStatus(INDEX, "sandbox", digest("e"), NOW)).toEqual({
			image: "sandbox",
			version: "2026.11.04.1",
			outdated: false,
			latest: { version: "2026.11.04.1", builtAt: "2026-11-04T00:00:00.000Z" },
		});
		expect(baseStatus(INDEX, "sandbox", digest("d"), NOW)).toMatchObject({
			image: "sandbox",
			version: "2026.11.03.1",
			outdated: true,
			behind: { days: 1, versions: 1 },
		});
		// An unlisted digest has no version to name.
		const unlisted = baseStatus(INDEX, "sandbox", digest("0"), NOW);
		expect(unlisted).toMatchObject({ image: "sandbox", outdated: true });
		expect(unlisted).not.toHaveProperty("version");
	});

	it("says nothing of an image the index doesn't have, or one with no stable version", () => {
		expect(baseStatus(INDEX, "isolate-host", digest("e"), NOW)).toBeUndefined();
		expect(baseStatus(INDEX, "browser", digest("e"), NOW)).toBeUndefined();
	});

	it("files a digest under the container image and a version under the host images", () => {
		expect(baseImageOf(digest("e"))).toBe("sandbox");
		expect(baseImageOf(HOST_LATEST)).toBe("host");
	});
});

describe("hostImageChannel", () => {
	it("names the host images' stable version at their repository", () => {
		expect(hostImageChannel(INDEX)).toEqual({ channel: "stable", version: HOST_LATEST, url: HOST_REPOSITORY });
		expect(hostImageChannel({ ...INDEX, images: INDEX.images.filter((image) => image.name !== "host") })).toBe(
			undefined,
		);
	});
});

describe("baseImageIndexReader", () => {
	const reader = (answers: (() => Response)[]) => {
		let at = NOW;
		let calls = 0;
		const read = baseImageIndexReader({
			url: "https://example.test/index.json",
			now: () => at,
			fetch: async () => {
				const answer = answers[Math.min(calls, answers.length - 1)];
				calls += 1;
				if (answer === undefined) throw new Error("no answer");
				return answer();
			},
		});
		return {
			read,
			calls: () => calls,
			advance: (ms: number) => {
				at += ms;
			},
		};
	};
	const ok = () => Response.json(INDEX);

	it("reads the index once for many callers, and again once it is old", async () => {
		const { read, calls, advance } = reader([ok]);
		const [first, second] = await Promise.all([read.index(), read.index()]);
		expect(first?.images.map((image) => image.name)).toEqual(["host", "sandbox", "browser"]);
		expect(second).toBe(first);
		expect(calls()).toBe(1);
		advance(BASE_IMAGE_INDEX_TTL_MS - 1);
		await read.index();
		expect(calls()).toBe(1);
		advance(1);
		await read.index();
		expect(calls()).toBe(2);
		expect(read.indexUrl).toBe("https://example.test/index.json");
	});

	it("gives up on an index that stalls, aborting it, and reads again once the failure is old", async () => {
		let at = NOW;
		const signals: AbortSignal[] = [];
		let calls = 0;
		const read = baseImageIndexReader({
			url: "https://example.test/index.json",
			now: () => at,
			timeoutMs: 20,
			fetch: async (_url, init) => {
				calls += 1;
				if (init?.signal) signals.push(init.signal);
				// The first answers headers, then never finishes its body; the second answers.
				if (calls === 1) return { ok: true, json: () => new Promise(() => {}) } as unknown as Response;
				return Response.json(INDEX);
			},
		});
		await expect(Promise.all([read.index(), read.index()])).rejects.toThrow(/took longer than 0.02s/);
		expect(calls).toBe(1);
		expect(signals[0]?.aborted).toBe(true);
		await expect(read.index()).rejects.toThrow(/took longer/);
		at += BASE_IMAGE_INDEX_FAILURE_TTL_MS;
		await expect(read.index()).resolves.toMatchObject({ version: 1 });
		expect(calls).toBe(2);
	});

	it("keeps a failure for a minute, saying why", async () => {
		const { read, calls, advance } = reader([() => new Response("gone", { status: 503 }), ok]);
		await expect(read.index()).rejects.toThrow("answered 503");
		await expect(read.index()).rejects.toThrow("answered 503");
		expect(calls()).toBe(1);
		advance(BASE_IMAGE_INDEX_FAILURE_TTL_MS);
		expect((await read.index())?.version).toBe(1);
		expect(calls()).toBe(2);
	});

	it("refuses a document that isn't an index", async () => {
		const { read } = reader([() => Response.json({ version: 99, images: [] })]);
		await expect(read.index()).rejects.toThrow("Not a base image index");
	});
});

describe("the switches", () => {
	it("reads KANTEL_IMAGE_PATCHING", () => {
		expect(imagePatchingSwitch(undefined)).toBe(false);
		expect(imagePatchingSwitch(" off ")).toBe(false);
		expect(imagePatchingSwitch("Experimental")).toBe(true);
		expect(() => imagePatchingSwitch("on")).toThrow("KANTEL_IMAGE_PATCHING");
	});

	it("reads KANTEL_BASE_IMAGE_INDEX", () => {
		expect(baseImageIndexUrl(undefined)).toBe(DEFAULT_BASE_IMAGE_INDEX);
		expect(baseImageIndexUrl("https://mirror.example/index.json")).toBe("https://mirror.example/index.json");
		expect(() => baseImageIndexUrl("ftp://mirror.example/index.json")).toThrow("KANTEL_BASE_IMAGE_INDEX");
	});
});

describe("hostSnapshotLinks", () => {
	const recorded: string[] = [];
	const service = {
		recordBases: async (hostId: string) => {
			recorded.push(`bases ${hostId}`);
		},
		recordSnapshotSizes: async (
			hostId: string,
			sizes: readonly { readonly ref: string; readonly sizeBytes: number }[],
		) => {
			recorded.push(`sizes ${hostId} ${sizes.length}`);
		},
	};

	it("passes on snapshot sizes with image patching off, and no images or bases", async () => {
		const links = hostSnapshotLinks(service, undefined);
		await links.recordSnapshotSizes("host_a", [{ ref: "host_a/snap", sizeBytes: 1 }]);
		expect(recorded).toEqual(["sizes host_a 1"]);
		expect("images" in links).toBe(false);
		expect("recordBases" in links).toBe(false);
	});

	it("adds the images and bases with image patching on", async () => {
		const links = hostSnapshotLinks(service, { index: async () => INDEX });
		expect(await links.images?.()).toEqual(hostImageChannel(INDEX));
		await links.recordBases?.("host_b", {});
		await links.recordSnapshotSizes("host_b", []);
		expect(recorded.slice(-2)).toEqual(["bases host_b", "sizes host_b 0"]);
	});
});
