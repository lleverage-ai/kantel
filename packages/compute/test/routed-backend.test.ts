// The routed backend: each call goes to the backend that holds the sandbox or snapshot, and gets the service's
// eligible hosts narrowed to that backend's own, so the service's constraints (type, labels, owner) survive.
import { describe, expect, it } from "vitest";
import type { BackendCapabilities, BackendHost, SandboxBackend } from "../src/backend.ts";
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
			await expect(call).rejects.toMatchObject({ code: "unavailable", message: NOT_HELD });
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
});
