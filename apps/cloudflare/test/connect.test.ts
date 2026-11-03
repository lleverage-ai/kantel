// Kantel Connect on the Worker's gateway, in Node: with KANTEL_CONNECT=experimental an Access person enrols a machine
// into their personal account, the host registers with no sign-in and connects its WebSocket to the stack object (here,
// straight to the hub the object hands sockets to), and the account's sandboxes run on it while an organisation with no
// host of its own keeps the stub. Off, none of it is served and the Worker is as it was.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createMemoryStore, HOST_NOT_REVOCABLE } from "@kantel/compute";
import { createStubBackend, STUB_HOST_ID } from "@kantel/compute/stub";
import type { Authenticator } from "@kantel/contracts";
import { ORGANISATION_HEADER } from "@kantel/contracts/identity";
import type { HostSocket } from "@kantel/hosts/hub";
import { decodeStreamFrame, encodeStreamFrame, type HostMessage } from "@kantel/hosts/protocol";
import { createMockAccess } from "@kantel/identity/testing";
import type { SqlValue } from "@kantel/sql";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { type ObjectSqlLike, objectSqlDriver } from "../src/audit-outbox.ts";
import {
	COMPUTE_MEMBERS_ONLY,
	createStackCompute,
	HOST_REGISTER_BODY_LIMIT,
	hostCredential,
	type MessageSocket,
	onMessages,
	preOpenBuffer,
	revivingStub,
	type StackCompute,
	sweptAsUsed,
	TUNNEL_PENDING_LIMIT,
	TUNNEL_PENDING_MESSAGES,
	tunnelTicket,
} from "../src/compute.ts";
import { type GatewayVars, gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { memoryMailCounts } from "../src/mail.ts";
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
			const params = message.params as { sandboxId: string; command?: string; snapshotId?: string };
			const answer = (result: unknown) => receive(JSON.stringify({ type: "result", id: message.id, result }));
			if (message.method === "sandbox.create") {
				sandboxes.add(params.sandboxId);
				return answer({ id: params.sandboxId, tier: "microvm", size: "default", state: "running", createdAt: 1 });
			}
			if (message.method === "sandbox.start" && sandboxes.has(params.sandboxId)) {
				return answer({ id: params.sandboxId, tier: "microvm", size: "default", state: "running", createdAt: 1 });
			}
			if (message.method === "sandbox.stop" && sandboxes.has(params.sandboxId)) {
				return answer({ id: params.snapshotId, sizeBytes: 1 });
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

	it("goes on reading a socket after a frame's handling fails", async () => {
		let listener: ((event: { readonly data: unknown }) => void) | undefined;
		const socket: MessageSocket = { addEventListener: (_type, handle) => (listener = handle) };
		const frames: string[] = [];
		const failures: unknown[] = [];
		onMessages(
			socket,
			(frame) => {
				if (frame === "bad") throw new Error("the tunnel's client is gone");
				frames.push(String(frame));
			},
			(_message, error) => failures.push(error),
		);
		listener?.({ data: "one" });
		listener?.({ data: "bad" });
		listener?.({ data: "two" });
		await expect.poll(() => frames).toEqual(["one", "two"]);
		expect(failures).toHaveLength(1);
	});

	it("sweeps expired tunnel tickets as new ones are issued, at most every ten minutes", async () => {
		let at = 0;
		const swept: number[] = [];
		const tickets = sweptAsUsed(
			{
				issue: async () => "ticket",
				verify: async () => undefined,
				sweep: async (now) => {
					swept.push(now);
				},
			},
			() => at,
		);
		const grant = { sandboxId: "sbx_1", port: 22, expiresAt: 1 };
		await tickets.issue(grant);
		at = 60_000;
		await tickets.issue(grant);
		at = 10 * 60_000;
		await tickets.issue(grant);
		expect(swept).toEqual([0, 10 * 60_000]);
	});

	it("keeps an account's stub sandboxes usable once it enrols a host, and bounds registration", async () => {
		// Hosts dial another address than the one the person calls: the command names that one.
		const publicUrl = "https://hosts.kantel.test";
		const { stack, call } = await start(new DatabaseSync(":memory:"), {
			KANTEL_CONNECT: "experimental",
			KANTEL_PUBLIC_URL: publicUrl,
		});
		const hosts = stack.compute.hosts;
		if (hosts === undefined) throw new Error("Connect is on");

		// Before any host: a microVM on the stub, stopped.
		const before = await call("POST", "/v1/sandboxes", { type: "microvm", wait: true });
		const old = before.body.id as string;
		expect((await call("POST", `/v1/sandboxes/${old}/stop`, { wait: true })).status).toBe(200);

		const enrolment = await call("POST", "/v1/connect/enrolments", {});
		const token = enrolment.body.token as string;
		expect(enrolment.body.command).toContain(`--url ${publicUrl} --token ${token}`);

		// Registration is public: a body past its limit is refused before any of it is parsed.
		const huge = await call("POST", "/v1/hosts/register", { token, name: "x".repeat(HOST_REGISTER_BODY_LIMIT) }, {});
		expect(huge.status).toBe(413);
		const chunked = await stack.compute.hosts?.fetch(
			new Request(`${BASE}/v1/hosts/register`, {
				method: "POST",
				body: new ReadableStream({
					start(controller) {
						for (let i = 0; i < 80; i++) controller.enqueue(new Uint8Array(1024));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
		);
		expect(chunked?.status).toBe(413);
		const registered = await call("POST", "/v1/hosts/register", { token }, {});
		expect(registered.status).toBe(201);
		const { hostId, credential } = registered.body as { hostId: string; credential: string };
		const host = fakeHost();
		const held = await hosts.connect(credential, host.socket);
		if (held === undefined) throw new Error("The host's credential was refused");
		host.attach(held, hostId);
		await expect.poll(() => hosts.service.hub.connected(hostId)).toBe(true);

		// New sandboxes go on the host; the old one starts again on the stub, where its disk is, and forks there.
		const fresh = await call("POST", "/v1/sandboxes", { type: "microvm", wait: true });
		expect(host.sandboxes.has(fresh.body.id as string)).toBe(true);
		const started = await call("POST", `/v1/sandboxes/${old}/start`, { wait: true });
		expect(started.body).toMatchObject({ id: old, state: "running" });
		const fork = await call("POST", `/v1/sandboxes/${old}/fork`, {});
		expect(fork.status).toBe(201);
		const forkId = ((fork.body.items as { id: string }[] | undefined)?.[0]?.id ?? fork.body.id) as string;
		await expect.poll(async () => (await call("GET", `/v1/sandboxes/${forkId}`)).body.state).toBe("running");
		expect(host.sandboxes.has(forkId)).toBe(false);
	});

	it("holds at most TUNNEL_PENDING_LIMIT bytes for a tunnel whose port isn't open yet", () => {
		const pending = preOpenBuffer();
		expect(pending.hold(new Uint8Array(1024))).toBe(true);
		expect(pending.hold(new Uint8Array(2048))).toBe(true);
		expect(pending.take().map((chunk) => chunk.byteLength)).toEqual([1024, 2048]);
		expect(pending.take()).toEqual([]);
		const flooded = preOpenBuffer();
		let held = 0;
		while (flooded.hold(new Uint8Array(64 * 1024))) held++;
		expect(held * 64 * 1024).toBeLessThanOrEqual(TUNNEL_PENDING_LIMIT);
		// Past the limit nothing is kept: the tunnel is closed, not written.
		expect(flooded.take()).toEqual([]);
		// Empty messages count too.
		const empties = preOpenBuffer();
		let kept = 0;
		while (empties.hold(new Uint8Array(0))) kept++;
		expect(kept).toBe(TUNNEL_PENDING_MESSAGES);
		expect(empties.held()).toEqual({ messages: 0, bytes: 0 });
		// A tunnel that ends before its port opens lets go of what it held, and holds nothing after.
		const ended = preOpenBuffer();
		ended.hold(new TextEncoder().encode("SSH-2.0-client\r\n"));
		ended.clear();
		expect(ended.held()).toEqual({ messages: 0, bytes: 0 });
		expect(ended.hold(new Uint8Array(1))).toBe(false);
		expect(ended.take()).toEqual([]);
	});

	it("answers a registration GET or HEAD with the host handler's 405", async () => {
		const { stack, call } = await start(new DatabaseSync(":memory:"), {
			KANTEL_CONNECT: "experimental",
			KANTEL_PUBLIC_URL: BASE,
		});
		const get = await call("GET", "/v1/hosts/register", undefined, {});
		expect(get.status).toBe(405);
		const head = await stack.compute.hosts?.fetch(new Request(`${BASE}/v1/hosts/register`, { method: "HEAD" }));
		expect(head?.status).toBe(405);
	});

	it("never revives a host's sandbox or snapshot on the stub while Connect is off, and gives it back once on", async () => {
		const db = new DatabaseSync(":memory:");
		// The same person on each start (the stack's identity is in memory in these tests; deployed, it is in D1).
		const authenticator: Authenticator = {
			authenticate: async () => ({
				method: "cloudflare_access",
				actor: { kind: "human", userId: "usr_tom" },
				organisationId: "org_1",
			}),
		};
		const open = async (connect: boolean) => {
			const compute = await createStackCompute({
				authenticator,
				identity: { authorize: async () => undefined, getUser: () => Promise.reject(new Error("no users here")) },
				sql: objectSql(db),
				...(connect ? { connect: { publicUrl: BASE } } : {}),
			});
			closers.push(() => compute.close());
			const call = async (method: string, path: string, body?: unknown) => {
				const response = await compute.fetch(
					new Request(`${BASE}${path}`, {
						method,
						headers: { authorization: "Bearer person", "content-type": "application/json" },
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}),
				);
				const text = (await response?.text()) ?? "";
				return { status: response?.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
			};
			return { compute, call };
		};
		const attachHost = async (hosts: NonNullable<typeof on.compute.hosts>, credential: string, hostId: string) => {
			const host = fakeHost();
			const held = await hosts.connect(credential, host.socket);
			if (held === undefined) throw new Error("The host's credential was refused");
			host.attach(held, hostId);
			await expect.poll(() => hosts.service.hub.connected(hostId)).toBe(true);
			return host;
		};

		// On: a stub sandbox (made before any host), then a host and a sandbox on it.
		const on = await open(true);
		const stubbed = String((await on.call("POST", "/v1/sandboxes", { type: "microvm", wait: true })).body.id);
		const token = String((await on.call("POST", "/v1/connect/enrolments", {})).body.token);
		const registered = await on.compute.hosts?.fetch(
			new Request(`${BASE}/v1/hosts/register`, { method: "POST", body: JSON.stringify({ token }) }),
		);
		if (registered === undefined) throw new Error("Registration wasn't served");
		const { hostId, credential } = (await registered.json()) as { hostId: string; credential: string };
		if (on.compute.hosts === undefined) throw new Error("Connect is on");
		await attachHost(on.compute.hosts, credential, hostId);
		const onHost = String((await on.call("POST", "/v1/sandboxes", { type: "microvm", wait: true })).body.id);
		expect((await on.call("GET", `/v1/sandboxes/${onHost}`)).body.hostId).toBe(hostId);
		// And one stopped there, its disk now a snapshot on the host.
		const parked = String((await on.call("POST", "/v1/sandboxes", { type: "microvm", wait: true })).body.id);
		expect((await on.call("POST", `/v1/sandboxes/${parked}/stop`, { wait: true })).body).toMatchObject({
			state: "stopped",
		});
		const parkedSnapshot = String((await on.call("GET", `/v1/sandboxes/${parked}`)).body.latestSnapshotId);
		await on.compute.close();

		// Off: the host's sandbox is refused, never made again on the stub; the stub's own revives as before.
		const off = await open(false);
		const refused = await off.call("POST", `/v1/sandboxes/${onHost}/commands`, { command: "echo where" });
		// A command's failure is its answer: nothing ran, and the stub has no machine for it.
		expect(refused.body).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Kantel Connect host") });
		expect((await off.call("POST", `/v1/sandboxes/${onHost}/stop`, { wait: true })).body).toMatchObject({
			error: { code: "unavailable" },
		});
		expect((await off.call("DELETE", `/v1/sandboxes/${onHost}`)).body).toMatchObject({
			error: { code: "unavailable" },
		});
		const kept = await off.call("GET", `/v1/sandboxes/${onHost}`);
		expect(kept.body).toMatchObject({ id: onHost, hostId });
		const revived = await off.call("POST", `/v1/sandboxes/${stubbed}/commands`, { command: "echo on the stub" });
		expect(revived.body).toMatchObject({ exitCode: 0, stdout: "on the stub\n" });
		// A new sandbox of the same type goes on the stub: the account's host, which the backend no longer has, is
		// passed over (unreachable), not preferred.
		const fresh = await off.call("POST", "/v1/sandboxes", { type: "microvm", wait: true });
		expect(fresh.body).toMatchObject({ state: "running", hostId: STUB_HOST_ID });
		// Made from the host's snapshot, or forked from its sandbox, it fails; started again, it still isn't made
		// (empty) on the stub, and it keeps the snapshot it is to be made from.
		const fromHost = await off.call("POST", "/v1/sandboxes", { type: "microvm", from: parkedSnapshot, wait: true });
		expect(fromHost.body).toMatchObject({ state: "error" });
		const forked = await off.call("POST", `/v1/sandboxes/${parked}/fork`, { wait: true });
		const fork = (forked.body.items as { id: string; state: string }[])[0];
		expect(fork).toMatchObject({ state: "error" });
		for (const id of [String(fromHost.body.id), String(fork?.id)]) {
			const started = await off.call("POST", `/v1/sandboxes/${id}/start`, { wait: true });
			expect(started.body).not.toMatchObject({ state: "running" });
			const recovered = await off.call("POST", `/v1/sandboxes/${id}/recover`, { wait: true });
			expect(recovered.body).not.toMatchObject({ state: "running" });
			const after = (await off.call("GET", `/v1/sandboxes/${id}`)).body;
			expect(after.state).toBe("error");
			expect(after.hostId).toBeUndefined();
		}
		// Its credential is the hosts registry's, which is off: revoking it is refused, not answered and left valid.
		const revoking = await off.call("DELETE", `/v1/admin/hosts/${hostId}`);
		expect(revoking.status).toBe(503);
		expect(revoking.body).toMatchObject({ error: { code: "unavailable", message: HOST_NOT_REVOCABLE } });
		expect((await off.call("GET", `/v1/admin/hosts/${hostId}`)).body.state).not.toBe("revoked");
		await off.compute.close();

		// On again: the host is back, and its sandbox runs there.
		const again = await open(true);
		if (again.compute.hosts === undefined) throw new Error("Connect is on");
		const host = await attachHost(again.compute.hosts, credential, hostId);
		host.sandboxes.add(onHost);
		// The refused stop left it in `error`, its host kept: it starts again there, from its own disk.
		expect((await again.call("GET", `/v1/sandboxes/${onHost}`)).body).toMatchObject({ state: "error", hostId });
		expect((await again.call("POST", `/v1/sandboxes/${onHost}/start`, { wait: true })).body).toMatchObject({
			state: "running",
			hostId,
		});
		expect(host.calls).toContain("sandbox.start");
		const ran = await again.call("POST", `/v1/sandboxes/${onHost}/commands`, { command: "echo back" });
		expect(ran.body).toMatchObject({ exitCode: 0, stdout: "back from my own machine\n" });
		expect((await again.call("GET", `/v1/sandboxes/${onHost}`)).body.hostId).toBe(hostId);
		// And it's preferred for new sandboxes again, still the account's.
		const next = await again.call("POST", "/v1/sandboxes", { type: "microvm", wait: true });
		expect(next.body).toMatchObject({ state: "running", hostId });
		expect((await again.call("GET", "/v1/connect/hosts")).body.items).toMatchObject([{ id: hostId, state: "online" }]);
		// The one made from its snapshot while it was off is made now, there, from that snapshot.
		const made = await again.call("POST", `/v1/sandboxes/${fromHost.body.id}/start`, { wait: true });
		expect(made.body).toMatchObject({ state: "running", hostId });
	});

	it("stops a host's sandbox at its auto-stop time, and sends its webhook, with no compute request to prompt it", async () => {
		let clock = Date.now();
		const authenticator: Authenticator = {
			authenticate: async () => ({
				method: "cloudflare_access",
				actor: { kind: "human", userId: "usr_tom" },
				organisationId: "org_1",
			}),
		};
		const db = new DatabaseSync(":memory:");
		const delivered: string[] = [];
		const open = async () => {
			const opened = await createStackCompute({
				authenticator,
				identity: { authorize: async () => undefined, getUser: () => Promise.reject(new Error("no users here")) },
				sql: objectSql(db),
				connect: { publicUrl: BASE },
				now: () => clock,
				connectSweepMs: 10,
				fetch: async (_url, init) => {
					delivered.push(String(init?.body));
					return new Response("ok");
				},
			});
			closers.push(() => opened.close());
			return opened;
		};
		const first = await open();
		const call = async (method: string, path: string, body?: unknown) => {
			const response = await first.fetch(
				new Request(`${BASE}${path}`, {
					method,
					headers: { authorization: "Bearer person", "content-type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
			return JSON.parse((await response?.text()) ?? "{}") as Record<string, unknown>;
		};
		if (first.hosts === undefined) throw new Error("Connect is on");
		const token = String((await call("POST", "/v1/connect/enrolments", {})).token);
		const registered = await first.hosts.fetch(
			new Request(`${BASE}/v1/hosts/register`, { method: "POST", body: JSON.stringify({ token }) }),
		);
		if (registered === undefined) throw new Error("Registration wasn't served");
		const { hostId, credential } = (await registered.json()) as { hostId: string; credential: string };
		const attach = async (compute: StackCompute, running: readonly string[] = []) => {
			const hosts = compute.hosts;
			if (hosts === undefined) throw new Error("Connect is on");
			const host = fakeHost();
			for (const id of running) host.sandboxes.add(id);
			const held = await hosts.connect(credential, host.socket);
			if (held === undefined) throw new Error("The host's credential was refused");
			host.attach(held, hostId);
			await expect.poll(() => hosts.service.hub.connected(hostId)).toBe(true);
			return host;
		};
		await attach(first);
		const timed = await call("POST", "/v1/sandboxes", { type: "microvm", autoStopMinutes: 1, wait: true });
		const kept = await call("POST", "/v1/sandboxes", { type: "microvm", autoStopMinutes: null, wait: true });
		expect([timed.hostId, kept.hostId]).toEqual([hostId, hostId]);
		await call("POST", "/v1/webhooks", {
			name: "stops",
			url: "https://hooks.example.test/x",
			events: ["sandbox.stopped"],
		});
		await first.close();

		// The object starts again (as after an eviction); nothing calls the compute API, so the request-driven timers
		// (the webhook dispatcher's among them) never start. Its stop time passes while its host is away, and sweeps run
		// meanwhile: it is kept running, not written off. Once the host reconnects it is stopped (it is used over SSH
		// alone, say), and its `sandbox.stopped` is sent.
		const second = await open();
		clock += 2 * 60_000;
		await new Promise((resolve) => setTimeout(resolve, 100));
		const host = await attach(second, [String(timed.id), String(kept.id)]);
		await expect.poll(() => host.calls.filter((method) => method === "sandbox.stop").length).toBe(1);
		await expect
			.poll(() => delivered.map((body) => JSON.parse(body) as { type: string; sandboxId?: string }), {
				timeout: 5000,
			})
			.toEqual([expect.objectContaining({ type: "sandbox.stopped" })]);
		const state = async (id: unknown) => {
			const response = await second.fetch(
				new Request(`${BASE}/v1/sandboxes/${id}`, { headers: { authorization: "Bearer person" } }),
			);
			return ((await response?.json()) as { state: string } | undefined)?.state;
		};
		expect(await state(timed.id)).toBe("stopped");
		expect(await state(kept.id)).toBe("running");
	});

	it("refuses a host's snapshot on the stub rather than booting an empty disk in its place", async () => {
		const stub = revivingStub(createStubBackend(), createMemoryStore().sandboxes);
		const ref = "host_abc/snap_1";
		const spec = {
			sandboxId: "sbx_new",
			accountId: "acc_1",
			type: "microvm" as const,
			subdomain: "new",
			env: {},
			eligibleHosts: [STUB_HOST_ID],
		};
		await expect(stub.create({ ...spec, fromSnapshot: ref })).rejects.toMatchObject({ code: "unavailable" });
		await expect(stub.listSnapshotFiles(ref, "/")).rejects.toMatchObject({ code: "unavailable" });
		await expect(stub.readSnapshotFile(ref, "/a")).rejects.toMatchObject({ code: "unavailable" });
		await expect(stub.deleteSnapshot(ref)).rejects.toMatchObject({ code: "unavailable" });
		// The stub's own snapshot it has lost still boots from an empty disk, as before.
		await expect(stub.create({ ...spec, fromSnapshot: "ref_gone" })).resolves.toMatchObject({ hostId: STUB_HOST_ID });
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

	it("shares KANTEL_PUBLIC_URL with email sign-in: alone it is Connect's, and sign-in stays off", () => {
		const access = { KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, KANTEL_ACCESS_AUD: AUD };
		const alone = gatewayConfig({ ...access, KANTEL_CONNECT: "experimental", KANTEL_PUBLIC_URL: BASE });
		expect(alone.connect).toEqual({ publicUrl: BASE });
		expect(alone.emailSignIn).toBeUndefined();
		// Turned off, the same configuration stays valid, with neither Connect nor sign-in.
		const off = gatewayConfig({ ...access, KANTEL_CONNECT: "off", KANTEL_PUBLIC_URL: BASE });
		expect(off.connect).toBeUndefined();
		expect(off.emailSignIn).toBeUndefined();
		expect(() => gatewayConfig({ ...access, KANTEL_CONNECT: "off", KANTEL_PUBLIC_URL: `${BASE}/x` })).toThrow(/origin/);
		// With no switch at all: the public origin without its sender is refused, as before.
		expect(() => gatewayConfig({ ...access, KANTEL_PUBLIC_URL: BASE })).toThrow(/KANTEL_SIGN_IN_FROM/);
		expect(() => gatewayConfig({ ...access, KANTEL_CONNECT: "off", KANTEL_SIGN_IN_FROM: "a@b.c" })).toThrow(/both/);
		const both = gatewayConfig({
			...access,
			KANTEL_CONNECT: "experimental",
			KANTEL_PUBLIC_URL: BASE,
			KANTEL_SIGN_IN_FROM: "sign-in@example.com",
		});
		expect(both.connect).toEqual({ publicUrl: BASE });
		expect(both.emailSignIn).toMatchObject({ publicUrl: BASE, from: "sign-in@example.com" });
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

	it("lets someone who signs up on the public origin enrol and use a host of their own, never the stub", async () => {
		const { call, signIn, hosts } = await startPublic();
		const ada = await signIn("ada@example.test");

		// In, but not a super-admin, and with no host of her own nothing runs: the stub is the deployment's.
		const whoami = await call("GET", "/v1/whoami", { token: ada });
		expect(whoami.status).toBe(200);
		expect(whoami.body).toMatchObject({ superAdmin: false });
		const personal = whoami.body.accountId as string;
		const early = await call("POST", "/v1/sandboxes", { token: ada, body: { type: "isolate", wait: true } });
		expect(early.status).toBe(503);
		expect(early.body.error).toMatchObject({ code: "unavailable", message: /host of this account's own/ });
		expect((await call("GET", "/v1/admin/hosts", { token: ada })).status).toBe(403);

		// She enrols her machine into her personal account; it registers and connects.
		const enrolment = await call("POST", "/v1/connect/enrolments", { token: ada, body: { name: "adas-box" } });
		expect(enrolment.status).toBe(201);
		expect(enrolment.body).toMatchObject({ accountId: personal });
		const registered = await call("POST", "/v1/hosts/register", { body: { token: enrolment.body.token } });
		const { hostId, credential } = registered.body as { hostId: string; credential: string };
		const host = fakeHost();
		const held = await hosts.connect(credential, host.socket);
		if (held === undefined) throw new Error("The host's credential was refused");
		host.attach(held, hostId);
		await expect.poll(() => hosts.service.hub.connected(hostId)).toBe(true);
		const listed = await call("GET", "/v1/connect/hosts", { token: ada });
		expect(listed.body.items).toMatchObject([{ id: hostId, state: "online", accountId: personal }]);

		// Her sandbox goes on her machine, and so does one made with a key she makes.
		const made = await call("POST", "/v1/sandboxes", { token: ada, body: { type: "microvm", wait: true } });
		expect(made.status).toBe(201);
		const sandboxId = made.body.id as string;
		expect(host.sandboxes.has(sandboxId)).toBe(true);
		const key = await call("POST", "/v1/api-keys", {
			token: ada,
			body: { name: "cli", scopes: ["sandboxes:read", "sandboxes:write", "exec"] },
		});
		expect(key.status).toBe(201);
		const byKey = await call("POST", "/v1/sandboxes", {
			token: key.body.secret as string,
			body: { type: "microvm", wait: true },
		});
		expect(host.sandboxes.has(byKey.body.id as string)).toBe(true);
		// Her key, too, is kept off the stub: an isolate (which her host doesn't run) has nowhere to go.
		const isolate = await call("POST", "/v1/sandboxes", {
			token: key.body.secret as string,
			body: { type: "isolate", wait: true },
		});
		expect(isolate.status).not.toBe(201);

		// A tunnel given under a session ends with that session, and not with another of hers.
		const later = await signIn("ada@example.test");
		const ticketOf = async (token: string) => {
			const ssh = await call("POST", `/v1/sandboxes/${sandboxId}/ssh`, { token, body: {} });
			expect(ssh.status).toBe(201);
			const ticket = tunnelTicket(new URL(ssh.body.proxyUrl as string).pathname);
			if (ticket === undefined) throw new Error("Not a tunnel URL");
			return ticket;
		};
		const first = await ticketOf(ada);
		const second = await ticketOf(later);
		expect((await call("POST", "/auth/session/end", { token: ada })).status).toBe(204);
		const refused: number[] = [];
		const ended = await hosts.tunnel(first, { send: () => undefined, close: (code) => refused.push(code) });
		expect(ended).toBeUndefined();
		expect(refused).toEqual([4003]);
		const open = await hosts.tunnel(second, { send: () => undefined, close: () => undefined });
		expect(open).toBeDefined();
		open?.close();
	});

	it("keeps the stub its organisation's, a project's members too, Connect on or off, and outsiders' keys off it", async () => {
		const databases = { identity: new DatabaseSync(":memory:"), compute: new DatabaseSync(":memory:") };
		const on = await startPublic({}, databases);
		const ada = await on.signIn("ada@example.test");
		const bob = await on.signIn("bob@example.test");
		// Bob, who signed up too, is given a role on one of the deployment's projects only.
		const bobId = ((await on.call("GET", "/v1/whoami", { token: bob })).body.user as { id: string }).id;
		const website = await on.stack.identity.createProject(on.stack.admin, { name: "Website" });
		await on.stack.identity.grantRole(on.stack.admin, {
			principal: { kind: "user", userId: bobId },
			role: "viewer",
			projectId: website.id,
		});
		const deployment = on.stack.admin.organisationId;
		const asBob = { token: bob, organisation: deployment };
		const scopes = ["sandboxes:read", "sandboxes:write", "exec"];
		const keyOf = async (options: { token: string; organisation?: string }) => {
			const made = await on.call("POST", "/v1/api-keys", { ...options, body: { name: "cli", scopes } });
			expect(made.status).toBe(201);
			return made.body.secret as string;
		};
		const adaKey = await keyOf({ token: ada });
		const bobKey = await keyOf(asBob);
		const isolate = { type: "isolate", wait: true };

		// Connect on: Bob is a member, so he and his key use the stub; Ada and hers, with no host of their own, don't.
		const bobs = await on.call("POST", "/v1/sandboxes", { ...asBob, body: isolate });
		expect(bobs.status).toBe(201);
		expect((await on.call("POST", "/v1/sandboxes", { token: bobKey, body: isolate })).status).toBe(201);
		expect((await on.call("POST", "/v1/sandboxes", { token: adaKey, body: isolate })).status).toBe(503);

		// Connect off, over the same records: Ada's key, made while it was on, still can't; Bob and his key still can.
		await on.stack.compute.close();
		const off = await startPublic({ KANTEL_CONNECT: "off" }, databases);
		const refused = await off.call("POST", "/v1/sandboxes", { token: adaKey, body: isolate });
		expect(refused.status).toBe(503);
		expect(refused.body.error).toMatchObject({ code: "unavailable", message: /host of this account's own/ });
		expect((await off.call("POST", "/v1/sandboxes", { token: bobKey, body: isolate })).status).toBe(201);
		const bobAgain = await off.signIn("bob@example.test");
		const inOrg = { token: bobAgain, organisation: deployment };
		expect((await off.call("POST", "/v1/sandboxes", { ...inOrg, body: isolate })).status).toBe(201);
		// The sandbox he made with Connect on is back after the restart, and runs his command.
		const ran = await off.call("POST", `/v1/sandboxes/${bobs.body.id}/commands`, {
			...inOrg,
			body: { command: "echo hi" },
		});
		expect(ran.status).toBe(200);
		expect(ran.body.stdout).toBe("hi\n");
	});

	it("keeps a public sign-up off the stub with Connect off, as before", async () => {
		const { call, signIn } = await startPublic({ KANTEL_CONNECT: "off" });
		const ada = await signIn("ada@example.test");
		const refused = await call("POST", "/v1/sandboxes", { token: ada, body: { type: "isolate", wait: true } });
		expect(refused.status).toBe(403);
		expect(refused.body.error).toMatchObject({ code: "forbidden", message: COMPUTE_MEMBERS_ONLY });
		expect((await call("POST", "/v1/connect/enrolments", { token: ada, body: {} })).status).toBe(403);
	});
});

/**
 * The Worker with email-code sign-in and open sign-up on its public origin, and Kantel Connect on (`vars` to change
 * that): a call there with a session or key, and someone's sign-in, as `test/sign-in.test.ts` has them.
 */
async function startPublic(
	vars: GatewayVars = {},
	databases: { identity: DatabaseSync; compute?: DatabaseSync } = { identity: new DatabaseSync(":memory:") },
) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const sent: { to: string; text?: string }[] = [];
	const pending: Promise<unknown>[] = [];
	const stack = await createStack({
		config: gatewayConfig({
			KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
			KANTEL_ACCESS_AUD: AUD,
			KANTEL_ADMIN_EMAIL: ADMIN,
			KANTEL_PUBLIC_URL: BASE,
			KANTEL_SIGN_IN_FROM: "sign-in@kantel.test",
			KANTEL_CONNECT: "experimental",
			...vars,
		}),
		accessFetch: mock.fetch,
		storage: {
			sql: syncSqliteDriver(databases.identity),
			...(databases.compute === undefined ? {} : { compute: objectSql(databases.compute) }),
		},
		mail: {
			binding: {
				send: async (message) => {
					sent.push(message as { to: string; text?: string });
					return { messageId: `m${sent.length}` };
				},
			},
			counts: memoryMailCounts(),
			defer: (work) => {
				pending.push(work);
			},
		},
	});
	closers.push(() => stack.compute.close());
	const gateway = createGateway(stack);
	const call = async (
		method: string,
		path: string,
		options: { body?: unknown; token?: string; organisation?: string } = {},
	) => {
		const headers: Record<string, string> = {};
		if (options.body !== undefined) headers["content-type"] = "application/json";
		if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
		if (options.organisation !== undefined) headers[ORGANISATION_HEADER] = options.organisation;
		const response = await gateway.fetch(
			new Request(`${BASE}${path}`, {
				method,
				headers,
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			}),
		);
		const text = await response.text();
		return {
			status: response.status,
			body: (text === "" || !text.startsWith("{") ? {} : JSON.parse(text)) as Record<string, unknown>,
		};
	};
	const signIn = async (email: string): Promise<string> => {
		expect((await call("POST", "/auth/otp/start", { body: { email } })).status).toBe(202);
		await Promise.all(pending.splice(0));
		const code = /code is (\d{6})/.exec(sent.findLast((message) => message.to === email)?.text ?? "")?.[1];
		const verified = await call("POST", "/auth/otp/verify", { body: { email, code } });
		expect(verified.status).toBe(200);
		return String(verified.body.token);
	};
	const hosts = stack.compute.hosts;
	return {
		stack,
		call,
		signIn,
		get hosts() {
			if (hosts === undefined) throw new Error("Connect is off");
			return hosts;
		},
	};
}
