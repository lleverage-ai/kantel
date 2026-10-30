// Story-only frames for the session components, as Tailwind classes (src/tokens/tailwind.css). The transcript is
// virtualised and fills its parent, so its stories give it a fixed-height frame, as a host's session screen would.

const frame = "flex w-full flex-col overflow-hidden rounded-panel border border-border bg-canvas";

/** A session screen's height for a transcript: twelve 48px steps. */
export const transcriptFrame = `${frame} h-144`;
/** A taller one, fifteen steps, for a story with more to show. */
export const transcriptFrameTall = `${frame} h-180`;
/** A whole turn of presented images, so its screenshot shows the turn from the person's message to the answer. */
export const transcriptFrameTurn = `${frame} h-192`;
/** Room above a composer for its model picker, which opens upward. */
export const pickerFrame = "pt-(--hb-popover-height)";
