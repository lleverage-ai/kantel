// Story-only frames for the workspace components, as Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).
// The tree sits at the sidebar's width; the viewers fill and scroll inside fixed-height frames, as a host's file
// browser would give them. The documents and presented-files stories use the same frames.

/** The sidebar's width, for the file tree. */
export const treeFrame = "w-full max-w-sidebar";

/** A viewer's frame: a hairline box the viewer fills and scrolls inside. Its height is set by each frame below. */
const viewerBox = "flex w-full flex-col overflow-hidden rounded-panel border border-border";

/** A viewer frame 480px tall. */
export const viewerFrame = `${viewerBox} h-[calc(var(--kt-step-12)*10)]`;
/** A viewer frame 288px tall, for loading, empty and error states. */
export const viewerFrameShort = `${viewerBox} h-[calc(var(--kt-step-12)*6)]`;
/** A viewer frame 672px tall, for long content and phones. */
export const viewerFrameTall = `${viewerBox} h-[calc(var(--kt-step-12)*14)]`;

/**
 * The presented files' cards beside their viewer, as the console's session screen lays them out. The cards (the first
 * child) scroll on their own with room around them.
 */
export const presentedSplit =
	"grid h-[calc(var(--kt-step-12)*12)] grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-2.5 overflow-hidden rounded-panel border border-border [&>:first-child]:overflow-auto [&>:first-child]:p-2.5";
