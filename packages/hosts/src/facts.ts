/**
 * Checks what a host says about itself before the registry keeps it. With account hosts, a host can be anyone's
 * machine, and one malformed report (`tiers: {}`) kept as it came would break every account's placement and host
 * listing, which read every host's facts. So registration and hello refuse a report that isn't shaped as kantel-host
 * sends it, and reading a stored one that isn't (kept before this check) treats it as no report at all.
 */
import { MAX_MOUNTS } from "@kantel/contracts";
import type {
	HostCapacity,
	HostDiskLimits,
	HostDiskUsage,
	HostFacts,
	HostImages,
	HostMemoryAdmission,
	HostMemoryMode,
	HostMemoryReport,
	HostMemorySource,
	HostMemoryState,
	HostMountStatus,
	HostSandboxUsage,
	HostSize,
	HostUsageReport,
	HostUsageTotals,
	SandboxTier,
} from "./protocol.ts";

const TIERS: ReadonlySet<string> = new Set<SandboxTier>(["microvm", "isolate"]);
const MAX_TEXT = 256;
const MAX_ITEMS = 64;

class FactsError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length > MAX_TEXT) {
		throw new FactsError(`${field} is a string of at most ${MAX_TEXT} characters`);
	}
	return value;
}

function count(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new FactsError(`${field} is a number, 0 or more`);
	}
	return value;
}

/** Go marshals an empty slice or map as null. */
function list(value: unknown, field: string): readonly unknown[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_ITEMS) {
		throw new FactsError(`${field} is a list of at most ${MAX_ITEMS}`);
	}
	return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (value === null || value === undefined) return {};
	if (!isObject(value) || Object.keys(value).length > MAX_ITEMS) {
		throw new FactsError(`${field} is an object of at most ${MAX_ITEMS} entries`);
	}
	return value;
}

function size(value: unknown, at: number): HostSize {
	if (!isObject(value)) throw new FactsError(`sizes[${at}] is an object`);
	return {
		name: text(value.name, `sizes[${at}].name`),
		vcpus: count(value.vcpus, `sizes[${at}].vcpus`),
		memoryMiB: count(value.memoryMiB, `sizes[${at}].memoryMiB`),
		diskGiB: count(value.diskGiB, `sizes[${at}].diskGiB`),
	};
}

function labels(value: unknown): { [key: string]: string } {
	const out: { [key: string]: string } = {};
	for (const [key, label] of Object.entries(record(value, "labels")))
		out[text(key, "a label's key")] = text(label, `labels.${key}`);
	return out;
}

/**
 * A host's images (image patching), or undefined when it reports none or none shaped as kantel-host sends them: they are
 * shown, never placed by, so a malformed report is dropped rather than refused.
 */
function images(value: unknown): HostImages | undefined {
	if (!isObject(value)) return undefined;
	try {
		return {
			version: text(value.version ?? "", "images.version"),
			firecracker: text(value.firecracker ?? "", "images.firecracker"),
			autoUpdate: value.autoUpdate === true,
			signatures: text(value.signatures ?? "", "images.signatures"),
		};
	} catch (error) {
		if (error instanceof FactsError) return undefined;
		throw error;
	}
}

/**
 * The disk a host gives a custom shape (`HostDiskLimits`), or undefined where it says none or none shaped as kantel-host
 * sends it (whole GiB, at least 1, the least no more than the most): a host from before it said is taken to give what
 * the compute plane's `diskLimitsOf` says, so a malformed report is dropped rather than refused.
 */
function disk(value: unknown): HostDiskLimits | undefined {
	if (!isObject(value)) return undefined;
	const { minGiB, maxGiB } = value;
	if (!Number.isSafeInteger(minGiB) || !Number.isSafeInteger(maxGiB)) return undefined;
	const min = minGiB as number;
	const max = maxGiB as number;
	return min >= 1 && min <= max ? { minGiB: min, maxGiB: max } : undefined;
}

/** A string a host may leave out (Go's `omitempty`): absent when it does, or when it is empty. */
function optionalText<K extends string>(value: Record<string, unknown>, field: K): { [key in K]?: string } {
	const found = value[field];
	if (found === undefined || found === null || found === "") return {};
	return { [field]: text(found, field) } as { [key in K]?: string };
}

function facts(value: unknown): HostFacts {
	if (!isObject(value)) throw new FactsError("facts is an object");
	const tiers = list(value.tiers, "tiers").map((tier, at) => text(tier, `tiers[${at}]`));
	const features = list(value.features, "features").map((feature, at) => text(feature, `features[${at}]`));
	const kept = labels(value.labels);
	const hostImages = images(value.images);
	const hostDisk = disk(value.disk);
	return {
		version: text(value.version, "version"),
		protocol: count(value.protocol, "protocol"),
		os: text(value.os, "os"),
		arch: text(value.arch, "arch"),
		kernel: text(value.kernel, "kernel"),
		hostname: text(value.hostname, "hostname"),
		cpus: count(value.cpus, "cpus"),
		memoryMiB: count(value.memoryMiB, "memoryMiB"),
		diskGiB: count(value.diskGiB, "diskGiB"),
		kvm: value.kvm === true,
		nested: value.nested === true,
		// A tier a newer host offers that this control plane doesn't know is left out, not refused.
		tiers: tiers.filter((tier): tier is SandboxTier => TIERS.has(tier)),
		sizes: list(value.sizes, "sizes").map(size),
		...(hostDisk === undefined ? {} : { disk: hostDisk }),
		...(Object.keys(kept).length === 0 ? {} : { labels: kept }),
		egress: text(value.egress, "egress"),
		...(features.length === 0 ? {} : { features }),
		...optionalText(value, "firecracker"),
		...optionalText(value, "guestKernel"),
		...(hostImages === undefined ? {} : { images: hostImages }),
	};
}

function capacity(value: unknown): HostCapacity {
	if (!isObject(value)) throw new FactsError("capacity is an object");
	// A host from before warm pools were removed also sends `warm`, its ready pool counts: ignored.
	const builds = list(value.builds, "builds").map((build, at) => text(build, `builds[${at}]`));
	return {
		freeMemoryMiB: count(value.freeMemoryMiB, "freeMemoryMiB"),
		freeDiskGiB: count(value.freeDiskGiB, "freeDiskGiB"),
		running: count(value.running, "running"),
		stopped: count(value.stopped, "stopped"),
		load1: count(value.load1, "load1"),
		...(builds.length === 0 ? {} : { builds }),
		...diskUsage(value.disk),
		...memoryReport(value.memory),
	};
}

const MEMORY_MODES: ReadonlySet<string> = new Set<HostMemoryMode>(["reserved", "used"]);
const MEMORY_STATES: ReadonlySet<string> = new Set<HostMemoryState>(["ok", "tight", "refusing", "critical"]);

/** A capacity's memory (`HostMemoryReport`): left out, not refused, when it isn't one, so the rest still stands. */
function memoryReport(value: unknown): { memory?: HostMemoryReport } {
	if (!isObject(value)) return {};
	if (typeof value.mode !== "string" || !MEMORY_MODES.has(value.mode)) return {};
	if (typeof value.state !== "string" || !MEMORY_STATES.has(value.state)) return {};
	const whole = [
		"totalMiB",
		"reserveMiB",
		"capacityMiB",
		"reservedMiB",
		"committedMiB",
		"guestUsedMiB",
		"residentMiB",
		"availableMiB",
		"swapUsedMiB",
	] as const;
	const figures: { [K in (typeof whole)[number]]?: number } = {};
	for (const field of whole) {
		const figure = value[field];
		if (typeof figure !== "number" || !Number.isSafeInteger(figure) || figure < 0) return {};
		figures[field] = figure;
	}
	const share = (figure: unknown): figure is number =>
		typeof figure === "number" && Number.isFinite(figure) && figure >= 0;
	if (!share(value.pressureSome) || !share(value.pressureFull) || !share(value.maxRatio)) return {};
	const measuredAt = value.measuredAt;
	const admission = memoryAdmission(value.admission);
	return {
		memory: {
			...(figures as { [K in (typeof whole)[number]]: number }),
			mode: value.mode as HostMemoryMode,
			state: value.state as HostMemoryState,
			pressureSome: Math.min(100, value.pressureSome),
			pressureFull: Math.min(100, value.pressureFull),
			maxRatio: value.maxRatio,
			...(typeof measuredAt === "number" && Number.isSafeInteger(measuredAt) && measuredAt > 0 ? { measuredAt } : {}),
			...(admission === undefined ? {} : { admission }),
		},
	};
}

/** A host's memory report as it is shown: all but what it admits against (`admission`), the scheduler's alone. */
export function withoutAdmission(memory: HostMemoryReport): Omit<HostMemoryReport, "admission"> {
	const { admission: _admission, ...rest } = memory;
	return rest;
}

/** A memory report's admission (`HostMemoryAdmission`), or undefined when it isn't one. */
function memoryAdmission(value: unknown): HostMemoryAdmission | undefined {
	if (!isObject(value)) return undefined;
	const whole = (figure: unknown): figure is number =>
		typeof figure === "number" && Number.isSafeInteger(figure) && figure >= 0;
	const { reservableMiB, committableMiB, startMiB, headroomMiB, headroomPercent } = value;
	if (!whole(reservableMiB) || !whole(committableMiB) || !whole(startMiB) || !whole(headroomMiB)) return undefined;
	if (typeof headroomPercent !== "number" || !Number.isFinite(headroomPercent) || headroomPercent < 0) return undefined;
	return { reservableMiB, committableMiB, startMiB, headroomMiB, headroomPercent };
}

/** A capacity's disk measure (`HostDiskUsage`): left out, not refused, when it isn't one, so the rest still stands. */
function diskUsage(value: unknown): { disk?: HostDiskUsage } {
	if (!isObject(value)) return {};
	const fields = [
		"totalBytes",
		"usedBytes",
		"snapshotsBytes",
		"sandboxesBytes",
		"imagesBytes",
		"templatesBytes",
		"bundlesBytes",
		"otherBytes",
		"measuredAt",
	] as const;
	const disk: { [K in (typeof fields)[number]]?: number } = {};
	for (const field of fields) {
		const figure = value[field];
		if (typeof figure !== "number" || !Number.isSafeInteger(figure) || figure < 0) return {};
		disk[field] = figure;
	}
	return { disk: { ...(disk as HostDiskUsage), ...snapshotSplit(value) } };
}

/** The most snapshots, or groups of shared files, a disk measure's split by snapshot may name. */
const MAX_SPLIT_ENTRIES = 10_000;

/**
 * A disk measure's snapshots by snapshot (`HostDiskUsage.snapshotOwnBytes`, `snapshotShared`): left out whole when any
 * of it isn't one, and the compute plane then splits by sizes alone.
 */
function snapshotSplit(value: Record<string, unknown>): Pick<HostDiskUsage, "snapshotOwnBytes" | "snapshotShared"> {
	const bytes = (figure: unknown): figure is number =>
		typeof figure === "number" && Number.isSafeInteger(figure) && figure >= 0;
	const own = value.snapshotOwnBytes;
	const shared = value.snapshotShared ?? [];
	if (!isObject(own) || !Array.isArray(shared)) return {};
	const entries = Object.entries(own);
	if (entries.length > MAX_SPLIT_ENTRIES || shared.length > MAX_SPLIT_ENTRIES) return {};
	if (!entries.every(([id, figure]) => id !== "" && bytes(figure))) return {};
	const groups: { snapshots: string[]; bytes: number }[] = [];
	for (const group of shared) {
		if (!isObject(group) || !bytes(group.bytes) || !Array.isArray(group.snapshots)) return {};
		if (!group.snapshots.every((id): id is string => typeof id === "string" && id !== "")) return {};
		groups.push({ snapshots: [...group.snapshots], bytes: group.bytes });
	}
	return { snapshotOwnBytes: Object.fromEntries(entries) as { [id: string]: number }, snapshotShared: groups };
}

/** The most sandboxes one usage tick may name: more than any host runs. */
export const MAX_USAGE_SANDBOXES = 4096;
/** A usage tick's interval, in milliseconds. */
const MIN_USAGE_INTERVAL_MS = 1_000;
const MAX_USAGE_INTERVAL_MS = 300_000;

/** CPU utilisation: 0 to 1, above 1 taken as 1. */
const utilisation = (value: unknown, field: string): number => Math.min(1, count(value, field));

function usageTotals(value: unknown): HostUsageTotals {
	if (!isObject(value)) throw new FactsError("usage.host is an object");
	return {
		cpu: utilisation(value.cpu, "usage.host.cpu"),
		memUsedBytes: count(value.memUsedBytes, "usage.host.memUsedBytes"),
		memTotalBytes: count(value.memTotalBytes, "usage.host.memTotalBytes"),
		diskUsedBytes: count(value.diskUsedBytes, "usage.host.diskUsedBytes"),
		diskTotalBytes: count(value.diskTotalBytes, "usage.host.diskTotalBytes"),
	};
}

const MEMORY_SOURCES: ReadonlySet<string> = new Set<HostMemorySource>(["guest", "rss"]);

/** One sandbox's reading, or undefined for one of a kind this control plane doesn't know (left out, not refused). */
function sandboxUsage(value: unknown, at: number): HostSandboxUsage | undefined {
	if (!isObject(value)) throw new FactsError(`usage.sandboxes[${at}] is an object`);
	const kind = text(value.kind, `usage.sandboxes[${at}].kind`);
	if (!TIERS.has(kind)) return undefined;
	// A source this control plane doesn't know (a newer host's) is left out, not refused: the figure still stands.
	const memSource =
		typeof value.memSource === "string" && MEMORY_SOURCES.has(value.memSource)
			? (value.memSource as HostMemorySource)
			: undefined;
	return {
		id: text(value.id, `usage.sandboxes[${at}].id`),
		kind: kind as SandboxTier,
		cpu: utilisation(value.cpu, `usage.sandboxes[${at}].cpu`),
		memUsedBytes: count(value.memUsedBytes, `usage.sandboxes[${at}].memUsedBytes`),
		memLimitBytes: count(value.memLimitBytes, `usage.sandboxes[${at}].memLimitBytes`),
		...(memSource === undefined ? {} : { memSource }),
		...guestFigures(value),
	};
}

const figure = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * A microVM's disk, IO and memory pressure and OOM kills, which a host sends from its guest's agent when it has them. Optional, and left out
 * rather than refused when they make no sense (a used beyond its size, a share outside 0 to 1): the tick's CPU and
 * memory still stand.
 */
function guestFigures(
	value: Record<string, unknown>,
): Pick<
	HostSandboxUsage,
	"diskUsedBytes" | "diskTotalBytes" | "ioPressure" | "oomKills" | "memPressureSome" | "memPressureFull"
> {
	const { diskUsedBytes: used, diskTotalBytes: total, ioPressure, oomKills, memPressureSome, memPressureFull } = value;
	return {
		...(figure(used) && figure(total) && total > 0 && used <= total
			? { diskUsedBytes: used, diskTotalBytes: total }
			: {}),
		...(figure(ioPressure) && ioPressure <= 1 ? { ioPressure } : {}),
		...(figure(oomKills) && Number.isSafeInteger(oomKills) ? { oomKills } : {}),
		...(figure(memPressureSome) && memPressureSome <= 1 ? { memPressureSome } : {}),
		...(figure(memPressureFull) && memPressureFull <= 1 ? { memPressureFull } : {}),
	};
}

/** The longest `run` a usage tick may name: kantel-host's are 16 hex digits. */
const MAX_USAGE_RUN = 64;

/**
 * A tick's `run` and `seq` (`usage-acks`), both or neither: a `seq` that isn't a whole number from 1, or a `run` that
 * isn't a short string, leaves the tick as an older host's, taken but never acknowledged.
 */
function usageSequence(value: Record<string, unknown>): { readonly seq: number; readonly run: string } | undefined {
	const { seq, run } = value;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return undefined;
	if (typeof run !== "string" || run === "" || run.length > MAX_USAGE_RUN) return undefined;
	return { seq, run };
}

function usage(value: unknown): HostUsageReport & { readonly sandboxes: readonly HostSandboxUsage[] } {
	if (!isObject(value)) throw new FactsError("usage is an object");
	const at = count(value.at, "usage.at");
	const intervalMs = count(value.intervalMs, "usage.intervalMs");
	if (intervalMs < MIN_USAGE_INTERVAL_MS || intervalMs > MAX_USAGE_INTERVAL_MS) {
		throw new FactsError(`usage.intervalMs is ${MIN_USAGE_INTERVAL_MS} to ${MAX_USAGE_INTERVAL_MS}`);
	}
	const sandboxes = value.sandboxes ?? [];
	if (!Array.isArray(sandboxes) || sandboxes.length > MAX_USAGE_SANDBOXES) {
		throw new FactsError(`usage.sandboxes is a list of at most ${MAX_USAGE_SANDBOXES}`);
	}
	return {
		...usageSequence(value),
		at,
		intervalMs,
		host: usageTotals(value.host),
		sandboxes: sandboxes
			.map((each, index) => sandboxUsage(each, index))
			.filter((each): each is HostSandboxUsage => each !== undefined),
	};
}

const checked =
	<T>(parse: (value: unknown) => T) =>
	(value: unknown): { ok: true; value: T } | { ok: false; reason: string } => {
		try {
			return { ok: true, value: parse(value) };
		} catch (error) {
			if (error instanceof FactsError) return { ok: false, reason: error.message };
			throw error;
		}
	};

/** A host's facts as kantel-host sends them, normalised; or why not. */
export const parseHostFacts = checked(facts);
/** A host's capacity, from its hello or a heartbeat; or why not. */
export const parseHostCapacity = checked(capacity);
/** A host's usage tick (`HostUsageReport`), normalised: CPU above 1 taken as 1, `null` sandboxes as none; or why not. */
export const parseHostUsage = checked(usage);

/** Stored facts, read: undefined when they aren't shaped as facts (kept before the check), so they count as none. */
export function storedFacts(value: unknown): HostFacts | undefined {
	if (value === undefined) return undefined;
	const parsed = parseHostFacts(value);
	return parsed.ok ? parsed.value : undefined;
}

/** Stored capacity, read: undefined when it isn't shaped as capacity. */
export function storedCapacity(value: unknown): HostCapacity | undefined {
	if (value === undefined) return undefined;
	const parsed = parseHostCapacity(value);
	return parsed.ok ? parsed.value : undefined;
}

const MOUNT_STATUSES: ReadonlySet<string> = new Set<HostMountStatus["status"]>(["pending", "ready", "failed"]);
/** As long as a mount's path may be. */
const MAX_MOUNT_PATH = 1024;
const MAX_MOUNT_ERROR = 512;

/** When a host set a sandbox's mounts (`HostSandbox.mountsAt`): a positive whole number of milliseconds, or undefined. */
export function parseMountsAt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Mounts' statuses as a host reports them (a `sandbox.mounts` event, or the sandbox a call answered): undefined unless
 * they are a list of at most `MAX_MOUNTS` (null, Go's empty list, is none). An entry that isn't
 * `{ path, status, error? }` is left out and long strings are clipped, so what any account's host says can't swell a
 * sandbox's record.
 */
export function parseMountStatuses(value: unknown): HostMountStatus[] | undefined {
	if (value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_MOUNTS) return undefined;
	const out: HostMountStatus[] = [];
	for (const entry of value as unknown[]) {
		if (!isObject(entry)) continue;
		const { path, status, error } = entry;
		if (typeof path !== "string" || path === "" || typeof status !== "string" || !MOUNT_STATUSES.has(status)) continue;
		out.push({
			path: path.slice(0, MAX_MOUNT_PATH),
			status: status as HostMountStatus["status"],
			...(typeof error === "string" && error !== "" ? { error: error.slice(0, MAX_MOUNT_ERROR) } : {}),
		});
	}
	return out;
}
