/**
 * Checks what a host says about itself before the registry keeps it. With account hosts, a host can be anyone's
 * machine, and one malformed report (`tiers: {}`) kept as it came would break every account's placement and host
 * listing, which read every host's facts. So registration and hello refuse a report that isn't shaped as kantel-host
 * sends it, and reading a stored one that isn't (kept before this check) treats it as no report at all.
 */
import type {
	HostCapacity,
	HostFacts,
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

function facts(value: unknown): HostFacts {
	if (!isObject(value)) throw new FactsError("facts is an object");
	const tiers = list(value.tiers, "tiers").map((tier, at) => text(tier, `tiers[${at}]`));
	const features = list(value.features, "features").map((feature, at) => text(feature, `features[${at}]`));
	const kept = labels(value.labels);
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
		...(Object.keys(kept).length === 0 ? {} : { labels: kept }),
		egress: text(value.egress, "egress"),
		...(features.length === 0 ? {} : { features }),
	};
}

function capacity(value: unknown): HostCapacity {
	if (!isObject(value)) throw new FactsError("capacity is an object");
	// A host from before warm pools were removed also sends `warm`, its ready pool counts: ignored.
	return {
		freeMemoryMiB: count(value.freeMemoryMiB, "freeMemoryMiB"),
		freeDiskGiB: count(value.freeDiskGiB, "freeDiskGiB"),
		running: count(value.running, "running"),
		stopped: count(value.stopped, "stopped"),
		load1: count(value.load1, "load1"),
	};
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

/** One sandbox's reading, or undefined for one of a kind this control plane doesn't know (left out, not refused). */
function sandboxUsage(value: unknown, at: number): HostSandboxUsage | undefined {
	if (!isObject(value)) throw new FactsError(`usage.sandboxes[${at}] is an object`);
	const kind = text(value.kind, `usage.sandboxes[${at}].kind`);
	if (!TIERS.has(kind)) return undefined;
	return {
		id: text(value.id, `usage.sandboxes[${at}].id`),
		kind: kind as SandboxTier,
		cpu: utilisation(value.cpu, `usage.sandboxes[${at}].cpu`),
		memUsedBytes: count(value.memUsedBytes, `usage.sandboxes[${at}].memUsedBytes`),
		memLimitBytes: count(value.memLimitBytes, `usage.sandboxes[${at}].memLimitBytes`),
	};
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
