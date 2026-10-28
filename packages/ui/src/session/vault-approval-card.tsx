import type { VaultApprovalCard as VaultApprovalCardData } from "@harbour/protocol";
import { type KeyboardEvent, memo, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
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
import "../primitives/button.css";
import "./vault-approval-card.css";

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
	const source = card.termsSource === "approved" ? "Approved on the vault page" : "Proposed by the agent";
	return (
		<div className="hb-vault-term-set">
			<p className="hb-vault-term-source">{source}</p>
			<FieldList>
				<Field label="Host">
					<code className="hb-mono hb-selectable">{card.host}</code>
				</Field>
				<Field label="Methods">
					<code className="hb-mono">{methodText(card.methods)}</code>
				</Field>
				<Field label="Path">
					<code className="hb-mono hb-selectable">{card.pathPrefix}</code>{" "}
					<span className="hb-vault-muted">and below</span>
				</Field>
				<Field label="Injection">
					{isRouteGrant(card) ? (
						<span className="hb-vault-muted">Nothing injected: a route grant</span>
					) : (
						<code className="hb-mono hb-selectable">{card.injectionTemplate}</code>
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
		<span className={`hb-mono${pending && isUrgent(expiresAt, current) ? " hb-vault-urgent" : ""}`}>
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
			<section className="hb-vault-card hb-vault-card-settled" aria-labelledby={titleId}>
				<div className="hb-vault-row">
					<CheckCircleIcon className="hb-vault-row-icon hb-vault-tone-done" />
					<p id={titleId} className="hb-vault-row-text">
						Approved: {card.what} on <span className="hb-mono">{card.host}</span>
					</p>
					<code className="hb-vault-row-code hb-selectable">{card.bindingCode}</code>
					<Disclosure summary="Terms" className="hb-vault-terms">
						<Terms card={card} now={now} requester={requester} />
					</Disclosure>
				</div>
			</section>
		);
	}

	if (status === "denied" || status === "withdrawn") {
		const denied = status === "denied";
		return (
			<section className="hb-vault-card hb-vault-card-settled" aria-labelledby={titleId}>
				<div className="hb-vault-row">
					{denied ? (
						<XCircleIcon className="hb-vault-row-icon hb-vault-tone-error" />
					) : (
						<MinusCircleIcon className="hb-vault-row-icon hb-vault-tone-faint" />
					)}
					<p id={titleId} className="hb-vault-row-text">
						{denied ? "Denied" : "Withdrawn"}: {card.what}
					</p>
					<code className="hb-vault-row-code hb-selectable">{card.bindingCode}</code>
				</div>
			</section>
		);
	}

	if (status === "expired") {
		return (
			<section className="hb-vault-card hb-vault-card-settled" aria-labelledby={titleId}>
				<div className="hb-vault-row">
					<AlertIcon className="hb-vault-row-icon hb-vault-tone-faint" />
					<div className="hb-vault-row-text">
						<p id={titleId} className="hb-vault-row-line">
							This request expired before anyone approved it.
						</p>
						<p className="hb-vault-row-detail">{card.what}</p>
					</div>
					<code className="hb-vault-row-code hb-selectable">{card.bindingCode}</code>
					{onAskAgain === undefined ? null : (
						<Button size="xs" onClick={onAskAgain}>
							Ask for a new link
						</Button>
					)}
				</div>
			</section>
		);
	}

	const host = vaultHost(card.link);
	return (
		<section className="hb-vault-card hb-vault-card-pending" aria-labelledby={titleId}>
			<header className="hb-vault-card-header">
				<VaultIcon className="hb-vault-card-mark" />
				<span className="hb-vault-card-ask">Needs approval</span>
				{isRouteGrant(card) ? <Badge tone="accent">Route grant</Badge> : null}
				{host === undefined ? null : <span className="hb-vault-card-host">{host}</span>}
			</header>

			<div className="hb-vault-card-intro">
				<h3 id={titleId} className="hb-vault-card-title">
					{card.what}
				</h3>
				{card.why.trim() === "" ? null : <p className="hb-vault-card-why hb-selectable">{card.why}</p>}
				<p className="hb-vault-card-note">
					The agent never sees the value. The vault adds it to matching requests on the way out.
				</p>
			</div>

			<Terms card={card} now={now} requester={requester} />

			<div className="hb-vault-code">
				<p className="hb-vault-code-label">Binding code</p>
				<p className="hb-vault-code-rule">The vault page shows the same code. Check they match before you approve.</p>
				<div className="hb-vault-code-row">
					<code className="hb-vault-code-value hb-selectable">{card.bindingCode}</code>
					<CopyButton text={card.bindingCode} label="Copy code" iconOnly variant="ghost" />
				</div>
			</div>

			<div className="hb-vault-card-actions">
				<a
					className="hb-button hb-button-primary hb-button-sm hb-focusable hb-vault-open"
					href={card.link}
					target="_blank"
					rel="noopener noreferrer"
				>
					<span className="hb-button-label">Open in vault</span>
					<span className="hb-sr-only">, opens in a new tab</span>
				</a>
				<CopyButton text={card.link} label="Copy link" />
			</div>

			<p className="hb-vault-card-closing">The agent carries on when you're done.</p>
		</section>
	);
});

/** The shape of a pending card while it loads: header, title, terms and actions as placeholders. */
export function VaultApprovalCardSkeleton() {
	return (
		<div className="hb-vault-card hb-vault-card-loading">
			<span className="hb-sr-only">Loading the vault request</span>
			<Skeleton width="35%" />
			<Skeleton width="60%" />
			<Skeleton lines={2} />
			<Skeleton lines={4} width="80%" />
			<span className="hb-vault-skeleton-code" aria-hidden="true" />
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
		<div className={`hb-code-picker${error === undefined ? "" : " hb-code-picker-invalid"}`}>
			<p id={`${id}-label`} className="hb-code-picker-label">
				{label}
			</p>
			<div
				className="hb-code-picker-options"
				role="radiogroup"
				aria-labelledby={`${id}-label`}
				aria-describedby={error === undefined ? undefined : `${id}-error`}
				aria-invalid={error === undefined ? undefined : true}
				aria-disabled={disabled || undefined}
				onKeyDown={onKeyDown}
			>
				{codes.map((code, index) => {
					const checked = index === selected;
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
							className="hb-code-option hb-focusable"
							onClick={() => onPick(code)}
						>
							<span className="hb-code-option-mark" aria-hidden="true">
								{checked ? <CheckIcon size="sm" /> : null}
							</span>
							<span className="hb-code-option-value">{code}</span>
						</button>
					);
				})}
			</div>
			{error === undefined ? null : (
				<p id={`${id}-error`} className="hb-code-picker-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
