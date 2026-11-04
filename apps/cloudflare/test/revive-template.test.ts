// `revivingStub` with templates on: a sandbox made from a template, its machine lost with the stub's memory, is made
// again from the base and setup its create resolved (`templateBoot`), not as an empty machine, whatever its template is
// now.
import { type ComputeApi, createComputeApi, createMemoryStore, type PersonIdentity } from "@kantel/compute";
import { createStubBackend } from "@kantel/compute/stub";
import { afterEach, describe, expect, it } from "vitest";
import { revivingStub } from "../src/compute.ts";

const TOM: PersonIdentity = { userId: "usr_tom", name: "Tom", email: "tom@example.com" };

const opened: ComputeApi[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

/** A stack on `store` with templates on, whose stub starts empty, as a Durable Object's does after eviction. */
function stack(store: ReturnType<typeof createMemoryStore>) {
	const api = createComputeApi({
		store,
		backend: revivingStub(createStubBackend(), store.sandboxes),
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

	it("revives a sandbox made without a template as an empty machine, as before", async () => {
		const store = createMemoryStore();
		const made = await stack(store).call<{ id: string }>("POST", "/sandboxes", { type: "microvm", wait: true });
		const ran = await stack(store).call<{ exitCode: number }>("POST", `/sandboxes/${made.id}/commands`, {
			command: "test -e /opt/app/marker",
		});
		expect(ran.exitCode).not.toBe(0);
	});
});
