// Kantel Connect on the Worker's gateway, in Node: with KANTEL_CONNECT=experimental an Access person enrols a machine
// into their personal account, the host registers with no sign-in and connects its WebSocket to the stack object (here,
// straight to the hub the object hands sockets to), and the account's sandboxes run on it while an organisation with no
// host of its own keeps the stub. Off, none of it is served and the Worker is as it was.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { HostSocket } from "@kantel/hosts/hub";
import { decodeStreamFrame, encodeStreamFrame, type HostMessage } from "@kantel/hosts/protocol";
import { createMockAccess } from "@kantel/identity/testing";
import type { SqlValue } from "@kantel/sql";
import { afterEach, describe, expect, it } from "vitest";
import { type ObjectSqlLike, objectSqlDriver } from "../src/audit-outbox.ts";
import { hostCredential, type MessageSocket, onMessages, tunnelTicket } from "../src/compute.ts";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { createStack } from "../src/stack.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
const BASE = "https://kantel.test";

function objectSql(db: DatabaseSync) {
	const sql: ObjectSqlLike = {
		exec(query: string, ...bindings: SqlValue[]) {
			const statement = db.prepare(query);
			const values = bindings as SQLInputValue[];
			let rows: unknown[] = [];
			if (statement.columns().length > 0) rows = statement.all(...values);
			else statement.run(...values);
			return { toArray: () => rows };
		},
	};
	return objectSqlDriver(sql, <T>(work: () => T): T => {
		db.exec("BEGIN");
		try {
			const result = work();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

async function start(db: DatabaseSync, vars: { KANTEL_CONNECT?: string; KANTEL_PUBLIC_URL?: string } = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		KANTEL_ACCESS_AUD: AUD,
		KANTEL_ADMIN_EMAIL: ADMIN,
		...vars,
	});
	const stack = await createStack({ config, accessFetch: mock.fetch, storage: { compute: objectSql(db) } });
	closers.push(() => stack.compute.close());
	const gateway = createGateway(stack);
	const signedIn = { "cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN }) };
	/** A call as the Access person, or with `headers` instead (a host has no sign-in). */
	const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = signedIn) => {
		const response = await gateway.fetch(
			new Request(`${BASE}${path}`, {
				method,
				redirect: "manual",
				headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			body: (text === "" || !text.startsWith("{") ? {} : JSON.parse(text)) as Record<string, unknown>,
		};
	};
	return { stack, call };
}

/** kantel-host as the hub sees it over its WebSocket: it says hello, then runs sandboxes and an `echo`. */
function fakeHost() {
	const sandboxes = new Set<string>();
	const calls: string[] = [];
	let closed: { code: number; reason: string } | undefined;
	let receive: (frame: string | Uint8Array) => void = () => undefined;
	const socket: HostSocket = {
		sendText(text) {
			const message = JSON.parse(text) as HostMessage;
			if (message.type !== "call") return;
			calls.push(message.method ?? "");
			const params = message.params as { sandboxId: string; command?: string };
			const answer = (result: unknown) => receive(JSON.stringify({ type: "result", id: message.id, result }));
			if (message.method === "sandbox.create") {
				sandboxes.add(params.sandboxId);
				return answer({ id: params.sandboxId, tier: "microvm", size: "default", state: "running", createdAt: 1 });
			}
			if (message.method === "sandbox.exec") {
				const echo = /^echo (.*)$/.exec(params.command ?? "");
				return answer({ exitCode: 0, stdout: `${echo?.[1] ?? ""} from my own machine\n`, stderr: "" });
			}
			// A port: what comes in on its stream goes back out, uppercased (an SSH server stands in).
			if (message.method === "port.open") return answer({});
			receive(JSON.stringify({ type: "result", id: message.id, error: { code: "unsupported", message: "no" } }));
		},
		sendBinary(bytes) {
			const frame = decodeStreamFrame(bytes);
			if (frame === undefined) return;
			const text = new TextDecoder().decode(frame.payload).toUpperCase();
			receive(encodeStreamFrame(frame.stream, new TextEncoder().encode(text)));
		},
		close(code, reason) {
			closed = { code, reason };
		},
	};
	const hello = (hostId: string) =>
		JSON.stringify({
			type: "hello",
			hello: {
				hostId,
				facts: {
					version: "0.4.0",
					protocol: 1,
					os: "linux",
					arch: "amd64",
					kernel: "6.8",
					hostname: "toms-box",
					cpus: 8,
					memoryMiB: 16_384,
					diskGiB: 200,
					kvm: true,
					nested: false,
					tiers: ["microvm"],
					sizes: [{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 }],
					egress: "open",
				},
				sandboxes: [],
				capacity: { freeMemoryMiB: 14_000, freeDiskGiB: 180, running: 0, stopped: 0, load1: 0, warm: {} },
			},
		});
	return {
		socket,
		sandboxes,
		calls,
		closed: () => closed,
		/** Hands the hub's `receive` over, then says hello. */
		attach(held: { receive(frame: string | Uint8Array): void }, hostId: string) {
			receive = (frame) => held.receive(frame);
			receive(hello(hostId));
		},
	};
}

describe("Kantel Connect on the Worker", () => {
	it("is off by default: no host routes, no Connect routes, the stub as before", async () => {
		const { stack, call } = await start(new DatabaseSync(":memory:"));
		expect(stack.compute.hosts).toBeUndefined();
		expect((await call("POST", "/v1/connect/enrolments", {})).body).toMatchObject({
			error: { code: "not_supported" },
		});
		expect((await call("POST", "/v1/hosts/register", { token: "kth_x" }, {})).status).toBe(404);
		expect((await call("GET", "/v1/hosts/images/manifest.json", undefined, {})).status).toBe(404);
	});

	it("reads a socket's binary messages as bytes, a Blob too, in the order they came", async () => {
		let listener: ((event: { readonly data: unknown }) => void) | undefined;
		const socket: MessageSocket = { addEventListener: (_type, handle) => (listener = handle) };
		const frames: (string | number[])[] = [];
		onMessages(socket, (frame) => frames.push(typeof frame === "string" ? frame : [...frame]));
		expect(socket.binaryType).toBe("arraybuffer");
		listener?.({ data: new Blob([new Uint8Array([1, 2])]) });
		listener?.({ data: "text" });
		listener?.({ data: new Uint8Array([3]).buffer });
		await expect.poll(() => frames.length).toBe(3);
		expect(frames).toEqual([[1, 2], "text", [3]]);
	});

	it("needs KANTEL_PUBLIC_URL with the switch on, and refuses a switch it doesn't know", () => {
		const access = { KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, KANTEL_ACCESS_AUD: AUD };
		expect(gatewayConfig({ ...access, KANTEL_CONNECT: "off" }).connect).toBeUndefined();
		expect(() => gatewayConfig({ ...access, KANTEL_CONNECT: "experimental" })).toThrow(/KANTEL_PUBLIC_URL/);
		expect(() => gatewayConfig({ ...access, KANTEL_CONNECT: "yes", KANTEL_PUBLIC_URL: BASE })).toThrow(
			/KANTEL_CONNECT/,
		);
		expect(gatewayConfig({ ...access, KANTEL_CONNECT: "experimental", KANTEL_PUBLIC_URL: `${BASE}/` }).connect).toEqual(
			{ publicUrl: BASE },
		);
	});

	it("enrols a host into the person's account and runs that account's sandboxes on it, others' on the stub", async () => {
		const db = new DatabaseSync(":memory:");
		const on = { KANTEL_CONNECT: "experimental", KANTEL_PUBLIC_URL: BASE };
		const { stack, call } = await start(db, on);
		const hosts = stack.compute.hosts;
		if (hosts === undefined) throw new Error("Connect is on");

		const whoami = await call("GET", "/v1/whoami");
		const personal = whoami.body.accountId as string;
		const enrolment = await call("POST", "/v1/connect/enrolments", { name: "toms-box" });
		expect(enrolment.status).toBe(201);
		expect(enrolment.body).toMatchObject({ accountId: personal });
		const token = enrolment.body.token as string;
		expect(enrolment.body.command).toContain(`--url ${BASE} --token ${token}`);

		// kantel-host install fetches Kantel's images through the Worker, and registers, with no sign-in.
		const manifest = await call("GET", "/v1/hosts/images/manifest.json", undefined, {});
		expect(manifest.status).toBe(302);
		expect(manifest.headers.get("location")).toMatch(/releases\/download\/host-images-[0-9.]+\/manifest\.json$/);
		const registered = await call("POST", "/v1/hosts/register", { token }, {});
		expect(registered.status).toBe(201);
		const { hostId, credential } = registered.body as { hostId: string; credential: string };
		expect((await call("POST", "/v1/hosts/register", { token }, {})).status).toBe(403);

		// A wrong credential's socket is closed with 4003, kantel-host's "stop, don't retry".
		const stranger = fakeHost();
		expect(await hosts.connect("khc_wrong", stranger.socket)).toBeUndefined();
		expect(stranger.closed()?.code).toBe(4003);
		expect(await hosts.connect(undefined, fakeHost().socket)).toBeUndefined();

		// The host's own connection, as the stack object accepts it.
		const request = new Request(`${BASE}/v1/hosts/connect`, { headers: { authorization: `Bearer ${credential}` } });
		const host = fakeHost();
		const held = await hosts.connect(hostCredential(request), host.socket);
		if (held === undefined) throw new Error("The host's credential was refused");
		host.attach(held, hostId);
		await expect.poll(() => hosts.service.hub.connected(hostId)).toBe(true);

		const listed = await call("GET", "/v1/connect/hosts");
		expect(listed.body.items).toMatchObject([{ id: hostId, name: "toms-box", state: "online", accountId: personal }]);

		// The person's sandbox goes on their machine, and its command runs there.
		const sandbox = await call("POST", "/v1/sandboxes", { type: "microvm", wait: true });
		expect(sandbox.status).toBe(201);
		const sandboxId = sandbox.body.id as string;
		expect(host.sandboxes.has(sandboxId)).toBe(true);
		const run = await call("POST", `/v1/sandboxes/${sandboxId}/commands`, { command: "echo hello" });
		expect(run.body).toMatchObject({ exitCode: 0, stdout: "hello from my own machine\n" });

		// SSH: the ticket's raw tunnel reaches the sandbox's port 22 over the host's connection.
		const ssh = await call("POST", `/v1/sandboxes/${sandboxId}/ssh`, {});
		expect(ssh.status).toBe(201);
		const proxyUrl = new URL(ssh.body.proxyUrl as string);
		expect(proxyUrl.origin).toBe(BASE.replace("https", "wss"));
		const ticket = tunnelTicket(proxyUrl.pathname);
		if (ticket === undefined) throw new Error(`Not a tunnel URL: ${proxyUrl.href}`);
		const heard: string[] = [];
		const tunnel = await hosts.tunnel(ticket, {
			send: (bytes) => heard.push(new TextDecoder().decode(bytes)),
			close: () => undefined,
		});
		if (tunnel === undefined) throw new Error("The tunnel was refused");
		tunnel.write(new TextEncoder().encode("ssh-2.0-client"));
		await expect.poll(() => heard.join("")).toBe("SSH-2.0-CLIENT");
		tunnel.close();
		const refused: number[] = [];
		const forged = `${ticket.slice(0, -4)}AAAA`;
		expect(await hosts.tunnel(forged, { send: () => undefined, close: (code) => refused.push(code) })).toBeUndefined();
		expect(refused).toEqual([4003]);
		expect(tunnelTicket(`${proxyUrl.pathname}/json/version`)).toBeUndefined();

		// An organisation with no host of its own keeps the stub.
		const org = await call("POST", "/v1/accounts", { name: "Acme" });
		const orgId = org.body.id as string;
		const elsewhere = await call("POST", "/v1/sandboxes", { account: orgId, type: "isolate", wait: true });
		expect(elsewhere.status).toBe(201);
		expect(host.sandboxes.has(elsewhere.body.id as string)).toBe(false);
		const stubbed = await call("POST", `/v1/sandboxes/${elsewhere.body.id as string}/commands`, {
			command: "echo on the stub",
		});
		expect(stubbed.body).toMatchObject({ exitCode: 0, stdout: "on the stub\n" });
		expect((await call("GET", `/v1/connect/hosts?account=${orgId}`)).body.items).toEqual([]);

		// Removed: revoked, its connection closed.
		const removed = await call("DELETE", `/v1/connect/hosts/${hostId}`);
		expect(removed.body).toMatchObject({ state: "revoked" });
		expect(host.closed()?.code).toBe(4003);

		// The registry is in the object's SQLite: after the object is evicted, the host is still the account's. (The
		// identity directory here is in memory, so the person signs in afresh; the registry is what's checked.)
		await stack.compute.close();
		const again = await start(db, on);
		const kept = await again.stack.compute.hosts?.service.get(hostId);
		expect(kept).toMatchObject({ id: hostId, accountId: personal, state: "revoked" });
	});
});
