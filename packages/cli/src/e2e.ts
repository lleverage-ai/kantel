/**
 * `kantel e2e`: this device's keys, the organisation's signed chain, and sessions to hosts the gateway relays but
 * can't read (`@kantel/e2e`).
 *
 * The device's seeds are in `<config>/e2e/device.json` (0600) and never leave it. What this device trusts is the
 * genesis it pinned in `<config>/e2e/spaces/<space>.json`: the one it made (`init`), or one an admin gave it out of
 * band (`join`). Every chain the gateway answers is verified from that genesis before it is used, so a key the gateway
 * adds, or a chain it makes up, is refused here as it is on the host.
 */
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { fromBase64url, toBase64url, utf8 } from "@kantel/e2e/bytes";
import {
	type ChainDevice,
	type ChainEntry,
	chainDevice,
	createHostTicket,
	type DeviceClass,
	type EntryBody,
	encodeJoinTicket,
	entryHash,
	type SpaceState,
	signEntry,
	verifyChain,
} from "@kantel/e2e/chain";
import { parseCard, webSocketChannel } from "@kantel/e2e/device";
import { fingerprint, type Identity, identityFromSeeds, type KeySeeds, keyId, randomSeed } from "@kantel/e2e/keys";
import { type ByteChannel, type OpenedSession, openSession, type SessionOp } from "@kantel/e2e/session";

interface DeviceFile {
	readonly v: 1;
	readonly seeds: KeySeeds;
	readonly label: string;
}

export interface Device {
	readonly identity: Identity;
	readonly id: string;
	readonly label: string;
}

const devicePath = (configDir: string) => join(configDir, "e2e", "device.json");
const spacePath = (configDir: string, space: string) =>
	join(configDir, "e2e", "spaces", `${space.replace(/[^\w.-]/g, "_")}.json`);

const pendingPath = (configDir: string, space: string) =>
	join(configDir, "e2e", "pending", `${space.replace(/[^\w.-]/g, "_")}.json`);

/** Writes the whole file or none of it: a reader never sees half a file, even if this process dies part way. */
async function writePrivate(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

/**
 * Writes `path` whole if it isn't there, and says whether it did: linked into place, which fails if a file is there,
 * so it never replaces one.
 */
async function createPrivate(path: string, value: unknown): Promise<boolean> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await link(temporary, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		await rm(temporary, { force: true });
	}
}

/**
 * A lock taken on another machine (a config directory on a shared disk) is abandoned only after this long: its
 * holder can't be asked whether it is running. One taken on this machine is abandoned when its process has gone.
 */
const FOREIGN_LOCK_MS = 10 * 60_000;
/** A lock file still without its holder after this long was left by a process that died making it. */
const UNWRITTEN_LOCK_MS = 5_000;

export interface LockOptions {
	/** How long to wait for another kantel to finish; default 30 s. */
	readonly waitMs?: number;
	/** For tests: runs once an abandoned lock is found, before it is broken, to let another process go first. */
	readonly beforeBreak?: () => Promise<void>;
}

/** A lock file as it was seen: which file (a new one is another file) and whether its holder has gone. */
interface SeenLock {
	readonly dev: number;
	readonly ino: number;
	readonly abandoned: boolean;
}

/**
 * Runs `act` holding `<path>.lock`, which every kantel sharing the config directory takes before it changes `path`
 * (or decides from it what to change): an exclusively created file holding its process and machine, since Node has
 * no flock.
 *
 * A lock is broken only when its holder has gone: its process isn't running on this machine, or (taken on another
 * machine) it is very old. Breaking one takes `<path>.lock.break` first, then looks again: so of two kantels that
 * found the same abandoned lock, the second sees the first one's fresh lock, whose holder is running, and leaves it.
 * A holder removes the lock on its way out only if it is still the file it made.
 */
export async function withFileLock<T>(path: string, act: () => Promise<T>, options: LockOptions = {}): Promise<T> {
	const lock = `${path}.lock`;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + (options.waitMs ?? 30_000);
	let held: SeenLock | undefined;
	for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
		held = await takeLock(lock);
		if (held !== undefined) break;
		if (await breakAbandoned(lock, options.beforeBreak)) continue;
		if (Date.now() > deadline) {
			throw new Error(
				`Another kantel is changing ${path}: try again. If none is running, remove ${lock} (and ${lock}.break)`,
			);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, wait));
	}
	try {
		return await act();
	} finally {
		await releaseLock(lock, held);
	}
}

/** Makes `lock`, holding this process and machine, or says it is there already. */
async function takeLock(lock: string): Promise<SeenLock | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(lock, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
		throw error;
	}
	try {
		await handle.writeFile(`${process.pid} ${hostname()}\n`);
		const { dev, ino } = await handle.stat();
		return { dev, ino, abandoned: false };
	} catch (error) {
		await rm(lock, { force: true });
		throw error;
	} finally {
		await handle.close();
	}
}

async function releaseLock(lock: string, held: SeenLock | undefined): Promise<void> {
	const now = await stat(lock).catch(() => undefined);
	if (held !== undefined && now !== undefined && now.dev === held.dev && now.ino === held.ino) {
		await rm(lock, { force: true });
	}
}

/** `lock` as it is now, or nothing if it has gone. */
async function seeLock(lock: string): Promise<SeenLock | undefined> {
	// One open file for both, so what it says and which file it is are the same file's.
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(lock, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let content: string;
	let info: Awaited<ReturnType<typeof handle.stat>>;
	try {
		info = await handle.stat();
		content = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
	const age = Date.now() - Number(info.mtimeMs);
	const [pid, machine] = content.trim().split(" ");
	const abandoned =
		pid === undefined || pid === "" || machine === undefined
			? age > UNWRITTEN_LOCK_MS
			: machine === hostname()
				? !running(Number(pid))
				: age > FOREIGN_LOCK_MS;
	return { dev: Number(info.dev), ino: Number(info.ino), abandoned };
}

function running(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it is running, as someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Removes `lock` if its holder has gone, and says whether to try for it again now. Done holding `<lock>.break`, and
 * only if the lock is still the abandoned file it was: one made since is someone's, who is running.
 */
async function breakAbandoned(lock: string, beforeBreak?: () => Promise<void>): Promise<boolean> {
	const seen = await seeLock(lock);
	if (seen === undefined) return true;
	if (!seen.abandoned) return false;
	await beforeBreak?.();
	const breaker = await takeLock(`${lock}.break`);
	if (breaker === undefined) return false;
	try {
		const again = await seeLock(lock);
		if (again?.abandoned && again.dev === seen.dev && again.ino === seen.ino) {
			await rm(lock, { force: true });
		}
	} finally {
		await releaseLock(`${lock}.break`, breaker);
	}
	return true;
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * This device's keys, made the first time (with `label`) and kept. Made under the device file's lock, read again
 * there: of two commands that start at once, both use the keys the first one made.
 */
export async function loadDevice(configDir: string, label?: string): Promise<Device> {
	const path = devicePath(configDir);
	const file =
		(await readJson<DeviceFile>(path)) ??
		(await withFileLock(path, async () => {
			const made = await readJson<DeviceFile>(path);
			if (made !== undefined) return made;
			const fresh: DeviceFile = {
				v: 1,
				seeds: { sign: toBase64url(randomSeed()), dh: toBase64url(randomSeed()) },
				label: label ?? "kantel",
			};
			// Published only if there is none, even were the lock not held: a device's keys are never written over.
			return (await createPrivate(path, fresh)) ? fresh : ((await readJson<DeviceFile>(path)) as DeviceFile);
		}));
	const identity = await identityFromSeeds(file.seeds);
	return { identity, id: await keyId("kd", identity.signer.publicKey), label: file.label };
}

export async function deviceFingerprint(device: Device): Promise<string> {
	return fingerprint(device.identity.signer.publicKey, device.identity.static.publicKey);
}

/** What `kantel e2e device` prints for an admin to add: the device as the chain lists it, as one word. */
export async function deviceCard(device: Device, user: string, deviceClass: DeviceClass = "cli"): Promise<string> {
	return toBase64url(utf8(JSON.stringify(await chainDevice(device.identity, user, deviceClass, device.label))));
}

/** A device card (this CLI's, or the hosted console's for a browser) as the chain will list it. */
export { parseCard };

export async function cardFingerprint(device: ChainDevice): Promise<string> {
	return fingerprint(fromBase64url(device.sign), fromBase64url(device.dh));
}

/** What this device keeps of a space: the genesis it trusts, and the newest entry it has verified. */
interface SpaceFile {
	readonly genesis: string;
	readonly seq?: number;
	readonly head?: string;
}

/** The genesis this device trusts for `space`, if it has one. */
export async function pinnedGenesis(configDir: string, space: string): Promise<string | undefined> {
	return (await readJson<SpaceFile>(spacePath(configDir, space)))?.genesis;
}

/** The spaces this device has pinned a genesis for (made or joined), by ID. */
export async function pinnedSpaces(configDir: string): Promise<readonly string[]> {
	try {
		const names = await readdir(join(configDir, "e2e", "spaces"));
		return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
	} catch {
		return [];
	}
}

/** Trusts `genesis` for `space`, under the space file's lock: never over another genesis, nor over a checkpoint. */
export async function pinGenesis(configDir: string, space: string, genesis: string): Promise<void> {
	const path = spacePath(configDir, space);
	await withFileLock(path, async () => {
		const pinned = (await readJson<SpaceFile>(path))?.genesis;
		if (pinned !== undefined && pinned !== genesis) {
			throw new Error(`This device already trusts another chain for ${space} (${short(pinned)})`);
		}
		if (pinned === undefined) await writePrivate(path, { genesis });
	});
}

/**
 * Takes a chain this device verified from its genesis only if it carries on from the newest one it verified before,
 * then remembers it: else the gateway could serve an older chain, with a device or host since removed still in it.
 * The check and the write are under the space file's lock, so of two commands that verified different chains at once
 * the newer one's stays, and the older one is refused rather than written over it.
 */
async function checkpoint(configDir: string, state: SpaceState): Promise<void> {
	const path = spacePath(configDir, state.space);
	await withFileLock(path, async () => {
		const saved = await readJson<SpaceFile>(path);
		if (saved !== undefined && saved.genesis !== state.genesis) {
			throw new Error(`This device trusts another chain for ${state.space} (${short(saved.genesis)})`);
		}
		if (saved?.seq !== undefined && saved.head !== undefined) {
			if (state.seq < saved.seq || state.hashes[saved.seq] !== saved.head) {
				throw new Error(
					`The gateway's chain for ${state.space} goes back on what this device verified before (seq ${saved.seq}): it isn't used`,
				);
			}
		}
		if (saved?.seq === state.seq && saved.head === state.head) return;
		await writePrivate(path, { genesis: state.genesis, seq: state.seq, head: state.head });
	});
}

export const short = (hash: string) => hash.slice(0, 16);

export interface VerifiedChain {
	readonly entries: readonly ChainEntry[];
	readonly state: SpaceState;
}

/** The space's chain from the gateway, verified from the genesis this device pinned. */
export async function verifiedChain(client: KantelClient, configDir: string, space: string): Promise<VerifiedChain> {
	const genesis = await pinnedGenesis(configDir, space);
	if (genesis === undefined) {
		throw new Error(
			`This device trusts no E2E chain for ${space}: an admin runs kantel e2e init, or gives you kantel e2e join ${space} <genesis>`,
		);
	}
	const { entries } = await client.getE2EChain(space);
	if (entries.length === 0) throw new Error(`The gateway has no chain for ${space}`);
	const state = await verifyChain(entries, genesis);
	await checkpoint(configDir, state);
	return { entries, state };
}

/** Signs `body` with this device after `chain`'s head and adds it. */
export async function appendEntry(
	client: KantelClient,
	configDir: string,
	device: Device,
	chain: VerifiedChain,
	body: EntryBody,
	now: number = Date.now(),
): Promise<VerifiedChain> {
	const entry = await signEntry(
		chain.state,
		chain.state.space,
		body,
		{ id: device.id, signer: device.identity.signer },
		Math.max(now, chain.state.at),
	);
	const { entries } = await client.appendE2EChain(chain.state.space, {
		from: chain.state.seq + 1,
		entries: [entry],
	});
	const state = await verifyChain(entries, chain.state.genesis);
	// The answer must hold this very entry where it was added: a chain without it (the one from before, or another
	// entry in its place) verifies too, and taking it would report a removal that never happened.
	if (state.hashes[chain.state.seq + 1] !== (await entryHash(entry))) {
		throw new Error(
			`The gateway's answer for ${chain.state.space} doesn't hold this change: it may not have been made (kantel e2e status shows the chain)`,
		);
	}
	await checkpoint(configDir, state);
	return { entries, state };
}

/** A genesis this device signed and is publishing: kept until it is pinned, so an interrupted init can finish. */
interface PendingGenesis {
	readonly entry: ChainEntry;
	readonly mode: "on" | "strict";
	readonly user: string;
}

/** What the gateway answers before it changes anything: it didn't publish what it refused so. */
const DEFINITE_REFUSALS = new Set([400, 401, 403, 404, 422]);

/**
 * Starts `space`'s chain with this device as its admin, and pins it.
 *
 * The signed genesis is kept (`e2e/pending/<space>.json`) before it is published, and stays until it is pinned, until
 * another chain is found there, or until the gateway refuses it outright. It is never replaced: an init whose answer
 * was lost, or one still running, may yet publish it. A retry publishes the same genesis again, and one asking for
 * another mode or person is refused until that one is finished.
 */
export async function initChain(
	client: KantelClient,
	configDir: string,
	device: Device,
	space: string,
	user: string,
	mode: "on" | "strict",
): Promise<VerifiedChain> {
	const trusted = await pinnedGenesis(configDir, space);
	if (trusted !== undefined) {
		throw new Error(
			`This device trusts ${space}'s chain already (genesis ${short(trusted)}): kantel e2e status shows it, and kantel e2e mode changes its mode`,
		);
	}
	const path = pendingPath(configDir, space);
	const taken = `${space} already has a chain, which this device didn't start: an admin gives you its genesis for kantel e2e join`;
	// Kept before it is published, so a lost answer can't leave the space with a chain this device didn't pin.
	const { genesis, published } = await withFileLock(path, async () => {
		const pending = await readJson<PendingGenesis>(path);
		if (pending !== undefined) {
			const { entries } = await client.getE2EChain(space);
			const first = entries[0];
			if (first !== undefined && (await entryHash(first)) === (await entryHash(pending.entry))) {
				return { genesis: pending.entry, published: entries };
			}
			if (first !== undefined) {
				// It can't be published now: a space's first entry never changes.
				await rm(path, { force: true });
				throw new Error(taken);
			}
			// Not published yet, but it may still be: it is published again, as it is.
			if (pending.user !== user) {
				throw new Error(
					`An earlier kantel e2e init for ${space}, as ${pending.user}, may still be publishing its chain: sign in as them and run it again to finish it`,
				);
			}
			if (pending.mode !== mode) {
				throw new Error(
					`An earlier kantel e2e init for ${space}, E2E ${pending.mode}, may still be publishing its chain: finish it with kantel e2e init${pending.mode === "on" ? "" : ` --mode ${pending.mode}`}, then change it with kantel e2e mode ${mode}`,
				);
			}
			return { genesis: pending.entry, published: undefined };
		}
		const entry = await signEntry(
			undefined,
			space,
			{ type: "genesis", body: { mode, device: await chainDevice(device.identity, user, "cli", device.label) } },
			{ id: device.id, signer: device.identity.signer },
			Date.now(),
		);
		await writePrivate(path, { entry, mode, user } satisfies PendingGenesis);
		return { genesis: entry, published: undefined };
	});
	// The genesis is the one this device signed, whatever chain the gateway answers with.
	const pin = await entryHash(genesis);
	let entries: readonly ChainEntry[];
	try {
		entries = published ?? (await client.appendE2EChain(space, { from: 0, entries: [genesis] })).entries;
	} catch (error) {
		// Refused outright (not an admin, say): nothing was published, nor will be by another try of the same.
		if (error instanceof KantelApiError && DEFINITE_REFUSALS.has(error.status)) {
			await forgetPending(path, pin);
			throw error;
		}
		// Lost, or a conflict: it may have been added before the answer was lost, or another chain got there first.
		const existing = (await client.getE2EChain(space)).entries;
		const first = existing[0];
		if (first === undefined) throw error;
		if ((await entryHash(first)) !== pin) {
			await forgetPending(path, pin);
			throw new Error(taken);
		}
		entries = existing;
	}
	const state = await verifyChain(entries, pin);
	await pinGenesis(configDir, space, pin);
	await checkpoint(configDir, state);
	await forgetPending(path, pin);
	return { entries, state };
}

/** Removes the pending genesis if it is still `pin`'s (under its lock). */
async function forgetPending(path: string, pin: string): Promise<void> {
	await withFileLock(path, async () => {
		const pending = await readJson<PendingGenesis>(path);
		if (pending !== undefined && (await entryHash(pending.entry)) === pin) await rm(path, { force: true });
	});
}

/** What `kantel e2e host-ticket` prints: the host's join command, with a ticket good for `minutes`. */
export async function hostTicket(device: Device, chain: VerifiedChain, name: string, minutes: number): Promise<string> {
	const join = await createHostTicket(
		chain.state,
		{ id: device.id, signer: device.identity.signer },
		name,
		Date.now() + minutes * 60_000,
	);
	return encodeJoinTicket(join);
}

/** A WebSocket as a session's channel, shared with the hosted console's browser device. */
export { webSocketChannel };

export interface OpenedE2E extends OpenedSession {
	readonly space: string;
	readonly hostId: string;
}

/**
 * A session to the host `sandboxId` is on: the gateway answers where (`openE2E`), the chain says who the host is, and
 * the session proves it. `connect` is for tests; default a WebSocket to the URL.
 */
export async function openE2ESession(
	client: KantelClient,
	configDir: string,
	sandboxId: string,
	op: SessionOp,
	port?: number,
	connect: (url: string) => Promise<ByteChannel> = webSocketChannel,
): Promise<OpenedE2E> {
	const device = await loadDevice(configDir);
	const access = await client.openE2E(sandboxId, {});
	const chain = await verifiedChain(client, configDir, access.accountId);
	if (!chain.state.hosts.has(access.hostId)) {
		throw new Error(
			`The sandbox is on host ${access.hostId}, which isn't in ${access.accountId}'s chain: an admin enrols it with kantel e2e host-ticket`,
		);
	}
	const session = await openSession({
		channel: await connect(access.url),
		static: device.identity.static,
		state: chain.state,
		entries: chain.entries,
		hostId: access.hostId,
		sandbox: sandboxId,
		op,
		...(port === undefined ? {} : { port }),
	});
	return { ...session, space: access.accountId, hostId: access.hostId };
}
