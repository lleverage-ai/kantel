import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import {
	type BackendCapabilities,
	DetachedWaitEnded,
	type ExecRequest,
	type ExecResult,
	type SandboxBackend,
	type SandboxSpec,
} from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { restoreAsked } from "../src/machine.ts";
import { createRoutedBackend, NOT_HELD } from "../src/routed-backend.ts";
import {
	checkShape,
	HOST_REVOKED_REASON,
	hourlyRate,
	type InviteMail,
	inviteForSomeoneElse,
	inviteLink,
	isLoopbackUrl,
	microvmShapes,
	NEVER_MADE,
	PLACEHOLDER_RATES,
	publicOrigin,
	SHARED_HOSTS_REFUSED,
	SHARED_KEY_REFUSED,
	shapeFor,
} from "../src/service.ts";
import { createMemoryStore, type StoredCommand } from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";

/** People the injected authenticator knows, by bearer. */
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

function setup(
	backend: SandboxBackend = createStubBackend(),
	extra: Pick<
		Parameters<typeof createComputeApi>[0],
		"sharedHosts" | "invites" | "limits" | "startHoldMs" | "startPollMs" | "store"
	> = {},
) {
	const api = createComputeApi({
		...extra,
		backend,
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const client = (token: string | undefined) =>
		createKantelClient({
			baseUrl: BASE_URL,
			...(token === undefined ? {} : { token }),
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, client, tom: client("tom-token"), ann: client("ann-token"), root: client("root-token") };
}

/** The error a call failed with; fails the test when it succeeded. */
async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

describe("sandboxes", () => {
	it("creates an isolate, runs a command and reads, writes and lists files", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox.type).toBe("isolate");
		expect(sandbox.state).toBe("running");
		expect(sandbox.visibility).toBe("private");
		expect(sandbox.stopsAt).toBeTypeOf("number");

		const command = await tom.runCommand(sandbox.id, { command: "echo hello > f.txt && cat f.txt" });
		expect(command.state).toBe("exited");
		expect(command.exitCode).toBe(0);
		expect(command.stdout).toBe("hello\n");
		expect((await tom.listCommands(sandbox.id)).items.map((item) => item.id)).toEqual([command.id]);

		const read = await tom.readFile(sandbox.id, { path: "f.txt" });
		expect(read).toMatchObject({ path: "/home/user/f.txt", encoding: "utf8", content: "hello\n", size: 6 });

		const written = await tom.writeFile(sandbox.id, { path: "notes/todo.md", content: "# To do" });
		expect(written).toMatchObject({ path: "/home/user/notes/todo.md", kind: "file", size: 7 });
		const listing = await tom.listFiles(sandbox.id, { path: "notes" });
		expect(listing.items.map((entry) => entry.name)).toEqual(["todo.md"]);
		const encoded = await tom.readFile(sandbox.id, { path: "/home/user/notes/todo.md", encoding: "base64" });
		expect(atob(encoded.content)).toBe("# To do");

		await tom.deleteFile(sandbox.id, { path: "notes/todo.md" });
		expect((await failure(tom.readFile(sandbox.id, { path: "notes/todo.md" }))).code).toBe("not_found");
	});

	it("reads a file over 1 MiB in parts with offset and length", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const half = 768 * 1024;
		await tom.writeFile(sandbox.id, { path: "a.txt", content: "a".repeat(half) });
		await tom.writeFile(sandbox.id, { path: "b.txt", content: "b".repeat(half) });
		await tom.runCommand(sandbox.id, { command: "cat a.txt b.txt > big.txt" });

		const whole = await failure(tom.readFile(sandbox.id, { path: "big.txt" }));
		expect(whole.code).toBe("invalid");
		expect(whole.message).toContain("read it in parts with offset and length");

		const first = await tom.readFile(sandbox.id, { path: "big.txt", offset: 0 });
		expect(first).toMatchObject({ size: 2 * half, offset: 0 });
		expect(first.content).toBe("a".repeat(half) + "b".repeat(1024 * 1024 - half));
		const rest = await tom.readFile(sandbox.id, { path: "big.txt", offset: 1024 * 1024, length: 1024 * 1024 });
		expect(rest).toMatchObject({ size: 2 * half, offset: 1024 * 1024 });
		expect(rest.content).toBe("b".repeat(2 * half - 1024 * 1024));
		const some = await tom.readFile(sandbox.id, { path: "big.txt", offset: half - 2, length: 4, encoding: "base64" });
		expect(atob(some.content)).toBe("aabb");
		const past = await tom.readFile(sandbox.id, { path: "big.txt", offset: 5 * half, length: 10 });
		expect(past).toMatchObject({ content: "", size: 2 * half, offset: 2 * half });
		// A small file read with a range says where its part starts; without one, it answers no offset.
		expect(await tom.readFile(sandbox.id, { path: "a.txt", length: 3 })).toMatchObject({ content: "aaa", offset: 0 });
		expect(await tom.readFile(sandbox.id, { path: "a.txt" })).not.toHaveProperty("offset");
		expect((await failure(tom.readFile(sandbox.id, { path: "a.txt", length: 1024 * 1024 + 1 }))).code).toBe("invalid");
	});

	it("runs a detached command in the background and records how it ended", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const detached = await tom.runCommand(sandbox.id, { command: "echo later", detached: true });
		expect(detached.state).toBe("running");
		await api.service.idle();
		const ended = await tom.getCommand(sandbox.id, detached.id);
		expect(ended.state).toBe("exited");
		expect(ended.stdout).toBe("later\n");
	});

	it("says when its latest snapshot was taken, from the snapshot, for a snapshot taken while it runs and an older record", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const taken = await tom.takeSnapshot(sandbox.id, {});
		const running = await tom.getSandbox(sandbox.id);
		expect(running).toMatchObject({ latestSnapshotId: taken.id, latestSnapshotAt: taken.createdAt });
		// A record kept before it had the time: the list and the sandbox read it from the snapshot's own record.
		const stored = await api.store.sandboxes.get(sandbox.id);
		if (stored === undefined) expect.fail("no sandbox");
		const { latestSnapshotAt: _, ...older } = stored;
		await api.store.sandboxes.put(older);
		expect((await tom.getSandbox(sandbox.id)).latestSnapshotAt).toBe(taken.createdAt);
		const listed = (await tom.listSandboxes()).items.find((item) => item.id === sandbox.id);
		expect(listed?.latestSnapshotAt).toBe(taken.createdAt);
	});

	it("sends a detached command with its ID and no limit but the caller's, and a kill to its backend", async () => {
		const stub = createStubBackend();
		const requests: ExecRequest[] = [];
		const kills: string[] = [];
		const backend: SandboxBackend = {
			...stub,
			exec: (id, request) => {
				requests.push(request);
				return stub.exec(id, request);
			},
			killCommand: async (id, commandId) => {
				kills.push(commandId);
				await stub.killCommand?.(id, commandId);
			},
		};
		const { api, tom } = setup(backend);
		const sandbox = await tom.createSandbox({ wait: true });
		const free = await tom.runCommand(sandbox.id, { command: "echo free", detached: true });
		const capped = await tom.runCommand(sandbox.id, { command: "echo capped", detached: true, timeoutMs: 5_000 });
		await api.service.idle();
		expect(requests.map(({ commandId, detached, timeoutMs }) => ({ commandId, detached, timeoutMs }))).toEqual([
			{ commandId: free.id, detached: true, timeoutMs: undefined },
			{ commandId: capped.id, detached: true, timeoutMs: 5_000 },
		]);
		// A foreground command has its ID too (a kill names it), and the default limit.
		const foreground = await tom.runCommand(sandbox.id, { command: "echo now" });
		expect(requests.at(-1)).toMatchObject({ commandId: foreground.id, timeoutMs: 30_000 });
		expect(requests.at(-1)?.detached).toBeUndefined();

		// A kill goes to the backend by the command's ID, once it is recorded killed.
		const held = await tom.runCommand(sandbox.id, { command: "sleep 600", detached: true });
		const killed = await tom.killCommand(sandbox.id, held.id);
		expect(killed).toMatchObject({ state: "killed", exitCode: 137, stderr: "" });
		expect(kills).toEqual([held.id]);
		await api.service.idle();
		expect((await tom.getCommand(sandbox.id, held.id)).state).toBe("killed");
		// One that has ended isn't killed again.
		expect((await tom.killCommand(sandbox.id, free.id)).state).toBe("exited");
		expect(kills).toEqual([held.id]);
	});

	it("marks a command killed when its backend can't stop it, and says so", async () => {
		const stub = createStubBackend();
		const backend: SandboxBackend = {
			...stub,
			exec: (_id, request) =>
				new Promise((resolve) =>
					request.signal?.addEventListener("abort", () =>
						resolve({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
					),
				),
			killCommand: async () => {
				throw new KantelError("not_supported", "this sandbox's host can't stop a command; upgrade its kantel-host");
			},
		};
		const { tom } = setup(backend);
		const sandbox = await tom.createSandbox({ wait: true });
		const held = await tom.runCommand(sandbox.id, { command: "./serve", detached: true });
		const killed = await tom.killCommand(sandbox.id, held.id);
		expect(killed.state).toBe("killed");
		expect(killed.stderr).toBe(
			"Kantel marked this command killed but couldn't stop it, so it may still be running: this sandbox's host can't stop a command; upgrade its kantel-host\n",
		);
		expect((await tom.getCommand(sandbox.id, held.id)).stderr).toBe(killed.stderr);
	});

	it("fetches a detached command's end from its backend once the gateway that started it has gone", async () => {
		const stub = createStubBackend();
		const results = new Map<string, ExecResult | undefined>();
		const backend: SandboxBackend = {
			...stub,
			// The command runs on in the sandbox; only the gateway's wait for it ends.
			exec: (_id, request) =>
				new Promise((_resolve, reject) =>
					request.signal?.addEventListener("abort", () => reject(new DetachedWaitEnded())),
				),
			commandResult: async (_id, commandId) => {
				if (!results.has(commandId)) throw new KantelError("not_found", "no such command");
				return results.get(commandId);
			},
		};
		const store = createMemoryStore();
		const first = createComputeApi({ backend, store, authenticatePerson: async () => PEOPLE["tom-token"] });
		const client = (api: ComputeApi) =>
			createKantelClient({
				baseUrl: BASE_URL,
				token: "tom-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
		const sandbox = await client(first).createSandbox({ wait: true });
		const started = await client(first).runCommand(sandbox.id, { command: "./build", detached: true });
		results.set(started.id, undefined);
		// The gateway closes (a restart, or another replica serves the next call): the command isn't failed for it.
		await first.close();
		const second = createComputeApi({ backend, store, authenticatePerson: async () => PEOPLE["tom-token"] });
		opened.push(second);
		expect((await client(second).getCommand(sandbox.id, started.id)).state).toBe("running");
		results.set(started.id, { exitCode: 0, stdout: "built\n", stderr: "", timedOut: false });
		expect(await client(second).getCommand(sandbox.id, started.id)).toMatchObject({
			state: "exited",
			exitCode: 0,
			stdout: "built\n",
		});
	});

	it("brings an unfollowed detached command's end in before listing it, killing it or stopping its sandbox", async () => {
		const stub = createStubBackend();
		const results = new Map<string, ExecResult | undefined>();
		const kills: string[] = [];
		const backend: SandboxBackend = {
			...stub,
			exec: (_id, request) =>
				new Promise((_resolve, reject) =>
					request.signal?.addEventListener("abort", () => reject(new DetachedWaitEnded())),
				),
			killCommand: async (_id, commandId) => void kills.push(commandId),
			commandResult: async (_id, commandId) => results.get(commandId),
		};
		const store = createMemoryStore();
		const first = createComputeApi({ backend, store, authenticatePerson: async () => PEOPLE["tom-token"] });
		const client = (api: ComputeApi) =>
			createKantelClient({
				baseUrl: BASE_URL,
				token: "tom-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
		const sandbox = await client(first).createSandbox({ wait: true });
		const listed = await client(first).runCommand(sandbox.id, { command: "./a", detached: true });
		const killed = await client(first).runCommand(sandbox.id, { command: "./b", detached: true });
		const stopped = await client(first).runCommand(sandbox.id, { command: "./c", detached: true });
		const running = await client(first).runCommand(sandbox.id, { command: "./d", detached: true });
		await first.close();
		const second = createComputeApi({ backend, store, authenticatePerson: async () => PEOPLE["tom-token"] });
		opened.push(second);
		const tom = client(second);
		const built = { exitCode: 0, stdout: "built\n", stderr: "", timedOut: false };
		// Each ends just before the call that has to bring its end in, so each call is what does.
		results.set(listed.id, built);
		const items = (await tom.listCommands(sandbox.id)).items;
		expect(items.find((item) => item.id === listed.id)).toMatchObject({ state: "exited", stdout: "built\n" });
		expect(items.find((item) => item.id === killed.id)?.state).toBe("running");
		expect(items.find((item) => item.id === running.id)?.state).toBe("running");
		// Ended already: a kill answers its end, and sends nothing.
		results.set(killed.id, built);
		expect(await tom.killCommand(sandbox.id, killed.id)).toMatchObject({ state: "exited", stdout: "built\n" });
		expect(kills).toEqual([]);
		// A stop keeps the end of one that ended, and marks the one still running killed.
		expect((await store.commands.get(stopped.id))?.state).toBe("running");
		results.set(stopped.id, built);
		await tom.stopSandbox(sandbox.id, { wait: true });
		expect(await tom.getCommand(sandbox.id, stopped.id)).toMatchObject({ state: "exited", stdout: "built\n" });
		expect((await tom.getCommand(sandbox.id, running.id)).state).toBe("killed");
	});

	it("sends a kill again when the first never reached the backend, until it does", async () => {
		const stub = createStubBackend();
		const kills: string[] = [];
		let reachable = false;
		const backend: SandboxBackend = {
			...stub,
			exec: (_id, request) =>
				new Promise((resolve) =>
					request.signal?.addEventListener("abort", () =>
						resolve({ exitCode: 137, stdout: "", stderr: "", timedOut: false }),
					),
				),
			killCommand: async (_id, commandId) => {
				kills.push(commandId);
				if (!reachable) throw new KantelError("unavailable", "the host disconnected");
			},
		};
		const { tom } = setup(backend);
		const sandbox = await tom.createSandbox({ wait: true });
		const held = await tom.runCommand(sandbox.id, { command: "./serve", detached: true });
		const first = await tom.killCommand(sandbox.id, held.id);
		expect(first.state).toBe("killed");
		expect(first.stderr).toContain("may still be running: the host disconnected; kill it again to retry");
		// The host is back: the next kill sends it again, and says nothing more.
		reachable = true;
		const again = await tom.killCommand(sandbox.id, held.id);
		expect(again.state).toBe("killed");
		expect(kills).toEqual([held.id, held.id]);
		// Delivered: a third kill sends nothing.
		await tom.killCommand(sandbox.id, held.id);
		expect(kills).toEqual([held.id, held.id]);
	});

	it("doesn't reopen a delivered kill when an older attempt fails after it", async () => {
		const stub = createStubBackend();
		const deliveries: { resolve: () => void; reject: (error: Error) => void }[] = [];
		const backend: SandboxBackend = {
			...stub,
			exec: (_id, request) =>
				new Promise((_resolve, reject) =>
					request.signal?.addEventListener("abort", () => reject(new DetachedWaitEnded())),
				),
			killCommand: () =>
				new Promise<void>((resolve, reject) => {
					deliveries.push({ resolve, reject });
				}),
		};
		const { api, tom } = setup(backend);
		const sandbox = await tom.createSandbox({ wait: true });
		const held = await tom.runCommand(sandbox.id, { command: "./serve", detached: true });
		// Two kills at once: the first marks it killed, pending; the second retries the pending kill.
		const first = tom.killCommand(sandbox.id, held.id);
		await vi.waitFor(() => expect(deliveries).toHaveLength(1));
		const second = tom.killCommand(sandbox.id, held.id);
		await vi.waitFor(() => expect(deliveries).toHaveLength(2));
		// The second is delivered, then the first fails.
		deliveries[1]?.resolve();
		expect((await second).stderr).toBe("");
		deliveries[0]?.reject(new KantelError("unavailable", "the host disconnected"));
		const late = await first;
		expect(late.stderr).toBe("");
		const stored = await api.store.commands.get(held.id);
		expect(stored?.killPending).toBeUndefined();
		expect(stored?.stderr).toBe("");
		// Delivered: another kill sends nothing.
		await tom.killCommand(sandbox.id, held.id);
		expect(deliveries).toHaveLength(2);
	});

	it("keeps an end recorded while a kill was on its way, and sends that kill nowhere", async () => {
		const stub = createStubBackend();
		const kills: string[] = [];
		const backend: SandboxBackend = { ...stub, killCommand: async (_id, commandId) => void kills.push(commandId) };
		const store = createMemoryStore();
		// The kill reads the command while it still runs; its end lands before the kill writes.
		let stale: StoredCommand | undefined;
		const commands = {
			...store.commands,
			get: async (id: string) => {
				const read = stale?.id === id ? stale : await store.commands.get(id);
				stale = undefined;
				return read;
			},
		};
		const api = createComputeApi({
			backend,
			store: { ...store, commands },
			authenticatePerson: async () => PEOPLE["tom-token"],
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const sandbox = await tom.createSandbox({ wait: true });
		const ran = await tom.runCommand(sandbox.id, { command: "echo done" });
		expect(ran.state).toBe("exited");
		stale = { ...((await store.commands.get(ran.id)) as StoredCommand), state: "running" };
		const answer = await tom.killCommand(sandbox.id, ran.id);
		expect(answer).toMatchObject({ state: "exited", exitCode: 0, stdout: "done\n" });
		expect((await store.commands.get(ran.id))?.state).toBe("exited");
		expect(kills).toEqual([]);
	});

	it("stops with a history snapshot and resumes with its files", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.runCommand(sandbox.id, { command: "echo kept > keep.txt" });

		const stopped = await tom.stopSandbox(sandbox.id, { wait: true });
		expect(stopped.state).toBe("stopped");
		expect(stopped.stopsAt).toBeUndefined();
		const history = await tom.listSnapshots({ sandboxId: sandbox.id });
		expect(history.items).toHaveLength(1);
		expect(history.items[0]).toMatchObject({ kind: "automatic", trigger: "stop", sandboxId: sandbox.id });
		expect(stopped.latestSnapshotId).toBe(history.items[0]?.id);
		expect(stopped.latestSnapshotAt).toBe(history.items[0]?.createdAt);
		expect((await failure(tom.runCommand(sandbox.id, { command: "true" }))).code).toBe("conflict");
		expect((await tom.listSandboxes()).items.map((item) => item.id)).not.toContain(sandbox.id);
		expect((await tom.listSandboxes({ all: true })).items.map((item) => item.id)).toContain(sandbox.id);

		const resumed = await tom.resumeSandbox(sandbox.id, { wait: true });
		expect(resumed.state).toBe("running");
		expect((await tom.readFile(sandbox.id, { path: "keep.txt" })).content).toBe("kept\n");

		const events = await tom.listEvents({ sandboxId: sandbox.id });
		expect(events.items.map((event) => event.type)).toEqual([
			"sandbox.running",
			"sandbox.stopped",
			"sandbox.running",
			"sandbox.created",
		]);
	});

	it("forks, saves a named snapshot, creates from it and deletes for good", async () => {
		const { tom } = setup();
		const source = await tom.createSandbox({ name: "source", wait: true });
		await tom.writeFile(source.id, { path: "app.txt", content: "v1" });

		const forks = await tom.forkSandbox(source.id, { count: 2, wait: true });
		expect(forks.items).toHaveLength(2);
		for (const fork of forks.items) {
			expect(fork.state).toBe("running");
			expect(fork.source?.sandboxId).toBe(source.id);
			expect((await tom.readFile(fork.id, { path: "app.txt" })).content).toBe("v1");
		}

		const saved = await tom.saveSnapshot({ name: "base", sandboxId: source.id });
		expect(saved).toMatchObject({ kind: "saved", name: "base", trigger: "save" });
		expect((await failure(tom.saveSnapshot({ name: "base", sandboxId: source.id }))).code).toBe("conflict");

		const fromSaved = await tom.createSandbox({ from: "base", wait: true });
		expect(fromSaved.source?.snapshotId).toBe(saved.id);
		expect((await tom.readFile(fromSaved.id, { path: "app.txt" })).content).toBe("v1");

		await tom.stopSandbox(source.id, { wait: true });
		const deleted = await tom.deleteSandbox(source.id);
		expect(deleted.state).toBe("deleted");
		expect((await tom.getSandbox(source.id)).state).toBe("deleted");
		expect((await failure(tom.runCommand(source.id, { command: "true" }))).code).toBe("not_found");
		expect((await tom.listSandboxes({ all: true })).items.map((item) => item.id)).not.toContain(source.id);
		expect((await tom.listSnapshots({ sandboxId: source.id })).items).toEqual([]);
		const kept = await tom.listSnapshots({ kind: "saved" });
		expect(kept.items.map((item) => item.id)).toEqual([saved.id]);
		expect(kept.items[0]?.sandboxId).toBeUndefined();
	});

	it("answers the first sandbox again for a repeated idempotency key", async () => {
		const { tom } = setup();
		const first = await tom.createSandbox({ name: "once" }, { idempotencyKey: "create-1" });
		const again = await tom.createSandbox({ name: "once" }, { idempotencyKey: "create-1" });
		expect(again.id).toBe(first.id);
		const named = (await tom.listSandboxes({ all: true })).items.filter((item) => item.name === "once");
		expect(named).toHaveLength(1);
	});

	it("refuses microVM-only features on an isolate and gives them to a microVM", async () => {
		const { tom } = setup();
		const isolate = await tom.createSandbox({ wait: true });
		const refused = await failure(tom.openSsh(isolate.id, {}));
		expect(refused.status).toBe(501);
		expect(refused.code).toBe("not_supported");
		expect((await failure(tom.stopSandbox(isolate.id, { keepMemory: true }))).code).toBe("not_supported");

		const vm = await tom.createSandbox({ type: "microvm", wait: true });
		expect(vm.size).toBe("default");
		const ssh = await tom.openSsh(vm.id, {});
		expect(ssh.command).toContain("ssh");
		const port = await tom.exposePort(vm.id, { port: 3000 });
		expect(port.url).toBe(`http://3000-${vm.subdomain}.sandbox.localhost`);
		const paused = await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		expect(paused.state).toBe("paused");
	});

	it("says what shapes may be asked for: an isolate's memory and, on a host that makes them, any microVM", async () => {
		const { tom } = setup();
		const shapes = await tom.getSandboxShapes();
		expect(shapes.isolate).toEqual({ memoryMb: { min: 128, max: 512, step: 64, default: 256 }, enforced: false });
		expect(shapes.microvm).toMatchObject({
			vcpus: { min: 1, max: 32, step: 1, default: 2 },
			memoryMb: { min: 512, step: 512, default: 4096 },
			memoryMbPerVcpu: { min: 512, max: 8192 },
			custom: true,
		});
		expect(shapes.microvm?.presets.map((preset) => preset.name)).toEqual(["small", "default", "large", "xlarge"]);
		// Hosts keep no warm pools, so no preset says it is warm.
		expect(shapes.microvm?.presets.some((preset) => "warm" in preset)).toBe(false);
		// Self-hosted, sandboxes have no price.
		expect(shapes.rates).toBeUndefined();
	});

	it("makes a microVM of any shape, matching a preset by its numbers, and an isolate of the memory it asks", async () => {
		const { tom } = setup();
		const custom = await tom.createSandbox({ type: "microvm", resources: { vcpus: 3, memoryMb: 6144 }, wait: true });
		expect(custom.size).toBeUndefined();
		expect(custom.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });
		expect(custom.cost.ratePerHour).toBe(hourlyRate(PLACEHOLDER_RATES, "microvm", { vcpus: 3, memoryMb: 6144 }));
		// A fork is its source's shape.
		const [fork] = (await tom.forkSandbox(custom.id, { wait: true })).items;
		expect(fork?.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });

		const preset = await tom.createSandbox({ type: "microvm", resources: { vcpus: 4, memoryMb: 8192 }, wait: true });
		expect(preset.size).toBe("large");

		const isolate = await tom.createSandbox({ resources: { memoryMb: 384 }, wait: true });
		expect(isolate.resources).toMatchObject({ vcpus: 0, memoryMb: 384 });
		expect(isolate.cost.ratePerHour).toBe(hourlyRate(PLACEHOLDER_RATES, "isolate", { vcpus: 0, memoryMb: 384 }));
		const plain = await tom.createSandbox({ wait: true });
		expect(plain.resources).toMatchObject({ memoryMb: 256 });
	});

	it("makes a sandbox from a snapshot holding memory as the snapshot's machine, refusing another before storing it", async () => {
		const backend = createStubBackend();
		const create = vi.spyOn(backend, "create");
		const { tom } = setup(backend);
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const [paused] = (await tom.listSnapshots({ sandboxId: vm.id })).items;
		expect(paused).toMatchObject({ memory: true, size: "large" });
		const id = paused?.id ?? "";
		const before = (await tom.listSandboxes({ all: true })).items.length;

		for (const body of [
			{ resources: { vcpus: 4, memoryMb: 16_384 } },
			{ resources: { vcpus: 2, memoryMb: 8192 } },
			{ size: "small" as const },
		]) {
			const refused = await failure(tom.createSandbox({ type: "microvm", from: id, ...body }));
			expect(refused.code).toBe("invalid");
			expect(refused.message).toContain("holds its sandbox's memory");
		}
		// Nothing is stored for a refused create.
		expect((await tom.listSandboxes({ all: true })).items).toHaveLength(before);

		// Its own machine, asked by its numbers or not at all, is the snapshot's size.
		const same = await tom.createSandbox({ from: id, resources: { vcpus: 4, memoryMb: 8192 }, wait: true });
		expect(same).toMatchObject({ size: "large", state: "running" });
		const plain = await tom.createSandbox({ from: id, wait: true });
		expect(plain).toMatchObject({ size: "large", state: "running" });
		// Its backend is asked for the snapshot's own vCPUs and memory, which its host makes as the snapshot's size.
		const restore = create.mock.calls.find(([spec]) => spec.sandboxId === plain.id)?.[0];
		expect(restore?.shape).toEqual(
			paused?.resources && { vcpus: paused.resources.vcpus, memoryMb: paused.resources.memoryMb },
		);
	});

	it("keeps a pause's memory when it is saved, so a sandbox made from the save is its machine too", async () => {
		const { tom } = setup();
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const saved = await tom.saveSnapshot({ name: "paused", sandboxId: vm.id });
		expect(saved).toMatchObject({ memory: true, size: "large" });
		const refused = await failure(
			tom.createSandbox({ type: "microvm", from: "paused", resources: { vcpus: 2, memoryMb: 4096 } }),
		);
		expect(refused.code).toBe("invalid");
		expect((await tom.createSandbox({ from: "paused", size: "large", wait: true })).size).toBe("large");
	});

	it("treats a save made before saves kept memory as holding it when its bytes are a pause's", async () => {
		const store = createMemoryStore();
		const { tom } = setup(createStubBackend(), { store });
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const saved = await tom.saveSnapshot({ name: "old-save", sandboxId: vm.id });
		// As an older control plane stored it: the pause's bytes, said to hold no memory.
		const stored = await store.snapshots.get(saved.id);
		if (stored === undefined) throw new Error("no saved snapshot");
		await store.snapshots.put({ ...stored, memory: false });
		// Reads say what a create from it is held to; a snapshot of the disk alone still says no.
		expect((await tom.getSnapshot(saved.id)).memory).toBe(true);
		const listed = (await tom.listSnapshots({ kind: "saved" })).items.find((item) => item.id === saved.id);
		expect(listed?.memory).toBe(true);
		const other = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.stopSandbox(other.id, { wait: true });
		const disk = await tom.saveSnapshot({ name: "disk-only", sandboxId: other.id });
		expect((await tom.getSnapshot(disk.id)).memory).toBe(false);
		const refused = await failure(
			tom.createSandbox({ type: "microvm", from: "old-save", resources: { vcpus: 2, memoryMb: 4096 } }),
		);
		expect(refused.code).toBe("invalid");
	});

	it("keeps an older save holding memory once the pause it shares bytes with is deleted", async () => {
		const store = createMemoryStore();
		const { tom } = setup(createStubBackend(), { store });
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const [pause] = (await tom.listSnapshots({ sandboxId: vm.id })).items;
		const saved = await tom.saveSnapshot({ name: "old-save", sandboxId: vm.id });
		const stored = await store.snapshots.get(saved.id);
		if (stored === undefined || pause === undefined) throw new Error("no snapshots");
		await store.snapshots.put({ ...stored, memory: false });
		// The source resumes, and its pause is deleted: the save is the bytes' last record.
		await tom.resumeSandbox(vm.id, { wait: true });
		await tom.deleteSnapshot(pause.id);
		expect((await store.snapshots.get(saved.id))?.memory).toBe(true);
		expect((await tom.getSnapshot(saved.id)).memory).toBe(true);
		const listed = (await tom.listSnapshots({ kind: "saved" })).items.find((item) => item.id === saved.id);
		expect(listed?.memory).toBe(true);
		const before = (await tom.listSandboxes({ all: true })).items.length;
		const refused = await failure(
			tom.createSandbox({ type: "microvm", from: "old-save", resources: { vcpus: 2, memoryMb: 4096 } }),
		);
		expect(refused.code).toBe("invalid");
		expect((await tom.listSandboxes({ all: true })).items).toHaveLength(before);
	});

	it("keeps an older save holding memory when its sandbox is deleted, and its own size when hosts stop naming it", async () => {
		const store = createMemoryStore();
		const stub = createStubBackend();
		let dropLarge = false;
		const backend: SandboxBackend = {
			...stub,
			capabilities: async () => {
				const read = await stub.capabilities();
				if (!dropLarge) return read;
				const offered = <T extends { readonly name: string }>(sizes: readonly T[]) =>
					sizes.filter((size) => size.name !== "large");
				return {
					...read,
					sizes: offered(read.sizes),
					hosts: read.hosts.map((host) => ({ ...host, ...(host.sizes ? { sizes: offered(host.sizes) } : {}) })),
				};
			},
		};
		const { tom } = setup(backend, { store });
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const saved = await tom.saveSnapshot({ name: "old-save", sandboxId: vm.id });
		const stored = await store.snapshots.get(saved.id);
		if (stored === undefined) throw new Error("no saved snapshot");
		await store.snapshots.put({ ...stored, memory: false });
		// Deleting the sandbox forgets its pause and detaches the save, which keeps the flag it was just given.
		await tom.deleteSandbox(vm.id);
		expect(await store.snapshots.get(saved.id)).toMatchObject({ memory: true });
		expect((await store.snapshots.get(saved.id))?.sandboxId).toBeUndefined();
		expect((await tom.getSnapshot(saved.id)).memory).toBe(true);
		// The hosts stop naming its size: asking for it by name is still its own machine.
		dropLarge = true;
		const made = await tom.createSandbox({ type: "microvm", from: "old-save", size: "large", wait: true });
		expect(made).toMatchObject({ size: "large", state: "running" });
	});

	it("checks an ask against a memory snapshot's own record, never another host's sizes", () => {
		const pause = {
			id: "snap_p",
			memory: true,
			size: "large" as const,
			resources: { vcpus: 4, memoryMb: 8192, diskGb: 50 },
		};
		expect(restoreAsked(pause, {})).toEqual({});
		expect(restoreAsked(pause, { size: "large" })).toEqual({});
		expect(restoreAsked(pause, { shape: { vcpus: 4, memoryMb: 8192 } })).toEqual({});
		expect(restoreAsked(pause, { size: "large", shape: { vcpus: 4, memoryMb: 8192 } })).toEqual({});
		// Another name is another machine, whatever its numbers somewhere.
		expect(() => restoreAsked(pause, { size: "default" })).toThrow(/holds its sandbox's memory/);
		expect(() => restoreAsked(pause, { shape: { vcpus: 4, memoryMb: 16_384 } })).toThrow(/size large, 4 vCPU/);
		// One recording a size alone can't be checked against numbers: only its name or nothing.
		const named = { id: "snap_n", memory: true, size: "large" as const };
		expect(restoreAsked(named, { size: "large" })).toEqual({});
		expect(() => restoreAsked(named, { shape: { vcpus: 4, memoryMb: 8192 } })).toThrow(/size large\)/);
		// The disk alone, or no machine recorded: any ask, as before.
		expect(restoreAsked({ ...pause, memory: false }, { size: "small" })).toEqual({ size: "small" });
		expect(restoreAsked({ id: "snap_o", memory: true }, { size: "small" })).toEqual({ size: "small" });
	});

	it("refuses forks of a pause at another size before storing any", async () => {
		const { tom } = setup();
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const before = (await tom.listSandboxes({ all: true })).items.length;
		expect((await failure(tom.forkSandbox(vm.id, { size: "small", count: 2 }))).code).toBe("invalid");
		expect((await tom.listSandboxes({ all: true })).items).toHaveLength(before);
		const [fork] = (await tom.forkSandbox(vm.id, { size: "large", wait: true })).items;
		expect(fork?.size).toBe("large");
	});

	it("gives a fork its source's machine from the moment it is made, a custom shape too, not only once it runs", async () => {
		const stub = createStubBackend();
		// Forks are held as a host copying a big machine holds them, so they can be read while they start.
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const backend: SandboxBackend = {
			...stub,
			fork: async (source, targets) => {
				await held;
				return stub.fork(source, targets);
			},
		};
		const { tom } = setup(backend);
		const custom = await tom.createSandbox({ type: "microvm", resources: { vcpus: 4, memoryMb: 16_384 }, wait: true });
		const preset = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		// Stopped before any fork is held: a source's stop waits for its live forks.
		const cold = await tom.createSandbox({ type: "microvm", resources: { vcpus: 4, memoryMb: 16_384 }, wait: true });
		await tom.stopSandbox(cold.id, { wait: true });
		const other = await tom.createSandbox({ type: "microvm", resources: { vcpus: 4, memoryMb: 16_384 }, wait: true });
		await tom.stopSandbox(other.id, { wait: true });
		expect(custom.size).toBeUndefined();
		expect(custom.resources).toMatchObject({ vcpus: 4, memoryMb: 16_384 });

		const forks: { readonly id: string }[] = [];
		const starting = async (sourceId: string) => {
			const [fork] = (await tom.forkSandbox(sourceId, {})).items;
			if (fork === undefined) throw new Error("no fork");
			return fork;
		};
		// Forked live, and from a snapshot of the disk alone that asks for no other size: the source's machine, disk and all,
		// in the fork's answer, its read and the list while it starts.
		try {
			const live = await starting(custom.id);
			const named = await starting(preset.id);
			const stopped = await starting(cold.id);
			const listed = (await tom.listSandboxes({})).items;
			for (const [fork, source] of [
				[live, custom],
				[named, preset],
				[stopped, cold],
			] as const) {
				expect(fork).toMatchObject({ state: "starting", resources: source.resources });
				expect(fork.size).toBe(source.size);
				expect(await tom.getSandbox(fork.id)).toMatchObject({ state: "starting", resources: source.resources });
				expect(listed.find((item) => item.id === fork.id)?.resources).toEqual(source.resources);
			}
			// Another size asked for is that size's, which its host says: no resources are guessed for it.
			const [resized] = (await tom.forkSandbox(other.id, { size: "small" })).items;
			expect(resized).toMatchObject({ state: "starting", size: "small" });
			expect(resized?.resources).toBeUndefined();
			forks.push(live, named, stopped);
		} finally {
			release();
		}
		const [live, named, stopped] = forks;
		if (live === undefined || named === undefined || stopped === undefined) throw new Error("no forks");
		for (const fork of [live, named, stopped]) {
			await vi.waitFor(async () => expect((await tom.getSandbox(fork.id)).state).toBe("running"));
		}
		expect((await tom.getSandbox(live.id)).resources).toEqual(custom.resources);
		expect((await tom.getSandbox(named.id)).resources).toEqual(preset.resources);
		expect((await tom.getSandbox(stopped.id)).resources).toEqual(cold.resources);
	});

	it("gives a fork its source's exposed ports, each public or gated as it was, under the fork's own name", async () => {
		const backend = createStubBackend();
		const expose = vi.spyOn(backend, "exposePort");
		const { tom } = setup(backend);
		const source = await tom.createSandbox({ type: "microvm", resources: { vcpus: 4, memoryMb: 16_384 }, wait: true });
		await tom.exposePort(source.id, { port: 8080, public: true });
		await tom.exposePort(source.id, { port: 3000 });
		const before = (await tom.listPorts(source.id)).items;

		const forks = (await tom.forkSandbox(source.id, { count: 2, wait: true })).items;
		for (const fork of forks) {
			const ports = [...(await tom.listPorts(fork.id)).items].sort((a, b) => a.port - b.port);
			expect(ports).toMatchObject([
				{ port: 3000, public: false, url: `http://3000-${fork.subdomain}.sandbox.localhost` },
				{ port: 8080, public: true, url: `http://8080-${fork.subdomain}.sandbox.localhost` },
			]);
			// Exposed on the fork's own machine, by whoever forked it, each as it was on the source.
			for (const { port, public: isPublic } of ports) {
				expect(expose).toHaveBeenCalledWith(
					fork.id,
					port,
					expect.objectContaining({ public: isPublic, subdomain: fork.subdomain, grantee: expect.any(String) }),
				);
			}
		}
		// The source keeps its own.
		expect((await tom.listPorts(source.id)).items).toEqual(before);

		// A stopped sandbox has no exposed ports (they end when it stops), so a fork of one has none either.
		await tom.stopSandbox(source.id, { wait: true });
		const [fromStopped] = (await tom.forkSandbox(source.id, { wait: true })).items;
		expect((await tom.listPorts(fromStopped?.id ?? "")).items).toEqual([]);
	});

	it("resizes a sandbox made from a snapshot of the disk alone", async () => {
		const { tom } = setup();
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { wait: true });
		const [stopped] = (await tom.listSnapshots({ sandboxId: vm.id })).items;
		expect(stopped?.memory).toBe(false);
		const bigger = await tom.createSandbox({
			from: stopped?.id ?? "",
			resources: { vcpus: 4, memoryMb: 16_384 },
			wait: true,
		});
		expect(bigger.resources).toMatchObject({ vcpus: 4, memoryMb: 16_384 });
	});

	it("refuses a shape it can't make", async () => {
		const { tom } = setup();
		const refusals = [
			{ resources: { memoryMb: 600 } },
			{ resources: { memoryMb: 1024 } },
			{ resources: { vcpus: 2, memoryMb: 256 } },
			{ type: "microvm", resources: { memoryMb: 2048 } },
			{ type: "microvm", resources: { vcpus: 1, memoryMb: 16_384 } },
			{ type: "microvm", resources: { vcpus: 2, memoryMb: 3000 } },
			{ type: "microvm", resources: { vcpus: 2, memoryMb: 2048 }, size: "small" },
		] as const;
		for (const body of refusals) expect((await failure(tom.createSandbox(body))).code).toBe("invalid");
	});

	it("prices by vCPU and GB an hour", () => {
		const rates = { currency: "USD", microvmPerVcpuHour: 0.01, microvmPerGbHour: 0.002, isolatePerGbHour: 0.02 };
		expect(hourlyRate(rates, "microvm", { vcpus: 2, memoryMb: 4096 })).toBe(0.028);
		expect(hourlyRate(rates, "isolate", { vcpus: 0, memoryMb: 512 })).toBe(0.01);
		expect(checkShape("microvm", { vcpus: 2, memoryMb: 768 }, [{ vcpus: 2, memoryMb: 768 }])).toEqual({
			vcpus: 2,
			memoryMb: 768,
		});
	});

	it("offers a host's presets, and any shape where it makes them, promising no disk for one", () => {
		const host = {
			id: "h",
			name: "h",
			version: "1",
			os: "linux",
			arch: "x86_64",
			tiers: ["microvm"],
			kvm: true,
			nestedVirtualisation: false,
			capacity: { vcpus: 8, memoryMb: 16_384, diskGb: 200 },
			labels: {},
		} as const;
		const sizes = [{ name: "default", vcpus: 2, memoryMb: 2048, diskGb: 20 }] as const;
		const named = microvmShapes([host], sizes);
		expect(named).toMatchObject({ vcpus: { max: 2 }, memoryMb: { max: 2048 }, custom: false });
		const custom = microvmShapes([{ ...host, features: ["custom-shapes"] }], sizes);
		expect(custom).toMatchObject({ vcpus: { max: 8 }, memoryMb: { max: 16_384 }, custom: true });
		expect(custom?.presets).toEqual([{ name: "default", vcpus: 2, memoryMb: 2048, diskGb: 20 }]);
		// A custom shape's disk is its host's to give (and a snapshot's to keep): none is said ahead.
		expect(custom).not.toHaveProperty("customDisk");
		expect(microvmShapes([], sizes)).toBeUndefined();
	});

	it("keeps hosts' different shapes under one name apart", () => {
		const host = {
			id: "a",
			name: "a",
			version: "1",
			os: "linux",
			arch: "x86_64",
			tiers: ["microvm"],
			kvm: true,
			nestedVirtualisation: false,
			capacity: { vcpus: 8, memoryMb: 16_384, diskGb: 200 },
			labels: {},
			features: ["custom-shapes"],
		} as const;
		const four = { ...host, sizes: [{ name: "default" as const, vcpus: 4, memoryMb: 2048, diskGb: 20 }] };
		const two = { ...host, id: "b", sizes: [{ name: "default" as const, vcpus: 2, memoryMb: 4096, diskGb: 40 }] };
		const shapes = microvmShapes([four, two], []);
		expect(shapes?.presets).toEqual([
			{ name: "default", vcpus: 2, memoryMb: 4096, diskGb: 40 },
			{ name: "default", vcpus: 4, memoryMb: 2048, diskGb: 20 },
		]);
		// The same shape on both: one entry.
		const same = microvmShapes([four, { ...four, id: "c" }], []);
		expect(same?.presets).toEqual([{ name: "default", vcpus: 4, memoryMb: 2048, diskGb: 20 }]);
	});

	it("checks a shape against the hosts this create may use only, however full they are", () => {
		const host = {
			id: "named",
			name: "named",
			version: "1",
			os: "linux",
			arch: "x86_64",
			tiers: ["microvm"],
			kvm: true,
			nestedVirtualisation: false,
			capacity: { vcpus: 8, memoryMb: 16_384, diskGb: 200 },
			labels: {},
		} as const;
		const sizes = [{ name: "default", vcpus: 2, memoryMb: 2048, diskGb: 20 }] as const;
		const custom = { vcpus: 3, memoryMb: 6144 };
		// Only named sizes where it may go: another account's upgraded host doesn't count.
		expect(() => shapeFor("microvm", custom, [host], sizes)).toThrow(/No host this sandbox may use/);
		expect(shapeFor("microvm", { vcpus: 2, memoryMb: 2048 }, [host], sizes)).toEqual({ vcpus: 2, memoryMb: 2048 });
		expect(shapeFor("microvm", custom, [{ ...host, features: ["custom-shapes"] }], sizes)).toEqual(custom);
		// From a snapshot it boots on the snapshot's host as it was.
		expect(shapeFor("microvm", custom, [host], sizes, false)).toEqual(custom);
		expect(shapeFor("isolate", undefined, [], sizes)).toEqual({ vcpus: 0, memoryMb: 256 });
		expect(shapeFor("microvm", undefined, [], sizes)).toBeUndefined();
	});

	it("refuses a screen the image reports it lacks once placed, even when asked for before then", async () => {
		const stub = createStubBackend();
		const reason = "No desktop in this image: it has no Xvfb";
		let screens = 0;
		const backend: SandboxBackend = {
			...stub,
			// An injected Alpine image: it says what it has when it boots, after the create returned.
			create: async (spec) => {
				const placement = await stub.create(spec);
				await new Promise((resolve) => setTimeout(resolve, 20));
				const unavailable = { available: false, reason };
				return {
					...placement,
					capabilities: {
						...placement.capabilities,
						desktop: false,
						browser: false,
						guest: {
							reportedAt: Date.now(),
							os: { id: "alpine", name: "Alpine Linux v3.22", version: "3.22.0" },
							arch: "x86_64",
							libc: "musl",
							shell: "/bin/sh",
							init: "kantel",
							agent: { version: "test", injected: true },
							desktop: unavailable,
							browser: { available: false, reason: "No browser in this image" },
							docker: { available: false, reason: "No Docker in this image", kvm: false },
						},
					},
				};
			},
			openDesktop: async (...args) => {
				screens++;
				return stub.openDesktop(...args);
			},
			openBrowser: async (...args) => {
				screens++;
				return stub.openBrowser(...args);
			},
		};
		const { tom } = setup(backend);
		const vm = await tom.createSandbox({ type: "microvm" });
		const desktop = await failure(tom.openDesktop(vm.id, {}));
		expect(desktop.code).toBe("not_supported");
		expect(desktop.message).toBe(reason);
		expect((await failure(tom.openBrowser(vm.id, {}))).code).toBe("not_supported");
		expect(screens).toBe(0);
	});

	it("extends a running sandbox's stop time and stops it once that passes", async () => {
		let clock = Date.UTC(2026, 0, 1);
		const api = createComputeApi({
			backend: createStubBackend(),
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
			now: () => clock,
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const sandbox = await tom.createSandbox({ autoStopMinutes: 5, wait: true });
		expect(sandbox.stopsAt).toBe(clock + 5 * 60_000);
		const extended = await tom.updateSandbox(sandbox.id, { extendMinutes: 30 });
		expect(extended.stopsAt).toBe(clock + 30 * 60_000);

		clock += 31 * 60_000;
		await tom.getCaller();
		await api.service.idle();
		const stopped = await tom.getSandbox(sandbox.id);
		expect(stopped.state).toBe("stopped");
		expect(stopped.usage.runningSeconds).toBe(31 * 60);
		expect(stopped.cost.total).toBeGreaterThan(0);
		expect(stopped.reason).toBe("auto-stop");

		// A command then is refused with why it stopped and how to resume it; nothing resumes it.
		const refused = await failure(tom.runCommand(sandbox.id, { command: "true" }));
		expect(refused.status).toBe(409);
		expect(refused.code).toBe("conflict");
		expect(refused.message).toBe("The sandbox is stopped (auto-stop); resume it first");
		expect(refused.details).toEqual({
			code: "sandbox_stopped",
			sandboxId: sandbox.id,
			state: "stopped",
			stopReason: "auto-stop",
			hint: `Resume it with kantel resume ${sandbox.id} or POST /v1/sandboxes/${sandbox.id}/resume, then try again`,
		});
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");
		// Its reason goes once it runs again.
		expect((await tom.resumeSandbox(sandbox.id, { wait: true })).reason).toBeUndefined();
	});
});

describe("idle stop", () => {
	function clocked(store?: ReturnType<typeof createMemoryStore>) {
		const clock = { at: Date.UTC(2026, 0, 1) };
		const api = createComputeApi({
			backend: createStubBackend(),
			...(store === undefined ? {} : { store }),
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
			now: () => clock.at,
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		/** Moves the clock on, then lets a request sweep and waits for what it began. */
		const after = async (ms: number) => {
			clock.at += ms;
			await tom.getCaller();
			await api.service.idle();
		};
		return { clock, api, tom, after };
	}

	it("stops a sandbox once it goes unused for its idle stop, apart from its auto-stop, and keeps its disk", async () => {
		const { clock, api, tom, after } = clocked();
		const started = clock.at;
		const sandbox = await tom.createSandbox({ autoStopMinutes: null, idleStopMinutes: 10, wait: true });
		expect(sandbox.idleStopMinutes).toBe(10);
		expect(sandbox.stopsAt).toBeUndefined();
		expect(sandbox.lastActiveAt).toBe(started);
		expect(sandbox.idleStopsAt).toBe(started + 10 * 60_000);

		// A command is a use: the idle time counts from it.
		await after(6 * 60_000);
		await tom.runCommand(sandbox.id, { command: "true" });
		await api.service.idle();
		const used = clock.at;
		const after6 = await tom.getSandbox(sandbox.id);
		expect(after6.lastActiveAt).toBe(used);
		expect(after6.idleStopsAt).toBe(used + 10 * 60_000);

		// Reading it isn't a use; nine minutes on it still runs, and past ten it stops.
		await after(9 * 60_000);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
		await after(2 * 60_000);
		const stopped = await tom.getSandbox(sandbox.id);
		expect(stopped.state).toBe("stopped");
		expect(stopped.reason).toBe("idle-stop");
		expect(stopped.idleStopMinutes).toBe(10);
		expect(stopped.idleStopsAt).toBeUndefined();
		expect(stopped.latestSnapshotId).toBeDefined();

		// Nothing resumes it: a command is refused with why it stopped, and a hosted port's request is told so.
		const refused = await failure(tom.runCommand(sandbox.id, { command: "true" }));
		expect(refused.status).toBe(409);
		expect(refused.details).toMatchObject({ code: "sandbox_stopped", stopReason: "idle-stop" });
		const page = await api.service.portNotRunning(sandbox.id);
		expect(page).toContain("went 10 minutes without use (its idle stop)");
		expect(page).toContain("Its disk is kept");
		expect(page).toContain(`kantel resume ${sandbox.id}`);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");

		// Resumed, its idle time counts from the start.
		const resumed = await tom.resumeSandbox(sandbox.id, { wait: true });
		expect(resumed.reason).toBeUndefined();
		expect(resumed.lastActiveAt).toBe(clock.at);
		expect(await api.service.portNotRunning(sandbox.id)).toBeUndefined();
	});

	it("counts relayed traffic, writing it at most once a window and the rest at the sweep", async () => {
		const { clock, api, tom, after } = clocked();
		const sandbox = await tom.createSandbox({ autoStopMinutes: null, idleStopMinutes: 5, wait: true });
		await after(60_000);
		const first = clock.at;
		api.service.noteActivity(sandbox.id);
		await api.service.idle();
		expect((await tom.getSandbox(sandbox.id)).lastActiveAt).toBe(first);

		// More traffic within the window is held, not written.
		clock.at += 5_000;
		const held = clock.at;
		api.service.noteActivity(sandbox.id);
		await api.service.idle();
		expect((await tom.getSandbox(sandbox.id)).lastActiveAt).toBe(first);
		// The sweep after the window writes it.
		await after(15_000);
		expect((await tom.getSandbox(sandbox.id)).lastActiveAt).toBe(held);

		// Traffic keeps it running past its idle time from the start; once it stops, it stops.
		for (let minute = 0; minute < 8; minute++) {
			await after(60_000);
			api.service.noteActivity(sandbox.id);
		}
		await api.service.idle();
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
		await after(6 * 60_000);
		const stopped = await tom.getSandbox(sandbox.id);
		expect(stopped.state).toBe("stopped");
		expect(stopped.reason).toBe("idle-stop");
	});

	it("is set, changed and turned off by an update, counting from it, and validated", async () => {
		const { clock, tom, after } = clocked();
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox.idleStopMinutes).toBeNull();
		expect(sandbox.idleStopsAt).toBeUndefined();
		await after(3 * 60_000);
		const set = await tom.updateSandbox(sandbox.id, { idleStopMinutes: 20 });
		expect(set.idleStopMinutes).toBe(20);
		expect(set.idleStopsAt).toBe(clock.at + 20 * 60_000);
		// Its auto-stop is untouched.
		expect(set.stopsAt).toBe(sandbox.stopsAt);
		const off = await tom.updateSandbox(sandbox.id, { idleStopMinutes: null });
		expect(off.idleStopMinutes).toBeNull();
		expect(off.idleStopsAt).toBeUndefined();

		for (const minutes of [0, 43_201, 1.5]) {
			const refused = await failure(tom.updateSandbox(sandbox.id, { idleStopMinutes: minutes }));
			expect(refused.status).toBe(400);
			const made = await failure(tom.createSandbox({ idleStopMinutes: minutes }));
			expect(made.status).toBe(400);
		}
		// A fork keeps it.
		const idle = await tom.updateSandbox(sandbox.id, { idleStopMinutes: 15 });
		const [fork] = (await tom.forkSandbox(idle.id, { wait: true })).items;
		expect(fork?.idleStopMinutes).toBe(15);
	});

	it("counts a use whose write is held up or failed, till the store has it, against its idle stop only", async () => {
		const memory = createMemoryStore();
		const sandboxes = memory.sandboxes;
		// Writes of a use alone (only `lastActiveAt` moves) fail, or wait for `release`; every other write goes through.
		let mode: "ok" | "fail" | "hold" = "ok";
		let release = () => {};
		const attempts: number[] = [];
		const store = {
			...memory,
			sandboxes: {
				...sandboxes,
				async update(
					id: string,
					change: Parameters<typeof sandboxes.update>[1],
					expected?: Parameters<typeof sandboxes.update>[2],
				) {
					const current = await sandboxes.get(id);
					const next = current === undefined ? undefined : change(current);
					const useOnly =
						current !== undefined &&
						next !== undefined &&
						next.lastActiveAt !== current.lastActiveAt &&
						JSON.stringify({ ...next, lastActiveAt: 0 }) === JSON.stringify({ ...current, lastActiveAt: 0 });
					if (useOnly && next?.lastActiveAt !== undefined) attempts.push(next.lastActiveAt);
					if (useOnly && mode === "fail") throw new Error("The database is away");
					if (useOnly && mode === "hold") {
						await new Promise<void>((resolve) => {
							release = resolve;
						});
					}
					return sandboxes.update(id, change, expected);
				},
			},
		};
		const { clock, api, tom, after } = clocked(store);
		const started = clock.at;
		const sandbox = await tom.createSandbox({ autoStopMinutes: null, idleStopMinutes: 1, wait: true });

		// A use whose write fails still counts: past a minute and its grace from its start, it runs on.
		mode = "fail";
		await after(50_000);
		const used = clock.at;
		api.service.noteActivity(sandbox.id);
		await api.service.idle();
		await after(50_000);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
		expect((await tom.getSandbox(sandbox.id)).lastActiveAt).toBe(started);
		// It's tried again at the next sweep after its window, and once the store is back it's written.
		mode = "ok";
		await after(20_000);
		expect(attempts.filter((at) => at === used).length).toBeGreaterThanOrEqual(3);
		expect((await tom.getSandbox(sandbox.id)).lastActiveAt).toBe(used);

		// A use whose write is held up: the sweep doesn't wait for it, and doesn't idle-stop the sandbox meanwhile.
		mode = "hold";
		await after(15_000);
		const held = clock.at;
		api.service.noteActivity(sandbox.id);
		clock.at += 50_000;
		// Stored, its last use is over 90 s ago (`used`); seen here, it's 50 s.
		await tom.getCaller();
		const during = await tom.getSandbox(sandbox.id);
		expect(during.state).toBe("running");
		expect(during.lastActiveAt).toBe(used);
		mode = "ok";
		release();
		await api.service.idle();
		expect((await tom.getSandbox(sandbox.id)).lastActiveAt).toBe(held);

		// Once its last use is a minute and its grace behind, it stops.
		await after(100_000);
		const stopped = await tom.getSandbox(sandbox.id);
		expect(stopped.state).toBe("stopped");
		expect(stopped.reason).toBe("idle-stop");
	});

	it("waits out its grace, so a use another gateway holds back lands before this one's sweep can stop it", async () => {
		const clock = { at: Date.UTC(2026, 0, 1) };
		const store = createMemoryStore();
		const backend = createStubBackend();
		const gateway = () => {
			const api = createComputeApi({
				backend,
				store,
				authenticatePerson: async (request) =>
					request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
				now: () => clock.at,
			});
			opened.push(api);
			const tom = createKantelClient({
				baseUrl: BASE_URL,
				token: "tom-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
			/** Its sweep, now: a request lets it sweep, and it waits for what it began. */
			const sweep = async () => {
				await tom.getCaller();
				await api.service.idle();
			};
			return { api, tom, sweep };
		};
		const a = gateway();
		const b = gateway();
		const sandbox = await a.tom.createSandbox({ autoStopMinutes: null, idleStopMinutes: 1, wait: true });
		const started = clock.at;

		// Gateway A writes a use at once, then holds the next one back for its window.
		clock.at = started + 50_000;
		a.api.service.noteActivity(sandbox.id);
		await a.api.service.idle();
		clock.at = started + 64_000;
		a.api.service.noteActivity(sandbox.id);
		// Past a minute from the use A stored, B sweeps before A has written the one it held: within its grace, it runs on.
		clock.at = started + 111_000;
		await b.sweep();
		expect((await b.tom.getSandbox(sandbox.id)).state).toBe("running");
		// A's sweep writes it; past a minute from the stored use but not its grace, B leaves it running.
		clock.at = started + 112_000;
		await a.sweep();
		expect((await b.tom.getSandbox(sandbox.id)).lastActiveAt).toBe(started + 64_000);
		clock.at = started + 141_000;
		await b.sweep();
		expect((await b.tom.getSandbox(sandbox.id)).state).toBe("running");
		// Unused a minute and its grace, B stops it.
		clock.at = started + 64_000 + 60_000 + 30_000;
		await b.sweep();
		const stopped = await b.tom.getSandbox(sandbox.id);
		expect([stopped.state, stopped.reason]).toEqual(["stopped", "idle-stop"]);
	});

	it("stops for its auto-stop or a stop it is owed however recently it was used", async () => {
		const store = createMemoryStore();
		const { api, tom, after } = clocked(store);
		const timed = await tom.createSandbox({ autoStopMinutes: 2, idleStopMinutes: 10, wait: true });
		const owed = await tom.createSandbox({ autoStopMinutes: null, idleStopMinutes: 10, wait: true });
		for (let i = 0; i < 9; i++) {
			await after(15_000);
			api.service.noteActivity(timed.id);
			api.service.noteActivity(owed.id);
		}
		await store.sandboxes.update(owed.id, (current) => ({ ...current, stopFor: "egress-rule" }));
		api.service.noteActivity(owed.id);
		await after(1_000);
		const a = await tom.getSandbox(timed.id);
		expect([a.state, a.reason]).toEqual(["stopped", "auto-stop"]);
		const b = await tom.getSandbox(owed.id);
		expect([b.state, b.reason]).toEqual(["stopped", "egress-rule"]);
	});

	it("stops for its auto-stop, not idleness, where both are due", async () => {
		const { tom, after } = clocked();
		const sandbox = await tom.createSandbox({ autoStopMinutes: 5, idleStopMinutes: 5, wait: true });
		await after(6 * 60_000);
		const stopped = await tom.getSandbox(sandbox.id);
		expect(stopped.state).toBe("stopped");
		expect(stopped.reason).toBe("auto-stop");
	});
});

/** A backend whose resumes wait for `release` and then go on, or fail with `failWith`. */
function gatedResumes() {
	const stub = createStubBackend();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const state = { resumes: 0, failWith: undefined as Error | undefined };
	const backend: SandboxBackend = {
		...stub,
		resume: async (sandboxId, options) => {
			state.resumes++;
			await gate;
			if (state.failWith !== undefined) throw state.failWith;
			return stub.resume(sandboxId, options);
		},
	};
	return { backend, release: () => release(), state };
}

describe("calls on a sandbox that isn't running", () => {
	it("refuses a stopped or paused sandbox with a stable code and the resume call, and stops nothing else", async () => {
		const { tom } = setup();
		const isolate = await tom.createSandbox({ wait: true });
		await tom.stopSandbox(isolate.id, { wait: true });
		const stopped = await failure(tom.readFile(isolate.id, { path: "f.txt" }));
		expect(stopped.status).toBe(409);
		expect(stopped.code).toBe("conflict");
		expect(stopped.message).toBe("The sandbox is stopped; resume it first");
		// A stop someone asked for records no reason.
		expect(stopped.details).toEqual({
			code: "sandbox_stopped",
			sandboxId: isolate.id,
			state: "stopped",
			hint: `Resume it with kantel resume ${isolate.id} or POST /v1/sandboxes/${isolate.id}/resume, then try again`,
		});
		for (const call of [
			tom.runCommand(isolate.id, { command: "true" }),
			tom.writeFile(isolate.id, { path: "f.txt", content: "x" }),
			tom.listFiles(isolate.id),
			tom.deleteFile(isolate.id, { path: "f.txt" }),
		]) {
			expect((await failure(call)).details).toMatchObject({ code: "sandbox_stopped", state: "stopped" });
		}

		const vm = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const paused = await failure(tom.runCommand(vm.id, { command: "true" }));
		expect(paused.code).toBe("conflict");
		expect(paused.message).toBe("The sandbox is paused; resume it first");
		expect(paused.details).toMatchObject({ code: "sandbox_paused", sandboxId: vm.id, state: "paused" });
		expect(paused.details?.hint).toContain(`kantel resume ${vm.id}`);
		expect((await tom.getSandbox(vm.id)).state).toBe("paused");
	});

	it("holds a call made while the sandbox starts and runs it once it is running", async () => {
		const gated = gatedResumes();
		const { api, tom } = setup(gated.backend);
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		const starting = await tom.resumeSandbox(sandbox.id, { wait: false });
		expect(starting.state).toBe("starting");

		// Two callers wait on the one start; its own timeout starts only once it runs.
		const first = tom.runCommand(sandbox.id, { command: "echo one", timeoutMs: 50 });
		const second = tom.writeFile(sandbox.id, { path: "two.txt", content: "two" });
		await new Promise((resolve) => setTimeout(resolve, 150));
		gated.release();
		const command = await first;
		expect(command).toMatchObject({ state: "exited", exitCode: 0, stdout: "one\n" });
		expect(await second).toMatchObject({ path: "/home/user/two.txt" });
		expect(gated.state.resumes).toBe(1);
		await api.service.idle();
		const events = await tom.listEvents({ sandboxId: sandbox.id });
		expect(events.items.filter((event) => event.type === "sandbox.running")).toHaveLength(2);
	});

	it("holds a call while another gateway starts the sandbox, reading it again until it runs", async () => {
		const { api, tom } = setup(createStubBackend(), { startPollMs: 10 });
		const sandbox = await tom.createSandbox({ wait: true });
		const running = await api.store.sandboxes.get(sandbox.id);
		if (running === undefined) throw new Error("No record");
		// As this gateway sees a start another gateway carries out: starting, with no work of its own to wait on.
		await api.store.sandboxes.put({ ...running, state: "starting" });
		setTimeout(() => void api.store.sandboxes.put(running), 100);
		const command = await tom.runCommand(sandbox.id, { command: "echo ran" });
		expect(command).toMatchObject({ state: "exited", stdout: "ran\n" });
	});

	it("answers sandbox_starting once the hold runs out, so the caller sends it again", async () => {
		const gated = gatedResumes();
		const { api, tom } = setup(gated.backend, { startHoldMs: 100, startPollMs: 10 });
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		await tom.resumeSandbox(sandbox.id, { wait: false });
		const refused = await failure(tom.runCommand(sandbox.id, { command: "true" }));
		expect(refused.status).toBe(409);
		expect(refused.code).toBe("conflict");
		expect(refused.message).toBe("The sandbox is still starting after 100 ms; send the call again");
		expect(refused.details).toEqual({
			code: "sandbox_starting",
			sandboxId: sandbox.id,
			state: "starting",
			hint: "It is still starting: send the call again in a moment",
		});
		// Nothing was run or recorded for it; the start carries on, and the call sent again runs.
		expect((await tom.listCommands(sandbox.id)).items).toEqual([]);
		gated.release();
		await api.service.idle();
		expect((await tom.runCommand(sandbox.id, { command: "true" })).exitCode).toBe(0);
	});

	it("refuses a held call with sandbox_error and its reason when the start fails", async () => {
		const gated = gatedResumes();
		const { tom } = setup(gated.backend);
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		await tom.resumeSandbox(sandbox.id, { wait: false });
		gated.state.failWith = new Error("The host ran out of disk");
		const held = failure(tom.runCommand(sandbox.id, { command: "true" }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		gated.release();
		const refused = await held;
		expect(refused.code).toBe("conflict");
		expect(refused.message).toBe("The sandbox is in error (The host ran out of disk); resume it first");
		expect(refused.details).toMatchObject({
			code: "sandbox_error",
			sandboxId: sandbox.id,
			state: "error",
			stopReason: "The host ran out of disk",
		});
		// Not `details.reason`, which the SDK reads as a placement's.
		expect(refused.details).not.toHaveProperty("reason");
		expect(refused.details?.hint).toContain(`kantel resume ${sandbox.id}`);
	});
});

describe("placement reasons", () => {
	/** The stub, its hosts as `hosts` says (the stub's own one, as it reports it, by default). */
	function placing(
		hosts: (own: BackendCapabilities) => BackendCapabilities = (own) => own,
		types?: Parameters<typeof createStubBackend>[0],
	): SandboxBackend {
		const stub = createStubBackend(types);
		return { ...stub, capabilities: async () => hosts(await stub.capabilities()) };
	}
	const reasonOf = async (call: Promise<unknown>) => {
		const error = await failure(call);
		return { status: error.status, code: error.code, reason: error.reason, details: error.details };
	};

	it("says no_host when no host is connected, and no_host_for_type when none runs the type", async () => {
		const { tom } = setup(placing(() => ({ types: [], sizes: [], hosts: [] })));
		expect(await reasonOf(tom.createSandbox({ type: "microvm" }))).toEqual({
			status: 503,
			code: "unavailable",
			reason: "no_host",
			details: { reason: "no_host" },
		});
		const isolates = setup(placing(undefined, { types: ["isolate"] }));
		expect(await reasonOf(isolates.tom.createSandbox({ type: "microvm" }))).toMatchObject({
			status: 503,
			code: "unavailable",
			reason: "no_host_for_type",
		});
		// The host is there, but offline.
		const offline = setup(
			placing((own) => ({ ...own, hosts: own.hosts.map((host) => ({ ...host, connected: false })) })),
		);
		expect(await reasonOf(offline.tom.createSandbox({ type: "microvm" }))).toMatchObject({
			status: 503,
			reason: "no_host",
		});
	});

	it("says no_host_with_labels and no_host_offers_size, the codes as before", async () => {
		const { tom } = setup(placing((own) => ({ ...own, sizes: own.sizes.filter((size) => size.name !== "xlarge") })));
		expect(await reasonOf(tom.createSandbox({ hostLabels: { zone: "ams" } }))).toMatchObject({
			status: 503,
			code: "unavailable",
			reason: "no_host_with_labels",
		});
		expect(await reasonOf(tom.createSandbox({ type: "microvm", size: "xlarge" }))).toMatchObject({
			status: 501,
			code: "not_supported",
			reason: "no_host_offers_size",
		});
	});

	it("says account_limit when the account runs as many sandboxes as it may", async () => {
		const { tom } = setup(placing(), { limits: { concurrentSandboxes: 1 } });
		await tom.createSandbox({ wait: true });
		expect(await reasonOf(tom.createSandbox({}))).toMatchObject({
			status: 429,
			code: "exhausted",
			reason: "account_limit",
		});
	});

	it("says host_unavailable when a stopped sandbox's host can't take it back", async () => {
		let hostUp = true;
		let otherHost = false;
		const backend = placing((own) => {
			const [stub] = own.hosts;
			if (stub === undefined) throw new Error("The stub has a host");
			return {
				...own,
				hosts: [
					{ ...stub, connected: hostUp },
					...(otherHost ? [{ ...stub, id: "host_other", name: "other", connected: true }] : []),
				],
			};
		});
		const { tom } = setup(backend);
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		hostUp = false;
		// No host at all: the start is refused, naming its own host as the trouble.
		expect(await reasonOf(tom.startSandbox(sandbox.id, { wait: true }))).toMatchObject({
			status: 503,
			code: "unavailable",
			reason: "host_unavailable",
		});
		// So are a fork of it and a sandbox made from its snapshot, bound to that host as it is, whatever the fleet has.
		expect(await reasonOf(tom.forkSandbox(sandbox.id, {}))).toMatchObject({
			status: 503,
			code: "unavailable",
			reason: "host_unavailable",
		});
		const snapshotId = (await tom.getSandbox(sandbox.id)).latestSnapshotId;
		expect(snapshotId).toBeDefined();
		expect(await reasonOf(tom.createSandbox({ type: "microvm", from: snapshotId }))).toMatchObject({
			status: 503,
			code: "unavailable",
			reason: "host_unavailable",
		});
		// Another host is up, but its disk is on its own: its boot fails, and the sandbox says why.
		otherHost = true;
		const started = await tom.startSandbox(sandbox.id, { wait: true });
		expect(started).toMatchObject({ state: "error", placementReason: "host_unavailable" });
		// Back on its host, it starts, and the reason goes with the error.
		hostUp = true;
		const again = await tom.startSandbox(sandbox.id, { wait: true });
		expect(again.state).toBe("running");
		expect(again.placementReason).toBeUndefined();
	});

	it("names a refusal for the type by the hosts the caller may use, and a snapshot's by its host", async () => {
		let microvmHost = true;
		let isolatesUp = true;
		const backend = placing((own) => {
			const [stub] = own.hosts;
			if (stub === undefined) throw new Error("The stub has a host");
			const isolates = {
				...stub,
				id: "host_isolates",
				name: "isolates",
				tiers: ["isolate" as const],
				connected: isolatesUp,
			};
			return {
				...own,
				types: microvmHost ? ["isolate", "microvm"] : ["isolate"],
				hosts: microvmHost ? [stub, isolates] : [isolates],
			};
		});
		const { tom } = setup(backend);
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		const from = (await tom.getSandbox(sandbox.id)).latestSnapshotId;
		// The microVM host is gone (revoked, say): only an isolate host is left.
		microvmHost = false;
		expect(await reasonOf(tom.createSandbox({ type: "microvm", from }))).toMatchObject({
			status: 503,
			code: "unavailable",
			reason: "host_unavailable",
		});
		expect(await reasonOf(tom.createSandbox({ type: "microvm" }))).toMatchObject({
			status: 503,
			reason: "no_host_for_type",
		});
		// And with that one offline too, none is connected at all.
		isolatesUp = false;
		expect(await reasonOf(tom.createSandbox({ type: "microvm" }))).toMatchObject({ status: 503, reason: "no_host" });
	});

	it("carries no reason on other errors", async () => {
		const { tom } = setup();
		const error = await failure(tom.getSandbox("sbx_missing"));
		expect([error.code, error.reason, error.details]).toEqual(["not_found", undefined, undefined]);
	});
});

describe("keys and scopes", () => {
	it("refuses a read-only key a create, and a call with no bearer or a bad one", async () => {
		const { client, tom } = setup();
		const issued = await tom.createApiKey({ name: "reader", preset: "read-only" });
		expect(issued.secret).toMatch(/^ksk_[0-9A-Za-z]{32}$/);
		expect(issued.key.prefix).toBe(issued.secret.slice(0, 8));
		expect(issued.key.scopes).toEqual(["sandboxes:read", "snapshots:read", "account:read"]);

		const reader = client(issued.secret);
		expect((await reader.listSandboxes()).items).toEqual([]);
		const refused = await failure(reader.createSandbox({}));
		expect(refused.status).toBe(403);
		expect(refused.code).toBe("forbidden");

		const anonymous = await failure(client(undefined).getCaller());
		expect(anonymous.status).toBe(401);
		expect(anonymous.code).toBe("unauthenticated");
		expect((await failure(client("ksk_notakey").getCaller())).status).toBe(401);

		await tom.revokeApiKey(issued.key.id);
		expect((await failure(reader.listSandboxes())).status).toBe(401);
	});

	it("lets a key grant only the scopes it holds", async () => {
		const { client, tom } = setup();
		const admin = client(
			(await tom.createApiKey({ name: "admin", scopes: ["account:admin", "sandboxes:read"] })).secret,
		);
		const refused = await failure(admin.createApiKey({ name: "more", scopes: ["exec"] }));
		expect(refused.code).toBe("forbidden");
		const narrower = await admin.createApiKey({ name: "less", scopes: ["sandboxes:read"] });
		expect(narrower.key.scopes).toEqual(["sandboxes:read"]);
		expect((await failure(admin.createApiKey({ name: "hosts", scopes: ["hosts:admin"] }))).code).toBe("forbidden");
	});

	it("rotates a key, so the old secret stops working", async () => {
		const { client, tom } = setup();
		const issued = await tom.createApiKey({ name: "ci", preset: "ci" });
		const rotated = await tom.rotateApiKey(issued.key.id);
		expect(rotated.secret).not.toBe(issued.secret);
		expect((await failure(client(issued.secret).listSandboxes())).status).toBe(401);
		expect((await client(rotated.secret).getCaller()).apiKey?.id).toBe(issued.key.id);
	});

	it("won't let a key rotate a key holding scopes it lacks, which would hand it their secret", async () => {
		const { client, root } = setup();
		const admin = await root.createApiKey({ name: "admin", preset: "admin" });
		const wide = await root.createApiKey({ name: "hosts", scopes: ["account:read", "hosts:admin"] });
		const refused = await failure(client(admin.secret).rotateApiKey(wide.key.id));
		expect(refused.code).toBe("forbidden");
		expect((await client(wide.secret).getCaller()).apiKey?.id).toBe(wide.key.id);
	});

	it("never answers the proxy's upstream header values", async () => {
		const { tom } = setup();
		const settings = await tom.putProxySettings({
			enabled: true,
			defaultAction: "deny",
			allow: ["api.github.com"],
			upstream: { url: "https://mehen.example", headers: { authorization: "Bearer hush-123" } },
		});
		expect(settings.upstream?.headerNames).toEqual(["authorization"]);
		expect(JSON.stringify(settings)).not.toContain("hush-123");
		expect(JSON.stringify(await tom.getProxySettings())).not.toContain("hush-123");
	});

	it("refuses a proxy write made from an older read, with `expected`, and leaves the settings as they were", async () => {
		const { tom } = setup();
		// Never written: the defaults are what was read.
		const unset = await tom.getProxySettings();
		const first = await tom.putProxySettings({
			enabled: true,
			defaultAction: "deny",
			allow: ["api.github.com"],
			upstream: { url: "https://mehen.example", headers: { authorization: "Bearer hush-123" } },
			expected: unset,
		});
		// Someone else adds a host from that read.
		const theirs = await tom.putProxySettings({
			...first,
			upstream: { url: "https://mehen.example" },
			allow: [...first.allow, "pypi.org"],
			expected: first,
		});
		expect(theirs.upstream?.headerNames).toEqual(["authorization"]);

		// A write from the same, now older, read would drop pypi.org: it is refused.
		const stale = await failure(
			tom.putProxySettings({
				...first,
				upstream: { url: "https://mehen.example" },
				deny: ["evil.example"],
				expected: first,
			}),
		);
		expect(stale.code).toBe("conflict");
		const now = await tom.getProxySettings();
		expect(now).toMatchObject({ allow: ["api.github.com", "pypi.org"], deny: [] });

		// From the defaults too, once the settings have been written.
		expect((await failure(tom.putProxySettings({ enabled: false, expected: unset }))).code).toBe("conflict");
		// Without `expected` the write replaces them whatever they hold, as before.
		expect(await tom.putProxySettings({ enabled: false })).toMatchObject({ enabled: false, allow: [] });
	});

	it("refuses a first proxy write whose `expected` isn't the defaults", async () => {
		const { tom } = setup();
		const unset = await tom.getProxySettings();
		const refused = await failure(
			tom.putProxySettings({ enabled: true, expected: { ...unset, allow: ["api.github.com"] } }),
		);
		expect(refused.code).toBe("conflict");
		expect(await tom.getProxySettings()).toEqual(unset);
	});
});

describe("device sign-in", () => {
	it("signs a device in once a person approves its code, and hands its key over once", async () => {
		const { client, tom } = setup();
		const device = client(undefined);
		const started = await device.startDeviceLogin({ clientName: "kantel on build-01" });
		expect(started.deviceCode).toMatch(/^kdc_/);
		expect(started.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
		expect(started.verificationUrl).toBe("http://compute.test/device");
		expect(started.verificationUrlComplete).toBe(`http://compute.test/device?code=${started.userCode}`);

		expect(await device.pollDeviceLogin({ deviceCode: started.deviceCode })).toEqual({ state: "pending" });

		// The person may type it in lower case and without the dash.
		const typed = started.userCode.toLowerCase().replace("-", "");
		expect(await tom.getDeviceLogin(typed)).toMatchObject({ clientName: "kantel on build-01", state: "pending" });
		expect(await tom.approveDeviceLogin(typed, { preset: "agent" })).toMatchObject({ state: "approved" });

		const approved = await device.pollDeviceLogin({ deviceCode: started.deviceCode });
		expect(approved.state).toBe("approved");
		expect(approved.issued?.secret).toMatch(/^ksk_/);
		expect(approved.issued?.key.name).toBe("kantel on build-01");
		expect(approved.issued?.key.expiresAt).toBeTypeOf("number");
		const caller = await client(approved.issued?.secret).getCaller();
		expect(caller.apiKey?.scopes).not.toContain("account:admin");
		expect(caller.apiKey?.id).toBe(approved.issued?.key.id);
		expect(approved.issued?.key.createdBy).toMatchObject({ kind: "user", id: "usr_tom" });

		// The secret is handed over once.
		expect(await device.pollDeviceLogin({ deviceCode: started.deviceCode })).toEqual({ state: "expired" });
		expect((await failure(tom.approveDeviceLogin(started.userCode, {}))).code).toBe("conflict");
	});

	it("tells the device when the person denies it, and needs a person to approve", async () => {
		const { client, tom } = setup();
		const device = client(undefined);
		const started = await device.startDeviceLogin({});
		const key = await tom.createApiKey({ name: "admin", preset: "admin" });
		expect((await failure(client(key.secret).approveDeviceLogin(started.userCode, {}))).code).toBe("forbidden");
		expect((await failure(device.approveDeviceLogin(started.userCode, {}))).status).toBe(401);
		await tom.denyDeviceLogin(started.userCode);
		expect(await device.pollDeviceLogin({ deviceCode: started.deviceCode })).toEqual({ state: "denied" });
		expect((await failure(device.pollDeviceLogin({ deviceCode: "kdc_nope" }))).code).toBe("not_found");
		expect((await failure(tom.getDeviceLogin("BBBB-BBBB"))).code).toBe("not_found");
	});
});

describe("organisations", () => {
	it("creates an organisation, invites someone and lets them join", async () => {
		const { tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		expect(org).toMatchObject({ kind: "organisation", role: "owner", defaultVisibility: "organisation" });

		const invite = await tom.createInvite(org.id, { role: "member" });
		const code = invite.code ?? "";
		expect(code).toMatch(/^kji_/);
		const joined = await ann.joinOrganisation({ code });
		expect(joined).toMatchObject({ id: org.id, role: "member" });
		expect((await failure(ann.joinOrganisation({ code }))).code).toBe("expired");

		const members = await tom.listMembers(org.id);
		expect(members.items.map((member) => member.userId).sort()).toEqual(["usr_ann", "usr_tom"]);
		expect((await ann.getCaller()).accounts.map((account) => account.id)).toContain(org.id);
		expect((await failure(ann.createInvite(org.id, {}))).code).toBe("forbidden");

		const shared = await tom.createSandbox({ account: org.id, wait: true });
		const mine = await tom.createSandbox({ account: org.id, visibility: "private", wait: true });
		const seen = await ann.listSandboxes({ account: org.id });
		expect(seen.items.map((item) => item.id)).toEqual([shared.id]);
		expect((await failure(ann.getSandbox(mine.id))).code).toBe("not_found");
		const annEvents = await ann.listEvents({ account: org.id });
		expect(annEvents.items.some((event) => event.sandboxId === shared.id)).toBe(true);
		expect(annEvents.items.some((event) => event.sandboxId === mine.id)).toBe(false);
		const tomEvents = await tom.listEvents({ account: org.id });
		expect(tomEvents.items.some((event) => event.sandboxId === mine.id)).toBe(true);
		expect((await failure(ann.listSandboxes({ account: "acc_elsewhere" }))).code).toBe("forbidden");

		expect((await failure(tom.removeMember(org.id, "usr_tom"))).code).toBe("conflict");
		await ann.removeMember(org.id, "usr_ann");
		expect((await failure(ann.listSandboxes({ account: org.id }))).code).toBe("forbidden");
	});

	it("lets only the person an emailed invite is for join, whatever case either email is in, and says who it's for (#657)", async () => {
		const { tom, ann, root } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { email: "  Ann@Example.COM ", role: "admin" });
		expect(invite.email).toBe("ann@example.com");
		const code = invite.code ?? "";

		const refused = await failure(root.joinOrganisation({ code }));
		expect(refused.code).toBe("forbidden");
		expect(refused.message).toBe(
			"This invite is for ann@example.com, but you're signed in as root@example.com. Sign in as ann@example.com to join.",
		);
		expect(await ann.joinOrganisation({ code })).toMatchObject({ id: org.id, role: "admin" });
		expect((await failure(tom.createInvite(org.id, { email: "not an email" }))).code).toBe("invalid");
	});

	it("emails an invite made for an address, with a link that joins with its code", async () => {
		const sent: InviteMail[] = [];
		const { tom, ann } = setup(createStubBackend(), {
			invites: { send: async (mail) => void sent.push(mail), consoleUrl: "https://kantel.example.com/" },
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { email: "Ann@Example.com", role: "member" });
		expect(invite.emailed).toBe(true);
		expect(sent).toEqual([
			{
				to: "ann@example.com",
				organisation: "Acme",
				invitedBy: "tom@example.com",
				link: `https://kantel.example.com/organisation#join=${invite.code}`,
				expiresAt: invite.expiresAt,
			},
		]);
		// The link's code is the invite's: following it joins.
		const code = decodeURIComponent(new URL(sent[0]?.link ?? "").hash.replace(/^#join=/, ""));
		expect(await ann.joinOrganisation({ code })).toMatchObject({ id: org.id, role: "member" });

		// An invite for anyone with the code goes to nobody.
		expect((await tom.createInvite(org.id, {})).emailed).toBe(false);
		expect(sent).toHaveLength(1);
	});

	it("keeps an invite whose email didn't go, and says so; without mail it sends none", async () => {
		const failed: string[] = [];
		const { tom, ann } = setup(createStubBackend(), {
			invites: {
				send: async () => {
					throw new Error("mail is down");
				},
				onMailError: (_error, to) => void failed.push(to),
			},
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { email: "ann@example.com" });
		expect(invite.emailed).toBe(false);
		expect(failed).toEqual(["ann@example.com"]);
		expect(await ann.joinOrganisation({ code: invite.code ?? "" })).toMatchObject({ id: org.id });

		const unmailed = setup();
		const other = await unmailed.tom.createOrganisation({ name: "Beta" });
		expect((await unmailed.tom.createInvite(other.id, { email: "ann@example.com" })).emailed).toBe(false);
	});

	it("emails an invite only to an address that can sign in to follow its link, where the deployment says", async () => {
		const sent: InviteMail[] = [];
		const asked: string[] = [];
		const { tom, ann } = setup(createStubBackend(), {
			invites: {
				send: async (mail) => void sent.push(mail),
				canSignIn: async (email) => {
					asked.push(email);
					return email === "ann@example.com";
				},
			},
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		const stranger = await tom.createInvite(org.id, { email: "stranger@example.com" });
		expect(stranger).toMatchObject({ email: "stranger@example.com", emailed: false });
		expect(stranger.code).toMatch(/^kji_/);
		const invite = await tom.createInvite(org.id, { email: "Ann@Example.com" });
		expect(invite.emailed).toBe(true);
		expect(asked).toEqual(["stranger@example.com", "ann@example.com"]);
		expect(sent.map((mail) => mail.to)).toEqual(["ann@example.com"]);
		expect(await ann.joinOrganisation({ code: invite.code ?? "" })).toMatchObject({ id: org.id });
	});

	it("links an invite to the console where the call came in, without a console URL", async () => {
		const sent: InviteMail[] = [];
		const { tom } = setup(createStubBackend(), { invites: { send: async (mail) => void sent.push(mail) } });
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { email: "ann@example.com" });
		expect(sent[0]?.link).toBe(`http://compute.test/organisation#join=${invite.code}`);
		expect(inviteLink("https://kantel.example.com//", "kji_a/b")).toBe(
			"https://kantel.example.com/organisation#join=kji_a%2Fb",
		);
	});

	it("tells someone signed in with no email which email an invite is for", () => {
		expect(inviteForSomeoneElse("Ann@Example.com", undefined)).toBe(
			"This invite is for ann@example.com, but you're signed in with no email. Sign in as ann@example.com to join.",
		);
	});

	it("keeps someone off the shared hosts (sharedHosts) out of a sandbox there, though a member shared its account", async () => {
		const { tom, ann, root } = setup(createStubBackend(), { sharedHosts: async (userId) => userId === "usr_tom" });
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		await ann.joinOrganisation({ code: invite.code ?? "" });
		// On the stub, the deployment's one shared host.
		const shared = await tom.createSandbox({ account: org.id, wait: true });

		// Ann sees it listed, but can't use it, nor put a sandbox of her own on the shared hosts.
		expect((await ann.listSandboxes({ account: org.id })).items.map((item) => item.id)).toEqual([shared.id]);
		expect((await failure(ann.getSandbox(shared.id))).code).toBe("forbidden");
		expect((await failure(ann.runCommand(shared.id, { command: "true" }))).code).toBe("forbidden");
		const placed = await failure(ann.createSandbox({ account: org.id, wait: true }));
		expect(placed.code).toBe("unavailable");
		expect(placed.message).toMatch(/host of this account's own/);
		// Tom, who may, still can; and so can the super-admin with sandboxes of their own.
		expect((await tom.runCommand(shared.id, { command: "echo hi" })).stdout).toBe("hi\n");
		const roots = await root.createSandbox({ wait: true });
		expect((await root.runCommand(roots.id, { command: "echo hi" })).stdout).toBe("hi\n");
	});

	it("makes a sandbox whose create or fork failed from its source again, never as an empty one", async () => {
		const stub = createStubBackend();
		let failing = false;
		const refuse = () => Promise.reject(new KantelError("unavailable", "The host is away"));
		const backend: SandboxBackend = {
			...stub,
			create: (spec) => (failing ? refuse() : stub.create(spec)),
			fork: (source, targets) => (failing ? refuse() : stub.fork(source, targets)),
		};
		const { tom } = setup(backend);
		const source = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.writeFile(source.id, { path: "/home/user/kept.txt", content: "kept" });
		const stopped = await tom.stopSandbox(source.id, { wait: true });
		const snapshotId = stopped.latestSnapshotId ?? "";
		await tom.startSandbox(source.id, { wait: true });

		// Its create from the snapshot fails, and so does a fork of the running sandbox (it has no snapshot of its own).
		failing = true;
		const fromSnapshot = await tom.createSandbox({ type: "microvm", from: snapshotId, wait: true });
		expect(fromSnapshot.state).toBe("error");
		const [fork] = (await tom.forkSandbox(source.id, { wait: true })).items;
		expect(fork?.state).toBe("error");
		failing = false;

		// Started again, the first is made from the snapshot, its file there; the fork can't be, so it is refused.
		expect((await tom.startSandbox(fromSnapshot.id, { wait: true })).state).toBe("running");
		expect((await tom.readFile(fromSnapshot.id, { path: "/home/user/kept.txt" })).content).toBe("kept");
		for (const call of [tom.startSandbox(fork?.id ?? "", { wait: true }), tom.recoverSandbox(fork?.id ?? "")]) {
			expect(await failure(call)).toMatchObject({ code: "conflict", message: NEVER_MADE });
		}
		expect((await tom.getSandbox(fork?.id ?? "")).state).toBe("error");

		// One of a shape of its own is made again as that shape; a size named on its start replaces it.
		failing = true;
		const shaped = await tom.createSandbox({
			type: "microvm",
			from: snapshotId,
			resources: { vcpus: 3, memoryMb: 6144 },
			wait: true,
		});
		const sized = await tom.createSandbox({
			type: "microvm",
			from: snapshotId,
			resources: { vcpus: 3, memoryMb: 6144 },
			wait: true,
		});
		failing = false;
		const again = await tom.startSandbox(shaped.id, { wait: true });
		expect(again.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });
		const large = await tom.startSandbox(sized.id, { size: "large", wait: true });
		expect(large).toMatchObject({ size: "large", resources: { vcpus: 4, memoryMb: 8192 } });
	});

	it("runs a restart that names a size as that size, even the name it had, and one that names none as it was", async () => {
		const { tom } = setup();
		const custom = { vcpus: 3, memoryMb: 6144 };
		const made = await tom.createSandbox({ type: "microvm", resources: custom, wait: true });
		const name = made.size ?? "default";
		await tom.stopSandbox(made.id, { wait: true });
		const kept = await tom.startSandbox(made.id, { wait: true });
		expect(kept.resources).toMatchObject(custom);
		// Its own size's name, given: that size, not the custom shape it had.
		await tom.stopSandbox(made.id, { keepMemory: true, wait: true });
		const named = await tom.resumeSandbox(made.id, { size: name, wait: true });
		const size = (await tom.getSandboxShapes()).microvm?.presets.find((preset) => preset.name === name);
		expect(named.resources).toMatchObject({ vcpus: size?.vcpus, memoryMb: size?.memoryMb });
		expect(named.cost.ratePerHour).toBe(
			hourlyRate(PLACEHOLDER_RATES, "microvm", { vcpus: size?.vcpus ?? 0, memoryMb: size?.memoryMb ?? 0 }),
		);
		// Another size, then a fork and a plain restart: each the size it now runs as.
		await tom.stopSandbox(made.id, { wait: true });
		const large = await tom.startSandbox(made.id, { size: "large", wait: true });
		expect(large).toMatchObject({ size: "large", resources: { vcpus: 4, memoryMb: 8192 } });
		const [fork] = (await tom.forkSandbox(made.id, { wait: true })).items;
		expect(fork?.resources).toMatchObject({ vcpus: 4, memoryMb: 8192 });
		await tom.stopSandbox(made.id, { wait: true });
		expect((await tom.startSandbox(made.id, { wait: true })).resources).toMatchObject({ vcpus: 4, memoryMb: 8192 });
	});

	it("makes a plain sandbox whose create failed again as its create would, on recover, start or resume", async () => {
		const stub = createStubBackend();
		let failing = true;
		const creates: string[] = [];
		const backend: SandboxBackend = {
			...stub,
			create: (spec) => {
				creates.push(spec.sandboxId);
				return failing
					? Promise.reject(new KantelError("unavailable", "The disk couldn't be made"))
					: stub.create(spec);
			},
		};
		const { api, tom } = setup(backend);
		// Made from no snapshot, each create fails: no backend has them, and they have no snapshot of their own.
		const made = [];
		for (let i = 0; i < 3; i++) made.push(await tom.createSandbox({ type: "microvm", wait: true }));
		expect(made.map((sandbox) => sandbox.state)).toEqual(["error", "error", "error"]);
		failing = false;

		// Each is made again with the backend's create, as its create made it, rather than asked of a backend without it.
		const [recovered, started, resumed] = made.map((sandbox) => sandbox.id);
		await tom.recoverSandbox(recovered ?? "");
		await api.service.idle();
		expect((await tom.startSandbox(started ?? "", { wait: true })).state).toBe("running");
		expect((await tom.resumeSandbox(resumed ?? "", { wait: true })).state).toBe("running");
		for (const sandbox of made) {
			expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
			expect((await tom.runCommand(sandbox.id, { command: "echo hi" })).stdout).toBe("hi\n");
		}
		expect(creates.filter((id) => id === recovered)).toHaveLength(2);
	});

	it("makes a sandbox from a memory snapshot whose create or fork failed again as the snapshot's machine", async () => {
		const stub = createStubBackend();
		let failing = false;
		const creates: SandboxSpec[] = [];
		const backend: SandboxBackend = {
			...stub,
			create: (spec) => {
				creates.push(spec);
				return failing ? Promise.reject(new KantelError("unavailable", "The host is full")) : stub.create(spec);
			},
			fork: (source, targets) => {
				creates.push(...targets);
				return failing
					? Promise.reject(new KantelError("unavailable", "The host is full"))
					: stub.fork(source, targets);
			},
		};
		const { api, tom } = setup(backend);
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const [pause] = (await tom.listSnapshots({ sandboxId: vm.id })).items;
		const own = pause?.resources && { vcpus: pause.resources.vcpus, memoryMb: pause.resources.memoryMb };
		expect(own).toBeDefined();
		failing = true;
		const made = await tom.createSandbox({ from: pause?.id ?? "", wait: true });
		const [fork] = (await tom.forkSandbox(vm.id, { wait: true })).items;
		expect([made.state, fork?.state]).toEqual(["error", "error"]);
		failing = false;

		for (const id of [made.id, fork?.id ?? ""]) {
			await tom.recoverSandbox(id);
			await api.service.idle();
			expect((await tom.getSandbox(id)).state).toBe("running");
			const remade = creates.filter((spec) => spec.sandboxId === id);
			expect(remade).toHaveLength(2);
			// The snapshot's own machine each time, which its host makes as the snapshot's size.
			for (const spec of remade) expect(spec.shape).toEqual(own);
		}
	});

	it("makes a plain microVM of its own shape whose create failed again as that shape, on recover, start or resume", async () => {
		const stub = createStubBackend();
		let failing = true;
		const creates: { readonly sandboxId: string; readonly size?: string; readonly shape?: unknown }[] = [];
		const backend: SandboxBackend = {
			...stub,
			create: (spec) => {
				creates.push({ sandboxId: spec.sandboxId, size: spec.size, shape: spec.shape });
				return failing
					? Promise.reject(new KantelError("unavailable", "The disk couldn't be made"))
					: stub.create(spec);
			},
		};
		const { api, tom } = setup(backend);
		const custom = { vcpus: 3, memoryMb: 6144 };
		const made = [];
		for (let i = 0; i < 3; i++) made.push(await tom.createSandbox({ type: "microvm", resources: custom, wait: true }));
		expect(made.map((sandbox) => sandbox.state)).toEqual(["error", "error", "error"]);
		failing = false;

		// Each is made again at the shape it asked for: no preset's size in its place.
		const [recovered, started, resumed] = made.map((sandbox) => sandbox.id);
		await tom.recoverSandbox(recovered ?? "");
		await api.service.idle();
		await tom.startSandbox(started ?? "", { wait: true });
		await tom.resumeSandbox(resumed ?? "", { wait: true });
		for (const sandbox of made) {
			const again = await tom.getSandbox(sandbox.id);
			expect(again.state).toBe("running");
			expect(again.resources).toMatchObject(custom);
			const remade = creates.filter((create) => create.sandboxId === sandbox.id);
			expect(remade).toHaveLength(2);
			expect(remade[1]).toMatchObject({ shape: custom });
			expect(remade[1]?.size).toBeUndefined();
		}
	});

	it("sends a sandbox the routed backend's fallback has just made its egress before it runs, and refuses one never made", async () => {
		const stub = createStubBackend();
		let release = () => {};
		const booting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let failing = false;
		const fallback: SandboxBackend = {
			...stub,
			create: async (spec) => {
				if (failing) throw new KantelError("unavailable", "The disk couldn't be made");
				await booting;
				return stub.create(spec);
			},
		};
		// An account-hosts side with no hosts: everything is the fallback's, as is the records' say of what it holds.
		const primary: SandboxBackend = {
			...createStubBackend(),
			capabilities: async () => ({ types: ["isolate", "microvm"], sizes: [], hosts: [] }),
		};
		const records: { api?: ComputeApi } = {};
		const routed = createRoutedBackend({
			primary,
			fallback,
			holds: async () => false,
			fallbackHolds: async (id) => (await records.api?.store.sandboxes.get(id))?.hostId === STUB_HOST_ID,
			holdsSnapshot: () => false,
		});
		const { api, tom } = setup(routed);
		records.api = api;

		// Its grants change while it is made: sent once it is placed, before its record says where, so it runs.
		const sandbox = await tom.createSandbox({});
		await tom.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "evil.example" }] });
		release();
		await api.service.idle();
		expect(await tom.getSandbox(sandbox.id)).toMatchObject({ state: "running" });
		expect((await tom.runCommand(sandbox.id, { command: "echo hi" })).stdout).toBe("hi\n");

		// One whose create failed is the fallback's no more than anyone's.
		failing = true;
		const lost = await tom.createSandbox({ wait: true });
		expect(lost.state).toBe("error");
		await expect(routed.exec(lost.id, { command: "true" })).rejects.toMatchObject({ message: NOT_HELD });
	});

	it("keeps an overdue sandbox whose host is away running, and auto-stops it once its host is back", async () => {
		let clock = 1_000_000;
		const stub = createStubBackend();
		let connected = true;
		let dropOnStop = false;
		let refuseStop = false;
		const stops: string[] = [];
		const away = () => new KantelError("unavailable", "Host host_stub is not connected");
		const backend: SandboxBackend = {
			...stub,
			async capabilities() {
				const known = await stub.capabilities();
				return { ...known, hosts: known.hosts.map((host) => ({ ...host, connected })) };
			},
			async stop(sandboxId, how) {
				// The connection drops with the stop pending, and the host is connected again (a new connection) by the
				// time the failure is handled: the stop never reached the machine.
				if (dropOnStop) {
					dropOnStop = false;
					throw new KantelError("unavailable", "The host disconnected: replaced by a newer connection");
				}
				if (refuseStop) throw new KantelError("conflict", "The host refused the stop");
				if (!connected) throw away();
				stops.push(sandboxId);
				return stub.stop(sandboxId, how);
			},
		};
		const api = createComputeApi({
			backend,
			now: () => clock,
			authenticatePerson: async (request) => PEOPLE[request.headers.get("authorization")?.slice(7) ?? ""],
			fetch: async () => new Response(null, { status: 204 }),
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const sandbox = await tom.createSandbox({ type: "microvm", autoStopMinutes: 1, wait: true });
		const sweep = async () => {
			await api.service.sweep();
			await api.service.idle();
		};
		clock += 2 * 60_000;

		// Away across its stop time: it isn't stopped, nor written off as `error`, but kept running, its time kept.
		connected = false;
		await sweep();
		expect(await tom.getSandbox(sandbox.id)).toMatchObject({ state: "running", stopsAt: sandbox.stopsAt });
		// Back, but its connection is lost (and replaced) as the stop goes out: the stop never got through, so it is
		// running as it was, though the host is connected again by then.
		[connected, dropOnStop] = [true, true];
		await sweep();
		const handedBack = await tom.getSandbox(sandbox.id);
		expect(handedBack).toMatchObject({ state: "running", stopsAt: sandbox.stopsAt });
		expect(handedBack.reason).toBeUndefined();
		expect(stops).toEqual([]);
		// The next sweep stops it.
		await sweep();
		expect(stops).toEqual([sandbox.id]);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");

		// A stop the host refuses outright is an error, as before, not retried on every sweep.
		const refused = await tom.createSandbox({ type: "microvm", autoStopMinutes: 1, wait: true });
		clock += 2 * 60_000;
		refuseStop = true;
		await sweep();
		expect((await tom.getSandbox(refused.id)).state).toBe("error");
	});

	it("keeps a fork that was made when a later one in its batch fails, rather than taking it for never made", async () => {
		const stub = createStubBackend();
		// Room for one more machine: as a host's backend does, it makes a batch's targets one by one, so the first is made
		// and the second refused.
		let room = 1;
		const backend: SandboxBackend = {
			...stub,
			async fork(source, targets) {
				const out = [];
				for (const target of targets) {
					if (room-- <= 0) throw new KantelError("unavailable", "The host is full");
					out.push(...(await stub.fork(source, [target])));
				}
				return out;
			},
		};
		const { tom } = setup(backend);
		for (const live of [false, true]) {
			room = 1;
			const source = await tom.createSandbox({ type: "microvm", wait: true });
			await tom.writeFile(source.id, { path: "/home/user/kept.txt", content: "kept" });
			if (!live) await tom.stopSandbox(source.id, { wait: true });
			const { items } = await tom.forkSandbox(source.id, { count: 2, wait: true });
			const [made, refused] = await Promise.all(items.map((fork) => tom.getSandbox(fork.id)));
			// The one made is running, its disk the source's; only the other failed.
			expect(made?.state).toBe("running");
			expect((await tom.readFile(made?.id ?? "", { path: "/home/user/kept.txt" })).content).toBe("kept");
			expect(refused?.state).toBe("error");
			// Stopped and started, the one made is its own machine again, never made anew or refused as never made.
			await tom.stopSandbox(made?.id ?? "", { wait: true });
			expect((await tom.startSandbox(made?.id ?? "", { wait: true })).state).toBe("running");
			expect((await tom.readFile(made?.id ?? "", { path: "/home/user/kept.txt" })).content).toBe("kept");
		}
	});

	it("won't rotate a key that may use the shared hosts for an admin who may not", async () => {
		const { tom, ann, client } = setup(createStubBackend(), { sharedHosts: async (userId) => userId === "usr_tom" });
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "admin" })).code ?? "" });
		const scopes = ["sandboxes:read", "sandboxes:write", "exec"] as const;
		const toms = await tom.createApiKey({ account: org.id, name: "tom's", scopes: [...scopes] });
		const anns = await ann.createApiKey({ account: org.id, name: "ann's", scopes: [...scopes] });

		// Ann, an admin of the account but kept off the shared hosts, can't take Tom's key; it still works, unchanged.
		const refused = await failure(ann.rotateApiKey(toms.key.id));
		expect(refused).toMatchObject({ code: "forbidden", message: SHARED_KEY_REFUSED });
		expect((await client(toms.secret).createSandbox({ wait: true })).state).toBe("running");
		// Her own she may rotate, and it stays off them; Tom may rotate either.
		const hers = await ann.rotateApiKey(anns.key.id);
		expect((await failure(client(hers.secret).createSandbox({ wait: true }))).code).toBe("unavailable");
		expect((await tom.rotateApiKey(anns.key.id)).key.id).toBe(anns.key.id);
		const his = await tom.rotateApiKey(toms.key.id);
		expect((await client(his.secret).createSandbox({ wait: true })).state).toBe("running");
	});

	it("checks again once a sandbox is placed, so a call queued while it starts can't reach a shared host", async () => {
		// The host's reply to the first create is held until `release`, so calls queue behind the placement.
		const stub = createStubBackend();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const backend: SandboxBackend = { ...stub, create: async (input) => held.then(() => stub.create(input)) };
		const { tom, ann } = setup(backend, { sharedHosts: async (userId) => userId === "usr_tom" });
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "member" })).code ?? "" });

		const starting = await tom.createSandbox({ account: org.id });
		expect(starting.state).toBe("starting");
		// Ann finds it while it has no host yet, and queues calls on it; so does Tom.
		expect((await ann.listSandboxes({ account: org.id })).items.map((item) => item.id)).toEqual([starting.id]);
		const annRuns = failure(ann.runCommand(starting.id, { command: "echo hi" }));
		const annWrites = failure(ann.writeFile(starting.id, { path: "/tmp/x", content: "x" }));
		const annStops = failure(ann.stopSandbox(starting.id, {}));
		const tomRuns = tom.runCommand(starting.id, { command: "echo hi" });
		// Long enough for each to be let in (no host yet) and wait on the placement; nothing here takes a millisecond.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await tom.getSandbox(starting.id)).state).toBe("starting");
		release();

		// Once it is on the shared host, hers are refused there and none of them reached it; Tom's ran.
		for (const refused of await Promise.all([annRuns, annWrites, annStops])) {
			expect(refused).toMatchObject({ code: "forbidden", message: SHARED_HOSTS_REFUSED });
		}
		expect((await tomRuns).stdout).toBe("hi\n");
		const after = await tom.getSandbox(starting.id);
		expect(after.state).toBe("running");
		await expect(tom.readFile(starting.id, { path: "/tmp/x" })).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("hosts", () => {
	it("needs hosts:admin", async () => {
		const { api, client, root, tom } = setup();
		expect((await failure(tom.listHosts())).code).toBe("forbidden");
		const plain = client((await root.createApiKey({ name: "plain", preset: "admin" })).secret);
		expect((await failure(plain.listHosts())).code).toBe("forbidden");

		const ops = client((await root.createApiKey({ name: "ops", scopes: ["hosts:admin"] })).secret);
		const hosts = await ops.listHosts();
		expect(hosts.items.map((host) => host.id)).toEqual([STUB_HOST_ID]);
		const token = await ops.createHostJoinToken({ name: "box" });
		expect(token.token).toMatch(/^kth_/);
		expect(token.command).toBe(
			`curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url http://compute.test --token ${token.token}`,
		);

		const drained = await ops.updateHost(STUB_HOST_ID, { draining: true });
		expect(drained.state).toBe("draining");
		expect((await failure(tom.createSandbox({}))).code).toBe("unavailable");

		expect(await api.fetch(new Request("http://compute.test/v1/sessions"))).toBeUndefined();
		expect(await api.fetch(new Request("http://compute.test/elsewhere"))).toBeUndefined();
	});

	it("sets the public URL join commands use, and goes back to the deployment's own", async () => {
		const { root, tom } = setup();
		const before = await root.getPublicUrl();
		expect(before).toEqual({
			publicUrl: "http://compute.test",
			source: "deployment",
			deploymentUrl: "http://compute.test",
			loopback: false,
		});
		expect((await failure(tom.getPublicUrl())).code).toBe("forbidden");
		expect((await failure(tom.setPublicUrl({ publicUrl: "https://kantel.example.com" }))).code).toBe("forbidden");

		const set = await root.setPublicUrl({ publicUrl: "https://kantel.example.com/" });
		expect(set).toEqual({
			publicUrl: "https://kantel.example.com",
			source: "console",
			deploymentUrl: "http://compute.test",
			loopback: false,
		});
		const token = await root.createHostJoinToken({});
		expect(token.command).toContain(`--url https://kantel.example.com --token ${token.token}`);

		for (const bad of ["kantel.example.com", "ftp://kantel.example.com", "https://kantel.example.com/console"]) {
			expect((await failure(root.setPublicUrl({ publicUrl: bad }))).code).toBe("invalid");
		}
		// A host the URL parser allows but a shell would run, when the join command is pasted.
		for (const bad of [
			"https://$(id).example.com",
			"https://`id`.example.com",
			"http://a;id.example.com",
			"http://a&b.com",
		]) {
			expect((await failure(root.setPublicUrl({ publicUrl: bad }))).code).toBe("invalid");
		}
		expect((await root.getPublicUrl()).publicUrl).toBe("https://kantel.example.com");
		const safe = await root.createHostJoinToken({});
		expect(safe.command).toContain(`--url https://kantel.example.com --token ${safe.token}`);

		expect(await root.setPublicUrl({ publicUrl: "http://127.0.0.1:58090" })).toMatchObject({ loopback: true });
		expect(await root.setPublicUrl({ publicUrl: null })).toEqual(before);
		expect((await root.createHostJoinToken({})).command).toContain("--url http://compute.test --token");
	});

	it("tells a loopback public URL from one other machines can reach", () => {
		for (const url of ["http://127.0.0.1:58090", "http://localhost:8080", "http://[::1]:58090", "http://0.0.0.0"]) {
			expect(isLoopbackUrl(url)).toBe(true);
		}
		for (const url of ["https://kantel.example.com", "http://10.0.0.5:58090", "http://kantel.tail1234.ts.net"]) {
			expect(isLoopbackUrl(url)).toBe(false);
		}
		expect(publicOrigin(" https://Kantel.Example.com/ ")).toBe("https://kantel.example.com");
		// DNS names, ports, IPv4 and IPv6, and an international name in its punycode form.
		expect(publicOrigin("http://10.0.0.5:58090")).toBe("http://10.0.0.5:58090");
		expect(publicOrigin("http://[fd00::5]:58090/")).toBe("http://[fd00::5]:58090");
		expect(publicOrigin("https://kantel.tail1234.ts.net:8443")).toBe("https://kantel.tail1234.ts.net:8443");
		expect(publicOrigin("https://bücher.example")).toBe("https://xn--bcher-kva.example");
		for (const bad of ["https://$(id).example.com", "https://a'b.example.com", "https://a!b.example.com"]) {
			expect(() => publicOrigin(bad)).toThrow("domain name or an IP address");
		}
	});

	it("says a revoked host's sandboxes can't be reached, and lets them be deleted", async () => {
		const { tom, root } = setup();
		const running = await tom.createSandbox({ wait: true });
		const stopped = await tom.createSandbox({ wait: true });
		await tom.stopSandbox(stopped.id, { wait: true });
		await root.revokeHost(STUB_HOST_ID);
		for (const id of [running.id, stopped.id]) {
			const after = await tom.getSandbox(id);
			expect(after).toMatchObject({ state: "error", reason: HOST_REVOKED_REASON });
		}
		const deleted = await tom.deleteSandbox(running.id);
		expect(deleted.state).toBe("deleted");
	});

	it("says which hosts are out of date, updates one, and shows it updating until it's back on the version", async () => {
		const stub = createStubBackend();
		let version = "0.4.1";
		const asked: string[] = [];
		const backend: SandboxBackend = {
			...stub,
			async capabilities() {
				const caps = await stub.capabilities();
				return {
					...caps,
					hosts: caps.hosts.map((host) => ({
						...host,
						version,
						latestVersion: "0.4.2",
						...(version === "0.4.2" ? {} : { updateAvailable: true }),
					})),
				};
			},
			async updateHostAgent(hostId) {
				asked.push(hostId);
				return { version: "0.4.2" };
			},
		};
		const { root, tom } = setup(backend);
		const listed = await root.listHosts();
		expect(listed.items[0]).toMatchObject({ version: "0.4.1", latestVersion: "0.4.2", updateAvailable: true });
		expect(listed.items[0]?.updating).toBeUndefined();
		// Only the deployment's super-admin updates its hosts.
		expect((await failure(tom.updateHostAgent(STUB_HOST_ID))).code).toBe("forbidden");

		const started = Date.now();
		const updating = await root.updateHostAgent(STUB_HOST_ID);
		expect(asked).toEqual([STUB_HOST_ID]);
		expect(updating.updating).toEqual({ version: "0.4.2", requestedAt: expect.any(Number) });
		expect((await root.getHost(STUB_HOST_ID)).updating?.version).toBe("0.4.2");
		// Ten minutes on without coming back on it, it isn't said to be updating any more.
		const clock = vi.spyOn(Date, "now").mockReturnValue(started + 11 * 60 * 1000);
		try {
			expect((await root.getHost(STUB_HOST_ID)).updating).toBeUndefined();
		} finally {
			clock.mockRestore();
		}
		await root.updateHostAgent(STUB_HOST_ID);
		// Back on the new version: no longer updating, nor out of date.
		version = "0.4.2";
		const back = await root.getHost(STUB_HOST_ID);
		expect(back).toMatchObject({ version: "0.4.2", latestVersion: "0.4.2" });
		expect(back.updating).toBeUndefined();
		expect(back.updateAvailable).toBeUndefined();
	});

	it("refuses an update where the backend doesn't update hosts", async () => {
		const { root } = setup();
		expect((await failure(root.updateHostAgent(STUB_HOST_ID))).code).toBe("not_supported");
		// A host the stub reports names no version to run, so it isn't said to be out of date.
		const [host] = (await root.listHosts()).items;
		expect(host?.latestVersion).toBeUndefined();
		expect(host?.updateAvailable).toBeUndefined();
	});

	it("doesn't run a first create on a host revoked while the host made it", async () => {
		const stub = createStubBackend();
		let revokeMeanwhile: (() => Promise<unknown>) | undefined;
		const { tom, root } = setup({
			...stub,
			// Where it is placed while it boots, as a host backend records it before asking the host.
			placedOn: async () => STUB_HOST_ID,
			// The host makes it, and before its record names the host, the host is revoked and its sandboxes scanned.
			async create(spec) {
				const placement = await stub.create(spec);
				await revokeMeanwhile?.();
				return placement;
			},
		});
		revokeMeanwhile = () => root.revokeHost(STUB_HOST_ID);
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox).toMatchObject({ state: "error", reason: HOST_REVOKED_REASON });
		expect((await tom.getSandbox(sandbox.id)).state).toBe("error");
	});

	it("fails a revocation whose sandbox write failed, and finishes it when it is made again", async () => {
		const store = createMemoryStore();
		const sandboxes = store.sandboxes;
		let failNext = false;
		const { tom, root } = setup(createStubBackend(), {
			store: {
				...store,
				sandboxes: {
					...sandboxes,
					async update(id, change, expected) {
						if (failNext) {
							failNext = false;
							throw new Error("The database is away");
						}
						return sandboxes.update(id, change, expected);
					},
				},
			},
		});
		const sandbox = await tom.createSandbox({ wait: true });
		failNext = true;
		await failure(root.revokeHost(STUB_HOST_ID));
		// Not claimed done: it still says what it was, and the host is revoked.
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
		expect((await root.listHosts()).items.find((host) => host.id === STUB_HOST_ID)?.state).toBe("revoked");
		await root.revokeHost(STUB_HOST_ID);
		expect(await tom.getSandbox(sandbox.id)).toMatchObject({ state: "error", reason: HOST_REVOKED_REASON });
	});

	it("runs a first create stranded for a revoked host its boot didn't end up on", async () => {
		const stub = createStubBackend();
		let revokeMeanwhile: (() => Promise<unknown>) | undefined;
		const { tom, root } = setup({
			...stub,
			// Its placement read as the revoked host (as a template restore's, before it booted fresh elsewhere).
			placedOn: async () => STUB_HOST_ID,
			async create(spec) {
				const placement = await stub.create(spec);
				await revokeMeanwhile?.();
				return { ...placement, hostId: "host_elsewhere" };
			},
		});
		revokeMeanwhile = () => root.revokeHost(STUB_HOST_ID);
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox.state).toBe("running");
		expect(sandbox.reason).toBeUndefined();
	});

	/**
	 * A stub whose first create is read as placed on `placedOn()` by a revocation, and ends on `endsOn`; with `reconcile`,
	 * its egress changes while it boots, and the revocation lands while that egress is being sent.
	 */
	function revokedMidBoot(options: { endsOn: string; reconcile?: boolean; alsoRevoke?: string; refuse?: boolean }) {
		const stub = createStubBackend();
		const store = createMemoryStore();
		const delivered: (number | undefined)[] = [];
		let placedNow = STUB_HOST_ID;
		let revoke: (hostId: string) => Promise<unknown> = async () => undefined;
		const revokeAll = async () => {
			await revoke(STUB_HOST_ID);
			if (options.alsoRevoke !== undefined) {
				placedNow = options.alsoRevoke;
				await revoke(options.alsoRevoke);
			}
		};
		const api = setup(
			{
				...stub,
				async capabilities() {
					const known = await stub.capabilities();
					const [only] = known.hosts;
					return only === undefined || options.alsoRevoke === undefined
						? known
						: { ...known, hosts: [...known.hosts, { ...only, id: options.alsoRevoke, name: options.alsoRevoke }] };
				},
				placedOn: async () => placedNow,
				async create(spec) {
					const placement = await stub.create(spec);
					if (options.reconcile === true) {
						// Its egress changes while it starts: its boot has it sent before it may run.
						await store.sandboxes.update(spec.sandboxId, (current) => ({
							...current,
							egressRevision: (current.egressRevision ?? 0) + 1,
						}));
					} else {
						await revokeAll();
					}
					return { ...placement, hostId: options.endsOn };
				},
				async updateEgress(_sandboxId, _egress, revision) {
					delivered.push(revision);
					// The revocation's scan lands while this egress is on its way.
					if (options.reconcile === true && delivered.length === 1) await revokeAll();
					// Its host then refuses the egress, which would have it stopped.
					if (options.refuse === true) throw new KantelError("not_supported", "This host can't enforce it");
				},
			},
			{ store },
		);
		revoke = (hostId) => api.root.revokeHost(hostId);
		return { ...api, store, delivered };
	}

	it("doesn't run a first create whose host is revoked while its egress is being reconciled", async () => {
		const { tom, delivered } = revokedMidBoot({ endsOn: STUB_HOST_ID, reconcile: true });
		const sandbox = await tom.createSandbox({ wait: true });
		expect(delivered.length).toBeGreaterThan(0);
		expect(sandbox).toMatchObject({ state: "error", reason: HOST_REVOKED_REASON });
	});

	it("runs, with its egress as it is now, a first create whose egress was reconciled on a host that wasn't revoked", async () => {
		const { tom, store, delivered } = revokedMidBoot({ endsOn: "host_elsewhere", reconcile: true });
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox.state).toBe("running");
		const stored = await store.sandboxes.get(sandbox.id);
		expect(delivered).toContain(stored?.egressRevision);
		expect(stored?.egressApplied).toBe(stored?.egressRevision);
	});

	it("ends a first create whose host is revoked before its egress is refused in error, not handed back from a stop", async () => {
		const { tom } = revokedMidBoot({ endsOn: STUB_HOST_ID, reconcile: true, refuse: true });
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox).toMatchObject({ state: "error", reason: HOST_REVOKED_REASON });
	});

	it("doesn't run a first create that moved to another host revoked too", async () => {
		const { tom } = revokedMidBoot({ endsOn: "host_elsewhere", alsoRevoke: "host_elsewhere" });
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox).toMatchObject({ state: "error", reason: HOST_REVOKED_REASON });
	});

	it("doesn't strand a boot whose record moved on after its placement was read", async () => {
		const stub = createStubBackend();
		const store = createMemoryStore();
		let revokeMeanwhile: (() => Promise<unknown>) | undefined;
		let moveOn: ((sandboxId: string) => Promise<unknown>) | undefined;
		const { tom, root } = setup(
			{
				...stub,
				// Read as the revoked host; then, before the scan writes, the sandbox moves on (a recovery, say).
				async placedOn(sandboxId) {
					await moveOn?.(sandboxId);
					return STUB_HOST_ID;
				},
				async create(spec) {
					const placement = await stub.create(spec);
					await revokeMeanwhile?.();
					return { ...placement, hostId: "host_elsewhere" };
				},
			},
			{ store },
		);
		moveOn = (sandboxId) =>
			store.sandboxes.update(sandboxId, (current) => ({ ...current, lifecycle: (current.lifecycle ?? 0) + 2 }));
		revokeMeanwhile = () => root.revokeHost(STUB_HOST_ID);
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox.state).toBe("running");
		const events = (await tom.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(events).not.toContain("sandbox.error");
	});

	it("keeps a revocation that lands while a drain is in flight", async () => {
		const stub = createStubBackend();
		let revokeMeanwhile: (() => Promise<unknown>) | undefined;
		const { client, root } = setup({
			...stub,
			// Between the drain reading the host and writing it, another call revokes it.
			async updateHost(hostId, change) {
				const revoke = revokeMeanwhile;
				revokeMeanwhile = undefined;
				await revoke?.();
				return stub.updateHost?.(hostId, change);
			},
		});
		const ops = client((await root.createApiKey({ name: "ops", scopes: ["hosts:admin"] })).secret);
		revokeMeanwhile = () => ops.revokeHost(STUB_HOST_ID);
		expect((await failure(ops.updateHost(STUB_HOST_ID, { draining: true }))).code).toBe("conflict");
		const listed = await ops.listHosts();
		expect(listed.items.find((host) => host.id === STUB_HOST_ID)?.state).toBe("revoked");
		// And the next capabilities refresh doesn't bring it back.
		expect((await ops.listHosts()).items.find((host) => host.id === STUB_HOST_ID)?.state).toBe("revoked");
	});
});

describe("people's names", () => {
	it("shows a person whose record has their user ID for a name by their email, without them signing in again", async () => {
		// Gateways once named everyone by their user ID, and wrote it back on every sign-in.
		const store = createMemoryStore();
		const legacy = "usr_4e473b3d-2b96-4bbf-9427-98be4e40ecff";
		const api = createComputeApi({
			backend: createStubBackend(),
			store,
			authenticatePerson: async (request) => {
				const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
				return token === undefined ? undefined : PEOPLE[token];
			},
			fetch: async () => new Response(null, { status: 204 }),
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		await store.accounts.put({
			id: "acc_alex",
			kind: "personal",
			name: legacy,
			defaultVisibility: "private",
			createdAt: 1,
		});
		await store.users.put({
			id: legacy,
			name: legacy,
			email: "alex@example.com",
			superAdmin: false,
			personalAccountId: "acc_alex",
			createdAt: 1,
		});
		await store.members.put({
			id: `${org.id}:${legacy}`,
			accountId: org.id,
			userId: legacy,
			role: "owner",
			joinedAt: 2,
		});
		await store.apiKeys.put({
			id: "key_alex",
			accountId: org.id,
			name: "alex's",
			prefix: "ksk_abcd",
			scopes: ["sandboxes:read"],
			createdBy: { kind: "user", id: legacy, name: legacy },
			createdAt: 3,
			secretHash: "0".repeat(64),
			ownerUserId: legacy,
		});

		const members = await tom.listMembers(org.id);
		expect(members.items.map((member) => [member.userId, member.name])).toEqual(
			expect.arrayContaining([
				["usr_tom", "Tom"],
				[legacy, "alex@example.com"],
			]),
		);
		const keys = await tom.listApiKeys({ account: org.id });
		expect(keys.items.find((key) => key.id === "key_alex")?.createdBy).toEqual({
			kind: "user",
			id: legacy,
			name: "alex@example.com",
		});
		expect((await tom.getApiKey("key_alex")).createdBy.name).toBe("alex@example.com");
		// What Tom makes says who he is, and so does what he made while his record said only his user ID.
		const sandbox = await tom.createSandbox({ account: org.id, wait: true });
		expect(sandbox.createdBy).toEqual({ kind: "user", id: "usr_tom", name: "Tom" });
		await store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			createdBy: { kind: "user", id: "usr_tom", name: "usr_tom" },
		}));
		expect((await tom.getSandbox(sandbox.id)).createdBy.name).toBe("Tom");
		const listed = await tom.listSandboxes({ account: org.id });
		expect(listed.items.find((item) => item.id === sandbox.id)?.createdBy.name).toBe("Tom");
	});

	it("names a personal account made with its person's user ID as they are now", async () => {
		const store = createMemoryStore();
		const api = createComputeApi({
			backend: createStubBackend(),
			store,
			authenticatePerson: async () => PEOPLE["ann-token"],
			fetch: async () => new Response(null, { status: 204 }),
		});
		opened.push(api);
		const ann = createKantelClient({
			baseUrl: BASE_URL,
			token: "ann-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const caller = await ann.getCaller();
		const personal = caller.accounts.find((account) => account.kind === "personal");
		if (personal === undefined) throw new Error("no personal account");
		await store.accounts.update(personal.id, (current) => ({ ...current, name: "usr_ann" }));
		expect((await ann.getCaller()).accounts.find((account) => account.id === personal.id)?.name).toBe("Ann");
		expect((await ann.getAccount(personal.id)).name).toBe("Ann");
	});
});
