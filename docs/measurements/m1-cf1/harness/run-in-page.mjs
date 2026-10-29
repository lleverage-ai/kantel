// Runs a browser-side measurement script in a signed-in page on harbour.myslop.app through brwsr (context `sal`,
// read-only), and writes what it returns to a JSON file. Usage: node run-in-page.mjs <script.js> <out.json> [jsonArgs]
import { readFileSync, writeFileSync } from "node:fs";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const [script, out, args = "{}"] = process.argv.slice(2);
const { BRWSR_API_KEY: apiKey, BRWSR_API_URL: baseURL } = process.env;
const bb = new Browserbase({ apiKey, baseURL });
const [ctx] = await (await fetch(`${baseURL}/v1/contexts?name=sal`, { headers: { "x-bb-api-key": apiKey } })).json();
const session = await bb.sessions.create({
	keepAlive: true,
	timeout: 3600,
	browserSettings: { context: { id: ctx.id, persist: false } },
	userMetadata: { agent: "sal", title: "TASK-3688 harbour measurement" },
});
console.error(`brwsr session ${session.id}`);
try {
	const browser = await chromium.connectOverCDP(session.connectUrl);
	const [context] = browser.contexts();
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto("https://harbour.myslop.app/healthz", { waitUntil: "load" });
	console.error(`at ${page.url()}`);
	const body = readFileSync(script, "utf8");
	const startedAt = new Date().toISOString();
	const result = await page.evaluate(`(async (args) => { ${body} })(${args})`);
	const endedAt = new Date().toISOString();
	writeFileSync(
		out,
		`${JSON.stringify({ brwsrSession: session.id, startedAt, endedAt, from: page.url(), ...result }, null, "\t")}\n`,
	);
	console.error(`wrote ${out}`);
	console.log(JSON.stringify(result.summary ?? {}, null, 2));
	await browser.close();
} finally {
	await bb.sessions.update(session.id, { status: "REQUEST_RELEASE" });
}
