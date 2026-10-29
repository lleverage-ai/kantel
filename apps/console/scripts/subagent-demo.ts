// Nested subagents end to end in the console, against a gateway with subagents on (`pnpm --filter @harbour/cloudflare
// dev`, whose dev vars set HARBOUR_SUBAGENTS=on):
//   node scripts/subagent-demo.ts <gateway> <out-dir> [--chromium /usr/bin/chromium]
// Signs in as the dev admin with the gateway's mock Access issuer and gives a session the dev model's `delegate a > b >
// c` errand: the session hands `b > c` to a subagent, which hands `c` to one of its own. While they work it screenshots
// the parent's thread with the subagent's card, then opens the card, then the subagent's own card, so the top bar has
// the whole trail (project / session / subagent / its subagent). Then it goes back up by the breadcrumbs, and once
// everything has answered screenshots the parent's finished card. Last, the deepest level on a phone.
// Writes 1-parent-working.png, 2-subagent-working.png, 3-sub-subagent.png, 4-back-to-subagent.png, 5-parent-done.png,
// 6-phone-sub-subagent.png and 7-phone-trail-open.png to <out-dir>.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type BrowserContext, chromium, type Page } from "playwright-core";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" } },
});
const [gateway, out] = positionals;
if (gateway === undefined || out === undefined) throw new Error("usage: subagent-demo.ts <gateway> <out-dir>");
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

const TOP = "Audit the refund path";
const SUB = "Check the partial refunds";
const SUBSUB = "Count the partial-refund tests";

const projects = (await api("/v1/projects")) as { items: { id: string }[] };
const projectId = projects.items[0]!.id;
const session = (await api("/v1/sessions", { projectId, agentId: "assistant", title: TOP })) as { id: string };
console.log(`session ${session.id}`);

const shot = async (page: Page, name: string) => {
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(out, name) });
	console.log(name);
};
const card = (page: Page, title: string) => page.locator(".hb-subagent-card", { hasText: title }).first();
const trail = (page: Page) => page.locator("nav.hb-breadcrumbs").first();

const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
const contextFor = async (width: number, height: number): Promise<BrowserContext> =>
	browser.newContext({
		viewport: { width, height },
		colorScheme: "dark",
		extraHTTPHeaders: { "cf-access-jwt-assertion": await token() },
	});
try {
	const page = await (await contextFor(1440, 900)).newPage();
	await page.goto(`${gateway}/projects/${projectId}/sessions/${session.id}`);
	await page.waitForTimeout(1500);
	await api(`/v1/sessions/${session.id}/prompt`, { text: `delegate ${TOP} > ${SUB} > ${SUBSUB}` });

	// The parent's thread: the subagent's card, working, saying what it is doing now (waiting on its own subagent).
	await card(page, SUB).waitFor({ timeout: 30_000 });
	await page.getByText("Waiting on its subagent", { exact: false }).first().waitFor({ timeout: 30_000 });
	await shot(page, "1-parent-working.png");

	// Into the subagent: its own session streams, the trail gains it, and its card for its own subagent is there.
	await card(page, SUB).click();
	await card(page, SUBSUB).waitFor({ timeout: 30_000 });
	await trail(page).getByText(TOP).waitFor();
	await shot(page, "2-subagent-working.png");

	// Down one more: project / session / subagent / its subagent, every level above a link.
	await card(page, SUBSUB).click();
	await trail(page).getByRole("link", { name: SUB }).waitFor({ timeout: 30_000 });
	await page
		.getByText(/Calling (ls|bash)|Checked/)
		.first()
		.waitFor({ timeout: 30_000 });
	await shot(page, "3-sub-subagent.png");

	// Back up by the trail: the subagent's level, then the session's.
	await trail(page).getByRole("link", { name: SUB }).click();
	await card(page, SUBSUB).waitFor({ timeout: 30_000 });
	await shot(page, "4-back-to-subagent.png");
	await trail(page).getByRole("link", { name: TOP }).click();
	await page.locator(".hb-subagent-card.hb-subagent-done", { hasText: SUB }).waitFor({ timeout: 60_000 });
	await page.getByText(`${TOP}: ${SUB}:`).waitFor({ timeout: 60_000 });
	await shot(page, "5-parent-done.png");

	// A phone, at the deepest level: the nearest parent stays, the levels above it fold into a button.
	const sub = (await api(`/v1/sessions?parentSessionId=${session.id}`)) as { items: { id: string }[] };
	const subId = sub.items[0]!.id;
	const subsub = (await api(`/v1/sessions?parentSessionId=${subId}`)) as { items: { id: string }[] };
	const phone = await (await contextFor(420, 860)).newPage();
	await phone.goto(`${gateway}/projects/${projectId}/sessions/${subsub.items[0]!.id}`);
	await trail(phone).getByRole("link", { name: SUB }).waitFor({ timeout: 30_000 });
	await shot(phone, "6-phone-sub-subagent.png");
	const more = trail(phone).getByRole("button", { name: /levels? above/ });
	if ((await more.count()) > 0) {
		await more.click();
		await shot(phone, "7-phone-trail-open.png");
	}
} finally {
	await browser.close();
}
