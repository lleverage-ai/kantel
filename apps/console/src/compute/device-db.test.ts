// The browser device's store (device-db.ts) in Chromium, as it is in a page, with two tabs of one origin sharing it:
// changes from both don't lose one another's, a refused change writes nothing, and when both make keys at once both end
// up with the one set kept, still non-extractable. Runs where there is a Chromium (CHROMIUM, or /usr/bin/chromium).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceDb } from "./device-db.ts";

const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const ORIGIN = "https://console.kantel.test";

type InPage = typeof globalThis & { deviceDb: DeviceDb };

let launched: Browser | undefined;
afterEach(async () => {
	await launched?.close();
	launched = undefined;
});

/** Two tabs of the console's origin in one browser profile, each with device-db.ts loaded as it is. */
async function twoTabs(): Promise<[Page, Page]> {
	const source = stripTypeScriptTypes(await readFile(new URL("./device-db.ts", import.meta.url), "utf8"));
	launched = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
	const context = await launched.newContext();
	await context.route(`${ORIGIN}/**`, (route) =>
		route.fulfill({ contentType: "text/html", body: "<!doctype html><title>console</title>" }),
	);
	const tab = async () => {
		const page = await context.newPage();
		await page.goto(`${ORIGIN}/`);
		await page.addScriptTag({ type: "module", content: `${source}\nglobalThis.deviceDb = indexedDeviceDb();` });
		await page.waitForFunction(() => (globalThis as InPage).deviceDb !== undefined);
		return page;
	};
	return [await tab(), await tab()];
}

describe.skipIf(!existsSync(CHROMIUM))("the browser device's IndexedDB store", () => {
	it("makes each change in one step across tabs, and a refused one writes nothing", async () => {
		const [a, b] = await twoTabs();
		// Fifty changes at once in each tab, each from what is kept: none is lost.
		const bump = (page: Page) =>
			page.evaluate(async () => {
				const db = (globalThis as InPage).deviceDb;
				await Promise.all(Array.from({ length: 50 }, () => db.update<number>("trust", "count", (n) => (n ?? 0) + 1)));
			});
		await Promise.all([bump(a), bump(b)]);
		expect(await a.evaluate(() => (globalThis as InPage).deviceDb.get("trust", "count"))).toBe(100);

		// A change that throws is refused with what it threw, and what was kept stays.
		await a.evaluate(() =>
			(globalThis as InPage).deviceDb.update("trust", "usr_bob/acc_one", () => ({ genesis: "pinned", seq: 4 })),
		);
		const refused = await b.evaluate(() =>
			(globalThis as InPage).deviceDb
				.update("trust", "usr_bob/acc_one", () => {
					throw new Error("goes back on what this device verified before");
				})
				.then(
					() => "written",
					(error: Error) => error.message,
				),
		);
		expect(refused).toBe("goes back on what this device verified before");
		expect(await a.evaluate(() => (globalThis as InPage).deviceDb.get("trust", "usr_bob/acc_one"))).toEqual({
			genesis: "pinned",
			seq: 4,
		});
	});

	it("keeps the first tab's keys when two make them at once, and both use those", async () => {
		const [a, b] = await twoTabs();
		const make = (page: Page) =>
			page.evaluate(async () => {
				const db = (globalThis as InPage).deviceDb;
				const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
				type Kept = { readonly pair: CryptoKeyPair };
				const kept = await db.update<Kept>("keys", "usr_bob", (current) =>
					current === undefined ? { pair } : undefined,
				);
				if (kept === undefined) throw new Error("nothing kept");
				const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kept.pair.publicKey));
				return { key: Array.from(raw).join(","), extractable: kept.pair.privateKey.extractable };
			});
		const [fromA, fromB] = await Promise.all([make(a), make(b)]);
		expect(fromA).toEqual(fromB);
		expect(fromA.extractable).toBe(false);
		// What a third look reads is that set, and its private key still can't be read out.
		const later = await b.evaluate(async () => {
			const kept = await (globalThis as InPage).deviceDb.get<{ pair: CryptoKeyPair }>("keys", "usr_bob");
			if (kept === undefined) throw new Error("nothing kept");
			const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kept.pair.publicKey));
			const exported = await crypto.subtle.exportKey("pkcs8", kept.pair.privateKey).then(
				() => true,
				() => false,
			);
			return { key: Array.from(raw).join(","), exported };
		});
		expect(later).toEqual({ key: fromA.key, exported: false });
	});
});
