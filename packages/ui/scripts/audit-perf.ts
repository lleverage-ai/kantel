// Measures the audit timeline over 100k events in headless Chromium, on the workbench's Large story:
//   - how long until the first rows show (the story builds its 100k-event store in the page first; that time is
//     reported apart, as it is the fixture's cost, not the view's);
//   - each page read as the reader scrolls (the in-memory store's query, through the view's feed);
//   - frame times while scrolling through every loaded row, and how many rows are mounted at once.
//   pnpm build:workbench && node scripts/audit-perf.ts [--pages 40] [--json out.json]

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { serve } from "./workbench-server.ts";

const { values } = parseArgs({
	options: {
		build: { type: "string", default: new URL("../build/", import.meta.url).pathname },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
		pages: { type: "string", default: "40" },
		json: { type: "string" },
	},
});

const percentile = (list: number[], p: number) => {
	const sorted = [...list].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};
const round = (value: number) => Math.round(value * 10) / 10;

const server = await serve(values.build);
const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
	page.on("crash", () => console.error("The page crashed"));
	page.on("pageerror", (error) => console.error(`Page error: ${error.message}`));
	const opened = Date.now();
	await page.goto(`${server.url}?story=audit--audit-view--large&mode=preview`);
	await page.waitForSelector(".kt-audit-row", { timeout: 120_000 });
	const firstRows = Date.now() - opened;

	const result = await page.evaluate(async (pages: number) => {
		const list = document.querySelector(".kt-audit-list") as HTMLElement;
		const status = document.querySelector(".kt-audit-status") as HTMLElement;
		const loaded = () => Number(status.dataset.loaded ?? 0);
		const frame = () => new Promise<number>((resolve) => requestAnimationFrame((at) => resolve(at)));
		const frames: number[] = [];
		const pageReads: number[] = [];
		let mountedMax = 0;
		let last = await frame();
		for (let read = 0; read < pages; read += 1) {
			const before = loaded();
			const started = performance.now();
			// Scroll in viewport-sized steps to the end of what's loaded, as a reader flinging down would. The end is
			// fixed at the start of the step, so a page that lands meanwhile counts towards the next step.
			const end = list.scrollHeight;
			while (list.scrollTop + list.clientHeight < end - 2) {
				list.scrollTop += list.clientHeight;
				const now = await frame();
				frames.push(now - last);
				last = now;
				mountedMax = Math.max(mountedMax, list.querySelectorAll(".kt-audit-row").length);
			}
			// Wait for the next page to land.
			while (loaded() === before) {
				const now = await frame();
				frames.push(now - last);
				last = now;
				if (performance.now() - started > 10_000) break;
			}
			pageReads.push(performance.now() - started);
		}
		return { frames, pageReads, mountedMax, loaded: loaded() };
	}, Number(values.pages));

	const summary = {
		story: "audit--audit-view--large",
		events: 100_000,
		firstRowsMs: firstRows,
		rowsLoaded: result.loaded,
		mountedRowsMax: result.mountedMax,
		frames: result.frames.length,
		frameMedianMs: round(percentile(result.frames, 0.5)),
		frameP95Ms: round(percentile(result.frames, 0.95)),
		frameMaxMs: round(Math.max(...result.frames)),
		longFrames: result.frames.filter((ms) => ms > 50).length,
		pageScrollAndReadMedianMs: round(percentile(result.pageReads, 0.5)),
		pageScrollAndReadP95Ms: round(percentile(result.pageReads, 0.95)),
	};
	console.log(JSON.stringify(summary, null, 2));
	if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(summary, null, 2)}\n`);
} finally {
	await browser.close();
	await server.close();
}
