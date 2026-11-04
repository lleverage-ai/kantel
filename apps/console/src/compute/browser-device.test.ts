// The hosted console's browser device end to end: the console's own source (api-source.ts) as Bob signs in, against
// the real compute API, the hosts service's hub and kantel-host's TypeScript twin (packages/hosts/test/e2e-host.ts).
// The admin signs the chain's entries with `@kantel/e2e`, as `kantel e2e` does. The browser's store is a map here; in a
// page it is IndexedDB.

import { fromBase64url, utf8 } from "@kantel/e2e/bytes";
import {
	chainDevice,
	createHostTicket,
	type EntryBody,
	extendChain,
	type SpaceState,
	signEntry,
	verifyChain,
} from "@kantel/e2e/chain";
import { callHost, parseCard, pinGenesis, type SpaceTrust } from "@kantel/e2e/device";
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

function memoryDb() {
	const kept = new Map<string, unknown>();
	const db: DeviceDb = {
		get: async <T>(store: string, key: string) => kept.get(`${store}:${key}`) as T | undefined,
		put: async (store, key, value) => {
			kept.set(`${store}:${key}`, value);
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
		const trust = new Map<string, SpaceTrust>();
		const store = {
			read: async (space: string) => trust.get(space),
			write: async (space: string, t: SpaceTrust) => void trust.set(space, t),
		};
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
		expect(s.host.ran.at(-1)).toMatchObject({ device: card.id, method: "sandbox.history" });
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
