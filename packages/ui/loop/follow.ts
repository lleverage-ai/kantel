// The transcript's follow check: a docked transcript streams a live turn (loop/harness/follow.tsx, one batch every
// 100 ms, as the console's client delivers it) while headless Chromium scrolls it with the wheel, as a reader does.
// It holds the transcript to T3 Code's thread scroll (pingdotgg/t3code, apps/web/src/components/chat/
// useTimelineFollow.ts and timelineViewport.ts):
//   1. at the end, it follows: the end stays in view through thinking, tool calls, a thought folding and the answer;
//   2. scrolling up lets go at once: no batch takes the reader back to the end, and what they are looking at doesn't
//      move while the turn streams below it;
//   3. scrolling back down reaches the end without being thrown back, and it follows again from there;
//   4. the Scroll to end button takes the reader to the end, and it follows again;
//   5. away from the end, the turn settling (the working header and activity row going, the answer's actions
//      arriving) moves nothing.
// Each frame is sampled after it is painted. "Moved" is how far the row under the middle of the view moved on the
// screen since the last frame, so the virtualiser's own corrections, which keep the content still, don't count.
//   pnpm --filter @kantel/ui follow [--no-build] [--cpu 4] [--smooth] [--width 1280] [--height 900] [--json out.json]

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";
import { serve } from "../scripts/workbench-server.ts";
import { buildHarness, harnessOut } from "./measure.ts";

const { values } = parseArgs({
	options: {
		"no-build": { type: "boolean", default: false },
		width: { type: "string", default: "1280" },
		height: { type: "string", default: "900" },
		/** CPU throttling, as a slow laptop or a cloud browser without a GPU. */
		cpu: { type: "string", default: "1" },
		/** Animated wheel scrolling, as a desktop browser has. */
		smooth: { type: "boolean", default: false },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
		json: { type: "string" },
	},
});

/** Within this many CSS pixels of the end counts as at the end. */
const AT_END_PX = 2;
/** Content under the middle of the view may move this much on its own, in CSS pixels, before it counts as moved. */
const STILL_PX = 2;
/** One wheel notch, and the pause between notches: a reader's rhythm, slow enough for batches to land between. */
const NOTCH_PX = 100;
const NOTCH_MS = 250;

type Sample = {
	t: number;
	phase: string;
	gap: number;
	/** Scroll to end shows. */
	button: boolean;
	/** How far the row under the middle of the view at the last sample moved on the screen since then (down is +). */
	moved: number;
};

type Check = { name: string; ok: boolean; detail: string };

/** Installs the per-frame recorder: a sample after every painted frame. */
async function record(page: Page): Promise<void> {
	await page.evaluate(() => {
		const list = document.querySelector<HTMLElement>(".kt-transcript-list");
		if (list === null) throw new Error("No transcript list");
		const samples: Sample[] = [];
		const w = window as Window & { __samples?: Sample[]; __phase?: string };
		w.__samples = samples;
		w.__phase = "start";
		let previous: { id: string; top: number } | undefined;
		const middle = () => {
			const y = list.getBoundingClientRect().top + list.clientHeight / 2;
			for (const row of list.querySelectorAll<HTMLElement>("[data-row]")) {
				const rect = row.getBoundingClientRect();
				if (rect.top <= y && rect.bottom > y) return { id: row.dataset.row ?? "", top: rect.top };
			}
			return undefined;
		};
		const sample = () => {
			let moved = 0;
			if (previous !== undefined) {
				const row = list.querySelector<HTMLElement>(`[data-row="${CSS.escape(previous.id)}"]`);
				if (row !== null) moved = row.getBoundingClientRect().top - previous.top;
			}
			previous = middle();
			samples.push({
				t: Math.round(performance.now()),
				phase: w.__phase ?? "",
				gap: Math.round(list.scrollHeight - list.clientHeight - list.scrollTop),
				button: document.querySelector(".kt-transcript-scroll-end") !== null,
				moved: Math.round(moved),
			});
		};
		// After the frame is painted: a task queued from the frame's animation callback.
		const channel = new MessageChannel();
		channel.port1.onmessage = sample;
		const loop = () => {
			channel.port2.postMessage(0);
			requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
	});
}

const phase = (page: Page, name: string) =>
	page.evaluate((name) => {
		(window as Window & { __phase?: string }).__phase = name;
	}, name);

const gap = (page: Page) =>
	page.evaluate(() => {
		const list = document.querySelector<HTMLElement>(".kt-transcript-list");
		if (list === null) throw new Error("No transcript list");
		return Math.round(list.scrollHeight - list.clientHeight - list.scrollTop);
	});

const samples = async (page: Page, name: string): Promise<Sample[]> =>
	(await page.evaluate(() => (window as Window & { __samples?: Sample[] }).__samples ?? [])).filter(
		(sample) => sample.phase === name,
	);

/** A painted frame away from the end: following, even one frame showing a batch's last lines missing counts. */
const leftEnd = (list: readonly Sample[]): Sample | undefined => list.find((sample) => sample.gap > AT_END_PX);

/** Frames where the content moved the wrong way: `allowed` says which moves are the reader's own. */
const against = (list: readonly Sample[], allowed: (moved: number) => boolean) =>
	list.filter((sample) => !allowed(sample.moved));
/**
 * From the first frame the reader has left the end, when Scroll to end shows: before the first notch lands the list is
 * still following, and a batch may land a frame before it is pinned.
 */
const afterLeaving = (list: readonly Sample[]) => {
	const index = list.findIndex((sample) => sample.button);
	return index < 0 ? [] : list.slice(index);
};
const largest = (list: readonly Sample[]) => Math.max(0, ...list.map((sample) => Math.abs(sample.moved)));

async function main() {
	if (!values["no-build"]) await buildHarness();
	const served = await serve(harnessOut());
	const browser = await chromium.launch({
		executablePath: values.chromium,
		args: values.smooth ? ["--enable-smooth-scrolling"] : [],
	});
	const checks: Check[] = [];
	const check = (name: string, ok: boolean, detail: string) => {
		checks.push({ name, ok, detail });
		console.log(`${ok ? "pass" : "FAIL"}  ${name}: ${detail}`);
	};
	try {
		const page = await browser.newPage({ viewport: { width: Number(values.width), height: Number(values.height) } });
		if (Number(values.cpu) > 1) {
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(values.cpu) });
		}
		await page.goto(`${served.url}?scenario=follow`);
		await page.waitForFunction(() => (window as Window & { __hb?: { ready: boolean } }).__hb?.ready === true);
		await record(page);
		const box = await page.locator(".kt-transcript-list").boundingBox();
		if (box === null) throw new Error("No transcript list");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
		const wheel = async (deltaY: number, times: number, pause = NOTCH_MS) => {
			for (let i = 0; i < times; i++) {
				await page.mouse.wheel(0, deltaY);
				await page.waitForTimeout(pause);
			}
		};

		// 1. Following: a thought, two calls, a second thought that folds, and the answer's start, all at the end.
		await phase(page, "follow");
		await page.evaluate(() => window.__follow?.start(260));
		await page.waitForTimeout(6_000);
		const following = await samples(page, "follow");
		const left = leftEnd(following);
		check(
			"follows the end while the reader is there",
			left === undefined,
			left === undefined ? `${following.length} frames, end in view in every one` : `left the end by ${left.gap}px`,
		);

		// 2. Up, a notch at a time while it streams: each notch moves the content down, nothing moves it back up, and once
		// the reader stops it stays where they left it.
		await phase(page, "up");
		await wheel(-NOTCH_PX, 4);
		await phase(page, "away");
		await page.waitForTimeout(2_500);
		const up = await samples(page, "up");
		const away = await samples(page, "away");
		const pulledBack = against(afterLeaving(up), (moved) => moved >= -STILL_PX);
		const movedAway = against(away, (moved) => Math.abs(moved) <= STILL_PX);
		const awayGap = await gap(page);
		check(
			"scrolling up lets go at once: no batch takes the reader back to the end",
			pulledBack.length === 0 && awayGap > 3 * NOTCH_PX,
			`${pulledBack.length} frames pulled back (largest ${largest(pulledBack)}px), ${awayGap}px from the end after ${4 * NOTCH_PX}px up`,
		);
		check(
			"away from the end, streaming below doesn't move the view",
			movedAway.length === 0 && away.length > 0 && away.every((sample) => sample.button),
			`${away.length} frames, ${movedAway.length} moved (largest ${largest(movedAway)}px), Scroll to end ${away.at(-1)?.button ? "shown" : "hidden"}`,
		);

		// 3. Back down with the wheel: it reaches the end, nothing throws it back, and it follows from there.
		await phase(page, "down");
		let reached = false;
		for (let i = 0; i < 200 && !reached; i++) {
			await wheel(NOTCH_PX, 1, 50);
			reached = (await gap(page)) <= AT_END_PX;
		}
		await wheel(NOTCH_PX, 4, 50);
		const down = await samples(page, "down");
		// Scrolling down moves content up the screen (negative); content moving down is the view thrown back up.
		const thrown = against(down, (moved) => moved <= STILL_PX);
		await phase(page, "end");
		await page.waitForTimeout(2_000);
		const end = await samples(page, "end");
		const lost = leftEnd(end);
		check(
			"scrolling back down reaches the end and isn't thrown back",
			reached && thrown.length === 0,
			`${reached ? "reached the end" : "never reached the end"}, ${thrown.length} frames thrown back (largest ${largest(thrown)}px)`,
		);
		check(
			"follows again from the end",
			lost === undefined && end.every((sample) => !sample.button),
			lost === undefined ? `${end.length} frames at the end` : `left the end by ${lost.gap}px`,
		);

		// 4. Scroll to end.
		await phase(page, "up-again");
		await wheel(-NOTCH_PX, 5);
		const upAgain = await samples(page, "up-again");
		const button = page.locator(".kt-transcript-scroll-end");
		const shown = await button.isVisible();
		await phase(page, "jump");
		if (shown) await button.click();
		await page.waitForTimeout(500);
		await phase(page, "after-jump");
		await page.waitForTimeout(1_500);
		const afterJump = await samples(page, "after-jump");
		const lostAfterJump = leftEnd(afterJump);
		check(
			"Scroll to end goes to the end and follows",
			shown && lostAfterJump === undefined && afterJump.length > 0,
			!shown
				? `no button after ${5 * NOTCH_PX}px up (${against(afterLeaving(upAgain), (moved) => moved >= -STILL_PX).length} frames pulled back)`
				: lostAfterJump === undefined
					? `${afterJump.length} frames at the end`
					: `left the end by ${lostAfterJump.gap}px`,
		);

		// 5. Away from the end while the turn settles: the working row goes and the answer gets its actions.
		await phase(page, "leave");
		await wheel(-NOTCH_PX, 4);
		await phase(page, "settle");
		await page.waitForFunction(() => window.__follow?.done === true, undefined, { timeout: 60_000 });
		await page.waitForTimeout(800);
		const leave = await samples(page, "leave");
		const settle = await samples(page, "settle");
		const settleMoved = [
			...against(afterLeaving(leave), (moved) => moved >= -STILL_PX),
			...against(settle, (moved) => Math.abs(moved) <= STILL_PX),
		];
		check(
			"the turn settling away from the end moves nothing",
			settleMoved.length === 0 && settle.length > 0,
			`${settle.length} frames, ${settleMoved.length} moved (largest ${largest(settleMoved)}px)`,
		);
	} finally {
		await browser.close();
		await served.close();
	}
	if (values.json !== undefined) writeFileSync(values.json, JSON.stringify(checks, null, "\t"));
	const failed = checks.filter((entry) => !entry.ok);
	console.log(failed.length === 0 ? "follow: all checks pass" : `follow: ${failed.length} of ${checks.length} failed`);
	process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
