/**
 * A space as tests (and the cross-language vectors) see it: an organisation `acc_org` whose admin Tom made the chain,
 * added a host and let Bob in, and whose gateway tries to sneak in a device of its own. Every key comes from a fixed
 * seed, and Ed25519 is deterministic, so the same entries come out every time.
 */
import { sha256, toBase64url, utf8 } from "../src/bytes.ts";
import {
	type ChainEntry,
	chainDevice,
	createHostTicket,
	type EntryBody,
	type HostJoinTicket,
	type SpaceState,
	signEntry,
	signHostEntry,
	verifyChain,
} from "../src/chain.ts";
import { type Identity, identityFromSeeds, keyId, signerFromSeed } from "../src/keys.ts";

export const SPACE = "acc_org";
export const HOST_ID = "host_one";
export const T0 = 1_793_750_400_000;

export async function seed(name: string): Promise<Uint8Array> {
	return sha256(utf8(`kantel-e2e-fixture/${name}`));
}

export async function fixedIdentity(name: string): Promise<Identity> {
	return identityFromSeeds({
		sign: toBase64url(await seed(`${name}/sign`)),
		dh: toBase64url(await seed(`${name}/dh`)),
	});
}

export interface Fixture {
	readonly tom: Identity;
	readonly tomPhone: Identity;
	readonly bob: Identity;
	readonly bobLaptop: Identity;
	readonly host: Identity;
	readonly gateway: Identity;
	readonly tomId: string;
	readonly bobId: string;
	readonly join: HostJoinTicket;
	/** genesis, host.add, member.add bob, device.add bob, device.add bob's laptop (by bob), device.add tom's phone. */
	readonly entries: readonly ChainEntry[];
	readonly state: SpaceState;
}

export async function signAs(
	state: SpaceState | undefined,
	who: Identity,
	entry: EntryBody,
	at: number,
): Promise<ChainEntry> {
	return signEntry(state, SPACE, entry, { id: await keyId("kd", who.signer.publicKey), signer: who.signer }, at);
}

export async function fixture(): Promise<Fixture> {
	const tom = await fixedIdentity("tom");
	const tomPhone = await fixedIdentity("tom-phone");
	const bob = await fixedIdentity("bob");
	const bobLaptop = await fixedIdentity("bob-laptop");
	const host = await fixedIdentity("host");
	const gateway = await fixedIdentity("gateway");
	const tomId = await keyId("kd", tom.signer.publicKey);
	const bobId = await keyId("kd", bob.signer.publicKey);
	const entries: ChainEntry[] = [];
	let state: SpaceState | undefined;
	const push = async (entry: ChainEntry) => {
		entries.push(entry);
		state = await verifyChain(entries);
	};
	await push(
		await signAs(
			undefined,
			tom,
			{
				type: "genesis",
				body: { mode: "on", device: await chainDevice(tom, "usr_tom", "cli", "kantel on tom-laptop") },
			},
			T0,
		),
	);
	const join = await createHostTicket(
		state as SpaceState,
		{ id: tomId, signer: tom.signer },
		"rack-1",
		T0 + 3_600_000,
		await seed("ticket-1"),
	);
	await push(await signHostEntry(state as SpaceState, join, { id: HOST_ID, identity: host }, T0 + 60_000));
	await push(await signAs(state, tom, { type: "member.add", body: { user: "usr_bob", role: "member" } }, T0 + 120_000));
	await push(
		await signAs(
			state,
			tom,
			{ type: "device.add", body: { device: await chainDevice(bob, "usr_bob", "cli", "kantel on bob-desktop") } },
			T0 + 180_000,
		),
	);
	await push(
		await signAs(
			state,
			bob,
			{ type: "device.add", body: { device: await chainDevice(bobLaptop, "usr_bob", "cli", "kantel on bob-laptop") } },
			T0 + 240_000,
		),
	);
	await push(
		await signAs(
			state,
			tom,
			{ type: "device.add", body: { device: await chainDevice(tomPhone, "usr_tom", "web", "console on tom-phone") } },
			T0 + 300_000,
		),
	);
	return { tom, tomPhone, bob, bobLaptop, host, gateway, tomId, bobId, join, entries, state: state as SpaceState };
}

/** A device ID and signer the gateway makes up: its own key, claiming nothing it can prove. */
export async function gatewaySigner(): Promise<{ id: string; signer: Awaited<ReturnType<typeof signerFromSeed>> }> {
	const signer = await signerFromSeed(await seed("gateway/sign"));
	return { id: await keyId("kd", signer.publicKey), signer };
}
