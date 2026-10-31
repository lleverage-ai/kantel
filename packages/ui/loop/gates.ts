// The design loop's browser gates, over every workbench story at 1280px and 420px in headless Chromium:
//   1. axe: no WCAG 2.2 A/AA violations.
//   2. Keyboard: every enabled, tabbable control is reached by Tab in order, and shows a visible focus ring when it
//      is; nothing traps focus.
//   3. Alignment: icons, dots, badges and button labels are centred on their text within 1px (loop/align.ts).
//   4. States: each of the loop's components (loop/specs.ts) has a story for every required state.
// The static gates (token and copy lint) run in scripts/token-lint.ts. A story or variant that fails any gate is
// rejected before it is measured or judged.
//   pnpm build:workbench && node loop/gates.ts [--only id,id] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";
import { serve } from "../scripts/workbench-server.ts";
import { alignment, type Misalignment } from "./align.ts";
import { missingStates } from "./specs.ts";

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
	alignment: Misalignment[];
	/** Set when the story never loaded, after one retry: a failure, not a crash that loses every other result. */
	error?: string;
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
		const root = document.querySelector(".kt-app") ?? document.body;
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
		const nodes = [...document.querySelectorAll<HTMLElement>(`.kt-app ${selector}`)].filter((element) => {
			if (element.tabIndex < 0 || (element as HTMLButtonElement).disabled) return false;
			const style = getComputedStyle(element);
			const box = element.getBoundingClientRect();
			return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
		});
		// A native radio group is one Tab stop (arrow keys move within it), so its radios share one index.
		const radioIndex = new Map<string, number>();
		let count = 0;
		for (const element of nodes) {
			const name = element instanceof HTMLInputElement && element.type === "radio" ? element.name : "";
			if (name !== "" && radioIndex.has(name)) {
				element.dataset.gateIndex = String(radioIndex.get(name));
				continue;
			}
			if (name !== "") radioIndex.set(name, count);
			element.dataset.gateIndex = String(count++);
		}
		return count;
	});
	const reached = new Set<string>();
	const withoutRing: string[] = [];
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	// Controls revealed on focus (a row's actions) add stops the initial scan can't see, so allow for them; stop once
	// every scanned control has been reached.
	for (let step = 0; step < tabbable * 3 + 4 && reached.size < tabbable; step++) {
		await page.keyboard.press("Tab");
		const seen = await page.evaluate(() => {
			const element = document.activeElement as HTMLElement | null;
			if (element === null || element === document.body) return undefined;
			const hasRing = (target: Element) => {
				const style = getComputedStyle(target);
				return (
					(style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 1) ||
					(style.boxShadow !== "none" && style.boxShadow !== "")
				);
			};
			// A field inside a declared focus surface (the composer) may show focus on the surface instead.
			const surface = element.closest("[data-focus-surface]");
			const ring = hasRing(element) || (surface !== null && getComputedStyle(surface).outlineStyle !== "none");
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
				let error: string | undefined;
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						await page.goto(`${server.url}?story=${story}&mode=preview`);
						await page.waitForSelector(".kt-app", { timeout: 60_000 });
						error = undefined;
						break;
					} catch (cause) {
						error = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
					}
				}
				if (error !== undefined) {
					const empty = { tabbable: 0, reached: 0, withoutRing: [], unreached: [] };
					results.push({ story, width, alignment: [], axe: [], keyboard: empty, error });
					continue;
				}
				await page.waitForTimeout(150);
				// Alignment first, before Tab reveals any row's actions in place of its status.
				const misaligned = await alignment(page);
				results.push({ story, width, alignment: misaligned, axe: await axe(page), keyboard: await keyboard(page) });
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
	return (
		result.error === undefined &&
		result.axe.length === 0 &&
		result.keyboard.withoutRing.length === 0 &&
		result.keyboard.unreached.length === 0 &&
		result.alignment.length === 0
	);
}

/** The States gate, on a built workbench: the loop's components each have a story for every required state. */
export function statesGate(build: string): string[] {
	const meta = JSON.parse(readFileSync(`${build}meta.json`, "utf8")) as { stories: Record<string, unknown> };
	return missingStates(Object.keys(meta.stories));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const missing = statesGate(values.build);
	console.log(missing.length === 0 ? "pass  states: every loop component has every state" : "FAIL  states");
	for (const id of missing) console.log(`      missing story: ${id}`);
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
		if (result.error !== undefined) console.log(`      did not load: ${result.error}`);
		for (const violation of result.axe)
			console.log(`      axe ${violation.id} (${violation.impact}, ${violation.nodes}): ${violation.help}`);
		for (const label of result.keyboard.withoutRing) console.log(`      no focus ring: ${label}`);
		for (const label of result.keyboard.unreached) console.log(`      not reached by Tab: ${label}`);
		for (const pair of result.alignment)
			console.log(
				pair.offset === null
					? `      could not measure: ${pair.check}, ${pair.where}`
					: `      off centre by ${pair.offset}px: ${pair.check}, ${pair.where}`,
			);
	}
	if (values.json !== undefined) writeFileSync(values.json, JSON.stringify(results, null, "\t"));
	process.exitCode = missing.length === 0 && results.every(passed) ? 0 : 1;
}
