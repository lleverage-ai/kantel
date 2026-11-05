// Made-up live usage for the sample data and the stories: a sandbox's or a host's CPU, memory and disk every 5 seconds,
// the same for the same id and time on every read, so a graph that reads again only grows at its right-hand end.

import type { UsagePoint, UsageSeries } from "./compute-model.ts";

export const STUB_INTERVAL_MS = 5_000;

/** The most points one read returns: an hour at 5 seconds, or a week at an hour and a day at 5 minutes. */
const MOST = 720;

/** A number from 0 to 1 for a string and a step: the same every time. */
function noise(seed: number, step: number): number {
	let value = (seed ^ Math.imul(step, 0x9e3779b1)) >>> 0;
	value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
	value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
	return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

function seedOf(id: string): number {
	let hash = 2166136261;
	for (let at = 0; at < id.length; at += 1) hash = Math.imul(hash ^ id.charCodeAt(at), 16777619) >>> 0;
	return hash;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export interface StubUsageOptions {
	/** Points after this time. */
	readonly since: number;
	/** And up to this one. */
	readonly now: number;
	readonly memLimitBytes: number;
	/** A host's or a sandbox's disk: with it, each point has the disk in use. */
	readonly diskTotalBytes?: number;
	/** Each point has how much of it waited on IO, as a sandbox's host that reads its pressure says. */
	readonly io?: boolean;
	/** The points' interval: 5 seconds, as live readings come, or the means a longer range is read in. */
	readonly intervalMs?: number;
	/** How busy its CPU is on average, 0 to 1. Default from the id. */
	readonly busy?: number;
	/** How much of its memory it uses on average, 0 to 1. Default from the id. */
	readonly memory?: number;
	/** How much of its disk is in use, 0 to 1. Default from the id. */
	readonly disk?: number;
}

/** The value at one step: a slow wave and a quicker one round `level`, now and then a burst of work. */
function cpuAt(seed: number, step: number, level: number): number {
	const slow = Math.sin(step / 37 + (seed % 97)) * 0.5;
	const quick = Math.sin(step / 7 + (seed % 13)) * 0.25;
	const jitter = (noise(seed, step) - 0.5) * 0.3;
	// A burst lasts a few steps: each block of 18 steps has one in five chance.
	const block = Math.floor(step / 18);
	const burst = noise(seed + 1, block) < 0.2 && step % 18 < 6 ? 0.45 : 0;
	return clamp(level * (1 + slow + quick + jitter) + burst, 0.01, 1);
}

/** A sandbox's or host's points after `since`, every 5 seconds on the clock, as a live source answers. */
export function stubUsage(id: string, options: StubUsageOptions): UsageSeries {
	const seed = seedOf(id);
	const busy = options.busy ?? 0.08 + noise(seed, 1) * 0.4;
	const memory = options.memory ?? 0.2 + noise(seed, 2) * 0.4;
	const disk = options.disk ?? 0.2 + noise(seed, 3) * 0.5;
	const interval = options.intervalMs ?? STUB_INTERVAL_MS;
	// Longer means are smoother: the same waves, on steps of the interval rather than of 5 seconds.
	const scale = interval / STUB_INTERVAL_MS;
	const last = Math.floor(options.now / interval);
	const first = Math.max(Math.floor(options.since / interval) + 1, last - MOST + 1);
	const points: UsagePoint[] = [];
	for (let tick = first; tick <= last; tick += 1) {
		const step = scale === 1 ? tick : Math.round(tick * Math.min(scale, 6));
		const cpu = cpuAt(seed, step, busy);
		// Memory follows the CPU a little and drifts slowly; it doesn't jump about as CPU does.
		const share = clamp(memory + Math.sin(step / 90 + (seed % 31)) * 0.06 + cpu * 0.08, 0.02, 0.98);
		points.push({
			at: tick * interval,
			cpu: Math.round(cpu * 1000) / 1000,
			memUsedBytes: Math.round(options.memLimitBytes * share),
			...(options.diskTotalBytes === undefined
				? {}
				: {
						diskUsedBytes: Math.round(
							options.diskTotalBytes * clamp(disk + Math.sin(step / 400 + (seed % 7)) * 0.001, 0, 1),
						),
					}),
			// IO waits come with bursts of work, and are otherwise near none.
			...(options.io === true
				? {
						ioPressure:
							Math.round(clamp(cpu > busy * 1.6 ? cpu * 0.35 : noise(seed + 2, step) * 0.03, 0, 1) * 1000) / 1000,
					}
				: {}),
		});
	}
	return {
		intervalMs: interval,
		memLimitBytes: options.memLimitBytes,
		...(options.diskTotalBytes === undefined ? {} : { diskTotalBytes: options.diskTotalBytes }),
		points,
	};
}
