// Screenshot the console at desktop and phone widths with a headless Chromium.
//   node scripts/screenshot.ts <url> <out-prefix> [--wait ms] [--chromium /usr/bin/chromium]
// Writes <out-prefix>-desktop.png (1440×900) and <out-prefix>-420.png (420×860, 2× scale).

import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		wait: { type: "string", default: "4000" },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
	},
});
const [url, prefix] = positionals;
if (url === undefined || prefix === undefined) throw new Error("usage: screenshot.ts <url> <out-prefix>");

const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
try {
	for (const [name, viewport, scale] of [
		["desktop", { width: 1440, height: 900 }, 1],
		["420", { width: 420, height: 860 }, 2],
	] as const) {
		const page = await browser.newPage({ viewport, deviceScaleFactor: scale, colorScheme: "dark" });
		await page.goto(url);
		await page.waitForTimeout(Number(values.wait));
		await page.screenshot({ path: `${prefix}-${name}.png` });
		await page.close();
		console.log(`${prefix}-${name}.png`);
	}
} finally {
	await browser.close();
}
