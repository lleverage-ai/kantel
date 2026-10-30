import { languageForPath } from "../../code/code.tsx";
import { CodeView } from "../../code/code-view.tsx";
import { EmptyState } from "../../primitives/surface.tsx";
import type { PreviewBodyProps } from "../registry.ts";
import { TextEditor } from "./text-editor.tsx";

// Code and plain text: the same code view a read or write tool call shows in the transcript (line numbers, the theme's
// syntax colours, long lines scrolling sideways), here the whole height of the panel. In Edit, a plain text editor in
// the same type and gutter, so switching doesn't move the text.

export default function CodeBody({ file, text, streaming, editing, onText, label }: PreviewBodyProps) {
	if (editing && onText !== undefined) return <TextEditor text={text} onText={onText} label={`Edit ${file.name}`} />;
	if (text === "" && !streaming) return <EmptyState title="This file is empty" />;
	return (
		<FullCode text={text} language={languageForPath(file.path || file.name)} streaming={streaming} label={label} />
	);
}

/** A code view that fills the body and scrolls within it. */
export function FullCode({
	text,
	language,
	streaming = false,
	label,
}: {
	text: string;
	language: string | undefined;
	streaming?: boolean;
	label: string;
}) {
	return (
		<CodeView
			code={text}
			language={language}
			streaming={streaming}
			label={label}
			collapsedLines={Number.POSITIVE_INFINITY}
			// The view fills the body; its scroller takes what's left. code-view.css sets neither, so utilities apply.
			className="h-full [&>.hb-code-scroll]:min-h-0 [&>.hb-code-scroll]:flex-auto"
		/>
	);
}
