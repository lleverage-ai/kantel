import { useMemo } from "react";
import { EmptyState } from "../../primitives/surface.tsx";
import type { PreviewBodyProps } from "../registry.ts";
import { FullCode } from "./code-body.tsx";
import { TextEditor } from "./text-editor.tsx";

// JSON: pretty-printed with two-space indents and highlighted as JSON in the code view, so a minified API response
// reads as a tree. Text that doesn't parse (JSON with comments, a JSON Lines file) is shown as it is. Edit edits the
// file as it is, not the pretty-printed form.

/** Past this, the text is shown as it is: parsing and printing a very large file costs more than it gives. */
const PRETTY_LIMIT = 2_000_000;

export function prettyJson(text: string): string {
	if (text.length > PRETTY_LIMIT) return text;
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

export default function JsonBody({ file, text, streaming, editing, onText, label }: PreviewBodyProps) {
	const pretty = useMemo(() => (streaming ? text : prettyJson(text)), [text, streaming]);
	if (editing && onText !== undefined) return <TextEditor text={text} onText={onText} label={`Edit ${file.name}`} />;
	if (text === "" && !streaming) return <EmptyState title="This file is empty" />;
	return <FullCode text={pretty} language="json" streaming={streaming} label={label} />;
}
