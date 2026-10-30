import { type CSSProperties, memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CollapseIcon, ExpandIcon } from "../primitives/lucide.tsx";
import { type AnsiLine, type AnsiStyle, hasAnsi, parseAnsi, stripAnsi } from "./ansi.ts";
import { codeLines } from "./code-view.tsx";
import "./code-view.css";
import "./terminal.css";

const count = new Intl.NumberFormat("en-GB");

/** Output lines a collapsed terminal shows: the last ones, where a command says how it ended. */
export const TERMINAL_COLLAPSED_LINES = 10;

function runClass(style: AnsiStyle): string | undefined {
	const classes: string[] = [];
	if (style.fg !== undefined) classes.push(`hb-ansi-fg-${style.fg}`);
	if (style.bg !== undefined) classes.push(`hb-ansi-bg-${style.bg}`);
	if (style.bold) classes.push("hb-ansi-bold");
	if (style.dim) classes.push("hb-ansi-dim");
	if (style.italic) classes.push("hb-ansi-italic");
	if (style.underline) classes.push("hb-ansi-underline");
	return classes.length === 0 ? undefined : classes.join(" ");
}

const OutputLine = memo(function OutputLine({ line, caret = false }: { line: AnsiLine; caret?: boolean }) {
	return (
		<span className="hb-terminal-line">
			{line.map((run, index) => {
				const className = runClass(run.style);
				return className === undefined ? (
					run.text
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: a line's runs are replaced whole, never reordered.
					<span key={index} className={className}>
						{run.text}
					</span>
				);
			})}
			{caret ? <span className="hb-code-caret hb-terminal-caret" aria-hidden="true" /> : null}
			{"\n"}
		</span>
	);
});

/**
 * The command after its prompt, in the terminal's own text colour as a shell shows it (not in the theme's syntax
 * colours, which are chosen for the theme's code surface, not the terminal's dark well); later lines of a multi-line
 * command follow a continuation prompt.
 */
function Command({ command, streaming }: { command: string; streaming: boolean }) {
	const lines = command === "" ? [""] : codeLines(command);
	return (
		<div className="hb-terminal-command">
			{lines.map((line, index) => {
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: the command's lines only grow at the end.
					<div key={index} className="hb-terminal-prompt-line">
						<span className="hb-terminal-prompt" aria-hidden="true">
							{index === 0 ? "$" : ">"}
						</span>
						<span className="hb-terminal-command-text">
							{line}
							{streaming && index === lines.length - 1 ? <span className="hb-code-caret" aria-hidden="true" /> : null}
						</span>
					</div>
				);
			})}
		</div>
	);
}

export type TerminalProps = {
	/** The command, whole or as far as the model has written it. */
	command: string;
	/** The model is still writing the command: a caret follows it, and there is no output yet. */
	commandStreaming?: boolean;
	/** What the command printed: stdout and stderr together, as the shell tool returns them. ANSI colours are kept. */
	output?: string;
	/** What it printed to stderr, when a tool returns it apart: shown after the output, in the error tone. */
	stderr?: string;
	/** The command is running: output so far, and a working caret after it. */
	running?: boolean;
	/** What a screen reader calls the output region. */
	label: string;
	/** Shown under the output: the exit code, a note that the output was cut. */
	footer?: ReactNode;
	collapsedLines?: number;
};

/**
 * A command as an inline terminal: a dark well with the prompt and the command, then what it
 * printed, colours and bold from its ANSI codes honoured, stderr in the error tone when the tool keeps it apart. Long
 * output collapses to its last lines, where a command says how it ended, with "Show all" to read the rest.
 */
export const Terminal = memo(function Terminal({
	command,
	commandStreaming = false,
	output = "",
	stderr = "",
	running = false,
	label,
	footer,
	collapsedLines = TERMINAL_COLLAPSED_LINES,
}: TerminalProps) {
	const [expanded, setExpanded] = useState(false);
	const scroller = useRef<HTMLElement>(null);
	const pinned = useRef(true);
	const outLines = useMemo(
		() =>
			hasAnsi(output) ? parseAnsi(output) : codeLines(output).map((text) => (text === "" ? [] : [{ text, style: {} }])),
		[output],
	);
	const errLines = useMemo(() => parseAnsi(stderr), [stderr]);
	const total = outLines.length + errLines.length;
	const collapsible = total > collapsedLines;
	// A running command's caret sits where its next character would: after an unfinished last line, or on a new one.
	const caretInLine = running && errLines.length === 0 && outLines.length > 0 && !/\n$/.test(stripAnsi(output));
	// The end is where a command says how it went: a collapsed terminal opens there and follows it while it runs.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element === null || expanded || !pinned.current) return;
		element.scrollTop = element.scrollHeight;
	});
	return (
		<div
			className={`hb-terminal${collapsible && !expanded ? " hb-terminal-collapsed" : ""}`}
			style={{ "--hb-code-lines": collapsedLines } as CSSProperties}
		>
			<Command command={command} streaming={commandStreaming} />
			{total > 0 || running ? (
				<section
					ref={scroller}
					className="hb-terminal-scroll hb-focusable"
					aria-label={label}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					tabIndex={0}
					onScroll={(event) => {
						const element = event.currentTarget;
						pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
					}}
				>
					<pre className="hb-terminal-output hb-selectable">
						{outLines.map((line, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: output only grows at its end.
							<OutputLine key={index} line={line} caret={caretInLine && index === outLines.length - 1} />
						))}
						{errLines.length > 0 ? (
							<span className="hb-terminal-stderr">
								<span className="hb-sr-only">Errors: </span>
								{errLines.map((line, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: output only grows at its end.
									<OutputLine key={index} line={line} />
								))}
							</span>
						) : null}
						{running && !caretInLine ? <span className="hb-code-caret hb-terminal-caret" aria-hidden="true" /> : null}
					</pre>
				</section>
			) : null}
			{collapsible ? (
				<button
					type="button"
					className="hb-code-more hb-terminal-more hb-focusable"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? <CollapseIcon size="sm" /> : <ExpandIcon size="sm" />}
					<span>{expanded ? "Show less" : `Show all ${count.format(total)} lines`}</span>
				</button>
			) : null}
			{footer === undefined ? null : <div className="hb-terminal-footer">{footer}</div>}
		</div>
	);
});
