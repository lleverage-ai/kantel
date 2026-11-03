// Revoking access ends the sessions already open, on every gateway replica, within seconds: two replicas share one
// database (the compute API's records and the relay's tickets and exposed ports). A key is revoked, a person signs
// out or is removed from the organisation on replica A; their desktop, SSH, CDP and exposed-port sessions open on
// replica B are closed with 4003, and new ones are refused. Each session type is a real WebSocket through B's upgrade
// handler to a fake sandbox port.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createKantelClient } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, encodeGrantee, type PersonIdentity } from "@kantel/compute";
import { createSqlComputeStore, migrateComputeStore } from "@kantel/compute/sql";
import { createStubBackend } from "@kantel/compute/stub";
import { DESKTOP_PORT, DESKTOP_SOCKET, HOSTS_DESKTOP_PATH } from "@kantel/hosts/desktop";
import type { PortSink } from "@kantel/hosts/hub";
import { PORT_COOKIE } from "@kantel/hosts/ports";
import { RELAY_CLOSE_REVOKED } from "@kantel/hosts/relay-access";
import { createSqlRelayStore, migrateRelay } from "@kantel/hosts/relay-store";
import type { HostsService } from "@kantel/hosts/service";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type GatewayHostsBackend, gatewayRelay, withHostUpgrades } from "../../src/gateway/compute.ts";
import { closeServer } from "./close-server.ts";

const cleanups: (() => Promise<void> | void)[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) client.terminate();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A sandbox port: raw bytes echo back; a WebSocket handshake (CDP, a dev server) is answered and says "hi"; any other
 * HTTP request is answered 200.
 */
function sandboxPort(_sandboxId: string, _port: number, sink: PortSink) {
	let websocket = false;
	return Promise.resolve({
		stream: 1,
		write(bytes: Uint8Array) {
			// After its handshake, a WebSocket server here says nothing more.
			if (websocket) return;
			const text = new TextDecoder().decode(bytes);
			if (text.startsWith("GET ") && !/upgrade: websocket/i.test(text)) {
				sink.data(new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
				sink.end("closed");
				return;
			}
			if (text.startsWith("GET ")) {
				websocket = true;
				const key = /Sec-WebSocket-Key: (\S+)/.exec(text)?.[1] ?? "";
				const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
				sink.data(
					new TextEncoder().encode(
						`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
					),
				);
				sink.data(new Uint8Array([0x81, 0x02, 0x68, 0x69]));
				return;
			}
			sink.data(bytes);
		},
		close() {},
	});
}

const TOM: PersonIdentity = { userId: "usr_tom", name: "Tom" };
const ANN: PersonIdentity = { userId: "usr_ann", name: "Ann" };

/** Two gateway replicas over one database, each with its compute API and its relay. */
async function cluster() {
	const database = await pgliteDatabase.open();
	cleanups.push(() => database.close());
	await migrateComputeStore(database.driver);
	await migrateRelay(database.driver);
	/** Live Kantel sessions, as the shared sessions table holds them. */
	const live = new Set(["session-tom", "session-ann"]);
	const people: { [bearer: string]: PersonIdentity } = {
		"Bearer tom": { ...TOM, session: "session-tom" },
		"Bearer ann": { ...ANN, session: "session-ann" },
	};
	const replica = async () => {
		const service = { authenticate: async () => undefined, sandboxes: { openPort: sandboxPort } };
		const hosts: GatewayHostsBackend = gatewayRelay(
			{ publicUrl: "http://gateway.test", portsDomain: "kantel-ports.test" },
			service as unknown as HostsService,
			createSqlRelayStore(database.driver),
			{ intervalMs: 100 },
		);
		const api: ComputeApi = createComputeApi({
			store: createSqlComputeStore(database.driver),
			backend: createStubBackend(),
			authenticatePerson: async (request) => people[request.headers.get("authorization") ?? ""],
			sessionLive: async (session) => live.has(session),
			fetch: async () => new Response(null, { status: 204 }),
		});
		cleanups.push(() => api.close());
		hosts.bind((grantee, sandboxId) => api.service.stillAllowed(grantee, sandboxId));
		hosts.access.start();
		cleanups.push(() => hosts.access.stop());
		const upgrades = withHostUpgrades(hosts, undefined);
		const server: Server = createServer((_, response) => response.writeHead(404).end());
		server.on("upgrade", (incoming, socket, head) => upgrades?.(incoming, socket, head));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => closeServer(server));
		const { port } = server.address() as AddressInfo;
		const client = (token: string) =>
			createKantelClient({
				baseUrl: "http://gateway.test/v1",
				token,
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
		return { hosts, api, client, address: `ws://127.0.0.1:${port}` };
	};
	return { a: await replica(), b: await replica(), live };
}

interface Opened {
	readonly socket: WebSocket;
	/** Resolves with the close code. */
	readonly closed: Promise<number>;
}

/** Opens a WebSocket and waits for its first message (the echo, or the port's "hi"). */
function open(url: string, headers: Record<string, string> = {}): Promise<Opened> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers });
		clients.push(socket);
		const closed = new Promise<number>((done) => socket.on("close", (code) => done(code)));
		socket.on("open", () => socket.send(Buffer.from("ping"), { binary: true }));
		socket.once("message", () => resolve({ socket, closed }));
		socket.on("error", reject);
		closed.then((code) => reject(new Error(`closed with ${code} before a message`)));
	});
}

/**
 * Every session type on replica B for one grantee: the desktop (Selkies' stream on its own route, driving and
 * watching), SSH (raw), CDP (passed through), a port's WebSocket.
 */
async function sessions(b: Awaited<ReturnType<typeof cluster>>["b"], sandboxId: string, grantee: string) {
	const expiresAt = Date.now() + 10 * 60_000;
	const ticket = (port: number, desktop?: "control" | "view") =>
		b.hosts.tickets.issue({ sandboxId, port, expiresAt, grantee, ...(desktop === undefined ? {} : { desktop }) });
	const tunnel = `${b.address}/v1/hosts/tunnel`;
	const desktop = async (mode: "control" | "view") =>
		`${b.address}${HOSTS_DESKTOP_PATH}/${await ticket(DESKTOP_PORT, mode)}${DESKTOP_SOCKET}`;
	const ports = b.hosts.ports;
	if (ports === undefined) throw new Error("no ports");
	const exposed = await ports.expose(sandboxId, 5173, { public: false, subdomain: "brave-otter-ab12cd", grantee });
	const token = new URL(exposed.url).searchParams.get("_token") ?? "";
	const host = "5173-brave-otter-ab12cd.kantel-ports.test";
	const opened = {
		desktop: await open(await desktop("control")),
		watching: await open(await desktop("view")),
		ssh: await open(`${tunnel}/${await ticket(22)}`),
		cdp: await open(`${tunnel}/${await ticket(9222)}/devtools/browser/abc`),
		port: await open(`${b.address}/hmr`, { host, cookie: `${PORT_COOKIE}=${token}` }),
	};
	const again = async () => ({
		desktop: await refusedWith(await desktop("control")),
		port: await refusedWith(`${b.address}/hmr`, { host, cookie: `${PORT_COOKIE}=${token}` }),
	});
	return {
		opened,
		again,
		httpPort: () => ports.fetch(new Request(`http://${host}/`, { headers: { cookie: `${PORT_COOKIE}=${token}` } })),
	};
}

/** How a new connection is refused: its close code (an HTTP status would mean the gateway answered one, which it never does on an upgrade). */
function refusedWith(url: string, headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve) => {
		const socket = new WebSocket(url, { headers });
		clients.push(socket);
		socket.on("close", (code) => resolve(`close ${code}`));
		socket.on("unexpected-response", (_request, response) => resolve(`http ${response.statusCode}`));
		socket.on("error", () => undefined);
		socket.on("message", () => resolve("opened"));
	});
}

const within = (promise: Promise<number>, ms: number) =>
	Promise.race([promise, new Promise<number>((_, reject) => setTimeout(() => reject(new Error("still open")), ms))]);

async function expectAllCut(opened: { [kind: string]: Opened }) {
	const codes = await Promise.all(Object.values(opened).map((session) => within(session.closed, 3000)));
	expect(Object.fromEntries(Object.keys(opened).map((kind, index) => [kind, codes[index]]))).toEqual(
		Object.fromEntries(Object.keys(opened).map((kind) => [kind, RELAY_CLOSE_REVOKED])),
	);
}

describe("revoking access across gateway replicas", { timeout: 30_000 }, () => {
	it("cuts a revoked API key's desktop, SSH, CDP and port sessions on the other replica", async () => {
		const { a, b } = await cluster();
		const tom = a.client("tom");
		const sandbox = await tom.createSandbox({ wait: true });
		const issued = await tom.createApiKey({ name: "agent", preset: "agent" });
		const grantee = encodeGrantee({
			kind: "key",
			keyId: issued.key.id,
			keyName: "agent",
			accountId: sandbox.accountId,
			scopes: [],
			limits: {},
			userId: TOM.userId,
			superAdmin: false,
		});
		const { opened, again, httpPort } = await sessions(b, sandbox.id, grantee);
		expect((await httpPort())?.status).toBe(200);

		await tom.revokeApiKey(issued.key.id);
		await expectAllCut(opened);
		expect(await again()).toEqual({ desktop: `close ${RELAY_CLOSE_REVOKED}`, port: "close 4403" });
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect((await httpPort())?.status).toBe(403);
	});

	it("cuts a person's sessions when they sign out, and not another person's", async () => {
		const { a, b, live } = await cluster();
		const org = await a.client("tom").createOrganisation({ name: "Acme" });
		const invite = await a.client("tom").createInvite(org.id, { role: "member" });
		await a.client("ann").joinOrganisation({ code: invite.code ?? "" });
		const sandbox = await a.client("tom").createSandbox({ account: org.id, wait: true });
		const person = (identity: PersonIdentity, personalAccountId: string) =>
			encodeGrantee({ kind: "person", ...identity, superAdmin: false, personalAccountId });
		const tomSessions = await sessions(b, sandbox.id, person({ ...TOM, session: "session-tom" }, ""));
		const ann = await b.hosts.tickets.issue({
			sandboxId: sandbox.id,
			port: 22,
			expiresAt: Date.now() + 60_000,
			grantee: person({ ...ANN, session: "session-ann" }, ""),
		});
		const annSsh = await open(`${b.address}/v1/hosts/tunnel/${ann}`);

		live.delete("session-tom");
		await expectAllCut(tomSessions.opened);
		// Ann is still signed in: her session stays up.
		await expect(within(annSsh.closed, 500)).rejects.toThrow("still open");
		annSsh.socket.close();
	});

	it("cuts a member's sessions when they are removed from the organisation", async () => {
		const { a, b } = await cluster();
		const org = await a.client("tom").createOrganisation({ name: "Acme" });
		const invite = await a.client("tom").createInvite(org.id, { role: "member" });
		await a.client("ann").joinOrganisation({ code: invite.code ?? "" });
		const sandbox = await a.client("tom").createSandbox({ account: org.id, wait: true });
		const grantee = encodeGrantee({
			kind: "person",
			...ANN,
			session: "session-ann",
			superAdmin: false,
			personalAccountId: "",
		});
		const { opened, again } = await sessions(b, sandbox.id, grantee);

		await a.client("tom").removeMember(org.id, ANN.userId);
		await expectAllCut(opened);
		expect(await again()).toEqual({ desktop: `close ${RELAY_CLOSE_REVOKED}`, port: "close 4403" });
	});
});
