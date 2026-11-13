import type { computeSchema } from "@kantel/api";
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PersonIdentity, personalAccountIdOf } from "../src/auth.ts";
import {
	type BackendCapabilities,
	type BackendDiskUsage,
	DetachedWaitEnded,
	type ExecRequest,
	type ExecResult,
	type SandboxBackend,
	type SandboxSpec,
	type SharedSnapshotBytes,
	type TakenSnapshot,
} from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { memoryOf, restoreAsked } from "../src/machine.ts";
import { createRoutedBackend, NOT_HELD } from "../src/routed-backend.ts";
import {
	AUTOMATIC_SNAPSHOT_TTL_MS,
	attributeSnapshotBytes,
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
	RETIRE_LEASE_MS,
	SAVE_ADMISSION_LEASE_MS,
	SHARED_HOSTS_REFUSED,
	SHARED_KEY_REFUSED,
	SNAPSHOT_EXPIRY_EVERY_MS,
	shapeFor,
} from "../src/service.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import {
	type ComputeStore,
	createMemoryStore,
	fenceClosedAccounts,
	joinTokenSpender,
	type StoredCommand,
} from "../src/store.ts";
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
		| "sharedHosts"
		| "invites"
		| "limits"
		| "startHoldMs"
		| "startPollMs"
		| "store"
		| "deletePerson"
		| "deploymentAdmin"
		| "accountHosts"
		| "wakeAt"
		| "now"
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

const MiB = 2 ** 20;

/** A snapshot's ref on its backend; fails the test when it has none. */
async function refOf(store: ComputeStore, snapshotId: string): Promise<string> {
	const ref = (await store.snapshots.get(snapshotId))?.ref;
	if (ref === undefined) throw new Error(`no ref for ${snapshotId}`);
	return ref;
}

/**
 * The stub, its keeps and live saves `next.bytes` big (and with `next.unique`, that much their own and the files
 * `next.shared` names shared), recording the refs it deletes and counting live saves. `oldHost`: no `snapshot.keep`,
 * so a save shares its source's bytes. `failing.deletes`: a delete fails, as with its host away. `gate`: a live save
 * waits for it.
 */
function sizedBackend(options: { oldHost?: boolean } = {}) {
	const stub = createStubBackend();
	const next: { bytes: number; unique?: number; shared: (ref: string) => SharedSnapshotBytes[] } = {
		bytes: 0,
		shared: () => [],
	};
	const released: string[] = [];
	const failing = { deletes: false };
	const takes = { count: 0, gate: undefined as Promise<void> | undefined };
	// What the host says each snapshot takes in full now (`snapshotSizes`), or that it can't answer.
	const measured = { sizes: undefined as Map<string, number> | undefined, offline: false };
	const sized = (taken: TakenSnapshot): TakenSnapshot => ({
		...taken,
		sizeBytes: next.bytes,
		...(next.unique === undefined ? {} : { uniqueBytes: next.unique, shared: next.shared(taken.ref) }),
	});
	const { keepSnapshot, ...withoutKeep } = stub;
	const backend: SandboxBackend = {
		...withoutKeep,
		...(options.oldHost === true || keepSnapshot === undefined
			? {}
			: { keepSnapshot: async (ref: string) => sized((await keepSnapshot(ref)) ?? { ref, sizeBytes: 0 }) }),
		takeSnapshot: async (sandboxId, taking) => {
			takes.count += 1;
			const taken = sized(await stub.takeSnapshot(sandboxId, taking));
			await takes.gate;
			return taken;
		},
		snapshotSizes: async () => {
			if (measured.offline) throw new KantelError("unavailable", "The host is away");
			return measured.sizes;
		},
		deleteSnapshot: async (ref) => {
			if (failing.deletes) throw new KantelError("unavailable", "The host is away");
			released.push(ref);
			await stub.deleteSnapshot(ref);
		},
	};
	return { backend, next, released, failing, takes, measured };
}

/**
 * A save of a stopped sandbox as an older control plane stored it: its pause's bytes (the pause's ref, shared), said to
 * hold no memory. Saves now keep their own ref (`keepSnapshot`), so the records sharing one are older ones.
 */
async function asOlderSave(store: ReturnType<typeof createMemoryStore>, savedId: string): Promise<void> {
	const stored = await store.snapshots.get(savedId);
	if (stored?.sandboxId === undefined) throw new Error("no saved snapshot");
	const sandbox = await store.sandboxes.get(stored.sandboxId);
	const pause =
		sandbox?.latestSnapshotId === undefined ? undefined : await store.snapshots.get(sandbox.latestSnapshotId);
	if (pause?.ref === undefined) throw new Error("no pause");
	await store.snapshots.put({ ...stored, ref: pause.ref, memory: false });
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
		// An isolate keeps only /workspace, so its commands start there, and relative paths are from there.
		expect(command.cwd).toBe("/workspace");
		expect((await tom.runCommand(sandbox.id, { command: "pwd; echo $HOME" })).stdout).toBe("/workspace\n/workspace\n");
		expect((await tom.runCommand(sandbox.id, { command: "pwd", cwd: "notes" })).cwd).toBe("/workspace/notes");

		const read = await tom.readFile(sandbox.id, { path: "f.txt" });
		expect(read).toMatchObject({ path: "/workspace/f.txt", encoding: "utf8", content: "hello\n", size: 6 });

		const written = await tom.writeFile(sandbox.id, { path: "notes/todo.md", content: "# To do" });
		expect(written).toMatchObject({ path: "/workspace/notes/todo.md", kind: "file", size: 7 });
		const listing = await tom.listFiles(sandbox.id, { path: "notes" });
		expect(listing.items.map((entry) => entry.name)).toEqual(["todo.md"]);
		const encoded = await tom.readFile(sandbox.id, { path: "/workspace/notes/todo.md", encoding: "base64" });
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

	it("lists a running microVM's busiest processes from its backend, and says when they can't be listed", async () => {
		const stub = createStubBackend();
		const asked: { id: string; limit: number }[] = [];
		const backend: SandboxBackend = {
			...stub,
			processes: async (id, limit) => {
				asked.push({ id, limit });
				return {
					processes: [
						{ pid: 812, command: "yes", cpuPercent: 99.5, memoryBytes: 1_048_576 },
						{ pid: 1, command: "/sbin/init", cpuPercent: 0, memoryBytes: 8_388_608 },
					],
					total: 37,
				};
			},
		};
		const { tom, client } = setup(backend);
		const vm = await tom.createSandbox({ type: "microvm", wait: true });
		expect(await tom.listSandboxProcesses(vm.id)).toEqual({
			items: [
				{ pid: 812, command: "yes", cpuPercent: 99.5, memoryBytes: 1_048_576 },
				{ pid: 1, command: "/sbin/init", cpuPercent: 0, memoryBytes: 8_388_608 },
			],
			total: 37,
		});
		await tom.listSandboxProcesses(vm.id, { limit: 3 });
		expect(asked).toEqual([
			{ id: vm.id, limit: 10 },
			{ id: vm.id, limit: 3 },
		]);
		expect((await failure(tom.listSandboxProcesses(vm.id, { limit: 51 }))).code).toBe("invalid");

		// Command lines are what `ps` shows: a key needs `exec`, as running it would.
		const reader = client((await tom.createApiKey({ name: "reader", preset: "read-only" })).secret);
		expect((await failure(reader.listSandboxProcesses(vm.id))).code).toBe("forbidden");
		const runner = client((await tom.createApiKey({ name: "runner", scopes: ["sandboxes:read", "exec"] })).secret);
		expect((await runner.listSandboxProcesses(vm.id)).total).toBe(37);

		// An isolate's aren't listed, and nor are any where the backend can't list them.
		const isolate = await tom.createSandbox({ type: "isolate", wait: true });
		const refused = await failure(tom.listSandboxProcesses(isolate.id));
		expect(refused.code).toBe("not_supported");
		expect(refused.message).toContain("isolate");
		const plain = setup(stub).tom;
		const elsewhere = await plain.createSandbox({ type: "microvm", wait: true });
		expect((await failure(plain.listSandboxProcesses(elsewhere.id))).code).toBe("not_supported");

		// A stopped one has none to list.
		await tom.stopSandbox(vm.id, { wait: true });
		expect((await failure(tom.listSandboxProcesses(vm.id))).details).toMatchObject({ code: "sandbox_stopped" });
		expect(asked).toHaveLength(3);
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
		// Who saved it, as the list answers it too.
		expect(saved.createdBy).toMatchObject({ kind: "user", id: "usr_tom" });
		expect((await tom.listSnapshots({ kind: "saved" })).items[0]?.createdBy).toEqual(saved.createdBy);
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
		// Its backend is asked for the snapshot's own vCPUs and memory, and the disk it copies, which its host makes as the
		// snapshot's size.
		const restore = create.mock.calls.find(([spec]) => spec.sandboxId === plain.id)?.[0];
		expect(restore?.shape).toEqual(
			paused?.resources && {
				vcpus: paused.resources.vcpus,
				memoryMb: paused.resources.memoryMb,
				diskGb: paused.resources.diskGb,
			},
		);
	});

	it("keeps a stopped sandbox's save, and a history entry's, under refs of their own", async () => {
		const store = createMemoryStore();
		const backend = createStubBackend();
		const keep = vi.spyOn(backend, "keepSnapshot");
		const take = vi.spyOn(backend, "takeSnapshot");
		const drop = vi.spyOn(backend, "deleteSnapshot");
		const { tom } = setup(backend, { store });
		const vm = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.writeFile(vm.id, { path: "app.txt", content: "v1" });
		const first = await tom.stopSandbox(vm.id, { wait: true });
		const refOf = async (id: string | undefined) => (await store.snapshots.get(id ?? ""))?.ref;
		const firstRef = await refOf(first.latestSnapshotId);

		// The stopped sandbox's newest snapshot, kept: the save's ref is the kept one, not the stop's.
		const stopped = await tom.saveSnapshot({ name: "stopped", sandboxId: vm.id });
		expect(keep).toHaveBeenCalledTimes(1);
		expect(keep).toHaveBeenLastCalledWith(firstRef);
		const stoppedRef = await refOf(stopped.id);
		expect(stoppedRef).toBe((await keep.mock.results[0]?.value)?.ref);
		expect(stoppedRef).not.toBe(firstRef);
		expect(take).not.toHaveBeenCalled();
		// The stop's entry stays in the history, automatic, on its own ref.
		expect(await store.snapshots.get(first.latestSnapshotId ?? "")).toMatchObject({ kind: "automatic", ref: firstRef });

		// A later run, and a save of the first stop from the history: kept from that entry's ref.
		await tom.resumeSandbox(vm.id, { wait: true });
		await tom.writeFile(vm.id, { path: "app.txt", content: "v2" });
		await tom.stopSandbox(vm.id, { wait: true });
		const history = await tom.saveSnapshot({ name: "history", sandboxId: vm.id, snapshotId: first.latestSnapshotId });
		expect(keep).toHaveBeenLastCalledWith(firstRef);
		const historyRef = await refOf(history.id);
		expect(new Set([firstRef, stoppedRef, historyRef]).size).toBe(3);

		// Deleting the history entry lets its bytes go, and each save keeps its own.
		await tom.deleteSnapshot(first.latestSnapshotId ?? "");
		expect(drop).toHaveBeenLastCalledWith(firstRef);
		for (const saved of [stopped, history]) {
			expect((await tom.readSnapshotFile(saved.id, { path: "app.txt" })).content).toBe("v1");
		}
		// Replacing a save lets its own bytes go, never the history's it was kept from.
		const latestRef = await refOf((await tom.getSandbox(vm.id)).latestSnapshotId);
		const replaced = await tom.saveSnapshot({ name: "history", sandboxId: vm.id, replace: true });
		expect(drop).toHaveBeenLastCalledWith(historyRef);
		expect(drop).not.toHaveBeenCalledWith(latestRef);
		// Deleting the sandbox lets its automatic snapshots' bytes go; the saves' are their own.
		await tom.deleteSandbox(vm.id);
		expect(drop).toHaveBeenLastCalledWith(latestRef);
		expect(drop).not.toHaveBeenCalledWith(stoppedRef);
		expect((await tom.readSnapshotFile(stopped.id, { path: "app.txt" })).content).toBe("v1");
		expect((await tom.readSnapshotFile(replaced.id, { path: "app.txt" })).content).toBe("v2");
	});

	it("keeps a snapshot's labels, and when the state it holds was taken beside when it was saved", async () => {
		let clock = Date.UTC(2026, 10, 6, 9);
		const { tom } = setup(createStubBackend(), { now: () => clock });
		const vm = await tom.createSandbox({ type: "microvm", wait: true });
		const taken = await tom.takeSnapshot(vm.id, { labels: { "git.base": "aaa" } });
		expect(taken).toMatchObject({ labels: { "git.base": "aaa" }, createdAt: clock, takenAt: clock });

		// Saved from the running sandbox: its state is the save's.
		clock += 60_000;
		const live = await tom.saveSnapshot({ name: "live", sandboxId: vm.id, labels: { "git.base": "bbb" } });
		expect(live).toMatchObject({ labels: { "git.base": "bbb" }, createdAt: clock, takenAt: clock });

		// Saved an hour after the sandbox stopped: its state is the stop's, which the save's own time would hide.
		clock += 60_000;
		const stopped = await tom.stopSandbox(vm.id, { wait: true });
		const stoppedAt = (await tom.getSnapshot(stopped.latestSnapshotId ?? "")).createdAt;
		clock += 3_600_000;
		const later = await tom.saveSnapshot({ name: "later", sandboxId: vm.id });
		expect(later.createdAt).toBe(clock);
		expect(later.takenAt).toBe(stoppedAt);
		expect(later.labels).toBeUndefined();
		// One of its history: that entry's time.
		const history = await tom.saveSnapshot({ name: "history", sandboxId: vm.id, snapshotId: taken.id });
		expect(history.takenAt).toBe(taken.createdAt);

		// Read back, one at a time and in the list.
		expect(await tom.getSnapshot(live.id)).toMatchObject({ labels: { "git.base": "bbb" }, takenAt: live.createdAt });
		const listed = (await tom.listSnapshots({ kind: "saved" })).items;
		expect(listed.find((snapshot) => snapshot.id === later.id)?.takenAt).toBe(stoppedAt);

		// Labels are bounded, as a description is.
		const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
		expect((await failure(tom.saveSnapshot({ name: "many", sandboxId: vm.id, labels: many }))).code).toBe("invalid");
		const long = { "git.base": "x".repeat(501) };
		expect((await failure(tom.takeSnapshot(vm.id, { labels: long }))).code).toBe("invalid");
	});

	it("records a kept save's memory as its backend says, and stores none it couldn't keep", async () => {
		const stub = createStubBackend();
		let answer: "pruned" | "refused" = "pruned";
		const backend: SandboxBackend = {
			...stub,
			async keepSnapshot(ref) {
				if (answer === "refused") throw new KantelError("not_supported", "This snapshot's host is too old");
				// A host whose source has lost its memory to pruning.
				const kept = await stub.keepSnapshot?.(ref);
				return kept && { ...kept, memory: false };
			},
		};
		const { tom } = setup(backend);
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const [pause] = (await tom.listSnapshots({ sandboxId: vm.id })).items;
		expect(pause?.memory).toBe(true);
		expect((await tom.saveSnapshot({ name: "pruned", sandboxId: vm.id })).memory).toBe(false);
		answer = "refused";
		expect((await failure(tom.saveSnapshot({ name: "refused", sandboxId: vm.id }))).code).toBe("not_supported");
		expect((await tom.listSnapshots({ kind: "saved" })).items.map((item) => item.name)).toEqual(["pruned"]);
	});

	it("shares its source's ref where the backend never drops a snapshot's bytes on its own", async () => {
		const store = createMemoryStore();
		const { keepSnapshot: _none, ...stub } = createStubBackend();
		const { tom } = setup(stub, { store });
		const vm = await tom.createSandbox({ type: "microvm", wait: true });
		const stopped = await tom.stopSandbox(vm.id, { wait: true });
		const saved = await tom.saveSnapshot({ name: "shared", sandboxId: vm.id });
		expect((await store.snapshots.get(saved.id))?.ref).toBe(
			(await store.snapshots.get(stopped.latestSnapshotId ?? ""))?.ref,
		);
	});

	it("saves a running sandbox's disk only, unless memory is asked for", async () => {
		const backend = createStubBackend();
		const take = vi.spyOn(backend, "takeSnapshot");
		const { tom } = setup(backend);
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.saveSnapshot({ name: "disk-only", sandboxId: vm.id });
		await tom.saveSnapshot({ name: "with-memory", sandboxId: vm.id, memory: true });
		await tom.takeSnapshot(vm.id, {});
		await tom.takeSnapshot(vm.id, { memory: true });
		expect(take.mock.calls.map(([, options]) => options)).toEqual([
			{ memory: false },
			{ memory: true },
			{ memory: false },
			{ memory: true },
		]);
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
		await asOlderSave(store, saved.id);
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

	it("keeps snapshots' sizes as their host measures them now, for every record of the same bytes", async () => {
		const store = createMemoryStore();
		const { api, tom } = setup(createStubBackend(), { store });
		const vm = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const taken = await tom.takeSnapshot(vm.id, {});
		const saved = await tom.saveSnapshot({ name: "golden", sandboxId: vm.id, snapshotId: taken.id });
		const other = await tom.takeSnapshot(vm.id, {});
		// As a host's snapshots are named: `<hostId>/<id>`, the save sharing its source's.
		const ref = `${STUB_HOST_ID}/snap-1`;
		for (const id of [taken.id, saved.id]) {
			await store.snapshots.update(id, (current) => ({ ...current, ref, sizeBytes: 9_999 }));
		}
		// Another host can't say what this one's snapshots take.
		await api.service.recordSnapshotSizes("host_other", [{ ref, sizeBytes: 1 }]);
		expect((await tom.getSnapshot(saved.id)).sizeBytes).toBe(9_999);
		await api.service.recordSnapshotSizes(STUB_HOST_ID, [
			{ ref, sizeBytes: 4_096 },
			{ ref: `${STUB_HOST_ID}/snap-gone`, sizeBytes: 7 },
		]);
		expect((await tom.getSnapshot(taken.id)).sizeBytes).toBe(4_096);
		expect((await tom.getSnapshot(saved.id)).sizeBytes).toBe(4_096);
		expect((await tom.getSnapshot(other.id)).sizeBytes).toBe(other.sizeBytes);
	});

	it("counts each shared file once, for a saved record before an automatic one, then the one recorded first", () => {
		const records = [
			{ ref: "h/auto", kind: "automatic" as const, createdAt: 1, state: "ready" as const },
			{ ref: "h/kept", kind: "saved" as const, createdAt: 2, state: "ready" as const },
			// A manual take: saved on its host, automatic here.
			{ ref: "h/manual", kind: "automatic" as const, createdAt: 3, state: "ready" as const },
			{ ref: "h/older", kind: "automatic" as const, createdAt: 0, state: "ready" as const },
		];
		const unique = new Map([
			["h/auto", 10],
			["h/kept", 4],
			["h/manual", 6],
			["h/older", 1],
		]);
		const sizes = attributeSnapshotBytes(records, unique, [
			{ refs: ["h/auto", "h/kept"], bytes: 100 },
			{ refs: ["h/manual", "h/older"], bytes: 50 },
			// Held by nothing recorded: counted for none.
			{ refs: ["h/gone", "h/lost"], bytes: 7 },
		]);
		expect(Object.fromEntries(sizes)).toEqual({ "h/auto": 10, "h/kept": 104, "h/manual": 6, "h/older": 51 });
	});

	it("records a kept copy's size as the next refresh counts it", async () => {
		const store = createMemoryStore();
		const stub = createStubBackend();
		const source = `${STUB_HOST_ID}/snap-auto`;
		const kept = `${STUB_HOST_ID}/snap-kept`;
		// A host that keeps by linking: the copy's 100 bytes of disk are its source's file.
		const backend: SandboxBackend = {
			...stub,
			keepSnapshot: async () => ({
				ref: kept,
				sizeBytes: 104,
				uniqueBytes: 4,
				shared: [{ refs: [source, kept], bytes: 100 }],
			}),
		};
		const { api, tom } = setup(backend, { store });
		const vm = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const taken = await tom.takeSnapshot(vm.id, {});
		await store.snapshots.update(taken.id, (current) => ({ ...current, ref: source }));
		const saved = await tom.saveSnapshot({ name: "golden", sandboxId: vm.id, snapshotId: taken.id });
		expect(saved.sizeBytes).toBe(104);
		await api.service.recordSnapshotSizes(
			STUB_HOST_ID,
			[
				{ ref: source, sizeBytes: 110, uniqueBytes: 10 },
				{ ref: kept, sizeBytes: 104, uniqueBytes: 4 },
			],
			[{ refs: [source, kept], bytes: 100 }],
		);
		expect((await tom.getSnapshot(saved.id)).sizeBytes).toBe(104);
		// Its source, automatic, is left what is its own.
		expect((await tom.getSnapshot(taken.id)).sizeBytes).toBe(10);
		// Each keeps its full size too, shared files included, which a host's limit on saved bytes counts.
		expect((await store.snapshots.get(saved.id))?.fullSizeBytes).toBe(104);
		expect((await store.snapshots.get(taken.id))?.fullSizeBytes).toBe(110);

		// A host with isolates too: their snapshots say nothing of what is their own, and keep their reported size, while
		// the microVM ones are still counted by their shared files.
		const isolate = await tom.createSandbox({ type: "isolate", autoStopMinutes: null, wait: true });
		const iso = await tom.takeSnapshot(isolate.id, {});
		const isoRef = `${STUB_HOST_ID}/snap-isolate`;
		await store.snapshots.update(iso.id, (current) => ({ ...current, ref: isoRef }));
		await api.service.recordSnapshotSizes(
			STUB_HOST_ID,
			[
				{ ref: source, sizeBytes: 110, uniqueBytes: 10 },
				{ ref: kept, sizeBytes: 104, uniqueBytes: 4 },
				{ ref: isoRef, sizeBytes: 77 },
			],
			[{ refs: [source, kept], bytes: 100 }],
		);
		expect((await tom.getSnapshot(saved.id)).sizeBytes).toBe(104);
		expect((await tom.getSnapshot(taken.id)).sizeBytes).toBe(10);
		expect((await tom.getSnapshot(iso.id)).sizeBytes).toBe(77);
	});

	it("records a replacement's size without the save it replaces, which shares its files", async () => {
		const store = createMemoryStore();
		const stub = createStubBackend();
		const source = `${STUB_HOST_ID}/snap-auto`;
		let keeps = 0;
		// Each keep links the source's 100 bytes of disk: every kept copy shares them with it, and with each other.
		const backend: SandboxBackend = {
			...stub,
			keepSnapshot: async () => {
				keeps += 1;
				const refs = [source, ...Array.from({ length: keeps }, (_, at) => `${STUB_HOST_ID}/snap-kept-${at + 1}`)];
				return {
					ref: `${STUB_HOST_ID}/snap-kept-${keeps}`,
					sizeBytes: 104,
					uniqueBytes: 4,
					shared: [{ refs, bytes: 100 }],
				};
			},
		};
		const { tom } = setup(backend, { store });
		const vm = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const taken = await tom.takeSnapshot(vm.id, {});
		await store.snapshots.update(taken.id, (current) => ({ ...current, ref: source }));
		const first = await tom.saveSnapshot({ name: "golden", sandboxId: vm.id, snapshotId: taken.id });
		expect(first.sizeBytes).toBe(104);
		// The replacement keeps the shared files once the first goes: they are its.
		const replaced = await tom.saveSnapshot({ name: "golden", sandboxId: vm.id, snapshotId: taken.id, replace: true });
		expect(replaced.sizeBytes).toBe(104);
	});

	it("counts the sandboxes made or forked from a snapshot as its uses, deleted ones included", async () => {
		const { tom } = setup();
		const vm = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const saved = await tom.saveSnapshot({ name: "golden", sandboxId: vm.id });
		expect(saved.uses).toBe(0);
		const first = await tom.createSandbox({ from: "golden", wait: true });
		await tom.createSandbox({ from: "golden", wait: true });
		await tom.deleteSandbox(first.id);
		const listed = (await tom.listSnapshots({ kind: "saved" })).items.find((item) => item.id === saved.id);
		expect(listed?.uses).toBe(2);
		expect((await tom.getSnapshot(saved.id)).uses).toBe(2);
		const taken = await tom.takeSnapshot(vm.id, {});
		await tom.forkSandbox(vm.id, { snapshotId: taken.id, wait: true });
		expect((await tom.getSnapshot(taken.id)).uses).toBe(1);
	});

	it("keeps an older save holding memory once the pause it shares bytes with is deleted", async () => {
		const store = createMemoryStore();
		const { tom } = setup(createStubBackend(), { store });
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		const [pause] = (await tom.listSnapshots({ sandboxId: vm.id })).items;
		const saved = await tom.saveSnapshot({ name: "old-save", sandboxId: vm.id });
		if (pause === undefined) throw new Error("no pause");
		await asOlderSave(store, saved.id);
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
		await asOlderSave(store, saved.id);
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
		const harness = setup(backend);
		const { tom } = harness;
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
					expect.objectContaining({
						public: isPublic,
						subdomain: fork.subdomain,
						grantee: expect.any(String),
						ifAbsent: true,
					}),
				);
			}
		}
		// The source keeps its own.
		expect((await tom.listPorts(source.id)).items).toEqual(before);

		// A key that may fork but not open ports (no `access`) still forks, and its forks get no ports: copied under it,
		// they would refuse everyone. One with `access` gets them.
		const { client } = harness;
		const lifecycle = client(
			(await tom.createApiKey({ name: "lifecycle", scopes: ["sandboxes:read", "sandboxes:write"] })).secret,
		);
		const [bare] = (await lifecycle.forkSandbox(source.id, { wait: true })).items;
		expect(bare?.state).toBe("running");
		expect((await tom.listPorts(bare?.id ?? "")).items).toEqual([]);
		const opener = client(
			(await tom.createApiKey({ name: "opener", scopes: ["sandboxes:read", "sandboxes:write", "access"] })).secret,
		);
		const [opened] = (await opener.forkSandbox(source.id, { wait: true })).items;
		expect((await tom.listPorts(opened?.id ?? "")).items.map((port) => port.port).sort()).toEqual([3000, 8080]);

		// A stopped sandbox has no exposed ports (they end when it stops), so a fork of one has none either.
		await tom.stopSandbox(source.id, { wait: true });
		const [fromStopped] = (await tom.forkSandbox(source.id, { wait: true })).items;
		expect((await tom.listPorts(fromStopped?.id ?? "")).items).toEqual([]);
	});

	it("keeps a port exposed on a fork by hand while its source's ports are copied, whichever lands first", async () => {
		const stub = createStubBackend();
		const store = createMemoryStore();
		// Two control planes over the same records and machines, as replicas are: a call on one doesn't wait for work queued
		// on the other. On the second, someone exposes the fork's 3000 gated by hand around the first's copy of it (public):
		// before its exposure (the copy is then refused) or after it (theirs replaces the copy, and its record stands).
		let order: "before" | "after" = "before";
		let byHand: ((sandboxId: string) => Promise<void>) | undefined;
		const backend: SandboxBackend = {
			...stub,
			exposePort: async (sandboxId, port, how) => {
				const race = how.ifAbsent === true && port === 3000 ? byHand : undefined;
				if (race !== undefined && order === "before") await race(sandboxId);
				const made = await stub.exposePort(sandboxId, port, how);
				if (race !== undefined && order === "after") await race(sandboxId);
				return made;
			},
		};
		const { tom } = setup(backend, { store });
		const other = setup(stub, { store }).tom;
		const source = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.exposePort(source.id, { port: 3000, public: true });
		for (const each of ["before", "after"] as const) {
			order = each;
			let manual: { readonly port: number; readonly public: boolean; readonly createdAt: number } | undefined;
			byHand = async (sandboxId) => {
				manual = await other.exposePort(sandboxId, { port: 3000 });
			};
			const [fork] = (await tom.forkSandbox(source.id, { wait: true })).items;
			byHand = undefined;
			expect(manual).toMatchObject({ port: 3000, public: false });
			// The fork's record keeps the port as exposed by hand, gated (the relay's own store keeps its gate and token alike:
			// @kantel/hosts' ports tests).
			const ports = (await tom.listPorts(fork?.id ?? "")).items;
			expect(ports).toEqual([expect.objectContaining({ port: 3000, public: false, createdAt: manual?.createdAt })]);
		}
	});

	it("boots every fork in a batch when recording one's copied port fails", async () => {
		const memory = createMemoryStore();
		let failNext = false;
		const store: typeof memory = {
			...memory,
			sandboxes: {
				...memory.sandboxes,
				// The store fails the first write that adds a port once armed: the first fork's copied port.
				update: (id, change) =>
					memory.sandboxes.update(id, (current) => {
						const next = change(current);
						if (failNext && next !== undefined && next.ports.length > current.ports.length) {
							failNext = false;
							throw new Error("database down");
						}
						return next;
					}),
			},
		};
		const { tom } = setup(createStubBackend(), { store });
		const source = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.exposePort(source.id, { port: 3000, public: true });
		failNext = true;
		const forks = (await tom.forkSandbox(source.id, { count: 2, wait: true })).items;
		expect(failNext).toBe(false);
		expect(forks.map((fork) => fork.state)).toEqual(["running", "running"]);
		const ports = await Promise.all(forks.map(async (fork) => (await tom.listPorts(fork.id)).items.length));
		expect(ports).toEqual([0, 1]);
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

	it("refuses a sandbox with less memory than its saved snapshot's least, and keeps the least through a replace", async () => {
		const { tom } = setup();
		const vm = await tom.createSandbox({ type: "microvm", size: "large", wait: true });
		const saved = await tom.saveSnapshot({ name: "monorepo-checks", sandboxId: vm.id, minMemoryMb: 16_384 });
		expect(saved.minMemoryMb).toBe(16_384);
		expect((await tom.getSnapshot(saved.id)).minMemoryMb).toBe(16_384);

		const before = (await tom.listSandboxes({ all: true })).items.length;
		// Its own machine (large, 8 GB), another size and a smaller shape: each refused before anything is made.
		for (const body of [{}, { size: "small" as const }, { resources: { vcpus: 8, memoryMb: 8192 } }]) {
			const refused = await failure(tom.createSandbox({ from: saved.id, ...body }));
			expect(refused.code).toBe("invalid");
			expect(refused.message).toContain("needs at least 16 GB of memory (16384 MB)");
		}
		expect((await tom.listSandboxes({ all: true })).items.length).toBe(before);

		const enough = await tom.createSandbox({ from: saved.id, resources: { vcpus: 8, memoryMb: 16_384 }, wait: true });
		expect(enough.resources).toMatchObject({ vcpus: 8, memoryMb: 16_384 });

		// A replace keeps it unless it says otherwise; 0 is none.
		const replaced = await tom.saveSnapshot({ name: "monorepo-checks", sandboxId: vm.id, replace: true });
		expect(replaced.minMemoryMb).toBe(16_384);
		const cleared = await tom.saveSnapshot({
			name: "monorepo-checks",
			sandboxId: vm.id,
			replace: true,
			minMemoryMb: 0,
		});
		expect(cleared.minMemoryMb).toBeUndefined();
		const any = await tom.createSandbox({ from: cleared.id, wait: true });
		expect(any.state).toBe("running");

		const isolate = await tom.createSandbox({ type: "isolate", wait: true });
		const wrongType = await failure(tom.saveSnapshot({ name: "iso", sandboxId: isolate.id, minMemoryMb: 1024 }));
		expect(wrongType.code).toBe("invalid");

		// Its source sandbox deleted: still checked, on the host that holds it.
		const kept = await tom.saveSnapshot({ name: "kept", sandboxId: vm.id, minMemoryMb: 16_384 });
		await tom.deleteSandbox(vm.id);
		for (const body of [{}, { size: "large" as const }]) {
			expect((await failure(tom.createSandbox({ from: kept.id, ...body }))).message).toContain("needs at least 16 GB");
		}
	});

	it("knows a size's memory only where the hosts it may go to agree on it", () => {
		const large = (memoryMb: number) => ({ name: "large" as const, vcpus: 4, memoryMb, diskGb: 40 });
		expect(memoryOf({ size: "large" }, [large(8192)])).toBe(8192);
		expect(memoryOf({ size: "large" }, [large(8192), large(8192)])).toBe(8192);
		expect(memoryOf({ size: "large" }, [large(16_384), large(8192)])).toBeUndefined();
		expect(memoryOf({ size: "large", shape: { vcpus: 8, memoryMb: 16_384 } }, [large(8192)])).toBe(16_384);
		// Its copied machine's, where it is that one.
		const copies = { size: "large" as const, resources: { vcpus: 4, memoryMb: 12_288, diskGb: 40 } };
		expect(memoryOf({ size: "large" }, [large(8192)], copies)).toBe(12_288);
		expect(memoryOf(undefined, [large(8192)])).toBeUndefined();
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

	it("makes a microVM with the disk it asks for, apart from its vCPUs and memory, and keeps it through fork and start", async () => {
		const { tom } = setup();
		const shapes = await tom.getSandboxShapes();
		// From the least the hosts give (the smallest preset's) to the most, the default preset's by default.
		expect(shapes.microvm?.diskGb).toEqual({ min: 10, max: 1024, step: 1, default: 20 });

		const custom = await tom.createSandbox({
			type: "microvm",
			resources: { vcpus: 2, memoryMb: 4096, diskGb: 64 },
			wait: true,
		});
		// Named by the preset its vCPUs and memory are, whatever its disk.
		expect(custom.size).toBe("default");
		expect(custom.resources).toEqual({ vcpus: 2, memoryMb: 4096, diskGb: 64 });
		// Disk isn't priced.
		expect(custom.cost.ratePerHour).toBe(hourlyRate(PLACEHOLDER_RATES, "microvm", { vcpus: 2, memoryMb: 4096 }));

		// A disk alone goes to the default size's vCPUs and memory, or a named size's.
		const alone = await tom.createSandbox({ type: "microvm", resources: { diskGb: 100 }, wait: true });
		expect(alone.resources).toEqual({ vcpus: 2, memoryMb: 4096, diskGb: 100 });
		const sized = await tom.createSandbox({ type: "microvm", size: "large", resources: { diskGb: 120 }, wait: true });
		expect(sized.resources).toEqual({ vcpus: 4, memoryMb: 8192, diskGb: 120 });

		// A fork, from a snapshot or live, has its source's disk; so does a start fresh from its snapshot.
		const [fork] = (await tom.forkSandbox(custom.id, { wait: true })).items;
		expect(fork?.resources).toEqual({ vcpus: 2, memoryMb: 4096, diskGb: 64 });
		await tom.stopSandbox(custom.id, { wait: true });
		const started = await tom.startSandbox(custom.id, { wait: true });
		expect(started.resources).toEqual({ vcpus: 2, memoryMb: 4096, diskGb: 64 });
		const saved = await tom.saveSnapshot({ name: "disk", sandboxId: custom.id });
		const fromSaved = await tom.createSandbox({ type: "microvm", from: saved.id, wait: true });
		expect(fromSaved.resources).toMatchObject({ diskGb: 64 });
		// Another vCPU count and memory, as the console sends them, or another size: still the snapshot's disk, where it
		// is bigger than theirs.
		const reshaped = await tom.createSandbox({
			type: "microvm",
			from: saved.id,
			resources: { vcpus: 2, memoryMb: 4096 },
			wait: true,
		});
		expect(reshaped.resources).toEqual({ vcpus: 2, memoryMb: 4096, diskGb: 64 });
		const larger = await tom.createSandbox({
			type: "microvm",
			from: saved.id,
			resources: { vcpus: 4, memoryMb: 8192 },
			wait: true,
		});
		expect(larger.resources).toEqual({ vcpus: 4, memoryMb: 8192, diskGb: 64 });
		const [sizedFork] = (await tom.forkSandbox(custom.id, { snapshotId: saved.id, size: "large", wait: true })).items;
		expect(sizedFork?.resources).toEqual({ vcpus: 4, memoryMb: 8192, diskGb: 64 });
		// A size whose own disk is bigger: that size, whole.
		const [xlarge] = (await tom.forkSandbox(custom.id, { snapshotId: saved.id, size: "xlarge", wait: true })).items;
		expect(xlarge?.resources).toEqual({ vcpus: 8, memoryMb: 16384, diskGb: 80 });
		expect(xlarge?.size).toBe("xlarge");
		// A disk another preset has too (large's 40 GB), or smaller than its own size's: still the snapshot's, with its own
		// vCPUs and memory as the console sends them, or with others.
		for (const [size, diskGb, vcpus, memoryMb] of [
			["small", 40, 1, 1024],
			["default", 15, 2, 4096],
		] as const) {
			const made = await tom.createSandbox({ type: "microvm", size, resources: { diskGb }, wait: true });
			const kept = await tom.saveSnapshot({ name: `${size}-${diskGb}`, sandboxId: made.id });
			const same = await tom.createSandbox({
				type: "microvm",
				from: kept.id,
				resources: { vcpus, memoryMb },
				wait: true,
			});
			expect(same.resources).toEqual({ vcpus, memoryMb, diskGb });
		}
		const small = await tom.createSandbox({ type: "microvm", size: "small", resources: { diskGb: 40 }, wait: true });
		const smallKept = await tom.saveSnapshot({ name: "small-kept", sandboxId: small.id });
		const wider = await tom.createSandbox({
			type: "microvm",
			from: smallKept.id,
			resources: { vcpus: 2, memoryMb: 4096 },
			wait: true,
		});
		expect(wider.resources).toEqual({ vcpus: 2, memoryMb: 4096, diskGb: 40 });
		const [defaultFork] = (await tom.forkSandbox(small.id, { snapshotId: smallKept.id, size: "default", wait: true }))
			.items;
		expect(defaultFork?.resources).toEqual({ vcpus: 2, memoryMb: 4096, diskGb: 40 });
		// One from a snapshot keeps the snapshot's disk: none may be asked for.
		const refused = await failure(
			tom.createSandbox({ type: "microvm", from: saved.id, resources: { diskGb: 200 }, wait: true }),
		);
		expect(refused.code).toBe("invalid");
		expect(refused.message).toMatch(/keeps the snapshot's disk/);
	});

	it("refuses a disk out of range, on an isolate, or beside a size's vCPUs and memory", async () => {
		const { tom } = setup();
		const invalid = [
			{ type: "microvm", resources: { vcpus: 2, memoryMb: 4096, diskGb: 0 } },
			{ type: "microvm", resources: { vcpus: 2, memoryMb: 4096, diskGb: 2.5 } },
			{ type: "microvm", resources: { diskGb: 5000 } },
			{ resources: { memoryMb: 256, diskGb: 20 } },
			{ resources: { diskGb: 20 } },
			{ type: "microvm", size: "large", resources: { memoryMb: 8192, diskGb: 60 } },
		] as const;
		for (const body of invalid) expect((await failure(tom.createSandbox(body))).code).toBe("invalid");
		// Within what the API takes but more than any host gives: not_supported, before anything is stored.
		const big = await failure(
			tom.createSandbox({ type: "microvm", resources: { vcpus: 2, memoryMb: 4096, diskGb: 2000 } }),
		);
		expect(big.code).toBe("not_supported");
		expect(big.message).toMatch(/2000 GB disk/);
		const tiny = await failure(tom.createSandbox({ type: "microvm", resources: { diskGb: 4 } }));
		expect(tiny.code).toBe("not_supported");
	});

	it("offers a disk apart from the vCPUs and memory only where a host makes custom shapes", () => {
		const host = {
			id: "h",
			name: "h",
			version: "1",
			os: "linux",
			arch: "x86_64",
			tiers: ["microvm"],
			kvm: true,
			nestedVirtualisation: false,
			capacity: { vcpus: 8, memoryMb: 16_384, diskGb: 300 },
			labels: {},
		} as const;
		const sizes = [
			{ name: "small", vcpus: 1, memoryMb: 1024, diskGb: 10 },
			{ name: "default", vcpus: 2, memoryMb: 2048, diskGb: 20 },
		] as const;
		expect(microvmShapes([host], sizes)).not.toHaveProperty("diskGb");
		const custom = { ...host, features: ["custom-shapes"] };
		// A host from before it said its limits: its smallest preset's disk, at most its free disk.
		expect(microvmShapes([custom], sizes)?.diskGb).toEqual({ min: 10, max: 300, step: 1, default: 20 });
		// One that says: its limits, the most no more than its free disk; across hosts, the least and the most.
		const said = { ...custom, disk: { minGb: 15, maxGb: 200 } };
		expect(microvmShapes([said], sizes)?.diskGb).toEqual({ min: 15, max: 200, step: 1, default: 20 });
		// One without room for its least offers none, and with no other host, no disk may be chosen.
		const full = { ...said, id: "full", capacity: { ...host.capacity, diskGb: 5 } };
		expect(microvmShapes([full], sizes)).not.toHaveProperty("diskGb");
		// The free disk it last reported, not what it had when it started: more or less, and none free as none.
		expect(microvmShapes([{ ...said, freeDiskGb: 120 }], sizes)?.diskGb).toMatchObject({ max: 120 });
		expect(microvmShapes([{ ...full, freeDiskGb: 180 }], sizes)?.diskGb).toMatchObject({ max: 180 });
		expect(microvmShapes([{ ...said, freeDiskGb: 0 }], sizes)).not.toHaveProperty("diskGb");
		expect(microvmShapes([{ ...said, freeDiskGb: 0 }], sizes)?.custom).toBe(true);
		// A full host with a big least adds nothing to another's range.
		const bigFull = { ...said, id: "big", disk: { minGb: 1000, maxGb: 2000 }, freeDiskGb: 0 };
		const small = { ...said, id: "small", disk: { minGb: 10, maxGb: 100 }, freeDiskGb: 100 };
		expect(microvmShapes([bigFull, small], sizes)?.diskGb).toEqual({ min: 10, max: 100, step: 1, default: 20 });
		const roomy = {
			...said,
			id: "roomy",
			disk: { minGb: 30, maxGb: 2000 },
			capacity: { ...host.capacity, diskGb: 900 },
		};
		expect(microvmShapes([said, roomy], sizes)?.diskGb).toEqual({ min: 15, max: 900, step: 1, default: 20 });

		// A whole shape with a disk, checked against the hosts' limits.
		expect(shapeFor("microvm", { vcpus: 3, memoryMb: 4096, diskGb: 150 }, [said], sizes)).toEqual({
			vcpus: 3,
			memoryMb: 4096,
			diskGb: 150,
		});
		expect(() => shapeFor("microvm", { vcpus: 3, memoryMb: 4096, diskGb: 250 }, [said], sizes)).toThrow(/250 GB disk/);
		// A preset's own numbers and disk need no custom shapes; another disk does.
		expect(shapeFor("microvm", { vcpus: 2, memoryMb: 2048, diskGb: 20 }, [host], sizes)).toMatchObject({ diskGb: 20 });
		expect(() => shapeFor("microvm", { vcpus: 2, memoryMb: 2048, diskGb: 40 }, [host], sizes)).toThrow(
			/No host this sandbox may use/,
		);
		// A disk alone is the default size's (`sandboxMachine`).
		expect(shapeFor("microvm", { diskGb: 40 }, [said], sizes)).toBeUndefined();
		// A host from before it said its limits is admitted as placement admits it, 1 to 4096 GB, whatever the slider
		// offers.
		for (const diskGb of [5, 1500, 4096]) {
			expect(shapeFor("microvm", { vcpus: 3, memoryMb: 4096, diskGb }, [custom], sizes)).toMatchObject({ diskGb });
		}
		// A preset's disk outside the limits, as a custom shape given it by default records it: admitted, as placement does.
		const high = { ...custom, disk: { minGb: 60, maxGb: 200 } };
		expect(shapeFor("microvm", { vcpus: 3, memoryMb: 4096, diskGb: 20 }, [high], sizes)).toMatchObject({ diskGb: 20 });
		expect(() => shapeFor("microvm", { vcpus: 3, memoryMb: 4096, diskGb: 30 }, [high], sizes)).toThrow(/30 GB disk/);
	});

	it("offers a host's presets, and any shape where it makes them", () => {
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
	function clocked(store?: ReturnType<typeof createMemoryStore>, backend: SandboxBackend = createStubBackend()) {
		const clock = { at: Date.UTC(2026, 0, 1) };
		const api = createComputeApi({
			backend,
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

	it("doesn't count reading its processes as a use, so an open metrics dialog doesn't hold off its idle stop", async () => {
		const stub = createStubBackend();
		const { clock, tom, after } = clocked(undefined, {
			...stub,
			processes: async () => ({
				processes: [{ pid: 1, command: "/sbin/init", cpuPercent: 0, memoryBytes: 4096 }],
				total: 1,
			}),
		});
		const started = clock.at;
		const sandbox = await tom.createSandbox({
			type: "microvm",
			autoStopMinutes: null,
			idleStopMinutes: 5,
			wait: true,
		});
		// A dialog left open reads them every 10 seconds; past five minutes it stops all the same.
		for (let read = 0; read < 30; read++) {
			await after(10_000);
			expect((await tom.listSandboxProcesses(sandbox.id)).total).toBe(1);
		}
		expect((await tom.getSandbox(sandbox.id)).lastActiveAt).toBe(started);
		await after(60_000);
		const stopped = await tom.getSandbox(sandbox.id);
		expect([stopped.state, stopped.reason]).toEqual(["stopped", "idle-stop"]);
		// And then there are none to read.
		expect((await failure(tom.listSandboxProcesses(sandbox.id))).details).toMatchObject({ code: "sandbox_stopped" });
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
		expect(await second).toMatchObject({ path: "/workspace/two.txt" });
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

/** Carries every account deletion on to its end, as the sweep does once each pass is due. */
async function finishDeletions(api: ComputeApi, store: ComputeStore): Promise<void> {
	const running = () => store.deletions.list({ stage: "running" });
	for (let round = 0; round < 5 && (await running()).length > 0; round++) {
		for (const deletion of await running()) {
			await store.deletions.update(deletion.id, (current) => ({ ...current, dueAt: 0 }));
		}
		await api.service.sweep();
		await vi.waitFor(async () => {
			for (const deletion of await running()) expect(deletion.lease).toBeUndefined();
		});
	}
	expect(await running()).toEqual([]);
}

describe("deleting your account", () => {
	it("refuses while you'd leave an organisation with no owner, or have sandboxes of your own", async () => {
		const { tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const failed = await failure(tom.deleteCaller());
		expect(failed.code).toBe("conflict");
		expect(failed.message).toContain("Acme");

		const sandbox = await ann.createSandbox({ wait: true });
		expect((await failure(ann.deleteCaller())).code).toBe("conflict");
		await ann.deleteSandbox(sandbox.id);
		await ann.deleteCaller();
		expect((await tom.listMembers(org.id)).items.map((member) => member.userId)).toEqual(["usr_tom"]);
	});

	it("revokes their keys, takes them out of organisations, removes them from sign-in, and starts afresh after", async () => {
		const deleted: string[] = [];
		const store = createMemoryStore();
		const { api, tom, ann, client } = setup(undefined, {
			store,
			deletePerson: async (userId) => void deleted.push(userId),
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "admin" });
		await ann.joinOrganisation({ code: invite.code ?? "" });
		const before = (await ann.getCaller()).accountId;
		const personalKey = client((await ann.createApiKey({ name: "mine", preset: "read-only" })).secret);
		const orgKey = client((await ann.createApiKey({ name: "theirs", preset: "read-only", account: org.id })).secret);
		await ann.createWebhook({ name: "hook", url: "https://example.com/hook", events: ["sandbox.created"] });
		await ann.createApiKey({ name: "again", preset: "read-only" }, { idempotencyKey: "first" });
		await tom.createOrganisation({ name: "Tom's" }, { idempotencyKey: "first" });
		const kept = async (prefix: string) =>
			(await store.idempotency.list()).filter((each) => each.id.startsWith(prefix));
		expect(await kept("user:usr_ann:")).toHaveLength(1);

		expect((await failure(personalKey.deleteCaller())).code).toBe("forbidden");
		await ann.deleteCaller();

		expect(deleted).toEqual(["usr_ann"]);
		expect(await kept("user:usr_ann:")).toEqual([]);
		expect(await kept("user:usr_tom:")).toHaveLength(1);
		expect((await failure(personalKey.getCaller())).status).toBe(401);
		expect((await failure(orgKey.getCaller())).status).toBe(401);
		expect((await tom.listMembers(org.id)).items.map((member) => member.userId)).toEqual(["usr_tom"]);

		// Once it has finished, the user ID they had is never let in or honoured again: not even should a request that
		// began before the deletion make their record afresh, nor with a key that a write landing late left live. (Signing
		// up again gets a new user ID: apps/cloudflare/test/sign-in.test.ts.)
		await finishDeletions(api, store);
		expect(await store.deletions.get("usr_ann")).toEqual(expect.objectContaining({ stage: "done", name: "" }));
		expect((await failure(ann.getCaller())).status).toBe(401);
		await store.users.put({ id: "usr_ann", name: "Ann", superAdmin: false, personalAccountId: before, createdAt: 0 });
		for (const key of await store.apiKeys.list({ ownerUserId: "usr_ann" })) {
			await store.apiKeys.update(key.id, ({ revokedAt: _revoked, ...live }) => live);
		}
		expect((await failure(ann.getCaller())).status).toBe(401);
		expect((await failure(orgKey.listMembers(org.id))).status).toBe(401);
	});
});

describe("deleting your account, beyond the basics", () => {
	it("spends no join token they made for an organisation, and is refused to a deployment admin", async () => {
		const store = createMemoryStore();
		const { tom, ann } = setup(undefined, {
			store,
			accountHosts: true,
			deploymentAdmin: async (userId) => userId === "usr_tom",
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "admin" });
		await ann.joinOrganisation({ code: invite.code ?? "" });
		await ann.createAccountJoinToken({ name: "laptop", account: org.id });
		expect(await store.joinTokens.list({ createdBy: "usr_ann" })).toHaveLength(1);
		// A bundle's bytes are deleteBundle's to remove, so one left in their personal account refuses it.
		const personal = (await ann.getCaller()).accountId;
		const bundle = {
			id: `${personal}/sha256:00`,
			accountId: personal,
			digest: "sha256:00",
			sizeBytes: 1,
			createdAt: 0,
		};
		await store.bundles.put(bundle);
		expect((await failure(ann.deleteCaller())).code).toBe("conflict");
		await store.bundles.delete(bundle.id);

		await ann.deleteCaller();
		expect(await store.joinTokens.list({ createdBy: "usr_ann" })).toEqual([]);
		expect((await failure(tom.deleteCaller())).code).toBe("forbidden");
	});
});

/** The stores the deletion races are run on: they coordinate only through the store, so each must hold them off. */
const databases: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
});
const STORES: readonly { readonly name: string; readonly make: () => Promise<ComputeStore> }[] = [
	{ name: "in memory", make: async () => createMemoryStore() },
	{
		name: "in SQL",
		make: async () => {
			const database = await pgliteDatabase.open();
			databases.push(database);
			await migrateComputeStore(database.driver);
			return createSqlComputeStore(database.driver);
		},
	},
];
const sqlTimeout = pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs };

describe.each(STORES)("deleting your account as things are being made, stored $name", sqlTimeout, ({ make }) => {
	const close = (store: ComputeStore, accountId: string) =>
		store.accounts.update(accountId, (account) => ({ ...account, closedAt: Date.now() }));
	const report = (sandboxId: string, at = 1) => ({
		at,
		sandboxId,
		method: "CONNECT",
		host: "example.com",
		port: 443,
		allowed: true,
		swapped: [],
		inspected: false,
		bytesUp: 0,
		bytesDown: 0,
	});

	it("refuses a create in a closed account, leaving no record", async () => {
		const store = await make();
		const { ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		await close(store, personal);
		expect((await failure(ann.createSandbox({ wait: true }))).code).toBe("conflict");
		expect(await store.sandboxes.list({ accountId: personal })).toEqual([]);
	});

	it("deletes a sandbox stored just as the account closed, and finishes", async () => {
		const store = await make();
		const deleted: string[] = [];
		const { ann } = setup(undefined, { store, deletePerson: async (userId) => void deleted.push(userId) });
		const personal = (await ann.getCaller()).accountId;
		const raced = await ann.createSandbox({ wait: true });
		// The deletion's first look doesn't see it, as if it were stored just after.
		const list = store.sandboxes.list.bind(store.sandboxes);
		let first = true;
		store.sandboxes.list = async (where) => {
			const all = await list(where);
			if (!first) return all;
			first = false;
			return all.filter((sandbox) => sandbox.id !== raced.id);
		};
		await ann.deleteCaller();
		expect(deleted).toEqual(["usr_ann"]);
		expect(await store.accounts.get(personal)).toBeUndefined();
		expect(await store.sandboxes.get(raced.id)).toBeUndefined();
	});

	it("is carried on by the sweep after a pass fails partway, and the person can't get back in meanwhile", async () => {
		const store = await make();
		const deleted: string[] = [];
		const { api, ann } = setup(undefined, { store, deletePerson: async (userId) => void deleted.push(userId) });
		const personal = (await ann.getCaller()).accountId;
		const listWebhooks = store.webhooks.list.bind(store.webhooks);
		let failOnce = true;
		store.webhooks.list = async (where) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("the database went away");
			}
			return listWebhooks(where);
		};
		await ann.deleteCaller();
		const pending = await store.deletions.get("usr_ann");
		expect(pending).toMatchObject({ attempts: 1, lastError: expect.stringContaining("went away") });
		expect((await store.accounts.get(personal))?.closedAt).toBeDefined();
		expect((await failure(ann.getCaller())).status).toBe(401);
		await finishDeletions(api, store);
		expect(deleted.length).toBeGreaterThan(0);
		expect(await store.accounts.get(personal)).toBeUndefined();
		expect(await store.users.get("usr_ann")).toEqual(
			expect.objectContaining({ name: "", retiredAt: expect.any(Number) }),
		);
	});

	it("finishes the person's removal from sign-in when that fails after their records are gone", async () => {
		const store = await make();
		let failOnce = true;
		const deleted: string[] = [];
		const { api, ann } = setup(undefined, {
			store,
			deletePerson: async (userId) => {
				if (failOnce) {
					failOnce = false;
					throw new Error("identity is away");
				}
				deleted.push(userId);
			},
		});
		const personal = (await ann.getCaller()).accountId;
		await ann.deleteCaller();
		expect(await store.accounts.get(personal)).toBeUndefined();
		expect(deleted).toEqual([]);
		await finishDeletions(api, store);
		expect(deleted).toContain("usr_ann");
	});

	it("clears in its last pass what a write already under way stored after its first", async () => {
		const store = await make();
		const { api, ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		await ann.deleteCaller();
		expect(await store.accounts.get(personal)).toBeUndefined();
		// A request authorised before the close lands its write after the first pass.
		const webhook = { id: "whk_late", accountId: personal } as Parameters<typeof store.webhooks.put>[0];
		await store.webhooks.put(webhook);
		await finishDeletions(api, store);
		expect(await store.webhooks.list({ accountId: personal })).toEqual([]);
	});

	it("forgets a command stored as its account closed, and never runs it", async () => {
		const store = await make();
		const { ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		const sandbox = await ann.createSandbox({ wait: true });
		await close(store, personal);
		expect((await failure(ann.runCommand(sandbox.id, { command: "echo hi" }))).code).toBe("conflict");
		expect(await store.commands.list({ sandboxId: sandbox.id })).toEqual([]);
	});

	it("takes out again, and refuses, a settings record written into an account that has closed or gone", async () => {
		const store = await make();
		const fenced = fenceClosedAccounts(store);
		const account = {
			id: "acc_x",
			kind: "personal" as const,
			name: "X",
			defaultVisibility: "private" as const,
			createdAt: 0,
		};
		await store.accounts.put(account);
		const webhook = (id: string) => ({ id, accountId: account.id }) as Parameters<typeof store.webhooks.put>[0];
		await fenced.webhooks.put(webhook("whk_open"));
		await close(store, account.id);
		await expect(fenced.webhooks.put(webhook("whk_late"))).rejects.toThrow("being deleted");
		await store.accounts.delete(account.id);
		await expect(fenced.webhooks.insert(webhook("whk_gone"))).rejects.toThrow("being deleted");
		expect((await store.webhooks.list({ accountId: account.id })).map((each) => each.id)).toEqual(["whk_open"]);
	});

	it("forgets a snapshot taken as its account closed", async () => {
		const store = await make();
		const { ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		const sandbox = await ann.createSandbox({ type: "microvm", wait: true });
		await close(store, personal);
		expect((await failure(ann.takeSnapshot(sandbox.id, {}))).code).toBe("conflict");
		expect(await store.snapshots.list({ accountId: personal })).toEqual([]);
	});

	it("takes out an event whose write was under way as its account closed and went", async () => {
		const store = await make();
		const fenced = fenceClosedAccounts(store);
		const account = {
			id: "acc_e",
			kind: "personal" as const,
			name: "E",
			defaultVisibility: "private" as const,
			createdAt: 0,
		};
		await store.accounts.put(account);
		// The event's write is held until the account has closed and its deletion has gone.
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const put = store.events.put.bind(store.events);
		store.events.put = async (event) => {
			await held;
			return put(event);
		};
		const event = { id: "evt_late", accountId: account.id } as Parameters<typeof store.events.put>[0];
		const writing = fenced.events.put(event);
		await close(store, account.id);
		await store.accounts.delete(account.id);
		release();
		await writing;
		await vi.waitFor(async () => expect(await store.events.list({ accountId: account.id })).toEqual([]));
	});

	it("keeps its last pass for when it is due, and asks the deployment to wake for it", async () => {
		const store = await make();
		const wakes: number[] = [];
		const { api, ann } = setup(undefined, { store, wakeAt: (at) => void wakes.push(at) });
		await ann.deleteCaller();
		const after = await store.deletions.get("usr_ann");
		expect(after).toMatchObject({ stage: "running", clearedAt: expect.any(Number) });
		// A sweep, or a deletion call holding an older copy, straight after: the last pass waits its turn.
		const next = await api.service.carryOnDeletions();
		expect(next).toBe(after?.dueAt);
		expect(await store.deletions.get("usr_ann")).toMatchObject({ stage: "running" });
		await vi.waitFor(() => expect(wakes).toContain(after?.dueAt));
	});

	it("leaves nothing of a sign-in that set the person up as their deletion began", async () => {
		const store = await make();
		const { api, ann } = setup(undefined, { store });
		// Their deletion is recorded while the sign-in is setting them up for the first time.
		const get = store.users.get.bind(store.users);
		let once = true;
		store.users.get = async (id) => {
			if (once && id === "usr_ann") {
				once = false;
				await store.deletions.put({
					id: "usr_ann",
					stage: "running",
					personalAccountId: "acc_before",
					name: "Ann",
					startedAt: 0,
					dueAt: Number.MAX_SAFE_INTEGER,
					attempts: 0,
				});
			}
			return get(id);
		};
		expect((await failure(ann.getCaller())).status).toBe(401);
		// What it made landed before the deletion retired them; the deletion's passes clear it, by its account's ID.
		await store.deletions.update("usr_ann", (current) => ({ ...current, dueAt: 0 }));
		await finishDeletions(api, store);
		expect(await store.members.list({ userId: "usr_ann" })).toEqual([]);
		expect(await store.accounts.get(personalAccountIdOf("usr_ann"))).toBeUndefined();
		expect(await store.users.get("usr_ann")).toEqual(
			expect.objectContaining({ name: "", retiredAt: expect.any(Number) }),
		);
	});

	it("makes nothing more for a person once they are retired, however late a first sign-in's writes come", async () => {
		const store = await make();
		const { api, ann } = setup(undefined, { store });
		await ann.deleteCaller();
		await finishDeletions(api, store);
		// A first sign-in's account and membership, arriving after the retirement: refused in the same write.
		const account = personalAccountIdOf("usr_ann");
		expect(
			await store.personWrites.insertAccount(
				{ id: account, kind: "personal", name: "Ann", defaultVisibility: "private", createdAt: 0 },
				"usr_ann",
			),
		).toBe(false);
		expect(
			await store.personWrites.insertMember({
				id: `${account}:usr_ann`,
				accountId: account,
				userId: "usr_ann",
				role: "owner",
				joinedAt: 0,
			}),
		).toBe(false);
		expect(await store.accounts.get(account)).toBeUndefined();
		expect(await store.members.list({ userId: "usr_ann" })).toEqual([]);
		expect((await failure(ann.getCaller())).status).toBe(401);
	});

	it("finishes setting a person up on their next sign-in, when their first stopped partway", async () => {
		const store = await make();
		const { ann } = setup(undefined, { store });
		const insertAccount = store.personWrites.insertAccount.bind(store.personWrites);
		let failOnce = true;
		store.personWrites.insertAccount = async (account, userId) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("the gateway went away");
			}
			return insertAccount(account, userId);
		};
		await expect(ann.getCaller()).rejects.toBeDefined();
		expect(await store.users.get("usr_ann")).toBeDefined();
		expect(await store.accounts.get(personalAccountIdOf("usr_ann"))).toBeUndefined();
		const caller = await ann.getCaller();
		expect(caller.accountId).toBe(personalAccountIdOf("usr_ann"));
		expect(await store.accounts.get(personalAccountIdOf("usr_ann"))).toMatchObject({ kind: "personal" });
		expect((await ann.listMembers(caller.accountId)).items.map((member) => member.userId)).toEqual(["usr_ann"]);
	});

	it("keeps a stray account findable until it is gone, should its removal fail", async () => {
		const store = await make();
		const { api, ann } = setup(undefined, { store });
		await ann.deleteCaller();
		await store.members.put({
			id: "acc_stray:usr_ann",
			accountId: "acc_stray",
			userId: "usr_ann",
			role: "owner",
			joinedAt: 0,
		});
		await store.accounts.put({
			id: "acc_stray",
			kind: "personal",
			name: "Ann",
			defaultVisibility: "private",
			createdAt: 0,
		});
		const remove = store.accounts.delete.bind(store.accounts);
		let failOnce = true;
		store.accounts.delete = async (id) => {
			if (failOnce && id === "acc_stray") {
				failOnce = false;
				throw new Error("the database went away");
			}
			return remove(id);
		};
		await finishDeletions(api, store);
		expect(await store.accounts.get("acc_stray")).toBeUndefined();
		expect(await store.members.list({ userId: "usr_ann" })).toEqual([]);
	});

	it("clears the personal account a racing sign-in would make, though no membership names it", async () => {
		const store = await make();
		const { api, ann } = setup(undefined, { store });
		await ann.deleteCaller();
		// Written before the deletion was recorded, by a sign-in that stopped before its membership or user.
		const stray = personalAccountIdOf("usr_ann");
		await store.accounts.put({ id: stray, kind: "personal", name: "Ann", defaultVisibility: "private", createdAt: 0 });
		await finishDeletions(api, store);
		expect(await store.accounts.get(stray)).toBeUndefined();
	});

	it("clears a personal account a sign-in made and couldn't finish, found by its membership", async () => {
		const store = await make();
		const { api, ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		await ann.deleteCaller();
		// A sign-in that began before the deletion got as far as an owner membership and an account, then stopped.
		await store.members.put({
			id: "acc_stray:usr_ann",
			accountId: "acc_stray",
			userId: "usr_ann",
			role: "owner",
			joinedAt: 0,
		});
		await store.accounts.put({
			id: "acc_stray",
			kind: "personal",
			name: "Ann",
			defaultVisibility: "private",
			createdAt: 0,
		});
		await finishDeletions(api, store);
		expect(await store.accounts.get("acc_stray")).toBeUndefined();
		expect(await store.accounts.get(personal)).toBeUndefined();
		expect(await store.members.list({ userId: "usr_ann" })).toEqual([]);
	});

	it("is woken for after a first pass cut short, and finished by its wakes with no request", async () => {
		const store = await make();
		const wakes: number[] = [];
		const deleted: string[] = [];
		const { api, ann } = setup(undefined, {
			store,
			wakeAt: (at) => void wakes.push(at),
			deletePerson: async (userId) => void deleted.push(userId),
		});
		const personal = (await ann.getCaller()).accountId;
		const listWebhooks = store.webhooks.list.bind(store.webhooks);
		let failOnce = true;
		store.webhooks.list = async (where) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("the gateway went away");
			}
			return listWebhooks(where);
		};
		const before = Date.now();
		await ann.deleteCaller();
		// A wake was asked for before anything changed, within a lease of the start.
		expect(wakes.length).toBeGreaterThan(0);
		expect(Math.min(...wakes)).toBeLessThanOrEqual(before + 5 * 60_000 + 1000);
		// Each wake carries the deletion on (as the hosted alarm does), until it is done.
		for (let round = 0; round < 5 && (await store.deletions.get("usr_ann"))?.stage === "running"; round++) {
			await store.deletions.update("usr_ann", ({ lease: _lease, ...current }) => ({ ...current, dueAt: 0 }));
			await api.service.carryOnDeletions();
		}
		expect((await store.deletions.get("usr_ann"))?.stage).toBe("done");
		expect(await store.accounts.get(personal)).toBeUndefined();
		expect(deleted).toContain("usr_ann");
	});

	it("refuses the deletion, changing nothing, when no wake can be arranged", async () => {
		const store = await make();
		const { ann } = setup(undefined, {
			store,
			wakeAt: () => {
				throw new Error("no alarm");
			},
		});
		const personal = (await ann.getCaller()).accountId;
		await expect(ann.deleteCaller()).rejects.toBeDefined();
		expect(await store.deletions.get("usr_ann")).toBeUndefined();
		expect((await store.accounts.get(personal))?.closedAt).toBeUndefined();
		expect((await ann.getCaller()).accountId).toBe(personal);
	});

	it("keeps an away host's credential until its template cache's bytes are deleted, templates on or off", async () => {
		const store = await make();
		const stub = createStubBackend();
		const order: string[] = [];
		let personal = "";
		let away = true;
		const backend: SandboxBackend = {
			...stub,
			// One host of Ann's own, away at first.
			capabilities: async () => {
				const base = await stub.capabilities();
				const [template] = base.hosts;
				if (template === undefined || personal === "") return base;
				return {
					...base,
					hosts: [...base.hosts, { ...template, id: "host_own", connected: !away, accountId: personal }],
				};
			},
			deleteTemplateSnapshot: async ({ snapshotId }) => {
				if (away) throw new KantelError("unavailable", "The host isn't connected");
				order.push(`deleted ${snapshotId}`);
			},
			revokeHost: async (hostId) => void order.push(`revoked ${hostId}`),
		};
		// Templates off on this deployment: nothing but the deletion tries the bytes again.
		const { api, ann } = setup(backend, { store, accountHosts: true });
		personal = (await ann.getCaller()).accountId;
		const entry = { id: "tsn_own", accountId: personal, templateId: "tpl_gone", hostId: "host_own", state: "deleting" };
		await store.templateSnapshots.put(entry as Parameters<typeof store.templateSnapshots.put>[0]);
		await ann.deleteCaller();
		expect(order).toEqual([]);
		expect(await store.deletions.get("usr_ann")).toMatchObject({
			stage: "running",
			lastError: expect.stringContaining("template"),
		});
		// It comes back: the deletion's next pass deletes the bytes, then revokes it.
		away = false;
		await store.deletions.update("usr_ann", ({ lease: _lease, ...current }) => ({ ...current, dueAt: 0 }));
		await api.service.carryOnDeletions();
		expect(order).toEqual(["deleted tsn_own", "revoked host_own"]);
		expect(await store.templateSnapshots.get(entry.id)).toBeUndefined();
	});

	it("revokes an account's host after a day though its template cache is still there", async () => {
		const store = await make();
		const stub = createStubBackend();
		const revoked: string[] = [];
		let personal = "";
		const backend: SandboxBackend = {
			...stub,
			capabilities: async () => {
				const base = await stub.capabilities();
				const [template] = base.hosts;
				if (template === undefined || personal === "") return base;
				return {
					...base,
					hosts: [...base.hosts, { ...template, id: "host_gone", connected: false, accountId: personal }],
				};
			},
			// Gone for good: its bytes can't be deleted.
			deleteTemplateSnapshot: async () => {
				throw new KantelError("unavailable", "The host isn't connected");
			},
			revokeHost: async (hostId) => void revoked.push(hostId),
		};
		const { api, ann } = setup(backend, { store, accountHosts: true });
		personal = (await ann.getCaller()).accountId;
		const entry = { id: "tsn_gone", accountId: personal, hostId: "host_gone", state: "deleting" };
		await store.templateSnapshots.put(entry as Parameters<typeof store.templateSnapshots.put>[0]);
		await ann.deleteCaller();
		expect(revoked).toEqual([]);
		await store.deletions.update("usr_ann", ({ lease: _lease, ...current }) => ({
			...current,
			startedAt: Date.now() - 25 * 60 * 60_000,
			dueAt: 0,
		}));
		await api.service.carryOnDeletions();
		expect(revoked).toContain("host_gone");
	});

	it("joins no host with a token whose account has closed", async () => {
		const store = await make();
		const { ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		const hash = "f".repeat(64);
		await store.joinTokens.put({
			id: "jtk_1",
			tokenHash: hash,
			labels: {},
			expiresAt: Date.now() + 60_000,
			createdAt: Date.now(),
			accountId: personal,
		});
		await close(store, personal);
		expect(await joinTokenSpender(store).spendJoinToken(hash, "host_1", Date.now())).toBeUndefined();
	});

	it("lets two deletions that overlap both carry it on, ending with the account gone", async () => {
		const store = await make();
		const { ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		const results = await Promise.allSettled([ann.deleteCaller(), ann.deleteCaller()]);
		expect(results.some((result) => result.status === "fulfilled")).toBe(true);
		expect(await store.accounts.get(personal)).toBeUndefined();
		expect(await store.users.get("usr_ann")).toEqual(
			expect.objectContaining({ name: "", retiredAt: expect.any(Number) }),
		);
	});

	it("lets no key of theirs work once they're gone, even one stored after the deletion revoked theirs", async () => {
		const store = await make();
		const { ann, tom, client } = setup(undefined, { store });
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "admin" })).code ?? "" });
		const issued = await ann.createApiKey({ name: "late", preset: "read-only", account: org.id });
		await ann.deleteCaller();
		// As if its write had landed after the deletion's sweep: live, in an organisation that goes on.
		await store.apiKeys.update(issued.key.id, ({ revokedAt: _revoked, ...key }) => key);
		expect((await failure(client(issued.secret).listMembers(org.id))).status).toBe(401);
	});

	it("keeps a closed account closed through an update, and never brings back a removed one", async () => {
		const store = await make();
		const { ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		await close(store, personal);
		await ann.updateAccount(personal, { name: "Renamed" });
		expect(await store.accounts.get(personal)).toMatchObject({ name: "Renamed", closedAt: expect.any(Number) });
		// Removed by its deletion between the update's read and its write.
		const update = store.accounts.update.bind(store.accounts);
		store.accounts.update = async (id, change, expected) => {
			await store.accounts.delete(id);
			return update(id, change, expected);
		};
		expect((await failure(ann.updateAccount(personal, { name: "Again" }))).code).toBe("not_found");
		expect(await store.accounts.get(personal)).toBeUndefined();
	});

	it("destroys what a boot made when its record was deleted while it booted", async () => {
		const store = await make();
		const stub = createStubBackend();
		const destroyed: string[] = [];
		const backend: SandboxBackend = {
			...stub,
			// Another replica's deletion purges the record while this one boots.
			create: async (spec) => {
				const placed = await stub.create(spec);
				await store.sandboxes.delete(spec.sandboxId);
				return placed;
			},
			destroy: async (sandboxId) => {
				destroyed.push(sandboxId);
				return stub.destroy(sandboxId);
			},
		};
		const { ann } = setup(backend, { store });
		const made = await ann.createSandbox({});
		await vi.waitFor(() => expect(destroyed).toContain(made.id), { timeout: 10_000 });
	});

	it("destroys what a boot made when its record was being deleted as it booted", async () => {
		const store = await make();
		const stub = createStubBackend();
		const destroyed: string[] = [];
		const backend: SandboxBackend = {
			...stub,
			// Another replica's delete has destroyed and not yet marked it deleted when this boot makes its machine.
			create: async (spec) => {
				const placed = await stub.create(spec);
				await store.sandboxes.update(spec.sandboxId, (current) => ({ ...current, state: "deleting" }));
				return placed;
			},
			destroy: async (sandboxId) => {
				destroyed.push(sandboxId);
				return stub.destroy(sandboxId);
			},
		};
		const { ann } = setup(backend, { store });
		const made = await ann.createSandbox({});
		await vi.waitFor(() => expect(destroyed).toContain(made.id), { timeout: 10_000 });
	});

	it("drops a host's egress report for a closed account, and keeps one for an open account", async () => {
		const store = await make();
		const { api, ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		const sandbox = await ann.createSandbox({ wait: true });
		await api.service.recordEgress(STUB_HOST_ID, [report(sandbox.id)]);
		expect(await store.egress.list({ sandboxId: sandbox.id })).toHaveLength(1);
		await close(store, personal);
		await api.service.recordEgress(STUB_HOST_ID, [report(sandbox.id, 2)]);
		// A closed account's log is the deletion's to clear; nothing new is added to it.
		expect((await store.egress.list({ sandboxId: sandbox.id })).length).toBeLessThanOrEqual(1);
	});

	it("drops what an egress report wrote when its account closed as it wrote, failed or not", async () => {
		const store = await make();
		const { api, ann } = setup(undefined, { store });
		const personal = (await ann.getCaller()).accountId;
		const sandbox = await ann.createSandbox({ wait: true });
		// The first entry lands and the account closes; the second write fails.
		const put = store.egress.put.bind(store.egress);
		let writes = 0;
		store.egress.put = async (entry) => {
			writes++;
			if (writes === 2) throw new Error("the database went away");
			const written = await put(entry);
			await close(store, personal);
			return written;
		};
		await expect(
			api.service.recordEgress(STUB_HOST_ID, [report(sandbox.id, 1), report(sandbox.id, 2)]),
		).rejects.toThrow("the database went away");
		expect(await store.egress.list({ sandboxId: sandbox.id })).toEqual([]);
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
		expect((await ann.listSandboxes({ account: org.id, mine: true })).items).toEqual([]);
		const annOwn = await ann.createSandbox({ account: org.id, wait: true });
		expect((await ann.listSandboxes({ account: org.id, mine: true })).items.map((item) => item.id)).toEqual([
			annOwn.id,
		]);
		expect((await tom.listSandboxes({ account: org.id, mine: true })).items.map((item) => item.id).sort()).toEqual(
			[shared.id, mine.id].sort(),
		);
		await ann.deleteSandbox(annOwn.id);
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
		// Its vCPUs and memory, and the disk it copies.
		const own = pause?.resources && {
			vcpus: pause.resources.vcpus,
			memoryMb: pause.resources.memoryMb,
			diskGb: pause.resources.diskGb,
		};
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

	it("shows a host's memory as the backend last said, without writing it to the host's record", async () => {
		const store = createMemoryStore();
		const stub = createStubBackend();
		const report: computeSchema.HostMemory = {
			mode: "used",
			state: "ok",
			totalMiB: 128_000,
			reserveMiB: 12_800,
			capacityMiB: 115_200,
			reservedMiB: 131_072,
			committedMiB: 45_056,
			guestUsedMiB: 12_288,
			residentMiB: 24_576,
			availableMiB: 100_000,
			swapUsedMiB: 0,
			pressureSome: 0,
			pressureFull: 0,
			maxRatio: 2.5,
			measuredAt: 1_700_000_000_000,
		};
		let memory: computeSchema.HostMemory | undefined;
		const backend: SandboxBackend = {
			...stub,
			capabilities: async () => {
				const read = await stub.capabilities();
				return {
					...read,
					hosts: (read.hosts ?? []).map((host) => (memory === undefined ? host : { ...host, memory })),
				};
			},
		};
		const { root } = setup(backend, { store });
		expect((await root.getHost(STUB_HOST_ID)).memory).toBeUndefined();
		memory = report;
		expect((await root.listHosts()).items[0]?.memory).toEqual(report);
		// It moves on every heartbeat: the record is never written for it.
		const written = await store.hosts.get(STUB_HOST_ID);
		memory = { ...report, committedMiB: 50_000 };
		expect((await root.listHosts()).items[0]?.memory?.committedMiB).toBe(50_000);
		expect(await store.hosts.get(STUB_HOST_ID)).toEqual(written);
		expect(written).not.toHaveProperty("memory");
		// A host that stops saying has none.
		memory = undefined;
		expect((await root.listHosts()).items[0]?.memory).toBeUndefined();
	});

	it("shows how a host reaches its mesh peers as the backend last said, without writing it to the host's record", async () => {
		const store = createMemoryStore();
		const stub = createStubBackend();
		const report: computeSchema.HostMesh = {
			address: "fd4b:91c2:7e10:0:5a1e:3f20:9c4d:1b07",
			peers: [
				{
					hostId: "host_b",
					path: "direct",
					endpoint: "203.0.113.24:51820",
					lastHandshake: 1_700_000_000_000,
					rttMs: 0.4,
				},
				{ hostId: "host_c", path: "none" },
			],
		};
		let mesh: computeSchema.HostMesh | undefined;
		const backend: SandboxBackend = {
			...stub,
			capabilities: async () => {
				const read = await stub.capabilities();
				return {
					...read,
					hosts: (read.hosts ?? []).map((host) => (mesh === undefined ? host : { ...host, mesh })),
				};
			},
		};
		const { root } = setup(backend, { store });
		expect((await root.getHost(STUB_HOST_ID)).mesh).toBeUndefined();
		mesh = report;
		expect((await root.getHost(STUB_HOST_ID)).mesh).toEqual(report);
		expect((await root.listHosts()).items[0]?.mesh).toEqual(report);
		const written = await store.hosts.get(STUB_HOST_ID);
		expect(written).not.toHaveProperty("mesh");
		// A host whose mesh went down (its pool's sync off) has none.
		mesh = undefined;
		expect((await root.listHosts()).items[0]?.mesh).toBeUndefined();
	});

	it("shows what takes a host's disk as the host last measured it, its snapshots split by their records", async () => {
		const store = createMemoryStore();
		const stub = createStubBackend();
		const rest = {
			totalBytes: 1_000,
			usedBytes: 600,
			sandboxesBytes: 150,
			imagesBytes: 50,
			templatesBytes: 40,
			bundlesBytes: 10,
			otherBytes: 50,
			measuredAt: 1_700_000_000_000,
		};
		const measured = { ...rest, snapshotsBytes: 300 };
		let disk: BackendDiskUsage | undefined;
		const backend: SandboxBackend = {
			...stub,
			capabilities: async () => {
				const read = await stub.capabilities();
				return {
					...read,
					hosts: (read.hosts ?? []).map((host) => (disk === undefined ? host : { ...host, diskUsage: disk })),
				};
			},
		};
		const { root, tom } = setup(backend, { store });
		expect((await root.getHost(STUB_HOST_ID)).diskUsage).toBeUndefined();
		disk = measured;
		await root.createHostJoinToken({});
		// No saved snapshots: all of it is automatic, a manual take (which a host keeps as saved) included.
		const sandbox = await tom.createSandbox({ type: "microvm", autoStopMinutes: null, wait: true });
		await tom.takeSnapshot(sandbox.id, {});
		// An isolate's save is among its sandbox's files on the host, not its snapshots: it counts for neither.
		const isolate = await tom.createSandbox({ type: "isolate", autoStopMinutes: null, wait: true });
		const isolateSave = await tom.saveSnapshot({ name: "isolate", sandboxId: isolate.id });
		await store.snapshots.update(isolateSave.id, (current) => ({ ...current, sizeBytes: 100 }));
		expect((await root.listHosts()).items[0]?.diskUsage).toEqual({
			...rest,
			savedSnapshotsBytes: 0,
			automaticSnapshotsBytes: 300,
		});
		// A save counts its size as saved, and the rest stays automatic.
		const saved = await tom.saveSnapshot({ name: "golden", sandboxId: sandbox.id });
		await store.snapshots.update(saved.id, (current) => ({ ...current, sizeBytes: 100 }));
		expect((await root.getHost(STUB_HOST_ID)).diskUsage).toMatchObject({
			savedSnapshotsBytes: 100,
			automaticSnapshotsBytes: 200,
		});
		// Never more than the host measured for its snapshots.
		await store.snapshots.update(saved.id, (current) => ({ ...current, sizeBytes: 1_000 }));
		expect((await root.getHost(STUB_HOST_ID)).diskUsage).toMatchObject({
			savedSnapshotsBytes: 300,
			automaticSnapshotsBytes: 0,
		});

		// A host that splits its snapshots by snapshot: saved is what the saved ones hold of those files, each group once,
		// whatever their sizes say (memory the save shares with its sandbox, say, is the sandbox's).
		const savedRef = await refOf(store, saved.id);
		const autoRef = `${STUB_HOST_ID}/snap-auto`;
		const otherRef = `${STUB_HOST_ID}/snap-other`;
		disk = {
			...measured,
			snapshotOwnBytes: { [savedRef]: 40, [autoRef]: 100, [otherRef]: 60 },
			snapshotShared: [
				{ refs: [savedRef, autoRef], bytes: 70 },
				{ refs: [autoRef, otherRef], bytes: 30 },
			],
		};
		await root.createHostJoinToken({});
		expect((await root.getHost(STUB_HOST_ID)).diskUsage).toEqual({
			...rest,
			savedSnapshotsBytes: 110,
			automaticSnapshotsBytes: 190,
		});
	});

	it("refuses a save past a host's limit on each account's saved snapshots, set by its admin", async () => {
		const store = createMemoryStore();
		const { backend, next, released, takes } = sizedBackend();
		const { root, tom, ann } = setup(backend, { store });
		const sandbox = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		next.bytes = 40 * MiB;
		const first = await tom.saveSnapshot({ name: "first", sandboxId: sandbox.id });
		expect(first.sizeBytes).toBe(40 * MiB);
		expect((await failure(tom.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: 1 }))).code).toBe("forbidden");
		const limited = await root.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: 50 * MiB });
		expect(limited.savedSnapshotBytesLimit).toBe(50 * MiB);
		// Another write keeps it.
		expect((await root.updateHost(STUB_HOST_ID, { name: "renamed" })).savedSnapshotBytesLimit).toBe(50 * MiB);

		// A history entry's copy of another 20 MiB would take it past: refused, and the copy's bytes go again, while the
		// entry's stay.
		const taken = await tom.takeSnapshot(sandbox.id, {});
		const takenRef = await refOf(store, taken.id);
		const firstRef = await refOf(store, first.id);
		next.bytes = 20 * MiB;
		const refused = await failure(tom.saveSnapshot({ name: "second", sandboxId: sandbox.id, snapshotId: taken.id }));
		expect(refused.code).toBe("exhausted");
		expect(refused.message).toContain("50 MiB of saved snapshots on this host");
		expect(refused.message).toContain("has 40 MiB; this one is 20 MiB");
		expect(released).toHaveLength(1);
		expect(released).not.toContain(takenRef);
		expect((await store.snapshots.list()).filter((snapshot) => snapshot.name === "second")).toEqual([]);
		expect((await tom.getSnapshot(taken.id)).state).toBe("ready");

		// Replacing the first with it fits: the first's bytes go.
		const replaced = await tom.saveSnapshot({
			name: "first",
			sandboxId: sandbox.id,
			snapshotId: taken.id,
			replace: true,
		});
		expect(replaced.name).toBe("first");
		expect(released).toContain(firstRef);
		// Another account's saves count against its own.
		const own = await ann.createSandbox({ autoStopMinutes: null, wait: true });
		next.bytes = 45 * MiB;
		await ann.saveSnapshot({ name: "anns", sandboxId: own.id });

		// The limit reached: a save of a running sandbox's state now is refused before it's taken.
		await store.snapshots.update(replaced.id, (current) => ({
			...current,
			sizeBytes: 50 * MiB,
			fullSizeBytes: 50 * MiB,
		}));
		const before = takes.count;
		expect((await failure(tom.saveSnapshot({ name: "third", sandboxId: sandbox.id }))).code).toBe("exhausted");
		expect(takes.count).toBe(before);

		// Removed, saves go through again.
		const unlimited = await root.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: null });
		expect(unlimited.savedSnapshotBytesLimit).toBeUndefined();
		expect((await tom.saveSnapshot({ name: "third", sandboxId: sandbox.id })).name).toBe("third");
	});

	/**
	 * A host whose keeps link an entry's 60 MiB of files into each copy, 1 MiB of each copy its own: a keep's answer
	 * names, as a host does, only the snapshots still there (none whose bytes were deleted).
	 */
	async function linkingCopies() {
		const store = createMemoryStore();
		const sized = sizedBackend();
		const { root, tom } = setup(sized.backend, { store });
		const sandbox = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const entry = await tom.takeSnapshot(sandbox.id, {});
		const entryRef = await refOf(store, entry.id);
		const copies: string[] = [];
		sized.next.bytes = 61 * MiB;
		sized.next.unique = MiB;
		sized.next.shared = (ref) => {
			copies.push(ref);
			const there = copies.filter((copy) => !sized.released.includes(copy));
			return [{ refs: [entryRef, ...there], bytes: 60 * MiB }];
		};
		const copy = (name: string, replace = false) =>
			tom.saveSnapshot({ name, sandboxId: sandbox.id, snapshotId: entry.id, ...(replace ? { replace } : {}) });
		const limit = (mib: number | null) =>
			root.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: mib === null ? null : mib * MiB });
		return { ...sized, store, tom, sandbox, copy, limit };
	}

	it("counts each save at its full size: copies that share files count apart", async () => {
		const { store, released, copy, limit } = await linkingCopies();
		await limit(100);
		const first = await copy("first");
		// Its size counts the files it shares (it holds them); its full size is the same 61 MiB.
		expect(first.sizeBytes).toBe(61 * MiB);
		// A second copy sharing the same 60 MiB counts its full 61 MiB too: 122 MiB, past 100.
		const refused = await failure(copy("second"));
		expect(refused.code).toBe("exhausted");
		expect(refused.message).toContain("has 61 MiB; this one is 61 MiB");
		expect(released).toHaveLength(1);
		expect((await store.snapshots.list()).filter((snapshot) => snapshot.name === "second")).toEqual([]);
		// Up to 122 MiB, both fit.
		await limit(122);
		const second = await copy("second");
		expect(second.state).toBe("ready");
	});

	it("reads the full size of a save recorded before full sizes were from its host, refusing when it can't", async () => {
		const { store, next, measured, takes, tom, sandbox, copy, limit } = await linkingCopies();
		// A holds the 60 MiB both copies share; B, beside it, was recorded at its own 1 MiB, before full sizes were.
		const a = await copy("a");
		const b = await copy("b");
		const bRef = await refOf(store, b.id);
		for (const old of [a, b]) {
			await store.snapshots.update(old.id, ({ fullSizeBytes: _, ...current }) => current);
		}
		await tom.deleteSnapshot(a.id);
		await limit(100);
		// An unrelated 70 MiB would fit were B counted at 1 MiB; the host says it takes 61, so it doesn't.
		measured.sizes = new Map([[bRef, 61 * MiB]]);
		next.bytes = 70 * MiB;
		next.unique = undefined;
		const refused = await failure(tom.saveSnapshot({ name: "big", sandboxId: sandbox.id }));
		expect(refused.code).toBe("exhausted");
		expect(refused.message).toContain("has 61 MiB; this one is 70 MiB");
		expect((await store.snapshots.get(b.id))?.fullSizeBytes).toBe(61 * MiB);
		// A host that can't answer refuses the save, nothing taken, rather than count less.
		await store.snapshots.update(b.id, ({ fullSizeBytes: _, ...current }) => current);
		measured.offline = true;
		const before = takes.count;
		expect((await failure(tom.saveSnapshot({ name: "big", sandboxId: sandbox.id }))).code).toBe("unavailable");
		expect(takes.count).toBe(before);
		// With no limit, the host isn't asked.
		await limit(null);
		expect((await tom.saveSnapshot({ name: "big", sandboxId: sandbox.id })).state).toBe("ready");
	});

	it("counts a save still being admitted at its full size, and frees it once withdrawn", async () => {
		const { store, backend, copy, limit } = await linkingCopies();
		const first = await copy("first");
		// The first still being admitted (on another gateway, say): it counts, so a second copy doesn't fit 100 MiB.
		await store.snapshots.update(first.id, (current) => ({ ...current, state: "creating" }));
		await limit(100);
		expect((await failure(copy("second"))).message).toContain("has 61 MiB; this one is 61 MiB");
		// Withdrawn, its bytes deleted: the second fits.
		await backend.deleteSnapshot(await refOf(store, first.id));
		await store.snapshots.delete(first.id);
		expect((await copy("second")).state).toBe("ready");
	});

	it("counts the bytes a save shares with its source once, on a host that can't keep copies", async () => {
		const store = createMemoryStore();
		const { backend, released } = sizedBackend({ oldHost: true });
		const { root, tom } = setup(backend, { store });
		const sandbox = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const entry = await tom.takeSnapshot(sandbox.id, {});
		const other = await tom.takeSnapshot(sandbox.id, {});
		await store.snapshots.update(entry.id, (current) => ({ ...current, sizeBytes: 40 * MiB }));
		await store.snapshots.update(other.id, (current) => ({ ...current, sizeBytes: 20 * MiB }));
		await root.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: 50 * MiB });
		// Both saves of the entry share its ref: 40 MiB in all.
		await tom.saveSnapshot({ name: "one", sandboxId: sandbox.id, snapshotId: entry.id });
		await tom.saveSnapshot({ name: "two", sandboxId: sandbox.id, snapshotId: entry.id });
		// Refused, a save sharing its source's bytes leaves them be.
		expect((await failure(tom.saveSnapshot({ name: "three", sandboxId: sandbox.id, snapshotId: other.id }))).code).toBe(
			"exhausted",
		);
		expect(released).toEqual([]);
		expect((await tom.getSnapshot(other.id)).state).toBe("ready");
		expect((await store.snapshots.list()).filter((snapshot) => snapshot.name === "three")).toEqual([]);
	});

	it("takes back a save its gateway left being admitted, once its lease is past, freeing its bytes", async () => {
		const memory = createMemoryStore();
		// The gateway dies once the save is stored `creating`: nothing it writes after lands.
		const died = { yes: false };
		const store: ComputeStore = {
			...memory,
			snapshots: {
				...memory.snapshots,
				put: async (record) => {
					if (died.yes) throw new Error("the gateway died");
					await memory.snapshots.put(record);
					if (record.state === "creating") died.yes = true;
				},
				update: async (id, change) => {
					if (died.yes) throw new Error("the gateway died");
					return memory.snapshots.update(id, change);
				},
			},
		};
		const { backend, next, released } = sizedBackend();
		const clock = { at: Date.UTC(2026, 0, 1) };
		const dying = setup(backend, { store, now: () => clock.at });
		const sandbox = await dying.tom.createSandbox({ autoStopMinutes: null, wait: true });
		await dying.root.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: 50 * MiB });
		next.bytes = 40 * MiB;
		await failure(dying.tom.saveSnapshot({ name: "lost", sandboxId: sandbox.id }));
		const [left] = (await memory.snapshots.list()).filter((snapshot) => snapshot.name === "lost");
		expect(left?.state).toBe("creating");

		// Another gateway: the stranded save counts against the limit while its lease runs.
		const { api, tom } = setup(backend, { store: memory, now: () => clock.at });
		next.bytes = 20 * MiB;
		expect((await failure(tom.saveSnapshot({ name: "next", sandboxId: sandbox.id }))).code).toBe("exhausted");
		clock.at += SAVE_ADMISSION_LEASE_MS - 60_000;
		await api.service.sweep();
		await api.service.idle();
		expect((await memory.snapshots.get(left?.id ?? ""))?.state).toBe("creating");
		// Past it, the sweep takes it back, its bytes with it, and the next save fits.
		clock.at += SNAPSHOT_EXPIRY_EVERY_MS;
		await api.service.sweep();
		await api.service.idle();
		expect(released).toContain(left?.ref);
		expect(await memory.snapshots.get(left?.id ?? "")).toBeUndefined();
		expect((await tom.saveSnapshot({ name: "next", sandboxId: sandbox.id })).state).toBe("ready");
	});

	it("fails an admission the sweep took back meanwhile, its bytes released once", async () => {
		const memory = createMemoryStore();
		// The admission's read of the host's limit waits, once the save is stored `creating`.
		let stored = false;
		let resume = () => {};
		const held = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let waiting = false;
		const store: ComputeStore = {
			...memory,
			snapshots: {
				...memory.snapshots,
				put: async (record) => {
					await memory.snapshots.put(record);
					if (record.state === "creating") stored = true;
				},
			},
			hosts: {
				...memory.hosts,
				get: async (id) => {
					if (stored) {
						stored = false;
						waiting = true;
						await held;
					}
					return memory.hosts.get(id);
				},
			},
		};
		const { backend, next, released } = sizedBackend();
		const clock = { at: Date.UTC(2026, 0, 1) };
		const { api, root, tom } = setup(backend, { store, now: () => clock.at });
		const sandbox = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		await root.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: 50 * MiB });
		next.bytes = 10 * MiB;
		const saving = failure(tom.saveSnapshot({ name: "slow", sandboxId: sandbox.id }));
		while (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
		const [record] = (await memory.snapshots.list()).filter((snapshot) => snapshot.name === "slow");
		clock.at += SAVE_ADMISSION_LEASE_MS + SNAPSHOT_EXPIRY_EVERY_MS;
		await api.service.sweep();
		await api.service.idle();
		expect(released).toEqual([record?.ref]);
		resume();
		expect((await saving).code).toBe("conflict");
		expect(released).toEqual([record?.ref]);
		expect((await memory.snapshots.list()).filter((snapshot) => snapshot.name === "slow")).toEqual([]);
	});

	it("keeps a refused save's bytes recorded until its host deletes them, and tries again", async () => {
		const store = createMemoryStore();
		const { backend, next, released, failing } = sizedBackend();
		const clock = { at: Date.UTC(2026, 0, 1) };
		// An account may keep one saved snapshot: a refused save still settling doesn't count as one.
		const { api, root, tom } = setup(backend, { store, now: () => clock.at, limits: { savedSnapshots: 1 } });
		const sandbox = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		await root.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: 10 * MiB });
		next.bytes = 20 * MiB;
		failing.deletes = true;
		expect((await failure(tom.saveSnapshot({ name: "big", sandboxId: sandbox.id }))).code).toBe("exhausted");
		// The host couldn't delete them: the record stays, settling, counted for nothing and not in the name's way.
		const [left] = (await store.snapshots.list()).filter((snapshot) => snapshot.name === "big");
		expect(left?.state).toBe("deleting");
		expect(left?.retiring?.settling).toBe(true);
		next.bytes = 5 * MiB;
		failing.deletes = false;
		const fits = await tom.saveSnapshot({ name: "big", sandboxId: sandbox.id });
		expect(fits.state).toBe("ready");
		// Its name names the new one, not the one being deleted.
		const made = await tom.createSandbox({ from: "big", autoStopMinutes: null, wait: true });
		expect(made.state).toBe("running");
		// The sweep deletes them once the host can, even with expiry off.
		clock.at += SNAPSHOT_EXPIRY_EVERY_MS;
		await api.service.sweep();
		await api.service.idle();
		expect(released).toContain(left?.ref);
		expect(await store.snapshots.get(left?.id ?? "")).toBeUndefined();
		expect((await tom.getSnapshot(fits.id)).state).toBe("ready");
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

	it("checks for host updates for the super-admin only, where the backend reads releases", async () => {
		const stub = createStubBackend();
		let checks = 0;
		const { root, tom } = setup({
			...stub,
			async checkHostUpdates() {
				checks += 1;
				return checks === 1 ? { checked: true, latestVersion: "0.3.1" } : { checked: false };
			},
		});
		expect((await failure(tom.checkHostUpdates())).code).toBe("forbidden");
		expect(checks).toBe(0);
		expect(await root.checkHostUpdates()).toEqual({ checked: true, latestVersion: "0.3.1" });
		expect(await root.checkHostUpdates()).toEqual({ checked: false });
		expect((await failure(setup().root.checkHostUpdates())).code).toBe("not_supported");
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
			// Between the drain reading the host and writing it, another call revokes it. (The registry is also told the
			// host's pool, which is no drain.)
			async updateHost(hostId, change) {
				const revoke = change.draining === undefined ? undefined : revokeMeanwhile;
				if (revoke !== undefined) revokeMeanwhile = undefined;
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

describe("snapshot expiry", () => {
	/**
	 * A gateway on a clock, whose backend records the bytes it deletes. `oldHost`: no `snapshot.keep`, so a save shares
	 * its source's bytes. `failDeletes`: a delete fails, as with its host away.
	 */
	function expiring(options: { oldHost?: boolean; store?: ReturnType<typeof createMemoryStore> } = {}) {
		const store = options.store ?? createMemoryStore();
		const stub = createStubBackend();
		const released: string[] = [];
		const failing = { deletes: false };
		const { keepSnapshot: _keep, ...withoutKeep } = stub;
		const backend: SandboxBackend = {
			...(options.oldHost === true ? withoutKeep : stub),
			deleteSnapshot: async (ref) => {
				if (failing.deletes) throw new KantelError("unavailable", "The host is away");
				released.push(ref);
				await stub.deleteSnapshot(ref);
			},
		};
		const clock = { at: Date.UTC(2026, 0, 1) };
		const api = createComputeApi({
			backend,
			store,
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
			now: () => clock.at,
			snapshotExpiry: true,
			snapshotExpiryDelayMs: 0,
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const sweep = async () => {
			await api.service.sweep();
			await api.service.idle();
		};
		/** Past the automatic snapshots' time, and the next expiry pass's. */
		const expire = async () => {
			clock.at += AUTOMATIC_SNAPSHOT_TTL_MS + SNAPSHOT_EXPIRY_EVERY_MS;
			await sweep();
		};
		const refOf = async (id: string) => (await store.snapshots.get(id))?.ref;
		return { store, api, tom, clock, sweep, expire, released, failing, refOf };
	}

	it("deletes automatic snapshots past their time, keeping a sandbox's newest, a save's copy and shared bytes", async () => {
		const { store, tom, clock, sweep, released, refOf } = expiring();
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const savedFrom = await tom.takeSnapshot(running.id, {});
		const own = await tom.takeSnapshot(running.id, {});
		const legacy = await tom.takeSnapshot(running.id, {});
		const newest = await tom.takeSnapshot(running.id, {});
		// A save keeps a copy of its own (snapshot.keep): its source's expiry doesn't touch it.
		const saved = await tom.saveSnapshot({ name: "kept", sandboxId: running.id, snapshotId: savedFrom.id });
		expect(await refOf(saved.id)).not.toBe(await refOf(savedFrom.id));
		// A save from before its host kept copies shares its source's ref: expiry leaves that source be.
		const legacyRef = await refOf(legacy.id);
		const sharing = await tom.saveSnapshot({ name: "legacy", sandboxId: running.id, snapshotId: legacy.id });
		await store.snapshots.update(sharing.id, (current) => ({ ...current, ref: legacyRef }));
		const stopped = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		await tom.stopSandbox(stopped.id, { wait: true });
		const resumesFrom = (await tom.getSandbox(stopped.id)).latestSnapshotId;
		if (resumesFrom === undefined) throw new Error("the stop took no snapshot");
		const [fromRef, ownRef] = [await refOf(savedFrom.id), await refOf(own.id)];

		// Within its time, nothing goes.
		clock.at += AUTOMATIC_SNAPSHOT_TTL_MS - 60_000;
		await sweep();
		expect(await store.snapshots.get(own.id)).toBeDefined();

		clock.at += SNAPSHOT_EXPIRY_EVERY_MS;
		await sweep();
		expect(await store.snapshots.get(own.id)).toBeUndefined();
		expect(released).toContain(ownRef);
		expect(await store.snapshots.get(savedFrom.id)).toBeUndefined();
		expect(released).toContain(fromRef);
		expect((await tom.getSnapshot(saved.id)).id).toBe(saved.id);
		// The shared one stays, record and bytes.
		expect((await store.snapshots.get(legacy.id))?.state).toBe("ready");
		expect(released).not.toContain(legacyRef);
		// The running sandbox's newest, and the one the stopped sandbox resumes from, stay.
		expect(await store.snapshots.get(newest.id)).toBeDefined();
		expect(await store.snapshots.get(resumesFrom)).toBeDefined();
		expect((await tom.resumeSandbox(stopped.id, { wait: true })).state).toBe("running");
		// A save is never expired.
		clock.at += 30 * 24 * 3_600_000;
		await sweep();
		expect(await store.snapshots.get(saved.id)).toBeDefined();
	});

	it("rolls an adoption back when its check of the snapshot can't be read", async () => {
		const base = createMemoryStore();
		let armed = false;
		let failReads = false;
		const store = {
			...base,
			snapshots: {
				...base.snapshots,
				get: async (id: string) => {
					if (failReads) throw new KantelError("unavailable", "An injected failure");
					return base.snapshots.get(id);
				},
			},
			sandboxes: {
				...base.sandboxes,
				// Once the fork is stored, the check of its snapshot fails.
				put: async (record: Parameters<typeof base.sandboxes.put>[0]) => {
					await base.sandboxes.put(record);
					if (armed) failReads = true;
				},
			},
		} as ReturnType<typeof createMemoryStore>;
		const { tom } = expiring({ store });
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const snapshot = await tom.takeSnapshot(running.id, {});
		const before = (await base.sandboxes.list()).length;
		armed = true;
		const refused = await failure(tom.forkSandbox(running.id, { snapshotId: snapshot.id }));
		armed = false;
		failReads = false;
		expect(refused.code).toBe("conflict");
		expect((await base.sandboxes.list()).length).toBe(before);
	});

	it("settles only the mark whose dependents it read, not one made again by the same process meanwhile", async () => {
		const base = createMemoryStore();
		let target: string | undefined;
		let remarks = 0;
		const store = {
			...base,
			sandboxes: {
				...base.sandboxes,
				// Every read of what depends on it, the mark is put back and made again (another token) while it reads.
				list: async (where?: Parameters<typeof base.sandboxes.list>[0]) => {
					const read = await base.sandboxes.list(where);
					if (where === undefined && target !== undefined) {
						remarks += 1;
						const token = `ret_again_${remarks}`;
						await base.snapshots.update(target, (current) =>
							current.retiring === undefined ? undefined : { ...current, retiring: { ...current.retiring, token } },
						);
					}
					return read;
				},
			},
		} as ReturnType<typeof createMemoryStore>;
		const { tom, expire, released, refOf } = expiring({ store });
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const old = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		const ref = await refOf(old.id);
		target = old.id;
		await expire();
		target = undefined;
		expect(remarks).toBeGreaterThan(1);
		expect(released).not.toContain(ref);
		expect((await base.snapshots.get(old.id))?.retiring?.settling).not.toBe(true);
	});

	it("expires nothing with expiry off, and nothing before its start delay once it is on", async () => {
		for (const [on, delay] of [
			[false, 0],
			[true, 60 * 60_000],
		] as const) {
			const store = createMemoryStore();
			const clock = { at: Date.UTC(2026, 0, 1) };
			const api = createComputeApi({
				backend: createStubBackend(),
				store,
				authenticatePerson: async (request) =>
					request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
				now: () => clock.at,
				snapshotExpiry: on,
				snapshotExpiryDelayMs: delay,
			});
			opened.push(api);
			const tom = createKantelClient({
				baseUrl: BASE_URL,
				token: "tom-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
			const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
			const old = await tom.takeSnapshot(running.id, {});
			await tom.takeSnapshot(running.id, {});
			await store.snapshots.update(old.id, (current) => ({ ...current, expiresAt: clock.at - 1 }));
			const sweep = async (by: number) => {
				clock.at += by;
				await api.service.sweep();
				await api.service.idle();
			};
			if (on) {
				// Within the delay: kept; past it: expired.
				await sweep(delay - 1);
				expect((await store.snapshots.get(old.id))?.state).toBe("ready");
				await sweep(2);
				expect(await store.snapshots.get(old.id)).toBeUndefined();
			} else {
				await sweep(SNAPSHOT_EXPIRY_EVERY_MS);
				await sweep(365 * 24 * 3_600_000);
				expect((await store.snapshots.get(old.id))?.state).toBe("ready");
			}
		}
	});

	it("leaves the source of an older gateway's create alone while expiry waits out its start delay", async () => {
		const store = createMemoryStore();
		const stub = createStubBackend();
		const clock = { at: Date.UTC(2026, 0, 1) };
		const delay = SNAPSHOT_EXPIRY_EVERY_MS * 3;
		const api = createComputeApi({
			backend: stub,
			store,
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
			now: () => clock.at,
			snapshotExpiry: true,
			snapshotExpiryDelayMs: delay,
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		// Taken long ago (already past its expiry), as by the gateway this one replaced.
		const old = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		await store.snapshots.update(old.id, (current) => ({ ...current, expiresAt: clock.at - 1 }));
		// An older gateway's fork, which doesn't adopt: it has read the snapshot ready, and is held before it stores
		// its sandbox. This gateway sweeps meanwhile, within its start delay.
		const read = await store.snapshots.get(old.id);
		expect(read?.state).toBe("ready");
		for (let pass = 0; pass < 2; pass += 1) {
			clock.at += SNAPSHOT_EXPIRY_EVERY_MS;
			await api.service.sweep();
			await api.service.idle();
		}
		expect((await store.snapshots.get(old.id))?.state).toBe("ready");
		// The older gateway stores its fork, never placed yet, made from it.
		const [made] = (await tom.forkSandbox(running.id, { snapshotId: old.id, wait: true })).items;
		if (made === undefined) throw new Error("no fork");
		await store.sandboxes.update(made.id, (current) => ({
			...current,
			hostId: undefined,
			latestSnapshotId: undefined,
		}));
		// Past the delay, expiry sees what depends on it, and keeps it.
		clock.at += delay;
		await api.service.sweep();
		await api.service.idle();
		expect((await store.snapshots.get(old.id))?.state).toBe("ready");
	});

	it("expires nothing on a host that can't keep copies, which prunes its own", async () => {
		const { store, tom, expire, released } = expiring({ oldHost: true });
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const old = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		await expire();
		expect((await store.snapshots.get(old.id))?.state).toBe("ready");
		expect(released).toEqual([]);
	});

	it("keeps the snapshot a sandbox is made from only until it is placed", async () => {
		const { store, tom, expire } = expiring();
		const source = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const history = await tom.takeSnapshot(source.id, {});
		await tom.takeSnapshot(source.id, {});
		// A fork of history: placed, with snapshots of its own once it stops.
		const [fork] = (await tom.forkSandbox(source.id, { snapshotId: history.id, wait: true })).items;
		if (fork === undefined) throw new Error("no fork");
		expect((await store.sandboxes.get(fork.id))?.source?.snapshotId).toBe(history.id);
		await expire();
		expect(await store.snapshots.get(history.id)).toBeUndefined();
	});

	it("keeps a snapshot whose bytes its host couldn't delete, hidden, and deletes them on a later sweep", async () => {
		const { store, tom, expire, sweep, clock, released, failing, refOf } = expiring();
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const old = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		const ref = await refOf(old.id);
		failing.deletes = true;
		await expire();
		// Gone to every read, its record kept with its ref for the retry.
		expect((await store.snapshots.get(old.id))?.state).toBe("deleting");
		expect((await failure(tom.getSnapshot(old.id))).code).toBe("not_found");
		expect((await tom.listSnapshots({ sandboxId: running.id })).items.map((item) => item.id)).not.toContain(old.id);
		failing.deletes = false;
		clock.at += SNAPSHOT_EXPIRY_EVERY_MS;
		await sweep();
		expect(await store.snapshots.get(old.id)).toBeUndefined();
		expect(released).toContain(ref);
	});

	for (const when of ["before", "after"] as const) {
		it(`refuses a fork from a snapshot expiry marked, stored ${when} expiry reads the sandboxes`, async () => {
			const base = createMemoryStore();
			let hook: (() => Promise<unknown>) | undefined;
			const sandboxes = base.sandboxes;
			const store = {
				...base,
				sandboxes: {
					...sandboxes,
					// Expiry's read of every sandbox, once its snapshots are marked: the fork lands just before or just after it.
					list: async (where?: Parameters<typeof sandboxes.list>[0]) => {
						const run = where === undefined ? hook : undefined;
						if (run !== undefined) hook = undefined;
						if (run !== undefined && when === "before") await run();
						const read = await sandboxes.list(where);
						if (run !== undefined && when === "after") await run();
						return read;
					},
				},
			} as ReturnType<typeof createMemoryStore>;
			const { tom, expire, released, refOf } = expiring({ store });
			const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
			const old = await tom.takeSnapshot(running.id, {});
			await tom.takeSnapshot(running.id, {});
			const ref = await refOf(old.id);
			const before = (await sandboxes.list()).length;
			let refused: KantelApiError | undefined;
			hook = async () => {
				refused = await failure(tom.forkSandbox(running.id, { snapshotId: old.id }));
			};
			await expire();
			// The fork saw the mark and let its record go; the snapshot, which nothing then depends on, is deleted.
			expect(refused?.code).toBe("conflict");
			expect((await sandboxes.list()).length).toBe(before);
			expect(await base.snapshots.get(old.id)).toBeUndefined();
			expect(released).toContain(ref);
		});
	}

	it("keeps the snapshot a never-placed fork is to be made from, marked and put back", async () => {
		const { tom, expire, store } = expiring();
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const old = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		// A fork whose create failed: never placed, it is to be made from the snapshot (`latestRef`).
		const [stored] = (await tom.forkSandbox(running.id, { snapshotId: old.id, wait: true })).items;
		if (stored === undefined) throw new Error("no fork");
		await store.sandboxes.update(stored.id, (current) => ({
			...current,
			hostId: undefined,
			latestSnapshotId: undefined,
		}));
		await expire();
		expect((await store.snapshots.get(old.id))?.state).toBe("ready");
	});
});

describe("snapshot expiry across gateways", () => {
	/** Two gateways on one store, one backend and one clock, as replicas are; the backend records what it deletes. */
	function replicas() {
		const store = createMemoryStore();
		const stub = createStubBackend();
		const released: string[] = [];
		const backend: SandboxBackend = {
			...stub,
			deleteSnapshot: async (ref) => {
				released.push(ref);
				await stub.deleteSnapshot(ref);
			},
		};
		const clock = { at: Date.UTC(2026, 0, 1) };
		const gateway = () => {
			const api = createComputeApi({
				backend,
				store,
				authenticatePerson: async (request) =>
					request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
				now: () => clock.at,
				snapshotExpiry: true,
				snapshotExpiryDelayMs: 0,
			});
			opened.push(api);
			return api;
		};
		const [a, b] = [gateway(), gateway()];
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				a.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const sweep = async (api: ComputeApi) => {
			await api.service.sweep();
			await api.service.idle();
		};
		return { store, released, clock, a, b, tom, sweep };
	}

	it("keeps the source of a never-placed sandbox whose delete is under way, which may fail back to error", async () => {
		const store = createMemoryStore();
		const stub = createStubBackend();
		let hook: (() => Promise<void>) | undefined;
		let failing: string | undefined;
		const backend: SandboxBackend = {
			...stub,
			destroy: async (sandboxId) => {
				if (sandboxId === failing) {
					const run = hook;
					hook = undefined;
					if (run !== undefined) await run();
					throw new KantelError("unavailable", "The host is away");
				}
				await stub.destroy(sandboxId);
			},
		};
		const clock = { at: Date.UTC(2026, 0, 1) };
		const gateway = () => {
			const api = createComputeApi({
				backend,
				store,
				authenticatePerson: async (request) =>
					request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
				now: () => clock.at,
				snapshotExpiry: true,
				snapshotExpiryDelayMs: 0,
			});
			opened.push(api);
			return api;
		};
		const [a, b] = [gateway(), gateway()];
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				a.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const source = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		// A fork whose create failed: never placed, it is to be made from the snapshot.
		const [fork] = (await tom.forkSandbox(running.id, { snapshotId: source.id, wait: true })).items;
		if (fork === undefined) throw new Error("no fork");
		await store.sandboxes.update(fork.id, (current) => ({
			...current,
			state: "error",
			hostId: undefined,
			latestSnapshotId: undefined,
		}));
		await store.snapshots.update(source.id, (current) => ({ ...current, expiresAt: clock.at - 1 }));
		// Its delete is under way (deleting) when the other gateway expires snapshots; then its destroy fails.
		failing = fork.id;
		clock.at += SNAPSHOT_EXPIRY_EVERY_MS;
		hook = async () => {
			expect((await store.sandboxes.get(fork.id))?.state).toBe("deleting");
			await b.service.sweep();
			await b.service.idle();
		};
		await tom.deleteSandbox(fork.id).catch(() => undefined);
		await a.service.idle();
		expect(hook).toBeUndefined();
		expect((await store.sandboxes.get(fork.id))?.state).toBe("error");
		expect((await store.snapshots.get(source.id))?.state).toBe("ready");
	});

	it("leaves another gateway's mark alone, and expires what it puts back on a later pass", async () => {
		const { store, released, clock, b, tom, sweep } = replicas();
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const old = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		const ref = (await store.snapshots.get(old.id))?.ref;
		// Gateway A has marked it, and is checking what depends on it: B's sweep finds it deleting, not B's to settle.
		await store.snapshots.update(old.id, (current) => ({
			...current,
			state: "deleting",
			retiring: { by: "gateway-a", at: clock.at },
		}));
		await sweep(b);
		expect((await store.snapshots.get(old.id))?.state).toBe("deleting");
		expect(released).not.toContain(ref);
		// A puts it back (something depended on it then); B expires it on a later pass.
		await store.snapshots.update(old.id, ({ retiring: _, ...current }) => ({ ...current, state: "ready" }));
		clock.at += AUTOMATIC_SNAPSHOT_TTL_MS + SNAPSHOT_EXPIRY_EVERY_MS;
		await sweep(b);
		expect(await store.snapshots.get(old.id)).toBeUndefined();
		expect(released).toContain(ref);
	});

	it("takes over a mark whose gateway went past its lease, checking what depends on it again", async () => {
		const { store, released, clock, b, tom, sweep } = replicas();
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const kept = await tom.takeSnapshot(running.id, {});
		const gone = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		const [keptRef, goneRef] = [(await store.snapshots.get(kept.id))?.ref, (await store.snapshots.get(gone.id))?.ref];
		// A never-placed fork is to be made from one of them.
		const [fork] = (await tom.forkSandbox(running.id, { snapshotId: kept.id, wait: true })).items;
		if (fork === undefined) throw new Error("no fork");
		await store.sandboxes.update(fork.id, (current) => ({
			...current,
			hostId: undefined,
			latestSnapshotId: undefined,
		}));
		// Both marked by a gateway that then died.
		for (const id of [kept.id, gone.id]) {
			await store.snapshots.update(id, (current) => ({
				...current,
				state: "deleting",
				retiring: { by: "gateway-gone", at: clock.at },
			}));
		}
		// Within the lease, B leaves them be.
		clock.at += RETIRE_LEASE_MS / 2;
		await sweep(b);
		expect((await store.snapshots.get(gone.id))?.state).toBe("deleting");
		clock.at += RETIRE_LEASE_MS;
		await sweep(b);
		expect((await store.snapshots.get(kept.id))?.state).toBe("ready");
		expect(released).not.toContain(keptRef);
		expect(await store.snapshots.get(gone.id)).toBeUndefined();
		expect(released).toContain(goneRef);
	});

	it("deletes an expired snapshot once when both gateways sweep at once, and keeps one something depends on", async () => {
		const { store, released, clock, a, b, tom, sweep } = replicas();
		const running = await tom.createSandbox({ autoStopMinutes: null, wait: true });
		const gone = await tom.takeSnapshot(running.id, {});
		const kept = await tom.takeSnapshot(running.id, {});
		await tom.takeSnapshot(running.id, {});
		const [fork] = (await tom.forkSandbox(running.id, { snapshotId: kept.id, wait: true })).items;
		if (fork === undefined) throw new Error("no fork");
		await store.sandboxes.update(fork.id, (current) => ({
			...current,
			hostId: undefined,
			latestSnapshotId: undefined,
		}));
		const goneRef = (await store.snapshots.get(gone.id))?.ref;
		clock.at += AUTOMATIC_SNAPSHOT_TTL_MS + SNAPSHOT_EXPIRY_EVERY_MS;
		await Promise.all([sweep(a), sweep(b)]);
		expect(await store.snapshots.get(gone.id)).toBeUndefined();
		expect(released.filter((ref) => ref === goneRef)).toHaveLength(1);
		expect((await store.snapshots.get(kept.id))?.state).toBe("ready");
	});
});

describe("snapshot deletes under random interleavings", () => {
	/** A small seeded generator (mulberry32), so a failing seed can be run again. */
	function random(seed: number) {
		let state = seed >>> 0;
		const next = () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
		};
		return { next, pick: <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)] };
	}

	async function run(seed: number) {
		const rng = random(seed);
		const base = createMemoryStore();
		const faults = { on: false };
		const flaky = () => faults.on && rng.next() < 0.3;
		const fail = () => new KantelError("unavailable", "An injected failure");
		// Transient failures of the reads expiry and deletes depend on: every sandbox, and a ref's records.
		const store = {
			...base,
			sandboxes: {
				...base.sandboxes,
				list: async (where?: Parameters<typeof base.sandboxes.list>[0]) => {
					if (where === undefined && flaky()) throw fail();
					return base.sandboxes.list(where);
				},
			},
			snapshots: {
				...base.snapshots,
				list: async (where?: Parameters<typeof base.snapshots.list>[0]) => {
					if (where?.ref !== undefined && flaky()) throw fail();
					return base.snapshots.list(where);
				},
			},
		} as ReturnType<typeof createMemoryStore>;
		const stub = createStubBackend();
		const deleted = new Set<string>();
		const violations: string[] = [];
		const oldHost = seed % 2 === 0;
		// Half the seeds on a host without snapshot.keep, where a save shares its source's bytes.
		const { keepSnapshot: _keep, ...withoutKeep } = stub;
		const backend: SandboxBackend = {
			...(seed % 2 === 0 ? withoutKeep : stub),
			deleteSnapshot: async (ref) => {
				if (flaky()) throw fail();
				// Bytes are deleted only once every record that names them is settling; and expiry deletes nothing on a
				// host that can't keep copies (what a sweep there settles is a delete asked for by hand).
				for (const record of await base.snapshots.list({ ref })) {
					const settling = record.state === "deleting" && record.retiring?.settling === true;
					if (!settling) violations.push(`seed ${seed}: ${ref} deleted under ${record.id} (${record.state})`);
					else if (oldHost) {
						violations.push(`seed ${seed}: expiry deleted ${ref} on a host that can't keep copies`);
					}
				}
				deleted.add(ref);
				await stub.deleteSnapshot(ref);
			},
		};
		const clock = { at: Date.UTC(2026, 0, 1) };
		const gateway = () => {
			const api = createComputeApi({
				backend,
				store,
				authenticatePerson: async (request) =>
					request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
				now: () => clock.at,
				snapshotExpiry: true,
				snapshotExpiryDelayMs: 0,
			});
			opened.push(api);
			return api;
		};
		const gateways = [gateway(), gateway()] as const;
		const clients = gateways.map((api) =>
			createKantelClient({
				baseUrl: BASE_URL,
				token: "tom-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			}),
		);
		const [primary] = clients;
		if (primary === undefined) throw new Error("no client");
		const client = () => rng.pick(clients) ?? primary;
		const seen = new Set<string>();
		const deletedByHand = new Set<string>();
		const refsDeletedByHand = new Set<string>();

		const check = async (step: string) => {
			const records = await base.snapshots.list();
			const byIdNow = new Map(records.map((record) => [record.id, record]));
			for (const event of await base.events.list()) {
				if (event.type !== "snapshot.deleted" || event.snapshotId === undefined) continue;
				const record = byIdNow.get(event.snapshotId);
				if (record !== undefined && record.state !== "deleting") {
					throw new Error(`seed ${seed}, ${step}: ${record.id} said deleted, but ${record.state}`);
				}
			}
			for (const record of records) {
				if (record.ref !== undefined) seen.add(record.ref);
				const settling = record.state === "deleting" && record.retiring?.settling === true;
				if (!settling && record.ref !== undefined && deleted.has(record.ref)) {
					throw new Error(`seed ${seed}, ${step}: ${record.id} (${record.state}) names deleted bytes ${record.ref}`);
				}
			}
			const byId = new Map(records.map((record) => [record.id, record]));
			for (const sandbox of await base.sandboxes.list()) {
				if (sandbox.state === "deleted" || sandbox.state === "deleting") continue;
				const needed = [
					sandbox.latestSnapshotId,
					sandbox.state === "paused" ? sandbox.pausedSnapshotId : undefined,
					sandbox.hostId === undefined && sandbox.latestSnapshotId === undefined
						? sandbox.source?.snapshotId
						: undefined,
				];
				for (const id of needed) {
					// A delete by hand removes what it is asked to, as it always has; expiry never removes what is needed.
					if (id === undefined || deletedByHand.has(id)) continue;
					const record = byId.get(id);
					if (record === undefined || record.retiring?.settling === true) {
						throw new Error(`seed ${seed}, ${step}: ${sandbox.id} (${sandbox.state}) depends on ${id}, which is gone`);
					}
				}
			}
		};

		await primary.createSandbox({ autoStopMinutes: null, wait: true });
		await primary.createSandbox({ autoStopMinutes: null, wait: true });
		for (let step = 0; step < 60; step += 1) {
			faults.on = rng.next() < 0.5;
			const sandboxes = (await base.sandboxes.list()).filter(
				(sandbox) => sandbox.state !== "deleted" && sandbox.state !== "deleting",
			);
			const running = sandboxes.filter((sandbox) => sandbox.state === "running");
			const stopped = sandboxes.filter((sandbox) => sandbox.state === "stopped" || sandbox.state === "paused");
			const snapshots = (await base.snapshots.list()).filter((record) => record.state === "ready");
			// One to three actors at once, interleaved at every await: the gateways' requests and sweeps alike.
			const choices = [
				"take",
				"take",
				"delete",
				"crash",
				"fork",
				"stop",
				"resume",
				"fail",
				"advance",
				"sweep",
				"sweep",
			] as const;
			const actions = Array.from({ length: 1 + Math.floor(rng.next() * 3) }, () => rng.pick(choices) ?? "sweep");
			const action = actions.join("+");
			const done = async (call: () => Promise<unknown>) => {
				await call().catch(() => undefined);
				for (const api of gateways) await api.service.idle();
			};
			const act = async (action: (typeof choices)[number]) => {
				switch (action) {
					case "take": {
						const sandbox = rng.pick(running);
						if (sandbox !== undefined) await done(() => client().takeSnapshot(sandbox.id, {}));
						break;
					}
					case "delete": {
						const snapshot = rng.pick(snapshots);
						if (snapshot !== undefined) {
							deletedByHand.add(snapshot.id);
							// A delete by hand gives up on bytes its host couldn't delete, as it always has: not expiry's leak.
							if (snapshot.ref !== undefined) refsDeletedByHand.add(snapshot.ref);
							await done(() => client().deleteSnapshot(snapshot.id));
						}
						break;
					}
					case "crash": {
						// An expiry whose gateway died between its mark and its settling (on a host that keeps copies, where
						// expiry runs): the mark is left, for the sweep after its lease.
						const snapshot = rng.pick(
							snapshots.filter(
								(record) =>
									record.kind === "automatic" && record.expiresAt !== undefined && record.expiresAt <= clock.at,
							),
						);
						if (snapshot !== undefined && !oldHost) {
							await base.snapshots.update(snapshot.id, (current) =>
								current.state !== "ready"
									? undefined
									: {
											...current,
											state: "deleting",
											retiring: { by: "gateway-dead", token: "ret_dead", at: clock.at },
										},
							);
						}
						break;
					}
					case "fork": {
						const snapshot = rng.pick(snapshots.filter((record) => record.kind === "automatic"));
						if (snapshot?.sandboxId !== undefined) {
							const sandboxId = snapshot.sandboxId;
							await done(() => client().forkSandbox(sandboxId, { snapshotId: snapshot.id, wait: true }));
						}
						break;
					}
					case "stop": {
						const sandbox = rng.pick(running);
						if (sandbox !== undefined) {
							await done(() => client().stopSandbox(sandbox.id, { keepMemory: rng.next() < 0.5, wait: true }));
						}
						break;
					}
					case "resume": {
						const sandbox = rng.pick(stopped);
						if (sandbox !== undefined) await done(() => client().resumeSandbox(sandbox.id, { wait: true }));
						break;
					}
					case "fail": {
						// A fork whose create failed: never placed, it is to be made from its source (still there, as a create
						// that failed after it adopted its source would find it).
						const ready = new Set(snapshots.map((record) => record.id));
						const sandbox = rng.pick(
							sandboxes.filter((each) => each.source?.snapshotId !== undefined && ready.has(each.source.snapshotId)),
						);
						if (sandbox !== undefined) {
							await base.sandboxes.update(sandbox.id, (current) => ({
								...current,
								state: "error",
								hostId: undefined,
								latestSnapshotId: undefined,
							}));
						}
						break;
					}
					case "advance":
						clock.at += Math.floor(rng.next() * 3 * 24 * 3_600_000);
						break;
					default: {
						clock.at += SNAPSHOT_EXPIRY_EVERY_MS;
						const api = rng.pick(gateways) ?? gateways[0];
						await done(async () => {
							await api.service.sweep();
						});
					}
				}
			};
			await Promise.all(actions.map(act));
			faults.on = false;
			expect(violations).toEqual([]);
			await check(`step ${step} (${action})`);
		}
		// Everything settles once nothing fails: no delete left under way, and no bytes nothing names.
		faults.on = false;
		for (let round = 0; round < 4; round += 1) {
			clock.at += RETIRE_LEASE_MS + SNAPSHOT_EXPIRY_EVERY_MS;
			for (const api of gateways) {
				await api.service.sweep();
				await api.service.idle();
			}
			await check(`settling round ${round}`);
		}
		expect(violations).toEqual([]);
		const records = await base.snapshots.list();
		const settling = records.filter((record) => record.state === "deleting");
		expect(
			settling.map((record) => record.id),
			`seed ${seed}: deletes left settling`,
		).toEqual([]);
		const named = new Set(records.flatMap((record) => (record.ref === undefined ? [] : [record.ref])));
		const leaked = [...seen].filter((ref) => !named.has(ref) && !deleted.has(ref) && !refsDeletedByHand.has(ref));
		expect(leaked, `seed ${seed}: bytes no record names`).toEqual([]);
	}

	// KANTEL_SNAPSHOT_SEEDS runs more (200, say) locally.
	const seeds = Number(process.env.KANTEL_SNAPSHOT_SEEDS ?? 16);
	for (let seed = 1; seed <= seeds; seed += 1) {
		it(`keeps every snapshot something names and leaks no bytes (seed ${seed})`, async () => {
			await run(seed);
		});
	}
});

describe.each(STORES)("saves at once against a host's limit, stored $name", sqlTimeout, ({ make }) => {
	it("never lets saves on two gateways at once past the limit together, and releases the refused ones' bytes", async () => {
		const store = await make();
		const { backend, next, released, takes } = sizedBackend();
		const one = setup(backend, { store });
		const two = setup(backend, { store });
		const a = await one.tom.createSandbox({ autoStopMinutes: null, wait: true });
		const b = await two.tom.createSandbox({ autoStopMinutes: null, wait: true });
		next.bytes = 40 * MiB;
		await one.tom.saveSnapshot({ name: "base", sandboxId: a.id });
		await one.root.updateHost(STUB_HOST_ID, { savedSnapshotBytesLimit: 50 * MiB });

		// Two live saves of 8 MiB, each through its own gateway, both taken before either is stored: only one fits.
		next.bytes = 8 * MiB;
		const before = takes.count;
		let open = () => {};
		takes.gate = new Promise((resolve) => {
			open = resolve;
		});
		const saving = Promise.allSettled([
			one.tom.saveSnapshot({ name: "a", sandboxId: a.id }),
			two.tom.saveSnapshot({ name: "b", sandboxId: b.id }),
		]);
		while (takes.count < before + 2) await new Promise((resolve) => setTimeout(resolve, 5));
		open();
		const results = await saving;
		const saved = results.filter((result) => result.status === "fulfilled");
		const refused = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		expect(saved.length).toBeLessThanOrEqual(1);
		expect(refused.length).toBeGreaterThanOrEqual(1);
		for (const reason of refused) expect((reason as KantelApiError).code).toBe("exhausted");
		const kept = (await store.snapshots.list({ kind: "saved" })).filter((snapshot) => snapshot.state !== "deleting");
		expect(kept.every((snapshot) => snapshot.state === "ready")).toBe(true);
		expect(kept.reduce((total, snapshot) => total + (snapshot.sizeBytes ?? 0), 0)).toBeLessThanOrEqual(50 * MiB);
		// Each refused one's new bytes went again, and its record with them.
		expect(released).toHaveLength(refused.length);
		expect(await store.snapshots.list({ state: "deleting" })).toEqual([]);
	});
});
