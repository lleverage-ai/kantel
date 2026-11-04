// A device's side of E2E (device.ts) with a browser's keys: WebCrypto keys nothing can read out, trust from a pinned
// genesis, and a call on the host over a session the relay can't read.
import { describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.ts";
import { type ChainEntry, extendChain, type SpaceState, verifyChain } from "../src/chain.ts";
import {
	callHost,
	type DeviceGateway,
	DeviceTrustError,
	deviceCard,
	keysFingerprint,
	memoryTrustStore,
	parseCard,
	pinGenesis,
	type TrustStore,
	trustedChain,
} from "../src/device.ts";
import { type DeviceKeys, generateWebKeys, keysFromWebKeys } from "../src/keys.ts";
import { serveSession } from "../src/responder.ts";
import type { ByteChannel } from "../src/session.ts";
import { contains, recordingRelay } from "../src/testing.ts";
import { type Fixture, fixture, HOST_ID, SPACE, signAs, T0 } from "./fixture.ts";

const SECRET = "OPENAI_API_KEY=sk-live-the-secret-value";

const memoryTrust = memoryTrustStore;

/** The fixture's host, knowing `knows`, answering `sandbox.history` on sbx_one. */
function host(f: Fixture, channel: ByteChannel, knows: readonly ChainEntry[]) {
	let state: SpaceState | undefined;
	const calls: string[] = [];
	const served = verifyChain(knows).then((verified) => {
		state = verified;
		return serveSession({
			channel,
			static: f.host.static,
			hostId: HOST_ID,
			chain: {
				state: () => state as SpaceState,
				async extend(from, entries) {
					state = await extendChain(state as SpaceState, entries, from);
					return state;
				},
			},
			authorize: (_device, hello) => (hello.sandbox === "sbx_one" ? undefined : "No such sandbox on this host"),
			async rpc(device, _sandbox, method) {
				calls.push(`${device.class}:${method}`);
				return { items: [{ command: SECRET }] };
			},
			async port() {
				throw new Error("No ports here");
			},
		});
	});
	return { served, calls };
}

const gatewayOf = (entries: () => readonly ChainEntry[]): DeviceGateway => ({
	openE2E: async () => ({ url: "wss://relay.test/e2e", hostId: HOST_ID, accountId: SPACE }),
	getE2EChain: async () => ({ entries: entries() }),
});

/** A browser device of Bob's, added to the fixture's chain by Tom. */
async function browser(f: Fixture) {
	const keys = await keysFromWebKeys(await generateWebKeys());
	const card = await parseCard(await deviceCard(keys, "usr_bob", "web", "console in Firefox"));
	const added = await signAs(f.state, f.tom, { type: "device.add", body: { device: card } }, T0 + 400_000);
	const entries = [...f.entries, added];
	return { keys, card, entries, state: await verifyChain(entries) };
}

describe("a browser device", () => {
	it("keeps keys nothing can read out", async () => {
		const pairs = await generateWebKeys();
		await expect(crypto.subtle.exportKey("pkcs8", pairs.sign.privateKey)).rejects.toThrow();
		await expect(crypto.subtle.exportKey("pkcs8", pairs.dh.privateKey)).rejects.toThrow();
		await expect(crypto.subtle.exportKey("jwk", pairs.dh.privateKey)).rejects.toThrow();
		const keys: DeviceKeys = await keysFromWebKeys(pairs);
		const card = await parseCard(await deviceCard(keys, "usr_bob", "web", "console in Firefox"));
		expect(card).toMatchObject({ user: "usr_bob", class: "web", label: "console in Firefox" });
		expect(await keysFingerprint(keys)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
	});

	it("runs a call on the host once an admin has added it, and the relay carries only ciphertext", async () => {
		const f = await fixture();
		const b = await browser(f);
		const trust = memoryTrust();
		await pinGenesis(trust, SPACE, f.state.genesis);
		const relay = recordingRelay({ chunk: 5 });
		// The host hasn't heard of the browser: the session brings it the entry.
		const h = host(f, relay.host, f.entries);
		const page = await callHost<{ items: { command: string }[] }>({
			gateway: gatewayOf(() => b.entries),
			trust,
			keys: b.keys,
			sandboxId: "sbx_one",
			method: "sandbox.history",
			params: { limit: 10 },
			connect: async () => relay.device,
		});
		expect(page.items[0]?.command).toBe(SECRET);
		await h.served;
		expect(h.calls).toEqual(["web:sandbox.history"]);
		const seen = relay.seen();
		for (const secret of [SECRET, "sandbox.history", "sbx_one"]) {
			expect(contains(seen.toHost, utf8(secret))).toBe(false);
			expect(contains(seen.toDevice, utf8(secret))).toBe(false);
		}
		expect(trust.saved.get(SPACE)).toEqual({ genesis: f.state.genesis, seq: b.state.seq, head: b.state.head });
	});

	it("is refused before any session when it isn't in the chain, has been removed, or the space is strict", async () => {
		const f = await fixture();
		const b = await browser(f);
		const removed = await signAs(b.state, f.tom, { type: "device.remove", body: { id: b.card.id } }, T0 + 500_000);
		const strict = await signAs(b.state, f.tom, { type: "mode", body: { mode: "strict" } }, T0 + 500_000);
		let connected = 0;
		const attempt = async (entries: readonly ChainEntry[]) => {
			const trust = memoryTrust();
			await pinGenesis(trust, SPACE, f.state.genesis);
			return callHost({
				gateway: gatewayOf(() => entries),
				trust,
				keys: b.keys,
				sandboxId: "sbx_one",
				method: "sandbox.history",
				connect: async () => {
					connected++;
					throw new Error("no session should open");
				},
			}).then(
				() => "ok",
				(error: unknown) => (error instanceof DeviceTrustError ? `${error.problem}: ${error.message}` : String(error)),
			);
		};
		expect(await attempt(f.entries)).toBe("not_in_chain: This device isn't in the space's chain");
		expect(await attempt([...b.entries, removed])).toBe("not_in_chain: This device isn't in the space's chain");
		expect(await attempt([...b.entries, strict])).toBe(
			"refused: This space is strict: the hosted console isn't let in",
		);
		expect(connected).toBe(0);
	});

	it("trusts only the genesis it pinned, and no chain that goes back on one it verified", async () => {
		const f = await fixture();
		const b = await browser(f);
		const trust = memoryTrust();
		await expect(trustedChain(trust, SPACE, b.entries)).rejects.toMatchObject({ problem: "unpinned" });
		await expect(pinGenesis(trust, SPACE, "not a genesis")).rejects.toThrow(/isn't a chain's genesis/);
		await pinGenesis(trust, SPACE, f.state.genesis);
		await pinGenesis(trust, SPACE, ` ${f.state.genesis}\n`);
		await expect(pinGenesis(trust, SPACE, b.state.head)).rejects.toThrow(/already trusts another chain/);
		expect((await trustedChain(trust, SPACE, b.entries)).seq).toBe(b.state.seq);
		// An older chain, from before the browser was added: refused, and what was verified stays.
		await expect(trustedChain(trust, SPACE, f.entries)).rejects.toMatchObject({ problem: "rollback" });
		expect(trust.saved.get(SPACE)?.seq).toBe(b.state.seq);
		// Another space's chain, or one the gateway forks at the genesis, doesn't verify from the pin.
		const other = memoryTrust();
		await pinGenesis(other, SPACE, b.state.head);
		await expect(trustedChain(other, SPACE, b.entries)).rejects.toThrow();
	});

	it("keeps the newest chain it verified when checks overlap, and a pin never clears it", async () => {
		const f = await fixture();
		const b = await browser(f);
		const trust = memoryTrust();
		await pinGenesis(trust, SPACE, f.state.genesis);
		const pinned = trust.saved.get(SPACE);
		// Two checks read the pin; the one with the newer chain finishes first. The other, from what it read, would take
		// its older chain: what is kept when it writes says no.
		const stale: TrustStore = { read: async () => pinned, update: trust.update };
		expect((await trustedChain(trust, SPACE, b.entries)).seq).toBe(b.state.seq);
		await expect(trustedChain(stale, SPACE, f.entries)).rejects.toMatchObject({ problem: "rollback" });
		expect(trust.saved.get(SPACE)).toEqual({ genesis: f.state.genesis, seq: b.state.seq, head: b.state.head });
		// The same head again, however it was read, changes nothing.
		expect((await trustedChain(stale, SPACE, b.entries)).seq).toBe(b.state.seq);
		expect((await Promise.all([1, 2, 3].map(() => trustedChain(trust, SPACE, b.entries)))).map((s) => s.seq)).toEqual([
			b.state.seq,
			b.state.seq,
			b.state.seq,
		]);
		// Pinning the genesis again, as a second tab's set-up would, keeps the checkpoint; another genesis is refused.
		await Promise.all([pinGenesis(trust, SPACE, f.state.genesis), pinGenesis(trust, SPACE, f.state.genesis)]);
		expect(trust.saved.get(SPACE)?.seq).toBe(b.state.seq);
		await expect(pinGenesis(trust, SPACE, b.state.head)).rejects.toThrow(/already trusts another chain/);
		expect(trust.saved.get(SPACE)?.genesis).toBe(f.state.genesis);
	});
});
