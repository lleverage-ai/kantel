// Negative probes for the gateway's shared state (TASK-4739), beside lane C's network probes in
// apps/host/test/isolation.sh: what a holder of an old, altered or revoked URL, an outsider on the replicas' network,
// or a reader of the database can and can't do. Everything runs against real gateway replicas over one database, with
// a real host connection on replica A and the attacker's requests landing on replica B (or on a restarted one).
// A probe named "(control)" is expected to succeed; the others are refusals.
import { createKantelClient } from "@kantel/api/sdk";
import type { PersonIdentity } from "@kantel/compute";
import { createReplicaKey, createSqlClusterStore, signPeerRequest } from "@kantel/hosts/cluster";
import { DESKTOP_PORT, DESKTOP_SOCKET, HOSTS_DESKTOP_PATH } from "@kantel/hosts/desktop";
import { portCookieName } from "@kantel/hosts/ports";
import { RELAY_CLOSE_REVOKED } from "@kantel/hosts/relay-access";
import type { SqlDriver } from "@kantel/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLUSTER_PATH } from "../../src/gateway/cluster.ts";
import {
	attempt,
	type Cleanup,
	closedWithin,
	connectHost,
	joinHost,
	openSession,
	type People,
	type Replica,
	type Session,
	sharedDatabase,
	startReplica,
	wsUrl,
} from "./cluster-harness.ts";

const REVOKED = `close ${RELAY_CLOSE_REVOKED}`;
/** The gate cookie over plain http, as these gateways are reached: no `__Host-` prefix. */
const PORT_COOKIE = portCookieName("http");
const PORTS_HOST = (port: number, label: string) => `${port}-${label}.kantel-ports.test`;
const tokenOf = (url: string) => new URL(url).searchParams.get("_token") ?? "";

function client(target: Replica, bearer: string) {
	const api = target.api;
	if (api === undefined) throw new Error("no compute API on this replica");
	return createKantelClient({
		baseUrl: "http://kantel.test/v1",
		token: bearer,
		fetch: (input, init) =>
			api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
	});
}

/** Two replicas with the compute API, a host on A, Tom and Ann in one organisation, and a sandbox on the host. */
async function world(cleanups: Cleanup[]) {
	const people: People = {
		byBearer: {
			"Bearer tom": { userId: "usr_tom", name: "Tom", session: "s-tom" } satisfies PersonIdentity,
			"Bearer ann": { userId: "usr_ann", name: "Ann", session: "s-ann" } satisfies PersonIdentity,
		},
		live: new Set(["s-tom", "s-ann"]),
	};
	const driver = await sharedDatabase(cleanups);
	const a = await startReplica(driver, cleanups, { people });
	const b = await startReplica(driver, cleanups, { people });
	const { hostId, credential } = await joinHost(a);
	const host = await connectHost(a, hostId, credential, cleanups);
	const tom = client(a, "tom");
	const org = await tom.createOrganisation({ name: "Acme" });
	const invite = await tom.createInvite(org.id, { role: "member" });
	await client(a, "ann").joinOrganisation({ code: invite.code ?? "" });
	await b.cluster.cluster.tick();
	/** A sandbox in the organisation, placed on the host through B. */
	const sandbox = async () => {
		const made = await tom.createSandbox({ account: org.id, wait: true });
		await b.relay.service.sandboxes.create({ tier: "microvm", sandboxId: made.id });
		return made.id;
	};
	return { driver, people, a, b, host, hostId, credential, tom, org, sandbox };
}

/** A desktop's Selkies stream on `target`, for `ticket`. */
const desktopUrl = (target: { readonly url: string }, ticket: string) =>
	wsUrl(target, `${HOSTS_DESKTOP_PATH}/${ticket}${DESKTOP_SOCKET}`);

const key = (keyId: string) => JSON.stringify({ kind: "key", keyId });
const person = (userId: string, session: string) => JSON.stringify({ kind: "person", userId, session });

describe("negative probes: a gateway restart", { timeout: 60_000 }, () => {
	const cleanups: Cleanup[] = [];
	let after: Replica;
	const issued = { ticket: "", expired: "", view: "", gatedUrl: "", hiddenUrl: "", rotatedOld: "", rotatedNew: "" };
	let sandboxId = "";
	afterAll(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	beforeAll(async () => {
		const w = await world(cleanups);
		sandboxId = await w.sandbox();
		const ports = w.b.relay.ports;
		if (ports === undefined) throw new Error("no ports");
		const grantee = person("usr_tom", "s-tom");
		issued.ticket = await w.b.relay.tickets.issue({ sandboxId, port: 22, expiresAt: Date.now() + 60_000, grantee });
		issued.expired = await w.b.relay.tickets.issue({ sandboxId, port: 22, expiresAt: Date.now() + 300, grantee });
		issued.view = await w.b.relay.tickets.issue({
			sandboxId,
			port: DESKTOP_PORT,
			expiresAt: Date.now() + 60_000,
			grantee,
			desktop: "view",
		});
		issued.gatedUrl = (
			await ports.expose(sandboxId, 3000, { public: false, subdomain: "gated-otter-aa11bb", grantee })
		).url;
		issued.hiddenUrl = (
			await ports.expose(sandboxId, 4000, { public: false, subdomain: "hidden-otter-aa11bb", grantee })
		).url;
		await ports.hide(sandboxId, 4000);
		issued.rotatedOld = (
			await ports.expose(sandboxId, 5000, { public: false, subdomain: "moved-otter-aa11bb", grantee })
		).url;
		issued.rotatedNew = (
			await ports.expose(sandboxId, 5000, { public: false, subdomain: "moved-otter-aa11bb", grantee })
		).url;
		// Every replica restarts; the host reconnects to the new one.
		await w.a.stop();
		await w.b.stop();
		after = await startReplica(w.driver, cleanups, { people: w.people });
		await connectHost(after, w.hostId, w.credential, cleanups, w.host.sandboxes());
		await new Promise((resolve) => setTimeout(resolve, 400));
	});

	const portStatus = async (url: string, token?: string) => {
		const target = new URL(url);
		target.search = "";
		const response = await after.relay.ports?.fetch(
			new Request(target, token === undefined ? {} : { headers: { cookie: `${PORT_COOKIE}=${token}` } }),
		);
		return response?.status;
	};

	it("R1 (control) a tunnel URL from before the restart still opens", async () => {
		expect(await attempt(wsUrl(after, `/v1/hosts/tunnel/${issued.ticket}`), cleanups)).toBe("opened");
	});
	it("R2 a gated port from before the restart still refuses a request without its token", async () => {
		expect(await portStatus(issued.gatedUrl)).toBe(401);
		expect(await portStatus(issued.gatedUrl, tokenOf(issued.gatedUrl))).toBe(200);
	});
	it("R3 a port's old token stays dead after it was exposed again", async () => {
		expect(await portStatus(issued.rotatedOld, tokenOf(issued.rotatedOld))).toBe(401);
		expect(await portStatus(issued.rotatedNew, tokenOf(issued.rotatedNew))).toBe(200);
	});
	it("R4 a hidden port stays hidden", async () => {
		expect(await portStatus(issued.hiddenUrl, tokenOf(issued.hiddenUrl))).toBe(404);
	});
	it("R5 an expired tunnel URL is refused", async () => {
		expect(await attempt(wsUrl(after, `/v1/hosts/tunnel/${issued.expired}`), cleanups)).toBe(REVOKED);
	});
	it("R6 a well-formed ticket nobody issued is refused", async () => {
		const [id] = issued.ticket.split(".");
		expect(await attempt(wsUrl(after, `/v1/hosts/tunnel/${id}.${"x".repeat(43)}`), cleanups)).toBe(REVOKED);
	});
	it("R7 a view-only desktop URL from before the restart opens, still only as a viewer, and never as a raw tunnel", async () => {
		expect(await attempt(desktopUrl(after, issued.view), cleanups)).toBe("opened");
		expect(await attempt(wsUrl(after, `/v1/hosts/tunnel/${issued.view}`), cleanups)).toBe(REVOKED);
	});
});

describe("negative probes: two replicas", { timeout: 60_000 }, () => {
	const cleanups: Cleanup[] = [];
	let w: Awaited<ReturnType<typeof world>>;
	let sandboxId = "";
	let ticket = "";
	afterAll(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});
	beforeAll(async () => {
		w = await world(cleanups);
		sandboxId = await w.sandbox();
		ticket = await w.a.relay.tickets.issue({ sandboxId, port: 22, expiresAt: Date.now() + 60_000 });
	});

	/** A replica of the attacker's own, registered as live (as one with write access to the database could). */
	const intruder = async (driver: SqlDriver) => {
		const signing = await createReplicaKey();
		const store = createSqlClusterStore(driver);
		const at = Date.now();
		await store.putReplica({
			id: "rep_probe",
			url: "http://127.0.0.1:9",
			publicKey: signing.publicKey,
			startedAt: at,
			heartbeatAt: at,
		});
		return signing;
	};
	const peerPost = async (target: Replica, operation: string, body: string, headers: Record<string, string>) => {
		const response = await fetch(`${target.url}${CLUSTER_PATH}/${operation}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body,
		});
		return { status: response.status, text: await response.text() };
	};
	const signed = (made: { replica: string; at: string; nonce: string; signature: string }) => ({
		"x-kantel-replica": made.replica,
		"x-kantel-at": made.at,
		"x-kantel-nonce": made.nonce,
		"x-kantel-signature": made.signature,
	});

	it("M1 (control) a tunnel URL replica A issued opens on replica B, through A to the host", async () => {
		expect(await attempt(wsUrl(w.b, `/v1/hosts/tunnel/${ticket}`), cleanups)).toBe("opened");
	});
	it("M2 the same URL with its secret altered is refused on B", async () => {
		const altered = `${ticket.slice(0, -2)}${ticket.endsWith("AA") ? "BB" : "AA"}`;
		expect(await attempt(wsUrl(w.b, `/v1/hosts/tunnel/${altered}`), cleanups)).toBe(REVOKED);
	});
	it("M3 another ticket's ID with this secret is refused on B", async () => {
		const other = await w.b.relay.tickets.issue({ sandboxId, port: 5901, expiresAt: Date.now() + 60_000 });
		const mixed = `${other.split(".")[0]}.${ticket.split(".")[1]}`;
		expect(await attempt(wsUrl(w.b, `/v1/hosts/tunnel/${mixed}`), cleanups)).toBe(REVOKED);
	});
	it("M4 an unsigned call between replicas is a 404", async () => {
		const body = JSON.stringify({ hostId: w.hostId, method: "sandbox.exec", params: { sandboxId } });
		expect((await peerPost(w.a, "call", body, {})).status).toBe(404);
	});
	it("M5 a call signed with a key no live replica registered is a 404", async () => {
		const stranger = await createReplicaKey();
		const body = JSON.stringify({ hostId: w.hostId, method: "sandbox.exec", params: { sandboxId } });
		const to = w.a.cluster.cluster.replicaId;
		const made = await signPeerRequest(stranger, { from: w.b.cluster.cluster.replicaId, to }, "call", body);
		expect((await peerPost(w.a, "call", body, signed(made))).status).toBe(404);
	});
	it("M6 a signed call is taken once: played again, with an old time or for another operation, it is a 404", async () => {
		const signing = await intruder(w.driver);
		const body = JSON.stringify({ hostId: w.hostId, method: "sandbox.exec", params: { sandboxId } });
		const toA = { from: "rep_probe", to: w.a.cluster.cluster.replicaId };
		const made = signed(await signPeerRequest(signing, toA, "call", body));
		const first = await peerPost(w.a, "call", body, made);
		expect(first.status).toBe(200);
		expect(first.text).toContain('"exitCode":0');
		expect((await peerPost(w.a, "call", body, made)).status).toBe(404);
		const old = signed(await signPeerRequest(signing, toA, "call", body, Date.now() - 60_000));
		expect((await peerPost(w.a, "call", body, old)).status).toBe(404);
		const elsewhere = signed(await signPeerRequest(signing, toA, "call", body));
		expect((await peerPost(w.a, "disconnect", body, elsewhere)).status).toBe(404);
	});
	it("M10 a signed call captured on its way to one replica is a 404 on another, which hasn't seen its nonce", async () => {
		const signing = await intruder(w.driver);
		const body = JSON.stringify({ hostId: w.hostId, method: "sandbox.exec", params: { sandboxId } });
		const forB = signed(
			await signPeerRequest(signing, { from: "rep_probe", to: w.b.cluster.cluster.replicaId }, "call", body),
		);
		const before = w.host.calls.length;
		expect((await peerPost(w.a, "call", body, forB)).status).toBe(404);
		expect(w.host.calls.length).toBe(before);
	});
	it("M7 an unsigned port stream between replicas is a 404 (close 4404)", async () => {
		const url = wsUrl(w.a, `${CLUSTER_PATH}/port?host=${w.hostId}&sandbox=${sandboxId}&port=22`);
		const before = w.host.calls.length;
		expect(await attempt(url, cleanups)).toBe("close 4404");
		expect(w.host.calls.length).toBe(before);
	});
	it("M8 a replica serves only hosts connected to itself: a call never bounces on", async () => {
		const signing = await intruder(w.driver);
		const body = JSON.stringify({ hostId: w.hostId, method: "sandbox.exec", params: { sandboxId } });
		const before = w.host.calls.length;
		const toB = { from: "rep_probe", to: w.b.cluster.cluster.replicaId };
		const answer = await peerPost(w.b, "call", body, signed(await signPeerRequest(signing, toB, "call", body)));
		expect(answer.text).toContain('"code":"unavailable"');
		expect(w.host.calls.length).toBe(before);
	});
	it("M9 a host credential revoked on B closes the host's connection on A, and it can't come back on either", async () => {
		const extra = await joinHost(w.b);
		const connected = await connectHost(w.a, extra.hostId, extra.credential, cleanups);
		await w.b.relay.service.revoke(extra.hostId);
		expect(await connected.closed).toBe(4003);
		const again = new WebSocket(wsUrl(w.b, "/v1/hosts/connect"), {
			headers: { authorization: `Bearer ${extra.credential}` },
		});
		cleanups.push(() => again.terminate());
		expect(await new Promise((resolve) => again.on("close", (code) => resolve(code)))).toBe(4003);
	});
});

describe("negative probes: revoking access across replicas", { timeout: 60_000 }, () => {
	const cleanups: Cleanup[] = [];
	let w: Awaited<ReturnType<typeof world>>;
	afterAll(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});
	beforeAll(async () => {
		w = await world(cleanups);
	});

	/** A session of each kind on replica B for `grantee`; the host is on A. */
	const sessionsOn = async (sandboxId: string, grantee: string, label: string) => {
		const expiresAt = Date.now() + 10 * 60_000;
		const ticket = (port: number) => w.b.relay.tickets.issue({ sandboxId, port, expiresAt, grantee });
		const tunnel = (path: string) => wsUrl(w.b, `/v1/hosts/tunnel/${path}`);
		const ports = w.b.relay.ports;
		if (ports === undefined) throw new Error("no ports");
		const exposed = await ports.expose(sandboxId, 5173, { public: false, subdomain: label, grantee });
		const token = tokenOf(exposed.url);
		const portHeaders = { host: PORTS_HOST(5173, label), cookie: `${PORT_COOKIE}=${token}` };
		const desktopTicket = await w.b.relay.tickets.issue({
			sandboxId,
			port: DESKTOP_PORT,
			expiresAt,
			grantee,
			desktop: "control",
		});
		const opened = {
			ssh: await openSession(tunnel(await ticket(22)), cleanups),
			desktop: await openSession(desktopUrl(w.b, desktopTicket), cleanups),
			cdp: await openSession(tunnel(`${await ticket(9222)}/devtools/browser/abc`), cleanups),
			port: await openSession(wsUrl(w.b, "/hmr"), cleanups, portHeaders),
		};
		const http = async () =>
			(
				await ports.fetch(
					new Request(`http://${PORTS_HOST(5173, label)}/`, { headers: { cookie: `${PORT_COOKIE}=${token}` } }),
				)
			)?.status;
		return { opened, http, desktopTicket, portHeaders };
	};
	const cut = (session: Session) => closedWithin(session, 3000);

	describe("an API key revoked on replica A", () => {
		let s: Awaited<ReturnType<typeof sessionsOn>>;
		beforeAll(async () => {
			const sandboxId = await w.sandbox();
			const issued = await w.tom.createApiKey({ account: w.org.id, name: "agent", preset: "agent" });
			s = await sessionsOn(sandboxId, key(issued.key.id), "keyed-otter-aa11bb");
			expect(await s.http()).toBe(200);
			await w.tom.revokeApiKey(issued.key.id);
		});
		it("V1 cuts its SSH session on B", async () => expect(await cut(s.opened.ssh)).toBe(RELAY_CLOSE_REVOKED));
		it("V2 cuts its desktop session on B", async () => expect(await cut(s.opened.desktop)).toBe(RELAY_CLOSE_REVOKED));
		it("V3 cuts its CDP session on B", async () => expect(await cut(s.opened.cdp)).toBe(RELAY_CLOSE_REVOKED));
		it("V4 cuts its exposed port's WebSocket on B", async () =>
			expect(await cut(s.opened.port)).toBe(RELAY_CLOSE_REVOKED));
		it("V5 refuses its exposed port's HTTP", async () => {
			await new Promise((resolve) => setTimeout(resolve, 1100));
			expect(await s.http()).toBe(403);
		});
		it("V6 refuses a new connection with a URL it was given", async () => {
			expect(await attempt(desktopUrl(w.b, s.desktopTicket), cleanups)).toBe(REVOKED);
			expect(await attempt(wsUrl(w.b, "/hmr"), cleanups, s.portHeaders)).toBe("close 4403");
		});
	});

	it("V7 a person signing out ends their sessions on B, and V8 not another person's (control)", async () => {
		const sandboxId = await w.sandbox();
		const tom = await sessionsOn(sandboxId, person("usr_tom", "s-tom"), "signed-otter-aa11bb");
		const ann = await sessionsOn(sandboxId, person("usr_ann", "s-ann"), "staying-otter-aa11bb");
		w.people.live.delete("s-tom");
		try {
			expect(await cut(tom.opened.ssh)).toBe(RELAY_CLOSE_REVOKED);
			expect(await closedWithin(ann.opened.ssh, 500)).toBe("open");
		} finally {
			w.people.live.add("s-tom");
		}
	});

	it("V9 removing a member from the organisation ends their sessions on B", async () => {
		const sandboxId = await w.sandbox();
		const ann = await sessionsOn(sandboxId, person("usr_ann", "s-ann"), "removed-otter-aa11bb");
		await w.tom.removeMember(w.org.id, "usr_ann");
		expect(await cut(ann.opened.desktop)).toBe(RELAY_CLOSE_REVOKED);
		expect(await cut(ann.opened.port)).toBe(RELAY_CLOSE_REVOKED);
	});

	it("V10 deleting the sandbox ends the sessions to it on B", async () => {
		const sandboxId = await w.sandbox();
		const tom = await sessionsOn(sandboxId, person("usr_tom", "s-tom"), "deleted-otter-aa11bb");
		await w.tom.stopSandbox(sandboxId, { wait: true });
		await w.tom.deleteSandbox(sandboxId);
		expect(await cut(tom.opened.ssh)).toBe(RELAY_CLOSE_REVOKED);
	});

	it("V11 when the access check can't answer, it fails closed", async () => {
		const sandboxId = await w.sandbox();
		const broken = await startReplica(w.driver, cleanups, {
			stillAllowed: () => Promise.reject(new Error("the database is unreachable")),
		});
		const ticket = await broken.relay.tickets.issue({
			sandboxId,
			port: 22,
			expiresAt: Date.now() + 60_000,
			grantee: person("usr_tom", "s-tom"),
		});
		expect(await attempt(wsUrl(broken, `/v1/hosts/tunnel/${ticket}`), cleanups)).toBe(REVOKED);
	});
});

describe("negative probes: secrets at rest and in logs", { timeout: 60_000 }, () => {
	const cleanups: Cleanup[] = [];
	afterAll(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("S1 no row holds a tunnel ticket's secret, an exposed port's token or a replica's private key, and S2 no log line does", async () => {
		const w = await world(cleanups);
		const sandboxId = await w.sandbox();
		const ticket = await w.b.relay.tickets.issue({ sandboxId, port: 22, expiresAt: Date.now() + 60_000 });
		const exposed = await w.b.relay.ports?.expose(sandboxId, 3000, { public: false, subdomain: "secret-otter-aa11bb" });
		const secrets = [ticket.split(".")[1] ?? "", ticket, tokenOf(exposed?.url ?? "")];
		expect(secrets.every((secret) => secret.length >= 32)).toBe(true);
		await attempt(wsUrl(w.b, `/v1/hosts/tunnel/${ticket}`), cleanups);
		const rows = [
			...(await w.driver.query("SELECT * FROM compute_relay_tickets")),
			...(await w.driver.query("SELECT * FROM compute_port_exposures")),
			...(await w.driver.query("SELECT * FROM compute_gateway_replicas")),
			...(await w.driver.query("SELECT * FROM compute_host_owners")),
		];
		const stored = JSON.stringify(rows);
		for (const secret of secrets) expect(stored).not.toContain(secret);
		expect(Object.keys((await w.driver.query("SELECT * FROM compute_gateway_replicas"))[0] ?? {}).sort()).toEqual([
			"heartbeat_at",
			"id",
			"public_key",
			"started_at",
			"url",
		]);
		const logged = [...w.a.logs, ...w.b.logs].join("\n");
		for (const secret of secrets) expect(logged).not.toContain(secret);
	});
});
