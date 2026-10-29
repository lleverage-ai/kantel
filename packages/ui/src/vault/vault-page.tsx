import type { Decision, DecisionInput, HttpMethod } from "@harbour/contracts";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { useNow } from "../primitives/clock.ts";
import { SegmentedControl, TextField } from "../primitives/controls.tsx";
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
import "../primitives/button.css";
import "../session/vault-approval-card.css";
import "./vault-page.css";

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
};

const absolute = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** A compact age ("4m") against the page's time, with the date and time on hover. */
function At({ at, now }: { at: number; now: number }) {
	return (
		<time className="hb-time" dateTime={new Date(at).toISOString()} title={absolute.format(at)}>
			{compactAge(at, now)}
		</time>
	);
}

/** A label, its value and whether the agent proposed it or the approver narrowed it. */
function Term({
	label,
	tag,
	children,
	htmlFor,
}: {
	label: string;
	tag?: "proposed" | "narrowed" | "approved";
	children: ReactNode;
	htmlFor?: string;
}) {
	const badge =
		tag === undefined ? null : tag === "narrowed" ? (
			<Badge tone="accent">Narrowed</Badge>
		) : tag === "approved" ? (
			<Badge tone="done">Approved</Badge>
		) : (
			<Badge>Proposed</Badge>
		);
	return (
		<div className="hb-vault-term">
			<div className="hb-vault-term-head">
				{htmlFor === undefined ? (
					<span className="hb-vault-term-label">{label}</span>
				) : (
					<label className="hb-vault-term-label" htmlFor={htmlFor}>
						{label}
					</label>
				)}
				{badge}
			</div>
			<div className="hb-vault-term-value">{children}</div>
		</div>
	);
}

function Requester({ request, viewer, now }: { request: VaultRequest; viewer: Viewer; now: number }) {
	const { requester, proposal } = request;
	const forwarded = isForwarded(request, viewer);
	return (
		<section className="hb-vault-section" aria-labelledby={`${proposal.id}-who`}>
			<h2 id={`${proposal.id}-who`} className="hb-vault-section-title">
				Requested by
			</h2>
			<FieldList>
				<Field label="Agent">{requester.agent ?? "Unknown agent"}</Field>
				{requester.person === undefined ? null : <Field label="On behalf of">{requester.person}</Field>}
				<Field label="Session">
					{requester.session === undefined ? (
						<span className="hb-vault-muted">No session</span>
					) : requester.sessionHref === undefined ? (
						requester.session
					) : (
						<a className="hb-vault-link hb-focusable" href={requester.sessionHref}>
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
					Approve only if you know why they need it: the vault checks your own role, and records you as the approver.
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
	const id = useId();
	const { proposal } = request;
	const { route, lifetime } = proposal.terms;
	const result = draftNarrowing(proposal, draft);
	const tag = (changed: boolean) => (changed ? "narrowed" : "proposed");
	const options = lifetimeOptions(lifetime.ttlMs);
	const toggle = (method: HttpMethod) => {
		const has = draft.methods.includes(method);
		setDraft({ ...draft, methods: has ? draft.methods.filter((m) => m !== method) : [...draft.methods, method] });
	};
	return (
		<div className="hb-vault-terms-edit">
			<Term label="Host">
				<code className="hb-mono hb-selectable">{route.host}</code>
			</Term>
			<Term label="Methods" tag={tag(result.changes.methods)}>
				{locked ? (
					<code className="hb-mono hb-selectable">{route.methods.join(", ")}</code>
				) : (
					<fieldset className="hb-vault-methods" aria-describedby={result.errors.methods ? `${id}-methods` : undefined}>
						<legend className="hb-sr-only">Methods the agent may use</legend>
						{route.methods.map((method) => (
							<label key={method} className="hb-vault-check">
								<input
									type="checkbox"
									className="hb-focusable"
									checked={draft.methods.includes(method)}
									disabled={disabled}
									onChange={() => toggle(method)}
								/>
								<span className="hb-mono">{method}</span>
							</label>
						))}
					</fieldset>
				)}
				{result.errors.methods === undefined ? null : (
					<p id={`${id}-methods`} className="hb-vault-field-error">
						{result.errors.methods}
					</p>
				)}
			</Term>
			<Term label="Path" tag={tag(result.changes.pathPrefix)} {...(locked ? {} : { htmlFor: `${id}-path` })}>
				{locked ? (
					<code className="hb-mono hb-selectable">{route.pathPrefix} and below</code>
				) : (
					<TextField
						id={`${id}-path`}
						label="Path prefix"
						className="hb-vault-hidden-label hb-vault-mono-field"
						value={draft.pathPrefix}
						disabled={disabled}
						spellCheck={false}
						autoComplete="off"
						onChange={(event) => setDraft({ ...draft, pathPrefix: event.target.value })}
						hint={`This path and below. The agent asked for ${route.pathPrefix}.`}
						{...(result.errors.pathPrefix === undefined ? {} : { error: result.errors.pathPrefix })}
					/>
				)}
			</Term>
			<Term label="Injection">
				{request.item === undefined ? (
					<span className="hb-vault-muted">Set by the item</span>
				) : (
					<code className="hb-mono hb-selectable">{request.item.injection}</code>
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
			<Term label="Uses" tag={tag(result.changes.maxUses)} {...(locked ? {} : { htmlFor: `${id}-uses` })}>
				{locked ? (
					<span>
						{lifetime.maxUses === undefined
							? "No limit"
							: lifetime.maxUses === 1
								? "Once"
								: `At most ${lifetime.maxUses}`}
					</span>
				) : (
					<TextField
						id={`${id}-uses`}
						label="Most uses"
						className="hb-vault-hidden-label hb-vault-uses-field"
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
			</Term>
		</div>
	);
}

/** The binding code, always on show. Plain for reads and settled requests; inside the picker when it must be picked. */
function CodeBlock({ code, note }: { code: string; note: string }) {
	return (
		<div className="hb-vault-code">
			<p className="hb-vault-code-label">Binding code</p>
			<p className="hb-vault-code-rule">{note}</p>
			<div className="hb-vault-code-row">
				<code className="hb-vault-code-value hb-selectable">{code}</code>
			</div>
		</div>
	);
}

function OpenRequest({ request, viewer, now: fixedNow, onDecide, passkey, onDecided, initial }: VaultRequestViewProps) {
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
	const readOnly = request.readOnly === "role";
	const mustPick = request.codeRequired && !readOnly;
	const busy = phase !== "idle";
	const project = request.requester.project;

	const blocker = readOnly
		? `You can see this request but not decide it: that needs the operator role on ${project ?? "its project"}.`
		: mustPick && pickedCode === undefined
			? `Pick the code that matches the card to ${isSecret ? "paste" : "approve"}.`
			: isSecret && secretValue === ""
				? "Paste the value to approve."
				: !result.valid
					? "Fix the terms above to approve."
					: undefined;

	const approve = async () => {
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

	const codeError = refusal?.kind === "code" ? refusal.message : undefined;
	const urgent = isUrgent(proposal.expiresAt, now);
	return (
		<>
			<Requester request={request} viewer={viewer} now={now} />

			<section className="hb-vault-section" aria-labelledby={`${id}-terms`}>
				<div className="hb-vault-section-head">
					<h2 id={`${id}-terms`} className="hb-vault-section-title">
						Terms
					</h2>
					{result.narrowing === undefined || readOnly ? null : (
						<Button size="xs" variant="ghost" disabled={busy} onClick={() => setDraft(initialDraft(proposal))}>
							Undo narrowing
						</Button>
					)}
				</div>
				<p className="hb-vault-hint">
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
					<p className="hb-vault-preview">
						<span className="hb-vault-preview-label">If you approve, the agent may send </span>
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

			<section className="hb-vault-section" aria-labelledby={`${id}-code`}>
				<h2 id={`${id}-code`} className="hb-vault-section-title">
					Binding code
				</h2>
				<p className="hb-vault-hint">{kindText[proposal.kind]}</p>
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
				<section className="hb-vault-section" aria-labelledby={`${id}-paste`}>
					<h2 id={`${id}-paste`} className="hb-vault-section-title">
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
						hint="Pasted here only, and stored encrypted in the vault. The agent never sees it."
					/>
				</section>
			) : null}

			{refusal === undefined || refusal.kind === "code" ? null : (
				<Notice level={refusal.kind === "passkey" ? "warning" : "error"}>{refusal.message}</Notice>
			)}

			<div className="hb-vault-decide">
				<div className="hb-vault-decide-actions">
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
				</div>
				<p id={`${id}-blocker`} className="hb-vault-decide-note">
					{phase === "passkey"
						? "Waiting for your passkey."
						: phase === "approving"
							? "Approving."
							: (blocker ??
								(passkey === undefined
									? "You're approving as the person signed in here. The agent carries on once you've decided."
									: "Your passkey confirms it's you. The agent carries on once you've decided."))}
				</p>
				<p className={`hb-vault-countdown-line${urgent ? " hb-vault-countdown-urgent" : ""}`}>
					{timeLeft(proposal.expiresAt, now)} to decide
				</p>
			</div>
		</>
	);
}

const settledCopy = {
	approved: { icon: <CheckCircleIcon className="hb-vault-tone-done" />, title: "Approved" },
	narrowed: { icon: <CheckCircleIcon className="hb-vault-tone-done" />, title: "Approved with narrower terms" },
	denied: { icon: <XCircleIcon className="hb-vault-tone-error" />, title: "Denied" },
	expired: { icon: <AlertIcon className="hb-vault-tone-faint" />, title: "Expired" },
	revoked: { icon: <MinusCircleIcon className="hb-vault-tone-faint" />, title: "Approved, then stopped" },
	withdrawn: { icon: <MinusCircleIcon className="hb-vault-tone-faint" />, title: "Withdrawn" },
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

	const line = (() => {
		switch (state) {
			case "approved":
			case "narrowed":
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
			<div className={`hb-vault-outcome hb-vault-outcome-${state}`}>
				<span className="hb-vault-outcome-icon">{copy.icon}</span>
				<div className="hb-vault-outcome-text">
					<p className="hb-vault-outcome-title">{copy.title}</p>
					<p className="hb-vault-outcome-line">{line}</p>
				</div>
				{decision === undefined ? null : (
					<span className="hb-vault-outcome-time">
						<At at={decision.decidedAt} now={now} />
					</span>
				)}
			</div>

			<Requester request={request} viewer={viewer} now={now} />

			<section className="hb-vault-section" aria-labelledby={`${proposal.id}-settled-terms`}>
				<h2 id={`${proposal.id}-settled-terms`} className="hb-vault-section-title">
					{effective === undefined ? "Terms asked for" : "Terms in force"}
				</h2>
				{effective === undefined ? (
					<FieldList>
						<Field label="Host">
							<code className="hb-mono">{proposed.route.host}</code>
						</Field>
						<Field label="Methods">
							<code className="hb-mono">{methodText(proposed.route.methods)}</code>
						</Field>
						<Field label="Path">
							<code className="hb-mono hb-selectable">{proposed.route.pathPrefix}</code>{" "}
							<span className="hb-vault-muted">and below</span>
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
								<code className="hb-mono">{effective.route.host}</code>
							</Field>
							<Field label="Methods">
								<code className="hb-mono">{methodText(effective.route.methods)}</code>
							</Field>
							<Field label="Path">
								<code className="hb-mono hb-selectable">{effective.route.pathPrefix}</code>{" "}
								<span className="hb-vault-muted">and below</span>
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
								<span className={`hb-vault-grant-status hb-vault-grant-${effective.status}`}>
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
							<p className="hb-vault-hint">
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
							<div className="hb-vault-stop">
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
												setStopError("The vault didn't stop the grant. Try again.");
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

			<section className="hb-vault-section" aria-labelledby={`${proposal.id}-settled-code`}>
				<h2 id={`${proposal.id}-settled-code`} className="hb-vault-section-title">
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
	const name = request.item?.name ?? proposal.terms.secret?.name ?? "A credential";
	return (
		<article className="hb-vault-request" aria-labelledby={titleId}>
			<header className="hb-vault-request-head">
				<div className="hb-vault-request-badges">
					<Badge tone={state === "open" ? "approval" : "neutral"}>
						{state === "open" ? "Needs approval" : "Settled"}
					</Badge>
					<Badge tone={proposal.kind === "read" ? "neutral" : "accent"}>{kindLabel[proposal.kind]}</Badge>
				</div>
				<h1 id={titleId} className="hb-vault-request-title">
					{name} <span className="hb-vault-request-for">for</span>{" "}
					<span className="hb-mono">{proposal.terms.route.host}</span>
				</h1>
				<p className="hb-vault-request-why hb-selectable">{proposal.terms.reason}</p>
				<p className="hb-vault-request-note">
					<ShieldIcon size="sm" /> The agent never sees the value. The vault adds it to matching requests on the way
					out.
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
		<div className="hb-vault-request hb-vault-request-loading">
			<span className="hb-sr-only">Loading the vault request</span>
			<Skeleton width="30%" />
			<Skeleton width="65%" />
			<Skeleton lines={2} />
			<Skeleton lines={5} width="85%" />
			<span className="hb-vault-skeleton-code" aria-hidden="true" />
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
	/** The viewer's active grants, each with Stop. */
	grants: Omit<ActiveGrantListProps, "now">;
	/** Inside a host page with its own main landmark, such as the console: the request isn't wrapped in another. */
	embedded?: boolean;
};

/**
 * The vault page a card's Open in vault link opens: the request beside the viewer's active grants (stacked under it on a
 * narrow screen). The page header shows the vault's own host so the approver can check where they are.
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
	grants,
	embedded = false,
}: VaultPageProps) {
	const Main = embedded ? "div" : "main";
	const stopGrant = grants.onStop;
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
		if (request === undefined) {
			return loading ? (
				<VaultRequestSkeleton />
			) : (
				<EmptyState title="No request to decide">
					Open a request from the card in a session. Your active grants are listed here.
				</EmptyState>
			);
		}
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
			/>
		);
	}, [error, onRetry, request, loading, viewer, onDecide, passkey, stopGrant, now, onDecided, initial]);

	return (
		<div className="hb-vault-page">
			<header className="hb-vault-page-head">
				<VaultIcon className="hb-vault-page-mark" />
				<span className="hb-vault-page-name">Vault</span>
				{vaultHost === undefined ? null : <span className="hb-vault-page-host">{vaultHost}</span>}
				<span className="hb-vault-page-viewer">Signed in as {viewer.name}</span>
			</header>
			<div className="hb-vault-page-body">
				<Main className="hb-vault-page-main">{main}</Main>
				<aside className="hb-vault-page-aside">
					<ActiveGrantList {...grants} {...(now === undefined ? {} : { now })} />
				</aside>
			</div>
		</div>
	);
}
