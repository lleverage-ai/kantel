// The routed backend: each call goes to the backend that holds the sandbox or snapshot, and gets the service's
// eligible hosts narrowed to that backend's own, so the service's constraints (type, labels, owner) survive.
import { describe, expect, it } from "vitest";
import type {
	BackendCapabilities,
	BackendHost,
	BuiltTemplate,
	SandboxBackend,
	TemplateBuildSpec,
	TemplateRuntime,
	TemplateSnapshotBytes,
} from "../src/backend.ts";
import { createRoutedBackend, NOT_HELD } from "../src/routed-backend.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";

const host = (id: string, accountId?: string): BackendHost => ({
	id,
	name: id,
	tiers: ["microvm"],
	kvm: true,
	nestedVirtualisation: false,
	capacity: { vcpus: 4, memoryMb: 4096, diskGb: 40 },
	labels: {},
	connected: true,
	...(accountId === undefined ? {} : { accountId }),
});

/** A backend with `hosts` that records the eligible hosts of every call it answers. */
function fake(hosts: BackendHost[]) {
	const seen: { method: string; eligible: readonly string[] }[] = [];
	const capabilities: BackendCapabilities = { types: ["microvm"], sizes: [], hosts };
	const placement = { hostId: hosts[0]?.id ?? "", capabilities: {} as never };
	const backend = new Proxy({} as SandboxBackend, {
		get(_target, method: string) {
			// Not a thenable: the routed backend awaits the backend it picks.
			if (method === "then") return undefined;
			if (method === "capabilities") return async () => capabilities;
			return async (_id: unknown, input: { eligibleHosts?: readonly string[] } | unknown[]) => {
				const list = Array.isArray(input) ? input : [input ?? _id];
				for (const item of list as { eligibleHosts?: readonly string[] }[]) {
					if (item?.eligibleHosts !== undefined) seen.push({ method, eligible: item.eligibleHosts });
				}
				return method === "fork" ? list.map(() => placement) : placement;
			};
		},
	});
	return { backend, seen };
}

describe("createRoutedBackend", () => {
	const setup = () => {
		const primary = fake([host("host_own", "acc_a")]);
		const fallback = fake([host("host_stub"), host("host_other_shared")]);
		const routed = createRoutedBackend({
			primary: primary.backend,
			fallback: fallback.backend,
			holds: async (id) => id.startsWith("sbx_p"),
			holdsSnapshot: (ref) => ref.startsWith("host_"),
		});
		return { routed, primary, fallback };
	};
	const spec = (sandboxId: string, eligibleHosts: string[], fromSnapshot?: string) => ({
		sandboxId,
		accountId: "acc_a",
		type: "microvm" as const,
		subdomain: sandboxId,
		env: {},
		eligibleHosts,
		...(fromSnapshot === undefined ? {} : { fromSnapshot }),
	});

	it("puts a fresh sandbox on the primary when any eligible host is its own, else on the fallback", async () => {
		const { routed, primary, fallback } = setup();
		await routed.create(spec("sbx_1", ["host_own", "host_stub"]));
		await routed.create(spec("sbx_2", ["host_stub"]));
		expect(primary.seen).toEqual([{ method: "create", eligible: ["host_own"] }]);
		expect(fallback.seen).toEqual([{ method: "create", eligible: ["host_stub"] }]);
	});

	it("gives what the fallback holds the fallback's hosts among those eligible, never more", async () => {
		const { routed, fallback } = setup();
		// The service passes every qualifying host the account may use; its labels ruled out host_other_shared.
		const eligible = ["host_own", "host_stub"];
		await routed.start("sbx_f", { env: {}, eligibleHosts: eligible });
		await routed.resume("sbx_f", { env: {}, eligibleHosts: eligible });
		await routed.recover("sbx_f", { env: {}, eligibleHosts: eligible });
		await routed.fork({ sandboxId: "sbx_f" }, [spec("sbx_f2", eligible)]);
		await routed.create(spec("sbx_f3", eligible, "ref_stub_snapshot"));
		expect(fallback.seen.map((call) => [call.method, call.eligible])).toEqual([
			["start", ["host_stub"]],
			["resume", ["host_stub"]],
			["recover", ["host_stub"]],
			["fork", ["host_stub"]],
			["create", ["host_stub"]],
		]);
	});

	it("gives what the primary holds the primary's hosts among those eligible", async () => {
		const { routed, primary } = setup();
		await routed.start("sbx_p1", { env: {}, eligibleHosts: ["host_own", "host_stub"] });
		await routed.create(spec("sbx_p2", ["host_own", "host_stub"], "host_own/snap_1"));
		expect(primary.seen.map((call) => call.eligible)).toEqual([["host_own"], ["host_own"]]);
	});

	it("asks the backend that holds a sandbox whether a rebase can land, among its own hosts", async () => {
		const { routed, primary, fallback } = setup();
		await routed.prepareRebase?.("sbx_p1", { eligibleHosts: ["host_own", "host_stub"], rebaseTo: "v2" });
		await routed.prepareRebase?.("sbx_f1", { eligibleHosts: ["host_own", "host_stub"] });
		expect(primary.seen).toEqual([{ method: "prepareRebase", eligible: ["host_own"] }]);
		expect(fallback.seen).toEqual([{ method: "prepareRebase", eligible: ["host_stub"] }]);
	});

	it("refuses a sandbox neither holds rather than ask the fallback for it, and places it again only with create", async () => {
		const primary = fake([host("host_own", "acc_a")]);
		const fallback = fake([host("host_stub")]);
		const routed = createRoutedBackend({
			primary: primary.backend,
			fallback: fallback.backend,
			holds: async (id) => id.startsWith("sbx_p"),
			fallbackHolds: async (id) => id.startsWith("sbx_f"),
			holdsSnapshot: (ref) => ref.startsWith("host_"),
		});
		const eligible = ["host_own", "host_stub"];
		// Its create failed on the account's host: neither has it.
		for (const call of [
			routed.start("sbx_lost", { env: {}, eligibleHosts: eligible }),
			routed.resume("sbx_lost", { env: {}, eligibleHosts: eligible }),
			routed.recover("sbx_lost", { env: {}, eligibleHosts: eligible }),
			routed.exec("sbx_lost", { command: "true" }),
		]) {
			await expect(call).rejects.toMatchObject({
				code: "unavailable",
				message: NOT_HELD,
				details: { reason: "host_unavailable" },
			});
		}
		expect([...primary.seen, ...fallback.seen]).toEqual([]);
		// What the fallback holds still goes there, a destroy of one neither holds too (it has nothing to destroy).
		await routed.start("sbx_f1", { env: {}, eligibleHosts: eligible });
		await routed.destroy("sbx_lost");
		// Made again as a create, it goes where a new sandbox goes: the account's own host.
		await routed.create(spec("sbx_lost", eligible));
		expect(fallback.seen).toEqual([{ method: "start", eligible: ["host_stub"] }]);
		expect(primary.seen).toEqual([{ method: "create", eligible: ["host_own"] }]);
	});

	it("says why the fallback can't take a sandbox it holds when none of the hosts it may use is the fallback's", async () => {
		const stub = createStubBackend();
		const routed = createRoutedBackend({
			primary: fake([host("host_own", "acc_a")]).backend,
			fallback: stub,
			holds: async () => false,
			holdsSnapshot: () => false,
		});
		await routed.create(spec("sbx_f1", [STUB_HOST_ID]));
		// It may use only the account's host now: narrowed to the stub's own, none is left.
		await expect(routed.recover("sbx_f1", { env: {}, eligibleHosts: ["host_own"] })).rejects.toMatchObject({
			code: "unavailable",
			message: "It is on the deployment's shared hosts, none of which it may use now; it may use host_own",
		});
		// The stub, asked itself, says as much.
		await expect(stub.recover("sbx_f1", { env: {}, eligibleHosts: [] })).rejects.toMatchObject({
			message: `The stub's host (${STUB_HOST_ID}) isn't one this sandbox may use now: none of its eligible hosts is the stub's`,
		});
		await expect(stub.recover("sbx_f1", { env: {}, eligibleHosts: ["host_own"] })).rejects.toMatchObject({
			message: `The stub's host (${STUB_HOST_ID}) isn't one this sandbox may use now; it may use host_own`,
		});
	});

	it("puts a sandbox made from a template snapshot on the backend holding the snapshot", async () => {
		const { routed, primary, fallback } = setup();
		const template = { baseImage: "kantel/sandbox", baseDigest: "" };
		await routed.create({
			...spec("sbx_t1", ["host_own", "host_stub"]),
			template: { ...template, snapshot: "host_own/tsn_1" },
		});
		await routed.create({ ...spec("sbx_t2", ["host_stub"]), template: { ...template, snapshot: "tpl-snap:tsn_2" } });
		expect(primary.seen).toEqual([{ method: "create", eligible: ["host_own"] }]);
		expect(fallback.seen).toEqual([{ method: "create", eligible: ["host_stub"] }]);
	});
});

describe("createRoutedBackend's templates", () => {
	/** A backend with `hosts` and, unless `templates` is false, templates on each of them; it records its template calls. */
	function templated(hosts: BackendHost[], templates = true) {
		const calls: string[] = [];
		const backend = {
			capabilities: async (): Promise<BackendCapabilities> => ({ types: ["microvm"], sizes: [], hosts }),
			...(templates
				? {
						templateRuntimes: async (): Promise<TemplateRuntime[]> =>
							hosts.map((each) => ({ hostId: each.id, kernel: "6.1", firecracker: "v1.17.0" })),
						buildTemplate: async (spec: TemplateBuildSpec): Promise<BuiltTemplate> => {
							calls.push(`build ${spec.hostId}`);
							return { ref: `${spec.hostId}/${spec.snapshotId}`, hostId: spec.hostId, sizeBytes: 1 };
						},
						deleteTemplateSnapshot: async (bytes: TemplateSnapshotBytes) => {
							calls.push(`delete ${bytes.ref ?? `${bytes.hostId} ${bytes.snapshotId}`}`);
						},
					}
				: {}),
		} as unknown as SandboxBackend;
		return { backend, calls };
	}
	const buildSpec = (hostId: string): TemplateBuildSpec => ({
		snapshotId: "tsn_1",
		accountId: "acc_a",
		templateId: "tpl_1",
		version: 1,
		baseImage: "kantel/sandbox",
		baseDigest: "sha256:a",
		shape: { vcpus: 2, memoryMb: 2048 },
		env: {},
		keyHash: "k",
		hostId,
	});
	const route = (primary: SandboxBackend, fallback: SandboxBackend) =>
		createRoutedBackend({
			primary,
			fallback,
			holds: async () => false,
			holdsSnapshot: (ref) => ref.startsWith("host_"),
		});

	it("lists both backends' runtimes, and sends each build and delete (by ref, or by ID) to the backend of its host", async () => {
		const primary = templated([host("host_own", "acc_a")]);
		const fallback = templated([host("host_stub")]);
		const routed = route(primary.backend, fallback.backend);
		expect((await routed.templateRuntimes?.())?.map((runtime) => runtime.hostId)).toEqual(["host_own", "host_stub"]);
		await routed.buildTemplate?.(buildSpec("host_own"));
		await routed.buildTemplate?.(buildSpec("host_stub"));
		await routed.deleteTemplateSnapshot?.({ snapshotId: "tsn_1", hostId: "host_own", ref: "host_own/tsn_1" });
		await routed.deleteTemplateSnapshot?.({ snapshotId: "tsn_1", hostId: "host_stub", ref: "tpl-snap:tsn_1" });
		// A build that never answered has no ref: its bytes are deleted by ID on the host it was built on.
		await routed.deleteTemplateSnapshot?.({ snapshotId: "tsn_2", hostId: "host_own" });
		await routed.deleteTemplateSnapshot?.({ snapshotId: "tsn_3", hostId: "host_stub" });
		expect(primary.calls).toEqual(["build host_own", "delete host_own/tsn_1", "delete host_own tsn_2"]);
		expect(fallback.calls).toEqual(["build host_stub", "delete tpl-snap:tsn_1", "delete host_stub tsn_3"]);
	});

	it("has templates when either backend has, and none when neither has", async () => {
		const bare = route(templated([host("host_own")], false).backend, templated([host("host_stub")], false).backend);
		expect(bare.templateRuntimes).toBeUndefined();
		expect(bare.buildTemplate).toBeUndefined();
		expect(bare.deleteTemplateSnapshot).toBeUndefined();
		const half = route(templated([host("host_own")], false).backend, templated([host("host_stub")]).backend);
		expect((await half.templateRuntimes?.())?.map((runtime) => runtime.hostId)).toEqual(["host_stub"]);
		await expect(half.buildTemplate?.(buildSpec("host_own"))).rejects.toMatchObject({ code: "not_supported" });
	});
});

describe("createRoutedBackend's keepSnapshot", () => {
	const kept = { ref: "kept", sizeBytes: 1 };
	const keeping = (calls: string[], keeps: boolean): SandboxBackend => {
		const { keepSnapshot: _own, ...stub } = createStubBackend();
		return keeps
			? {
					...stub,
					keepSnapshot: async (ref: string) => {
						calls.push(ref);
						return kept;
					},
				}
			: stub;
	};
	const route = (primary: SandboxBackend, fallback: SandboxBackend) =>
		createRoutedBackend({
			primary,
			fallback,
			holds: async () => false,
			holdsSnapshot: (ref) => ref.startsWith("host_"),
		});

	it("keeps a snapshot on the backend its ref is on, and answers none where that backend has no keep", async () => {
		const primary: string[] = [];
		const fallback: string[] = [];
		const routed = route(keeping(primary, true), keeping(fallback, true));
		expect(await routed.keepSnapshot?.("host_own/snap_1")).toEqual(kept);
		expect(await routed.keepSnapshot?.("ref_stub")).toEqual(kept);
		expect(primary).toEqual(["host_own/snap_1"]);
		expect(fallback).toEqual(["ref_stub"]);
		const half = route(keeping([], true), keeping([], false));
		expect(await half.keepSnapshot?.("ref_stub")).toBeUndefined();
		expect(route(keeping([], false), keeping([], false)).keepSnapshot).toBeUndefined();
	});
});
