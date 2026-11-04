/**
 * Several gateway replicas behind one load balancer. A host holds one WebSocket, to whichever replica the balancer gave
 * it; a call for that host (a sandbox's command, a port stream for a desktop, SSH or an exposed port) may arrive at any
 * replica. So each replica records, in the shared database, the hosts whose connection it holds, and a call for a
 * host held elsewhere goes to the replica that holds it, over HTTP and WebSocket between replicas.
 *
 * - `compute_gateway_replicas`: each live replica's address and its Ed25519 public key, refreshed every
 *   `heartbeatMs`. A replica not seen for `staleMs` is gone: what it held is not routed to.
 * - `compute_host_owners`: which replica holds each host's connection, with an epoch that grows with each claim. A
 *   replica releases only the claim it made, so a late close of an old connection never erases a newer one; a replica
 *   that finds its host claimed by another live replica closes its own (stale) connection, and the host reconnects.
 *
 * Replicas sign what they send each other with the private key only they hold (never stored); the receiver checks it
 * against the public key the sender registered, that it was the replica the request was signed for, the time, and a
 * nonce it has not seen. No shared secret is kept
 * anywhere. A replica serves a peer's call only for a host connected to it, so calls never bounce between replicas.
 *
 * Nothing here is Node-only: the transport between replicas is the gateway's (`PeerTransport`).
 */
import type { SqlDriver } from "@kantel/sql";
import { sqlNumber } from "@kantel/sql";
import { type CallOptions, HostCallError, type HostHub, type PortSink, type PortStream } from "./hub.ts";
import type { HostWelcome } from "./protocol.ts";

export interface ReplicaRecord {
	readonly id: string;
	/** Where other replicas reach it, such as `http://10.0.3.7:8080`. */
	readonly url: string;
	/** Its Ed25519 public key, raw, base64url. */
	readonly publicKey: string;
	readonly startedAt: number;
	readonly heartbeatAt: number;
}

export interface HostOwner {
	readonly hostId: string;
	readonly replicaId: string;
	readonly epoch: number;
	readonly claimedAt: number;
}

export interface ClusterStore {
	/** Inserts or refreshes a replica. */
	putReplica(replica: ReplicaRecord): Promise<void>;
	getReplica(id: string): Promise<ReplicaRecord | undefined>;
	/** Replicas seen at or after `since`. */
	liveReplicas(since: number): Promise<ReplicaRecord[]>;
	/** Forgets a replica and every host it held. */
	removeReplica(id: string): Promise<void>;
	/** Forgets replicas not seen since `before`, and every host they held. */
	sweepReplicas(before: number): Promise<void>;
	/** Records that `replicaId` holds the host now; resolves the claim's epoch. */
	claimHost(hostId: string, replicaId: string, now: number): Promise<number>;
	/** Forgets the claim, if it is still this one. */
	releaseHost(hostId: string, replicaId: string, epoch: number): Promise<void>;
	getOwner(hostId: string): Promise<HostOwner | undefined>;
	owners(): Promise<HostOwner[]>;
}

export function createMemoryClusterStore(): ClusterStore {
	const replicas = new Map<string, ReplicaRecord>();
	const owners = new Map<string, HostOwner>();
	const forgetHostsOf = (replicaId: string) => {
		for (const [hostId, owner] of owners) if (owner.replicaId === replicaId) owners.delete(hostId);
	};
	return {
		async putReplica(replica) {
			replicas.set(replica.id, { ...replica });
		},
		async getReplica(id) {
			const replica = replicas.get(id);
			return replica === undefined ? undefined : { ...replica };
		},
		async liveReplicas(since) {
			return [...replicas.values()].filter((replica) => replica.heartbeatAt >= since).map((r) => ({ ...r }));
		},
		async removeReplica(id) {
			replicas.delete(id);
			forgetHostsOf(id);
		},
		async sweepReplicas(before) {
			for (const [id, replica] of replicas) {
				if (replica.heartbeatAt < before) {
					replicas.delete(id);
					forgetHostsOf(id);
				}
			}
		},
		async claimHost(hostId, replicaId, now) {
			const epoch = (owners.get(hostId)?.epoch ?? 0) + 1;
			owners.set(hostId, { hostId, replicaId, epoch, claimedAt: now });
			return epoch;
		},
		async releaseHost(hostId, replicaId, epoch) {
			const owner = owners.get(hostId);
			if (owner?.replicaId === replicaId && owner.epoch === epoch) owners.delete(hostId);
		},
		async getOwner(hostId) {
			const owner = owners.get(hostId);
			return owner === undefined ? undefined : { ...owner };
		},
		async owners() {
			return [...owners.values()].map((owner) => ({ ...owner }));
		},
	};
}

/** The cluster's tables, for SQLite and Postgres alike. */
export function clusterSchema(dialect: SqlDriver["dialect"]): string[] {
	const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS compute_gateway_replicas (
			id TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			public_key TEXT NOT NULL,
			started_at ${real} NOT NULL,
			heartbeat_at ${real} NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS compute_host_owners (
			host_id TEXT PRIMARY KEY,
			replica_id TEXT NOT NULL,
			epoch INTEGER NOT NULL,
			claimed_at ${real} NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS compute_host_owners_replica ON compute_host_owners (replica_id)",
	];
}

const replicaOf = (row: Record<string, unknown>): ReplicaRecord => ({
	id: String(row.id),
	url: String(row.url),
	publicKey: String(row.public_key),
	startedAt: sqlNumber(row.started_at),
	heartbeatAt: sqlNumber(row.heartbeat_at),
});

const ownerOf = (row: Record<string, unknown>): HostOwner => ({
	hostId: String(row.host_id),
	replicaId: String(row.replica_id),
	epoch: sqlNumber(row.epoch),
	claimedAt: sqlNumber(row.claimed_at),
});

/** The cluster's state in SQL. Run `migrateRelay` (which makes these tables too) first. */
export function createSqlClusterStore(driver: SqlDriver): ClusterStore {
	return {
		async putReplica(replica) {
			await driver.query(
				`INSERT INTO compute_gateway_replicas (id, url, public_key, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET url = excluded.url, public_key = excluded.public_key,
					heartbeat_at = excluded.heartbeat_at`,
				[replica.id, replica.url, replica.publicKey, replica.startedAt, replica.heartbeatAt],
			);
		},
		async getReplica(id) {
			const [row] = await driver.query("SELECT * FROM compute_gateway_replicas WHERE id = ?", [id]);
			return row === undefined ? undefined : replicaOf(row);
		},
		async liveReplicas(since) {
			const rows = await driver.query("SELECT * FROM compute_gateway_replicas WHERE heartbeat_at >= ? ORDER BY id", [
				since,
			]);
			return rows.map(replicaOf);
		},
		async removeReplica(id) {
			await driver.batch([
				{ sql: "DELETE FROM compute_host_owners WHERE replica_id = ?", params: [id] },
				{ sql: "DELETE FROM compute_gateway_replicas WHERE id = ?", params: [id] },
			]);
		},
		async sweepReplicas(before) {
			await driver.batch([
				{
					sql: "DELETE FROM compute_host_owners WHERE replica_id IN (SELECT id FROM compute_gateway_replicas WHERE heartbeat_at < ?)",
					params: [before],
				},
				{ sql: "DELETE FROM compute_gateway_replicas WHERE heartbeat_at < ?", params: [before] },
			]);
		},
		async claimHost(hostId, replicaId, now) {
			const [row] = await driver.query(
				`INSERT INTO compute_host_owners (host_id, replica_id, epoch, claimed_at) VALUES (?, ?, 1, ?)
				ON CONFLICT (host_id) DO UPDATE SET replica_id = excluded.replica_id,
					epoch = compute_host_owners.epoch + 1, claimed_at = excluded.claimed_at
				RETURNING epoch`,
				[hostId, replicaId, now],
			);
			return sqlNumber(row?.epoch);
		},
		async releaseHost(hostId, replicaId, epoch) {
			await driver.query("DELETE FROM compute_host_owners WHERE host_id = ? AND replica_id = ? AND epoch = ?", [
				hostId,
				replicaId,
				epoch,
			]);
		},
		async getOwner(hostId) {
			const [row] = await driver.query("SELECT * FROM compute_host_owners WHERE host_id = ?", [hostId]);
			return row === undefined ? undefined : ownerOf(row);
		},
		async owners() {
			return (await driver.query("SELECT * FROM compute_host_owners ORDER BY host_id")).map(ownerOf);
		},
	};
}

/** How a replica reaches another: the gateway's HTTP and WebSocket client, signing what it sends. */
export interface PeerTransport {
	call(peer: ReplicaRecord, hostId: string, method: string, params: unknown, options: CallOptions): Promise<unknown>;
	openPort(peer: ReplicaRecord, hostId: string, sandboxId: string, port: number, sink: PortSink): Promise<PortStream>;
	rewelcome(peer: ReplicaRecord, hostId: string, welcome: HostWelcome): Promise<void>;
	disconnect(peer: ReplicaRecord, hostId: string, code: number, reason: string): Promise<void>;
}

/** This replica's signing key: the private half never leaves the process. */
export interface ReplicaKey {
	readonly publicKey: string;
	sign(message: Uint8Array): Promise<Uint8Array>;
}

const base64url = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> => {
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** A copy over an ArrayBuffer of its own, as WebCrypto takes. */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

/** A new Ed25519 key for this replica, made when it starts. */
export async function createReplicaKey(): Promise<ReplicaKey> {
	type Key = Parameters<typeof crypto.subtle.sign>[1];
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as unknown as {
		readonly publicKey: Key;
		readonly privateKey: Key;
	};
	// A raw export is bytes (Workers' types allow a JWK for any format).
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	return {
		publicKey: base64url(raw),
		async sign(message) {
			return new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, own(message)));
		},
	};
}

/** Whether `signature` is `publicKey`'s over `message`. */
export async function verifyReplicaSignature(
	publicKey: string,
	message: Uint8Array,
	signature: string,
): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey("raw", fromBase64url(publicKey), { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify("Ed25519", key, fromBase64url(signature), own(message));
	} catch {
		return false;
	}
}

/**
 * What a replica signs for a request to another: the replica it is for (so no other replica takes it, where its nonce
 * is unknown), the operation, the time, a nonce and the body's SHA-256.
 */
export async function peerMessage(
	to: string,
	operation: string,
	at: number,
	nonce: string,
	body: string | Uint8Array,
): Promise<Uint8Array> {
	const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", own(bytes)));
	return new TextEncoder().encode(`kantel-peer/2\n${to}\n${operation}\n${at}\n${nonce}\n${base64url(digest)}`);
}

/** How long a signed request between replicas stays good. */
export const PEER_SKEW_MS = 30_000;

/**
 * Checks requests from other replicas: the signer is a live replica, its signature holds over this replica's ID and the
 * operation, the time is within `PEER_SKEW_MS` and the nonce is new (a captured request can't be played again, here or
 * on another replica).
 */
export function createPeerVerifier(options: {
	/** This replica: only requests signed for it pass. */
	readonly replicaId: string;
	readonly store: ClusterStore;
	readonly staleMs: number;
	readonly now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const seen = new Map<string, number>();
	return async (request: {
		readonly replicaId: string;
		readonly operation: string;
		readonly at: number;
		readonly nonce: string;
		readonly body: string | Uint8Array;
		readonly signature: string;
	}): Promise<boolean> => {
		const at = now();
		for (const [nonce, expires] of seen) if (expires < at) seen.delete(nonce);
		if (!Number.isFinite(request.at) || Math.abs(at - request.at) > PEER_SKEW_MS) return false;
		if (!/^[A-Za-z0-9_-]{16,64}$/.test(request.nonce) || seen.has(request.nonce)) return false;
		const replica = await options.store.getReplica(request.replicaId);
		if (replica === undefined || replica.heartbeatAt < at - options.staleMs) return false;
		const message = await peerMessage(options.replicaId, request.operation, request.at, request.nonce, request.body);
		if (!(await verifyReplicaSignature(replica.publicKey, message, request.signature))) return false;
		seen.set(request.nonce, at + 2 * PEER_SKEW_MS);
		return true;
	};
}

/** Signs a request from replica `from` to replica `to`: the headers (or query fields) the receiver checks. */
export async function signPeerRequest(
	key: ReplicaKey,
	peers: { readonly from: string; readonly to: string },
	operation: string,
	body: string | Uint8Array,
	at: number = Date.now(),
): Promise<{ replica: string; at: string; nonce: string; signature: string }> {
	const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
	const signature = base64url(await key.sign(await peerMessage(peers.to, operation, at, nonce, body)));
	return { replica: peers.from, at: String(at), nonce, signature };
}

export interface HostClusterOptions {
	readonly store: ClusterStore;
	readonly transport: PeerTransport;
	readonly replicaId: string;
	/** Where other replicas reach this one. */
	readonly url: string;
	readonly key: ReplicaKey;
	/** Default 2 s. */
	readonly heartbeatMs?: number;
	/** A replica not seen for this long is gone. Default 10 s. */
	readonly staleMs?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export interface HostCluster {
	readonly replicaId: string;
	/** This replica's hub, made to reach hosts held by other replicas too. */
	route(local: HostHub): HostHub;
	/** This replica's own hub: what a peer's request runs on. */
	local(): HostHub;
	/** A host's connection was welcomed here. */
	claim(hostId: string): Promise<void>;
	/** A host's connection here ended. */
	release(hostId: string): void;
	/** Registers this replica and keeps it fresh. */
	start(): Promise<void>;
	/** Forgets this replica and the hosts it held, so the others stop routing here. */
	stop(): Promise<void>;
	/** Refreshes now: the heartbeat, the hosts' owners, and stale connections closed. */
	tick(): Promise<void>;
}

const NOT_CONNECTED = (hostId: string) =>
	new HostCallError({ code: "unavailable", message: `Host ${hostId} is not connected` });

export function createHostCluster(options: HostClusterOptions): HostCluster {
	const { store, transport, replicaId } = options;
	const now = options.now ?? Date.now;
	const heartbeatMs = options.heartbeatMs ?? 2000;
	const staleMs = options.staleMs ?? 10_000;
	const log = options.log ?? ((message: string) => console.error(message));
	const startedAt = now();
	let localHub: HostHub | undefined;
	/** Claims made here, by host: released with their epoch. */
	const claims = new Map<string, number>();
	/** Hosts held by other live replicas, as last read. */
	let remote = new Map<string, ReplicaRecord>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;

	const hub = (): HostHub => {
		if (localHub === undefined) throw new Error("The cluster has no hub yet");
		return localHub;
	};

	/** The live replica other than this one holding the host, read now. */
	const ownerOf = async (hostId: string): Promise<ReplicaRecord | undefined> => {
		const owner = await store.getOwner(hostId);
		if (owner === undefined || owner.replicaId === replicaId) return undefined;
		const replica = await store.getReplica(owner.replicaId);
		if (replica === undefined || replica.heartbeatAt < now() - staleMs) return undefined;
		return replica;
	};

	const heartbeat = () =>
		store.putReplica({
			id: replicaId,
			url: options.url,
			publicKey: options.key.publicKey,
			startedAt,
			heartbeatAt: now(),
		});

	const tick = async () => {
		if (stopped) return;
		await heartbeat();
		const at = now();
		const live = new Map((await store.liveReplicas(at - staleMs)).map((replica) => [replica.id, replica]));
		const next = new Map<string, ReplicaRecord>();
		const owners = await store.owners();
		const owned = new Map(owners.map((owner) => [owner.hostId, owner]));
		for (const owner of owners) {
			const replica = live.get(owner.replicaId);
			if (owner.replicaId !== replicaId && replica !== undefined) next.set(owner.hostId, replica);
		}
		remote = next;
		const local = localHub;
		if (local === undefined) return;
		for (const owner of owners) {
			// A claim of this replica's whose connection is gone (its release was lost): let it go.
			if (owner.replicaId === replicaId && !local.connected(owner.hostId) && owner.claimedAt < at - staleMs) {
				claims.delete(owner.hostId);
				await store.releaseHost(owner.hostId, replicaId, owner.epoch);
			}
		}
		for (const hostId of local.connectedHosts()) {
			const owner = owned.get(hostId);
			if (owner === undefined || !live.has(owner.replicaId)) {
				// Its claim was lost (this replica was thought gone, or a stale close released it): claim it again.
				await claimHere(hostId);
			} else if (owner.replicaId !== replicaId) {
				// The host connected to another replica since: this connection is the stale one.
				claims.delete(hostId);
				log(`[cluster] host ${hostId} is held by replica ${owner.replicaId} now; closing its connection here`);
				local.disconnect(hostId, 4008, "A newer connection for the host took over");
			}
		}
		// Replicas gone without saying so: what they held is free for whichever replica the hosts reconnect to.
		if (at - startedAt > staleMs) await store.sweepReplicas(at - 3 * staleMs);
	};

	const claimHere = async (hostId: string) => {
		const epoch = await store.claimHost(hostId, replicaId, now());
		claims.set(hostId, epoch);
		remote.delete(hostId);
	};

	const safely = (what: string, work: Promise<unknown>) => {
		void work.catch((error) => log(`[cluster] ${what}: ${error instanceof Error ? error.message : String(error)}`));
	};

	return {
		replicaId,
		route(local) {
			localHub = local;
			return {
				accept: (hostId, socket) => local.accept(hostId, socket),
				connected: (hostId) => local.connected(hostId) || remote.has(hostId),
				connectedHosts: () => [...new Set([...local.connectedHosts(), ...remote.keys()])],
				async call<T>(hostId: string, method: string, params: unknown, callOptions: CallOptions = {}) {
					if (local.connected(hostId)) return local.call<T>(hostId, method, params, callOptions);
					const peer = await ownerOf(hostId);
					if (peer === undefined) throw NOT_CONNECTED(hostId);
					return (await transport.call(peer, hostId, method, params, callOptions)) as T;
				},
				async openPort(hostId, sandboxId, port, sink) {
					if (local.connected(hostId)) return local.openPort(hostId, sandboxId, port, sink);
					const peer = await ownerOf(hostId);
					if (peer === undefined) throw NOT_CONNECTED(hostId);
					return transport.openPort(peer, hostId, sandboxId, port, sink);
				},
				// A file stream isn't relayed between replicas: its host must be connected to this one.
				async openFile(hostId, params, sink) {
					if (local.connected(hostId)) return local.openFile(hostId, params, sink);
					if ((await ownerOf(hostId)) === undefined) throw NOT_CONNECTED(hostId);
					throw new HostCallError({
						code: "unavailable",
						message: `File streams need host ${hostId} connected to this gateway`,
					});
				},
				rewelcome(hostId, welcome) {
					if (local.connected(hostId)) return local.rewelcome(hostId, welcome);
					safely(
						`welcoming host ${hostId} again`,
						ownerOf(hostId).then((peer) => peer && transport.rewelcome(peer, hostId, welcome)),
					);
				},
				disconnect(hostId, code, reason) {
					local.disconnect(hostId, code, reason);
					safely(
						`disconnecting host ${hostId}`,
						ownerOf(hostId).then((peer) => peer && transport.disconnect(peer, hostId, code, reason)),
					);
				},
				closeAll: (code, reason) => local.closeAll(code, reason),
			};
		},
		local: hub,
		async claim(hostId) {
			await claimHere(hostId);
		},
		release(hostId) {
			const epoch = claims.get(hostId);
			if (epoch === undefined) return;
			claims.delete(hostId);
			safely(`releasing host ${hostId}`, store.releaseHost(hostId, replicaId, epoch));
		},
		async start() {
			stopped = false;
			await heartbeat();
			await tick();
			timer = setInterval(() => safely("heartbeat", tick()), heartbeatMs);
			(timer as { unref?: () => void }).unref?.();
		},
		async stop() {
			stopped = true;
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			claims.clear();
			await store.removeReplica(replicaId);
		},
		tick,
	};
}
