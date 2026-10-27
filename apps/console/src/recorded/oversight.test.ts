import { isHarbourError } from "@harbour/contracts";
import { describeEvent, readAll, toQuery } from "@harbour/ui";
import { describe, expect, it } from "vitest";
import { loadError } from "../app/vault-screen.tsx";
import { createRecordedOversight } from "./oversight.ts";

const NOW = Date.UTC(2026, 9, 27, 12);

describe("the console's vault and audit stand-in", () => {
	it("reads the vault's trail after the generated history, newest first and in time order", async () => {
		const { audit } = await createRecordedOversight(NOW, { historyCount: 600 });
		const events = [];
		for await (const page of readAll(audit.source, toQuery({ range: "all", kind: "all" }, NOW))) events.push(...page);
		expect(events.length).toBeGreaterThan(600);
		for (let index = 1; index < events.length; index += 1) {
			expect(events[index]!.seq).toBeLessThan(events[index - 1]!.seq);
			expect(events[index]!.at).toBeLessThanOrEqual(events[index - 1]!.at);
		}
		// The newest rows are the vault fixture's, written by the vault itself; the history's have `fx:` IDs.
		expect(events.slice(0, 20).every((event) => !event.id.startsWith("fx:"))).toBe(true);
	});

	it("files the history's credential uses under the vault's own items, so one filter finds both", async () => {
		const { audit } = await createRecordedOversight(NOW, { historyCount: 2000 });
		const linear = audit.choices.credentials?.find((choice) => choice.label === "Linear API key");
		expect(linear).toBeDefined();
		expect(audit.choices.credentials?.filter((choice) => choice.label === "Linear API key")).toHaveLength(1);
		const uses = [];
		for await (const page of readAll(audit.source, toQuery({ range: "all", kind: "credential-use" }, NOW), {
			credential: linear!.value,
		}))
			uses.push(...page);
		const recent = uses.filter((event) => event.at > NOW - 2 * 24 * 60 * 60 * 1000);
		expect(recent.length).toBeGreaterThan(0);
		expect(uses.length).toBeGreaterThan(recent.length);
		expect(audit.directory.item?.(linear!.value)).toBe("Linear API key");
	});

	it("files the second organisation's uses under the same choices", async () => {
		const { audit } = await createRecordedOversight(NOW, { historyCount: 4000 });
		const choices = new Set(audit.choices.credentials?.map((choice) => choice.value));
		const labs = audit.choices.organisations?.[1]?.value;
		expect(labs).toBeDefined();
		const named = new Set<string>();
		for await (const page of readAll(
			audit.source,
			toQuery({ range: "all", kind: "credential-use", organisationId: labs! }, NOW),
		))
			for (const event of page) if (typeof event.data?.itemId === "string") named.add(event.data.itemId);
		expect(named.size).toBeGreaterThan(0);
		for (const itemId of named) expect(choices.has(itemId), itemId).toBe(true);
	});

	it("links only the requests the vault holds", async () => {
		const { audit } = await createRecordedOversight(NOW, { historyCount: 600 });
		const events = [];
		for await (const page of readAll(audit.source, toQuery({ range: "all", kind: "vault" }, NOW))) events.push(...page);
		const lines = events.map((event) => ({ event, line: describeEvent(event, audit.directory, audit.links) }));
		const linked = lines.filter(({ line }) => line.link?.href.startsWith("/vault/requests/"));
		expect(linked.length).toBeGreaterThan(0);
		// The generated history's rows (`fx:` IDs) name requests the vault never held, so they stay unlinked.
		const history = ({ event }: (typeof lines)[number]) => event.id.startsWith("fx:");
		expect(linked.some(history)).toBe(false);
		expect(lines.some((entry) => history(entry) && entry.line.link === undefined)).toBe(true);
	});

	it("serves a request to decide, refuses a wrong code and stops a grant", async () => {
		const { vault, audit, proposals } = await createRecordedOversight(NOW, { historyCount: 100 });
		expect(audit.links.proposal?.("proposal_made_up")).toBeUndefined();
		expect(audit.links.proposal?.(proposals.pending!)).toBe(`/vault/requests/${proposals.pending}`);

		const request = await vault.request(proposals.pending!);
		expect(request.proposal.status).toBe("pending");
		const wrong = request.codeChoices!.find((code) => code !== request.proposal.bindingCode)!;
		const refused = await vault
			.decide({
				proposalId: request.proposal.id,
				outcome: "approve",
				termsHash: request.proposal.termsHash,
				pickedCode: wrong,
			})
			.catch((error: unknown) => error);
		expect(isHarbourError(refused, "refused")).toBe(true);
		const decision = await vault.decide({
			proposalId: request.proposal.id,
			outcome: "approve",
			termsHash: request.proposal.termsHash,
			pickedCode: request.proposal.bindingCode,
		});
		expect(decision.outcome).toBe("approved");
		expect((await vault.request(proposals.pending!)).proposal.status).toBe("approved");

		const grants = await vault.grants();
		expect(grants.length).toBeGreaterThan(0);
		await vault.stop(grants[0]!.grant.id);
		expect((await vault.grants()).map((summary) => summary.grant.id)).not.toContain(grants[0]!.grant.id);
		await expect(vault.request("proposal_missing")).rejects.toSatisfy((error) => isHarbourError(error, "not_found"));
	});

	it("says why a request didn't load", () => {
		expect(loadError(new Error("boom"))).toEqual({ kind: "other", message: "Couldn't load the request. Try again." });
	});
});
