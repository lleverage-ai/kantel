import { describe, expect, it } from "vitest";
import { decide, measureGain, noiseBand } from "./score.ts";

const same = { renderMs: 20, latencyMedian: 30, wasted: 0, bundleJs: 3000 };

describe("measureGain", () => {
	it("scores halving a cost +1 and doubling it -1", () => {
		expect(measureGain("renderMs", 20, 10)).toBe(1);
		expect(measureGain("renderMs", 20, 40)).toBe(-1);
	});

	it("scores costs under the floor as equal, so zero against zero is not infinite", () => {
		expect(measureGain("wasted", 0, 0)).toBe(0);
		expect(measureGain("renderMs", 0.2, 0.6)).toBe(0);
	});

	it("still credits removing a cost down to nothing, measured from the floor", () => {
		expect(measureGain("wasted", 4, 0)).toBe(2);
	});
});

describe("decide", () => {
	it("accepts a variant the judges prefer when the measures hold", () => {
		const decision = decide({
			gatesPassed: true,
			judgedChampion: 3.8,
			judgedVariant: 4.2,
			champion: same,
			variant: same,
		});
		expect(decision.accepted).toBe(true);
		expect(decision.score).toBeCloseTo(0.4);
	});

	it("keeps the champion when the change is inside the noise", () => {
		const decision = decide({
			gatesPassed: true,
			judgedChampion: 4,
			judgedVariant: 4,
			champion: same,
			variant: { ...same, renderMs: 19 },
		});
		expect(decision.accepted).toBe(false);
	});

	it("rejects a variant with any measure more than 10% worse, whatever its score", () => {
		const decision = decide({
			gatesPassed: true,
			judgedChampion: 3,
			judgedVariant: 4.5,
			champion: same,
			variant: { ...same, latencyMedian: 40 },
		});
		expect(decision.score).toBeGreaterThan(0.1);
		expect(decision.worse).toEqual(["latencyMedian"]);
		expect(decision.accepted).toBe(false);
	});

	it("rejects a variant missing a measure, so dropping a regressed measure cannot pass its veto", () => {
		const { latencyMedian: _, ...partial } = same;
		const decision = decide({
			gatesPassed: true,
			judgedChampion: 3,
			judgedVariant: 4,
			champion: same,
			variant: partial,
		});
		expect(decision.missing).toEqual(["latencyMedian"]);
		expect(decision.accepted).toBe(false);
	});

	it("rejects a comparison with no measures at all", () => {
		const decision = decide({ gatesPassed: true, judgedChampion: 3, judgedVariant: 4, champion: {}, variant: {} });
		expect(decision.missing).toEqual(["every measure"]);
		expect(decision.accepted).toBe(false);
	});

	it("rejects a variant that failed a gate", () => {
		expect(
			decide({ gatesPassed: false, judgedChampion: 3, judgedVariant: 5, champion: same, variant: same }).accepted,
		).toBe(false);
	});
});

describe("decide with a noise band", () => {
	it("scores a measure inside its noise band as no change, so it neither rejects nor counts", () => {
		const decision = decide({
			gatesPassed: true,
			judgedChampion: 4,
			judgedVariant: 4,
			champion: same,
			variant: { ...same, renderMs: 5, latencyMedian: 40 },
			noise: ["latencyMedian"],
		});
		expect(decision.worse).toEqual([]);
		expect(decision.noise).toEqual(["latencyMedian"]);
		expect(decision.measured).toBeCloseTo(2 / 4);
		expect(decision.accepted).toBe(true);
	});

	it("still rejects a measure outside its band", () => {
		const decision = decide({
			gatesPassed: true,
			judgedChampion: 4,
			judgedVariant: 4,
			champion: same,
			variant: { ...same, renderMs: 5, latencyMedian: 40 },
			noise: ["renderMs"],
		});
		expect(decision.worse).toEqual(["latencyMedian"]);
		expect(decision.accepted).toBe(false);
	});
});

describe("noiseBand", () => {
	const spread = (centre: number) => Array.from({ length: 30 }, (_, i) => centre + ((i * 7) % 11) - 5);

	it("finds no difference between two samples from the same spread", () => {
		const band = noiseBand("latencyMedian", spread(40), spread(40));
		expect(band.ratio).toBe(1);
		expect(band.inside).toBe(true);
	});

	it("tells a real difference from the noise", () => {
		const band = noiseBand("renderMs", spread(40), spread(20));
		expect(band.ratio).toBeCloseTo(0.5, 1);
		expect(band.high).toBeLessThan(1);
		expect(band.inside).toBe(false);
	});

	it("counts two values under the floor as the same", () => {
		expect(noiseBand("renderMs", [0, 0.2], [0.5, 0.9]).inside).toBe(true);
	});

	it("gives the same band each time for the same runs", () => {
		const a = [31, 45, 29, 44, 33, 46];
		const b = [44, 30, 45, 29, 46, 31];
		expect(noiseBand("latencyMedian", a, b)).toEqual(noiseBand("latencyMedian", a, b));
	});
});
