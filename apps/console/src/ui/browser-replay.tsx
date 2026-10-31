import {
	type BrowserRecording,
	BrowserTimeline,
	REPLAY_DEFAULT_SPEED,
	type ReplayManifest,
	type ReplayStep,
} from "@kantel/ui";
import { type ReactNode, useEffect, useState } from "react";
import { readFrames } from "../viewer/mkv.ts";
import { VIEW_API, type View, viewOf } from "../viewer/viewer.tsx";

// The browser timeline in the session's browser panel (TASK-4229): a closed browser's replay drawn in the panel
// itself, on a timeline of the agent's steps, rather than in an iframe of the view page. It reads the same recording
// the view page does, with the same view link (`POST /v1/browser/replay` minted it for the person watching): the
// manifest when the panel shows the browser, each chunk of frames only once it plays. A link that isn't one of
// Kantel's own (brwsr's share links) has no recording to read here, and keeps the iframe.
//
// Behind a switch while it is new: on unless this browser turned it off with `?timeline=off` (`?timeline=on` turns it
// back on). The choice is kept in localStorage, as the cache's is.

const SWITCH_KEY = "harbour.browser-timeline";

/** Whether the panel plays a replay on the browser timeline: `?timeline=on|off` sets it for this browser. */
export function browserTimelineSwitch(params: URLSearchParams, storage: Storage | undefined): boolean {
	const asked = params.get("timeline");
	try {
		if (asked === "off" || asked === "on") storage?.setItem(SWITCH_KEY, asked);
		return storage?.getItem(SWITCH_KEY) !== "off";
	} catch {
		return asked !== "off";
	}
}

let switched: boolean | undefined;
/** The switch for this page: read once, from its address and this browser's storage. */
export function browserTimelineOn(): boolean {
	if (switched === undefined) {
		let storage: Storage | undefined;
		try {
			storage = globalThis.localStorage ?? undefined;
		} catch {
			storage = undefined;
		}
		switched = browserTimelineSwitch(new URLSearchParams(globalThis.location?.search ?? ""), storage);
	}
	return switched;
}

/** The view a replay link opens, when it is one of Kantel's own (`/browser/<browser>#<token>`). */
export function replayViewOf(url: string): View | undefined {
	try {
		const parsed = new URL(url, globalThis.location?.href ?? "http://localhost/");
		if (globalThis.location !== undefined && parsed.origin !== globalThis.location.origin) return undefined;
		return viewOf(parsed.pathname, parsed.hash);
	} catch {
		return undefined;
	}
}

const viewFetch = (view: View, rest: string, signal?: AbortSignal) =>
	fetch(`${VIEW_API}${encodeURIComponent(view.browser)}${rest}`, {
		referrerPolicy: "no-referrer",
		headers: { authorization: `Bearer ${view.token}` },
		...(signal === undefined ? {} : { signal }),
	});

type Manifest = ReplayManifest & { readonly status: "recording" | "complete" | "none" };

/** The recording behind a view link: its manifest now, its chunks as they're asked for. */
export async function loadRecording(view: View, signal?: AbortSignal): Promise<BrowserRecording | "none"> {
	const response = await viewFetch(view, "/recording", signal);
	if (response.status === 404) return "none";
	if (!response.ok) throw new Error(`The recording didn't load (${response.status})`);
	const manifest = (await response.json()) as Manifest;
	if (manifest.status === "none" || manifest.pages.every((page) => page.chunks.length === 0)) return "none";
	return {
		manifest,
		async chunk(pageId, index) {
			const chunk = await viewFetch(view, `/recording/${encodeURIComponent(pageId)}/${index}`);
			if (!chunk.ok) throw new Error(String(chunk.status));
			return readFrames(new Uint8Array(await chunk.arrayBuffer()));
		},
	};
}

export type ReplayTimelineProps = {
	readonly view: View;
	readonly steps: readonly ReplayStep[];
	readonly poster?: string;
	readonly tabs?: (end: ReactNode) => ReactNode;
	/** While the manifest loads: the last screenshot, so the panel never starts the iframe player only to drop it. */
	readonly pending: ReactNode;
	/** If the recording can't be read here: what the panel showed before (the iframe player). */
	readonly fallback: ReactNode;
};

/** A closed browser's replay on its timeline, once its manifest has loaded; the fallback until then, or instead. */
export function ReplayTimeline({ view, steps, poster, tabs, pending, fallback }: ReplayTimelineProps) {
	const [recording, setRecording] = useState<BrowserRecording | "none" | "failed" | undefined>();
	useEffect(() => {
		const abort = new AbortController();
		setRecording(undefined);
		loadRecording(view, abort.signal).then(setRecording, () => {
			if (!abort.signal.aborted) setRecording("failed");
		});
		return () => abort.abort();
	}, [view]);
	if (recording === undefined) return <>{pending}</>;
	if (recording === "none" || recording === "failed") return <>{fallback}</>;
	return (
		<BrowserTimeline
			recording={recording}
			steps={steps}
			speed={REPLAY_DEFAULT_SPEED}
			{...(poster === undefined ? {} : { poster })}
			{...(tabs === undefined ? {} : { tabs })}
		/>
	);
}
