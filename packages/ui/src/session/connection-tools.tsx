import type { ConnectionApprovalCard, ConnectionCallOperation, ToolItem } from "@kantel/protocol";
import { createContext, type ReactNode, useContext } from "react";
import { Code } from "../code/code.tsx";
import { JsonViewer } from "../code/json-viewer.tsx";
import { ProviderLogo } from "../connections/provider-logo.tsx";
import { Disclosure } from "../primitives/controls.tsx";
import { ScriptIcon } from "../primitives/lucide.tsx";
import { Badge, type BadgeTone } from "../primitives/status.tsx";
import { Field, FieldList } from "../primitives/surface.tsx";
import { formatBytes } from "../workspace/workspace-model.ts";
import { ConnectionApproval, ConnectionApprovalsContext } from "./connection-approval.tsx";
import {
	ACCESS_WORDS,
	bodyBytes,
	type CallUse,
	CONNECTION_TOOLS,
	type ConnectionCallConnection,
	type ConnectionCallRequest,
	type ConnectionCallResult,
	type ConnectionCalls,
	callUseOf,
	connectionCallLabel,
	connectionCallNote,
	connectionOfCall,
	connectionRequestOf,
	connectionResultOf,
	decisionOfUse,
	jsonBody,
	labelOfUse,
	mediaType,
	namesList,
	refusalReason,
	refusedCall,
	requestsWords,
	requestTime,
	resultCount,
	runCounts,
	SCRIPT_TOOL,
	scriptCallUses,
	scriptCode,
	scriptNote,
	scriptRequests,
	scriptResultOf,
	serviceOfCall,
	type UseDecision,
} from "./connection-calls-model.ts";
import { serviceOf } from "./connection-operations.ts";
import type {
	ToolDetailProps,
	ToolRenderer,
	ToolRun,
	ToolRunIconProps,
	ToolRunUnderProps,
} from "./tool-renderer-model.ts";
import { ToolCard } from "./tool-views.tsx";

// The connection tools (`connection_request`, `connection_call`) and code mode's scripts (`codemode`) in the tool
// renderer registry (tool-renderer-model.ts), as the browser's tools are (browser-tools.tsx). A connection call reads
// as the service and what it did, not as "Calling connection_request": the service's logo, the operation in words
// ("Search pull requests: author tvdavies, created 31 Oct", connection-operations.ts) and how it went (a 200, a 403
// and why under the row). Consecutive calls are one run: "Used GitHub as tvdavies, 3 requests, 1 refused". Opened, a
// call shows its request line, its connection, what decided it, its response in a JSON viewer, and the raw call one
// switch away. A script reads "Ran a script, 9 GitHub requests" and opens to those requests, its code and its output.
//
// Each call shows once, as it was made: the session's API and stream keep every call (its arguments and text result)
// whatever renders it here, and the raw switch shows them. What the host knows (its connections and the session's uses
// of them, `ConnectionCallsContext`) fills in the account, the owner and the decision; without it a call still reads
// from its arguments and result.

/**
 * What the host knows of the session's connection calls: its connections and its uses (`connectionCalls`). The console
 * provides it around the transcript. Without it, calls read from their arguments and results alone.
 */
export const ConnectionCallsContext = createContext<ConnectionCalls | undefined>(undefined);

/** A connection's logo at an icon's size, or its first letter in a tile. */
function Logo({ connection, service }: { connection: ConnectionCallConnection | undefined; service: string }) {
	return <ProviderLogo name={connection?.name ?? service} icon={connection?.icon} size="icon" />;
}

/** The connection a call used and the service it went to, from the host's records and its arguments. */
function useCallConnection(item: ToolItem): {
	request: ConnectionCallRequest;
	connection: ConnectionCallConnection | undefined;
	service: string;
	calls: ConnectionCalls | undefined;
} {
	const calls = useContext(ConnectionCallsContext);
	const request = connectionRequestOf(item);
	const connection = connectionOfCall(item, calls?.connection(request.connectionId ?? item.connection?.connection.id));
	return { request, connection, service: serviceOfCall(request, connection) ?? "the connection", calls };
}

/** A connection call's icon: its service's logo. */
function CallIcon({ item }: { item: ToolItem }) {
	const { connection, service } = useCallConnection(item);
	return <Logo connection={connection} service={service} />;
}

/** A response status's badge tone: done for 2xx, error for 4xx and 5xx. */
const statusTone = (status: number): BadgeTone => (status >= 400 ? "error" : status >= 300 ? "neutral" : "done");

/** How a call went, beside its words: its status and what it holds, why nothing was sent, or what it waits for. */
function CallStatus({ item }: { item: ToolItem }) {
	const { service } = useCallConnection(item);
	const approval = useContext(ConnectionApprovalsContext)?.cards.of(item.callId);
	const result = connectionResultOf(item);
	if (item.status === "running" && approval?.status === "pending") {
		return (
			<span className="kt-connection-status ml-3 inline-flex flex-none items-center gap-1.5 text-xs text-faint">
				<Badge tone="approval">Waiting for you</Badge>
			</span>
		);
	}
	// A preview of a list says how many it kept of how many (#465).
	const previewed =
		result.kind === "response" ? /^the first ([\d,]+) of ([\d,]+) items$/.exec(result.kept ?? "") : null;
	const counted =
		previewed !== null
			? `${previewed[1]} of ${previewed[2]} items`
			: result.kind === "response" && result.status < 400
				? resultCount(result.body)
				: undefined;
	return (
		<span className="kt-connection-status ml-3 inline-flex flex-none items-center gap-1.5 text-xs text-faint">
			<ResultBadge result={result} service={service} />
			{counted === undefined ? null : <span>{counted}</span>}
		</span>
	);
}

function ResultBadge({ result, service }: { result: ConnectionCallResult; service: string }) {
	switch (result.kind) {
		case "waiting":
			return <span>Waiting for {service}</span>;
		case "response":
			return <Badge tone={statusTone(result.status)}>{result.status}</Badge>;
		case "refused":
			return result.code === "approval_pending" ? (
				<Badge tone="approval">Needs approval</Badge>
			) : (
				<Badge tone="error">{refusedCall(result) ? "Refused" : "Failed"}</Badge>
			);
		case "tool":
			return result.failed ? <Badge tone="error">Failed</Badge> : null;
		default:
			return null;
	}
}

/** The names of a run's connections, in the order it used them, and the account when it used one. */
function useRunConnections(calls: readonly ToolItem[]): {
	names: readonly string[];
	account: string | undefined;
	first: { connection: ConnectionCallConnection | undefined; service: string };
} {
	const host = useContext(ConnectionCallsContext);
	const names: string[] = [];
	const accounts = new Set<string | undefined>();
	let first: { connection: ConnectionCallConnection | undefined; service: string } | undefined;
	for (const call of calls) {
		const request = connectionRequestOf(call);
		const connection = connectionOfCall(call, host?.connection(request.connectionId));
		const name = serviceOfCall(request, connection) ?? "a connection";
		first ??= { connection, service: name };
		if (!names.includes(name)) names.push(name);
		accounts.add(connection?.account);
	}
	const [account] = accounts;
	return {
		names,
		account: names.length === 1 && accounts.size === 1 ? account : undefined,
		first: first ?? { connection: undefined, service: "" },
	};
}

/** A run's words: "Using GitHub" while it runs, "Used GitHub as tvdavies" once done, "Used GitHub and Linear". */
function RunTitle({ calls, running }: { calls: readonly ToolItem[]; running: boolean }) {
	const { names, account } = useRunConnections(calls);
	return (
		<>
			{running ? "Using" : "Used"} {namesList(names)}
			{account === undefined ? null : <span className="kt-connection-account"> as {account}</span>}
		</>
	);
}

/** A run's icon: its first connection's logo. */
function RunIcon({ calls }: ToolRunIconProps) {
	const { first } = useRunConnections(calls);
	return <Logo connection={first.connection} service={first.service} />;
}

/** The approvals a stretch of calls waits on, or waited on, one under the other. */
function Approvals({ shown }: { shown: readonly { call: ToolItem; card: ConnectionApprovalCard; inner?: true }[] }) {
	const host = useContext(ConnectionCallsContext);
	if (shown.length === 0) return null;
	return (
		<div className="kt-connection-approvals mt-2 mb-1 flex min-w-0 flex-col gap-2">
			{shown.map(({ call, card, inner }) => {
				const request = inner === true ? undefined : connectionRequestOf(call);
				return (
					<ConnectionApproval
						key={card.proposalId}
						card={card}
						running={call.status === "running"}
						connection={host?.connection(card.request?.connectionId)}
						body={request?.kind === "http" ? request.body : undefined}
						operation={inner === true ? undefined : call.connection?.request.operation}
					/>
				);
			})}
		</div>
	);
}

/** Under a run's line: the approval each of its calls waits on, in place of a card further down the transcript. */
function RunApprovals({ calls }: ToolRunUnderProps) {
	const approvals = useContext(ConnectionApprovalsContext);
	if (approvals === undefined) return null;
	const shown = calls.flatMap((call) => {
		const card = approvals.cards.of(call.callId);
		return card === undefined ? [] : [{ call, card }];
	});
	return <Approvals shown={shown} />;
}

/** Under a script's row: the approvals its own connection requests wait on. */
function ScriptApprovals({ item }: { item: ToolItem }) {
	const approvals = useContext(ConnectionApprovalsContext);
	if (approvals === undefined) return null;
	const shown = approvals.cards.inScript(item.callId).map((card) => ({ call: item, card, inner: true as const }));
	return <Approvals shown={shown} />;
}

/** A run of connection calls (`ToolRun`): one line for every stretch of them, whichever connections they used. */
export const CONNECTION_RUN: ToolRun = {
	id: "connection",
	summary: (calls, { running }) => {
		const { count, failed, allRefused } = runCounts(calls);
		const current = running ? (calls.findLast((call) => call.status === "running") ?? calls.at(-1)) : undefined;
		return {
			title: <RunTitle calls={calls} running={running} />,
			detail: current === undefined ? `${count} ${count === 1 ? "request" : "requests"}` : connectionCallLabel(current),
			...(failed === 0 ? {} : { failed, failedWord: allRefused ? "refused" : "failed" }),
		};
	},
	icon: RunIcon,
	under: RunApprovals,
};

/** One query parameter as a chip: its name quiet, its value in full. */
function QueryChip({ name, value }: { name: string; value: string }) {
	return (
		<li className="kt-connection-query inline-flex min-w-0 max-w-full items-baseline gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-xs">
			<span className="text-faint">{name}</span>
			<span className="text-fg wrap-anywhere">{value}</span>
		</li>
	);
}

/** An MCP tool's arguments as name and value pairs, for chips as a query's: a value that isn't text as JSON. */
function argumentPairs(args: unknown): (readonly [string, string])[] {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
	return Object.entries(args).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]);
}

/** "GET api.github.com/search/issues": the method quiet, the host at full strength, the path muted. */
function RequestLine({ request }: { request: Extract<ConnectionCallRequest, { kind: "http" }> }) {
	const { parts } = request;
	return (
		<span className="kt-connection-request min-w-0 truncate font-mono text-code" title={request.url}>
			<span className="text-faint">{request.method}</span>{" "}
			{parts === undefined ? (
				<span className="text-fg">{request.url}</span>
			) : (
				<>
					<span className="font-medium text-fg">{parts.host}</span>
					<span className="text-muted">{parts.path}</span>
				</>
			)}
		</span>
	);
}

/** The connection a call used: its logo and name, the account it acts as, and whose it is. */
function ConnectionFields({
	connection,
	service,
}: {
	connection: ConnectionCallConnection | undefined;
	service: string;
}) {
	const name =
		connection?.href === undefined ? (
			<span>{connection?.name ?? service}</span>
		) : (
			<a className={link} href={connection.href}>
				{connection.name}
			</a>
		);
	return (
		<>
			<Field label="Connection">
				<span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1">
					{/* On the words' baseline, taking no room above it, then up onto the middle of their capitals. Only a
					    logo: a letter tile beside the name would say its first letter twice. */}
					{connection?.icon === undefined ? null : (
						<span className="-mt-icon-md inline-flex translate-y-(--kt-on-cap)">
							<Logo connection={connection} service={service} />
						</span>
					)}
					{name}
					{connection?.account === undefined ? null : (
						<span>
							as <span className="font-medium">{connection.account}</span>
						</span>
					)}
				</span>
			</Field>
			{connection?.owner === undefined ? null : (
				<Field label="Owner">
					{connection.owner}
					{connection.shared === true ? <span className="text-muted">, shared with this project</span> : null}
				</Field>
			)}
		</>
	);
}

/** A link in the opened view's facts. */
const link = "kt-focusable text-fg underline decoration-border-strong underline-offset-2 hover:decoration-fg";

/** A fact led by its badge, as the status leads a response line: "[200] application/json, 84 bytes, 1.8s". */
function Badged({ badge, children }: { badge: ReactNode; children: ReactNode }) {
	return (
		<span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
			{badge}
			<span className="min-w-0">{children}</span>
		</span>
	);
}

/** What decided a request: its use's decision, with a link to the connection's rules when a rule did. */
function DecisionField({
	decision,
	connection,
}: {
	decision: UseDecision;
	connection: ConnectionCallConnection | undefined;
}) {
	return (
		<Field label="Decided by">
			<Badged badge={<Badge tone={decision.tone}>{decision.badge}</Badge>}>
				{decision.rule && connection?.href !== undefined ? (
					<a className={link} href={connection.href}>
						{decision.words}
					</a>
				) : (
					decision.words
				)}
			</Badged>
		</Field>
	);
}

/** What a request did, as its connection's template classifies it (#465): "Comment on tvdavies/harbour#12" [Writes]. */
function OperationField({ operation }: { operation: ConnectionCallOperation }) {
	return (
		<Field label="Operation">
			<Badged
				badge={
					<Badge tone={operation.access === "read" ? "neutral" : "approval"}>{ACCESS_WORDS[operation.access]}</Badge>
				}
			>
				{operation.label}
				{operation.resource === undefined || operation.label.includes(operation.resource) ? null : (
					<span className="text-muted"> in {operation.resource}</span>
				)}
			</Badged>
		</Field>
	);
}

/** "200, application/json, 84 bytes, 1.8s", or what came instead of an answer. */
function ResponseField({ item, result, service }: { item: ToolItem; result: ConnectionCallResult; service: string }) {
	const took = item.endedAt === undefined ? undefined : requestTime(item.endedAt - item.at);
	switch (result.kind) {
		case "waiting":
			return <Field label="Response">Waiting for {service}</Field>;
		case "response": {
			const facts = [
				mediaType(result.contentType),
				result.cut === undefined
					? formatBytes(bodyBytes(result.body))
					: `${formatBytes(bodyBytes(result.body))} kept of ${formatBytes(bodyBytes(result.body) + result.cut)}`,
				took,
			].filter((fact): fact is string => fact !== undefined && fact !== "");
			return (
				<Field label="Response">
					<Badged badge={<Badge tone={statusTone(result.status)}>{result.status}</Badge>}>{facts.join(", ")}</Badged>
				</Field>
			);
		}
		case "refused":
			return (
				<Field label="Response">
					<Badged badge={<Badge tone={result.code === "approval_pending" ? "approval" : "error"}>Not sent</Badge>}>
						{refusalReason(result.code, result.message)}
					</Badged>
				</Field>
			);
		case "tool":
			return (
				<Field label="Response">
					<Badged badge={result.failed ? <Badge tone="error">Failed</Badge> : null}>
						{took === undefined ? "The tool answered" : `The tool answered in ${took}`}
					</Badged>
				</Field>
			);
		case "interrupted":
			return <Field label="Response">Stopped before it answered</Field>;
	}
}

/** A scrolling block the keyboard can reach, as a tool's output is: the answer's body. */
const bodyFrame =
	"kt-connection-body kt-focusable max-h-(--kt-tool-output-height) min-w-0 overflow-auto rounded-sm bg-code-surface px-2.5 py-2";

const textBody = `${bodyFrame} kt-selectable m-0 font-mono text-code whitespace-pre-wrap text-fg wrap-anywhere select-text`;

/** The answer's body: a JSON viewer folded past its first level, or the text as it came. */
function ResponseBody({ result }: { result: ConnectionCallResult }) {
	const body = result.kind === "response" ? result.body : result.kind === "tool" ? result.text : "";
	const notes = [
		...(result.kind === "response" && result.cut !== undefined
			? [
					{
						message:
							result.kept === undefined
								? "The agent was given the start of this answer. A script gets all of it."
								: `The agent was given a preview of this answer, keeping ${result.kept}. A script gets all of it.`,
					},
				]
			: []),
		...(result.kind === "response" ? result.notes : []),
	];
	const json = jsonBody(body);
	return (
		<>
			{body.trim() === "" ? null : json !== undefined ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
				<div className={bodyFrame} tabIndex={0}>
					<JsonViewer value={json.value} label="The response" />
				</div>
			) : (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
				<pre className={textBody} tabIndex={0}>
					{body.trim()}
				</pre>
			)}
			{notes.length === 0 ? null : (
				<ul className="kt-connection-notes m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-status-approval">
					{notes.map((note) => (
						<li key={note.message}>{note.message}</li>
					))}
				</ul>
			)}
		</>
	);
}

/** What the call sent besides its URL: its headers, and its body for a write. */
function RequestExtras({ request }: { request: Extract<ConnectionCallRequest, { kind: "http" }> }) {
	if (request.headers.length === 0 && request.body === undefined) return null;
	const said = [
		request.headers.length === 0
			? undefined
			: `${request.headers.length} ${request.headers.length === 1 ? "header" : "headers"}`,
		request.body === undefined ? undefined : "a body",
	].filter((part) => part !== undefined);
	return (
		<Disclosure className="kt-connection-sent text-xs" summary={`What it sent: ${said.join(" and ")}`}>
			<div className="flex min-w-0 flex-col gap-1.5">
				{request.headers.length === 0 ? null : (
					<ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-code">
						{request.headers.map(([name, value]) => (
							<li key={name} className="wrap-anywhere">
								<span className="text-faint">{name}:</span> <span className="text-fg">{value}</span>
							</li>
						))}
					</ul>
				)}
				{request.body === undefined ? null : (
					<pre className="kt-selectable m-0 rounded-sm bg-code-surface px-2.5 py-2 font-mono text-code whitespace-pre-wrap wrap-anywhere text-fg">
						<Code code={request.body} language={jsonBody(request.body) === undefined ? undefined : "json"} />
					</pre>
				)}
			</div>
		</Disclosure>
	);
}

/** A section of the opened view. */
const sectionClass = "flex min-w-0 flex-col gap-2 px-3 py-2.5";

/**
 * A connection call, opened: the request line (the host emphasised, the query as chips; an MCP tool's name, its arguments
 * as chips), the connection, account and owner, what decided it, the response's status, type, size and time, the body
 * in a JSON viewer, and the raw call.
 */
function ConnectionCallDetail({ item, raw, showRaw, onShowRawChange }: ToolDetailProps) {
	const { request, connection, service, calls } = useCallConnection(item);
	const result = connectionResultOf(item);
	const use = callUseOf(item, calls?.useOf(item.callId));
	const operation = item.connection?.request.operation ?? use?.operation;
	const chips = request.kind === "http" ? (request.parts?.query ?? []) : argumentPairs(request.arguments);
	return (
		<ToolCard
			item={item}
			icon={<Logo connection={connection} service={service} />}
			title={
				request.kind === "http" ? (
					<RequestLine request={request} />
				) : (
					<span className="min-w-0 truncate font-mono text-code text-fg">{request.tool}</span>
				)
			}
			{...(request.kind === "http" && request.url !== "" ? { copy: { text: request.url, label: "Copy the URL" } } : {})}
			raw={showRaw}
			onRawChange={onShowRawChange}
		>
			{showRaw ? (
				raw
			) : (
				<div className="kt-connection-call flex min-w-0 flex-col text-sm">
					<div className={sectionClass}>
						{chips.length > 0 ? (
							<ul
								className="m-0 flex list-none flex-wrap gap-1.5 p-0"
								aria-label={request.kind === "http" ? "Query" : "Arguments"}
							>
								{chips.map(([name, value], index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: a query's parameters never reorder, and may repeat.
									<QueryChip key={index} name={name} value={value} />
								))}
							</ul>
						) : null}
						<FieldList>
							<ConnectionFields connection={connection} service={service} />
							{operation === undefined ? null : <OperationField operation={operation} />}
							{use === undefined ? null : <DecisionField decision={decisionOfUse(use)} connection={connection} />}
							<ResponseField item={item} result={result} service={service} />
						</FieldList>
						{request.kind === "http" ? <RequestExtras request={request} /> : null}
					</div>
					{result.kind === "response" || result.kind === "tool" ? (
						<div className={`${sectionClass} border-t border-border`}>
							<ResponseBody result={result} />
						</div>
					) : null}
				</div>
			)}
		</ToolCard>
	);
}

/** The connection tools' entry: each call one step of a connection run. */
const connectionCallRenderer: ToolRenderer = {
	tools: CONNECTION_TOOLS,
	run: CONNECTION_RUN,
	label: connectionCallLabel,
	icon: CallIcon,
	trailing: CallStatus,
	note: connectionCallNote,
	detail: (props) => <ConnectionCallDetail {...props} />,
};

/** A script's requests, from the host's uses: "9 GitHub requests", and how many were refused or are waiting. */
function ScriptRequests({ item }: { item: ToolItem }) {
	const calls = useContext(ConnectionCallsContext);
	const uses = scriptCallUses(item, calls);
	if (uses.length === 0) return null;
	const { count, services, refused, waiting } = scriptRequests(uses, calls);
	return (
		<span className="kt-script-requests flex-none text-faint">
			, {requestsWords(count, services)}
			{waiting === 0 ? null : <span className="text-status-approval">, {waiting} waiting for you</span>}
			{refused === 0 ? null : <span className="text-status-error">, {refused} refused</span>}
		</span>
	);
}

/** Consecutive uses of one request, one row each: a script that pages through a list makes the same request again. */
function sameRequests(uses: readonly CallUse[]): { use: CallUse; times: number }[] {
	const rows: { use: CallUse; times: number }[] = [];
	for (const use of uses) {
		const last = rows.at(-1);
		if (
			last !== undefined &&
			last.use.connectionId === use.connectionId &&
			last.use.method === use.method &&
			last.use.host === use.host &&
			last.use.path === use.path &&
			last.use.outcome === use.outcome &&
			last.use.reason === use.reason
		)
			last.times += 1;
		else rows.push({ use, times: 1 });
	}
	return rows;
}

/** One of a script's requests, compact: the service's logo, what it did, how often, and how it was decided. */
function ScriptRequestRow({ use, times }: { use: CallUse; times: number }) {
	const calls = useContext(ConnectionCallsContext);
	const connection = calls?.connection(use.connectionId);
	const decision = decisionOfUse(use);
	return (
		<li className="kt-script-request flex min-w-0 flex-col gap-0.5">
			<span className="flex min-w-0 items-center gap-2">
				<span className="inline-flex flex-none">
					<Logo connection={connection} service={serviceOf(use.host)} />
				</span>
				<span className="min-w-0 truncate text-fg" title={`${use.method} ${use.host}${use.path}`}>
					{labelOfUse(use)}
				</span>
				{times === 1 ? null : <span className="flex-none text-xs text-faint">{times} times</span>}
				<Badge tone={decision.tone}>{decision.badge}</Badge>
			</span>
			{use.outcome === "allowed" ? null : (
				<span className="ml-[calc(var(--kt-icon-md)_+_var(--kt-step-2))] text-xs text-status-error wrap-anywhere">
					{decision.words}
				</span>
			)}
		</li>
	);
}

const scriptLabel = "text-xs text-faint";
const scriptPre =
	"kt-selectable kt-focusable m-0 max-h-(--kt-tool-output-height) overflow-auto rounded-sm bg-code-surface px-2.5 py-2 font-mono text-code leading-normal whitespace-pre-wrap wrap-anywhere select-text";

/** A script, opened: the requests it made (from the host's uses), its code, and its output or error. */
function ScriptDetail({ item, raw, showRaw, onShowRawChange }: ToolDetailProps) {
	const calls = useContext(ConnectionCallsContext);
	const uses = scriptCallUses(item, calls);
	const result = scriptResultOf(item);
	const code = scriptCode(item);
	const running = item.status === "running";
	return (
		<ToolCard
			item={item}
			icon={<ScriptIcon size="sm" />}
			title={<span className="text-fg">Script</span>}
			meta={result.wallTime === undefined ? undefined : <span>Ran for {result.wallTime}</span>}
			{...(code === "" ? {} : { copy: { text: code, label: "Copy the script" } })}
			raw={showRaw}
			onRawChange={onShowRawChange}
		>
			{showRaw ? (
				raw
			) : (
				<div className="kt-script flex min-w-0 flex-col gap-3 px-3 py-2.5 text-sm">
					{uses.length === 0 ? null : (
						<section className="flex min-w-0 flex-col gap-1.5" aria-label="Its requests">
							<div className={scriptLabel}>{requestsWords(uses.length, scriptRequests(uses, calls).services)}</div>
							<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
								{sameRequests(uses).map(({ use, times }) => (
									<ScriptRequestRow key={use.id} use={use} times={times} />
								))}
							</ul>
						</section>
					)}
					{code === "" ? null : (
						<section className="flex min-w-0 flex-col gap-1.5" aria-label="The script">
							<div className={scriptLabel}>The script</div>
							{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard. */}
							<pre className={`${scriptPre} text-fg`} tabIndex={0}>
								<Code code={code} language="javascript" />
							</pre>
						</section>
					)}
					<section className="flex min-w-0 flex-col gap-1.5" aria-label="Its output">
						<div className={scriptLabel}>{running ? "Output so far" : result.ok ? "Output" : "Error"}</div>
						{result.output === "" ? (
							<p className="m-0 text-faint">{running ? "Waiting for output" : "No output"}</p>
						) : (
							// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
							<pre className={`${scriptPre} ${result.ok ? "text-fg" : "text-status-error"}`} tabIndex={0}>
								{result.output}
							</pre>
						)}
					</section>
				</div>
			)}
		</ToolCard>
	);
}

/** Code mode's entry: "Running a script", "Ran a script", with the requests it made. */
const scriptRenderer: ToolRenderer = {
	tools: [SCRIPT_TOOL],
	label: (item) => (item.status === "running" ? "Running a script" : "Ran a script"),
	icon: () => <ScriptIcon />,
	trailing: ScriptRequests,
	note: scriptNote,
	under: ScriptApprovals,
	detail: (props) => <ScriptDetail {...props} />,
};

/** The connection tools' and code mode's entries in the tool renderer registry. */
export const connectionToolRenderers: readonly ToolRenderer[] = [connectionCallRenderer, scriptRenderer];
