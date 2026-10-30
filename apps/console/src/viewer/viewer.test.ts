import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The browser's own writer (images/browser/agent/mkv.mjs): a replay reads what the recorder wrote, byte for byte.
// @ts-expect-error: plain JavaScript, with no types
import { mkvFrame, mkvHeader } from "../../../../images/browser/agent/mkv.mjs";
import { frameAt, framePainter, readFrames } from "./mkv.ts";
import { liveTargets, pageAt, timeline, VIEW_END_MESSAGE, viewOf } from "./viewer.tsx";

const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, n, n, 0xff, 0xd9]);
const concat = (parts: readonly Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};
const chunk = (frames: readonly [number, number][]) =>
	concat([mkvHeader(1280, 800), ...frames.map(([ms, n]) => mkvFrame(ms, Buffer.from(jpeg(n))))]);

describe("reading a recording chunk", () => {
	it("reads each JPEG and its time as the browser's recorder wrote them", () => {
		const frames = readFrames(
			chunk([
				[0, 1],
				[40, 2],
				[70_123, 3],
			]),
		);
		expect(frames.map((frame) => frame.ms)).toEqual([0, 40, 70_123]);
		expect(frames.map((frame) => [...frame.jpeg])).toEqual([[...jpeg(1)], [...jpeg(2)], [...jpeg(3)]]);
	});

	it("gives the frames before a cut, from a chunk cut short", () => {
		const whole = chunk([
			[0, 1],
			[40, 2],
		]);
		expect(readFrames(whole.subarray(0, whole.length - 3)).map((frame) => frame.ms)).toEqual([0]);
		expect(readFrames(new Uint8Array([0, 1, 2]))).toEqual([]);
	});

	it("finds the newest frame at or before a time", () => {
		const frames = [{ ms: 0 }, { ms: 100 }, { ms: 250 }];
		expect(frameAt(frames, 99)?.ms).toBe(0);
		expect(frameAt(frames, 100)?.ms).toBe(100);
		expect(frameAt(frames, 9_999)?.ms).toBe(250);
		expect(frameAt([], 5)).toBeUndefined();
	});

	it("paints a frame that decodes slower than playing asks again, and never an older one over a newer", async () => {
		const decodes = new Map<string, () => void>();
		const painted: string[] = [];
		const closed: string[] = [];
		const show = framePainter(
			(frame: string) => new Promise<string>((resolve) => decodes.set(frame, () => resolve(frame))),
			(bitmap) => painted.push(bitmap),
			(bitmap) => closed.push(bitmap),
		);
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		// Playing asks for the same frame on every animation frame while it decodes: it decodes once, and paints.
		show("a");
		show("a");
		show("a");
		decodes.get("a")!();
		await settle();
		expect(painted).toEqual(["a"]);
		// b is asked for, then c before b has decoded: b is dropped (and closed), c paints.
		show("b");
		show("c");
		decodes.get("c")!();
		await settle();
		decodes.get("b")!();
		await settle();
		expect(painted).toEqual(["a", "c"]);
		expect(closed).toEqual(["a", "c", "b"]);
	});
});

describe("the view page", () => {
	it("tells its parent its stream is over with the message Harbour's view links name", () => {
		// The console doesn't depend on @harbour/browser; the source is read so the two names can't drift apart.
		const provider = readFileSync(
			new URL("../../../../packages/browser/src/runtime/provider.ts", import.meta.url),
			"utf8",
		);
		expect(provider).toContain(`export const HARBOUR_VIEW_END_MESSAGE = "${VIEW_END_MESSAGE}";`);
	});

	it("reads its browser from the path and its token from the fragment only", () => {
		expect(viewOf("/browser/b1-2", "#abcdefghij.sig_-")).toEqual({ browser: "b1-2", token: "abcdefghij.sig_-" });
		expect(viewOf("/browser/b1", "")).toBeUndefined();
		expect(viewOf("/browser/abcdefghij.sig", "")).toBeUndefined();
		expect(viewOf("/projects/p/browser/b1", "#abcdefghij.sig")).toBeUndefined();
		expect(viewOf("/browser/b1", "#short")).toBeUndefined();
	});

	it("plays a recording's pages one after another, leaving out pages with nothing drawn", () => {
		const chunkAt = (index: number, startMs: number, durationMs: number) => ({ index, startMs, durationMs });
		const { tracks, duration } = timeline({
			status: "complete",
			startedAt: 0,
			pages: [
				{ pageId: "2", startMs: 9_000, durationMs: 3_000, width: 1, height: 1, chunks: [chunkAt(0, 0, 3_000)] },
				{ pageId: "3", startMs: 12_000, durationMs: 0, width: 1, height: 1, chunks: [] },
				{
					pageId: "1",
					startMs: 0,
					durationMs: 12_000,
					width: 1,
					height: 1,
					chunks: [chunkAt(0, 0, 10_000), chunkAt(1, 10_000, 4_000)],
				},
			],
		});
		expect(tracks.map((track) => [track.pageId, track.from, track.to])).toEqual([
			["1", 0, 14_000],
			["2", 14_000, 17_000],
		]);
		expect(duration).toBe(17_000);
	});

	it("follows a replayed page's address by the navigations its recording kept", () => {
		const { tracks } = timeline({
			status: "complete",
			startedAt: 0,
			pages: [
				{
					pageId: "1",
					startMs: 0,
					durationMs: 10_000,
					width: 1,
					height: 1,
					chunks: [{ index: 0, startMs: 0, durationMs: 10_000 }],
					navigations: [
						{ atMs: 4_000, url: "https://www.iana.org/", title: "IANA" },
						{ atMs: 0, url: "https://example.com/" },
					],
				},
			],
		});
		const navigations = tracks[0]!.navigations;
		expect(pageAt(navigations, 0)?.url).toBe("https://example.com/");
		expect(pageAt(navigations, 3_999)?.url).toBe("https://example.com/");
		expect(pageAt(navigations, 4_000)).toEqual({ atMs: 4_000, url: "https://www.iana.org/", title: "IANA" });
		expect(pageAt(navigations, Number.POSITIVE_INFINITY)?.url).toBe("https://www.iana.org/");
		// A recording from before navigations were kept has no address.
		expect(pageAt(undefined, 5)).toBeUndefined();
	});

	it("reads the live browser's pages from the socket's targets message", () => {
		expect(
			liveTargets({
				type: "targets",
				active: "T2",
				targets: [{ id: "T1", url: "https://example.com/", title: "Example Domain" }, { id: "T2" }, { url: "x" }],
			}),
		).toEqual({
			active: "T2",
			targets: [{ id: "T1", url: "https://example.com/", title: "Example Domain" }, { id: "T2" }],
		});
		expect(liveTargets({ type: "ended" })).toBeUndefined();
		expect(liveTargets(null)).toBeUndefined();
	});
});
