// Screenshots every workbench story (or those matching --only) at 1280px and 420px with a headless Chromium.
//   pnpm build:workbench && node scripts/shoot.ts [--only workbench--overview,primitives--buttons] [--out shots]
// Writes <out>/<story>-1280.png and <out>/<story>-420.png, full page.

import { mkdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { serve } from "./workbench-server.ts";

const { values } = parseArgs({
	options: {
		only: { type: "string" },
		out: { type: "string", default: new URL("../loop/out/shots/", import.meta.url).pathname },
		build: { type: "string", default: new URL("../build/", import.meta.url).pathname },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
		widths: { type: "string", default: "1280,420" },
	},
});

const meta = JSON.parse(readFileSync(`${values.build}meta.json`, "utf8")) as { stories: Record<string, unknown> };
const wanted = values.only?.split(",");
const stories = Object.keys(meta.stories).filter((id) => wanted === undefined || wanted.includes(id));
mkdirSync(values.out, { recursive: true });

const server = await serve(values.build);
const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
try {
	for (const width of values.widths.split(",").map(Number)) {
		const page = await browser.newPage({
			viewport: { width, height: width < 600 ? 860 : 900 },
			deviceScaleFactor: width < 600 ? 2 : 1,
			colorScheme: "dark",
			reducedMotion: "reduce",
		});
		for (const id of stories) {
			await page.goto(`${server.url}?story=${id}&mode=preview`);
			await page.waitForSelector(".hb-app");
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(300);
			const path = `${values.out}${id}-${width}.png`;
			// Grow the viewport to the page instead of using a full-page capture: that resizes behind the page's back and
			// resets inner scroll positions, so a transcript pinned to its end would be shot at its top.
			// The viewport grows until the page stops growing: content that sizes itself only once it is in view (rows with
			// content-visibility: auto, lazy images) changes the height after the first read. The content's height is read
			// from the story itself, not the document, whose min-height follows the viewport and would grow with it.
			const base = width < 600 ? 860 : 900;
			let height = base;
			for (let pass = 0; pass < 5; pass++) {
				const next = await page.evaluate(() => {
					const app = document.querySelector(".hb-app");
					if (app === null) return document.documentElement.scrollHeight;
					const padding = Number.parseFloat(getComputedStyle(app).paddingBottom) || 0;
					let bottom = 0;
					for (const child of app.children) bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
					return Math.ceil(bottom + padding + window.scrollY);
				});
				if (next <= height) break;
				height = next;
				await page.setViewportSize({ width, height });
				await page.waitForTimeout(200);
			}
			await page.screenshot({ path });
			if (height > base) await page.setViewportSize({ width, height: base });
			console.log(path);
		}
		await page.close();
	}
} finally {
	await browser.close();
	await server.close();
}
