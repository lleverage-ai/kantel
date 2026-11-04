import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "../primitives/format.ts";
import { expiresText, untilText } from "./compute-model.ts";
import { createComputeFixtures, FIXTURE_NOW, LLEVERAGE, MEMBERS } from "./fixtures.ts";

describe("how long until a key expires", () => {
	it("says it in days, hours or minutes, and nothing once it has passed", () => {
		expect(untilText(FIXTURE_NOW + 69 * DAY, FIXTURE_NOW)).toBe("in 69 days");
		expect(untilText(FIXTURE_NOW + 5 * HOUR, FIXTURE_NOW)).toBe("in 5h");
		expect(untilText(FIXTURE_NOW + 1, FIXTURE_NOW)).toBe("in 1m");
		expect(untilText(FIXTURE_NOW, FIXTURE_NOW)).toBeUndefined();
	});

	it("keeps the words a sandbox's expiry used", () => {
		expect(expiresText(FIXTURE_NOW + 3 * DAY, FIXTURE_NOW)).toBe("Expires in 3 days");
		expect(expiresText(FIXTURE_NOW - 1, FIXTURE_NOW)).toBe("Expired");
	});
});

describe("the sample organisation's settings", () => {
	it("renames the organisation, and lists it by its new name", async () => {
		const source = createComputeFixtures().accounts;
		const renamed = await source.rename?.(LLEVERAGE.id, "Lleverage AI");
		expect(renamed?.name).toBe("Lleverage AI");
		expect((await source.list()).find((account) => account.id === LLEVERAGE.id)?.name).toBe("Lleverage AI");
	});

	it("changes a member's role, and keeps it", async () => {
		const source = createComputeFixtures().accounts;
		const member = MEMBERS.find((each) => each.role === "member");
		if (member === undefined) throw new Error("The sample has no plain member.");
		expect((await source.setRole?.(LLEVERAGE.id, member.id, "admin"))?.role).toBe("admin");
		expect((await source.members(LLEVERAGE.id)).find((each) => each.id === member.id)?.role).toBe("admin");
	});
});
