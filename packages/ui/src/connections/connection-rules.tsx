// A connection's access rules (#341, design #332): what each agent may do with it, the answer for requests no rule
// covers, and "Try a request", which asks the API what the proxy would do with a request and shows the path the
// decision took. Every change is a call to the public API (`ConnectionRulesSource`); nothing is decided here.
//
// An HTTP connection's rules lead with "What agents may do" (#462, connection-policy.tsx): a grid that reads and
// writes the same rules, with the rule list under Advanced. An MCP server's rules name its tools, so it keeps the list.

import {
	type ConnectionCeiling,
	type ConnectionDecision,
	type ConnectionRule,
	type ConnectionRuleAction,
	type ConnectionRuleInput,
	type ConnectionRules,
	type ConnectionRuleWhat,
	type ConnectionRuleWho,
	type HttpMethod,
	OPERATION_ACCESSES,
	type OperationAccess,
	pathPatternProblem,
	resourcePatternProblem,
	rulesLetUnmatchedThrough,
	whatSpecificity,
	whoSpecificity,
} from "@kantel/contracts";
import { type ReactNode, useId, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { Disclosure, SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormGrid } from "../primitives/form-layout.tsx";
import { CheckIcon, MinusCircleIcon, PencilIcon, PlusIcon, XCircleIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { TrashIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, type BadgeTone } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { ConnectionPolicy } from "./connection-policy.tsx";
import type { Connection, ConnectionRulesSource, ConnectionsViewer } from "./connections-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ACTION_LABELS: Record<ConnectionRuleAction, string> = { allow: "Allow", ask: "Ask", deny: "Deny" };
const ACTION_TONE: Record<ConnectionRuleAction, BadgeTone> = { allow: "done", ask: "approval", deny: "error" };
const ACTION_OPTIONS = (["allow", "ask", "deny"] as const).map((value) => ({ value, label: ACTION_LABELS[value] }));
const UNMATCHED_WORDS: Record<ConnectionRuleAction, string> = {
	allow: "go through",
	ask: "wait for someone to approve them",
	deny: "are refused",
};
const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** A rule's who in words, with project names where the viewer knows them. */
export function whoText(who: ConnectionRuleWho, viewer: Pick<ConnectionsViewer, "projects">): string {
	switch (who.kind) {
		case "any":
			return "Any agent";
		case "attended":
			return "Sessions a person is in";
		case "unattended":
			return "Scheduled runs";
		case "organisation":
			return "Agents outside projects";
		case "project":
			return `In ${viewer.projects.find((p) => p.id === who.projectId)?.name ?? who.projectId}`;
		case "agent":
			return `Agent ${who.agentId}`;
		case "session":
			return `Session ${who.sessionId}`;
	}
}

/** A rule's what, as the request line it matches. */
export function whatText(what: ConnectionRuleWhat): string {
	switch (what.kind) {
		case "any":
			return "Any request";
		case "tool":
			return what.tool;
		case "endpoint":
			return `${what.method === "*" ? "Any" : what.method} ${what.host ?? ""}${what.path}`;
		case "operation":
			return operationText(what);
	}
}

const OPERATION_ACCESS_WORDS: Record<OperationAccess, string> = {
	read: "Reads",
	write: "Writes",
	delete: "Deletes",
	admin: "Admin changes",
};
/** Template permission groups in words; GitHub's are the grid's rows. */
const OPERATION_GROUP_WORDS: Readonly<Record<string, string>> = {
	profile: "your profile",
	repo: "repositories, issues and pull requests",
	workflow: "Actions workflows",
};

/**
 * An operation rule's what (#466) in words: "Writes to repositories, issues and pull requests in tvdavies/harbour",
 * "Deletes", "Any request it classifies".
 */
export function operationText(what: Extract<ConnectionRuleWhat, { kind: "operation" }>): string {
	const access = what.access === undefined ? undefined : OPERATION_ACCESS_WORDS[what.access];
	const group = what.group === undefined ? undefined : (OPERATION_GROUP_WORDS[what.group] ?? what.group);
	const head =
		access === undefined
			? group === undefined
				? "Any request it classifies"
				: `Anything to ${group}`
			: group === undefined
				? access
				: `${access} to ${group}`;
	return what.resource === undefined ? head : `${head} in ${what.resource}`;
}

/** The order the decision looks at rules in: the narrowest what, then the narrowest who, then the strictest. */
export function byPrecedence(rules: readonly ConnectionRule[]): ConnectionRule[] {
	const strict = { deny: 2, ask: 1, allow: 0 } as const;
	return [...rules].sort(
		(a, b) =>
			whatSpecificity(b.what) - whatSpecificity(a.what) ||
			whoSpecificity(b.who) - whoSpecificity(a.who) ||
			strict[b.action] - strict[a.action] ||
			a.createdAt - b.createdAt,
	);
}

/** What else a rule carries: where it came from, its limits. */
function ruleMeta(rule: ConnectionRule, now: number): string[] {
	const meta: string[] = [];
	if (rule.source === "default") meta.push("Template default");
	if (rule.source === "approval") meta.push("From an approval");
	if (rule.source === "migrated") meta.push("From a vault grant");
	if (rule.expiresAt !== undefined)
		meta.push(rule.expiresAt <= now ? "Expired" : `Ends in ${remaining(rule.expiresAt - now)}`);
	if (rule.maxUses !== undefined)
		meta.push(rule.uses >= rule.maxUses ? "Used up" : `${rule.uses} of ${rule.maxUses} uses`);
	return meta;
}

function remaining(ms: number): string {
	if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
	if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
	return `${Math.round(ms / DAY)}d`;
}

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export interface ConnectionRulesProps {
	readonly connection: Connection;
	readonly source: ConnectionRulesSource;
	readonly viewer: ConnectionsViewer;
	/** Whether the viewer may change them: they manage the connection. */
	readonly canManage: boolean;
	readonly now: number;
	/** For stories: a dry run's answer already shown. */
	readonly initialDecision?: ConnectionDecision;
}

/** The Rules section of a connection's page. */
export function ConnectionRulesSection({
	connection,
	source,
	viewer,
	canManage,
	now,
	initialDecision,
}: ConnectionRulesProps) {
	const loaded = useLoad(() => source.get(connection.id), [source, connection.id]);
	const ceiling = useLoad(() => source.ceiling(), [source]);
	const [editing, setEditing] = useState<ConnectionRule | "new">();
	const [removing, setRemoving] = useState<ConnectionRule>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [decision, setDecision] = useState<ConnectionDecision | undefined>(initialDecision);
	// Advanced holds the rule list under the grid; a dry run a rule decided opens it, so the rule shows lit.
	const [advanced, setAdvanced] = useState(initialDecision?.by.kind === "rule");
	const headingId = useId();
	const grid = connection.kind !== "mcp";

	const rules = loaded.state.status === "ready" ? loaded.state.value : undefined;
	const ordered = rules === undefined ? [] : byPrecedence(rules.rules);
	const decidedRule = decision?.by.kind === "rule" ? decision.by.ruleId : undefined;
	const ceilingValue = ceiling.state.status === "ready" ? ceiling.state.value : undefined;

	const run = async (work: () => Promise<unknown>) => {
		setBusy(true);
		setError(undefined);
		try {
			await work();
			// A decision made under the old rules may no longer hold.
			setDecision(undefined);
			loaded.reload();
		} catch (caught) {
			setError(message(caught, "Couldn't save that. Try again."));
		} finally {
			setBusy(false);
		}
	};

	const ruleList =
		rules === undefined ? null : (
			<>
				<Unmatched
					rules={rules}
					canManage={canManage}
					busy={busy}
					onChange={(unmatched) => run(() => source.update(connection.id, { unmatched }))}
				/>
				{ordered.length === 0 ? (
					<div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-panel border border-dashed border-border px-4 py-3 text-sm text-muted">
						<span>
							{rules.version === 0
								? "No rules yet. This connection works as it did before rules: every request it can make goes through."
								: "No rules. Every request gets the answer above."}
						</span>
						{canManage && connection.kind !== "mcp" && !rulesLetUnmatchedThrough(rules) ? (
							<Button busy={busy} onClick={() => run(() => source.update(connection.id, { reset: "template" }))}>
								Use the template's defaults
							</Button>
						) : null}
					</div>
				) : (
					<ul className="m-0 flex min-w-0 list-none flex-col overflow-hidden rounded-panel border border-border p-0">
						{ordered.map((rule) => (
							<RuleRow
								key={rule.id}
								rule={rule}
								viewer={viewer}
								now={now}
								decided={rule.id === decidedRule}
								canManage={canManage}
								onEdit={() => setEditing(rule)}
								onRemove={() => setRemoving(rule)}
							/>
						))}
					</ul>
				)}
			</>
		);

	return (
		<section className="kt-connection-rules flex min-w-0 flex-col gap-4" aria-labelledby={headingId}>
			<div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2 sm:flex-nowrap">
				<div className="flex min-w-0 flex-auto flex-col gap-1">
					<h3 id={headingId} className="m-0 text-sm font-strong text-fg">
						{grid ? "What agents may do" : "Rules"}
					</h3>
					<p className="m-0 max-w-prose text-xs leading-normal text-muted">
						{grid
							? "Checked on every request, for every agent. The grid is made of ordinary rules: Advanced lists them all, and a change in either shows in both."
							: "What agents may do with this connection, checked on every request. The narrowest rule decides; between equals, Deny beats Ask beats Allow."}
					</p>
				</div>
				{canManage && rules !== undefined && !grid ? (
					<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => setEditing("new")}>
						Add rule
					</Button>
				) : null}
			</div>

			{loaded.state.status === "error" ? (
				<Notice
					level="error"
					action={
						<Button size="xs" onClick={loaded.reload}>
							Try again
						</Button>
					}
				>
					Couldn't load the rules.
				</Notice>
			) : null}
			{loaded.state.status === "loading" ? (
				<div className="flex min-w-0 flex-col gap-2" role="status" aria-label="Loading the rules">
					<Skeleton lines={3} />
				</div>
			) : null}
			{error === undefined ? null : <Notice level="error">{error}</Notice>}
			{ceilingValue?.set === true ? <CeilingNote ceiling={ceilingValue} /> : null}

			{rules === undefined ? null : (
				<>
					{rulesLetUnmatchedThrough(rules) ? (
						<Notice
							level="warning"
							announce={false}
							action={
								canManage ? (
									<Button
										size="xs"
										busy={busy}
										onClick={() => run(() => source.update(connection.id, { reset: "template" }))}
									>
										Use the defaults
									</Button>
								) : undefined
							}
						>
							Requests no rule covers go through unasked, so an agent's writes and deletes reach {connection.name} with
							nobody approving them. The template's defaults allow reads, ask about writes and block deletes.
						</Notice>
					) : null}
					{rules.defaults?.reason === "migrated" ? (
						<Notice level="info" announce={false}>
							On <time dateTime={new Date(rules.defaults.at).toISOString()}>{when.format(rules.defaults.at)}</time>{" "}
							Kantel gave this connection its template's defaults: reads allowed, writes ask, deletes blocked. Before
							that it had no rules, and every request went through.
						</Notice>
					) : null}
					{grid ? (
						<ConnectionPolicy
							connection={connection}
							rules={rules}
							source={source}
							viewer={viewer}
							canManage={canManage}
							now={now}
							onChanged={() => {
								setDecision(undefined);
								loaded.reload();
							}}
						/>
					) : null}
					{grid ? (
						<Disclosure
							summary="Advanced: every rule"
							trailing={<span className="text-xs text-faint tabular-nums">{ordered.length}</span>}
							open={advanced}
							onOpenChange={setAdvanced}
						>
							<div className="flex min-w-0 flex-col gap-4 pt-2">
								{canManage ? (
									<div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
										<p className="m-0 max-w-prose text-xs leading-normal text-muted">
											By method and path, for an agent, a project or a session. The narrowest rule decides; between
											equals, Deny beats Ask beats Allow.
										</p>
										<Button icon={<PlusIcon size="sm" />} onClick={() => setEditing("new")}>
											Add rule
										</Button>
									</div>
								) : null}
								{ruleList}
							</div>
						</Disclosure>
					) : (
						ruleList
					)}
				</>
			)}

			<TryRequest
				connection={connection}
				viewer={viewer}
				decision={decision}
				ceiling={ceilingValue}
				onTry={async (request) => {
					const answer = await source.dryRun(connection.id, request);
					setDecision(answer);
					if (answer.by.kind === "rule") setAdvanced(true);
				}}
				onClear={() => setDecision(undefined)}
			/>

			{editing === undefined ? null : (
				<RuleDialog
					connection={connection}
					viewer={viewer}
					rule={editing === "new" ? undefined : editing}
					now={now}
					onClose={() => setEditing(undefined)}
					onSave={async (input) => {
						if (editing === "new") await source.create(connection.id, input);
						else await source.updateRule(connection.id, editing.id, input);
						setEditing(undefined);
						setDecision(undefined);
						loaded.reload();
					}}
				/>
			)}
			<Dialog
				open={removing !== undefined}
				title="Remove this rule?"
				onClose={() => setRemoving(undefined)}
				actions={
					<>
						<Button onClick={() => setRemoving(undefined)}>Cancel</Button>
						<Button
							variant="danger"
							busy={busy}
							onClick={() => {
								const rule = removing;
								setRemoving(undefined);
								if (rule !== undefined) void run(() => source.remove(connection.id, rule.id));
							}}
						>
							Remove
						</Button>
					</>
				}
			>
				{removing === undefined ? null : (
					<p>
						<strong>
							{ACTION_LABELS[removing.action]} {whatText(removing.what)}
						</strong>{" "}
						for {whoText(removing.who, viewer).toLowerCase()}. Requests it covered fall to the next rule that matches,
						or the answer for requests no rule covers.
					</p>
				)}
			</Dialog>
		</section>
	);
}

function CeilingNote({ ceiling }: { ceiling: ConnectionCeiling }) {
	return (
		<Notice level="info" announce={false}>
			Your organisation's ceiling limits every connection to{" "}
			{ceiling.routes.length === 0
				? "nothing"
				: ceiling.routes
						.slice(0, 3)
						.map(
							(route) => `${route.methods.join(", ")} ${route.host}${route.pathPrefix === "/" ? "" : route.pathPrefix}`,
						)
						.join("; ")}
			{ceiling.routes.length > 3 ? `, and ${ceiling.routes.length - 3} more` : ""}. A rule can't allow or ask for more.
		</Notice>
	);
}

function Unmatched({
	rules,
	canManage,
	busy,
	onChange,
}: {
	rules: ConnectionRules;
	canManage: boolean;
	busy: boolean;
	onChange: (action: ConnectionRuleAction) => void;
}) {
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
			<span>Requests no rule covers</span>
			{canManage ? (
				<span className={busy ? "pointer-events-none opacity-70" : undefined}>
					<SegmentedControl<ConnectionRuleAction>
						label="Requests no rule covers"
						options={ACTION_OPTIONS}
						value={rules.unmatched}
						onChange={(next) => {
							if (next !== rules.unmatched) onChange(next);
						}}
					/>
				</span>
			) : (
				<Badge tone={ACTION_TONE[rules.unmatched]}>{ACTION_LABELS[rules.unmatched]}</Badge>
			)}
			<span className="text-xs text-faint">They {UNMATCHED_WORDS[rules.unmatched]}.</span>
		</div>
	);
}

function RuleRow({
	rule,
	viewer,
	now,
	decided,
	canManage,
	onEdit,
	onRemove,
}: {
	rule: ConnectionRule;
	viewer: ConnectionsViewer;
	now: number;
	decided: boolean;
	canManage: boolean;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const meta = ruleMeta(rule, now);
	const spent =
		(rule.expiresAt !== undefined && rule.expiresAt <= now) ||
		(rule.maxUses !== undefined && rule.uses >= rule.maxUses);
	return (
		<li
			data-rule={rule.id}
			data-decided={decided || undefined}
			// The rule a dry run matched is ringed, not tinted: a tint under its badge would take the badge below contrast.
			className={`kt-rule-row grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-0 border-b border-solid border-border px-3 py-2.5 last:border-b-0 ${decided ? "inset-ring inset-ring-accent" : ""} ${spent ? "text-faint" : ""}`}
		>
			<span className="row-span-2 self-start pt-0.5 sm:row-span-1 sm:self-center">
				<Badge tone={spent ? "neutral" : ACTION_TONE[rule.action]}>{ACTION_LABELS[rule.action]}</Badge>
			</span>
			<div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
				<code className="kt-mono min-w-0 text-code text-fg wrap-anywhere">{whatText(rule.what)}</code>
				<span className="min-w-0 text-xs text-muted">{whoText(rule.who, viewer)}</span>
			</div>
			<div className="row-span-2 flex items-center gap-0.5 self-start sm:row-span-1 sm:self-center">
				{canManage ? (
					<>
						<IconButton variant="ghost" label="Edit rule" icon={<PencilIcon size="sm" />} onClick={onEdit} />
						<IconButton variant="ghost" label="Remove rule" icon={<TrashIcon size="sm" />} onClick={onRemove} />
					</>
				) : null}
			</div>
			{meta.length === 0 && rule.note === undefined ? null : (
				<p className="col-start-2 m-0 flex min-w-0 flex-wrap gap-x-3 text-xs text-faint">
					{meta.map((item) => (
						<span key={item}>{item}</span>
					))}
					{rule.note === undefined ? null : <span className="text-muted">{rule.note}</span>}
				</p>
			)}
		</li>
	);
}

// The rule form.

type WhoKind = ConnectionRuleWho["kind"];
type Expiry = "keep" | "never" | "hour" | "day" | "week" | "month";
const EXPIRY_MS: Record<Exclude<Expiry, "keep" | "never">, number> = {
	hour: HOUR,
	day: DAY,
	week: 7 * DAY,
	month: 30 * DAY,
};

function RuleDialog({
	connection,
	viewer,
	rule,
	now,
	onClose,
	onSave,
}: {
	connection: Connection;
	viewer: ConnectionsViewer;
	rule: ConnectionRule | undefined;
	now: number;
	onClose: () => void;
	onSave: (input: ConnectionRuleInput) => Promise<void>;
}) {
	const mcp = connection.kind === "mcp";
	const [action, setAction] = useState<ConnectionRuleAction>(rule?.action ?? "allow");
	const [whoKind, setWhoKind] = useState<WhoKind>(rule?.who.kind ?? "any");
	const [whoId, setWhoId] = useState(
		rule?.who.kind === "agent"
			? rule.who.agentId
			: rule?.who.kind === "session"
				? rule.who.sessionId
				: rule?.who.kind === "project"
					? rule.who.projectId
					: "",
	);
	// A template that classifies its requests (#465) can have rules on what they do (#466).
	const classifies = !mcp && connection.templateId === "github";
	const [whatKind, setWhatKind] = useState<"any" | "specific" | "operation">(
		rule?.what.kind === "operation" ? "operation" : rule === undefined || rule.what.kind !== "any" ? "specific" : "any",
	);
	const operation = rule?.what.kind === "operation" ? rule.what : undefined;
	const [group, setGroup] = useState(operation?.group ?? "");
	const [access, setAccess] = useState<OperationAccess | "">(operation?.access ?? "write");
	const [resource, setResource] = useState(operation?.resource ?? "");
	const endpoint = rule?.what.kind === "endpoint" ? rule.what : undefined;
	const [method, setMethod] = useState<HttpMethod | "*">(endpoint?.method ?? "GET");
	const [host, setHost] = useState(endpoint?.host ?? "");
	const [path, setPath] = useState(endpoint?.path ?? "/");
	const [tool, setTool] = useState(rule?.what.kind === "tool" ? rule.what.tool : "");
	const [expiry, setExpiry] = useState<Expiry>(rule?.expiresAt === undefined ? "never" : "keep");
	const [maxUses, setMaxUses] = useState(rule?.maxUses === undefined ? "" : String(rule.maxUses));
	const [note, setNote] = useState(rule?.note ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const [shown, setShown] = useState(false);

	const pathProblem = !mcp && whatKind === "specific" ? pathPatternProblem(path) : undefined;
	const toolProblem = mcp && whatKind === "specific" && tool.trim() === "" ? "Name the tool" : undefined;
	const resourceProblem =
		whatKind === "operation" && resource.trim() !== "" ? resourcePatternProblem(resource.trim()) : undefined;
	const whoProblem =
		(whoKind === "agent" || whoKind === "session" || whoKind === "project") && whoId.trim() === ""
			? whoKind === "project"
				? "Pick a project"
				: `Name the ${whoKind}`
			: undefined;
	const usesProblem =
		maxUses.trim() !== "" && !(Number.isInteger(Number(maxUses)) && Number(maxUses) >= 1)
			? "A whole number above zero"
			: undefined;

	const save = async () => {
		setShown(true);
		if (pathProblem ?? toolProblem ?? resourceProblem ?? whoProblem ?? usesProblem) return;
		const who: ConnectionRuleWho =
			whoKind === "agent"
				? { kind: "agent", agentId: whoId.trim() }
				: whoKind === "session"
					? { kind: "session", sessionId: whoId.trim() }
					: whoKind === "project"
						? { kind: "project", projectId: whoId }
						: { kind: whoKind };
		const what: ConnectionRuleWhat =
			whatKind === "any"
				? { kind: "any" }
				: whatKind === "operation"
					? {
							kind: "operation",
							...(group === "" ? {} : { group }),
							...(access === "" ? {} : { access }),
							...(resource.trim() === "" ? {} : { resource: resource.trim() }),
						}
					: mcp
						? { kind: "tool", tool: tool.trim() }
						: { kind: "endpoint", method, path: path.trim(), ...(host === "" ? {} : { host }) };
		const expiresAt = expiry === "keep" ? rule?.expiresAt : expiry === "never" ? undefined : now + EXPIRY_MS[expiry];
		const input = {
			who,
			what,
			action,
			...(expiresAt === undefined ? {} : { expiresAt }),
			...(maxUses.trim() === "" ? {} : { maxUses: Number(maxUses) }),
			...(note.trim() === "" ? {} : { note: note.trim() }),
		};
		setSaving(true);
		setError(undefined);
		try {
			// An edit clears what the form left empty; a new rule just leaves it out.
			await onSave(
				rule === undefined
					? input
					: ({
							...input,
							expiresAt: input.expiresAt ?? null,
							maxUses: input.maxUses ?? null,
							note: input.note ?? null,
						} as unknown as ConnectionRuleInput),
			);
		} catch (caught) {
			setError(message(caught, "Couldn't save the rule. Try again."));
			setSaving(false);
		}
	};

	const whoOptions = [
		{ value: "any", label: "Any agent" },
		{ value: "attended", label: "Sessions a person is in" },
		{ value: "unattended", label: "Scheduled runs" },
		...(viewer.projects.length === 0 ? [] : [{ value: "project", label: "Agents in a project" }]),
		{ value: "organisation", label: "Agents outside projects" },
		{ value: "agent", label: "One agent" },
		{ value: "session", label: "One session" },
	];
	return (
		<Dialog
			open
			title={rule === undefined ? "Add a rule" : "Edit the rule"}
			onClose={onClose}
			onSubmit={() => void save()}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button variant="primary" type="submit" busy={saving}>
						{rule === undefined ? "Add rule" : "Save"}
					</Button>
				</>
			}
		>
			<div className="flex min-w-0 flex-col gap-3 text-fg">
				{error === undefined ? null : <Notice level="error">{error}</Notice>}
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-xs text-muted">Answer</span>
					<SegmentedControl<ConnectionRuleAction>
						label="Answer"
						options={ACTION_OPTIONS}
						value={action}
						onChange={setAction}
					/>
				</div>
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-xs text-muted">For</span>
					<SelectField
						label="Who the rule is for"
						hideLabel
						value={whoKind}
						options={whoOptions}
						onChange={(event) => {
							const next = event.target.value as WhoKind;
							setWhoKind(next);
							setWhoId(next === "project" ? (viewer.projectId ?? viewer.projects[0]?.id ?? "") : "");
						}}
					/>
					{whoKind === "project" ? (
						<SelectField
							label="Project"
							hideLabel
							value={whoId}
							options={viewer.projects.map((p) => ({ value: p.id, label: p.name }))}
							onChange={(event) => setWhoId(event.target.value)}
						/>
					) : whoKind === "agent" || whoKind === "session" ? (
						<TextField
							label={whoKind === "agent" ? "Agent ID" : "Session ID"}
							hideLabel
							mono
							placeholder={whoKind === "agent" ? "Agent ID, such as triage" : "Session ID"}
							value={whoId}
							onChange={(event) => setWhoId(event.target.value)}
							error={shown ? whoProblem : undefined}
						/>
					) : null}
				</div>
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-xs text-muted">Covers</span>
					<SegmentedControl<"any" | "specific" | "operation">
						label="What the rule covers"
						options={[
							{ value: "specific", label: mcp ? "One tool" : "An endpoint" },
							...(classifies ? [{ value: "operation" as const, label: "A kind of request" }] : []),
							{ value: "any", label: mcp ? "Every tool" : "Every request" },
						]}
						value={whatKind}
						onChange={setWhatKind}
					/>
					{whatKind === "any" ? null : whatKind === "operation" ? (
						<FormGrid columns={2}>
							<SelectField
								label="Does"
								value={access}
								options={[
									{ value: "", label: "Anything" },
									...OPERATION_ACCESSES.map((value) => ({ value, label: OPERATION_ACCESS_WORDS[value] })),
								]}
								onChange={(event) => setAccess(event.target.value as OperationAccess | "")}
							/>
							<SelectField
								label="To"
								value={group}
								options={[
									{ value: "", label: "Anything it reaches" },
									...Object.entries(OPERATION_GROUP_WORDS).map(([value, label]) => ({
										value,
										label: label.charAt(0).toUpperCase() + label.slice(1),
									})),
								]}
								onChange={(event) => setGroup(event.target.value)}
							/>
							<TextField
								label="Repository"
								mono
								className="col-span-full"
								placeholder="Any, or owner/name"
								hint="owner/* for all of an owner's"
								value={resource}
								onChange={(event) => setResource(event.target.value)}
								error={shown ? resourceProblem : undefined}
							/>
						</FormGrid>
					) : mcp ? (
						<TextField
							label="Tool name"
							mono
							placeholder="create_issue"
							value={tool}
							onChange={(event) => setTool(event.target.value)}
							error={shown ? toolProblem : undefined}
						/>
					) : (
						<FormGrid columns={connection.hosts.length > 1 ? 2 : 3}>
							<SelectField
								label="Method"
								value={method}
								options={[{ value: "*", label: "Any" }, ...METHODS.map((m) => ({ value: m, label: m }))]}
								onChange={(event) => setMethod(event.target.value as HttpMethod | "*")}
							/>
							{connection.hosts.length > 1 ? (
								<SelectField
									label="Host"
									value={host}
									options={[
										{ value: "", label: "Any of its hosts" },
										...connection.hosts.map((h) => ({ value: h, label: h })),
									]}
									onChange={(event) => setHost(event.target.value)}
								/>
							) : null}
							<TextField
								label="Path"
								mono
								className={connection.hosts.length > 1 ? "col-span-full" : "col-span-2"}
								placeholder="/repos/*/issues"
								hint="* is one segment, /** at the end is the rest"
								value={path}
								onChange={(event) => setPath(event.target.value)}
								error={shown ? pathProblem : undefined}
							/>
						</FormGrid>
					)}
				</div>
				<FormGrid columns={2}>
					<SelectField
						label="Ends"
						value={expiry}
						options={[
							...(rule?.expiresAt === undefined
								? []
								: [
										{ value: "keep", label: rule.expiresAt <= now ? "Ended" : `In ${remaining(rule.expiresAt - now)}` },
									]),
							{ value: "never", label: "Never" },
							{ value: "hour", label: "In an hour" },
							{ value: "day", label: "In a day" },
							{ value: "week", label: "In a week" },
							{ value: "month", label: "In 30 days" },
						]}
						onChange={(event) => setExpiry(event.target.value as Expiry)}
					/>
					<TextField
						label="Use limit"
						inputMode="numeric"
						placeholder="No limit"
						value={maxUses}
						onChange={(event) => setMaxUses(event.target.value)}
						error={shown ? usesProblem : undefined}
					/>
				</FormGrid>
				<TextField
					label="Note"
					placeholder="Why it's here"
					value={note}
					onChange={(event) => setNote(event.target.value)}
				/>
			</div>
		</Dialog>
	);
}

// Try a request.

type Audience = "shared" | "private";

function TryRequest({
	connection,
	viewer,
	decision,
	ceiling,
	onTry,
	onClear,
}: {
	connection: Connection;
	viewer: ConnectionsViewer;
	decision: ConnectionDecision | undefined;
	ceiling: ConnectionCeiling | undefined;
	onTry: (request: Parameters<ConnectionRulesSource["dryRun"]>[1]) => Promise<void>;
	onClear: () => void;
}) {
	const mcp = connection.kind === "mcp";
	const headingId = useId();
	const [method, setMethod] = useState<HttpMethod>(mcp ? "POST" : "GET");
	const [url, setUrl] = useState(mcp ? (connection.mcp?.url ?? "") : `https://${connection.hosts[0] ?? ""}/`);
	const [tool, setTool] = useState("");
	const [agentId, setAgentId] = useState("");
	const [projectId, setProjectId] = useState(viewer.projectId ?? "");
	const [audience, setAudience] = useState<Audience>(connection.owner.kind === "user" ? "private" : "shared");
	const [run, setRun] = useState<"attended" | "unattended">("attended");
	const [body, setBody] = useState("");
	const classifies = !mcp && connection.templateId === "github";
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const tryIt = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await onTry({
				method,
				...(mcp ? (tool.trim() === "" ? {} : { tool: tool.trim() }) : { url: url.trim() }),
				...(agentId.trim() === "" ? {} : { agentId: agentId.trim() }),
				...(projectId === "" ? {} : { projectId }),
				audience,
				...(run === "unattended" ? { unattended: true } : {}),
				...(classifies && method !== "GET" && method !== "HEAD" && body.trim() !== "" ? { body } : {}),
			});
		} catch (caught) {
			setError(message(caught, "Couldn't try it. Try again."));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			aria-labelledby={headingId}
			className="kt-try-request flex min-w-0 flex-col gap-3 rounded-panel border border-border bg-panel p-4"
		>
			<div className="flex min-w-0 flex-col gap-1">
				<h4 id={headingId} className="m-0 text-sm font-medium text-fg">
					Try a request
				</h4>
				<p className="m-0 text-xs text-muted">
					See what Kantel would do with it, from the same check the real request goes through. Nothing is sent.
				</p>
			</div>
			<form
				className="flex min-w-0 flex-col gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					void tryIt();
				}}
			>
				{mcp ? (
					<TextField
						label="Tool"
						mono
						placeholder="Leave empty to list the tools"
						value={tool}
						onChange={(event) => setTool(event.target.value)}
					/>
				) : (
					<div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-end gap-2">
						<SelectField
							label="Method"
							value={method}
							options={METHODS.map((m) => ({ value: m, label: m }))}
							onChange={(event) => setMethod(event.target.value as HttpMethod)}
						/>
						<TextField label="URL" mono value={url} onChange={(event) => setUrl(event.target.value)} />
					</div>
				)}
				{classifies && method !== "GET" && method !== "HEAD" ? (
					<TextField
						label="Body"
						mono
						placeholder='{"query": "{ viewer { login } }"}'
						hint="For GraphQL, the query decides whether it reads or writes"
						value={body}
						onChange={(event) => setBody(event.target.value)}
					/>
				) : null}
				<FormGrid columns={2}>
					<TextField
						label="Agent"
						mono
						placeholder="Any"
						value={agentId}
						onChange={(event) => setAgentId(event.target.value)}
					/>
					<SelectField
						label="Session in"
						value={projectId}
						options={[
							{ value: "", label: "No project" },
							...viewer.projects.map((p) => ({ value: p.id, label: p.name })),
						]}
						onChange={(event) => setProjectId(event.target.value)}
					/>
					<SelectField
						label="Seen by"
						value={audience}
						options={[
							{ value: "shared", label: "Its project" },
							{ value: "private", label: "Only me" },
						]}
						onChange={(event) => setAudience(event.target.value as Audience)}
					/>
					<SelectField
						label="Run"
						value={run}
						options={[
							{ value: "attended", label: "A person is in it" },
							{ value: "unattended", label: "Scheduled" },
						]}
						onChange={(event) => setRun(event.target.value as "attended" | "unattended")}
					/>
				</FormGrid>
				<div className="flex flex-wrap items-center gap-2">
					<Button type="submit" busy={busy}>
						Try it
					</Button>
					{decision === undefined ? null : (
						<Button variant="ghost" onClick={onClear}>
							Clear
						</Button>
					)}
				</div>
			</form>
			{error === undefined ? null : <Notice level="error">{error}</Notice>}
			{decision === undefined ? null : <DecisionTrace decision={decision} ceiling={ceiling} viewer={viewer} />}
		</section>
	);
}

type StepState = "passed" | "decided" | "skipped";
const STEP_ORDER = ["usage", "connection", "ceiling", "rules"] as const;
type Step = (typeof STEP_ORDER)[number];
const STEP_LABELS: Record<Step, string> = {
	usage: "Who may use it",
	connection: "The connection",
	ceiling: "The organisation's ceiling",
	rules: "The rules",
};

function stepOf(decision: ConnectionDecision): Step {
	switch (decision.by.kind) {
		case "usage":
		case "connection":
		case "ceiling":
			return decision.by.kind;
		default:
			return "rules";
	}
}

/** The path the decision took, in the order Kantel checks: each step it passed, the one that answered, the rest. */
function DecisionTrace({
	decision,
	ceiling,
	viewer,
}: {
	decision: ConnectionDecision;
	ceiling: ConnectionCeiling | undefined;
	viewer: ConnectionsViewer;
}) {
	const at = STEP_ORDER.indexOf(stepOf(decision));
	const passedText: Record<Step, string> = {
		usage: "This session may use the connection",
		connection: "Connected, over https, to one of its hosts",
		ceiling: ceiling?.set === true ? "Inside the ceiling" : "Your organisation has no ceiling",
		rules: "",
	};
	const decidedText =
		decision.by.kind === "rule" && decision.rule !== undefined
			? `${ACTION_LABELS[decision.rule.action]} ${whatText(decision.rule.what)}, for ${whoText(decision.rule.who, viewer).toLowerCase()}`
			: decision.reason;
	return (
		<div
			className="kt-decision flex min-w-0 flex-col gap-3 border-0 border-t border-solid border-border pt-3"
			role="status"
		>
			<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
				<span className="text-lg font-strong text-fg">{VERDICT[decision.action]}</span>
				<span className="text-xs text-faint">Rules version {decision.rulesVersion}</span>
			</div>
			{decision.operation === undefined ? null : (
				<p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-fg" data-operation>
					<span className="text-xs text-muted">Kantel reads it as</span>
					<span className="min-w-0 wrap-anywhere">{decision.operation.label}</span>
					<Badge tone="neutral">
						{operationText({
							kind: "operation",
							group: decision.operation.group,
							access: decision.operation.access,
						})}
					</Badge>
				</p>
			)}
			<ol className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
				{STEP_ORDER.map((step, index) => {
					const state: StepState = index < at ? "passed" : index === at ? "decided" : "skipped";
					return (
						<li key={step} data-step={step} data-state={state} className="flex min-w-0 items-start gap-2 text-sm">
							<span className="mt-0.5 flex flex-none">
								<StepIcon state={state} action={decision.action} />
							</span>
							<span className="flex min-w-0 flex-col">
								<span className={state === "skipped" ? "text-faint" : "text-fg"}>{STEP_LABELS[step]}</span>
								<span className="text-xs text-muted wrap-anywhere">
									{state === "passed" ? passedText[step] : state === "decided" ? decidedText : "Not reached"}
								</span>
							</span>
						</li>
					);
				})}
			</ol>
		</div>
	);
}

const VERDICT: Record<ConnectionRuleAction, string> = {
	allow: "Allowed",
	ask: "Needs approval",
	deny: "Refused",
};

function StepIcon({ state, action }: { state: StepState; action: ConnectionRuleAction }): ReactNode {
	if (state === "passed") return <CheckIcon size="sm" className="text-status-done" />;
	if (state === "skipped") return <MinusCircleIcon size="sm" className="text-faint" />;
	if (action === "deny") return <XCircleIcon size="sm" className="text-status-error" />;
	if (action === "ask") return <MinusCircleIcon size="sm" className="text-status-approval" />;
	return <CheckIcon size="sm" className="text-status-done" />;
}
