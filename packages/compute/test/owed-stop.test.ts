// A sandbox that owes a stop (`stopFor`: its egress as stored isn't what its host enforces, or an asked stop its host
// was away for, LLE-19732) may still have a machine running, but nothing new is let near it until that stop is carried
// out: no live fork or snapshot, process list, set-up, recovery, upgrade or exposed port, as no command or file.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
};
const OWED = "Its egress can't be enforced";
const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

function setup() {
	const stub = createStubBackend();
	const written: string[] = [];
	const backend: SandboxBackend = {
		...stub,
		processes: async () => ({ processes: [], total: 0 }),
		writeFile: async (sandboxId, path, content, mode) => {
			written.push(path);
			return stub.writeFile(sandboxId, path, content, mode);
		},
	};
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
	/** Makes the sandbox owe a stop in `state`, as a stop handed back (running) or one under way (stopping) leaves it. */
	const owe = (sandboxId: string, state: "running" | "stopping" = "running") =>
		api.store.sandboxes.update(sandboxId, (current) => ({ ...current, state, stopFor: OWED }));
	return { api, tom, owe, written };
}

async function refused(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to be refused");
}

describe("a sandbox that owes a stop", () => {
	it("refuses a live fork, a live snapshot, its processes, a recovery and its ports, with the stop's reason", async () => {
		const { api, tom, owe } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		expect(await api.service.portRefused(sandbox.id)).toBeUndefined();
		await owe(sandbox.id);
		const reason = `The sandbox is being stopped: ${OWED}`;
		for (const call of [
			tom.forkSandbox(sandbox.id, { wait: true }),
			tom.saveSnapshot({ name: "live", sandboxId: sandbox.id }),
			tom.takeSnapshot(sandbox.id, {}),
			tom.listSandboxProcesses(sandbox.id),
			tom.recoverSandbox(sandbox.id),
		]) {
			const answer = await refused(call);
			expect(answer.status).toBe(409);
			expect(answer.message).toBe(reason);
		}
		expect(await api.service.portRefused(sandbox.id)).toBe(reason);
	});

	it("refuses its ports while its stop is under way too, and not once it is done", async () => {
		const { api, tom, owe } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await owe(sandbox.id, "stopping");
		expect(await api.service.portRefused(sandbox.id)).toBe(`The sandbox is being stopped: ${OWED}`);
		await api.store.sandboxes.update(sandbox.id, (current) => {
			const { stopFor: _, ...rest } = current;
			return { ...rest, state: "running" };
		});
		expect(await api.service.portRefused(sandbox.id)).toBeUndefined();
	});

	it("refuses an isolate's upgrade", async () => {
		const { tom, owe } = setup();
		const sandbox = await tom.createSandbox({ type: "isolate", wait: true });
		await owe(sandbox.id);
		const answer = await refused(tom.upgradeSandbox(sandbox.id, {}));
		expect(answer.status).toBe(409);
		expect(answer.message).toBe(`The sandbox is being stopped: ${OWED}`);
	});

	it("takes an environment attached, but keeps its files for its next start rather than writing them into it", async () => {
		const { api, tom, owe, written } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const environment = await tom.createEnvironment({ name: "npm" });
		await tom.setEnvironmentFile(environment.id, { path: ".npmrc", content: "registry=https://example.test" });
		await owe(sandbox.id);
		await tom.attachSandboxEnvironment(sandbox.id, { environment: environment.id });
		await api.service.idle();
		expect(written.some((path) => path.endsWith(".npmrc"))).toBe(false);
		expect((await api.store.sandboxes.get(sandbox.id))?.pendingProvision?.length ?? 0).toBeGreaterThan(0);
	});
});
