/**
 * Checks what a host says about itself before the registry keeps it. With account hosts, a host can be anyone's
 * machine, and one malformed report (`tiers: {}`) kept as it came would break every account's placement and host
 * listing, which read every host's facts. So registration and hello refuse a report that isn't shaped as kantel-host
 * sends it, and reading a stored one that isn't (kept before this check) treats it as no report at all.
 */
import { MAX_MOUNTS } from "@kantel/contracts";
import type { HostCapacity, HostFacts, HostMountStatus, HostSize, SandboxTier } from "./protocol.ts";

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
	const warm: { [pool: string]: number } = {};
	for (const [pool, n] of Object.entries(record(value.warm, "warm")))
		warm[text(pool, "a pool")] = count(n, `warm.${pool}`);
	return {
		freeMemoryMiB: count(value.freeMemoryMiB, "freeMemoryMiB"),
		freeDiskGiB: count(value.freeDiskGiB, "freeDiskGiB"),
		running: count(value.running, "running"),
		stopped: count(value.stopped, "stopped"),
		load1: count(value.load1, "load1"),
		warm,
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
