// Checks the console's vault page and audit log in a headless Chromium against a production build: for each route at
// 1280 px and 420 px, axe's violations, the page's headings and main landmarks, any page errors, and a screenshot.
//   pnpm --filter @harbour/console build && node scripts/oversight-check.ts <out-dir> [--chromium /usr/bin/chromium]
// Serves the build with `vite preview` on a random port and stops it after. Runs on `?source=recorded`.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" } },
});
const [out] = positionals;
if (out === undefined) throw new Error("usage: oversight-check.ts <out-dir>");

type Harbour = { __harbour?: { proposals?: Record<string, string> } };
type Axe = { axe: { run(context: Document): Promise<{ violations: { id: string; nodes: unknown[] }[] }> } };

const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const port = 40_000 + Math.floor(Math.random() * 20_000);
const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;

// Each load builds a fresh in-memory vault with new IDs, so a request is opened from within the page that made it.
const routes: [name: string, path: (proposals: Record<string, string>) => string][] = [
	["vault", () => "/vault"],
	["vault-pending", (p) => `/vault/proposals/${p.pending}`],
	["vault-narrowed", (p) => `/vault/proposals/${p.narrowed}`],
	["vault-missing", () => "/vault/proposals/proposal_missing"],
	["audit", () => "/audit"],
];

let failed = false;
const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
try {
	for (let tries = 0; ; tries += 1) {
		try {
			await fetch(base);
			break;
		} catch (error) {
			if (tries > 50) throw error;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	for (const [name, path] of routes)
		for (const [width, height, scale] of [
			[1280, 900, 1],
			[420, 860, 2],
		] as const) {
			const page = await browser.newPage({
				viewport: { width, height },
				deviceScaleFactor: scale,
				colorScheme: "dark",
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			// The recorded source: the stand-in vault and audit store in the page. The choice lasts the tab.
			await page.goto(`${base}/vault?source=recorded`);
			await page.waitForFunction(() => (window as Harbour).__harbour?.proposals !== undefined);
			const proposals = await page.evaluate(() => (window as Harbour).__harbour?.proposals ?? {});
			await page.evaluate((to) => {
				history.pushState(null, "", to);
				dispatchEvent(new PopStateEvent("popstate"));
			}, path(proposals));
			await page.waitForTimeout(1500);
			await page.addScriptTag({ content: axe });
			const violations = await page.evaluate(async () =>
				(await (window as unknown as Axe).axe.run(document)).violations.map((v) => `${v.id} (${v.nodes.length})`),
			);
			const headings = await page.evaluate(() => [...document.querySelectorAll("h1")].map((h) => h.textContent));
			const mains = await page.evaluate(() => document.querySelectorAll("main, [role=main]").length);
			await page.screenshot({ path: `${out}/console-${name}-${width}.png` });
			if (violations.length > 0 || errors.length > 0 || headings.length !== 1 || mains !== 1) failed = true;
			console.log(`${name} ${width}: ${JSON.stringify({ violations, headings, mains, errors })}`);
			await page.close();
		}
} finally {
	await browser.close();
	server.kill();
}
if (failed) process.exitCode = 1;
