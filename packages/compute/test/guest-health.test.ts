import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { unresponsiveReason } from "../src/service.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
};
const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

function setup(backend: SandboxBackend = createStubBackend()) {
	const api = createComputeApi({
		backend,
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
	return { api, tom };
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

const OOM = "Its guest agent hasn't answered for 60 seconds: it is out of memory (7.9 GB of 8.0 GB in use)";

describe("a sandbox whose guest agent stops answering", () => {
	it("stays running, unresponsive with its host's reason, refuses commands at once, and is ok once the agent answers", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true, autoStopMinutes: 30 });
		const stopsAt = (await tom.getSandbox(sandbox.id)).stopsAt;
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM, 1_000);

		// Running still (its egress, auto-stop and allocation go on as for any running machine), its stop time as it was.
		const unhealthy = await tom.getSandbox(sandbox.id);
		expect(unhealthy).toMatchObject({ state: "running", health: "unresponsive", stopsAt });
		expect(unhealthy.reason).toBe(`${OOM}. Recover it: a restart that keeps its disk`);
		const refused = await failure(tom.runCommand(sandbox.id, { command: "echo hi" }));
		expect(refused.status).toBe(409);
		expect(refused.message).toContain("out of memory");
		expect(refused.details).toMatchObject({ code: "sandbox_unresponsive", state: "running" });
		expect((await failure(tom.writeFile(sandbox.id, { path: "/tmp/x", content: "x" }))).status).toBe(409);

		// Reported again (a hello's replay), nothing moves; from another host, nothing either.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM, 1_000);
		await api.service.reportHealth("host_other", sandbox.id, undefined, undefined, 2_000);
		expect((await tom.getSandbox(sandbox.id)).health).toBe("unresponsive");

		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined, 2_000);
		const back = await tom.getSandbox(sandbox.id);
		expect(back).toMatchObject({ state: "running", health: "ok", stopsAt });
		expect(back.reason).toBeUndefined();
		expect((await tom.runCommand(sandbox.id, { command: "echo hi" })).stdout).toBe("hi\n");

		const types = (await tom.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(types.filter((type) => type === "sandbox.degraded")).toHaveLength(1);
		expect(types.filter((type) => type === "sandbox.recovered")).toHaveLength(1);
		expect(types).not.toContain("sandbox.error");
	});

	it("takes its host's reports in the order the host set them, whichever arrives first", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		// A newer healthy report, then an older unresponsive one delayed on the way: it stays ok.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined, 2_000);
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM, 1_000);
		expect((await tom.getSandbox(sandbox.id)).health).toBe("ok");
		// A newer unresponsive one, then an older healthy one: it stays unresponsive.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM, 4_000);
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined, 3_000);
		expect((await tom.getSandbox(sandbox.id)).health).toBe("unresponsive");
		// One at the same time as the last taken is a duplicate.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined, 4_000);
		expect((await tom.getSandbox(sandbox.id)).health).toBe("unresponsive");
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined, 5_000);
		expect((await tom.getSandbox(sandbox.id)).health).toBe("ok");
		// An unstamped one never replaces a stamped one, however late it arrives.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM, 6_000);
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined);
		expect((await tom.getSandbox(sandbox.id)).health).toBe("unresponsive");
	});

	it("keeps its health through an auto-stop handed back because its host was away", async () => {
		let clock = Date.UTC(2026, 10, 7);
		const stub = createStubBackend();
		let away = true;
		const api = createComputeApi({
			backend: {
				...stub,
				stop: async (sandboxId, how) => {
					if (away) throw new KantelError("unavailable", "The host is away");
					return stub.stop(sandboxId, how);
				},
			},
			now: () => clock,
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
			fetch: async () => new Response(null, { status: 204 }),
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true, autoStopMinutes: 5 });
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM, 1_000);
		clock += 6 * 60_000;
		await api.service.sweep();
		await api.service.idle();
		const handedBack = await tom.getSandbox(sandbox.id);
		expect(handedBack).toMatchObject({ state: "running", health: "unresponsive" });
		// Its host back, saying the same: it stays unresponsive; a newer healthy word makes it ok.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM, 1_000);
		expect((await tom.getSandbox(sandbox.id)).health).toBe("unresponsive");
		// The next sweep stops it, which leaves it healthy for its next boot.
		away = false;
		await api.service.sweep();
		await api.service.idle();
		expect(await tom.getSandbox(sandbox.id)).toMatchObject({ state: "stopped", health: "ok" });
	});

	it("is left alone by a report from another host, or while it isn't running", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await api.service.reportHealth("host_other", sandbox.id, "unresponsive", OOM);
		expect((await tom.getSandbox(sandbox.id)).health).toBe("ok");
		await tom.stopSandbox(sandbox.id, { wait: true });
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM);
		expect(await tom.getSandbox(sandbox.id)).toMatchObject({ state: "stopped", health: "ok" });
	});

	it("is ok again after a stop and start", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM, 1_000);
		expect((await tom.stopSandbox(sandbox.id, { wait: true })).state).toBe("stopped");
		expect(await tom.startSandbox(sandbox.id, { wait: true })).toMatchObject({ state: "running", health: "ok" });
		expect((await tom.runCommand(sandbox.id, { command: "echo hi" })).stdout).toBe("hi\n");
	});

	it("is recovered with a reset, its disk kept", async () => {
		const stub = createStubBackend();
		const recovered: string[] = [];
		const { api, tom } = setup({
			...stub,
			recover: (sandboxId, how) => {
				recovered.push(sandboxId);
				return stub.recover(sandboxId, how);
			},
		});
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.runCommand(sandbox.id, { command: "echo kept > /home/user/kept.txt" });
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM);
		await tom.recoverSandbox(sandbox.id);
		await api.service.idle();
		const after = await tom.getSandbox(sandbox.id);
		expect(after).toMatchObject({ state: "running", health: "ok" });
		expect(after.reason).toBeUndefined();
		expect(recovered).toEqual([sandbox.id]);
		expect((await tom.runCommand(sandbox.id, { command: "cat /home/user/kept.txt" })).stdout).toBe("kept\n");
	});
});

describe("a stop", () => {
	it("is a stop, not a pause, when its host stopped the machine cold rather than keep its memory", async () => {
		const stub = createStubBackend();
		const { tom } = setup({
			...stub,
			stop: async (sandboxId) => ({ ...(await stub.stop(sandboxId, { keepMemory: false })), memory: false }),
		});
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const stopped = await tom.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		expect(stopped.state).toBe("stopped");
		const types = (await tom.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(types).toContain("sandbox.stopped");
		expect(types).not.toContain("sandbox.paused");
		const snapshots = (await tom.listSnapshots({ sandboxId: sandbox.id })).items;
		expect(snapshots.map((snapshot) => snapshot.memory)).toEqual([false]);
	});

	it("keeps a pause a pause", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		expect((await tom.stopSandbox(sandbox.id, { keepMemory: true, wait: true })).state).toBe("paused");
	});

	it("works from error on a host, without its memory, rather than refused until a resume", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const stored = await api.store.sandboxes.get(sandbox.id);
		if (stored === undefined) throw new Error("no sandbox");
		await api.store.sandboxes.put({ ...stored, state: "error", reason: "Its host was lost" });
		expect((await failure(tom.stopSandbox(sandbox.id, { keepMemory: true }))).status).toBe(409);
		expect((await tom.stopSandbox(sandbox.id, { wait: true })).state).toBe("stopped");
		expect((await tom.startSandbox(sandbox.id, { wait: true })).state).toBe("running");
	});
});

describe("unresponsiveReason", () => {
	it("says what to do unless the host did", () => {
		expect(unresponsiveReason(undefined)).toBe(
			"Its guest agent stopped answering. Recover it: a restart that keeps its disk",
		);
		expect(unresponsiveReason("It hasn't answered. Recover it, a restart.")).toBe(
			"It hasn't answered. Recover it, a restart",
		);
	});
});
