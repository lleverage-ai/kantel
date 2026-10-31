// The vault page against the in-memory vault: every fixture state loads and draws its binding code, a narrowed approval
// produces the grant the page promised, a wrong code is refused and audited, and a forwarded link is decided only on the
// approver's own role. Rendering is to static markup (no DOM emulation); interaction is checked in the workbench.

import { isKantelError, KantelError } from "@kantel/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "../primitives/format.ts";
import { createVaultScenario, FIXTURE_NOW, type FixtureState, people } from "./fixtures.ts";
import { VaultPage } from "./vault-page.tsx";
import {
	decisionRefusal,
	draftNarrowing,
	initialDraft,
	isForwarded,
	lifetimeOptions,
	previewTerms,
	settledState,
	termsSentence,
	type VaultRequest,
	type Viewer,
} from "./vault-page-model.ts";

const expected: Record<FixtureState, ReturnType<typeof settledState>> = {
	proposed: "open",
	pending: "open",
	read: "open",
	route: "open",
	secret: "open",
	approved: "approved",
	narrowed: "narrowed",
	denied: "denied",
	expired: "expired",
	revoked: "revoked",
	withdrawn: "withdrawn",
	personal: "open",
	exact: "open",
};

const noop = async () => {
	throw new Error("not in this test");
};

function render(request: VaultRequest, viewer: Viewer = people.tom, options: { passkey?: boolean } = {}) {
	return renderToStaticMarkup(
		createElement(VaultPage, {
			request,
			viewer,
			now: FIXTURE_NOW,
			onDecide: noop,
			...(options.passkey === false ? {} : { passkey: async () => "confirmed" as const }),
			grants: { grants: [], onStop: noop },
		}),
	);
}

describe("vault page fixtures", () => {
	it("holds one proposal in every lifecycle state, and the page draws each with its binding code", async () => {
		const scenario = await createVaultScenario();
		for (const [state, id] of Object.entries(scenario.proposals) as [FixtureState, string][]) {
			const request = await scenario.load(id);
			expect(settledState(request, FIXTURE_NOW), state).toBe(expected[state]);
			const html = render(request);
			// Always shown: plainly, or as one of the choices when it must be picked.
			expect(html, state).toContain(request.proposal.bindingCode);
		}
	});

	it("derives the kinds the page labels from the terms: write, read, route grant and secret paste", async () => {
		const scenario = await createVaultScenario();
		const kind = async (state: FixtureState) => (await scenario.load(scenario.proposals[state])).proposal.kind;
		expect(await kind("proposed")).toBe("write");
		expect(await kind("read")).toBe("read");
		expect(await kind("route")).toBe("route");
		expect(await kind("secret")).toBe("secret");
	});

	it("keeps Approve disabled until a code is picked for a write, route grant or paste, and not for a read", async () => {
		const scenario = await createVaultScenario();
		// The button's opening tag only: its class list has `disabled:` variants, so look for the attribute itself.
		const approveButton = (html: string) =>
			(html.match(/<button[^>]*>(?:(?!<\/button>).)*with passkey/s)?.[0] ?? "")
				.match(/^<button[^>]*>/)?.[0]
				.replace(/class="[^"]*"/, "") ?? "";
		for (const state of ["proposed", "route", "secret"] as const) {
			const request = await scenario.load(scenario.proposals[state]);
			expect(request.codeRequired, state).toBe(true);
			expect(approveButton(render(request)), state).toContain("disabled");
		}
		const read = await scenario.load(scenario.proposals.read);
		expect(read.codeRequired).toBe(false);
		expect(approveButton(render(read))).not.toContain("disabled");
	});

	it("shows an exact request in full, marks its hidden character, and offers no narrowing", async () => {
		const scenario = await createVaultScenario();
		const request = await scenario.load(scenario.proposals.exact);
		expect(request.proposal.kind).toBe("request");
		expect(request.codeRequired).toBe(true);
		const html = render(request);
		expect(html).toContain("The request");
		expect(html).toContain("https://api.github.com/repos/harbour-dev/harbour/issues?labels=release");
		expect(html).toContain("x-github-api-version");
		// Every header that goes out is part of it, Accept included; hop-by-hop ones never leave.
		expect(html).toContain("*/*");
		expect(html).not.toContain("keep-alive");
		expect(html).toContain("ZWSP");
		expect(html).toContain("can&#x27;t be seen");
		expect(html).toContain(request.proposal.terms.request!.digest);
		expect(html).not.toContain("Undo narrowing");
		expect(html).not.toContain("Always allow");
		const offered = renderToStaticMarkup(
			createElement(VaultPage, {
				request,
				viewer: people.tom,
				now: FIXTURE_NOW,
				onDecide: noop,
				onAlwaysAllow: noop,
				grants: { grants: [], onStop: noop },
			}),
		);
		expect(offered).toContain("Approve and always allow requests like this");
		// It says what the rule will be before it is saved.
		expect(offered).toContain("POST /repos/harbour-dev/harbour/issues, for this agent");
	});

	it("claims no passkey on a host without one: Approve, on the sign-in alone", async () => {
		const scenario = await createVaultScenario();
		const html = render(await scenario.load(scenario.proposals.read), people.tom, { passkey: false });
		expect(html).not.toMatch(/passkey/i);
		expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*>Approve<\/span>/s);
		expect(html).toContain("approving as the person signed in here");
	});
});

describe("approving with narrowed terms", () => {
	it("produces a grant whose terms match what the page showed", async () => {
		const scenario = await createVaultScenario();
		const request = await scenario.load(scenario.proposals.route);
		const draft = { ...initialDraft(request.proposal), methods: ["GET" as const], pathPrefix: "/jobs/stuck" };
		const withLifetime = { ...draft, ttlMs: DAY, maxUses: "5" };
		const result = draftNarrowing(request.proposal, withLifetime);
		expect(result.valid).toBe(true);
		expect(result.changes).toEqual({ methods: true, pathPrefix: true, ttlMs: true, maxUses: true });
		const shown = previewTerms(request.proposal, result.narrowing, FIXTURE_NOW);

		const decision = await scenario.vault.decide(scenario.ctxFor(people.tom), {
			proposalId: request.proposal.id,
			outcome: "approve",
			termsHash: request.proposal.termsHash,
			pickedCode: request.proposal.bindingCode,
			...(result.narrowing === undefined ? {} : { narrowing: result.narrowing }),
		});
		const grant = await scenario.vault.getGrant(scenario.ctxFor(people.tom), decision.grantId!);
		expect(grant.route).toEqual({ host: shown.host, methods: shown.methods, pathPrefix: shown.pathPrefix });
		expect(grant.maxUses).toBe(shown.maxUses);
		expect(grant.expiresAt).toBe(shown.expiresAt);
		expect(decision.effectiveTerms?.route).toEqual(grant.route);

		const after = await scenario.load(request.proposal.id);
		expect(settledState(after, FIXTURE_NOW)).toBe("narrowed");
		expect(after.grant?.id).toBe(grant.id);
	});

	it("refuses in the draft what the vault would refuse: a sibling path, more uses, no methods", async () => {
		const scenario = await createVaultScenario();
		const { proposal } = await scenario.load(scenario.proposals.pending);
		const base = initialDraft(proposal);
		expect(draftNarrowing(proposal, { ...base, pathPrefix: "/graphqlx" }).errors.pathPrefix).toBeDefined();
		expect(draftNarrowing(proposal, { ...base, pathPrefix: "graphql" }).errors.pathPrefix).toBeDefined();
		expect(draftNarrowing(proposal, { ...base, maxUses: "2" }).errors.maxUses).toBe("At most 1.");
		expect(draftNarrowing(proposal, { ...base, maxUses: "" }).errors.maxUses).toBe("At most 1.");
		expect(draftNarrowing(proposal, { ...base, methods: [] }).errors.methods).toBeDefined();
		expect(draftNarrowing(proposal, base)).toMatchObject({ narrowing: undefined, valid: true });
	});

	it("offers only lifetimes as short as the proposal's or shorter", () => {
		expect(lifetimeOptions(7 * DAY).map((option) => option.label)).toEqual(["1 hour", "8 hours", "1 day", "7 days"]);
		expect(lifetimeOptions(DAY).map((option) => option.label)).toEqual(["15 minutes", "1 hour", "8 hours", "1 day"]);
		expect(lifetimeOptions(undefined).at(-1)?.label).toBe("No expiry");
		expect(lifetimeOptions(undefined)).toHaveLength(4);
	});

	it("says the terms in one sentence", () => {
		expect(
			termsSentence({ host: "api.linear.app", methods: ["POST"], pathPrefix: "/graphql", ttlMs: DAY, maxUses: 1 }),
		).toBe("POST to api.linear.app under /graphql, for 1 day, once.");
		expect(termsSentence({ host: "sentry.io", methods: ["GET", "POST"], pathPrefix: "/", ttlMs: 8 * HOUR })).toBe(
			"GET, POST anywhere on sentry.io, for 8 hours, as often as needed.",
		);
	});
});

describe("the binding code", () => {
	it("refuses a wrong pick, records it in the audit log, and approves the matching one", async () => {
		const scenario = await createVaultScenario();
		const ctx = scenario.ctxFor(people.tom);
		const request = await scenario.load(scenario.proposals.proposed);
		const wrong = request.codeChoices!.find((code) => code !== request.proposal.bindingCode)!;
		const attempt = scenario.vault.decide(ctx, {
			proposalId: request.proposal.id,
			outcome: "approve",
			termsHash: request.proposal.termsHash,
			pickedCode: wrong,
		});
		const error = await attempt.catch((caught: unknown) => caught);
		expect(isKantelError(error, "refused")).toBe(true);
		expect(decisionRefusal(error).kind).toBe("code");
		const audited = await scenario.audit.query(ctx, { type: "vault.binding_code.mismatch" });
		expect(audited.items).toHaveLength(1);
		expect(audited.items[0]?.subject).toEqual({ kind: "vault.proposal", id: request.proposal.id });
		expect((await scenario.load(request.proposal.id)).proposal.status).toBe("pending");

		const decision = await scenario.vault.decide(ctx, {
			proposalId: request.proposal.id,
			outcome: "approve",
			termsHash: request.proposal.termsHash,
			pickedCode: request.proposal.bindingCode,
		});
		expect(decision.outcome).toBe("approved");
	});

	it("refuses a secret paste with a wrong code and stores nothing", async () => {
		const scenario = await createVaultScenario();
		const ctx = scenario.ctxFor(people.tom);
		const request = await scenario.load(scenario.proposals.secret);
		const wrong = request.codeChoices!.find((code) => code !== request.proposal.bindingCode)!;
		const error = await scenario.vault
			.decide(ctx, {
				proposalId: request.proposal.id,
				outcome: "approve",
				termsHash: request.proposal.termsHash,
				pickedCode: wrong,
				secretValue: "sntrys_canary",
			})
			.catch((caught: unknown) => caught);
		expect(decisionRefusal(error).kind).toBe("code");
		const items = await scenario.vault.listItems(ctx);
		expect(items.items.map((item) => item.name)).not.toContain("Sentry auth token");
	});
});

describe("a forwarded link", () => {
	it("shows another approver the requester and lets them decide on their own operator role, recorded as them", async () => {
		const scenario = await createVaultScenario();
		const request = await scenario.load(scenario.proposals.proposed, people.alex);
		expect(request.requester.person).toBe(people.tom.name);
		expect(isForwarded(request, people.alex)).toBe(true);
		expect(isForwarded(request, people.tom)).toBe(false);
		expect(request.readOnly).toBeUndefined();
		expect(render(request, people.alex)).toContain("not yours");
		const decision = await scenario.vault.decide(scenario.ctxFor(people.alex), {
			proposalId: request.proposal.id,
			outcome: "approve",
			termsHash: request.proposal.termsHash,
			pickedCode: request.proposal.bindingCode,
		});
		expect(decision.decidedBy).toEqual({ kind: "human", userId: people.alex.userId });
	});

	it("is read-only for a viewer without the operator role, and the vault refuses their decision", async () => {
		const scenario = await createVaultScenario();
		const request = await scenario.load(scenario.proposals.proposed, people.dean);
		expect(request.readOnly).toBe("role");
		expect(request.codeChoices).toBeUndefined();
		const html = render(request, people.dean);
		expect(html).toContain(request.proposal.bindingCode);
		expect(html).toContain("needs the operator role on Billing");
		const error = await scenario.vault
			.decide(scenario.ctxFor(people.dean), {
				proposalId: request.proposal.id,
				outcome: "approve",
				termsHash: request.proposal.termsHash,
				pickedCode: request.proposal.bindingCode,
			})
			.catch((caught: unknown) => caught);
		expect(decisionRefusal(error, { project: "Billing" })).toMatchObject({ kind: "role" });
	});

	it("reads the host's passkey refusal as a passkey problem, not a wrong code", () => {
		const refused = (passkey?: string) =>
			decisionRefusal(new KantelError("refused", "Passkey refused", passkey === undefined ? undefined : { passkey }));
		expect(refused("missing")).toMatchObject({ kind: "passkey", message: expect.stringMatching(/needs your passkey/) });
		expect(refused("binding")).toMatchObject({ kind: "passkey", message: expect.stringMatching(/didn't match/) });
		expect(refused().kind).toBe("code");
	});

	it("marks a personal item, and leaves only its owner to decide it, a project operator read-only", async () => {
		const scenario = await createVaultScenario();
		const own = await scenario.load(scenario.proposals.personal, people.tom);
		expect(own.item?.personalTo).toBe(people.tom.userId);
		expect(own.readOnly).toBeUndefined();
		expect(render(own)).toContain("Your personal item");
		const other = await scenario.load(scenario.proposals.personal, people.alex);
		expect(other.readOnly).toBeDefined();
		expect(other.codeChoices).toBeUndefined();
		// Alex can't read the item at all, so the page says why it may be read-only without naming it.
		expect(other.item).toBeUndefined();
		expect(render(other, people.alex)).toContain("someone&#x27;s personal one");
		const error = await scenario.vault
			.decide(scenario.ctxFor(people.alex), {
				proposalId: other.proposal.id,
				outcome: "approve",
				termsHash: other.proposal.termsHash,
				pickedCode: other.proposal.bindingCode,
			})
			.catch((caught: unknown) => caught);
		expect(isKantelError(error, "forbidden")).toBe(true);
		const names = (await scenario.vault.listItems(scenario.ctxFor(people.alex))).items.map((item) => item.name);
		expect(names).not.toContain("Google Calendar token");
	});

	it("can't be opened at all by someone with no role on the project", async () => {
		const scenario = await createVaultScenario();
		const error = await scenario.load(scenario.proposals.proposed, people.bethan).catch((caught: unknown) => caught);
		expect(isKantelError(error, "forbidden")).toBe(true);
	});
});

describe("active grants", () => {
	it("lists the active grants with their uses, and Stop ends one", async () => {
		const scenario = await createVaultScenario();
		const grants = await scenario.grants();
		// The narrowed Linear grant and the approved GitHub one; the stopped staging grant is not active.
		expect(grants.map((summary) => summary.itemName).sort()).toEqual(["GitHub token", "Linear API key"]);
		const linear = grants.find((summary) => summary.itemName === "Linear API key")!;
		expect(linear.grant.uses).toBe(3);
		await scenario.vault.revokeGrant(scenario.ctxFor(people.tom), linear.grant.id);
		expect((await scenario.grants()).map((summary) => summary.grant.id)).not.toContain(linear.grant.id);
	});
});
