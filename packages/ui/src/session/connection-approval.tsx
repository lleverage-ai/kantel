import type { ConnectionRuleInput } from "@kantel/contracts";
import type { ConnectionApprovalCard } from "@kantel/protocol";
import { createContext, memo, type ReactNode, useContext, useEffect, useId, useState } from "react";
import { Code } from "../code/code.tsx";
import { ProviderLogo } from "../connections/provider-logo.tsx";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { useNow } from "../primitives/clock.ts";
import { CopyButton } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { AlertIcon, CheckCircleIcon, KeyIcon, MinusCircleIcon, XCircleIcon } from "../primitives/icons.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Field, FieldList, Notice } from "../primitives/surface.tsx";
import {
	type ApprovalState,
	approvalRefusal,
	approvalState,
	approvalTitle,
	type CallApprovalCards,
	settledWords,
	timeLeftText,
} from "./connection-approvals-model.ts";
import type { ConnectionCallConnection } from "./connection-calls-model.ts";
import { requestParts } from "./connection-operations.ts";
import { isUrgent } from "./vault-model.ts";

// A connection request waiting on a person, in place in the call that waits on it (#460): what it wants to do in one
// sentence, the request, and Approve once, Allow for this session, Always allow… and Deny, with one click and no binding
// code to type (the session's card is the person's own; a request page opened from a link still asks for the code).
// Once decided it settles to one line under the call that says who decided. The host provides the cards and the
// actions (`ConnectionApprovalsContext`); without the actions it shows the code and a link to the request page, as
// the approval card does.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css).

/** How the person here decided an approval, kept by the host until the card says so too. */
export type ConnectionApprovalDecided = {
	readonly outcome: "approved" | "denied";
	/** Who decided: the person's name. */
	readonly by?: string | undefined;
	/** For an approval: once, or with a rule for the session or for good. */
	readonly scope?: "once" | "session" | "always" | undefined;
};

/** What the host does when the person decides a waiting request in the session. */
export type ConnectionApprovalActions = {
	/**
	 * Approves the request once, with the card's binding code and the terms the vault holds, after the person's passkey
	 * where the organisation asks for one; for `session`, then saves an allow rule for this session on the request's
	 * operation (`sessionRule`). `onApproving` is called once the passkey is through and the approval is on its way.
	 */
	readonly approve: (
		card: ConnectionApprovalCard,
		options: { readonly scope: "once" | "session"; readonly onApproving?: () => void },
	) => Promise<void>;
	readonly deny: (card: ConnectionApprovalCard) => Promise<void>;
	/** The rule "Always allow…" would save for this approval (`alwaysAllowRule`), read from the request the vault holds. */
	readonly alwaysAllowRule: (card: ConnectionApprovalCard) => Promise<ConnectionRuleInput | undefined>;
	/** Approves the request once, as `approve`, then saves `rule`, linked back to the approval. */
	readonly alwaysAllow: (
		card: ConnectionApprovalCard,
		rule: ConnectionRuleInput,
		options: { readonly onApproving?: () => void },
	) => Promise<void>;
	/** Whether the person may add rules to the connection: only then are the session and standing choices offered. */
	readonly canManage: (connectionId: string) => boolean;
	/** Approving asks for the person's passkey first. */
	readonly passkey: boolean;
	/** How the person here decided the approval, until the card says so; and who did, for its settled line. */
	readonly decided: (proposalId: string) => ConnectionApprovalDecided | undefined;
};

/**
 * The session's approval cards by the call that waits on each (`callApprovals`), and what the person can do about
 * them. The console provides it around the transcript.
 */
export type ConnectionApprovals = {
	readonly cards: CallApprovalCards;
	/** Without them the approval shows its binding code and a link to the request page. */
	readonly actions?: ConnectionApprovalActions | undefined;
};

export const ConnectionApprovalsContext = createContext<ConnectionApprovals | undefined>(undefined);

/** What the approval is doing now. */
type Phase = "idle" | "passkey" | "approving" | "session" | "denying";

/** The waiting approval's frame: in the approval colour, a card's padding, its parts a block's step apart. */
const pendingFrame =
	"kt-connection-approval flex min-w-0 flex-col gap-3 rounded-panel border border-status-approval-line bg-panel p-3 text-sm leading-normal text-fg";
/** A settled approval's line, in line with the call's words. */
const settledLine =
	"kt-connection-approval-settled flex min-w-0 items-baseline gap-2 text-xs leading-normal text-muted [&>.kt-icon]:translate-y-(--kt-on-cap) [&>.kt-icon]:self-baseline";
const bodyFrame =
	"kt-selectable kt-focusable m-0 max-h-(--kt-tool-output-height) overflow-auto rounded-sm bg-code-surface px-2.5 py-2 font-mono text-code whitespace-pre-wrap wrap-anywhere text-fg";
const pageLink = "kt-focusable text-muted underline decoration-border-strong underline-offset-2 hover:text-fg";

export type ConnectionApprovalProps = {
	card: ConnectionApprovalCard;
	/** The call still waits (or sends): a pending approval shows only while it does. */
	running: boolean;
	/** The connection, as the host knows it: its logo, name and account. */
	connection?: ConnectionCallConnection | undefined;
	/** The body the call sends, when the call's own arguments say (a script's inner call's don't reach the session). */
	body?: string | undefined;
	/** A fixed time, for stories. Without it a waiting approval reads the shared clock each second. */
	now?: number;
};

/**
 * A connection request's approval in its call: the request and its four choices while it waits, one line once settled.
 * Memoised on its props; the host's actions and decisions arrive by context.
 */
export const ConnectionApproval = memo(function ConnectionApproval({
	card,
	running,
	connection,
	body,
	now,
}: ConnectionApprovalProps) {
	const approvals = useContext(ConnectionApprovalsContext);
	const actions = approvals?.actions;
	const decided = actions?.decided(card.proposalId);
	const ticking = useNow(1000, now === undefined && card.status === "pending" && decided === undefined);
	const time = now ?? ticking;
	const state = approvalState(card, decided?.outcome, time);
	if (state !== "pending") return <SettledApproval card={card} state={state} decided={decided} />;
	// The call ended with the card still open (stopped, say): nothing waits on it here.
	if (!running) return null;
	return <PendingApproval card={card} connection={connection} body={body} now={time} actions={actions} />;
});

/** One line under the call: who decided, and what it was. */
function SettledApproval({
	card,
	state,
	decided,
}: {
	card: ConnectionApprovalCard;
	state: Exclude<ApprovalState, "pending">;
	decided: ConnectionApprovalDecided | undefined;
}) {
	const icon =
		state === "approved" ? (
			<CheckCircleIcon size="sm" className="flex-none text-status-done" />
		) : state === "denied" ? (
			<XCircleIcon size="sm" className="flex-none text-status-error" />
		) : state === "expired" ? (
			<AlertIcon size="sm" className="flex-none text-faint" />
		) : (
			<MinusCircleIcon size="sm" className="flex-none text-faint" />
		);
	const scope =
		state !== "approved" || decided?.scope === undefined || decided.scope === "once"
			? ""
			: decided.scope === "session"
				? ", and for the rest of this session"
				: ", and from now on";
	return (
		<p className={settledLine}>
			{icon}
			<span className="min-w-0 wrap-anywhere">
				<span className="text-fg">
					{settledWords(state, decided?.by)}
					{scope}
				</span>
				: {approvalTitle(card)}
			</span>
		</p>
	);
}

/** The request as it goes out: the method in the approval colour, the host at full strength, the path muted. */
function RequestLine({ card }: { card: ConnectionApprovalCard }) {
	const request = card.request;
	if (request === undefined) return null;
	if (request.kind !== "http") {
		return (
			<p className="m-0 min-w-0 font-mono text-code text-muted wrap-anywhere">
				{request.tool === undefined ? "Its tools" : request.tool} on{" "}
				<span className="text-fg">{request.connectionName}</span>
			</p>
		);
	}
	const parts = requestParts({ method: request.method, url: request.url });
	return (
		<p className="kt-connection-approval-request m-0 flex min-w-0 items-baseline gap-2 font-mono text-code">
			<span className="flex-none font-medium text-status-approval">{request.method}</span>
			<span className="min-w-0 wrap-anywhere">
				{parts === undefined ? (
					<span className="text-fg">{request.url}</span>
				) : (
					<>
						<span className="font-medium text-fg">{parts.host}</span>
						<span className="text-muted">{request.url.slice(request.url.indexOf(parts.host) + parts.host.length)}</span>
					</>
				)}
			</span>
		</p>
	);
}

/** The body it sends, formatted when it is JSON. */
function Body({ body }: { body: string }) {
	let shown = body;
	let json = false;
	try {
		shown = JSON.stringify(JSON.parse(body), null, 2);
		json = true;
	} catch {
		// Not JSON: as it goes out.
	}
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
		<pre className={bodyFrame} tabIndex={0}>
			<Code code={shown} language={json ? "json" : undefined} />
		</pre>
	);
}

/** The waiting approval: who and where, what it wants to do, the request, the agent's reason, and the choices. */
function PendingApproval({
	card,
	connection,
	body,
	now,
	actions,
}: {
	card: ConnectionApprovalCard;
	connection: ConnectionCallConnection | undefined;
	body: string | undefined;
	now: number;
	actions: ConnectionApprovalActions | undefined;
}) {
	const titleId = useId();
	const noteId = useId();
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string>();
	const [always, setAlways] = useState(false);
	const name = connection?.name ?? card.request?.connectionName ?? card.host;
	const connectionId = card.request?.connectionId;
	const manage = actions !== undefined && connectionId !== undefined && actions.canManage(connectionId);
	const standing = manage && card.request !== undefined && card.request.kind !== "mcp_tools";
	const busy = phase !== "idle";

	const approve = async (scope: "once" | "session") => {
		if (actions === undefined) return;
		setError(undefined);
		setPhase(actions.passkey ? "passkey" : scope === "session" ? "session" : "approving");
		try {
			await actions.approve(card, {
				scope,
				onApproving: () => setPhase(scope === "session" ? "session" : "approving"),
			});
		} catch (failed) {
			setError(approvalRefusal(failed));
		} finally {
			setPhase("idle");
		}
	};
	const deny = async () => {
		if (actions === undefined) return;
		setError(undefined);
		setPhase("denying");
		try {
			await actions.deny(card);
		} catch (failed) {
			setError(approvalRefusal(failed, "deny"));
		} finally {
			setPhase("idle");
		}
	};

	const note =
		phase === "passkey"
			? "Waiting for your passkey."
			: phase === "approving"
				? "Approving."
				: phase === "session"
					? "Approving, then allowing it for this session."
					: phase === "denying"
						? "Denying."
						: actions === undefined
							? "Open the request page to approve it. It asks for the code above."
							: [
									actions.passkey
										? "Your passkey confirms it's you. The agent sends it once, as soon as you approve."
										: "The agent sends it once, as soon as you approve.",
									manage ? undefined : `Only someone who manages ${name} can allow requests like this for longer.`,
								]
									.filter((line) => line !== undefined)
									.join(" ");

	return (
		<section className={pendingFrame} aria-labelledby={titleId}>
			<header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
				<ProviderLogo name={name} icon={connection?.icon} size="xs" />
				<span className="min-w-0 text-muted wrap-anywhere">
					{name}
					{connection?.account === undefined ? null : (
						<>
							{" "}
							as <span className="font-medium text-fg">{connection.account}</span>
						</>
					)}
				</span>
				<Badge tone="approval">Waiting for you</Badge>
				<span
					className={`ml-auto flex-none font-mono text-xs tabular-nums ${isUrgent(card.expiresAt, now) ? "text-status-approval" : "text-faint"}`}
				>
					{timeLeftText(card.expiresAt, now)}
				</span>
			</header>

			<div className="flex min-w-0 flex-col gap-1">
				<h3 id={titleId} className="m-0 text-md font-medium leading-tight text-fg wrap-anywhere">
					{approvalTitle(card)}
				</h3>
				<RequestLine card={card} />
			</div>

			{body === undefined || body.trim() === "" ? null : <Body body={body} />}

			{card.why.trim() === "" ? null : (
				<FieldList>
					<Field label="Agent's reason">
						<span className="kt-selectable">{card.why}</span>
					</Field>
				</FieldList>
			)}

			{actions === undefined ? (
				<OutOfBand card={card} />
			) : (
				<div className="kt-connection-approval-actions flex min-w-0 flex-wrap items-center gap-2">
					<Button
						variant="primary"
						icon={actions.passkey ? <KeyIcon size="sm" /> : undefined}
						busy={phase === "passkey" || phase === "approving"}
						disabled={busy}
						aria-describedby={noteId}
						onClick={() => void approve("once")}
					>
						Approve once
					</Button>
					{standing ? (
						<>
							<Button busy={phase === "session"} disabled={busy} onClick={() => void approve("session")}>
								Allow for this session
							</Button>
							<Button disabled={busy} onClick={() => setAlways(true)}>
								Always allow…
							</Button>
						</>
					) : null}
					<Button
						variant="danger"
						className="ml-auto"
						busy={phase === "denying"}
						disabled={busy}
						onClick={() => void deny()}
					>
						Deny
					</Button>
				</div>
			)}

			{error === undefined ? null : <Notice level="error">{error}</Notice>}

			<p id={noteId} className="m-0 text-xs text-muted" aria-live="polite">
				{note}
				{actions === undefined || body !== undefined ? null : (
					<>
						{" "}
						<a className={pageLink} href={card.link} target="_blank" rel="noopener noreferrer">
							Open the request page
						</a>
					</>
				)}
			</p>

			{actions === undefined || !standing ? null : (
				<AlwaysAllowDialog open={always} card={card} name={name} actions={actions} onClose={() => setAlways(false)} />
			)}
		</section>
	);
}

/** Without the host's actions: the binding code, and the request page, where it is approved. */
function OutOfBand({ card }: { card: ConnectionApprovalCard }) {
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-2">
			<a
				className={`${buttonClass("primary", "sm")} no-underline`}
				href={card.link}
				target="_blank"
				rel="noopener noreferrer"
			>
				<span className={buttonLabelClass}>Open request</span>
				<span className="kt-sr-only">, opens in a new tab</span>
			</a>
			<CopyButton text={card.link} label="Copy link" />
			<span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted">
				Code <code className="kt-selectable font-mono text-sm font-medium text-fg">{card.bindingCode}</code>
			</span>
		</div>
	);
}

/** Who a rule is for, in words. */
function ruleWho(rule: ConnectionRuleInput): string {
	switch (rule.who.kind) {
		case "agent":
			return "This agent, in any session";
		case "session":
			return "This session only";
		case "project":
			return "Any agent in this project";
		default:
			return "Any agent";
	}
}

/** What a rule covers, in words. */
function ruleWhat(rule: ConnectionRuleInput): ReactNode {
	const what = rule.what;
	if (what.kind === "tool") return <code className="font-mono text-code">{what.tool}</code>;
	if (what.kind === "endpoint")
		return (
			<code className="font-mono text-code wrap-anywhere">
				{what.method} {what.host ?? ""}
				{what.path}
			</code>
		);
	return "Any request";
}

/**
 * "Always allow…": the rule it would save, in words, before it is saved. Save approves this request once and saves
 * the rule, linked back to the approval.
 */
function AlwaysAllowDialog({
	open,
	card,
	name,
	actions,
	onClose,
}: {
	open: boolean;
	card: ConnectionApprovalCard;
	name: string;
	actions: ConnectionApprovalActions;
	onClose: () => void;
}) {
	const [rule, setRule] = useState<ConnectionRuleInput | null>();
	const [phase, setPhase] = useState<"idle" | "passkey" | "saving">("idle");
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!open) return;
		let current = true;
		setRule(undefined);
		setError(undefined);
		actions.alwaysAllowRule(card).then(
			(found) => {
				if (current) setRule(found ?? null);
			},
			() => {
				if (current) setRule(null);
			},
		);
		return () => {
			current = false;
		};
	}, [open, actions, card]);

	const save = async () => {
		if (rule === undefined || rule === null) return;
		setError(undefined);
		setPhase(actions.passkey ? "passkey" : "saving");
		try {
			await actions.alwaysAllow(card, rule, { onApproving: () => setPhase("saving") });
			onClose();
		} catch (failed) {
			setError(approvalRefusal(failed));
		} finally {
			setPhase("idle");
		}
	};

	return (
		<Dialog
			open={open}
			title={`Always allow on ${name}`}
			onClose={() => {
				if (phase === "idle") onClose();
			}}
			onSubmit={() => void save()}
			actions={
				<>
					<Button variant="ghost" disabled={phase !== "idle"} onClick={onClose}>
						Cancel
					</Button>
					<Button
						type="submit"
						variant="primary"
						icon={actions.passkey ? <KeyIcon size="sm" /> : undefined}
						busy={phase !== "idle"}
						disabled={rule === undefined || rule === null}
					>
						Save
					</Button>
				</>
			}
		>
			{rule === undefined ? (
				<p className="flex items-center gap-2">
					<Spinner size="sm" /> Reading the request
				</p>
			) : rule === null ? (
				<p>Kantel can't make a standing rule from this request. Approve it once instead.</p>
			) : (
				<>
					<p>
						Saving approves this request once, then adds a rule to <strong>{name}</strong>. Later requests it covers go
						out without asking, whatever their body. You can stop it in the connection's rules.
					</p>
					<div className="mt-3 rounded-control bg-sunken px-3 py-2.5 text-fg">
						<FieldList>
							<Field label="Allows">{ruleWhat(rule)}</Field>
							<Field label="For">{ruleWho(rule)}</Field>
						</FieldList>
					</div>
					{phase === "passkey" ? <p className="mt-2">Waiting for your passkey.</p> : null}
					{error === undefined ? null : <p className="kt-dialog-error mt-2">{error}</p>}
				</>
			)}
		</Dialog>
	);
}
