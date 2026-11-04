import type { ComponentProps, ReactNode } from "react";
import { Spinner } from "./spinner.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

/**
 * What every button shares. A coarse pointer gets the touch height whatever the size asked for. Busy blocks clicks
 * (disabled) but stays nearer full strength than a plain disabled button.
 */
const buttonBase =
	"inline-flex flex-none items-center justify-center gap-1.5 border [font-family:inherit] font-medium leading-none whitespace-nowrap cursor-pointer transition-colors duration-(--kt-duration-fast) disabled:cursor-default disabled:not-aria-busy:opacity-50 aria-busy:opacity-80 pointer-coarse:min-h-control-lg";

/** Each variant's border colour, background and text colour, and its hover (never while disabled). */
const buttonVariants: { readonly [variant in ButtonVariant]: string } = {
	primary: "border-transparent bg-primary text-primary-fg hover:not-disabled:bg-primary-hover",
	secondary: "border-transparent bg-secondary text-fg hover:not-disabled:bg-secondary-hover",
	ghost: "border-transparent bg-transparent text-muted hover:not-disabled:bg-hover hover:not-disabled:text-fg",
	danger: "border-transparent bg-destructive text-on-solid hover:not-disabled:bg-destructive/85",
	/** A destructive action that isn't the page's point (Leave): the secondary ground, in the danger colour. */
	"danger-quiet": "border-transparent bg-secondary text-destructive hover:not-disabled:bg-secondary-hover",
};

/** Each size's height, inline padding and font size, for a button with words. Every button has the control radius, as the Lleverage app's. */
const buttonSizes: { readonly [size in ButtonSize]: string } = {
	xs: "h-control-xs px-2.5 py-0 text-sm rounded-control",
	sm: "h-control-sm px-3 py-0 text-sm rounded-control",
	md: "h-control-md px-3.5 py-0 text-sm rounded-control",
	lg: "h-control-lg px-4.5 py-0 text-md rounded-control",
};

/** The same for an icon-only button: round, no padding, and touch-wide as well as touch-tall on a coarse pointer. */
const iconButtonSizes: { readonly [size in ButtonSize]: string } = {
	xs: "size-control-xs p-0 text-sm rounded-control pointer-coarse:min-w-control-lg",
	sm: "size-control-sm p-0 text-sm rounded-control pointer-coarse:min-w-control-lg",
	md: "size-control-md p-0 text-sm rounded-control pointer-coarse:min-w-control-lg",
	lg: "size-control-lg p-0 text-md rounded-control pointer-coarse:min-w-control-lg",
};

/**
 * A button's classes, for an element that isn't a `<button>` but should look like one (a link that opens the vault).
 * Keeps the `kt-button` hook classes other stylesheets and the design loop select on. Put its words in a span with
 * `buttonLabelClass`.
 */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "sm", iconOnly = false): string {
	const hooks = `kt-button kt-button-${variant} kt-button-${size} kt-focusable${iconOnly ? " kt-icon-button" : ""}`;
	return `${hooks} ${buttonBase} ${buttonVariants[variant]} ${iconOnly ? iconButtonSizes[size] : buttonSizes[size]}`;
}

/**
 * A button's label. Trimmed to its capitals (cap height down to the baseline), so centring it in the button centres
 * the letters rather than a line box whose space below them is deeper than above. The padding gives descenders room
 * inside the clip and, being even, keeps the capitals on the button's centre.
 */
export const buttonLabelClass =
	"kt-button-label min-w-0 py-(--kt-trim-room) overflow-hidden text-ellipsis [text-box:trim-both_cap_alphabetic]";

export type ButtonProps = Omit<ComponentProps<"button">, "type"> & {
	variant?: ButtonVariant;
	size?: ButtonSize;
	/** A leading icon. Never an arrow: say where the button goes in words. */
	icon?: ReactNode;
	/** Shows a spinner in place of the icon and blocks clicks, keeping the button's width. */
	busy?: boolean;
	type?: "button" | "submit" | "reset";
};

/**
 * A button. One primary per surface; secondary for the alternatives; ghost inside dense rows; danger only for the
 * action that destroys or refuses something. Labels are short verbs in sentence case: "Approve", "Open in vault".
 *
 * An `kt-icon-button` class in `className` makes it square, as IconButton does (CopyButton's icon-only form passes it).
 */
export function Button({
	variant = "secondary",
	size = "sm",
	icon,
	busy = false,
	type = "button",
	className,
	children,
	disabled,
	...rest
}: ButtonProps) {
	const extra = className?.split(/\s+/).filter((name) => name !== "") ?? [];
	const iconOnly = extra.includes("kt-icon-button");
	const others = extra.filter((name) => name !== "kt-icon-button").join(" ");
	return (
		<button
			type={type}
			className={`${buttonClass(variant, size, iconOnly)}${others === "" ? "" : ` ${others}`}`}
			disabled={disabled || busy}
			aria-busy={busy || undefined}
			{...rest}
		>
			{busy ? <Spinner size="sm" /> : icon}
			{children === undefined ? null : <span className={buttonLabelClass}>{children}</span>}
		</button>
	);
}

export type IconButtonProps = Omit<ButtonProps, "children" | "icon"> & {
	/** What the button does, for screen readers and the tooltip. Required: an icon alone is not a label. */
	label: string;
	icon: ReactNode;
};

/** A square button with only an icon. The label becomes its accessible name and its tooltip. */
export function IconButton({ label, icon, className, title, ...rest }: IconButtonProps) {
	return (
		<Button
			{...rest}
			icon={icon}
			aria-label={label}
			title={title ?? label}
			className={`kt-icon-button${className ? ` ${className}` : ""}`}
		/>
	);
}
