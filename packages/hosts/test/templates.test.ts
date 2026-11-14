// Templates over hosts: the runtime each host reports (its Firecracker and guest kernel), template snapshots built and
// deleted on the host a build names (an account's own host only for that account), and a sandbox made from one placed
// on the host holding it, with its template relayed, as the shape it asks for. Only a host that reports templates gets
// either, and a build is admitted and holds its machine's memory and disk as a create does.
import {
	type BackendEgress,
	type SandboxBackend,
	type SandboxSpec,
	TEMPLATE_BUILD_LEASE_MS,
	type TemplateBuildSpec,
} from "@kantel/compute";
import { isKantelError, placementReasonOf } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { parseHostFacts } from "../src/facts.ts";
import { HOST_FEATURES } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { customSizeName } from "../src/scheduler.ts";
import {
	createHostsService,
	type HostsService,
	TEMPLATE_BUILD_TIMEOUT_MS,
	TEMPLATE_IMAGE_BUILD_TIMEOUT_MS,
	unanswered,
} from "../src/service.ts";
import { createMemoryHostStore, type HostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost, facts } from "./fake-host.ts";

const RUNTIME = { firecracker: "v1.17.0", guestKernel: "6.1.102+0123456789ab" };

describe("host facts' runtime", () => {
	it("keeps a host's Firecracker and guest kernel, and leaves them out when it reports none", () => {
		expect(parseHostFacts({ ...facts(), ...RUNTIME })).toMatchObject({ ok: true, value: RUNTIME });
		for (const none of [{}, { firecracker: "", guestKernel: null }]) {
			const parsed = parseHostFacts({ ...facts(), ...none });
			expect(parsed.ok).toBe(true);
			expect(parsed.ok && "firecracker" in parsed.value).toBe(false);
			expect(parsed.ok && "guestKernel" in parsed.value).toBe(false);
		}
		expect(parseHostFacts({ ...facts(), firecracker: 17 })).toMatchObject({ ok: false });
		expect(parseHostFacts({ ...facts(), guestKernel: "x".repeat(300) })).toMatchObject({ ok: false });
	});
});

const services: HostsService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
});

async function addHost(
	store: HostStore,
	service: HostsService,
	id: string,
	options: {
		accountId?: string;
		runtime?: boolean;
		draining?: boolean;
		old?: boolean;
		templates?: boolean;
		custom?: boolean;
		/** It builds templates' custom images in a build microVM (`HOST_FEATURES.templateImages`). */
		images?: boolean;
		freeMemoryMiB?: number;
	} = {},
) {
	await store.insertHost({
		id,
		name: id,
		labels: {},
		credentialHash: "x",
		revoked: false,
		draining: options.draining === true,
		joinedAt: 1,
		...(options.accountId === undefined ? {} : { accountId: options.accountId }),
	});
	// Enforcing egress grants, making custom shapes and running templates, as a host from since templates does;
	// `templates: false`, one from just before them; `custom: false`, one making only its named sizes; `old`, one from
	// before egress grants too.
	const features =
		options.old === true
			? undefined
			: [
					HOST_FEATURES.egressPolicy,
					...(options.custom === false ? [] : [HOST_FEATURES.customShapes]),
					...(options.templates === false ? [] : [HOST_FEATURES.templates]),
					...(options.images === true ? [HOST_FEATURES.templateImages] : []),
				];
	const host = new FakeHost(service, id, features);
	if (options.freeMemoryMiB !== undefined) host.freeMemoryMiB = options.freeMemoryMiB;
	if (options.runtime !== false) host.moreFacts = RUNTIME;
	host.connect();
	await new Promise((resolve) => setTimeout(resolve, 5));
	return host;
}

async function setup(options: { readonly callTimeoutMs?: number } = {}) {
	const store = createMemoryHostStore();
	const service = createHostsService({ store, publicUrl: "https://kantel.test", log: () => undefined, ...options });
	services.push(service);
	const backend: SandboxBackend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
		attributionKey: "the-deployment-key",
	});
	return { store, service, backend };
}

const EGRESS: BackendEgress = {
	defaultAction: "deny",
	allow: ["deb.debian.org"],
	deny: [],
	attribution: true,
	grants: [{ action: "allow", host: "api.github.com", paths: ["/repos/**"], rule: "allow api.github.com /repos/**" }],
};

const BASE_DIGEST = `sha256:${"b".repeat(64)}`;

const buildSpec = (hostId: string, accountId = "acc_a"): TemplateBuildSpec => ({
	snapshotId: "tsn_1",
	accountId,
	templateId: "tpl_1",
	version: 2,
	baseImage: "kantel/sandbox",
	baseDigest: BASE_DIGEST,
	shape: { vcpus: 2, memoryMb: 2048 },
	env: { MODE: "agent" },
	setup: "apt-get install -y jq",
	egress: EGRESS,
	keyHash: "k1",
	hostId,
});

describe("host backend templates", () => {
	it("answers each connected, undrained microVM host's runtime, unknown for a host that reports none", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_new");
		await addHost(store, service, "host_old", { runtime: false });
		await addHost(store, service, "host_drained", { draining: true });
		await store.insertHost({
			id: "host_away",
			name: "away",
			labels: {},
			credentialHash: "x",
			revoked: false,
			draining: false,
			joinedAt: 1,
			facts: { ...facts(), ...RUNTIME },
		});
		expect(await backend.templateRuntimes?.()).toEqual([
			{ hostId: "host_new", kernel: RUNTIME.guestKernel, firecracker: RUNTIME.firecracker },
			{ hostId: "host_old", kernel: "unknown", firecracker: "unknown" },
		]);
	});

	it("builds on the host the spec names, with a ref naming that host, and deletes it there", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a");
		const other = await addHost(store, service, "host_b");
		const built = await backend.buildTemplate?.(buildSpec("host_b"));
		expect(built).toEqual({ ref: "host_b/tsn_1", hostId: "host_b", imageDigest: "sha256:feed", sizeBytes: 42 });
		const call = other.calls.find((each) => each.method === "template.build");
		// The base image's name and digest, which the host pulls from its operator's registry: nothing it builds.
		expect(Object.keys(call?.params ?? {}).sort()).toEqual([
			"baseDigest",
			"baseImage",
			"diskGiB",
			"egress",
			"env",
			"keyHash",
			"memoryMiB",
			"owner",
			"setup",
			"snapshotId",
			"vcpus",
		]);
		expect(call?.params).toMatchObject({
			snapshotId: "tsn_1",
			baseImage: "kantel/sandbox",
			baseDigest: BASE_DIGEST,
			setup: "apt-get install -y jq",
			env: { MODE: "agent" },
			vcpus: 2,
			memoryMiB: 2048,
			keyHash: "k1",
			owner: "acc_a",
			egress: { mode: "proxy", grants: [{ action: "allow", host: "api.github.com", paths: ["/repos/**"] }] },
		});
		// The default channel with no digest published yet: the image's name alone, for the host's own sandbox image.
		await backend.buildTemplate?.({ ...buildSpec("host_b"), baseDigest: "" });
		const second = other.calls.filter((each) => each.method === "template.build")[1]?.params;
		expect(second).toMatchObject({ baseImage: "kantel/sandbox" });
		expect(second !== undefined && "baseDigest" in second).toBe(false);
		await backend.deleteTemplateSnapshot?.({ snapshotId: "tsn_1", hostId: "host_b", ref: "host_b/tsn_1" });
		expect(other.calls.at(-1)).toEqual({ method: "template.delete", params: { snapshotId: "tsn_1" } });
		// A build whose answer never came has no ref: its bytes, if it made them, are deleted by its ID on its host.
		await backend.deleteTemplateSnapshot?.({ snapshotId: "tsn_2", hostId: "host_b" });
		expect(other.calls.at(-1)).toEqual({ method: "template.delete", params: { snapshotId: "tsn_2" } });
	});

	it("answers what a template snapshot was made on where its host says, as kantel-host sends it", async () => {
		const { store, service, backend } = await setup();
		const host = await addHost(store, service, "host_a");
		const cpu = { vendor: "AuthenticAMD", family: 25, model: 97, featuresHash: "sha256:0123456789abcdef" };
		const runtime = "firecracker=v1.17.0;kernel=6.1.102+0123456789ab;image=host-images-20261103;sticky=4";
		host.madeOn = { cpu, runtime };
		expect(await backend.buildTemplate?.(buildSpec("host_a"))).toMatchObject({ cpu, runtime });
		host.madeOn = { cpu: { ...cpu, model: "97" }, runtime: "" };
		const odd = await backend.buildTemplate?.(buildSpec("host_a"));
		expect(odd).not.toHaveProperty("cpu");
		expect(odd).not.toHaveProperty("runtime");
	});

	it("builds on an account's own host only for that account, and gives it no attribution key", async () => {
		const { store, service, backend } = await setup();
		const own = await addHost(store, service, "host_own", { accountId: "acc_a" });
		await expect(backend.buildTemplate?.(buildSpec("host_own", "acc_b"))).rejects.toSatisfy((error) =>
			isKantelError(error, "unavailable"),
		);
		expect(own.calls.some((each) => each.method === "template.build")).toBe(false);
		await backend.buildTemplate?.(buildSpec("host_own", "acc_a"));
		const params = own.calls.find((each) => each.method === "template.build")?.params as { egress?: object };
		expect(params.egress).not.toHaveProperty("attributionKey");
		await expect(backend.buildTemplate?.(buildSpec("host_nowhere"))).rejects.toSatisfy((error) =>
			isKantelError(error, "not_found"),
		);
		// A host from before egress grants (and templates) is sent no build.
		await addHost(store, service, "host_old", { old: true });
		await expect(backend.buildTemplate?.(buildSpec("host_old"))).rejects.toSatisfy((error) =>
			isKantelError(error, "not_supported"),
		);
	});

	it("puts a sandbox made from a template snapshot on its host, and relays the template", async () => {
		const { store, service, backend } = await setup();
		const first = await addHost(store, service, "host_a");
		const holder = await addHost(store, service, "host_b");
		const template = { baseImage: "kantel/sandbox", baseDigest: BASE_DIGEST, setup: "touch /ready" };
		const spec: SandboxSpec = {
			sandboxId: "sbx_from_tpl",
			accountId: "acc_a",
			type: "microvm",
			subdomain: "sbx_from_tpl",
			env: { MODE: "agent" },
			eligibleHosts: ["host_a", "host_b"],
			template: { ...template, snapshot: "host_b/tsn_1" },
			// The template's shape, off the hosts' one size: what it is placed, booted and recorded as, a custom shape
			// with the disk its host gives it (its smallest size's with at least that memory).
			shape: { vcpus: 1, memoryMb: 1536 },
		};
		const machine = { size: "", vcpus: 1, memoryMiB: 1536, diskGiB: 20 };
		const placement = await backend.create(spec);
		expect(placement.hostId).toBe("host_b");
		expect(placement.resources).toEqual({ vcpus: 1, memoryMb: 1536, diskGb: 20 });
		expect(await service.sandboxes.placement("sbx_from_tpl")).toMatchObject({ vcpus: 1, memoryMiB: 1536, diskGiB: 20 });
		expect(holder.calls.find((each) => each.method === "sandbox.create")?.params).toMatchObject({
			sandboxId: "sbx_from_tpl",
			...machine,
			template: { baseImage: "kantel/sandbox", baseDigest: BASE_DIGEST, setup: "touch /ready", snapshot: "tsn_1" },
		});
		// Its snapshot's host must be one it may use.
		await expect(backend.create({ ...spec, sandboxId: "sbx_elsewhere", eligibleHosts: ["host_a"] })).rejects.toSatisfy(
			(error) => isKantelError(error, "unavailable"),
		);
		// A fresh boot goes where the scheduler puts it, and the host runs its setup.
		const fresh = await backend.create({ ...spec, sandboxId: "sbx_fresh", template });
		const host = fresh.hostId === "host_b" ? holder : first;
		const params = host.calls.find((each) => each.params.sandboxId === "sbx_fresh")?.params as {
			template?: object;
		};
		expect(params).toMatchObject(machine);
		expect(params.template).toEqual({ baseImage: "kantel/sandbox", baseDigest: BASE_DIGEST, setup: "touch /ready" });
		expect(fresh.resources).toEqual({ vcpus: 1, memoryMb: 1536, diskGb: 20 });
	});

	it("is placed as its template's shape: held as it, a named size of the same shape or a custom one, never another size", async () => {
		const { store, service } = await setup();
		// Room for 3000 MiB: two of a 1024 MiB machine, though only one of the `default` size.
		await addHost(store, service, "host_a", { freeMemoryMiB: 3000 });
		const shape = { vcpus: 1, memoryMiB: 1024 };
		const machine = { vcpus: 1, memoryMiB: 1024, diskGiB: 20 };
		for (const sandboxId of ["sbx_m1", "sbx_m2"]) {
			const placed = await service.sandboxes.create({ tier: "microvm", sandboxId, template: TEMPLATE, shape });
			expect(placed.placement).toMatchObject({ size: customSizeName(machine), ...machine });
		}
		await expect(
			service.sandboxes.create({ tier: "microvm", sandboxId: "sbx_m3", template: TEMPLATE, shape }),
		).rejects.toSatisfy((error) => isKantelError(error, "exhausted"));
		// Its shape wins over a size named with it.
		const { store: store2, service: service2 } = await setup();
		await addHost(store2, service2, "host_b");
		expect(
			(await service2.sandboxes.create({ tier: "microvm", size: "large", template: TEMPLATE, shape })).placement,
		).toMatchObject({ size: customSizeName(machine), ...machine });
		// The shape of a named size is that size.
		expect(
			(await service2.sandboxes.create({ tier: "microvm", template: TEMPLATE, shape: { vcpus: 2, memoryMiB: 2048 } }))
				.placement,
		).toMatchObject({ size: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 });
		// A shape bigger than the host goes nowhere.
		await expect(
			service2.sandboxes.create({ tier: "microvm", template: TEMPLATE, shape: { vcpus: 2, memoryMiB: 65_536 } }),
		).rejects.toSatisfy((error) => isKantelError(error, "exhausted"));
		// A host making only its named sizes takes none of another shape.
		const { store: store3, service: service3 } = await setup();
		await addHost(store3, service3, "host_c", { custom: false });
		await expect(service3.sandboxes.create({ tier: "microvm", template: TEMPLATE, shape })).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		expect(
			(await service3.sandboxes.create({ tier: "microvm", template: TEMPLATE, shape: { vcpus: 2, memoryMiB: 2048 } }))
				.placement,
		).toMatchObject({ size: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 });
	});

	it("keeps a template restore whose host never answered on that host, rather than booting it fresh elsewhere", async () => {
		const { store, service, backend } = await setup();
		const other = await addHost(store, service, "host_a");
		const holder = await addHost(store, service, "host_b");
		holder.hold = (method) => (method === "sandbox.create" ? new Promise<void>(() => undefined) : undefined);
		const creating = backend.create({
			sandboxId: "sbx_lost_restore",
			accountId: "acc_a",
			type: "microvm",
			subdomain: "sbx_lost_restore",
			env: {},
			eligibleHosts: ["host_a", "host_b"],
			template: { baseImage: "kantel/sandbox", baseDigest: "", snapshot: "host_b/tsn_1" },
			shape: { vcpus: 2, memoryMb: 2048 },
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		holder.connection.closed(1006, "gone");
		const error = await creating.catch((caught: unknown) => caught);
		// Not known to have failed: no placement reason, still placed on its snapshot's host, and made nowhere else.
		expect(unanswered(error)).toBe(true);
		expect(placementReasonOf(error)).toBeUndefined();
		expect((await store.getPlacement("sbx_lost_restore"))?.hostId).toBe("host_b");
		expect(other.calls.some((call) => call.method === "sandbox.create")).toBe(false);
	});

	it("restores a template snapshot on whichever host with a copy has the most room, and boots fresh elsewhere when they have none", async () => {
		const { store, service, backend } = await setup();
		const built = await addHost(store, service, "host_b", { freeMemoryMiB: 3000 });
		const copy = await addHost(store, service, "host_c", { freeMemoryMiB: 30_000 });
		const other = await addHost(store, service, "host_a", { freeMemoryMiB: 60_000 });
		for (const host of [built, copy]) host.createSource = "snapshot";
		const spec: SandboxSpec = {
			sandboxId: "sbx_copy",
			accountId: "acc_a",
			type: "microvm",
			subdomain: "sbx_copy",
			env: {},
			eligibleHosts: ["host_a", "host_b", "host_c"],
			template: {
				baseImage: "kantel/sandbox",
				baseDigest: "",
				snapshot: "host_b/tsn_1",
				snapshotHosts: ["host_b", "host_c"],
			},
			shape: { vcpus: 2, memoryMb: 2048 },
		};
		// The emptier of the two with the snapshot, never the emptiest host without it.
		const placement = await backend.create(spec);
		expect(placement.hostId).toBe("host_c");
		expect(placement.bootedFresh).toBeUndefined();
		const params = copy.calls.find((call) => call.params.sandboxId === "sbx_copy")?.params as {
			template?: { snapshot?: string };
		};
		expect(params.template?.snapshot).toBe("tsn_1");
		expect(other.calls.some((call) => call.method === "sandbox.create")).toBe(false);
		// Neither with room: fresh on the host without it.
		for (const host of [built, copy]) {
			host.refuse = (method) =>
				method === "sandbox.create" ? { code: "capacity", message: "this host hasn't 2048 MiB free" } : undefined;
		}
		expect(await backend.create({ ...spec, sandboxId: "sbx_none" })).toMatchObject({
			hostId: "host_a",
			bootedFresh: true,
		});
		// The snapshot's own host not one the create may use, a copy's host is: restored there.
		copy.refuse = undefined;
		expect(
			await backend.create({ ...spec, sandboxId: "sbx_elsewhere", eligibleHosts: ["host_a", "host_c"] }),
		).toMatchObject({ hostId: "host_c" });
	});

	it("boots the template fresh on another host when its snapshot's host has no room, or on it when it misses the snapshot, but a sandbox's own snapshot waits", async () => {
		const { store, service, backend } = await setup();
		const other = await addHost(store, service, "host_a");
		// Room for less than one machine of the template's 2048 MiB, as this replica sees it.
		const holder = await addHost(store, service, "host_b", { freeMemoryMiB: 1000 });
		const spec: SandboxSpec = {
			sandboxId: "sbx_full",
			accountId: "acc_a",
			type: "microvm",
			subdomain: "sbx_full",
			env: {},
			eligibleHosts: ["host_a", "host_b"],
			template: { baseImage: "kantel/sandbox", baseDigest: "", snapshot: "host_b/tsn_1" },
			shape: { vcpus: 2, memoryMb: 2048 },
		};
		const placement = await backend.create(spec);
		expect(placement).toMatchObject({
			hostId: "host_a",
			bootedFresh: true,
			resources: { vcpus: 2, memoryMb: 2048, diskGb: 20 },
		});
		const params = other.calls.find((call) => call.params.sandboxId === "sbx_full")?.params as { template?: object };
		expect(params.template).not.toHaveProperty("snapshot");
		expect(params).toMatchObject({ size: "default" });
		expect(holder.calls.some((call) => call.method === "sandbox.create")).toBe(false);

		// The host itself refusing for want of room (another replica's work) is the same.
		holder.freeMemoryMiB = 20_000;
		holder.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 20_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} } },
		});
		await tick();
		holder.refuse = (method) =>
			method === "sandbox.create" ? { code: "capacity", message: "this host hasn't 2048 MiB free" } : undefined;
		expect(await backend.create({ ...spec, sandboxId: "sbx_refused" })).toMatchObject({
			hostId: "host_a",
			bootedFresh: true,
		});
		// Room on its host: restored there, as before.
		holder.refuse = undefined;
		holder.createSource = "snapshot";
		const restored = await backend.create({ ...spec, sandboxId: "sbx_room" });
		expect(restored.hostId).toBe("host_b");
		expect(restored.bootedFresh).toBeUndefined();
		// Its host no longer holding the snapshot (or unable to restore it) boots the template fresh there, and says so.
		holder.createSource = "boot";
		expect(await backend.create({ ...spec, sandboxId: "sbx_missed" })).toMatchObject({
			hostId: "host_b",
			bootedFresh: true,
		});
		// A sandbox's own snapshot has nowhere else to go.
		holder.refuse = (method) =>
			method === "sandbox.create" ? { code: "capacity", message: "this host hasn't 2048 MiB free" } : undefined;
		const { template: _none, ...plain } = spec;
		await expect(backend.create({ ...plain, sandboxId: "sbx_own", fromSnapshot: "host_b/snap_1" })).rejects.toSatisfy(
			(error) => isKantelError(error, "exhausted"),
		);
		expect(other.calls.some((call) => call.params.sandboxId === "sbx_own")).toBe(false);
	});

	it("places a sandbox made from a snapshot as the shape it is given, the snapshot's sandbox's", async () => {
		const { store, service, backend } = await setup();
		const host = await addHost(store, service, "host_a");
		const placement = await backend.create({
			sandboxId: "sbx_copy",
			accountId: "acc_a",
			type: "microvm",
			subdomain: "sbx_copy",
			size: "default",
			env: {},
			eligibleHosts: ["host_a"],
			fromSnapshot: "host_a/snap_1",
			// A custom shape, which its shape wins over its size for.
			shape: { vcpus: 1, memoryMb: 1536 },
		});
		const machine = { vcpus: 1, memoryMiB: 1536, diskGiB: 20 };
		expect(placement.resources).toEqual({ vcpus: 1, memoryMb: 1536, diskGb: 20 });
		expect(await service.sandboxes.placement("sbx_copy")).toMatchObject({ size: customSizeName(machine), ...machine });
		expect(host.calls.find((call) => call.method === "sandbox.create")?.params).toMatchObject({
			from: "snap_1",
			size: "",
			...machine,
		});
	});

	it("refuses a template for an isolate, and a template snapshot without its one host", async () => {
		const { store, service } = await setup();
		await addHost(store, service, "host_a");
		const template = { baseImage: "kantel/sandbox" };
		await expect(service.sandboxes.create({ tier: "isolate", template })).rejects.toSatisfy((error) =>
			isKantelError(error, "invalid"),
		);
		await expect(
			service.sandboxes.create({ tier: "microvm", template: { ...template, snapshot: "tsn_1" } }),
		).rejects.toSatisfy((error) => isKantelError(error, "invalid"));
	});
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const TEMPLATE = { baseImage: "kantel/sandbox" };

describe("templates' custom images", () => {
	const image = { kind: "dockerfile", dockerfile: "FROM $KANTEL_BASE\nRUN true\n", scope: "tpl_1@2#0" } as const;

	it("go only to hosts that build them, which say so, with the image relayed and the root filesystem answered", async () => {
		const { store, service, backend } = await setup();
		const plain = await addHost(store, service, "host_plain", { freeMemoryMiB: 30_000 });
		const builder = await addHost(store, service, "host_builder", { images: true });
		expect(await backend.templateRuntimes?.()).toEqual([
			{ hostId: "host_plain", kernel: RUNTIME.guestKernel, firecracker: RUNTIME.firecracker },
			{ hostId: "host_builder", kernel: RUNTIME.guestKernel, firecracker: RUNTIME.firecracker, customImages: true },
		]);
		// A host without the builder would drop `image` and build the base: it is sent nothing.
		await expect(backend.buildTemplate?.({ ...buildSpec("host_plain"), image })).rejects.toSatisfy((error) =>
			isKantelError(error, "not_supported"),
		);
		expect(plain.calls.some((call) => call.method === "template.build")).toBe(false);
		builder.answer = (method) =>
			method === "template.build"
				? {
						ref: "tsn_1",
						imageDigest: `sha256:${"c".repeat(64)}`,
						rootfsKey: "f".repeat(64),
						source: "dockerfile",
						sizeBytes: 7,
					}
				: undefined;
		const built = await backend.buildTemplate?.({ ...buildSpec("host_builder"), image });
		expect(built).toEqual({
			ref: "host_builder/tsn_1",
			hostId: "host_builder",
			imageDigest: `sha256:${"c".repeat(64)}`,
			rootfsKey: "f".repeat(64),
			sizeBytes: 7,
		});
		expect(builder.calls.find((call) => call.method === "template.build")?.params).toMatchObject({
			image,
			egress: { mode: "proxy" },
		});

		// A create from it goes only to a host that builds them, told the image and its root filesystem.
		const boot = { ...TEMPLATE, image, rootfsKey: "f".repeat(64) };
		for (const sandboxId of ["sbx_img_1", "sbx_img_2"]) {
			expect((await service.sandboxes.create({ tier: "microvm", sandboxId, template: boot })).hostId).toBe(
				"host_builder",
			);
		}
		expect(builder.calls.find((call) => call.method === "sandbox.create")?.params).toMatchObject({
			template: { image, rootfsKey: "f".repeat(64) },
		});
		await expect(
			service.sandboxes.create({ tier: "microvm", template: boot, hostIds: ["host_plain"] }),
		).rejects.toSatisfy((error) => isKantelError(error, "not_supported"));
		expect(plain.calls.some((call) => call.method === "sandbox.create")).toBe(false);
	});
});

describe("hosts from before templates", () => {
	it("are sent no template, neither a create from one nor a build, while ordinary creates still go to them", async () => {
		const { store, service, backend } = await setup();
		// The older host (which would drop `template` and boot the default image) has the most room: placement's first pick.
		const older = await addHost(store, service, "host_older", { templates: false, freeMemoryMiB: 30_000 });
		const newer = await addHost(store, service, "host_newer");
		expect((await backend.templateRuntimes?.())?.map((runtime) => runtime.hostId)).toEqual(["host_newer"]);
		for (const sandboxId of ["sbx_tpl_1", "sbx_tpl_2", "sbx_tpl_3"]) {
			expect((await service.sandboxes.create({ tier: "microvm", sandboxId, template: TEMPLATE })).hostId).toBe(
				"host_newer",
			);
		}
		expect(newer.calls.filter((call) => call.method === "sandbox.create")).toHaveLength(3);
		// An ordinary create still goes to the older host.
		expect((await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx_plain" })).hostId).toBe("host_older");
		// With the older host alone to use: not_supported, and nothing sent to it.
		await expect(
			service.sandboxes.create({ tier: "microvm", template: TEMPLATE, hostIds: ["host_older"] }),
		).rejects.toSatisfy(
			(error) => isKantelError(error, "not_supported") && error.details?.reason === "no_host_for_template",
		);
		await expect(backend.buildTemplate?.(buildSpec("host_older"))).rejects.toSatisfy((error) =>
			isKantelError(error, "not_supported"),
		);
		expect(older.calls.map((call) => call.method)).toEqual(["sandbox.create"]);
		expect(older.calls.some((call) => "template" in call.params)).toBe(false);
	});
});

describe("a template build its host can't take now", () => {
	it("says host_unavailable when the host is draining or gone, and insufficient_capacity when it has no room", async () => {
		const { store, service, backend } = await setup();
		const reasonOf = (call: Promise<unknown> | undefined) =>
			(call ?? Promise.reject(new Error("No buildTemplate"))).then(
				() => "built",
				(error: unknown) => (isKantelError(error) ? `${error.code} ${String(error.details?.reason)}` : String(error)),
			);
		await addHost(store, service, "host_draining", { draining: true });
		expect(await reasonOf(backend.buildTemplate?.(buildSpec("host_draining")))).toBe("unavailable host_unavailable");
		await addHost(store, service, "host_small", { freeMemoryMiB: 100 });
		expect(await reasonOf(backend.buildTemplate?.(buildSpec("host_small")))).toBe("exhausted insufficient_capacity");
		await addHost(store, service, "host_gone");
		service.hub.disconnect("host_gone", 1001, "gone");
		expect(await reasonOf(backend.buildTemplate?.(buildSpec("host_gone")))).toBe("unavailable host_unavailable");
	});
});

describe("a template build's time", () => {
	it("ends, a custom image's too, well within the stored build's lease, so no other gateway reclaims it while it may run", () => {
		for (const timeout of [TEMPLATE_BUILD_TIMEOUT_MS, TEMPLATE_IMAGE_BUILD_TIMEOUT_MS]) {
			expect(TEMPLATE_BUILD_LEASE_MS - timeout).toBeGreaterThanOrEqual(15 * 60_000);
		}
	});
});

describe("a create from a template", () => {
	it("is given as long as a build to answer, while an ordinary create keeps its deadline", async () => {
		const { store, service } = await setup({ callTimeoutMs: 50 });
		const host = await addHost(store, service, "host_a");
		host.hold = (method) =>
			method === "sandbox.create" ? new Promise((resolve) => setTimeout(resolve, 200)) : undefined;
		await expect(service.sandboxes.create({ tier: "microvm", sandboxId: "sbx_plain" })).rejects.toSatisfy(
			(error) => isKantelError(error, "unavailable") && unanswered(error),
		);
		// Timed out, not refused: the host may be making it still, so it stays placed there until the host says.
		expect((await service.sandboxes.placement("sbx_plain"))?.state).toBe("starting");
		// Booting fresh, it pulls the base image and runs the setup: past the ordinary deadline, and still answered.
		const placed = await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx_tpl", template: TEMPLATE });
		expect(placed.sandbox.state).toBe("running");
		expect((await service.sandboxes.placement("sbx_tpl"))?.state).toBe("running");
	});
});

describe("a template build's room on its host", () => {
	it("is held from before the build until a report counts it, against other builds and creates, counted once", async () => {
		const { store, service, backend } = await setup();
		// Room for one machine of the `default` size (2 vCPUs, 2048 MiB, 20 GiB) at a time.
		const host = await addHost(store, service, "host_a", { freeMemoryMiB: 3000 });
		const capacity = { freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} };
		let finish: () => void = () => undefined;
		host.hold = (method) =>
			method === "template.build"
				? new Promise<void>((resolve) => {
						finish = resolve;
					})
				: undefined;
		const first = backend.buildTemplate?.(buildSpec("host_a"));
		await tick();
		// The host is told the disk the hold counts.
		expect(host.calls.find((call) => call.method === "template.build")?.params).toMatchObject({
			vcpus: 2,
			memoryMiB: 2048,
			diskGiB: 20,
		});
		// Another build (another runtime's, say) and a create both wait for room.
		await expect(backend.buildTemplate?.({ ...buildSpec("host_a"), snapshotId: "tsn_2" })).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		await expect(service.sandboxes.create({ tier: "microvm" })).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		// A report that doesn't name the build (sent before the host admitted it) doesn't let the hold go.
		host.send({ type: "heartbeat", heartbeat: { capacity: { freeMemoryMiB: 3000, ...capacity } } });
		await tick();
		await expect(service.sandboxes.create({ tier: "microvm" })).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		expect(host.calls.filter((call) => call.method === "template.build")).toHaveLength(1);

		// One that names it has left its 2048 MiB out of the free memory already, as `Host.Capacity` does: 4096 MiB free.
		// The hold goes, so the build isn't counted twice: two creates of 2048 MiB fit, a third doesn't.
		host.send({ type: "heartbeat", heartbeat: { capacity: { freeMemoryMiB: 4096, ...capacity, builds: ["tsn_1"] } } });
		await tick();
		for (const sandboxId of ["sbx_fit_1", "sbx_fit_2"]) {
			expect((await service.sandboxes.create({ tier: "microvm", sandboxId })).hostId).toBe("host_a");
		}
		await expect(service.sandboxes.create({ tier: "microvm", sandboxId: "sbx_over" })).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		// A later report without it (the build has ended) doesn't bring the hold back.
		host.send({ type: "heartbeat", heartbeat: { capacity: { freeMemoryMiB: 2048, ...capacity } } });
		await tick();
		expect((await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx_after" })).hostId).toBe("host_a");

		finish();
		await first;
	});

	it("is let go when its call ends, whether or not a report named it", async () => {
		const { store, service, backend } = await setup();
		const host = await addHost(store, service, "host_a", { freeMemoryMiB: 3000 });
		let finish: () => void = () => undefined;
		host.hold = (method) =>
			method === "template.build"
				? new Promise<void>((resolve) => {
						finish = resolve;
					})
				: undefined;
		const first = backend.buildTemplate?.(buildSpec("host_a"));
		await tick();
		await expect(service.sandboxes.create({ tier: "microvm" })).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		finish();
		await first;
		// It has ended: its room is free again.
		expect((await service.sandboxes.create({ tier: "microvm" })).hostId).toBe("host_a");
	});

	it("is let go when a build fails, and a shape the host can't make is refused", async () => {
		const { store, service, backend } = await setup();
		const host = await addHost(store, service, "host_a", { freeMemoryMiB: 3000 });
		host.refuse = (method) =>
			method === "template.build" ? { code: "failed", message: "The setup exited with 1" } : undefined;
		await expect(backend.buildTemplate?.(buildSpec("host_a"))).rejects.toSatisfy((error) =>
			isKantelError(error, "unavailable"),
		);
		host.refuse = undefined;
		await expect(backend.buildTemplate?.(buildSpec("host_a"))).resolves.toMatchObject({ ref: "host_a/tsn_1" });
		await expect(
			backend.buildTemplate?.({ ...buildSpec("host_a"), shape: { vcpus: 2, memoryMb: 262_144 } }),
		).rejects.toSatisfy((error) => isKantelError(error, "not_supported"));
		expect(host.calls.filter((call) => call.method === "template.build")).toHaveLength(2);
		// Neither build holds anything now.
		expect((await service.sandboxes.create({ tier: "microvm" })).hostId).toBe("host_a");
		// A host making only its named sizes builds none of another shape.
		const named = await addHost(store, service, "host_named", { custom: false });
		await expect(
			backend.buildTemplate?.({ ...buildSpec("host_named"), shape: { vcpus: 1, memoryMb: 1024 } }),
		).rejects.toSatisfy((error) => isKantelError(error, "not_supported"));
		expect(named.calls.some((call) => call.method === "template.build")).toBe(false);
	});

	it("is refused for now when the host itself hasn't the room, which another replica's builds and creates take", async () => {
		const { store, service, backend } = await setup();
		const host = await addHost(store, service, "host_a");
		// This replica's view says there is room; the host, which counts every replica's builds, says there isn't.
		host.refuse = (method) =>
			method === "template.build"
				? { code: "capacity", message: "this host hasn't 2048 MiB free to build the template now" }
				: undefined;
		await expect(backend.buildTemplate?.(buildSpec("host_a"))).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		// Nothing is left held here: the next try goes to the host again, and is built when it has room.
		host.refuse = undefined;
		await expect(backend.buildTemplate?.(buildSpec("host_a"))).resolves.toMatchObject({ ref: "host_a/tsn_1" });
		expect(host.calls.filter((call) => call.method === "template.build")).toHaveLength(2);
	});
});
