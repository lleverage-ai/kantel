// Templates and their snapshot cache, through the HTTP API with the SDK: the cache key, rebuilding in the background on a
// new version, a new base digest or a host's new runtime (a pinned base reporting how far behind it is instead), a create
// starting from the newest ready snapshot or booting fresh, invalidation never touching the account's own snapshots, a
// template's image being Kantel's base on a channel or digest the deployment published, and the switch off. Builds are
// gated, so each test decides when one finishes.
import type { computeSchema } from "@kantel/api";
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import type { SqlDriver, SqlValue } from "@kantel/sql";
import { nodeSqliteDatabase, pgliteDatabase, type TestDatabaseKind } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import {
	type BackendSize,
	type BuiltTemplate,
	CUSTOM_SHAPES_FEATURE,
	type SandboxBackend,
	type SandboxSpec,
	type TemplateBuildSpec,
} from "../src/backend.ts";
import type { BaseImages } from "../src/base-status.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import {
	type ComputeStore,
	createMemoryStore,
	type StoredTemplate,
	type StoredTemplateVersion,
	type TemplateChange,
	UniqueViolation,
} from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";
import { TEMPLATE_BUILD_LEASE_MS, TEMPLATE_BUILD_RETRY_MS, templateCacheKey } from "../src/templates.ts";
import { INDEX } from "./base-index-fixture.ts";

const BASE_URL = "http://compute.test/v1";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const D1 = digest("1");
const D2 = digest("2");
const D3 = digest("3");

const SETUP = "mkdir -p /opt/app && echo ready > /opt/app/marker";
const SPEC: computeSchema.TemplateSpec = {
	setup: SETUP,
	env: { APP_MODE: "template" },
};

const opened: ComputeApi[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A build the fake backend was asked for, held until the test releases or fails it. */
interface HeldBuild {
	readonly spec: TemplateBuildSpec;
	/** Runs the stub's build and answers it. */
	release(): void;
	fail(message: string): void;
	/** Rejects with `error` as it is: a `KantelError`'s code, say. */
	reject(error: Error): void;
	/** Runs the stub's build, making its bytes, but answers `unavailable`: a host that finished after its call timed out. */
	timeOut(): void;
	/** Runs the stub's build, making its bytes, and never answers: its gateway died while it ran. */
	finishUnanswered(): void;
}

/** The template snapshot bytes each host holds, as `<hostId> <snapshotId>`: made by a build, gone with a deletion. */
type BytesOnHosts = Set<string>;

/**
 * The stub backend with template builds held (`builds`), its hosts' runtime changeable (`runtime`, and which hosts have
 * one, `runtimeHosts`), its sizes given (`sizes`, each host's too), more hosts (`moreHosts`), a host made one from before
 * custom shapes, which makes only its named sizes (`hostSizes`), what it was asked recorded (machines made, user snapshots deleted, template snapshots deleted: by ref, or
 * by ID when they have none), and `refuse`: template snapshot deletions failing while `deletes` is set, a template
 * snapshot's host full while `snapshotHost` is (a create from one boots fresh instead, `Placement.bootedFresh`), and
 * every create failing while `creates` is. A build on any of its hosts makes its bytes there (`bytesOnHosts`, which
 * services over one store share).
 */
function controllableBackend(
	options: {
		readonly templates?: boolean;
		readonly sizes?: readonly BackendSize[];
		readonly moreHosts?: readonly string[];
		readonly bytesOnHosts?: BytesOnHosts;
	} = {},
) {
	const stub = createStubBackend();
	const bytesOnHosts = options.bytesOnHosts ?? new Set<string>();
	const runtime = { kernel: "6.1.100", firecracker: "1.10.1" };
	const runtimeHosts = [STUB_HOST_ID, ...(options.moreHosts ?? [])];
	const hostSizes = new Map<string, readonly BackendSize[]>();
	const refuse = { deletes: false, snapshotHost: false, creates: false };
	const builds: HeldBuild[] = [];
	const waiting = new Map<number, (build: HeldBuild) => void>();
	const created: SandboxSpec[] = [];
	const deletedSnapshots: string[] = [];
	const deletedTemplateSnapshots: string[] = [];
	const sizes = options.sizes;
	const capabilities = async () => {
		const offered = await stub.capabilities();
		const [host] = offered.hosts;
		const hosts = [
			...offered.hosts,
			...(host === undefined ? [] : (options.moreHosts ?? []).map((id) => ({ ...host, id, name: id }))),
		];
		return {
			...offered,
			sizes: [...(sizes ?? offered.sizes)],
			hosts: hosts.map((each) => {
				const only = hostSizes.get(each.id);
				if (only !== undefined) {
					return { ...each, sizes: only, features: each.features?.filter((name) => name !== CUSTOM_SHAPES_FEATURE) };
				}
				return sizes === undefined ? each : { ...each, sizes };
			}),
		};
	};
	const base: SandboxBackend = {
		...stub,
		capabilities,
		create: async (spec) => {
			created.push(spec);
			if (refuse.creates) throw new KantelError("unavailable", "The sandbox's disk couldn't be partitioned");
			if (refuse.snapshotHost && spec.template?.snapshot !== undefined) {
				const { snapshot: _full, ...fresh } = spec.template;
				return { ...(await stub.create({ ...spec, template: fresh })), bootedFresh: true };
			}
			return stub.create(spec);
		},
		deleteSnapshot: async (ref) => {
			deletedSnapshots.push(ref);
			return stub.deleteSnapshot(ref);
		},
	};
	const {
		templateRuntimes: _runtimes,
		buildTemplate: _build,
		deleteTemplateSnapshot: _delete,
		...withoutTemplates
	} = base;
	const backend: SandboxBackend =
		options.templates === false
			? withoutTemplates
			: {
					...base,
					templateRuntimes: async () => runtimeHosts.map((hostId) => ({ hostId, ...runtime })),
					buildTemplate: (spec) =>
						new Promise<BuiltTemplate>((resolve, reject) => {
							let released = false;
							// The stub builds as its own host; the bytes are on the host asked.
							const make = () =>
								(stub.buildTemplate as NonNullable<SandboxBackend["buildTemplate"]>)({
									...spec,
									hostId: STUB_HOST_ID,
								}).then((built) => {
									bytesOnHosts.add(`${spec.hostId} ${spec.snapshotId}`);
									return { ...built, hostId: spec.hostId };
								});
							const run = (answer: (built: BuiltTemplate) => void) => {
								if (released) return;
								released = true;
								make().then(answer, reject);
							};
							const held: HeldBuild = {
								spec,
								release: () => run(resolve),
								fail: (message) => reject(new Error(message)),
								reject,
								timeOut: () =>
									run(() => reject(new KantelError("unavailable", "The host didn't answer the build in time"))),
								finishUnanswered: () => run(() => undefined),
							};
							builds.push(held);
							waiting.get(builds.length - 1)?.(held);
						}),
					deleteTemplateSnapshot: async (bytes) => {
						if (refuse.deletes) throw new KantelError("unavailable", "The host isn't connected");
						deletedTemplateSnapshots.push(bytes.ref ?? bytes.snapshotId);
						bytesOnHosts.delete(`${bytes.hostId} ${bytes.snapshotId}`);
						return stub.deleteTemplateSnapshot?.(bytes);
					},
				};
	/** Releases every build asked for, as they are asked for, until nothing is left running. */
	const releaseAll = async (idle: () => Promise<void>): Promise<void> => {
		let done = false;
		const settled = idle().then(() => {
			done = true;
		});
		while (!done) {
			for (const held of builds) held.release();
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await settled;
	};
	/** The `index`th build asked for (from 0), once it is. */
	const build = (index: number): Promise<HeldBuild> => {
		const asked = builds[index];
		if (asked !== undefined) return Promise.resolve(asked);
		return new Promise((resolve) => waiting.set(index, resolve));
	};
	return {
		backend,
		stub,
		runtime,
		runtimeHosts,
		hostSizes,
		refuse,
		builds,
		build,
		releaseAll,
		created,
		deletedSnapshots,
		deletedTemplateSnapshots,
		bytesOnHosts,
	};
}

function setup(
	options: {
		readonly templates?: boolean;
		readonly backendTemplates?: boolean;
		readonly store?: ComputeStore;
		readonly sizes?: readonly BackendSize[];
		readonly moreHosts?: readonly string[];
		readonly bytesOnHosts?: BytesOnHosts;
		/** Image patching on, with this index. */
		readonly baseImages?: BaseImages;
	} = {},
) {
	const fake = controllableBackend({
		...(options.backendTemplates === false ? { templates: false } : {}),
		...(options.sizes === undefined ? {} : { sizes: options.sizes }),
		...(options.moreHosts === undefined ? {} : { moreHosts: options.moreHosts }),
		...(options.bytesOnHosts === undefined ? {} : { bytesOnHosts: options.bytesOnHosts }),
	});
	// Real time, moved on by `clock.skip` (a build tried again once its host has had time to make room).
	const clock = { skip: 0 };
	const api = createComputeApi({
		backend: fake.backend,
		templates: options.templates ?? true,
		now: () => Date.now() + clock.skip,
		...(options.store === undefined ? {} : { store: options.store }),
		...(options.baseImages === undefined ? {} : { baseImages: options.baseImages }),
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
	});
	opened.push(api);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, ...fake, clock, client, tom: client("tom-token"), root: client("root-token") };
}

/** The error a call failed with; fails the test when it succeeded. */
async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

/** The machine the backend made for a sandbox. */
function specOf(created: readonly SandboxSpec[], sandboxId: string): SandboxSpec {
	const spec = created.find((each) => each.sandboxId === sandboxId);
	if (spec === undefined) throw new Error(`The backend made no machine for ${sandboxId}`);
	return spec;
}

describe("templateCacheKey", () => {
	const parts: computeSchema.TemplateCacheKey = {
		templateVersion: "tpl_one@1",
		baseDigest: D1,
		kernel: "6.1.100",
		firecracker: "1.10.1",
		vcpus: 2,
		memoryMb: 4096,
	};

	it("hashes the same parts the same, whatever order they come in", async () => {
		const { key, keyHash } = await templateCacheKey(parts);
		expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
		expect(key).toEqual(parts);
		const reordered = await templateCacheKey({
			memoryMb: 4096,
			vcpus: 2,
			firecracker: "1.10.1",
			kernel: "6.1.100",
			baseDigest: D1,
			templateVersion: "tpl_one@1",
		});
		expect(reordered.keyHash).toBe(keyHash);
		expect(Object.keys(reordered.key)).toEqual([
			"templateVersion",
			"baseDigest",
			"kernel",
			"firecracker",
			"vcpus",
			"memoryMb",
		]);
	});

	it("changes with each of its six parts", async () => {
		const { keyHash } = await templateCacheKey(parts);
		const changed: computeSchema.TemplateCacheKey[] = [
			{ ...parts, templateVersion: "tpl_one@2" },
			{ ...parts, baseDigest: D2 },
			{ ...parts, kernel: "6.1.101" },
			{ ...parts, firecracker: "1.11.0" },
			{ ...parts, vcpus: 4 },
			{ ...parts, memoryMb: 8192 },
		];
		const hashes = await Promise.all(changed.map(async (each) => (await templateCacheKey(each)).keyHash));
		for (const hash of hashes) expect(hash).not.toBe(keyHash);
		expect(new Set(hashes).size).toBe(hashes.length);
	});
});

describe("rebuilding", () => {
	it("builds a new version in the background, keeping the old snapshot stale until the new one is ready", async () => {
		const { api, tom, root, build, builds, deletedTemplateSnapshots } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		expect(template.version).toBe(1);
		expect(template.build.state).toBe("building");
		const first = await build(0);
		expect(first.spec).toMatchObject({
			templateId: template.id,
			version: 1,
			baseImage: "kantel/sandbox",
			baseDigest: D1,
			shape: { vcpus: 2, memoryMb: 4096 },
			env: { APP_MODE: "template" },
			setup: SETUP,
			hostId: STUB_HOST_ID,
		});
		first.release();
		await api.service.idle();
		const built = await tom.getTemplate(template.id);
		expect(built.build.state).toBe("ready");
		const old = built.build.ready;
		expect(old).toMatchObject({ version: 1, state: "ready", hostId: STUB_HOST_ID });
		expect(old?.builtFrom).toMatchObject({ baseDigest: D1, pinned: false, channel: "stable", kernel: "6.1.100" });
		expect(old?.builtFrom.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

		// A name or description alone makes no version, and builds nothing.
		await tom.updateTemplate(template.id, { description: "The web app" });
		expect((await tom.getTemplate(template.id)).version).toBe(1);

		const updated = await tom.updateTemplate(template.id, {
			spec: { ...SPEC, setup: `${SETUP} && echo two >> /opt/app/marker` },
		});
		expect(updated.version).toBe(2);
		const second = await build(1);
		expect(second.spec.version).toBe(2);
		// While it builds, the old one is kept, stale.
		const during = await tom.getTemplate(template.id);
		expect(during.build.state).toBe("building");
		expect(during.build.ready).toMatchObject({ id: old?.id, state: "stale" });
		expect(during.build.building?.version).toBe(2);
		expect(deletedTemplateSnapshots).toEqual([]);

		second.release();
		await api.service.idle();
		const after = await tom.getTemplate(template.id);
		expect(after.build.state).toBe("ready");
		expect(after.build.ready?.version).toBe(2);
		const snapshots = await tom.listTemplateSnapshots(template.id);
		expect(snapshots.items.map((each) => [each.version, each.state])).toEqual([
			[2, "ready"],
			[1, "discarded"],
		]);
		expect(deletedTemplateSnapshots).toHaveLength(1);
		const versions = await tom.listTemplateVersions(template.id);
		expect(versions.items.map((each) => each.version)).toEqual([2, 1]);
		expect(builds).toHaveLength(2);
	});

	it("rebuilds templates following a channel on a new base digest, but not pinned ones, which say how far behind", async () => {
		const { api, tom, root, build, builds, created } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const follower = await tom.createTemplate({ name: "follows", spec: SPEC });
		const pinned = await tom.createTemplate({
			name: "pinned",
			spec: { ...SPEC, base: { image: "kantel/sandbox", digest: D1 } },
		});
		(await build(0)).release();
		(await build(1)).release();
		await api.service.idle();
		const before = (await tom.getTemplate(follower.id)).build.ready;
		const pinnedBefore = await tom.listTemplateSnapshots(pinned.id);
		expect((await tom.getTemplate(pinned.id)).build.behind).toBeUndefined();

		// Only a super-admin publishes.
		expect(
			(await failure(tom.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D2 }))).code,
		).toBe("forbidden");
		const channel = await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D2 });
		expect(channel.history.map((release) => release.digest)).toEqual([D2, D1]);
		const rebuild = await build(2);
		expect(rebuild.spec).toMatchObject({ templateId: follower.id, baseDigest: D2 });

		// While it rebuilds, creates start from the stale snapshot: only the base digest differs.
		const during = await tom.getTemplate(follower.id);
		expect(during.build.ready).toMatchObject({ id: before?.id, state: "stale" });
		const sandbox = await tom.createSandbox({ template: "follows", wait: true });
		expect(sandbox.template).toEqual({
			id: follower.id,
			name: "follows",
			version: 1,
			snapshotId: before?.id,
			start: "snapshot",
		});
		expect(specOf(created, sandbox.id).template?.snapshot).toBe(
			(await api.store.templateSnapshots.get(before?.id ?? ""))?.ref,
		);

		rebuild.release();
		await api.service.idle();
		const after = await tom.getTemplate(follower.id);
		expect(after.build).toMatchObject({ state: "ready", ready: { builtFrom: { baseDigest: D2 } } });

		// The pinned one built nothing more, and is a release behind.
		expect(builds).toHaveLength(3);
		expect(await tom.listTemplateSnapshots(pinned.id)).toEqual(pinnedBefore);
		const behind = (await tom.getTemplate(pinned.id)).build.behind;
		expect(behind).toEqual({ releases: 1, since: channel.publishedAt, latestDigest: D2 });
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D3 });
		(await build(3)).release();
		await api.service.idle();
		expect((await tom.getTemplate(pinned.id)).build.behind).toMatchObject({ releases: 2, latestDigest: D3 });
		// The patching pipeline finds what was built from a digest.
		const fromD1 = await tom.listTemplates({ baseDigest: D1 });
		expect(fromD1.items.map((each) => each.name)).toEqual(["pinned"]);
		const bases = await tom.listTemplateBases();
		expect(bases.items).toMatchObject([{ image: "kantel/sandbox", channel: "stable", digest: D3 }]);
	});

	it("rebuilds on the sweep when a host's kernel or Firecracker changes", async () => {
		const { api, tom, root, build, runtime } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();

		runtime.kernel = "6.1.120";
		await api.service.sweep();
		const kernel = await build(1);
		expect(kernel.spec.templateId).toBe(template.id);
		kernel.release();
		await api.service.idle();
		let ready = (await tom.getTemplate(template.id)).build.ready;
		expect(ready?.key).toMatchObject({ kernel: "6.1.120", firecracker: "1.10.1" });

		runtime.firecracker = "1.12.0";
		await api.service.sweep();
		(await build(2)).release();
		await api.service.idle();
		ready = (await tom.getTemplate(template.id)).build.ready;
		expect(ready?.key).toMatchObject({ kernel: "6.1.120", firecracker: "1.12.0" });
		const states = (await tom.listTemplateSnapshots(template.id)).items.map((each) => each.state);
		expect(states).toEqual(["ready", "discarded", "discarded"]);

		// Nothing changed: the sweep builds nothing.
		await api.service.sweep();
		await api.service.idle();
		expect((await tom.listTemplateSnapshots(template.id)).items).toHaveLength(3);
	});
});

describe("creating from a template", () => {
	it("starts from the newest ready snapshot, on its host", async () => {
		const { api, tom, root, build, created } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({
			name: "web",
			spec: {
				...SPEC,
				network: { grants: [{ action: "allow", host: "registry.npmjs.org" }] },
			},
		});
		(await build(0)).release();
		await api.service.idle();
		const ready = (await tom.getTemplate(template.id)).build.ready;
		const stored = await api.store.templateSnapshots.get(ready?.id ?? "");

		const sandbox = await tom.createSandbox({ template: template.id, env: { OWN: "yes" }, wait: true });
		expect(sandbox).toMatchObject({ type: "microvm", size: "default", state: "running" });
		expect(sandbox.template).toEqual({
			id: template.id,
			name: "web",
			version: 1,
			snapshotId: ready?.id,
			start: "snapshot",
		});
		expect(sandbox.grants).toMatchObject([{ action: "allow", host: "registry.npmjs.org" }]);
		const spec = specOf(created, sandbox.id);
		expect(spec.template).toMatchObject({ snapshot: stored?.ref, baseImage: "kantel/sandbox", baseDigest: D1 });
		expect(spec.eligibleHosts).toEqual([STUB_HOST_ID]);
		expect(spec.env).toMatchObject({ APP_MODE: "template", OWN: "yes" });
		// What the setup left is there: the machine started from the snapshot.
		const marker = await tom.runCommand(sandbox.id, { command: "cat /opt/app/marker" });
		expect(marker.stdout).toBe("ready\n");
		expect((await tom.getTemplate(template.id)).sandboxCount).toBe(1);
	});

	it("boots fresh, running the setup itself, while the snapshot builds or after its build failed", async () => {
		const { api, tom, root, build, created } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		const held = await build(0);

		const building = await tom.createSandbox({ template: "web", wait: true });
		expect(building.template).toEqual({ id: template.id, name: "web", version: 1, start: "boot" });
		expect(specOf(created, building.id).template?.snapshot).toBeUndefined();
		expect(specOf(created, building.id).template?.setup).toBe(SETUP);
		expect((await tom.runCommand(building.id, { command: "cat /opt/app/marker" })).stdout).toBe("ready\n");

		held.fail("The image didn't build: no such package jq");
		await api.service.idle();
		const failed = await tom.getTemplate(template.id);
		expect(failed.build.state).toBe("failed");
		expect(failed.build.error).toContain("no such package");
		const afterFailure = await tom.createSandbox({ template: "web", wait: true });
		expect(afterFailure.template?.start).toBe("boot");
		expect(specOf(created, afterFailure.id).template?.snapshot).toBeUndefined();

		// A failed key isn't tried again by the sweep; a rebuild tries it.
		await api.service.sweep();
		await api.service.idle();
		expect((await tom.listTemplateSnapshots(template.id)).items).toHaveLength(1);
		await tom.rebuildTemplate(template.id);
		(await build(1)).release();
		await api.service.idle();
		expect((await tom.getTemplate(template.id)).build.state).toBe("ready");
	});

	it("refuses a template with an image or an isolate, one that isn't there, and a second of a name", async () => {
		const { api, tom, build } = setup();
		await tom.createTemplate({ name: "web", spec: SPEC });
		// No digest published on the default channel yet: the image's name alone, for each host's own sandbox image.
		const held = await build(0);
		expect(held.spec).toMatchObject({ baseImage: "kantel/sandbox", baseDigest: "" });
		held.release();
		await api.service.idle();
		expect((await failure(tom.createSandbox({ template: "web", type: "isolate" }))).code).toBe("invalid");
		expect((await failure(tom.createSandbox({ template: "web", image: "ubuntu-24.04" }))).code).toBe("invalid");
		expect((await failure(tom.createSandbox({ template: "nope" }))).code).toBe("not_found");
		expect((await failure(tom.createTemplate({ name: "web", spec: SPEC }))).code).toBe("conflict");
	});
});

describe("a template's setup", () => {
	it("runs only for a caller that may run commands, whatever the template's cache, while a template without one needs no more", async () => {
		const { api, tom, build, created, client } = setup({ sizes: HOST_SIZES });
		const writer = client(
			(await tom.createApiKey({ name: "writer", scopes: ["sandboxes:read", "sandboxes:write"] })).secret,
		);
		const runner = client(
			(await tom.createApiKey({ name: "runner", scopes: ["sandboxes:read", "sandboxes:write", "exec"] })).secret,
		);
		// An exported function named for a command the setup runs would run in its place, as root.
		const payload = { "BASH_FUNC_echo%%": "() { /usr/bin/touch /root/unauthorised-command; }" };
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		const held = await build(0);

		// No snapshot yet: a fresh boot would run the setup with the caller's env.
		expect((await failure(writer.createSandbox({ template: "web", env: payload, wait: true }))).code).toBe("forbidden");
		expect(created).toEqual([]);
		const fresh = await runner.createSandbox({ template: "web", env: { OWN: "yes" }, wait: true });
		expect(fresh).toMatchObject({ state: "running", template: { start: "boot" } });
		expect(specOf(created, fresh.id).env).toMatchObject({ OWN: "yes" });

		held.release();
		await api.service.idle();
		expect((await tom.getTemplate(template.id)).build.state).toBe("ready");
		// A snapshot ready: its host may still boot fresh (the snapshot lost, or another shape asked for).
		expect((await failure(writer.createSandbox({ template: "web", env: payload, wait: true }))).code).toBe("forbidden");
		expect(
			(await failure(writer.createSandbox({ template: "web", size: "large", env: payload, wait: true }))).code,
		).toBe("forbidden");
		expect(created).toHaveLength(1);
		const restored = await runner.createSandbox({ template: "web", wait: true });
		expect(restored.template).toMatchObject({ start: "snapshot" });

		// A template without setup runs nothing: sandboxes:write is enough, as for a plain create.
		await tom.createTemplate({ name: "bare", spec: { env: { APP_MODE: "bare" } } });
		(await build(1)).release();
		await api.service.idle();
		expect((await writer.createSandbox({ template: "bare", wait: true })).state).toBe("running");
		expect((await writer.createSandbox({ template: "bare", size: "large", wait: true })).state).toBe("running");
	});
});

describe("a template sandbox whose create failed", () => {
	it("is made again by Start and Recover from the base and setup its create resolved, whatever its template has become", async () => {
		const { api, tom, root, build, created, refuse, client } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		const ready = (await tom.getTemplate(template.id)).build.ready;

		refuse.creates = true;
		const ids: string[] = [];
		for (let i = 0; i < 2; i++) {
			const made = await tom.createSandbox({ template: "web", wait: true });
			expect(made).toMatchObject({ state: "error", template: { start: "snapshot", snapshotId: ready?.id } });
			ids.push(made.id);
		}
		refuse.creates = false;
		// Its template edited, then deleted, with its snapshot: none of that is the sandbox's.
		await tom.updateTemplate(template.id, {
			spec: { ...SPEC, setup: "mkdir -p /opt/app && echo two > /opt/app/marker" },
		});
		(await build(1)).release();
		await api.service.idle();
		await tom.deleteTemplate(template.id);
		await api.service.idle();

		// Made again, its setup runs: a caller who may not run commands can't have it run, as at its create.
		const writer = client(
			(await tom.createApiKey({ name: "writer", scopes: ["sandboxes:read", "sandboxes:write"] })).secret,
		);
		const [recovered = "", started = ""] = ids;
		expect((await failure(writer.recoverSandbox(recovered))).code).toBe("forbidden");
		expect((await failure(writer.startSandbox(started, { wait: true }))).code).toBe("forbidden");
		await tom.recoverSandbox(recovered);
		await tom.startSandbox(started, { wait: true });
		await api.service.idle();
		const lastSpec = (id: string) => created.filter((spec) => spec.sandboxId === id).at(-1);
		for (const id of ids) {
			const sandbox = await tom.getSandbox(id);
			expect(sandbox.state).toBe("running");
			// Booted fresh from the base and setup of version 1, the snapshot it was to start from gone.
			expect(lastSpec(id)?.template).toEqual({ baseImage: "kantel/sandbox", baseDigest: D1, setup: SETUP });
			expect(sandbox.template).toEqual({ id: template.id, name: "web", version: 1, start: "boot" });
			expect((await tom.runCommand(id, { command: "cat /opt/app/marker" })).stdout).toBe("ready\n");
		}

		// Placed now, a start boots its own disk: its setup isn't run again, and needs no more than a start.
		await tom.stopSandbox(started, { wait: true });
		const made = created.length;
		await writer.startSandbox(started, { wait: true });
		await api.service.idle();
		expect(created).toHaveLength(made);
		expect((await tom.getSandbox(started)).state).toBe("running");
	});

	it("is made again by a restart on latest only for a caller that may run its setup, refused before anything moves", async () => {
		const { api, tom, build, created, refuse, client } = setup({
			baseImages: { indexUrl: "https://example.test/index.json", index: async () => INDEX },
		});
		const writer = client(
			(await tom.createApiKey({ name: "writer", scopes: ["sandboxes:read", "sandboxes:write"] })).secret,
		);
		const runner = client(
			(await tom.createApiKey({ name: "runner", scopes: ["sandboxes:read", "sandboxes:write", "exec"] })).secret,
		);
		await tom.createTemplate({ name: "web", spec: SPEC });
		await tom.createTemplate({ name: "bare", spec: { env: { APP_MODE: "bare" } } });
		(await build(0)).release();
		(await build(1)).release();
		await api.service.idle();
		refuse.creates = true;
		const withSetup = await tom.createSandbox({ template: "web", wait: true });
		const bare = await tom.createSandbox({ template: "bare", wait: true });
		expect([withSetup.state, bare.state]).toEqual(["error", "error"]);
		refuse.creates = false;

		// Its setup would run: a caller who may not run commands is refused, its record as it was, nothing made.
		const asked = created.length;
		const before = await api.store.sandboxes.get(withSetup.id);
		expect((await failure(writer.restartSandboxOnLatest(withSetup.id))).code).toBe("forbidden");
		await api.service.idle();
		expect(await api.store.sandboxes.get(withSetup.id)).toEqual(before);
		expect(created).toHaveLength(asked);
		// One who may has it made again, its setup run.
		await runner.restartSandboxOnLatest(withSetup.id);
		await api.service.idle();
		expect((await tom.getSandbox(withSetup.id)).state).toBe("running");
		expect((await tom.runCommand(withSetup.id, { command: "cat /opt/app/marker" })).stdout).toBe("ready\n");

		// A template without setup runs nothing: sandboxes:write is enough.
		await writer.restartSandboxOnLatest(bare.id);
		await api.service.idle();
		expect((await tom.getSandbox(bare.id)).state).toBe("running");

		// Placed now, a restart boots its own disk: its setup isn't run again, and needs no more than sandboxes:write.
		const placed = created.length;
		await writer.restartSandboxOnLatest(withSetup.id);
		await api.service.idle();
		expect(created).toHaveLength(placed);
		expect((await tom.getSandbox(withSetup.id)).state).toBe("running");
	});
});

describe("a template sandbox's image", () => {
	it("is the base its snapshot was built from when restored, a release behind while its rebuild runs, and the resolved base when booted fresh", async () => {
		const { api, tom, root, build, refuse } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D2 });
		const rebuild = await build(1);

		// While D2's snapshot builds, a create restores D1's, stale: it runs D1, and says so.
		const restored = await tom.createSandbox({ template: "web", wait: true });
		expect(restored).toMatchObject({ image: `kantel/sandbox@${D1}`, template: { start: "snapshot" } });
		// A live fork is its source's machine, image and all.
		const {
			items: [live],
		} = await tom.forkSandbox(restored.id, { wait: true });
		expect(live?.image).toBe(`kantel/sandbox@${D1}`);

		// Its snapshot's host with no room: booted fresh from the channel's D2.
		refuse.snapshotHost = true;
		const fresh = await tom.createSandbox({ template: "web", wait: true });
		expect(fresh).toMatchObject({ image: `kantel/sandbox@${D2}`, template: { start: "boot" } });
		refuse.snapshotHost = false;

		// A create that failed is made again from its fresh-boot recipe, D2, not the snapshot it was to restore.
		refuse.creates = true;
		const failed = await tom.createSandbox({ template: "web", wait: true });
		expect(failed).toMatchObject({ state: "error", template: { start: "snapshot" } });
		refuse.creates = false;
		const retried = await tom.startSandbox(failed.id, { wait: true });
		expect(retried).toMatchObject({ state: "running", image: `kantel/sandbox@${D2}`, template: { start: "boot" } });

		// D2's snapshot ready, a create restores it.
		rebuild.release();
		await api.service.idle();
		const current = await tom.createSandbox({ template: "web", wait: true });
		expect(current).toMatchObject({ image: `kantel/sandbox@${D2}`, template: { start: "snapshot" } });
	});
});

describe("invalidating the template cache", () => {
	it("never touches the account's own snapshots", async () => {
		const { api, tom, root, build, deletedSnapshots, deletedTemplateSnapshots } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const own = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.runCommand(own.id, { command: "echo mine > notes.txt" });
		await tom.takeSnapshot(own.id, {});
		await api.service.idle();
		const snapshots = await api.store.snapshots.list();
		expect(snapshots.length).toBeGreaterThan(0);

		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();

		await tom.rebuildTemplate(template.id);
		(await build(1)).release();
		await api.service.idle();
		await tom.updateTemplate(template.id, { spec: { ...SPEC, env: { APP_MODE: "two" } } });
		(await build(2)).release();
		await api.service.idle();
		await tom.deleteTemplate(template.id);
		await api.service.idle();

		expect(deletedTemplateSnapshots).toHaveLength(3);
		expect(deletedSnapshots).toEqual([]);
		expect(await api.store.snapshots.list()).toEqual(snapshots);
		expect(await api.store.templateSnapshots.list()).toEqual([]);
		expect(await api.store.templateVersions.list()).toEqual([]);
		expect((await failure(tom.getTemplate(template.id))).code).toBe("not_found");
	});
});

describe("a template's image", () => {
	it("is Kantel's base, filled in when left out, and the backend is given only the base's name and digest", async () => {
		const { api, tom, build, created, releaseAll } = setup();
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		expect(template.spec).toMatchObject({
			image: { kind: "kantel-base" },
			base: { image: "kantel/sandbox", channel: "stable" },
		});
		const named = await tom.createTemplate({ name: "named", spec: { ...SPEC, image: { kind: "kantel-base" } } });
		expect(named.spec.image).toEqual({ kind: "kantel-base" });

		// A build and a fresh boot carry no Dockerfile or image reference: the base, which hosts pull by digest.
		const held = await build(0);
		expect(held.spec).toMatchObject({ baseImage: "kantel/sandbox", baseDigest: "" });
		for (const key of ["image", "dockerfile", "imageRef"]) expect(held.spec).not.toHaveProperty(key);
		const sandbox = await tom.createSandbox({ template: "web", wait: true });
		expect(specOf(created, sandbox.id).template).toEqual({ baseImage: "kantel/sandbox", baseDigest: "", setup: SETUP });
		expect(sandbox.image).toBe("kantel/sandbox");
		await releaseAll(() => api.service.idle());
	});

	it("refuses a Dockerfile, an image reference, and a base naming a registry, tag or digest", async () => {
		const { api, tom, releaseAll } = setup();
		const refused = [
			{ ...SPEC, image: { kind: "dockerfile", dockerfile: "FROM alpine\nRUN apk add jq\n" } },
			{ ...SPEC, image: { kind: "image", ref: "ghcr.io/acme/agent:1" } },
			{ ...SPEC, base: { image: "registry.example.com:5000/acme/base", channel: "stable" } },
			{ ...SPEC, base: { image: "kantel/sandbox:latest", channel: "stable" } },
			{ ...SPEC, base: { image: `kantel/sandbox@${D1}`, channel: "stable" } },
		];
		for (const spec of refused) {
			const error = await failure(tom.createTemplate({ name: "bad", spec: spec as computeSchema.TemplateSpec }));
			expect(error.code).toBe("invalid");
		}
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		const edit = {
			spec: { ...SPEC, image: { kind: "image", ref: "acme/agent:1" } } as unknown as computeSchema.TemplateSpec,
		};
		expect((await failure(tom.updateTemplate(template.id, edit))).code).toBe("invalid");
		expect((await tom.listTemplates()).items.map((each) => [each.name, each.version])).toEqual([["web", 1]]);
		await releaseAll(() => api.service.idle());
	});
});

describe("a template's base", () => {
	it("is a channel the deployment published, or the default one before it publishes", async () => {
		const { api, tom, root, build, releaseAll } = setup();
		for (const base of [
			{ image: "kantel/sandbox", channel: "beta" },
			{ image: "acme/base", channel: "stable" },
		]) {
			const error = await failure(tom.createTemplate({ name: "web", spec: { ...SPEC, base } }));
			expect(error.code).toBe("invalid");
			expect(error.message).toBe(
				`This deployment publishes no channel ${base.channel} of the base image ${base.image}`,
			);
		}
		// The default channel, unpublished: each host's own sandbox image.
		await tom.createTemplate({
			name: "default",
			spec: { ...SPEC, base: { image: "kantel/sandbox", channel: "stable" } },
		});
		expect((await build(0)).spec).toMatchObject({ baseImage: "kantel/sandbox", baseDigest: "" });

		await root.publishTemplateBase({ image: "acme/base", channel: "stable", digest: D1 });
		const acme = await tom.createTemplate({
			name: "acme",
			spec: { ...SPEC, base: { image: "acme/base", channel: "stable" } },
		});
		const held = await build(1);
		expect(held.spec).toMatchObject({ templateId: acme.id, baseImage: "acme/base", baseDigest: D1 });
		await releaseAll(() => api.service.idle());
	});

	it("pinned, is a digest one of its image's channels published", async () => {
		const { api, tom, root, build, releaseAll } = setup();
		const pin = (image: string, digest: string): computeSchema.TemplateSpec => ({ ...SPEC, base: { image, digest } });
		const refusal = (image: string, digest: string) =>
			`No channel of the base image ${image} on this deployment has published ${digest}`;
		// Nothing published: not even the default image's digest.
		let error = await failure(tom.createTemplate({ name: "web", spec: pin("kantel/sandbox", D1) }));
		expect(error).toMatchObject({ code: "invalid", message: refusal("kantel/sandbox", D1) });

		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D2 });
		await root.publishTemplateBase({ image: "acme/base", channel: "stable", digest: D3 });
		// Another image's digest is not this image's.
		error = await failure(tom.createTemplate({ name: "web", spec: pin("kantel/sandbox", D3) }));
		expect(error).toMatchObject({ code: "invalid", message: refusal("kantel/sandbox", D3) });
		// A digest from the channel's history, not only its current one; and one another channel of the image published.
		const old = await tom.createTemplate({ name: "old", spec: pin("kantel/sandbox", D1) });
		expect((await build(0)).spec).toMatchObject({ templateId: old.id, baseImage: "kantel/sandbox", baseDigest: D1 });
		await root.publishTemplateBase({ image: "acme/base", channel: "beta", digest: D2 });
		await tom.createTemplate({ name: "acme", spec: pin("acme/base", D2) });

		// A change to an unpublished pin is refused, and makes no version.
		error = await failure(tom.updateTemplate(old.id, { spec: pin("acme/base", D1) }));
		expect(error).toMatchObject({ code: "invalid", message: refusal("acme/base", D1) });
		expect((await tom.getTemplate(old.id)).version).toBe(1);
		// One keeping its pin is allowed, even after the channel's history has dropped it.
		await api.store.templateBases.update("kantel/sandbox:stable", (current) => ({
			...current,
			history: current.history.filter((release) => release.digest !== D1),
		}));
		const edited = await tom.updateTemplate(old.id, { spec: { ...pin("kantel/sandbox", D1), setup: "echo two" } });
		expect(edited.version).toBe(2);
		await releaseAll(() => api.service.idle());
	});
});

describe("the switch", () => {
	it("off, every template route and a create naming a template answer not_supported", async () => {
		const { tom, root } = setup({ templates: false });
		for (const call of [
			tom.listTemplates(),
			tom.createTemplate({ name: "web", spec: SPEC }),
			tom.getTemplate("tpl_none"),
			tom.listTemplateBases(),
			root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 }),
			tom.createSandbox({ template: "web" }),
		]) {
			const error = await failure(call);
			expect(error.code).toBe("not_supported");
			expect(error.message).toContain("KANTEL_TEMPLATES");
		}
		// Sandboxes without one are made as ever.
		expect((await tom.createSandbox({ wait: true })).state).toBe("running");
	});

	it("on, with a backend that can't build templates, answers not_supported", async () => {
		const { tom } = setup({ backendTemplates: false });
		expect((await failure(tom.listTemplates())).code).toBe("not_supported");
	});
});

const sqlTimeout = pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs };

describe("a SQL store", sqlTimeout, () => {
	it("keeps templates, their versions, snapshots and base channels", async () => {
		const database = await pgliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const { api, tom, root, build } = setup({ store: createSqlComputeStore(database.driver) });
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		const sandbox = await tom.createSandbox({ template: "web", wait: true });
		expect(sandbox.template?.start).toBe("snapshot");
		expect((await tom.getTemplate(template.id)).build.state).toBe("ready");
		expect((await tom.listTemplateBases()).items).toHaveLength(1);
	});

	it("keeps a retirement cut short for a new service's sweep to finish, its bytes still to delete kept for later", async () => {
		const database = await pgliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const sql = createSqlComputeStore(database.driver);
		// The database goes away part-way through the retirement: after its template is marked, before its versions go.
		let failing = false;
		const store: ComputeStore = {
			...sql,
			templateVersions: {
				...sql.templateVersions,
				delete: async (id) => {
					if (failing) throw new Error("The database went away");
					return sql.templateVersions.delete(id);
				},
			},
		};
		const first = setup({ store });
		await first.root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const web = await first.tom.createTemplate({ name: "web", spec: SPEC });
		(await first.build(0)).release();
		await first.api.service.idle();
		await first.tom.updateTemplate(web.id, { spec: { ...SPEC, setup: "echo two" } });
		(await first.build(1)).release();
		await first.api.service.idle();
		const [ready] = (await sql.templateSnapshots.list({ templateId: web.id })).filter(
			(entry) => entry.state === "ready",
		);
		expect(await sql.templateVersions.list({ templateId: web.id })).toHaveLength(2);

		first.refuse.deletes = true;
		failing = true;
		await failure(first.tom.deleteTemplate(web.id));
		// Gone to callers already, its records left behind.
		expect((await failure(first.tom.getTemplate(web.id))).code).toBe("not_found");
		expect((await first.tom.listTemplates()).items).toEqual([]);
		expect((await sql.templates.get(web.id))?.retiredAt).toBeDefined();
		expect(await sql.templateVersions.list({ templateId: web.id })).toHaveLength(2);

		// A new service over the same records, its host unable to delete for now: its sweep finishes the retirement,
		// keeping the bytes to delete.
		const second = setup({ store: sql });
		second.refuse.deletes = true;
		await second.api.service.sweep();
		await second.api.service.idle();
		expect(await sql.templates.list()).toEqual([]);
		expect(await sql.templateVersions.list()).toEqual([]);
		const kept = await sql.templateSnapshots.list();
		expect(kept.map((entry) => [entry.id, entry.state, entry.ref])).toContainEqual([ready?.id, "deleting", ready?.ref]);
		expect(kept.every((entry) => entry.state === "deleting")).toBe(true);

		second.refuse.deletes = false;
		await second.api.service.sweep();
		await second.api.service.idle();
		expect(await sql.templateSnapshots.list()).toEqual([]);
		expect(second.deletedTemplateSnapshots).toContain(ready?.ref);
	});
});

describe("rebuilding on request", () => {
	it("keeps the ready snapshot usable, stale, until the rebuild's is ready, and after a rebuild that failed", async () => {
		const { api, tom, root, build, builds, deletedTemplateSnapshots } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		const ready = (await tom.getTemplate(template.id)).build.ready;
		const ref = (await api.store.templateSnapshots.get(ready?.id ?? ""))?.ref;

		await tom.rebuildTemplate(template.id);
		const failing = await build(1);
		const during = await tom.getTemplate(template.id);
		expect(during.build).toMatchObject({ state: "building", ready: { id: ready?.id, state: "stale" } });
		expect(deletedTemplateSnapshots).toEqual([]);
		const whileBuilding = await tom.createSandbox({ template: "web", wait: true });
		expect(whileBuilding.template).toMatchObject({ start: "snapshot", snapshotId: ready?.id });

		// The rebuild fails: the old snapshot goes on serving creates, through sweeps too.
		failing.fail("The registry was down");
		await api.service.idle();
		await api.service.sweep();
		await api.service.idle();
		const failed = await tom.getTemplate(template.id);
		expect(failed.build).toMatchObject({ state: "failed", ready: { id: ready?.id, state: "stale" } });
		expect(deletedTemplateSnapshots).toEqual([]);
		expect((await tom.createSandbox({ template: "web", wait: true })).template?.snapshotId).toBe(ready?.id);

		// A rebuild that succeeds replaces it, and only then is it thrown away. The failed build is thrown away at once,
		// whatever it may have left on its host deleted by its ID.
		await tom.rebuildTemplate(template.id);
		const succeeding = await build(2);
		expect(deletedTemplateSnapshots).toEqual([failing.spec.snapshotId]);
		succeeding.release();
		await api.service.idle();
		const after = await tom.getTemplate(template.id);
		expect(after.build.state).toBe("ready");
		expect(after.build.ready?.id).not.toBe(ready?.id);
		expect(deletedTemplateSnapshots).toEqual([failing.spec.snapshotId, ref]);
		expect((await api.store.templateSnapshots.get(ready?.id ?? ""))?.state).toBe("discarded");
		expect(builds).toHaveLength(3);
	});
});

describe("a template snapshot the backend lost", () => {
	it("boots fresh, running the setup with the sandbox's variables, recorded as a fresh boot, while the records still have it ready", async () => {
		const { api, tom, root, build, stub, created } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({
			name: "web",
			spec: { ...SPEC, setup: 'mkdir -p /opt/app && echo "$APP_MODE $OWN" > /opt/app/vars' },
		});
		(await build(0)).release();
		await api.service.idle();
		const ready = (await tom.getTemplate(template.id)).build.ready;
		const stored = await api.store.templateSnapshots.get(ready?.id ?? "");
		// As a restart loses the stub's template snapshots, while their records outlast it.
		await stub.deleteTemplateSnapshot?.({ snapshotId: ready?.id ?? "", hostId: STUB_HOST_ID, ref: stored?.ref ?? "" });

		const sandbox = await tom.createSandbox({ template: "web", env: { OWN: "mine" }, wait: true });
		expect(sandbox.state).toBe("running");
		expect((await tom.runCommand(sandbox.id, { command: "cat /opt/app/vars" })).stdout).toBe("template mine\n");
		// Asked to start from the snapshot, the backend booted fresh: so its record says, without the snapshot.
		expect(specOf(created, sandbox.id).template?.snapshot).toBe(stored?.ref);
		expect(sandbox.template).toEqual({ id: template.id, name: "web", version: 1, start: "boot" });
		expect((await tom.getTemplate(template.id)).build.ready?.id).toBe(ready?.id);
	});
});

/** A host's sizes: two with 4 vCPUs, none with a template's default 2 vCPUs and 4096 MB. */
const HOST_SIZES: readonly BackendSize[] = [
	{ name: "small", vcpus: 1, memoryMb: 1024, diskGb: 10 },
	{ name: "default", vcpus: 4, memoryMb: 2048, diskGb: 20 },
	{ name: "large", vcpus: 4, memoryMb: 8192, diskGb: 50 },
];

describe("a template's machine", () => {
	it("is exactly its resources, for the build, the snapshot's key, a restore, a fresh boot and the sandbox's record", async () => {
		const { api, tom, root, build, created, stub } = setup({ sizes: HOST_SIZES });
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		// 2 vCPUs and 4096 MB, a shape no size has, so named by none; its host gives the disk.
		const shape = { vcpus: 2, memoryMb: 4096 };
		// While it builds, a fresh boot as that shape.
		const held = await build(0);
		expect(held.spec.shape).toEqual(shape);
		const fresh = await tom.createSandbox({ template: "web", wait: true });
		expect(fresh).toMatchObject({ resources: shape, template: { start: "boot" } });
		expect(fresh.size).toBeUndefined();
		expect(specOf(created, fresh.id)).toMatchObject({ shape });
		expect(specOf(created, fresh.id).size).toBeUndefined();
		held.release();
		await api.service.idle();
		const ready = (await tom.getTemplate(template.id)).build.ready;
		expect(ready?.key).toMatchObject(shape);

		// Restored: the same machine, recorded the same.
		const restored = await tom.createSandbox({ template: "web", wait: true });
		expect(restored).toMatchObject({ resources: shape, template: { start: "snapshot", snapshotId: ready?.id } });
		expect(restored.resources).toEqual(fresh.resources);
		expect(specOf(created, restored.id)).toMatchObject({ shape });
		// Its snapshot lost to the backend: booted fresh as the same machine still.
		await stub.deleteTemplateSnapshot?.({ snapshotId: ready?.id ?? "", hostId: STUB_HOST_ID });
		const lost = await tom.createSandbox({ template: "web", wait: true });
		expect(lost.resources).toEqual(fresh.resources);

		// A size named: that size's machine, which no snapshot was built as, so a fresh boot, never another restored.
		for (const [size, sized] of [
			["default", { vcpus: 4, memoryMb: 2048 }],
			["large", { vcpus: 4, memoryMb: 8192 }],
		] as const) {
			const made = await tom.createSandbox({ template: "web", size, wait: true });
			expect(made).toMatchObject({ size, resources: sized, template: { start: "boot" } });
			expect(specOf(created, made.id)).toMatchObject({ size, shape: sized });
			expect(specOf(created, made.id).template?.snapshot).toBeUndefined();
		}
	});

	it("is refused where no host it may use can make it, for its builds and its sandboxes", async () => {
		const { api, tom, root, builds, hostSizes } = setup({ sizes: HOST_SIZES });
		// A host from before custom shapes, which makes only its sizes: none is a template's default 2 vCPUs and 4096 MB.
		hostSizes.set(STUB_HOST_ID, HOST_SIZES);
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		await tom.createTemplate({ name: "web", spec: SPEC });
		await api.service.idle();
		expect(builds).toEqual([]);
		expect((await failure(tom.createSandbox({ template: "web" }))).code).toBe("not_supported");
		// Named by a size it has, it makes it, booted fresh.
		const sized = await tom.createSandbox({ template: "web", size: "large", wait: true });
		expect(sized).toMatchObject({
			size: "large",
			resources: { vcpus: 4, memoryMb: 8192 },
			template: { start: "boot" },
		});
	});
});

describe("a template sandbox's snapshots and forks", () => {
	it("are made as its actual machine, the snapshot keeping it, and a live fork as its source whatever size it asks", async () => {
		const { api, tom, build, created } = setup({ sizes: HOST_SIZES });
		await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		// 2 vCPUs and 4096 MB, a shape no size has.
		const shape = { vcpus: 2, memoryMb: 4096 };
		const source = await tom.createSandbox({ template: "web", wait: true });
		expect(source).toMatchObject({ resources: shape });
		expect(source.size).toBeUndefined();
		const snapshot = await tom.takeSnapshot(source.id, {});
		expect(snapshot.resources).toEqual(source.resources);
		expect(snapshot.size).toBeUndefined();

		// From the snapshot, a create and a fork: placed, held and recorded as that machine.
		const made = await tom.createSandbox({ from: snapshot.id, wait: true });
		expect(made.resources).toEqual(source.resources);
		expect(made.size).toBeUndefined();
		expect(specOf(created, made.id)).toMatchObject({ shape });
		const {
			items: [forked],
		} = await tom.forkSandbox(source.id, { snapshotId: snapshot.id, wait: true });
		expect(forked?.resources).toEqual(source.resources);
		// Another size asked for: that size's machine, as its placement says.
		const sized = await tom.createSandbox({ from: snapshot.id, size: "default", wait: true });
		expect(sized.size).toBe("default");
		expect(specOf(created, sized.id)).toMatchObject({ size: "default" });
		expect(specOf(created, sized.id).shape).toBeUndefined();

		// Forked live: its source's machine, whatever size it asks for, as a host copies the running machine.
		const {
			items: [live],
		} = await tom.forkSandbox(source.id, { size: "default", wait: true });
		expect(live?.resources).toEqual(source.resources);
		expect(live?.size).toBeUndefined();
	});
});

describe("saving a snapshot of a template sandbox", () => {
	it("keeps the machine a resource-only snapshot records, not the sandbox's since, while a legacy one takes the sandbox's", async () => {
		const { api, tom, build, created } = setup({ sizes: HOST_SIZES });
		await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		// 2 vCPUs and 4096 MB, a shape no size has: its snapshots record resources and no size.
		const shape = { vcpus: 2, memoryMb: 4096 };
		const source = await tom.createSandbox({ template: "web", wait: true });
		const taken = await tom.takeSnapshot(source.id, {});
		expect(taken).toMatchObject({ resources: shape });
		expect(taken.size).toBeUndefined();

		// Started again as another size: saving the earlier snapshot keeps the machine it records.
		await tom.stopSandbox(source.id, { wait: true });
		const large = await tom.startSandbox(source.id, { size: "large", wait: true });
		expect(large).toMatchObject({ size: "large", resources: { vcpus: 4, memoryMb: 8192 } });
		const saved = await tom.saveSnapshot({ sandboxId: source.id, snapshotId: taken.id, name: "first" });
		expect(saved.resources).toEqual(taken.resources);
		expect(saved.size).toBeUndefined();
		const made = await tom.createSandbox({ from: saved.id, wait: true });
		expect(made.resources).toEqual(taken.resources);
		expect(specOf(created, made.id)).toMatchObject({ shape });

		// Stopped, its newest snapshot is saved: the machine that records, though its record has since moved on (a
		// restart as another size that failed, say).
		await tom.stopSandbox(made.id, { wait: true });
		const stopped = await tom.getSandbox(made.id);
		const latest = (await api.store.snapshots.get(stopped.latestSnapshotId ?? "")) ?? expect.fail("no snapshot");
		expect(latest).toMatchObject({ resources: { ...shape, diskGb: expect.any(Number) } });
		await api.store.sandboxes.update(made.id, (current) => ({
			...current,
			size: "large",
			resources: { vcpus: 4, memoryMb: 8192, diskGb: 50 },
		}));
		const newest = await tom.saveSnapshot({ sandboxId: made.id, name: "newest" });
		expect(newest.resources).toEqual(latest.resources);
		expect(newest.size).toBeUndefined();

		// A snapshot from before sizes records neither: it is taken to be of the sandbox's machine.
		await api.store.snapshots.update(latest.id, ({ resources: _none, size: _neither, ...rest }) => rest);
		const legacy = await tom.saveSnapshot({ sandboxId: made.id, name: "legacy" });
		expect(legacy).toMatchObject({ size: "large", resources: { vcpus: 4, memoryMb: 8192, diskGb: 50 } });
	});
});

describe("a template snapshot's host with no room", () => {
	it("has the create boot the template fresh elsewhere, recorded as a fresh boot", async () => {
		const { api, tom, build, refuse, created } = setup({ moreHosts: ["host_b"] });
		await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		refuse.snapshotHost = true;
		const sandbox = await tom.createSandbox({ template: "web", wait: true });
		expect(sandbox.state).toBe("running");
		expect(sandbox.template?.start).toBe("boot");
		expect(sandbox.template?.snapshotId).toBeUndefined();
		// Asked with the snapshot, and every host it may use, for the fresh boot.
		const spec = specOf(created, sandbox.id);
		expect(spec.template?.snapshot).toBeDefined();
		expect([...spec.eligibleHosts].sort()).toEqual([STUB_HOST_ID, "host_b"].sort());
	});
});

describe("a template's build host", () => {
	it("is one that can make its shape, of each runtime, not merely the first host with that runtime", async () => {
		const { api, tom, build, hostSizes, runtimeHosts } = setup({ sizes: HOST_SIZES, moreHosts: ["host_small"] });
		// The small host comes first, and makes only `small`, not the template's 2 vCPUs and 4096 MB.
		runtimeHosts.reverse();
		hostSizes.set("host_small", [HOST_SIZES[0] as BackendSize]);
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		const held = await build(0);
		expect(held.spec.hostId).toBe(STUB_HOST_ID);
		held.release();
		await api.service.idle();
		expect((await tom.getTemplate(web.id)).build.state).toBe("ready");
		// No host can make it: nothing is built.
		hostSizes.set(STUB_HOST_ID, [HOST_SIZES[0] as BackendSize]);
		await tom.updateTemplate(web.id, { spec: { ...SPEC, setup: "true" } });
		await api.service.idle();
		expect((await api.store.templateSnapshots.list()).filter((entry) => entry.version === 2)).toEqual([]);
	});
});

describe("a template snapshot's bytes", () => {
	it("are kept to delete, and deleted on a later sweep, when its host can't delete them now", async () => {
		const { api, tom, root, build, refuse, deletedTemplateSnapshots } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		const [built] = await api.store.templateSnapshots.list({ templateId: web.id });
		const api2 = await tom.createTemplate({ name: "api", spec: SPEC });
		const inFlight = await build(1);

		// Deleted while its host can't delete: the template goes, and its entry stays, `deleting`; and so does that of
		// the build in flight, whose result is thrown away when it finishes.
		refuse.deletes = true;
		await tom.deleteTemplate(web.id);
		await tom.deleteTemplate(api2.id);
		inFlight.release();
		await api.service.idle();
		expect(await api.store.templates.list()).toEqual([]);
		const kept = await api.store.templateSnapshots.list();
		expect(kept.map((entry) => entry.state)).toEqual(["deleting", "deleting"]);
		expect(kept.map((entry) => entry.ref)).toContain(built?.ref);
		await api.service.sweep();
		await api.service.idle();
		expect(await api.store.templateSnapshots.list()).toHaveLength(2);
		expect(deletedTemplateSnapshots).toEqual([]);

		// Its host back: the sweep deletes them, and their entries go with them.
		refuse.deletes = false;
		await api.service.sweep();
		await api.service.idle();
		expect(await api.store.templateSnapshots.list()).toEqual([]);
		expect([...deletedTemplateSnapshots].sort()).toEqual(kept.map((entry) => entry.ref).sort());
	});

	it("of a stale snapshot replaced while its host can't delete are kept to delete, its key not built again till then", async () => {
		const { api, tom, root, build, refuse, deletedTemplateSnapshots } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		const [first] = await api.store.templateSnapshots.list({ templateId: web.id });
		refuse.deletes = true;
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D2 });
		(await build(1)).release();
		await api.service.idle();
		const replaced = await api.store.templateSnapshots.get(first?.id ?? "");
		expect(replaced).toMatchObject({ state: "deleting", ref: first?.ref });
		// On the wire it is thrown away.
		expect((await tom.listTemplateSnapshots(web.id)).items.find((entry) => entry.id === first?.id)?.state).toBe(
			"discarded",
		);
		refuse.deletes = false;
		await api.service.sweep();
		await api.service.idle();
		expect(deletedTemplateSnapshots).toEqual([first?.ref]);
		expect(await api.store.templateSnapshots.get(first?.id ?? "")).toMatchObject({ state: "discarded" });
		expect((await api.store.templateSnapshots.get(first?.id ?? ""))?.ref).toBeUndefined();
	});
});

describe("a template snapshot's bytes from a build that never answered", () => {
	it("are deleted by its ID on its host when a rebuild sets it aside, kept to delete while its host can't", async () => {
		const { api, tom, root, build, refuse, deletedTemplateSnapshots } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		// Its host finishes the snapshot after the build's call has given up on it.
		(await build(0)).timeOut();
		await api.service.idle();
		const [failed] = await api.store.templateSnapshots.list({ templateId: web.id });
		expect(failed).toMatchObject({ state: "failed", hostId: STUB_HOST_ID });
		expect(failed?.ref).toBeUndefined();

		refuse.deletes = true;
		await tom.rebuildTemplate(web.id);
		(await build(1)).release();
		await api.service.idle();
		expect(await api.store.templateSnapshots.get(failed?.id ?? "")).toMatchObject({ state: "deleting" });
		await api.service.sweep();
		await api.service.idle();
		expect(await api.store.templateSnapshots.get(failed?.id ?? "")).toMatchObject({ state: "deleting" });

		refuse.deletes = false;
		await api.service.sweep();
		await api.service.idle();
		expect(deletedTemplateSnapshots).toEqual([failed?.id]);
		expect(await api.store.templateSnapshots.get(failed?.id ?? "")).toMatchObject({ state: "discarded" });
		expect((await tom.getTemplate(web.id)).build.state).toBe("ready");
	});

	it("are deleted when its template is deleted, the entry outliving the template until its host has deleted them", async () => {
		const { api, tom, build, refuse, deletedTemplateSnapshots } = setup();
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).timeOut();
		await api.service.idle();
		const [failed] = await api.store.templateSnapshots.list({ templateId: web.id });
		refuse.deletes = true;
		await tom.deleteTemplate(web.id);
		expect(await api.store.templates.list()).toEqual([]);
		expect(await api.store.templateVersions.list()).toEqual([]);
		expect(await api.store.templateSnapshots.list()).toMatchObject([{ id: failed?.id, state: "deleting" }]);

		refuse.deletes = false;
		await api.service.sweep();
		await api.service.idle();
		expect(deletedTemplateSnapshots).toEqual([failed?.id]);
		expect(await api.store.templateSnapshots.list()).toEqual([]);
	});

	it("of a build thrown away while it ran are left to it while it runs, and deleted by its ID once it fails", async () => {
		const { api, tom, build, refuse, deletedTemplateSnapshots } = setup();
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		const held = await build(0);
		await tom.deleteTemplate(web.id);
		// Its host holds the bytes while it builds them: nothing is asked of it till the build ends.
		const [entry] = await api.store.templateSnapshots.list();
		expect(entry).toMatchObject({ state: "deleting" });
		expect(entry?.buildLeaseEnds).toBe((entry?.startedAt ?? 0) + TEMPLATE_BUILD_LEASE_MS);
		expect(deletedTemplateSnapshots).toEqual([]);

		refuse.deletes = true;
		held.timeOut();
		await api.service.idle();
		expect(await api.store.templateSnapshots.list()).toMatchObject([{ id: entry?.id, state: "deleting" }]);
		expect((await api.store.templateSnapshots.get(entry?.id ?? ""))?.buildLeaseEnds).toBeUndefined();
		refuse.deletes = false;
		await api.service.sweep();
		await api.service.idle();
		expect(deletedTemplateSnapshots).toEqual([entry?.id]);
		expect(await api.store.templateSnapshots.list()).toEqual([]);
	});
});

/** Waits for `done`, polling: work another part of the service does in the background meanwhile. */
async function until(done: () => Promise<boolean>): Promise<void> {
	for (let i = 0; i < 400 && !(await done()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	if (!(await done())) throw new Error("Gave up waiting");
}

// The rule: every obsolete template snapshot's bytes stay scheduled for deletion until their host has deleted them,
// whether their template and account are still there or not. Each test ends with no bytes left on any host but the ready
// snapshots still used.
describe("an obsolete template snapshot's bytes", () => {
	it("from builds its host finished after their calls timed out are deleted by their IDs, through a rebuild and the template's deletion", async () => {
		const { api, tom, build, bytesOnHosts } = setup();
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).timeOut();
		await api.service.idle();
		const [first] = await api.store.templateSnapshots.list({ templateId: web.id });
		expect(first).toMatchObject({ state: "failed", hostId: STUB_HOST_ID });
		expect([...bytesOnHosts]).toEqual([`${STUB_HOST_ID} ${first?.id}`]);

		await tom.rebuildTemplate(web.id);
		const second = await build(1);
		expect([...bytesOnHosts]).toEqual([]);
		second.timeOut();
		await api.service.idle();
		expect([...bytesOnHosts]).toEqual([`${STUB_HOST_ID} ${second.spec.snapshotId}`]);

		await tom.deleteTemplate(web.id);
		await api.service.idle();
		expect([...bytesOnHosts]).toEqual([]);
		expect(await api.store.templateSnapshots.list()).toEqual([]);
	});

	it("from a failed build are deleted by its ID when its key is no longer wanted: a new version, or a new digest of its channel", async () => {
		const { api, tom, root, build, bytesOnHosts } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).timeOut();
		await api.service.idle();
		const [first] = await api.store.templateSnapshots.list({ templateId: web.id });
		expect(first).toMatchObject({ state: "failed" });
		expect([...bytesOnHosts]).toEqual([`${STUB_HOST_ID} ${first?.id}`]);

		// A new version: the failed v1 entry's key is no longer wanted, so its bytes go without a rebuild or a deletion.
		await tom.updateTemplate(web.id, { spec: { ...SPEC, setup: `${SETUP} && echo two >> /opt/app/marker` } });
		const second = await build(1);
		expect(second.spec.version).toBe(2);
		expect([...bytesOnHosts]).toEqual([]);
		second.timeOut();
		await api.service.idle();
		expect([...bytesOnHosts]).toEqual([`${STUB_HOST_ID} ${second.spec.snapshotId}`]);

		// A new digest of the channel it follows: the same.
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D2 });
		await api.service.sweep();
		(await build(2)).release();
		await api.service.idle();
		const entries = await api.store.templateSnapshots.list({ templateId: web.id });
		const ready = entries.find((entry) => entry.state === "ready");
		expect(ready?.key.baseDigest).toBe(D2);
		expect([...bytesOnHosts]).toEqual([`${STUB_HOST_ID} ${ready?.id}`]);
		expect(entries.filter((entry) => entry.state === "failed" || entry.state === "deleting")).toEqual([]);
	});

	it("answered while a retirement removes its entry are kept to delete: its record goes only while it is discarded", async () => {
		// The memory store, its entries' removal holding back while a build's answer comes in, just before it is made.
		const memory = createMemoryStore();
		let race: ((id: string) => Promise<void>) | undefined;
		const store: ComputeStore = {
			...memory,
			templateSnapshots: {
				...memory.templateSnapshots,
				deleteIf: async (id, when) => {
					const run = race;
					race = undefined;
					await run?.(id);
					return memory.templateSnapshots.deleteIf(id, when);
				},
			},
		};
		const { api, tom, build, refuse, clock, bytesOnHosts } = setup({ store });
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		const held = await build(0);
		await tom.deleteTemplate(web.id);
		expect(await memory.templates.list()).toEqual([]);
		const [entry] = await memory.templateSnapshots.list();
		expect(entry).toMatchObject({ state: "deleting" });

		// Its build outlives its lease: a sweep deletes by its ID what its host has so far (nothing), and its record is to
		// go; meanwhile the build answers, its result thrown away, and its host is gone before its bytes can be deleted.
		clock.skip += TEMPLATE_BUILD_LEASE_MS;
		race = async (id) => {
			refuse.deletes = true;
			held.release();
			await until(async () => (await memory.templateSnapshots.get(id))?.ref !== undefined);
		};
		await api.service.sweep();
		await api.service.idle();
		expect(race).toBeUndefined();
		expect(await memory.templateSnapshots.list()).toMatchObject([{ id: entry?.id, state: "deleting" }]);
		expect([...bytesOnHosts]).toEqual([`${STUB_HOST_ID} ${entry?.id}`]);

		refuse.deletes = false;
		await api.service.sweep();
		await api.service.idle();
		expect([...bytesOnHosts]).toEqual([]);
		expect(await memory.templateSnapshots.list()).toEqual([]);
	});

	it("of a build left running on its host by a gateway that restarted are deleted there when another builds its key elsewhere", async () => {
		const store = createMemoryStore();
		const bytesOnHosts: BytesOnHosts = new Set();
		const first = setup({ store, bytesOnHosts, moreHosts: ["host_b"] });
		const web = await first.tom.createTemplate({ name: "web", spec: SPEC });
		const abandoned = await first.build(0);
		expect(abandoned.spec.hostId).toBe(STUB_HOST_ID);
		// Its gateway is gone: the host finishes the snapshot, and nobody hears.
		abandoned.finishUnanswered();
		await until(async () => bytesOnHosts.size === 1);

		// A new gateway once the build's lease has lapsed, its host now host_b, and the old host unreachable for a while.
		const second = setup({ store, bytesOnHosts, moreHosts: ["host_b"] });
		second.runtimeHosts.splice(0, 1);
		second.clock.skip = TEMPLATE_BUILD_LEASE_MS;
		second.refuse.deletes = true;
		await second.api.service.sweep();
		const again = await second.build(0);
		expect(again.spec).toMatchObject({ hostId: "host_b", keyHash: abandoned.spec.keyHash });
		expect(again.spec.snapshotId).not.toBe(abandoned.spec.snapshotId);
		again.release();
		await second.api.service.idle();
		expect((await second.tom.getTemplate(web.id)).build).toMatchObject({
			state: "ready",
			ready: { id: again.spec.snapshotId, hostId: "host_b" },
		});
		// The abandoned entry keeps its ID and host, its bytes there to delete.
		expect(await store.templateSnapshots.get(abandoned.spec.snapshotId)).toMatchObject({
			state: "deleting",
			hostId: STUB_HOST_ID,
		});
		await second.api.service.sweep();
		await second.api.service.idle();
		expect(bytesOnHosts.has(`${STUB_HOST_ID} ${abandoned.spec.snapshotId}`)).toBe(true);

		// The old host back: the sweep deletes them there.
		second.refuse.deletes = false;
		await second.api.service.sweep();
		await second.api.service.idle();
		expect([...bytesOnHosts]).toEqual([`host_b ${again.spec.snapshotId}`]);
		expect(await store.templateSnapshots.get(abandoned.spec.snapshotId)).toMatchObject({ state: "discarded" });

		// The first gateway's build call ends at last: nothing of it is used, and nothing more is left.
		abandoned.fail("The gateway went away");
		await first.api.service.idle();
		expect([...bytesOnHosts]).toEqual([`host_b ${again.spec.snapshotId}`]);
		expect((await second.tom.getTemplate(web.id)).build.ready?.id).toBe(again.spec.snapshotId);
	});

	it("are kept to delete while their host is down, however they were thrown away, and deleted once it is back", async () => {
		const { api, tom, build, refuse, bytesOnHosts } = setup();
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		await tom.updateTemplate(web.id, { spec: { ...SPEC, setup: "echo two" } });
		const inFlight = await build(1);

		// Its host down: a rebuild throws away the build in flight, whose result is then rejected; the rebuild's
		// snapshot replaces the stale one; and the template is deleted, with its ready one.
		refuse.deletes = true;
		await tom.rebuildTemplate(web.id);
		inFlight.release();
		(await build(2)).release();
		await api.service.idle();
		expect((await tom.getTemplate(web.id)).build).toMatchObject({ state: "ready", ready: { version: 2 } });
		await tom.deleteTemplate(web.id);
		await api.service.sweep();
		await api.service.idle();
		expect(await api.store.templates.list()).toEqual([]);
		const kept = await api.store.templateSnapshots.list();
		expect(kept.map((entry) => entry.state)).toEqual(["deleting", "deleting", "deleting"]);
		expect(bytesOnHosts.size).toBe(3);

		refuse.deletes = false;
		await api.service.sweep();
		await api.service.idle();
		expect([...bytesOnHosts]).toEqual([]);
		expect(await api.store.templateSnapshots.list()).toEqual([]);
	});
});

describe("a build whose key is no longer wanted", () => {
	it("deferred for want of room, is thrown away, so the template is ready once its new version's is", async () => {
		const { api, tom, build, builds } = setup();
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).reject(new KantelError("exhausted", "The host has no room to build the template now"));
		await api.service.idle();
		const [deferred] = await api.store.templateSnapshots.list({ templateId: web.id });
		expect(deferred).toMatchObject({ state: "queued", version: 1 });

		await tom.updateTemplate(web.id, { spec: { ...SPEC, setup: "echo two" } });
		(await build(1)).release();
		await api.service.idle();
		expect((await tom.getTemplate(web.id)).build).toMatchObject({ state: "ready", ready: { version: 2 } });
		expect(await api.store.templateSnapshots.get(deferred?.id ?? "")).toMatchObject({ state: "discarded" });
		await api.service.sweep();
		await api.service.idle();
		expect(builds).toHaveLength(2);
	});

	it("still running, throws its result away when it finishes, its bytes deleted", async () => {
		const { api, tom, build, deletedTemplateSnapshots } = setup();
		const web = await tom.createTemplate({ name: "web", spec: SPEC });
		const old = await build(0);
		await tom.updateTemplate(web.id, { spec: { ...SPEC, setup: "echo two" } });
		const current = await build(1);
		// The old one is no longer reported building: the new version's alone is.
		expect((await tom.getTemplate(web.id)).build).toMatchObject({ state: "building", building: { version: 2 } });
		current.release();
		for (let i = 0; i < 200 && (await tom.getTemplate(web.id)).build.state !== "ready"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect((await tom.getTemplate(web.id)).build).toMatchObject({ state: "ready", ready: { version: 2 } });

		old.release();
		await api.service.idle();
		const entries = await api.store.templateSnapshots.list({ templateId: web.id });
		expect(entries.map((entry) => [entry.version, entry.state])).toEqual([
			[1, "discarded"],
			[2, "ready"],
		]);
		expect(deletedTemplateSnapshots).toHaveLength(1);
		expect((await tom.getTemplate(web.id)).build).toMatchObject({ state: "ready", ready: { version: 2 } });
	});
});

describe("hosts that can't boot templates", () => {
	it("get no template's sandbox, which is then not_supported, while other creates go on", async () => {
		const { api, tom, runtimeHosts, builds } = setup();
		runtimeHosts.splice(0);
		await tom.createTemplate({ name: "web", spec: SPEC });
		await api.service.idle();
		expect(builds).toEqual([]);
		expect((await failure(tom.createSandbox({ template: "web" }))).code).toBe("not_supported");
		expect((await tom.createSandbox({ type: "microvm", wait: true })).state).toBe("running");
	});
});

describe("a build its host has no room for", () => {
	it("stays queued, and is tried again once a while has passed", async () => {
		const { api, tom, root, build, builds, clock } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const template = await tom.createTemplate({ name: "web", spec: SPEC });
		(await build(0)).reject(new KantelError("exhausted", "The host has no room to build the template now"));
		await api.service.idle();
		const waiting = await tom.getTemplate(template.id);
		expect(waiting.build.state).toBe("building");
		expect(waiting.build.error).toBeUndefined();
		// Not straight away: the host needs time to make room.
		await api.service.sweep();
		await api.service.idle();
		expect(builds).toHaveLength(1);

		clock.skip += TEMPLATE_BUILD_RETRY_MS;
		await api.service.sweep();
		(await build(1)).release();
		await api.service.idle();
		expect((await tom.getTemplate(template.id)).build.state).toBe("ready");
	});
});

describe("deleting an organisation", () => {
	it("retires its templates, their versions and cache, and builds nothing more for it", async () => {
		const { api, tom, root, build, builds, deletedSnapshots, deletedTemplateSnapshots } = setup();
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D1 });
		const own = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.takeSnapshot(own.id, {});
		await api.service.idle();
		const snapshots = await api.store.snapshots.list();

		const org = await tom.createOrganisation({ name: "Acme" });
		const web = await tom.createTemplate({ account: org.id, name: "web", spec: SPEC });
		(await build(0)).release();
		await api.service.idle();
		const [built] = await api.store.templateSnapshots.list({ templateId: web.id });

		// A sandbox of it left: refused, and nothing retired.
		const left = await tom.createSandbox({ account: org.id, template: "web", wait: true });
		expect((await failure(tom.deleteOrganisation(org.id))).code).toBe("conflict");
		expect(await api.store.templates.list({ accountId: org.id })).toHaveLength(1);
		await tom.deleteSandbox(left.id);
		await api.service.idle();
		await tom.createTemplate({ account: org.id, name: "api", spec: SPEC });
		const inFlight = await build(1);

		await tom.deleteOrganisation(org.id);
		expect(await api.store.templates.list({ accountId: org.id })).toEqual([]);
		expect(await api.store.templateVersions.list()).toEqual([]);
		// The build in flight's entry is kept to delete whatever it leaves on its host, once it ends.
		expect((await api.store.templateSnapshots.list()).map((entry) => [entry.templateId, entry.state])).toEqual([
			[inFlight.spec.templateId, "deleting"],
		]);
		expect(deletedTemplateSnapshots).toEqual([built?.ref]);

		// The build in flight finishes: its result is thrown away, never published.
		inFlight.release();
		await api.service.idle();
		expect(await api.store.templateSnapshots.list()).toEqual([]);
		expect(deletedTemplateSnapshots).toHaveLength(2);

		// Neither a base publication nor a sweep builds for it.
		await root.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: D2 });
		await api.service.sweep();
		await api.service.idle();
		expect(builds).toHaveLength(2);
		// The account's own snapshots were never touched.
		expect(deletedSnapshots).toEqual([]);
		expect(await api.store.snapshots.list()).toEqual(snapshots);
	});

	it("retires on the sweep a template its deleted account left behind", async () => {
		const { api, tom, builds } = setup();
		await tom.listSandboxes();
		const orphan = storedTemplate("tpl_orphan", "acc_gone", "web");
		await api.store.templateWrites.insert(orphan, firstVersion(orphan));
		await api.service.sweep();
		await api.service.idle();
		expect(await api.store.templates.get(orphan.id)).toBeUndefined();
		expect(await api.store.templateVersions.list()).toEqual([]);
		expect(builds).toEqual([]);
	});
});

/** A template as the store keeps it, at version 1. */
function storedTemplate(id: string, accountId: string, name: string): StoredTemplate {
	return {
		id,
		accountId,
		name,
		version: 1,
		spec: { ...SPEC, base: { image: "kantel/sandbox", channel: "stable" } },
		cacheEpoch: 0,
		ownerUserId: "usr_tom",
		createdAt: 1,
		updatedAt: 1,
		createdBy: { kind: "user", id: "usr_tom", name: "Tom" },
	};
}

const firstVersion = (template: StoredTemplate): StoredTemplateVersion => ({
	id: `${template.id}@1`,
	templateId: template.id,
	version: 1,
	spec: template.spec,
	createdAt: template.createdAt,
	createdBy: template.createdBy,
});

/** Each store, fresh: memory, and SQL on Postgres (PGlite) and SQLite. */
const STORES: readonly { readonly name: string; readonly kind?: TestDatabaseKind }[] = [
	{ name: "the memory store" },
	{ name: `a SQL store on ${pgliteDatabase.name}`, kind: pgliteDatabase },
	{ name: `a SQL store on ${nodeSqliteDatabase.name}`, kind: nodeSqliteDatabase },
];

/** A fresh SQL store over `kind`, its driver's batches passed through `wrap`. */
async function sqlStore(kind: TestDatabaseKind, wrap: (driver: SqlDriver) => SqlDriver = (driver) => driver) {
	const database = await kind.open();
	cleanups.push(() => database.close());
	await migrateComputeStore(database.driver);
	return createSqlComputeStore(wrap(database.driver));
}

for (const each of STORES) {
	const open = (): Promise<ComputeStore> =>
		each.kind === undefined ? Promise.resolve(createMemoryStore()) : sqlStore(each.kind);
	const timeout = each.kind?.testTimeoutMs === undefined ? {} : { timeout: each.kind.testTimeoutMs };

	describe(`template writes in ${each.name}`, timeout, () => {
		it("refuse a second template of a name in an account, in the write, but not in another account", async () => {
			const store = await open();
			const web = storedTemplate("tpl_a", "acc_1", "web");
			expect(await store.templateWrites.insert(web, firstVersion(web))).toBe(true);
			const twin = storedTemplate("tpl_b", "acc_1", "web");
			await expect(store.templateWrites.insert(twin, firstVersion(twin))).rejects.toBeInstanceOf(UniqueViolation);
			expect(await store.templates.get(twin.id)).toBeUndefined();
			expect(await store.templateVersions.get(`${twin.id}@1`)).toBeUndefined();
			const elsewhere = storedTemplate("tpl_c", "acc_2", "web");
			expect(await store.templateWrites.insert(elsewhere, firstVersion(elsewhere))).toBe(true);

			// A rename to a name another holds is refused; a change keeping its own name isn't.
			const other = storedTemplate("tpl_d", "acc_1", "api");
			await store.templateWrites.insert(other, firstVersion(other));
			await expect(
				store.templateWrites.update(other.id, (current) => ({ template: { ...current, name: "web" } })),
			).rejects.toBeInstanceOf(UniqueViolation);
			expect((await store.templates.get(other.id))?.name).toBe("api");
			const described = await store.templateWrites.update(other.id, (current) => ({
				template: { ...current, description: "The API" },
			}));
			expect(described).toMatchObject({ name: "api", version: 1, description: "The API" });
			expect(await store.templates.list({ accountId: "acc_1", name: "web" })).toHaveLength(1);
		});

		it("record a version with the template that reaches it", async () => {
			const store = await open();
			const web = storedTemplate("tpl_a", "acc_1", "web");
			await store.templateWrites.insert(web, firstVersion(web));
			const spec = { ...web.spec, setup: "echo two" };
			const changed = await store.templateWrites.update(web.id, (current) => ({
				template: { ...current, version: 2, spec },
				version: { ...firstVersion(current), id: `${web.id}@2`, version: 2, spec },
			}));
			expect(changed).toMatchObject({ version: 2, spec: { setup: "echo two" } });
			expect((await store.templateVersions.get(`${web.id}@2`))?.spec.setup).toBe("echo two");
			expect(await store.templateVersions.list({ templateId: web.id })).toHaveLength(2);
		});
	});
}

for (const kind of [pgliteDatabase, nodeSqliteDatabase]) {
	const timeout = kind.testTimeoutMs === undefined ? {} : { timeout: kind.testTimeoutMs };

	describe(`templates over a SQL store on ${kind.name}`, timeout, () => {
		it("give a contested name to exactly one of concurrent creates and renames, and conflict to the rest", async () => {
			const { api, tom, releaseAll } = setup({ store: await sqlStore(kind) });
			// Tom's first call makes his personal account: before the race, so both calls are in one account.
			await tom.listTemplates();
			const outcomes = async (calls: readonly Promise<unknown>[]) => {
				const settled = await Promise.allSettled(calls);
				const refused = settled.flatMap((each) =>
					each.status === "rejected" && each.reason instanceof KantelApiError ? [each.reason.code] : [],
				);
				return { won: settled.filter((each) => each.status === "fulfilled").length, refused };
			};
			// Create and create.
			expect(
				await outcomes([
					tom.createTemplate({ name: "web", spec: SPEC }),
					tom.createTemplate({ name: "web", spec: { ...SPEC, setup: "echo other" } }),
				]),
			).toEqual({ won: 1, refused: ["conflict"] });
			const one = await tom.createTemplate({ name: "one", spec: SPEC });
			const two = await tom.createTemplate({ name: "two", spec: SPEC });
			// Rename and rename.
			expect(
				await outcomes([tom.updateTemplate(one.id, { name: "api" }), tom.updateTemplate(two.id, { name: "api" })]),
			).toEqual({ won: 1, refused: ["conflict"] });
			// Create and rename.
			const [renamed] = (await tom.listTemplates()).items.filter((each) => each.name !== "api" && each.name !== "web");
			expect(
				await outcomes([
					tom.createTemplate({ name: "cli", spec: SPEC }),
					tom.updateTemplate(renamed?.id ?? "", { name: "cli" }),
				]),
			).toEqual({ won: 1, refused: ["conflict"] });
			const names = (await tom.listTemplates()).items.map((each) => each.name).sort();
			expect(names).toEqual([...new Set(names)]);
			expect(names).toEqual(expect.arrayContaining(["api", "cli", "web"]));
			// A rename made no version; each template resolves by name, as by ID.
			const api2 = (await tom.listTemplates()).items.find((each) => each.name === "api");
			expect(api2?.version).toBe(1);
			await releaseAll(api.service.idle);
			expect((await tom.createSandbox({ template: "api", wait: true })).template?.id).toBe(api2?.id);
		});

		it("keep both of two concurrent edits making the same version, one renaming and one describing", async () => {
			// Both edits' first reads see the template as it was: neither reads until both have.
			let reads = 0;
			let bothRead: () => void = () => undefined;
			const barrier = new Promise<void>((resolve) => {
				bothRead = resolve;
			});
			const store = await sqlStore(kind, (driver) => ({
				...driver,
				query: (async (sql: string, params?: readonly SqlValue[]) => {
					const rows = await driver.query(sql, params);
					if (sql.startsWith("SELECT data, version") && params?.[0] === "templates" && ++reads <= 2) {
						if (reads === 2) bothRead();
						await barrier;
					}
					return rows;
				}) as SqlDriver["query"],
			}));
			const web = storedTemplate("tpl_a", "acc_1", "web");
			await store.templateWrites.insert(web, firstVersion(web));
			// As the service edits: one clock and one actor, so both make the very same version 2 from the same spec, which
			// only a changed spec makes.
			const spec = { ...web.spec, setup: "echo two" };
			const edit =
				(fields: Partial<StoredTemplate>) =>
				(current: StoredTemplate): TemplateChange => {
					const respecified = JSON.stringify(current.spec) !== JSON.stringify(spec);
					const version = respecified ? current.version + 1 : current.version;
					return {
						template: { ...current, ...fields, spec, version, updatedAt: 2 },
						...(respecified
							? { version: { ...firstVersion(current), id: `${web.id}@${version}`, version, spec, createdAt: 2 } }
							: {}),
					};
				};
			const [renamed, described] = await Promise.all([
				store.templateWrites.update(web.id, edit({ name: "api" })),
				store.templateWrites.update(web.id, edit({ description: "The API" })),
			]);
			expect(reads).toBeGreaterThan(2);
			// Each answers what it wrote, and the template has both.
			expect(renamed).toMatchObject({ name: "api", version: 2 });
			expect(described).toMatchObject({ description: "The API", version: 2 });
			expect(await store.templates.get(web.id)).toMatchObject({
				name: "api",
				description: "The API",
				version: 2,
				spec: { setup: "echo two" },
			});
			const versions = await store.templateVersions.list({ templateId: web.id });
			expect(versions.map((each) => [each.version, each.spec.setup])).toEqual([
				[1, SPEC.setup],
				[2, "echo two"],
			]);
		});

		it("commit each version with the template, through a failed write, a retry and concurrent edits", async () => {
			let failNext = false;
			// The batch's second statement (the version's insert) fails, as a write dying part-way would.
			const store = await sqlStore(kind, (driver) => ({
				...driver,
				batch: (statements) => {
					if (!failNext) return driver.batch(statements);
					failNext = false;
					return driver.batch([...statements.slice(0, 1), { sql: "SELECT no_such_column FROM compute_api_records" }]);
				},
			}));
			const { api, tom, releaseAll } = setup({ store });
			const template = await tom.createTemplate({ name: "web", spec: SPEC });
			const two = { ...SPEC, setup: "echo two" };
			failNext = true;
			await failure(tom.updateTemplate(template.id, { spec: two }));
			expect((await tom.getTemplate(template.id)).version).toBe(1);
			expect((await tom.listTemplateVersions(template.id)).items.map((each) => each.version)).toEqual([1]);

			// The same edit again makes version 2, with its own definition; again, nothing more.
			expect((await tom.updateTemplate(template.id, { spec: two })).version).toBe(2);
			expect((await tom.updateTemplate(template.id, { spec: two })).version).toBe(2);
			// Two different edits at once: a version each, each with its own definition.
			await Promise.all([
				tom.updateTemplate(template.id, { spec: { ...SPEC, setup: "echo three" } }),
				tom.updateTemplate(template.id, { spec: { ...SPEC, setup: "echo four" } }),
			]);
			const versions = (await tom.listTemplateVersions(template.id)).items;
			expect(versions.map((each) => each.version)).toEqual([4, 3, 2, 1]);
			expect(versions.find((each) => each.version === 2)?.spec.setup).toBe("echo two");
			expect(new Set(versions.slice(0, 2).map((each) => each.spec.setup))).toEqual(
				new Set(["echo three", "echo four"]),
			);
			const current = await tom.getTemplate(template.id);
			expect(current.spec).toEqual(versions[0]?.spec);
			await releaseAll(api.service.idle);
		});
	});
}

describe("The stub's create of a template sandbox", () => {
	it("is the only one for its sandbox while its setup runs: a second create of it is a conflict, not a replacement", async () => {
		const stub = createStubBackend();
		const spec = {
			sandboxId: "sbx_once",
			accountId: "acc_a",
			type: "microvm" as const,
			subdomain: "once",
			env: {},
			eligibleHosts: [STUB_HOST_ID],
			template: { baseImage: "kantel/sandbox", baseDigest: "", setup: "echo one > /root/marker" },
		};
		const [first, second] = await Promise.allSettled([stub.create(spec), stub.create(spec)]);
		expect(first.status).toBe("fulfilled");
		expect(second).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
		// Once it's made, it is still the one machine, and one that failed lets a later create of its ID through.
		await expect(stub.create(spec)).rejects.toMatchObject({ code: "conflict" });
		const failing = { ...spec, sandboxId: "sbx_failed", template: { ...spec.template, setup: "exit 1" } };
		await expect(stub.create(failing)).rejects.toMatchObject({ code: "invalid" });
		await expect(stub.create({ ...failing, template: spec.template })).resolves.toMatchObject({});
	});
});
