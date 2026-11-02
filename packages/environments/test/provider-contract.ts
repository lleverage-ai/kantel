// The provider contract: what every `EnvironmentProvider` must do, as one suite each provider's test runs against its
// own factory. A self-hosted or bring-your-own provider passes the same suite before the broker uses it.
import type { EnvironmentProvider, MachineRef, MachineSpec, MachineStatus } from "@kantel/contracts";
import { expect, it } from "vitest";

export interface ProviderUnderTest {
	readonly provider: EnvironmentProvider;
	/** Waits until the provider's machine settles, for providers whose moves take time. */
	readonly settle?: () => Promise<void>;
}

const spec = (environmentId: string, version = 1): MachineSpec => ({
	environmentId,
	name: `contract-${environmentId}`,
	size: "default",
	definition: { version },
	labels: { "kantel.test": "contract" },
});

async function until(
	provider: EnvironmentProvider,
	ref: MachineRef,
	want: MachineStatus,
	settle?: () => Promise<void>,
) {
	for (let i = 0; i < 50; i++) {
		await settle?.();
		const state = await provider.status(ref);
		if (state.status === want) return state;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`The machine never reached ${want}; it is ${(await provider.status(ref)).status}`);
}

/** Registers the contract's tests for the provider `make` builds afresh for each. */
export function providerContract(make: () => ProviderUnderTest): void {
	it("declares what it can do", () => {
		const { provider } = make();
		const capabilities = provider.capabilities();
		expect(capabilities.sizes).toContain("default");
		expect(capabilities.stopModes).toContain("stop");
		expect(capabilities.maxExecMs).toBeGreaterThan(0);
		expect(["managed", "unmanaged"]).toContain(capabilities.egress);
	});

	it("creates a machine idempotently, and it comes up", async () => {
		const { provider, settle } = make();
		const first = await provider.create(spec("env_a"));
		const again = await provider.create(spec("env_a"));
		expect(again).toEqual(first);
		expect(first.provider).toBe(provider.kind);
		await until(provider, first, "running", settle);
		const other = await provider.create(spec("env_a", 2));
		expect(other.machineId).not.toBe(first.machineId);
	});

	it("runs a command with its exit code, output, directory and variables", async () => {
		const { provider, settle } = make();
		const ref = await provider.create(spec("env_exec"));
		await until(provider, ref, "running", settle);
		const ok = await provider.exec(ref, { command: "echo hello" });
		expect(ok).toMatchObject({ exitCode: 0, stdout: "hello\n", timedOut: false });
		const failed = await provider.exec(ref, { command: "exit 3" });
		expect(failed.exitCode).toBe(3);
		await provider.exec(ref, { command: "mkdir -p /home/user/work/a" });
		const where = await provider.exec(ref, { command: "pwd", cwd: "/home/user/work/a" });
		expect(where.stdout).toBe("/home/user/work/a\n");
		const env = await provider.exec(ref, { command: "printenv GREETING", env: { GREETING: "it's me" } });
		expect(env.stdout).toBe("it's me\n");
		const chunks: string[] = [];
		await provider.exec(ref, { command: "echo streamed", onOutput: (_stream, chunk) => chunks.push(chunk) });
		expect(chunks.join("")).toBe("streamed\n");
	});

	it("reads, writes, lists and removes files", async () => {
		const { provider, settle } = make();
		const ref = await provider.create(spec("env_files"));
		await until(provider, ref, "running", settle);
		const files = provider.files(ref);
		const bytes = new Uint8Array([0, 1, 2, 250, 255]);
		await files.write("/home/user/data/blob.bin", bytes);
		expect(await files.read("/home/user/data/blob.bin")).toEqual(bytes);
		await files.write("/home/user/data/note.txt", new TextEncoder().encode("hi"));
		const listed = await files.list("/home/user/data");
		expect(listed.map((entry) => entry.name)).toEqual(["blob.bin", "note.txt"]);
		expect(listed.find((entry) => entry.name === "note.txt")).toMatchObject({ directory: false, size: 2 });
		const cat = await provider.exec(ref, { command: "cat data/note.txt" });
		expect(cat.stdout).toBe("hi");
		await files.remove("/home/user/data/note.txt");
		expect((await files.list("/home/user/data")).map((entry) => entry.name)).toEqual(["blob.bin"]);
	});

	it("stops keeping its disk, and starts again", async () => {
		const { provider, settle } = make();
		const ref = await provider.create(spec("env_cycle"));
		await until(provider, ref, "running", settle);
		await provider.files(ref).write("/home/user/kept.txt", new TextEncoder().encode("kept"));
		await provider.stop(ref);
		await until(provider, ref, "stopped", settle);
		// A second stop is answered as it is.
		expect((await provider.stop(ref)).status).toBe("stopped");
		await provider.start(ref);
		await until(provider, ref, "running", settle);
		// A start of a running machine is answered as it is.
		expect((await provider.start(ref)).status).toBe("running");
		expect((await provider.exec(ref, { command: "cat kept.txt" })).stdout).toBe("kept");
	});

	it("exposes a port", async () => {
		const { provider, settle } = make();
		const ref = await provider.create(spec("env_port"));
		await until(provider, ref, "running", settle);
		const gated = await provider.expose(ref, 3000);
		expect(gated).toMatchObject({ port: 3000, public: false });
		expect(gated.url).toMatch(/^https:\/\//);
		expect((await provider.expose(ref, 8080, { public: true })).public).toBe(true);
	});

	it("snapshots and forks, keeping the files", async () => {
		const { provider, settle } = make();
		if (!provider.capabilities().fork || provider.fork === undefined || provider.snapshot === undefined) return;
		const ref = await provider.create(spec("env_source"));
		await until(provider, ref, "running", settle);
		await provider.files(ref).write("/home/user/seed.txt", new TextEncoder().encode("seed"));
		const fork = await provider.fork(ref, spec("env_fork"));
		await until(provider, fork, "running", settle);
		expect((await provider.exec(fork, { command: "cat seed.txt" })).stdout).toBe("seed");
		const snapshot = await provider.snapshot(ref, "contract-seed");
		const fromSnapshot = await provider.fork(snapshot, spec("env_from_snapshot"));
		await until(provider, fromSnapshot, "running", settle);
		expect((await provider.exec(fromSnapshot, { command: "cat seed.txt" })).stdout).toBe("seed");
	});

	it("destroys a machine, running or not, and a second destroy is not an error", async () => {
		const { provider, settle } = make();
		const ref = await provider.create(spec("env_gone"));
		await until(provider, ref, "running", settle);
		await provider.destroy(ref);
		expect((await provider.status(ref)).status).toBe("gone");
		await provider.destroy(ref);
	});

	it("reports a machine it never had as gone", async () => {
		const { provider } = make();
		expect((await provider.status({ provider: provider.kind, machineId: "bx_nothere" })).status).toBe("gone");
	});
}
