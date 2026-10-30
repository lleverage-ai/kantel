// Story-only frames for the identity components, as Tailwind utilities. The sign-in screen fills a page-sized frame,
// as the console mounts it; the sidebar footer sits at the sidebar's width, on the sidebar's panel.

/** A page-sized frame for the sign-in screen: 672px tall, 576px under 640px. */
export const signInFrame = "flex min-h-168 flex-col rounded-panel border border-border max-sm:min-h-144";
/** A live story: the component, with a sidebar-wide panel beside it (under it below 640px). */
export const liveFrame =
	"grid grid-cols-[minmax(0,1fr)_var(--hb-sidebar-width)] items-start gap-4 max-sm:grid-cols-[minmax(0,1fr)]";
/** A page as the console mounts it: the content column, nothing around it. */
export const pageFrame = "flex min-w-0 justify-center";
export const storyNote = "m-0 text-sm text-muted";
export const storyCode = "font-mono text-md";
/** The sidebar's width. */
export const sidebarFrame = "flex w-full max-w-sidebar flex-col gap-4";
/** The sidebar's foot, on the sidebar's panel. */
export const sidebarFoot =
	"flex items-center gap-1.5 rounded-panel border border-border bg-panel px-2.5 py-2 text-xs text-muted";
