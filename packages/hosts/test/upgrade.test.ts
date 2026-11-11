// Upgrading an isolate to a microVM on kantel-host hosts, through the compute API and the hub: on the isolate's own
// host (`sandbox.upgrade`, the files never leaving it), or on another host with Kantel moving the files (listed and
// read from the isolate's host, written as a tar into the microVM and extracted there), with the placement following
// only once the microVM has them, and a failure leaving the isolate where and as it was. And a command's needsMicrovm,
// passed through from the host. apps/host/test/upgrade-crosshost.sh moves one between real hosts.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender } from "@kantel/compute";
import { afterEach, describe, expect, it } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { HOST_FEATURES, type HostFacts, type HostMessage } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore, type HostStore, type PlacementRecord } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";

const BOTH = ["microvm", "isolate"] as const;

const factsOf = (tiers: readonly ("microvm" | "isolate")[], features: readonly string[]): HostFacts => ({
	version: "0.1.0",
	protocol: 1,
	os: "linux",
	arch: "amd64",
	kernel: "6.8",
	hostname: "box",
	cpus: 16,
	memoryMiB: 32_768,
	diskGiB: 500,
	kvm: tiers.includes("microvm"),
	nested: true,
	tiers: [...tiers],
	sizes: tiers.includes("microvm") ? [{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 }] : [],
	egress: "proxy",
	features: [...features],
});

const b64 = (bytes: Uint8Array) => {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
};
const unb64 = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
const text = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

/** The entries of a tar, as the host's extract would write them: name, type and bytes. */
function readTar(tar: Uint8Array): { name: string; type: string; link: string; mode: number; data: Uint8Array }[] {
	const out: { name: string; type: string; link: string; mode: number; data: Uint8Array }[] = [];
	const field = (block: Uint8Array, at: number, width: number) =>
		new TextDecoder().decode(block.subarray(at, at + width)).replace(/\0.*$/s, "");
	let pax: string | undefined;
	for (let at = 0; at + 512 <= tar.length; ) {
		const block = tar.subarray(at, at + 512);
		if (block.every((byte) => byte === 0)) break;
		const size = Number.parseInt(field(block, 124, 12), 8) || 0;
		const type = field(block, 156, 1);
		const data = tar.subarray(at + 512, at + 512 + size);
		at += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			pax = /\d+ path=(.*)\n/.exec(new TextDecoder().decode(data))?.[1];
			continue;
		}
		out.push({
			name: pax ?? field(block, 0, 100),
			type,
			link: field(block, 157, 100),
			mode: Number.parseInt(field(block, 100, 8), 8),
			data: data.slice(),
		});
		pax = undefined;
	}
	return out;
}

interface Held {
	tier: "microvm" | "isolate";
	state: string;
	size: string;
	/** An isolate's /workspace (relative paths), or a microVM's files (absolute paths). */
	readonly files: Map<string, { kind: "file" | "dir" | "symlink"; data?: Uint8Array; target?: string; mode?: number }>;
}

/** kantel-host as an upgrade sees it: isolates over manifests, microVMs with files, and the calls it was sent. */
class Host {
	readonly sandboxes = new Map<string, Held>();
	readonly calls: { method: string; params: { [key: string]: unknown } }[] = [];
	/** An error `sandbox.upgrade` answers instead. */
	refuseUpgrade?: { code: string; message: string };
	/** An error `sandbox.files.extract` answers instead. */
	refuseExtract?: { code: string; message: string };
	/** What an isolate's command answers. */
	isolateExec?: (command: string) => unknown;
	/** An error a method answers instead, by method. */
	refuseMethod?: (method: string) => { code: string; message: string } | undefined;
	/** `sandbox.upgrade` is done but its answer `drop`ped, or sent this many milliseconds late. */
	upgradeAnswer?: "drop" | number;
	/** `sandbox.create` makes the sandbox but its answer is dropped. */
	dropCreateAnswer = false;
	/** The next `sandbox.upgrade.thaw` is done, but answered only once this settles. */
	holdThaw?: Promise<void>;
	/** How long a file read takes to answer, in milliseconds, and the most answered at once so far. */
	readDelayMs = 0;
	private readsUnderWay = 0;
	mostReadsAtOnce = 0;
	/** A file whose reads answer this many more bytes than its listing says (it grows as it is read). */
	growing?: { name: string; extra: number };
	/** Each upgrade by sandbox, as kantel-host keeps it: its operation, and its outcome once it has one. */
	readonly upgrades = new Map<
		string,
		{ op: string; done: Promise<{ state: string; sandbox?: unknown; error?: string }> }
	>();
	/** Isolates held still for an upgrade, by sandbox: the operation. */
	readonly frozen = new Map<string, string>();
	/** Detached isolate commands' ends, by command ID (`sandbox.exec.get`). */
	readonly ended = new Map<string, unknown>();
	/** Commands under way in isolates. */
	readonly running = new Set<Promise<void>>();
	receive!: (text: string) => void;

	constructor(
		readonly service: HostsService,
		readonly hostId: string,
		readonly facts: HostFacts,
	) {}

	heartbeat() {
		this.receive(
			JSON.stringify({
				type: "heartbeat",
				heartbeat: { capacity: { freeMemoryMiB: 30_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0 } },
			}),
		);
	}

	async connect() {
		const held = this.service.hub.accept(this.hostId, {
			sendText: (raw) => this.onText(JSON.parse(raw) as HostMessage),
			sendBinary: () => undefined,
			close: () => undefined,
		});
		this.receive = (raw) => held.receive(raw);
		this.receive(
			JSON.stringify({
				type: "hello",
				hello: {
					hostId: this.hostId,
					facts: this.facts,
					sandboxes: [...this.sandboxes.entries()].map(([id, held]) => ({
						id,
						tier: held.tier,
						size: held.size,
						state: held.state,
						createdAt: 1,
					})),
					capacity: { freeMemoryMiB: 30_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0 },
				},
			}),
		);
		while (!this.service.hub.connected(this.hostId)) await new Promise((resolve) => setTimeout(resolve, 1));
	}

	methods(): string[] {
		return this.calls.map((call) => call.method);
	}

	private onText(message: HostMessage) {
		if (message.type !== "call") return;
		const p = message.params as { [key: string]: unknown };
		this.calls.push({ method: message.method ?? "", params: p });
		const answer = (result: unknown) => this.receive(JSON.stringify({ type: "result", id: message.id, result }));
		const fail = (error: { code: string; message: string }) =>
			this.receive(JSON.stringify({ type: "result", id: message.id, error }));
		const id = String(p.sandboxId);
		const sandbox = this.sandboxes.get(id);
		const info = (s: Held, extra: object = {}) => ({
			id,
			tier: s.tier,
			size: s.size,
			state: s.state,
			createdAt: 1,
			...extra,
		});
		const path = String(p.path ?? "");
		const key = sandbox?.tier === "isolate" ? path.replace(/^\/workspace\/?/, "") : path;
		const refused = this.refuseMethod?.(message.method ?? "");
		if (refused !== undefined) return fail(refused);
		const frozen = () => fail({ code: "conflict", message: `sandbox ${id} is being upgraded to a microVM` });
		switch (message.method) {
			case "sandbox.create": {
				const made: Held = {
					tier: p.tier === "isolate" ? "isolate" : "microvm",
					state: "running",
					size: p.tier === "isolate" ? "isolate" : String(p.size || "default"),
					files: new Map(),
				};
				this.sandboxes.set(id, made);
				if (this.dropCreateAnswer) return;
				return answer(info(made));
			}
			case "sandbox.get":
				return sandbox === undefined ? fail({ code: "not_found", message: "no such sandbox" }) : answer(info(sandbox));
			case "sandbox.upgrade": {
				const op = String(p.operationId);
				const kept = this.upgrades.get(id);
				if (kept?.op === op) {
					void kept.done.then((outcome) =>
						outcome.state === "done"
							? answer(outcome.sandbox)
							: fail({ code: "unavailable", message: outcome.error ?? "" }),
					);
					return;
				}
				if (this.refuseUpgrade !== undefined) return fail(this.refuseUpgrade);
				if (sandbox?.tier !== "isolate") return fail({ code: "conflict", message: "not an isolate" });
				let files = 0;
				let bytes = 0;
				const moved = new Map<string, Held["files"] extends Map<string, infer V> ? V : never>();
				for (const [name, entry] of sandbox.files) {
					moved.set(`/home/user/workspace/${name}`, entry);
					files += 1;
					bytes += entry.data?.length ?? 0;
				}
				const delay = typeof this.upgradeAnswer === "number" ? this.upgradeAnswer : 0;
				const done = new Promise<{ state: string; sandbox?: unknown }>((resolve) =>
					setTimeout(() => {
						const microvm: Held = {
							tier: "microvm",
							state: "running",
							size: String(p.size || "default"),
							files: moved,
						};
						this.sandboxes.set(id, microvm);
						resolve({
							state: "done",
							sandbox: info(microvm, { moved: { files, bytes }, timings: { "upgrade.total": 1200 } }),
						});
					}, delay),
				);
				this.upgrades.set(id, { op, done });
				if (this.upgradeAnswer === "drop") return;
				void done.then((outcome) => answer(outcome.sandbox));
				return;
			}
			case "sandbox.upgrade.settle": {
				const op = String(p.operationId);
				const kept = this.upgrades.get(id);
				if (kept?.op === op) {
					void kept.done.then(answer);
					return;
				}
				this.upgrades.set(id, { op, done: Promise.resolve({ state: "failed", error: "rolled back" }) });
				return answer({ state: "failed", error: "rolled back" });
			}
			case "sandbox.upgrade.freeze": {
				if (sandbox?.tier !== "isolate") return fail({ code: "not_found", message: "no such isolate" });
				// What is under way ends first; nothing after it gets in.
				void Promise.all(this.running).then(() => {
					this.frozen.set(id, String(p.operationId));
					answer({ ok: true });
				});
				return;
			}
			case "sandbox.upgrade.thaw": {
				if (this.frozen.get(id) === String(p.operationId)) this.frozen.delete(id);
				const held = this.holdThaw;
				this.holdThaw = undefined;
				if (held !== undefined) {
					void held.then(() => answer({ ok: true }));
					return;
				}
				return answer({ ok: true });
			}
			case "sandbox.delete":
				this.sandboxes.delete(id);
				return answer({ ok: true });
			case "sandbox.exec": {
				if (sandbox?.tier === "isolate" && this.frozen.has(id)) return frozen();
				// A command that writes a file a moment after it starts.
				const slow = /^slow-write (\S+)$/.exec(String(p.command ?? ""));
				if (sandbox?.tier === "isolate" && slow !== null) {
					const work = new Promise<void>((resolve) =>
						setTimeout(() => {
							sandbox.files.set(slow[1] ?? "", { kind: "file", data: enc("late\n"), mode: 0o644 });
							resolve();
						}, 150),
					);
					this.running.add(work);
					void work.then(() => {
						this.running.delete(work);
						answer({ exitCode: 0, stdout: "", stderr: "", durationMs: 150 });
					});
					return;
				}
				if (sandbox?.tier === "isolate" && this.isolateExec !== undefined) {
					const result = this.isolateExec(String(p.command));
					// Detached (`execControl`): started at once, its end `sandbox.exec.get`'s.
					if (p.detached === true && typeof p.commandId === "string") {
						this.ended.set(p.commandId, result);
						return answer({ commandId: p.commandId, state: "running" });
					}
					return answer(result);
				}
				return answer({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
			}
			case "sandbox.exec.get": {
				const result = this.ended.get(String(p.commandId));
				if (result === undefined) return fail({ code: "not_found", message: "no such command" });
				return answer({ commandId: p.commandId, state: "exited", result });
			}
			case "sandbox.files.write":
				if (sandbox?.tier === "isolate" && this.frozen.has(id)) return frozen();
				sandbox?.files.set(key, { kind: "file", data: unb64(String(p.data)), mode: Number(p.mode ?? 0o644) });
				return answer({ ok: true });
			case "sandbox.files.read": {
				const listed = sandbox?.files.get(key)?.data;
				const data =
					listed !== undefined && this.growing?.name === key
						? new Uint8Array(listed.length + this.growing.extra).fill(1)
						: listed;
				if (data === undefined) return fail({ code: "not_found", message: `no file ${path}` });
				const offset = Number(p.offset ?? 0);
				const part = p.length === undefined ? data : data.subarray(offset, offset + Number(p.length));
				const result = { data: b64(part), size: part.length, fileSize: data.length };
				if (this.readDelayMs === 0) return answer(result);
				this.readsUnderWay += 1;
				this.mostReadsAtOnce = Math.max(this.mostReadsAtOnce, this.readsUnderWay);
				setTimeout(() => {
					this.readsUnderWay -= 1;
					answer(result);
				}, this.readDelayMs);
				return;
			}
			case "sandbox.files.list": {
				const prefix = key === "" ? "" : `${key}/`;
				const entries = [...(sandbox?.files.entries() ?? [])]
					.filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
					.map(([name, entry]) => ({
						name: name.slice(prefix.length),
						path: `/workspace/${name}`,
						type: entry.kind,
						size: entry.data?.length ?? 0,
						mode: entry.mode ?? 0,
						...(entry.target === undefined ? {} : { target: entry.target }),
					}));
				return answer({ entries });
			}
			case "sandbox.files.extract": {
				if (this.refuseExtract !== undefined) return fail(this.refuseExtract);
				const archive = sandbox?.files.get(String(p.archive))?.data;
				if (sandbox === undefined || archive === undefined) return fail({ code: "not_found", message: "no archive" });
				sandbox.files.delete(String(p.archive));
				for (const entry of readTar(archive)) {
					const at = `${String(p.target)}/${entry.name.replace(/\/$/, "")}`;
					sandbox.files.set(
						at,
						entry.type === "5"
							? { kind: "dir" }
							: entry.type === "2"
								? { kind: "symlink", target: entry.link }
								: { kind: "file", data: entry.data, mode: entry.mode },
					);
				}
				return answer({ ok: true });
			}
			case "sandbox.egress":
			case "sandbox.env":
				return answer({ ok: true });
			default:
				return fail({ code: "unsupported", message: `unknown method ${message.method}` });
		}
	}
}

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

async function setup(
	hosts: readonly { readonly name: string; readonly facts: HostFacts }[],
	options: Partial<Parameters<typeof createHostsService>[0]> = {},
) {
	const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test", ...options });
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
	});
	const api: ComputeApi = createComputeApi({
		backend,
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
	const made: Host[] = [];
	for (const each of hosts) {
		const token = await root.createHostJoinToken({ name: each.name });
		const { hostId } = await service.register({ token: token.token, facts: each.facts });
		const host = new Host(service, hostId, each.facts);
		await host.connect();
		made.push(host);
	}
	return { service, api, root, hosts: made };
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

const enc = (value: string) => new TextEncoder().encode(value);

describe("upgrading an isolate on kantel-host hosts", () => {
	it("is done by the isolate's own host when it can, the files never leaving it", async () => {
		const { root, service, hosts } = await setup([
			{ name: "both", facts: factsOf(BOTH, [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateUpgrade]) },
		]);
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		host.sandboxes.get(sandbox.id)?.files.set("notes.md", { kind: "file", data: enc("# notes\n") });

		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ id: sandbox.id, type: "microvm", state: "running", hostId: host.hostId });
		expect(host.methods()).toContain("sandbox.upgrade");
		expect(host.methods()).not.toContain("sandbox.files.read");
		const sent = host.calls.find((call) => call.method === "sandbox.upgrade")?.params;
		expect(sent).toMatchObject({ sandboxId: sandbox.id, tier: "microvm", size: "default" });
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ tier: "microvm", hostId: host.hostId });
		const event = (await root.listEvents({ sandboxId: sandbox.id })).items.find(
			(each) => each.type === "sandbox.upgraded",
		);
		expect(event?.data).toMatchObject({ path: "host", files: 1, bytes: 8 });
		expect(text(host.sandboxes.get(sandbox.id)?.files.get("/home/user/workspace/notes.md")?.data)).toBe("# notes\n");
	});

	it("moves the files to a microVM on another host when its own can't make one", { timeout: 60_000 }, async () => {
		const { root, service, hosts } = await setup([
			{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
			{
				name: "vms",
				facts: factsOf(
					["microvm"],
					[HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract, HOST_FEATURES.fileStreams],
				),
			},
		]);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		expect(isolates.sandboxes.has(sandbox.id)).toBe(true);
		const workspace = isolates.sandboxes.get(sandbox.id)?.files;
		const long = `${"d".repeat(60)}/${"f".repeat(80)}.txt`;
		workspace?.set("src", { kind: "dir" });
		workspace?.set("src/a.txt", { kind: "file", data: enc("hello\n"), mode: 0o644 });
		workspace?.set("run.sh", { kind: "file", data: enc("#!/bin/sh\n"), mode: 0o755 });
		workspace?.set("link", { kind: "symlink", target: "src/a.txt" });
		// Links to absolute paths in the isolate's /workspace, which the microVM's extractor refuses as they are: made
		// relative to where they are, the rest of the path as it was.
		workspace?.set("src/up", { kind: "symlink", target: "/workspace/run.sh" });
		workspace?.set("src/top", { kind: "symlink", target: "/workspace" });
		workspace?.set("abs", { kind: "symlink", target: "/workspace//src/../src/a.txt" });
		// Through a link, then up: out of the workspace as text, in it where the isolate resolves it.
		workspace?.set("src/deep", { kind: "dir" });
		workspace?.set("jump", { kind: "symlink", target: "/workspace/src/deep" });
		// One the isolate can't resolve (through a missing directory) is left as it was, for the extractor to refuse.
		workspace?.set("src/broken", { kind: "symlink", target: "../jump/../../missing/../run.sh" });
		workspace?.set("to-file", { kind: "symlink", target: "/workspace/jump/../../run.sh" });
		workspace?.set("src/through", { kind: "symlink", target: "../jump/../../run.sh" });
		workspace?.set("d".repeat(60), { kind: "dir" });
		workspace?.set(long, { kind: "file", data: enc("long\n") });
		// A big file, read a part at a time.
		const big = new Uint8Array(9 * 1024 * 1024).fill(7);
		workspace?.set("big.bin", { kind: "file", data: big });

		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ id: sandbox.id, type: "microvm", hostId: vms.hostId });
		const files = vms.sandboxes.get(sandbox.id)?.files;
		expect(text(files?.get("/home/user/workspace/src/a.txt")?.data)).toBe("hello\n");
		expect(files?.get("/home/user/workspace/run.sh")?.mode).toBe(0o755);
		expect(files?.get("/home/user/workspace/link")).toEqual({ kind: "symlink", target: "src/a.txt" });
		expect(files?.get("/home/user/workspace/src/up")).toEqual({ kind: "symlink", target: "../run.sh" });
		expect(files?.get("/home/user/workspace/src/top")).toEqual({ kind: "symlink", target: ".." });
		expect(files?.get("/home/user/workspace/abs")).toEqual({ kind: "symlink", target: "src/../src/a.txt" });
		expect(files?.get("/home/user/workspace/jump")).toEqual({ kind: "symlink", target: "src/deep" });
		expect(files?.get("/home/user/workspace/to-file")).toEqual({ kind: "symlink", target: "run.sh" });
		expect(files?.get("/home/user/workspace/src/through")).toEqual({ kind: "symlink", target: "../run.sh" });
		expect(files?.get("/home/user/workspace/src/broken")).toEqual({
			kind: "symlink",
			target: "../jump/../../missing/../run.sh",
		});
		expect(text(files?.get(`/home/user/workspace/${long}`)?.data)).toBe("long\n");
		expect(files?.get("/home/user/workspace/big.bin")?.data?.length).toBe(big.length);
		const reads = isolates.calls.filter(
			(call) => call.method === "sandbox.files.read" && call.params.path === "/workspace/big.bin",
		);
		expect(reads.length).toBe(2);
		// /workspace linked as root, the staged tar gone, the isolate deleted from its host, the placement moved.
		const link = vms.calls.find((call) => call.method === "sandbox.exec")?.params;
		expect(link).toMatchObject({ user: "root" });
		expect(JSON.stringify(link?.argv)).toContain("ln -sfn /home/user/workspace /workspace");
		expect([...(files?.keys() ?? [])].some((name) => name.startsWith("/tmp/"))).toBe(false);
		expect(isolates.sandboxes.has(sandbox.id)).toBe(false);
		// Deleted keeping its snapshots, which stay the sandbox's, an isolate's.
		expect(isolates.calls.find((call) => call.method === "sandbox.delete")?.params).toEqual({
			sandboxId: sandbox.id,
			keepSnapshots: true,
		});
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ tier: "microvm", hostId: vms.hostId });
		const event = (await root.listEvents({ sandboxId: sandbox.id })).items.find(
			(each) => each.type === "sandbox.upgraded",
		);
		expect(event?.data).toMatchObject({ path: "control-plane", files: 15, bytes: 6 + 10 + 5 + big.length });
		// Its commands go to the microVM now.
		await root.runCommand(sandbox.id, { command: "ls" });
		expect(vms.calls.filter((call) => call.method === "sandbox.exec")).toHaveLength(2);
	});

	it("leaves the isolate where and as it was when its own host has no room and no other can take it", async () => {
		const both = factsOf(BOTH, [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateUpgrade]);
		const { root, service, hosts } = await setup([{ name: "both", facts: both }]);
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		host.refuseUpgrade = { code: "capacity", message: "no room for the microVM" };
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const refused = await failure(root.upgradeSandbox(sandbox.id, {}));
		expect(refused.status).toBe(429);
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ tier: "isolate", hostId: host.hostId });
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ type: "isolate", state: "running" });
		expect(host.sandboxes.get(sandbox.id)?.tier).toBe("isolate");
	});

	it("deletes the microVM it made elsewhere and keeps the isolate when the files can't be put in", async () => {
		const { root, service, hosts } = await setup([
			{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
			{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
		]);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		vms.refuseExtract = { code: "invalid", message: "the archive is refused" };
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		isolates.sandboxes.get(sandbox.id)?.files.set("a.txt", { kind: "file", data: enc("a") });
		const refused = await failure(root.upgradeSandbox(sandbox.id, {}));
		expect(refused.message).toContain("the archive is refused");
		expect(vms.sandboxes.has(sandbox.id)).toBe(false);
		expect(vms.methods()).toContain("sandbox.delete");
		expect(isolates.sandboxes.get(sandbox.id)?.tier).toBe("isolate");
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ tier: "isolate", hostId: isolates.hostId });
		expect((await root.getSandbox(sandbox.id)).type).toBe("isolate");
	});

	it("refuses to move more files than Kantel carries between hosts, thawing the isolate", async () => {
		const { root, hosts } = await setup(
			[
				{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
				{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
			],
			{ upgradeMoveLimits: { files: 100, bytes: 1 << 20 } },
		);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const workspace = isolates.sandboxes.get(sandbox.id)?.files;
		for (let index = 0; index <= 100; index++) workspace?.set(`f${index}`, { kind: "symlink", target: "x" });
		const refused = await failure(root.upgradeSandbox(sandbox.id, {}));
		expect(refused.status).toBe(501);
		expect(refused.message).toContain("too many files");
		expect(vms.sandboxes.has(sandbox.id)).toBe(false);
		expect(isolates.frozen.has(sandbox.id)).toBe(false);
		expect((await root.getSandbox(sandbox.id)).type).toBe("isolate");
	});

	it("refuses a workspace past the limits as listed, before it makes a microVM or reads a file", async () => {
		const { root, service, hosts } = await setup(
			[
				{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
				{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
			],
			{ upgradeMoveLimits: { files: 100, bytes: 1000 } },
		);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const many = await root.createSandbox({ type: "isolate", wait: true });
		for (let index = 0; index <= 100; index++) {
			isolates.sandboxes.get(many.id)?.files.set(`f${index}`, { kind: "file", data: enc("x") });
		}
		const big = await root.createSandbox({ type: "isolate", wait: true });
		isolates.sandboxes.get(big.id)?.files.set("big.bin", { kind: "file", data: new Uint8Array(1001) });
		for (const [sandbox, why] of [
			[many, "too many files"],
			[big, "too many bytes"],
		] as const) {
			const refused = await failure(root.upgradeSandbox(sandbox.id, {}));
			expect(refused.status).toBe(501);
			expect(refused.message).toContain(why);
			expect(isolates.frozen.has(sandbox.id)).toBe(false);
			expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ tier: "isolate", hostId: isolates.hostId });
		}
		expect(isolates.methods()).not.toContain("sandbox.files.read");
		expect(vms.methods()).not.toContain("sandbox.create");
	});

	it("reads an isolate's files a few at once, and keeps their order", async () => {
		const { root, hosts } = await setup([
			{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
			{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
		]);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const workspace = isolates.sandboxes.get(sandbox.id)?.files;
		workspace?.set("src", { kind: "dir" });
		for (let index = 0; index < 64; index++) {
			workspace?.set(`src/f${index}.txt`, { kind: "file", data: enc(`file ${index}\n`), mode: 0o644 });
		}
		isolates.readDelayMs = 5;
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded.type).toBe("microvm");
		expect(isolates.mostReadsAtOnce).toBeGreaterThan(1);
		expect(isolates.mostReadsAtOnce).toBeLessThanOrEqual(16);
		const files = vms.sandboxes.get(sandbox.id)?.files;
		for (let index = 0; index < 64; index++) {
			expect(text(files?.get(`/home/user/workspace/src/f${index}.txt`)?.data)).toBe(`file ${index}\n`);
		}
	});

	it("passes an isolate command's needsMicrovm and terminated through from its host", async () => {
		const { root, hosts } = await setup([{ name: "both", facts: factsOf(BOTH, [HOST_FEATURES.egressPolicy]) }]);
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		host.isolateExec = (command) =>
			command.startsWith("pip")
				? {
						exitCode: 127,
						stdout: "",
						stderr: "pip: not available in an isolate. Use a microVM.\n",
						needsMicrovm: { command: "pip install", reason: "Packages need a microVM." },
					}
				: { exitCode: 152, stdout: "", stderr: "", terminated: "cpu" };
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const pip = await root.runCommand(sandbox.id, { command: "pip install requests" });
		expect(pip.needsMicrovm).toEqual({ command: "pip install", reason: "Packages need a microVM." });
		const spin = await root.runCommand(sandbox.id, { command: "while true; do :; done" });
		expect(spin).toMatchObject({ exitCode: 152, terminated: "cpu" });
		expect(spin.needsMicrovm).toBeUndefined();
	});

	it("keeps a needsMicrovm its host only inferred a hint, which autoUpgrade never acts on", async () => {
		const { root, hosts } = await setup([
			{
				name: "both",
				facts: factsOf(BOTH, [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateUpgrade, HOST_FEATURES.execControl]),
			},
		]);
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		host.isolateExec = (command) =>
			command.startsWith("echo")
				? {
						// Text the command printed itself, which the host read as a refusal.
						exitCode: 127,
						stdout: "",
						stderr: "bash: git: command not found\n",
						needsMicrovm: { command: "git", reason: "An isolate has no git; a microVM does.", inferred: true },
					}
				: {
						exitCode: 127,
						stdout: "",
						stderr: "tar: not available in an isolate. Use a microVM.\n",
						needsMicrovm: { command: "tar", reason: "Archives need a microVM." },
					};
		const sandbox = await root.createSandbox({ type: "isolate", autoUpgrade: true, wait: true });
		const printed = await root.runCommand(sandbox.id, { command: "echo 'bash: git: command not found' >&2; exit 127" });
		expect(printed.needsMicrovm).toEqual({
			command: "git",
			reason: "An isolate has no git; a microVM does.",
			inferred: true,
		});
		expect(printed.rerunAs).toBeUndefined();
		expect(host.methods()).not.toContain("sandbox.upgrade");
		expect((await root.getSandbox(sandbox.id)).type).toBe("isolate");
		// Its detached run, its end fetched by its ID, keeps it too.
		const detached = await root.runCommand(sandbox.id, { command: "echo again >&2; exit 127", detached: true });
		let ended = await root.getCommand(sandbox.id, detached.id);
		for (let tries = 0; ended.state === "running" && tries < 200; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			ended = await root.getCommand(sandbox.id, detached.id);
		}
		expect(ended.needsMicrovm).toMatchObject({ command: "git", inferred: true });
		expect(ended.rerunAs).toBeUndefined();
		expect(host.methods()).toContain("sandbox.exec.get");
		expect((await root.getSandbox(sandbox.id)).type).toBe("isolate");

		// What the runtime says is acted on: the isolate is upgraded and the command run again in the microVM.
		const tar = await root.runCommand(sandbox.id, { command: "tar -tf x.tar" });
		expect(tar).toMatchObject({ exitCode: 0 });
		expect(tar.rerunOf).toBeDefined();
		expect(host.methods()).toContain("sandbox.upgrade");
		expect((await root.getSandbox(sandbox.id)).type).toBe("microvm");
	});
});

describe("an upgrade whose answer is lost, or whose isolate is busy", () => {
	const both = () => factsOf(BOTH, [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateUpgrade]);

	it("asks its host what it did when the answer never comes, and takes the microVM the host made", async () => {
		const { root, service, hosts } = await setup([{ name: "both", facts: both() }], { upgradeTimeoutMs: 100 });
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		host.upgradeAnswer = "drop";
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		host.sandboxes.get(sandbox.id)?.files.set("a.txt", { kind: "file", data: enc("a") });
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ type: "microvm", state: "running" });
		expect(host.methods().filter((method) => method === "sandbox.upgrade")).toHaveLength(1);
		expect(host.methods()).toContain("sandbox.upgrade.settle");
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ tier: "microvm" });
		expect((await service.sandboxes.placement(sandbox.id))?.upgrade).toBeUndefined();
	});

	it("waits for an upgrade that outlasts the call's time, rather than taking it for failed", async () => {
		const { root, hosts } = await setup([{ name: "both", facts: both() }], { upgradeTimeoutMs: 100 });
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		host.upgradeAnswer = 400;
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded.type).toBe("microvm");
		expect(host.sandboxes.get(sandbox.id)?.tier).toBe("microvm");
	});

	it("keeps it starting, neither isolate nor microVM, while its host can't be asked", async () => {
		const { root, api, service, hosts } = await setup([{ name: "both", facts: both() }], { upgradeTimeoutMs: 100 });
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		host.upgradeAnswer = "drop";
		host.refuseMethod = (method) =>
			method === "sandbox.upgrade.settle" ? { code: "unavailable", message: "busy" } : undefined;
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const refused = await failure(root.upgradeSandbox(sandbox.id, {}));
		expect(refused.status).toBe(503);
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("starting");
		expect((await service.sandboxes.placement(sandbox.id))?.upgrade?.phase).toBe("host");
		// Once it answers, settling it takes the microVM.
		host.refuseMethod = undefined;
		const settled = await service.sandboxes.settleUpgrade(
			sandbox.id,
			(await api.store.sandboxes.get(sandbox.id))?.upgrading?.operationId ?? "",
		);
		expect(settled.state).toBe("done");
	});

	it("holds a moving isolate still: a command under way ends and its write is moved, none after gets in", async () => {
		const { root, hosts } = await setup([
			{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
			{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
		]);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		isolates.sandboxes.get(sandbox.id)?.files.set("early.txt", { kind: "file", data: enc("early\n") });
		// A command already sent, writing as the upgrade begins.
		const writing = root.runCommand(sandbox.id, { command: "slow-write late.txt" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded.type).toBe("microvm");
		expect((await writing).exitCode).toBe(0);
		const files = vms.sandboxes.get(sandbox.id)?.files;
		expect(text(files?.get("/home/user/workspace/late.txt")?.data)).toBe("late\n");
		expect(text(files?.get("/home/user/workspace/early.txt")?.data)).toBe("early\n");
		const order = isolates.methods();
		expect(order.indexOf("sandbox.upgrade.freeze")).toBeLessThan(order.indexOf("sandbox.files.list"));
	});

	it("deletes a microVM whose create's answer was lost, and thaws the isolate", async () => {
		const { root, service, hosts } = await setup(
			[
				{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
				{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
			],
			{ callTimeoutMs: 200 },
		);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		vms.dropCreateAnswer = true;
		const refused = await failure(root.upgradeSandbox(sandbox.id, {}));
		expect(refused.status).toBe(503);
		expect(vms.methods()).toContain("sandbox.delete");
		expect(vms.sandboxes.has(sandbox.id)).toBe(false);
		expect(isolates.frozen.has(sandbox.id)).toBe(false);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ tier: "isolate", hostId: isolates.hostId });
		expect(placement?.upgrade).toBeUndefined();
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ type: "isolate", state: "running" });
	});

	it("owes the isolate's host its removal when that fails, and does it once the host is back", async () => {
		const { root, service, hosts } = await setup([
			{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
			{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
		]);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		isolates.refuseMethod = (method) =>
			method === "sandbox.delete" ? { code: "unavailable", message: "disk busy" } : undefined;
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ type: "microvm", hostId: vms.hostId });
		expect(isolates.sandboxes.has(sandbox.id)).toBe(true);
		expect((await service.sandboxes.placement(sandbox.id))?.cleanup).toMatchObject({ hostId: isolates.hostId });
		// It comes back, still holding the isolate: welcomed, then on its heartbeat the isolate goes.
		isolates.refuseMethod = undefined;
		await isolates.connect();
		isolates.heartbeat();
		for (let tries = 0; tries < 100 && isolates.sandboxes.has(sandbox.id); tries++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(isolates.sandboxes.has(sandbox.id)).toBe(false);
		const deletes = isolates.calls.filter((call) => call.method === "sandbox.delete");
		expect(deletes.at(-1)?.params).toEqual({ sandboxId: sandbox.id, keepSnapshots: true });
		for (
			let tries = 0;
			tries < 100 && (await service.sandboxes.placement(sandbox.id))?.cleanup !== undefined;
			tries++
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect((await service.sandboxes.placement(sandbox.id))?.cleanup).toBeUndefined();
		expect((await service.sandboxes.placement(sandbox.id))?.hostId).toBe(vms.hostId);
	});

	it("counts the bytes it moves as it reads them, not as they were listed", async () => {
		const { root, hosts } = await setup(
			[
				{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
				{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
			],
			{ upgradeMoveLimits: { files: 100, bytes: 1000 } },
		);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		isolates.sandboxes.get(sandbox.id)?.files.set("log.txt", { kind: "file", data: enc("small") });
		// Listed at 5 bytes; read at 5005.
		isolates.growing = { name: "log.txt", extra: 5000 };
		const refused = await failure(root.upgradeSandbox(sandbox.id, {}));
		expect(refused.message).toContain("too many bytes");
		expect(vms.sandboxes.has(sandbox.id)).toBe(false);
		expect((await root.getSandbox(sandbox.id)).type).toBe("isolate");
	});
});

/** A memory store whose placement writes fail where `refuse` says: before the write lands, or after (`landed`). */
function failingStore(refuse: (placement: PlacementRecord) => "before" | "landed" | undefined): HostStore {
	const store = createMemoryHostStore();
	const put = store.putPlacement.bind(store);
	const update = store.updatePlacement.bind(store);
	return {
		...store,
		putPlacement: async (placement) => {
			const how = refuse(placement);
			if (how === "before") throw new Error("the database went away");
			await put(placement);
			if (how === "landed") throw new Error("the database went away after the write");
		},
		updatePlacement: async (sandboxId, change) => {
			let how: "before" | "landed" | undefined;
			const written = await update(sandboxId, (latest) => {
				const next = change(latest);
				how = next === undefined ? undefined : refuse(next);
				return how === "before" ? undefined : next;
			});
			if (how !== undefined) throw new Error("the database went away");
			return written;
		},
	};
}

describe("an upgrade that fails after its irreversible step", () => {
	const crossHost = () => [
		{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
		{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
	];

	it("keeps the microVM, and owes the isolate's removal, when recording that removal fails", async () => {
		// The write clearing `cleanup`, once the isolate is deleted from its host, fails.
		let failing = true;
		const store = failingStore((placement) =>
			failing && placement.tier === "microvm" && placement.cleanup === undefined ? "before" : undefined,
		);
		const { root, service, hosts } = await setup(crossHost(), { store });
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		isolates.sandboxes.get(sandbox.id)?.files.set("a.txt", { kind: "file", data: enc("a\n") });
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ type: "microvm", hostId: vms.hostId });
		// The isolate is gone from its host; the microVM, the only copy, is kept, and the placement is its.
		expect(isolates.sandboxes.has(sandbox.id)).toBe(false);
		expect(text(vms.sandboxes.get(sandbox.id)?.files.get("/home/user/workspace/a.txt")?.data)).toBe("a\n");
		expect(vms.methods()).not.toContain("sandbox.delete");
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ tier: "microvm", hostId: vms.hostId, cleanup: { hostId: isolates.hostId } });
		// Its removal, still owed, is done once the host is back.
		failing = false;
		await isolates.connect();
		isolates.heartbeat();
		for (
			let tries = 0;
			tries < 100 && (await service.sandboxes.placement(sandbox.id))?.cleanup !== undefined;
			tries++
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ tier: "microvm", hostId: vms.hostId });
		expect((await service.sandboxes.placement(sandbox.id))?.cleanup).toBeUndefined();
	});

	it("takes the microVM when the write placing it lands but answers a failure", async () => {
		let failing = true;
		const store = failingStore((placement) => {
			if (!failing || placement.tier !== "microvm" || placement.cleanup === undefined) return undefined;
			failing = false;
			return "landed";
		});
		const { root, service, hosts } = await setup(crossHost(), { store });
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ type: "microvm", hostId: vms.hostId });
		expect(vms.sandboxes.get(sandbox.id)?.tier).toBe("microvm");
		expect(isolates.sandboxes.has(sandbox.id)).toBe(false);
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ tier: "microvm", hostId: vms.hostId });
	});

	it("rolls back as before when the write placing the microVM never lands", async () => {
		let failing = true;
		const store = failingStore((placement) => {
			if (!failing || placement.tier !== "microvm" || placement.cleanup === undefined) return undefined;
			failing = false;
			return "before";
		});
		const { root, service, hosts } = await setup(crossHost(), { store });
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		await failure(root.upgradeSandbox(sandbox.id, {}));
		expect(vms.sandboxes.has(sandbox.id)).toBe(false);
		expect(isolates.sandboxes.get(sandbox.id)?.tier).toBe("isolate");
		expect(isolates.frozen.has(sandbox.id)).toBe(false);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ tier: "isolate", hostId: isolates.hostId });
		expect(placement?.upgrade).toBeUndefined();
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ type: "isolate", state: "running" });
	});

	it("leaves the outcome unknown when the rollback's claim fails in the store, and settling it rolls back", async () => {
		let failPublish = true;
		let failClaim = true;
		const store = failingStore((placement) => {
			if (failPublish && placement.tier === "microvm" && placement.cleanup !== undefined) {
				failPublish = false;
				return "before";
			}
			if (failClaim && placement.upgrade?.settling !== undefined) {
				failClaim = false;
				return "before";
			}
			return undefined;
		});
		const { root, service, hosts } = await setup(crossHost(), { store });
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const refused = await failure(root.upgradeSandbox(sandbox.id, {}));
		// Not a plain failure, which compute would take as the isolate put back: unknown, so compute settles it, and that
		// settle carries out the rollback before the isolate runs again.
		expect(refused.status).toBe(503);
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ type: "isolate", state: "running" });
		expect(isolates.frozen.has(sandbox.id)).toBe(false);
		expect(vms.sandboxes.has(sandbox.id)).toBe(false);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ tier: "isolate", hostId: isolates.hostId });
		expect(placement?.upgrade).toBeUndefined();
	});

	it("settles a same-host upgrade by its ID when recording the microVM fails, never taking it for refused", async () => {
		let failing = true;
		const store = failingStore((placement) => {
			if (!failing || placement.tier !== "microvm") return undefined;
			failing = false;
			return "before";
		});
		const { root, service, hosts } = await setup(
			[{ name: "both", facts: factsOf(BOTH, [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateUpgrade]) }],
			{ store },
		);
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ type: "microvm", hostId: host.hostId });
		expect(host.methods()).toContain("sandbox.upgrade.settle");
		expect(host.sandboxes.get(sandbox.id)?.tier).toBe("microvm");
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ tier: "microvm", hostId: host.hostId });
		expect(placement?.upgrade).toBeUndefined();
	});
});

describe("an upgrade settled by more than one gateway", () => {
	it("lets one roll it back at a time, and a late one neither restores the isolate nor touches a newer upgrade", async () => {
		let at = 1_000_000;
		const { root, service, hosts } = await setup(
			[
				{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
				{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
			],
			{ callTimeoutMs: 200, clock: { now: () => at } },
		);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		isolates.sandboxes.get(sandbox.id)?.files.set("a.txt", { kind: "file", data: enc("a\n") });
		// The microVM's create answer is lost, and the isolate's host can't be reached to thaw it: left to be settled.
		vms.dropCreateAnswer = true;
		isolates.refuseMethod = (method) =>
			method === "sandbox.upgrade.thaw" ? { code: "unavailable", message: "away" } : undefined;
		expect((await failure(root.upgradeSandbox(sandbox.id, {}))).status).toBe(503);
		const operationId = (await service.sandboxes.placement(sandbox.id))?.upgrade?.operationId ?? "";
		expect(operationId).toMatch(/^upg_/);
		vms.dropCreateAnswer = false;
		isolates.refuseMethod = undefined;

		// One gateway settles it: the microVM deleted, the isolate thawed, and that answer held.
		let releaseThaw: () => void = () => undefined;
		isolates.holdThaw = new Promise<void>((resolve) => {
			releaseThaw = resolve;
		});
		const thaws = () => isolates.methods().filter((method) => method === "sandbox.upgrade.thaw").length;
		const thawed = thaws();
		const late = service.sandboxes.settleUpgrade(sandbox.id, operationId);
		for (let tries = 0; tries < 200 && thaws() === thawed; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(thaws()).toBe(thawed + 1);
		// Another, meanwhile, is refused while the first has it, and sends nothing.
		const deletes = () => vms.methods().filter((method) => method === "sandbox.delete").length;
		const deleted = deletes();
		await expect(service.sandboxes.settleUpgrade(sandbox.id, operationId)).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(deletes()).toBe(deleted);

		// The first taken for gone once its claim lapses: another rolls it back, and a new upgrade makes the microVM.
		at += 10 * 60_000;
		expect(await service.sandboxes.settleUpgrade(sandbox.id, operationId)).toMatchObject({ state: "failed" });
		expect((await service.sandboxes.placement(sandbox.id))?.upgrade).toBeUndefined();
		const next = await service.sandboxes.upgrade(sandbox.id, { operationId: "upg_next" });
		expect(next.hostId).toBe(vms.hostId);

		// The first's answer comes at last: it restores nothing, and the newer microVM stays.
		releaseThaw();
		await late.catch(() => undefined);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ tier: "microvm", hostId: vms.hostId });
		expect(placement?.upgrade).toBeUndefined();
		expect(vms.sandboxes.get(sandbox.id)?.tier).toBe("microvm");
		expect(text(vms.sandboxes.get(sandbox.id)?.files.get("/home/user/workspace/a.txt")?.data)).toBe("a\n");
	});
});

describe("a host's report racing an upgrade's handover", () => {
	/** A store whose reads `hold` suspends once, right after they read, until `release`. */
	function heldStore() {
		const store = createMemoryHostStore();
		let armed: "getHost" | "placementsOn" | undefined;
		let release: () => void = () => undefined;
		let reached: () => void = () => undefined;
		const suspended = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const wrapped: HostStore = {
			...store,
			getHost: async (id) => {
				const read = await store.getHost(id);
				if (armed === "getHost") {
					armed = undefined;
					reached();
					await gate;
				}
				return read;
			},
			placementsOn: async (hostId) => {
				const read = await store.placementsOn(hostId);
				if (armed === "placementsOn") {
					armed = undefined;
					reached();
					await gate;
				}
				return read;
			},
		};
		return {
			store: wrapped,
			hold: (at: "getHost" | "placementsOn") => (armed = at),
			suspended,
			release: () => release(),
		};
	}

	it("keeps a same-host upgrade's microVM when an isolate event read before it lands after", async () => {
		const held = heldStore();
		const { root, service, hosts } = await setup(
			[{ name: "both", facts: factsOf(BOTH, [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateUpgrade]) }],
			{ store: held.store },
		);
		const [host] = hosts;
		if (host === undefined) throw new Error("no host");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		// The isolate's event: read with the isolate's placement, then held at its host's read.
		held.hold("getHost");
		host.receive(
			JSON.stringify({
				type: "event",
				event: {
					kind: "sandbox",
					sandbox: { id: sandbox.id, tier: "isolate", size: "isolate", state: "stopped", createdAt: 1 },
				},
			}),
		);
		await held.suspended;
		const upgraded = await root.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ type: "microvm", hostId: host.hostId });
		held.release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ tier: "microvm", hostId: host.hostId, state: "running", size: "default" });
		expect(placement?.upgrade).toBeUndefined();
	});

	it("keeps a cross-host handover's placement when the isolate's host's hello, read before it, lands after", async () => {
		const held = heldStore();
		const { root, service, hosts } = await setup(
			[
				{ name: "isolates", facts: factsOf(["isolate"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze]) },
				{ name: "vms", facts: factsOf(["microvm"], [HOST_FEATURES.egressPolicy, HOST_FEATURES.filesExtract]) },
			],
			{ store: held.store },
		);
		const [isolates, vms] = hosts;
		if (isolates === undefined || vms === undefined) throw new Error("no hosts");
		const sandbox = await root.createSandbox({ type: "isolate", wait: true });
		// The isolate's host says hello again (to this gateway, as it reconnects), holding it as stopped: its placements
		// read, then held.
		const isolate = isolates.sandboxes.get(sandbox.id);
		if (isolate === undefined) throw new Error("no isolate");
		isolate.state = "stopped";
		held.hold("placementsOn");
		const hello = isolates.connect();
		await held.suspended;
		// Meanwhile the upgrade's handover is committed (by another gateway, whose connection to the host it has): the
		// microVM on the other host, owing the isolate's removal.
		const before = await service.sandboxes.placement(sandbox.id);
		if (before === undefined) throw new Error("no placement");
		const handedOver: PlacementRecord = {
			...before,
			hostId: vms.hostId,
			tier: "microvm",
			size: "default",
			vcpus: 2,
			memoryMiB: 2048,
			diskGiB: 20,
			state: "running",
			cleanup: { hostId: isolates.hostId, operationId: "op_1" },
		};
		await held.store.putPlacement(handedOver);
		held.release();
		await hello;
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toEqual(handedOver);
	});
});
