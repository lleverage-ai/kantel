import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
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
	it("is in error with its host's reason, refuses commands at once, and is running again once the agent answers", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true, autoStopMinutes: 30 });
		const stopsAt = (await tom.getSandbox(sandbox.id)).stopsAt;
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM);

		const unhealthy = await tom.getSandbox(sandbox.id);
		expect(unhealthy).toMatchObject({ state: "error", health: "degraded" });
		expect(unhealthy.reason).toBe(`${OOM}. Recover it: a restart that keeps its disk`);
		const refused = await failure(tom.runCommand(sandbox.id, { command: "echo hi" }));
		expect(refused.status).toBe(409);
		expect(refused.message).toContain("out of memory");

		// Reported again (a hello's replay), nothing moves; from another host, nothing either.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM);
		await api.service.reportHealth("host_other", sandbox.id, undefined, undefined);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("error");

		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined);
		const back = await tom.getSandbox(sandbox.id);
		expect(back).toMatchObject({ state: "running", health: "ok" });
		expect(back.reason).toBeUndefined();
		expect(back.stopsAt).toBe(stopsAt);
		expect((await tom.runCommand(sandbox.id, { command: "echo hi" })).stdout).toBe("hi\n");

		const types = (await tom.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(types).toContain("sandbox.error");
		expect(types).toContain("sandbox.recovered");
	});

	it("is left alone by a report from another host, or while it isn't running", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await api.service.reportHealth("host_other", sandbox.id, "unresponsive", OOM);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
		await tom.stopSandbox(sandbox.id, { wait: true });
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");
		// An error of another cause isn't undone by its agent answering.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");
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
		// Its agent's answer after the recovery changes nothing.
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, undefined, undefined);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("can be stopped and started from error, rather than refused until a resume", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM);
		const stopped = await tom.stopSandbox(sandbox.id, { wait: true });
		expect(stopped.state).toBe("stopped");
		expect((await tom.startSandbox(sandbox.id, { wait: true })).state).toBe("running");
		expect((await tom.runCommand(sandbox.id, { command: "echo hi" })).stdout).toBe("hi\n");
	});

	it("can't be paused from error, which would keep the memory that starved it", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await api.service.reportHealth(STUB_HOST_ID, sandbox.id, "unresponsive", OOM);
		expect((await failure(tom.stopSandbox(sandbox.id, { keepMemory: true }))).status).toBe(409);
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
