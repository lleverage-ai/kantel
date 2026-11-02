import type { ConnectionUse } from "@kantel/contracts";
import type { ConnectionCallDetails, ToolItem, TranscriptItem } from "@kantel/protocol";
import type { ReactNode } from "react";
import { logo } from "../connections/fixture-logos.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { type ConnectionCallConnection, connectionCalls, SCRIPT_TOOL } from "./connection-calls-model.ts";
import { CONNECTION_RUN, ConnectionCallsContext } from "./connection-tools.tsx";
import { GITHUB_CONNECTION, GITHUB_SESSION, GITHUB_SESSION_USES } from "./fixture-github-session.ts";
import { transcriptFrameTall } from "./story-frames.ts";
import { ToolCallChip, toolGroup } from "./tool-call.tsx";
import { ToolRenderersContext } from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS } from "./tool-renderers.tsx";
import { ToolRunRow } from "./tool-run.tsx";
import { Transcript } from "./transcript.tsx";

export default { title: "Session/Connection calls" } satisfies StoryDefault;

// The connection tools' calls and code mode's scripts (connection-tools.tsx): session 3430cd86's GitHub requests
// (fixture-github-session.ts), and calls made up around them for the states it didn't reach.

const GITHUB = GITHUB_CONNECTION.id;
const LINEAR: ConnectionCallConnection = {
	id: "conn_linear_example",
	name: "Linear",
	templateId: "linear",
	icon: logo("linear"),
	account: "tom@kantel.example",
	owner: "Tom Davies",
	shared: true,
	href: "#connection=conn_linear_example",
};
const LINKED_GITHUB: ConnectionCallConnection = { ...GITHUB_CONNECTION, href: "#connection=conn_github_example" };

const calls = GITHUB_SESSION.filter((item): item is ToolItem => item.kind === "tool");
const requests = calls.filter((call) => call.name === "connection_request");
const scripts = calls.filter((call) => call.name === SCRIPT_TOOL);
const [refused, today] = requests;
const lastWeek = requests.find((call) => call.output?.includes('"total_count":295'));

const NOW = Date.UTC(2026, 9, 31, 15, 30);

/** A request made up in the fixture's shape: its arguments and text result as connection_request gives them. */
function request(
	id: string,
	url: string,
	options: { method?: string; status?: ToolItem["status"]; output?: string; connectionId?: string; body?: string } = {},
): ToolItem {
	const at = NOW - 60_000;
	const status = options.status ?? "done";
	return {
		kind: "tool",
		id,
		callId: `toolu_${id}`,
		name: "connection_request",
		label: "Calling connection_request",
		args: {
			connectionId: options.connectionId ?? GITHUB,
			method: options.method ?? "GET",
			url,
			headers: { "User-Agent": "kantel-agent", Accept: "application/vnd.github+json" },
			...(options.body === undefined ? {} : { body: options.body }),
		},
		status,
		at,
		...(status === "running" ? {} : { endedAt: at + 640 }),
		...(options.output === undefined ? {} : { output: options.output }),
	};
}

const notFound = request("s404", "https://api.github.com/repos/lleverage-ai/lleverage", {
	status: "error",
	output:
		'HTTP 404 (application/json; charset=utf-8)\n\n{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}',
});
const ruleBlocked = request("srule", "https://api.github.com/repos/tvdavies/agent-toolkit/issues/61/comments", {
	method: "POST",
	body: '{"body":"Merged, thanks."}',
	status: "error",
	output: "refused: A rule on GitHub refuses writes to tvdavies/agent-toolkit.",
});
const waiting = request("swait", "https://api.github.com/repos/tvdavies/agent-toolkit/pulls?state=open&per_page=20", {
	status: "running",
});
const mcp: ToolItem = {
	kind: "tool",
	id: "smcp",
	callId: "toolu_smcp",
	name: "connection_call",
	label: "Calling connection_call",
	args: { connectionId: LINEAR.id, tool: "list_issues", arguments: { assignee: "me", state: "started" } },
	status: "done",
	at: NOW - 30_000,
	endedAt: NOW - 29_200,
	output: '[{"identifier":"HAR-459","title":"Show connection calls as the service, account and operation"}]',
};

/** The uses the host has for the made-up calls: what decided each, in the session's first use's shape. */
const [firstUse] = GITHUB_SESSION_USES;
const madeUpUses: readonly ConnectionUse[] =
	firstUse === undefined
		? []
		: [
				{
					...firstUse,
					id: "cu_story_404",
					toolCallId: "toolu_s404",
					path: "/repos/lleverage-ai/lleverage",
					decidedBy: "rule",
					decision: "allow",
					at: NOW - 60_000,
				},
				{
					...firstUse,
					id: "cu_story_rule",
					toolCallId: "toolu_srule",
					method: "POST",
					path: "/repos/tvdavies/agent-toolkit/issues/61/comments",
					outcome: "denied",
					decision: "deny",
					decidedBy: "rule",
					reason: "A rule on GitHub refuses writes to tvdavies/agent-toolkit.",
					at: NOW - 60_000,
				},
			];

const host = connectionCalls([LINKED_GITHUB, LINEAR], [...GITHUB_SESSION_USES, ...madeUpUses]);

/** The registry and the host's data, as the console gives them. */
function Host({ children }: { children: ReactNode }) {
	return (
		<ToolRenderersContext.Provider value={DEFAULT_TOOL_RENDERERS}>
			<ConnectionCallsContext.Provider value={host}>{children}</ConnectionCallsContext.Provider>
		</ToolRenderersContext.Provider>
	);
}

const Run = ({
	items,
	open = false,
	active = false,
}: {
	items: readonly ToolItem[];
	open?: boolean;
	active?: boolean;
}) => <ToolRunRow items={items} run={CONNECTION_RUN} defaultOpen={open} active={active} />;

/** The second turn's first script: a link (`#turn=`) to it opens its turn's work. */
const SECOND_TURN = GITHUB_SESSION.find((item) => item.kind === "tool" && item.name === SCRIPT_TOOL)?.id;

export const Session: Story = () => (
	<Sheet
		title="A session that used GitHub"
		intro="Session 3430cd86, its second turn's work open: two GitHub requests as one run, then eight scripts, each with the GitHub requests it made. Every call shows once, as the service and what it did."
	>
		<ConnectionCallsContext.Provider value={host}>
			<div className={transcriptFrameTall}>
				<Transcript
					items={GITHUB_SESSION as readonly TranscriptItem[]}
					{...(SECOND_TURN === undefined ? {} : { turn: SECOND_TURN })}
				/>
			</div>
		</ConnectionCallsContext.Provider>
	</Sheet>
);

export const Allowed: Story = () => (
	<Sheet
		title="An allowed request"
		intro="The run says the service and the account; each step says what it did and how it went. Opened, the request's line with its query as chips, the connection, what decided it, and the answer folded past its first level."
	>
		<Host>
			<Column>
				<Section title="The run">
					<Run items={[today, lastWeek].filter((call) => call !== undefined)} open />
				</Section>
				<Section title="A step, opened">
					<div className={toolGroup}>
						{lastWeek === undefined ? null : <ToolCallChip item={lastWeek} defaultOpen />}
					</div>
				</Section>
			</Column>
		</Host>
	</Sheet>
);

export const Refused403: Story = () => (
	<Sheet
		title="Refused by GitHub"
		intro="GitHub's own words say why under the row: here, a request without a User-Agent. The run counts it as refused."
	>
		<Host>
			<Column>
				<Section title="The run">
					<Run items={[refused, today].filter((call) => call !== undefined)} open />
				</Section>
				<Section title="The refused step, opened">
					<div className={toolGroup}>{refused === undefined ? null : <ToolCallChip item={refused} defaultOpen />}</div>
				</Section>
			</Column>
		</Host>
	</Sheet>
);
Refused403.storyName = "Refused 403";

export const NotFound404: Story = () => (
	<Sheet
		title="Not found, and refused by a rule"
		intro="A 404 says GitHub's message. A request a rule refused was never sent: the rule's reason is under the row, and the connection's rules are a link away."
	>
		<Host>
			<Column>
				<Section title="The run">
					<Run items={[notFound, ruleBlocked]} />
				</Section>
				<Section title="Both, opened">
					<div className={toolGroup}>
						<ToolCallChip item={notFound} defaultOpen />
						<ToolCallChip item={ruleBlocked} defaultOpen />
					</div>
				</Section>
			</Column>
		</Host>
	</Sheet>
);
NotFound404.storyName = "Not found 404";

export const Waiting: Story = () => (
	<Sheet
		title="Waiting for GitHub"
		intro="While a request runs the run says Using, with the step under way; the step says it is waiting for the service."
	>
		<Host>
			<Column>
				<Section title="The run, under way">
					<Run items={[today, waiting].filter((call) => call !== undefined)} active />
				</Section>
				<Section title="Open">
					<Run items={[today, waiting].filter((call) => call !== undefined)} open active />
				</Section>
				<Section title="The step, opened">
					<div className={toolGroup}>
						<ToolCallChip item={waiting} defaultOpen />
					</div>
				</Section>
			</Column>
		</Host>
	</Sheet>
);

/** Twelve requests across two connections: a run's line names both, and its list scrolls with the transcript. */
const longRun: readonly ToolItem[] = [
	...[1, 2, 3, 4, 5, 6].map((page) =>
		request(`long-${page}`, `https://api.github.com/user/repos?per_page=30&page=${page}&sort=pushed`, {
			output: `HTTP 200 (application/json; charset=utf-8)\n\n[${'{"full_name":"tvdavies/agent-toolkit"},'.repeat(page === 6 ? 2 : 30).slice(0, -1)}]`,
		}),
	),
	request("long-7", "https://api.github.com/repos/tvdavies/agent-toolkit/pulls?state=all&per_page=10", {
		output: 'HTTP 200 (application/json; charset=utf-8)\n\n[{"number":61,"title":"initiative-review-deck"}]',
	}),
	request("long-8", "https://api.github.com/repos/tvdavies/agent-toolkit/actions/runs?per_page=5", {
		output: 'HTTP 200 (application/json; charset=utf-8)\n\n{"total_count":118,"workflow_runs":[]}',
	}),
	notFound,
	mcp,
	request("long-11", "https://api.github.com/users/tvdavies/events?per_page=10", {
		output: 'HTTP 200 (application/json; charset=utf-8)\n\n[{"type":"PushEvent"}]',
	}),
	ruleBlocked,
];

export const LongRun: Story = () => (
	<Sheet
		title="A long run"
		intro="Twelve requests on GitHub and Linear in one run: one line for all of them, the refused and failed counted, each step its operation."
	>
		<Host>
			<Column>
				<Run items={longRun} />
				<Run items={longRun} open />
				<div className={toolGroup}>
					<ToolCallChip item={mcp} defaultOpen />
				</div>
			</Column>
		</Host>
	</Sheet>
);
LongRun.storyName = "Long run";

/** The events call of session 3430cd86, whose 60 KB one-line answer the harness dropped whole. */
const eventsDropped = requests.find((call) => call.output?.includes("bytes dropped"));

/** The same call as connection_request answers it now (#465): a preview that is still JSON, marked as cut. */
const events = Array.from({ length: 100 }, (_, index) => ({
	id: String(52_118_000_000 - index * 7),
	type: index % 3 === 0 ? "PullRequestEvent" : index % 3 === 1 ? "PushEvent" : "IssueCommentEvent",
	actor: { login: "tvdavies", url: "https://api.github.com/users/tvdavies" },
	repo: { name: index % 2 === 0 ? "tvdavies/harbour" : "tvdavies/sal" },
	payload: {
		action: "opened",
		ref: "refs/heads/main",
		size: 1 + (index % 4),
		commits: [
			{ sha: (52_118_000_000 - index).toString(16).padStart(40, "0"), message: "Show the service ".repeat(12) },
		],
	},
	public: true,
	created_at: new Date(Date.UTC(2026, 9, 31, 14) - index * 1_800_000).toISOString(),
}));
const eventsBody = JSON.stringify(events);
/** As many events as fit the 40,000 bytes connection_request gives the model. */
const eventsKept = events.findIndex((_, index) => JSON.stringify(events.slice(0, index + 1)).length > 40_000);
const eventsPreview = JSON.stringify(events.slice(0, eventsKept));
const eventsCut = request("events-preview", "https://api.github.com/users/tvdavies/events?per_page=100", {
	output:
		`HTTP 200 (application/json; charset=utf-8)\n\n${eventsPreview}\n[cut: ${eventsBody.length - eventsPreview.length} more ` +
		`characters. The JSON above is a preview keeping the first ${eventsKept} of 100 items; a code mode script gets the whole body]`,
});

export const LongAnswer: Story = () => (
	<Sheet
		title="A long answer"
		intro="A 60 KB one-line answer used to reach the agent as nothing: the harness dropped the whole line. Now connection_request gives the agent a preview that is still JSON and says what it kept; a script gets the whole answer as an object."
	>
		<Host>
			<Column>
				<Section title="Now: a preview, marked as cut">
					<div className={toolGroup}>
						<ToolCallChip item={eventsCut} defaultOpen />
					</div>
				</Section>
				<Section title="Before: dropped by the harness">
					<div className={toolGroup}>
						{eventsDropped === undefined ? null : <ToolCallChip item={eventsDropped} defaultOpen />}
					</div>
				</Section>
			</Column>
		</Host>
	</Sheet>
);
LongAnswer.storyName = "Long answer";

const nineRequests = scripts.find((script) => host.scriptUses(script.callId).length === 9);
const failedScript = scripts.find((script) => script.status === "error" && host.scriptUses(script.callId).length === 1);

export const InScript: Story = () => (
	<Sheet
		title="Requests inside a script"
		intro="A script reads Ran a script, with the requests it made from the host's records. Opened, those requests in brief, the script and its output; a script that failed says why under its row."
	>
		<Host>
			<Column>
				<div className={toolGroup}>
					{scripts.map((script) => (
						<ToolCallChip key={script.id} item={script} />
					))}
				</div>
				<Section title="Opened">
					<div className={toolGroup}>
						{nineRequests === undefined ? null : <ToolCallChip item={nineRequests} defaultOpen />}
						{failedScript === undefined ? null : <ToolCallChip item={failedScript} defaultOpen />}
					</div>
				</Section>
			</Column>
		</Host>
	</Sheet>
);
InScript.storyName = "In a script";

export const WithoutHostData: Story = () => (
	<Sheet
		title="Without the host's records"
		intro="A host that gives no connections or uses: the service from the request's host, no account, and a script reads Ran a script alone."
	>
		<ToolRenderersContext.Provider value={DEFAULT_TOOL_RENDERERS}>
			<Column>
				<Run items={[refused, today].filter((call) => call !== undefined)} open />
				<div className={toolGroup}>
					{today === undefined ? null : <ToolCallChip item={today} defaultOpen />}
					{nineRequests === undefined ? null : <ToolCallChip item={nineRequests} />}
				</div>
			</Column>
		</ToolRenderersContext.Provider>
	</Sheet>
);
WithoutHostData.storyName = "Without host data";

/** A call's own details (#464), as the API gives them on its tool item: who acted, what it did, what decided it. */
const detailsOf = (
	item: ToolItem,
	fields: {
		method: string;
		path: string;
		query?: string;
		operation: NonNullable<ConnectionCallDetails["request"]["operation"]>;
		outcome: ConnectionCallDetails["outcome"];
		decision: NonNullable<ConnectionCallDetails["decision"]>;
		reason?: string;
		status?: number;
	},
): ToolItem => ({
	...item,
	connection: {
		callId: item.callId,
		connection: {
			id: GITHUB,
			name: "GitHub",
			templateId: "github",
			account: "tvdavies",
			owner: { kind: "project", projectId: "prj_example" },
		},
		request: {
			kind: "http",
			method: fields.method,
			host: "api.github.com",
			path: fields.path,
			...(fields.query === undefined ? {} : { query: fields.query }),
			operation: fields.operation,
		},
		decision: fields.decision,
		outcome: fields.outcome,
		...(fields.reason === undefined ? {} : { reason: fields.reason }),
		...(fields.status === undefined
			? {}
			: { response: { status: fields.status, contentType: "application/json", bytes: 2_210, ms: 640 } }),
	},
});

const listedPulls = detailsOf(
	request("dpulls", "https://api.github.com/repos/tvdavies/harbour/pulls?state=open", {
		output: 'HTTP 200 (application/json; charset=utf-8)\n\n[{"number":499,"title":"Connections: GitHub operations"}]',
	}),
	{
		method: "GET",
		path: "/repos/tvdavies/harbour/pulls",
		query: "state=open",
		operation: {
			id: "pulls/list",
			label: "List pull requests",
			group: "repo",
			access: "read",
			resource: "tvdavies/harbour",
		},
		outcome: "allowed",
		decision: { action: "allow", decidedBy: "rule", ruleId: "rule_reads" },
		status: 200,
	},
);
const refusedComment = detailsOf(
	request("dcomment", "https://api.github.com/repos/tvdavies/harbour/issues/12/comments", {
		method: "POST",
		body: '{"body":"Done."}',
		status: "error",
		output: "refused: A rule on GitHub refuses writes to tvdavies/harbour.",
	}),
	{
		method: "POST",
		path: "/repos/tvdavies/harbour/issues/12/comments",
		operation: {
			id: "issues/create-comment",
			label: "Create an issue comment",
			group: "repo",
			access: "write",
			resource: "tvdavies/harbour",
		},
		outcome: "denied",
		decision: { action: "deny", decidedBy: "rule", ruleId: "rule_writes" },
		reason: "A rule on GitHub refuses writes to tvdavies/harbour.",
	},
);

export const FromDetails: Story = () => (
	<Sheet
		title="From the call's own details"
		intro="No host records: each call's details (#464) say the connection and the account it acted as, what it did as GitHub classifies it, and what decided it."
	>
		<ToolRenderersContext.Provider value={DEFAULT_TOOL_RENDERERS}>
			<Column>
				<Run items={[listedPulls, refusedComment]} open />
				<div className={toolGroup}>
					<ToolCallChip item={listedPulls} defaultOpen />
					<ToolCallChip item={refusedComment} defaultOpen />
				</div>
			</Column>
		</ToolRenderersContext.Provider>
	</Sheet>
);
FromDetails.storyName = "From details";

export const Mobile: Story = () => (
	<Sheet
		title="Connection calls at 420px"
		intro="Rows truncate their words and keep their status; chips and facts wrap."
	>
		<Host>
			<Column>
				<Run items={[refused, today].filter((call) => call !== undefined)} open />
				<div className={toolGroup}>
					{lastWeek === undefined ? null : <ToolCallChip item={lastWeek} defaultOpen />}
					{nineRequests === undefined ? null : <ToolCallChip item={nineRequests} defaultOpen />}
				</div>
			</Column>
		</Host>
	</Sheet>
);
Mobile.meta = { width: 420 };
