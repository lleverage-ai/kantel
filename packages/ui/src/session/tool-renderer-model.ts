import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { createContext, type ReactNode } from "react";
import type { PreviewImageSource } from "../presented/presented-file-card.tsx";

// The tool renderer registry: one place that says how a tool's calls show in the transcript. A tool with no entry gets
// the generic tool-call row (an icon, its label and a chevron that opens its arguments and output), in a "Worked for"
// group with the calls around it. An entry changes that in one of two ways:
//
// - `inPlace`: the call renders as something of its own (a file's card, an image) instead of the generic row. It is a
//   row of its own in the turn, where the call happened, and never one of a "Worked for" line's steps: while a finished
//   turn's work is folded it stays in view, so it shows once. A turn whose work is all calls rendered in place has no
//   "Worked for" line at all. While it has nothing of its own to show (`shows`: it is running, or it failed), the
//   call is the generic row, and counts as a step like any other.
// - `label`, `detail`, `openByDefault`: the call keeps its generic row in its group, with its own words and what it
//   shows when opened (a file as an editor shows it, a command as a terminal), the raw arguments and output one switch
//   away.
//
// It is presentation only. The session's API and event stream carry every call as it was made (`ToolItem`, with its
// name, arguments, output and files), whatever renders it here, so an app built on Harbour shows calls its own way.
// The library's own entries, and how to add one, are in tool-renderers.tsx.

/**
 * A URL an `<img>` can show for an image file (an object URL of its bytes, say), or undefined when there is none: the
 * card then shows the file's icon. Called once per image card as it mounts; keep it stable and cache what it reads.
 */
export type PreviewImage = PreviewImageSource;

/** What a call rendered in place is given. */
export type ToolInPlaceProps = {
	readonly item: ToolItem;
	/** Opens a file the call presented in the host's viewer. Without it the call's cards show what the files are. */
	readonly onOpenFile?: ((file: PresentedFile, item: ToolItem) => void) | undefined;
	/** The key (`presentedKey`) of the file open in the host's viewer, when it is one this call presented. */
	readonly openFile?: string | undefined;
	/** The host's image previews (`TranscriptProps.previewImage`). */
	readonly previewImage?: PreviewImage | undefined;
	/** A link names the call (`#turn=`): it stands out briefly. */
	readonly linked: boolean;
};

/** What a call's own detail is given, inside its generic row. */
export type ToolDetailProps = {
	readonly item: ToolItem;
	/** The generic detail (the arguments and output as they are), for a renderer that offers it as a switch. */
	readonly raw: ReactNode;
	/** Whether that switch is on. The row keeps it, so it stays as left when the row closes and opens again. */
	readonly showRaw: boolean;
	readonly onShowRawChange: (raw: boolean) => void;
};

/** How one or more tools' calls render. */
export type ToolRenderer = {
	/** The tools it renders, by name ("present_files"). */
	readonly tools: readonly string[];
	/** Renders a call instead of the generic tool-call row, while `shows` says it has something of its own to show. */
	readonly inPlace?: (props: ToolInPlaceProps) => ReactNode;
	/**
	 * Whether `inPlace` has something to show for the call now. Otherwise the call is the generic row on its own: a step
	 * of the turn's work, folded away with the rest once the turn ends (a failed call too; the turn's line marks it). By default, once
	 * the call is done.
	 */
	readonly shows?: (item: ToolItem) => boolean;
	/** The generic row's words for the call, instead of its label. */
	readonly label?: (item: ToolItem) => string;
	/** What the generic row shows when opened, instead of the call's arguments and output. */
	readonly detail?: (props: ToolDetailProps) => ReactNode;
	/** The generic row starts open. */
	readonly openByDefault?: (item: ToolItem) => boolean;
};

/** A registry: each tool's renderer, by name. Make one with `toolRenderers`. */
export type ToolRenderers = {
	/** The renderer for a tool, if it has one. */
	readonly get: (name: string) => ToolRenderer | undefined;
	/**
	 * Whether a call renders in place: a row of its own, out of any group of calls. Decided by the tool's name alone, so
	 * a call keeps its row from when it starts to when it ends.
	 */
	readonly inPlace: (item: Pick<ToolItem, "name">) => boolean;
	/** Whether a call rendered in place shows as itself now (its renderer's `shows`), rather than as the generic row. */
	readonly shows: (item: ToolItem) => boolean;
	/** Every entry, in the order given. */
	readonly entries: readonly ToolRenderer[];
};

/**
 * A registry from its entries. A later entry for a tool replaces an earlier one, so a host extends or overrides the
 * library's with `toolRenderers([...defaultToolRenderers, ...mine])`. Make it once (a module constant, or `useMemo`):
 * the transcript renders every row again when it changes.
 */
export function toolRenderers(entries: readonly ToolRenderer[]): ToolRenderers {
	const byName = new Map<string, ToolRenderer>();
	for (const entry of entries) for (const name of entry.tools) byName.set(name, entry);
	return {
		get: (name) => byName.get(name),
		inPlace: (item) => byName.get(item.name)?.inPlace !== undefined,
		shows: (item) => {
			const entry = byName.get(item.name);
			if (entry?.inPlace === undefined) return false;
			return entry.shows === undefined ? item.status === "done" : entry.shows(item);
		},
		entries,
	};
}

/**
 * The registry the calls under it render with. The transcript provides its own. A call row rendered anywhere else (a
 * story, a host's own list of calls) has none here, and uses the file and shell tools' cards (`codingToolRenderers`).
 */
export const ToolRenderersContext = createContext<ToolRenderers | undefined>(undefined);
