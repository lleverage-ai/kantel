// A host's mesh peers, under its disk when its row on the Hosts page is opened: each other host of its pool, by name,
// whether the host reaches it, the path and endpoint it uses, its last handshake and the round trip of its last probe,
// as the host last reported them (every heartbeat). So a link that's down shows before a sync across it fails. A host
// without a mesh (its pool's sync off, or an older host agent), or that isn't connected, says so instead.

import { compactAge } from "../primitives/format.ts";
import { SideScroll } from "../primitives/side-scroll.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { type Host, type HostMeshPeer, meshPeerReachable } from "./compute-model.ts";
import { cellMono, table, tableFrame, td, th } from "./parts.tsx";

export interface HostPeersProps {
	readonly host: Pick<Host, "name" | "state" | "mesh">;
	/** Each host's name by its ID, to name the peers; a peer not in it shows its ID. */
	readonly names: ReadonlyMap<string, string>;
	readonly now: number;
	/** A phone: a short row per peer instead of the table. */
	readonly narrow?: boolean;
}

/** The path in words: `direct` and `none` as Kantel names them; another (from a newer host) as it came. */
export function pathText(path: string): string {
	if (path === "direct") return "Direct";
	if (path === "none") return "No path";
	return path;
}

/** The last handshake, relative to now: "Just now", "4m ago", or "Never" before the first. */
export function handshakeText(at: number | undefined, now: number): string {
	if (at === undefined) return "Never";
	const age = compactAge(at, now);
	return age === "now" ? "Just now" : `${age} ago`;
}

/** The round trip in milliseconds: a tenth under 10 ms, whole above; "No answer" when the probe got none. */
export function roundTripText(ms: number | undefined): string {
	if (ms === undefined) return "No answer";
	return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms).toLocaleString("en-GB")} ms`;
}

/** Unreachable peers first, then by name. */
function ordered(peers: readonly HostMeshPeer[], names: ReadonlyMap<string, string>, now: number) {
	return peers
		.map((peer) => ({ peer, name: names.get(peer.hostId), reachable: meshPeerReachable(peer, now) }))
		.sort(
			(a, b) =>
				Number(a.reachable) - Number(b.reachable) ||
				(a.name ?? a.peer.hostId).localeCompare(b.name ?? b.peer.hostId, "en-GB"),
		);
}

const Reach = ({ reachable }: { reachable: boolean }) =>
	reachable ? (
		<StatusLabel status="done">Reachable</StatusLabel>
	) : (
		<StatusLabel status="error">Unreachable</StatusLabel>
	);

const PeerName = ({ name, hostId }: { name: string | undefined; hostId: string }) =>
	name === undefined ? (
		<span className={cellMono}>{hostId}</span>
	) : (
		<span className="block max-w-(--kt-popover-width) truncate font-medium text-fg" title={hostId}>
			{name}
		</span>
	);

/** A host's mesh peers: whether it reaches each, how, and how fast. */
export function HostPeers({ host, names, now, narrow = false }: HostPeersProps) {
	const { mesh } = host;
	const heading = <h3 className="m-0 text-sm font-medium text-fg">Peers</h3>;
	if (mesh === undefined) {
		return (
			<section className="flex min-w-0 flex-col gap-1" aria-label={`${host.name}'s peers`} data-host-peers="none">
				{heading}
				<p className="m-0 text-sm text-muted">
					{host.state === "offline"
						? "Not connected, so how it reaches its peers isn't known."
						: "No mesh. Its pool doesn't sync disks between its hosts, or its host agent is too old to join one."}
				</p>
			</section>
		);
	}
	const peers = ordered(mesh.peers, names, now);
	const down = peers.filter((each) => !each.reachable).length;
	const summary =
		peers.length === 0
			? null
			: down === 0
				? `All ${peers.length.toLocaleString("en-GB")} reachable`
				: `${down.toLocaleString("en-GB")} of ${peers.length.toLocaleString("en-GB")} unreachable`;
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-label={`${host.name}'s peers`} data-host-peers>
			<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
				{heading}
				<span className="min-w-0 text-sm text-muted">
					{summary === null ? null : <span className={down === 0 ? "text-muted" : "text-status-error"}>{summary}</span>}
					{summary === null ? null : ", "}
					<span className="font-mono text-code">{mesh.address}</span> on the pool's mesh
				</span>
			</div>
			{peers.length === 0 ? (
				<p className="m-0 text-sm text-muted">No peers yet. It's the only host in its pool on the mesh.</p>
			) : narrow ? (
				<ul className="m-0 flex list-none flex-col p-0">
					{peers.map(({ peer, name, reachable }) => (
						<li
							key={peer.hostId}
							className="flex min-w-0 flex-col gap-1 border-b border-border py-2 last:border-b-0"
							data-peer={peer.hostId}
						>
							<span className="flex min-w-0 items-center justify-between gap-3">
								<PeerName name={name} hostId={peer.hostId} />
								<Reach reachable={reachable} />
							</span>
							<span className="flex min-w-0 flex-wrap gap-x-3 text-sm text-muted">
								<span>{pathText(peer.path)}</span>
								{peer.endpoint === undefined ? null : <span className="font-mono text-code">{peer.endpoint}</span>}
								<span>
									{peer.lastHandshake === undefined
										? "No handshake yet"
										: `Handshake ${handshakeText(peer.lastHandshake, now).toLowerCase()}`}
								</span>
								<span className="tabular-nums">{roundTripText(peer.rttMs)}</span>
							</span>
						</li>
					))}
				</ul>
			) : (
				<SideScroll className={tableFrame}>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Peer
								</th>
								<th className={th} scope="col">
									State
								</th>
								<th className={th} scope="col">
									Path
								</th>
								<th className={th} scope="col">
									Endpoint
								</th>
								<th className={th} scope="col">
									Last handshake
								</th>
								<th className={`${th} text-right`} scope="col">
									Round trip
								</th>
							</tr>
						</thead>
						<tbody>
							{peers.map(({ peer, name, reachable }) => (
								<tr key={peer.hostId} data-peer={peer.hostId}>
									<td className={td}>
										<PeerName name={name} hostId={peer.hostId} />
									</td>
									<td className={td}>
										<Reach reachable={reachable} />
									</td>
									<td className={td}>{pathText(peer.path)}</td>
									<td className={td}>
										{peer.endpoint === undefined ? (
											<span className="text-muted">None</span>
										) : (
											<span className={cellMono}>{peer.endpoint}</span>
										)}
									</td>
									<td
										className={td}
										title={
											peer.lastHandshake === undefined
												? undefined
												: new Date(peer.lastHandshake).toLocaleString("en-GB")
										}
									>
										{handshakeText(peer.lastHandshake, now)}
									</td>
									<td className={`${td} text-right tabular-nums`}>{roundTripText(peer.rttMs)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</SideScroll>
			)}
		</section>
	);
}
