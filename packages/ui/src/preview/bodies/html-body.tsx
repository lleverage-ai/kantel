import { useMemo } from "react";
import { framedHtml, HTML_FRAME_SANDBOX } from "../../presented/html-frame.ts";
import type { PreviewBodyProps } from "../registry.ts";
import { TextEditor } from "./text-editor.tsx";

// An HTML page, run in an iframe sandboxed without `allow-same-origin` (html-frame.ts): the page gets an opaque
// origin and its own policy at the top, so it can reach neither the console nor its credentials, call out, or post a
// form, while a chart that pulls its library from a CDN still draws. Edit edits its source.

export default function HtmlBody({ file, text, editing, onText }: PreviewBodyProps) {
	const source = useMemo(() => framedHtml(text), [text]);
	if (editing && onText !== undefined) return <TextEditor text={text} onText={onText} label={`Edit ${file.name}`} />;
	return (
		<iframe
			className="block h-full w-full border-0 bg-canvas"
			title={file.name}
			sandbox={HTML_FRAME_SANDBOX}
			referrerPolicy="no-referrer"
			srcDoc={source}
		/>
	);
}
