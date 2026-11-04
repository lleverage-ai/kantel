// `revivingStub` with templates on: a sandbox made from a template, its machine lost with the stub's memory, is made
// again from the base and setup its create resolved (`templateBoot`), not as an empty machine, whatever its template is
// now.
import {
	type ComputeApi,
	createComputeApi,
	createMemoryStore,
	type PersonIdentity,
	type SandboxBackend,
} from "@kantel/compute";
import { createStubBackend } from "@kantel/compute/stub";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { revivingStub } from "../src/compute.ts";

const TOM: PersonIdentity = { userId: "usr_tom", name: "Tom", email: "tom@example.com" };

const opened: ComputeApi[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

/** A stack on `store` with templates on, whose stub starts empty, as a Durable Object's does after eviction. */
function stack(
	store: ReturnType<typeof createMemoryStore>,
	wrap: (stub: SandboxBackend) => SandboxBackend = (stub) => stub,
) {
	const api = createComputeApi({
		store,
		backend: revivingStub(wrap(createStubBackend()), store.sandboxes),
		templates: true,
		authenticatePerson: async () => TOM,
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const response = await api.fetch(
			new Request(`http://compute.test/v1${path}`, {
				method,
				headers: { authorization: "Bearer tom", "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		if (response === undefined || !response.ok) {
			throw new Error(`${method} ${path}: ${response?.status} ${await response?.text()}`);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	};
	return { api, call };
}

describe("A revived template sandbox", () => {
	it("runs its template's setup as its create resolved it, though the template changed and was deleted since", async () => {
		const store = createMemoryStore();
		const first = stack(store);
		const template = await first.call<{ id: string }>("POST", "/templates", {
			name: "web",
			spec: { setup: "mkdir -p /opt/app && echo one > /opt/app/marker" },
		});
		await first.api.service.idle();
		const made = await first.call<{ id: string; state: string; template?: { version: number } }>("POST", "/sandboxes", {
			template: "web",
			wait: true,
		});
		expect(made).toMatchObject({ state: "running", template: { version: 1 } });
		// The template moves on, then goes: the sandbox keeps the recipe it was made with.
		await first.call("PATCH", `/templates/${template.id}`, {
			spec: { setup: "mkdir -p /opt/app && echo two > /opt/app/marker" },
		});
		await first.api.service.idle();
		await first.call("DELETE", `/templates/${template.id}`);

		// The stub's memory goes (another stack on the same records): its next command revives the machine.
		const second = stack(store);
		const ran = await second.call<{ exitCode: number; stdout: string }>("POST", `/sandboxes/${made.id}/commands`, {
			command: "cat /opt/app/marker",
		});
		expect(ran).toMatchObject({ exitCode: 0, stdout: "one\n" });
	});

	it("is made once for calls that overlap while its setup runs, and a failed attempt can be tried again", async () => {
		const store = createMemoryStore();
		const first = stack(store);
		await first.call("POST", "/templates", {
			name: "web",
			spec: { setup: "mkdir -p /opt/app && echo one > /opt/app/marker" },
		});
		await first.api.service.idle();
		const made = await first.call<{ id: string }>("POST", "/sandboxes", { template: "web", wait: true });

		// The stub's memory goes; its creates are counted, the first fails and the next is held until released.
		let creates = 0;
		let active = 0;
		let most = 0;
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const second = stack(store, (stub) => ({
			...stub,
			async create(spec) {
				creates += 1;
				if (creates === 1) throw new KantelError("invalid", "The template's setup exited with 1: no");
				active += 1;
				most = Math.max(most, active);
				try {
					await held;
					return await stub.create(spec);
				} finally {
					active -= 1;
				}
			},
		}));
		const run = (command: string) =>
			second.call<{ exitCode: number; stdout: string }>("POST", `/sandboxes/${made.id}/commands`, { command });

		// The failed attempt fails its call and is let go.
		expect(await run("true")).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/setup exited with 1/) });
		// Two calls overlap while the next attempt is held: they share it.
		const both = Promise.all([run("cat /opt/app/marker"), run("cat /opt/app/marker")]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		release();
		expect(await both).toEqual([
			expect.objectContaining({ exitCode: 0, stdout: "one\n" }),
			expect.objectContaining({ exitCode: 0, stdout: "one\n" }),
		]);
		expect({ creates, most }).toEqual({ creates: 2, most: 1 });
		// What one wrote after the revival stays: no later revival replaced the machine.
		await run("echo kept > /tmp/written");
		expect(await run("cat /tmp/written")).toMatchObject({ exitCode: 0, stdout: "kept\n" });
		expect(creates).toBe(2);
	});

	it("revives a sandbox made without a template as an empty machine, as before", async () => {
		const store = createMemoryStore();
		const made = await stack(store).call<{ id: string }>("POST", "/sandboxes", { type: "microvm", wait: true });
		const ran = await stack(store).call<{ exitCode: number }>("POST", `/sandboxes/${made.id}/commands`, {
			command: "test -e /opt/app/marker",
		});
		expect(ran.exitCode).not.toBe(0);
	});
});
