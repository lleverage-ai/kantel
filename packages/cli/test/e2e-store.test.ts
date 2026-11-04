// What `kantel e2e` keeps on disk, and what it takes from the gateway, on a real filesystem: one device identity however
// many commands start at once, a checkpoint that only moves forward, an append taken only if the answer holds it, and an
// init whose answer was lost finishing with the genesis this device signed. The gateway is a stand-in that holds
// one chain and can lose answers or answer what it likes.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { type ChainEntry, chainDevice, entryHash, signEntry, verifyChain } from "@kantel/e2e/chain";
import { keyId, newIdentity } from "@kantel/e2e/keys";
import { afterEach, describe, expect, it } from "vitest";
import { proxyEnv } from "../src/commands.ts";
import {
	appendEntry,
	type Device,
	initChain,
	loadDevice,
	pinGenesis,
	pinnedGenesis,
	verifiedChain,
	withFileLock,
} from "../src/e2e.ts";

const SPACE = "acc_e2e";
const USER = "usr_root";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function configDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "kantel-e2e-store-"));
	dirs.push(dir);
	return dir;
}

const spaceFile = async (dir: string) =>
	JSON.parse(await readFile(join(dir, "e2e", "spaces", `${SPACE}.json`), "utf8")) as { seq?: number; head?: string };

/**
 * A gateway holding one chain. `loseNext` commits the next append and then throws as a lost connection would;
 * `answer` replaces what an append answers.
 */
function gateway() {
	const chain: ChainEntry[] = [];
	const g = {
		chain,
		loseNext: false,
		refuseNext: undefined as KantelApiError | undefined,
		answer: undefined as ((entries: ChainEntry[]) => ChainEntry[]) | undefined,
		client: {
			getE2EChain: async () => ({ entries: [...chain] }),
			appendE2EChain: async (_space: string, body: { from: number; entries: ChainEntry[] }) => {
				if (g.refuseNext !== undefined) {
					const refusal = g.refuseNext;
					g.refuseNext = undefined;
					throw refusal;
				}
				if (body.from !== chain.length) {
					throw new KantelApiError(409, "conflict", `The chain is ${chain.length} entries long, not ${body.from}`);
				}
				chain.push(...body.entries);
				if (g.loseNext) {
					g.loseNext = false;
					throw new TypeError("fetch failed");
				}
				return { entries: g.answer?.([...chain]) ?? [...chain] };
			},
		} as unknown as KantelClient,
	};
	return g;
}

describe("this device's identity", () => {
	it("is made once, however many commands start at once, and never replaced", async () => {
		const dir = await configDir();
		const loaded = await Promise.all(Array.from({ length: 12 }, (_, i) => loadDevice(dir, `try ${i}`)));
		const again = await loadDevice(dir, "later");
		expect(new Set(loaded.map((device) => device.id))).toEqual(new Set([again.id]));
		expect(loaded.every((device) => device.label === again.label)).toBe(true);
		// No lock or half-written file is left behind.
		expect(await readdir(join(dir, "e2e"))).toEqual(["device.json"]);
	});
});

describe("the space file", () => {
	/** A chain of `n` member.add entries after the genesis, signed by `device`. */
	async function chainOf(device: Device, n: number): Promise<ChainEntry[]> {
		const by = { id: device.id, signer: device.identity.signer };
		const genesis = await signEntry(
			undefined,
			SPACE,
			{ type: "genesis", body: { mode: "on", device: await chainDevice(device.identity, USER, "cli", "laptop") } },
			by,
			1,
		);
		const entries = [genesis];
		let state = await verifyChain(entries);
		for (let i = 0; i < n; i++) {
			entries.push(
				await signEntry(state, SPACE, { type: "member.add", body: { user: `usr_${i}`, role: "member" } }, by, 2 + i),
			);
			state = await verifyChain(entries);
		}
		return entries;
	}

	it("keeps the newest chain verified when commands verify older and newer ones at once", async () => {
		const dir = await configDir();
		const device = await loadDevice(dir);
		const full = await chainOf(device, 6);
		const genesis = await entryHash(full[0] as ChainEntry);
		await pinGenesis(dir, SPACE, genesis);
		const newest = await verifyChain(full);
		for (let round = 0; round < 5; round++) {
			const reads = [2, 6, 3, 1, 5].map((n) =>
				verifiedChain(
					{ getE2EChain: async () => ({ entries: full.slice(0, n + 1) }) } as unknown as KantelClient,
					dir,
					SPACE,
				).then(
					() => "taken",
					(error: Error) => error.message,
				),
			);
			// Pinning the same genesis again, meanwhile, never takes the checkpoint back to the genesis alone.
			const pins = [pinGenesis(dir, SPACE, genesis), pinGenesis(dir, SPACE, genesis)];
			const results = await Promise.all(reads);
			await Promise.all(pins);
			for (const result of results) expect(result).toMatch(/^taken$|goes back on what this device verified/);
			expect(await spaceFile(dir)).toMatchObject({ seq: newest.seq, head: newest.head });
		}
		// Any shorter chain is refused from now on.
		await expect(
			verifiedChain(
				{ getE2EChain: async () => ({ entries: full.slice(0, 4) }) } as unknown as KantelClient,
				dir,
				SPACE,
			),
		).rejects.toThrow(/goes back on what this device verified/);
		await expect(pinGenesis(dir, SPACE, "b".repeat(43))).rejects.toThrow(/already trusts another chain/);
	});

	it("waits for a lock another command holds, and breaks one left by a command that died", async () => {
		const dir = await configDir();
		const path = join(dir, "thing.json");
		const order: string[] = [];
		await Promise.all([
			withFileLock(path, async () => {
				order.push("first in");
				await new Promise((done) => setTimeout(done, 50));
				order.push("first out");
			}),
			new Promise((done) => setTimeout(done, 5)).then(() =>
				withFileLock(path, async () => {
					order.push("second");
				}),
			),
		]);
		expect(order).toEqual(["first in", "first out", "second"]);
		// A lock from long ago: its holder has gone.
		const { utimes, writeFile } = await import("node:fs/promises");
		await writeFile(`${path}.lock`, "999999\n");
		const old = new Date(Date.now() - 60_000);
		await utimes(`${path}.lock`, old, old);
		await expect(withFileLock(path, async () => "in")).resolves.toBe("in");
	});
});

describe("an append", () => {
	async function started() {
		const dir = await configDir();
		const device = await loadDevice(dir);
		const g = gateway();
		const chain = await initChain(g.client, dir, device, SPACE, USER, "on");
		return { dir, device, g, chain };
	}

	it("is taken when the answer holds it, with any entries after it", async () => {
		const { dir, device, g, chain } = await started();
		const next = await appendEntry(g.client, dir, device, chain, {
			type: "member.add",
			body: { user: "usr_bob", role: "member" },
		});
		expect(next.state.members.get("usr_bob")).toBe("member");
		// Another entry after this one in the answer is fine: it verifies, and holds this one where it was added.
		const other = await newIdentity();
		g.answer = (entries) => entries;
		const third = await appendEntry(g.client, dir, device, next, {
			type: "device.add",
			body: { device: await chainDevice(other, "usr_bob", "cli", "bob's laptop") },
		});
		expect(third.state.seq).toBe(next.state.seq + 1);
	});

	it("isn't taken from an answer without it: the chain from before, or another entry in its place", async () => {
		const { dir, device, g, chain } = await started();
		const added = await appendEntry(g.client, dir, device, chain, {
			type: "member.add",
			body: { user: "usr_bob", role: "member" },
		});
		// The gateway drops the removal and answers the chain as it was.
		g.answer = (entries) => entries.slice(0, -1);
		await expect(
			appendEntry(g.client, dir, device, added, { type: "member.remove", body: { user: "usr_bob" } }),
		).rejects.toThrow(/doesn't hold this change/);
		// Or answers another entry, validly signed by this device earlier, in its place.
		const by = { id: device.id, signer: device.identity.signer };
		const instead = await signEntry(
			added.state,
			SPACE,
			{ type: "member.add", body: { user: "usr_eve", role: "admin" } },
			by,
			Date.now(),
		);
		g.chain.splice(added.state.seq + 1);
		g.answer = (entries) => [...entries.slice(0, added.state.seq + 1), instead];
		await expect(
			appendEntry(g.client, dir, device, added, { type: "member.remove", body: { user: "usr_bob" } }),
		).rejects.toThrow(/doesn't hold this change/);
		// What this device verified hasn't moved past what it was told.
		expect((await spaceFile(dir)).seq).toBe(added.state.seq);
	});
});

describe("starting a chain", () => {
	it("finishes with its own genesis when the gateway took it but the answer was lost", async () => {
		const dir = await configDir();
		const device = await loadDevice(dir);
		const g = gateway();
		g.loseNext = true;
		await expect(initChain(g.client, dir, device, SPACE, USER, "on")).resolves.toMatchObject({
			state: { seq: 0, mode: "on" },
		});
		expect(g.chain).toHaveLength(1);
		expect(await pinnedGenesis(dir, SPACE)).toBe(await entryHash(g.chain[0] as ChainEntry));
		expect(await readdir(join(dir, "e2e", "pending"))).toEqual([]);
	});

	it("finishes on a second try when the first lost its answer and no chain was readable then", async () => {
		const dir = await configDir();
		const device = await loadDevice(dir);
		const g = gateway();
		// The first try's append and the read after it both fail: the genesis is kept, and the retry uses it.
		g.loseNext = true;
		const getChain = g.client.getE2EChain;
		let failRead = true;
		(g.client as { getE2EChain: unknown }).getE2EChain = async (space: string) => {
			if (failRead) {
				failRead = false;
				throw new TypeError("fetch failed");
			}
			return getChain(space);
		};
		await expect(initChain(g.client, dir, device, SPACE, USER, "on")).rejects.toThrow(/fetch failed/);
		expect(await pinnedGenesis(dir, SPACE)).toBeUndefined();
		const finished = await initChain(g.client, dir, device, SPACE, USER, "on");
		expect(g.chain).toHaveLength(1);
		expect(finished.state.genesis).toBe(await entryHash(g.chain[0] as ChainEntry));
		expect(await pinnedGenesis(dir, SPACE)).toBe(finished.state.genesis);
	});

	it("trusts nothing when another chain is there, and keeps nothing when it is refused", async () => {
		const dir = await configDir();
		const device = await loadDevice(dir);
		const g = gateway();
		const someoneElse = await newIdentity();
		g.chain.push(
			await signEntry(
				undefined,
				SPACE,
				{ type: "genesis", body: { mode: "on", device: await chainDevice(someoneElse, "usr_other", "cli", "theirs") } },
				{ id: await keyId("kd", someoneElse.signer.publicKey), signer: someoneElse.signer },
				1,
			),
		);
		await expect(initChain(g.client, dir, device, SPACE, USER, "on")).rejects.toThrow(/already has a chain/);
		expect(await pinnedGenesis(dir, SPACE)).toBeUndefined();

		const fresh = gateway();
		fresh.refuseNext = new KantelApiError(403, "forbidden", "Only an admin or owner starts the chain");
		await expect(initChain(fresh.client, dir, device, "acc_other", USER, "on")).rejects.toThrow(/admin or owner/);
		expect(await pinnedGenesis(dir, "acc_other")).toBeUndefined();
		expect(await readdir(join(dir, "e2e", "pending"))).toEqual([]);
	});
});

describe("kantel e2e ssh's proxy", () => {
	it("is given the gateway, key and account this invocation resolved", () => {
		expect(proxyEnv({ url: "https://mine.test/v1", apiKey: "kt_secret", account: "acc_1" })).toEqual({
			KANTEL_URL: "https://mine.test/v1",
			KANTEL_API_KEY: "kt_secret",
			KANTEL_ACCOUNT: "acc_1",
		});
		expect(proxyEnv({ url: "https://mine.test/v1" })).toEqual({ KANTEL_URL: "https://mine.test/v1" });
	});
});
