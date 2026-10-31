// The members flow over a stand-in for the routes: listing, confirming and resetting a person's passkeys, and what each
// failure says. The console's seam is tested against the real identity and passkey handlers
// (apps/console/src/api/members.test.ts).

import { HarbourError } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { createMembersFlow, type MembersApi, membersProblem, resetText } from "./members-model.ts";

const MEMBERS = [
	{ userId: "usr_ada", name: "Ada" },
	{ userId: "usr_lin", name: "Lin" },
];

function api(fail: { list?: unknown; reset?: unknown } = {}) {
	const resets: string[] = [];
	const made: MembersApi = {
		list: async () => {
			if (fail.list !== undefined) throw fail.list;
			return MEMBERS;
		},
		resetPasskeys: async (userId) => {
			if (fail.reset !== undefined) throw fail.reset;
			resets.push(userId);
			return { removed: 2 };
		},
	};
	return { api: made, resets };
}

describe("the members flow", () => {
	it("lists the members, then resets one person's passkeys only once it is confirmed", async () => {
		const { api: made, resets } = api();
		const flow = createMembersFlow({ api: made });
		expect(flow.getState()).toEqual({ loading: true });
		await flow.load();
		expect(flow.getState()).toEqual({ members: MEMBERS, loading: false });

		// Nothing to reset until someone is asked about.
		await flow.reset();
		expect(resets).toEqual([]);

		flow.askReset("usr_lin");
		flow.cancelReset();
		expect(flow.getState().confirming).toBeUndefined();

		flow.askReset("usr_lin");
		const resetting = flow.reset();
		expect(flow.getState().resetting).toBe("usr_lin");
		// A second press while it runs does nothing.
		await flow.reset();
		await resetting;
		expect(resets).toEqual(["usr_lin"]);
		expect(flow.getState()).toEqual({ members: MEMBERS, loading: false, done: { userId: "usr_lin", removed: 2 } });

		// Asking about someone else clears the last result.
		flow.askReset("usr_ada");
		expect(flow.getState().done).toBeUndefined();
	});

	it("keeps the confirmation open with the reason when a reset is refused", async () => {
		const { api: made } = api({ reset: new HarbourError("forbidden", "Needs admin") });
		const flow = createMembersFlow({ api: made });
		await flow.load();
		flow.askReset("usr_ada");
		await flow.reset();
		expect(flow.getState()).toMatchObject({
			confirming: "usr_ada",
			resetProblem: { userId: "usr_ada", problem: { kind: "forbidden" } },
		});
		expect(flow.getState().resetting).toBeUndefined();
	});

	it("says why the list didn't load", async () => {
		const failing = api({ list: new HarbourError("unavailable", "restarting") });
		const flow = createMembersFlow({ api: failing.api });
		await flow.load();
		expect(flow.getState()).toEqual({ loading: false, loadProblem: { kind: "unavailable" } });
	});

	it("names each failure", () => {
		expect(membersProblem(new HarbourError("forbidden", "Signed out", { authentication: "invalid" }))).toEqual({
			kind: "signed-out",
		});
		expect(membersProblem(new HarbourError("forbidden", "Needs admin"))).toEqual({ kind: "forbidden" });
		expect(membersProblem(new HarbourError("not_found", "No such user"))).toEqual({ kind: "not-found" });
		expect(membersProblem(new HarbourError("not_supported", "No passkeys"))).toEqual({ kind: "not-supported" });
		expect(membersProblem(new Error("network"))).toEqual({ kind: "unavailable" });
	});

	it("says what a reset did", () => {
		expect(resetText("Lin", 0)).toBe("Lin had no passkeys to remove.");
		expect(resetText("Lin", 1)).toBe(
			"Removed 1 passkey from Lin. They can set up a new one on the connection request page.",
		);
		expect(resetText("Lin", 3)).toBe(
			"Removed 3 passkeys from Lin. They can set up a new one on the connection request page.",
		);
	});
});
