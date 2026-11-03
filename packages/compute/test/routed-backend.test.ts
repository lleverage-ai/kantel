// The routed backend: each call goes to the backend that holds the sandbox or snapshot, and gets the service's
// eligible hosts narrowed to that backend's own, so the service's constraints (type, labels, owner) survive.
import { describe, expect, it } from "vitest";
import type { BackendCapabilities, BackendHost, SandboxBackend } from "../src/backend.ts";
import { createRoutedBackend } from "../src/routed-backend.ts";

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
});
