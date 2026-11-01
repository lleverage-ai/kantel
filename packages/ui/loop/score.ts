// The design loop's score and acceptance rule, for one variant against its champion.
//   S = (J_V - J_C) + M,   M = mean over measures of log2(C / V)
// A variant is accepted when every gate passed, S > 0.1, and no measure is more than 10% worse than the champion's.
// A measure whose difference is inside its noise band (`noise`, from noiseBand() over many runs, as loop/ab.ts
// gives) neither scores nor rejects: it counts as no change.
// Pure, so the rule can be tested on its own.

export type Measures = Record<string, number>;

/** Below these a cost is noise (a sub-millisecond render, no wasted renders): it neither scores nor rejects. */
export const floors: Record<string, number> = {
	renderMs: 1,
	inputRenderMs: 1,
	latencyMedian: 1,
	latencyP95: 1,
	wasted: 1,
	bundleJs: 64,
	bundleCss: 64,
};

export const ACCEPT_ABOVE = 0.1;
export const WORSE_LIMIT = 1.1;

export type Decision = {
	judged: number;
	measured: number;
	score: number;
	/** Measures more than 10% worse than the champion's, which reject the variant whatever its score. */
	worse: string[];
	/** Measures one side has and the other lacks. Missing evidence is not "no regression": it rejects the variant. */
	missing: string[];
	/** Measures whose difference was inside the noise band, so scored 0 and never counted as worse. */
	noise: string[];
	accepted: boolean;
};

export type Band = {
	/** median(variant) / median(champion), each raised to the measure's floor. */
	ratio: number;
	/** The 95% bootstrap interval of that ratio. */
	low: number;
	high: number;
	/** The interval includes 1, or both medians are under the floor: the difference is not told apart from noise. */
	inside: boolean;
};

const median = (values: readonly number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] as number;
};

/** A small seeded generator (mulberry32), so a band is the same each time it is recomputed from the same runs. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The noise band of one measure: the ratio of the variant's median run to the champion's, and its 95% interval from a
 * bootstrap that resamples each side's runs with replacement. Runs are the unit, not single inputs, because inputs in
 * one page share its state (its JIT, its garbage, where its frames fall).
 */
export function noiseBand(
	name: string,
	champion: readonly number[],
	variant: readonly number[],
	options: { resamples?: number; seed?: number } = {},
): Band {
	if (champion.length === 0 || variant.length === 0) throw new Error(`No runs for ${name}`);
	const floor = floors[name] ?? 0;
	const ratioOf = (c: readonly number[], v: readonly number[]) =>
		Math.max(median(v), floor) / Math.max(median(c), floor, Number.MIN_VALUE);
	const next = random(options.seed ?? 1);
	const pick = (values: readonly number[]) => values.map(() => values[Math.floor(next() * values.length)] as number);
	const ratios: number[] = [];
	for (let i = 0; i < (options.resamples ?? 2000); i++) ratios.push(ratioOf(pick(champion), pick(variant)));
	ratios.sort((a, b) => a - b);
	const low = ratios[Math.floor(0.025 * ratios.length)] as number;
	const high = ratios[Math.min(ratios.length - 1, Math.floor(0.975 * ratios.length))] as number;
	const ratio = ratioOf(champion, variant);
	const underFloor = Math.max(median(champion), median(variant)) <= floor;
	return { ratio, low, high, inside: underFloor || (low <= 1 && high >= 1) };
}

/** log2(C / V) with each side raised to its floor, so a cost at or under the floor on both sides scores 0. */
export function measureGain(name: string, champion: number, variant: number): number {
	const floor = floors[name] ?? 0;
	return Math.log2(Math.max(champion, floor) / Math.max(variant, floor));
}

export function decide(input: {
	gatesPassed: boolean;
	judgedChampion: number;
	judgedVariant: number;
	champion: Measures;
	variant: Measures;
	/** Measures whose difference is inside the noise band. */
	noise?: readonly string[];
}): Decision {
	const names = Object.keys(input.champion).filter((name) => name in input.variant);
	const noise = names.filter((name) => input.noise?.includes(name) === true);
	const missing = [
		...Object.keys(input.champion).filter((name) => !(name in input.variant)),
		...Object.keys(input.variant).filter((name) => !(name in input.champion)),
	];
	if (names.length === 0 && missing.length === 0) missing.push("every measure");
	const gains = names.map((name) =>
		noise.includes(name) ? 0 : measureGain(name, input.champion[name] as number, input.variant[name] as number),
	);
	const measured = gains.length === 0 ? 0 : gains.reduce((sum, gain) => sum + gain, 0) / gains.length;
	const worse = names.filter((_name, index) => (gains[index] as number) < -Math.log2(WORSE_LIMIT));
	const judged = input.judgedVariant - input.judgedChampion;
	const score = judged + measured;
	return {
		judged,
		measured,
		score,
		worse,
		missing,
		noise,
		accepted: input.gatesPassed && score > ACCEPT_ABOVE && worse.length === 0 && missing.length === 0,
	};
}
