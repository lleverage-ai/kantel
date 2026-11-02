/**
 * The in-process provider (`kind: "fake"`): machines in memory, for tests, stories and a gateway without a provider
 * configured. Its machines go through the same states as a real one's, each move after `settleMs`, and its commands
 * run in `shell.ts`'s tiny shell. Nothing here touches the network or runs a process.
 */
import {
	type EnvironmentProvider,
	type EnvironmentSizeName,
	KantelError,
	type MachineExecRequest,
	type MachineExecResult,
	type MachineFileEntry,
	type MachineFiles,
	type MachineRef,
	type MachineSpec,
	type MachineState,
	type MachineStatus,
	type PortUrl,
	type ProviderCapabilities,
	type SnapshotRef,
} from "@kantel/contracts";
import { emptyTree, HOME, makeDirs, resolvePath, runShell, type ShellFiles } from "./shell.ts";

interface FakeMachine {
	readonly id: string;
	readonly environmentId: string;
	status: MachineStatus;
	size: EnvironmentSizeName;
	tree: ShellFiles;
	runningSince?: number;
	runningMs: number;
	readonly commands: string[];
}

export interface FakeProviderOptions {
	/** Milliseconds a start or stop takes. Default 0: the next `status` sees it done. */
	readonly settleMs?: number;
	readonly now?: () => number;
	/** Fail the next start with this message (once). */
	failNextStart?: string;
}

export interface FakeProvider extends EnvironmentProvider {
	/** The machines it holds, for tests. */
	readonly machines: ReadonlyMap<string, { status: MachineStatus; commands: readonly string[] }>;
	/** Makes the next start fail with `message`. */
	failNextStart(message: string): void;
	/** Stops a machine behind the broker's back, as a provider's own auto-stop would. */
	stopBehindTheBack(machineId: string): void;
}

const CAPABILITIES: ProviderCapabilities = {
	sizes: ["small", "default", "large", "xlarge"],
	stopModes: ["stop"],
	snapshot: true,
	fork: true,
	expose: true,
	docker: true,
	kvm: false,
	gpu: false,
	egress: "unmanaged",
	pushesState: false,
	maxExecMs: 600_000,
};

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
	const now = options.now ?? (() => Date.now());
	const settleMs = options.settleMs ?? 0;
	const machines = new Map<string, FakeMachine>();
	const byEnvironment = new Map<string, string>();
	const snapshots = new Map<string, ShellFiles>();
	let failStart = options.failNextStart;
	let counter = 0;

	const find = (ref: MachineRef): FakeMachine => {
		const machine = machines.get(ref.machineId);
		if (machine === undefined || machine.status === "gone") {
			throw new KantelError("not_found", `No machine ${ref.machineId}`);
		}
		return machine;
	};
	const settle = (machine: FakeMachine, to: MachineStatus) => {
		const apply = () => {
			if (machine.status === "gone") return;
			if (to === "running") machine.runningSince = now();
			if (to === "stopped" && machine.runningSince !== undefined) {
				machine.runningMs += now() - machine.runningSince;
				machine.runningSince = undefined;
			}
			machine.status = to;
		};
		if (settleMs <= 0) apply();
		else setTimeout(apply, settleMs);
	};
	const state = (machine: FakeMachine): MachineState => ({ status: machine.status, size: machine.size });
	const make = (spec: MachineSpec, tree: ShellFiles): MachineRef => {
		counter += 1;
		const id = `fake_${counter.toString(36).padStart(6, "0")}`;
		const machine: FakeMachine = {
			id,
			environmentId: spec.environmentId,
			status: "creating",
			size: spec.size,
			tree,
			runningMs: 0,
			commands: [],
		};
		machines.set(id, machine);
		byEnvironment.set(`${spec.environmentId}:${spec.definition.version}`, id);
		// A new machine comes up once, then the broker stops it or uses it.
		settle(machine, "running");
		return { provider: "fake", machineId: id };
	};
	const cloneTree = (tree: ShellFiles): ShellFiles => ({ files: new Map(tree.files), dirs: new Set(tree.dirs) });

	const provider: FakeProvider = {
		kind: "fake",
		machines,
		failNextStart(message) {
			failStart = message;
		},
		stopBehindTheBack(machineId) {
			const machine = machines.get(machineId);
			if (machine !== undefined && machine.status === "running") settle(machine, "stopped");
		},
		capabilities: () => CAPABILITIES,
		async create(spec) {
			const existing = byEnvironment.get(`${spec.environmentId}:${spec.definition.version}`);
			if (existing !== undefined && machines.get(existing)?.status !== "gone") {
				return { provider: "fake", machineId: existing };
			}
			if (!CAPABILITIES.sizes.includes(spec.size)) throw new KantelError("invalid", `No size ${spec.size}`);
			return make(spec, emptyTree());
		},
		async start(ref, startOptions) {
			const machine = find(ref);
			if (failStart !== undefined) {
				const message = failStart;
				failStart = undefined;
				throw new KantelError("unavailable", message);
			}
			if (machine.status === "running" || machine.status === "starting" || machine.status === "creating") {
				return state(machine);
			}
			if (startOptions?.size !== undefined) machine.size = startOptions.size;
			machine.status = "starting";
			settle(machine, "running");
			return state(machine);
		},
		async stop(ref) {
			const machine = find(ref);
			if (machine.status === "stopped" || machine.status === "stopping") return state(machine);
			machine.status = "stopping";
			settle(machine, "stopped");
			return state(machine);
		},
		async status(ref) {
			const machine = machines.get(ref.machineId);
			if (machine === undefined) return { status: "gone" };
			return state(machine);
		},
		async destroy(ref) {
			const machine = machines.get(ref.machineId);
			if (machine === undefined) return;
			machine.status = "gone";
		},
		async exec(ref, request: MachineExecRequest): Promise<MachineExecResult> {
			const machine = find(ref);
			if (machine.status !== "running") {
				throw new KantelError("conflict", `Machine ${ref.machineId} is ${machine.status}, not running`);
			}
			const started = now();
			machine.commands.push(request.command);
			const cwd = request.cwd === undefined ? HOME : resolvePath(HOME, request.cwd);
			if (!machine.tree.dirs.has(cwd)) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: `cd: ${cwd}: No such file or directory\n`,
					timedOut: false,
					durationMs: 0,
				};
			}
			if (request.detached) {
				return { exitCode: null, stdout: "", stderr: "", timedOut: false, durationMs: 0, processId: `p${counter}` };
			}
			const result = runShell(request.command, machine.tree, { cwd, env: { HOME, ...request.env } });
			if (result.stdout !== "") request.onOutput?.("stdout", result.stdout);
			if (result.stderr !== "") request.onOutput?.("stderr", result.stderr);
			return { ...result, timedOut: false, durationMs: now() - started };
		},
		files(ref): MachineFiles {
			const tree = () => find(ref).tree;
			return {
				async read(path) {
					const file = tree().files.get(resolvePath(HOME, path));
					if (file === undefined) throw new KantelError("not_found", `No file ${path}`);
					return file;
				},
				async write(path, bytes) {
					const at = resolvePath(HOME, path);
					makeDirs(tree(), at.slice(0, at.lastIndexOf("/")) || "/");
					tree().files.set(at, bytes);
				},
				async list(path) {
					const at = resolvePath(HOME, path);
					const entries: MachineFileEntry[] = [];
					const prefix = at === "/" ? "/" : `${at}/`;
					const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
					for (const dir of tree().dirs)
						if (direct(dir) && dir !== at)
							entries.push({ name: dir.slice(prefix.length), path: dir, directory: true, size: 0 });
					for (const [file, bytes] of tree().files)
						if (direct(file))
							entries.push({ name: file.slice(prefix.length), path: file, directory: false, size: bytes.length });
					return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
				},
				async remove(path) {
					const at = resolvePath(HOME, path);
					tree().files.delete(at);
					for (const file of [...tree().files.keys()]) if (file.startsWith(`${at}/`)) tree().files.delete(file);
					for (const dir of [...tree().dirs]) if (dir === at || dir.startsWith(`${at}/`)) tree().dirs.delete(dir);
				},
			};
		},
		async expose(ref, port, exposeOptions): Promise<PortUrl> {
			find(ref);
			const isPublic = exposeOptions?.public ?? false;
			return {
				port,
				public: isPublic,
				url: `https://${ref.machineId}-${port}.fake.invalid/${isPublic ? "" : "?_t=x"}`,
			};
		},
		async snapshot(ref, name): Promise<SnapshotRef> {
			snapshots.set(name, cloneTree(find(ref).tree));
			return { provider: "fake", snapshotId: name };
		},
		async fork(from, spec) {
			const tree = "snapshotId" in from ? snapshots.get(from.snapshotId) : machines.get(from.machineId)?.tree;
			if (tree === undefined) throw new KantelError("not_found", "Nothing to fork from");
			return make(spec, cloneTree(tree));
		},
		async usage(ref) {
			const machine = find(ref);
			const live = machine.runningSince === undefined ? 0 : now() - machine.runningSince;
			return { runningMs: machine.runningMs + live };
		},
	};
	return provider;
}
