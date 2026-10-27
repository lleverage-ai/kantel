import type { ComponentProps, ReactNode } from "react";
import { Spinner } from "./spinner.tsx";
import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

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
	return (
		<button
			type={type}
			className={`hb-button hb-button-${variant} hb-button-${size} hb-focusable${className ? ` ${className}` : ""}`}
			disabled={disabled || busy}
			aria-busy={busy || undefined}
			{...rest}
		>
			{busy ? <Spinner size="sm" /> : icon}
			{children === undefined ? null : <span className="hb-button-label">{children}</span>}
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
			className={`hb-icon-button${className ? ` ${className}` : ""}`}
		/>
	);
}
