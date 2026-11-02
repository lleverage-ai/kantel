// Drives one of Kantel's own browsers end to end in a session and screenshots its live view and its replay, against a
// gateway that runs them (`pnpm --filter @kantel/cloudflare dev`, whose dev vars set KANTEL_BROWSER_PROVIDER=kantel):
//   node scripts/browser-demo.ts <gateway> <out-dir> [--url https://example.com] [--chromium /usr/bin/chromium]
// Signs in as the dev admin with the gateway's mock Access issuer, starts a session on the dev model's `browse <url>`
// errand, allows its browser request in the console, waits for the live view, then says `close` and waits for the
// replay. Writes live.png, replay-ready.png (Play over the last screenshot), replay.png (playing) and replay-page.png
// (the replay's own page) to <out-dir>.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Frame, type Page } from "playwright-core";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		url: { type: "string", default: "https://example.com" },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
	},
});
const [gateway, out] = positionals;
if (gateway === undefined || out === undefined) throw new Error("usage: browser-demo.ts <gateway> <out-dir>");
mkdirSync(out, { recursive: true });

const token = async () => ((await (await fetch(`${gateway}/__dev/access-token`)).json()) as { token: string }).token;
const api = async (path: string, body?: unknown) => {
	const response = await fetch(`${gateway}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "cf-access-jwt-assertion": await token(), "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response.json() as Promise<{ [key: string]: unknown }>;
};

const projects = (await api("/v1/projects")) as { items: { id: string }[] };
const projectId = projects.items[0]!.id;
const session = (await api("/v1/sessions", { projectId, agentId: "assistant" })) as { id: string };
console.log(`session ${session.id}`);

const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
try {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		colorScheme: "dark",
		extraHTTPHeaders: { "cf-access-jwt-assertion": await token() },
	});
	const page: Page = await context.newPage();
	await page.goto(`${gateway}/projects/${projectId}/sessions/${session.id}`);
	await page.waitForTimeout(2000);
	await api(`/v1/sessions/${session.id}/prompt`, { text: `browse ${values.url}` });
	await page.getByRole("button", { name: "Allow" }).click({ timeout: 30_000 });
	// The live view: the frame, then the page's canvas drawing.
	const liveFrame = page.frameLocator("iframe[title^='Live view']").first();
	await liveFrame.locator("[data-state='live']").waitFor({ timeout: 90_000 });
	await page.waitForTimeout(1500);
	await page.locator(".kt-browser-live").first().scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(out, "live.png") });
	console.log("live.png");
	await api(`/v1/sessions/${session.id}/prompt`, { text: "close" });
	// The replay waits behind Play over the last screenshot, under the newest call on the browser: the close, once done.
	await page.getByText(/^Closed: /).waitFor({ timeout: 120_000 });
	const play = page.locator(".kt-browser-live-replay").getByRole("button", { name: "Play" }).first();
	await play.waitFor({ timeout: 120_000 });
	await page.locator(".kt-browser-live-replay").first().scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(out, "replay-ready.png") });
	console.log("replay-ready.png");
	await play.click();
	const replayFrame = page.frameLocator("iframe[title^='Replay']").first();
	await replayFrame.locator(".kt-viewer-controls").waitFor({ timeout: 120_000 });
	const frame: Frame | null = page.frames().find((each) => each.url().includes("/browser/")) ?? null;
	await page.waitForTimeout(3000);
	await page.locator(".kt-browser-live-replay").first().scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(out, "replay.png") });
	console.log("replay.png");
	if (frame !== null) {
		const replay = await context.newPage();
		await replay.goto(frame.url());
		await replay.locator(".kt-viewer-controls").waitFor({ timeout: 30_000 });
		await replay.waitForTimeout(2500);
		await replay.screenshot({ path: join(out, "replay-page.png") });
		console.log("replay-page.png");
	}
} finally {
	await browser.close();
}
