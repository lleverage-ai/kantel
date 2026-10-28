// Compares a champion and a variant tree on one scenario, with a noise band on every difference. Both trees' harness
// builds are served side by side and measured in one browser, alternating pages in ABBA order (C V V C C V ...), so
// drift in the host's load or the browser's state falls on both sides alike. Each side's first warm-up pages are
// thrown away: the first pages in a fresh browser run cold and land a frame or more late. Each kept page is one run,
// as in measure.ts; the band is a bootstrap over runs (loop/score.ts, noiseBand), and a difference counts only when
// its 95% interval leaves out no change.
//
//   node loop/ab.ts --only vault-card --champion <tree>/packages/ui --variant <tree>/packages/ui
//                   [--runs 40] [--warmup 4] [--json out.json] [--no-build]
//
// The scenario, its interactions and the counting are this tree's; the pages measured are each tree's own build.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { serve } from "../scripts/workbench-server.ts";
import {
	buildHarness,
	bundleCost,
	harnessOut,
	measureOnce,
	quantile,
	type Run,
	type ScenarioResult,
	summariseRuns,
	table,
} from "./measure.ts";
import { type Band, decide, noiseBand } from "./score.ts";
import { specs } from "./specs.ts";

const { values } = parseArgs({
	options: {
		only: { type: "string" },
		champion: { type: "string" },
		variant: { type: "string" },
		runs: { type: "string", default: "40" },
		warmup: { type: "string", default: "4" },
		throttle: { type: "string", default: "4" },
		json: { type: "string" },
		"no-build": { type: "boolean", default: false },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
	},
});

const spec = specs.find((candidate) => candidate.scenario === values.only);
if (spec === undefined || values.champion === undefined || values.variant === undefined)
	throw new Error("Usage: node loop/ab.ts --only <scenario> --champion <packages/ui> --variant <packages/ui>");
const root = (path: string) => `${resolve(path)}/`;
const trees = { champion: root(values.champion), variant: root(values.variant) };
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const throttle = Number(values.throttle);

/** The scored measures of one run, as loop/score.ts names them. */
const perRun: Record<string, (run: Run) => number> = {
	renderMs: (run) => run.renderMs,
	wasted: (run) => run.wasted,
	latencyMedian: (run) => quantile(run.latencies, 0.5),
	latencyP95: (run) => quantile(run.latencies, 0.95),
	inputRenderMs: (run) => run.inputRenderMs,
};
/** Reported with a band but not scored: it explains latency. */
const diagnostic: Record<string, (run: Run) => number> = { workMedian: (run) => quantile(run.work, 0.5) };

if (!values["no-build"]) for (const tree of Object.values(trees)) await buildHarness(tree);
const servers = { champion: await serve(harnessOut(trees.champion)), variant: await serve(harnessOut(trees.variant)) };
const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
const kept: { champion: Run[]; variant: Run[] } = { champion: [], variant: [] };
const thrown: { champion: Run[]; variant: Run[] } = { champion: [], variant: [] };
const order: string[] = [];
try {
	for (let pair = 0; pair < warmup + runs; pair++) {
		const sides = pair % 2 === 0 ? (["champion", "variant"] as const) : (["variant", "champion"] as const);
		for (const side of sides) {
			const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
			const run = await measureOnce(page, servers[side].url, spec, throttle);
			await page.close();
			(pair < warmup ? thrown : kept)[side].push(run);
			order.push(side);
		}
	}
} finally {
	await browser.close();
	await servers.champion.close();
	await servers.variant.close();
}

const results: Record<"champion" | "variant", ScenarioResult> = {
	champion: summariseRuns(spec, kept.champion, await bundleCost(spec, trees.champion)),
	variant: summariseRuns(spec, kept.variant, await bundleCost(spec, trees.variant)),
};
const bands: Record<string, Band> = {};
for (const [name, pick] of Object.entries({ ...perRun, ...diagnostic }))
	bands[name] = noiseBand(name, kept.champion.map(pick), kept.variant.map(pick));

const medians = (result: ScenarioResult) => ({
	renderMs: result.renderMs.median,
	wasted: result.wasted.median,
	latencyMedian: result.latencyMedian.median,
	latencyP95: result.latencyP95.median,
	inputRenderMs: result.inputRenderMs.median,
	bundleJs: result.bundle.js,
	bundleCss: result.bundle.css,
});
const noise = Object.keys(perRun).filter((name) => bands[name]?.inside === true);
const measured = decide({
	gatesPassed: true,
	judgedChampion: 0,
	judgedVariant: 0,
	champion: medians(results.champion),
	variant: medians(results.variant),
	noise,
});

console.log(
	`${spec.scenario}: ${runs} runs a side after ${warmup} warm-up, ABBA, CPU ${throttle}x, median (min–max)\n`,
);
console.log(table([results.champion, { ...results.variant, component: `${spec.component} (variant)` }]));
console.log("\n| Measure | Variant / champion | 95% band | Counted |\n| --- | --- | --- | --- |");
for (const [name, band] of Object.entries(bands))
	console.log(
		`| ${name} | ${band.ratio.toFixed(3)} | ${band.low.toFixed(3)}–${band.high.toFixed(3)} | ${name in diagnostic ? "not scored" : band.inside ? "no, inside the noise" : "yes"} |`,
	);
console.log(
	`\nMeasured gain M = ${measured.measured.toFixed(3)}; worse: ${measured.worse.join(", ") || "none"}; inside the noise: ${noise.join(", ") || "none"}`,
);
if (values.json !== undefined)
	writeFileSync(
		values.json,
		JSON.stringify(
			{
				scenario: spec.scenario,
				at: new Date().toISOString(),
				runs,
				warmup,
				throttle,
				trees,
				order,
				results,
				bands,
				measured,
				raw: { kept, thrown },
			},
			null,
			"\t",
		),
	);
