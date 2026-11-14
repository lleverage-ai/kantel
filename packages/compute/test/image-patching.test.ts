import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { BootOptions, SandboxBackend } from "../src/backend.ts";
import type { BaseImages } from "../src/base-status.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { CLAIM_LAPSED } from "../src/service.ts";
import { createStubBackend } from "../src/stub-backend.ts";
import { HOST_BEHIND, HOST_LATEST, HOST_OLDEST, INDEX } from "./base-index-fixture.ts";

const BASE_URL = "http://compute.test/v1";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

/**
 * The stub, reporting bases as a host with image patching does: a new sandbox is on `HOST_BEHIND`, and a start with
 * `rebase` moves it onto `HOST_LATEST`. What each start was asked is kept in `starts`, and the order of stops and starts
 * in `calls`; the preflight says whether the machine is running, as a host does.
 */
function versionedStub(ready?: () => void | Promise<void>) {
	const stub = createStubBackend();
	const bases = new Map<string, { base: string; baseAt: number }>();
	let clock = 1_000;
	const tick = () => {
		clock += 1_000;
		return clock;
	};
	const starts: BootOptions[] = [];
	const calls: string[] = [];
	const running = new Set<string>();
	const prepared: { readonly eligibleHosts: readonly string[]; readonly rebaseTo?: string }[] = [];
	const backend: SandboxBackend = {
		...stub,
		async prepareRebase(sandboxId, how) {
			prepared.push(how);
			await ready?.();
			return { running: running.has(sandboxId) };
		},
		async create(spec) {
			const placement = await stub.create(spec);
			running.add(spec.sandboxId);
			const on = { base: HOST_BEHIND, baseAt: tick() };
			bases.set(spec.sandboxId, on);
			return { ...placement, ...on };
		},
		async start(sandboxId, how) {
			starts.push(how);
			calls.push("start");
			const placement = await stub.start(sandboxId, how);
			running.add(sandboxId);
			if (how.rebase === true) bases.set(sandboxId, { base: HOST_LATEST, baseAt: tick() });
			const on = bases.get(sandboxId);
			return on === undefined ? placement : { ...placement, ...on };
		},
		async stop(sandboxId, how) {
			calls.push("stop");
			const taken = await stub.stop(sandboxId, how);
			running.delete(sandboxId);
			const on = bases.get(sandboxId);
			return on === undefined ? taken : { ...taken, base: on.base };
		},
	};
	return { backend, starts, prepared, calls };
}

function setup(baseImages?: BaseImages, ready?: () => void | Promise<void>) {
	const { backend, starts, prepared, calls } = versionedStub(ready);
	const api = createComputeApi({
		backend,
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
		...(baseImages === undefined ? {} : { baseImages }),
	});
	opened.push(api);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, backend, starts, prepared, calls, tom: client("tom-token"), root: client("root-token") };
}

const indexed: BaseImages = { indexUrl: "https://example.test/index.json", index: async () => INDEX };

async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

describe("image patching off", () => {
	it("answers no base, and refuses its routes", async () => {
		const { api, tom, root } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox).not.toHaveProperty("base");
		await tom.stopSandbox(sandbox.id, { wait: true });
		await api.service.idle();
		const [snapshot] = (await tom.listSnapshots({ sandboxId: sandbox.id })).items;
		expect(snapshot).toBeDefined();
		expect(snapshot).not.toHaveProperty("base");
		expect((await failure(tom.restartSandboxOnLatest(sandbox.id))).code).toBe("not_supported");
		expect((await failure(root.listBaseImages())).code).toBe("not_supported");
	});
});

describe("image patching on", () => {
	it("says how far behind a sandbox's base is", async () => {
		const { tom } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox.base).toMatchObject({
			image: "host",
			version: HOST_BEHIND,
			outdated: true,
			latest: { version: HOST_LATEST },
			behind: { versions: 1 },
			security: true,
		});
		expect((await tom.getSandbox(sandbox.id)).base?.version).toBe(HOST_BEHIND);
	});

	it("keeps the base a sandbox's own host reports, without a boot, and nobody else's", async () => {
		const { api, tom } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		await api.store.sandboxes.update(sandbox.id, (current) => {
			const { base: _base, ...rest } = current;
			return rest;
		});
		expect((await tom.getSandbox(sandbox.id)).base).toBeUndefined();
		const hostId = (await api.store.sandboxes.get(sandbox.id))?.hostId ?? "";
		const report = (from: string, base: string) =>
			api.service.recordBases(from, { sandboxes: [{ sandboxId: sandbox.id, base }] });
		await report("host_someone_else", HOST_LATEST);
		await report(hostId, "not a base!");
		expect((await tom.getSandbox(sandbox.id)).base).toBeUndefined();
		await report(hostId, HOST_OLDEST);
		expect((await tom.getSandbox(sandbox.id)).base).toMatchObject({
			version: HOST_OLDEST,
			outdated: true,
			behind: { versions: 2 },
		});
	});

	it("restarts on latest once for one Idempotency-Key", async () => {
		const { api, tom } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		const first = await tom.restartSandboxOnLatest(sandbox.id, { idempotencyKey: "rebase-1" });
		await api.service.idle();
		const lifecycle = (await api.store.sandboxes.get(sandbox.id))?.lifecycle;
		// Running again: without the key, a retry would stop and boot it a second time.
		expect(await tom.restartSandboxOnLatest(sandbox.id, { idempotencyKey: "rebase-1" })).toEqual(first);
		await api.service.idle();
		expect((await api.store.sandboxes.get(sandbox.id))?.lifecycle).toBe(lifecycle);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("never restarts a sandbox whose move is under way, as another gateway would find it", async () => {
		const { api, tom, starts } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		// Its machine exited as a running sandbox's first copy was made: `error`, its move still on it.
		const at = Date.now();
		await api.store.sandboxes.update(sandbox.id, (latest) => ({
			...latest,
			state: "error",
			moving: { operationId: "mov_1", at, heartbeatAt: at, phase: "copying", from: "running", before: {} },
		}));
		const before = starts.length;
		const refused = await failure(tom.restartSandboxOnLatest(sandbox.id));
		expect(refused.code).toBe("conflict");
		expect(refused.message).toContain("moving");
		expect(starts.length).toBe(before);
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({
			state: "error",
			moving: { operationId: "mov_1" },
		});
	});

	it("keeps a restart's key when its stop fails part way, so a retry never ends commands again", async () => {
		const { api, backend, tom, calls } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		// The stop has begun (its commands ended) when the host refuses it.
		(backend as { stop: SandboxBackend["stop"] }).stop = async () => {
			calls.push("stop");
			throw new KantelError("conflict", "The host lost the machine");
		};
		const first = await failure(tom.restartSandboxOnLatest(sandbox.id, { idempotencyKey: "k-stop-failed" }));
		expect(first.status).toBe(409);
		expect(first.code).toBe("aborted");
		await api.service.idle();
		const stops = calls.filter((call) => call === "stop").length;
		expect(stops).toBe(1);
		const retried = await failure(tom.restartSandboxOnLatest(sandbox.id, { idempotencyKey: "k-stop-failed" }));
		expect(retried.message).toBe(CLAIM_LAPSED);
		await api.service.idle();
		expect(calls.filter((call) => call === "stop")).toHaveLength(stops);
	});

	it("keeps a restart's key once it has stopped the sandbox, so a retry never stops what started it since", async () => {
		const { api, tom, starts } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		// Another call starts the sandbox the moment this restart's stop has written it stopped.
		const sandboxes = api.store.sandboxes;
		const update = sandboxes.update.bind(sandboxes);
		let moved = false;
		(sandboxes as { update: typeof update }).update = async (id, change, expected) => {
			const result = await update(id, change, expected);
			if (!moved && result?.state === "stopped") {
				moved = true;
				await update(id, (current) => ({ ...current, state: "running", lifecycle: (current.lifecycle ?? 0) + 1 }));
			}
			return result;
		};
		const first = await failure(tom.restartSandboxOnLatest(sandbox.id, { idempotencyKey: "k-moved" }));
		expect(moved).toBe(true);
		expect(first.status).toBe(409);
		expect(first.code).toBe("aborted");
		const booted = starts.length;
		const retried = await failure(tom.restartSandboxOnLatest(sandbox.id, { idempotencyKey: "k-moved" }));
		expect(retried.code).toBe("conflict");
		expect(retried.message).toBe(CLAIM_LAPSED);
		await api.service.idle();
		expect(starts).toHaveLength(booted);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("never takes over a restart's lapsed key: a retry is conflict, and nothing restarts again", async () => {
		const { api, tom } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		const lifecycle = (await api.store.sandboxes.get(sandbox.id))?.lifecycle;
		// A restart whose gateway stopped renewing its claim before it read the sandbox, and may yet go on.
		await api.store.idempotency.put({
			id: "user:usr_tom:restartSandboxOnLatest:k-lapsed",
			createdAt: 0,
			claim: "claim_stalled",
			claimExpiresAt: 1,
		});
		const retried = await failure(tom.restartSandboxOnLatest(sandbox.id, { idempotencyKey: "k-lapsed" }));
		expect(retried.code).toBe("conflict");
		await api.service.idle();
		expect((await api.store.sandboxes.get(sandbox.id))?.lifecycle).toBe(lifecycle);
	});

	it("never lets a late report replace the base a boot recorded", async () => {
		const { api, tom } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		await api.store.sandboxes.update(sandbox.id, (current) => {
			const { base: _base, ...rest } = current;
			return rest;
		});
		const hostId = (await api.store.sandboxes.get(sandbox.id))?.hostId ?? "";
		const putOnAt = (await api.store.sandboxes.get(sandbox.id))?.baseAt ?? 0;
		// A hello's report of the old base, delayed past a restart on latest that records the new one.
		await tom.restartSandboxOnLatest(sandbox.id);
		await api.service.idle();
		expect((await tom.getSandbox(sandbox.id)).base?.version).toBe(HOST_LATEST);
		const rebasedAt = (await api.store.sandboxes.get(sandbox.id))?.baseAt ?? 0;
		expect(rebasedAt).toBeGreaterThan(putOnAt);
		const report = (base: string, baseAt?: number) =>
			api.service.recordBases(hostId, {
				sandboxes: [{ sandboxId: sandbox.id, base, ...(baseAt === undefined ? {} : { baseAt }) }],
			});
		await report(HOST_BEHIND, putOnAt);
		await report(HOST_OLDEST);
		expect((await tom.getSandbox(sandbox.id)).base?.version).toBe(HOST_LATEST);
		// One the host says it put the sandbox on later (a rebase boot whose answer never came back) is taken.
		await report(HOST_BEHIND, rebasedAt + 1);
		expect((await tom.getSandbox(sandbox.id)).base?.version).toBe(HOST_BEHIND);
		expect((await api.store.sandboxes.get(sandbox.id))?.baseAt).toBe(rebasedAt + 1);
	});

	it("fills in the base of a snapshot saved before its host versioned its images", async () => {
		const { api, tom } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		const saved = await tom.saveSnapshot({ name: "before", sandboxId: sandbox.id });
		// As the hosts backend names it: `<hostId>/<snapshot ID on the host>`.
		const hostId = "host_a";
		const ref = `${hostId}/${saved.id}`;
		await api.store.snapshots.update(saved.id, (current) => {
			const { base: _base, ...rest } = current;
			return { ...rest, ref };
		});
		await api.service.recordBases("host_someone_else", { snapshots: [{ ref, base: HOST_LATEST }] });
		expect((await api.store.snapshots.get(saved.id))?.base).toBeUndefined();
		await api.service.recordBases(hostId, { snapshots: [{ ref, base: HOST_OLDEST }] });
		expect((await api.store.snapshots.get(saved.id))?.base).toBe(HOST_OLDEST);
		// Filled once: a later report doesn't move it.
		await api.service.recordBases(hostId, { snapshots: [{ ref, base: HOST_LATEST }] });
		expect((await api.store.snapshots.get(saved.id))?.base).toBe(HOST_OLDEST);
	});

	it("refuses to restart on latest while the sandbox is mid-lifecycle", async () => {
		const { api, tom, starts } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		for (const state of ["starting", "stopping", "deleting"] as const) {
			await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, state }));
			await expect(tom.restartSandboxOnLatest(sandbox.id)).rejects.toMatchObject({ code: "conflict" });
		}
		expect(starts).toHaveLength(0);
	});

	it("restarts a running sandbox on the latest base, from a snapshot of its disk", async () => {
		const { api, tom, starts, prepared } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.runCommand(sandbox.id, { command: "echo kept > keep.txt" });

		const restarting = await tom.restartSandboxOnLatest(sandbox.id);
		expect(restarting.state).toBe("starting");
		await api.service.idle();

		const restarted = await tom.getSandbox(sandbox.id);
		expect(restarted.state).toBe("running");
		expect(restarted.base).toMatchObject({ image: "host", version: HOST_LATEST, outdated: false });
		expect(starts.map((how) => how.rebase)).toEqual([true]);
		// Checked first, and told where to land: the version `stable` names.
		expect(prepared.map((how) => how.rebaseTo)).toEqual([HOST_LATEST]);
		expect(starts[0]?.rebaseTo).toBe(HOST_LATEST);
		// Its disk was saved without its memory, as a stop saves it, and the snapshot is on the base it was taken from.
		const history = (await tom.listSnapshots({ sandboxId: sandbox.id })).items;
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			trigger: "stop",
			memory: false,
			base: { version: HOST_BEHIND, outdated: true },
		});
		expect(starts[0]?.fromSnapshot).toBeDefined();
		expect((await tom.readFile(sandbox.id, { path: "keep.txt" })).content).toBe("kept\n");
	});

	it("stops a sandbox recorded as errored whose machine is still running before booting it on the latest base", async () => {
		const { api, tom, starts, calls } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		// A boot that finished on its host after its call gave up: the record says error, the machine runs on the old base.
		await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, state: "error" }));
		expect((await tom.restartSandboxOnLatest(sandbox.id)).state).toBe("starting");
		await api.service.idle();
		expect(calls).toEqual(["stop", "start"]);
		expect(starts.map((how) => how.rebase)).toEqual([true]);
		const after = await tom.getSandbox(sandbox.id);
		expect(after.state).toBe("running");
		expect(after.base?.version).toBe(HOST_LATEST);
	});

	it("boots a sandbox recorded as errored whose machine isn't running without stopping it", async () => {
		const { api, tom, calls } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		calls.length = 0;
		await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, state: "error" }));
		await tom.restartSandboxOnLatest(sandbox.id);
		await api.service.idle();
		expect(calls).toEqual(["start"]);
		expect((await tom.getSandbox(sandbox.id)).base?.version).toBe(HOST_LATEST);
	});

	it("keeps a custom-shape sandbox's vCPUs, memory and disk when it restarts on the latest base", async () => {
		const { api, tom, starts } = setup(indexed);
		const sandbox = await tom.createSandbox({ type: "microvm", resources: { vcpus: 3, memoryMb: 6144 }, wait: true });
		await tom.restartSandboxOnLatest(sandbox.id);
		await api.service.idle();
		// The disk its host gave it at create, kept as its shape.
		expect(starts[0]?.shape).toEqual({ vcpus: 3, memoryMb: 6144, diskGb: sandbox.resources?.diskGb });
		const after = await tom.getSandbox(sandbox.id);
		expect(after.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });
		expect(after.base?.version).toBe(HOST_LATEST);
	});

	it("restarts a stopped sandbox on the latest base", async () => {
		const { api, tom, starts } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		expect((await tom.restartSandboxOnLatest(sandbox.id)).state).toBe("starting");
		await api.service.idle();
		expect((await tom.getSandbox(sandbox.id)).base?.version).toBe(HOST_LATEST);
		expect(starts.map((how) => how.rebase)).toEqual([true]);
	});

	it("names stable's host images as the target for a sandbox with no recorded base, and none without an index", async () => {
		const { api, tom, prepared } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		await api.store.sandboxes.update(sandbox.id, (current) => {
			const { base: _base, ...rest } = current;
			return rest;
		});
		await tom.restartSandboxOnLatest(sandbox.id);
		await api.service.idle();
		expect(prepared.map((how) => how.rebaseTo)).toEqual([HOST_LATEST]);

		const unread = setup({
			indexUrl: "https://example.test/index.json",
			index: async () => {
				throw new Error("unreachable");
			},
		});
		const other = await unread.tom.createSandbox({ wait: true });
		await unread.tom.restartSandboxOnLatest(other.id);
		await unread.api.service.idle();
		// No target: the backend that holds it decides (a host's refuses, test above in @kantel/hosts).
		expect(unread.prepared).toEqual([{ eligibleHosts: expect.any(Array) }]);
	});

	it("leaves a running sandbox running when its host can't take the latest base yet", async () => {
		const { api, tom, starts } = setup(indexed, () => {
			throw new KantelError("unavailable", "not yet");
		});
		const sandbox = await tom.createSandbox({ wait: true });
		expect((await failure(tom.restartSandboxOnLatest(sandbox.id))).code).toBe("unavailable");
		await api.service.idle();
		const after = await tom.getSandbox(sandbox.id);
		expect(after.state).toBe("running");
		expect(after.base?.version).toBe(HOST_BEHIND);
		expect(starts).toEqual([]);
		expect((await tom.listSnapshots({ sandboxId: sandbox.id })).items).toEqual([]);
	});

	it("refuses a restart on latest that another restart overtook, without stopping or booting it again", async () => {
		let release: () => void = () => {};
		let held = false;
		const { api, tom, calls } = setup(indexed, async () => {
			if (held) return;
			held = true;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const sandbox = await tom.createSandbox({ wait: true });
		// Held at its preflight, after it read the sandbox running.
		const stale = failure(tom.restartSandboxOnLatest(sandbox.id));
		await new Promise((resolve) => setTimeout(resolve, 10));
		// Meanwhile it is stopped and started again: running once more, on a new run.
		await tom.stopSandbox(sandbox.id, { wait: true });
		await tom.startSandbox(sandbox.id, { wait: true });
		calls.length = 0;
		release();
		expect((await stale).code).toBe("conflict");
		await api.service.idle();
		expect(calls).toEqual([]);
		const after = await tom.getSandbox(sandbox.id);
		expect(after.state).toBe("running");
		expect(after.base?.version).toBe(HOST_BEHIND);
	});

	it("refuses a restart on latest of a stopped sandbox that was started and stopped again meanwhile", async () => {
		let release: () => void = () => {};
		let held = false;
		const { api, tom, starts } = setup(indexed, async () => {
			if (held) return;
			held = true;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		const stale = failure(tom.restartSandboxOnLatest(sandbox.id));
		await new Promise((resolve) => setTimeout(resolve, 10));
		await tom.startSandbox(sandbox.id, { wait: true });
		await tom.stopSandbox(sandbox.id, { wait: true });
		starts.length = 0;
		release();
		expect((await stale).code).toBe("conflict");
		await api.service.idle();
		expect(starts).toEqual([]);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");
	});

	it("carries a sandbox's mounts through its restart on latest, pending until the boot says", async () => {
		const { api, tom, starts } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		const digest = `sha256:${"a".repeat(64)}`;
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			mounts: [{ path: "/mnt/skills", source: { kind: "bundle", digest }, status: "ready" }],
		}));
		const restarting = await tom.restartSandboxOnLatest(sandbox.id);
		expect(restarting.mounts).toEqual([{ path: "/mnt/skills", source: { kind: "bundle", digest }, status: "pending" }]);
		await api.service.idle();
		expect(starts.map((how) => how.mounts)).toEqual([[{ path: "/mnt/skills", source: { kind: "bundle", digest } }]]);
	});

	it("refuses a sandbox being deleted", async () => {
		const { api, tom } = setup(indexed);
		const sandbox = await tom.createSandbox({ wait: true });
		await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, state: "deleting" }));
		expect((await failure(tom.restartSandboxOnLatest(sandbox.id))).code).toBe("conflict");
	});

	it("lists the base images for a super-admin only", async () => {
		const { tom, root } = setup(indexed);
		const list = await root.listBaseImages();
		expect(list.indexUrl).toBe("https://example.test/index.json");
		expect(list.generatedAt).toBe(INDEX.generatedAt);
		expect(list.templates).toEqual([]);
		expect(list.error).toBeUndefined();
		const host = list.images.find((image) => image.name === "host");
		expect(host).toMatchObject({ channel: "stable", latest: { version: HOST_LATEST, signed: true } });
		expect(host?.versions.map((version) => version.version)).toEqual(
			INDEX.images[0]?.versions.map((version) => version.version),
		);
		expect(host?.versions[1]?.scan?.findings[0]).toMatchObject({ id: "CVE-2026-1234", severity: "critical" });
		expect(list.images.find((image) => image.name === "browser")).not.toHaveProperty("latest");
		expect((await failure(tom.listBaseImages())).code).toBe("forbidden");
	});

	it("answers why the index couldn't be read", async () => {
		const { root } = setup({
			indexUrl: "https://example.test/index.json",
			index: async () => {
				throw new Error("The base image index couldn't be read: it answered 503");
			},
		});
		const list = await root.listBaseImages();
		expect(list).toMatchObject({ images: [], templates: [], error: expect.stringContaining("503") });
	});
});
