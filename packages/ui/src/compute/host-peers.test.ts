import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type HostMesh, MESH_HANDSHAKE_STALE_MS, meshPeerReachable } from "./compute-model.ts";
import { HostPeers, handshakeText, pathText, roundTripText } from "./host-peers.tsx";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const names = new Map([
	["host_b", "hetzner-fsn1-02"],
	["host_c", "home-server"],
]);

describe("whether a host reaches a mesh peer", () => {
	it("does with a path and a recent handshake", () => {
		expect(meshPeerReachable({ hostId: "host_b", path: "direct", lastHandshake: NOW - 40_000 }, NOW)).toBe(true);
	});

	it("doesn't with no path, a stale handshake, or none at all", () => {
		expect(meshPeerReachable({ hostId: "host_b", path: "none", lastHandshake: NOW - 40_000 }, NOW)).toBe(false);
		expect(
			meshPeerReachable({ hostId: "host_b", path: "direct", lastHandshake: NOW - MESH_HANDSHAKE_STALE_MS - 1 }, NOW),
		).toBe(false);
		expect(meshPeerReachable({ hostId: "host_b", path: "direct" }, NOW)).toBe(false);
	});
});

describe("a peer's figures in words", () => {
	it("says the path, the handshake and the round trip plainly", () => {
		expect(pathText("direct")).toBe("Direct");
		expect(pathText("none")).toBe("No path");
		expect(pathText("relayed")).toBe("relayed");
		expect(handshakeText(undefined, NOW)).toBe("Never");
		expect(handshakeText(NOW - 20_000, NOW)).toBe("Just now");
		expect(handshakeText(NOW - 4 * 60_000, NOW)).toBe("4m ago");
		expect(roundTripText(undefined)).toBe("No answer");
		expect(roundTripText(0.42)).toBe("0.4 ms");
		expect(roundTripText(142.3)).toBe("142 ms");
	});
});

const render = (mesh: HostMesh | undefined, state: "online" | "offline" = "online") =>
	renderToStaticMarkup(
		createElement(HostPeers, {
			host: { name: "hetzner-fsn1-01", state, ...(mesh === undefined ? {} : { mesh }) },
			names,
			now: NOW,
		}),
	);

describe("a host's peers", () => {
	it("shows an unreachable peer as unreachable, first, and counts it", () => {
		const html = render({
			address: "fd4b::1",
			peers: [
				{ hostId: "host_b", path: "direct", endpoint: "203.0.113.24:51820", lastHandshake: NOW - 40_000, rttMs: 0.4 },
				{ hostId: "host_c", path: "none", endpoint: "198.51.100.7:51820", lastHandshake: NOW - 26 * 60_000 },
			],
		});
		const rows = html.split("<tr data-peer=").slice(1);
		expect(rows[0]).toContain("home-server");
		expect(rows[0]).toContain("Unreachable");
		expect(rows[0]).toContain("26m ago");
		expect(rows[1]).toContain("hetzner-fsn1-02");
		expect(rows[1]).toContain("Reachable");
		expect(rows[1]).toContain("0.4 ms");
		expect(html).toContain("1 of 2 unreachable");
	});

	it("names a peer the page doesn't know by its ID", () => {
		expect(render({ address: "fd4b::1", peers: [{ hostId: "host_z", path: "none" }] })).toContain("host_z");
	});

	it("says plainly when there is no mesh, no peers yet, or the host isn't connected", () => {
		expect(render(undefined)).toContain("No mesh. Its pool doesn&#x27;t sync disks between its hosts");
		expect(render(undefined, "offline")).toContain("Not connected");
		expect(render({ address: "fd4b::1", peers: [] })).toContain("No peers yet");
	});
});
