import { type ReactNode, useEffect, useId, useRef } from "react";
import { Button } from "./button.tsx";
import { CopyButton } from "./controls.tsx";
import { FormActions } from "./form-layout.tsx";
import { Notice, Panel } from "./surface.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/** Text to copy, in code's font on the sunken ground: one click selects all of it. */
const codeFrame =
	"m-0 min-w-0 flex-1 rounded-control border border-border-input bg-sunken px-2.5 py-2 font-mono text-code leading-normal text-fg select-all wrap-anywhere whitespace-pre-wrap";

/**
 * A command to run, in code's font, with its own Copy. It wraps anywhere rather than scroll, so the whole command is
 * on screen at 420px.
 */
export function CommandBlock({
	command,
	label,
	copyLabel = "Copy command",
}: {
	command: string;
	/** What the command is for, above it: "For a stdio server". */
	label?: ReactNode;
	copyLabel?: string;
}) {
	return (
		<div className="kt-command-block flex min-w-0 flex-col gap-1">
			{label === undefined ? null : <span className="text-xs text-muted">{label}</span>}
			<div className="flex min-w-0 items-start gap-2 max-sm:flex-col max-sm:items-stretch">
				<pre className={codeFrame}>
					<code>{command}</code>
				</pre>
				<CopyButton text={command} label={copyLabel} size="sm" />
			</div>
		</div>
	);
}

export interface OneTimeSecretProps {
	/** What to do now, as the panel's heading: "Copy the token for docs-search now". */
	readonly title: ReactNode;
	readonly secret: string;
	/** What the secret is, read before it by screen readers: "Tunnel token". */
	readonly secretLabel?: string;
	readonly copyLabel?: string;
	/** Commands that use the secret, each with its own Copy: the first is the usual one, the rest alternatives. */
	readonly commands?: readonly { readonly label?: ReactNode; readonly text: string }[];
	/** The "shown once" warning, in words that say where to keep it. */
	readonly warning?: ReactNode;
	/** Anything else to say, after the commands. */
	readonly children?: ReactNode;
	readonly acknowledgeLabel?: string;
	/** The person has stored it; the owner forgets the secret. */
	readonly onAcknowledge: () => void;
	readonly className?: string;
}

/**
 * A secret shown once, when it is made (an API key, a tunnel token): the heading takes focus so a screen reader reads
 * it next, the secret in a code block with Copy, any command that uses it with Copy, a warning that it won't be shown
 * again, and a button to say it's stored. The owner holds the secret only until then.
 */
export function OneTimeSecret({
	title,
	secret,
	secretLabel = "Secret",
	copyLabel = "Copy",
	commands = [],
	warning = "Kantel shows this only once and keeps just a hash of it. If it's lost, make another and revoke this one.",
	children,
	acknowledgeLabel = "I've stored it",
	onAcknowledge,
	className,
}: OneTimeSecretProps) {
	const heading = useRef<HTMLHeadingElement>(null);
	const titleId = useId();
	useEffect(() => heading.current?.focus(), []);
	return (
		<Panel
			tone="approval"
			className={`kt-one-time-secret max-w-content${className === undefined ? "" : ` ${className}`}`}
			aria-labelledby={titleId}
			header={
				<h2
					id={titleId}
					ref={heading}
					tabIndex={-1}
					className="m-0 text-sm font-medium text-fg wrap-anywhere focus:outline-none"
				>
					{title}
				</h2>
			}
		>
			<div className="flex min-w-0 flex-col gap-4">
				<div className="flex min-w-0 items-start gap-2 max-sm:flex-col max-sm:items-stretch">
					<span className="kt-sr-only">{secretLabel}</span>
					<code className={codeFrame}>{secret}</code>
					<CopyButton text={secret} label={copyLabel} size="sm" />
				</div>
				{commands.map((command) => (
					<CommandBlock key={command.text} command={command.text} label={command.label} />
				))}
				{children}
				<Notice level="warning" announce={false}>
					{warning}
				</Notice>
				<FormActions>
					<Button variant="primary" size="sm" onClick={onAcknowledge}>
						{acknowledgeLabel}
					</Button>
				</FormActions>
			</div>
		</Panel>
	);
}
