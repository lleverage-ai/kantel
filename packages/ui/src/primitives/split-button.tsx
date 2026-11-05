import type { ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./button.tsx";
import { CaretIcon } from "./lucide.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/** The two halves meet with no gap and no inner corners; a hairline in the button's own text colour parts them. */
const group = "kt-split-button inline-flex flex-none items-stretch";
const main = "rounded-r-none";
const caret =
	"kt-split-button-caret rounded-l-none border-l-current/25 px-1.5 pointer-coarse:min-w-control-lg [&>.kt-icon]:opacity-80";

export type SplitButtonProps = {
	/** The main action, done at once: "New". */
	readonly label: string;
	readonly icon?: ReactNode;
	readonly onClick: () => void;
	/** What the caret does, for its accessible name and tooltip: "New sandbox with options". */
	readonly moreLabel: string;
	/** The caret: the same action with its choices, usually a dialog. */
	readonly onMore: () => void;
	readonly variant?: ButtonVariant;
	readonly size?: ButtonSize;
	readonly busy?: boolean;
	readonly disabled?: boolean;
};

/**
 * A button that does its action at once, with a caret beside it for the same action with choices, as boat.dev's New:
 * the main half makes a sandbox with the defaults, the caret opens New sandbox's dialog. The caret is its own button,
 * so both are reachable by Tab and each has its own name.
 */
export function SplitButton({
	label,
	icon,
	onClick,
	moreLabel,
	onMore,
	variant = "primary",
	size = "sm",
	busy = false,
	disabled = false,
}: SplitButtonProps) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a pair of buttons, not a fieldset of inputs.
		<span className={group} role="group" aria-label={label}>
			<Button
				variant={variant}
				size={size}
				icon={icon}
				busy={busy}
				disabled={disabled}
				className={main}
				onClick={onClick}
			>
				{label}
			</Button>
			<Button
				variant={variant}
				size={size}
				icon={<CaretIcon size="sm" />}
				disabled={disabled}
				className={caret}
				aria-label={moreLabel}
				title={moreLabel}
				aria-haspopup="dialog"
				onClick={onMore}
			/>
		</span>
	);
}
