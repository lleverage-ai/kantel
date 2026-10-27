// The design loop's browser gates, over every workbench story at 1280px and 420px in headless Chromium:
//   1. axe: no WCAG 2.2 A/AA violations.
//   2. Keyboard: every enabled, tabbable control is reached by Tab in order, and shows a visible focus ring when it
//      is; nothing traps focus.
// The static gates (token and copy lint) run in scripts/token-lint.ts. A story or variant that fails any gate is
// rejected before it is measured or judged.
//   pnpm build:workbench && node loop/gates.ts [--only id,id] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";
import { serve } from "../scripts/workbench-server.ts";

const { values } = parseArgs({
	options: {
		only: { type: "string" },
		build: { type: "string", default: new URL("../build/", import.meta.url).pathname },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
		json: { type: "string" },
	},
});

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

export type GateResult = {
	story: string;
	width: number;
	axe: { id: string; impact: string | null; nodes: number; help: string }[];
	keyboard: { tabbable: number; reached: number; withoutRing: string[]; unreached: string[] };
};

type AxeWindow = Window & {
	axe: {
		run(
			context: Element,
			options: object,
		): Promise<{ violations: { id: string; impact: string | null; help: string; nodes: unknown[] }[] }>;
	};
};

async function axe(page: Page): Promise<GateResult["axe"]> {
	await page.addScriptTag({ content: axeSource });
	return page.evaluate(async () => {
		const root = document.querySelector(".hb-app") ?? document.body;
		const result = await (window as unknown as AxeWindow).axe.run(root, {
			runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
		});
		return result.violations.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.length,
			help: violation.help,
		}));
	});
}

async function keyboard(page: Page): Promise<GateResult["keyboard"]> {
	const tabbable = await page.evaluate(() => {
		const selector = "a[href], button, input, textarea, select, [tabindex]";
		const nodes = [...document.querySelectorAll<HTMLElement>(`.hb-app ${selector}`)].filter((element) => {
			if (element.tabIndex < 0 || (element as HTMLButtonElement).disabled) return false;
			const style = getComputedStyle(element);
			const box = element.getBoundingClientRect();
			return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
		});
		nodes.forEach((element, index) => {
			element.dataset.gateIndex = String(index);
		});
		return nodes.length;
	});
	const reached = new Set<string>();
	const withoutRing: string[] = [];
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	for (let step = 0; step < tabbable + 2; step++) {
		await page.keyboard.press("Tab");
		const seen = await page.evaluate(() => {
			const element = document.activeElement as HTMLElement | null;
			if (element === null || element === document.body) return undefined;
			const style = getComputedStyle(element);
			const ring =
				(style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 1) ||
				(style.boxShadow !== "none" && style.boxShadow !== "");
			const label = `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}"`;
			return { index: element.dataset.gateIndex, ring, label };
		});
		if (seen?.index === undefined) continue;
		reached.add(seen.index);
		if (!seen.ring && !withoutRing.includes(seen.label)) withoutRing.push(seen.label);
	}
	const unreached = await page.evaluate(
		(ids) =>
			[...document.querySelectorAll<HTMLElement>("[data-gate-index]")]
				.filter((element) => !ids.includes(element.dataset.gateIndex ?? ""))
				.map((element) => `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}"`),
		[...reached],
	);
	return { tabbable, reached: reached.size, withoutRing, unreached };
}

export async function runGates(options: { build: string; only?: string[]; chromium: string }): Promise<GateResult[]> {
	const meta = JSON.parse(readFileSync(`${options.build}meta.json`, "utf8")) as { stories: Record<string, unknown> };
	const stories = Object.keys(meta.stories).filter((id) => options.only === undefined || options.only.includes(id));
	const server = await serve(options.build);
	const browser = await chromium.launch({ executablePath: options.chromium, args: ["--no-sandbox"] });
	const results: GateResult[] = [];
	try {
		for (const width of [1280, 420]) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: "dark",
				reducedMotion: "reduce",
			});
			for (const story of stories) {
				await page.goto(`${server.url}?story=${story}&mode=preview`);
				await page.waitForSelector(".hb-app");
				await page.waitForTimeout(150);
				results.push({ story, width, axe: await axe(page), keyboard: await keyboard(page) });
			}
			await page.close();
		}
	} finally {
		await browser.close();
		await server.close();
	}
	return results;
}

export function passed(result: GateResult): boolean {
	return result.axe.length === 0 && result.keyboard.withoutRing.length === 0 && result.keyboard.unreached.length === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const results = await runGates({
		build: values.build,
		chromium: values.chromium,
		...(values.only ? { only: values.only.split(",") } : {}),
	});
	for (const result of results) {
		const mark = passed(result) ? "pass" : "FAIL";
		console.log(
			`${mark}  ${result.story} @${result.width}  axe ${result.axe.length}  keys ${result.keyboard.reached}/${result.keyboard.tabbable}`,
		);
		for (const violation of result.axe)
			console.log(`      axe ${violation.id} (${violation.impact}, ${violation.nodes}): ${violation.help}`);
		for (const label of result.keyboard.withoutRing) console.log(`      no focus ring: ${label}`);
		for (const label of result.keyboard.unreached) console.log(`      not reached by Tab: ${label}`);
	}
	if (values.json !== undefined) writeFileSync(values.json, JSON.stringify(results, null, "\t"));
	process.exitCode = results.every(passed) ? 0 : 1;
}
