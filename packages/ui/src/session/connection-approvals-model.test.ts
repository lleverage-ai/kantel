import { KantelError, type Proposal } from "@kantel/contracts";
import type { CardItem, ConnectionApprovalCard, ToolItem, TranscriptItem } from "@kantel/protocol";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ConnectionApprovalActions, ConnectionApprovalsContext } from "./connection-approval.tsx";
import {
	ApprovalMismatch,
	approvalRefusal,
	approvalState,
	approvalTitle,
	callApprovals,
	inCallDecision,
	PasskeyCancelled,
	RuleNotSaved,
	sessionRule,
	settledWords,
	timeLeftText,
} from "./connection-approvals-model.ts";
import { CONNECTION_RUN } from "./connection-tools.tsx";
import { ToolCallChip } from "./tool-call.tsx";
import { ToolRenderersContext } from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS } from "./tool-renderers.tsx";
import { ToolRunRow } from "./tool-run.tsx";

// The approval a connection call waits on, shown in the call (#460): which cards leave the transcript, the decision
// the session sends, the session's rule, and the approval as a call's run renders it.

const NOW = 1_793_500_000_000;

const call: ToolItem = {
	kind: "tool",
	id: "t1:toolu_pr",
	callId: "toolu_pr",
	name: "connection_request",
	label: "Calling connection_request",
	args: {
		connectionId: "conn_github",
		method: "POST",
		url: "https://api.github.com/repos/tvdavies/harbour/pulls",
		body: '{"title":"Spacing"}',
	},
	status: "running",
	at: NOW - 5000,
};
const script: ToolItem = {
	kind: "tool",
	id: "t2:toolu_script",
	callId: "toolu_script",
	name: "codemode",
	label: "Calling codemode",
	args: { code: "await tools.connection_request({})" },
	status: "running",
	at: NOW - 3000,
};

const card: ConnectionApprovalCard = {
	type: "connection.approval",
	proposalId: "prop_pr",
	status: "pending",
	bindingCode: "K7Q-2MX",
	what: "POST api.github.com/repos/tvdavies/harbour/pulls through GitHub",
	why: "Opening the PR you asked for.",
	host: "api.github.com",
	methods: ["POST"],
	pathPrefix: "/repos/tvdavies/harbour/pulls",
	termsSource: "agent-proposed",
	expiresAt: NOW + 600_000,
	link: "https://kantel.example/connections/requests/prop_pr",
	request: {
		connectionId: "conn_github",
		connectionName: "GitHub",
		kind: "http",
		method: "POST",
		url: "https://api.github.com/repos/tvdavies/harbour/pulls",
		digest: "d1",
	},
	callId: call.callId,
};
const inner: ConnectionApprovalCard = { ...card, proposalId: "prop_inner", callId: `${script.callId}/c2` };
const cardItem = (approval: ConnectionApprovalCard): CardItem => ({
	kind: "card",
	id: `c:${approval.proposalId}`,
	at: NOW,
	card: approval,
});

const proposal: Proposal = {
	id: "prop_pr",
	organisationId: "org_1" as Proposal["organisationId"],
	requester: {
		actor: { kind: "agent", agentId: "agent_1" as never, sessionId: "sess_1" as never },
		agentId: "agent_1" as never,
		sessionId: "sess_1" as never,
	},
	kind: "request",
	terms: {
		route: { host: "api.github.com", methods: ["POST"], pathPrefix: "/repos/tvdavies/harbour/pulls" },
		lifetime: { maxUses: 1 },
		reason: "Opening the PR you asked for.",
		request: {
			connectionId: "conn_github",
			connectionName: "GitHub",
			kind: "http",
			method: "POST",
			host: "api.github.com",
			path: "/repos/tvdavies/harbour/pulls",
			digest: "d1",
		} as never,
	},
	termsHash: "hash_1",
	bindingCode: "K7Q-2MX",
	status: "pending",
	createdAt: NOW - 5000,
	expiresAt: NOW + 600_000,
	link: "/connections/requests/prop_pr",
};

describe("callApprovals", () => {
	it("takes a card out of the transcript when its call is on screen, and finds it by the call", () => {
		const items: TranscriptItem[] = [call, cardItem(card)];
		const shown = callApprovals(items);
		expect(shown.items).toEqual([call]);
		expect(shown.cards.of(call.callId)).toBe(card);
		expect(shown.moved).toEqual([card]);
	});

	it("finds a script's inner request's card under the script", () => {
		const shown = callApprovals([script, cardItem(inner)]);
		expect(shown.items).toEqual([script]);
		expect(shown.cards.inScript(script.callId)).toEqual([inner]);
		expect(shown.cards.of(inner.callId!)).toBe(inner);
	});

	it("leaves a card whose call isn't loaded, or that names none, where it is, and the items the same array", () => {
		const { callId: _, ...withoutCall } = card;
		const items: TranscriptItem[] = [cardItem(card), cardItem(withoutCall)];
		const shown = callApprovals(items);
		expect(shown.items).toBe(items);
		expect(shown.cards.of(call.callId)).toBeUndefined();
	});
});

describe("the approval's words", () => {
	it("says what the request does in one sentence", () => {
		expect(approvalTitle(card)).toBe("Open a pull request in tvdavies/harbour");
	});

	it("reads the person's own decision before the card says it, and the clock", () => {
		expect(approvalState(card, undefined, NOW)).toBe("pending");
		expect(approvalState(card, "approved", NOW)).toBe("approved");
		expect(approvalState(card, undefined, card.expiresAt)).toBe("expired");
		expect(approvalState({ ...card, status: "denied" }, "approved", NOW)).toBe("denied");
	});

	it("says who decided", () => {
		expect(settledWords("approved", "Tom Davies")).toBe("Approved by Tom Davies");
		expect(settledWords("denied", undefined)).toBe("Denied by a person");
		expect(settledWords("expired", undefined)).toBe("Expired, nobody answered");
		expect(timeLeftText(NOW + 582_000, NOW)).toBe("9:42 left");
	});
});

describe("inCallDecision", () => {
	it("approves the terms the vault holds with the card's own code", () => {
		expect(inCallDecision(card, proposal)).toEqual({
			proposalId: "prop_pr",
			outcome: "approve",
			termsHash: "hash_1",
			pickedCode: "K7Q-2MX",
		});
	});

	it("refuses when the vault holds another request than the card shows", () => {
		expect(() => inCallDecision(card, { ...proposal, bindingCode: "ZZZ-000" })).toThrow(ApprovalMismatch);
		expect(() =>
			inCallDecision(card, {
				...proposal,
				terms: { ...proposal.terms, request: { ...proposal.terms.request!, digest: "other" } },
			}),
		).toThrow(ApprovalMismatch);
	});
});

describe("sessionRule", () => {
	it("allows the request's operation for its session alone, linked to the approval", () => {
		expect(sessionRule(proposal)).toEqual({
			who: { kind: "session", sessionId: "sess_1" },
			what: { kind: "endpoint", method: "POST", path: "/repos/tvdavies/harbour/pulls", host: "api.github.com" },
			action: "allow",
			note: "From approval prop_pr, for this session",
		});
	});
});

describe("approvalRefusal", () => {
	it("says nothing was approved, and why", () => {
		expect(approvalRefusal(new PasskeyCancelled())).toBe("You cancelled the passkey, so nothing was approved.");
		expect(approvalRefusal(new RuleNotSaved(new KantelError("forbidden", "No")))).toMatch(/can't add rules/);
		expect(approvalRefusal(new KantelError("expired", "Expired"))).toMatch(/expired/);
		expect(approvalRefusal(new KantelError("refused", "Wrong code"))).toMatch(/may have changed/);
		expect(approvalRefusal(new Error("offline"), "deny")).toBe(
			"Kantel didn't answer, so the request wasn't denied. Try again in a moment.",
		);
	});
});

describe("the approval in its call", () => {
	const actions = (decided?: "approved"): ConnectionApprovalActions => ({
		approve: async () => undefined,
		deny: async () => undefined,
		alwaysAllowRule: async () => undefined,
		alwaysAllow: async () => undefined,
		canManage: () => true,
		passkey: false,
		decided: () => (decided === undefined ? undefined : { outcome: decided, by: "Tom Davies" }),
	});
	const render = (node: ReactNode, items: readonly TranscriptItem[], given?: ConnectionApprovalActions) =>
		renderToStaticMarkup(
			createElement(
				ToolRenderersContext.Provider,
				{ value: DEFAULT_TOOL_RENDERERS },
				createElement(
					ConnectionApprovalsContext.Provider,
					{ value: { cards: callApprovals(items).cards, actions: given, now: NOW } },
					node,
				),
			),
		);

	it("puts the request and its four choices under the run that waits on it, with no code to type", () => {
		const html = render(
			createElement(ToolRunRow, { items: [call], run: CONNECTION_RUN, active: true }),
			[call, cardItem(card)],
			actions(),
		);
		expect(html).toContain("Open a pull request in tvdavies/harbour");
		for (const choice of ["Approve once", "Allow for this session", "Always allow…", "Deny"])
			expect(html).toContain(choice);
		expect(html).not.toContain("K7Q-2MX");
		expect(html).toContain("&quot;title&quot;");
	});

	it("offers only once and Deny to someone who doesn't manage the connection", () => {
		const html = render(
			createElement(ToolRunRow, { items: [call], run: CONNECTION_RUN, active: true }),
			[call, cardItem(card)],
			{
				...actions(),
				canManage: () => false,
			},
		);
		expect(html).toContain("Approve once");
		expect(html).not.toContain("Allow for this session");
		expect(html).toContain("Only someone who manages GitHub can allow requests like this for longer.");
	});

	it("settles to one line saying who decided", () => {
		const done: ToolItem = { ...call, status: "done", endedAt: NOW };
		const html = render(
			createElement(ToolRunRow, { items: [done], run: CONNECTION_RUN }),
			[done, cardItem(card)],
			actions("approved"),
		);
		expect(html).toContain("Approved by Tom Davies");
		expect(html).not.toContain("Approve once");
	});

	it("shows the code and the request page to a host that can't decide", () => {
		const html = render(createElement(ToolRunRow, { items: [call], run: CONNECTION_RUN, active: true }), [
			call,
			cardItem(card),
		]);
		expect(html).toContain("K7Q-2MX");
		expect(html).toContain("Open request");
		expect(html).not.toContain("Approve once");
	});

	it("puts a script's inner request under the script's row", () => {
		const html = render(createElement(ToolCallChip, { item: script }), [script, cardItem(inner)], actions());
		expect(html).toContain("Approve once");
	});

	it("shows nothing for a pending card whose call stopped", () => {
		const stopped: ToolItem = { ...call, status: "error", endedAt: NOW };
		const html = render(
			createElement(ToolRunRow, { items: [stopped], run: CONNECTION_RUN }),
			[stopped, cardItem(card)],
			actions(),
		);
		expect(html).not.toContain("Approve once");
		expect(html).not.toContain("Approved by");
	});
});
