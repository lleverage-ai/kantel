import type { ConnectionRuleInput, Decision, DecisionInput, HttpMethod, Proposal } from "@kantel/contracts";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { useNow } from "../primitives/clock.ts";
import { SegmentedControl, TextField } from "../primitives/controls.tsx";
import { FormActions, FormField, FormLayout, formInline, PageHeader } from "../primitives/form-layout.tsx";
import { compactAge, timeLeft } from "../primitives/format.ts";
import {
	AlertIcon,
	CheckCircleIcon,
	KeyIcon,
	MinusCircleIcon,
	ShieldIcon,
	VaultIcon,
	XCircleIcon,
} from "../primitives/icons.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice } from "../primitives/surface.tsx";
import { BindingCodePicker } from "../session/vault-approval-card.tsx";
import { isUrgent, methodText } from "../session/vault-model.ts";
import {
	vaultCode,
	vaultCodeLabel,
	vaultCodeRow,
	vaultCodeRule,
	vaultCodeValue,
	vaultMuted,
	vaultSkeletonCode,
	vaultToneDone,
	vaultToneError,
	vaultToneFaint,
} from "../session/vault-styles.ts";
import { ExactRequest } from "./exact-request.tsx";
import { alwaysAllowRule, ruleSummary } from "./exact-request-model.ts";
import { ActiveGrantList, type ActiveGrantListProps } from "./grant-list.tsx";
import type { PasskeyCheck } from "./passkey.ts";
import {
	type DecisionRefusal,
	decisionRefusal,
	draftNarrowing,
	initialDraft,
	isForwarded,
	kindLabel,
	kindText,
	lifetimeLabel,
	lifetimeOptions,
	lifetimeValue,
	type NarrowingDraft,
	previewTerms,
	settledState,
	termsSentence,
	usesText,
	type VaultRequest,
	type Viewer,
} from "./vault-page-model.ts";
import "../session/vault-approval-card.css";
import "./vault-page.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css): the request beside the viewer's active grants, stacked on
// a narrow screen (the side-by-side breakpoint stays in vault-page.css). The binding code, the muted and tone colours
// and the code's placeholder share the card's classes (session/vault-styles.ts), so the code looks the same in both
// places; the code row's wrap under 480px stays in session/vault-approval-card.css, imported above.

/** A part of the request, under a hairline. */
const section = "flex min-w-0 flex-col gap-2.5 border-t border-border pt-4";
const sectionTitle = "m-0 text-sm font-medium text-fg";
const hint = "text-xs text-muted wrap-anywhere";
/** The border of a settled request's outcome, by how it ended. */
const outcomeBorder: Record<string, string> = {
	approved: "border-status-done-soft",
	narrowed: "border-status-done-soft",
	denied: "border-status-error-line",
};

export type VaultRequestViewProps = {
	/** The request, from `loadVaultRequest`. */
	request: VaultRequest;
	/** Who is looking: compared with the person behind the session, to spot a forwarded link. */
	viewer: Viewer;
	/** A fixed time, for stories and screenshots. Without it an open request counts down on the shared clock. */
	now?: number;
	/** Sends the decision to the vault. Rejects with the vault's error, which the page explains. */
	onDecide: (input: DecisionInput) => Promise<Decision>;
	/**
	 * Asks for the approver's passkey before an approval or a paste. See `webAuthnPasskey`. Without it, on a host with no
	 * passkeys yet, the page approves on the host's sign-in alone and says so, rather than claim a passkey it never asked
	 * for.
	 */
	passkey?: PasskeyCheck;
	/** Called after a decision lands, for the host to reload the request and the grants. */
	onDecided?: (decision: Decision) => void;
	/** Stops the request's grant from its settled view. Without it there is no Stop there. */
	onStopGrant?: (grantId: string) => Promise<void>;
	/** A draft to start from: for restoring one after a reload, and for stories. */
	initial?: { draft?: Partial<NarrowingDraft>; pickedCode?: string; refusal?: DecisionRefusal };
	/**
	 * For an exact request (#333): once it is approved, saves `rule` (`alwaysAllowRule`), which allows requests like it
	 * from now on (`POST /v1/connections/{id}/rules/from-approval`). A host whose person may add rules passes it;
	 * without it the page offers approve and deny alone.
	 */
	onAlwaysAllow?: (proposal: Proposal, rule: ConnectionRuleInput) => Promise<void>;
};

const absolute = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** A compact age ("4m") against the page's time, with the date and time on hover. */
function At({ at, now }: { at: number; now: number }) {
	return (
		<time className="kt-time" dateTime={new Date(at).toISOString()} title={absolute.format(at)}>
			{compactAge(at, now)}
		</time>
	);
}

type TermTag = "proposed" | "narrowed" | "approved";

/** Whether the agent proposed a term or the approver narrowed it. */
function termBadge(tag: TermTag | undefined): ReactNode {
	return tag === undefined ? undefined : tag === "narrowed" ? (
		<Badge tone="accent">Narrowed</Badge>
	) : tag === "approved" ? (
		<Badge tone="done">Approved</Badge>
	) : (
		<Badge>Proposed</Badge>
	);
}

/** A term that is read, not edited: a settings row with its label, tag and value. */
function Term({
	label,
	tag,
	hint,
	error,
	children,
}: {
	label: string;
	tag?: TermTag;
	hint?: ReactNode;
	error?: ReactNode;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<FormField
			id={id}
			label={label}
			layout="inline"
			extra={termBadge(tag)}
			hint={hint}
			error={error}
			className="kt-vault-term"
		>
			<div className="flex min-h-control-md min-w-0 items-center wrap-anywhere">{children}</div>
		</FormField>
	);
}

function Requester({ request, viewer, now }: { request: VaultRequest; viewer: Viewer; now: number }) {
	const { requester, proposal } = request;
	const forwarded = isForwarded(request, viewer);
	return (
		<section className={section} aria-labelledby={`${proposal.id}-who`}>
			<h2 id={`${proposal.id}-who`} className={sectionTitle}>
				Requested by
			</h2>
			<FieldList>
				<Field label="Agent">{requester.agent ?? "Unknown agent"}</Field>
				{requester.person === undefined ? null : <Field label="On behalf of">{requester.person}</Field>}
				<Field label="Session">
					{requester.session === undefined ? (
						<span className={vaultMuted}>No session</span>
					) : requester.sessionHref === undefined ? (
						requester.session
					) : (
						<a
							className="kt-focusable rounded-xs text-accent-text no-underline wrap-anywhere hover:underline"
							href={requester.sessionHref}
						>
							{requester.session}
						</a>
					)}
				</Field>
				{requester.project === undefined ? null : <Field label="Project">{requester.project}</Field>}
				<Field label="Organisation">{requester.organisation}</Field>
				<Field label="Asked">
					<At at={proposal.createdAt} now={now} />
				</Field>
			</FieldList>
			{forwarded ? (
				<Notice level="warning" announce={false}>
					This came from {requester.person ?? "someone else"}'s session, not yours. Someone may have forwarded the link.
					Approve only if you know why they need it: Kantel checks your own role, and records you as the approver.
				</Notice>
			) : null}
		</section>
	);
}

/** The terms the approver may narrow: methods, path, lifetime and uses. Host and injection are fixed. */
function EditableTerms({
	request,
	draft,
	setDraft,
	disabled,
	locked = false,
}: {
	request: VaultRequest;
	draft: NarrowingDraft;
	setDraft: (draft: NarrowingDraft) => void;
	disabled: boolean;
	/** The viewer can't decide: the terms show as values, not as fields that look editable. */
	locked?: boolean;
}) {
	const { proposal } = request;
	const { route, lifetime } = proposal.terms;
	const result = draftNarrowing(proposal, draft);
	const tag = (changed: boolean): TermTag => (changed ? "narrowed" : "proposed");
	const options = lifetimeOptions(lifetime.ttlMs);
	const toggle = (method: HttpMethod) => {
		const has = draft.methods.includes(method);
		setDraft({ ...draft, methods: has ? draft.methods.filter((m) => m !== method) : [...draft.methods, method] });
	};
	return (
		// Editable terms: settings rows (FormField, inline), the label and its Proposed or Narrowed tag beside each value
		// or control, on one pair of tracks so the values line up. A read-only value sits on the control's line. 12px apart:
		// `!` because FormLayout sets its own gap with a utility on the same element, and two utilities for one property
		// are ordered by Tailwind's sort, not by which comes later in the class.
		<FormLayout className="gap-3!">
			<Term label="Host">
				<code className="kt-mono kt-selectable">{route.host}</code>
			</Term>
			<Term label="Methods" tag={tag(result.changes.methods)} error={result.errors.methods}>
				{locked ? (
					<code className="kt-mono kt-selectable">{route.methods.join(", ")}</code>
				) : (
					<fieldset className={`${formInline} m-0 border-0 p-0`}>
						<legend className="kt-sr-only">Methods the agent may use</legend>
						{route.methods.map((method) => (
							<label key={method} className="inline-flex min-h-control-sm cursor-pointer items-center gap-1.5">
								<input
									type="checkbox"
									className="kt-focusable peer m-0 size-icon-sm cursor-pointer accent-accent disabled:cursor-default disabled:opacity-60"
									checked={draft.methods.includes(method)}
									disabled={disabled}
									onChange={() => toggle(method)}
								/>
								<span className="kt-mono peer-disabled:cursor-default peer-disabled:opacity-60">{method}</span>
							</label>
						))}
					</fieldset>
				)}
			</Term>
			{locked ? (
				<Term label="Path" tag={tag(result.changes.pathPrefix)}>
					<code className="kt-mono kt-selectable">{route.pathPrefix} and below</code>
				</Term>
			) : (
				<TextField
					label="Path"
					layout="inline"
					extra={termBadge(tag(result.changes.pathPrefix))}
					mono
					value={draft.pathPrefix}
					disabled={disabled}
					spellCheck={false}
					autoComplete="off"
					onChange={(event) => setDraft({ ...draft, pathPrefix: event.target.value })}
					hint={`This path and below. The agent asked for ${route.pathPrefix}.`}
					{...(result.errors.pathPrefix === undefined ? {} : { error: result.errors.pathPrefix })}
				/>
			)}
			<Term label="Injection">
				{request.item === undefined ? (
					<span className={vaultMuted}>Set by the item</span>
				) : (
					<code className="kt-mono kt-selectable">{request.item.injection}</code>
				)}
			</Term>
			<Term label="Lifetime" tag={tag(result.changes.ttlMs)}>
				{disabled ? (
					<span>{draft.ttlMs === undefined ? "No expiry" : lifetimeLabel(draft.ttlMs)}</span>
				) : (
					<SegmentedControl
						label="Lifetime from approval"
						options={options.map((option) => ({ value: option.value, label: option.label }))}
						value={lifetimeValue(draft.ttlMs)}
						onChange={(value) => setDraft({ ...draft, ttlMs: options.find((option) => option.value === value)?.ttlMs })}
					/>
				)}
			</Term>
			{locked ? (
				<Term label="Uses" tag={tag(result.changes.maxUses)}>
					<span>
						{lifetime.maxUses === undefined
							? "No limit"
							: lifetime.maxUses === 1
								? "Once"
								: `At most ${lifetime.maxUses}`}
					</span>
				</Term>
			) : (
				<TextField
					label="Uses"
					layout="inline"
					extra={termBadge(tag(result.changes.maxUses))}
					width="short"
					inputMode="numeric"
					value={draft.maxUses}
					disabled={disabled}
					autoComplete="off"
					placeholder="No limit"
					onChange={(event) => setDraft({ ...draft, maxUses: event.target.value })}
					hint={
						lifetime.maxUses === undefined
							? "Empty for no limit, as the agent asked."
							: `At most ${lifetime.maxUses}, as the agent asked.`
					}
					{...(result.errors.maxUses === undefined ? {} : { error: result.errors.maxUses })}
				/>
			)}
		</FormLayout>
	);
}

/** The binding code, always on show. Plain for reads and settled requests; inside the picker when it must be picked. */
function CodeBlock({ code, note }: { code: string; note: string }) {
	return (
		<div className={vaultCode}>
			<p className={vaultCodeLabel}>Binding code</p>
			<p className={vaultCodeRule}>{note}</p>
			<div className={vaultCodeRow}>
				<code className={`${vaultCodeValue} kt-selectable`}>{code}</code>
			</div>
		</div>
	);
}

function OpenRequest({
	request,
	viewer,
	now: fixedNow,
	onDecide,
	passkey,
	onDecided,
	initial,
	onAlwaysAllow,
}: VaultRequestViewProps) {
	const { proposal } = request;
	const ticking = useNow(1000, fixedNow === undefined);
	const now = fixedNow ?? ticking;
	const [draft, setDraft] = useState<NarrowingDraft>(() => ({ ...initialDraft(proposal), ...initial?.draft }));
	const [pickedCode, setPickedCode] = useState<string | undefined>(initial?.pickedCode);
	const [secretValue, setSecretValue] = useState("");
	const [phase, setPhase] = useState<"idle" | "passkey" | "approving" | "denying">("idle");
	const [refusal, setRefusal] = useState<DecisionRefusal | undefined>(initial?.refusal);
	const id = useId();

	const result = draftNarrowing(proposal, draft);
	const preview = result.valid ? previewTerms(proposal, result.narrowing, now) : undefined;
	const isSecret = proposal.kind === "secret";
	const exact = proposal.kind === "request" ? proposal.terms.request : undefined;
	const readOnly = request.readOnly === "role";
	const mustPick = request.codeRequired && !readOnly;
	const busy = phase !== "idle";
	const project = request.requester.project;

	// An item the viewer can't read may be someone's personal one, which only its owner decides (the vault says no more).
	const hidden = request.item === undefined && request.proposal.terms.itemId !== undefined;
	const blocker = readOnly
		? `You can see this request but not decide it: that needs the operator role on ${project ?? "its project"}${
				hidden ? ", or the credential is someone's personal one, which only they decide" : ""
			}.`
		: mustPick && pickedCode === undefined
			? `Pick the code that matches the card to ${isSecret ? "paste" : "approve"}.`
			: isSecret && secretValue === ""
				? "Paste the value to approve."
				: !result.valid
					? "Fix the terms above to approve."
					: undefined;

	/** Approves; `after`, run once the approval has landed, is for "Always allow", which saves its rule then. */
	const approve = async (after?: () => Promise<void>) => {
		if (blocker !== undefined) return;
		setRefusal(undefined);
		if (passkey !== undefined) {
			const checked = await checkPasskey(passkey);
			if (!checked) return;
		}
		setPhase("approving");
		try {
			const decision = await onDecide({
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				...(pickedCode === undefined ? {} : { pickedCode }),
				...(result.narrowing === undefined ? {} : { narrowing: result.narrowing }),
				...(isSecret ? { secretValue } : {}),
			});
			setSecretValue("");
			if (after !== undefined) {
				try {
					await after();
				} catch (error) {
					const reason = decisionRefusal(error, project === undefined ? {} : { project });
					setRefusal({
						kind: reason.kind === "unavailable" ? "unavailable" : "invalid",
						message: `Approved once, but the rule wasn't saved: ${reason.message}`,
					});
				}
			}
			onDecided?.(decision);
		} catch (error) {
			const reason = decisionRefusal(error, project === undefined ? {} : { project });
			if (reason.kind === "code") setPickedCode(undefined);
			setRefusal(reason);
		} finally {
			setPhase("idle");
		}
	};

	/** Asks for the passkey; false, with the reason shown, when the approval must not go ahead. */
	const checkPasskey = async (check: PasskeyCheck): Promise<boolean> => {
		setPhase("passkey");
		try {
			const confirmed = await check({
				proposalId: proposal.id,
				termsHash: proposal.termsHash,
				action: isSecret ? "paste" : "approve",
				// The same narrowing the decision carries, so the passkey approves exactly these terms.
				...(result.narrowing === undefined ? {} : { narrowing: result.narrowing }),
			});
			if (confirmed === "cancelled") {
				setRefusal({ kind: "passkey", message: "You cancelled the passkey, so nothing was approved." });
				setPhase("idle");
				return false;
			}
			return true;
		} catch {
			setRefusal({ kind: "passkey", message: "Your passkey couldn't be checked, so nothing was approved. Try again." });
			setPhase("idle");
			return false;
		}
	};

	const deny = async () => {
		setRefusal(undefined);
		setPhase("denying");
		try {
			const decision = await onDecide({ proposalId: proposal.id, outcome: "deny" });
			onDecided?.(decision);
		} catch (error) {
			setRefusal(decisionRefusal(error, project === undefined ? {} : { project }));
		} finally {
			setPhase("idle");
		}
	};

	// Approve this one, then save the rule: a wrong code or a cancelled passkey saves nothing.
	const alwaysRule = onAlwaysAllow === undefined ? undefined : alwaysAllowRule(proposal);
	const alwaysAllow =
		onAlwaysAllow === undefined || alwaysRule === undefined
			? undefined
			: () => approve(() => onAlwaysAllow(proposal, alwaysRule));

	const codeError = refusal?.kind === "code" ? refusal.message : undefined;
	const urgent = isUrgent(proposal.expiresAt, now);
	return (
		<>
			<Requester request={request} viewer={viewer} now={now} />

			{exact !== undefined ? (
				<ExactRequest request={exact} />
			) : (
				<section className={section} aria-labelledby={`${id}-terms`}>
					<div className="flex min-h-control-xs items-center justify-between gap-2">
						<h2 id={`${id}-terms`} className={sectionTitle}>
							Terms
						</h2>
						{result.narrowing === undefined || readOnly ? null : (
							<Button size="xs" variant="ghost" disabled={busy} onClick={() => setDraft(initialDraft(proposal))}>
								Undo narrowing
							</Button>
						)}
					</div>
					<p className={hint}>
						{readOnly
							? "The terms the agent asked for."
							: "The agent's terms. Narrow any of them before you approve: the agent is told what you approve, never what it asked for."}
					</p>
					<EditableTerms
						request={request}
						draft={draft}
						setDraft={setDraft}
						disabled={readOnly || busy}
						locked={readOnly}
					/>
					{preview === undefined ? null : (
						<p className="rounded-control bg-sunken px-3 py-2.5 text-sm text-fg wrap-anywhere">
							<span className="text-muted">If you approve, the agent may send </span>
							{termsSentence({
								host: preview.host,
								methods: preview.methods,
								pathPrefix: preview.pathPrefix,
								...(preview.expiresAt === undefined ? {} : { ttlMs: preview.expiresAt - now }),
								...(preview.maxUses === undefined ? {} : { maxUses: preview.maxUses }),
							})}
						</p>
					)}
				</section>
			)}

			<section className={section} aria-labelledby={`${id}-code`}>
				<h2 id={`${id}-code`} className={sectionTitle}>
					Binding code
				</h2>
				<p className={hint}>{kindText[proposal.kind]}</p>
				{mustPick && request.codeChoices !== undefined ? (
					<BindingCodePicker
						codes={request.codeChoices}
						{...(pickedCode === undefined ? {} : { value: pickedCode })}
						onPick={(code) => {
							setPickedCode(code);
							if (refusal?.kind === "code") setRefusal(undefined);
						}}
						disabled={busy}
						label="Pick the code the card in your session shows"
						{...(codeError === undefined ? {} : { error: codeError })}
					/>
				) : (
					<CodeBlock
						code={proposal.bindingCode}
						note={
							readOnly
								? "The card in the requester's session shows the same code."
								: "The card in your session shows the same code. Check they match before you approve."
						}
					/>
				)}
			</section>

			{isSecret && !readOnly ? (
				<section className={section} aria-labelledby={`${id}-paste`}>
					<h2 id={`${id}-paste`} className={sectionTitle}>
						Secret
					</h2>
					<TextField
						label={`Value for ${request.item?.name ?? "the new item"}`}
						type="password"
						autoComplete="off"
						spellCheck={false}
						value={secretValue}
						disabled={busy}
						onChange={(event) => setSecretValue(event.target.value)}
						hint="Pasted here only, and stored encrypted. The agent never sees it."
					/>
				</section>
			) : null}

			{refusal === undefined || refusal.kind === "code" ? null : (
				<Notice level={refusal.kind === "passkey" ? "warning" : "error"}>{refusal.message}</Notice>
			)}

			{/* Approve and deny, with the reason Approve is disabled under them. */}
			<div className="flex flex-col gap-2 border-t border-border pt-4">
				<FormActions>
					<Button
						variant="primary"
						size="md"
						icon={passkey === undefined ? <CheckCircleIcon size="sm" /> : <KeyIcon size="sm" />}
						busy={phase === "passkey" || phase === "approving"}
						disabled={blocker !== undefined || busy}
						aria-describedby={blocker === undefined ? undefined : `${id}-blocker`}
						onClick={() => void approve()}
					>
						{passkey === undefined
							? isSecret
								? "Paste and approve"
								: "Approve"
							: isSecret
								? "Paste and approve with passkey"
								: "Approve with passkey"}
					</Button>
					<Button
						size="md"
						variant="danger"
						busy={phase === "denying"}
						disabled={readOnly || busy}
						onClick={() => void deny()}
					>
						Deny
					</Button>
					{exact === undefined || alwaysAllow === undefined || readOnly ? null : (
						<Button
							size="md"
							variant="ghost"
							disabled={blocker !== undefined || busy}
							onClick={() => void alwaysAllow()}
							aria-describedby={`${id}-always`}
						>
							Approve and always allow requests like this
						</Button>
					)}
				</FormActions>
				{exact === undefined || alwaysAllow === undefined || alwaysRule === undefined || readOnly ? null : (
					<p id={`${id}-always`} className="text-xs text-muted">
						Always allow approves this request, then saves a rule on the connection: {ruleSummary(alwaysRule)}. Later
						requests it covers go out without asking, whatever their body. You can stop it in the connection's rules.
					</p>
				)}
				<p id={`${id}-blocker`} className="text-xs text-muted">
					{phase === "passkey"
						? "Waiting for your passkey."
						: phase === "approving"
							? "Approving."
							: (blocker ??
								(exact !== undefined
									? passkey === undefined
										? "You're approving as the person signed in here. The agent is waiting and sends it once, as soon as you approve."
										: "Your passkey confirms it's you. The agent is waiting and sends it once, as soon as you approve."
									: passkey === undefined
										? "You're approving as the person signed in here. The agent carries on once you've decided."
										: "Your passkey confirms it's you. The agent carries on once you've decided."))}
				</p>
				<p className={`font-mono text-xs tabular-nums ${urgent ? "text-status-approval" : "text-faint"}`}>
					{timeLeft(proposal.expiresAt, now)} to decide
				</p>
			</div>
		</>
	);
}

const settledCopy = {
	approved: { icon: <CheckCircleIcon className={vaultToneDone} />, title: "Approved" },
	narrowed: { icon: <CheckCircleIcon className={vaultToneDone} />, title: "Approved with narrower terms" },
	denied: { icon: <XCircleIcon className={vaultToneError} />, title: "Denied" },
	expired: { icon: <AlertIcon className={vaultToneFaint} />, title: "Expired" },
	revoked: { icon: <MinusCircleIcon className={vaultToneFaint} />, title: "Approved, then stopped" },
	withdrawn: { icon: <MinusCircleIcon className={vaultToneFaint} />, title: "Withdrawn" },
} as const;

function SettledRequest({
	request,
	viewer,
	now,
	state,
	onStopGrant,
}: {
	request: VaultRequest;
	viewer: Viewer;
	now: number;
	state: keyof typeof settledCopy;
	onStopGrant?: (grantId: string) => Promise<void>;
}) {
	const { proposal, grant, decision } = request;
	const proposed = proposal.terms;
	const copy = settledCopy[state];
	const [stopping, setStopping] = useState(false);
	const [stopError, setStopError] = useState<string | undefined>(undefined);
	const byViewer = decision?.decidedBy.kind === "human" && decision.decidedBy.userId === viewer.userId;
	const who = byViewer ? "You" : request.decider;
	const effective = grant;
	const exact = proposal.kind === "request" ? proposal.terms.request : undefined;

	const line = (() => {
		switch (state) {
			case "approved":
			case "narrowed":
				if (exact !== undefined) {
					const sent = effective !== undefined && effective.uses > 0;
					return `${who === undefined ? "Approved" : `${who} approved it`}. ${
						sent ? "The agent sent it, once." : "The agent can send this exact request once."
					}`;
				}
				return `${who === undefined ? "Approved" : `${who} approved it`}. The agent was told the terms below and carried on.`;
			case "revoked":
				return `${who === undefined ? "Approved" : `${who} approved it`}. The grant has since been stopped, so the agent's next request with it is refused.`;
			case "denied":
				return `${who === undefined ? "Denied" : `${who} denied it`}. The agent was told no, and carries on without it.`;
			case "expired":
				return "Nobody decided in time. Nothing changed; the agent can ask again.";
			case "withdrawn":
				return "The agent withdrew the request. Nothing changed.";
		}
	})();

	return (
		<>
			{/* A settled request's outcome, one line at the top. */}
			<div
				className={`flex min-w-0 items-start gap-2.5 rounded-control border bg-panel p-3 ${outcomeBorder[state] ?? "border-border"}`}
			>
				<span className="inline-flex flex-none pt-0.5">{copy.icon}</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<p className="font-medium">{copy.title}</p>
					<p className="text-muted">{line}</p>
				</div>
				{decision === undefined ? null : (
					<span className="flex-none text-xs text-faint">
						<At at={decision.decidedAt} now={now} />
					</span>
				)}
			</div>

			<Requester request={request} viewer={viewer} now={now} />

			{exact === undefined ? null : <ExactRequest request={exact} />}

			<section
				className={section}
				aria-labelledby={`${proposal.id}-settled-terms`}
				hidden={exact !== undefined && effective === undefined}
			>
				<h2 id={`${proposal.id}-settled-terms`} className={sectionTitle}>
					{effective === undefined ? "Terms asked for" : "Terms in force"}
				</h2>
				{effective === undefined ? (
					<FieldList>
						<Field label="Host">
							<code className="kt-mono">{proposed.route.host}</code>
						</Field>
						<Field label="Methods">
							<code className="kt-mono">{methodText(proposed.route.methods)}</code>
						</Field>
						<Field label="Path">
							<code className="kt-mono kt-selectable">{proposed.route.pathPrefix}</code>{" "}
							<span className={vaultMuted}>and below</span>
						</Field>
						<Field label="Lifetime">
							{proposed.lifetime.ttlMs === undefined ? "No expiry" : lifetimeLabel(proposed.lifetime.ttlMs)}
						</Field>
						<Field label="Uses">
							{proposed.lifetime.maxUses === undefined ? "No limit" : String(proposed.lifetime.maxUses)}
						</Field>
					</FieldList>
				) : (
					<>
						<FieldList>
							<Field label="Host">
								<code className="kt-mono">{effective.route.host}</code>
							</Field>
							<Field label="Methods">
								<code className="kt-mono">{methodText(effective.route.methods)}</code>
							</Field>
							<Field label="Path">
								<code className="kt-mono kt-selectable">{effective.route.pathPrefix}</code>{" "}
								<span className={vaultMuted}>and below</span>
							</Field>
							<Field label="Lifetime">
								{effective.expiresAt === undefined
									? "No expiry"
									: effective.status === "active"
										? timeLeft(effective.expiresAt, now)
										: lifetimeLabel(effective.expiresAt - effective.createdAt)}
							</Field>
							<Field label="Uses">{usesText(effective)}</Field>
							<Field label="Grant">
								<span className={`font-medium ${effective.status === "active" ? "text-status-done" : "text-muted"}`}>
									{effective.status === "active"
										? "Active"
										: effective.status === "revoked"
											? "Stopped"
											: effective.status === "expired"
												? "Expired"
												: "Used up"}
								</span>
							</Field>
						</FieldList>
						{state === "narrowed" ? (
							<p className={hint}>
								The agent asked for:{" "}
								{termsSentence({
									host: proposed.route.host,
									methods: proposed.route.methods,
									pathPrefix: proposed.route.pathPrefix,
									...(proposed.lifetime.ttlMs === undefined ? {} : { ttlMs: proposed.lifetime.ttlMs }),
									...(proposed.lifetime.maxUses === undefined ? {} : { maxUses: proposed.lifetime.maxUses }),
								})}
							</p>
						) : null}
						{effective.status === "active" && onStopGrant !== undefined ? (
							<div className="flex flex-col items-start gap-2">
								<Button
									variant="danger"
									size="sm"
									busy={stopping}
									onClick={() => {
										setStopping(true);
										setStopError(undefined);
										onStopGrant(effective.id).then(
											() => setStopping(false),
											() => {
												setStopping(false);
												setStopError("Kantel didn't stop the grant. Try again.");
											},
										);
									}}
								>
									Stop this grant
								</Button>
								{stopError === undefined ? null : <Notice level="error">{stopError}</Notice>}
							</div>
						) : null}
					</>
				)}
			</section>

			<section className={section} aria-labelledby={`${proposal.id}-settled-code`}>
				<h2 id={`${proposal.id}-settled-code`} className={sectionTitle}>
					Binding code
				</h2>
				<CodeBlock code={proposal.bindingCode} note="The same code the card in the session shows." />
			</section>
		</>
	);
}

/**
 * One vault request: who asked and why, the terms (editable for narrowing while open), the binding code, and approve
 * with a passkey or deny. Settled requests show the outcome and the terms in force.
 */
export function VaultRequestView(props: VaultRequestViewProps) {
	const { request, viewer } = props;
	const { proposal } = request;
	const ticking = useNow(1000, props.now === undefined && proposal.status === "pending");
	const now = props.now ?? ticking;
	const state = settledState(request, now);
	const titleId = useId();
	const exact = proposal.kind === "request" ? proposal.terms.request : undefined;
	const name =
		exact !== undefined
			? exact.kind === "mcp_call"
				? `${exact.tool ?? "A tool"} on ${exact.connectionName}`
				: `${exact.method} through ${exact.connectionName}`
			: (request.item?.name ?? proposal.terms.secret?.name ?? "A credential");
	return (
		<article className="flex min-w-0 flex-col gap-6" aria-labelledby={titleId}>
			<header className="flex min-w-0 flex-col gap-2">
				<div className="flex flex-wrap gap-1.5">
					<Badge tone={state === "open" ? "approval" : "neutral"}>
						{state === "open" ? "Needs approval" : "Settled"}
					</Badge>
					<Badge tone={proposal.kind === "read" ? "neutral" : "accent"}>{kindLabel[proposal.kind]}</Badge>
					{request.item?.personalTo === undefined ? null : (
						<Badge tone="neutral">
							{request.item.personalTo === viewer.userId ? "Your personal item" : "Personal item"}
						</Badge>
					)}
				</div>
				<h1 id={titleId} className="m-0 text-lg font-strong leading-tight wrap-anywhere">
					{name} <span className="font-regular text-muted">for</span>{" "}
					<span className="kt-mono">{proposal.terms.route.host}</span>
				</h1>
				<p className="kt-selectable text-md leading-prose text-fg wrap-anywhere">{proposal.terms.reason}</p>
				<p className="flex items-center gap-1.5 text-xs text-muted">
					<ShieldIcon size="sm" className="flex-none text-faint" />{" "}
					{exact !== undefined
						? "The agent never sees the credential. Kantel adds it to this one request on the way out."
						: "The agent never sees the value. Kantel adds it to matching requests on the way out."}
				</p>
			</header>
			{state === "open" ? (
				<OpenRequest {...props} now={now} />
			) : (
				<SettledRequest
					request={request}
					viewer={viewer}
					now={now}
					state={state}
					{...(props.onStopGrant === undefined ? {} : { onStopGrant: props.onStopGrant })}
				/>
			)}
		</article>
	);
}

/** The request's shape while it loads. */
export function VaultRequestSkeleton() {
	return (
		// kt-vault-request-loading: apps/console/scripts/vault-api-check.ts waits for it to go.
		<div className="kt-vault-request-loading flex min-w-0 flex-col gap-3">
			<span className="kt-sr-only">Loading the connection request</span>
			<Skeleton width="30%" />
			<Skeleton width="65%" />
			<Skeleton lines={2} />
			<Skeleton lines={5} width="85%" />
			<span className={vaultSkeletonCode} aria-hidden="true" />
			<Skeleton width="40%" />
		</div>
	);
}

export type VaultPageProps = {
	/** The request the link names; undefined while loading, or when the page was opened without one. */
	request?: VaultRequest;
	viewer: Viewer;
	loading?: boolean;
	/** The request couldn't be loaded. `forbidden` says the viewer may not see it; anything else is shown as given. */
	error?: { kind: "forbidden" } | { kind: "other"; message: string };
	onRetry?: () => void;
	/** The vault's host, shown in the header so the approver can check the origin. */
	vaultHost?: string;
	now?: number;
	onDecide: VaultRequestViewProps["onDecide"];
	/** See `VaultRequestViewProps.passkey`. */
	passkey?: PasskeyCheck;
	onDecided?: VaultRequestViewProps["onDecided"];
	initial?: VaultRequestViewProps["initial"];
	/** See `VaultRequestViewProps.onAlwaysAllow`. */
	onAlwaysAllow?: VaultRequestViewProps["onAlwaysAllow"];
	/** The viewer's active grants, each with Stop. */
	grants: Omit<ActiveGrantListProps, "now">;
	/** Inside a host page with its own main landmark, such as the console: the request isn't wrapped in another. */
	embedded?: boolean;
};

/**
 * The vault page a card's Open in vault link opens: the request beside the viewer's active grants (stacked under it on a
 * narrow screen), with the vault's own host in the header so the approver can check where they are. Opened without a
 * request, the page is the active grants alone, in one column.
 */
export function VaultPage({
	request,
	viewer,
	loading = false,
	error,
	onRetry,
	vaultHost,
	now,
	onDecide,
	passkey,
	onDecided,
	initial,
	onAlwaysAllow,
	grants,
	embedded = false,
}: VaultPageProps) {
	const Main = embedded ? "div" : "main";
	const stopGrant = grants.onStop;
	// A link named a request: it shows, loads or failed to. Without one there's nothing to decide, only grants. The
	// header's vault host and Signed in as are there so an approver can check the origin before approving, so they show
	// only with a request.
	const focused = request !== undefined || loading || error !== undefined;
	const main = useMemo(() => {
		if (error?.kind === "forbidden") {
			return (
				<EmptyState title="You can't open this request">
					It belongs to a project you have no role on. If someone sent you the link, ask them to approve it from their
					own session.
				</EmptyState>
			);
		}
		if (error !== undefined) {
			return (
				<Notice
					level="error"
					action={
						onRetry === undefined ? undefined : (
							<Button size="xs" onClick={onRetry}>
								Try again
							</Button>
						)
					}
				>
					{error.message}
				</Notice>
			);
		}
		if (request === undefined) return loading ? <VaultRequestSkeleton /> : null;
		return (
			<VaultRequestView
				key={`${request.proposal.id}:${request.proposal.status}`}
				request={request}
				viewer={viewer}
				onDecide={onDecide}
				{...(passkey === undefined ? {} : { passkey })}
				onStopGrant={stopGrant}
				{...(now === undefined ? {} : { now })}
				{...(onDecided === undefined ? {} : { onDecided })}
				{...(initial === undefined ? {} : { initial })}
				{...(onAlwaysAllow === undefined ? {} : { onAlwaysAllow })}
			/>
		);
	}, [error, onRetry, request, loading, viewer, onDecide, passkey, stopGrant, now, onDecided, initial, onAlwaysAllow]);

	const grantList = <ActiveGrantList {...grants} {...(now === undefined ? {} : { now })} />;
	return (
		// kt-vault-page: a hook for apps/console/scripts/vault-api-check.ts. Claude.ai's connector permissions: with no
		// request open the grants are the page, one column at the reading width under a header that is just the title.
		<div
			className={`kt-vault-page flex w-full min-w-0 flex-col gap-6 text-sm leading-normal text-fg [&_p]:m-0 ${focused ? "" : "max-w-content"}`}
		>
			<PageHeader
				titleAs="p"
				title={
					embedded ? (
						"Connection requests"
					) : (
						<span className="inline-flex items-center gap-2">
							<VaultIcon className="flex-none" />
							Connection requests
						</span>
					)
				}
				{...(!focused || vaultHost === undefined
					? {}
					: { lede: <span className="font-mono text-xs wrap-anywhere">{vaultHost}</span> })}
				{...(focused ? { actions: <span className="text-xs text-muted">Signed in as {viewer.name}</span> } : {})}
			/>
			{focused ? (
				<div className="kt-vault-page-body grid grid-cols-[minmax(0,1fr)] items-start gap-8">
					<Main className="min-w-0">{main}</Main>
					<aside className="min-w-0">{grantList}</aside>
				</div>
			) : (
				<Main className="min-w-0">{grantList}</Main>
			)}
		</div>
	);
}
