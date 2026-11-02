// Gathers the console's performance evidence against a running console (a profiling build is best:
// `pnpm build:profiling && pnpm preview`) with a headless Chromium:
//   1. React Profiler: which rows render while the 2,000-turn session streams its long answer.
//   2. A simulated disconnect mid-stream, and how the console resumes.
//   3. Frame times while scrolling the whole 2,000-turn history, at desktop and at 420 px.
// Writes evidence/out/results.json and screenshots.
//   node scripts/evidence.ts [--url http://127.0.0.1:4173/] [--chromium /usr/bin/chromium]

import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Browser, chromium, type Page } from "playwright-core";
import type { SessionState } from "../src/state/session-client.ts";

const { values } = parseArgs({
	options: {
		url: { type: "string", default: "http://127.0.0.1:4173/" },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
		out: { type: "string", default: new URL("../evidence/out/", import.meta.url).pathname },
	},
});
const out = values.out;
mkdirSync(out, { recursive: true });
const base = values.url;

type Win = Window & {
	__kantel?: {
		// Both are set once a session is open; `open` waits for that.
		host: { finished: boolean; head: string; published: number };
		client: { getState(): SessionState; simulateDisconnect(ms?: number): void };
	};
	__kantelProfile?: {
		updates: Record<string, number>;
		mounts: Record<string, number>;
		baseline: Set<string>;
		records: { id: string; phase: string; actualMs: number }[];
	};
};

async function open(browser: Browser, width: number, height: number, query: string): Promise<Page> {
	const page = await browser.newPage({
		viewport: { width, height },
		deviceScaleFactor: width < 600 ? 2 : 1,
		colorScheme: "dark",
	});
	// The 2,000-turn recording is the Kantel project's "Platform migration" session.
	const rest = query.replace(/^session=long&?/, "");
	await page.goto(
		new URL(`projects/kantel/sessions/s-migration?source=recorded${rest === "" ? "" : `&${rest}`}`, base).href,
	);
	await page.waitForFunction(
		() =>
			(window as Win).__kantel?.client?.getState().cursor !== undefined &&
			(window as Win).__kantel?.host !== undefined,
		undefined,
		{
			timeout: 30_000,
		},
	);
	return page;
}

async function profilerRun(browser: Browser) {
	const page = await open(browser, 1440, 900, "session=long&profile=1&delay=1500");
	await page.waitForTimeout(9_000);
	await page.screenshot({ path: `${out}/profiler-streaming-desktop.png` });
	await page.waitForFunction(
		() => {
			const kantel = (window as Win).__kantel;
			return kantel?.host.finished === true && kantel.client.getState().status === "idle";
		},
		undefined,
		{ timeout: 120_000, polling: 500 },
	);
	await page.waitForTimeout(800);
	await page.screenshot({ path: `${out}/profiler-done-desktop.png` });
	const result = await page.evaluate(() => {
		const profile = (window as Win).__kantelProfile!;
		const state = (window as Win).__kantel!.client.getState();
		const items = state.items;
		const updates = Object.entries(profile.updates).filter(([id]) => id !== "transcript-list");
		const earlier = updates.filter(([id]) => profile.baseline.has(id));
		const durations = profile.records
			.filter((record) => record.id === "transcript-list" && record.phase !== "mount")
			.map((record) => record.actualMs)
			.sort((a, b) => a - b);
		return {
			commitsFromStream: state.flushes,
			hostDeltas: (window as Win).__kantel!.host.published,
			baselineRows: profile.baseline.size,
			rowsRerendered: Object.fromEntries(
				updates.map(([id, count]) => [id, { count, kind: items.find((item) => item.id === id)?.kind }]),
			),
			rowsMounted: Object.keys(profile.mounts).filter((id) => id !== "transcript-list").length,
			earlierRowsRerendered: earlier.length,
			listRenders: profile.updates["transcript-list"] ?? 0,
			listRenderMs: {
				p50: durations[Math.floor(durations.length * 0.5)],
				p95: durations[Math.floor(durations.length * 0.95)],
				max: durations.at(-1),
			},
		};
	});
	await page.close();
	return result;
}

async function disconnectRun(browser: Browser, width: number, height: number, name: string) {
	const page = await open(browser, width, height, "session=long&delay=500");
	await page.waitForTimeout(7_000);
	const before = await page.evaluate(() => (window as Win).__kantel!.client.getState().cursor);
	await page.evaluate(() => (window as Win).__kantel!.client.simulateDisconnect(4_000));
	await page.waitForTimeout(1_500);
	await page.screenshot({ path: `${out}/disconnect-offline-${name}.png` });
	const offline = await page.evaluate(() => {
		const state = (window as Win).__kantel!.client.getState();
		return {
			cursor: state.cursor,
			connection: state.connection.status,
			freshness: state.freshness.state,
			hostHead: (window as Win).__kantel!.host.head,
		};
	});
	await page.waitForTimeout(4_000);
	await page.screenshot({ path: `${out}/disconnect-resumed-${name}.png` });
	await page.waitForFunction(() => (window as Win).__kantel!.host.finished, undefined, {
		timeout: 120_000,
		polling: 500,
	});
	await page.waitForTimeout(800);
	const after = await page.evaluate(() => {
		const state = (window as Win).__kantel!.client.getState();
		return {
			cursor: state.cursor,
			hostHead: (window as Win).__kantel!.host.head,
			resumes: state.resumes,
			freshness: state.freshness,
		};
	});
	await page.close();
	return { cursorAtDrop: before, offline, after };
}

async function scrollRun(browser: Browser, width: number, height: number, name: string) {
	const page = await open(browser, width, height, "session=long&delay=0&speed=20");
	await page.waitForFunction(() => (window as Win).__kantel!.host.finished, undefined, {
		timeout: 60_000,
		polling: 250,
	});
	await page.waitForTimeout(1_000);
	await page.mouse.move(width / 2, height / 2);
	await page.evaluate(() => {
		const frames: number[] = [];
		let last = performance.now();
		let maxRows = 0;
		const tick = (now: number) => {
			frames.push(now - last);
			last = now;
			maxRows = Math.max(maxRows, document.querySelectorAll(".kt-transcript-row").length);
			Object.assign(window, { __frames: frames, __maxRows: maxRows });
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	const started = Date.now();
	// Scroll up through the whole history, as a reader flicking upwards would, until the first item is loaded.
	for (;;) {
		await page.mouse.wheel(0, -900);
		await page.waitForTimeout(16);
		const done = await page.evaluate(() => {
			const state = (window as Win).__kantel!.client.getState();
			const viewport = document.querySelector(".kt-transcript-list") as HTMLElement;
			return !state.hasEarlier && viewport.scrollTop < 5;
		});
		if (done || Date.now() - started > 240_000) break;
	}
	await page.screenshot({ path: `${out}/scrolled-to-start-${name}.png` });
	// And back down again, fast.
	for (let index = 0; index < 400; index++) {
		await page.mouse.wheel(0, 2400);
		await page.waitForTimeout(16);
	}
	const result = await page.evaluate(() => {
		const frames = ((window as unknown as { __frames: number[] }).__frames ?? []).slice(1).sort((a, b) => a - b);
		const pick = (q: number) =>
			Math.round((frames[Math.min(frames.length - 1, Math.floor(frames.length * q))] ?? 0) * 10) / 10;
		const state = (window as Win).__kantel!.client.getState();
		return {
			itemsLoaded: state.items.length,
			wholeSession: !state.hasEarlier,
			turns: state.items.filter((item) => item.kind === "user").length,
			frames: frames.length,
			frameMs: { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: pick(1) },
			framesOver50ms: frames.filter((ms) => ms > 50).length,
			maxRowsMounted: (window as unknown as { __maxRows: number }).__maxRows,
		};
	});
	await page.close();
	return { ...result, seconds: Math.round((Date.now() - started) / 1000) };
}

const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
try {
	const profiler = await profilerRun(browser);
	console.log("profiler", JSON.stringify(profiler));
	const disconnectDesktop = await disconnectRun(browser, 1440, 900, "desktop");
	console.log("disconnect desktop", JSON.stringify(disconnectDesktop));
	const disconnect420 = await disconnectRun(browser, 420, 860, "420");
	console.log("disconnect 420", JSON.stringify(disconnect420));
	const scrollDesktop = await scrollRun(browser, 1440, 900, "desktop");
	console.log("scroll desktop", JSON.stringify(scrollDesktop));
	const scroll420 = await scrollRun(browser, 420, 860, "420");
	console.log("scroll 420", JSON.stringify(scroll420));
	const results = {
		at: new Date().toISOString(),
		url: base,
		chromium: browser.version(),
		profiler,
		disconnectDesktop,
		disconnect420,
		scrollDesktop,
		scroll420,
	};
	writeFileSync(`${out}/results.json`, `${JSON.stringify(results, null, 2)}\n`);
	console.log(`${out}/results.json`);
} finally {
	await browser.close();
}
