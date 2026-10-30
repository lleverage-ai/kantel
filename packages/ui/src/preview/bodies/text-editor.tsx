import { type KeyboardEvent, useRef } from "react";

// Editing a text file: a plain textarea in the code view's type, on the code surface, with its padding, so Edit and
// Preview put the text in the same place. Tab inserts a tab rather than leaving the field; Shift+Tab still leaves it.
// Saving is the panel's (Cmd/Ctrl+S, or the host's autosave).

export function TextEditor({ text, onText, label }: { text: string; onText: (text: string) => void; label: string }) {
	const field = useRef<HTMLTextAreaElement>(null);
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Tab" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
		event.preventDefault();
		const element = event.currentTarget;
		const { selectionStart: start, selectionEnd: end, value } = element;
		const next = `${value.slice(0, start)}\t${value.slice(end)}`;
		element.value = next;
		element.selectionStart = element.selectionEnd = start + 1;
		onText(next);
	};
	return (
		<textarea
			ref={field}
			className="hb-focusable hb-selectable block h-full w-full resize-none border-0 bg-code-surface px-gutter py-4 font-mono text-code leading-normal whitespace-pre text-fg [tab-size:4] focus-visible:-outline-offset-(--hb-ring)!"
			defaultValue={text}
			spellCheck={false}
			autoCapitalize="off"
			autoComplete="off"
			autoCorrect="off"
			aria-label={label}
			onChange={(event) => onText(event.currentTarget.value)}
			onKeyDown={onKeyDown}
		/>
	);
}
