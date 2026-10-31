import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
	Bold,
	Code,
	Heading1,
	Heading2,
	Heading3,
	Italic,
	List,
	ListOrdered,
	type LucideIcon,
	Minus,
	Pilcrow,
	Quote,
	Redo2,
	Strikethrough,
	Table,
	Undo2,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { FoldSections } from "./fold-sections.ts";

// The document editor itself: TipTap (ProseMirror) with Markdown in and out, and a small toolbar of lucide icons. Its
// own module, loaded lazily by `DocumentEditor`, so the console's first load doesn't carry an editor.

export type RichEditorProps = {
	/** The document as Markdown. A new value that differs from what the editor holds replaces its content. */
	markdown: string;
	editable: boolean;
	/** The document as Markdown after each edit the person makes; never for a new `markdown` from the host. */
	onChange?: ((markdown: string) => void) | undefined;
	/** The editing area's accessible name. */
	label: string;
};

type Tool = {
	readonly label: string;
	readonly icon: LucideIcon;
	readonly run: (editor: Editor) => void;
	readonly active?: (editor: Editor) => boolean;
	readonly enabled?: (editor: Editor) => boolean;
};

const TOOLS: readonly (readonly Tool[])[] = [
	[
		{
			label: "Undo",
			icon: Undo2,
			run: (editor) => editor.chain().focus().undo().run(),
			enabled: (editor) => editor.can().undo(),
		},
		{
			label: "Redo",
			icon: Redo2,
			run: (editor) => editor.chain().focus().redo().run(),
			enabled: (editor) => editor.can().redo(),
		},
	],
	[
		{
			label: "Text",
			icon: Pilcrow,
			run: (editor) => editor.chain().focus().setParagraph().run(),
			active: (editor) => editor.isActive("paragraph"),
		},
		{
			label: "Heading 1",
			icon: Heading1,
			run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
			active: (editor) => editor.isActive("heading", { level: 1 }),
		},
		{
			label: "Heading 2",
			icon: Heading2,
			run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
			active: (editor) => editor.isActive("heading", { level: 2 }),
		},
		{
			label: "Heading 3",
			icon: Heading3,
			run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
			active: (editor) => editor.isActive("heading", { level: 3 }),
		},
	],
	[
		{
			label: "Bold",
			icon: Bold,
			run: (editor) => editor.chain().focus().toggleBold().run(),
			active: (editor) => editor.isActive("bold"),
		},
		{
			label: "Italic",
			icon: Italic,
			run: (editor) => editor.chain().focus().toggleItalic().run(),
			active: (editor) => editor.isActive("italic"),
		},
		{
			label: "Strikethrough",
			icon: Strikethrough,
			run: (editor) => editor.chain().focus().toggleStrike().run(),
			active: (editor) => editor.isActive("strike"),
		},
		{
			label: "Code",
			icon: Code,
			run: (editor) => editor.chain().focus().toggleCode().run(),
			active: (editor) => editor.isActive("code"),
		},
	],
	[
		{
			label: "Bulleted list",
			icon: List,
			run: (editor) => editor.chain().focus().toggleBulletList().run(),
			active: (editor) => editor.isActive("bulletList"),
		},
		{
			label: "Numbered list",
			icon: ListOrdered,
			run: (editor) => editor.chain().focus().toggleOrderedList().run(),
			active: (editor) => editor.isActive("orderedList"),
		},
		{
			label: "Quote",
			icon: Quote,
			run: (editor) => editor.chain().focus().toggleBlockquote().run(),
			active: (editor) => editor.isActive("blockquote"),
		},
		{
			label: "Table",
			icon: Table,
			run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
			enabled: (editor) => !editor.isActive("table"),
		},
		{
			label: "Divider",
			icon: Minus,
			run: (editor) => editor.chain().focus().setHorizontalRule().run(),
		},
	],
];

// The toolbar is styled with Tailwind utilities (src/tokens/tailwind.css); the document's type is document-panel.css's,
// on the editor's hb-doc-prose class.

/** A 28px icon button: muted, the hover colour when enabled, the active colour while its format is on. */
const toolButton =
	"hb-focusable inline-flex size-control-sm cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-default disabled:text-disabled aria-pressed:bg-active aria-pressed:text-fg";

function Toolbar({ editor }: { editor: Editor }) {
	// Re-rendered only when what the buttons show changes, not on every keystroke.
	const state = useEditorState({
		editor,
		selector: ({ editor: current }) =>
			TOOLS.flat().map((tool) => ({
				active: tool.active?.(current) ?? false,
				enabled: tool.enabled?.(current) ?? true,
			})),
	});
	let index = 0;
	return (
		// It stays at the top of the page as the page scrolls.
		<div
			className="sticky top-0 z-(--hb-z-float) -mx-2 flex flex-wrap items-center gap-2 bg-canvas p-2"
			role="toolbar"
			aria-label="Formatting"
		>
			{TOOLS.map((group) => (
				<div
					key={group[0]?.label}
					className="flex items-center gap-0.5 not-first:border-l not-first:border-border not-first:pl-2"
				>
					{group.map((tool) => {
						const shown = state[index++] ?? { active: false, enabled: true };
						const Icon = tool.icon;
						return (
							<button
								key={tool.label}
								type="button"
								className={toolButton}
								aria-label={tool.label}
								title={tool.label}
								aria-pressed={tool.active === undefined ? undefined : shown.active}
								disabled={!shown.enabled}
								// Keep the selection in the document: a click mustn't take focus from it first.
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => tool.run(editor)}
							>
								<Icon className="hb-icon hb-icon-md" strokeWidth={1.75} aria-hidden="true" />
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}

/** A rich text editor over Markdown: headings, lists, tables, quotes, code. */
export default function RichEditor({ markdown, editable, onChange, label }: RichEditorProps) {
	const changed = useRef(onChange);
	changed.current = onChange;
	const editor = useEditor({
		extensions: [StarterKit.configure({ link: { openOnClick: false } }), TableKit, Markdown, FoldSections],
		content: markdown,
		contentType: "markdown",
		editable,
		immediatelyRender: true,
		shouldRerenderOnTransaction: false,
		editorProps: {
			attributes: {
				class: "hb-doc-prose hb-markdown hb-selectable",
				"aria-label": label,
				"aria-multiline": "true",
				role: "textbox",
			},
		},
		onUpdate: ({ editor: current }) => changed.current?.(current.getMarkdown()),
	});

	// A new version from the host (the agent rewrote the document, or it was read again) replaces what is shown, unless
	// it is what the editor already holds: the echo of the person's own edit.
	useEffect(() => {
		if (editor.isDestroyed || editor.getMarkdown() === markdown) return;
		editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
	}, [editor, markdown]);

	useEffect(() => {
		if (!editor.isDestroyed) editor.setEditable(editable, false);
	}, [editor, editable]);

	return (
		<div className="hb-doc-editor">
			{editable ? <Toolbar editor={editor} /> : null}
			<EditorContent editor={editor} className="hb-doc-editor-content" />
		</div>
	);
}
