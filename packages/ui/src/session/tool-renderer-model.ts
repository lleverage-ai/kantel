import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { createContext, type ReactNode } from "react";
import type { PreviewImageSource } from "../presented/presented-file-card.tsx";
import type { IconProps } from "../primitives/icons.tsx";

// The tool renderer registry: one place that says how a tool's calls show in the transcript. A tool with no entry gets
// the generic tool-call row (an icon, its label and a chevron that opens its arguments and output), in a "Worked for"
// group with the calls around it. An entry changes that in one of two ways:
//
// - `inPlace`: the call renders as something of its own (a file's card, an image) instead of the generic row. It is a
//   row of its own in the turn, where the call happened, and never one of a "Worked for" line's steps: while a finished
//   turn's work is folded it stays in view, so it shows once. A turn whose work is all calls rendered in place has no
//   "Worked for" line at all. While it has nothing of its own to show (`shows`: it is running, or it failed), the
//   call is the generic row, and counts as a step like any other.
// - `label`, `detail`, `openByDefault`, `note`: the call keeps its generic row in its group, with its own words, what
//   it shows when opened (a file as an editor shows it, a command as a terminal), the raw arguments and output one
//   switch away, and a short line under the row (why a step failed).
//
// Either way, an entry can also say its calls form a run (`run`): consecutive calls whose entries give the same run are
// one row of the transcript, one line that says what the run is doing or, once done, how it went ("Browsed
// kayak.co.uk for 2m 37s, 15 steps, 4 failed"), with its steps one switch away. The agent's words between two of its
// calls fold into it, in view among the steps, and the thoughts before a step fold into that step's detail. A run is
// a line of the turn of its own: a finished turn's "Worked for" fold never hides it, so its steps are never more than
// one switch away. The browser's tools are one (tool-renderers.tsx, `browserToolRenderers`).
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
	/** What the agent thought before the call, when it is a step of a run (`ToolRun`): its thought folds into the step. */
	readonly thought?: string | undefined;
	/** The generic detail (the arguments and output as they are), for a renderer that offers it as a switch. */
	readonly raw: ReactNode;
	/** Whether that switch is on. The row keeps it, so it stays as left when the row closes and opens again. */
	readonly showRaw: boolean;
	readonly onShowRawChange: (raw: boolean) => void;
};

/** What a run's line says (`ToolRun.summary`). */
export type ToolRunSummary = {
	/** Its words, at full strength while it runs: "Browsing kayak.co.uk", "Browsed kayak.co.uk for 2m 37s". */
	readonly title: string;
	/** After them, muted: what it is doing now while it runs ("Reading the page"), or how many steps it took. */
	readonly detail?: string | undefined;
	/** How many of its steps failed, said after the detail in the error tone ("4 failed"). None when 0. */
	readonly failed?: number | undefined;
};

/** What a run's own part under its line is given (`ToolRun.under`). */
export type ToolRunUnderProps = {
	/** The run's row, by its id (its first call's). */
	readonly rowId: string;
	readonly calls: readonly ToolItem[];
	/** A call of it runs, or the run may still take steps: its turn is working and only the agent's words follow it. */
	readonly busy: boolean;
};

/**
 * A run of consecutive calls that reads as one thing, such as a browsing run: one line in the turn, its steps one switch
 * away. Give the same object to every tool of the run, and keep it stable: rows are compared by it.
 */
export type ToolRun = {
	/** Names the run: consecutive calls whose entries give runs with the same id are one run ("browser"). */
	readonly id: string;
	/** The line's words, from the run's calls. `running`: a call runs, or the run may still take steps. */
	readonly summary: (calls: readonly ToolItem[], state: { readonly running: boolean }) => ToolRunSummary;
	/** The line's icon while nothing runs (a spinner while something does). By default, its first call's tool icon. */
	readonly icon?: ((props: IconProps) => ReactNode) | undefined;
	/** Under the line, open or not: something the whole run has, such as its browser's card. */
	readonly under?: ((props: ToolRunUnderProps) => ReactNode) | undefined;
};

/** How one or more tools' calls render. */
export type ToolRenderer = {
	/**
	 * The tools it renders, by name ("present_files"), or by a name's start ending in `*` ("browser_*": every tool whose
	 * name starts "browser_", including ones added later). A name beats a start, and a longer start a shorter one.
	 */
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
	/**
	 * A short line under the generic row, in view without opening it: why the call failed, in the error tone. Nothing
	 * when it returns undefined.
	 */
	readonly note?: (item: ToolItem) => string | undefined;
	/** The calls form a run with the consecutive calls of every tool whose entry gives the same run (`ToolRun`). */
	readonly run?: ToolRun;
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
	/** The run a call is a step of (its renderer's `run`), if any. By the tool's name alone, as `inPlace`. */
	readonly run: (item: Pick<ToolItem, "name">) => ToolRun | undefined;
	/** Every entry, in the order given. */
	readonly entries: readonly ToolRenderer[];
};

/** Whether a tool's name is one of `tools`: a name, or a name's start ending in `*` (`ToolRenderer.tools`). */
export function toolMatches(tools: readonly string[], name: string): boolean {
	return tools.some((tool) => (tool.endsWith("*") ? name.startsWith(tool.slice(0, -1)) : tool === name));
}

/**
 * A registry from its entries. A later entry for a tool replaces an earlier one, so a host extends or overrides the
 * library's with `toolRenderers([...defaultToolRenderers, ...mine])`. Make it once (a module constant, or `useMemo`):
 * the transcript renders every row again when it changes.
 */
export function toolRenderers(entries: readonly ToolRenderer[]): ToolRenderers {
	const byName = new Map<string, ToolRenderer>();
	// Names' starts ("browser_"), longest first; for one start, the later entry.
	const starts = new Map<string, ToolRenderer>();
	for (const entry of entries) {
		for (const name of entry.tools) {
			if (name.endsWith("*")) starts.set(name.slice(0, -1), entry);
			else byName.set(name, entry);
		}
	}
	const byStart = [...starts].sort(([a], [b]) => b.length - a.length);
	// Each name's entry, once looked up: a transcript asks for every call's on every render.
	const found = new Map<string, ToolRenderer | undefined>();
	const get = (name: string): ToolRenderer | undefined => {
		if (found.has(name)) return found.get(name);
		const entry = byName.get(name) ?? byStart.find(([start]) => name.startsWith(start))?.[1];
		found.set(name, entry);
		return entry;
	};
	return {
		get,
		inPlace: (item) => get(item.name)?.inPlace !== undefined,
		shows: (item) => {
			const entry = get(item.name);
			if (entry?.inPlace === undefined) return false;
			return entry.shows === undefined ? item.status === "done" : entry.shows(item);
		},
		run: (item) => get(item.name)?.run,
		entries,
	};
}

/**
 * The registry the calls under it render with. The transcript provides its own. A call row rendered anywhere else (a
 * story, a host's own list of calls) has none here, and uses the file and shell tools' cards (`codingToolRenderers`).
 */
export const ToolRenderersContext = createContext<ToolRenderers | undefined>(undefined);
