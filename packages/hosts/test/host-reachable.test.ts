// A sandbox whose host isn't connected says so (`hostReachable` false), rather than reading as running and reachable:
// the calls that need its machine are refused at once, a desktop or SSH grant isn't handed out to fail when it's used,
// a stop still waits for the host (#737), and a console watching the account hears of it when the host goes and comes
// back.
import { createKantelClient, type LiveFrame } from "@kantel/api/sdk";
import { createComputeApi, joinTokenSpender } from "@kantel/compute";
import { isKantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { HOST_FEATURES } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const FEATURES = [HOST_FEATURES.egressPolicy, HOST_FEATURES.guestHealth, HOST_FEATURES.exitStamps];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

async function setup() {
	const service = createHostsService({
		store: createMemoryHostStore(),
		publicUrl: "https://kantel.test",
		log: () => undefined,
	});
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
	});
	const api = createComputeApi({
		backend,
		authenticatePerson: async (request) => (request.headers.get("authorization") === "Bearer root" ? ROOT : undefined),
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
	});
	service.useJoinTokens(joinTokenSpender(api.store));
	service.useCompute({
		secrets: async () => undefined,
		recordEgress: async () => undefined,
		reportExit: (...report) => api.service.reportExit(...report),
		hostConnection: (...report) => api.service.reportHostConnection(...report),
	});
	closers.push(
		() => service.close(),
		() => api.close(),
	);
	const root = createKantelClient({
		baseUrl: "https://kantel.test/v1",
		token: "root",
		fetch: (input, init) =>
			api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
	});
	const token = await root.createHostJoinToken({ name: "box" });
	const { hostId } = await service.register({ token: token.token });
	const host = new FakeHost(service, hostId, FEATURES);
	host.connect();
	await vi.waitFor(() => expect(host.welcomed()).toBe(true));
	const sandbox = await root.createSandbox({ type: "microvm", wait: true });
	return { api, root, service, backend, hostId, host, sandbox };
}

async function reconnect(service: ReturnType<typeof createHostsService>, hostId: string, was: FakeHost) {
	const back = new FakeHost(service, hostId, FEATURES);
	back.connect([...was.sandboxes.values()]);
	await vi.waitFor(() => expect(back.welcomed()).toBe(true));
	return back;
}

/** What a call answers when it fails, or `undefined` when it succeeds. */
async function failure(
	call: Promise<unknown>,
): Promise<{ status?: number; code?: string; message: string } | undefined> {
	try {
		await call;
		return undefined;
	} catch (error) {
		const failed = error as { status?: number; code?: string; message: string };
		return { status: failed.status, code: failed.code, message: failed.message };
	}
}

describe("a sandbox whose host isn't connected", () => {
	it("is answered reachable while its host is connected, and not once it goes, in a get and a list", async () => {
		const { root, host, sandbox } = await setup();
		expect(sandbox.hostReachable).toBe(true);
		expect((await root.getSandbox(sandbox.id)).hostReachable).toBe(true);

		host.connection.closed(1006, "gone");
		const away = await root.getSandbox(sandbox.id);
		// Its state is its last known: nothing says its machine ended.
		expect(away).toMatchObject({ state: "running", hostReachable: false });
		const listed = (await root.listSandboxes()).items.find((item) => item.id === sandbox.id);
		expect(listed).toMatchObject({ state: "running", hostReachable: false });
	});

	it("is reachable again once its host reconnects", async () => {
		const { root, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		expect((await root.getSandbox(sandbox.id)).hostReachable).toBe(false);
		await reconnect(service, hostId, host);
		expect((await root.getSandbox(sandbox.id)).hostReachable).toBe(true);
	});

	it("refuses commands, files, SSH, the desktop and the browser at once with unavailable", async () => {
		const { root, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		for (const call of [
			root.runCommand(sandbox.id, { command: "true" }),
			root.readFile(sandbox.id, { path: "/etc/hostname" }),
			root.openSsh(sandbox.id),
			root.openDesktop(sandbox.id),
			root.openBrowser(sandbox.id),
		]) {
			const refused = await failure(call);
			expect(refused).toMatchObject({ status: 503, code: "unavailable" });
			expect(refused?.message).toMatch(/host isn't connected/);
		}
	});

	it("isn't given a desktop or SSH ticket by the backend, which would only fail when opened", async () => {
		const { backend, host, sandbox } = await setup();
		await expect(backend.openDesktop(sandbox.id, { viewOnly: false, ttlMinutes: 5 })).resolves.toMatchObject({
			url: expect.any(String),
		});
		host.connection.closed(1006, "gone");
		const refused = await backend.openDesktop(sandbox.id, { viewOnly: false, ttlMinutes: 5 }).catch((error) => error);
		expect(isKantelError(refused) && refused.code).toBe("unavailable");
	});

	it("refuses a save, its processes and its snapshots' files without naming the host, and still lists its snapshots", async () => {
		const { root, hostId, host, sandbox } = await setup();
		const taken = await root.takeSnapshot(sandbox.id);
		await vi.waitFor(async () => expect((await root.getSnapshot(taken.id)).state).toBe("ready"));
		host.connection.closed(1006, "gone");
		for (const call of [
			root.saveSnapshot({ name: "kept", sandboxId: sandbox.id }),
			root.saveSnapshot({ name: "kept-entry", sandboxId: sandbox.id, snapshotId: taken.id }),
			root.listSandboxProcesses(sandbox.id),
			root.listSnapshotFiles(taken.id),
			root.readSnapshotFile(taken.id, { path: "/etc/hostname" }),
		]) {
			const refused = await failure(call);
			expect(refused).toMatchObject({ status: 503, code: "unavailable" });
			expect(refused?.message).toMatch(/host isn't connected/);
			expect(refused?.message).not.toContain(hostId);
		}
		// Its records are Kantel's, answered while the host is away.
		expect((await root.getSnapshot(taken.id)).id).toBe(taken.id);
		expect((await root.listSnapshots({ sandboxId: sandbox.id })).items.map((item) => item.id)).toContain(taken.id);
	});

	it("is refused at once, not after a stop queued on it that waits for the host", async () => {
		const { api, root, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		// The stop waits up to minutes for the host to reconnect.
		await root.stopSandbox(sandbox.id);
		expect((await root.getSandbox(sandbox.id)).state).toBe("stopping");
		const started = Date.now();
		const refused = await failure(root.runCommand(sandbox.id, { command: "true" }));
		expect(refused).toMatchObject({ status: 503, code: "unavailable" });
		expect(Date.now() - started).toBeLessThan(2_000);
		// Back, the stop carries on.
		await reconnect(service, hostId, host);
		await api.service.idle();
		expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
	});

	it("says its host is away rather than that its guest agent doesn't answer, which can't be known now", async () => {
		const { api, root, hostId, host, sandbox } = await setup();
		await api.service.reportHealth(hostId, sandbox.id, "unresponsive", "out of memory", Date.now());
		expect(await failure(root.runCommand(sandbox.id, { command: "true" }))).toMatchObject({ status: 409 });
		host.connection.closed(1006, "gone");
		expect(await failure(root.runCommand(sandbox.id, { command: "true" }))).toMatchObject({
			status: 503,
			code: "unavailable",
		});
	});

	it("can still be stopped: the stop waits for its host", async () => {
		const { api, root, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id);
		expect((await root.getSandbox(sandbox.id)).state).toBe("stopping");
		await reconnect(service, hostId, host);
		await api.service.idle();
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "stopped", hostReachable: true });
	});

	it("is published to a watching console when its host goes and when it comes back", async () => {
		const { root, service, hostId, host, sandbox } = await setup();
		const frames: LiveFrame[] = [];
		const handle = root.watchEvents({ onFrames: (some) => frames.push(...some), onClose: () => undefined });
		closers.push(() => handle.close());
		await vi.waitFor(() => expect(frames.some((frame) => frame.type === "hello")).toBe(true));
		const ofSandbox = () => frames.filter((frame) => frame.type === "sandbox" && frame.sandboxId === sandbox.id);

		host.connection.closed(1006, "gone");
		await vi.waitFor(() => expect(ofSandbox()).toHaveLength(1));
		expect(ofSandbox()[0]).toMatchObject({ state: "running", previousState: "running" });

		await reconnect(service, hostId, host);
		await vi.waitFor(() => expect(ofSandbox()).toHaveLength(2));
	});
});
