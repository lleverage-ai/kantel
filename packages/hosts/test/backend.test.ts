// The compute API (`@kantel/compute`) over the host backend, end to end through the hub with a fake kantel-host: a
// host joins with a token the API minted, shows up in the API's host list, and runs a sandbox's lifecycle, commands,
// files, snapshots and forks; desktop, browser and SSH access come back as signed tunnel URLs.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_DISPLAY_RECORD, BROWSER_SURFACE_MARK, createHostBackend } from "../src/backend.ts";
import { createPortRouter } from "../src/ports.ts";
import type { HostFacts, HostGuest, HostIsolateRuntime, HostMessage, HostSandbox } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets, HOSTS_TUNNEL_PATH } from "../src/tunnel.ts";

const facts: HostFacts = {
	version: "0.1.0",
	protocol: 1,
	os: "linux",
	arch: "amd64",
	kernel: "6.8",
	hostname: "box",
	cpus: 16,
	memoryMiB: 32_768,
	diskGiB: 500,
	kvm: true,
	nested: true,
	tiers: ["microvm", "isolate"],
	sizes: [{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 }],
	egress: "open",
};

const b64 = (text: string) => btoa(text);
const unb64 = (data: string) => atob(data);

/** kantel-host as the backend sees it: sandboxes with files, snapshots of those files, and a few commands. */
class FakeHost {
	readonly sandboxes = new Map<string, Omit<HostSandbox, "state"> & { state: string; files: Map<string, string> }>();
	readonly snapshots = new Map<string, Map<string, string>>();
	readonly calls: string[] = [];
	readonly params: { method: string; params: { [key: string]: unknown } }[] = [];
	/** Off: a kantel-host from before ranged reads, which answers a read's whole file and no fileSize. */
	rangedReads = true;
	/** The host images version it answers `host.images` with; absent, image patching is off on it. */
	images?: string;
	/** What its images' guest agent reports; absent, a host from before the guest agent said. */
	guest: HostGuest | undefined;
	/** What its isolate runtime says it can do, with each isolate; absent, a host from before kantel-isolate. */
	isolate: HostIsolateRuntime | undefined;
	/** Whether its machines run Chromium on its own display now (kantel-browser's record says :2, the display up). */
	ownBrowserDisplay = false;
	/** What its hello says it is: the features it reports, say. */
	facts: HostFacts = facts;
	/** Each sticky disk's newest version it holds. */
	readonly stickyHeads = new Map<string, string>();
	/** What its sticky.commit answers beside the version and its sizes (a block map's digest, say). */
	stickyCommitExtra: Record<string, unknown> = {};
	/** The phases a create, fork or resume answers with; absent, a host from before it said. */
	phases?: unknown;
	/**
	 * What `sandbox.processes` answers; absent, a host from before it listed them. Answering undefined: a sandbox whose
	 * guest agent is from before it could.
	 */
	processes?: (params: { [key: string]: unknown }) => unknown;
	/** An error `snapshot.keep` answers instead of keeping, such as a conflict on its ID. */
	keepRefusal?: { code: string; message: string };
	/** What `snapshot.list` answers, and whether it refuses instead. */
	listing: { id: string; sizeBytes?: number }[] = [];
	listRefusal = false;
	receive!: (text: string) => void;

	constructor(
		readonly service: HostsService,
		readonly hostId: string,
	) {}

	connect() {
		const held = this.service.hub.accept(this.hostId, {
			sendText: (text) => this.onText(JSON.parse(text) as HostMessage),
			sendBinary: () => undefined,
			close: () => undefined,
		});
		this.receive = (text) => held.receive(text);
		this.receive(
			JSON.stringify({
				type: "hello",
				hello: {
					hostId: this.hostId,
					facts: this.facts,
					sandboxes: [],
					capacity: { freeMemoryMiB: 30_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} },
				},
			}),
		);
	}

	private onText(message: HostMessage) {
		if (message.type !== "call") return;
		this.calls.push(message.method ?? "");
		const p = message.params as { [key: string]: unknown };
		this.params.push({ method: message.method ?? "", params: p });
		const answer = (result: unknown) => this.receive(JSON.stringify({ type: "result", id: message.id, result }));
		const fail = (code: string, text: string) =>
			this.receive(JSON.stringify({ type: "result", id: message.id, error: { code, message: text } }));
		const sandbox = this.sandboxes.get(String(p.sandboxId));
		const info = (s: { id: string; tier: string; size?: string; state: string }) => ({
			id: s.id,
			tier: s.tier,
			size: s.size,
			state: s.state,
			createdAt: 1,
			...(this.guest === undefined || s.tier !== "microvm" ? {} : { guest: this.guest }),
			...(this.isolate === undefined || s.tier !== "isolate" ? {} : { isolate: this.isolate }),
			...(this.phases === undefined ? {} : { phases: this.phases }),
		});
		switch (message.method) {
			case "sandbox.create": {
				const from = typeof p.from === "string" ? this.snapshots.get(p.from) : undefined;
				if (typeof p.from === "string" && from === undefined) return fail("not_found", "no such snapshot");
				const made = {
					id: String(p.sandboxId),
					tier: p.tier as "microvm",
					size: String(p.size),
					state: "running" as const,
					createdAt: 1,
					files: new Map(from ?? []),
				};
				this.sandboxes.set(made.id, made);
				// Its sticky disks, each a copy of the newest version the host holds, or a new disk.
				const sticky = Array.isArray(p.stickyDisks) ? (p.stickyDisks as { diskId: string; path: string }[]) : [];
				return answer({
					...info(made),
					...(sticky.length === 0
						? {}
						: {
								stickyDisks: sticky.map((disk) => {
									const version = this.stickyHeads.get(disk.diskId);
									return {
										diskId: disk.diskId,
										path: disk.path,
										...(version === undefined ? {} : { version }),
										state: "mounted",
									};
								}),
							}),
				});
			}
			case "sandbox.fork": {
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				const made = { ...sandbox, id: String(p.newId), files: new Map(sandbox.files) };
				this.sandboxes.set(made.id, made);
				return answer(info(made));
			}
			case "sticky.commit": {
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				this.stickyHeads.set(String(p.diskId), String(p.version));
				return answer({ version: p.version, sizeBytes: 100, allocatedBytes: 7, ...this.stickyCommitExtra });
			}
			case "sticky.delete":
				this.stickyHeads.delete(String(p.diskId));
				return answer({});
			case "sandbox.stop":
			case "snapshot.save": {
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				this.snapshots.set(String(p.snapshotId), new Map(sandbox.files));
				if (message.method === "sandbox.stop") sandbox.state = "stopped";
				return answer({ id: p.snapshotId, sandboxId: sandbox.id, kind: "auto", sizeBytes: 42, memory: true });
			}
			case "sandbox.resume":
			case "sandbox.start":
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				sandbox.state = "running";
				return answer(info(sandbox));
			case "sandbox.delete":
				this.sandboxes.delete(String(p.sandboxId));
				return answer({ ok: true });
			case "sandbox.egress":
			case "sandbox.env":
				return sandbox === undefined ? fail("not_found", "no such sandbox") : answer({ ok: true });
			case "sandbox.exec": {
				const argv = p.argv as string[] | undefined;
				if (argv?.[0] === "/.kantel/bin/kantel-guest") {
					// Only an injected agent is there.
					if (this.guest?.agent.injected !== true) {
						return answer({ exitCode: 1, stdout: "", stderr: "guest agent 500: fork/exec: no such file\n" });
					}
					return answer({ exitCode: 0, stdout: "--kantel-host-key--\nSHA256:injected\n", stderr: "" });
				}
				const command = String(p.command);
				if (command.includes("curl -fsS --max-time 5 http://127.0.0.1:9222/json/version")) {
					const checked = command.includes(`cat ${BROWSER_DISPLAY_RECORD}`);
					const mark = checked && this.ownBrowserDisplay ? BROWSER_SURFACE_MARK : "";
					return answer({
						exitCode: 0,
						stdout: `${mark}${JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc-123" })}`,
						stderr: "",
					});
				}
				if (command.includes("authorized_keys")) {
					const env = p.env as { KANTEL_PUBLIC_KEY: string };
					const key = env.KANTEL_PUBLIC_KEY === "" ? "-----BEGIN OPENSSH PRIVATE KEY-----\nmade\n" : "";
					return answer({ exitCode: 0, stdout: `${key}--kantel-host-key--\nSHA256:hostkey\n`, stderr: "" });
				}
				const echo = /^echo (.*)$/.exec(command);
				return answer({ exitCode: 0, stdout: echo === null ? "" : `${echo[1]}\n`, stderr: "" });
			}
			case "sandbox.files.write":
				sandbox?.files.set(String(p.path), unb64(String(p.data)));
				return answer({ ok: true });
			case "sandbox.files.read": {
				const data = sandbox?.files.get(String(p.path));
				if (data === undefined) return fail("not_found", "no such file");
				if (!this.rangedReads) return answer({ data: b64(data) });
				const offset = Number(p.offset ?? 0);
				const part = p.length === undefined ? data : data.slice(offset, offset + Number(p.length));
				return answer({ data: b64(part), size: part.length, fileSize: data.length });
			}
			case "sandbox.files.list":
				return answer({
					entries: [...(sandbox?.files.keys() ?? [])].map((path) => ({
						name: path.split("/").pop(),
						path,
						type: "file",
						size: sandbox?.files.get(path)?.length ?? 0,
					})),
				});
			case "sandbox.processes":
				if (this.processes === undefined) return fail("unsupported", `unknown method ${message.method}`);
				if (sandbox?.tier === "isolate") return fail("unsupported", "isolate sandboxes don't list their processes");
				return this.processes(p) === undefined
					? fail("unsupported", "this sandbox's guest agent is from before it could list its processes")
					: answer(this.processes(p));
			case "snapshot.read": {
				const data = this.snapshots.get(String(p.snapshotId))?.get(String(p.path));
				return data === undefined ? fail("not_found", "no such file") : answer({ data: b64(data) });
			}
			case "snapshot.delete":
				this.snapshots.delete(String(p.snapshotId));
				return answer({ ok: true });
			case "snapshot.keep": {
				if (this.keepRefusal !== undefined) return fail(this.keepRefusal.code, this.keepRefusal.message);
				const from = this.snapshots.get(String(p.from));
				if (from === undefined) return fail("not_found", `no snapshot ${String(p.from)} on this host`);
				this.snapshots.set(String(p.snapshotId), new Map(from));
				// As a host whose source has lost its memory to pruning answers.
				return answer({ id: p.snapshotId, kind: "saved", sizeBytes: 40, memory: false, base: "v2" });
			}
			case "snapshot.list":
				return this.listRefusal
					? fail("unavailable", "the host is busy")
					: answer({ snapshots: this.listing, shared: [] });
			case "host.images":
				return this.images === undefined
					? fail("unsupported", "image patching is off on this host")
					: answer({
							version: this.images,
							autoUpdate: true,
							...(p.sandboxId === undefined ? {} : { state: this.sandboxes.get(String(p.sandboxId))?.state }),
						});
			default:
				return fail("unsupported", `unknown method ${message.method}`);
		}
	}
}

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

function setup(options: { ports?: boolean } = {}) {
	const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test" });
	const relay = createMemoryRelayStore();
	const tickets = createTunnelTickets(relay);
	// The compute API comes after the router, as on a gateway: it is bound once there is one.
	let compute: ComputeApi | undefined;
	const ports =
		options.ports === true
			? createPortRouter({
					domain: "kantel-ports.test",
					openPort: (sandboxId, port, sink) => service.sandboxes.openPort(sandboxId, port, sink),
					store: relay,
					notRunning: async (sandboxId) => compute?.service.portNotRunning(sandboxId),
				})
			: undefined;
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets,
		attributionKey: "attr-key",
		...(ports === undefined ? {} : { ports }),
	});
	const api: ComputeApi = createComputeApi({
		backend,
		stickyDisks: true,
		authenticatePerson: async (request) => (request.headers.get("authorization") === "Bearer root" ? ROOT : undefined),
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
	});
	compute = api;
	service.useJoinTokens(joinTokenSpender(api.store));
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
	return { service, api, root, tickets, relay, ports, backend };
}

async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

describe("the compute API on kantel-host hosts", () => {
	it("joins a host with the API's token, then runs a microVM's lifecycle, files, snapshots and forks on it", async () => {
		const { service, root } = setup();
		// No host yet: nothing to place a sandbox on.
		const token = await root.createHostJoinToken({ name: "box-1", labels: { region: "eu" } });
		expect(token.command).toBe(
			`curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.test --token ${token.token}`,
		);
		const { hostId } = await service.register({ token: token.token, facts });
		await expect(service.register({ token: token.token, facts })).rejects.toThrow(/unknown, used or expired/);
		const host = new FakeHost(service, hostId);
		host.connect();
		// Its hello is answered once Kantel has read it back (async): it is online once welcomed.
		while (!service.hub.connected(hostId)) await new Promise((resolve) => setTimeout(resolve, 1));

		const listed = (await root.listHosts()).items;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ id: hostId, name: "box-1", state: "online", labels: { region: "eu" } });

		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		expect(sandbox.state).toBe("running");
		expect(sandbox.capabilities).toMatchObject({ exec: true, ssh: true, desktop: true, browser: true, kvm: true });
		expect(host.sandboxes.has(sandbox.id)).toBe(true);

		const run = await root.runCommand(sandbox.id, { command: "echo on a host" });
		expect(run.stdout).toBe("on a host\n");
		await root.writeFile(sandbox.id, { path: "/home/user/app.txt", content: "v1" });
		expect((await root.readFile(sandbox.id, { path: "/home/user/app.txt" })).content).toBe("v1");
		// A ranged read asks the host for the range; a read without one asks for one byte past 1 MiB, to refuse more.
		const reads = () => host.params.filter((call) => call.method === "sandbox.files.read").map((call) => call.params);
		expect(reads().at(-1)).toMatchObject({ offset: 0, length: 1024 * 1024 + 1 });
		const ranged = { path: "/home/user/app.txt", offset: 1, length: 5 };
		expect(await root.readFile(sandbox.id, ranged)).toMatchObject({ content: "1", size: 2, offset: 1 });
		expect(reads().at(-1)).toMatchObject({ offset: 1, length: 5 });
		// One from before ranged reads sends the whole file, which the backend cuts.
		host.rangedReads = false;
		expect(await root.readFile(sandbox.id, ranged)).toMatchObject({ content: "1", size: 2, offset: 1 });
		host.rangedReads = true;

		// A stop takes a snapshot on the host; its files are readable there, and a resume runs again.
		const stopped = await root.stopSandbox(sandbox.id, { wait: true });
		expect(stopped.state).toBe("stopped");
		const snapshotId = stopped.latestSnapshotId ?? "";
		const file = await root.readSnapshotFile(snapshotId, { path: "/home/user/app.txt" });
		expect(file.content).toBe("v1");
		expect((await root.resumeSandbox(sandbox.id, { wait: true })).state).toBe("running");

		// Forks and sandboxes made from a snapshot go on the snapshot's host.
		const forks = await root.forkSandbox(sandbox.id, { wait: true });
		const fork = forks.items[0];
		expect(fork?.state).toBe("running");
		expect((await root.readFile(fork?.id ?? "", { path: "/home/user/app.txt" })).content).toBe("v1");
		const saved = await root.saveSnapshot({ name: "base", sandboxId: sandbox.id });
		const fromSaved = await root.createSandbox({ type: "microvm", from: saved.id, wait: true });
		expect((await root.readFile(fromSaved.id, { path: "/home/user/app.txt" })).content).toBe("v1");
		// The host keeps the disk alone unless memory is asked for.
		await root.saveSnapshot({ name: "warm", sandboxId: sandbox.id, memory: true });
		const saves = host.params.filter((call) => call.method === "snapshot.save").map((call) => call.params);
		expect(saves.map((params) => params.memory)).toEqual([undefined, true]);
		expect(host.calls).toContain("sandbox.fork");

		await root.deleteSandbox(fork?.id ?? "");
		expect(host.sandboxes.has(fork?.id ?? "")).toBe(false);
	});

	it("sends the account's proxy settings to the host as each sandbox boots, and to running ones when they change", async () => {
		const { service, root } = setup();
		const token = await root.createHostJoinToken({ name: "box-1" });
		const { hostId } = await service.register({ token: token.token, facts });
		const host = new FakeHost(service, hostId);
		host.connect();
		const egressOf = (method: string) => host.params.filter((call) => call.method === method).at(-1)?.params.egress;

		// Off: the host's own default.
		const open = await root.createSandbox({ type: "microvm", wait: true });
		expect(egressOf("sandbox.create")).toBeUndefined();

		await root.putProxySettings({
			enabled: true,
			defaultAction: "deny",
			allow: ["*.npmjs.org"],
			deny: ["evil.example"],
			upstream: { url: "http://mehen.internal:3128", headers: { "X-Mehen-Key": "secret" } },
			attribution: true,
		});
		const want = {
			mode: "proxy",
			allow: ["*.npmjs.org"],
			deny: ["evil.example"],
			defaultDeny: true,
			upstream: "http://mehen.internal:3128",
			headers: { "X-Mehen-Key": "secret" },
			attributionKey: "attr-key",
			// Each sandbox's egress revision, which orders its updates.
			revision: expect.any(Number),
		};
		// The running sandbox gets them at once.
		await expect.poll(() => egressOf("sandbox.egress")).toEqual(want);
		expect(host.params.find((call) => call.method === "sandbox.egress")?.params.sandboxId).toBe(open.id);

		const proxied = await root.createSandbox({ type: "microvm", wait: true });
		expect(egressOf("sandbox.create")).toEqual(want);
		await root.forkSandbox(proxied.id, { wait: true });
		expect(egressOf("sandbox.fork")).toEqual(want);
		await root.stopSandbox(proxied.id, { wait: true });
		await root.resumeSandbox(proxied.id, { wait: true });
		expect(egressOf("sandbox.resume")).toEqual(want);

		// Turned off: running sandboxes go back to the host's default.
		const before = host.params.length;
		await root.putProxySettings({ enabled: false });
		await expect
			.poll(() => host.params.slice(before).filter((call) => call.method === "sandbox.egress").length)
			.toBeGreaterThanOrEqual(2);
		expect(egressOf("sandbox.egress")).toBeNull();
	});

	it("answers desktop, browser and SSH access as tunnel URLs with tickets the relay keeps", async () => {
		const { service, root, tickets } = setup();
		const token = await root.createHostJoinToken({});
		const { hostId } = await service.register({ token: token.token, facts });
		const host = new FakeHost(service, hostId);
		host.connect();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });

		// The desktop is Selkies' page on the gateway, whose stream goes through it with the same ticket.
		const desktop = await root.openDesktop(sandbox.id, { ttlMinutes: 5 });
		const page = "https://kantel.test/v1/hosts/desktop/";
		const ticketOf = (url: string) => url.slice(page.length).split("/")[0] ?? "";
		expect(desktop.url).toMatch(new RegExp(`^${page}[^/]+/$`));
		expect(desktop.embedUrl).toBe(desktop.url);
		const ticket = ticketOf(desktop.url);
		const prefix = `wss://kantel.test${HOSTS_TUNNEL_PATH}/`;
		const grant = await tickets.verify(ticket, Date.now());
		expect(grant).toMatchObject({ sandboxId: sandbox.id, port: 6080, desktop: "control" });
		// Given to the caller: the relay ends it when their access ends.
		expect(JSON.parse(grant?.grantee ?? "{}")).toEqual({ kind: "person", userId: "usr_root" });
		// View-only is kept in the ticket's row, so the gateway enforces it; the fragment is for Selkies' viewer page.
		const watch = await root.openDesktop(sandbox.id, { viewOnly: true });
		expect(watch.url).toMatch(new RegExp(`^${page}[^/]+/#shared$`));
		expect(await tickets.verify(ticketOf(watch.url), Date.now())).toMatchObject({ port: 6080, desktop: "view" });
		expect(await createTunnelTickets(createMemoryRelayStore()).verify(ticket, Date.now())).toBeUndefined();
		expect(await tickets.verify(ticket, Date.now() + 6 * 60_000)).toBeUndefined();
		expect(await tickets.verify(`${ticket.slice(0, -2)}xx`, Date.now())).toBeUndefined();

		const browser = await root.openBrowser(sandbox.id, {});
		expect(browser.cdpUrl).toMatch(new RegExp(`^${prefix}[^/]+/devtools/browser/abc-123$`));
		expect(browser.url.startsWith(page)).toBe(true);
		// No guest report of a browser surface, and Chromium on the desktop: its view is the desktop's.
		expect(browser.surface).toBe("desktop");
		expect(sandbox.capabilities.browserSurface).toBe(false);
		expect(await tickets.verify(ticketOf(browser.url), Date.now())).toMatchObject({ port: 6080, desktop: "control" });
		// The machine is what counts, not a report kept from another boot of its image: once it runs Chromium on its own
		// display (a cold boot under an upgraded host, say), the browser alone.
		host.ownBrowserDisplay = true;
		const alone = await root.openBrowser(sandbox.id, {});
		expect(alone.surface).toBe("browser");
		expect(await tickets.verify(ticketOf(alone.url), Date.now())).toMatchObject({ port: 6081, desktop: "control" });
		host.ownBrowserDisplay = false;
		// Unless asked, a URL can be opened for 10 minutes; and never for more than an hour.
		const cdpTicket = browser.cdpUrl.slice(prefix.length).split("/")[0] ?? "";
		const cdpGrant = await tickets.verify(cdpTicket, Date.now());
		expect(cdpGrant?.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
		expect(cdpGrant?.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
		expect(browser.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
		const longest = await root.openDesktop(sandbox.id, { ttlMinutes: 60 });
		expect(await tickets.verify(ticketOf(longest.url), Date.now() + 59 * 60_000)).toBeDefined();
		expect((await failure(root.openDesktop(sandbox.id, { ttlMinutes: 61 }))).code).toBe("invalid");
		expect((await failure(root.openSsh(sandbox.id, { ttlMinutes: 24 * 60 }))).code).toBe("invalid");

		const made = await root.openSsh(sandbox.id, {});
		expect(made.privateKey).toContain("OPENSSH PRIVATE KEY");
		expect(made.hostKeyFingerprint).toBe("SHA256:hostkey");
		expect(made.command).toMatch(/^ssh -o ProxyCommand='websocat --binary wss:\/\/kantel\.test\/v1\/hosts\/tunnel\//);
		expect(made.proxyUrl).toMatch(new RegExp(`^${prefix}[^/]+$`));
		expect((await tickets.verify(made.proxyUrl?.slice(prefix.length) ?? "", Date.now()))?.port).toBe(22);
		expect(made.command).toContain(made.proxyUrl);
		const own = await root.openSsh(sandbox.id, { publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM me@laptop" });
		expect(own.privateKey).toBeUndefined();
		expect((await failure(root.openSsh(sandbox.id, { publicKey: "ssh-ed25519 AAAA\nrm -rf /" }))).code).toBe("invalid");
	});

	it("exposes a microVM's ports only with a name for them, token-gated unless public, and says so on stop and forgets them on boot", async () => {
		const without = setup();
		const lone = await without.root.createHostJoinToken({});
		new FakeHost(without.service, (await without.service.register({ token: lone.token, facts })).hostId).connect();
		const plain = await without.root.createSandbox({ type: "microvm", wait: true });
		expect(plain.capabilities.ports).toBe(false);
		expect((await failure(without.root.exposePort(plain.id, { port: 3000 }))).code).toBe("not_supported");

		const { service, root, ports, relay } = setup({ ports: true });
		const token = await root.createHostJoinToken({});
		new FakeHost(service, (await service.register({ token: token.token, facts })).hostId).connect();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		expect(sandbox.capabilities.ports).toBe(true);
		const gated = await root.exposePort(sandbox.id, { port: 3000 });
		expect(gated.public).toBe(false);
		expect(gated.url).toBe(
			`https://3000-${sandbox.subdomain}.kantel-ports.test/?_token=${new URL(gated.url).searchParams.get("_token")}`,
		);
		expect(new URL(gated.url).searchParams.get("_token")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const open = await root.exposePort(sandbox.id, { port: 8080, public: true });
		expect(open.url).toBe(`https://8080-${sandbox.subdomain}.kantel-ports.test/`);
		const bare = new Request(`https://3000-${sandbox.subdomain}.kantel-ports.test/`);
		expect((await ports?.fetch(bare))?.status).toBe(401);
		// The records keep the URL without its token: it is shown once, in the answer to exposing the port.
		const listed = await root.listPorts(sandbox.id);
		expect(listed.items.find((entry) => entry.port === 3000)?.url).toBe(
			`https://3000-${sandbox.subdomain}.kantel-ports.test/`,
		);
		expect(JSON.stringify(await relay.exposuresOf(sandbox.id))).not.toContain(
			new URL(gated.url).searchParams.get("_token") ?? "-",
		);
		// Exposing it again gives it a new token and ends the old one; a public port answers as it is.
		const again = await root.exposePort(sandbox.id, { port: 3000 });
		expect(again.url).not.toBe(gated.url);
		expect((await ports?.fetch(new Request(gated.url)))?.status).toBe(401);
		expect((await root.exposePort(sandbox.id, { port: 8080, public: true })).url).toBe(open.url);

		const isolate = await root.createSandbox({ type: "isolate", wait: true });
		expect(isolate.capabilities.ports).toBe(false);

		// Recovering clears the recorded ports, and their URLs end with them.
		const recovered = await root.createSandbox({ type: "microvm", wait: true });
		const before = await root.exposePort(recovered.id, { port: 5173, public: true });
		expect((await ports?.fetch(new Request(before.url)))?.status).not.toBe(404);
		await root.recoverSandbox(recovered.id);
		await expect.poll(async () => (await root.getSandbox(recovered.id)).state).toBe("running");
		expect((await root.listPorts(recovered.id)).items).toEqual([]);
		expect(await relay.exposuresOf(recovered.id)).toEqual([]);
		expect((await ports?.fetch(new Request(before.url)))?.status).toBe(404);

		// A stopped sandbox's port says so, and how it is resumed: the request doesn't wake it.
		await root.stopSandbox(sandbox.id, { wait: true });
		const stopped = await ports?.fetch(new Request(open.url));
		expect(stopped?.status).toBe(503);
		expect(await stopped?.text()).toContain(`kantel resume ${sandbox.id}`);
		// Without the port's token, nothing is said about the sandbox.
		expect((await ports?.fetch(bare))?.status).toBe(401);
		expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
		// Its URLs end when it boots again; the port is exposed again for a new one.
		await root.resumeSandbox(sandbox.id, { wait: true });
		expect((await root.listPorts(sandbox.id)).items).toEqual([]);
		expect(await relay.exposuresOf(sandbox.id)).toEqual([]);
		expect((await ports?.fetch(new Request(open.url)))?.status).toBe(404);
	});

	it("runs node and python in an isolate where its host's runtime says so, and says memory is enforced where every host's is", async () => {
		const { service, root } = setup();
		const runtime: HostIsolateRuntime = {
			runtime: "deno_core",
			version: "0.1.0",
			javascript: true,
			python: true,
			memoryEnforced: true,
		};
		const token = await root.createHostJoinToken({});
		const { hostId } = await service.register({ token: token.token, facts: { ...facts, isolate: runtime } });
		const host = new FakeHost(service, hostId);
		host.facts = { ...facts, isolate: runtime };
		host.isolate = runtime;
		host.connect();
		const isolate = await root.createSandbox({ type: "isolate", wait: true });
		expect(isolate.capabilities).toMatchObject({ javascript: true, python: true, ssh: false });
		const vm = await root.createSandbox({ type: "microvm", wait: true });
		expect(vm.capabilities).toMatchObject({ javascript: true, python: true });
		expect((await root.getSandboxShapes()).isolate.enforced).toBe(true);
		const hosts = await service.list();
		expect(hosts.find((view) => view.id === hostId)?.isolate).toEqual(runtime);

		// A second host from before kantel-isolate: an isolate may land there, so memory isn't enforced everywhere.
		const older = await root.createHostJoinToken({});
		const second = await service.register({ token: older.token, facts });
		new FakeHost(service, second.hostId).connect();
		expect((await root.getSandboxShapes()).isolate.enforced).toBe(false);
	});

	it("runs neither node nor python in an isolate on a host from before kantel-isolate", async () => {
		const { service, root } = setup();
		const token = await root.createHostJoinToken({});
		new FakeHost(service, (await service.register({ token: token.token, facts })).hostId).connect();
		const isolate = await root.createSandbox({ type: "isolate", wait: true });
		expect(isolate.capabilities).toMatchObject({ javascript: false, python: false });
		expect((await root.getSandboxShapes()).isolate.enforced).toBe(false);
	});

	it("shows the browser alone where the image's guest reports a browser surface, view-only kept in the ticket", async () => {
		const { service, root, tickets } = setup();
		const token = await root.createHostJoinToken({});
		const { hostId } = await service.register({ token: token.token, facts });
		const host = new FakeHost(service, hostId);
		const has = (detail: string) => ({ available: true, detail });
		host.guest = {
			reportedAt: 1,
			agent: { version: "1.19.0", injected: false },
			os: { id: "ubuntu", name: "Ubuntu 26.04 LTS", version: "26.04" },
			arch: "x86_64",
			libc: "glibc",
			shell: "/bin/bash",
			init: "systemd",
			desktop: has("Xtigervnc, Openbox, Selkies"),
			browser: has("Chromium"),
			browserSurface: has("Xtigervnc, Selkies"),
			docker: { ...has("dockerd"), kvm: false },
		};
		host.ownBrowserDisplay = true;
		host.connect();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		expect(sandbox.capabilities).toMatchObject({ desktop: true, browser: true, browserSurface: true });

		const page = "https://kantel.test/v1/hosts/desktop/";
		const ticketOf = (url: string) => url.slice(page.length).split("/")[0] ?? "";
		const browser = await root.openBrowser(sandbox.id, {});
		expect(browser).toMatchObject({ surface: "browser", viewOnly: false });
		expect(browser.url).toMatch(new RegExp(`^${page}[^/]+/$`));
		expect(browser.embedUrl).toBe(browser.url);
		// Its own stream (6081), with its own ticket: not the desktop's page.
		expect(await tickets.verify(ticketOf(browser.url), Date.now())).toMatchObject({
			sandboxId: sandbox.id,
			port: 6081,
			desktop: "control",
		});
		const watch = await root.openBrowser(sandbox.id, { viewOnly: true });
		expect(watch.url).toMatch(new RegExp(`^${page}[^/]+/#shared$`));
		expect(await tickets.verify(ticketOf(watch.url), Date.now())).toMatchObject({ port: 6081, desktop: "view" });
		// The desktop is still the desktop.
		const desktop = await root.openDesktop(sandbox.id, {});
		expect(await tickets.verify(ticketOf(desktop.url), Date.now())).toMatchObject({ port: 6080 });

		// A machine that runs Chromium on the desktop (paused under an older host, or moved there by a template's setup),
		// whatever its image's report says: the desktop, which shows it.
		host.ownBrowserDisplay = false;
		const onDesktop = await root.openBrowser(sandbox.id, {});
		expect(onDesktop.surface).toBe("desktop");
		expect(await tickets.verify(ticketOf(onDesktop.url), Date.now())).toMatchObject({ port: 6080, desktop: "control" });
		expect(onDesktop.cdpUrl).toMatch(/\/devtools\/browser\/abc-123$/);
	});

	it("gives a microVM what its image's guest agent reports, and refuses the desktop and browser an image lacks", async () => {
		const { service, root } = setup();
		const token = await root.createHostJoinToken({});
		const { hostId } = await service.register({ token: token.token, facts });
		const host = new FakeHost(service, hostId);
		const lacks = (what: string) => ({ available: false, reason: `No ${what} in this image` });
		host.guest = {
			reportedAt: 1,
			agent: { version: "1.18.0", injected: true },
			os: { id: "alpine", name: "Alpine Linux v3.22", version: "3.22.7" },
			arch: "x86_64",
			libc: "musl",
			shell: "/bin/sh",
			init: "kantel",
			desktop: lacks("desktop"),
			browser: lacks("browser"),
			docker: { ...lacks("Docker"), kvm: true },
		};
		host.connect();

		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		expect(sandbox.capabilities).toMatchObject({
			exec: true,
			ssh: true,
			desktop: false,
			browser: false,
			docker: false,
			kvm: true,
			guest: { os: { id: "alpine" }, libc: "musl", agent: { injected: true } },
		});
		const desktop = await failure(root.openDesktop(sandbox.id, {}));
		expect(desktop).toMatchObject({ code: "not_supported", message: "No desktop in this image" });
		// SSH is the injected agent's own, with its own host key, let in by the agent rather than a shell script.
		const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM me@laptop";
		expect(await root.openSsh(sandbox.id, { publicKey: key })).toMatchObject({ hostKeyFingerprint: "SHA256:injected" });
		const ssh = host.params.filter((call) => call.method === "sandbox.exec").at(-1);
		expect(ssh?.params).toMatchObject({
			argv: ["/.kantel/bin/kantel-guest", "ssh-access"],
			env: { KANTEL_PUBLIC_KEY: key },
		});
		expect(await failure(root.openBrowser(sandbox.id, {}))).toMatchObject({ code: "not_supported" });

		// It keeps the report through a stop and a start.
		await root.stopSandbox(sandbox.id, { wait: true });
		await root.startSandbox(sandbox.id, { wait: true });
		expect((await root.getSandbox(sandbox.id)).capabilities).toMatchObject({
			desktop: false,
			guest: { os: { id: "alpine" } },
		});
	});

	it("keeps how a microVM's start took its time, by phase, on its record and its running event", async () => {
		const { service, root } = setup();
		const token = await root.createHostJoinToken({});
		const { hostId } = await service.register({ token: token.token, facts });
		const host = new FakeHost(service, hostId);
		host.connect();
		while (!service.hub.connected(hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		// A host from before phases: none.
		expect(sandbox.startup).toBeUndefined();
		const saved = await root.saveSnapshot({ name: "warm", sandboxId: sandbox.id });

		// Made from a disk-only snapshot on a host without reflinks: the disk copy is the slow part.
		host.phases = { disk: "copy", diskMs: 18_234.56, bootMs: 1_900, agentMs: 612.3, totalMs: 21_400 };
		const made = await root.createSandbox({ type: "microvm", from: saved.id, wait: true });
		expect(made.startup).toMatchObject({
			disk: "copy",
			diskMs: 18_234.6,
			bootMs: 1_900,
			agentMs: 612.3,
			hostMs: 21_400,
		});
		expect(made.startup?.totalMs).toBeGreaterThanOrEqual(21_400);
		expect((await root.getSandbox(made.id)).startup).toEqual(made.startup);
		const running = (await root.listEvents({ sandboxId: made.id, type: "sandbox.running" })).items;
		expect(running.map((event) => event.data.startup)).toEqual([made.startup]);

		// A fork of a running one: its source's live snapshot first.
		host.phases = { disk: "move", diskMs: 0.4, snapshotMs: 950, bootMs: 300, agentMs: 20, totalMs: 1_400 };
		const fork = (await root.forkSandbox(made.id, { wait: true })).items[0];
		expect(fork?.startup).toMatchObject({ disk: "move", snapshotMs: 950, hostMs: 1_400 });

		// A start whose host doesn't say leaves no previous start's phases behind; one it can't read is none.
		host.phases = undefined;
		await root.stopSandbox(made.id, { wait: true });
		expect((await root.resumeSandbox(made.id, { wait: true })).startup).toBeUndefined();
		host.phases = { disk: "teleport", diskMs: -1, bootMs: "fast", agentMs: 1, totalMs: 2 };
		const odd = await root.createSandbox({ type: "microvm", from: saved.id, wait: true });
		expect(odd.startup).toBeUndefined();
	});

	it("says why a sandbox can't be placed, at its create and when its host is gone", async () => {
		const { service, root } = setup();
		const none = await failure(root.createSandbox({ type: "microvm" }));
		expect([none.status, none.code, none.reason]).toEqual([503, "unavailable", "no_host"]);
		const join = async () => {
			const { hostId } = await service.register({ token: (await root.createHostJoinToken({})).token, facts });
			const host = new FakeHost(service, hostId);
			host.connect();
			return hostId;
		};
		const first = await join();
		const labelled = await failure(root.createSandbox({ type: "microvm", hostLabels: { zone: "ams" } }));
		expect([labelled.status, labelled.code, labelled.reason]).toEqual([503, "unavailable", "no_host_with_labels"]);
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		await root.stopSandbox(sandbox.id, { wait: true });
		// Its host goes; another is up. Its disk is on the first, so its boot fails, saying why.
		await join();
		service.hub.disconnect(first, 1001, "gone");
		const started = await root.startSandbox(sandbox.id, { wait: true });
		expect(started).toMatchObject({ state: "error", placementReason: "host_unavailable" });
		expect(started.reason).toContain(`The host its disk is on (${first}) can't take it now`);
	});

	it("attaches sticky disks only on a host that runs them, and commits and deletes them there", async () => {
		const { service, api, root, backend } = setup();
		const disk = await root.createStickyDisk({ name: "ci-cache", sizeGb: 50 });
		const plain = await service.register({ token: (await root.createHostJoinToken({ name: "old" })).token, facts });
		new FakeHost(service, plain.hostId).connect();
		while (!service.hub.connected(plain.hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
		const refused = await root.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: "ci-cache", path: "/var/lib/ci" }],
			wait: true,
		});
		expect(refused).toMatchObject({ state: "error", reason: expect.stringContaining("sticky disks") });

		const sticky = { ...facts, features: ["sticky-disks"] };
		const { hostId } = await service.register({
			token: (await root.createHostJoinToken({ name: "new" })).token,
			facts: sticky,
		});
		const host = new FakeHost(service, hostId);
		host.facts = sticky;
		host.connect();
		while (!service.hub.connected(hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
		const sandbox = await root.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: "ci-cache", path: "/var/lib/ci" }],
			wait: true,
		});
		expect(sandbox.hostId).toBe(hostId);
		const sent = (method: string) => host.params.filter((call) => call.method === method).map((call) => call.params);
		expect(sent("sandbox.create")[0]?.stickyDisks).toEqual([{ diskId: disk.id, path: "/var/lib/ci", sizeGiB: 50 }]);
		expect(sandbox.stickyDisks).toEqual([{ diskId: disk.id, name: "ci-cache", path: "/var/lib/ci", state: "mounted" }]);
		// A host from before block maps answers no digest; one with them, its version's map's, kept with the version. One
		// that isn't a digest is left out.
		const version = await root.commitStickyDisk(sandbox.id, "ci-cache");
		expect(version).toMatchObject({ hostId, sandboxId: sandbox.id, sizeBytes: 100, allocatedBytes: 7 });
		expect(sent("sticky.commit")).toEqual([{ sandboxId: sandbox.id, diskId: disk.id, version: version.id }]);
		expect((await api.store.stickyDiskVersions.get(version.id))?.mapDigest).toBeUndefined();
		host.stickyCommitExtra = { mapDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
		const mapped = await root.commitStickyDisk(sandbox.id, "ci-cache");
		expect((await api.store.stickyDiskVersions.get(mapped.id))?.mapDigest).toBe(
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		host.stickyCommitExtra = { mapDigest: "sha256:nope" };
		const odd = await root.commitStickyDisk(sandbox.id, "ci-cache");
		expect((await api.store.stickyDiskVersions.get(odd.id))?.mapDigest).toBeUndefined();
		// What a host holds, with each map digest it has: a version whose map was made after its commit gets it there.
		host.receive(
			JSON.stringify({
				type: "heartbeat",
				heartbeat: {
					capacity: {
						freeMemoryMiB: 30_000,
						freeDiskGiB: 400,
						running: 1,
						stopped: 0,
						load1: 0,
						warm: {},
						stickyDisks: [
							{
								diskId: disk.id,
								versions: [
									{
										version: odd.id,
										allocatedBytes: 7,
										at: 1,
										mapDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
									},
									{ version: version.id, allocatedBytes: 7, at: 1, mapDigest: "not a digest" },
								],
							},
						],
					},
				},
			}),
		);
		const reported = async () => (await backend.stickyHoldings?.())?.find((report) => report.hostId === hostId);
		while ((await reported())?.disks === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
		expect((await reported())?.disks).toEqual([
			{
				diskId: disk.id,
				versions: [odd.id, version.id],
				mapDigests: { [odd.id]: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
			},
		]);
		// A runner pool's beforeCommit runs as root, by the guest's own choice of user; any other command as the default.
		await backend.exec(sandbox.id, { command: "echo prune", asRoot: true });
		await backend.exec(sandbox.id, { command: "echo plain" });
		expect(sent("sandbox.exec").map((params) => [params.command, params.user])).toEqual([
			["echo prune", "root"],
			["echo plain", undefined],
		]);
		await root.deleteStickyDisk(disk.id);
		expect(sent("sticky.delete")).toEqual([{ diskId: disk.id }]);
	});

	it("revokes and drains a host through the API, and the registry follows", async () => {
		const { service, root } = setup();
		const token = await root.createHostJoinToken({});
		const { hostId, credential } = await service.register({ token: token.token, facts });
		new FakeHost(service, hostId).connect();
		expect((await root.updateHost(hostId, { draining: true })).state).toBe("draining");
		expect((await service.get(hostId)).state).toBe("draining");
		expect((await root.revokeHost(hostId)).state).toBe("revoked");
		expect(await service.authenticate(credential)).toBeUndefined();
	});
});

describe("a restart on the latest base, checked with the host first", () => {
	it("lists a microVM's processes from a host that says it can, and refuses where its host or guest agent can't", async () => {
		const { service, root } = setup();
		const listing = { features: ["processes"], ...facts };
		const token = await root.createHostJoinToken({ name: "box-1" });
		const { hostId } = await service.register({ token: token.token, facts: listing });
		const host = new FakeHost(service, hostId);
		host.facts = listing;
		host.processes = () => ({
			processes: [{ pid: 812, command: "yes", cpuPercent: 99.5, memoryBytes: 1_048_576 }],
			total: 41,
			sampleMs: 503,
		});
		host.connect();
		while (!service.hub.connected(hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const asked = () => host.params.filter((call) => call.method === "sandbox.processes").map((call) => call.params);

		expect(await root.listSandboxProcesses(sandbox.id, { limit: 8 })).toEqual({
			items: [{ pid: 812, command: "yes", cpuPercent: 99.5, memoryBytes: 1_048_576 }],
			total: 41,
		});
		expect(asked()).toEqual([{ sandboxId: sandbox.id, limit: 8 }]);
		// A guest agent from before it could: the host's unsupported.
		host.processes = () => undefined;
		expect((await failure(root.listSandboxProcesses(sandbox.id))).code).toBe("not_supported");
		expect(asked()).toHaveLength(2);
	});

	it("sends a sandbox's new env to its host as sandbox.env, the whole env each time", async () => {
		const { service, root, backend } = setup();
		const withEnv = { ...facts, features: ["sandbox-env"] };
		const token = await root.createHostJoinToken({ name: "box-1" });
		const { hostId } = await service.register({ token: token.token, facts: withEnv });
		const host = new FakeHost(service, hostId);
		host.facts = withEnv;
		host.connect();
		while (!service.hub.connected(hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const sent = () => host.params.filter((call) => call.method === "sandbox.env").map((call) => call.params);

		await backend.updateEnv?.(sandbox.id, { GH_TOKEN: "kph_attached", "WITH SPACE": 'a "b"\n' });
		await backend.updateEnv?.(sandbox.id, {});
		expect(sent()).toEqual([
			{ sandboxId: sandbox.id, env: { GH_TOKEN: "kph_attached", "WITH SPACE": 'a "b"\n' } },
			{ sandboxId: sandbox.id, env: {} },
		]);
		await expect(backend.updateEnv?.("sbx_nope", { A: "1" })).rejects.toMatchObject({ code: "not_found" });
	});

	it("sends no env to a host from before sandbox.env: the sandbox has it from its next boot", async () => {
		const { service, root, backend } = setup();
		const token = await root.createHostJoinToken({ name: "box-1" });
		const { hostId } = await service.register({ token: token.token, facts });
		const host = new FakeHost(service, hostId);
		host.connect();
		while (!service.hub.connected(hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		await backend.updateEnv?.(sandbox.id, { A: "1" });
		expect(host.calls).not.toContain("sandbox.env");
	});

	it("asks a host from before processes could be listed for none", async () => {
		const { service, root } = setup();
		const token = await root.createHostJoinToken({ name: "box-1" });
		const { hostId } = await service.register({ token: token.token, facts });
		const host = new FakeHost(service, hostId);
		host.connect();
		while (!service.hub.connected(hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const refused = await failure(root.listSandboxProcesses(sandbox.id));
		expect(refused.code).toBe("not_supported");
		expect(refused.message).toBe("This sandbox's host can't list its processes");
		expect(host.calls).not.toContain("sandbox.processes");
	});

	it("asks the sandbox's own host for its images, and refuses where it can't land", async () => {
		const { service, root, backend } = setup();
		const token = await root.createHostJoinToken({ name: "box-1" });
		const { hostId } = await service.register({ token: token.token, facts });
		const host = new FakeHost(service, hostId);
		host.connect();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const prepare = (rebaseTo?: string, eligibleHosts: readonly string[] = [hostId]) =>
			backend.prepareRebase?.(sandbox.id, { eligibleHosts, ...(rebaseTo === undefined ? {} : { rebaseTo }) });

		// Image patching off on the host.
		await expect(prepare("host-images-20261104.2")).rejects.toMatchObject({ code: "not_supported" });
		host.images = "host-images-20261103.1";
		// Not on the version yet.
		await expect(prepare("host-images-20261104.2")).rejects.toMatchObject({
			code: "unavailable",
			message: expect.stringMatching(/host-images-20261103\.1, not host-images-20261104\.2/),
		});
		// Its own host isn't one it may use now (another one is).
		await expect(prepare("host-images-20261103.1", ["hst_other"])).rejects.toMatchObject({ code: "unavailable" });
		// Where it lands, and whether its machine is running there (a record that says `error` may not know).
		await expect(prepare("host-images-20261103.1")).resolves.toEqual({ running: true });
		// Asked about this sandbox: its tier's images.
		expect(host.params.filter((call) => call.method === "host.images").at(-1)?.params).toEqual({
			sandboxId: sandbox.id,
		});
		// No version to land on (the index names no stable host images): refused, not left to whatever the host has.
		await expect(prepare()).rejects.toMatchObject({ code: "unavailable" });
		// No sandbox stopped for any of it.
		expect(host.calls.filter((method) => method === "sandbox.stop")).toEqual([]);
	});
});

describe("saving a stopped sandbox on a host", () => {
	async function connected(features: readonly string[]) {
		const { service, root, backend } = setup();
		const told = { ...facts, features: [...features] };
		const token = await root.createHostJoinToken({ name: "box-1" });
		const { hostId } = await service.register({ token: token.token, facts: told });
		const host = new FakeHost(service, hostId);
		host.facts = told;
		host.connect();
		while (!service.hub.connected(hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		await root.writeFile(sandbox.id, { path: "/home/user/app.txt", content: "v1" });
		const stopped = await root.stopSandbox(sandbox.id, { wait: true });
		const stopSnapshot = String(host.params.find((call) => call.method === "sandbox.stop")?.params.snapshotId);
		return { service, hostId, root, host, backend, sandbox, stopped, stopSnapshot };
	}

	it("reads each snapshot's full size from a host that measures them, for a limit on saved bytes", async () => {
		const { hostId, host, backend } = await connected(["snapshot-keep", "snapshot-sizes"]);
		host.listing = [{ id: "snap_1", sizeBytes: 61 }, { id: "snap_2", sizeBytes: 5 }, { id: "snap_3" }];
		expect(await backend.snapshotSizes?.(hostId)).toEqual(
			new Map([
				[`${hostId}/snap_1`, 61],
				[`${hostId}/snap_2`, 5],
			]),
		);
		expect(host.params.filter((call) => call.method === "snapshot.list").at(-1)?.params).toEqual({ sandboxId: "" });
		// A host that can't answer: an error, not a guess.
		host.listRefusal = true;
		await expect(backend.snapshotSizes?.(hostId)).rejects.toMatchObject({ code: "unavailable" });
	});

	it("says nothing of snapshots' full sizes for a host that doesn't measure them, and doesn't ask it", async () => {
		const { hostId, host, backend } = await connected(["snapshot-keep"]);
		const asked = host.calls.filter((method) => method === "snapshot.list").length;
		expect(await backend.snapshotSizes?.(hostId)).toBeUndefined();
		expect(host.calls.filter((method) => method === "snapshot.list")).toHaveLength(asked);
	});

	it("keeps the stop's snapshot as one of the save's own on the host, which outlasts the automatic one", async () => {
		const { root, host, sandbox, stopped, stopSnapshot } = await connected(["snapshot-keep"]);
		const saved = await root.saveSnapshot({ name: "kept", sandboxId: sandbox.id });
		const keeps = host.params.filter((call) => call.method === "snapshot.keep").map((call) => call.params);
		expect(keeps).toHaveLength(1);
		expect(keeps[0]?.from).toBe(stopSnapshot);
		expect(keeps[0]?.snapshotId).not.toBe(stopSnapshot);
		// The host's word on what it kept: its source's memory pruned, the save says none.
		expect(saved).toMatchObject({ kind: "saved", memory: false, sizeBytes: 40 });
		// The stop's entry stays in the history, automatic.
		expect((await root.getSnapshot(stopped.latestSnapshotId ?? "")).kind).toBe("automatic");
		// The host prunes the stop's snapshot, or removes it with its sandbox: the save's bytes are its own.
		host.snapshots.delete(stopSnapshot);
		expect((await root.readSnapshotFile(saved.id, { path: "/home/user/app.txt" })).content).toBe("v1");
		const made = await root.createSandbox({ type: "microvm", from: saved.id, wait: true });
		expect((await root.readFile(made.id, { path: "/home/user/app.txt" })).content).toBe("v1");
	});

	it("saves it as before on a host from before it could keep a copy: sharing the stop's snapshot, with a warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { root, host, sandbox } = await connected([]);
			const saved = await root.saveSnapshot({ name: "kept", sandboxId: sandbox.id });
			expect(saved).toMatchObject({ kind: "saved", name: "kept" });
			expect(host.calls).not.toContain("snapshot.keep");
			// The stop's own bytes, as a save of a stopped sandbox had before.
			expect((await root.readSnapshotFile(saved.id, { path: "/home/user/app.txt" })).content).toBe("v1");
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("snapshot-keep"));
		} finally {
			warn.mockRestore();
		}
	});

	it("answers the host's refusals as Kantel's errors, and stores no save for them", async () => {
		const { service, hostId, root, host, sandbox, stopSnapshot } = await connected(["snapshot-keep"]);
		// The host pruned the stop's snapshot: the source is gone.
		const pruned = host.snapshots.get(stopSnapshot);
		host.snapshots.delete(stopSnapshot);
		const gone = await failure(root.saveSnapshot({ name: "kept", sandboxId: sandbox.id }));
		expect([gone.status, gone.code]).toEqual([404, "not_found"]);
		if (pruned !== undefined) host.snapshots.set(stopSnapshot, pruned);

		// A refusal frees its idempotency key: the same key, once the host takes it, saves.
		host.keepRefusal = { code: "conflict", message: "snapshot snap_x already exists on this host" };
		const once = { idempotencyKey: "save-kept" };
		const refused = await failure(root.saveSnapshot({ name: "kept", sandboxId: sandbox.id }, once));
		expect([refused.status, refused.code]).toEqual([409, "conflict"]);
		host.keepRefusal = undefined;
		const saved = await root.saveSnapshot({ name: "kept", sandboxId: sandbox.id }, once);
		expect(saved).toMatchObject({ kind: "saved", name: "kept" });
		expect((await root.saveSnapshot({ name: "kept", sandboxId: sandbox.id }, once)).id).toBe(saved.id);

		// The host is away: unavailable, not the compute API's own failure.
		service.hub.disconnect(hostId, 1001, "gone");
		const away = await failure(root.saveSnapshot({ name: "away", sandboxId: sandbox.id }));
		expect([away.status, away.code]).toEqual([503, "unavailable"]);
		expect((await root.listSnapshots({ kind: "saved" })).items.map((item) => item.name)).toEqual(["kept"]);
	});
});
