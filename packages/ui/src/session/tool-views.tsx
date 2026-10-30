import type { ToolItem } from "@harbour/protocol";
import { memo, type ReactNode, useMemo } from "react";
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
import "./tool-views.css";

// The file and shell tools' cards (write, read, edit, bash), in place of their arguments as JSON: a file as an editor
// shows it, an edit as a diff, a command as a terminal. Each card has a header (what, where, how it went) with copy
// and a switch to the raw arguments and output, which every call keeps.

const count = new Intl.NumberFormat("en-GB");

function Notes({ notes }: { notes: readonly HarnessNote[] }) {
	if (notes.length === 0) return null;
	return (
		<ul className="hb-tool-card-notes">
			{notes.map((note, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a result's notes never reorder.
				<li key={index} className={`hb-tool-card-note hb-tool-card-note-${note.severity}`}>
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
			className={`hb-tool-card-result${failed ? " hb-tool-card-result-failed" : ""}`}
			role={failed ? "alert" : undefined}
		>
			{text}
		</p>
	);
}

type CardProps = {
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

function Card({ item, icon, title, meta, copy, raw, onRawChange, children }: CardProps) {
	return (
		<div className={`hb-tool-card hb-tool-card-${item.status}${item.streaming ? " hb-tool-card-streaming" : ""}`}>
			<div className="hb-tool-card-header">
				<span className="hb-tool-card-icon">{icon}</span>
				<span className="hb-tool-card-title">{title}</span>
				{meta === undefined ? null : <span className="hb-tool-card-meta">{meta}</span>}
				<span className="hb-tool-card-actions">
					<button
						type="button"
						className={`hb-tool-card-raw hb-focusable${raw ? " hb-tool-card-raw-on" : ""}`}
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
			{children}
		</div>
	);
}

/** A path for a header: the file name at full strength after its folder. */
function PathTitle({ path, fallback }: { path: string; fallback: string }) {
	if (path === "") return <span className="hb-tool-card-path hb-tool-card-path-pending">{fallback}</span>;
	const slash = path.lastIndexOf("/");
	return (
		<span className="hb-tool-card-path" title={path}>
			{slash < 0 ? null : <span className="hb-tool-card-dir">{path.slice(0, slash + 1)}</span>}
			<span className="hb-tool-card-file">{path.slice(slash + 1)}</span>
		</span>
	);
}

const languageBadge = (language: string | undefined) => {
	const name = language === undefined ? undefined : languageName(language);
	return name === undefined ? null : <span className="hb-tool-card-language">{name}</span>;
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
		<Card
			item={item}
			icon={<FileWriteIcon />}
			title={<PathTitle path={view.path} fallback="New file" />}
			meta={
				<>
					{languageBadge(language)}
					{lines > 0 ? (
						<span className="hb-tool-card-count">
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
		</Card>
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
		<Card
			item={item}
			icon={<EyeIcon />}
			title={<PathTitle path={view.path} fallback="A file" />}
			meta={
				<>
					{languageBadge(language)}
					{done && lines > 0 && range.partial ? (
						<span className="hb-tool-card-count">
							Lines {count.format(range.start)}&ndash;{count.format(range.end)}
						</span>
					) : done && lines > 0 ? (
						<span className="hb-tool-card-count">
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
				<p className="hb-tool-card-waiting">Reading&hellip;</p>
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
		</Card>
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
		<Card
			item={item}
			icon={<FileDiffIcon />}
			title={<PathTitle path={view.path} fallback="A file" />}
			meta={
				<>
					{languageBadge(language)}
					{counts.additions + counts.deletions > 0 ? (
						<span className="hb-tool-card-count">
							<span className="hb-tool-card-add">+{count.format(counts.additions)}</span>{" "}
							<span className="hb-tool-card-del">&minus;{count.format(counts.deletions)}</span>
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
		</Card>
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
		<Card
			item={item}
			icon={<TerminalWindowIcon />}
			title={<span className="hb-tool-card-path">Terminal</span>}
			meta={
				<>
					{view.timeout === undefined ? null : (
						<span className="hb-tool-card-count">Timeout {count.format(view.timeout)}s</span>
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
								<span className="hb-terminal-error">{reason}</span>
								<Notes notes={notes} />
							</>
						) : notes.length > 0 ? (
							<Notes notes={notes} />
						) : undefined
					}
				/>
			)}
		</Card>
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
