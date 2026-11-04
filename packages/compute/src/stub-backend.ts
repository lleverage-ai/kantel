/**
 * A `SandboxBackend` in memory, for tests and local runs before hosts exist. One stub host (`host_stub`, named `stub`)
 * runs every sandbox; each sandbox is a just-bash shell over its own in-memory filesystem with `/home/user` (the
 * working directory) and `/tmp`, so commands really run. A snapshot is a deep copy of the file tree (path to bytes),
 * restored on start, resume, fork and create-from. A template snapshot is a file tree too, kept apart from snapshots:
 * a build runs the template's setup in a fresh shell and keeps what it leaves, and a fresh boot from a template runs the
 * setup in the new sandbox. microVM-only features answer stub URLs under
 * `https://stub.kantel.invalid/` for a microVM, and `not_supported` for an isolate. Nothing here is a security
 * boundary: it is a stand-in for lane 2's host scheduler.
 */
import type { computeSchema } from "@kantel/api";
import { KantelError } from "@kantel/contracts";
import { Bash, InMemoryFs } from "just-bash";
import {
	type BackendCapabilities,
	type BackendFileEntry,
	type BackendHost,
	type BackendShape,
	type BackendSize,
	type BootOptions,
	type BuiltTemplate,
	CUSTOM_SHAPES_FEATURE,
	type ExecRequest,
	type ExecResult,
	type Placement,
	type SandboxBackend,
	type SandboxSpec,
	type SshGrant,
	type TakenSnapshot,
	type TemplateBuildSpec,
	type TemplateRuntime,
	type UsageSample,
} from "./backend.ts";
import { type BackendUsageReport, RAW_WINDOW_MS, USAGE_INTERVAL_MS } from "./usage-series.ts";
import { baseName, HOME, randomId, randomSecret, sliceRange } from "./util.ts";

/** The stub's one host. */
export const STUB_HOST_ID = "host_stub";

/** The stub host's runtime, which its template snapshots are keyed by. */
export const STUB_RUNTIME = { kernel: "stub", firecracker: "stub" } as const;

/** The prefix of the stub's template snapshots' refs: `tpl-snap:<snapshotId>`. */
export const STUB_TEMPLATE_REF_PREFIX = "tpl-snap:";

/** Where the stub's microVM-only URLs point. */
export const STUB_ORIGIN = "https://stub.kantel.invalid";

export interface StubBackendOptions {
	/** The types it offers. Default both. */
	readonly types?: readonly computeSchema.SandboxType[];
	/** The domain public port URLs are under: `http://<port>-<subdomain>.<domain>`. Default `sandbox.localhost`. */
	readonly sandboxDomain?: string;
	/** For its usage readings' times. Default `Date.now`. */
	readonly now?: () => number;
}

/** The stub host's memory and disk, as its usage reports them. */
const STUB_HOST_MEMORY_BYTES = 256 * 1024 ** 3;
const STUB_HOST_DISK_BYTES = 2048 * 1024 ** 3;
/** What the stub host itself uses, besides its sandboxes. */
const STUB_HOST_BASE_BYTES = 2 * 1024 ** 3;
const MIB = 1024 * 1024;
/** An isolate's memory limit, as the stub reports it. */
const ISOLATE_MEMORY_BYTES = 128 * MIB;

/** FNV-1a: a stable 32-bit number from a string, so a sandbox's made-up readings are the same however often read. */
function hash(text: string): number {
	let value = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 0x01000193) >>> 0;
	}
	return value;
}

/** A number in [0, 1) from a seed and a tick, the same every time. */
function noise(seed: number, tick: number): number {
	let value = (seed ^ Math.imul(tick, 0x9e3779b1)) >>> 0;
	value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
	value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
	return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

/**
 * A plausible reading of a stub sandbox at `at`: a slow swell, a quicker ripple and some noise, its own per sandbox, and
 * the same whenever it is asked for, so a series made up in two reads lines up.
 */
export function stubReading(sandboxId: string, at: number, baseBytes: number): { cpu: number; memUsedBytes: number } {
	const seed = hash(sandboxId);
	const tick = Math.floor(at / 5_000);
	const phase = (seed % 1000) / 1000;
	const slow = Math.sin(2 * Math.PI * (at / (240_000 + (seed % 120) * 1_000) + phase));
	const quick = Math.sin(2 * Math.PI * (at / 35_000 + phase * 3));
	const burst = noise(seed, Math.floor(tick / 6)) > 0.85 ? 0.35 : 0;
	const cpu = 0.12 + 0.08 * slow + 0.04 * quick + 0.06 * noise(seed, tick) + burst;
	const memory = baseBytes + (24 + 16 * slow + 4 * noise(seed ^ 0x5bd1e995, tick)) * MIB;
	return { cpu: Math.min(1, Math.max(0, cpu)), memUsedBytes: Math.round(memory) };
}

const SIZES: readonly BackendSize[] = [
	{ name: "small", vcpus: 1, memoryMb: 1024, diskGb: 10 },
	{ name: "default", vcpus: 2, memoryMb: 4096, diskGb: 20 },
	{ name: "large", vcpus: 4, memoryMb: 8192, diskGb: 40 },
	{ name: "xlarge", vcpus: 8, memoryMb: 16384, diskGb: 80 },
];

const ISOLATE_CAPABILITIES: computeSchema.SandboxCapabilities = {
	exec: true,
	files: true,
	ssh: false,
	desktop: false,
	browser: false,
	ports: true,
	docker: false,
	kvm: false,
	pause: false,
	browserSurface: false,
};

const MICROVM_CAPABILITIES: computeSchema.SandboxCapabilities = {
	exec: true,
	files: true,
	ssh: true,
	desktop: true,
	browser: true,
	ports: true,
	docker: true,
	kvm: true,
	pause: true,
	// The stub's browser view is its own page, apart from its desktop's.
	browserSurface: true,
};

/** just-bash's own directories, which a snapshot leaves out. */
const RESERVED = ["/bin", "/usr", "/dev", "/proc"];
const reserved = (path: string) => RESERVED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/** A deep copy of a disk. */
interface Tree {
	readonly dirs: Map<string, number>;
	readonly files: Map<string, { readonly bytes: Uint8Array; readonly mode: number; readonly mtime: number }>;
	readonly links: Map<string, string>;
}

interface Machine {
	readonly id: string;
	readonly type: computeSchema.SandboxType;
	size: computeSchema.SandboxSizeName | undefined;
	/** A microVM's vCPUs and memory as asked for, off the sizes or on them. */
	shape: BackendShape | undefined;
	env: { readonly [name: string]: string };
	/** The disk while it runs or is paused (its memory); absent while stopped. */
	fs: InMemoryFs | undefined;
	bash: Bash | undefined;
	state: "running" | "paused" | "stopped";
	/** When it last booted or resumed, for its usage readings. */
	runningSince: number;
	readonly ports: Map<number, string>;
}

interface LiveMachine extends Machine {
	fs: InMemoryFs;
	bash: Bash;
}

/** Turns a just-bash filesystem error into a KantelError. */
function fsError(error: unknown, path: string): never {
	if (error instanceof KantelError) throw error;
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("ENOENT")) throw new KantelError("not_found", `No such file or directory: ${path}`);
	if (message.includes("EISDIR")) throw new KantelError("invalid", `${path} is a directory`);
	if (message.includes("ENOTDIR")) throw new KantelError("invalid", `A part of ${path} is not a directory`);
	if (message.includes("EEXIST")) throw new KantelError("conflict", `${path} already exists`);
	throw new KantelError("invalid", message);
}

async function capture(fs: InMemoryFs): Promise<Tree> {
	const tree: Tree = { dirs: new Map(), files: new Map(), links: new Map() };
	for (const path of fs.getAllPaths()) {
		if (path === "/" || reserved(path)) continue;
		const stat = await fs.lstat(path).catch(() => undefined);
		if (stat === undefined) continue;
		if (stat.isSymbolicLink) tree.links.set(path, await fs.readlink(path));
		else if (stat.isDirectory) tree.dirs.set(path, stat.mode);
		else if (stat.isFile) {
			const bytes = new Uint8Array(await fs.readFileBuffer(path));
			tree.files.set(path, { bytes, mode: stat.mode, mtime: stat.mtime.getTime() });
		}
	}
	return tree;
}

async function restore(tree: Tree | undefined): Promise<InMemoryFs> {
	const fs = new InMemoryFs();
	await fs.mkdir(HOME, { recursive: true });
	await fs.mkdir("/tmp", { recursive: true });
	if (tree === undefined) return fs;
	for (const dir of [...tree.dirs.keys()].sort()) await fs.mkdir(dir, { recursive: true });
	for (const [path, file] of tree.files) {
		const parent = path.slice(0, path.lastIndexOf("/"));
		if (parent !== "") await fs.mkdir(parent, { recursive: true });
		await fs.writeFile(path, new Uint8Array(file.bytes));
		await fs.chmod(path, file.mode).catch(() => undefined);
		await fs.utimes(path, new Date(file.mtime), new Date(file.mtime)).catch(() => undefined);
	}
	for (const [path, target] of tree.links) await fs.symlink(target, path).catch(() => undefined);
	return fs;
}

/** A machine's memory before its made-up wobble: 64 MiB and its files (they live in memory). */
async function baseBytes(fs: InMemoryFs): Promise<number> {
	let bytes = 0;
	for (const path of fs.getAllPaths()) {
		if (reserved(path)) continue;
		const stat = await fs.lstat(path).catch(() => undefined);
		if (stat?.isFile === true) bytes += stat.size;
	}
	return 64 * MIB + bytes;
}

function treeSize(tree: Tree): number {
	let size = 0;
	for (const file of tree.files.values()) size += file.bytes.byteLength;
	return size;
}

/** The entries of one directory of a snapshot. */
function entriesOf(tree: Tree, dir: string): BackendFileEntry[] {
	const prefix = dir === "/" ? "/" : `${dir}/`;
	const children = new Map<string, BackendFileEntry>();
	const add = (path: string, entry: Omit<BackendFileEntry, "name" | "path">) => {
		if (!path.startsWith(prefix) || path === dir) return;
		const rest = path.slice(prefix.length);
		const slash = rest.indexOf("/");
		const name = slash < 0 ? rest : rest.slice(0, slash);
		const childPath = `${prefix}${name}`;
		if (slash >= 0) {
			if (!children.has(childPath)) children.set(childPath, { name, path: childPath, kind: "directory", size: 0 });
			return;
		}
		children.set(childPath, { name, path: childPath, ...entry });
	};
	for (const path of tree.dirs.keys()) add(path, { kind: "directory", size: 0 });
	for (const [path, file] of tree.files)
		add(path, { kind: "file", size: file.bytes.byteLength, modifiedAt: file.mtime });
	for (const path of tree.links.keys()) add(path, { kind: "symlink", size: 0 });
	return [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A `SandboxBackend` in memory over just-bash, with one stub host. */
export function createStubBackend(options: StubBackendOptions = {}): SandboxBackend {
	const types: readonly computeSchema.SandboxType[] = options.types ?? ["isolate", "microvm"];
	const domain = options.sandboxDomain ?? "sandbox.localhost";
	const now = options.now ?? Date.now;
	/** When the stub host came up: it reports nothing before. */
	const upSince = now();
	const machines = new Map<string, Machine>();
	/** Sandboxes a create is making now (booting, restoring, running a template's setup). */
	const creating = new Set<string>();
	const snapshots = new Map<string, Tree>();
	/** Template snapshots by ref: a cache apart from `snapshots`, which `deleteSnapshot` never touches. */
	const templateSnapshots = new Map<string, Tree>();

	const host: BackendHost = {
		id: STUB_HOST_ID,
		name: "stub",
		version: "0.0.0-stub",
		os: "just-bash",
		arch: "x86_64",
		tiers: types,
		kvm: types.includes("microvm"),
		nestedVirtualisation: false,
		capacity: { vcpus: 64, memoryMb: 262_144, diskGb: 2048 },
		// It enforces what its sandboxes get however they run, makes any shape, and keeps no warm machines.
		features: ["egress-policy", CUSTOM_SHAPES_FEATURE],
		sizes: SIZES,
		labels: { site: "local" },
	};

	const machineOf = (sandboxId: string): Machine => {
		const machine = machines.get(sandboxId);
		if (machine === undefined) throw new KantelError("not_found", `The stub has no machine for ${sandboxId}`);
		return machine;
	};
	const running = (sandboxId: string): LiveMachine => {
		const machine = machineOf(sandboxId);
		if (machine.state !== "running" || machine.fs === undefined || machine.bash === undefined) {
			throw new KantelError("conflict", `${sandboxId} is not running`);
		}
		return machine as LiveMachine;
	};
	const microvmOnly = (machine: Machine, what: string) => {
		if (machine.type !== "microvm")
			throw new KantelError("not_supported", `${what} needs a microVM; this is an isolate`);
	};
	const placeable = (eligibleHosts: readonly string[], type: computeSchema.SandboxType) => {
		if (!types.includes(type)) throw new KantelError("unavailable", `No host runs ${type} sandboxes`);
		if (eligibleHosts.includes(STUB_HOST_ID)) return;
		throw new KantelError(
			"unavailable",
			eligibleHosts.length === 0
				? `The stub's host (${STUB_HOST_ID}) isn't one this sandbox may use now: none of its eligible hosts is the stub's`
				: `The stub's host (${STUB_HOST_ID}) isn't one this sandbox may use now; it may use ${eligibleHosts.join(", ")}`,
		);
	};
	const placement = (machine: Machine): Placement => {
		const named = SIZES.find((entry) => entry.name === (machine.size ?? "default"));
		const shape = machine.shape;
		// A shape off the sizes gets the disk of the smallest size with at least its memory, as kantel-host's do.
		const shaped =
			shape === undefined
				? named
				: {
						vcpus: shape.vcpus,
						memoryMb: shape.memoryMb,
						diskGb: (SIZES.find((entry) => entry.memoryMb >= shape.memoryMb) ?? SIZES.at(-1))?.diskGb ?? 20,
					};
		const size = machine.type === "microvm" ? shaped : undefined;
		return {
			hostId: STUB_HOST_ID,
			...(size === undefined ? {} : { resources: { vcpus: size.vcpus, memoryMb: size.memoryMb, diskGb: size.diskGb } }),
			capabilities: machine.type === "microvm" ? MICROVM_CAPABILITIES : ISOLATE_CAPABILITIES,
		};
	};
	const boot = (machine: Machine, fs: InMemoryFs) => {
		machine.fs = fs;
		machine.bash = new Bash({ fs, cwd: HOME, env: { HOME, USER: "user", ...machine.env } });
		machine.state = "running";
		machine.runningSince = now();
	};
	const snapshotTree = (ref: string): Tree => {
		const tree = snapshots.get(ref);
		if (tree === undefined) throw new KantelError("not_found", `The stub has no snapshot ${ref}`);
		return tree;
	};
	const keep = (tree: Tree): TakenSnapshot => {
		const ref = randomId("ref");
		snapshots.set(ref, tree);
		return { ref, sizeBytes: treeSize(tree) };
	};
	const fromSnapshot = (ref: string | undefined) => restore(ref === undefined ? undefined : snapshotTree(ref));
	const viewUrl = (sandboxId: string, what: string) =>
		`${STUB_ORIGIN}/${what}/${sandboxId}?token=${randomSecret("", 24)}`;

	/** Runs a template's setup as root in a shell; rejects with its output's end when it fails. */
	const runSetup = async (bash: Bash, setup: string, env: { readonly [name: string]: string }) => {
		const result = await bash.exec(setup, { cwd: "/", env: { ...env, HOME: "/root", USER: "root" } });
		if (result.exitCode !== 0) {
			throw new KantelError(
				"invalid",
				`The template's setup exited with ${result.exitCode}: ${result.stderr.slice(-500).trim()}`,
			);
		}
	};

	const create = async (spec: SandboxSpec): Promise<Placement> => {
		placeable(spec.eligibleHosts, spec.type);
		if (machines.has(spec.sandboxId) || creating.has(spec.sandboxId)) {
			throw new KantelError("conflict", `${spec.sandboxId} already has a machine`);
		}
		if (spec.template !== undefined && spec.type !== "microvm") {
			throw new KantelError("not_supported", "A template makes microVMs; this is an isolate");
		}
		// Held from here until it is made or has failed, so a second create of it, while a setup runs, is a conflict and
		// never replaces the machine this one makes.
		creating.add(spec.sandboxId);
		try {
			return await made(spec);
		} finally {
			creating.delete(spec.sandboxId);
		}
	};

	/** Makes the machine `create` has checked and holds. */
	const made = async (spec: SandboxSpec): Promise<Placement> => {
		const machine: Machine = {
			id: spec.sandboxId,
			type: spec.type,
			size: spec.size,
			shape: spec.type === "microvm" ? spec.shape : undefined,
			env: { ...spec.env },
			fs: undefined,
			bash: undefined,
			state: "stopped",
			runningSince: now(),
			ports: new Map(),
		};
		const template = spec.template;
		// A template snapshot the stub no longer holds (lost with the process, as the records outlast it) boots fresh, and
		// says so (`bootedFresh`).
		const prepared = template?.snapshot === undefined ? undefined : templateSnapshots.get(template.snapshot);
		if (prepared !== undefined) boot(machine, await restore(prepared));
		else boot(machine, await fromSnapshot(spec.fromSnapshot));
		// A fresh boot from a template: its setup runs in the new machine, as a build would have run it.
		if (template !== undefined && prepared === undefined && template.setup !== undefined) {
			await runSetup((machine as LiveMachine).bash, template.setup, machine.env);
		}
		machines.set(spec.sandboxId, machine);
		const placed = placement(machine);
		return template?.snapshot !== undefined && prepared === undefined ? { ...placed, bootedFresh: true } : placed;
	};

	const reboot = async (sandboxId: string, options: BootOptions, keepMemory: boolean): Promise<Placement> => {
		const machine = machineOf(sandboxId);
		placeable(options.eligibleHosts, machine.type);
		if (machine.state === "running") return placement(machine);
		// The boot states its sizing: its shape where it has one, else its named size, even one the machine already had.
		if (machine.type === "microvm") machine.shape = options.shape;
		machine.size = options.size ?? machine.size;
		machine.env = { ...options.env };
		if (keepMemory && machine.state === "paused" && machine.fs !== undefined) boot(machine, machine.fs);
		else boot(machine, await fromSnapshot(options.fromSnapshot));
		return placement(machine);
	};

	return {
		async capabilities(): Promise<BackendCapabilities> {
			return { types, sizes: SIZES, defaultImage: "ubuntu-24.04", hosts: [host] };
		},

		create,

		start: (sandboxId, options) => reboot(sandboxId, options, false),

		async stop(sandboxId, { keepMemory }) {
			const machine = machineOf(sandboxId);
			if (keepMemory) microvmOnly(machine, "Pausing with memory");
			if (machine.fs === undefined) throw new KantelError("conflict", `${sandboxId} has no machine to stop`);
			const taken = keep(await capture(machine.fs));
			machine.bash = undefined;
			machine.ports.clear();
			if (keepMemory) machine.state = "paused";
			else {
				machine.fs = undefined;
				machine.state = "stopped";
			}
			return taken;
		},

		resume: (sandboxId, options) => reboot(sandboxId, options, true),

		async fork(source, targets) {
			const tree =
				source.snapshot !== undefined ? snapshotTree(source.snapshot) : await capture(running(source.sandboxId).fs);
			const placements: Placement[] = [];
			for (const target of targets) {
				const { ref } = keep(tree);
				try {
					placements.push(await create({ ...target, fromSnapshot: ref }));
				} finally {
					snapshots.delete(ref);
				}
			}
			return placements;
		},

		async recover(sandboxId, options) {
			const machine = machineOf(sandboxId);
			placeable(options.eligibleHosts, machine.type);
			machine.env = { ...options.env };
			machine.ports.clear();
			boot(machine, machine.fs ?? (await fromSnapshot(options.fromSnapshot)));
			return placement(machine);
		},

		async destroy(sandboxId) {
			machines.delete(sandboxId);
		},

		async exec(sandboxId, request: ExecRequest): Promise<ExecResult> {
			const machine = running(sandboxId);
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let onAbort: (() => void) | undefined;
			const races: Promise<ExecResult>[] = [
				machine.bash
					.exec(request.command, {
						cwd: request.cwd ?? HOME,
						signal: controller.signal,
						...(request.env === undefined ? {} : { env: { ...request.env } }),
						...(request.stdin === undefined ? {} : { stdin: request.stdin }),
					})
					.then(
						(result): ExecResult => ({
							exitCode: result.exitCode,
							stdout: result.stdout,
							stderr: result.stderr,
							timedOut: false,
						}),
						(error: unknown): ExecResult => ({
							exitCode: 1,
							stdout: "",
							stderr: `${error instanceof Error ? error.message : String(error)}\n`,
							timedOut: false,
						}),
					),
			];
			const timeoutMs = request.timeoutMs;
			if (timeoutMs !== undefined) {
				races.push(
					new Promise<ExecResult>((resolve) => {
						timer = setTimeout(() => {
							controller.abort();
							resolve({ exitCode: 124, stdout: "", stderr: `timed out after ${timeoutMs} ms\n`, timedOut: true });
						}, timeoutMs);
					}),
				);
			}
			const signal = request.signal;
			if (signal !== undefined) {
				races.push(
					new Promise<ExecResult>((resolve) => {
						onAbort = () => {
							controller.abort();
							resolve({ exitCode: 137, stdout: "", stderr: "killed\n", timedOut: false });
						};
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
					}),
				);
			}
			try {
				return await Promise.race(races);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
			}
		},

		async readFile(sandboxId, path, range) {
			const { fs } = running(sandboxId);
			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(await fs.readFileBuffer(path));
			} catch (error) {
				return fsError(error, path);
			}
			const size = bytes.byteLength;
			return range === undefined ? { bytes, size } : { bytes: sliceRange(bytes, range), size };
		},

		async writeFile(sandboxId, path, content, mode): Promise<BackendFileEntry> {
			const { fs } = running(sandboxId);
			try {
				const parent = path.slice(0, path.lastIndexOf("/"));
				if (parent !== "") await fs.mkdir(parent, { recursive: true });
				await fs.writeFile(path, content);
				if (mode !== undefined) await fs.chmod(path, mode);
				const stat = await fs.stat(path);
				return { name: baseName(path), path, kind: "file", size: stat.size, modifiedAt: stat.mtime.getTime() };
			} catch (error) {
				return fsError(error, path);
			}
		},

		async deleteFile(sandboxId, path) {
			const { fs } = running(sandboxId);
			if (path === "/") throw new KantelError("invalid", "The root can't be deleted");
			try {
				await fs.lstat(path);
				await fs.rm(path, { recursive: true, force: true });
			} catch (error) {
				fsError(error, path);
			}
		},

		async listFiles(sandboxId, path) {
			const { fs } = running(sandboxId);
			try {
				const stat = await fs.stat(path);
				if (!stat.isDirectory) throw new KantelError("invalid", `${path} is not a directory`);
				const entries: BackendFileEntry[] = [];
				for (const name of (await fs.readdir(path)).sort()) {
					const child = path === "/" ? `/${name}` : `${path}/${name}`;
					if (reserved(child)) continue;
					const info = await fs.lstat(child);
					entries.push({
						name,
						path: child,
						kind: info.isSymbolicLink ? "symlink" : info.isDirectory ? "directory" : "file",
						size: info.isFile ? info.size : 0,
						modifiedAt: info.mtime.getTime(),
					});
				}
				return entries;
			} catch (error) {
				return fsError(error, path);
			}
		},

		async takeSnapshot(sandboxId) {
			return keep(await capture(running(sandboxId).fs));
		},

		async listSnapshotFiles(ref, path) {
			const tree = snapshotTree(ref);
			const entries = entriesOf(tree, path);
			if (path !== "/" && !tree.dirs.has(path) && entries.length === 0) {
				if (tree.files.has(path)) throw new KantelError("invalid", `${path} is not a directory`);
				throw new KantelError("not_found", `No such directory in the snapshot: ${path}`);
			}
			return entries;
		},

		async readSnapshotFile(ref, path) {
			const file = snapshotTree(ref).files.get(path);
			if (file === undefined) throw new KantelError("not_found", `No such file in the snapshot: ${path}`);
			return new Uint8Array(file.bytes);
		},

		async deleteSnapshot(ref) {
			snapshots.delete(ref);
		},

		async templateRuntimes(): Promise<TemplateRuntime[]> {
			return types.includes("microvm") ? [{ hostId: STUB_HOST_ID, ...STUB_RUNTIME }] : [];
		},

		async buildTemplate(spec: TemplateBuildSpec): Promise<BuiltTemplate> {
			if (!types.includes("microvm")) throw new KantelError("unavailable", "No host runs microvm sandboxes");
			if (spec.hostId !== STUB_HOST_ID) throw new KantelError("unavailable", `The stub has no host ${spec.hostId}`);
			const fs = await restore(undefined);
			if (spec.setup !== undefined) {
				await runSetup(new Bash({ fs, cwd: "/", env: { ...spec.env } }), spec.setup, spec.env);
			}
			const tree = await capture(fs);
			const ref = `${STUB_TEMPLATE_REF_PREFIX}${spec.snapshotId}`;
			templateSnapshots.set(ref, tree);
			// It boots no image: the base's digest stands for the one a host pulls (none for its own sandbox image).
			return {
				ref,
				hostId: STUB_HOST_ID,
				...(spec.baseDigest === "" ? {} : { imageDigest: spec.baseDigest }),
				sizeBytes: treeSize(tree),
			};
		},

		async deleteTemplateSnapshot(bytes) {
			templateSnapshots.delete(bytes.ref ?? `${STUB_TEMPLATE_REF_PREFIX}${bytes.snapshotId}`);
		},

		async exposePort(sandboxId, port, { subdomain }) {
			const machine = running(sandboxId);
			const url = `http://${port}-${subdomain}.${domain}`;
			machine.ports.set(port, url);
			return { url };
		},

		async hidePort(sandboxId, port) {
			machines.get(sandboxId)?.ports.delete(port);
		},

		async openSsh(sandboxId, { publicKey }): Promise<SshGrant> {
			const machine = running(sandboxId);
			microvmOnly(machine, "SSH");
			const privateKey =
				publicKey === undefined
					? `-----BEGIN OPENSSH PRIVATE KEY-----\n${randomSecret("stub", 64)}\n-----END OPENSSH PRIVATE KEY-----\n`
					: undefined;
			return {
				host: "ssh.stub.kantel.invalid",
				port: 2222,
				user: sandboxId,
				...(privateKey === undefined ? {} : { privateKey }),
				hostKeyFingerprint: "SHA256:stub",
			};
		},

		async openDesktop(sandboxId) {
			const machine = running(sandboxId);
			microvmOnly(machine, "The desktop");
			const url = viewUrl(sandboxId, "desktop");
			return { url, embedUrl: `${url}&embed=1` };
		},

		async openBrowser(sandboxId) {
			const machine = running(sandboxId);
			microvmOnly(machine, "The browser");
			return {
				url: viewUrl(sandboxId, "browser"),
				cdpUrl: `wss://stub.kantel.invalid/cdp/${sandboxId}`,
				surface: "browser",
			};
		},

		async usage(sandboxId): Promise<UsageSample> {
			const machine = machineOf(sandboxId);
			if (machine.state !== "running" || machine.fs === undefined) return { cpu: 0, memoryBytes: 0 };
			const reading = stubReading(sandboxId, now(), await baseBytes(machine.fs));
			return { cpu: reading.cpu, memoryBytes: reading.memUsedBytes };
		},

		// The stub host's ticks, made up: every running machine's, 5 seconds apart, from when it booted.
		async usageReports(since, until): Promise<BackendUsageReport[]> {
			const live = [...machines.values()].filter((machine) => machine.state === "running" && machine.fs !== undefined);
			const bases = new Map<string, number>();
			for (const machine of live) bases.set(machine.id, await baseBytes(machine.fs as InMemoryFs));
			const first = Math.max(since, until - RAW_WINDOW_MS, upSince - USAGE_INTERVAL_MS);
			const reports: BackendUsageReport[] = [];
			for (
				let at = (Math.floor(first / USAGE_INTERVAL_MS) + 1) * USAGE_INTERVAL_MS;
				at <= until;
				at += USAGE_INTERVAL_MS
			) {
				const sandboxes = live
					.filter((machine) => machine.runningSince <= at)
					.map((machine) => {
						const reading = stubReading(machine.id, at, bases.get(machine.id) ?? 0);
						// Its limit is the shape it runs as, as its placement says: a custom shape's, else its named size's.
						const memoryMb = placement(machine).resources?.memoryMb;
						return {
							id: machine.id,
							kind: machine.type,
							cpu: reading.cpu,
							memUsedBytes: reading.memUsedBytes,
							memLimitBytes:
								machine.type === "microvm" && memoryMb !== undefined ? memoryMb * MIB : ISOLATE_MEMORY_BYTES,
						};
					});
				const ambient = stubReading(STUB_HOST_ID, at, STUB_HOST_BASE_BYTES);
				reports.push({
					hostId: STUB_HOST_ID,
					at,
					intervalMs: USAGE_INTERVAL_MS,
					host: {
						cpu: Math.min(
							1,
							ambient.cpu / 4 + sandboxes.reduce((sum, each) => sum + each.cpu, 0) / host.capacity.vcpus,
						),
						memUsedBytes: ambient.memUsedBytes + sandboxes.reduce((sum, each) => sum + each.memUsedBytes, 0),
						memTotalBytes: STUB_HOST_MEMORY_BYTES,
						diskUsedBytes: 40 * 1024 ** 3 + snapshots.size * 64 * MIB,
						diskTotalBytes: STUB_HOST_DISK_BYTES,
					},
					sandboxes,
				});
			}
			return reports;
		},
	};
}
