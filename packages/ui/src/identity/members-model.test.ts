// The members flow over a stand-in for the routes: listing, confirming and resetting a person's passkeys, and what each
// failure says. The console's seam is tested against the real identity and passkey handlers
// (apps/console/src/api/members.test.ts).

import { KantelError } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import {
	createMembersFlow,
	type InviteRow,
	type MembersApi,
	membersProblem,
	onlyYou,
	resetText,
} from "./members-model.ts";

const MEMBERS = [
	{ userId: "usr_ada", name: "Ada" },
	{ userId: "usr_lin", name: "Lin" },
];

const PENDING: InviteRow = { id: "inv_1", email: "grace@example.test", role: "viewer", expiresAt: 1 };

function api(fail: { list?: unknown; reset?: unknown; invite?: unknown; revoke?: unknown } = {}, pending = [PENDING]) {
	const resets: string[] = [];
	const revoked: string[] = [];
	const made: MembersApi = {
		listInvites: async () => pending,
		invite: async ({ email, role }) => {
			if (fail.invite !== undefined) throw fail.invite;
			return { invite: { id: "inv_2", email, role, expiresAt: 2 }, link: "https://harbour.test/", emailed: false };
		},
		revokeInvite: async (inviteId) => {
			if (fail.revoke !== undefined) throw fail.revoke;
			revoked.push(inviteId);
		},
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
	return { api: made, resets, revoked };
}

describe("the members flow", () => {
	it("lists the members, then resets one person's passkeys only once it is confirmed", async () => {
		const { api: made, resets } = api();
		const flow = createMembersFlow({ api: made });
		expect(flow.getState()).toEqual({ loading: true });
		await flow.load();
		expect(flow.getState()).toEqual({ members: MEMBERS, invites: [PENDING], loading: false });

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
		expect(flow.getState()).toEqual({
			members: MEMBERS,
			invites: [PENDING],
			loading: false,
			done: { userId: "usr_lin", removed: 2 },
		});

		// Asking about someone else clears the last result.
		flow.askReset("usr_ada");
		expect(flow.getState().done).toBeUndefined();
	});

	it("keeps the confirmation open with the reason when a reset is refused", async () => {
		const { api: made } = api({ reset: new KantelError("forbidden", "Needs admin") });
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

	it("invites someone from the dialog, adds them to the pending invites, and keeps the link to share", async () => {
		const flow = createMembersFlow({ api: api().api });
		await flow.load();
		// Nothing is sent before the dialog opens.
		await flow.invite({ email: "lin@example.test", role: "admin" });
		expect(flow.getState().invites).toEqual([PENDING]);

		flow.openInvite();
		const sending = flow.invite({ email: "lin@example.test", role: "admin" });
		expect(flow.getState().inviting).toEqual({ sending: true });
		flow.closeInvite();
		expect(flow.getState().inviting, "it stays open while it sends").toEqual({ sending: true });
		await sending;
		const lin = { id: "inv_2", email: "lin@example.test", role: "admin", expiresAt: 2 };
		expect(flow.getState().invites).toEqual([PENDING, lin]);
		expect(flow.getState().inviting).toEqual({
			sending: false,
			sent: { invite: lin, link: "https://harbour.test/", emailed: false },
		});
		flow.closeInvite();
		expect(flow.getState().inviting).toBeUndefined();
	});

	it("keeps the dialog open with the reason when an invite is refused", async () => {
		const flow = createMembersFlow({ api: api({ invite: new KantelError("conflict", "invited already") }).api });
		await flow.load();
		flow.openInvite();
		await flow.invite({ email: "grace@example.test", role: "viewer" });
		expect(flow.getState().inviting).toEqual({ sending: false, problem: { kind: "conflict" } });
		expect(flow.getState().invites).toEqual([PENDING]);
	});

	it("revokes a pending invite, and drops one that is no longer pending", async () => {
		const ok = api();
		const flow = createMembersFlow({ api: ok.api });
		await flow.load();
		await flow.revokeInvite("inv_1");
		expect(ok.revoked).toEqual(["inv_1"]);
		expect(flow.getState().invites).toEqual([]);

		const gone = createMembersFlow({ api: api({ revoke: new KantelError("not_found", "no such invite") }).api });
		await gone.load();
		await gone.revokeInvite("inv_1");
		expect(gone.getState().invites).toEqual([]);
		expect(gone.getState().revokeProblem).toBeUndefined();

		const refused = createMembersFlow({ api: api({ revoke: new KantelError("unavailable", "restarting") }).api });
		await refused.load();
		await refused.revokeInvite("inv_1");
		expect(refused.getState()).toMatchObject({
			invites: [PENDING],
			revokeProblem: { inviteId: "inv_1", problem: { kind: "unavailable" } },
		});
	});

	it("is only you while nobody else is a member or invited", async () => {
		const you = [{ userId: "usr_ada", name: "Ada" }];
		expect(onlyYou({ loading: true }, "usr_ada")).toBe(false);
		expect(onlyYou({ loading: false, members: you, invites: [] }, "usr_ada")).toBe(true);
		expect(onlyYou({ loading: false, members: [], invites: [] }, "usr_ada")).toBe(true);
		expect(onlyYou({ loading: false, members: you, invites: [PENDING] }, "usr_ada")).toBe(false);
		expect(onlyYou({ loading: false, members: MEMBERS, invites: [] }, "usr_ada")).toBe(false);
	});

	it("says why the list didn't load", async () => {
		const failing = api({ list: new KantelError("unavailable", "restarting") });
		const flow = createMembersFlow({ api: failing.api });
		await flow.load();
		expect(flow.getState()).toEqual({ loading: false, loadProblem: { kind: "unavailable" } });
	});

	it("names each failure", () => {
		expect(membersProblem(new KantelError("forbidden", "Signed out", { authentication: "invalid" }))).toEqual({
			kind: "signed-out",
		});
		expect(membersProblem(new KantelError("forbidden", "Needs admin"))).toEqual({ kind: "forbidden" });
		expect(membersProblem(new KantelError("not_found", "No such user"))).toEqual({ kind: "not-found" });
		expect(membersProblem(new KantelError("not_supported", "No passkeys"))).toEqual({ kind: "not-supported" });
		expect(membersProblem(new KantelError("conflict", "Invited already"))).toEqual({ kind: "conflict" });
		expect(membersProblem(new KantelError("invalid", "No email"))).toEqual({ kind: "invalid" });
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
