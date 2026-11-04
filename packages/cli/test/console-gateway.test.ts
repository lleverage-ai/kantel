// `kantel console` against a hostile gateway: whatever `/v1/...` answers (a page, an SVG, a script) is data on the
// console's origin, never code with its cookie and `/local/e2e` (this device's key). Checked over HTTP everywhere, and
// in Chromium where there is one (CHROMIUM, or /usr/bin/chromium).
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayType, type LocalConsole, serveLocalConsole } from "../src/console.ts";
import { CliError, HostAnswerError } from "../src/errors.ts";

const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";

/** A call to `/local/e2e` that names what made it, so the test can tell which payload got through. */
const steal = (by: string) =>
	`fetch("/local/e2e",{method:"POST",headers:{"content-type":"application/json"},` +
	`body:JSON.stringify({sandboxId:"sbx_one",method:"sandbox.exec",params:{command:${JSON.stringify(by)}}})})`;

/** The gateway: hostile pages, an SVG and a script, beside the JSON and bytes the console really reads. */
const HOSTILE: Record<string, { type: string; body: string | Uint8Array }> = {
	"/v1/payload.html": {
		type: "text/html; charset=utf-8",
		body: `<!doctype html><script>${steal("html inline")}</script><script src="/v1/payload.js"></script><p>hostile</p>`,
	},
	"/v1/payload.js": { type: "text/javascript", body: steal("js") },
	"/v1/payload.mjs": { type: "application/javascript; charset=utf-8", body: steal("mjs") },
	"/v1/payload.svg": {
		type: "image/svg+xml",
		body: `<svg xmlns="http://www.w3.org/2000/svg"><script>${steal("svg")}</script></svg>`,
	},
	"/v1/payload.xhtml": {
		type: "application/xhtml+xml",
		body: `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>${steal("xhtml")}</script></body></html>`,
	},
	"/v1/data.json": { type: "application/json; charset=utf-8", body: '{"items":[1,2,3]}' },
	"/v1/snapshot.bin": { type: "application/octet-stream", body: new Uint8Array([0, 1, 2, 250, 251, 252]) },
};

const hostileGateway: typeof fetch = async (input) => {
	const { pathname } = new URL(String(input));
	const found = HOSTILE[pathname];
	if (found === undefined) return Response.json({ error: { code: "not_found" } }, { status: 404 });
	return new Response(found.body, { headers: { "content-type": found.type } });
};

describe("kantel console and a hostile gateway", () => {
	const dirs: string[] = [];
	const consoles: LocalConsole[] = [];
	afterEach(async () => {
		await Promise.all(consoles.splice(0).map((c) => c.close()));
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	/** The console with a bundle of its own: its inline theme, and a script that reads the gateway's data. */
	async function serve(answer?: (method: string) => Promise<unknown>) {
		const dir = await mkdtemp(join(tmpdir(), "kantel-console-"));
		dirs.push(dir);
		await mkdir(join(dir, "assets"));
		await writeFile(
			join(dir, "index.html"),
			'<!doctype html><title>Kantel</title><script>document.documentElement.dataset.theme="dark"</script>' +
				'<script type="module" src="/assets/a.js"></script>',
		);
		await writeFile(
			join(dir, "assets", "a.js"),
			[
				"window.bundled = true;",
				'const json = await (await fetch("/v1/data.json")).json();',
				'const bytes = new Uint8Array(await (await fetch("/v1/snapshot.bin")).arrayBuffer());',
				// A bug that let the gateway choose a script's URL: the page's policy takes scripts from /assets/ only.
				'const s = document.createElement("script"); s.src = "/v1/payload.js"; document.head.append(s);',
				"window.results = { theme: document.documentElement.dataset.theme, json, bytes: [...bytes] };",
			].join("\n"),
		);
		const e2eCalls: { sandboxId: string; method: string; params: object }[] = [];
		const c = await serveLocalConsole({
			dir,
			gateway: "https://kantel.test",
			apiKey: "the-cli-key",
			fetch: hostileGateway,
			info: async () => ({ local: true, spaces: [] }),
			e2eCall: async (sandboxId, method, params) => {
				e2eCalls.push({ sandboxId, method, params });
				if (answer !== undefined) return answer(method);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		consoles.push(c);
		const entry = await fetch(c.url, { redirect: "manual" });
		const cookie = (entry.headers.get("set-cookie") ?? "").split(";")[0] as string;
		return { ...c, cookie, e2eCalls };
	}

	it("gives the gateway's answers no type a browser runs, and a sandbox with no scripts", async () => {
		const c = await serve();
		for (const [path, { type }] of Object.entries(HOSTILE)) {
			const answer = await fetch(`${c.origin}${path}`, { headers: { cookie: c.cookie } });
			expect(answer.status).toBe(200);
			const policy = answer.headers.get("content-security-policy") ?? "";
			expect(policy).toMatch(/default-src 'none'; sandbox;/);
			expect(policy).not.toContain("allow-scripts");
			expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
			const served = answer.headers.get("content-type");
			expect(served).toBe(path.endsWith(".json") ? "application/json" : "application/octet-stream");
			if (path.endsWith(".bin"))
				expect([...new Uint8Array(await answer.arrayBuffer())]).toEqual([0, 1, 2, 250, 251, 252]);
			expect(type).toBeTruthy();
		}
		// The page's own scripts are its files', not the gateway's, though both are on this origin.
		const page = await fetch(`${c.origin}/`, { headers: { cookie: c.cookie } });
		const policy = page.headers.get("content-security-policy") ?? "";
		expect(policy).toMatch(new RegExp(`script-src ${c.origin}/assets/ 'sha256-[^']+';`));
		expect(policy).not.toContain("'self' 'sha256");
		expect(policy).toContain(`worker-src ${c.origin}/assets/`);
	});

	it("passes on a host's refusal of a call with its code, and a session that failed without one", async () => {
		const c = await serve(async (method) => {
			if (method === "sandbox.files.list") throw new HostAnswerError("not_found", "no such directory");
			throw new CliError("The relay closed the stream before the host answered");
		});
		const call = async (method: string) => {
			const answer = await fetch(`${c.origin}/local/e2e`, {
				method: "POST",
				headers: { cookie: c.cookie, origin: c.origin, "content-type": "application/json" },
				body: JSON.stringify({ sandboxId: "sbx_one", method, params: { path: "/home/user" } }),
			});
			return { status: answer.status, body: await answer.json() };
		};
		expect(await call("sandbox.files.list")).toEqual({
			status: 502,
			body: { error: { code: "e2e", message: "no such directory", hostCode: "not_found" } },
		});
		expect(await call("sandbox.files.read")).toEqual({
			status: 502,
			body: { error: { code: "e2e", message: "The relay closed the stream before the host answered" } },
		});
	});

	it("keeps data types and a plain charset, and turns every other type to bytes", () => {
		expect(gatewayType("application/json; charset=utf-8")).toBe("application/json");
		expect(gatewayType("text/plain; charset=UTF-8")).toBe("text/plain; charset=UTF-8");
		expect(gatewayType('text/plain; charset="x"; boundary=y')).toBe("text/plain; charset=x");
		for (const type of [
			"text/html",
			"TEXT/HTML; charset=utf-8",
			"image/svg+xml",
			"application/xhtml+xml",
			"text/javascript",
			"application/javascript",
			"text/xml",
			"application/pdf",
			"multipart/x-mixed-replace; boundary=x",
			"",
			null,
		]) {
			expect(gatewayType(type)).toBe("application/octet-stream");
		}
	});

	it.skipIf(!existsSync(CHROMIUM))(
		"runs its own scripts in Chromium, and none of the gateway's",
		async () => {
			const c = await serve();
			const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
			try {
				const context = await browser.newContext({ acceptDownloads: true });
				const page = await context.newPage();
				await page.goto(c.url);
				await page.waitForFunction(() => (globalThis as { results?: unknown }).results !== undefined);
				// The bundle ran, its inline theme by its hash, and it reads the gateway's JSON and bytes.
				expect(await page.evaluate(() => (globalThis as { results?: unknown }).results)).toEqual({
					theme: "dark",
					json: { items: [1, 2, 3] },
					bytes: [0, 1, 2, 250, 251, 252],
				});
				// Each of the gateway's answers, opened as the console opens an access URL: a page of this origin's, if
				// the browser makes one at all.
				for (const path of Object.keys(HOSTILE)) {
					const opened = await context.newPage();
					await opened.goto(`${c.origin}${path}`).catch((error: unknown) => {
						// Bytes are downloaded, not shown.
						if (!String(error).includes("Download is starting")) throw error;
					});
					await opened.waitForLoadState("load").catch(() => undefined);
					await opened.close();
				}
				// A last round trip, so anything a payload started has reached the server.
				const settle = await context.newPage();
				await settle.goto(c.url);
				await settle.waitForFunction(() => (globalThis as { results?: unknown }).results !== undefined);
				expect(c.e2eCalls).toEqual([]);
				// What the payloads try does work from the console's own page: had one run there, the test would see it.
				await settle.evaluate(`${steal("control")}.then((r) => r.status)`);
				expect(c.e2eCalls).toEqual([{ sandboxId: "sbx_one", method: "sandbox.exec", params: { command: "control" } }]);
			} finally {
				await browser.close();
			}
		},
		60_000,
	);
});
