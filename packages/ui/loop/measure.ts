// The design loop's measures, for the five components in loop/specs.ts:
//   render cost   total React actualDuration (ms) over the scenario's data updates, profiling build
//   wasted        re-renders of a probed row or part whose data did not change (src/primitives/probe.ts); a mount
//                 (a row scrolled into view) is not waste
//   latency       interaction to the end of the next frame (ms): median and p95 over the scenario's inputs
//   work          interaction to the end of its dispatch, React's update included (ms): median over the inputs. Not
//                 scored; it explains latency, which moves in whole frames (see loop/harness/main.tsx)
//   bundle        minified and gzipped JS and CSS of the component's module, React excluded
// Headless Chromium with the CPU throttled 4x, five fresh pages per scenario after one warm-up page that is thrown
// away (the first page in a fresh browser runs cold), median kept; the quartiles and the min to max spread are
// reported so a change inside the noise is visible as such. Garbage is collected before each phase, so a
// collection left over from the last page or the update phase does not land in the interactions.
// To compare two trees, use loop/ab.ts, which alternates them in one browser and gives each difference a noise band.
//
//   node loop/measure.ts [--only transcript,composer] [--runs 5] [--warmup 1] [--label champion] [--json out.json]
//                        [--no-build]

import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { chromium, type Page } from "playwright-core";
import { build, type Rollup } from "vite";
import { serve } from "../scripts/workbench-server.ts";
import type { Collected, HarnessWindow } from "./harness/main.tsx";
import { type ComponentSpec, specs } from "./specs.ts";

const { values } = parseArgs({
	options: {
		only: { type: "string" },
		runs: { type: "string", default: "5" },
		warmup: { type: "string", default: "1" },
		throttle: { type: "string", default: "4" },
		label: { type: "string", default: "current" },
		json: { type: "string" },
		"no-build": { type: "boolean", default: false },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
	},
});

/** This tree's packages/ui directory, with a trailing slash. */
export const uiRoot = new URL("..", import.meta.url).pathname;
/** Where a tree's harness build is written (loop/harness/vite.config.ts). */
export const harnessOut = (root = uiRoot) => `${root}loop/out/harness/`;

/** Builds a tree's measurement harness, from that tree's own sources and config. */
export async function buildHarness(root = uiRoot): Promise<void> {
	await build({ configFile: `${root}loop/harness/vite.config.ts`, logLevel: "warn", mode: "production" });
}

export type Run = {
	renderMs: number;
	commits: number;
	wasted: number;
	needed: number;
	latencies: number[];
	work: number[];
	inputRenderMs: number;
	inputWasted: number;
};

export type Measure = { median: number; q1: number; q3: number; min: number; max: number };

export type ScenarioResult = {
	component: string;
	scenario: string;
	runs: number;
	renderMs: Measure;
	commits: Measure;
	wasted: Measure;
	needed: Measure;
	latencyMedian: Measure;
	latencyP95: Measure;
	workMedian: Measure;
	inputRenderMs: Measure;
	inputWasted: Measure;
	bundle: { js: number; css: number };
};

export const quantile = (values: readonly number[], q: number): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};

export const summarise = (values: readonly number[]): Measure => ({
	median: quantile(values, 0.5),
	q1: quantile(values, 0.25),
	q3: quantile(values, 0.75),
	min: Math.min(...values),
	max: Math.max(...values),
});

/** Re-renders counted for ids outside `changed` (an id, or `Component:id`), and inside it. */
function split(renders: Collected["renders"], watched: readonly string[], changed: readonly string[]) {
	let wasted = 0;
	let needed = 0;
	for (const component of watched)
		for (const [id, count] of Object.entries(renders[component] ?? {})) {
			if (changed.includes(id) || changed.includes(`${component}:${id}`)) needed += count;
			else wasted += count;
		}
	return { wasted, needed };
}

// The interaction phase, as real input from Playwright. Returns the renders it should have caused, for wasted
// renders: `undefined` when every render is needed.
export const interactions: Record<string, (page: Page) => Promise<number | undefined>> = {
	transcript: async (page) => {
		const list = page.locator(".hb-transcript-list");
		const box = await list.boundingBox();
		if (box === null) throw new Error("No transcript");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		for (let i = 0; i < 20; i++) {
			await page.mouse.wheel(0, -300);
			await page.waitForTimeout(80);
		}
		return undefined;
	},
	"tool-group": async (page) => {
		const rows = page.locator(".hb-tool-row");
		const count = await rows.count();
		for (let i = 0; i < count; i++) {
			await rows.nth(i).click();
			await page.waitForTimeout(50);
		}
		return count;
	},
	composer: async (page) => {
		await page.locator("textarea").click();
		await page.evaluate(() => (window as HarnessWindow).__hb?.reset());
		await page.keyboard.type("Check the staging dashboard and file what is broken.", { delay: 40 });
		return undefined;
	},
	"session-list": async (page) => {
		const rows = page.locator(".hb-session-rows-item > *");
		for (let i = 1; i <= 20; i++) {
			await rows.nth(i * 3).click();
			await page.waitForTimeout(50);
		}
		return 40;
	},
	"vault-card": async (page) => {
		await page.locator('[role="radio"]').first().focus();
		await page.evaluate(() => (window as HarnessWindow).__hb?.reset());
		for (let i = 0; i < 12; i++) {
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(50);
		}
		return undefined;
	},
};

export async function measureOnce(page: Page, url: string, spec: ComponentSpec, throttle: number): Promise<Run> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
	await page.goto(`${url}?scenario=${spec.scenario}`);
	await page.waitForFunction(() => (window as HarnessWindow).__hb?.ready === true, undefined, { timeout: 60_000 });
	await cdp.send("HeapProfiler.collectGarbage");
	const { changed } = await page.evaluate(() => (window as HarnessWindow).__hb!.run());
	const update = await page.evaluate(() => (window as HarnessWindow).__hb!.collect());
	await cdp.send("HeapProfiler.collectGarbage");
	await page.evaluate(() => (window as HarnessWindow).__hb!.reset());
	const expected = await (interactions[spec.scenario] ?? (async () => undefined))(page);
	await page.waitForTimeout(300);
	const input = await page.evaluate(() => (window as HarnessWindow).__hb!.collect());
	// Per update where the scenario marks its steps, so a render is needed only in the update that changed its id.
	const parts =
		update.steps.length > 0
			? update.steps.map((step) => split(step.renders, spec.watched, step.changed))
			: [split(update.renders, spec.watched, changed)];
	const wasted = parts.reduce((sum, part) => sum + part.wasted, 0);
	const needed = parts.reduce((sum, part) => sum + part.needed, 0);
	let inputRenders = 0;
	for (const component of spec.watched)
		for (const count of Object.values(input.renders[component] ?? {})) inputRenders += count;
	await cdp.detach();
	return {
		renderMs: update.renderMs,
		commits: update.commits,
		wasted,
		needed,
		latencies: input.latencies,
		work: input.work,
		inputRenderMs: input.renderMs,
		inputWasted: expected === undefined ? 0 : Math.max(0, inputRenders - expected),
	};
}

/** Minified, gzipped bytes of the component module's exports in a tree, with React and react-dom external. */
export async function bundleCost(spec: ComponentSpec, root = uiRoot): Promise<{ js: number; css: number }> {
	const dir = `${root}loop/out/bundle/`;
	mkdirSync(dir, { recursive: true });
	const entry = `${dir}${spec.scenario}.ts`;
	writeFileSync(entry, `export { ${spec.bundle.exports.join(", ")} } from "../../../${spec.bundle.module}";\n`);
	const output = (await build({
		configFile: false,
		logLevel: "silent",
		build: {
			write: false,
			minify: true,
			cssMinify: true,
			lib: { entry, formats: ["es"], fileName: spec.scenario },
			rollupOptions: { external: (id) => id === "react" || id.startsWith("react/") || id.startsWith("react-dom") },
		},
	})) as Rollup.RollupOutput | Rollup.RollupOutput[];
	let js = 0;
	let css = 0;
	for (const item of (Array.isArray(output) ? output : [output]).flatMap((result) => result.output)) {
		const bytes = gzipSync(item.type === "chunk" ? item.code : item.source).length;
		if (item.fileName.endsWith(".css")) css += bytes;
		else if (item.type === "chunk") js += bytes;
	}
	return { js, css };
}

/** One scenario's runs summarised: the median of the per-run values, with their quartiles and range. */
export function summariseRuns(
	spec: ComponentSpec,
	runs: readonly Run[],
	bundle: { js: number; css: number },
): ScenarioResult {
	const of = (pick: (run: Run) => number) => summarise(runs.map(pick));
	return {
		component: spec.component,
		scenario: spec.scenario,
		runs: runs.length,
		renderMs: of((run) => run.renderMs),
		commits: of((run) => run.commits),
		wasted: of((run) => run.wasted),
		needed: of((run) => run.needed),
		latencyMedian: of((run) => quantile(run.latencies, 0.5)),
		latencyP95: of((run) => quantile(run.latencies, 0.95)),
		workMedian: of((run) => quantile(run.work, 0.5)),
		inputRenderMs: of((run) => run.inputRenderMs),
		inputWasted: of((run) => run.inputWasted),
		bundle,
	};
}

export async function measure(options: {
	only?: readonly string[];
	runs: number;
	warmup: number;
	throttle: number;
	build: boolean;
	chromium: string;
}): Promise<ScenarioResult[]> {
	if (options.build) await buildHarness();
	const chosen = specs.filter((spec) => options.only === undefined || options.only.includes(spec.scenario));
	const server = await serve(harnessOut());
	const browser = await chromium.launch({ executablePath: options.chromium, args: ["--no-sandbox"] });
	const results: ScenarioResult[] = [];
	try {
		for (const spec of chosen) {
			const runs: Run[] = [];
			for (let i = 0; i < options.warmup + options.runs; i++) {
				const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
				const run = await measureOnce(page, server.url, spec, options.throttle);
				await page.close();
				if (i >= options.warmup) runs.push(run);
			}
			results.push(summariseRuns(spec, runs, await bundleCost(spec)));
		}
	} finally {
		await browser.close();
		await server.close();
	}
	return results;
}

const fixed = (measure: Measure, digits = 1) =>
	`${measure.median.toFixed(digits)} (${measure.min.toFixed(digits)}–${measure.max.toFixed(digits)})`;

export function table(results: readonly ScenarioResult[]): string {
	const lines = [
		"| Component | Render ms | Wasted renders | Latency median ms | Latency p95 ms | Work median ms | Input render ms | Wasted on input | JS gz | CSS gz |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const r of results)
		lines.push(
			`| ${r.component} | ${fixed(r.renderMs)} | ${fixed(r.wasted, 0)} | ${fixed(r.latencyMedian)} | ${fixed(r.latencyP95)} | ${fixed(r.workMedian)} | ${fixed(r.inputRenderMs)} | ${fixed(r.inputWasted, 0)} | ${(r.bundle.js / 1024).toFixed(1)} kB | ${(r.bundle.css / 1024).toFixed(1)} kB |`,
		);
	return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const results = await measure({
		...(values.only ? { only: values.only.split(",") } : {}),
		runs: Number(values.runs),
		warmup: Number(values.warmup),
		throttle: Number(values.throttle),
		build: !values["no-build"],
		chromium: values.chromium,
	});
	console.log(
		`${values.label}: ${values.runs} runs after ${values.warmup} warm-up, CPU ${values.throttle}x, median (min–max)\n`,
	);
	console.log(table(results));
	if (values.json !== undefined)
		writeFileSync(
			values.json,
			JSON.stringify({ label: values.label, at: new Date().toISOString(), results }, null, "\t"),
		);
}
