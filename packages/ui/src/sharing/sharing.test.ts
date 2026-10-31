// The sharing page's model and view. Rendering is to static markup (no DOM emulation), as for the vault page.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "../primitives/format.ts";
import {
	createSharingScenario,
	directory,
	FIXTURE_NOW,
	fixtureRequests,
	fixtureShares,
	skillSharingFixtures,
} from "./fixtures.ts";
import {
	expiryText,
	grantablePermissions,
	granteeText,
	grantInput,
	kindLabel,
	offersAgentWrites,
	readAll,
	readOverview,
	readResourceSharing,
	resourceText,
	shareState,
	sortShares,
} from "./sharing-model.ts";
import { ShareList, SharingView } from "./sharing-page.tsx";

describe("the sharing model", () => {
	it("offers a grant no wider than asked", () => {
		expect(grantablePermissions("edit")).toEqual(["use", "propose", "edit"]);
		expect(grantablePermissions("use")).toEqual(["use"]);
	});

	it("sends only what narrows a request", () => {
		const [request] = fixtureRequests();
		if (request === undefined) throw new Error("fixture");
		expect(grantInput(request, { permission: "edit" })).toEqual({ decision: "grant" });
		expect(grantInput(request, { permission: "use", expiresAt: FIXTURE_NOW + DAY, note: " ok " })).toEqual({
			decision: "grant",
			permission: "use",
			expiresAt: FIXTURE_NOW + DAY,
			note: "ok",
		});
	});

	it("lets agents write only on a grant that allows edit, and only when asked", () => {
		const [request] = fixtureRequests();
		if (request === undefined) throw new Error("fixture");
		expect(offersAgentWrites("edit")).toBe(true);
		expect(offersAgentWrites("approve")).toBe(true);
		expect(offersAgentWrites("propose")).toBe(false);
		expect(offersAgentWrites("use")).toBe(false);
		expect(grantInput(request, { permission: "edit", agentWrites: true })).toEqual({
			decision: "grant",
			agentWrites: true,
		});
		expect(grantInput(request, { permission: "edit", agentWrites: false })).toEqual({ decision: "grant" });
		// Ticked, then narrowed to a permission that can't carry it: it isn't sent.
		expect(grantInput(request, { permission: "propose", agentWrites: true })).toEqual({
			decision: "grant",
			permission: "propose",
		});
	});

	it("names resources, grantees and kinds", () => {
		expect(resourceText({ kind: "skills.skill", id: "skill_review", revision: 3 }, directory)).toBe(
			"Skill review-checklist, revision 3",
		);
		expect(resourceText({ kind: "workflows.workflow", id: "wf_1" })).toBe("workflows.workflow wf_1");
		expect(kindLabel("memory.space")).toBe("Memory space");
		expect(granteeText({ kind: "agent", agentId: "agent_triage" }, directory)).toBe("agent Triage");
		expect(granteeText({ kind: "user", userId: "usr_ana" }, directory)).toBe("Ana Silva");
		expect(granteeText({ kind: "project", projectId: "proj_x" }, { project: () => "Billing" })).toBe("Billing project");
	});

	it("says how long a share has left", () => {
		expect(expiryText(FIXTURE_NOW + 6 * DAY + 5, FIXTURE_NOW)).toBe("6 days left");
		expect(expiryText(FIXTURE_NOW + DAY, FIXTURE_NOW)).toBe("1 day left");
		expect(expiryText(FIXTURE_NOW + 2 * HOUR, FIXTURE_NOW)).toBe("2h left");
		expect(expiryText(FIXTURE_NOW - 1, FIXTURE_NOW)).toBe("Expired");
	});

	it("puts active shares first and tells expired from revoked", () => {
		const [skill, memory] = fixtureShares();
		if (skill === undefined || memory === undefined) throw new Error("fixture");
		const ended = { ...memory, expiresAt: FIXTURE_NOW - 1 };
		const revoked = { ...skill, id: "share_old", revokedAt: FIXTURE_NOW - DAY };
		expect(shareState(ended, FIXTURE_NOW)).toBe("expired");
		expect(shareState(revoked, FIXTURE_NOW)).toBe("revoked");
		expect(sortShares([revoked, ended, skill], FIXTURE_NOW).map((share) => share.id)).toEqual([
			"share_skill",
			"share_memory",
			"share_old",
		]);
	});

	it("reads every page, up to the limit", async () => {
		const pages = [{ items: [1, 2], nextCursor: "b" }, { items: [3, 4], nextCursor: "c" }, { items: [5] }];
		const cursors: (string | undefined)[] = [];
		const read = async (page: { cursor?: string }) => {
			cursors.push(page.cursor);
			return pages[cursors.length - 1] ?? { items: [] };
		};
		expect(await readAll(read)).toEqual([1, 2, 3, 4, 5]);
		expect(cursors).toEqual([undefined, "b", "c"]);
		expect(await readAll(async () => ({ items: [1, 2, 3], nextCursor: "more" }), 2)).toEqual([1, 2]);
	});

	it("reads one project's four lists, and a decision changes them", async () => {
		const source = createSharingScenario();
		const overview = await readOverview(source, "proj_support");
		expect(overview.inbox.map((request) => request.id)).toEqual(["request_skill"]);
		expect(overview.outgoing.map((share) => share.id)).toEqual(["share_skill", "share_memory"]);
		expect(overview.incoming.map((share) => share.id)).toEqual(["share_workspace"]);
		expect(overview.requests).toEqual([]);
		await source.decideRequest("request_skill", { decision: "grant", permission: "use" });
		const after = await readOverview(source, "proj_support");
		expect(after.inbox).toEqual([]);
		expect(after.outgoing.at(-1)?.permission).toBe("use");
	});
});

describe("the sharing view", () => {
	const draw = async () => {
		const overview = await readOverview(createSharingScenario(), "proj_support");
		const noop = () => undefined;
		return renderToStaticMarkup(
			createElement(SharingView, {
				overview,
				directory: { ...directory, project: (id: string) => ({ proj_billing: "Billing" })[id] },
				now: FIXTURE_NOW,
				onDecide: noop,
				onRevoke: noop,
				onWithdraw: noop,
			}),
		);
	};

	it("shows the request to decide, with the grants it allows", async () => {
		const html = await draw();
		expect(html).toContain("Requests to decide");
		expect(html).toContain("Skill review-checklist");
		expect(html).toContain("Edit for Billing project, asked by Ana Silva");
		expect(html).toContain("We&#x27;d like to add the refund checks");
		expect(html).toContain('<option value="propose">Propose changes</option>');
		expect(html).not.toContain('<option value="approve">');
		expect(html).toContain(">Grant</span>");
		expect(html).toContain(">Reject</span>");
		// The request asks for edit, so the grant offers agent writes, off until ticked.
		expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked)[^>]*>/);
		expect(html).toContain("Let agents write");
	});

	it("offers agent writes only for a request that can carry them", () => {
		const [request] = fixtureRequests();
		if (request === undefined) throw new Error("fixture");
		const html = renderToStaticMarkup(
			createElement(SharingView, {
				overview: { inbox: [{ ...request, permission: "propose" }], outgoing: [], incoming: [], requests: [] },
				directory,
				now: FIXTURE_NOW,
				onDecide: () => undefined,
				onRevoke: () => undefined,
				onWithdraw: () => undefined,
			}),
		);
		expect(html).toContain(">Grant</span>");
		expect(html).not.toContain("Let agents write");
	});

	it("lists what the project shares and what is shared with it", async () => {
		const html = await draw();
		expect(html).toContain("Skill review-checklist, revision 3");
		expect(html).toContain("With agent Triage");
		expect(html).toContain("6 days left");
		expect(html).toContain("Workspace Refund playbooks");
		expect(html).toContain("From Billing project");
		// Only the workspace share lets agents write, and the list says so.
		expect(html.match(/Agents can write/g)).toHaveLength(1);
		expect(html).toContain(">Revoke</span>");
		expect(html).toContain(">Detach</span>");
		// The project has asked for nothing, so its requests' card isn't shown at all.
		expect(html).not.toContain("This project&#x27;s requests");
		expect(html).not.toContain("Nothing shared yet");
	});

	it("says once that nothing is shared, rather than drawing four empty cards", () => {
		const html = renderToStaticMarkup(
			createElement(SharingView, {
				overview: { inbox: [], outgoing: [], incoming: [], requests: [] },
				directory,
				now: FIXTURE_NOW,
				onDecide: () => undefined,
				onRevoke: () => undefined,
				onWithdraw: () => undefined,
			}),
		);
		expect(html).toContain("Nothing shared yet");
		expect(html).not.toContain("Requests to decide");
		expect(html).not.toContain("Shared by this project");
		expect(html).not.toContain("Shared with this project");
	});
});

describe("a resource's sharing", () => {
	const extra = skillSharingFixtures("skill_reconcile", "prj_billing");
	const resource = { kind: "skills.skill", id: "skill_reconcile" } as const;

	it("reads only that resource's shares and pending requests", async () => {
		const source = createSharingScenario(extra);
		const sharing = await readResourceSharing(source, resource);
		expect(sharing.shares.map((share) => share.id)).toEqual([
			"share_skill_reconcile_web",
			"share_skill_reconcile_agent",
		]);
		expect(sharing.pending.map((request) => request.id)).toEqual(["request_skill_reconcile_platform"]);
		await source.decideRequest("request_skill_reconcile_platform", { decision: "reject" });
		await source.revokeShare("share_skill_reconcile_web");
		const after = await readResourceSharing(source, resource);
		expect(after.pending).toEqual([]);
		expect(after.shares.map((share) => share.id)).toEqual(["share_skill_reconcile_agent"]);
	});

	it("names each grantee, and the revision a share pins", () => {
		const html = renderToStaticMarkup(
			createElement(ShareList, {
				title: "Shared with",
				empty: "Not shared outside its owner.",
				shares: extra.shares,
				directory,
				now: FIXTURE_NOW,
				busy: undefined,
				action: "Revoke",
				onRevoke: () => undefined,
				side: "resource",
				heading: "h3",
			}),
		);
		expect(html).toContain("Website project, revision 1");
		expect(html).toContain("Agent Triage");
		expect(html).toContain("Shared by Tom Davies");
		expect(html).toContain("13 days left");
		expect(html).not.toContain("Skill ");
	});
});
