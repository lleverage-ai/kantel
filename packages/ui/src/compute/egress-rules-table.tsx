// Egress rules in one place (compute console): the account's, its environments' and its sandboxes' allow and deny
// rules in one table, with what each applies to, and under them the protected variables with the hosts each may be
// sent to. Add rule asks what a rule applies to as well as what it allows or denies. On a phone each rule is two lines.

import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField, SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormField } from "../primitives/form-layout.tsx";
import { EllipsisIcon, EnvironmentIcon, SandboxIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { Badge } from "../primitives/status.tsx";
import { type DestinationBinding, type EgressGrant, HTTP_METHODS, type HttpMethod } from "./compute-model.ts";
import { type EgressRule, methodsAndPaths, type ProtectedVariableRow, type RuleScope } from "./egress-overview.ts";
import { hostProblem, pathProblem, splitList } from "./egress-rules.ts";
import { cellMono, messageOf, table, tableFrame, td, th } from "./parts.tsx";

/** "Every sandbox", or the environment's or sandbox's name with its icon. */
export function ScopeText({ scope, href }: { scope: RuleScope; href?: string }) {
	if (scope.kind === "account") return <span className="text-fg">Every sandbox</span>;
	const Icon = scope.kind === "environment" ? EnvironmentIcon : SandboxIcon;
	const words = (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<Icon size="sm" className="flex-none text-muted" />
			<span className="truncate">{scope.name}</span>
		</span>
	);
	return href === undefined ? (
		<span className="text-fg">{words}</span>
	) : (
		<a className="text-fg no-underline hover:underline" href={href}>
			{words}
		</a>
	);
}

const ActionBadge = ({ action }: { action: EgressGrant["action"] }) =>
	action === "allow" ? <Badge tone="done">Allow</Badge> : <Badge tone="error">Deny</Badge>;

export interface EgressRulesTableProps {
	readonly rules: readonly EgressRule[];
	/** A phone: each rule as two lines. */
	readonly narrow?: boolean;
	/** The page an environment's or a sandbox's rules come from. */
	readonly scopeHref?: (scope: RuleScope) => string | undefined;
	/** Takes a rule out. Absent, the rules can't be changed here. */
	readonly onRemove?: (rule: EgressRule) => void;
	/** The rule being removed. */
	readonly busy?: string;
}

/** Every rule, with what it applies to. */
export function EgressRulesTable({ rules, narrow = false, scopeHref, onRemove, busy }: EgressRulesTableProps) {
	if (rules.length === 0) {
		return <p className="m-0 py-2 text-sm text-muted">No rules: the policy decides every request.</p>;
	}
	const menu = (rule: EgressRule) => {
		if (onRemove === undefined) return null;
		const entries: MenuEntry[] = [
			{
				kind: "item",
				id: "remove",
				label: "Remove rule",
				icon: <TrashIcon />,
				danger: true,
				disabled: busy !== undefined,
				onSelect: () => onRemove(rule),
			},
		];
		return (
			<Menu label={`Actions for the rule on ${rule.host}`} icon={<EllipsisIcon />} entries={entries} align="end" />
		);
	};
	if (narrow) {
		return (
			<ul className="m-0 flex list-none flex-col p-0" aria-label="Rules">
				{rules.map((rule) => (
					<li
						key={rule.key}
						className="flex min-w-0 items-start gap-2 border-b border-border py-3"
						data-rule={rule.key}
						aria-busy={busy === rule.key || undefined}
					>
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<span className="flex min-w-0 items-center gap-2">
								<span className="min-w-0 flex-1 truncate font-mono text-code text-fg">{rule.host}</span>
								<ActionBadge action={rule.action} />
							</span>
							<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
								<span className={methodsAndPaths(rule) === "Any" ? undefined : "font-mono"}>
									{methodsAndPaths(rule) === "Any" ? "Any request" : methodsAndPaths(rule)}
								</span>
								<span>{rule.scope.kind === "account" ? "Every sandbox" : rule.scope.name}</span>
							</span>
						</div>
						{menu(rule)}
					</li>
				))}
			</ul>
		);
	}
	return (
		<section
			className={`kt-focusable ${tableFrame}`}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
			tabIndex={0}
			aria-label="Rules"
		>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Rule
						</th>
						<th className={th} scope="col">
							Host
						</th>
						<th className={th} scope="col">
							Methods and paths
						</th>
						<th className={th} scope="col">
							Applies to
						</th>
						<th className={th} scope="col">
							<span className="kt-sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{rules.map((rule) => {
						const href = scopeHref?.(rule.scope);
						return (
							<tr key={rule.key} data-rule={rule.key} aria-busy={busy === rule.key || undefined}>
								<td className={`${td} w-0`}>
									<ActionBadge action={rule.action} />
								</td>
								<td className={td}>
									<span className={`${cellMono} text-fg`}>{rule.host}</span>
								</td>
								<td className={td}>
									<span className={methodsAndPaths(rule) === "Any" ? "text-muted" : cellMono}>
										{methodsAndPaths(rule)}
									</span>
								</td>
								<td className={td}>
									<ScopeText scope={rule.scope} {...(href === undefined ? {} : { href })} />
								</td>
								<td className={`${td} w-0 text-right`}>{menu(rule)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</section>
	);
}

/** `api.openai.com/v1/`, with the methods first when it is only for some: `POST, GET api.openai.com/v1/`. */
export function destinationText(binding: DestinationBinding): string {
	const methods = binding.methods.length === 0 ? "" : `${binding.methods.join(", ")} `;
	const places =
		binding.pathPrefixes.length === 0 ? [binding.host] : binding.pathPrefixes.map((path) => `${binding.host}${path}`);
	return `${methods}${places.join(", ")}`;
}

export interface ProtectedVariablesTableProps {
	readonly variables: readonly ProtectedVariableRow[];
	readonly narrow?: boolean;
	readonly environmentHref?: (environmentId: string) => string;
}

/** Each protected variable and the hosts the proxy swaps its value in for. */
export function ProtectedVariablesTable({ variables, narrow = false, environmentHref }: ProtectedVariablesTableProps) {
	if (variables.length === 0) {
		return (
			<p className="m-0 py-2 text-sm text-muted">
				No protected variables. Add one to an environment to keep a credential out of its sandboxes.
			</p>
		);
	}
	const scope = (row: ProtectedVariableRow): RuleScope => ({ kind: "environment", ...row.environment });
	if (narrow) {
		return (
			<ul className="m-0 flex list-none flex-col p-0" aria-label="Protected variables">
				{variables.map((row) => (
					<li
						key={`${row.environment.id}/${row.name}`}
						className="flex min-w-0 flex-col gap-1 border-b border-border py-3"
					>
						<span className="flex min-w-0 items-center justify-between gap-2">
							<span className="min-w-0 truncate font-mono text-code text-fg">{row.name}</span>
							<span className="flex-none text-sm text-muted">{row.environment.name}</span>
						</span>
						<span className="font-mono text-xs text-muted [overflow-wrap:anywhere]">
							{row.bindings.map(destinationText).join(", ")}
						</span>
					</li>
				))}
			</ul>
		);
	}
	return (
		<section
			className={`kt-focusable ${tableFrame}`}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
			tabIndex={0}
			aria-label="Protected variables"
		>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Variable
						</th>
						<th className={th} scope="col">
							Swapped in only for
						</th>
						<th className={th} scope="col">
							Environment
						</th>
					</tr>
				</thead>
				<tbody>
					{variables.map((row) => {
						const href = environmentHref?.(row.environment.id);
						return (
							<tr key={`${row.environment.id}/${row.name}`}>
								<td className={`${td} w-0`}>
									<span className="font-mono text-code text-fg">{row.name}</span>
								</td>
								<td className={`${td} whitespace-normal`}>
									<span className={cellMono}>{row.bindings.map(destinationText).join(", ")}</span>
								</td>
								<td className={`${td} w-0`}>
									<ScopeText scope={scope(row)} {...(href === undefined ? {} : { href })} />
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</section>
	);
}

/** A rule to add: what it allows or denies and what it applies to. */
export interface NewRule {
	readonly action: EgressGrant["action"];
	readonly host: string;
	readonly methods: readonly HttpMethod[];
	readonly paths: readonly string[];
	readonly scope: RuleScope;
}

const scopeValue = (scope: RuleScope): string => (scope.kind === "account" ? "account" : `${scope.kind}:${scope.id}`);

export interface AddRuleDialogProps {
	/** Every sandbox first, then the account's environments and sandboxes. */
	readonly scopes: readonly RuleScope[];
	/** What the dialog opens with, such as a denied request's host. */
	readonly initial?: Partial<Pick<NewRule, "action" | "host" | "scope">>;
	/** The account's policy allows nothing: a rule for every sandbox can't allow a host. */
	readonly closed?: boolean;
	readonly onClose: () => void;
	readonly onAdd: (rule: NewRule) => Promise<void>;
}

/**
 * Add rule: allow or deny, a host, what it applies to and, for an environment or a sandbox, optionally methods and
 * paths. A rule for every sandbox is for a whole host: the account's rules name hosts only.
 */
export function AddRuleDialog({ scopes, initial, closed = false, onClose, onAdd }: AddRuleDialogProps) {
	const [action, setAction] = useState<EgressGrant["action"]>(initial?.action ?? "allow");
	const [host, setHost] = useState(initial?.host ?? "");
	const [scope, setScope] = useState(scopeValue(initial?.scope ?? { kind: "account" }));
	const [methods, setMethods] = useState<readonly HttpMethod[]>([]);
	const [paths, setPaths] = useState("");
	const [tried, setTried] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const chosen = scopes.find((each) => scopeValue(each) === scope) ?? scopes[0] ?? { kind: "account" };
	const everySandbox = chosen.kind === "account";
	const hostError = hostProblem(host);
	const pathList = everySandbox ? [] : splitList(paths);
	const pathError = pathList.map(pathProblem).find((problem) => problem !== undefined);
	const scopeError =
		closed && everySandbox && action === "allow"
			? "Sandboxes may reach nothing, so a rule for every sandbox can't allow a host. Choose Allowed hosts first, or apply it to an environment or a sandbox."
			: undefined;
	const submit = () => {
		setTried(true);
		if (hostError !== undefined || pathError !== undefined || scopeError !== undefined || busy) return;
		setBusy(true);
		setFailure(undefined);
		onAdd({
			action,
			host: host.trim().toLowerCase(),
			methods: everySandbox ? [] : methods,
			paths: pathList,
			scope: chosen,
		}).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't add the rule. Try again."));
			},
		);
	};
	return (
		<Dialog
			open
			title="Add rule"
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy}>
						Add rule
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<FormField id="rule-action" label="Rule">
					<SegmentedControl
						label="Rule"
						options={[
							{ value: "allow", label: "Allow" },
							{ value: "deny", label: "Deny" },
						]}
						value={action}
						onChange={setAction}
					/>
				</FormField>
				<TextField
					label="Host"
					hint="*.example.com covers every subdomain."
					value={host}
					onChange={(event) => setHost(event.currentTarget.value)}
					placeholder="api.github.com"
					mono
					spellCheck={false}
					{...(tried && hostError !== undefined ? { error: hostError } : {})}
				/>
				<SelectField
					label="Applies to"
					value={scope}
					onChange={(event) => setScope(event.currentTarget.value)}
					options={scopes.map((each) => ({
						value: scopeValue(each),
						label:
							each.kind === "account"
								? "Every sandbox"
								: `${each.kind === "environment" ? "Environment" : "Sandbox"}: ${each.name}`,
					}))}
					{...(tried && scopeError !== undefined ? { error: scopeError } : {})}
					hint={
						everySandbox
							? "Every sandbox in the account. For whole hosts: to allow or deny some methods or paths only, apply it to an environment or a sandbox."
							: chosen.kind === "environment"
								? "Every sandbox made from this environment, from its next request."
								: "This sandbox only, from its next request."
					}
				/>
				{everySandbox ? null : (
					<>
						<FormField
							id="rule-methods"
							label="Methods"
							hint="None ticked: every method. Naming methods or paths makes the proxy look inside this host's HTTPS."
						>
							<div className="flex flex-wrap gap-x-4 gap-y-2">
								{HTTP_METHODS.map((method) => (
									<CheckboxField
										key={method}
										label={method}
										checked={methods.includes(method)}
										onChange={(event) => {
											const on = event.currentTarget.checked;
											setMethods((current) =>
												HTTP_METHODS.filter((each) => (each === method ? on : current.includes(each))),
											);
										}}
									/>
								))}
							</div>
						</FormField>
						<TextField
							label="Paths"
							hint="Optional. Comma-separated; * matches one segment, ** the rest: /repos/lleverage-ai/**."
							value={paths}
							onChange={(event) => setPaths(event.currentTarget.value)}
							placeholder="/repos/lleverage-ai/**"
							mono
							spellCheck={false}
							{...(tried && pathError !== undefined ? { error: pathError } : {})}
						/>
					</>
				)}
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
