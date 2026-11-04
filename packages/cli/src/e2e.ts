/**
 * `kantel e2e`: this device's keys, the organisation's signed chain, and sessions to hosts the gateway relays but
 * can't read (`@kantel/e2e`).
 *
 * The device's seeds are in `<config>/e2e/device.json` (0600) and never leave it. What this device trusts is the
 * genesis it pinned in `<config>/e2e/spaces/<space>.json`: the one it made (`init`), or one an admin gave it out of
 * band (`join`). Every chain the gateway answers is verified from that genesis before it is used, so a key the gateway
 * adds, or a chain it makes up, is refused here as it is on the host.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KantelClient } from "@kantel/api/sdk";
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "@kantel/e2e/bytes";
import {
	type ChainDevice,
	type ChainEntry,
	chainDevice,
	createHostTicket,
	type DeviceClass,
	type EntryBody,
	encodeJoinTicket,
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

async function writePrivate(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** This device's keys, made the first time (with `label`) and kept. */
export async function loadDevice(configDir: string, label?: string): Promise<Device> {
	let file = await readJson<DeviceFile>(devicePath(configDir));
	if (file === undefined) {
		file = {
			v: 1,
			seeds: { sign: toBase64url(randomSeed()), dh: toBase64url(randomSeed()) },
			label: label ?? "kantel",
		};
		await writePrivate(devicePath(configDir), file);
	}
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

/** The genesis this device trusts for `space`, if it has one. */
export async function pinnedGenesis(configDir: string, space: string): Promise<string | undefined> {
	return (await readJson<{ genesis: string }>(spacePath(configDir, space)))?.genesis;
}

export async function pinGenesis(configDir: string, space: string, genesis: string): Promise<void> {
	const pinned = await pinnedGenesis(configDir, space);
	if (pinned !== undefined && pinned !== genesis) {
		throw new Error(`This device already trusts another chain for ${space} (${short(pinned)})`);
	}
	await writePrivate(spacePath(configDir, space), { genesis });
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
	return { entries, state: await verifyChain(entries, genesis) };
}

/** Signs `body` with this device after `chain`'s head and adds it. */
export async function appendEntry(
	client: KantelClient,
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
	return { entries, state: await verifyChain(entries, chain.state.genesis) };
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
	const genesis = await signEntry(
		undefined,
		space,
		{ type: "genesis", body: { mode, device: await chainDevice(device.identity, user, "cli", device.label) } },
		{ id: device.id, signer: device.identity.signer },
		Date.now(),
	);
	const { entries } = await client.appendE2EChain(space, { from: 0, entries: [genesis] });
	const state = await verifyChain(entries);
	await pinGenesis(configDir, space, state.genesis);
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
