import { Children, type ComponentProps, createContext, type ReactNode, useContext, useState } from "react";
import type { Components } from "react-markdown";
import { folds } from "../documents/sections.ts";
import { MenuChevronIcon } from "../primitives/lucide.tsx";

// Folding a rendered note's sections, after Notion: the page as it reads, beside the editor's fold-sections.ts and with
// the same rule (documents/sections.ts). A rehype step nests the top-level blocks into sections, one per heading that
// folds, holding that heading and everything under it to the next heading of its level or above. Each section is
// `display: contents`, so the page lays out as if flat, and holds its own folded state; its heading draws the chevron.
// The page's CSS (preview.css) hides a folded section's blocks after its heading.

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

function headingLevel(node: HastNode): number | undefined {
	const match = node.type === "element" ? /^h([1-6])$/.exec(node.tagName ?? "") : null;
	return match === null ? undefined : Number(match[1]);
}

/** The rehype step: nests a note's top-level blocks into one `section` per heading that folds. */
export function rehypeSections() {
	return (tree: HastNode) => {
		const top: HastNode[] = [];
		const open: { level: number; section: HastNode }[] = [];
		let index = 0;
		for (const child of tree.children ?? []) {
			const level = headingLevel(child);
			if (level !== undefined && folds(level, index)) {
				while ((open.at(-1)?.level ?? 0) >= level) open.pop();
				const section: HastNode = {
					type: "element",
					tagName: "section",
					properties: { className: ["hb-md-section"] },
					children: [child],
				};
				(open.at(-1)?.section.children ?? top).push(section);
				open.push({ level, section });
			} else {
				(open.at(-1)?.section.children ?? top).push(child);
			}
			if (child.type === "element") index += 1;
		}
		tree.children = top;
	};
}

type Fold = { readonly folded: boolean; readonly toggle: () => void };

/** The section a heading opens: its folded state and the toggle. A heading outside any section doesn't fold. */
const FoldContext = createContext<Fold | undefined>(undefined);

function Section({ children }: { children?: ReactNode }) {
	const [folded, setFolded] = useState(false);
	return (
		<FoldContext.Provider value={{ folded, toggle: () => setFolded((value) => !value) }}>
			<section className="hb-md-section" data-folded={folded ? "" : undefined}>
				{children}
			</section>
		</FoldContext.Provider>
	);
}

function textOf(children: ReactNode): string {
	return Children.toArray(children)
		.map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
		.join("")
		.trim();
}

/**
 * A heading that folds its section: the chevron sits in the page's gutter, shown on hover or focus, and always once
 * folded, pointing down while open and right while folded. A heading nested under the one that opened the section
 * reads the nearest section, which is always its own, since each section starts with its heading.
 */
function heading(Tag: "h1" | "h2" | "h3" | "h4") {
	return function FoldingHeading({ node: _node, children, ...props }: ComponentProps<typeof Tag> & { node?: unknown }) {
		const fold = useContext(FoldContext);
		if (fold === undefined) return <Tag {...props}>{children}</Tag>;
		const name = textOf(children);
		return (
			<Tag {...props} className="hb-fold-heading" data-folded={fold.folded ? "" : undefined}>
				<button
					type="button"
					className="hb-fold-toggle hb-focusable"
					aria-expanded={!fold.folded}
					aria-label={`${fold.folded ? "Expand" : "Collapse"} ${name === "" ? "section" : name}`}
					title={fold.folded ? "Expand" : "Collapse"}
					onClick={fold.toggle}
				>
					<MenuChevronIcon />
				</button>
				{children}
			</Tag>
		);
	};
}

/** The components a folding note renders with: its sections and the headings that fold them. */
export const foldComponents: Components = {
	// Only the sections the rehype step made: GitHub's footnotes are a section too.
	section: ({ node: _node, className, children, ...props }) =>
		className === "hb-md-section" ? (
			<Section>{children}</Section>
		) : (
			<section {...props} className={className}>
				{children}
			</section>
		),
	h1: heading("h1"),
	h2: heading("h2"),
	h3: heading("h3"),
	h4: heading("h4"),
};
