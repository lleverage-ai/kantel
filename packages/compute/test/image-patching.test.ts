import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { BootOptions, SandboxBackend } from "../src/backend.ts";
import type { BaseImages } from "../src/base-status.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createStubBackend } from "../src/stub-backend.ts";
import { HOST_BEHIND, HOST_LATEST, INDEX } from "./base-index-fixture.ts";

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
 * `rebase` moves it onto `HOST_LATEST`. What each start was asked is kept in `starts`.
 */
function versionedStub(ready?: () => void) {
	const stub = createStubBackend();
	const bases = new Map<string, string>();
	const starts: BootOptions[] = [];
	const prepared: { readonly eligibleHosts: readonly string[]; readonly rebaseTo?: string }[] = [];
	const backend: SandboxBackend = {
		...stub,
		async prepareRebase(_sandboxId, how) {
			prepared.push(how);
			ready?.();
		},
		async create(spec) {
			const placement = await stub.create(spec);
			bases.set(spec.sandboxId, HOST_BEHIND);
			return { ...placement, base: HOST_BEHIND };
		},
		async start(sandboxId, how) {
			starts.push(how);
			const placement = await stub.start(sandboxId, how);
			if (how.rebase === true) bases.set(sandboxId, HOST_LATEST);
			const base = bases.get(sandboxId);
			return base === undefined ? placement : { ...placement, base };
		},
		async stop(sandboxId, how) {
			const taken = await stub.stop(sandboxId, how);
			const base = bases.get(sandboxId);
			return base === undefined ? taken : { ...taken, base };
		},
	};
	return { backend, starts, prepared };
}

function setup(baseImages?: BaseImages, ready?: () => void) {
	const { backend, starts, prepared } = versionedStub(ready);
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
	return { api, starts, prepared, tom: client("tom-token"), root: client("root-token") };
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
