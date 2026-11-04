// The hosted console's browser device end to end: the console's own source (api-source.ts) as Bob signs in, against
// the real compute API, the hosts service's hub and kantel-host's TypeScript twin (packages/hosts/test/e2e-host.ts).
// The admin signs the chain's entries with `@kantel/e2e`, as `kantel e2e` does. The browser's store is a map here; in a
// page it is IndexedDB (device-db.ts, checked across tabs in Chromium by device-db.test.ts).

import { fromBase64url, toBase64url, utf8 } from "@kantel/e2e/bytes";
import {
	type ChainEntry,
	chainDevice,
	createHostTicket,
	type EntryBody,
	extendChain,
	type SpaceState,
	signEntry,
	verifyChain,
} from "@kantel/e2e/chain";
import { callHost, memoryTrustStore, parseCard, pinGenesis } from "@kantel/e2e/device";
import { fingerprint, keyId, newIdentity, type WebKeyPairs } from "@kantel/e2e/keys";
import { contains } from "@kantel/e2e/testing";
import { describe, expect, it } from "vitest";
import {
	hostJoins,
	joined,
	PEOPLE,
	ROOT,
	SECRET_COMMAND,
	SECRET_OUTPUT,
	setup,
} from "../../../../packages/hosts/test/e2e-host.ts";
import { apiCompute } from "./api-source.ts";
import { browserLabel, type DeviceDb } from "./browser-device.ts";

/**
 * The browser's store as a map, shared by every source (tab) given it. A change reads and writes with no wait
 * between, as one IndexedDB transaction does, but each call waits a turn first, so tabs' calls interleave.
 */
function memoryDb() {
	const kept = new Map<string, unknown>();
	const db: DeviceDb = {
		get: async <T>(store: string, key: string) => {
			await Promise.resolve();
			return kept.get(`${store}:${key}`) as T | undefined;
		},
		update: async <T>(store: string, key: string, change: (current: T | undefined) => T | undefined) => {
			await Promise.resolve();
			const next = change(kept.get(`${store}:${key}`) as T | undefined);
			if (next !== undefined) kept.set(`${store}:${key}`, next);
			return kept.get(`${store}:${key}`) as T | undefined;
		},
	};
	return { kept, db };
}

/**
 * An organisation Bob is in, whose chain Root's device starts with E2E on; the host joins with Root's ticket, and a
 * sandbox is made after, so sessions reach it. `append` signs an entry as Root's device and adds it at the gateway.
 */
async function organisation() {
	const s = await setup();
	const org = await s.root.createOrganisation({ name: "Acme" });
	const invite = await s.root.createInvite(org.id, { role: "member" });
	await s.as("bob").joinOrganisation({ code: invite.code as string });
	// A sandbox from before E2E: it puts the organisation on the host, which may then read its chain to join.
	await s.root.createSandbox({ account: org.id, type: "microvm", wait: true });
	const device = await newIdentity();
	const by = { id: await keyId("kd", device.signer.publicKey), signer: device.signer };
	let state: SpaceState | undefined;
	const append = async (body: EntryBody) => {
		const entry = await signEntry(state, org.id, body, by, Date.now());
		const from = state === undefined ? 0 : state.seq + 1;
		await s.root.appendE2EChain(org.id, { from, entries: [entry] });
		state = state === undefined ? await verifyChain([entry]) : await extendChain(state, [entry], from);
		return state;
	};
	const genesis = await append({
		type: "genesis",
		body: { mode: "on", device: await chainDevice(device, ROOT.userId, "cli", "root's laptop") },
	});
	await hostJoins(s, await createHostTicket(genesis, by, "rack-1", Date.now() + 600_000));
	state = await verifyChain((await s.root.getE2EChain(org.id)).entries, genesis.genesis);
	const sandbox = await s.root.createSandbox({ account: org.id, type: "microvm", wait: true });
	/** A call on the sandbox's host as Root's device, as `kantel e2e exec` makes it. */
	const rootCalls = async (method: string, params: object) => {
		const store = memoryTrustStore();
		await pinGenesis(store, org.id, genesis.genesis);
		return callHost({
			gateway: s.root,
			trust: store,
			keys: device,
			sandboxId: sandbox.id,
			method,
			params,
			connect: s.tunnel,
		});
	};
	return { ...s, org, sandbox, append, genesis: genesis.genesis, rootCalls };
}

type Organisation = Awaited<ReturnType<typeof organisation>>;
type Source = Awaited<ReturnType<typeof apiCompute>>;

/** Bob's browser in `source` trusts the genesis, and Root adds Bob as a member and the browser's card. */
async function enrol(s: Organisation, source: Source) {
	const browser = source.e2e?.browser;
	if (browser === undefined) throw new Error("The console offered no browser device");
	await browser.trust(s.org.id, s.genesis);
	const pending = await browser.standing(s.org.id);
	if (pending.kind !== "pending") throw new Error(`Expected pending, got ${pending.kind}`);
	const card = await parseCard(pending.command.split(" ").at(-1) ?? "");
	await s.append({ type: "member.add", body: { user: PEOPLE.bob.userId, role: "member" } });
	await s.append({ type: "device.add", body: { device: card } });
	expect(await browser.standing(s.org.id)).toMatchObject({ kind: "ready" });
	return { browser, card };
}

describe("the hosted console's browser device", () => {
	it("becomes a device of its own, reads history end to end, and strict shuts it out", async () => {
		const s = await organisation();
		await s.rootCalls("sandbox.exec", { command: SECRET_COMMAND });

		// Bob signs in to the console the gateway serves; his browser keeps its keys in its own store.
		const { kept, db } = memoryDb();
		const source = await apiCompute({
			baseUrl: "https://kantel.test/v1",
			headers: () => ({ authorization: "Bearer bob" }),
			fetch: s.gatewayFetch,
			browser: { db, connect: s.tunnel, label: "Hosted console in Firefox" },
		});
		const browser = source.e2e?.browser;
		if (browser === undefined) throw new Error("The console offered no browser device");
		expect(await source.e2e?.mode(s.org.id)).toBe("on");
		await source.sandboxes.list(s.org.id);
		// The sandbox page frames its screens as ever, but says its files and output aren't available end to end yet,
		// rather than asking the gateway for them.
		expect(source.sandboxes.screens).toBe("console");
		expect(await source.sandboxes.endToEnd?.(s.sandbox.id)).toBe(true);

		// Until it trusts the genesis Bob was given, and an admin adds it, it reads nothing.
		expect(await browser.standing(s.org.id)).toEqual({ kind: "unpinned" });
		await expect(source.sandboxes.history(s.sandbox.id)).rejects.toThrow(/isn't a device in the organisation's chain/);
		await browser.trust(s.org.id, s.genesis);
		const pending = await browser.standing(s.org.id);
		if (pending.kind !== "pending") throw new Error(`Expected pending, got ${pending.kind}`);
		expect(pending.command).toMatch(/^kantel e2e add-device --member \S+$/);
		await expect(source.sandboxes.history(s.sandbox.id)).rejects.toThrow(/isn't in the space's chain/);
		// Its keys can't be read out of the store.
		const pairs = (kept.get(`keys:${PEOPLE.bob.userId}`) as { pairs: WebKeyPairs }).pairs;
		await expect(crypto.subtle.exportKey("pkcs8", pairs.dh.privateKey)).rejects.toThrow();
		await expect(crypto.subtle.exportKey("pkcs8", pairs.sign.privateKey)).rejects.toThrow();

		// The admin adds the card the command carries, after checking its fingerprint with Bob.
		const card = await parseCard(pending.command.split(" ").at(-1) ?? "");
		expect(card).toMatchObject({ user: PEOPLE.bob.userId, class: "web", label: "Hosted console in Firefox" });
		expect(await fingerprint(fromBase64url(card.sign), fromBase64url(card.dh))).toBe(pending.fingerprint);
		await s.append({ type: "member.add", body: { user: PEOPLE.bob.userId, role: "member" } });
		await s.append({ type: "device.add", body: { device: card } });
		expect(await browser.standing(s.org.id)).toEqual({ kind: "ready", label: "Hosted console in Firefox" });

		const framesBefore = s.host.frames.toGateway.length;
		const history = await source.sandboxes.history(s.sandbox.id);
		expect(history).toEqual([expect.objectContaining({ command: SECRET_COMMAND, exitCode: 0 })]);
		// Asked as kantel console asks, by the host's cursor and without output.
		expect(s.host.ran.at(-1)).toMatchObject({
			device: card.id,
			method: "sandbox.history",
			params: { limit: 100, output: false },
		});
		// The host's answer went back through the hub as ciphertext.
		const carried = joined(s.host.frames.toGateway.slice(framesBefore));
		expect(carried.byteLength).toBeGreaterThan(0);
		for (const secret of [SECRET_COMMAND, SECRET_OUTPUT, "sandbox.history"]) {
			expect(contains(carried, utf8(secret))).toBe(false);
		}

		// Strict lets no browser in: the console says so, and the host would refuse it anyway.
		await s.append({ type: "mode", body: { mode: "strict" } });
		expect(await browser.standing(s.org.id)).toEqual({
			kind: "refused",
			reason: "This space is strict: the hosted console isn't let in",
		});
		await expect(source.sandboxes.history(s.sandbox.id)).rejects.toThrow(/strict/);

		// Back on, then the admin takes the browser out: it can't come back with the same keys.
		await s.append({ type: "mode", body: { mode: "on" } });
		await s.append({ type: "device.remove", body: { id: card.id } });
		expect(await browser.standing(s.org.id)).toEqual({
			kind: "refused",
			reason: "An admin took this browser out of the chain",
		});
	});

	it("keeps each person's keys and trust apart in a shared browser, and trusts no other genesis", async () => {
		const s = await organisation();
		const { kept, db } = memoryDb();
		const as = (who: "root" | "bob") =>
			apiCompute({
				baseUrl: "https://kantel.test/v1",
				headers: () => ({ authorization: `Bearer ${who}` }),
				fetch: s.gatewayFetch,
				browser: { db, connect: s.tunnel },
			});
		const bob = (await as("bob")).e2e?.browser;
		const admin = (await as("root")).e2e?.browser;
		await bob?.trust(s.org.id, s.genesis);
		expect((await bob?.standing(s.org.id))?.kind).toBe("pending");
		// Root, in the same browser, has trusted nothing yet.
		expect(await admin?.standing(s.org.id)).toEqual({ kind: "unpinned" });
		// A genesis that isn't the chain's: the gateway's chain doesn't verify from it, so nothing is trusted.
		await admin?.trust(s.org.id, "a".repeat(43));
		await expect(admin?.standing(s.org.id)).rejects.toThrow(/genesis/i);
		await expect(bob?.trust(s.org.id, "a".repeat(43))).rejects.toThrow(/already trusts another chain/);
		expect([...kept.keys()].filter((key) => key.startsWith("keys:")).sort()).toEqual([
			`keys:${PEOPLE.bob.userId}`,
			`keys:${PEOPLE.root.userId}`,
		]);
	});

	it("never lends one person's keys to another's sign-in, and retires once the tab's sign-in changes", async () => {
		const s = await organisation();
		await s.rootCalls("sandbox.exec", { command: SECRET_COMMAND });
		const { db } = memoryDb();
		// The tab's session as localStorage has it: another tab signing out and in changes it under this one.
		let token = "bob";
		const sent: { path: string; authorization: string | null }[] = [];
		const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			sent.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
			return s.gatewayFetch(request);
		};
		const open = (who: string) =>
			apiCompute({
				baseUrl: "https://kantel.test/v1",
				headers: () => ({ authorization: `Bearer ${who === "tab" ? token : who}` }),
				fetch,
				browser: { db, connect: s.tunnel },
			});
		const source = await open("tab");
		const { card } = await enrol(s, source);
		const read = [expect.objectContaining({ command: SECRET_COMMAND })];
		// While the tab is Bob's, it reads as Bob; every call it makes as a device carries Bob's session.
		sent.length = 0;
		expect(await source.sandboxes.history(s.sandbox.id)).toEqual(read);
		const asDevice = sent.filter(({ path }) => path.includes("/e2e"));
		expect(asDevice.length).toBeGreaterThan(0);
		expect(new Set(asDevice.map(({ authorization }) => authorization))).toEqual(new Set(["Bearer bob"]));

		// Bob signs out and Root, with no device of his in this browser, signs in in another tab.
		token = "root";
		const ran = s.host.ran.length;
		sent.length = 0;
		await expect(source.sandboxes.history(s.sandbox.id)).rejects.toThrow(
			/sign-in has ended or another has replaced it/,
		);
		expect(await source.e2e?.browser?.standing(s.org.id)).toEqual({
			kind: "refused",
			reason: expect.stringMatching(/load the page again/),
		});
		// No session opened with Bob's keys, and nothing went to the gateway as Root for one.
		expect(s.host.ran.length).toBe(ran);
		expect(sent.filter(({ path }) => path.includes("/e2e"))).toEqual([]);
		// Retired for good: Bob's token back in storage doesn't bring it back.
		token = "bob";
		await expect(source.sandboxes.history(s.sandbox.id)).rejects.toThrow(/sign-in has ended/);
		expect(s.host.ran.length).toBe(ran);

		// A console loaded as Root has Root's keys and trust only, and he has trusted nothing in this browser.
		const root = await open("root");
		expect(await root.e2e?.browser?.standing(s.org.id)).toEqual({ kind: "unpinned" });
		await expect(root.sandboxes.history(s.sandbox.id)).rejects.toThrow(/isn't a device in the organisation's chain/);
		expect(s.host.ran.length).toBe(ran);
		// One loaded as Bob again reads with Bob's browser keys.
		expect(await (await open("bob")).sandboxes.history(s.sandbox.id)).toEqual(read);
		expect(s.host.ran.at(-1)).toMatchObject({ device: card.id, method: "sandbox.history" });
	});

	it("retires behind a cookie the page can't read once the gateway says someone else is signed in", async () => {
		const s = await organisation();
		const { db } = memoryDb();
		// Cloudflare Access: no header from the page; the browser sends the edge's cookie, here whoever `cookie` names.
		let cookie = "bob";
		// Set, the cookie becomes Root's as the session's URL is asked for: after every check the device makes.
		let switchAfterCheck = false;
		const opened: number[] = [];
		const make = () =>
			apiCompute({
				baseUrl: "https://kantel.test/v1",
				headers: () => ({}),
				fetch: async (input, init) => {
					const request = new Request(input, init);
					const opening = new URL(request.url).pathname === `/v1/sandboxes/${s.sandbox.id}/e2e`;
					if (switchAfterCheck && opening) cookie = "root";
					request.headers.set("authorization", `Bearer ${cookie}`);
					const response = await s.gatewayFetch(request);
					if (opening) opened.push(response.status);
					return response;
				},
				browser: { db, connect: s.tunnel },
			});
		const source = await make();
		await enrol(s, source);
		expect(await source.sandboxes.history(s.sandbox.id)).toEqual([]);
		const ran = s.host.ran.length;

		// Root's cookie by the next call.
		cookie = "root";
		await expect(source.sandboxes.history(s.sandbox.id)).rejects.toThrow(
			/sign-in has ended or another has replaced it/,
		);
		expect(s.host.ran.length).toBe(ran);

		// Root's cookie between the check and the session's URL: the gateway gives Root no URL asked for as Bob.
		cookie = "bob";
		const fresh = await make();
		opened.length = 0;
		switchAfterCheck = true;
		await expect(fresh.sandboxes.history(s.sandbox.id)).rejects.toThrow(/sign-in has ended or another has replaced it/);
		expect(opened).toEqual([403]);
		expect(s.host.ran.length).toBe(ran);
		// And the tab is retired: Bob's cookie back doesn't bring it back.
		switchAfterCheck = false;
		cookie = "bob";
		await expect(fresh.sandboxes.history(s.sandbox.id)).rejects.toThrow(/sign-in has ended/);
		expect(s.host.ran.length).toBe(ran);
	});

	it("reads plaintext history only where the chain it verified says off", async () => {
		const s = await organisation();
		await s.rootCalls("sandbox.exec", { command: SECRET_COMMAND });
		const { db } = memoryDb();
		// The gateway's chain as this test rewrites it, and every time the console asks the gateway for history.
		let forge: ((entries: ChainEntry[]) => Promise<ChainEntry[]>) | undefined;
		const askedGateway: string[] = [];
		const chainPath = `/v1/accounts/${s.org.id}/e2e/chain`;
		const source = await apiCompute({
			baseUrl: "https://kantel.test/v1",
			headers: () => ({ authorization: "Bearer bob" }),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const { pathname } = new URL(request.url);
				if (pathname.endsWith("/commands")) askedGateway.push(pathname);
				const response = await s.gatewayFetch(request);
				if (forge === undefined || pathname !== chainPath || request.method !== "GET") return response;
				const chain = (await response.json()) as { entries: ChainEntry[] };
				return Response.json({ ...chain, entries: await forge(chain.entries) });
			},
			browser: { db, connect: s.tunnel },
		});
		await enrol(s, source);
		const read = [expect.objectContaining({ command: SECRET_COMMAND })];
		expect(await source.sandboxes.history(s.sandbox.id)).toEqual(read);

		// Someone not in the chain says off: a whole new chain off from its genesis, or an entry on the end.
		const impostor = await newIdentity();
		const by = { id: await keyId("kd", impostor.signer.publicKey), signer: impostor.signer };
		const device = await chainDevice(impostor, PEOPLE.bob.userId, "cli", "not root");
		const offGenesis = await signEntry(undefined, s.org.id, { type: "genesis", body: { mode: "off", device } }, by, 1);
		const forged: [string, (entries: ChainEntry[]) => Promise<ChainEntry[]>, RegExp][] = [
			["no chain", async () => [], /no chain/],
			["another genesis, off", async () => [offGenesis], /genesis|verif|signature/i],
			[
				"an entry off it didn't sign",
				async (entries) => {
					const state = await verifyChain(entries, s.genesis);
					return [
						...entries,
						await signEntry(state, s.org.id, { type: "mode", body: { mode: "off" } }, by, Date.now()),
					];
				},
				/./,
			],
			// From before the browser was added: it goes back on the chain the browser verified.
			["an older chain", async (entries) => entries.slice(0, 1), /goes back on what this device verified/],
		];
		for (const [what, rewrite, refusal] of forged) {
			forge = rewrite;
			await expect(source.sandboxes.history(s.sandbox.id), what).rejects.toThrow(refusal);
			// Nor does the sandbox page take it as off and read its files through the gateway.
			await expect(source.sandboxes.endToEnd?.(s.sandbox.id), what).rejects.toThrow(refusal);
			expect(askedGateway, what).toEqual([]);
		}

		// Root really turns it off, signed in the chain: then the gateway's history is the one there is.
		forge = undefined;
		await s.append({ type: "mode", body: { mode: "off" } });
		await source.sandboxes.history(s.sandbox.id);
		expect(askedGateway).toEqual([`/v1/sandboxes/${s.sandbox.id}/commands`]);
		// Off, its page reads files and output through the gateway as for any other sandbox.
		expect(await source.sandboxes.endToEnd?.(s.sandbox.id)).toBe(false);
	});

	it("keeps one set of keys when tabs make them at once, and every tab shows that set", async () => {
		const s = await organisation();
		const { kept, db } = memoryDb();
		const tab = () =>
			apiCompute({
				baseUrl: "https://kantel.test/v1",
				headers: () => ({ authorization: "Bearer bob" }),
				fetch: s.gatewayFetch,
				browser: { db, connect: s.tunnel },
			});
		const tabs = await Promise.all([tab(), tab(), tab()]);
		// One tab has pinned the genesis and not yet kept keys when the others look: each would make a set.
		kept.set(`trust:${PEOPLE.bob.userId}/${s.org.id}`, { genesis: s.genesis });
		const standings = await Promise.all(tabs.map((t) => t.e2e?.browser?.standing(s.org.id)));
		const commands = new Set(standings.map((standing) => (standing?.kind === "pending" ? standing.command : "")));
		expect(commands.size).toBe(1);
		// The card every tab shows is the set that is kept.
		const card = await parseCard([...commands][0]?.split(" ").at(-1) ?? "");
		const pairs = (kept.get(`keys:${PEOPLE.bob.userId}`) as { pairs: WebKeyPairs }).pairs;
		const dh = new Uint8Array(await crypto.subtle.exportKey("raw", pairs.dh.publicKey));
		expect(card.dh).toBe(toBase64url(dh));
		// Once added, every tab reads with it.
		await s.append({ type: "member.add", body: { user: PEOPLE.bob.userId, role: "member" } });
		await s.append({ type: "device.add", body: { device: card } });
		for (const t of tabs) expect(await t.e2e?.browser?.standing(s.org.id)).toMatchObject({ kind: "ready" });
	});

	it("is labelled by the browser it is in", () => {
		const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
		const edge = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML) Chrome/140.0 Safari/537.36 Edg/140.0";
		const safari = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML) Version/18.0 Safari/605.1.15";
		expect(browserLabel(firefox)).toBe("Hosted console in Firefox");
		expect(browserLabel(edge)).toBe("Hosted console in Edge");
		expect(browserLabel(safari)).toBe("Hosted console in Safari");
		expect(browserLabel("")).toBe("Hosted console in a browser");
	});
});
