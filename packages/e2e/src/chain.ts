/**
 * The space chain: an append-only log, one per space (a personal account or an organisation), that says which people
 * are members, which devices and hosts hold the space's keys, and whether the space is end-to-end encrypted. Each entry
 * names the hash of the entry before it and is signed by a device the chain already lists (or, for a host, by the
 * one-off key in its join ticket). Hosts and devices verify every entry from the genesis they pinned; the server only
 * stores and relays entries. It can withhold one, never forge one, so signing in to Kantel is never enough to add a key.
 * The Go verifier is apps/host/internal/e2e/chain.go; both pass vectors/chain.json.
 *
 * An entry on the wire: `{ "payload": base64url(JSON), "sig": base64url(Ed25519) }`. The signature covers
 * `kantel-chain/1\n` and the payload's exact bytes, so nothing is canonicalised: the bytes signed are the bytes stored.
 * The payload: `{ v: 1, space, seq, prev, at, by, type, body }`, with exactly those keys (`prev` is absent on the
 * genesis, `at` is epoch milliseconds), and its entry's hash is base64url(SHA-256(payload ‖ sig)).
 *
 * Who may sign what:
 *
 *   genesis         seq 0, by the first device, which it lists; its person becomes the first admin (trust on first use)
 *   member.add      an admin's device: a person joins, or a member's role changes
 *   member.remove   an admin's device: the person and every device of theirs leave
 *   device.add      a device of the same person, or an admin's; the person must be a member
 *   device.remove   a device of the same person, or an admin's
 *   host.add        the join ticket's key, where the ticket was signed by an admin's device for this space and name
 *   host.remove     an admin's device
 *   mode            an admin's device: `off`, `on` (E2E; the hosted console allowed as a `web` device) or `strict`
 *
 * After every entry at least one admin must still have a device, so the chain can always move on.
 */
import { concat, equalBytes, fromBase64url, fromUtf8, sha256, toBase64url, utf8 } from "./bytes.ts";
import { type Identity, KEY_BYTES, keyId, randomSeed, type Signer, signerFromSeed, verifySignature } from "./keys.ts";

export const CHAIN_VERSION = 1;

export type MemberRole = "admin" | "member";
/** `cli`: a CLI install; `web`: a browser whose code the gateway served (the hosted console); `machine`: an agent. */
export type DeviceClass = "cli" | "web" | "machine";
/** `on` lets `web` devices in; `strict` refuses them. */
export type SpaceMode = "off" | "on" | "strict";

export interface ChainDevice {
	/** `kd_…`, from its signing key (`keyId`). */
	readonly id: string;
	/** The person it belongs to: their user ID on the server. */
	readonly user: string;
	/** Base64url of its Ed25519 public key. */
	readonly sign: string;
	/** Base64url of its X25519 public key: the key it opens Noise sessions with. */
	readonly dh: string;
	readonly class: DeviceClass;
	/** For people to tell their devices apart, such as `kantel on laptop`. */
	readonly label: string;
}

export interface ChainHost {
	/** The host's ID on the server, which the relay routes by. */
	readonly id: string;
	readonly name: string;
	readonly sign: string;
	readonly dh: string;
}

/** A join ticket's signed part. */
export interface TicketPayload {
	readonly v: number;
	readonly type: "host.ticket";
	readonly space: string;
	/** The genesis entry's hash, which the host pins. */
	readonly genesis: string;
	readonly name: string;
	/** Base64url of the ticket's one-off Ed25519 public key. */
	readonly key: string;
	/** Epoch milliseconds. */
	readonly exp: number;
	/** The admin's device that signed it. */
	readonly by: string;
}

export interface SignedBlob {
	readonly payload: string;
	readonly sig: string;
}

export type EntryBody =
	| { readonly type: "genesis"; readonly body: { readonly mode: SpaceMode; readonly device: ChainDevice } }
	| { readonly type: "member.add"; readonly body: { readonly user: string; readonly role: MemberRole } }
	| { readonly type: "member.remove"; readonly body: { readonly user: string } }
	| { readonly type: "device.add"; readonly body: { readonly device: ChainDevice } }
	| { readonly type: "device.remove"; readonly body: { readonly id: string } }
	| { readonly type: "host.add"; readonly body: { readonly host: ChainHost; readonly ticket: SignedBlob } }
	| { readonly type: "host.remove"; readonly body: { readonly id: string } }
	| { readonly type: "mode"; readonly body: { readonly mode: SpaceMode } };

export type EntryType = EntryBody["type"];

export type EntryPayload = EntryBody & {
	readonly v: number;
	readonly space: string;
	readonly seq: number;
	readonly prev?: string;
	readonly at: number;
	/** The signing device's ID, or `ticket` on a `host.add`. */
	readonly by: string;
};

/** An entry as stored and sent. */
export type ChainEntry = SignedBlob;

/** What a verified chain says now. */
export interface SpaceState {
	readonly space: string;
	/** The genesis entry's hash: what a host or device pins. */
	readonly genesis: string;
	/** The newest entry's hash and seq. */
	readonly head: string;
	readonly seq: number;
	readonly mode: SpaceMode;
	/**
	 * The hash of the entry from which E2E has been on (or strict) without a break: the genesis, or the mode entry that
	 * last turned it on; "" while it is off. Hosts trust only sandboxes they made under the current one.
	 */
	readonly onSince: string;
	readonly members: ReadonlyMap<string, MemberRole>;
	/** Devices that are in, by ID. */
	readonly devices: ReadonlyMap<string, ChainDevice>;
	/** Hosts that are in, by their ID. */
	readonly hosts: ReadonlyMap<string, ChainHost>;
	/** Every device ID, signing key and Noise key ever added, and every ticket key ever spent: none comes back. */
	readonly spent: ReadonlySet<string>;
	/** Each entry's hash, by seq, so a fork of an earlier entry is seen. */
	readonly hashes: readonly string[];
	/** The newest entry's time, for a ticket's expiry. */
	readonly at: number;
}

/** An entry that doesn't verify, and where. */
export class ChainError extends Error {
	readonly seq: number;
	constructor(seq: number, message: string) {
		super(`Space chain entry ${seq}: ${message}`);
		this.name = "ChainError";
		this.seq = seq;
	}
}

const ENTRY_CONTEXT = utf8("kantel-chain/1\n");
const TICKET_CONTEXT = utf8("kantel-ticket/1\n");

/** IDs and names in the chain: what a server would hand out, and nothing that reads two ways. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const DEVICE_ID = /^kd_[0-9a-f]{32}$/;
const MAX_LABEL = 100;
const MODES: readonly SpaceMode[] = ["off", "on", "strict"];
const ROLES: readonly MemberRole[] = ["admin", "member"];
const CLASSES: readonly DeviceClass[] = ["cli", "web", "machine"];

type Json = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The object's fields, which must be exactly `required` and any of `optional`. */
function fields(value: unknown, what: string, required: readonly string[], optional: readonly string[] = []): Json {
	if (!isObject(value)) throw new Error(`${what} is not an object`);
	for (const key of required) if (!(key in value)) throw new Error(`${what} has no ${key}`);
	for (const key of Object.keys(value)) {
		if (!required.includes(key) && !optional.includes(key)) throw new Error(`${what} has an unknown field ${key}`);
	}
	return value;
}

const str = (value: unknown, what: string): string => {
	if (typeof value !== "string") throw new Error(`${what} is not a string`);
	return value;
};
const id = (value: unknown, what: string): string => {
	const text = str(value, what);
	if (!ID.test(text)) throw new Error(`${what} is not a valid ID`);
	return text;
};
const int = (value: unknown, what: string): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${what} is not a whole number`);
	}
	return value;
};
const key32 = (value: unknown, what: string): string => {
	const text = str(value, what);
	let bytes: Uint8Array;
	try {
		bytes = fromBase64url(text);
	} catch {
		throw new Error(`${what} is not base64url`);
	}
	if (bytes.byteLength !== KEY_BYTES) throw new Error(`${what} is not a 32-byte key`);
	return text;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T => {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${what} is not one of ${allowed}`);
	return value as T;
};

function parseDevice(value: unknown): ChainDevice {
	const d = fields(value, "device", ["id", "user", "sign", "dh", "class", "label"]);
	const label = str(d.label, "device.label");
	if (label.length > MAX_LABEL) throw new Error("device.label is too long");
	const deviceId = str(d.id, "device.id");
	if (!DEVICE_ID.test(deviceId)) throw new Error("device.id is not a device ID");
	return {
		id: deviceId,
		user: id(d.user, "device.user"),
		sign: key32(d.sign, "device.sign"),
		dh: key32(d.dh, "device.dh"),
		class: oneOf(d.class, CLASSES, "device.class"),
		label,
	};
}

function parseHost(value: unknown): ChainHost {
	const h = fields(value, "host", ["id", "name", "sign", "dh"]);
	const name = str(h.name, "host.name");
	if (name.length > MAX_LABEL) throw new Error("host.name is too long");
	return { id: id(h.id, "host.id"), name, sign: key32(h.sign, "host.sign"), dh: key32(h.dh, "host.dh") };
}

function parseBlob(value: unknown, what: string): SignedBlob {
	const b = fields(value, what, ["payload", "sig"]);
	return { payload: str(b.payload, `${what}.payload`), sig: str(b.sig, `${what}.sig`) };
}

function parseBody(type: EntryType, body: unknown): EntryBody {
	switch (type) {
		case "genesis": {
			const b = fields(body, "body", ["mode", "device"]);
			return { type, body: { mode: oneOf(b.mode, MODES, "mode"), device: parseDevice(b.device) } };
		}
		case "member.add": {
			const b = fields(body, "body", ["user", "role"]);
			return { type, body: { user: id(b.user, "user"), role: oneOf(b.role, ROLES, "role") } };
		}
		case "member.remove": {
			const b = fields(body, "body", ["user"]);
			return { type, body: { user: id(b.user, "user") } };
		}
		case "device.add": {
			const b = fields(body, "body", ["device"]);
			return { type, body: { device: parseDevice(b.device) } };
		}
		case "device.remove":
		case "host.remove": {
			const b = fields(body, "body", ["id"]);
			return { type, body: { id: id(b.id, "id") } } as EntryBody;
		}
		case "host.add": {
			const b = fields(body, "body", ["host", "ticket"]);
			return { type, body: { host: parseHost(b.host), ticket: parseBlob(b.ticket, "ticket") } };
		}
		case "mode": {
			const b = fields(body, "body", ["mode"]);
			return { type, body: { mode: oneOf(b.mode, MODES, "mode") } };
		}
	}
}

const TYPES: readonly EntryType[] = [
	"genesis",
	"member.add",
	"member.remove",
	"device.add",
	"device.remove",
	"host.add",
	"host.remove",
	"mode",
];

function decodeJson(payload: string, what: string): { bytes: Uint8Array; value: unknown } {
	let bytes: Uint8Array;
	try {
		bytes = fromBase64url(payload);
	} catch {
		throw new Error(`${what} is not base64url`);
	}
	let value: unknown;
	try {
		value = JSON.parse(fromUtf8(bytes));
	} catch {
		throw new Error(`${what} is not JSON`);
	}
	return { bytes, value };
}

/** An entry's payload, read and checked for shape (not yet for its place in the chain or its signature). */
export function parseEntry(entry: ChainEntry): { readonly payload: EntryPayload; readonly bytes: Uint8Array } {
	const blob = parseBlob(entry, "entry");
	const { bytes, value } = decodeJson(blob.payload, "The payload");
	const p = fields(value, "The payload", ["v", "space", "seq", "at", "by", "type", "body"], ["prev"]);
	if (p.v !== CHAIN_VERSION) throw new Error(`The payload is version ${String(p.v)}, not ${CHAIN_VERSION}`);
	const type = oneOf(p.type, TYPES, "type");
	const seq = int(p.seq, "seq");
	const prev = p.prev === undefined ? undefined : str(p.prev, "prev");
	const by = type === "host.add" ? (p.by === "ticket" ? "ticket" : "") : str(p.by, "by");
	if (by === "") throw new Error("A host.add is signed by its ticket");
	return {
		payload: {
			v: CHAIN_VERSION,
			space: id(p.space, "space"),
			seq,
			...(prev === undefined ? {} : { prev }),
			at: int(p.at, "at"),
			by,
			...parseBody(type, p.body),
		} as EntryPayload,
		bytes,
	};
}

/** An entry's hash: base64url(SHA-256(payload ‖ sig)). */
export async function entryHash(entry: ChainEntry): Promise<string> {
	return toBase64url(await sha256(concat(fromBase64url(entry.payload), fromBase64url(entry.sig))));
}

function parseTicket(ticket: SignedBlob): { readonly payload: TicketPayload; readonly bytes: Uint8Array } {
	const { bytes, value } = decodeJson(ticket.payload, "The ticket");
	const t = fields(value, "The ticket", ["v", "type", "space", "genesis", "name", "key", "exp", "by"]);
	if (t.v !== CHAIN_VERSION) throw new Error("The ticket is another version");
	if (t.type !== "host.ticket") throw new Error("The ticket is not a host ticket");
	const name = str(t.name, "ticket.name");
	if (name.length > MAX_LABEL) throw new Error("ticket.name is too long");
	return {
		payload: {
			v: CHAIN_VERSION,
			type: "host.ticket",
			space: id(t.space, "ticket.space"),
			genesis: str(t.genesis, "ticket.genesis"),
			name,
			key: key32(t.key, "ticket.key"),
			exp: int(t.exp, "ticket.exp"),
			by: str(t.by, "ticket.by"),
		},
		bytes,
	};
}

const signedBytes = (context: Uint8Array, bytes: Uint8Array) => concat(context, bytes);

function sigOf(blob: SignedBlob, what: string): Uint8Array {
	try {
		return fromBase64url(blob.sig);
	} catch {
		throw new Error(`${what}'s signature is not base64url`);
	}
}

interface MutableState {
	space: string;
	genesis: string;
	head: string;
	seq: number;
	mode: SpaceMode;
	onSince: string;
	members: Map<string, MemberRole>;
	devices: Map<string, ChainDevice>;
	hosts: Map<string, ChainHost>;
	spent: Set<string>;
	hashes: string[];
	at: number;
}

const copy = (state: SpaceState): MutableState => ({
	space: state.space,
	genesis: state.genesis,
	head: state.head,
	seq: state.seq,
	mode: state.mode,
	onSince: state.onSince,
	members: new Map(state.members),
	devices: new Map(state.devices),
	hosts: new Map(state.hosts),
	spent: new Set(state.spent),
	hashes: [...state.hashes],
	at: state.at,
});

const isAdminDevice = (state: MutableState, deviceId: string): boolean => {
	const device = state.devices.get(deviceId);
	return device !== undefined && state.members.get(device.user) === "admin";
};

function spendDevice(state: MutableState, device: ChainDevice): void {
	for (const key of [`device:${device.id}`, `key:${device.sign}`, `key:${device.dh}`]) {
		if (state.spent.has(key)) throw new Error(`device ${device.id} or one of its keys was in the chain before`);
		state.spent.add(key);
	}
}

/** Applies one entry, which must come next. Throws (a plain Error; `extendChain` adds where) unless it verifies. */
async function apply(state: MutableState | undefined, entry: ChainEntry, pin?: string): Promise<MutableState> {
	const { payload, bytes } = parseEntry(entry);
	const sig = sigOf(entry, "The entry");
	const hash = await entryHash(entry);
	if (state === undefined) {
		if (payload.type !== "genesis") throw new Error("The chain must start with a genesis");
		if (payload.seq !== 0 || payload.prev !== undefined) throw new Error("The genesis is seq 0 with no prev");
		if (pin !== undefined && hash !== pin) throw new Error("This isn't the genesis this device or host pinned");
		const device = payload.body.device;
		if (payload.by !== device.id) throw new Error("The genesis is signed by the device it lists");
		if (device.id !== (await keyId("kd", fromBase64url(device.sign)))) throw new Error("device.id isn't its key's");
		if (!(await verifySignature(fromBase64url(device.sign), signedBytes(ENTRY_CONTEXT, bytes), sig))) {
			throw new Error("The genesis's signature is wrong");
		}
		const next: MutableState = {
			space: payload.space,
			genesis: hash,
			head: hash,
			seq: 0,
			mode: payload.body.mode,
			onSince: payload.body.mode === "off" ? "" : hash,
			members: new Map([[device.user, "admin"]]),
			devices: new Map([[device.id, device]]),
			hosts: new Map(),
			spent: new Set(),
			hashes: [hash],
			at: payload.at,
		};
		spendDevice(next, device);
		if (!adminCanSign(next)) throw new Error("No admin would have a device left that may sign in this mode");
		return next;
	}
	if (payload.space !== state.space) throw new Error("The entry is for another space");
	if (payload.seq !== state.seq + 1) throw new Error(`The entry is seq ${payload.seq}, not ${state.seq + 1}`);
	if (payload.prev !== state.head) throw new Error("The entry doesn't follow the chain's head");
	if (payload.type === "genesis") throw new Error("A second genesis");
	const next = copy(state);

	if (payload.type === "host.add") {
		const { host, ticket } = payload.body;
		const parsed = parseTicket(ticket);
		const t = parsed.payload;
		if (t.space !== state.space || t.genesis !== state.genesis) throw new Error("The ticket is for another space");
		if (!isAdminDevice(next, t.by)) throw new Error("The ticket wasn't signed by an admin's device");
		const admin = next.devices.get(t.by);
		if (state.mode === "strict" && admin?.class === "web") {
			throw new Error("This space is strict: a web device's ticket isn't taken");
		}
		if (
			admin === undefined ||
			!(await verifySignature(
				fromBase64url(admin.sign),
				signedBytes(TICKET_CONTEXT, parsed.bytes),
				sigOf(ticket, "The ticket"),
			))
		) {
			throw new Error("The ticket's signature is wrong");
		}
		if (payload.at > t.exp) throw new Error("The ticket had expired");
		if (host.name !== t.name) throw new Error("The host's name isn't the ticket's");
		if (next.spent.has(`ticket:${t.key}`)) throw new Error("The ticket was used before");
		if (!(await verifySignature(fromBase64url(t.key), signedBytes(ENTRY_CONTEXT, bytes), sig))) {
			throw new Error("The host.add isn't signed by the ticket's key");
		}
		if (next.hosts.has(host.id)) throw new Error(`Host ${host.id} is in the chain already`);
		for (const key of [`ticket:${t.key}`, `key:${host.sign}`, `key:${host.dh}`]) {
			if (next.spent.has(key)) throw new Error("A key of this host was in the chain before");
			next.spent.add(key);
		}
		next.hosts.set(host.id, host);
	} else {
		const signer = next.devices.get(payload.by);
		if (signer === undefined) throw new Error(`The signer ${payload.by} isn't a device in the chain`);
		// In a strict space the hosted console can't open sessions, so it can't change the chain either: else its key
		// (served by the gateway's code) could add a CLI device of its own, or turn E2E off.
		if (state.mode === "strict" && signer.class === "web") {
			throw new Error("This space is strict: a web device's entries aren't taken");
		}
		if (!(await verifySignature(fromBase64url(signer.sign), signedBytes(ENTRY_CONTEXT, bytes), sig))) {
			throw new Error("The entry's signature is wrong");
		}
		const admin = next.members.get(signer.user) === "admin";
		const needAdmin = () => {
			if (!admin) throw new Error(`${payload.type} needs an admin's device`);
		};
		switch (payload.type) {
			case "member.add":
				needAdmin();
				next.members.set(payload.body.user, payload.body.role);
				break;
			case "member.remove": {
				needAdmin();
				const user = payload.body.user;
				if (!next.members.delete(user)) throw new Error(`${user} isn't a member`);
				for (const [deviceId, device] of next.devices) if (device.user === user) next.devices.delete(deviceId);
				break;
			}
			case "device.add": {
				const device = payload.body.device;
				if (!next.members.has(device.user)) throw new Error(`${device.user} isn't a member`);
				if (!admin && signer.user !== device.user) throw new Error("Only an admin adds another person's device");
				if (device.id !== (await keyId("kd", fromBase64url(device.sign)))) {
					throw new Error("device.id isn't its key's");
				}
				spendDevice(next, device);
				next.devices.set(device.id, device);
				break;
			}
			case "device.remove": {
				const device = next.devices.get(payload.body.id);
				if (device === undefined) throw new Error(`${payload.body.id} isn't a device in the chain`);
				if (!admin && signer.user !== device.user) throw new Error("Only an admin removes another person's device");
				next.devices.delete(device.id);
				break;
			}
			case "host.remove":
				needAdmin();
				if (!next.hosts.delete(payload.body.id)) throw new Error(`${payload.body.id} isn't a host in the chain`);
				break;
			case "mode":
				needAdmin();
				if (payload.body.mode === "off") next.onSince = "";
				else if (next.mode === "off") next.onSince = hash;
				next.mode = payload.body.mode;
				break;
		}
	}
	if (!adminCanSign(next)) {
		throw new Error("No admin would have a device left that may sign in this mode");
	}
	next.seq = payload.seq;
	next.head = hash;
	next.hashes.push(hash);
	next.at = payload.at;
	return next;
}

const freeze = (state: MutableState): SpaceState => state;

/**
 * The state after `entries`, from the genesis. With `pin`, the genesis must be the one pinned. Throws `ChainError` on
 * the first entry that doesn't verify.
 */
/**
 * Whether an admin keeps a device that may sign the chain's next entries: in a strict space a web device's entries
 * aren't taken, so one that only the hosted console could change could never be changed again.
 */
function adminCanSign(state: MutableState): boolean {
	return [...state.devices.values()].some(
		(device) => state.members.get(device.user) === "admin" && (state.mode !== "strict" || device.class !== "web"),
	);
}

export async function verifyChain(entries: readonly ChainEntry[], pin?: string): Promise<SpaceState> {
	if (entries.length === 0) throw new ChainError(0, "The chain is empty");
	let state: MutableState | undefined;
	for (const [seq, entry] of entries.entries()) {
		try {
			state = await apply(state, entry, pin);
		} catch (error) {
			throw new ChainError(seq, error instanceof Error ? error.message : String(error));
		}
	}
	return freeze(state as MutableState);
}

/**
 * `state` moved on by `entries`, which are the entries after some seq: those it already has must be the same ones
 * (else it is a fork, and it throws), and the rest must follow. An older chain than `state` is no change: a server that
 * holds an entry back can't take one away.
 */
export async function extendChain(
	state: SpaceState,
	entries: readonly ChainEntry[],
	from: number,
): Promise<SpaceState> {
	let next: MutableState = copy(state);
	for (const [index, entry] of entries.entries()) {
		const seq = from + index;
		if (seq <= next.seq) {
			if ((await entryHash(entry)) !== next.hashes[seq]) {
				throw new ChainError(seq, "This entry differs from the one already verified: a fork");
			}
			continue;
		}
		try {
			next = await apply(next, entry);
		} catch (error) {
			throw new ChainError(seq, error instanceof Error ? error.message : String(error));
		}
	}
	return freeze(next);
}

/** The entry `by` signs to put `entry` after `state` (or as the genesis, with no state). */
export async function signEntry(
	state: SpaceState | undefined,
	space: string,
	entry: EntryBody,
	by: { readonly id: string; readonly signer: Signer },
	at: number,
): Promise<ChainEntry> {
	const payload = {
		v: CHAIN_VERSION,
		space,
		seq: state === undefined ? 0 : state.seq + 1,
		...(state === undefined ? {} : { prev: state.head }),
		at,
		by: entry.type === "host.add" ? "ticket" : by.id,
		type: entry.type,
		body: entry.body,
	};
	const bytes = utf8(JSON.stringify(payload));
	return {
		payload: toBase64url(bytes),
		sig: toBase64url(await by.signer.sign(signedBytes(ENTRY_CONTEXT, bytes))),
	};
}

/** A device as the chain lists it, from its identity. */
export async function chainDevice(
	identity: Identity,
	user: string,
	deviceClass: DeviceClass,
	label: string,
): Promise<ChainDevice> {
	return {
		id: await keyId("kd", identity.signer.publicKey),
		user,
		sign: toBase64url(identity.signer.publicKey),
		dh: toBase64url(identity.static.publicKey),
		class: deviceClass,
		label: label.slice(0, MAX_LABEL),
	};
}

/** What goes in the join command: the ticket an admin signed and the private seed of its one-off key. */
export interface HostJoinTicket {
	readonly ticket: SignedBlob;
	/** Base64url of the one-off Ed25519 seed. */
	readonly seed: string;
}

/** A ticket for a host called `name` to add itself to the space, signed by an admin's device. */
export async function createHostTicket(
	state: SpaceState,
	admin: { readonly id: string; readonly signer: Signer },
	name: string,
	expiresAt: number,
	/** For test vectors only. */
	seed: Uint8Array = randomSeed(),
): Promise<HostJoinTicket> {
	const oneOff = await signerFromSeed(seed);
	const payload: TicketPayload = {
		v: CHAIN_VERSION,
		type: "host.ticket",
		space: state.space,
		genesis: state.genesis,
		name,
		key: toBase64url(oneOff.publicKey),
		exp: expiresAt,
		by: admin.id,
	};
	const bytes = utf8(JSON.stringify(payload));
	return {
		ticket: {
			payload: toBase64url(bytes),
			sig: toBase64url(await admin.signer.sign(signedBytes(TICKET_CONTEXT, bytes))),
		},
		seed: toBase64url(seed),
	};
}

/** The join command's `--e2e` value: the ticket and its seed, as one base64url word. */
export function encodeJoinTicket(ticket: HostJoinTicket): string {
	return toBase64url(utf8(JSON.stringify(ticket)));
}

export function decodeJoinTicket(word: string): HostJoinTicket {
	const { value } = decodeJson(word, "The join ticket");
	const t = fields(value, "The join ticket", ["ticket", "seed"]);
	const ticket = parseBlob(t.ticket, "ticket");
	parseTicket(ticket);
	return { ticket, seed: key32(t.seed, "seed") };
}

/** The `host.add` a host signs with its ticket's one-off key (the Go host does the same; this is for tests). */
export async function signHostEntry(
	state: SpaceState,
	join: HostJoinTicket,
	host: { readonly id: string; readonly identity: Identity },
	at: number,
): Promise<ChainEntry> {
	const { payload } = parseTicket(join.ticket);
	const oneOff = await signerFromSeed(fromBase64url(join.seed));
	if (!equalBytes(oneOff.publicKey, fromBase64url(payload.key))) throw new Error("The seed isn't the ticket's key");
	return signEntry(
		state,
		state.space,
		{
			type: "host.add",
			body: {
				host: {
					id: host.id,
					name: payload.name,
					sign: toBase64url(host.identity.signer.publicKey),
					dh: toBase64url(host.identity.static.publicKey),
				},
				ticket: join.ticket,
			},
		},
		{ id: "ticket", signer: oneOff },
		at,
	);
}

/** Whether `device` may open a session to the space's hosts now. */
export function deviceAllowed(state: SpaceState, deviceId: string): { ok: true } | { ok: false; reason: string } {
	const device = state.devices.get(deviceId);
	if (device === undefined) return { ok: false, reason: "This device isn't in the space's chain" };
	if (!state.members.has(device.user)) return { ok: false, reason: "This device's person isn't a member" };
	if (state.mode === "strict" && device.class === "web") {
		return { ok: false, reason: "This space is strict: the hosted console isn't let in" };
	}
	return { ok: true };
}

/** The device whose Noise key is `dh` (base64url), if the chain lists one. */
export function deviceByDh(state: SpaceState, dh: string): ChainDevice | undefined {
	for (const device of state.devices.values()) if (device.dh === dh) return device;
	return undefined;
}
