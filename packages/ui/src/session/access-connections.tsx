// A session's connections in the composer's access menu (#463): each connection the session can use (`GET
// /v1/connections/eligible`), whose account it is and who owns it, its policy in a line ("Reads allowed, writes ask,
// deletes blocked", read from its rules the way the dry run decides), and what this session alone has been allowed
// (rules for `who: { kind: "session" }`, made by an approval's "Allow for this session"), each with Revoke for someone
// who manages the connection.

import type { ConnectionRule, ConnectionRuleAction, ConnectionRules } from "@kantel/contracts";
import { Fragment, useId, useRef, useState } from "react";
import { POLICY_ACTION_LABELS } from "../connections/connection-policy.tsx";
import { policySentence, readPolicyGrid } from "../connections/connection-policy-model.ts";
import { whatText } from "../connections/connection-rules.tsx";
import { ProviderLogo } from "../connections/provider-logo.tsx";
import { Button } from "../primitives/button.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, type BadgeTone } from "../primitives/status.tsx";
import { ClockTime } from "../primitives/time.tsx";
import type { SessionConnectionView } from "./session-visibility.tsx";

/** One connection the session can use, with what the menu says about it. */
export interface SessionAccessConnection {
	/** As the eligibility route answers it for this session, usable. */
	readonly connection: SessionConnectionView;
	/** `mcp`: a server's tools, whose rules name tools; anything else is an API whose rules name requests. */
	readonly kind: "http" | "mcp";
	/** Its template, for the policy's permission groups. */
	readonly templateId?: string;
	readonly hosts: readonly string[];
	/** Its rules, or undefined when the viewer can't read them. */
	readonly rules?: ConnectionRules;
	/** Whether the viewer manages the connection, and so may revoke what this session was allowed. */
	readonly canManage: boolean;
}

/** The menu's calls, for one session. */
export interface SessionAccessSource {
	readonly sessionId: string;
	/** The session's project: the policy line is what an agent in it gets. */
	readonly projectId?: string;
	/** The connections the session can use, each with its rules. */
	connections(): Promise<readonly SessionAccessConnection[]>;
	/** Removes one of this session's rules from a connection. */
	revoke(connectionId: string, ruleId: string): Promise<void>;
}

/** What this session alone has been allowed (or told to ask about, or blocked from) on a connection. */
export function sessionAllowances(
	rules: Pick<ConnectionRules, "rules"> | undefined,
	sessionId: string,
): ConnectionRule[] {
	return (rules?.rules ?? [])
		.filter((rule) => rule.who.kind === "session" && rule.who.sessionId === sessionId)
		.sort((a, b) => a.createdAt - b.createdAt);
}

/** What a tool no rule names gets, said of one tool and of several. */
const UNMATCHED_TOOLS: Record<ConnectionRuleAction, { readonly one: string; readonly many: string }> = {
	allow: { one: "goes through", many: "go through" },
	ask: { one: "asks first", many: "ask first" },
	deny: { one: "is blocked", many: "are blocked" },
};

/**
 * A connection's policy in one line, for any agent in the session's project: the grid's sentence for an API ("Reads
 * allowed, writes ask, deletes blocked"), its tool rules for an MCP server. Rules for one session are left out: the
 * menu lists this session's under the line.
 */
export function accessPolicyLine(
	item: Pick<SessionAccessConnection, "kind" | "templateId" | "hosts" | "rules">,
	options: { readonly projectId?: string; readonly now: number },
): string {
	const { rules } = item;
	if (rules === undefined) return "Its rules aren't visible to you";
	if (item.kind === "mcp") {
		const named = rules.rules.filter((rule) => rule.what.kind === "tool" && rule.who.kind !== "session").length;
		const unmatched = UNMATCHED_TOOLS[rules.unmatched];
		if (named === 0) return `Every tool ${unmatched.one}`;
		return `${named} ${named === 1 ? "tool has" : "tools have"} a rule, other tools ${unmatched.many}`;
	}
	return policySentence(
		readPolicyGrid(rules, {
			templateId: item.templateId,
			host: item.hosts[0] ?? "",
			...(options.projectId === undefined ? {} : { projectId: options.projectId }),
			now: options.now,
		}),
	);
}

const ALLOWANCE_TONE: Record<ConnectionRuleAction, BadgeTone> = { allow: "done", ask: "approval", deny: "error" };

/** The menu's heading style, as the access picker's "Access". */
const heading = "kt-access-heading m-0 px-2 pt-1.5 pb-1 text-xs font-medium text-faint outline-none";

/**
 * The connections section of the access menu, for a session that has started. Loads when it mounts, so each time the
 * menu opens, and again after a revoke.
 */
export function SessionAccessConnections({ source, now }: { source: SessionAccessSource; now?: number }) {
	const headingId = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [at] = useState(() => now ?? Date.now());
	const loaded = useLoad(() => source.connections(), [source]);
	const [revoking, setRevoking] = useState<string>();
	const [failed, setFailed] = useState<{ readonly ruleId: string; readonly text: string }>();

	const revoke = async (connectionId: string, ruleId: string) => {
		setRevoking(ruleId);
		setFailed(undefined);
		try {
			await source.revoke(connectionId, ruleId);
			loaded.reload();
			// The button goes with the rule: focus stays in the menu, on its heading.
			headingRef.current?.focus();
		} catch (caught) {
			setFailed({
				ruleId,
				text: caught instanceof Error && caught.message !== "" ? caught.message : "Couldn't revoke it. Try again.",
			});
		} finally {
			setRevoking(undefined);
		}
	};

	return (
		<section
			className="kt-access-connections flex min-w-0 flex-col border-0 border-t border-solid border-border pt-1"
			aria-labelledby={headingId}
		>
			<h3 id={headingId} ref={headingRef} tabIndex={-1} className={heading}>
				Connections in this session
			</h3>
			{loaded.state.status === "loading" ? (
				<div className="flex flex-col gap-2 px-2 py-1.5" role="status" aria-label="Loading its connections">
					<Skeleton lines={2} />
				</div>
			) : loaded.state.status === "error" ? (
				<div className="flex min-w-0 items-center justify-between gap-2 px-2 py-1.5">
					<span className="text-xs text-muted">Couldn't load its connections.</span>
					<Button size="xs" variant="ghost" onClick={loaded.reload}>
						Try again
					</Button>
				</div>
			) : loaded.state.value.length === 0 ? (
				<p className="m-0 px-2 py-1.5 text-xs text-muted">
					It can't use any connections. Connect a service, or share one with its project.
				</p>
			) : (
				<ul className="m-0 flex min-w-0 list-none flex-col p-0">
					{loaded.state.value.map((item) => (
						<AccessConnectionRow
							key={item.connection.id}
							item={item}
							sessionId={source.sessionId}
							policy={accessPolicyLine(item, {
								...(source.projectId === undefined ? {} : { projectId: source.projectId }),
								now: at,
							})}
							now={at}
							revoking={revoking}
							failed={failed}
							onRevoke={(ruleId) => void revoke(item.connection.id, ruleId)}
						/>
					))}
				</ul>
			)}
			<p className="m-0 px-2 pt-1 pb-1.5 text-xs leading-tight text-faint">
				Each follows its own rules, whatever the access level: a request that asks waits for someone to approve it.
			</p>
		</section>
	);
}

function AccessConnectionRow({
	item,
	sessionId,
	policy,
	now,
	revoking,
	failed,
	onRevoke,
}: {
	item: SessionAccessConnection;
	sessionId: string;
	policy: string;
	now: number;
	revoking: string | undefined;
	failed: { readonly ruleId: string; readonly text: string } | undefined;
	onRevoke: (ruleId: string) => void;
}) {
	const { connection } = item;
	const allowances = sessionAllowances(item.rules, sessionId);
	const meta = [connection.account, connection.ownerLabel].filter((part) => part !== undefined && part !== "");
	return (
		<li
			data-connection={connection.id}
			className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1 rounded-sm px-2 py-1.5"
		>
			<span className="row-span-2 pt-px">
				<ProviderLogo name={connection.name} icon={connection.icon} size="xs" />
			</span>
			<span className="flex min-w-0 flex-wrap items-baseline gap-x-2 leading-tight">
				<span className="text-sm font-medium text-fg">{connection.name}</span>
				{meta.length === 0 ? null : <span className="min-w-0 text-xs text-muted wrap-anywhere">{meta.join(", ")}</span>}
			</span>
			<span className="col-start-2 text-xs leading-tight text-muted">{policy}</span>
			{allowances.length === 0 ? null : (
				<ul className="col-start-2 m-0 mt-1 flex min-w-0 list-none flex-col gap-1.5 p-0">
					{allowances.map((rule) => (
						<li
							key={rule.id}
							data-rule={rule.id}
							className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5"
						>
							<Badge tone={ALLOWANCE_TONE[rule.action]}>{POLICY_ACTION_LABELS[rule.action]}</Badge>
							<code className="kt-mono col-span-2 min-w-0 text-code leading-tight text-fg wrap-anywhere">
								<BreakAtSlashes text={whatText(rule.what)} />
							</code>
							<span className="col-start-2 text-xs leading-tight text-faint">
								For this session{rule.source === "approval" ? ", from an approval" : ""},{" "}
								<ClockTime at={rule.createdAt} now={now} />
							</span>
							{item.canManage ? (
								<Button
									size="xs"
									variant="ghost"
									className="col-start-3"
									busy={revoking === rule.id}
									disabled={revoking !== undefined && revoking !== rule.id}
									aria-label={`Revoke ${POLICY_ACTION_LABELS[rule.action].toLowerCase()} ${whatText(rule.what)}`}
									onClick={() => onRevoke(rule.id)}
								>
									Revoke
								</Button>
							) : null}
							{failed?.ruleId === rule.id ? (
								<span className="col-start-2 col-end-4 text-xs text-status-error" role="alert">
									{failed.text}
								</span>
							) : null}
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

/** A request line that wraps after a slash, where a path reads best broken, before it wraps anywhere. */
function BreakAtSlashes({ text }: { text: string }) {
	const parts = text.split("/");
	return (
		<>
			{parts.map((part, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string, in order.
				<Fragment key={index}>
					{index === 0 ? null : (
						<>
							/<wbr />
						</>
					)}
					{part}
				</Fragment>
			))}
		</>
	);
}
