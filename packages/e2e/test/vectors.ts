/**
 * The cross-language vectors: chain cases both verifiers must agree on (vectors/chain.json), and one whole session
 * (vectors/session.json) the Go host replays byte for byte. `node packages/e2e/test/vectors.ts --write` writes them;
 * vectors.test.ts checks the files are what this makes.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fromBase64url, toBase64url, utf8 } from "../src/bytes.ts";
import {
	type ChainEntry,
	ChainError,
	chainDevice,
	createHostTicket,
	deviceAllowed,
	encodeJoinTicket,
	extendChain,
	type SpaceState,
	signEntry,
	signHostEntry,
	verifyChain,
} from "../src/chain.ts";
import { dhFromSeed, keyId } from "../src/keys.ts";
import { serveSession } from "../src/responder.ts";
import { openSession, prologue, SessionClient } from "../src/session.ts";
import { recordingRelay } from "../src/testing.ts";
import { fixedIdentity, fixture, gatewaySigner, HOST_ID, SPACE, seed, signAs, T0 } from "./fixture.ts";

export interface StateSummary {
	readonly space: string;
	readonly genesis: string;
	readonly head: string;
	readonly seq: number;
	readonly mode: string;
	readonly members: { readonly [user: string]: string };
	readonly devices: readonly string[];
	readonly hosts: readonly string[];
	/** Each device's verdict for a session now. */
	readonly allowed: { readonly [device: string]: boolean };
}

export interface ChainCase {
	readonly name: string;
	readonly entries: readonly ChainEntry[];
	readonly pin?: string;
	/** Verify `known` first, then extend that with `entries`, which start at seq `from`. */
	readonly extend?: { readonly known: readonly ChainEntry[]; readonly from: number };
	readonly ok: boolean;
	/** The entry that fails. */
	readonly seq?: number;
	readonly state?: StateSummary;
}

export function summary(state: SpaceState): StateSummary {
	return {
		space: state.space,
		genesis: state.genesis,
		head: state.head,
		seq: state.seq,
		mode: state.mode,
		members: Object.fromEntries([...state.members].sort(([a], [b]) => a.localeCompare(b))),
		devices: [...state.devices.keys()].sort(),
		hosts: [...state.hosts.keys()].sort(),
		allowed: Object.fromEntries([...state.devices.keys()].sort().map((id) => [id, deviceAllowed(state, id).ok])),
	};
}

async function run(c: Omit<ChainCase, "ok" | "seq" | "state">): Promise<ChainCase> {
	try {
		let state: SpaceState;
		if (c.extend === undefined) state = await verifyChain(c.entries, c.pin);
		else state = await extendChain(await verifyChain(c.extend.known, c.pin), c.entries, c.extend.from);
		return { ...c, ok: true, state: summary(state) };
	} catch (error) {
		if (!(error instanceof ChainError)) throw error;
		return { ...c, ok: false, seq: error.seq };
	}
}

export async function chainVectors(): Promise<{ readonly cases: readonly ChainCase[] }> {
	const f = await fixture();
	const base = f.entries;
	const at = T0 + 400_000;
	const gateway = await gatewaySigner();
	const eve = await fixedIdentity("eve");
	const gatewayDevice = {
		id: gateway.id,
		user: "usr_tom",
		sign: toBase64url(gateway.signer.publicKey),
		dh: toBase64url(f.gateway.static.publicKey),
		class: "cli" as const,
		label: "definitely tom",
	};
	const cases: Omit<ChainCase, "ok" | "seq" | "state">[] = [];
	cases.push({ name: "an organisation: admin, host, a member and their second device", entries: base });
	cases.push({
		name: "the gateway adds a device of its own, signed with its own key",
		entries: [
			...base,
			await signEntry(f.state, SPACE, { type: "device.add", body: { device: gatewayDevice } }, gateway, at),
		],
	});
	cases.push({
		name: "the gateway adds a device, claiming the admin's device signed it",
		entries: [
			...base,
			await signEntry(
				f.state,
				SPACE,
				{ type: "device.add", body: { device: gatewayDevice } },
				{ id: f.tomId, signer: gateway.signer },
				at,
			),
		],
	});
	cases.push({
		name: "a member adds a member",
		entries: [
			...base,
			await signAs(f.state, f.bob, { type: "member.add", body: { user: "usr_eve", role: "admin" } }, at),
		],
	});
	cases.push({
		name: "a member adds a device to another person",
		entries: [
			...base,
			await signAs(
				f.state,
				f.bob,
				{ type: "device.add", body: { device: await chainDevice(eve, "usr_tom", "cli", "not tom's") } },
				at,
			),
		],
	});
	cases.push({
		name: "a join ticket used twice",
		entries: [...base, await signHostEntry(f.state, f.join, { id: "host_two", identity: eve }, at)],
	});
	const t2 = await createHostTicket(
		f.state,
		{ id: f.tomId, signer: f.tom.signer },
		"rack-2",
		T0 + 3_600_000,
		await seed("ticket-2"),
	);
	cases.push({
		name: "the gateway, holding a ticket but not its seed, enrols a host of its own",
		entries: [
			...base,
			await signEntry(
				f.state,
				SPACE,
				{
					type: "host.add",
					body: {
						host: {
							id: "host_rogue",
							name: "rack-2",
							sign: toBase64url(gateway.signer.publicKey),
							dh: toBase64url(f.gateway.static.publicKey),
						},
						ticket: t2.ticket,
					},
				},
				gateway,
				at,
			),
		],
	});
	const expired = await createHostTicket(
		f.state,
		{ id: f.tomId, signer: f.tom.signer },
		"rack-3",
		T0 + 1_000,
		await seed("ticket-3"),
	);
	cases.push({
		name: "a join ticket used after it expired",
		entries: [...base, await signHostEntry(f.state, expired, { id: "host_three", identity: eve }, at)],
	});
	const memberTicket = await createHostTicket(
		f.state,
		{ id: f.bobId, signer: f.bob.signer },
		"rack-4",
		at + 60_000,
		await seed("ticket-4"),
	);
	cases.push({
		name: "a join ticket a member signed",
		entries: [...base, await signHostEntry(f.state, memberTicket, { id: "host_four", identity: eve }, at)],
	});
	cases.push({
		name: "the gateway sends another space's genesis to a device that pinned this one",
		entries: [
			await signAs(
				undefined,
				f.gateway,
				{ type: "genesis", body: { mode: "off", device: await chainDevice(f.gateway, "usr_tom", "cli", "gateway") } },
				T0,
			),
		],
		pin: f.state.genesis,
	});
	const prefix = await verifyChain(base.slice(0, 3));
	cases.push({
		name: "a fork: the gateway shows a host that verified seq 3 another seq 3",
		entries: [
			base[2] as ChainEntry,
			await signAs(prefix, f.tom, { type: "member.add", body: { user: "usr_mallory", role: "admin" } }, at),
		],
		extend: { known: base.slice(0, 4), from: 2 },
	});
	cases.push({
		name: "a rollback: older entries change nothing",
		entries: base.slice(1, 3),
		extend: { known: base, from: 1 },
	});
	cases.push({
		name: "a host behind takes the newer entries a device brings",
		entries: base.slice(3),
		extend: { known: base.slice(0, 3), from: 3 },
	});
	const removed = await signAs(f.state, f.tom, { type: "member.remove", body: { user: "usr_bob" } }, at);
	cases.push({ name: "the admin removes a member and their devices", entries: [...base, removed] });
	const phoneId = await keyId("kd", f.tomPhone.signer.publicKey);
	const noPhone = await signAs(f.state, f.tom, { type: "device.remove", body: { id: phoneId } }, at);
	const afterPhone = await verifyChain([...base, noPhone]);
	cases.push({
		name: "the last admin removes their last device",
		entries: [
			...base,
			noPhone,
			await signAs(afterPhone, f.tom, { type: "device.remove", body: { id: f.tomId } }, at + 1),
		],
	});
	const strict = await signAs(f.state, f.tom, { type: "mode", body: { mode: "strict" } }, at);
	cases.push({ name: "a strict space refuses the hosted console's device", entries: [...base, strict] });
	const strictState = await verifyChain([...base, strict]);
	cases.push({
		name: "in a strict space, the hosted console's key adds a CLI device of its own",
		entries: [
			...base,
			strict,
			await signAs(
				strictState,
				f.tomPhone,
				{ type: "device.add", body: { device: await chainDevice(eve, "usr_tom", "cli", "kantel on tom-laptop") } },
				at + 1,
			),
		],
	});
	cases.push({
		name: "in a strict space, the hosted console's key turns E2E off",
		entries: [...base, strict, await signAs(strictState, f.tomPhone, { type: "mode", body: { mode: "off" } }, at + 1)],
	});
	cases.push({
		name: "in a strict space, the admin removes their last CLI device, leaving only the hosted console's",
		entries: [
			...base,
			strict,
			await signAs(strictState, f.tom, { type: "device.remove", body: { id: f.tomId } }, at + 1),
		],
	});
	cases.push({
		name: "a strict genesis whose only device is the hosted console's",
		entries: [
			await signAs(
				undefined,
				f.tomPhone,
				{
					type: "genesis",
					body: { mode: "strict", device: await chainDevice(f.tomPhone, "usr_tom", "web", "console") },
				},
				T0,
			),
		],
	});
	cases.push({
		name: "a second genesis",
		entries: [
			...base,
			await signEntry(
				f.state,
				SPACE,
				{ type: "genesis", body: { mode: "off", device: await chainDevice(f.tom, "usr_tom", "cli", "again") } },
				{ id: f.tomId, signer: f.tom.signer },
				at,
			),
		],
	});
	const wrongPrev = await signAs(prefix, f.tom, { type: "mode", body: { mode: "off" } }, at);
	cases.push({ name: "an entry that doesn't follow the head", entries: [...base, wrongPrev] });
	return { cases: await Promise.all(cases.map(run)) };
}

export interface SessionVector {
	readonly space: string;
	readonly hostId: string;
	readonly prologue: string;
	/** Seeds, base64url. */
	readonly hostStatic: string;
	readonly hostEphemeral: string;
	readonly deviceStatic: string;
	readonly deviceEphemeral: string;
	/** The host's chain: the first `hostSeq + 1` entries of `entries`. */
	readonly entries: readonly ChainEntry[];
	readonly hostSeq: number;
	/**
	 * The records each side put on the stream (base64url, without their two length bytes), in order: the device's
	 * handshake, `open` and call; the host's handshake, `ready` and answer.
	 */
	readonly device: readonly string[];
	readonly host: readonly string[];
	/** The plaintext of the host's records: its handshake payload, then each control message's JSON. */
	readonly hostPlaintexts: readonly string[];
	/** The host's verdict on the device: it must be Bob's laptop, allowed once the two newer entries are in. */
	readonly deviceId: string;
}

/** A stream's bytes, cut at the two-byte lengths. */
export function records(stream: Uint8Array): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (let at = 0; at < stream.byteLength; ) {
		const length = ((stream[at] ?? 0) << 8) | (stream[at + 1] ?? 0);
		out.push(stream.slice(at + 2, at + 2 + length));
		at += 2 + length;
	}
	return out;
}

/** One session: Bob's laptop runs `echo hi` on sandbox `sbx_one`, bringing the host two entries it lacks. */
export async function sessionVector(): Promise<SessionVector> {
	const f = await fixture();
	const hostSeq = 3;
	const hostEphemeral = toBase64url(utf8("host-ephemeral-seed-0123456789ab").slice(0, 32));
	const deviceEphemeral = toBase64url(utf8("device-ephemeral-seed-0123456789").slice(0, 32));
	const relay = recordingRelay();
	let hostState = await verifyChain(f.entries.slice(0, hostSeq + 1));
	const head = JSON.stringify({ v: 1, head: { seq: hostState.seq, hash: hostState.head } });
	const result = { exitCode: 0, stdout: "hi\n", stderr: "", durationMs: 3 };
	const served = serveSession({
		channel: relay.host,
		static: f.host.static,
		hostId: HOST_ID,
		ephemeral: await dhFromSeed(fromBase64url(hostEphemeral)),
		chain: {
			state: () => hostState,
			async extend(from, entries) {
				hostState = await extendChain(hostState, entries, from);
				return hostState;
			},
		},
		rpc: async () => result,
	});
	const session = await openSession({
		channel: relay.device,
		static: f.bobLaptop.static,
		state: f.state,
		entries: f.entries,
		hostId: HOST_ID,
		sandbox: "sbx_one",
		op: "rpc",
		ephemeral: await dhFromSeed(fromBase64url(deviceEphemeral)),
	});
	const client = new SessionClient(session);
	await client.call("sandbox.exec", { command: "echo hi" });
	client.close();
	await served;
	const seen = relay.seen();
	return {
		space: SPACE,
		hostId: HOST_ID,
		prologue: toBase64url(prologue(SPACE, HOST_ID)),
		hostStatic: f.host.seeds.dh,
		hostEphemeral,
		deviceStatic: f.bobLaptop.seeds.dh,
		deviceEphemeral,
		entries: f.entries,
		hostSeq,
		device: records(seen.toHost).map(toBase64url),
		host: records(seen.toDevice).map(toBase64url),
		hostPlaintexts: [head, JSON.stringify({ type: "ready" }), JSON.stringify({ id: 1, result })],
		deviceId: await keyId("kd", f.bobLaptop.signer.publicKey),
	};
}

export interface JoinVector {
	/** The space's chain as the gateway gives it to a joining host. */
	readonly entries: readonly ChainEntry[];
	/** What `kantel e2e hosts ticket` prints for a host called rack-9. */
	readonly word: string;
	/** Another space's chain: a gateway that hands the host this instead. */
	readonly otherEntries: readonly ChainEntry[];
}

/** A ticket for a second host, which the Go host's join must turn into a host.add the chain takes. */
export async function joinVector(): Promise<JoinVector> {
	const f = await fixture();
	const join = await createHostTicket(
		f.state,
		{ id: f.tomId, signer: f.tom.signer },
		"rack-9",
		// Long after the fixture, so the Go host's clock is inside it for years.
		T0 + 20 * 365 * 24 * 3_600_000,
		await seed("ticket-9"),
	);
	const other = await fixedIdentity("other-space");
	const otherGenesis = await signEntry(
		undefined,
		SPACE,
		{ type: "genesis", body: { mode: "on", device: await chainDevice(other, "usr_tom", "cli", "other") } },
		{ id: await keyId("kd", other.signer.publicKey), signer: other.signer },
		T0,
	);
	return { entries: f.entries, word: encodeJoinTicket(join), otherEntries: [otherGenesis] };
}

const here = (name: string) => fileURLToPath(new URL(`../vectors/${name}`, import.meta.url));

export const vectorFiles = {
	chain: here("chain.json"),
	session: here("session.json"),
	join: here("join.json"),
};

export const render = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

if (process.argv.includes("--write")) {
	await writeFile(vectorFiles.chain, render(await chainVectors()));
	await writeFile(vectorFiles.session, render(await sessionVector()));
	await writeFile(vectorFiles.join, render(await joinVector()));
}
