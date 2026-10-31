// A connection's access rules (#341, design #332): what each agent may do with it, the answer for requests no rule
// covers, and "Try a request", which asks the API what the proxy would do with a request and shows the path the
// decision took. Every change is one call to the public API (`ConnectionRulesSource`); nothing is decided here.

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
	pathPatternProblem,
	rulesLetUnmatchedThrough,
	whatSpecificity,
	whoSpecificity,
} from "@kantel/contracts";
import { type ReactNode, useId, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormGrid } from "../primitives/form-layout.tsx";
import { CheckIcon, MinusCircleIcon, PencilIcon, PlusIcon, XCircleIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { TrashIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, type BadgeTone } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
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
	}
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
	const headingId = useId();

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

	return (
		<section className="kt-connection-rules flex min-w-0 flex-col gap-4" aria-labelledby={headingId}>
			<div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2 sm:flex-nowrap">
				<div className="flex min-w-0 flex-auto flex-col gap-1">
					<h3 id={headingId} className="m-0 text-sm font-strong text-fg">
						Rules
					</h3>
					<p className="m-0 max-w-prose text-xs leading-normal text-muted">
						What agents may do with this connection, checked on every request. The narrowest rule decides; between
						equals, Deny beats Ask beats Allow.
					</p>
				</div>
				{canManage && rules !== undefined ? (
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
			)}

			<TryRequest
				connection={connection}
				viewer={viewer}
				decision={decision}
				ceiling={ceilingValue}
				onTry={async (request) => {
					const answer = await source.dryRun(connection.id, request);
					setDecision(answer);
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
			className={`kt-rule-row grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-0 border-b border-solid border-border px-3 py-2.5 last:border-b-0 ${decided ? "bg-accent-soft" : ""} ${spent ? "text-faint" : ""}`}
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
	const [whatKind, setWhatKind] = useState<"any" | "specific">(
		rule === undefined || rule.what.kind !== "any" ? "specific" : "any",
	);
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
		if (pathProblem ?? toolProblem ?? whoProblem ?? usesProblem) return;
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
					<SegmentedControl<"any" | "specific">
						label="What the rule covers"
						options={[
							{ value: "specific", label: mcp ? "One tool" : "An endpoint" },
							{ value: "any", label: mcp ? "Every tool" : "Every request" },
						]}
						value={whatKind}
						onChange={setWhatKind}
					/>
					{whatKind === "any" ? null : mcp ? (
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
				<FormGrid columns={3}>
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
