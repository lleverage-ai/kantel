// The design loop's score and acceptance rule (docs/design-loop.md), for one variant against its champion.
//   S = (J_V - J_C) + M,   M = mean over measures of log2(C / V)
// A variant is accepted when every gate passed, S > 0.1, and no measure is more than 10% worse than the champion's.
// Pure, so the rule is tested and the history files are recomputed the same way.

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
	accepted: boolean;
};

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
}): Decision {
	const names = Object.keys(input.champion).filter((name) => name in input.variant);
	const gains = names.map((name) => measureGain(name, input.champion[name] as number, input.variant[name] as number));
	const measured = gains.length === 0 ? 0 : gains.reduce((sum, gain) => sum + gain, 0) / gains.length;
	const worse = names.filter((_name, index) => (gains[index] as number) < -Math.log2(WORSE_LIMIT));
	const judged = input.judgedVariant - input.judgedChampion;
	const score = judged + measured;
	return {
		judged,
		measured,
		score,
		worse,
		accepted: input.gatesPassed && score > ACCEPT_ABOVE && worse.length === 0,
	};
}
