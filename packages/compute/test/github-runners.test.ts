import { createKantelClient } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import type { KeyPrincipal } from "../src/auth.ts";
import { importAppKey } from "../src/github-app.ts";
import {
	CAPACITY_BACKOFF_MS,
	createGithubRunners,
	IDLE_GRACE_MS,
	poolFor,
	RUNNER_LABEL,
	type RunnerPool,
	type RunnerSandboxes,
	type StoredGithubRunners,
} from "../src/github-runners.ts";
import { createComputeApi } from "../src/http.ts";
import { createEphemeralSealer } from "../src/secrets.ts";
import { createMemoryStore } from "../src/store.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const POOL: RunnerPool = { label: "kantel-8vcpu", template: "ci", resources: { vcpus: 8, memoryMb: 16_384 } };
const PRINCIPAL: KeyPrincipal = {
	kind: "key",
	keyId: "key_runners",
	keyName: "GitHub runners: ci",
	accountId: "acc_org",
	scopes: ["sandboxes:read", "sandboxes:write", "sandboxes:delete", "exec"],
	limits: {},
	userId: "usr_admin",
	superAdmin: false,
};

/**
 * A host fleet's worth of sandboxes in memory: `room` runners fit, and each boots on the next `boot()`. `fail` makes
 * the named call reject, as a host or the store failing would.
 */
function fakeSandboxes(room: { value: number }) {
	const sandboxes = new Map<string, { state: string; placementReason?: string; createdAt: number; labels: object }>();
	const runs: { sandboxId: string; command: string; env: { readonly [name: string]: string } }[] = [];
	const fail = new Set<"get" | "delete" | "run">();
	const deletedBy: string[] = [];
	/** Runner commands that have ended. */
	const ended = new Set<string>();
	const execs: { sandboxId: string; command: string }[] = [];
	const commits: { sandboxId: string; disk: string }[] = [];
	let next = 0;
	const failing = (call: "get" | "delete" | "run") => {
		if (fail.has(call)) throw new KantelError("unavailable", `${call} failed`);
	};
	const api: RunnerSandboxes = {
		async create(_principal, body) {
			if (room.value <= 0) {
				throw new KantelError("exhausted", "No host can take a microVM (full)", { reason: "insufficient_capacity" });
			}
			room.value--;
			const id = `sbx_${++next}`;
			sandboxes.set(id, { state: "starting", createdAt: 0, labels: body.labels ?? {} });
			return { id, state: "starting" };
		},
		async get(_principal, sandboxId) {
			failing("get");
			return sandboxes.get(sandboxId);
		},
		async delete(principal, sandboxId) {
			failing("delete");
			deletedBy.push(principal.keyId);
			if (sandboxes.delete(sandboxId)) room.value++;
		},
		async exec(_principal, sandboxId, command) {
			execs.push({ sandboxId, command });
			return 0;
		},
		async commit(_principal, sandboxId, disk) {
			commits.push({ sandboxId, disk });
		},
		async run(_principal, sandboxId, command, env) {
			failing("run");
			runs.push({ sandboxId, command, env });
			return `cmd_${runs.length}`;
		},
		async commandRunning(_principal, _sandboxId, commandId) {
			return !ended.has(commandId);
		},
		async listMadeBy(_accountId, _keyId, labels) {
			return [...sandboxes]
				.filter(([, sandbox]) =>
					Object.entries(labels).every(([key, value]) => (sandbox.labels as Record<string, string>)[key] === value),
				)
				.map(([id, sandbox]) => ({ id, createdAt: sandbox.createdAt }));
		},
	};
	return {
		api,
		runs,
		sandboxes,
		fail,
		deletedBy,
		ended,
		execs,
		commits,
		/** Every starting sandbox is running now. */
		boot() {
			for (const sandbox of sandboxes.values()) if (sandbox.state === "starting") sandbox.state = "running";
		},
	};
}

/** GitHub's runners as the App sees them: `failRemove` makes removals fail, as an outage would. */
function fakeGithub() {
	const registered: { name: string; labels: readonly string[]; scope: unknown }[] = [];
	const removed: number[] = [];
	const removedFrom: unknown[] = [];
	const state: { failRemove: boolean; onRegister?: (name: string) => Promise<void> } = { failRemove: false };
	const runs = new Map<number, { event: string; headBranch?: string; headRepository?: string }>();
	return {
		registered,
		removed,
		removedFrom,
		state,
		runs,
		app: () => ({
			async generateJitConfig(
				_installation: number,
				scope: unknown,
				runner: { name: string; labels: readonly string[] },
			) {
				await state.onRegister?.(runner.name);
				registered.push({ ...runner, scope });
				return { runnerId: registered.length, encodedJitConfig: `jit-for-${runner.name}` };
			},
			async findRunner(_installation: number, _scope: unknown, name: string) {
				const index = registered.findIndex((runner) => runner.name === name);
				return index < 0 || removed.includes(index + 1) ? undefined : index + 1;
			},
			async removeRunner(_installation: number, scope: unknown, runnerId: number) {
				if (state.failRemove) throw new KantelError("unavailable", "GitHub answered 503");
				removed.push(runnerId);
				removedFrom.push(scope);
			},
			async getRun(_installation: number, _repository: string, runId: number) {
				return runs.get(runId);
			},
			async getJob() {
				return { status: "in_progress" };
			},
		}),
	};
}

async function setUp(
	options: {
		room?: number;
		repositories?: string[];
		scope?: "organization" | "repository";
		pool?: Partial<RunnerPool>;
	} = {},
) {
	const store = createMemoryStore();
	const sealer = createEphemeralSealer();
	const clock = { now: 1_000_000 };
	const room = { value: options.room ?? 10 };
	const sandboxes = fakeSandboxes(room);
	const github = fakeGithub();
	const key = { revoked: false };
	/** Runs after each listing of runners, before the pass acts on it: a webhook landing at that moment. */
	const afterListing: { hook?: () => Promise<void> } = {};
	const machines = store.githubRunnerMachines;
	const watched = {
		...store,
		githubRunnerMachines: {
			...machines,
			async list(where?: Parameters<typeof machines.list>[0]) {
				const listed = await machines.list(where);
				await afterListing.hook?.();
				return listed;
			},
		},
	};
	const broker = (gatewayId: string) =>
		createGithubRunners({
			store: watched,
			now: () => clock.now,
			sealer: () => sealer,
			sandboxes: sandboxes.api,
			principalOf: async (keyId) => (keyId === PRINCIPAL.keyId && !key.revoked ? PRINCIPAL : undefined),
			cleanupPrincipalOf: async (keyId) => (keyId === PRINCIPAL.keyId ? PRINCIPAL : undefined),
			github: github.app,
			gatewayId,
		});
	const runners = broker("gw_one");
	const sealed = await runners.seal("ghr_one", "unused in these tests: the App is a stand-in");
	const record: StoredGithubRunners = {
		id: "ghr_one",
		accountId: "acc_org",
		name: "ci",
		appId: 1,
		owner: "octo-org",
		scope: options.scope ?? "organization",
		...(options.scope === "repository" ? {} : { runnerGroupId: 7 }),
		...(options.repositories === undefined ? {} : { repositories: options.repositories }),
		pools: [{ ...POOL, ...options.pool }],
		enabled: true,
		keyId: PRINCIPAL.keyId,
		privateKey: sealed.privateKey,
		webhookSecret: sealed.webhookSecret,
		createdAt: clock.now,
		updatedAt: clock.now,
	};
	await store.githubRunners.put(record);
	const deliver = async (event: string, payload: object, secret = sealed.secret) => {
		const body = JSON.stringify(payload);
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
		const signature = `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		return runners.receive(
			"ghr_one",
			new Request("https://kantel.example/v1/github-runners/ghr_one/webhook", {
				method: "POST",
				headers: { "x-github-event": event, "x-hub-signature-256": signature },
				body,
			}),
		);
	};
	const job = (action: string, id: number, extra: object = {}, repository = "octo-org/app") =>
		deliver("workflow_job", {
			action,
			installation: { id: 42 },
			repository: { full_name: repository },
			workflow_job: { id, run_id: 900, name: `job ${id}`, labels: ["kantel-8vcpu"], ...extra },
		});
	const status = async () => {
		const record = await store.githubRunners.get("ghr_one");
		if (record === undefined) throw new Error("gone");
		return (await runners.view(record, "https://kantel.example/hook", true)).status?.[0];
	};
	return { store, clock, room, sandboxes, github, runners, broker, key, deliver, job, status, afterListing };
}

describe("GitHub runners", () => {
	it("picks a pool only when the runner would have every label the job asks for", () => {
		expect(poolFor([POOL], ["kantel-8vcpu"])?.label).toBe("kantel-8vcpu");
		expect(poolFor([POOL], ["self-hosted", "Linux", "kantel-8vcpu"])?.label).toBe("kantel-8vcpu");
		expect(poolFor([POOL], ["ubuntu-latest"])).toBeUndefined();
		expect(poolFor([POOL], ["kantel-8vcpu", "gpu"])).toBeUndefined();
	});

	it("refuses a delivery whose signature isn't the integration's", async () => {
		const { deliver, sandboxes } = await setUp();
		const response = await deliver("workflow_job", { action: "queued" }, "not the secret");
		expect(response.status).toBe(401);
		expect(sandboxes.sandboxes.size).toBe(0);
	});

	it("runs a job on a runner of its own, from queued to its runner's deletion", async () => {
		const { job, sandboxes, github, runners, store, status } = await setUp();
		expect((await job("queued", 1)).status).toBe(200);
		// A runner is made at once, and registered once its sandbox runs.
		expect(sandboxes.sandboxes.size).toBe(1);
		const [sandboxId] = [...sandboxes.sandboxes.keys()];
		expect(sandboxes.sandboxes.get(sandboxId ?? "")?.labels).toMatchObject({ [RUNNER_LABEL]: "ghr_one" });
		sandboxes.boot();
		await runners.tick();
		expect(github.registered).toEqual([
			expect.objectContaining({ name: sandboxId, labels: ["self-hosted", "linux", "x64", "kantel-8vcpu"] }),
		]);
		expect(sandboxes.runs).toEqual([
			expect.objectContaining({ sandboxId, env: { KANTEL_RUNNER_JITCONFIG: `jit-for-${sandboxId}` } }),
		]);
		// A delivery GitHub sends again doesn't make a second runner.
		await job("queued", 1);
		expect(sandboxes.sandboxes.size).toBe(1);
		await job("in_progress", 1, { runner_name: sandboxId });
		expect(await status()).toMatchObject({ queued: 0, busy: 1 });
		await job("completed", 1, { runner_name: sandboxId, conclusion: "success" });
		expect(sandboxes.sandboxes.size).toBe(0);
		expect(await store.githubRunnerMachines.list()).toEqual([]);
		expect(await runners.jobs("ghr_one")).toEqual([
			expect.objectContaining({ id: "1", state: "completed", conclusion: "success", sandboxId }),
		]);
		// GitHub took the ephemeral runner off with its job: nothing to remove.
		expect(github.removed).toEqual([]);
	});

	it("keeps jobs queued while no host has room, and makes their runners as room comes", async () => {
		const { job, sandboxes, runners, clock, room, status } = await setUp({ room: 1 });
		await job("queued", 1);
		await job("queued", 2);
		await job("queued", 3);
		// One fits; the others wait, and the pool backs off rather than trying on every pass.
		expect(sandboxes.sandboxes.size).toBe(1);
		expect(await status()).toMatchObject({ queued: 3, starting: 1, waitingFor: expect.stringContaining("full") });
		room.value = 1;
		clock.now += 1_000;
		await runners.tick();
		expect(sandboxes.sandboxes.size).toBe(1);
		// Once the wait is over, one runner probes for room, then the rest follow.
		clock.now += CAPACITY_BACKOFF_MS;
		await runners.tick();
		expect(sandboxes.sandboxes.size).toBe(2);
		room.value = 5;
		clock.now += CAPACITY_BACKOFF_MS;
		await runners.tick();
		await runners.tick();
		expect(sandboxes.sandboxes.size).toBe(3);
		expect(await status()).toMatchObject({ queued: 3, starting: 3 });
	});

	it("tries again as soon as one of its runners goes, without waiting out the backoff", async () => {
		const { job, sandboxes, runners } = await setUp({ room: 1 });
		await job("queued", 1);
		await job("queued", 2);
		expect(sandboxes.sandboxes.size).toBe(1);
		const [first] = [...sandboxes.sandboxes.keys()];
		sandboxes.boot();
		await runners.tick();
		await job("in_progress", 1, { runner_name: first });
		await job("completed", 1, { runner_name: first });
		// The completed job's runner freed the room, and the same delivery's pass used it.
		expect([...sandboxes.sandboxes.keys()]).toHaveLength(1);
		expect(sandboxes.sandboxes.has(first ?? "")).toBe(false);
		await runners.tick();
		expect(sandboxes.sandboxes.size).toBe(1);
	});

	it("removes a runner no job came for, on GitHub and its sandbox", async () => {
		const { job, sandboxes, runners, clock, github } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		await runners.tick();
		// Cancelled before any runner took it.
		await job("completed", 1, { conclusion: "cancelled" });
		expect(sandboxes.sandboxes.size).toBe(1);
		clock.now += IDLE_GRACE_MS + 1;
		await runners.tick();
		expect(sandboxes.sandboxes.size).toBe(0);
		expect(github.removed).toEqual([1]);
	});

	it("moves a job only forward, whatever order its webhooks come in", async () => {
		const { job, sandboxes, runners } = await setUp();
		await job("completed", 1, { conclusion: "cancelled" });
		await job("queued", 1);
		await job("in_progress", 2);
		await job("queued", 2);
		// Neither late `queued` makes demand: one job ended, the other is running elsewhere.
		expect(sandboxes.sandboxes.size).toBe(0);
		expect((await runners.jobs("ghr_one")).map((item) => [item.id, item.state])).toEqual([
			["2", "in_progress"],
			["1", "completed"],
		]);
	});

	it("counts a repository-scoped integration's runners per repository, each registered on its own", async () => {
		const { job, sandboxes, runners, github } = await setUp({ scope: "repository" });
		await job("queued", 1, {}, "octo-org/a");
		await job("queued", 2, {}, "octo-org/b");
		expect(sandboxes.sandboxes.size).toBe(2);
		sandboxes.boot();
		await runners.tick();
		expect(github.registered.map((runner) => runner.scope)).toEqual([
			{ kind: "repository", repository: "octo-org/a" },
			{ kind: "repository", repository: "octo-org/b" },
		]);
		// A's job ends without its runner: A's spare runner isn't counted for B's next job.
		await job("completed", 1, { conclusion: "cancelled" });
		await job("queued", 3, {}, "octo-org/b");
		expect(sandboxes.sandboxes.size).toBe(3);
	});

	it("runs an integration's pass on one gateway at a time", async () => {
		const { job, sandboxes, broker, store, clock } = await setUp();
		await store.githubRunners.update("ghr_one", (current) => ({
			...current,
			lease: { owner: "gw_other", until: clock.now + 60_000 },
		}));
		await job("queued", 1);
		await broker("gw_two").tick();
		// The other gateway holds the lease: its pass makes the runner, not these.
		expect(sandboxes.sandboxes.size).toBe(0);
		clock.now += 60_001;
		await broker("gw_two").tick();
		expect(sandboxes.sandboxes.size).toBe(1);
	});

	it("takes a runner it registered off GitHub when it can't start it, and keeps trying while GitHub fails", async () => {
		const { job, sandboxes, runners, github, store } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		sandboxes.fail.add("run");
		github.state.failRemove = true;
		await runners.tick();
		// Registered, not started, and GitHub refused its removal: kept, ending, with its sandbox. Its job still waits,
		// so another runner is made for it meanwhile.
		expect(github.registered).toHaveLength(1);
		expect(await store.githubRunnerMachines.list({ state: "ending" })).toEqual([
			expect.objectContaining({ id: "sbx_1", runnerId: 1 }),
		]);
		expect(sandboxes.sandboxes.has("sbx_1")).toBe(true);
		github.state.failRemove = false;
		sandboxes.fail.delete("run");
		await runners.tick();
		expect(github.removed).toContain(1);
		expect(await store.githubRunnerMachines.list({ state: "ending" })).toEqual([]);
	});

	it("finds a runner on GitHub by name when its registration stalled before its ID was kept", async () => {
		const { job, sandboxes, runners, github, store, clock } = await setUp();
		await job("queued", 1);
		const [sandboxId = ""] = [...sandboxes.sandboxes.keys()];
		// A gateway claimed it and registered it with GitHub, then died.
		await store.githubRunnerMachines.update(sandboxId, (current) => ({
			...current,
			state: "registering",
			claimedAt: clock.now,
			registration: { installationId: 42, scope: { kind: "organization", org: "octo-org", runnerGroupId: 7 } },
		}));
		github.registered.push({ name: sandboxId, labels: [], scope: {} });
		clock.now += 3 * 60_000;
		await runners.tick();
		expect(github.removed).toEqual([1]);
		expect(sandboxes.sandboxes.has(sandboxId)).toBe(false);
	});

	it("ends its runners with its key revoked, and makes no more", async () => {
		const { job, sandboxes, runners, key } = await setUp();
		await job("queued", 1);
		key.revoked = true;
		await runners.tick();
		await job("queued", 2);
		expect(sandboxes.sandboxes.size).toBe(0);
		expect(sandboxes.deletedBy).toEqual([PRINCIPAL.keyId]);
	});

	it("keeps a deleted integration, hidden, until its runners have gone", async () => {
		const { job, sandboxes, runners, store, deliver } = await setUp();
		await job("queued", 1);
		sandboxes.fail.add("delete");
		expect(await runners.retire("ghr_one")).toBe(false);
		expect((await deliver("ping", {})).status).toBe(404);
		expect((await store.githubRunners.get("ghr_one"))?.retiringAt).toBeDefined();
		sandboxes.fail.delete("delete");
		await runners.tick();
		expect(await store.githubRunners.get("ghr_one")).toBeUndefined();
		expect(sandboxes.sandboxes.size).toBe(0);
		expect(await store.githubRunnerJobs.list()).toEqual([]);
	});

	it("leaves a runner be when its sandbox can't be read", async () => {
		const { job, sandboxes, runners, store } = await setUp();
		await job("queued", 1);
		sandboxes.fail.add("get");
		await runners.tick();
		expect(await store.githubRunnerMachines.list()).toEqual([expect.objectContaining({ state: "booting" })]);
		expect(sandboxes.sandboxes.size).toBe(1);
	});

	it("keeps waiting for room when a runner's sandbox couldn't be placed after its create", async () => {
		const { job, sandboxes, runners, status } = await setUp();
		await job("queued", 1);
		const [sandboxId = ""] = [...sandboxes.sandboxes.keys()];
		const sandbox = sandboxes.sandboxes.get(sandboxId);
		if (sandbox === undefined) throw new Error("no sandbox");
		sandbox.state = "error";
		sandbox.placementReason = "insufficient_capacity";
		await runners.tick();
		await runners.tick();
		// Dropped, and the pool waits rather than making another at once.
		expect(sandboxes.sandboxes.size).toBe(0);
		expect(await status()).toMatchObject({ queued: 1, starting: 0, waitingFor: expect.any(String) });
	});

	it("refuses a webhook body larger than any delivery before reading it all", async () => {
		const { runners } = await setUp();
		const response = await runners.receive(
			"ghr_one",
			new Request("https://kantel.example/v1/github-runners/ghr_one/webhook", {
				method: "POST",
				headers: { "x-github-event": "workflow_job" },
				body: "x".repeat(1024 * 1024 + 1),
			}),
		);
		expect(response.status).toBe(413);
	});

	it("stops a pass at its next effect once another gateway has taken its lease", async () => {
		const { job, sandboxes, store, clock } = await setUp();
		const create = sandboxes.api.create;
		let first = true;
		sandboxes.api.create = async (principal, body) => {
			const made = await create(principal, body);
			// A slow first create: its lease ran out, and another gateway took it, filled the pool and released it.
			if (first) {
				first = false;
				await store.githubRunners.update("ghr_one", ({ lease: _lease, ...current }) => current);
			}
			return made;
		};
		await store.githubRunners.update("ghr_one", (current) => ({ ...current, installationId: 42 }));
		for (const id of [1, 2, 3]) {
			await store.githubRunnerJobs.insert({
				id: `ghr_one:${id}`,
				integrationId: "ghr_one",
				accountId: "acc_org",
				jobId: id,
				runId: 1,
				repository: "octo-org/app",
				name: "checks",
				labels: ["kantel-8vcpu"],
				pool: "kantel-8vcpu",
				state: "queued",
				queuedAt: clock.now,
				updatedAt: clock.now,
			});
		}
		await job("queued", 4);
		expect(sandboxes.sandboxes.size).toBe(1);
	});

	it("keeps a pool to its limit across repositories", async () => {
		const { job, sandboxes } = await setUp({ scope: "repository", pool: { maxRunners: 1 } });
		await job("queued", 1, {}, "octo-org/a");
		await job("queued", 2, {}, "octo-org/b");
		expect(sandboxes.sandboxes.size).toBe(1);
	});

	it("takes a runner off GitHub when its job ends while it is being registered", async () => {
		const { job, sandboxes, runners, github, store } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		github.state.onRegister = async (name) => {
			// The job's `completed` webhook marks the runner to end while GitHub registers it.
			await store.githubRunnerMachines.update(name, (current) => ({ ...current, state: "ending", endReason: "test" }));
		};
		await runners.tick();
		github.state.onRegister = undefined;
		await runners.tick();
		expect(github.removed).toEqual([1]);
		expect(sandboxes.runs.filter((run) => run.sandboxId === "sbx_1")).toEqual([]);
		expect(await store.githubRunnerMachines.get("sbx_1")).toBeUndefined();
	});

	it("takes a runner off GitHub where it was registered, though the integration has moved since", async () => {
		const { job, sandboxes, runners, github, store, clock } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		await runners.tick();
		await job("completed", 1, { conclusion: "cancelled" });
		await store.githubRunners.update("ghr_one", (current) => ({ ...current, owner: "other-org", runnerGroupId: 9 }));
		clock.now += IDLE_GRACE_MS + 1;
		await runners.tick();
		expect(github.removedFrom).toEqual([{ kind: "organization", org: "octo-org", runnerGroupId: 7 }]);
	});

	it("deletes a runner sandbox whose record was never written before forgetting a deleted integration", async () => {
		const { sandboxes, runners, store } = await setUp();
		const orphan = await sandboxes.api.create(PRINCIPAL, { labels: { [RUNNER_LABEL]: "ghr_one" } });
		expect(await runners.retire("ghr_one")).toBe(true);
		expect(sandboxes.sandboxes.has(orphan.id)).toBe(false);
		expect(await store.githubRunners.get("ghr_one")).toBeUndefined();
	});

	it("replaces an idle runner that can't take a job: its sandbox stopped, or its runner's command ended", async () => {
		for (const kill of ["sandbox", "command"] as const) {
			const { job, sandboxes, runners } = await setUp();
			await job("queued", 1);
			sandboxes.boot();
			await runners.tick();
			const [first = ""] = [...sandboxes.sandboxes.keys()];
			if (kill === "sandbox") {
				const sandbox = sandboxes.sandboxes.get(first);
				if (sandbox !== undefined) sandbox.state = "stopped";
			} else sandboxes.ended.add("cmd_1");
			await runners.tick();
			expect(sandboxes.sandboxes.has(first)).toBe(false);
			expect(sandboxes.sandboxes.size).toBe(1);
		}
	});

	it("keeps a runner GitHub gave a job while it was being ended for want of one", async () => {
		const { job, sandboxes, runners, github, store, clock } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		await runners.tick();
		const [sandboxId = ""] = [...sandboxes.sandboxes.keys()];
		await job("completed", 1, { conclusion: "cancelled" });
		clock.now += IDLE_GRACE_MS + 1;
		// GitHub refuses the removal: it has just given the runner another job.
		github.state.failRemove = true;
		await runners.tick();
		expect((await store.githubRunnerMachines.get(sandboxId))?.state).toBe("ending");
		await job("in_progress", 2, { runner_name: sandboxId });
		github.state.failRemove = false;
		await runners.tick();
		expect((await store.githubRunnerMachines.get(sandboxId))?.state).toBe("busy");
		expect(sandboxes.sandboxes.has(sandboxId)).toBe(true);
	});

	it("lets a runner finish its job when its pool is renamed", async () => {
		const { job, sandboxes, runners, store } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		await runners.tick();
		const [sandboxId = ""] = [...sandboxes.sandboxes.keys()];
		await job("in_progress", 1, { runner_name: sandboxId });
		await store.githubRunners.update("ghr_one", (current) => ({
			...current,
			pools: [{ ...POOL, label: "kantel-16vcpu" }],
		}));
		await runners.tick();
		expect(sandboxes.sandboxes.has(sandboxId)).toBe(true);
		await job("completed", 1, { runner_name: sandboxId, conclusion: "success" });
		await runners.tick();
		expect(sandboxes.sandboxes.has(sandboxId)).toBe(false);
	});

	it("follows a runner made under the old owner to its end after the owner changes, without moving the installation", async () => {
		const { job, sandboxes, runners, store } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		await runners.tick();
		const [sandboxId = ""] = [...sandboxes.sandboxes.keys()];
		await job("in_progress", 1, { runner_name: sandboxId });
		await store.githubRunners.update("ghr_one", ({ installationId: _installation, ...current }) => ({
			...current,
			owner: "new-org",
		}));
		// GitHub gives the same runner another of the old owner's jobs: its job is recorded, for polling to find.
		await job("in_progress", 3, { runner_name: sandboxId });
		expect(await store.githubRunnerJobs.get("ghr_one:3")).toMatchObject({ state: "in_progress", installationId: 42 });
		expect((await job("completed", 1, { runner_name: sandboxId, conclusion: "success" })).status).toBe(200);
		await runners.tick();
		expect(sandboxes.sandboxes.has(sandboxId)).toBe(false);
		expect((await store.githubRunners.get("ghr_one"))?.installationId).toBeUndefined();
		// A new job of the old owner is still nobody's.
		expect((await job("queued", 2)).status).toBe(202);
	});

	it("acts on a delivery only within the installation that sent it, whatever names it carries", async () => {
		const { job, deliver, sandboxes, runners, store } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		await runners.tick();
		const [victim = ""] = [...sandboxes.sandboxes.keys()];
		// Another owner's installation names our runner in its own job's signed `completed`: nothing happens to it.
		const foreign = await deliver("workflow_job", {
			action: "completed",
			installation: { id: 77 },
			repository: { full_name: "attacker/app" },
			workflow_job: {
				id: 500,
				run_id: 1,
				name: "x",
				labels: ["kantel-8vcpu"],
				runner_name: victim,
				conclusion: "success",
			},
		});
		expect(foreign.status).toBe(202);
		expect(sandboxes.sandboxes.has(victim)).toBe(true);
		expect((await store.githubRunnerMachines.get(victim))?.state).toBe("idle");
		// The owner changes while a delivery about a new job of the old owner is in flight: it records nothing.
		await store.githubRunners.update("ghr_one", (current) => ({ ...current, owner: "new-org" }));
		expect((await job("queued", 2)).status).toBe(202);
		expect(await store.githubRunnerJobs.get("ghr_one:2")).toBeUndefined();
	});

	it("forgets an account's runner records whose integration is already gone", async () => {
		const { store, runners, clock } = await setUp();
		await store.githubRunnerMachines.put({
			id: "sbx_stray",
			integrationId: "ghr_gone",
			accountId: "acc_org",
			pool: "kantel-8vcpu",
			state: "idle",
			createdAt: clock.now,
			expiresAt: clock.now + 60_000,
			updatedAt: clock.now,
		});
		await runners.forgetAccount("acc_org");
		expect(await store.githubRunnerMachines.list({ accountId: "acc_org" })).toEqual([]);
		expect(await store.githubRunners.list({ accountId: "acc_org" })).toEqual([]);
	});

	it("leaves a runner that took a job after a pass saw it ending for want of one", async () => {
		const { job, sandboxes, runners, github, store, clock, afterListing } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		await runners.tick();
		const [sandboxId = ""] = [...sandboxes.sandboxes.keys()];
		await job("completed", 1, { conclusion: "cancelled" });
		clock.now += IDLE_GRACE_MS + 1;
		github.state.failRemove = true;
		await runners.tick();
		expect((await store.githubRunnerMachines.get(sandboxId))?.state).toBe("ending");
		github.state.failRemove = false;
		// The next pass lists it ending; GitHub's in_progress lands before that pass acts on it, and does what a webhook
		// does (here straight to the store: a delivery would wait for this pass).
		let once = true;
		afterListing.hook = async () => {
			if (!once) return;
			once = false;
			await store.githubRunnerMachines.update(
				sandboxId,
				({ unused: _unused, endingAt: _at, endReason: _why, ...rest }) => ({
					...rest,
					state: "busy",
					tookJob: true,
					jobId: 2,
				}),
			);
		};
		await runners.tick();
		afterListing.hook = undefined;
		expect((await store.githubRunnerMachines.get(sandboxId))?.state).toBe("busy");
		expect(sandboxes.sandboxes.has(sandboxId)).toBe(true);
	});

	it("stops a pass at its next effect once account cleanup on the same gateway has taken its lease", async () => {
		const { job, sandboxes, runners, store } = await setUp();
		const create = sandboxes.api.create;
		let first = true;
		sandboxes.api.create = async (principal, body) => {
			const made = await create(principal, body);
			if (first) {
				first = false;
				await runners.forgetAccount("acc_org");
			}
			return made;
		};
		await store.githubRunners.update("ghr_one", (current) => ({ ...current, installationId: 42 }));
		for (const id of [1, 2, 3]) {
			await store.githubRunnerJobs.insert({
				id: `ghr_one:${id}`,
				integrationId: "ghr_one",
				accountId: "acc_org",
				jobId: id,
				runId: 1,
				repository: "octo-org/app",
				name: "checks",
				labels: ["kantel-8vcpu"],
				pool: "kantel-8vcpu",
				installationId: 42,
				state: "queued",
				queuedAt: 0,
				updatedAt: 0,
			});
		}
		await runners.tick();
		// One create was under way when cleanup took over; nothing more was made.
		expect(sandboxes.sandboxes.size).toBe(1);
		expect(await store.githubRunners.get("ghr_one")).toBeUndefined();
	});

	it("takes a registration off GitHub when cleanup took the lease while GitHub registered it", async () => {
		const { job, sandboxes, runners, github, store, clock } = await setUp();
		await job("queued", 1);
		sandboxes.boot();
		// Account cleanup takes the lease (and finds no runner on GitHub yet) while GitHub registers this one.
		github.state.onRegister = async () => {
			await store.githubRunners.update("ghr_one", (current) => ({
				...current,
				lease: { owner: "cleanup", until: clock.now + 60_000 },
			}));
		};
		await runners.tick();
		github.state.onRegister = undefined;
		expect(github.registered).toHaveLength(1);
		expect(github.removed).toEqual([1]);
		expect(sandboxes.runs).toEqual([]);
	});

	it("binds the installation only from its own owner's deliveries", async () => {
		const { deliver, store, sandboxes } = await setUp();
		const from = (owner: string, installation: number) =>
			deliver("workflow_job", {
				action: "queued",
				installation: { id: installation },
				repository: { full_name: `${owner}/app` },
				workflow_job: { id: installation, run_id: 1, name: "checks", labels: ["kantel-8vcpu"] },
			});
		await from("octo-org", 42);
		expect((await from("other-org", 99)).status).toBe(202);
		expect((await store.githubRunners.get("ghr_one"))?.installationId).toBe(42);
		expect(sandboxes.sandboxes.size).toBe(1);
	});

	it("commits a runner's sticky disk after a successful job on a branch it commits from, never a pull request's", async () => {
		const pool = {
			stickyDisks: [{ disk: "ci-cache", path: "/var/lib/ci", commit: { branches: ["main"], beforeCommit: "prune" } }],
		};
		const cases = [
			{ run: { event: "push", headBranch: "main", headRepository: "octo-org/app" }, conclusion: "success", commits: 1 },
			// A fork's pull request from its own `main`: the run's event and head repository say so.
			{
				run: { event: "pull_request", headBranch: "main", headRepository: "fork/app" },
				conclusion: "success",
				commits: 0,
			},
			{
				run: { event: "push", headBranch: "feature", headRepository: "octo-org/app" },
				conclusion: "success",
				commits: 0,
			},
			{ run: { event: "push", headBranch: "main", headRepository: "octo-org/app" }, conclusion: "failure", commits: 0 },
		];
		for (const { run, conclusion, commits } of cases) {
			const { job, sandboxes, runners, github } = await setUp({ pool });
			github.runs.set(900, run);
			await job("queued", 1);
			sandboxes.boot();
			await runners.tick();
			const [sandboxId = ""] = [...sandboxes.sandboxes.keys()];
			await job("in_progress", 1, { runner_name: sandboxId });
			await job("completed", 1, { runner_name: sandboxId, conclusion });
			await runners.tick();
			expect(sandboxes.commits).toEqual(commits === 0 ? [] : [{ sandboxId, disk: "ci-cache" }]);
			expect(sandboxes.execs).toEqual(commits === 0 ? [] : [{ sandboxId, command: "prune" }]);
			expect(sandboxes.sandboxes.has(sandboxId)).toBe(false);
		}
	});

	it("ignores jobs no pool takes, and records those of repositories it doesn't serve", async () => {
		const { deliver, job, sandboxes, runners } = await setUp({ repositories: ["octo-org/other"] });
		await deliver("workflow_job", {
			action: "queued",
			installation: { id: 42 },
			repository: { full_name: "octo-org/app" },
			workflow_job: { id: 5, run_id: 9, name: "linux", labels: ["ubuntu-latest"] },
		});
		await job("queued", 6);
		expect(sandboxes.sandboxes.size).toBe(0);
		expect(await runners.jobs("ghr_one")).toEqual([
			expect.objectContaining({ id: "6", state: "ignored", reason: expect.stringContaining("octo-org/app") }),
		]);
	});

	it("reads an App's PKCS #1 key as GitHub gives it", async () => {
		const pair = await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
			true,
			["sign", "verify"],
		);
		const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
		// PKCS #8's RSA key is its 26-byte header and the PKCS #1 key: what GitHub's PEM holds.
		const pkcs1 = pkcs8.slice(26);
		const pem = (label: string, bytes: Uint8Array) =>
			`-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...bytes)).replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;
		await expect(importAppKey(pem("RSA PRIVATE KEY", pkcs1))).resolves.toBeDefined();
		await expect(importAppKey(pem("PRIVATE KEY", pkcs8))).resolves.toBeDefined();
		await expect(importAppKey("not a key")).rejects.toThrow(/PEM/);
	});
});

describe("GitHub runners through the API", () => {
	async function pem(): Promise<string> {
		const pair = await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
			true,
			["sign", "verify"],
		);
		const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
		return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
	}

	it("connects an App, answers its signed webhook with a runner made as the integration's key, and disconnects", async () => {
		const github = fakeGithub();
		const stub = createStubBackend();
		// A host offering a 2-vCPU, 768 MB preset: a shape a create takes from it, outside the custom-shape rules.
		const backend = {
			...stub,
			async capabilities() {
				const capabilities = await stub.capabilities();
				return {
					...capabilities,
					hosts: capabilities.hosts.map((host) => ({
						...host,
						sizes: [
							...(host.sizes ?? capabilities.sizes),
							{ name: "small" as const, vcpus: 2, memoryMb: 768, diskGb: 10 },
						],
					})),
				};
			},
		};
		const api = createComputeApi({
			backend,
			templates: true,
			githubRunners: { app: github.app },
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer tom-token"
					? { userId: "usr_tom", name: "Tom", email: "tom@example.com" }
					: undefined,
		});
		try {
			const tom = createKantelClient({
				baseUrl: "http://compute.test/v1",
				token: "tom-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
			await tom.createTemplate({ name: "ci", spec: { setup: "true" } });
			await expect(
				tom.createGithubRunners({ name: "ci", appId: 1, privateKey: await pem(), owner: "octo-org", pools: [POOL] }),
			).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("runnerGroupId") });
			const { githubRunners, webhookSecret } = await tom.createGithubRunners({
				name: "ci",
				appId: 1,
				privateKey: await pem(),
				owner: "octo-org",
				runnerGroupId: 7,
				pools: [POOL],
			});
			expect(githubRunners.webhookUrl).toBe(`http://compute.test/v1/github-runners/${githubRunners.id}/webhook`);
			const body = JSON.stringify({
				action: "queued",
				installation: { id: 42 },
				repository: { full_name: "octo-org/app" },
				workflow_job: { id: 1, run_id: 2, name: "checks", labels: ["kantel-8vcpu"] },
			});
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(webhookSecret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
			const response = await api.fetch(
				new Request(githubRunners.webhookUrl, {
					method: "POST",
					headers: {
						"x-github-event": "workflow_job",
						"x-hub-signature-256": `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
					},
					body,
				}),
			);
			expect(response?.status).toBe(200);
			const [runner] = (await tom.listSandboxes()).items;
			expect(runner).toMatchObject({
				type: "microvm",
				labels: { [RUNNER_LABEL]: githubRunners.id },
				createdBy: { kind: "api_key", name: "GitHub runners: ci" },
			});
			expect((await tom.getGithubRunners(githubRunners.id)).status).toEqual([
				expect.objectContaining({ label: "kantel-8vcpu", queued: 1 }),
			]);
			// A sandbox someone labelled as a runner isn't one: the integration's cleanup leaves it.
			const forged = await tom.createSandbox({ labels: { [RUNNER_LABEL]: githubRunners.id } });
			await tom.deleteGithubRunners(githubRunners.id);
			expect(
				(await tom.listSandboxes()).items.filter((sandbox) => sandbox.state !== "deleted").map((s) => s.id),
			).toEqual([forged.id]);
			// A host's preset shape is a pool's to use; a pool no create could make is refused when it's given.
			const preset = await tom.createGithubRunners({
				name: "preset",
				appId: 1,
				privateKey: await pem(),
				owner: "octo-org",
				runnerGroupId: 7,
				pools: [{ ...POOL, label: "kantel-tiny", resources: { vcpus: 2, memoryMb: 768 } }],
			});
			expect(preset.githubRunners.pools[0]?.resources).toEqual({ vcpus: 2, memoryMb: 768 });
			await expect(
				tom.createGithubRunners({
					name: "bad",
					appId: 1,
					privateKey: await pem(),
					owner: "octo-org",
					runnerGroupId: 7,
					pools: [{ ...POOL, resources: { vcpus: 8, memoryMb: 20_000 } }],
				}),
			).rejects.toMatchObject({ code: "invalid" });
			expect(
				(await tom.listApiKeys()).items.find((item) => item.name === "GitHub runners: ci")?.revokedAt,
			).toBeDefined();
		} finally {
			await api.close();
		}
	});
});
