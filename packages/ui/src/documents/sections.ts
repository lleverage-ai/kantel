// Folding a document's sections, after Notion: a heading folds away everything under it up to the next heading of
// its level or above. Shared by the page as it reads (note-sections.tsx, which nests the rendered Markdown into
// sections) and the editor (fold-sections.ts, which hides the editor's blocks), so both fold the same blocks.

/** The deepest heading that folds: `####`. Below that a heading is a label, not a section. */
export const FOLD_DEPTH = 4;

/**
 * Whether the heading at `index` among the document's top-level blocks folds. A first-block `#` is the document's
 * title, not a section, so it doesn't.
 */
export function folds(level: number, index: number): boolean {
	return level >= 1 && level <= FOLD_DEPTH && !(index === 0 && level === 1);
}

/**
 * For each top-level block (its heading level, or undefined for anything else), the index of the folded heading that
 * hides it, or -1 when it shows. A heading hides what follows it until a heading of its level or above; a heading
 * inside a folded section is hidden with it, folded or not.
 */
export function hiddenBy(levels: readonly (number | undefined)[], folded: ReadonlySet<number>): number[] {
	const hidden: number[] = [];
	let owner = -1;
	let ownerLevel = 0;
	levels.forEach((level, index) => {
		if (owner !== -1 && level !== undefined && level <= ownerLevel) owner = -1;
		hidden.push(owner);
		if (owner === -1 && level !== undefined && folded.has(index) && folds(level, index)) {
			owner = index;
			ownerLevel = level;
		}
	});
	return hidden;
}
