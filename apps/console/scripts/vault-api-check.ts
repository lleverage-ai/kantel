// Checks the console's vault page on `source=api` against a running local gateway, in a headless Chromium: for each
// state at 1280 px and 420 px, axe's violations, the page's headings and main landmark, any page errors, and a
// screenshot. Then approves the route grant narrowed and checks the grant holds the terms the page showed.
//
//   pnpm --filter @kantel/cloudflare dev                                   # the gateway, http://127.0.0.1:8787
//   pnpm --filter @kantel/console dev                                      # the console as the dev admin
//   KANTEL_DEV_EMAIL=viewer@harbour.test pnpm --filter @kantel/console dev --port 5174   # as the seeded viewer
//   node scripts/vault-api-check.ts <out-dir> [--gateway http://127.0.0.1:8787] [--console http://127.0.0.1:5173]
//     [--viewer-console http://127.0.0.1:5174] [--chromium /usr/bin/chromium]
//
// Seeds a fresh set of vault requests with the gateway's `POST /__dev/vault-seed` first. Without `--viewer-console`
// the forwarded-link check is skipped.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { type Browser, chromium, type Page } from "playwright-core";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		gateway: { type: "string", default: "http://127.0.0.1:8787" },
		console: { type: "string", default: "http://127.0.0.1:5173" },
		"viewer-console": { type: "string" },
		chromium: { type: "string", default: process.env.CHROMIUM ?? "/usr/bin/chromium" },
	},
});
const [out] = positionals;
if (out === undefined) throw new Error("usage: vault-api-check.ts <out-dir>");

type Axe = { axe: { run(context: Document): Promise<{ violations: { id: string; nodes: unknown[] }[] }> } };
type Seed = { proposals: Record<"route" | "write" | "read" | "approved" | "narrowed" | "denied", string> };

const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const seeded = await fetch(`${values.gateway}/__dev/vault-seed`, { method: "POST" });
if (!seeded.ok) throw new Error(`the gateway's /__dev/vault-seed answered ${seeded.status}: ${await seeded.text()}`);
const { proposals } = (await seeded.json()) as Seed;

let failed = false;
const sizes = [
	[1280, 900, 1],
	[420, 860, 2],
] as const;

/** Chromium's own error when the host's network interfaces change under it (containers starting, say): not the page's. */
const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";

async function open(
	browser: Browser,
	base: string,
	path: string,
	width: number,
	height: number,
	scale: number,
	tries = 3,
): Promise<{ page: Page; errors: string[] }> {
	const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: "dark" });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await page.goto(`${base}${path}${path.includes("?") ? "&" : "?"}source=api`);
	// The request, the grants or an error, once the API has answered: no placeholder left. Vite's dev server may reload
	// the page once while it bundles dependencies on a first visit, so this allows for a slow start.
	try {
		await page.waitForSelector(".kt-vault-page", { timeout: 30_000 });
		await page.waitForFunction(
			() => document.querySelector(".kt-vault-page :is([class*='skeleton'], [class*='-loading'])") === null,
			undefined,
			{ timeout: 30_000 },
		);
		await page.waitForTimeout(500);
	} catch (error) {
		await page.screenshot({ path: `${out}/vault-api-timeout-${width}.png` });
		console.error(`${path} ${width} never loaded: ${JSON.stringify(errors)}`);
		if (tries <= 1) throw error;
	}
	// A load the host's network cut short says nothing about the page: load it again.
	if (errors.some((error) => error.includes(NETWORK_CHANGED)) && tries > 1) {
		await page.close();
		return open(browser, base, path, width, height, scale, tries - 1);
	}
	return { page, errors };
}

/** The browser logs every 4xx the page's reads get; `expected` is the one a state is meant to get. */
const loadFailure = (status: number) => `Failed to load resource: the server responded with a status of ${status}`;

async function check(page: Page, errors: string[], name: string, width: number, expected?: number) {
	errors = errors.filter((error) => expected === undefined || !error.startsWith(loadFailure(expected)));
	await page.addScriptTag({ content: axe });
	const violations = await page.evaluate(async () =>
		(await (window as unknown as Axe).axe.run(document)).violations.map((v) => `${v.id} (${v.nodes.length})`),
	);
	const headings = await page.evaluate(() => [...document.querySelectorAll("h1")].map((h) => h.textContent));
	const mains = await page.evaluate(() => document.querySelectorAll("main, [role=main]").length);
	await page.screenshot({ path: `${out}/vault-api-${name}-${width}.png` });
	if (violations.length > 0 || errors.length > 0 || headings.length !== 1 || mains !== 1) failed = true;
	console.log(`${name} ${width}: ${JSON.stringify({ violations, headings, mains, errors })}`);
}

const browser = await chromium.launch({ executablePath: values.chromium, args: ["--no-sandbox"] });
try {
	// The missing request's read is a 404; the forwarded one's approval view a 403, before it reads the request instead.
	const states: [name: string, base: string, path: string, expected?: number][] = [
		["grants", values.console, "/connections/requests"],
		["route", values.console, `/connections/requests/${proposals.route}`],
		["write", values.console, `/connections/requests/${proposals.write}`],
		["read", values.console, `/connections/requests/${proposals.read}`],
		["narrowed", values.console, `/connections/requests/${proposals.narrowed}`],
		["denied", values.console, `/connections/requests/${proposals.denied}`],
		["missing", values.console, "/connections/requests/proposal_missing", 404],
	];
	if (values["viewer-console"] !== undefined)
		states.push(["forwarded", values["viewer-console"], `/connections/requests/${proposals.route}`, 403]);
	for (const [name, base, path, expected] of states)
		for (const [width, height, scale] of sizes) {
			const { page, errors } = await open(browser, base, path, width, height, scale);
			await check(page, errors, name, width, expected);
			await page.close();
		}

	// The route grant, narrowed to GET under /repos/acme/harbour for 30 minutes and 3 uses, approved with the right code.
	const { page, errors } = await open(
		browser,
		values.console,
		`/connections/requests/${proposals.route}`,
		1280,
		900,
		1,
	);
	await page.getByRole("checkbox", { name: "POST" }).uncheck({ timeout: 30_000 });
	await page.locator("input[id$='-path']").fill("/repos/acme/harbour");
	await page.locator("input[id$='-uses']").fill("3");
	await check(page, errors, "route-narrowed-draft", 1280);
	const code = await page.evaluate(async (id) => {
		const response = await fetch(`/v1/connection-approvals/requests/${encodeURIComponent(id)}`);
		return ((await response.json()) as { bindingCode: string }).bindingCode;
	}, proposals.route);
	await page.getByRole("radio", { name: code }).check();
	await page.getByRole("button", { name: "Approve", exact: true }).click();
	try {
		// The settled view: the open request's code picker goes once the page has reloaded the request.
		await page.locator(".kt-code-picker-options").waitFor({ state: "detached", timeout: 20_000 });
	} catch (error) {
		await page.screenshot({ path: `${out}/vault-api-approve-failed-1280.png`, fullPage: true });
		console.error(`the approval didn't land: ${JSON.stringify(errors)}`);
		throw error;
	}
	await page.waitForTimeout(1000);
	await check(page, errors, "route-approved", 1280);
	const grant = await page.evaluate(async (id) => {
		const response = await fetch("/v1/connection-approvals/grants?status=active");
		const page = (await response.json()) as { items: { proposalId: string; route: unknown; maxUses?: number }[] };
		return page.items.find((grant) => grant.proposalId === id);
	}, proposals.route);
	const expected = { host: "api.github.com", methods: ["GET"], pathPrefix: "/repos/acme/harbour" };
	const matches = JSON.stringify(grant?.route) === JSON.stringify(expected) && grant?.maxUses === 3;
	if (!matches) failed = true;
	console.log(
		`narrowed grant: ${JSON.stringify(grant)} ${matches ? "matches" : "DOES NOT MATCH"} what the page showed`,
	);
	await page.close();
} finally {
	await browser.close();
}
if (failed) process.exitCode = 1;
