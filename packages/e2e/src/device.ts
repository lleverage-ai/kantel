/**
 * A device's side of E2E, wherever it keeps its keys and trust: the genesis it trusts for each space and the newest
 * chain it verified there (a `TrustStore`: the CLI's files, the hosted console's IndexedDB), the card an admin adds it
 * with, and a call on a sandbox's host over a session.
 *
 * Nothing the gateway answers is trusted as such: its chain is verified from the genesis this device pinned, and must
 * carry on from the newest one it verified before (else an older chain could bring back a removed device or host);
 * the session then proves the host's key against it, as the host checks this device's.
 */
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "./bytes.ts";
import {
	type ChainDevice,
	type ChainEntry,
	chainDevice,
	type DeviceClass,
	deviceAllowed,
	deviceByDh,
	type SpaceState,
	verifyChain,
} from "./chain.ts";
import { type DeviceKeys, fingerprint, keyId } from "./keys.ts";
import { type ByteChannel, openSession, SessionClient } from "./session.ts";

/** What a device keeps of a space: the genesis it trusts, and the newest entry of it that it verified. */
export interface SpaceTrust {
	readonly genesis: string;
	readonly seq?: number;
	readonly head?: string;
}

export interface TrustStore {
	read(space: string): Promise<SpaceTrust | undefined>;
	write(space: string, trust: SpaceTrust): Promise<void>;
}

/** Why a device can't use a space's chain: none pinned, the gateway's goes back on it, or the device isn't let in. */
export type TrustProblem = "unpinned" | "rollback" | "not_in_chain" | "refused";

export class DeviceTrustError extends Error {
	readonly problem: TrustProblem;
	constructor(problem: TrustProblem, message: string) {
		super(message);
		this.name = "DeviceTrustError";
		this.problem = problem;
	}
}

/** An entry's hash as the chain gives it: base64url of SHA-256. */
const HASH = /^[A-Za-z0-9_-]{43}$/;

/** Trusts `genesis` for `space`; refused if this device trusts another already. */
export async function pinGenesis(store: TrustStore, space: string, genesis: string): Promise<void> {
	const given = genesis.trim();
	if (!HASH.test(given))
		throw new Error("That isn't a chain's genesis: ask an admin for what kantel e2e status prints");
	const pinned = await store.read(space);
	if (pinned !== undefined && pinned.genesis !== given) {
		throw new Error(`This device already trusts another chain for ${space} (${pinned.genesis.slice(0, 16)})`);
	}
	if (pinned === undefined) await store.write(space, { genesis: given });
}

/**
 * The gateway's `entries` for `space`, verified from the genesis this device pinned and taken only if they carry on
 * from the newest chain it verified before, which they then replace.
 */
export async function trustedChain(
	store: TrustStore,
	space: string,
	entries: readonly ChainEntry[],
): Promise<SpaceState> {
	const trust = await store.read(space);
	if (trust === undefined) {
		throw new DeviceTrustError(
			"unpinned",
			`This device trusts no E2E chain for ${space}: an admin gives you its genesis (kantel e2e status)`,
		);
	}
	if (entries.length === 0) throw new Error(`The gateway has no chain for ${space}`);
	const state = await verifyChain(entries, trust.genesis);
	if (state.space !== space) throw new Error(`The gateway's chain for ${space} is another space's`);
	if (trust.seq !== undefined && trust.head !== undefined) {
		if (state.seq < trust.seq || state.hashes[trust.seq] !== trust.head) {
			throw new DeviceTrustError(
				"rollback",
				`The gateway's chain for ${space} goes back on what this device verified before (seq ${trust.seq}): it isn't used`,
			);
		}
	}
	if (trust.seq !== state.seq || trust.head !== state.head) {
		await store.write(space, { genesis: trust.genesis, seq: state.seq, head: state.head });
	}
	return state;
}

/** Whether this device may open sessions in `state`'s space, and why not. */
export function deviceStanding(
	state: SpaceState,
	keys: DeviceKeys,
):
	| { readonly ok: true; readonly device: ChainDevice }
	| { readonly ok: false; readonly problem: TrustProblem; readonly reason: string } {
	const device = deviceByDh(state, toBase64url(keys.static.publicKey));
	if (device === undefined || device.sign !== toBase64url(keys.signer.publicKey)) {
		return { ok: false, problem: "not_in_chain", reason: "This device isn't in the space's chain" };
	}
	const allowed = deviceAllowed(state, device.id);
	if (!allowed.ok) return { ok: false, problem: "refused", reason: allowed.reason };
	return { ok: true, device };
}

/** What `kantel e2e device` (or the hosted console) shows for an admin to add: the device as the chain lists it. */
export async function deviceCard(
	keys: DeviceKeys,
	user: string,
	deviceClass: DeviceClass,
	label: string,
): Promise<string> {
	return toBase64url(utf8(JSON.stringify(await chainDevice(keys, user, deviceClass, label))));
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

/** The fingerprint a person reads out to the admin adding their device. */
export function keysFingerprint(keys: DeviceKeys): Promise<string> {
	return fingerprint(keys.signer.publicKey, keys.static.publicKey);
}

/** The gateway as a device needs it: where a sandbox's session opens, and a space's chain (both untrusted). */
export interface DeviceGateway {
	openE2E(sandboxId: string): Promise<{ readonly url: string; readonly hostId: string; readonly accountId: string }>;
	getE2EChain(space: string): Promise<{ readonly entries: readonly ChainEntry[] }>;
}

export interface HostCallOptions {
	readonly gateway: DeviceGateway;
	readonly trust: TrustStore;
	readonly keys: DeviceKeys;
	readonly sandboxId: string;
	readonly method: string;
	readonly params?: object;
	/** The relay's WebSocket (default); tests give another channel. */
	readonly connect?: (url: string) => Promise<ByteChannel>;
}

/** Runs `method` on the host of `sandboxId` over an `rpc` session, after checking the chain lets this device in. */
export async function callHost<T>(options: HostCallOptions): Promise<T> {
	const access = await options.gateway.openE2E(options.sandboxId);
	const { entries } = await options.gateway.getE2EChain(access.accountId);
	const state = await trustedChain(options.trust, access.accountId, entries);
	const standing = deviceStanding(state, options.keys);
	if (!standing.ok) throw new DeviceTrustError(standing.problem, standing.reason);
	if (!state.hosts.has(access.hostId)) {
		throw new Error(`The sandbox is on host ${access.hostId}, which isn't in ${access.accountId}'s chain`);
	}
	const session = await openSession({
		channel: await (options.connect ?? webSocketChannel)(access.url),
		static: options.keys.static,
		state,
		entries,
		hostId: access.hostId,
		sandbox: options.sandboxId,
		op: "rpc",
	});
	const client = new SessionClient(session);
	try {
		return await client.call<T>(options.method, options.params ?? {});
	} finally {
		client.close();
	}
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
				// A copy: a DOM WebSocket takes only bytes over a plain ArrayBuffer.
				send: (bytes) => socket.send(new Uint8Array(bytes)),
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
