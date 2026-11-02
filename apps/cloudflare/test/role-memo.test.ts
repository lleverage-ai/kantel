// The role memo: one `roleOf` lookup per caller's request and project, never shared across requests, kept at most its
// TTL, never for a non-system caller, and never for a failed lookup.
import { type Actor, type IdentityDirectory, type Role, systemContext } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { memoiseRoleOf } from "../src/role-memo.ts";

const SYSTEM = systemContext("kantel.test");

function countingIdentity(answer: () => Promise<Role | undefined>) {
	const calls: { actor: Actor; projectId: string | undefined }[] = [];
	const identity = {
		roleOf: async (ctx: { actor: Actor }, actor: Actor, _organisationId: string, projectId?: string) => {
			if (ctx.actor.kind !== "system") throw new Error("forbidden");
			calls.push({ actor, projectId });
			return answer();
		},
		getProject: async () => ({ id: "prj_1" }),
	} as unknown as IdentityDirectory;
	return { identity, calls };
}

const person = (): Actor => ({ kind: "human", userId: "usr_1" });

describe("memoiseRoleOf", () => {
	it("looks a role up once for the same actor object and project", async () => {
		const { identity, calls } = countingIdentity(async () => "admin");
		let now = 0;
		const memo = memoiseRoleOf(identity, { clock: { now: () => now } });
		const actor = person();
		const answers = await Promise.all(Array.from({ length: 50 }, () => memo.roleOf(SYSTEM, actor, "org_1", "prj_1")));
		expect(answers.every((role) => role === "admin")).toBe(true);
		expect(calls).toHaveLength(1);
		await memo.roleOf(SYSTEM, actor, "org_1", "prj_2");
		await memo.roleOf(SYSTEM, actor, "org_1");
		expect(calls.map((call) => call.projectId)).toEqual(["prj_1", "prj_2", undefined]);
		now = 999;
		await memo.roleOf(SYSTEM, actor, "org_1", "prj_1");
		expect(calls).toHaveLength(3);
	});

	it("never shares an answer between requests (actor objects)", async () => {
		const roles: (Role | undefined)[] = ["admin", undefined];
		const { identity, calls } = countingIdentity(async () => roles.shift());
		const memo = memoiseRoleOf(identity, { clock: { now: () => 0 } });
		expect(await memo.roleOf(SYSTEM, person(), "org_1", "prj_1")).toBe("admin");
		// The role was revoked; the next request signs in as a new actor object and sees it.
		expect(await memo.roleOf(SYSTEM, person(), "org_1", "prj_1")).toBeUndefined();
		expect(calls).toHaveLength(2);
	});

	it("looks again once the TTL has passed", async () => {
		const { identity, calls } = countingIdentity(async () => "viewer");
		let now = 0;
		const memo = memoiseRoleOf(identity, { clock: { now: () => now }, ttlMs: 1000 });
		const actor = person();
		await memo.roleOf(SYSTEM, actor, "org_1", "prj_1");
		now = 1000;
		await memo.roleOf(SYSTEM, actor, "org_1", "prj_1");
		expect(calls).toHaveLength(2);
	});

	it("passes a non-system caller straight through, every time", async () => {
		const { identity } = countingIdentity(async () => "admin");
		const memo = memoiseRoleOf(identity, { clock: { now: () => 0 } });
		const actor = person();
		await memo.roleOf(SYSTEM, actor, "org_1", "prj_1");
		const asPerson = { actor } as unknown as typeof SYSTEM;
		await expect(memo.roleOf(asPerson, actor, "org_1", "prj_1")).rejects.toThrow("forbidden");
		await expect(memo.roleOf(asPerson, actor, "org_1", "prj_1")).rejects.toThrow("forbidden");
	});

	it("doesn't keep a failed lookup", async () => {
		let fail = true;
		const { identity, calls } = countingIdentity(async () => {
			if (fail) throw new Error("D1 unavailable");
			return "operator";
		});
		const memo = memoiseRoleOf(identity, { clock: { now: () => 0 } });
		const actor = person();
		await expect(memo.roleOf(SYSTEM, actor, "org_1", "prj_1")).rejects.toThrow("D1 unavailable");
		fail = false;
		expect(await memo.roleOf(SYSTEM, actor, "org_1", "prj_1")).toBe("operator");
		expect(calls).toHaveLength(2);
	});

	it("leaves every other method as it was", async () => {
		const { identity } = countingIdentity(async () => "admin");
		const memo = memoiseRoleOf(identity);
		expect(await memo.getProject({ ...SYSTEM, organisationId: "org_1" }, "prj_1")).toEqual({ id: "prj_1" });
	});
});
