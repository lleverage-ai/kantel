import { Extension } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { folds, hiddenBy } from "./sections.ts";

// Folding sections in the editor, after Notion: a chevron in the gutter beside each heading (on hover, or always once
// folded) folds away everything under it to the next heading of its level or above. Folding hides the editor's blocks
// with decorations and never touches the document, so the Markdown saved is the same folded or not. The caret is never
// left in a block nobody can see: folding a section it is in moves it to the end of the heading, and moving it into a
// folded section (arrow keys, a search) unfolds that section.

const key = new PluginKey<ReadonlySet<number>>("ktFoldSections");

type Block = { readonly pos: number; readonly node: ProseNode; readonly level: number | undefined };

function blocksOf(doc: ProseNode): Block[] {
	const blocks: Block[] = [];
	doc.forEach((node, pos) => {
		blocks.push({ pos, node, level: node.type.name === "heading" ? Number(node.attrs.level) : undefined });
	});
	return blocks;
}

/** Whether a position is inside the block's content (not at its edges, which it shares with its neighbours). */
function within(block: Block, pos: number): boolean {
	return pos > block.pos && pos < block.pos + block.node.nodeSize;
}

/** Each block's folded owner (an index, or -1), from the folded headings' positions. */
function ownersOf(blocks: readonly Block[], folded: ReadonlySet<number>): number[] {
	const indices = new Set<number>();
	blocks.forEach((block, index) => {
		if (folded.has(block.pos)) indices.add(index);
	});
	return hiddenBy(
		blocks.map((block) => block.level),
		indices,
	);
}

/**
 * lucide's chevron-right in Kantel's icon shape (primitives/lucide.tsx: 16px, a 1.5px stroke whatever the size, so
 * 2.25 in the 24-unit box), drawn as DOM for a ProseMirror widget, which isn't React.
 */
function chevron(): SVGSVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	for (const [name, value] of Object.entries({
		width: "16",
		height: "16",
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "2.25",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		class: "kt-icon kt-icon-md",
		"aria-hidden": "true",
	})) {
		svg.setAttribute(name, value);
	}
	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", "m9 18 6-6-6-6");
	svg.append(path);
	return svg;
}

function toggle(view: EditorView, pos: number): void {
	const { state } = view;
	const heading = state.doc.nodeAt(pos);
	if (heading === null) return;
	const transaction = state.tr.setMeta(key, pos);
	const folding = !(key.getState(state)?.has(pos) ?? false);
	if (folding) {
		// The caret inside the section about to fold goes to the end of its heading.
		const blocks = blocksOf(state.doc);
		const index = blocks.findIndex((block) => block.pos === pos);
		const owners = ownersOf(blocks, new Set([...(key.getState(state) ?? []), pos]));
		const head = state.selection.head;
		const inside = blocks.some((block, at) => owners[at] === index && within(block, head));
		if (inside) transaction.setSelection(TextSelection.create(state.doc, pos + heading.nodeSize - 1));
	}
	view.dispatch(transaction);
}

function decorations(state: EditorState): DecorationSet {
	const folded = key.getState(state) ?? new Set<number>();
	const blocks = blocksOf(state.doc);
	const owners = ownersOf(blocks, folded);
	const decorations: Decoration[] = [];
	blocks.forEach((block, index) => {
		const end = block.pos + block.node.nodeSize;
		if (owners[index] !== -1) {
			decorations.push(Decoration.node(block.pos, end, { class: "kt-fold-hidden" }));
			return;
		}
		if (block.level === undefined || !folds(block.level, index)) return;
		const isFolded = folded.has(block.pos);
		decorations.push(
			Decoration.node(
				block.pos,
				end,
				isFolded ? { class: "kt-fold-heading", "data-folded": "" } : { class: "kt-fold-heading" },
			),
			Decoration.widget(
				block.pos + 1,
				(view) => {
					const button = document.createElement("button");
					button.type = "button";
					button.className = "kt-fold-toggle";
					button.contentEditable = "false";
					button.tabIndex = -1;
					button.setAttribute("aria-label", isFolded ? "Expand section" : "Collapse section");
					button.setAttribute("aria-expanded", String(!isFolded));
					button.title = isFolded ? "Expand" : "Collapse";
					button.append(chevron());
					// On mousedown, so the click neither moves the caret nor takes focus from the editor.
					button.addEventListener("mousedown", (event) => {
						event.preventDefault();
						toggle(view, block.pos);
					});
					return button;
				},
				{ side: -1, ignoreSelection: true, stopEvent: () => true, key: `fold-${block.pos}-${isFolded}` },
			),
		);
	});
	return DecorationSet.create(state.doc, decorations);
}

/** Notion-like folding of a document's sections under their headings, in the editor. */
export const FoldSections = Extension.create({
	name: "ktFoldSections",
	addProseMirrorPlugins() {
		return [
			new Plugin<ReadonlySet<number>>({
				key,
				state: {
					init: () => new Set<number>(),
					apply(transaction, folded, _old, state) {
						let next: Set<number> | ReadonlySet<number> = folded;
						if (transaction.docChanged && folded.size > 0) {
							next = new Set(
								[...folded]
									.map((pos) => transaction.mapping.mapResult(pos, 1))
									.filter((result) => !result.deleted && state.doc.nodeAt(result.pos)?.type.name === "heading")
									.map((result) => result.pos),
							);
						}
						const toggled = transaction.getMeta(key) as number | undefined;
						if (toggled !== undefined) {
							const changed = new Set(next);
							if (changed.has(toggled)) changed.delete(toggled);
							else changed.add(toggled);
							return changed;
						}
						if (next.size > 0 && (transaction.selectionSet || transaction.docChanged)) {
							// The caret moved into a folded section: unfold the section it's in.
							const blocks = blocksOf(state.doc);
							const owners = ownersOf(blocks, next);
							const head = state.selection.head;
							const at = blocks.findIndex((block) => within(block, head));
							const owner = at === -1 ? -1 : (owners[at] ?? -1);
							const ownerBlock = blocks[owner];
							if (ownerBlock !== undefined) {
								const changed = new Set(next);
								changed.delete(ownerBlock.pos);
								return changed;
							}
						}
						return next;
					},
				},
				props: { decorations },
			}),
		];
	},
});
