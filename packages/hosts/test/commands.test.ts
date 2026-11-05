// Detached commands and kills on kantel-host hosts, through the compute API, the host backend and the hub, with a fake
// host and a fake clock: a detached command runs past every old limit (the guest's 120 s, the call's hour) and its
// result still lands, across the host's connection dropping; a kill reaches the host and stops the command; and a host
// from before `exec-control` runs as it did, with the command saying so.
import { createKantelClient } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend, OLD_HOST_DETACHED } from "../src/backend.ts";
import { HOST_FEATURES, type HostFacts, type HostMessage } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";

const baseFacts: HostFacts = {
	version: "0.2.0",
	protocol: 1,
	os: "linux",
	arch: "amd64",
	kernel: "6.8",
	hostname: "box",
	cpus: 8,
	memoryMiB: 16_384,
	diskGiB: 200,
	kvm: true,
	nested: false,
	tiers: ["microvm"],
	sizes: [{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 }],
	egress: "open",
};

const OLD_GUEST_LIMIT_MS = 120_000;

interface Running {
	readonly params: { [key: string]: unknown };
	ended?: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
	/** What it has written so far, as a host that reports a running command's output answers a get with it. */
	output?: { stdout: string; stderr: string };
	/** Answers waiting for its end: a foreground call's, or held gets. */
	readonly waiting: ((ended: NonNullable<Running["ended"]>) => void)[];
}

/** kantel-host as the backend sees it for commands: with `controls`, one with `exec-control`. */
class CommandHost {
	readonly calls: { method: string; params: { [key: string]: unknown } }[] = [];
	readonly commands = new Map<string, Running>();
	/**
	 * The connection drops as a detached start arrives, before it is answered: `started` once it has started the command,
	 * `lost` before.
	 */
	dropOnStart?: "started" | "lost";
	/** Set: every status get is refused with it, as once its space turns E2E on. */
	refuseGets?: { code: string; message: string };
	/** A detached start answered unconfirmed (its guest didn't answer): `started` once the guest has it, `lost` not. */
	unconfirmStart?: "started" | "lost";
	private receive?: (text: string) => void;
	private closed?: (code: number, reason: string) => void;

	constructor(
		readonly service: ReturnType<typeof createHostsService>,
		readonly hostId: string,
		readonly controls: boolean,
	) {}

	connect(sandboxes: { id: string; tier: string; size: string; state: string; createdAt: number }[] = []) {
		const held = this.service.hub.accept(this.hostId, {
			sendText: (text) => this.onText(JSON.parse(text) as HostMessage),
			sendBinary: () => undefined,
			close: () => undefined,
		});
		this.receive = (text) => held.receive(text);
		this.closed = (code, reason) => held.closed(code, reason);
		const facts = this.controls ? { ...baseFacts, features: [HOST_FEATURES.execControl] } : baseFacts;
		const capacity = { freeMemoryMiB: 14_000, freeDiskGiB: 150, running: 1, stopped: 0, load1: 0 };
		this.receive(JSON.stringify({ type: "hello", hello: { hostId: this.hostId, facts, sandboxes, capacity } }));
		// Every 15 s, as kantel-host's heartbeat: a host that stops is taken as gone.
		clearInterval(this.beat);
		this.beat = setInterval(
			() => this.receive?.(JSON.stringify({ type: "heartbeat", heartbeat: { capacity } })),
			15_000,
		);
	}

	private beat?: ReturnType<typeof setInterval>;

	/**
	 * The host dials again while its old connection is still held, as a host that took its link for dead does: the hub
	 * shuts the old one ("A newer connection for the host took over"), and calls waiting on it go unanswered. A host with
	 * `exec-control` keeps its commands running; one from before ends them with the old connection.
	 */
	takeOver(sandboxes: { id: string; tier: string; size: string; state: string; createdAt: number }[]) {
		this.connect(sandboxes);
		// Its answers go to the old connection, which is gone.
		if (!this.controls) {
			for (const [id, command] of this.commands) {
				if (command.ended === undefined) this.end(id, { exitCode: 137, stdout: "", stderr: "" });
			}
		}
	}

	/** Forgets a command, as a host or sandbox that restarted has. */
	forget(commandId: string) {
		this.commands.delete(commandId);
	}

	/** A running command's output so far. */
	output(commandId: string, stdout: string, stderr = "") {
		const command = this.commands.get(commandId);
		if (command !== undefined) command.output = { stdout, stderr };
	}

	/** The connection drops, as a network blip or a gateway restart would. */
	drop() {
		clearInterval(this.beat);
		this.closed?.(1006, "gone");
		this.receive = undefined;
	}

	stop() {
		clearInterval(this.beat);
	}

	/** Ends a running command, as its process exiting would. */
	end(commandId: string, ended: NonNullable<Running["ended"]>) {
		const command = this.commands.get(commandId);
		if (command === undefined || command.ended !== undefined) return;
		command.ended = ended;
		for (const answer of command.waiting.splice(0)) answer(ended);
	}

	private onText(message: HostMessage) {
		if (message.type !== "call") return;
		const p = (message.params ?? {}) as { [key: string]: unknown };
		this.calls.push({ method: message.method ?? "", params: p });
		const receive = this.receive;
		const answer = (result: unknown) => receive?.(JSON.stringify({ type: "result", id: message.id, result }));
		const fail = (code: string, text: string) =>
			receive?.(JSON.stringify({ type: "result", id: message.id, error: { code, message: text } }));
		switch (message.method) {
			case "sandbox.create":
				return answer({ id: p.sandboxId, tier: "microvm", size: "default", state: "running", createdAt: 1 });
			case "sandbox.delete":
				return answer({ ok: true });
			case "sandbox.exec": {
				// An older host knows no IDs: its "detached" command is a foreground one, stopped at its guest's limit.
				const id = this.controls && typeof p.commandId === "string" ? p.commandId : `anon-${this.calls.length}`;
				const command: Running = { params: p, waiting: [] };
				const drop = this.controls && p.detached === true ? this.dropOnStart : undefined;
				this.dropOnStart = undefined;
				const unconfirmed = this.controls && p.detached === true ? this.unconfirmStart : undefined;
				this.unconfirmStart = undefined;
				if (drop !== "lost" && unconfirmed !== "lost") this.commands.set(id, command);
				if (drop !== undefined) return this.drop();
				if (unconfirmed !== undefined) return answer({ commandId: id, state: "running", unconfirmed: true });
				if (this.controls && p.detached === true) {
					return answer({ commandId: id, state: "running", pid: 4242 });
				}
				command.waiting.push((ended) => answer(ended));
				if (!this.controls && p.timeoutMs === undefined) {
					setTimeout(() => this.end(id, { exitCode: 124, stdout: "", stderr: "", timedOut: true }), OLD_GUEST_LIMIT_MS);
				}
				return;
			}
			case "sandbox.exec.get": {
				if (!this.controls) return fail("unsupported", "unknown method sandbox.exec.get");
				if (this.refuseGets !== undefined) return fail(this.refuseGets.code, this.refuseGets.message);
				const command = this.commands.get(String(p.commandId));
				if (command === undefined) return fail("not_found", "no such command");
				const status = (ended: Running["ended"]) =>
					ended === undefined
						? { commandId: p.commandId, state: "running", ...(command.output ?? {}) }
						: { commandId: p.commandId, state: "exited", result: ended };
				if (command.ended !== undefined || typeof p.waitMs !== "number") return answer(status(command.ended));
				// Held for its wait, as a host holds it.
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					answer(status(undefined));
				}, p.waitMs);
				command.waiting.push((ended) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					answer(status(ended));
				});
				return;
			}
			case "sandbox.exec.kill": {
				if (!this.controls) return fail("unsupported", "unknown method sandbox.exec.kill");
				const command = this.commands.get(String(p.commandId));
				const killed = command !== undefined && command.ended === undefined;
				this.end(String(p.commandId), { exitCode: 137, stdout: "", stderr: "" });
				return answer({ killed });
			}
			default:
				return fail("unsupported", `unknown method ${message.method}`);
		}
	}
}

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const close of closers.splice(0).reverse()) await close();
});

type SandboxCall = ReturnType<typeof createHostsService>["sandboxes"]["call"];

async function setup(controls: boolean, wrapCall?: (call: SandboxCall) => SandboxCall) {
	const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test" });
	const call = service.sandboxes.call.bind(service.sandboxes);
	const hosts =
		wrapCall === undefined
			? service
			: Object.assign(Object.create(service), {
					sandboxes: Object.assign(Object.create(service.sandboxes), { call: wrapCall(call) }),
				});
	const backend = createHostBackend({
		hosts,
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
	const token = await root.createHostJoinToken({ name: "box-1" });
	const { hostId } = await service.register({ token: token.token, facts: baseFacts });
	const host = new CommandHost(service, hostId, controls);
	host.connect();
	closers.push(() => host.stop());
	await vi.waitFor(() => expect(service.hub.connected(hostId)).toBe(true));
	const sandbox = await root.createSandbox({ type: "microvm", wait: true, autoStopMinutes: null });
	/** Another gateway on the same store and hosts, as the next one after a restart is. */
	const nextGateway = () => {
		const next = createComputeApi({
			backend,
			store: api.store,
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer root" ? ROOT : undefined,
			fetch: async () => new Response(null, { status: 204 }),
			publicUrl: "https://kantel.test",
		});
		closers.push(() => next.close());
		return createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token: "root",
			fetch: (input, init) =>
				next.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	};
	return { service, api, root, host, sandbox, nextGateway };
}

const callsOf = (host: CommandHost, method: string) => host.calls.filter((call) => call.method === method);

describe("commands on kantel-host hosts", () => {
	it("runs a detached command past the guest's limit and the call's hour, and records its end", async () => {
		const { root, host, sandbox } = await setup(true);
		vi.useFakeTimers();
		const started = await root.runCommand(sandbox.id, { command: "npm run build", detached: true });
		expect(started.state).toBe("running");
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		const [exec] = callsOf(host, "sandbox.exec");
		// Sent with its ID and detached, with no limit of its own: the host's guest runs it with none.
		expect(exec?.params).toMatchObject({ command: "npm run build", commandId: started.id, detached: true });
		expect(exec?.params.timeoutMs).toBeUndefined();

		// Three hours: past the guest's 120 s and the hour a call was given.
		await vi.advanceTimersByTimeAsync(3 * 3_600_000);
		expect((await root.getCommand(sandbox.id, started.id)).state).toBe("running");
		expect(host.commands.get(started.id)?.ended).toBeUndefined();
		// Asked again and again, each get held by the host, never as one call.
		expect(callsOf(host, "sandbox.exec.get").length).toBeGreaterThan(100);

		host.end(started.id, { exitCode: 0, stdout: "built\n", stderr: "" });
		await vi.advanceTimersByTimeAsync(10);
		const ended = await root.getCommand(sandbox.id, started.id);
		expect(ended).toMatchObject({ state: "exited", exitCode: 0, stdout: "built\n" });
		expect(ended.durationMs).toBeGreaterThanOrEqual(3 * 3_600_000);
	});

	it("replays a detached command retried under the same Idempotency-Key, and starts it once", async () => {
		const { root, host, sandbox } = await setup(true);
		const run = { command: "./serve", detached: true };
		const first = await root.runCommand(sandbox.id, run, { idempotencyKey: "serve-1" });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		const again = await root.runCommand(sandbox.id, run, { idempotencyKey: "serve-1" });
		expect(again.id).toBe(first.id);
		expect(callsOf(host, "sandbox.exec")).toHaveLength(1);
		expect(callsOf(host, "sandbox.exec")[0]?.params.commandId).toBe(first.id);
	});

	it("ends a detached command whose host refuses for good to say how it went, rather than leave it running", async () => {
		const { root, host, sandbox } = await setup(true);
		host.refuseGets = { code: "unsupported", message: "its space is end-to-end encrypted" };
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.waitFor(async () => expect((await root.getCommand(sandbox.id, started.id)).state).toBe("exited"));
		const ended = await root.getCommand(sandbox.id, started.id);
		expect(ended).toMatchObject({ exitCode: 1 });
		expect(ended.stderr).toContain("end-to-end encrypted");
	});

	it("follows a detached start its sandbox didn't confirm, and ends it with that said when it never started", async () => {
		const { root, host, sandbox } = await setup(true);
		host.unconfirmStart = "started";
		const kept = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec.get").length).toBeGreaterThan(0));
		expect((await root.getCommand(sandbox.id, kept.id)).state).toBe("running");
		host.end(kept.id, { exitCode: 0, stdout: "served\n", stderr: "" });
		await vi.waitFor(async () =>
			expect(await root.getCommand(sandbox.id, kept.id)).toMatchObject({ state: "exited", stdout: "served\n" }),
		);
		host.unconfirmStart = "lost";
		const lost = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.waitFor(async () => expect((await root.getCommand(sandbox.id, lost.id)).state).toBe("exited"));
		const ended = await root.getCommand(sandbox.id, lost.id);
		expect(ended.exitCode).toBe(1);
		expect(ended.stderr).toContain("didn't confirm this command's start");
	});

	it("honours a detached command's own limit", async () => {
		const { root, host, sandbox } = await setup(true);
		const started = await root.runCommand(sandbox.id, { command: "sleep 9999", detached: true, timeoutMs: 600_000 });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		expect(callsOf(host, "sandbox.exec")[0]?.params).toMatchObject({ commandId: started.id, timeoutMs: 600_000 });
	});

	it("keeps following a detached command when the host's connection drops and comes back", async () => {
		const { service, root, host, sandbox } = await setup(true);
		vi.useFakeTimers();
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.advanceTimersByTimeAsync(5_000);
		host.drop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await root.getCommand(sandbox.id, started.id)).state).toBe("running");
		host.connect([{ id: sandbox.id, tier: "microvm", size: "default", state: "running", createdAt: 1 }]);
		await vi.advanceTimersByTimeAsync(10);
		expect(service.hub.connected(host.hostId)).toBe(true);
		host.end(started.id, { exitCode: 3, stdout: "", stderr: "crashed\n" });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(await root.getCommand(sandbox.id, started.id)).toMatchObject({
			state: "exited",
			exitCode: 3,
			stderr: "crashed\n",
		});
	});

	const RUNNING = (id: string) => [{ id, tier: "microvm", size: "default", state: "running", createdAt: 1 }];

	it("leaves a detached command running when a newer connection for its host takes over, its output so far shown (#703)", async () => {
		const { service, root, host, sandbox } = await setup(true);
		vi.useFakeTimers();
		const started = await root.runCommand(sandbox.id, {
			command: "apt-get install -y build-essential",
			detached: true,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		host.output(started.id, "Reading package lists...\n");
		// What it has written so far, while it runs: what attach shows first.
		expect(await root.getCommand(sandbox.id, started.id)).toMatchObject({
			state: "running",
			stdout: "Reading package lists...\n",
		});

		host.takeOver(RUNNING(sandbox.id));
		await vi.advanceTimersByTimeAsync(10);
		expect(service.hub.connected(host.hostId)).toBe(true);
		host.output(started.id, "Reading package lists...\nSetting up gcc\n", "debconf: delaying\n");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await root.getCommand(sandbox.id, started.id)).toMatchObject({
			state: "running",
			stdout: "Reading package lists...\nSetting up gcc\n",
			stderr: "debconf: delaying\n",
		});

		const out = "Reading package lists...\nSetting up gcc\nDone\n";
		host.end(started.id, { exitCode: 0, stdout: out, stderr: "debconf: delaying\n" });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(await root.getCommand(sandbox.id, started.id)).toMatchObject({ state: "exited", exitCode: 0, stdout: out });
		// Started once, never again.
		expect(callsOf(host, "sandbox.exec")).toHaveLength(1);
	});

	it("keeps a foreground command when a newer connection for its host takes over, and answers with its end", async () => {
		const { root, host, sandbox } = await setup(true);
		vi.useFakeTimers();
		const running = root.runCommand(sandbox.id, { command: "pnpm install", timeoutMs: 600_000 });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		const commandId = String(callsOf(host, "sandbox.exec")[0]?.params.commandId);
		host.takeOver(RUNNING(sandbox.id));
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await root.getCommand(sandbox.id, commandId)).state).toBe("running");
		host.end(commandId, { exitCode: 0, stdout: "Done in 42s\n", stderr: "" });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(await running).toMatchObject({ id: commandId, state: "exited", exitCode: 0, stdout: "Done in 42s\n" });
		expect(callsOf(host, "sandbox.exec")).toHaveLength(1);
	});

	it("gives up on a foreground command whose host doesn't come back by its limit, saying so", async () => {
		const { root, host, sandbox } = await setup(true);
		vi.useFakeTimers();
		const running = root.runCommand(sandbox.id, { command: "make", timeoutMs: 30_000 });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		host.drop();
		await vi.advanceTimersByTimeAsync(30_000 + 120_000);
		const ended = await running;
		expect(ended).toMatchObject({ state: "exited", exitCode: 1 });
		expect(ended.stderr).toMatch(/disconnected.*didn't come back/s);
	});

	it("says why a host from before exec-control loses a command when a newer connection takes over", async () => {
		const { root, host, sandbox } = await setup(false);
		const started = await root.runCommand(sandbox.id, {
			command: "apt-get install -y build-essential",
			detached: true,
		});
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		host.takeOver(RUNNING(sandbox.id));
		await vi.waitFor(async () => expect((await root.getCommand(sandbox.id, started.id)).state).toBe("exited"));
		const ended = await root.getCommand(sandbox.id, started.id);
		expect(ended.exitCode).toBe(1);
		expect(ended.stderr).toContain("A newer connection for the host took over");
		expect(ended.stderr).toMatch(/kantel-host from before .* upgrade its kantel-host/);
	});

	it("sends a kill to the host, which stops a detached command", async () => {
		const { root, host, sandbox } = await setup(true);
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		const killed = await root.killCommand(sandbox.id, started.id);
		expect(killed).toMatchObject({ state: "killed", exitCode: 137, stderr: "" });
		expect(callsOf(host, "sandbox.exec.kill").map((call) => call.params)).toEqual([
			{ commandId: started.id, sandboxId: sandbox.id },
		]);
		expect(host.commands.get(started.id)?.ended?.exitCode).toBe(137);
		// Its end at the host doesn't make it an exit.
		await vi.waitFor(async () => expect((await root.getCommand(sandbox.id, started.id)).state).toBe("killed"));
	});

	it("sends a kill to the host for a foreground command too", async () => {
		const { root, host, sandbox } = await setup(true);
		const running = root.runCommand(sandbox.id, { command: "sleep 20", timeoutMs: 30_000 });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		const commandId = String(callsOf(host, "sandbox.exec")[0]?.params.commandId);
		expect(commandId).toMatch(/^cmd_/);
		expect(callsOf(host, "sandbox.exec")[0]?.params.detached).toBeUndefined();
		await root.killCommand(sandbox.id, commandId);
		expect(callsOf(host, "sandbox.exec.kill")).toHaveLength(1);
		expect(await running).toMatchObject({ id: commandId, state: "killed", exitCode: 137 });
	});

	it("runs as it did on a host from before exec-control, and says so", async () => {
		const { root, host, sandbox } = await setup(false);
		vi.useFakeTimers();
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		const [exec] = callsOf(host, "sandbox.exec");
		// Nothing it doesn't know: no ID, not detached.
		expect(exec?.params.commandId).toBeUndefined();
		expect(exec?.params.detached).toBeUndefined();
		await vi.advanceTimersByTimeAsync(OLD_GUEST_LIMIT_MS + 1);
		const ended = await root.getCommand(sandbox.id, started.id);
		expect(ended.state).toBe("timed_out");
		expect(ended.stderr).toContain(OLD_HOST_DETACHED);

		const again = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		const killed = await root.killCommand(sandbox.id, again.id);
		expect(killed.state).toBe("killed");
		expect(killed.stderr).toMatch(/may still be running.*upgrade its kantel-host/);
		expect(callsOf(host, "sandbox.exec.kill")).toHaveLength(0);
	});

	it("ends an older host's detached command when its gateway closes, rather than leaving it running", async () => {
		const { api, root, host, sandbox } = await setup(false);
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		await api.close();
		// No gateway could fetch it from this host later: its end is recorded now.
		expect((await api.store.commands.get(started.id))?.state).toBe("exited");
	});

	it("leaves a host-kept detached command running when its gateway closes, for the next to fetch", async () => {
		const { api, root, host, sandbox } = await setup(true);
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec.get").length).toBeGreaterThan(0));
		await api.close();
		expect((await api.store.commands.get(started.id))?.state).toBe("running");
	});

	it("leaves a host-kept foreground command running when its gateway closes, and the next gateway records its end", async () => {
		const { api, root, host, sandbox, nextGateway } = await setup(true);
		const running = root.runCommand(sandbox.id, { command: "pnpm install", timeoutMs: 600_000 });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		const commandId = String(callsOf(host, "sandbox.exec")[0]?.params.commandId);
		await api.close();
		// Not recorded as failed: it runs on at its host.
		expect((await running).state).toBe("running");
		expect((await api.store.commands.get(commandId))?.state).toBe("running");

		const next = nextGateway();
		expect((await next.getCommand(sandbox.id, commandId)).state).toBe("running");
		host.end(commandId, { exitCode: 0, stdout: "Done in 42s\n", stderr: "" });
		expect(await next.getCommand(sandbox.id, commandId)).toMatchObject({
			state: "exited",
			exitCode: 0,
			stdout: "Done in 42s\n",
		});
		// And one still running is killed at its host by the next gateway.
		const again = root.runCommand(sandbox.id, { command: "sleep 600", timeoutMs: 600_000 });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(2));
		const againId = String(callsOf(host, "sandbox.exec")[1]?.params.commandId);
		void again.catch(() => undefined);
		await expect(next.killCommand(sandbox.id, againId)).resolves.toMatchObject({ state: "killed" });
		expect(callsOf(host, "sandbox.exec.kill").map((call) => call.params.commandId)).toEqual([againId]);
	});

	it("keeps a command's output recorded while it ran when its result is lost", async () => {
		const { root, host, sandbox } = await setup(true);
		vi.useFakeTimers();
		const started = await root.runCommand(sandbox.id, { command: "./build.sh", detached: true });
		await vi.advanceTimersByTimeAsync(5_000);
		host.output(started.id, "step 1\nstep 2\n", "warning: slow");
		expect((await root.getCommand(sandbox.id, started.id)).stdout).toBe("step 1\nstep 2\n");
		host.forget(started.id);
		await vi.advanceTimersByTimeAsync(61_000);
		const ended = await root.getCommand(sandbox.id, started.id);
		expect(ended).toMatchObject({ state: "exited", exitCode: 1, stdout: "step 1\nstep 2\n" });
		// What was recorded, then why its end is unknown (the gateway following it was told so by the host).
		expect(ended.stderr).toMatch(/^warning: slow\n.*no longer knows/s);
	});

	it("keeps recorded output, a full stream's too, when a later gateway finds the command's result lost", async () => {
		const { api, root, host, sandbox, nextGateway } = await setup(true);
		const started = await root.runCommand(sandbox.id, { command: "./build.sh", detached: true });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec")).toHaveLength(1));
		const full = "e".repeat(1024 * 1024);
		host.output(started.id, "step 1\n", full);
		await vi.waitFor(async () => expect((await root.getCommand(sandbox.id, started.id)).stderr).toBe(full));
		await api.close();
		host.forget(started.id);
		// Lost once its host hasn't known it for a while: recorded when it started, a minute and more ago.
		await api.store.commands.update(started.id, (latest) => ({ ...latest, startedAt: latest.startedAt - 61_000 }));
		const ended = await nextGateway().getCommand(sandbox.id, started.id);
		expect(ended).toMatchObject({ state: "exited", exitCode: 1, stdout: "step 1\n" });
		expect(ended.stderr.startsWith(full)).toBe(true);
		expect(ended.stderr.slice(full.length)).toMatch(/^\nKantel lost this command's result/);
		// (A real end, which extends what was recorded, is kept as it is: see the #703 takeover above.)
	});

	it("follows a detached command whose start went unanswered, which the host had started", async () => {
		const { root, host, sandbox } = await setup(true);
		vi.useFakeTimers();
		host.dropOnStart = "started";
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await root.getCommand(sandbox.id, started.id)).state).toBe("running");
		host.connect([{ id: sandbox.id, tier: "microvm", size: "default", state: "running", createdAt: 1 }]);
		await vi.advanceTimersByTimeAsync(40_000);
		expect((await root.getCommand(sandbox.id, started.id)).state).toBe("running");
		host.end(started.id, { exitCode: 0, stdout: "served\n", stderr: "" });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(await root.getCommand(sandbox.id, started.id)).toMatchObject({ state: "exited", stdout: "served\n" });
		// One start, never sent again.
		expect(callsOf(host, "sandbox.exec")).toHaveLength(1);
	});

	it("follows a detached start whose answer from a peer replica was cut off with a plain error", async () => {
		let cut = true;
		const { root, host, sandbox } = await setup(true, (call) => async (sandboxId, method, params, options) => {
			const answer = await call(sandboxId, method, params, options);
			if (cut && method === "sandbox.exec" && (params as { detached?: boolean }).detached === true) {
				cut = false;
				throw new TypeError("terminated");
			}
			return answer as never;
		});
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.waitFor(() => expect(callsOf(host, "sandbox.exec.get").length).toBeGreaterThan(0));
		host.end(started.id, { exitCode: 0, stdout: "served\n", stderr: "" });
		await vi.waitFor(async () =>
			expect(await root.getCommand(sandbox.id, started.id)).toMatchObject({ state: "exited", stdout: "served\n" }),
		);
		expect(callsOf(host, "sandbox.exec")).toHaveLength(1);
	});

	it("fails a detached command whose start never reached the host, with the start's error", async () => {
		const { root, host, sandbox } = await setup(true);
		vi.useFakeTimers();
		host.dropOnStart = "lost";
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await vi.advanceTimersByTimeAsync(5_000);
		host.connect([{ id: sandbox.id, tier: "microvm", size: "default", state: "running", createdAt: 1 }]);
		await vi.advanceTimersByTimeAsync(40_000);
		const ended = await root.getCommand(sandbox.id, started.id);
		expect(ended).toMatchObject({ state: "exited", exitCode: 1 });
		expect(ended.stderr).toMatch(/disconnected/);
		expect(callsOf(host, "sandbox.exec")).toHaveLength(1);
	});

	it("drops a call's abort listener however it settles, so a long-followed command holds none", async () => {
		const { service, host, sandbox } = await setup(true);
		const controller = new AbortController();
		const added = vi.spyOn(controller.signal, "addEventListener");
		const removed = vi.spyOn(controller.signal, "removeEventListener");
		for (let i = 0; i < 5; i++) {
			await service.hub
				.call(
					host.hostId,
					"sandbox.exec.get",
					{ sandboxId: sandbox.id, commandId: "cmd_x" },
					{
						signal: controller.signal,
					},
				)
				.catch(() => undefined);
		}
		expect(added).toHaveBeenCalledTimes(5);
		expect(removed).toHaveBeenCalledTimes(5);
	});
});
