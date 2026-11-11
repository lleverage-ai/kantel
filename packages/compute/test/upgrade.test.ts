// Upgrading an isolate to a microVM (`POST /sandboxes/{id}/upgrade`) and `autoUpgrade`: the same sandbox, its ID and
// settings kept, its `/workspace` files in the microVM, its usage split at the upgrade, a failure that leaves the
// isolate as it was, idempotency, commands that wait for it, a command run again once after an automatic upgrade, and
// who may do it.
import { createKantelClient, KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { ExecRequest, ExecResult, SandboxBackend, SandboxSpec, UpgradedPlacement } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { needsMicrovmOf } from "../src/needs-microvm.ts";
import { PLACEHOLDER_RATES } from "../src/service.ts";
import { createStubBackend } from "../src/stub-backend.ts";
import { bytesToBase64 } from "../src/util.ts";

const BASE_URL = "http://compute.test/v1";
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
};
const KEY = bytesToBase64(new Uint8Array(32).fill(7));
const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

interface Options {
	/** Stands in for the backend's upgrade: undefined lets the stub do it. */
	readonly upgrade?: (sandboxId: string, spec: SandboxSpec) => Promise<UpgradedPlacement> | undefined;
	/** Answers a command in place of the stub's shell, or `undefined` to let the stub run it. */
	readonly exec?: (sandboxId: string, request: ExecRequest) => ExecResult | undefined;
	readonly now?: () => number;
}

function setup(options: Options = {}) {
	const stub = createStubBackend();
	const upgrades: { readonly sandboxId: string; readonly spec: SandboxSpec }[] = [];
	const backend: SandboxBackend = {
		...stub,
		exec: async (sandboxId, request) => options.exec?.(sandboxId, request) ?? stub.exec(sandboxId, request),
		upgrade: async (sandboxId, spec) => {
			upgrades.push({ sandboxId, spec });
			const instead = options.upgrade?.(sandboxId, spec);
			if (instead !== undefined) return instead;
			if (stub.upgrade === undefined) throw new Error("The stub upgrades isolates");
			return stub.upgrade(sandboxId, spec);
		},
	};
	const api = createComputeApi({
		backend,
		secretsKey: KEY,
		...(options.now === undefined ? {} : { now: options.now }),
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const client = (token: string): KantelClient =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, stub, upgrades, client, tom: client("tom-token") };
}

async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

/** An isolate with some files: a directory, a file, an executable script and a link. */
async function isolateWithFiles(tom: KantelClient, extra: Parameters<KantelClient["createSandbox"]>[0] = {}) {
	const sandbox = await tom.createSandbox({
		name: "tickets",
		labels: { ticket: "PROJ-12" },
		env: { REGION: "eu" },
		wait: true,
		...extra,
	});
	expect(sandbox.type).toBe("isolate");
	const made = await tom.runCommand(sandbox.id, {
		command:
			"mkdir -p src && echo hello > src/a.txt && printf '#!/bin/sh\\necho run\\n' > run.sh && chmod 755 run.sh && ln -s src/a.txt link",
	});
	expect(made.exitCode).toBe(0);
	return sandbox;
}

describe("upgrading an isolate to a microVM", () => {
	it("keeps the sandbox, its settings and its files, at /home/user/workspace and through /workspace", async () => {
		const { tom, upgrades } = setup();
		const sandbox = await isolateWithFiles(tom);
		const upgraded = await tom.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({
			id: sandbox.id,
			name: "tickets",
			subdomain: sandbox.subdomain,
			labels: { ticket: "PROJ-12" },
			type: "microvm",
			state: "running",
			size: "default",
			image: "ubuntu-26.04",
			capabilities: { ssh: true, docker: true },
		});
		expect(upgraded.upgradedFrom?.type).toBe("isolate");
		expect(upgrades).toHaveLength(1);
		expect(upgrades[0]?.spec).toMatchObject({ sandboxId: sandbox.id, type: "microvm", env: { REGION: "eu" } });

		// Its files, where a microVM keeps work, and where the isolate had them.
		expect((await tom.readFile(sandbox.id, { path: "/home/user/workspace/src/a.txt" })).content).toBe("hello\n");
		const run = await tom.runCommand(sandbox.id, {
			command:
				"cat /workspace/src/a.txt; readlink /workspace; readlink /home/user/workspace/link; /workspace/run.sh; echo $REGION",
		});
		expect(run.stdout).toBe("hello\n/home/user/workspace\nsrc/a.txt\nrun\neu\n");
		expect(run.cwd).toBe("/home/user");

		const events = (await tom.listEvents({ sandboxId: sandbox.id })).items;
		const event = events.find((each) => each.type === "sandbox.upgraded");
		expect(event?.data).toMatchObject({
			from: "isolate",
			to: "microvm",
			previousState: "running",
			path: "host",
			files: 4,
			bytes: 6 + "#!/bin/sh\necho run\n".length,
		});
		expect(events.map((each) => each.type)).not.toContain("sandbox.deleted");

		// Upgraded already: answered as it is, nothing made again.
		expect((await tom.upgradeSandbox(sandbox.id, {})).type).toBe("microvm");
		expect(upgrades).toHaveLength(1);
	});

	it("makes the size, shape and image asked for", async () => {
		const { tom, upgrades } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const large = await tom.upgradeSandbox(sandbox.id, { size: "large", image: "ubuntu-24.04" });
		expect(large).toMatchObject({ size: "large", image: "ubuntu-24.04", resources: { vcpus: 4, memoryMb: 8192 } });
		expect(upgrades[0]?.spec).toMatchObject({ size: "large", image: "ubuntu-24.04" });

		const other = await tom.createSandbox({ wait: true });
		const shaped = await tom.upgradeSandbox(other.id, { resources: { vcpus: 3, memoryMb: 6144 } });
		expect(shaped.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });
		const third = await tom.createSandbox({ wait: true });
		const both = await failure(
			tom.upgradeSandbox(third.id, { size: "small", resources: { vcpus: 1, memoryMb: 1024 } }),
		);
		expect(both.status).toBe(400);
		expect((await tom.getSandbox(third.id)).type).toBe("isolate");
	});

	it("carries its environments, protected variables and grants", async () => {
		const { tom, upgrades } = setup();
		const environment = await tom.createEnvironment({ name: "backend" });
		await tom.setEnvironmentVariable(environment.id, "LOG_LEVEL", { value: "debug" });
		await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
			protected: true,
			value: "ghp_TESTSECRETVALUE123",
			bindings: [{ host: "api.github.com", pathPrefixes: ["/repos/"], methods: ["GET"] }],
		});
		const sandbox = await tom.createSandbox({ environment: "backend", wait: true });
		await tom.putSandboxGrants(sandbox.id, { grants: [{ action: "allow", host: "example.com" }] });
		const placeholder = (await tom.runCommand(sandbox.id, { command: "echo $GH_TOKEN" })).stdout.trim();
		expect(placeholder).toMatch(/^kph_/);

		const upgraded = await tom.upgradeSandbox(sandbox.id, {});
		expect(upgraded.environmentIds).toEqual([environment.id]);
		expect(upgraded.grants).toMatchObject([{ action: "allow", host: "example.com" }]);
		const spec = upgrades[0]?.spec;
		expect(spec?.env).toMatchObject({ LOG_LEVEL: "debug", GH_TOKEN: placeholder });
		expect(spec?.egress?.grants?.map((grant) => grant.host)).toEqual(expect.arrayContaining(["example.com"]));
		expect(spec?.egress?.protected).toBeDefined();
		expect(JSON.stringify(spec)).not.toContain("ghp_TESTSECRETVALUE123");
		// The same placeholder in the microVM: the host swaps it for the value as it did in the isolate.
		expect((await tom.runCommand(sandbox.id, { command: "echo $GH_TOKEN" })).stdout.trim()).toBe(placeholder);
	});

	it("brings a stopped isolate back as a running microVM with the files it stopped with", async () => {
		const { tom } = setup();
		const sandbox = await isolateWithFiles(tom);
		await tom.stopSandbox(sandbox.id, { wait: true });
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");
		const upgraded = await tom.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ type: "microvm", state: "running" });
		expect((await tom.runCommand(sandbox.id, { command: "cat /workspace/src/a.txt" })).stdout).toBe("hello\n");
		const types = (await tom.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(types).toEqual(expect.arrayContaining(["sandbox.upgraded", "sandbox.running"]));
	});

	it("ends the isolate's time and starts the microVM's at the upgrade, each at its own rate", async () => {
		let at = 1_000_000;
		const { tom, api } = setup({ now: () => at });
		const sandbox = await tom.createSandbox({ wait: true, autoStopMinutes: null });
		const isolateRate = (await tom.getSandbox(sandbox.id)).cost.ratePerHour;
		at += 3_600_000;
		await tom.upgradeSandbox(sandbox.id, {});
		at += 3_600_000;
		const view = await tom.getSandbox(sandbox.id);
		const microvmRate = 2 * PLACEHOLDER_RATES.microvmPerVcpuHour + 4 * PLACEHOLDER_RATES.microvmPerGbHour;
		expect(view.cost.ratePerHour).toBeCloseTo(microvmRate, 6);
		expect(view.usage.runningSeconds).toBeCloseTo(7200, 0);
		expect(view.cost.total).toBeCloseTo(isolateRate + microvmRate, 4);
		expect(isolateRate).toBeLessThan(microvmRate);
		const runs = (await api.store.sandboxes.get(sandbox.id))?.runs;
		expect(runs).toEqual([{ from: 1_000_000, to: 4_600_000, ratePerHour: isolateRate }, { from: 4_600_000 }]);
	});

	it("leaves the isolate as it was when the microVM can't be made", async () => {
		const { tom, api } = setup({
			upgrade: () => Promise.reject(new KantelError("exhausted", "No host has room for the microVM")),
		});
		const sandbox = await isolateWithFiles(tom);
		const before = await tom.getSandbox(sandbox.id);
		const refused = await failure(tom.upgradeSandbox(sandbox.id, {}));
		expect(refused.status).toBe(429);
		expect(refused.message).toContain("No host has room");
		const after = await tom.getSandbox(sandbox.id);
		expect(after).toMatchObject({
			type: "isolate",
			state: "running",
			stopsAt: before.stopsAt,
			startedAt: before.startedAt,
		});
		expect(after.upgradedFrom).toBeUndefined();
		const stored = await api.store.sandboxes.get(sandbox.id);
		expect(stored?.runs).toHaveLength(1);
		expect(stored?.runs[0]?.to).toBeUndefined();
		expect((await tom.runCommand(sandbox.id, { command: "cat src/a.txt" })).stdout).toBe("hello\n");
		const types = (await tom.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(types).not.toContain("sandbox.upgraded");
	});

	it("is done once for one Idempotency-Key", async () => {
		const { tom, upgrades } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const first = await tom.upgradeSandbox(sandbox.id, { size: "small" }, { idempotencyKey: "up-1" });
		const again = await tom.upgradeSandbox(sandbox.id, { size: "small" }, { idempotencyKey: "up-1" });
		expect(again).toMatchObject({ id: first.id, type: "microvm", size: "small" });
		expect(upgrades).toHaveLength(1);
		expect((await failure(tom.upgradeSandbox(sandbox.id, { size: "large" }, { idempotencyKey: "up-1" }))).status).toBe(
			422,
		);
	});

	it("holds commands and file calls made meanwhile until the microVM runs them", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { tom, stub } = setup({
			upgrade: async (sandboxId, spec) => {
				await held;
				return stub.upgrade?.(sandboxId, spec) as Promise<UpgradedPlacement>;
			},
		});
		const sandbox = await isolateWithFiles(tom);
		const upgrading = tom.upgradeSandbox(sandbox.id, {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await tom.getSandbox(sandbox.id)).state).toBe("starting");
		const command = tom.runCommand(sandbox.id, { command: "test -L /workspace && cat /workspace/src/a.txt" });
		const read = tom.readFile(sandbox.id, { path: "/home/user/workspace/src/a.txt" });
		let answered = false;
		void command.then(() => {
			answered = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(answered).toBe(false);
		release();
		expect((await upgrading).type).toBe("microvm");
		expect((await command).stdout).toBe("hello\n");
		expect((await read).content).toBe("hello\n");
	});

	it("answers wait: false at once, starting, and finishes on its own", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const answered = await tom.upgradeSandbox(sandbox.id, { wait: false });
		expect(answered.state).toBe("starting");
		expect((await tom.runCommand(sandbox.id, { command: "test -L /workspace && echo vm" })).stdout).toBe("vm\n");
		expect((await tom.getSandbox(sandbox.id)).type).toBe("microvm");
	});

	it("needs sandboxes:write", async () => {
		const { tom, client } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const runner = client(
			(await tom.createApiKey({ name: "runner", scopes: ["sandboxes:read", "exec", "files"] })).secret,
		);
		const refused = await failure(runner.upgradeSandbox(sandbox.id, {}));
		expect(refused.status).toBe(403);
		expect((await tom.getSandbox(sandbox.id)).type).toBe("isolate");
		const writer = client(
			(await tom.createApiKey({ name: "writer", scopes: ["sandboxes:read", "sandboxes:write"] })).secret,
		);
		expect((await writer.upgradeSandbox(sandbox.id, {})).type).toBe("microvm");
	});

	it("refuses an isolate that is neither running nor stopped, and a deployment that can't upgrade", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.deleteSandbox(sandbox.id);
		expect((await failure(tom.upgradeSandbox(sandbox.id, {}))).status).toBe(404);

		const { upgrade: _none, ...plain } = createStubBackend();
		const api = createComputeApi({
			backend: plain,
			authenticatePerson: async () => PEOPLE["tom-token"],
			fetch: async () => new Response(null, { status: 204 }),
		});
		opened.push(api);
		const other = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const isolate = await other.createSandbox({ wait: true });
		const refused = await failure(other.upgradeSandbox(isolate.id, {}));
		expect(refused.status).toBe(501);
		expect((await other.getSandbox(isolate.id)).type).toBe("isolate");
	});
});

describe("a command that needs a microVM", () => {
	it("says so, and the isolate stays one without autoUpgrade", async () => {
		const { tom, upgrades } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const command = await tom.runCommand(sandbox.id, { command: "gi" + "t status" });
		expect(command.exitCode).toBe(127);
		expect(command.needsMicrovm).toMatchObject({ command: "gi" + "t" });
		expect(command.rerunAs).toBeUndefined();
		expect((await tom.getSandbox(sandbox.id)).type).toBe("isolate");
		expect(upgrades).toHaveLength(0);
		// A typo isn't one.
		expect((await tom.runCommand(sandbox.id, { command: "gti status" })).needsMicrovm).toBeUndefined();
	});

	it("with autoUpgrade, upgrades the isolate and runs the command again there, once", async () => {
		let upgraded = false;
		const { tom, upgrades, stub } = setup({
			// The isolate refuses the program, as an isolate host's shell does; the microVM has it.
			exec: (_id, request) => {
				if (!request.command.startsWith("tar ")) return undefined;
				if (upgraded) return { exitCode: 0, stdout: `tar in ${request.cwd}\n`, stderr: "", timedOut: false };
				const stderr = "tar: not available in an isolate, which runs only its shell's own commands. Use a microVM.\n";
				const result = { exitCode: 127, stdout: "", stderr, timedOut: false };
				return { ...result, needsMicrovm: needsMicrovmOf(result) };
			},
			upgrade: async (sandboxId, spec) => {
				const placed = await (stub.upgrade?.(sandboxId, spec) as Promise<UpgradedPlacement>);
				upgraded = true;
				return placed;
			},
		});
		const sandbox = await tom.createSandbox({ autoUpgrade: true, wait: true });
		expect(sandbox.autoUpgrade).toBe(true);
		const answer = await tom.runCommand(sandbox.id, { command: "tar --version" });
		expect(answer).toMatchObject({ state: "exited", exitCode: 0, stdout: "tar in /workspace\n" });
		expect(answer.rerunOf).toBeDefined();
		expect(upgrades).toHaveLength(1);
		const first = await tom.getCommand(sandbox.id, answer.rerunOf as string);
		expect(first).toMatchObject({ exitCode: 127, needsMicrovm: { command: "tar" }, rerunAs: answer.id });
		expect((await tom.getSandbox(sandbox.id)).type).toBe("microvm");
		expect((await tom.listCommands(sandbox.id)).items.map((command) => command.id).sort()).toEqual(
			[answer.id, first.id].sort(),
		);
	});

	it("with autoUpgrade, keeps the first answer and says why when the upgrade fails", async () => {
		const { tom } = setup({
			upgrade: () => Promise.reject(new KantelError("unavailable", "No host runs microvm sandboxes")),
		});
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.updateSandbox(sandbox.id, { autoUpgrade: true });
		const answer = await tom.runCommand(sandbox.id, { command: "gi" + "t status" });
		expect(answer).toMatchObject({ exitCode: 127, needsMicrovm: { command: "gi" + "t" } });
		expect(answer.rerunAs).toBeUndefined();
		expect(answer.stderr).toContain("couldn't be upgraded to a microVM: No host runs microvm sandboxes");
		expect((await tom.getSandbox(sandbox.id)).type).toBe("isolate");
		expect((await tom.updateSandbox(sandbox.id, { autoUpgrade: false })).autoUpgrade).toBeUndefined();
	});
});

describe("needsMicrovmOf", () => {
	it("reads an isolate shell's refusal, and only a microVM's programs from command not found", () => {
		const result = (stderr: string, exitCode = 127) => ({ exitCode, stdout: "", stderr, timedOut: false });
		expect(
			needsMicrovmOf(
				result("tar: not available in an isolate, which runs only its shell's own commands. Use a microVM.\n"),
			),
		).toMatchObject({ command: "tar" });
		expect(needsMicrovmOf(result("bash: npm: command not found\n"))).toMatchObject({ command: "npm" });
		expect(needsMicrovmOf(result("bash: gti: command not found\n"))).toBeUndefined();
		expect(needsMicrovmOf(result("bash: npm: command not found\n", 1))).toBeUndefined();
		const said = { command: "pip install", reason: "Packages need a microVM." };
		expect(needsMicrovmOf({ ...result("anything", 1), needsMicrovm: said })).toEqual(said);
	});
});
