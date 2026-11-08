// A microVM its host ends without Kantel asking (its memory guard, the kernel's OOM killer at its limit, a crash) is in
// error, saying why, rather than left running until something else touches it (#808).
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { hostExitReason } from "../src/service.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
};
const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

function setup() {
	const api = createComputeApi({
		backend: createStubBackend(),
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

/** kantel-host's `microvm.KilledForMemory`: its memory guard's last step. */
const GUARD_KILL =
	"out of memory: the host ran short of memory, and Kantel stopped this sandbox's VM, the largest, to protect it";

describe("a running sandbox whose host ended its VM", () => {
	it("is in error with the host's reason, its run and ports ended, and starts again from its disk", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true, autoStopMinutes: 30 });
		await tom.exposePort(sandbox.id, { port: 3000 });
		expect((await api.store.sandboxes.get(sandbox.id))?.ports).toHaveLength(1);
		await api.service.reportExit(STUB_HOST_ID, sandbox.id, GUARD_KILL, Date.now());

		const ended = await tom.getSandbox(sandbox.id);
		expect(ended).toMatchObject({ state: "error", reason: hostExitReason(GUARD_KILL) });
		expect((await api.store.sandboxes.get(sandbox.id))?.ports).toEqual([]);
		expect(ended.reason).toMatch(/^Out of memory: the host ran short of memory/);
		expect(ended.reason).toContain("Start it again");
		expect(ended.stopsAt).toBeUndefined();
		const events = (await tom.listEvents({ sandboxId: sandbox.id })).items;
		const errored = events.find((event) => event.type === "sandbox.error");
		expect(errored?.data).toMatchObject({ previousState: "running", reason: hostExitReason(GUARD_KILL) });

		// Its calls say it is in error, with why, rather than hanging on a machine that isn't there.
		const refused = await failure(tom.runCommand(sandbox.id, { command: "echo hi" }));
		expect(refused.status).toBe(409);
		expect(refused.message).toContain("Out of memory");
		expect(refused.details).toMatchObject({ code: "sandbox_error", state: "error" });

		expect(await tom.startSandbox(sandbox.id, { wait: true })).toMatchObject({ state: "running" });
		expect((await tom.getSandbox(sandbox.id)).reason).toBeUndefined();
	});

	it("says its host stopped it when the host gives no reason, and can be stopped from error", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await api.service.reportExit(STUB_HOST_ID, sandbox.id, undefined, Date.now());
		expect(await tom.getSandbox(sandbox.id)).toMatchObject({ state: "error", reason: hostExitReason(undefined) });
		expect(hostExitReason(undefined)).toMatch(/^Its host stopped its VM\. /);
		expect((await tom.stopSandbox(sandbox.id, { wait: true })).state).toBe("stopped");
	});

	it("is dropped for another host, for a sandbox Kantel stopped, and for an exit had before its run began", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });

		await api.service.reportExit("host_other", sandbox.id, GUARD_KILL, Date.now());
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");

		// A stop Kantel asked for is that stop's: the host's word on it once done changes nothing.
		await tom.stopSandbox(sandbox.id, { wait: true });
		const seenBefore = Date.now();
		await api.service.reportExit(STUB_HOST_ID, sandbox.id, undefined, seenBefore);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");

		// Started again since: an exit had before this run began is the earlier machine's, handled late.
		await new Promise((resolve) => setTimeout(resolve, 5));
		await tom.startSandbox(sandbox.id, { wait: true });
		await api.service.reportExit(STUB_HOST_ID, sandbox.id, GUARD_KILL, seenBefore);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");

		// A sandbox that isn't there is nothing to do.
		await expect(api.service.reportExit(STUB_HOST_ID, "sbx_gone", GUARD_KILL, Date.now())).resolves.toBeUndefined();
	});
});
