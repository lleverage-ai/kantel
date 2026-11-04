/**
 * The gateway's copy of each organisation's E2E chain (`@kantel/e2e`): its signed members, devices, hosts and mode.
 *
 * The gateway keeps the chain and hands it out, and checks each append so it doesn't keep or serve one that wouldn't
 * verify, but it is not what anyone trusts: devices and hosts verify the chain themselves from a genesis they pinned, so
 * nothing the gateway adds, drops or changes gets a key into a session. An entry is a record of its own, its ID the
 * space and its seq, inserted only where none is: two appends racing for one seq can't both land, so the gateway's
 * copy never forks.
 */
import { KantelError } from "@kantel/contracts";
import { type ChainEntry, ChainError, parseEntry, type SpaceState, verifyChain } from "@kantel/e2e/chain";
import type { Collection } from "./store.ts";

/** One entry of one space's chain. */
export interface StoredE2EEntry {
	/** `<space>#<seq, 10 digits>`. */
	readonly id: string;
	readonly space: string;
	readonly seq: number;
	readonly payload: string;
	readonly sig: string;
	readonly addedAt: number;
}

/** The longest chain one append may add to. */
export const MAX_CHAIN_ENTRIES = 10_000;

const entryId = (space: string, seq: number) => `${space}#${String(seq).padStart(10, "0")}`;

export interface E2EChains {
	/** The space's entries, oldest first (none until it is started). */
	read(space: string): Promise<ChainEntry[]>;
	/** The verified state, or undefined when the space has no chain. */
	state(space: string): Promise<SpaceState | undefined>;
	/**
	 * Adds `entries` at `from` and answers the chain now. `invalid` unless the chain with them verifies, `conflict`
	 * when `from` isn't the chain's length (it moved). `check` sees each new entry's payload first, to refuse one the
	 * caller may not add, such as a genesis by someone who isn't the organisation's admin.
	 */
	append(
		space: string,
		from: number,
		entries: readonly ChainEntry[],
		check?: (payload: ReturnType<typeof parseEntry>["payload"]) => void | Promise<void>,
	): Promise<ChainEntry[]>;
}

const plain = (entry: StoredE2EEntry): ChainEntry => ({ payload: entry.payload, sig: entry.sig });

export function createE2EChains(collection: Collection<StoredE2EEntry>, now: () => number = Date.now): E2EChains {
	const read = async (space: string) =>
		(await collection.list({ space }))
			.sort((a, b) => a.seq - b.seq)
			.filter((entry, index) => entry.seq === index)
			.map(plain);
	return {
		read,
		async state(space) {
			const entries = await read(space);
			return entries.length === 0 ? undefined : verifyChain(entries);
		},
		async append(space, from, entries, check) {
			if (entries.length === 0) throw new KantelError("invalid", "No entries");
			const current = await read(space);
			if (from !== current.length) {
				throw new KantelError("conflict", `The chain is ${current.length} entries long, not ${from}: fetch it again`);
			}
			if (current.length + entries.length > MAX_CHAIN_ENTRIES) throw new KantelError("invalid", "The chain is full");
			for (const entry of entries) {
				let payload: ReturnType<typeof parseEntry>["payload"];
				try {
					payload = parseEntry(entry).payload;
				} catch (error) {
					throw new KantelError("invalid", error instanceof Error ? error.message : "Not an entry");
				}
				if (payload.space !== space) throw new KantelError("invalid", "An entry is for another space");
				await check?.(payload);
			}
			try {
				await verifyChain([...current, ...entries]);
			} catch (error) {
				if (error instanceof ChainError) throw new KantelError("invalid", error.message);
				throw error;
			}
			let seq = from;
			for (const entry of entries) {
				const inserted = await collection.insert({
					id: entryId(space, seq),
					space,
					seq,
					payload: entry.payload,
					sig: entry.sig,
					addedAt: now(),
				});
				if (!inserted) {
					throw new KantelError("conflict", `Another entry ${seq} got there first: fetch the chain again`);
				}
				seq++;
			}
			return read(space);
		},
	};
}
