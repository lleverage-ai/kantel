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
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "@kantel/e2e/bytes";
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

/** A lock older than this was left by a process that died holding it: what it guards takes milliseconds. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/**
 * Runs `act` holding `<path>.lock`, which every kantel sharing the config directory takes before it changes `path`
 * (or decides from it what to change): an exclusively created file, since Node has no flock. A lock left by a process
 * that died is broken once it is stale; it is moved aside first and checked again, so a fresh one is never broken.
 */
export async function withFileLock<T>(path: string, act: () => Promise<T>): Promise<T> {
	const lock = `${path}.lock`;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
		try {
			const handle = await open(lock, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`);
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (await breakStale(lock)) continue;
		if (Date.now() > deadline) {
			throw new Error(`Another kantel is changing ${path}: try again, or remove ${lock} if none is running`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, wait));
	}
	try {
		return await act();
	} finally {
		await rm(lock, { force: true });
	}
}

async function breakStale(lock: string): Promise<boolean> {
	const held = await stat(lock).catch(() => undefined);
	if (held === undefined) return true;
	if (Date.now() - held.mtimeMs <= STALE_LOCK_MS) return false;
	const aside = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}.stale`;
	try {
		await rename(lock, aside);
	} catch {
		return true;
	}
	const moved = await stat(aside).catch(() => undefined);
	if (moved !== undefined && Date.now() - moved.mtimeMs <= STALE_LOCK_MS) {
		// Another process broke the stale lock and took a fresh one in between: that one goes back.
		await rename(aside, lock).catch(() => undefined);
		return false;
	}
	await rm(aside, { force: true });
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
			await writePrivate(path, fresh);
			return fresh;
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

export async function parseCard(word: string): Promise<ChainDevice> {
	let value: Partial<ChainDevice>;
	try {
		value = JSON.parse(fromUtf8(fromBase64url(word.trim()))) as Partial<ChainDevice>;
	} catch {
		throw new Error("That isn't a device card: ask for what `kantel e2e device` prints");
	}
	const { id, user, sign, dh, label } = value;
	const deviceClass = value.class;
	if (
		typeof id !== "string" ||
		typeof user !== "string" ||
		typeof sign !== "string" ||
		typeof dh !== "string" ||
		typeof label !== "string" ||
		(deviceClass !== "cli" && deviceClass !== "web" && deviceClass !== "machine")
	) {
		throw new Error("That device card is missing a field");
	}
	if (id !== (await keyId("kd", fromBase64url(sign)))) throw new Error("The card's device ID isn't its key's");
	return { id, user, sign, dh, class: deviceClass, label };
}

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

/** Starts `space`'s chain with this device as its admin, and pins it. */
export async function initChain(
	client: KantelClient,
	configDir: string,
	device: Device,
	space: string,
	user: string,
	mode: "on" | "strict",
): Promise<VerifiedChain> {
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
				await rm(path, { force: true });
				throw new Error(taken);
			}
			// Never published: it is used again if it asked for the same, so a retry can't race its own first try.
			if (pending.mode === mode && pending.user === user) return { genesis: pending.entry, published: undefined };
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
		// Refused outright (not an admin, say): nothing was published.
		const refused = error instanceof KantelApiError && error.status < 500 && error.code !== "conflict";
		if (refused) {
			await rm(path, { force: true });
			throw error;
		}
		// Lost, or a conflict: it may have been added before the answer was lost, or another chain got there first.
		const existing = (await client.getE2EChain(space)).entries;
		const first = existing[0];
		if (first === undefined) throw error;
		if ((await entryHash(first)) !== pin) {
			await rm(path, { force: true });
			throw new Error(taken);
		}
		entries = existing;
	}
	const state = await verifyChain(entries, pin);
	await pinGenesis(configDir, space, pin);
	await checkpoint(configDir, state);
	await rm(path, { force: true });
	return { entries, state };
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

/** A WebSocket as a session's channel: the relay's binary frames, which needn't line up with records. */
export function webSocketChannel(url: string): Promise<ByteChannel> {
	return new Promise((resolveChannel, reject) => {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		let listener: ((bytes: Uint8Array) => void) | undefined;
		const pending: Uint8Array[] = [];
		const closeListeners: ((reason: string) => void)[] = [];
		let opened = false;
		socket.onopen = () => {
			opened = true;
			resolveChannel({
				send: (bytes) => socket.send(bytes),
				onData: (next) => {
					listener = next;
					for (const bytes of pending.splice(0)) next(bytes);
				},
				onClose: (next) => closeListeners.push(next),
				close: () => socket.close(1000, "closed by the device"),
			});
		};
		socket.onmessage = (event) => {
			const data = event.data;
			const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : utf8(String(data));
			if (listener === undefined) pending.push(bytes);
			else listener(bytes);
		};
		socket.onerror = () => {
			if (!opened) reject(new Error("Couldn't reach the host through the relay"));
		};
		socket.onclose = (event) => {
			if (!opened) reject(new Error(`The relay refused the session: ${event.reason || `code ${event.code}`}`));
			for (const close of closeListeners) close(event.reason || `code ${event.code}`);
		};
	});
}

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
