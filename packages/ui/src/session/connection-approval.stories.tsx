import type { ConnectionRuleInput } from "@kantel/contracts";
import type { CardItem, ConnectionApprovalCard, ToolItem, TranscriptItem } from "@kantel/protocol";
import { type ReactNode, useMemo, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import {
	ConnectionApproval,
	type ConnectionApprovalActions,
	type ConnectionApprovalDecided,
	ConnectionApprovalsContext,
} from "./connection-approval.tsx";
import { callApprovals } from "./connection-approvals-model.ts";
import { connectionCalls } from "./connection-calls-model.ts";
import { CONNECTION_RUN, ConnectionCallsContext } from "./connection-tools.tsx";
import { GITHUB_CONNECTION } from "./fixture-github-session.ts";
import { transcriptFrame } from "./story-frames.ts";
import { ToolCallChip, toolGroup } from "./tool-call.tsx";
import { ToolRenderersContext } from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS } from "./tool-renderers.tsx";
import { ToolRunRow } from "./tool-run.tsx";
import { Transcript } from "./transcript.tsx";

export default { title: "Session/Connection approval" } satisfies StoryDefault;

// A connection request waiting on a person, approved in place in its call (connection-approval.tsx): an illustrative
// write on the GitHub connection of session 3430cd86 (fixture-github-session.ts), which made only reads.

const NOW = Date.UTC(2026, 9, 31, 15, 6);
const GITHUB = { ...GITHUB_CONNECTION, manage: true };
const SHARED_GITHUB = { ...GITHUB_CONNECTION, manage: false };

const PR_BODY = JSON.stringify({
	title: "Console: one spacing scale",
	head: "sal/spacing",
	base: "main",
	body: "Applies the spacing scale to the session view, the connections page and the vault page.",
});

/** The agent's request to open a pull request, still waiting. */
const openPr: ToolItem = {
	kind: "tool",
	id: "ts9:toolu_story_pr",
	callId: "toolu_story_pr",
	name: "connection_request",
	label: "Calling connection_request",
	args: {
		connectionId: GITHUB.id,
		method: "POST",
		url: "https://api.github.com/repos/tvdavies/harbour/pulls",
		headers: { "User-Agent": "harbour-agent", Accept: "application/vnd.github+json" },
		body: PR_BODY,
	},
	status: "running",
	at: NOW - 18_000,
};

/** The read before it, done. */
const listPrs: ToolItem = {
	kind: "tool",
	id: "ts8:toolu_story_list",
	callId: "toolu_story_list",
	name: "connection_request",
	label: "Calling connection_request",
	args: {
		connectionId: GITHUB.id,
		method: "GET",
		url: "https://api.github.com/repos/tvdavies/harbour/pulls?state=open",
	},
	status: "done",
	at: NOW - 40_000,
	endedAt: NOW - 39_400,
	output: 'HTTP 200 (application/json; charset=utf-8)\n\n[{"number":453,"title":"Console: connection calls"}]',
};

const pending: ConnectionApprovalCard = {
	type: "connection.approval",
	proposalId: "prop_story_pr",
	status: "pending",
	bindingCode: "K7Q-2MX",
	what: "POST api.github.com/repos/tvdavies/harbour/pulls through GitHub",
	why: "Opening the PR for the spacing fix you asked for.",
	host: "api.github.com",
	methods: ["POST"],
	pathPrefix: "/repos/tvdavies/harbour/pulls",
	termsSource: "agent-proposed",
	expiresAt: NOW + 9 * 60_000 + 42_000,
	link: "https://harbour.example/connections/requests/prop_story_pr",
	request: {
		connectionId: GITHUB.id,
		connectionName: "GitHub",
		kind: "http",
		method: "POST",
		url: "https://api.github.com/repos/tvdavies/harbour/pulls",
		digest: "9f2c41d07be35a6e18c4f0d2a97b6e51c3d8f40a2be71965d0c3e8f4a1b2c3d4",
	},
	callId: openPr.callId,
};

const sent: ToolItem = {
	...openPr,
	status: "done",
	endedAt: NOW + 30_000,
	output: 'HTTP 201 (application/json; charset=utf-8)\n\n{"number":454,"title":"Console: one spacing scale"}',
};
const refused: ToolItem = {
	...openPr,
	status: "error",
	endedAt: NOW + 30_000,
	output: "approval_denied: a person denied this request, so nothing was sent. Approval prop_story_pr.",
};

/** A script that looks up the open pull requests, then comments on one: its comment waits. */
const script: ToolItem = {
	kind: "tool",
	id: "ts12:toolu_story_script",
	callId: "toolu_story_script",
	name: "codemode",
	label: "Calling codemode",
	args: {
		code: [
			'const open = await tools.connection_request({ connectionId: "conn_github_example", method: "GET",',
			'  url: "https://api.github.com/repos/tvdavies/harbour/pulls?state=open" });',
			"const [latest] = JSON.parse(open.split('\\n\\n')[1]);",
			'await tools.connection_request({ connectionId: "conn_github_example", method: "POST",',
			"  url: `https://api.github.com/repos/tvdavies/harbour/issues/${latest.number}/comments`,",
			'  body: JSON.stringify({ body: "Ready for review." }) });',
		].join("\n"),
	},
	status: "running",
	at: NOW - 12_000,
};
const inScript: ConnectionApprovalCard = {
	...pending,
	proposalId: "prop_story_comment",
	bindingCode: "R4D-9WT",
	what: "POST api.github.com/repos/tvdavies/harbour/issues/453/comments through GitHub",
	why: "Leaving the review note you asked for on the open pull request.",
	pathPrefix: "/repos/tvdavies/harbour/issues/453/comments",
	link: "https://harbour.example/connections/requests/prop_story_comment",
	request: {
		connectionId: GITHUB.id,
		connectionName: "GitHub",
		kind: "http",
		method: "POST",
		url: "https://api.github.com/repos/tvdavies/harbour/issues/453/comments",
		digest: "4b1e0c9a7f3d2e8b6a5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
	},
	callId: `${script.callId}/c2`,
};

const cardItem = (card: ConnectionApprovalCard): CardItem => ({
	kind: "card",
	id: `c:${card.proposalId}`,
	at: NOW,
	card,
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The host's side, as the console gives it, against nothing: deciding takes a moment, then the approval reads as
 * decided by Tom Davies.
 */
function StoryHost({
	children,
	cards,
	manage = true,
	passkey = false,
	decided: given = {},
}: {
	children: ReactNode;
	cards: readonly CardItem[];
	manage?: boolean;
	passkey?: boolean;
	decided?: Readonly<Record<string, ConnectionApprovalDecided>>;
}) {
	const [decided, setDecided] = useState<Readonly<Record<string, ConnectionApprovalDecided>>>(given);
	const actions = useMemo<ConnectionApprovalActions>(() => {
		const decide = (card: ConnectionApprovalCard, next: ConnectionApprovalDecided) =>
			setDecided((current) => ({ ...current, [card.proposalId]: next }));
		return {
			approve: async (card, { scope, onApproving }) => {
				if (passkey) await wait(1200);
				onApproving?.();
				await wait(900);
				decide(card, { outcome: "approved", by: "Tom Davies", scope });
			},
			deny: async (card) => {
				await wait(700);
				decide(card, { outcome: "denied", by: "Tom Davies" });
			},
			alwaysAllowRule: async (card): Promise<ConnectionRuleInput | undefined> => {
				await wait(300);
				return {
					who: { kind: "agent", agentId: "agent_default" },
					what: { kind: "endpoint", method: "POST", path: card.pathPrefix, host: card.host },
					action: "allow",
					note: `From approval ${card.proposalId}`,
				};
			},
			alwaysAllow: async (card, _rule, { onApproving }) => {
				if (passkey) await wait(1200);
				onApproving?.();
				await wait(900);
				decide(card, { outcome: "approved", by: "Tom Davies", scope: "always" });
			},
			canManage: () => manage,
			passkey,
			decided: (proposalId) => decided[proposalId],
		};
	}, [decided, manage, passkey]);
	const { cards: byCall } = callApprovals(cards);
	const host = connectionCalls([manage ? GITHUB : SHARED_GITHUB], []);
	return (
		<ToolRenderersContext.Provider value={DEFAULT_TOOL_RENDERERS}>
			<ConnectionCallsContext.Provider value={host}>
				<ConnectionApprovalsContext.Provider value={{ cards: byCall, actions, now: NOW }}>
					{children}
				</ConnectionApprovalsContext.Provider>
			</ConnectionCallsContext.Provider>
		</ToolRenderersContext.Provider>
	);
}

/** The run the call is the last step of, as the transcript shows it. */
const Run = ({ items }: { items: readonly ToolItem[] }) => (
	<ToolRunRow items={items} run={CONNECTION_RUN} active={items.some((item) => item.status === "running")} />
);

/** The transcript as the console gives it: the card whose call is on screen taken out, shown in the call. */
const session: readonly TranscriptItem[] = [
	{ kind: "user", id: "u1", at: NOW - 60_000, text: "Open a PR for the spacing fix on harbour.", via: "prompt" },
	listPrs,
	openPr,
	cardItem(pending),
];

export const Pending: Story = () => {
	const { items } = callApprovals(session);
	return (
		<Sheet
			title="Waiting for you, in its call"
			intro="The request shows once, where the agent made it: what it wants to do, the request and its body, the agent's reason, and four choices. One click approves; the card in your own session is yours, so there is no code to type."
		>
			<StoryHost cards={[cardItem(pending)]}>
				<div className={transcriptFrame}>
					<Transcript items={items} working />
				</div>
			</StoryHost>
		</Sheet>
	);
};

export const Approving: Story = () => (
	<Sheet
		title="Approving"
		intro="The choice made is busy and the others wait; the line under them says what is happening. Allow for this session approves, then saves the session's rule."
	>
		<StoryHost cards={[cardItem(pending)]}>
			<Column>
				<Section title="Approve once">
					<ConnectionApproval
						card={pending}
						running
						connection={GITHUB}
						body={PR_BODY}
						initial={{ phase: "approving" }}
					/>
				</Section>
				<Section title="Allow for this session">
					<ConnectionApproval card={pending} running connection={GITHUB} initial={{ phase: "session" }} />
				</Section>
				<Section title="Deny">
					<ConnectionApproval card={pending} running connection={GITHUB} initial={{ phase: "denying" }} />
				</Section>
				<Section title="Refused">
					<ConnectionApproval
						card={pending}
						running
						connection={GITHUB}
						initial={{ error: "You need the operator role on Default to decide this request. Nothing was approved." }}
					/>
				</Section>
			</Column>
		</StoryHost>
	</Sheet>
);

export const Approved: Story = () => (
	<Sheet
		title="Approved"
		intro="Once decided the approval settles into one line under the run: who approved it, and what. The run says how the request went."
	>
		<Column>
			<StoryHost
				cards={[cardItem({ ...pending, status: "approved", termsSource: "approved" })]}
				decided={{ prop_story_pr: { outcome: "approved", by: "Tom Davies" } }}
			>
				<Section title="Once">
					<Run items={[listPrs, sent]} />
				</Section>
				<Section title="Sending, just approved">
					<Run items={[listPrs, openPr]} />
				</Section>
			</StoryHost>
			<StoryHost
				cards={[cardItem({ ...pending, status: "approved", termsSource: "approved" })]}
				decided={{ prop_story_pr: { outcome: "approved", by: "Tom Davies", scope: "session" } }}
			>
				<Section title="For this session">
					<Run items={[listPrs, sent]} />
				</Section>
			</StoryHost>
			<StoryHost cards={[cardItem({ ...pending, status: "approved", termsSource: "approved" })]}>
				<Section title="Decided elsewhere">
					<Run items={[listPrs, sent]} />
				</Section>
			</StoryHost>
		</Column>
	</Sheet>
);

export const Denied: Story = () => (
	<Sheet title="Denied" intro="Nothing was sent. The line says who denied it; the run says the request was refused.">
		<StoryHost
			cards={[cardItem({ ...pending, status: "denied" })]}
			decided={{ prop_story_pr: { outcome: "denied", by: "Tom Davies" } }}
		>
			<Run items={[listPrs, refused]} />
		</StoryHost>
	</Sheet>
);

const timedOut: ToolItem = {
	...refused,
	output: "approval_expired: no one decided in time, so nothing was sent. Approval prop_story_pr.",
};

export const Expired: Story = () => (
	<Sheet title="Expired" intro="Nobody answered in ten minutes, so nothing was sent.">
		<StoryHost cards={[cardItem({ ...pending, status: "expired" })]}>
			<Run items={[listPrs, timedOut]} />
		</StoryHost>
	</Sheet>
);

export const PasskeyRequired: Story = () => (
	<Sheet
		title="Passkey required"
		intro="Where the organisation asks for a passkey, Approve once carries its mark and the prompt appears on click; the line under the choices waits for it."
	>
		<StoryHost cards={[cardItem(pending)]} passkey>
			<Column>
				<Section title="Before">
					<ConnectionApproval card={pending} running connection={GITHUB} body={PR_BODY} />
				</Section>
				<Section title="Waiting for the passkey">
					<ConnectionApproval card={pending} running connection={GITHUB} initial={{ phase: "passkey" }} />
				</Section>
				<Section title="Cancelled">
					<ConnectionApproval
						card={pending}
						running
						connection={GITHUB}
						initial={{ error: "You cancelled the passkey, so nothing was approved." }}
					/>
				</Section>
			</Column>
		</StoryHost>
	</Sheet>
);
PasskeyRequired.storyName = "Passkey required";

export const InScript: Story = () => (
	<Sheet
		title="Inside a script"
		intro="A request a code mode script makes that asks shows under the script's row, with the same choices. Its body stays in the script; the request page has it."
	>
		<Column>
			<StoryHost cards={[cardItem(inScript)]}>
				<div className={toolGroup}>
					<ToolCallChip item={script} />
				</div>
			</StoryHost>
			<StoryHost
				cards={[cardItem({ ...inScript, status: "approved", termsSource: "approved" })]}
				decided={{ prop_story_comment: { outcome: "approved", by: "Tom Davies" } }}
			>
				<Section title="Approved">
					<div className={toolGroup}>
						<ToolCallChip item={script} />
					</div>
				</Section>
			</StoryHost>
		</Column>
	</Sheet>
);
InScript.storyName = "In a script";

export const NoManageRights: Story = () => (
	<Sheet
		title="Without rights to the connection's rules"
		intro="Someone who doesn't manage the connection approves once or denies; the line says who can allow more."
	>
		<StoryHost cards={[cardItem(pending)]} manage={false}>
			<Run items={[listPrs, openPr]} />
		</StoryHost>
	</Sheet>
);
NoManageRights.storyName = "No manage rights";

export const WithoutHostActions: Story = () => (
	<Sheet
		title="Without the host's actions"
		intro="A host that renders calls but can't decide shows the code and the request page, as the approval card does."
	>
		<ToolRenderersContext.Provider value={DEFAULT_TOOL_RENDERERS}>
			<ConnectionCallsContext.Provider value={connectionCalls([GITHUB], [])}>
				<ConnectionApprovalsContext.Provider
					value={{ cards: callApprovals([openPr, cardItem(pending)]).cards, now: NOW }}
				>
					<Run items={[listPrs, openPr]} />
				</ConnectionApprovalsContext.Provider>
			</ConnectionCallsContext.Provider>
		</ToolRenderersContext.Provider>
	</Sheet>
);
WithoutHostActions.storyName = "Without host actions";

export const Mobile: Story = () => (
	<Sheet
		title="At 420px"
		intro="The choices wrap, Deny last; the request and its body wrap rather than scroll sideways."
	>
		<StoryHost cards={[cardItem(pending), cardItem(inScript)]}>
			<Column>
				<Run items={[listPrs, openPr]} />
				<div className={toolGroup}>
					<ToolCallChip item={script} />
				</div>
			</Column>
		</StoryHost>
	</Sheet>
);
Mobile.meta = { width: 420 };
