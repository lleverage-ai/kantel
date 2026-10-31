import { describe, expect, it } from "vitest";
import { compactAge } from "../primitives/format.ts";
import { canShare, canUnshare, reachFacts, shareableProjects, shareText, usageText } from "./connections-model.ts";
import {
	ADMIN_OTHER_VIEWER,
	CONNECTIONS,
	createSharingScenario,
	MEMBER_VIEWER,
	PEOPLE,
	sessionConnectionsFor,
	VIEWER,
} from "./fixtures.ts";

const find = (id: string) => {
	const found = CONNECTIONS.find((c) => c.id === id);
	if (found === undefined) throw new Error(`no ${id}`);
	return found;
};
const github = find("conn_github_tom");
const gmail = find("conn_gmail_tom");
const bot = find("conn_github_bot");
const people = (id: string) => PEOPLE[id];

describe("shareText", () => {
	it("reads a share made in the last minute as just now, not now ago", () => {
		const at = 1_000_000_000;
		const share = { projectId: "proj_support", sharedBy: "Tom Davies", sharedAt: at };
		expect(shareText(share, at + 5_000, compactAge)).toBe("Shared by Tom Davies just now");
		expect(shareText(share, at + 3 * 60_000, compactAge)).toBe("Shared by Tom Davies 3m ago");
	});
});

describe("who may share", () => {
	it("lets only the person a connection belongs to share it", () => {
		expect(canShare(github, VIEWER)).toBe(true);
		expect(canShare(github, ADMIN_OTHER_VIEWER)).toBe(false);
		expect(canShare(bot, VIEWER)).toBe(false);
	});

	it("lets the owner or an admin stop a share, and not another member", () => {
		expect(canUnshare(github, VIEWER)).toBe(true);
		expect(canUnshare(github, ADMIN_OTHER_VIEWER)).toBe(true);
		expect(canUnshare(github, { ...MEMBER_VIEWER, userId: "usr_ana" })).toBe(false);
	});

	it("offers only the projects it isn't shared with yet", () => {
		expect(shareableProjects(github, VIEWER).map((p) => p.id)).toEqual(["proj_billing"]);
		expect(shareableProjects(gmail, VIEWER).map((p) => p.id)).toEqual(["proj_support", "proj_billing"]);
	});
});

describe("reachFacts", () => {
	it("says a personal connection that isn't shared stays in its owner's private sessions", () => {
		const facts = reachFacts(gmail, VIEWER, people);
		expect(facts.find((f) => f.label === "Sessions")?.text).toBe("Only sessions acting for you.");
		expect(facts.find((f) => f.label === "Seen by")).toMatchObject({ closed: true });
		expect(facts.find((f) => f.label === "Unattended runs")?.text).toMatch(/^Never/);
	});

	it("names the projects a shared personal connection reaches, and where its data may be seen", () => {
		const facts = reachFacts(github, VIEWER, people);
		expect(facts.find((f) => f.label === "Sessions")?.text).toBe(
			"Sessions acting for you, and any session in the Support project.",
		);
		expect(facts.find((f) => f.label === "Seen by")?.text).toMatch(/except in Support/);
	});

	it("names the owner to someone else", () => {
		const facts = reachFacts(github, ADMIN_OTHER_VIEWER, people);
		expect(facts[0]?.text).toMatch(/^Sessions acting for Tom Davies/);
	});

	it("lets an organisation's connection reach unattended runs", () => {
		const facts = reachFacts(bot, VIEWER, people);
		expect(facts.find((f) => f.label === "Sessions")?.text).toBe("Any session in Acme.");
		expect(facts.find((f) => f.label === "Unattended runs")?.closed).toBeUndefined();
	});

	it("keeps usageText reading the shares", () => {
		expect(usageText(github, VIEWER)).toMatch(/Support/);
	});
});

describe("the sharing scenario", () => {
	const scenario = (viewer = VIEWER) => {
		let list = CONNECTIONS;
		return createSharingScenario({
			connections: () => list,
			set: (next) => {
				list = list.map((c) => (c.id === next.id ? next : c));
			},
			viewer,
			wait: async (value) => value(),
		});
	};

	it("shares and stops sharing, as the API does", async () => {
		const source = scenario();
		const shared = await source.share(gmail.id, "proj_billing");
		expect(shared.shares?.map((s) => s.projectId)).toEqual(["proj_billing"]);
		const unshared = await source.unshare(gmail.id, "proj_billing");
		expect(unshared.shares).toEqual([]);
	});

	it("refuses someone else sharing a person's connection", async () => {
		await expect(scenario(ADMIN_OTHER_VIEWER).share(github.id, "proj_billing")).rejects.toThrow(/Only the person/);
	});
});

describe("a session's connections", () => {
	it("refuses a personal connection that isn't shared once others can see the session", () => {
		const shared = sessionConnectionsFor("shared");
		expect(shared.find((c) => c.id === "conn_gmail_tom")).toMatchObject({
			usable: false,
			reason: "It is private, and other people can see this session",
		});
		expect(shared.find((c) => c.id === "conn_github_tom")).toMatchObject({ usable: true, viaShare: true });
		expect(sessionConnectionsFor("private").find((c) => c.id === "conn_gmail_tom")?.usable).toBe(true);
	});
});
