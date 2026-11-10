// `updateEnv`: a sandbox's new env (an environment attached or detached) reaches it while it runs, where its backend
// can, and stays for its later boots; the routed backend sends it to the backend holding the sandbox.
import { describe, expect, it } from "vitest";
import type { SandboxBackend } from "../src/backend.ts";
import { createRoutedBackend } from "../src/routed-backend.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";

const spec = (sandboxId: string, env: { readonly [name: string]: string }) => ({
	sandboxId,
	accountId: "acc_a",
	type: "microvm" as const,
	subdomain: sandboxId,
	env,
	eligibleHosts: [STUB_HOST_ID],
});

describe("the stub backend's updateEnv", () => {
	it("gives a running machine's next command exactly the new env, its disk kept", async () => {
		const backend = createStubBackend();
		expect((await backend.capabilities()).hosts[0]?.features).toContain("sandbox-env");
		await backend.create(spec("sbx_1", { OLD: "old" }));
		await backend.writeFile("sbx_1", "/home/user/kept.txt", new TextEncoder().encode("still here"), 0o644);
		const echo = async (id: string) =>
			(await backend.exec(id, { command: 'echo "[$OLD] [$NEW]"; cat /home/user/kept.txt' })).stdout;
		expect(await echo("sbx_1")).toBe("[old] []\nstill here");

		await backend.updateEnv?.("sbx_1", { NEW: "attached" });
		expect(await echo("sbx_1")).toBe("[] [attached]\nstill here");
		// A command's own variables still go on top of it.
		expect((await backend.exec("sbx_1", { command: "echo $NEW", env: { NEW: "own" } })).stdout).toBe("own\n");
		expect(await echo("sbx_1")).toBe("[] [attached]\nstill here");
	});
});

describe("the routed backend's updateEnv", () => {
	const recording = (calls: string[], updates: boolean): SandboxBackend => {
		const { updateEnv: _none, ...stub } = createStubBackend();
		return updates
			? {
					...stub,
					updateEnv: async (id: string, env: { readonly [name: string]: string }) => {
						calls.push(`${id} ${JSON.stringify(env)}`);
					},
				}
			: stub;
	};

	it("sends it to the backend holding the sandbox, and has none where neither backend has one", async () => {
		const primary: string[] = [];
		const fallback: string[] = [];
		const routed = createRoutedBackend({
			primary: recording(primary, true),
			fallback: recording(fallback, true),
			holds: async (id) => id.startsWith("sbx_p"),
			holdsSnapshot: () => false,
		});
		await routed.updateEnv?.("sbx_p1", { A: "1" });
		await routed.updateEnv?.("sbx_f1", {});
		expect(primary).toEqual(['sbx_p1 {"A":"1"}']);
		expect(fallback).toEqual(["sbx_f1 {}"]);

		const half = createRoutedBackend({
			primary: recording([], false),
			fallback: recording(fallback, true),
			holds: async (id) => id.startsWith("sbx_p"),
			holdsSnapshot: () => false,
		});
		// The primary's sandbox gets it at its next boot: nothing is sent, not to the fallback either.
		await half.updateEnv?.("sbx_p2", { A: "1" });
		expect(fallback).toHaveLength(1);
		await half.updateEnv?.("sbx_f2", { B: "2" });
		expect(fallback).toEqual(["sbx_f1 {}", 'sbx_f2 {"B":"2"}']);
		const neither = createRoutedBackend({
			primary: recording([], false),
			fallback: recording([], false),
			holds: async () => true,
			holdsSnapshot: () => false,
		});
		expect(neither.updateEnv).toBeUndefined();
	});
});
