// The compute API (`@kantel/compute`) over the host backend, end to end through the hub with a fake kantel-host: a
// host joins with a token the API minted, shows up in the API's host list, and runs a sandbox's lifecycle, commands,
// files, snapshots and forks; desktop, browser and SSH access come back as signed tunnel URLs.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender } from "@kantel/compute";
import { afterEach, describe, expect, it } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { createPortRouter } from "../src/ports.ts";
import type { HostFacts, HostMessage, HostSandbox } from "../src/protocol.ts";
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
					facts,
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
				return answer(info(made));
			}
			case "sandbox.fork": {
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				const made = { ...sandbox, id: String(p.newId), files: new Map(sandbox.files) };
				this.sandboxes.set(made.id, made);
				return answer(info(made));
			}
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
				return sandbox === undefined ? fail("not_found", "no such sandbox") : answer({ ok: true });
			case "sandbox.exec": {
				const command = String(p.command);
				if (command.startsWith("curl") && command.includes("9222/json/version")) {
					return answer({
						exitCode: 0,
						stdout: JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc-123" }),
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
			case "snapshot.read": {
				const data = this.snapshots.get(String(p.snapshotId))?.get(String(p.path));
				return data === undefined ? fail("not_found", "no such file") : answer({ data: b64(data) });
			}
			case "snapshot.delete":
				this.snapshots.delete(String(p.snapshotId));
				return answer({ ok: true });
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
	const ports =
		options.ports === true
			? createPortRouter({
					domain: "kantel-ports.test",
					openPort: (sandboxId, port, sink) => service.sandboxes.openPort(sandboxId, port, sink),
					store: relay,
				})
			: undefined;
	const api: ComputeApi = createComputeApi({
		backend: createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets,
			attributionKey: "attr-key",
			...(ports === undefined ? {} : { ports }),
		}),
		authenticatePerson: async (request) => (request.headers.get("authorization") === "Bearer root" ? ROOT : undefined),
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
	});
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
	return { service, api, root, tickets, relay, ports };
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
			`sudo npx -y @kantel/host@latest install --url https://kantel.test --token ${token.token}`,
		);
		const { hostId } = await service.register({ token: token.token, facts });
		await expect(service.register({ token: token.token, facts })).rejects.toThrow(/unknown, used or expired/);
		const host = new FakeHost(service, hostId);
		host.connect();

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
		new FakeHost(service, hostId).connect();
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

	it("exposes a microVM's ports only with a name for them, token-gated unless public, and forgets them on stop", async () => {
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

		await root.stopSandbox(sandbox.id, { wait: true });
		expect((await ports?.fetch(new Request(open.url)))?.status).toBe(404);
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
