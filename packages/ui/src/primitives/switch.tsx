import { type ReactNode, useId } from "react";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/**
 * The track: a pill two thumbs long, the accent colour when on. Busy keeps it focusable (aria-disabled, not disabled,
 * so focus isn't lost while a change saves). On a coarse pointer an invisible ring makes it a touch target.
 */
const track =
	"hb-switch hb-focusable group/switch relative inline-flex h-4 w-7 flex-none cursor-pointer items-center rounded-full border border-border-strong bg-active p-0 transition-colors aria-checked:border-transparent aria-checked:bg-accent disabled:cursor-default disabled:opacity-50 aria-busy:cursor-progress pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5 pointer-coarse:before:content-['']";

/** The thumb slides across when on, and breathes while a change saves: transform and opacity only. */
const thumb =
	"hb-switch-thumb pointer-events-none block size-3 translate-x-0.5 rounded-full bg-muted transition-transform group-aria-checked/switch:translate-x-3 group-aria-checked/switch:bg-accent-fg group-aria-busy/switch:animate-[hb-pulse_var(--hb-duration-pulse)_var(--hb-ease-breathe)_infinite]";

export interface SwitchProps {
	/** What it turns on and off, in a few words: "Enable slack_search". */
	readonly label: ReactNode;
	readonly checked: boolean;
	/** Asked for the new value; the owner sets `checked` (and `busy` while it saves). */
	readonly onChange: (checked: boolean) => void;
	/** Read by screen readers but not shown, where the row already says what it is. */
	readonly hideLabel?: boolean;
	/** A line under the label, read as the switch's description. */
	readonly hint?: ReactNode;
	readonly disabled?: boolean;
	/** The change is saving: the thumb breathes, clicks are ignored and focus stays. */
	readonly busy?: boolean;
	readonly id?: string;
	readonly className?: string;
}

/**
 * An on/off setting that applies the moment it changes, such as a tool's Enabled: no Save button. A button with
 * role="switch" and aria-checked, so Space and Enter toggle it and a screen reader says "on" or "off"; its label
 * beside it toggles it too. For a choice that takes effect with a form, use CheckboxField.
 */
export function Switch({
	label,
	checked,
	onChange,
	hideLabel = false,
	hint,
	disabled = false,
	busy = false,
	id: suppliedId,
	className,
}: SwitchProps) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	const hintId = `${id}-hint`;
	return (
		<div
			className={`hb-switch-field inline-grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 text-sm leading-normal text-fg${className === undefined ? "" : ` ${className}`}`}
		>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				aria-busy={busy || undefined}
				aria-disabled={busy || undefined}
				aria-describedby={hint === undefined ? undefined : hintId}
				disabled={disabled}
				className={track}
				onClick={() => {
					if (!busy) onChange(!checked);
				}}
			>
				<span className={thumb} />
			</button>
			<label
				htmlFor={id}
				className={`hb-switch-label ${hideLabel ? "hb-sr-only" : disabled ? "cursor-default text-disabled" : "cursor-pointer"}`}
			>
				{label}
			</label>
			{hint === undefined ? null : (
				<span id={hintId} className="hb-switch-hint col-start-2 text-xs text-faint">
					{hint}
				</span>
			)}
		</div>
	);
}
