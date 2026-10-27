import { type CallContext, type ExecRequest, systemContext } from "@harbour/contracts";
import {
	createInProcessIsolateBackend,
	runShell,
	type ShellRequest,
	type WorkspacePort,
} from "@harbour/sandbox/isolate";
import { usageReport } from "@harbour/sandbox/sweeper";
import { containerWins, createTieredSandboxes, type IsolateBackend } from "@harbour/sandbox/tiered";
import { ManualClock, RecordingAuditSink } from "@harbour/testing/harness";
import { createMemoryProjectFiles } from "@harbour/workspace/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces, type StoredWorkspaces } from "@harbour/workspace/stored";
import { defineCommand } from "just-bash/browser";
import { describe, expect, it } from "vitest";
import { SimulatedContainer } from "./backends.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const SWEEP = systemContext("sandbox.test");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEED = {
	name: "s",
	sources: [{ kind: "files" as const, files: { "docs/one.md": "one", "top.txt": "top" } }],
};

interface SetUpOptions {
	/** Wraps the real in-process isolate backend. */
	readonly isolate?: (
		inner: IsolateBackend,
		deps: { clock: ManualClock; workspaces: StoredWorkspaces },
	) => IsolateBackend;
	/** Seeds the workspace; true by default. */
	readonly seeded?: boolean;
	/** Wraps the stored workspaces the sandboxes (and only they) use. */
	readonly sandboxWorkspaces?: (inner: StoredWorkspaces) => StoredWorkspaces;
}

async function setUp(options: SetUpOptions = {}) {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const projectFiles = createMemoryProjectFiles();
	const projectVersion = await projectFiles.seed("proj-1", { "README.md": "readme", "src/a.ts": "a" });
	const workspaces = createStoredWorkspaces({
		store: createMemoryWorkspaceStore(),
		clock,
		audit,
		sources: [projectFiles],
	});
	const record = await workspaces.create(ctx, {
		owner: { kind: "organisation", organisationId: "org-1" },
		...(options.seeded === false ? {} : { seed: SEED }),
		mounts: [{ path: "/project", source: "project-files", ref: "proj-1" }],
	});
	const container = new SimulatedContainer(workspaces);
	const inner = createInProcessIsolateBackend(workspaces);
	const isolate = options.isolate?.(inner, { clock, workspaces }) ?? inner;
	const sandboxes = createTieredSandboxes({
		workspaces: options.sandboxWorkspaces?.(workspaces) ?? workspaces,
		isolate,
		container,
		clock,
		audit,
	});
	const workspaceId = record.id;
	const run = (command: string) =>
		sandboxes.run(ctx, { sessionId: "sess-1", workspaceId, tool: "bash", request: { command } });
	const head = async () => (await workspaces.get(ctx, workspaceId)).head;
	const text = async (path: string) => decoder.decode((await workspaces.read(ctx, workspaceId, path)).content);
	const acquire = (tier: "isolate" | "container", ttlMs?: number) =>
		sandboxes.acquire(ctx, { sessionId: "sess-1", workspaceId, tier, ...(ttlMs === undefined ? {} : { ttlMs }) });
	return {
		clock,
		audit,
		projectFiles,
		projectVersion,
		workspaces,
		workspaceId,
		container,
		sandboxes,
		run,
		head,
		text,
		acquire,
	};
}

interface Slot {
	interfere: (() => Promise<unknown>) | undefined;
}

/** An isolate backend that runs `interfere` (once) after the command and before the sandboxes commit its changes. */
function interfering(slot: Slot) {
	return (inner: IsolateBackend): IsolateBackend => ({
		async exec(input) {
			const output = await inner.exec(input);
			const interfere = slot.interfere;
			slot.interfere = undefined;
			if (interfere !== undefined) await interfere();
			return output;
		},
	});
}

interface Gate {
	/** Settles when something first waits at the gate. */
	readonly reached: Promise<void>;
	open(): void;
	wait(): Promise<void>;
}

/** A pause the test controls: `wait` blocks until `open`. */
function gate(): Gate {
	let open: () => void = () => undefined;
	let reach: () => void = () => undefined;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return {
		reached,
		open: () => open(),
		async wait() {
			reach();
			await opened;
		},
	};
}

/** Stored workspaces whose `history` (read only when an isolate commit is re-based) waits at `paused` first. */
function pausingHistory(paused: Gate) {
	return (inner: StoredWorkspaces): StoredWorkspaces =>
		new Proxy(inner, {
			get(target, property, receiver) {
				if (property === "history") {
					return async (...args: Parameters<StoredWorkspaces["history"]>) => {
						await paused.wait();
						return target.history(...args);
					};
				}
				const value: unknown = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
}

/** Makes the container's `pending` wait at `paused` after taking its snapshot. */
function pausePending(container: SimulatedContainer, paused: Gate): void {
	const pending = container.pending.bind(container);
	container.pending = async (input, options) => {
		const snapshot = await pending(input, options);
		await paused.wait();
		return snapshot;
	};
}

describe("tiered sandboxes: one tree in both directions", () => {
	it("lets the container see the isolate's last write before its next command", async () => {
		const { run } = await setUp();
		const first = await run("git --version");
		expect(first.tier).toBe("container");
		const wrote = await run("printf '%s' 'from isolate' > shared.txt");
		expect(wrote.tier).toBe("isolate");
		const seen = await run("git --version && cat shared.txt");
		expect(seen.leaseId).toBe(first.leaseId);
		expect(seen.baseVersion).toBe(wrote.workspaceVersion);
		expect(seen.stdout.endsWith("from isolate")).toBe(true);
	});

	it("lets the isolate see the container's write after a run-to-isolate checkpoint, keeping the lease live", async () => {
		const { sandboxes, container, acquire, run, head, text } = await setUp();
		const before = await head();
		const lease = await acquire("container");
		await sandboxes.exec(ctx, lease.id, { command: "printf '%s' 'from container' > c.txt" });
		expect(await head()).toBe(before);

		const seen = await run("cat c.txt");
		expect(seen).toMatchObject({ tier: "isolate", exitCode: 0, stdout: "from container" });
		expect(await head()).toBe(before + 1);
		expect(container.pendingPaths(lease.id)).toEqual([]);
		const live = await sandboxes.leases(ctx, { sessionId: "sess-1", live: true });
		expect(live.map((entry) => entry.id)).toContain(lease.id);

		// The container keeps working on top of its checkpoint.
		await sandboxes.exec(ctx, lease.id, { command: "printf '%s' ' and more' >> c.txt" });
		expect(await text("c.txt")).toBe("from container");
		await sandboxes.release(ctx, lease.id);
		expect(await head()).toBe(before + 2);
		expect((await run("cat c.txt")).stdout).toBe("from container and more");
	});

	it("lets the isolate see the container's write after the container lease is released", async () => {
		const { sandboxes, audit, acquire, run, head } = await setUp();
		const before = await head();
		const lease = await acquire("container");
		await sandboxes.exec(ctx, lease.id, { command: "mkdir -p notes && printf '%s' 'released' > notes/r.txt" });
		const ended = await sandboxes.release(ctx, lease.id);
		expect(ended.endReason).toBe("released");
		expect(await head()).toBe(before + 1);
		const released = audit.ofType("sandbox.lease.released").find((event) => event.subject?.id === lease.id);
		expect(released?.data).toMatchObject({ reason: "released", committedVersion: before + 1 });
		expect((await run("cat notes/r.txt")).stdout).toBe("released");
	});
});

describe("tiered sandboxes: isolate commits", () => {
	it("re-bases an isolate commit on a moved head when none of its paths changed", async () => {
		const slot: Slot = { interfere: undefined };
		const { sandboxes, workspaces, workspaceId, acquire, head, text } = await setUp({ isolate: interfering(slot) });
		const lease = await acquire("isolate");
		const before = await head();
		slot.interfere = () =>
			workspaces.commit(ctx, workspaceId, {
				baseVersion: before,
				changes: [{ op: "put", path: "other.txt", content: encoder.encode("other") }],
			});
		const result = await sandboxes.exec(ctx, lease.id, { command: "printf '%s' mine > mine.txt" });
		expect(result.baseVersion).toBe(before);
		expect(result.workspaceVersion).toBe(before + 2);
		expect(await head()).toBe(before + 2);
		expect(await text("mine.txt")).toBe("mine");
		expect(await text("other.txt")).toBe("other");
	});

	it("fails with conflict, committing nothing, when another writer changed the same path meanwhile", async () => {
		const slot: Slot = { interfere: undefined };
		const { sandboxes, workspaces, workspaceId, acquire, head, text } = await setUp({ isolate: interfering(slot) });
		const lease = await acquire("isolate");
		const before = await head();
		slot.interfere = () =>
			workspaces.commit(ctx, workspaceId, {
				baseVersion: before,
				changes: [{ op: "put", path: "top.txt", content: encoder.encode("theirs") }],
			});
		await expect(sandboxes.exec(ctx, lease.id, { command: "printf '%s' mine > top.txt" })).rejects.toMatchObject({
			code: "conflict",
		});
		expect(await head()).toBe(before + 1);
		expect(await text("top.txt")).toBe("theirs");
	});

	it("treats an append to a file another writer deleted meanwhile as a conflict", async () => {
		const slot: Slot = { interfere: undefined };
		const { sandboxes, workspaces, workspaceId, acquire, head } = await setUp({ isolate: interfering(slot) });
		const lease = await acquire("isolate");
		const before = await head();
		slot.interfere = () =>
			workspaces.commit(ctx, workspaceId, { baseVersion: before, changes: [{ op: "delete", path: "docs/one.md" }] });
		await expect(sandboxes.exec(ctx, lease.id, { command: "printf '%s' x >> docs/one.md" })).rejects.toMatchObject({
			code: "conflict",
		});
		expect(await head()).toBe(before + 1);
	});

	it("never commits a command's changes when the lease expired while it ran", async () => {
		const { sandboxes, acquire, head, workspaces, workspaceId } = await setUp({
			isolate: (inner, { clock }) => ({
				async exec(input) {
					const output = await inner.exec(input);
					clock.advance(2_000);
					return output;
				},
			}),
		});
		const lease = await acquire("isolate", 1_000);
		const before = await head();
		await expect(sandboxes.exec(ctx, lease.id, { command: "printf late > late.txt" })).rejects.toMatchObject({
			code: "expired",
		});
		expect(await head()).toBe(before);
		await expect(workspaces.read(ctx, workspaceId, "late.txt")).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("tiered sandboxes: nothing commits after expiry", () => {
	it("commits nothing when a container lease passes its TTL while its release waits on pending", async () => {
		const { sandboxes, container, clock, audit, acquire, head, workspaces, workspaceId } = await setUp();
		const lease = await acquire("container", 1_000);
		await sandboxes.exec(ctx, lease.id, { command: "printf late > late.txt" });
		const before = await head();
		const paused = gate();
		pausePending(container, paused);
		const releasing = sandboxes.release(ctx, lease.id);
		await paused.reached;
		clock.advance(1_500);
		paused.open();
		await expect(releasing).rejects.toMatchObject({ code: "expired" });
		expect(await head()).toBe(before);
		await expect(workspaces.read(ctx, workspaceId, "late.txt")).rejects.toMatchObject({ code: "not_found" });
		expect(container.endedCalls).toEqual([{ leaseId: lease.id, discard: true }]);
		const released = audit.ofType("sandbox.lease.released");
		expect(released).toHaveLength(1);
		expect(released[0]?.data).toMatchObject({ reason: "expired" });
	});

	it("lets the sweep end an expired lease whose release hangs, and the release then commits nothing", async () => {
		const { sandboxes, container, clock, audit, acquire, head } = await setUp();
		const lease = await acquire("container", 1_000);
		await sandboxes.exec(ctx, lease.id, { command: "printf late > late.txt" });
		const before = await head();
		const paused = gate();
		pausePending(container, paused);
		const releasing = sandboxes.release(ctx, lease.id);
		await paused.reached;
		clock.advance(1_500);
		const swept = await sandboxes.sweep(SWEEP);
		expect(swept.map((ended) => [ended.id, ended.endReason])).toEqual([[lease.id, "expired"]]);
		expect(container.endedCalls).toEqual([{ leaseId: lease.id, discard: true }]);
		paused.open();
		await expect(releasing).rejects.toMatchObject({ code: "expired", details: { endReason: "expired" } });
		expect(await head()).toBe(before);
		expect(container.endedCalls).toHaveLength(1);
		expect(audit.ofType("sandbox.lease.released")).toHaveLength(1);
	});

	it("commits nothing from a run-to-isolate checkpoint whose container lease expires meanwhile", async () => {
		const { sandboxes, container, clock, acquire, run, head, workspaces, workspaceId } = await setUp();
		const lease = await acquire("container", 1_000);
		await sandboxes.exec(ctx, lease.id, { command: "printf late > late.txt" });
		const before = await head();
		const paused = gate();
		pausePending(container, paused);
		const running = run("cat top.txt");
		await paused.reached;
		clock.advance(1_500);
		paused.open();
		await expect(running).rejects.toMatchObject({ code: "expired" });
		expect(await head()).toBe(before);
		await expect(workspaces.read(ctx, workspaceId, "late.txt")).rejects.toMatchObject({ code: "not_found" });
		expect(container.endedCalls).toEqual([{ leaseId: lease.id, discard: true }]);
	});

	it("commits nothing when the lease expires while an isolate commit is re-based", async () => {
		const slot: Slot = { interfere: undefined };
		const paused = gate();
		const { sandboxes, workspaces, workspaceId, clock, acquire, head } = await setUp({
			isolate: interfering(slot),
			sandboxWorkspaces: pausingHistory(paused),
		});
		const lease = await acquire("isolate", 1_000);
		const before = await head();
		slot.interfere = () =>
			workspaces.commit(ctx, workspaceId, {
				baseVersion: before,
				changes: [{ op: "put", path: "other.txt", content: encoder.encode("other") }],
			});
		const running = sandboxes.exec(ctx, lease.id, { command: "printf mine > mine.txt" });
		await paused.reached;
		clock.advance(2_000);
		paused.open();
		await expect(running).rejects.toMatchObject({ code: "expired" });
		expect(await head()).toBe(before + 1);
		await expect(workspaces.read(ctx, workspaceId, "mine.txt")).rejects.toMatchObject({ code: "not_found" });
	});

	it("commits nothing when the lease is released while an isolate commit is re-based", async () => {
		const slot: Slot = { interfere: undefined };
		const paused = gate();
		const { sandboxes, workspaces, workspaceId, acquire, head } = await setUp({
			isolate: interfering(slot),
			sandboxWorkspaces: pausingHistory(paused),
		});
		const lease = await acquire("isolate");
		const before = await head();
		slot.interfere = () =>
			workspaces.commit(ctx, workspaceId, {
				baseVersion: before,
				changes: [{ op: "put", path: "other.txt", content: encoder.encode("other") }],
			});
		const running = sandboxes.exec(ctx, lease.id, { command: "printf mine > mine.txt" });
		await paused.reached;
		expect((await sandboxes.release(ctx, lease.id)).endReason).toBe("released");
		paused.open();
		await expect(running).rejects.toMatchObject({ code: "expired", details: { endReason: "released" } });
		expect(await head()).toBe(before + 1);
		await expect(workspaces.read(ctx, workspaceId, "mine.txt")).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("tiered sandboxes: concurrent acquisition", () => {
	it("gives one of two concurrent acquires for a session and tier a conflict", async () => {
		const { sandboxes, acquire } = await setUp();
		const settled = await Promise.allSettled([acquire("container"), acquire("container")]);
		expect(settled.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
		const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
		expect(rejected?.reason).toMatchObject({ code: "conflict" });
		expect(await sandboxes.leases(ctx, { sessionId: "sess-1", live: true })).toHaveLength(1);
	});

	it("shares one lease between two concurrent first runs", async () => {
		const { sandboxes, run } = await setUp();
		const [first, second] = await Promise.all([run("echo one"), run("echo two")]);
		expect(second.leaseId).toBe(first.leaseId);
		expect(await sandboxes.leases(ctx, { sessionId: "sess-1" })).toHaveLength(1);
	});
});

describe("tiered sandboxes: cancellation", () => {
	it("stops an isolate command when the caller cancels, committing nothing", async () => {
		const controller = new AbortController();
		const ran: string[] = [];
		const commands = [
			defineCommand("mark", async (args) => {
				ran.push(args.join(" "));
				return { stdout: "", stderr: "", exitCode: 0 };
			}),
			defineCommand("cancel", async () => {
				controller.abort();
				return { stdout: "", stderr: "", exitCode: 0 };
			}),
		];
		const { sandboxes, acquire, head, workspaces, workspaceId } = await setUp({
			isolate: (_inner, deps) => createInProcessIsolateBackend(deps.workspaces, { commands }),
		});
		const lease = await acquire("isolate");
		const before = await head();
		const cancelling: CallContext = { ...ctx, signal: controller.signal };
		const command = "printf a > a.txt\nmark one\ncancel\nmark two\nprintf b > b.txt";
		await expect(sandboxes.exec(cancelling, lease.id, { command })).rejects.toMatchObject({ code: "aborted" });
		expect(ran).toEqual(["one"]);
		expect(await head()).toBe(before);
		await expect(workspaces.read(ctx, workspaceId, "a.txt")).rejects.toMatchObject({ code: "not_found" });
	});

	it("commits nothing for an isolate command whose caller cancelled as the backend returned", async () => {
		const controller = new AbortController();
		const { sandboxes, acquire, head, workspaces, workspaceId } = await setUp({
			isolate: (inner) => ({
				async exec(input) {
					const output = await inner.exec(input);
					controller.abort();
					return output;
				},
			}),
		});
		const lease = await acquire("isolate");
		const before = await head();
		const cancelling: CallContext = { ...ctx, signal: controller.signal };
		await expect(sandboxes.exec(cancelling, lease.id, { command: "printf a > a.txt" })).rejects.toMatchObject({
			code: "aborted",
		});
		expect(await head()).toBe(before);
		await expect(workspaces.read(ctx, workspaceId, "a.txt")).rejects.toMatchObject({ code: "not_found" });
	});

	it("does not report a cancelled container command as a success", async () => {
		const controller = new AbortController();
		const { sandboxes, container, acquire, head } = await setUp();
		const lease = await acquire("container");
		const before = await head();
		const containerExec = container.exec.bind(container);
		container.exec = async (input) => {
			const output = await containerExec(input);
			controller.abort();
			return output;
		};
		const cancelling: CallContext = { ...ctx, signal: controller.signal };
		await expect(sandboxes.exec(cancelling, lease.id, { command: "printf c > c.txt" })).rejects.toMatchObject({
			code: "aborted",
		});
		expect(await head()).toBe(before);
		// As for any container command, its changes stay in the container until the lease is released.
		expect(container.pendingPaths(lease.id)).toEqual(["c.txt"]);
	});
});

describe("tiered sandboxes: expiry", () => {
	it("discards an expired container lease on release instead of committing it", async () => {
		const { sandboxes, container, clock, audit, acquire, head, workspaces, workspaceId } = await setUp();
		const lease = await acquire("container", 1_000);
		await sandboxes.exec(ctx, lease.id, { command: "printf lost > lost.txt" });
		const before = await head();
		clock.advance(1_500);
		const ended = await sandboxes.release(ctx, lease.id);
		expect(ended.endReason).toBe("expired");
		expect(await head()).toBe(before);
		await expect(workspaces.read(ctx, workspaceId, "lost.txt")).rejects.toMatchObject({ code: "not_found" });
		expect(container.endedCalls).toEqual([{ leaseId: lease.id, discard: true }]);
		const released = audit.ofType("sandbox.lease.released");
		expect(released).toHaveLength(1);
		expect(released[0]?.data).toMatchObject({ reason: "expired", heldMs: 1_500 });
		expect(released[0]?.data).not.toHaveProperty("committedVersion");
	});

	it("tells the container backend to discard when the sweep ends a lease", async () => {
		const { sandboxes, container, clock, acquire, head } = await setUp();
		const lease = await acquire("container", 1_000);
		await sandboxes.exec(ctx, lease.id, { command: "printf lost > lost.txt" });
		const before = await head();
		clock.advance(1_000);
		const swept = await sandboxes.sweep(SWEEP);
		expect(swept.map((ended) => [ended.id, ended.endReason])).toEqual([[lease.id, "expired"]]);
		expect(container.endedCalls).toEqual([{ leaseId: lease.id, discard: true }]);
		expect(await head()).toBe(before);
		expect(await sandboxes.sweep(SWEEP)).toEqual([]);
		expect(container.endedCalls).toHaveLength(1);
	});

	it("ends a lease it finds expired on exec, discarding the container's changes", async () => {
		const { sandboxes, container, clock, audit, acquire } = await setUp();
		const lease = await acquire("container", 1_000);
		await sandboxes.exec(ctx, lease.id, { command: "printf lost > lost.txt" });
		clock.advance(2_000);
		await expect(sandboxes.exec(ctx, lease.id, { command: "true" })).rejects.toMatchObject({ code: "expired" });
		expect(container.endedCalls).toEqual([{ leaseId: lease.id, discard: true }]);
		// Ending it again (the sweep, a release) neither calls the backend nor audits again.
		expect(await sandboxes.sweep(SWEEP)).toEqual([]);
		expect((await sandboxes.release(ctx, lease.id)).endReason).toBe("expired");
		expect(container.endedCalls).toHaveLength(1);
		expect(audit.ofType("sandbox.lease.released")).toHaveLength(1);
	});

	it("ends an expired container lease found by run before acquiring a new one", async () => {
		const { container, clock, acquire, run } = await setUp();
		const lease = await acquire("container", 1_000);
		clock.advance(1_000);
		const next = await run("git --version");
		expect(next.leaseId).not.toBe(lease.id);
		expect(container.endedCalls).toEqual([{ leaseId: lease.id, discard: true }]);
	});

	it("tells the container backend to keep (commit) the changes of a lease released in time", async () => {
		const { sandboxes, container, acquire } = await setUp();
		const lease = await acquire("container");
		await sandboxes.exec(ctx, lease.id, { command: "printf kept > kept.txt" });
		await sandboxes.release(ctx, lease.id);
		expect(container.endedCalls).toEqual([{ leaseId: lease.id, discard: false }]);
	});
});

describe("tiered sandboxes: usage", () => {
	it("reports held and busy time per tier", async () => {
		const { sandboxes, container, clock, audit, run } = await setUp({
			isolate: (inner, deps) => ({
				async exec(input) {
					deps.clock.advance(40);
					return inner.exec(input);
				},
			}),
		});
		const containerExec = container.exec.bind(container);
		container.exec = async (input) => {
			clock.advance(100);
			return containerExec(input);
		};
		const first = await run("true");
		expect(first.durationMs).toBe(40);
		await run("echo again");
		const git = await run("git --version");
		expect(git.durationMs).toBe(100);
		clock.advance(20);
		const usage = await sandboxes.usage(ctx, "sess-1");
		expect(usage).toEqual([
			{ tier: "isolate", leases: 1, heldMs: 200, busyMs: 80 },
			{ tier: "container", leases: 1, heldMs: 120, busyMs: 100 },
		]);
		expect(usageReport(usage)).toEqual([
			{ tier: "isolate", leases: 1, heldMs: 200, busyMs: 80, boundRatio: 0.4 },
			{ tier: "container", leases: 1, heldMs: 120, busyMs: 100, boundRatio: 100 / 120 },
		]);
		await sandboxes.release(ctx, git.leaseId);
		const released = audit.ofType("sandbox.lease.released").find((event) => event.subject?.id === git.leaseId);
		expect(released?.data).toMatchObject({ tier: "container", heldMs: 120, busyMs: 100 });
	});

	it("reports per-phase timings and the version a command ran on", async () => {
		const { run, head } = await setUp();
		const before = await head();
		const result = await run("printf '%s' t > t.txt");
		expect(result.baseVersion).toBe(before);
		expect(result.workspaceVersion).toBe(before + 1);
		for (const phase of ["isolate.manifest", "isolate.exec", "isolate.scan", "isolate.commit", "isolate.total"]) {
			expect(typeof result.timings[phase], phase).toBe("number");
		}
	});
});

describe("tiered sandboxes: the isolate shell", () => {
	async function isolateExec() {
		const fixture = await setUp();
		const lease = await fixture.acquire("isolate");
		const exec = (command: string, extra: Omit<ExecRequest, "command"> = {}) =>
			fixture.sandboxes.exec(ctx, lease.id, { command, ...extra });
		return { ...fixture, exec };
	}

	it("runs pipes and jq", async () => {
		const { exec, text } = await isolateExec();
		const json = '{"items":[{"n":1},{"n":2},{"n":3}]}';
		const counted = await exec(`printf '%s' '${json}' > data.json && jq '.items | length' data.json`);
		expect(counted).toMatchObject({ exitCode: 0, stdout: "3\n" });
		expect(await text("data.json")).toBe(json);
		expect((await exec("cat data.json | jq -r '.items[].n' | sort -r | head -n 1")).stdout).toBe("3\n");
		expect((await exec("echo hello world | tr a-z A-Z")).stdout).toBe("HELLO WORLD\n");
		expect((await exec("cat docs/one.md top.txt | wc -c")).stdout.trim()).toBe("6");
		expect((await exec("cat", { stdin: "piped" })).stdout).toBe("piped");
		expect((await exec("ls", { cwd: "docs" })).stdout.trim()).toBe("one.md");
	});

	it("has no git, and propagates exit codes", async () => {
		const { exec } = await isolateExec();
		const git = await exec("git --version");
		expect(git.exitCode).toBe(127);
		expect(git.stderr).toContain("not found");
		expect((await exec("true && exit 7")).exitCode).toBe(7);
		expect((await exec("false || exit 4")).exitCode).toBe(4);
	});

	it("reads /project but refuses every write under it", async () => {
		const { exec, head, text, projectFiles, projectVersion } = await isolateExec();
		const before = await head();
		expect((await exec("cat /project/README.md")).stdout).toBe("readme");
		expect((await exec("ls /project")).stdout.split(/\s+/).filter(Boolean)).toEqual(["README.md", "src"]);
		for (const command of [
			"printf x > /project/README.md",
			"printf x >> /project/README.md",
			"mkdir -p /project/new",
			"rm /project/README.md",
			"touch /project/src/b.ts",
			"cp top.txt /project/top.txt",
			"mv top.txt /project/top.txt",
		]) {
			const result = await exec(command);
			expect(result.exitCode, command).not.toBe(0);
		}
		const redirect = await exec("printf x > /project/README.md");
		expect(redirect.stderr).toContain("Read-only file system");
		expect(await head()).toBe(before);
		expect(await text("/project/README.md")).toBe("readme");
		expect(await text("top.txt")).toBe("top");
		expect(decoder.decode(await projectFiles.read(ctx, "proj-1", projectVersion, "README.md"))).toBe("readme");

		// A recursive copy onto the mount neither changes it nor escapes as a commit under /project.
		const copied = await exec(
			"mkdir -p payload/project && printf changed > payload/project/README.md; cp -r payload/. /; cat /project/README.md",
		);
		expect(copied.stdout).toBe("readme");
		expect(await text("payload/project/README.md")).toBe("changed");
		expect(await text("/project/README.md")).toBe("readme");
	});

	it("keeps mode bits across commits", async () => {
		const { exec, workspaces, workspaceId } = await isolateExec();
		await exec("printf '#!/bin/sh\\necho hi\\n' > run.sh && chmod 755 run.sh");
		const listed = await workspaces.list(ctx, workspaceId, { recursive: true });
		expect(listed.items.find((entry) => entry.path === "run.sh")?.mode).toBe(0o755);
	});
});

describe("tiered sandboxes: the container protocol", () => {
	it("keeps a command that runs between pending and committed pending", async () => {
		const { container, acquire, workspaces, workspaceId } = await setUp();
		const lease = await acquire("container");
		const record = await workspaces.get(ctx, workspaceId);
		await container.exec({ ctx, lease, record, request: { command: "printf one > first" } });
		const pending = await container.pending({ ctx, lease, record });
		await container.exec({ ctx, lease, record, request: { command: "printf two > second" } });
		await container.committed(lease, record.head + 1, pending.stamp);
		const after = await container.pending({ ctx, lease, record });
		expect(after.changes.map((change) => change.path)).toEqual(["second"]);
	});

	it("runs no more commands on a lease once release has taken its final snapshot", async () => {
		const { sandboxes, container, acquire, workspaces, workspaceId } = await setUp({ seeded: false });
		const lease = await acquire("container");
		await sandboxes.exec(ctx, lease.id, { command: "printf a > a" });
		let late: Promise<unknown> = Promise.resolve("not attempted");
		const original = container.pending.bind(container);
		container.pending = async (input, options) => {
			const snapshot = await original(input, options);
			if (options?.final === true) {
				late = container.exec({ ...input, request: { command: "printf b > b" } }).then(
					() => "ran",
					(error: Error) => error.message,
				);
			}
			return snapshot;
		};
		await sandboxes.release(ctx, lease.id);
		expect(await late).toMatch(/being released/);
		const record = await workspaces.get(ctx, workspaceId);
		await expect(container.exec({ ctx, lease, record, request: { command: "printf c > c" } })).rejects.toThrow(
			/has ended/,
		);
		const files = await workspaces.list(ctx, workspaceId, { recursive: true });
		expect(files.items.map((entry) => entry.path)).toEqual(["a"]);
	});

	it("leaves the lease live when container cleanup fails, so release can be retried", async () => {
		const { sandboxes, container, acquire } = await setUp();
		const lease = await acquire("container");
		const original = container.ended.bind(container);
		let failures = 1;
		container.ended = async (...args) => {
			if (failures-- > 0) throw new Error("container unreachable");
			return original(...args);
		};
		await expect(sandboxes.release(ctx, lease.id)).rejects.toThrow(/unreachable/);
		expect((await sandboxes.leases(ctx, { sessionId: "sess-1", live: true })).map((live) => live.id)).toEqual([
			lease.id,
		]);
		const ended = await sandboxes.release(ctx, lease.id);
		expect(ended.endedAt).toBeDefined();
	});

	it("lets the container's tree win over a head where file and directory swapped", () => {
		const present = new Set(["a", "b/one", "b/two", "keep"]);
		const changes = containerWins(
			[
				{ op: "put", path: "a/inner", content: new Uint8Array() },
				{ op: "put", path: "b", content: new Uint8Array() },
				{ op: "delete", path: "gone" },
			],
			present,
		);
		expect(changes.map((change) => `${change.op} ${change.path}`).sort()).toEqual([
			"delete a",
			"delete b/one",
			"delete b/two",
			"put a/inner",
			"put b",
		]);
	});
});

describe("the isolate shell over a port", () => {
	const port: WorkspacePort = {
		entries: async () => [],
		mountEntries: async () => [{ kind: "file", path: "/project/README.md", size: 8, version: "1" } as never],
		readBlob: async () => new Uint8Array(),
		readMount: async () => encoder.encode("original"),
	};
	const request = (command: string): ShellRequest => ({
		command,
		baseVersion: 0,
		mounts: [{ path: "/project" }],
	});

	// just-bash's plain `rm alias` refuses a symlink to a directory; `rm -r` removes the link, `ln -sfn` retargets it.
	it.each(["rm -r alias", "ln -sfn other alias"])(
		"commits a file created through a symlink that the command then changes (%s)",
		async (unlink) => {
			const seeded: WorkspacePort = {
				...port,
				entries: async () =>
					["real/.keep", "other/.keep"].map(
						(path) => ({ kind: "file", path, digest: "empty", mode: 0o644, size: 0, version: 0 }) as never,
					),
			};
			const outcome = await runShell(
				seeded,
				request(`ln -s real alias && mktemp alias/t.XXXXXX > /dev/null && ${unlink} && ls real`),
			);
			expect(outcome.stderr).toBe("");
			expect(outcome.exitCode).toBe(0);
			const files = outcome.changes.filter((change) => change.op === "put").map((change) => change.path);
			expect(files).toEqual(expect.arrayContaining([expect.stringMatching(/^real\/t\.\w{6}$/)]));
		},
	);

	it("rejects with aborted, running nothing, when the caller has already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runShell(port, request("echo x"), { signal: controller.signal })).rejects.toMatchObject({
			code: "aborted",
		});
	});

	it("refuses a mount over the shell's own paths", async () => {
		const outcome = await runShell(port, { command: "cat /bin/echo", baseVersion: 0, mounts: [{ path: "/bin" }] });
		expect(outcome.exitCode).toBe(1);
		expect(outcome.stderr).toMatch(/cannot mount \/bin/);
	});

	it("fails a redirect onto a mount as read-only", async () => {
		const outcome = await runShell(port, request("echo x > /project/README.md"));
		expect(outcome.exitCode).toBe(1);
		expect(outcome.stderr).toBe("bash: /project/README.md: Read-only file system\n");
		expect(outcome.changes).toEqual([]);
	});
});
