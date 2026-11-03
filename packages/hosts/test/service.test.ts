// The service end to end over the hub, with fake hosts speaking the protocol as kantel-host does: join, hello and
// reconcile, placement, calls routed to the sandbox's host, port streams, drain and revoke.
import { isKantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHostsApi } from "../src/http.ts";
import { HOST_CLOSE_REPLACED, HOST_CLOSE_REVOKED, type HostSandbox } from "../src/protocol.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { FakeHost, facts } from "./fake-host.ts";

const services: HostsService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function setup(options: { now?: () => number } = {}) {
	const store = createMemoryHostStore();
	const logs: string[] = [];
	const service = createHostsService({
		store,
		publicUrl: "https://kantel.example.com/",
		clock: { now: options.now ?? (() => Date.now()) },
		log: (message) => logs.push(message),
	});
	services.push(service);
	const join = async (name: string, labels?: { [key: string]: string }) => {
		const token = await service.createJoinToken({ name, ...(labels === undefined ? {} : { labels }) });
		const { hostId, credential } = await service.register({ token: token.token, facts: facts() });
		return { hostId, credential, token };
	};
	return { store, service, logs, join };
}

describe("hosts service", () => {
	it("joins a host once per token, and authenticates only its credential", async () => {
		const { service, join } = await setup();
		const { hostId, credential, token } = await join("box-1", { region: "eu" });
		expect(token.token).toMatch(/^kth_/);
		expect(token.command).toBe(
			`curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token ${token.token}`,
		);
		expect(credential).toMatch(/^khc_/);
		await expect(service.register({ token: token.token })).rejects.toSatisfy((error) =>
			isKantelError(error, "forbidden"),
		);
		expect((await service.authenticate(credential))?.id).toBe(hostId);
		expect(await service.authenticate("khc_wrong")).toBeUndefined();
		const view = await service.get(hostId);
		expect(view).toMatchObject({
			name: "box-1",
			state: "unreachable",
			labels: { region: "eu" },
			tiers: ["microvm", "isolate"],
		});
	});

	it("refuses an expired token", async () => {
		let now = 1_000;
		const { service } = await setup({ now: () => now });
		const token = await service.createJoinToken({ expiresInMinutes: 5 });
		now += 5 * 60_000;
		await expect(service.register({ token: token.token })).rejects.toSatisfy((error) =>
			isKantelError(error, "forbidden"),
		);
	});

	it("welcomes a host, reconciles what it holds, and places and routes sandboxes", async () => {
		const { service, store, join, logs } = await setup();
		const a = await join("a");
		// A sandbox Kantel placed earlier, which the host lost while it was away.
		await store.putPlacement({
			sandboxId: "lost-one",
			hostId: a.hostId,
			tier: "microvm",
			size: "default",
			vcpus: 2,
			memoryMiB: 2048,
			diskGiB: 20,
			state: "running",
			createdAt: 1,
			updatedAt: 1,
		});
		const host = new FakeHost(service, a.hostId);
		host.connect([{ id: "stray", tier: "microvm", size: "default", state: "stopped", createdAt: 1 }]);
		await tick();
		expect(host.welcomed()).toBe(true);
		expect(host.sent[0]).toMatchObject({
			type: "welcome",
			welcome: { hostId: a.hostId, heartbeatSeconds: 15, pools: { "microvm/default": 1 } },
		});
		expect((await store.getPlacement("lost-one"))?.state).toBe("lost");
		expect(logs.join("\n")).toMatch(/didn't place: stray/);
		expect((await service.get(a.hostId)).state).toBe("online");

		const created = await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-one" });
		expect(created).toMatchObject({ hostId: a.hostId, sandbox: { id: "sbx-one", state: "running" } });
		const events: string[] = [];
		const result = await service.sandboxes.call(
			"sbx-one",
			"sandbox.exec",
			{ command: "echo hi" },
			{ onEvent: (event) => events.push(event.kind) },
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "hi\n" });
		expect(events).toEqual(["exec.output"]);
		const stopped = await service.sandboxes.call<HostSandbox>("sbx-one", "sandbox.stop");
		expect(stopped.state).toBe("stopped");
		const stopCall = host.sent.find((message) => message.method === "sandbox.stop");
		expect((stopCall?.params as { snapshotId?: string } | undefined)?.snapshotId).toMatch(/^snap_/);
		expect((await store.getPlacement("sbx-one"))?.state).toBe("stopped");
		await expect(service.sandboxes.call("sbx-one", "host.update", {})).rejects.toSatisfy((error) =>
			isKantelError(error, "forbidden"),
		);
		await expect(service.sandboxes.call("sbx-one", "sandbox.nope", {})).rejects.toSatisfy((error) =>
			isKantelError(error, "not_supported"),
		);

		const fork = await service.sandboxes.fork("sbx-one", { newId: "sbx-two" });
		expect(fork.hostId).toBe(a.hostId);
		expect((await service.get(a.hostId)).allocated).toMatchObject({
			sandboxes: 2,
			vcpus: 2,
			memoryMb: 2048,
			diskGb: 60,
		});

		await service.sandboxes.delete("sbx-two");
		expect(await service.sandboxes.placement("sbx-two")).toBeUndefined();
		await expect(service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-one" })).rejects.toSatisfy((error) =>
			isKantelError(error, "conflict"),
		);
	});

	it("carries a port stream both ways over the host's connection", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-port" });
		const received: string[] = [];
		const ended: string[] = [];
		const stream = await service.sandboxes.openPort("sbx-port", 22, {
			data: (bytes) => received.push(new TextDecoder().decode(bytes)),
			end: (reason) => ended.push(reason),
		});
		stream.write(new TextEncoder().encode("SSH-2.0-test"));
		expect(received).toEqual(["echo:SSH-2.0-test"]);
		host.send({ type: "stream.close", stream: stream.stream, reason: "closed by the sandbox" });
		expect(ended).toEqual(["closed by the sandbox"]);
		stream.write(new TextEncoder().encode("after"));
		expect(host.binary).toHaveLength(1);
	});

	it("spreads by free memory, skips a draining host and refuses when none can take it", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const b = await join("b");
		const hostA = new FakeHost(service, a.hostId);
		hostA.freeMemoryMiB = 3_000;
		hostA.connect();
		const hostB = new FakeHost(service, b.hostId);
		hostB.freeMemoryMiB = 3_000;
		hostB.warm = { "microvm/default": 1 };
		hostB.connect();
		await tick();
		expect((await service.sandboxes.create({ tier: "microvm" })).hostId).toBe(b.hostId);
		// b's report is now 2 GiB stale: the next goes to a.
		expect((await service.sandboxes.create({ tier: "microvm" })).hostId).toBe(a.hostId);
		await expect(service.sandboxes.create({ tier: "microvm" })).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		// A heartbeat clears what was reserved; draining a moves everything to b.
		hostA.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 1, stopped: 0, load1: 0, warm: {} } },
		});
		hostB.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 5_000, freeDiskGiB: 400, running: 1, stopped: 0, load1: 0, warm: {} } },
		});
		await tick();
		await service.update(a.hostId, { draining: true });
		expect(hostA.sent.filter((message) => message.type === "welcome").at(-1)?.welcome).toMatchObject({
			draining: true,
			pools: {},
		});
		expect((await service.get(a.hostId)).state).toBe("draining");
		expect((await service.sandboxes.create({ tier: "microvm" })).hostId).toBe(b.hostId);
	});

	it("takes over from an older connection and revokes a host for good", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const first = new FakeHost(service, a.hostId);
		first.connect();
		await tick();
		const second = new FakeHost(service, a.hostId);
		second.connect();
		await tick();
		expect(first.closedWith?.code).toBe(HOST_CLOSE_REPLACED);
		// The old socket's close doesn't take the host offline.
		first.connection.closed(HOST_CLOSE_REPLACED, "replaced");
		expect(service.hub.connected(a.hostId)).toBe(true);
		const revoked = await service.revoke(a.hostId);
		expect(revoked.state).toBe("revoked");
		expect(second.closedWith?.code).toBe(HOST_CLOSE_REVOKED);
		expect(await service.authenticate(a.credential)).toBeUndefined();
	});

	it("refuses a hello from another protocol version or for another host", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connection = service.hub.accept(a.hostId, {
			sendText: () => undefined,
			sendBinary: () => undefined,
			close: (code, reason) => {
				host.closedWith = { code, reason };
			},
		});
		host.send({
			type: "hello",
			hello: {
				hostId: "host_other",
				facts: facts(),
				sandboxes: [],
				capacity: { freeMemoryMiB: 1, freeDiskGiB: 1, running: 0, stopped: 0, load1: 0, warm: {} },
			},
		});
		await tick();
		expect(host.closedWith).toMatchObject({ code: 4002, reason: "The hello names another host than the credential" });
		expect(service.hub.connected(a.hostId)).toBe(false);
	});

	it("serves registration and the operator's routes over HTTP", async () => {
		const { service } = await setup();
		let admin = true;
		const api = createHostsApi({
			hosts: service,
			async authorizeAdmin() {
				if (!admin) {
					const { KantelError } = await import("@kantel/contracts");
					throw new KantelError("forbidden", "Operators only");
				}
			},
		});
		const call = async (method: string, path: string, body?: unknown) => {
			const response = await api.fetch(
				new Request(`https://k.example${path}`, {
					method,
					...(body === undefined
						? {}
						: { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
				}),
			);
			// biome-ignore lint/suspicious/noExplicitAny: a test reads the answers' fields directly
			const answer: any = response === undefined ? undefined : await response.json().catch(() => undefined);
			return { status: response?.status, body: answer };
		};
		const made = await call("POST", "/v1/admin/hosts/join-tokens", { name: "edge", labels: { region: "eu" } });
		expect(made.status).toBe(201);
		const registered = await call("POST", "/v1/hosts/register", {
			token: made.body.token,
			name: "ignored",
			facts: facts(),
		});
		expect(registered.status).toBe(201);
		expect(registered.body).toMatchObject({
			hostId: expect.stringMatching(/^host_/),
			credential: expect.stringMatching(/^khc_/),
		});
		expect((await call("POST", "/v1/hosts/register", { token: made.body.token })).status).toBe(403);
		const listed = await call("GET", "/v1/admin/hosts");
		expect(listed.body.items).toHaveLength(1);
		expect(listed.body.items[0]).toMatchObject({ name: "edge", state: "unreachable", arch: "x86_64" });
		const patched = await call("PATCH", `/v1/admin/hosts/${registered.body.hostId}`, {
			draining: true,
			name: "edge-2",
		});
		expect(patched.body).toMatchObject({ name: "edge-2", state: "unreachable" });
		expect((await call("POST", "/v1/admin/compute/sandboxes", { tier: "microvm" })).status).toBe(503);
		admin = false;
		expect((await call("GET", "/v1/admin/hosts")).status).toBe(403);
		expect(await api.fetch(new Request("https://k.example/v1/sessions"))).toBeUndefined();
	});
});
