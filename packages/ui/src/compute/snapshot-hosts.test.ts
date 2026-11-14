import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createComputeFixtures, EVALS, LLEVERAGE, SAVED_HOSTS, VIEWER } from "./fixtures.ts";
import { OrganisationPage } from "./organisation-page.tsx";
import { ProfilePage } from "./profile-page.tsx";
import { SnapshotHosts } from "./snapshot-hosts.tsx";

const text = (html: string): string =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

describe("a saved snapshot's hosts", () => {
	it("names each host, held or fetching", () => {
		const html = renderToStaticMarkup(createElement(SnapshotHosts, { hosts: SAVED_HOSTS.ssn_playwright ?? [] }));
		expect(text(html)).toBe("hetzner-fsn1-02 Held hetzner-fsn1-01 Fetching");
		// Without memory in the snapshot, nothing about it.
		expect(html).not.toContain("memory");
	});

	it("says where a snapshot with memory restores it", () => {
		const html = renderToStaticMarkup(
			createElement(SnapshotHosts, {
				memory: true,
				hosts: [
					{ hostId: "hst_a", hostName: "a", state: "held", memory: true },
					{ hostId: "hst_b", hostName: "b", state: "held", memory: false },
					{ hostId: "hst_c", hostName: "c", state: "fetching", memory: false },
				],
			}),
		);
		expect(text(html)).toBe("a With memory Held b Disk only Held c Fetching");
	});

	it("lists a host the viewer may not know of without its name, and says when there are none yet", () => {
		const shared = renderToStaticMarkup(createElement(SnapshotHosts, { hosts: [{ state: "held", memory: false }] }));
		expect(text(shared)).toBe("Shared host Held");
		expect(text(renderToStaticMarkup(createElement(SnapshotHosts, { hosts: [] })))).toContain("Not on a host yet");
	});
});

describe("the account's Keep saved snapshots on two hosts", () => {
	const source = createComputeFixtures().accounts;
	const general = (account: typeof LLEVERAGE) =>
		renderToStaticMarkup(createElement(OrganisationPage, { source, account, viewerId: VIEWER.id }));

	it("is on an organisation's General page where the account says it, read only for a member", () => {
		expect(general(LLEVERAGE)).toContain("Keep saved snapshots on two hosts");
		expect(general(EVALS)).toContain("Only an admin or owner changes this.");
		// A gateway from before it doesn't say: not offered.
		const { snapshotCopies: _, ...older } = LLEVERAGE;
		expect(general(older)).not.toContain("Keep saved snapshots on two hosts");
	});

	it("is on Profile for the personal account, given it", () => {
		const profile = (props: Parameters<typeof ProfilePage>[0]) =>
			renderToStaticMarkup(createElement(ProfilePage, props));
		expect(profile({ name: "Tom" })).not.toContain("Keep saved snapshots on two hosts");
		expect(profile({ name: "Tom", snapshotCopies: { on: false, onChange: async (on) => on } })).toContain(
			"Keep saved snapshots on two hosts",
		);
	});
});
