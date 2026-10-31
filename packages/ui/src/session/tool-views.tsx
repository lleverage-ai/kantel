import type { ToolItem } from "@kantel/protocol";
import { createContext, memo, type ReactNode, useMemo } from "react";
import { languageForPath } from "../code/code.tsx";
import { CodeView, codeLines } from "../code/code-view.tsx";
import { diffCounts, diffLines } from "../code/diff.ts";
import { DiffView } from "../code/diff-view.tsx";
import { languageName } from "../code/lines.ts";
import { Terminal } from "../code/terminal.tsx";
import { CopyButton } from "../primitives/controls.tsx";
import { EyeIcon } from "../primitives/icons.tsx";
import { FileDiffIcon, FileWriteIcon, RawIcon, TerminalWindowIcon } from "../primitives/lucide.tsx";
import { Badge } from "../primitives/status.tsx";
import type { ToolDetailProps, ToolRenderer } from "./tool-renderer-model.ts";
import {
	type CommandEnd,
	commandEnd,
	type HarnessNote,
	openByDefault,
	readRange,
	splitHarness,
	type ToolView,
	toolView,
	toolViewLabel,
} from "./tool-views-model.ts";

// The file and shell tools' cards (write, read, edit, bash), in place of their arguments as JSON: a file as an editor
// shows it, an edit as a diff, a command as a terminal. Each card has a header (what, where, how it went) with copy
// and a switch to the raw arguments and output, which every call keeps.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md), as Claude's code cards: a framed block
// under the call's row, the column's full width and in line with the row's icon, not indented under it (T3 Code's tool
// detail panel, WorkLogDetails in WorkLog.tsx, has no inline start margin), with a slim header (an icon, the path with
// its file name at full strength, quiet meta, then Raw and Copy) over the code, diff or terminal, edge to edge. A
// failure frames the card in the error line. The kt- class names stay as hooks for tests and other stylesheets.

const count = new Intl.NumberFormat("en-GB");

/**
 * Inside a card: the generic detail (tool-call.tsx) drawn there as the raw view reads it and leaves off its own frame
 * (margin, border and radius), as the card is its frame.
 */
export const InToolCard = createContext(false);

/** A note's tone, by its severity: an error in the error tone, a warning in the approval tone, the rest quiet. */
const noteTone = { error: "text-status-error", warn: "text-status-approval", info: "" } as const;

function Notes({ notes, inFooter = false }: { notes: readonly HarnessNote[]; inFooter?: boolean }) {
	if (notes.length === 0) return null;
	return (
		<ul
			// Inside a terminal's footer the notes sit on its rule already: no padding or rule of their own.
			className={`kt-tool-card-notes m-0 flex list-none flex-col gap-0.5 text-xs text-faint wrap-anywhere ${inFooter ? "p-0" : "border-t border-border px-3 py-1.5"}`}
		>
			{notes.map((note, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a result's notes never reorder.
				<li key={index} className={`kt-tool-card-note kt-tool-card-note-${note.severity} ${noteTone[note.severity]}`}>
					{note.message}
				</li>
			))}
		</ul>
	);
}

/** A tool's own words about how it went: "Successfully wrote to a.py" quiet, an error in the error tone. */
function Result({ item, body }: { item: ToolItem; body: string }) {
	const text = body.trim();
	if (item.status === "running" || text === "") return null;
	const failed = item.status !== "done";
	return (
		<p
			className={`kt-tool-card-result m-0 border-t border-border px-3 py-1.5 whitespace-pre-wrap wrap-anywhere ${failed ? "kt-tool-card-result-failed font-mono text-code text-status-error" : "text-xs text-faint"}`}
			role={failed ? "alert" : undefined}
		>
			{text}
		</p>
	);
}

export type ToolCardProps = {
	item: ToolItem;
	icon: ReactNode;
	/** The file or command the card is about, in mono. */
	title: ReactNode;
	/** How it went or what it holds, after the title: a badge or counts. */
	meta?: ReactNode;
	/** What the copy button copies; none when there is nothing to copy yet. */
	copy?: { text: string; label: string };
	raw: boolean;
	onRawChange: (raw: boolean) => void;
	children: ReactNode;
};

/** The card's frame. */
const card = "kt-tool-card mx-0 mt-1 mb-2 flex min-w-0 flex-col overflow-hidden rounded-control border bg-panel";
/** The slim header over the card's view. */
const header =
	"kt-tool-card-header flex min-h-[calc(var(--kt-control-xs)_+_var(--kt-step-1_5))] min-w-0 items-center gap-2 border-b border-border py-0.5 pr-1.5 pl-3 text-xs text-muted";
/** Raw: a quiet toggle, lit while on. */
const rawToggle =
	"kt-tool-card-raw kt-focusable inline-flex h-control-xs cursor-pointer items-center gap-1 rounded-sm border-0 px-1.5 py-0 [font-family:inherit] [font-feature-settings:inherit] [font-weight:inherit] text-xs [line-height:inherit]";

/**
 * A call's card: a slim header (an icon, what it is about, how it went, Raw and Copy) over its own view. Any tool's
 * detail can use it, as the browser's steps do (browser-tools.tsx).
 */
export function ToolCard({ item, icon, title, meta, copy, raw, onRawChange, children }: ToolCardProps) {
	return (
		<div
			className={`${card} kt-tool-card-${item.status}${item.streaming ? " kt-tool-card-streaming" : ""} ${item.status === "error" ? "border-status-error-line" : "border-border-strong"}`}
		>
			<div className={header}>
				<span className="kt-tool-card-icon inline-flex flex-none text-faint">{icon}</span>
				<span className="kt-tool-card-title flex min-w-0 flex-auto">{title}</span>
				{meta === undefined ? null : (
					<span className="kt-tool-card-meta inline-flex flex-none items-center gap-2 whitespace-nowrap text-faint tabular-nums">
						{meta}
					</span>
				)}
				<span className="kt-tool-card-actions inline-flex flex-none items-center gap-0.5">
					<button
						type="button"
						className={`${rawToggle} ${raw ? "kt-tool-card-raw-on bg-hover text-fg" : "bg-transparent text-faint hover:bg-hover hover:text-fg"}`}
						aria-pressed={raw}
						title={raw ? "Show the formatted view" : "Show the raw arguments and output"}
						onClick={() => onRawChange(!raw)}
					>
						<RawIcon size="sm" />
						<span>Raw</span>
					</button>
					{copy === undefined || copy.text === "" ? null : (
						<CopyButton text={copy.text} label={copy.label} iconOnly variant="ghost" size="xs" />
					)}
				</span>
			</div>
			<InToolCard.Provider value={true}>{children}</InToolCard.Provider>
		</div>
	);
}

/** The path or the command's name in a header: one line, clipped at its end. */
const pathText = "kt-tool-card-path truncate [direction:ltr]";

/** A path for a header: the file name at full strength after its folder. */
function PathTitle({ path, fallback }: { path: string; fallback: string }) {
	if (path === "") {
		return <span className={`${pathText} kt-tool-card-path-pending font-sans text-xs text-faint`}>{fallback}</span>;
	}
	const slash = path.lastIndexOf("/");
	return (
		<span className={`${pathText} font-mono text-code`} title={path}>
			{slash < 0 ? null : <span className="kt-tool-card-dir text-faint">{path.slice(0, slash + 1)}</span>}
			<span className="kt-tool-card-file text-fg">{path.slice(slash + 1)}</span>
		</span>
	);
}

const languageBadge = (language: string | undefined) => {
	const name = language === undefined ? undefined : languageName(language);
	return name === undefined ? null : <span className="kt-tool-card-language text-faint">{name}</span>;
};

type ViewProps<K extends ToolView["kind"]> = {
	item: ToolItem;
	view: Extract<ToolView, { kind: K }>;
	raw: boolean;
	onRawChange: (raw: boolean) => void;
	rawView: ReactNode;
};

function WriteCard({ item, view, raw, onRawChange, rawView }: ViewProps<"write">) {
	const language = languageForPath(view.path);
	const { body, notes } = splitHarness(item.output ?? "");
	const lines = codeLines(view.content).length;
	const streaming = item.streaming === true;
	return (
		<ToolCard
			item={item}
			icon={<FileWriteIcon />}
			title={<PathTitle path={view.path} fallback="New file" />}
			meta={
				<>
					{languageBadge(language)}
					{lines > 0 ? (
						<span className="kt-tool-card-count">
							{count.format(lines)} {lines === 1 ? "line" : "lines"}
						</span>
					) : null}
				</>
			}
			copy={{ text: view.content, label: "Copy file" }}
			raw={raw}
			onRawChange={onRawChange}
		>
			{raw ? (
				rawView
			) : (
				<>
					<CodeView
						code={view.content}
						language={language}
						streaming={streaming}
						label={`Contents of ${view.path || "the new file"}`}
					/>
					<Result item={item} body={body} />
					<Notes notes={notes} />
				</>
			)}
		</ToolCard>
	);
}

function ReadCard({ item, view, raw, onRawChange, rawView }: ViewProps<"read">) {
	const language = languageForPath(view.path);
	const { body, notes } = splitHarness(item.output ?? "");
	const done = item.status === "done";
	const lines = codeLines(body).length;
	const range = readRange(view, lines, notes);
	const hasImages = (item.images?.length ?? 0) > 0;
	return (
		<ToolCard
			item={item}
			icon={<EyeIcon />}
			title={<PathTitle path={view.path} fallback="A file" />}
			meta={
				<>
					{languageBadge(language)}
					{done && lines > 0 && range.partial ? (
						<span className="kt-tool-card-count">
							Lines {count.format(range.start)}&ndash;{count.format(range.end)}
						</span>
					) : done && lines > 0 ? (
						<span className="kt-tool-card-count">
							{count.format(lines)} {lines === 1 ? "line" : "lines"}
						</span>
					) : null}
				</>
			}
			copy={done ? { text: body, label: "Copy contents" } : undefined}
			raw={raw}
			onRawChange={onRawChange}
		>
			{raw ? (
				rawView
			) : item.status === "running" ? (
				<p className="kt-tool-card-waiting m-0 px-3 py-2.5 text-sm text-faint">Reading&hellip;</p>
			) : done ? (
				<>
					{hasImages && body === "" ? null : (
						<CodeView code={body} language={language} startLine={range.start} label={`Contents of ${view.path}`} />
					)}
					<Notes notes={notes} />
				</>
			) : (
				<>
					<Result item={item} body={body} />
					<Notes notes={notes} />
				</>
			)}
		</ToolCard>
	);
}

function EditCard({ item, view, raw, onRawChange, rawView }: ViewProps<"edit">) {
	const language = languageForPath(view.path);
	const { body, notes } = splitHarness(item.output ?? "");
	const counts = useMemo(() => {
		let additions = 0;
		let deletions = 0;
		for (const edit of view.edits) {
			const counted = diffCounts(diffLines(edit.oldText, edit.newText));
			additions += counted.additions;
			deletions += counted.deletions;
		}
		return { additions, deletions };
	}, [view.edits]);
	return (
		<ToolCard
			item={item}
			icon={<FileDiffIcon />}
			title={<PathTitle path={view.path} fallback="A file" />}
			meta={
				<>
					{languageBadge(language)}
					{counts.additions + counts.deletions > 0 ? (
						<span className="kt-tool-card-count">
							<span className="kt-tool-card-add text-diff-add">+{count.format(counts.additions)}</span>{" "}
							<span className="kt-tool-card-del text-diff-del">&minus;{count.format(counts.deletions)}</span>
						</span>
					) : null}
				</>
			}
			raw={raw}
			onRawChange={onRawChange}
		>
			{raw ? (
				rawView
			) : (
				<>
					<DiffView
						edits={view.edits}
						language={language}
						streaming={item.streaming === true}
						label={`Changes to ${view.path || "the file"}`}
					/>
					<Result item={item} body={body} />
					<Notes notes={notes} />
				</>
			)}
		</ToolCard>
	);
}

function endBadge(end: CommandEnd): ReactNode {
	switch (end.kind) {
		case "running":
			return null;
		case "exited":
			return <Badge tone={end.code === 0 ? "done" : "error"}>Exit {end.code}</Badge>;
		case "timed-out":
			return <Badge tone="error">Timed out</Badge>;
		case "interrupted":
			return <Badge tone="approval">Interrupted</Badge>;
		case "failed":
			return <Badge tone="error">Failed</Badge>;
	}
}

function BashCard({ item, view, raw, onRawChange, rawView }: ViewProps<"bash">) {
	const { body: output, notes: allNotes } = splitHarness(item.output ?? "");
	const { end, notes } = commandEnd(item.status, output, allNotes);
	const streaming = item.streaming === true;
	const running = item.status === "running" && !streaming;
	// A failure without an exit code says why; it is often the output's whole text.
	const reason = end.kind === "timed-out" ? end.message : end.kind === "failed" ? end.message : undefined;
	return (
		<ToolCard
			item={item}
			icon={<TerminalWindowIcon />}
			// A word, not a path or a command: in the header's own type, not the code font.
			title={<span className={`${pathText} text-fg`}>Terminal</span>}
			meta={
				<>
					{view.timeout === undefined ? null : (
						<span className="kt-tool-card-count">Timeout {count.format(view.timeout)}s</span>
					)}
					{endBadge(end)}
				</>
			}
			copy={{ text: view.command, label: "Copy command" }}
			raw={raw}
			onRawChange={onRawChange}
		>
			{raw ? (
				rawView
			) : (
				<Terminal
					command={view.command}
					commandStreaming={streaming}
					output={output}
					running={running}
					label={`Output of ${view.command.split("\n")[0] ?? "the command"}`}
					footer={
						reason !== undefined && !output.includes(reason) ? (
							<>
								<span className="kt-terminal-error font-mono text-code text-status-error">{reason}</span>
								<Notes notes={notes} inFooter />
							</>
						) : notes.length > 0 ? (
							<Notes notes={notes} inFooter />
						) : undefined
					}
				/>
			)}
		</ToolCard>
	);
}

export type ToolViewCardProps = {
	item: ToolItem;
	view: ToolView;
	/** Shows the raw arguments and output in place of the card's view. */
	raw: boolean;
	onRawChange: (raw: boolean) => void;
	/** The generic arguments and output, for the raw view. */
	rawView: ReactNode;
};

/** The card for a file or shell call, by its kind. */
export const ToolViewCard = memo(function ToolViewCard({ item, view, raw, onRawChange, rawView }: ToolViewCardProps) {
	const props = { item, raw, onRawChange, rawView };
	switch (view.kind) {
		case "write":
			return <WriteCard {...props} view={view} />;
		case "read":
			return <ReadCard {...props} view={view} />;
		case "edit":
			return <EditCard {...props} view={view} />;
		case "bash":
			return <BashCard {...props} view={view} />;
	}
});

/** A file or shell call's detail: its card, or the raw arguments and output while its arguments make no card. */
function ToolViewDetail({ item, raw, showRaw, onShowRawChange }: ToolDetailProps) {
	// Recomputed only when the call's name or arguments change, so a card's views keep their memoised parts.
	const view = useMemo(
		() => toolView({ name: item.name, args: item.args, streaming: item.streaming }),
		[item.name, item.args, item.streaming],
	);
	if (view === undefined) return raw;
	return <ToolViewCard item={item} view={view} raw={showRaw} onRawChange={onShowRawChange} rawView={raw} />;
}

/**
 * The file and shell tools' entry in the tool renderer registry (tool-renderer-model.ts): their calls keep the generic
 * row, with words of their own ("Wrote notes/plan.py") and their card as its detail, open unless it is a read.
 */
export const codingToolRenderers: readonly ToolRenderer[] = [
	{
		tools: ["write", "read", "edit", "bash"],
		label: (item) => {
			const view = toolView(item);
			return view === undefined ? item.label : toolViewLabel(view, item.status);
		},
		openByDefault: (item) => openByDefault(toolView(item)),
		detail: (props) => <ToolViewDetail {...props} />,
	},
];
