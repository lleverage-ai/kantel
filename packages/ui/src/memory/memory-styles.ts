// The memory page's shared Tailwind classes (src/tokens/tailwind.css, docs/tailwind.md), for the pieces more than one
// of its files draws: the page, the concept, the proposals and recall.

/** A plain list of rows: concepts, recalled concepts, decided proposals, sources, history. */
export const memoryRows = "m-0 flex list-none flex-col gap-0.5 p-0";
/** Skeletons while something loads. */
export const memoryLoading = "flex flex-col gap-4";
/** A row's badges, side by side. */
export const memoryBadges = "inline-flex items-center gap-1";
/** Small, faint meta: a count, an age, a reason. */
export const memoryFaint = "text-xs text-faint";
/** A panel's heading. */
export const memorySection = "m-0 text-sm font-medium";
/** A sentence of help in a panel. */
export const memoryNote = "m-0 text-muted";
/** A concept ID or a source that opens something: underlined accent text, in the font around it. */
export const conceptLink =
	"cursor-pointer border-0 bg-transparent p-0 text-left text-accent-text underline underline-offset-[0.2em] [font:inherit] wrap-anywhere";
/** A source link stacked under another, a full touch target tall. */
export const stackedLink = "inline-flex min-h-control-xs items-center";
