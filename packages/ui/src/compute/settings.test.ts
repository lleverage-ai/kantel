import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "../primitives/format.ts";
import { expiresText, untilText } from "./compute-model.ts";
import { createComputeFixtures, FIXTURE_NOW, LLEVERAGE, MEMBERS } from "./fixtures.ts";
import { createMemberLocks } from "./organisation-page.tsx";

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

	it("holds a second change to one member until the first settles, and lets other members' through", async () => {
		const source = createComputeFixtures().accounts;
		const [bethan, maya] = MEMBERS.filter((each) => each.role === "member");
		if (bethan === undefined || maya === undefined) throw new Error("The sample needs two plain members.");
		const seen: (readonly string[])[] = [];
		const locks = createMemberLocks((busy) => seen.push([...busy]));
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Admin, held on its way so the next ones arrive while it is still going.
		const first = locks.run(bethan.id, async () => {
			await held;
			return source.setRole?.(LLEVERAGE.id, bethan.id, "admin");
		});
		expect(first).toBeDefined();
		// Back to Member, and Remove, for the same person: refused while Admin is going.
		expect(locks.run(bethan.id, async () => source.setRole?.(LLEVERAGE.id, bethan.id, "member"))).toBeUndefined();
		expect(locks.run(bethan.id, async () => source.removeMember(LLEVERAGE.id, bethan.id))).toBeUndefined();
		// Someone else isn't held up.
		await locks.run(maya.id, async () => source.setRole?.(LLEVERAGE.id, maya.id, "admin"));
		release();
		await first;
		const stored = await source.members(LLEVERAGE.id);
		expect(stored.find((each) => each.id === bethan.id)?.role).toBe("admin");
		expect(stored.find((each) => each.id === maya.id)?.role).toBe("admin");
		expect(seen.at(-1)).toEqual([]);
		// Settled, so the next change goes.
		expect(locks.run(bethan.id, async () => source.setRole?.(LLEVERAGE.id, bethan.id, "member"))).toBeDefined();
	});

	it("frees a member when the change fails", async () => {
		const locks = createMemberLocks(() => {});
		await expect(locks.run("usr_x", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
		expect(locks.run("usr_x", async () => "again")).toBeDefined();
	});

	it("changes a member's role, and keeps it", async () => {
		const source = createComputeFixtures().accounts;
		const member = MEMBERS.find((each) => each.role === "member");
		if (member === undefined) throw new Error("The sample has no plain member.");
		expect((await source.setRole?.(LLEVERAGE.id, member.id, "admin"))?.role).toBe("admin");
		expect((await source.members(LLEVERAGE.id)).find((each) => each.id === member.id)?.role).toBe("admin");
	});
});
