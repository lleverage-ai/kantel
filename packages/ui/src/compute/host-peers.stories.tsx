import { MINUTE } from "../primitives/format.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostMesh, HostMeshPeer } from "./compute-model.ts";
import { FIXTURE_NOW } from "./fixtures.ts";
import { HostPeers } from "./host-peers.tsx";

export default { title: "Compute/Host peers" } satisfies StoryDefault;

const names = new Map([
	["hst_hetzner_1", "hetzner-fsn1-01"],
	["hst_hetzner_2", "hetzner-fsn1-02"],
	["hst_home", "home-server"],
	["hst_ovh_1", "ovh-gra-builds-and-checks-runner-with-a-long-name-01"],
]);

const SECOND = 1000;

const ADDRESS = "fd4b:91c2:7e10:0:5a1e:3f20:9c4d:1b07";

const direct = (hostId: string, at: number, rttMs: number, endpoint: string): HostMeshPeer => ({
	hostId,
	path: "direct",
	endpoint,
	lastHandshake: FIXTURE_NOW - at,
	rttMs,
});

const healthy: HostMesh = {
	address: ADDRESS,
	peers: [
		direct("hst_hetzner_2", 42 * SECOND, 0.4, "203.0.113.24:51820"),
		direct("hst_home", 95 * SECOND, 18.6, "198.51.100.7:51820"),
	],
};

const host = (mesh: HostMesh | undefined, state: "online" | "offline" = "online") => ({
	name: "hetzner-fsn1-01",
	state,
	...(mesh === undefined ? {} : { mesh }),
});

/** Every peer reached directly, with a recent handshake and a round trip. */
export const Reachable: Story = () => <HostPeers host={host(healthy)} names={names} now={FIXTURE_NOW} />;

/**
 * Peers it can't reach, listed first: one with no path (no handshake in 3 minutes), one whose report still says direct
 * but whose handshake is stale, and one it has never shaken hands with.
 */
export const Unreachable: Story = () => (
	<HostPeers
		host={host({
			address: ADDRESS,
			peers: [
				direct("hst_hetzner_2", 42 * SECOND, 0.4, "203.0.113.24:51820"),
				{ hostId: "hst_home", path: "none", endpoint: "198.51.100.7:51820", lastHandshake: FIXTURE_NOW - 26 * MINUTE },
				{ ...direct("hst_ovh_1", 11 * MINUTE, 9.2, "192.0.2.80:51820") },
				{ hostId: "hst_7q2w9e", path: "none" },
			],
		})}
		names={names}
		now={FIXTURE_NOW}
	/>
);

/** A pool of 24 hosts: the table grows with it, the summary counts what's down. */
export const ManyPeers: Story = () => (
	<HostPeers
		host={host({
			address: ADDRESS,
			peers: Array.from({ length: 23 }, (_, at) =>
				at % 9 === 4
					? { hostId: `hst_pool_${at}`, path: "none", endpoint: `203.0.113.${at + 10}:51820` }
					: direct(`hst_pool_${at}`, (at + 1) * 7 * SECOND, 0.3 + at * 1.7, `203.0.113.${at + 10}:51820`),
			),
		})}
		names={
			new Map(Array.from({ length: 23 }, (_, at) => [`hst_pool_${at}`, `pool-host-${String(at + 1).padStart(2, "0")}`]))
		}
		now={FIXTURE_NOW}
	/>
);

/** Long host names and a peer the page has no name for (its ID shows). */
export const LongContent: Story = () => (
	<HostPeers
		host={host({
			address: ADDRESS,
			peers: [
				direct("hst_ovh_1", 20 * SECOND, 142.3, "[2001:db8:85a3::8a2e:370:7334]:51820"),
				direct("hst_unlisted_9f8e7d6c", 50 * SECOND, 3.1, "192.0.2.80:51820"),
			],
		})}
		names={names}
		now={FIXTURE_NOW}
	/>
);

/** Its pool syncs, but it is the only host on the mesh yet. */
export const NoPeers: Story = () => (
	<HostPeers host={host({ address: ADDRESS, peers: [] })} names={names} now={FIXTURE_NOW} />
);

/** Its pool's sync is off (or its host agent is older): no mesh, and it says so. */
export const NoMesh: Story = () => <HostPeers host={host(undefined)} names={names} now={FIXTURE_NOW} />;

/** A host that isn't connected: how it reaches its peers isn't known. */
export const NotConnected: Story = () => (
	<HostPeers host={host(undefined, "offline")} names={names} now={FIXTURE_NOW} />
);

/** A phone: a short row per peer, unreachable ones first. */
export const Mobile: Story = () => (
	<HostPeers
		host={host({
			address: ADDRESS,
			peers: [
				...healthy.peers,
				{ hostId: "hst_ovh_1", path: "none", endpoint: "192.0.2.80:51820", lastHandshake: FIXTURE_NOW - 26 * MINUTE },
			],
		})}
		names={names}
		now={FIXTURE_NOW}
		narrow
	/>
);
Mobile.meta = { width: 390 };
