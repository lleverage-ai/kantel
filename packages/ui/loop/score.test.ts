import { describe, expect, it } from "vitest";
import { decide, measureGain } from "./score.ts";

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

	it("rejects a variant that failed a gate", () => {
		expect(
			decide({ gatesPassed: false, judgedChampion: 3, judgedVariant: 5, champion: same, variant: same }).accepted,
		).toBe(false);
	});
});
