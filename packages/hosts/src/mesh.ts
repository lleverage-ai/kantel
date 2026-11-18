/**
 * The pools' meshes (docs/design/disk-store.md, "2a. The mesh"): each pool's hosts with `HOST_FEATURES.mesh` peer over
 * WireGuard, and Kantel gives each its mesh address and its pool's other hosts. Pools never peer: a host's peers are the
 * hosts of its own pool alone.
 *
 * Addresses are IPv6 ULAs (RFC 4193): one /48 per pool, its 40-bit global ID taken from a hash of the pool's ID, and one
 * /128 per host in its first /64, its interface ID from a hash of the pool's and host's IDs. A host keeps the address it
 * was given (`HostRecord.mesh`), so it stays the same across reconnects; one that would be another host's in the pool is
 * passed over for the next.
 */
import type { HostMeshPeer } from "./protocol.ts";
import { HOST_FEATURES } from "./protocol.ts";
import type { HostRecord } from "./store.ts";

/** How many addresses are tried for a host before giving up: each a 64-bit hash, so a second is already rare. */
const ADDRESS_ATTEMPTS = 16;

const sha256 = async (text: string): Promise<Uint8Array> =>
	new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** An IPv6 address's 16 bytes as RFC 5952 writes them: lower case, no leading zeros, the longest run of 0s as `::`. */
export function formatIPv6(bytes: Uint8Array): string {
	if (bytes.length !== 16) throw new Error("An IPv6 address is 16 bytes");
	const groups: number[] = [];
	for (let at = 0; at < 16; at += 2) groups.push(((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0));
	// The longest run of two or more zero groups, the first of equals.
	let runAt = -1;
	let runLength = 0;
	for (let at = 0; at < 8; ) {
		if (groups[at] !== 0) {
			at += 1;
			continue;
		}
		let end = at;
		while (end < 8 && groups[end] === 0) end += 1;
		if (end - at > runLength && end - at >= 2) {
			runAt = at;
			runLength = end - at;
		}
		at = end;
	}
	const hex = (part: readonly number[]) => part.map((group) => group.toString(16)).join(":");
	if (runAt < 0) return hex(groups);
	return `${hex(groups.slice(0, runAt))}::${hex(groups.slice(runAt + runLength))}`;
}

/** The first 6 bytes of a pool's /48: `fd` and the 40-bit global ID from its ID. */
async function poolBytes(poolId: string): Promise<Uint8Array> {
	const hash = await sha256(`kantel mesh pool\n${poolId}`);
	return Uint8Array.of(0xfd, ...hash.slice(0, 5));
}

/** A pool's mesh prefix, its /48: `fdxx:xxxx:xxxx::/48`. */
export async function meshPrefix(poolId: string): Promise<string> {
	const address = new Uint8Array(16);
	address.set(await poolBytes(poolId));
	return `${formatIPv6(address)}/48`;
}

/**
 * A host's mesh address in a pool, its `attempt`th candidate: the pool's /48, subnet 0, and a 64-bit interface ID from
 * the pool's and host's IDs (never all zeros, the subnet's anycast address).
 */
export async function meshAddressCandidate(poolId: string, hostId: string, attempt: number): Promise<string> {
	const address = new Uint8Array(16);
	address.set(await poolBytes(poolId));
	const hash = await sha256(`kantel mesh host\n${poolId}\n${hostId}\n${attempt}`);
	address.set(hash.slice(0, 8), 8);
	if (address.slice(8).every((byte) => byte === 0)) address[15] = 1;
	return formatIPv6(address);
}

/**
 * The address a host gets in a pool: its first candidate that none of `taken` (the pool's other hosts' addresses) has.
 * Undefined only if every attempt is taken, which 64-bit hashes make all but impossible.
 */
export async function meshAddressFor(
	poolId: string,
	hostId: string,
	taken: ReadonlySet<string>,
): Promise<string | undefined> {
	for (let attempt = 0; attempt < ADDRESS_ATTEMPTS; attempt += 1) {
		const candidate = await meshAddressCandidate(poolId, hostId, attempt);
		if (!taken.has(candidate)) return candidate;
	}
	return undefined;
}

/** Whether a host runs the mesh: it reports the feature and its key, and isn't revoked. */
export function runsMesh(host: HostRecord): boolean {
	return !host.revoked && host.facts?.features?.includes(HOST_FEATURES.mesh) === true && host.facts.mesh !== undefined;
}

/**
 * A host as its pool's other hosts see it in the mesh: undefined unless it runs the mesh, is in a pool, and has its
 * address there.
 */
export function meshPeerOf(host: HostRecord): HostMeshPeer | undefined {
	const mesh = host.facts?.mesh;
	if (!runsMesh(host) || mesh === undefined || host.poolId === undefined) return undefined;
	if (host.mesh === undefined || host.mesh.poolId !== host.poolId) return undefined;
	return { hostId: host.id, publicKey: mesh.publicKey, address: host.mesh.address, endpoints: [...mesh.endpoints] };
}

/** The peers of `host` among `hosts`: every other host of its pool in the mesh, none of another pool's. */
export function meshPeersAmong(host: HostRecord, hosts: readonly HostRecord[]): HostMeshPeer[] {
	if (host.poolId === undefined) return [];
	const peers: HostMeshPeer[] = [];
	for (const other of hosts) {
		if (other.id === host.id || other.poolId !== host.poolId) continue;
		const peer = meshPeerOf(other);
		if (peer !== undefined) peers.push(peer);
	}
	return peers;
}

/** Whether a host's entry in its peers' lists differs between two of its records (a new key, endpoints, address). */
export function meshPeerChanged(before: HostRecord | undefined, after: HostRecord | undefined): boolean {
	const was = before === undefined ? undefined : meshPeerOf(before);
	const is = after === undefined ? undefined : meshPeerOf(after);
	return JSON.stringify(was) !== JSON.stringify(is);
}
