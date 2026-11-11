// Upgrading an isolate to a microVM (`POST /sandboxes/{id}/upgrade`) and `autoUpgrade`: the same sandbox, its ID and
// settings kept, its `/workspace` files in the microVM, its usage split at the upgrade, a failure that leaves the
// isolate as it was, idempotency, commands that wait for it, a command run again once after an automatic upgrade, and
// who may do it.
import { createKantelClient, KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import {
	type BackendEgress,
	type ExecRequest,
	type ExecResult,
	type SandboxBackend,
	type SandboxSpec,
	type UpgradedPlacement,
	type UpgradeOutcome,
	upgradeOutcomeUnknown,
} from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { needsMicrovmOf } from "../src/needs-microvm.ts";
import { HOST_REVOKED_REASON, PLACEHOLDER_RATES, UPGRADE_STALE_MS } from "../src/service.ts";
import { type ComputeStore, createMemoryStore } from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";
import { TarCheck, writeTar } from "../src/tar.ts";
import { bytesToBase64 } from "../src/util.ts";

const BASE_URL = "http://compute.test/v1";
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};
const KEY = bytesToBase64(new Uint8Array(32).fill(7));
/** A command's answer when the isolate's runtime says it needs a microVM. */
const NEEDS_TAR = {
	exitCode: 127,
	stdout: "",
	stderr: "tar: not available in an isolate, which runs only its shell's own commands. Use a microVM.\n",
	needsMicrovm: { command: "tar", reason: "tar is not available in an isolate." },
} as const;
const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

interface Options {
	/** Stands in for the backend's upgrade: undefined lets the stub do it. */
	readonly upgrade?: (
		sandboxId: string,
		spec: SandboxSpec,
		operationId: string,
	) => Promise<UpgradedPlacement> | undefined;
	/** Stands in for the backend's settling of an upgrade: undefined lets the stub do it. */
	readonly settle?: (sandboxId: string, operationId: string) => Promise<UpgradeOutcome> | undefined;
	/** Answers a command in place of the stub's shell, or `undefined` to let the stub run it. */
	readonly exec?: (sandboxId: string, request: ExecRequest) => ExecResult | undefined | Promise<ExecResult>;
	/** Takes egress updates, as a host does; absent, the backend takes none (as the stub). */
	readonly updateEgress?: (sandboxId: string, egress: BackendEgress | undefined, revision?: number) => Promise<void>;
	/** Answers commands' results by their ID, as a host that keeps them does. */
	readonly results?: Map<string, ExecResult>;
	/** Takes a command's kill, as a host does, after the stub's. */
	readonly kill?: (sandboxId: string, commandId: string) => void;
	readonly now?: () => number;
	readonly store?: ComputeStore;
}

function setup(options: Options = {}) {
	const stub = createStubBackend();
	const upgrades: { readonly sandboxId: string; readonly spec: SandboxSpec; readonly operationId: string }[] = [];
	const backend: SandboxBackend = {
		...stub,
		exec: async (sandboxId, request) => {
			const result = (await options.exec?.(sandboxId, request)) ?? (await stub.exec(sandboxId, request));
			if (request.commandId !== undefined) options.results?.set(request.commandId, result);
			return result;
		},
		upgrade: async (sandboxId, spec, operationId) => {
			upgrades.push({ sandboxId, spec, operationId });
			const instead = options.upgrade?.(sandboxId, spec, operationId);
			if (instead !== undefined) return instead;
			if (stub.upgrade === undefined) throw new Error("The stub upgrades isolates");
			return stub.upgrade(sandboxId, spec, operationId);
		},
		settleUpgrade: async (sandboxId, operationId) => {
			const instead = options.settle?.(sandboxId, operationId);
			if (instead !== undefined) return instead;
			if (stub.settleUpgrade === undefined) throw new Error("The stub settles upgrades");
			return stub.settleUpgrade(sandboxId, operationId);
		},
		...(options.updateEgress === undefined ? {} : { updateEgress: options.updateEgress }),
		...(options.kill === undefined
			? {}
			: {
					killCommand: async (sandboxId: string, commandId: string) => {
						await stub.killCommand?.(sandboxId, commandId);
						options.kill?.(sandboxId, commandId);
					},
				}),
		...(options.results === undefined
			? {}
			: { commandResult: async (_sandboxId: string, commandId: string) => options.results?.get(commandId) }),
	};
	const api = createComputeApi({
		backend,
		secretsKey: KEY,
		...(options.store === undefined ? {} : { store: options.store }),
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
			upgrade: async (sandboxId, spec, operationId) => {
				await held;
				return stub.upgrade?.(sandboxId, spec, operationId) as Promise<UpgradedPlacement>;
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
		expect(command.needsMicrovm).toMatchObject({ command: "gi" + "t", inferred: true });
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
				// As the isolate's runtime says it, not read from the shell's answer.
				return { ...NEEDS_TAR, timedOut: false };
			},
			upgrade: async (sandboxId, spec, operationId) => {
				const placed = await (stub.upgrade?.(sandboxId, spec, operationId) as Promise<UpgradedPlacement>);
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

		// Detached (as the CLI runs commands): the first ends only once its run again has started, naming it.
		const other = await tom.createSandbox({ autoUpgrade: true, wait: true });
		upgraded = false;
		const started = await tom.runCommand(other.id, { command: "tar -tf x.tar", detached: true });
		let ended = await tom.getCommand(other.id, started.id);
		for (let tries = 0; ended.state === "running" && tries < 200; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			ended = await tom.getCommand(other.id, started.id);
		}
		expect(ended).toMatchObject({ exitCode: 127, needsMicrovm: { command: "tar" } });
		expect(ended.rerunAs).toBeDefined();
		let again = await tom.getCommand(other.id, ended.rerunAs as string);
		for (let tries = 0; again.state === "running" && tries < 200; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			again = await tom.getCommand(other.id, again.id);
		}
		expect(again).toMatchObject({ state: "exited", exitCode: 0, rerunOf: started.id, stdout: "tar in /workspace\n" });
	});

	it("with autoUpgrade, keeps the first answer and says why when the upgrade fails", async () => {
		const { tom } = setup({
			upgrade: () => Promise.reject(new KantelError("unavailable", "No host runs microvm sandboxes")),
			exec: (_id, request) => (request.command.startsWith("tar ") ? { ...NEEDS_TAR, timedOut: false } : undefined),
		});
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.updateSandbox(sandbox.id, { autoUpgrade: true });
		const answer = await tom.runCommand(sandbox.id, { command: "tar -xf a.tar" });
		expect(answer).toMatchObject({ exitCode: 127, needsMicrovm: { command: "tar" } });
		expect(answer.rerunAs).toBeUndefined();
		expect(answer.stderr).toContain("couldn't be upgraded to a microVM: No host runs microvm sandboxes");
		expect((await tom.getSandbox(sandbox.id)).type).toBe("isolate");
		expect((await tom.updateSandbox(sandbox.id, { autoUpgrade: false })).autoUpgrade).toBeUndefined();
	});
});

describe("a command killed while autoUpgrade runs it again", () => {
	/** A sandbox with autoUpgrade whose `tar` needs a microVM, its upgrade held until `release`, and its runs in the microVM. */
	function held(options: { readonly holdRerun?: boolean; readonly store?: ComputeStore } = {}) {
		let upgraded = false;
		let release = (): void => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reruns: string[] = [];
		const kills: string[] = [];
		const rerunsKilled = new Map<string, () => void>();
		const made = setup({
			exec: (_id, request) => {
				if (!request.command.startsWith("tar ")) return undefined;
				if (!upgraded) return { ...NEEDS_TAR, timedOut: false };
				reruns.push(request.commandId ?? "");
				if (options.holdRerun !== true) return { exitCode: 0, stdout: "tar\n", stderr: "", timedOut: false };
				// Runs until it is killed.
				return new Promise<ExecResult>((resolve) =>
					rerunsKilled.set(request.commandId ?? "", () =>
						resolve({ exitCode: 137, stdout: "", stderr: "", timedOut: false }),
					),
				);
			},
			upgrade: async (sandboxId, spec, operationId) => {
				await gate;
				const placed = await (made.stub.upgrade?.(sandboxId, spec, operationId) as Promise<UpgradedPlacement>);
				upgraded = true;
				return placed;
			},
			kill: (_id, commandId) => {
				kills.push(commandId);
				rerunsKilled.get(commandId)?.();
			},
			...(options.store === undefined ? {} : { store: options.store }),
		});
		return { ...made, release: () => release(), reruns, kills };
	}

	const until = async (check: () => Promise<boolean> | boolean) => {
		for (let tries = 0; tries < 300 && !(await check()); tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(await check()).toBe(true);
	};

	it("isn't run again when it is killed while its isolate upgrades, attached or detached", async () => {
		for (const detached of [false, true]) {
			const { tom, upgrades, release, reruns } = held();
			const sandbox = await tom.createSandbox({ autoUpgrade: true, wait: true });
			const answer = tom.runCommand(sandbox.id, { command: "tar -xf a.tar", detached });
			await until(() => upgrades.length === 1);
			const [first] = (await tom.listCommands(sandbox.id)).items;
			if (first === undefined) throw new Error("no command");
			expect((await tom.killCommand(sandbox.id, first.id)).state).toBe("killed");
			release();
			// The upgrade itself is done; the command isn't run again.
			await until(async () => (await tom.getSandbox(sandbox.id)).type === "microvm");
			const answered = await answer;
			if (!detached) expect(answered).toMatchObject({ id: first.id, state: "killed" });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(reruns).toEqual([]);
			const commands = (await tom.listCommands(sandbox.id)).items;
			expect(commands.map((command) => command.id)).toEqual([first.id]);
			expect(commands[0]).toMatchObject({ state: "killed" });
			expect(commands[0]?.rerunAs).toBeUndefined();
		}
	});

	it("isn't run again when the kill lands as its run again is being recorded", async () => {
		for (const detached of [false, true]) {
			// The kill lands after the first was given its run again's ID, before that run is recorded.
			const store = createMemoryStore();
			const put = store.commands.put.bind(store.commands);
			let killing: Promise<unknown> | undefined;
			store.commands.put = async (record) => {
				if (record.rerunOf !== undefined && killing === undefined) {
					killing = made.tom.killCommand(record.sandboxId, record.rerunOf);
					await killing;
				}
				return put(record);
			};
			const made = held({ store });
			const { tom, release, reruns } = made;
			const sandbox = await tom.createSandbox({ autoUpgrade: true, wait: true });
			const answer = tom.runCommand(sandbox.id, { command: "tar -xf a.tar", detached });
			release();
			await until(() => killing !== undefined);
			const answered = await answer;
			await until(async () => (await tom.listCommands(sandbox.id)).items.every((each) => each.state !== "running"));
			expect(reruns).toEqual([]);
			const commands = (await tom.listCommands(sandbox.id)).items;
			const first = commands.find((command) => command.rerunOf === undefined);
			const rerun = commands.find((command) => command.rerunOf !== undefined);
			expect(first).toMatchObject({ state: "killed" });
			expect(rerun).toMatchObject({ state: "killed", rerunOf: first?.id });
			// The killed original still names the run again it had, attached or detached.
			expect(first?.rerunAs).toBe(rerun?.id);
			if (!detached) expect(answered).toMatchObject({ id: rerun?.id, state: "killed" });
		}
	});

	it("has its kill reach its run again once that has started, attached or detached", async () => {
		for (const detached of [false, true]) {
			const { tom, release, reruns, kills } = held({ holdRerun: true });
			const sandbox = await tom.createSandbox({ autoUpgrade: true, wait: true });
			const answer = tom.runCommand(sandbox.id, { command: "tar -xf a.tar", detached });
			release();
			await until(() => reruns.length === 1);
			const first = (await tom.listCommands(sandbox.id)).items.find((command) => command.rerunOf === undefined);
			if (first === undefined) throw new Error("no command");
			const killed = await tom.killCommand(sandbox.id, first.id);
			// Killed whichever it was when the kill came: the first still running, or ended naming its run again.
			const rerunId = killed.rerunAs ?? (await tom.getCommand(sandbox.id, first.id)).rerunAs;
			expect(rerunId).toBe(reruns[0]);
			expect(kills).toContain(reruns[0]);
			await until(async () => (await tom.getCommand(sandbox.id, rerunId as string)).state === "killed");
			const answered = await answer;
			if (!detached) expect(answered).toMatchObject({ id: rerunId, state: "killed" });
			expect((await tom.listCommands(sandbox.id)).items.filter((command) => command.state === "running")).toEqual([]);
		}
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

describe("writeTar", () => {
	it("writes a tar the archive check reads back, long names and links included", () => {
		const long = `${"d".repeat(70)}/${"f".repeat(70)}.txt`;
		const tar = writeTar([
			{ kind: "directory", name: "src" },
			{ kind: "file", name: "src/a.txt", bytes: new TextEncoder().encode("hello\n") },
			{ kind: "directory", name: "d".repeat(70) },
			{ kind: "file", name: long, mode: 0o755, bytes: new Uint8Array(1000) },
			{ kind: "symlink", name: "link", target: "src/a.txt" },
		]);
		expect(tar.length % 512).toBe(0);
		const check = new TarCheck({ maxBytes: 1 << 20 });
		check.push(tar);
		expect(check.end()).toEqual({ files: 2, directories: 2, symlinks: 1, bytes: 1006 });
	});
});

describe("an upgrade's outcome, when its answer is lost", () => {
	it("asks the backend, and publishes the microVM its host made though the answer never came", async () => {
		const { tom, stub, upgrades } = setup({
			// The host did it, then its answer was lost.
			upgrade: async (sandboxId, spec, operationId) => {
				await stub.upgrade?.(sandboxId, spec, operationId);
				throw upgradeOutcomeUnknown("The host didn't answer within the call's time");
			},
		});
		const sandbox = await isolateWithFiles(tom);
		const upgraded = await tom.upgradeSandbox(sandbox.id, {});
		expect(upgraded).toMatchObject({ type: "microvm", state: "running" });
		expect(upgrades).toHaveLength(1);
		expect((await tom.runCommand(sandbox.id, { command: "cat /workspace/src/a.txt" })).stdout).toBe("hello\n");
	});

	it("keeps it starting while that can't be told, and the sweep settles it once the host answers", async () => {
		let at = 1_000_000;
		let hostBack = false;
		const { tom, api, stub } = setup({
			now: () => at,
			upgrade: async (sandboxId, spec, operationId) => {
				await stub.upgrade?.(sandboxId, spec, operationId);
				throw upgradeOutcomeUnknown("The host went away during the upgrade");
			},
			settle: (sandboxId, operationId) =>
				hostBack
					? undefined
					: Promise.reject(new KantelError("unavailable", `The host is away (${sandboxId} ${operationId})`)),
		});
		const sandbox = await tom.createSandbox({ wait: true, autoStopMinutes: null });
		const refused = await failure(tom.upgradeSandbox(sandbox.id, {}));
		expect(refused.status).toBe(503);
		expect(refused.message).toContain("isn't known");
		// Neither put back (and billed as a running isolate) nor taken for a microVM.
		const stored = await api.store.sandboxes.get(sandbox.id);
		expect(stored).toMatchObject({ state: "starting", type: "isolate" });
		expect(stored?.upgrading?.operationId).toMatch(/^upg_/);
		await api.service.sweep();
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("starting");
		hostBack = true;
		at += UPGRADE_STALE_MS + 1;
		await api.service.sweep();
		const settled = await api.store.sandboxes.get(sandbox.id);
		expect(settled).toMatchObject({ state: "running", type: "microvm" });
		expect(settled?.upgrading).toBeUndefined();
	});

	it("puts back an isolate whose upgrading gateway died, once its backend says the upgrade never finished", async () => {
		let at = 1_000_000;
		const store = createMemoryStore();
		let hang: (error: Error) => void = () => undefined;
		const first = setup({
			now: () => at,
			store,
			// The gateway dies mid-upgrade: its call never ends.
			upgrade: () =>
				new Promise<UpgradedPlacement>((_resolve, reject) => {
					hang = reject;
				}),
		});
		const sandbox = await first.tom.createSandbox({ wait: true, autoStopMinutes: null });
		const before = await store.sandboxes.get(sandbox.id);
		void first.tom.upgradeSandbox(sandbox.id, { wait: false });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await store.sandboxes.get(sandbox.id))?.state).toBe("starting");
		// Another gateway, with no part in it, settles it once it has gone quiet.
		const other = setup({ now: () => at, store, settle: () => Promise.resolve({ state: "failed" as const }) });
		await other.api.service.sweep();
		expect((await store.sandboxes.get(sandbox.id))?.state).toBe("starting");
		at += UPGRADE_STALE_MS + 1;
		await other.api.service.sweep();
		const back = await store.sandboxes.get(sandbox.id);
		expect(back).toMatchObject({ state: "running", type: "isolate", runs: before?.runs });
		expect(back?.upgrading).toBeUndefined();
		hang(new KantelError("unavailable", "the gateway went"));
	});
});

describe("an upgrade's egress and billing", () => {
	it("enforces a grant revoked while it was upgrading before the microVM runs", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const updates: { revision?: number; hosts: string[]; state?: string }[] = [];
		let storeOf: ComputeStore | undefined;
		const { tom, stub, api } = setup({
			upgrade: async (sandboxId, spec, operationId) => {
				await held;
				return stub.upgrade?.(sandboxId, spec, operationId) as Promise<UpgradedPlacement>;
			},
			updateEgress: async (sandboxId, egress, revision) => {
				const state = (await storeOf?.sandboxes.get(sandboxId))?.state;
				updates.push({
					...(revision === undefined ? {} : { revision }),
					hosts: (egress?.grants ?? []).map((grant) => grant.host),
					...(state === undefined ? {} : { state }),
				});
			},
		});
		storeOf = api.store;
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.putSandboxGrants(sandbox.id, { grants: [{ action: "allow", host: "example.com" }] });
		const upgrading = tom.upgradeSandbox(sandbox.id, {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Revoked while the microVM is made: sent with the old grant.
		await tom.putSandboxGrants(sandbox.id, { grants: [] });
		updates.length = 0;
		release();
		const upgraded = await upgrading;
		expect(upgraded.type).toBe("microvm");
		const stored = await api.store.sandboxes.get(sandbox.id);
		// Sent to the microVM, without the grant, while it was still starting: it never ran with the old one.
		expect(updates.at(0)).toMatchObject({ hosts: [], state: "starting", revision: stored?.egressRevision });
		expect(stored?.egressApplied).toBe(stored?.egressRevision);
	});

	it("says it is the microVM it became when its host is revoked after replacing the isolate, before it is published", async () => {
		let root: KantelClient | undefined;
		const { tom, stub, api, client } = setup({
			// The host replaces the isolate, then is revoked before the control plane publishes the microVM.
			upgrade: async (sandboxId, spec, operationId) => {
				const placed = await (stub.upgrade?.(sandboxId, spec, operationId) as Promise<UpgradedPlacement>);
				await root?.revokeHost(STUB_HOST_ID);
				return placed;
			},
		});
		root = client("root-token");
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.upgradeSandbox(sandbox.id, {}).catch(() => undefined);
		const after = await tom.getSandbox(sandbox.id);
		expect(after).toMatchObject({ state: "error", reason: HOST_REVOKED_REASON, type: "microvm" });
		const stored = await api.store.sandboxes.get(sandbox.id);
		expect(stored?.upgrading).toBeUndefined();
		expect(stored?.upgradedFrom).toMatchObject({ type: "isolate" });
		expect(stored?.pendingProvision).toBeUndefined();
		const events = (await tom.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(events).toContain("sandbox.upgraded");
	});

	it("keeps the microVM it became when its egress can't be enforced there and it is stopped instead", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let storeOf: ComputeStore | undefined;
		const { tom, stub, api } = setup({
			upgrade: async (sandboxId, spec, operationId) => {
				await held;
				return stub.upgrade?.(sandboxId, spec, operationId) as Promise<UpgradedPlacement>;
			},
			// The microVM's host refuses the egress changed while it was made.
			updateEgress: async (sandboxId) => {
				if ((await storeOf?.sandboxes.get(sandboxId))?.state === "starting") {
					throw new KantelError("not_supported", "this host can't enforce egress grants");
				}
			},
		});
		storeOf = api.store;
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.putSandboxGrants(sandbox.id, { grants: [{ action: "allow", host: "example.com" }] });
		const upgrading = tom.upgradeSandbox(sandbox.id, {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		await tom.putSandboxGrants(sandbox.id, { grants: [] });
		release();
		await upgrading;
		let stopped = await tom.getSandbox(sandbox.id);
		for (let tries = 0; stopped.state !== "stopped" && tries < 300; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			stopped = await tom.getSandbox(sandbox.id);
		}
		// Stopped, never running with egress its host doesn't enforce, and a microVM: the isolate is gone.
		expect(stopped).toMatchObject({ state: "stopped", type: "microvm" });
		const stored = await api.store.sandboxes.get(sandbox.id);
		expect(stored?.upgrading).toBeUndefined();
		expect(stored?.upgradedFrom).toMatchObject({ type: "isolate" });
		const [snapshot] = (await tom.listSnapshots({ sandboxId: sandbox.id })).items;
		expect(snapshot?.sandboxType).toBe("microvm");
		const events = (await tom.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(events).toContain("sandbox.upgraded");
		// Started again, it starts as the microVM it is, from its own snapshot.
		const started = await tom.startSandbox(sandbox.id, { wait: true });
		expect(started).toMatchObject({ type: "microvm", state: "running" });
	});

	it("prices every run the isolate had as an isolate's, its stops and starts too", async () => {
		let at = 1_000_000;
		const { tom, api } = setup({ now: () => at });
		const sandbox = await tom.createSandbox({ wait: true, autoStopMinutes: null });
		const isolateRate = (await tom.getSandbox(sandbox.id)).cost.ratePerHour;
		at += 3_600_000;
		await tom.stopSandbox(sandbox.id, { wait: true });
		at += 3_600_000;
		await tom.startSandbox(sandbox.id, { wait: true });
		at += 3_600_000;
		await tom.stopSandbox(sandbox.id, { wait: true });
		// Upgraded from stopped, so both earlier runs are closed already.
		await tom.upgradeSandbox(sandbox.id, {});
		at += 3_600_000;
		const view = await tom.getSandbox(sandbox.id);
		const microvmRate = view.cost.ratePerHour;
		expect(view.cost.total).toBeCloseTo(2 * isolateRate + microvmRate, 4);
		const runs = (await api.store.sandboxes.get(sandbox.id))?.runs ?? [];
		expect(runs.slice(0, 2).every((run) => run.ratePerHour === isolateRate)).toBe(true);
		expect(runs.at(-1)?.ratePerHour).toBeUndefined();
	});
});

describe("autoUpgrade's limits", () => {
	it("never upgrades on a needsMicrovm read from the command's own output", async () => {
		const { tom, upgrades } = setup({
			// The guest prints the refusal itself, and exits 127: read from its answer, as a host reads one.
			exec: (_id, request) => {
				if (!request.command.startsWith("fake")) return undefined;
				const printed = { exitCode: 127, stdout: "", stderr: NEEDS_TAR.stderr, timedOut: false };
				return { ...printed, needsMicrovm: needsMicrovmOf(printed) };
			},
		});
		const sandbox = await tom.createSandbox({ autoUpgrade: true, wait: true });
		const answer = await tom.runCommand(sandbox.id, { command: "fake-tar" });
		expect(answer.needsMicrovm).toMatchObject({ command: "tar", inferred: true });
		expect(answer.rerunAs).toBeUndefined();
		expect(upgrades).toHaveLength(0);
		expect((await tom.getSandbox(sandbox.id)).type).toBe("isolate");
	});

	it("is set only with sandboxes:write, and then any key that may run commands may cause the upgrade", async () => {
		const { tom, client, upgrades } = setup({
			exec: (_id, request) => (request.command.startsWith("tar ") ? { ...NEEDS_TAR, timedOut: false } : undefined),
		});
		const runner = client((await tom.createApiKey({ name: "runner", scopes: ["sandboxes:read", "exec"] })).secret);
		const sandbox = await tom.createSandbox({ wait: true });
		expect((await failure(runner.updateSandbox(sandbox.id, { autoUpgrade: true }))).status).toBe(403);
		expect((await failure(runner.createSandbox({ autoUpgrade: true }))).status).toBe(403);
		expect((await tom.getSandbox(sandbox.id)).autoUpgrade).toBeUndefined();
		await tom.updateSandbox(sandbox.id, { autoUpgrade: true });
		// The opt-in, made with sandboxes:write, lets an exec-only key's command upgrade it.
		const answer = await runner.runCommand(sandbox.id, { command: "tar -xf a.tar" });
		expect(answer.rerunOf).toBeDefined();
		expect(upgrades).toHaveLength(1);
		expect((await tom.getSandbox(sandbox.id)).type).toBe("microvm");
	});

	it("doesn't let a reader of a detached command record its end before its run again is", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let upgraded = false;
		const results = new Map<string, ExecResult>();
		const { tom, stub } = setup({
			results,
			exec: (_id, request) =>
				request.command.startsWith("tar ")
					? upgraded
						? { exitCode: 0, stdout: "listed\n", stderr: "", timedOut: false }
						: { ...NEEDS_TAR, timedOut: false }
					: undefined,
			upgrade: async (sandboxId, spec, operationId) => {
				await held;
				const placed = await (stub.upgrade?.(sandboxId, spec, operationId) as Promise<UpgradedPlacement>);
				upgraded = true;
				return placed;
			},
		});
		const sandbox = await tom.createSandbox({ autoUpgrade: true, wait: true });
		const started = await tom.runCommand(sandbox.id, { command: "tar -tf x.tar", detached: true });
		for (let tries = 0; tries < 100 && !results.has(started.id); tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		// Its end is in, needing a microVM, and its backend says so: a reader asking meanwhile sees it running still.
		expect(results.get(started.id)?.needsMicrovm?.command).toBe("tar");
		for (let look = 0; look < 3; look++) {
			expect((await tom.getCommand(sandbox.id, started.id)).state).toBe("running");
		}
		release();
		let ended = await tom.getCommand(sandbox.id, started.id);
		for (let tries = 0; ended.state === "running" && tries < 200; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			ended = await tom.getCommand(sandbox.id, started.id);
		}
		expect(ended).toMatchObject({ exitCode: 127, needsMicrovm: { command: "tar" } });
		expect(ended.rerunAs).toBeDefined();
	});
});
