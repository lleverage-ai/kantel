// The sharing page's Tailwind utilities, shared with the resource sharing panel (resource-sharing-panel.tsx), which
// shows the same lists on a skill's or a memory space's own page. Panels in a column, each a list of rows with the
// resource and its terms on the left and the actions on the right; under 640px a row's actions go under it.

/** Panels in a column. */
export const sharingBody = "flex min-w-0 flex-col gap-4";
/** A panel's heading. */
export const sharingTitle = "m-0 text-sm font-strong";
export const sharingRows = "m-0 flex list-none flex-col p-0";
/** A row: a hairline between rows, none above the first or below the last. */
export const sharingRow =
	"flex items-center justify-between gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-0 last:pb-0 max-sm:flex-col max-sm:items-stretch";
/** The resource and its terms. */
export const sharingWhat = "flex min-w-0 flex-col gap-0.5";
export const sharingResource = "font-medium wrap-anywhere";
export const sharingDetail = "text-xs text-muted";
/** A request's reason, as its asker wrote it. */
export const sharingReason = "text-xs whitespace-pre-wrap text-muted";
export const sharingActions = "flex shrink-0 items-center gap-2 max-sm:flex-wrap";
