import type { ConnectionApprovalCard, VaultApprovalCard as DeprecatedApprovalCard } from "@harbour/protocol";
import { type KeyboardEvent, memo, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { useNow } from "../primitives/clock.ts";
import { CopyButton, Disclosure } from "../primitives/controls.tsx";
import {
	AlertIcon,
	CheckCircleIcon,
	CheckIcon,
	MinusCircleIcon,
	VaultIcon,
	XCircleIcon,
} from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Field, FieldList } from "../primitives/surface.tsx";
import { isRouteGrant, isUrgent, lifetimeText, methodText, vaultHost } from "./vault-model.ts";
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
} from "./vault-styles.ts";
import "./vault-approval-card.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css); the pieces the vault page draws too (the binding code, the
// muted and tone colours, the code's placeholder) are in vault-styles.ts. The hb- classes stay as hooks:
// vault-approval-card.css keeps the narrow layout under 480px (a breakpoint the theme lacks) and the Terms row's reach
// into the Disclosure primitive on them, and apps/console/scripts/vault-api-check.ts waits on hb-code-picker-options
// and on the -loading class.

/**
 * The card's frame, whatever its state; each state adds its gap, padding and border colour. It sets the code block's
 * height, `--hb-vault-code-height` (a local size, a candidate for a token), for the loading card's placeholder.
 */
const frame =
	"hb-vault-card flex w-full max-w-card min-w-0 flex-col rounded-panel border bg-panel text-sm leading-normal text-fg [--hb-vault-code-height:calc(var(--hb-text-display)*var(--hb-leading-tight)_+_var(--hb-step-3)*2)]";
/** A pending card: the full request, edged in the approval colour. 12px in under 480px (vault-approval-card.css). */
const pendingCard = `${frame} hb-vault-card-pending gap-4 border-status-approval-line p-4`;
/** A settled card: one quiet row. */
const settledCard = `${frame} hb-vault-card-settled gap-0 border-border px-3 py-2`;
/** The pending card's shape while it loads. */
const loadingCard = `${frame} hb-vault-card-loading gap-3 border-border p-4`;

/** Header: the vault mark, what is asked, and which vault, at the right. */
const header = "hb-vault-card-header flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted";
/** The vault's host, at the header's end; on its own line, left, under 480px (vault-approval-card.css). */
const host = "hb-vault-card-host ml-auto min-w-0 text-right font-mono text-xs text-muted wrap-anywhere";
/** What is needed, why, and that the agent never sees the value. */
const intro = "hb-vault-card-intro flex min-w-0 flex-col gap-1.5";
const title = "hb-vault-card-title m-0 text-md font-medium leading-tight text-fg wrap-anywhere";
/** The terms under one quiet line saying whose they are, set like the binding code's label so the two read as a pair. */
const termSet = "hb-vault-term-set flex min-w-0 flex-col gap-1.5";
const termSource = "hb-vault-term-source m-0 text-xs font-medium text-muted";
/** Open in vault and Copy link; stacked at full width under 480px (vault-approval-card.css). */
const actions = "hb-vault-card-actions flex flex-wrap items-center gap-2";
/** Open in vault: a link drawn as a primary Button, without the underline a link has by default. */
const openLink = `${buttonClass("primary", "sm")} hb-vault-open no-underline`;

/** A settled card's row: icon, what happened, the code, and on an approved card its Terms. */
const row = "hb-vault-row flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted";
const rowIcon = "hb-vault-row-icon flex-none";
/** What happened: takes the row's spare width. A paragraph on two of the rows, so no margin. */
const rowText = "hb-vault-row-text m-0 min-w-0 flex-1 wrap-anywhere";
const rowCode = "hb-vault-row-code flex-none font-mono text-xs text-faint";
/** The Terms disclosure joins the row: its button sits at the end, its detail wraps onto a full-width line below. */
const terms = "hb-vault-terms contents";

/** The vault page's binding-code picker: the label, the codes, and an error under them. */
const picker = "hb-code-picker flex min-w-0 flex-col gap-2";
const pickerOptions = "hb-code-picker-options flex min-w-0 flex-wrap gap-2";
/** One code: a large, touch-tall option. Its border and background depend on whether it is picked (codeOptionState). */
const codeOption =
	"hb-code-option hb-focusable inline-flex min-h-[calc(var(--hb-control-lg)_+_var(--hb-step-3))] min-w-0 cursor-pointer items-center gap-1.5 rounded-control border py-2 pr-4 pl-2.5 text-fg [font:inherit] transition-[background-color,border-color] duration-(--hb-duration-fast) ease-standard disabled:cursor-default disabled:opacity-50";
/**
 * An option's border and background: unpicked, picked, or picked when the server refused the pick. Hover shows on the
 * first two only, as before: the old hover rule outweighed the picked one, and the refused one outweighed hover.
 */
const codeOptionState = {
	idle: "border-border-strong bg-raised enabled:hover:bg-active",
	picked: "border-accent bg-accent-soft enabled:hover:bg-active",
	refused: "border-status-error-line bg-status-error-soft",
} as const;
/** Holds the tick's place so options don't shift when one is picked. */
const codeOptionMark = "hb-code-option-mark inline-flex w-icon-sm flex-none items-center justify-center";
const codeOptionValue = "hb-code-option-value min-w-0 font-mono text-display font-medium leading-tight wrap-anywhere";

/** A connection approval card, under its type or the deprecated `vault.approval` an older transcript carries. */
type VaultApprovalCardData = ConnectionApprovalCard | DeprecatedApprovalCard;

export type VaultApprovalCardProps = {
	card: VaultApprovalCardData;
	/** A fixed time, for stories and screenshots. Without it the card reads the shared clock, only while pending. */
	now?: number;
	/** Offered on an expired card as "Ask for a new link". Without it the expired card has no action. */
	onAskAgain?: () => void;
	/** Who asked: an agent's or a person's name, shown as "Requested by". */
	requester?: string;
};

/**
 * The terms as label and value pairs, under one line that says who set them: the agent (proposed) or a person
 * (approved). The protocol gives one source for every term on a card, so it is said once rather than as a badge on
 * each row, where five identical amber marks read as five warnings and compete with the binding code. The Lifetime
 * term is the only place the card says how long is left; under two minutes it turns amber. The terms themselves do
 * not move with time: only the Lifetime value does, in its own component, so the list renders with the card alone.
 */
function Terms({ card, now, requester }: { card: VaultApprovalCardData; now?: number; requester?: string }) {
	useRenderProbe("VaultTerms", card.proposalId);
	const source = card.termsSource === "approved" ? "Approved on the connection request page" : "Proposed by the agent";
	return (
		// The values' code wraps anywhere, as the Field's own words do.
		<div className={termSet}>
			<p className={termSource}>{source}</p>
			<FieldList>
				<Field label="Host">
					<code className="hb-mono hb-selectable wrap-anywhere">{card.host}</code>
				</Field>
				<Field label="Methods">
					<code className="hb-mono wrap-anywhere">{methodText(card.methods)}</code>
				</Field>
				<Field label="Path">
					<code className="hb-mono hb-selectable wrap-anywhere">{card.pathPrefix}</code>{" "}
					<span className={vaultMuted}>and below</span>
				</Field>
				<Field label="Injection">
					{isRouteGrant(card) ? (
						<span className={vaultMuted}>Nothing injected: a route grant</span>
					) : (
						<code className="hb-mono hb-selectable wrap-anywhere">{card.injectionTemplate}</code>
					)}
				</Field>
				<Field label="Lifetime">
					<LifetimeValue expiresAt={card.expiresAt} pending={card.status === "pending"} now={now} />
				</Field>
				{requester === undefined ? null : <Field label="Requested by">{requester}</Field>}
			</FieldList>
		</div>
	);
}

/**
 * The Lifetime term's value, the one part of the card that moves with time. While the card is pending and has no fixed
 * `now`, it alone reads the shared one-second clock and re-renders on each tick; the card around it does not.
 */
function LifetimeValue({ expiresAt, pending, now }: { expiresAt: number; pending: boolean; now?: number }) {
	const ticking = useNow(1000, now === undefined && pending);
	const time = now ?? ticking;
	// The card folds to expired on its own timer. Should a tick land before it, keep the last pending wording rather
	// than say "Expired" on a card that still reads as pending; with time left this is the current time.
	const current = pending ? Math.min(time, expiresAt - 1) : time;
	return (
		// Under two minutes left: in the approval colour.
		<span
			className={pending && isUrgent(expiresAt, current) ? "hb-mono hb-vault-urgent text-status-approval" : "hb-mono"}
		>
			{lifetimeText(expiresAt, current)}
		</span>
	);
}

// The longest delay setTimeout holds; a longer one would fire at once.
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * The card a session shows when its agent asks the vault for a secret or a route. It says what is needed and why,
 * that the agent never sees the value, and the exact terms, marked once as the agent's proposal or as approved, with
 * how long is left said once, in the Lifetime term. The binding code is always shown; the vault page shows the same
 * one. Settled cards fold to one row.
 */
export const VaultApprovalCard = memo(function VaultApprovalCard({
	card,
	now,
	onAskAgain,
	requester,
}: VaultApprovalCardProps) {
	useRenderProbe("VaultApprovalCard", card.proposalId);
	const titleId = useId();
	const expiresAt = card.expiresAt;
	// The expiry this card has seen pass. The card holds no clock: a pending, unfixed card sets one timeout for its
	// expiry and re-renders when it fires, or when its props change. A card mounted already past its expiry starts so.
	const [ranOut, setRanOut] = useState<number | undefined>(() =>
		now === undefined && Date.now() >= expiresAt ? expiresAt : undefined,
	);
	const live = now === undefined && card.status === "pending" && ranOut !== expiresAt;
	// A layout effect, so a card whose new expiry has already passed folds before it is painted as pending.
	useLayoutEffect(() => {
		if (!live) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const check = () => {
			const left = expiresAt - Date.now();
			if (left <= 0) setRanOut(expiresAt);
			else timer = setTimeout(check, Math.min(left, MAX_TIMEOUT));
		};
		check();
		return () => clearTimeout(timer);
	}, [live, expiresAt]);

	const timeIsUp = now === undefined ? ranOut === expiresAt : now >= expiresAt;
	const status = card.status === "pending" && timeIsUp ? "expired" : card.status;

	if (status === "approved") {
		return (
			<section className={settledCard} aria-labelledby={titleId}>
				<div className={row}>
					<CheckCircleIcon className={`${rowIcon} ${vaultToneDone}`} />
					<p id={titleId} className={rowText}>
						Approved: {card.what} on <span className="hb-mono">{card.host}</span>
					</p>
					<code className={`${rowCode} hb-selectable`}>{card.bindingCode}</code>
					<Disclosure summary="Terms" className={terms}>
						<Terms card={card} now={now} requester={requester} />
					</Disclosure>
				</div>
			</section>
		);
	}

	if (status === "denied" || status === "withdrawn") {
		const denied = status === "denied";
		return (
			<section className={settledCard} aria-labelledby={titleId}>
				<div className={row}>
					{denied ? (
						<XCircleIcon className={`${rowIcon} ${vaultToneError}`} />
					) : (
						<MinusCircleIcon className={`${rowIcon} ${vaultToneFaint}`} />
					)}
					<p id={titleId} className={rowText}>
						{denied ? "Denied" : "Withdrawn"}: {card.what}
					</p>
					<code className={`${rowCode} hb-selectable`}>{card.bindingCode}</code>
				</div>
			</section>
		);
	}

	if (status === "expired") {
		return (
			<section className={settledCard} aria-labelledby={titleId}>
				<div className={row}>
					<AlertIcon className={`${rowIcon} ${vaultToneFaint}`} />
					<div className={rowText}>
						<p id={titleId} className="hb-vault-row-line m-0 text-muted">
							This request expired before anyone approved it.
						</p>
						<p className="hb-vault-row-detail m-0 text-xs text-faint wrap-anywhere">{card.what}</p>
					</div>
					<code className={`${rowCode} hb-selectable`}>{card.bindingCode}</code>
					{onAskAgain === undefined ? null : (
						<Button size="xs" onClick={onAskAgain}>
							Ask for a new link
						</Button>
					)}
				</div>
			</section>
		);
	}

	const vault = vaultHost(card.link);
	return (
		<section className={pendingCard} aria-labelledby={titleId}>
			<header className={header}>
				<VaultIcon className="hb-vault-card-mark flex-none text-status-approval" />
				<span className="hb-vault-card-ask font-medium text-status-approval">Needs approval</span>
				{isRouteGrant(card) ? <Badge tone="accent">Route grant</Badge> : null}
				{vault === undefined ? null : <span className={host}>{vault}</span>}
			</header>

			<div className={intro}>
				<h3 id={titleId} className={title}>
					{card.what}
				</h3>
				{card.why.trim() === "" ? null : (
					<p className="hb-vault-card-why hb-selectable m-0 text-sm text-muted wrap-anywhere">{card.why}</p>
				)}
				<p className="hb-vault-card-note m-0 text-xs text-muted">
					The agent never sees the value. Harbour adds it to matching requests on the way out.
				</p>
			</div>

			<Terms card={card} now={now} requester={requester} />

			<div className={vaultCode}>
				<p className={vaultCodeLabel}>Binding code</p>
				<p className={vaultCodeRule}>
					The connection request page shows the same code. Check they match before you approve.
				</p>
				<div className={vaultCodeRow}>
					<code className={`${vaultCodeValue} hb-selectable`}>{card.bindingCode}</code>
					<CopyButton text={card.bindingCode} label="Copy code" iconOnly variant="ghost" />
				</div>
			</div>

			<div className={actions}>
				<a className={openLink} href={card.link} target="_blank" rel="noopener noreferrer">
					<span className={buttonLabelClass}>Open request</span>
					<span className="hb-sr-only">, opens in a new tab</span>
				</a>
				<CopyButton text={card.link} label="Copy link" />
			</div>

			<p className="hb-vault-card-closing m-0 text-xs text-muted">The agent carries on when you're done.</p>
		</section>
	);
});

/** The shape of a pending card while it loads: header, title, terms and actions as placeholders. */
export function VaultApprovalCardSkeleton() {
	return (
		<div className={loadingCard}>
			<span className="hb-sr-only">Loading the connection request</span>
			<Skeleton width="35%" />
			<Skeleton width="60%" />
			<Skeleton lines={2} />
			<Skeleton lines={4} width="80%" />
			<span className={vaultSkeletonCode} aria-hidden="true" />
			<Skeleton width="45%" />
		</div>
	);
}

export type BindingCodePickerProps = {
	/** Three or four codes, one of them the card's. The picker does not know which: the server checks. */
	codes: readonly string[];
	value?: string;
	onPick: (code: string) => void;
	disabled?: boolean;
	/** Shown under the codes, for instance after the server refused a pick. */
	error?: string;
	label?: string;
};

/**
 * For the vault page: the approver picks the binding code that matches the card in the session before Approve or
 * Paste is enabled. A radio group of large mono codes; Tab reaches it, arrow keys, Home and End move and pick.
 */
export function BindingCodePicker({
	codes,
	value,
	onPick,
	disabled = false,
	error,
	label = "Pick the code shown on the card",
}: BindingCodePickerProps) {
	const id = useId();
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const selected = value === undefined ? -1 : codes.indexOf(value);
	const invalid = error !== undefined;
	const focusable = selected === -1 ? 0 : selected;

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (disabled || codes.length === 0) return;
		const count = codes.length;
		let next: number;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			next = selected === -1 ? 0 : (selected + 1) % count;
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			next = selected === -1 ? count - 1 : (selected - 1 + count) % count;
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = count - 1;
		} else {
			return;
		}
		event.preventDefault();
		const code = codes[next];
		if (code === undefined) return;
		onPick(code);
		refs.current[next]?.focus();
	};

	return (
		// hb-code-picker-invalid: a hook only; the options and their ticks take the error colours from `invalid` below.
		<div className={invalid ? `${picker} hb-code-picker-invalid` : picker}>
			<p id={`${id}-label`} className="hb-code-picker-label m-0 text-sm text-muted">
				{label}
			</p>
			<div
				className={pickerOptions}
				role="radiogroup"
				aria-labelledby={`${id}-label`}
				aria-describedby={error === undefined ? undefined : `${id}-error`}
				aria-invalid={error === undefined ? undefined : true}
				aria-disabled={disabled || undefined}
				onKeyDown={onKeyDown}
			>
				{codes.map((code, index) => {
					const checked = index === selected;
					const state = checked ? (invalid ? "refused" : "picked") : "idle";
					return (
						// biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio group with roving focus, as SegmentedControl.
						<button
							key={code}
							ref={(element) => {
								refs.current[index] = element;
							}}
							type="button"
							role="radio"
							aria-checked={checked}
							tabIndex={index === focusable ? 0 : -1}
							disabled={disabled}
							className={`${codeOption} ${codeOptionState[state]}`}
							onClick={() => onPick(code)}
						>
							<span
								className={`${codeOptionMark} ${invalid ? "text-status-error" : "text-accent-text"}`}
								aria-hidden="true"
							>
								{checked ? <CheckIcon size="sm" /> : null}
							</span>
							<span className={codeOptionValue}>{code}</span>
						</button>
					);
				})}
			</div>
			{error === undefined ? null : (
				<p id={`${id}-error`} className="hb-code-picker-error m-0 text-xs text-status-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
