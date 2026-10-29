import type { BrowserLiveStatus } from "@harbour/ui";
import type { BrowserLiveLink } from "../api/client.ts";

// The session screen's live-view links, one per browser the transcript names: asked for once, when the browser's view
// first comes on screen, and kept while the screen is open, so a view that scrolls away and back (the transcript
// unmounts it) or moves down to a newer call doesn't ask again. The links come from Harbour (`POST /v1/browser/live`),
// minted for the signed-in person; this holds them in memory only.

/** One browser's live view, as `BrowserLiveView` shows it. */
export type BrowserLive = {
	readonly status: BrowserLiveStatus;
	readonly url?: string;
};

/** Asks Harbour for a browser's live-view link; rejects with an error whose `code` says why there is none. */
export type LoadBrowserLive = (browserSessionId: string, signal: AbortSignal) => Promise<BrowserLiveLink>;

export interface BrowserLiveStore {
	/** The browser's view; the first call asks for its link. The same object until it changes. */
	get(browserSessionId: string): BrowserLive;
	subscribe(browserSessionId: string, listener: () => void): () => void;
	/**
	 * The live page said its browser has gone, or its link ran out: asks once more. A new link (the old one had run out)
	 * goes live again; the same link, or an error, means the browser has closed.
	 */
	disconnected(browserSessionId: string): void;
	/** Stops asking: the session screen is gone. */
	dispose(): void;
}

const CONNECTING: BrowserLive = { status: "connecting" };
const ENDED: BrowserLive = { status: "ended" };
const UNAVAILABLE: BrowserLive = { status: "unavailable" };

/** Why there is no link, as the view's status: a closed or forgotten browser has ended; anything else, no view. */
export function statusOfFailure(reason: unknown): BrowserLive {
	const code = typeof reason === "object" && reason !== null ? (reason as { code?: unknown }).code : undefined;
	return code === "expired" || code === "not_found" ? ENDED : UNAVAILABLE;
}

export function createBrowserLiveStore(load: LoadBrowserLive): BrowserLiveStore {
	const views = new Map<string, BrowserLive>();
	const listeners = new Map<string, Set<() => void>>();
	const aborts = new Set<AbortController>();
	let disposed = false;

	const set = (id: string, view: BrowserLive) => {
		if (disposed || views.get(id) === view) return;
		views.set(id, view);
		for (const listener of listeners.get(id) ?? []) listener();
	};

	const ask = (id: string, previous?: string) => {
		const abort = new AbortController();
		aborts.add(abort);
		load(id, abort.signal)
			.then(
				(link) => set(id, link.url === previous ? ENDED : { status: "live", url: link.url }),
				(reason: unknown) => set(id, statusOfFailure(reason)),
			)
			.finally(() => aborts.delete(abort));
	};

	return {
		get(id) {
			const view = views.get(id);
			if (view !== undefined) return view;
			views.set(id, CONNECTING);
			if (!disposed) ask(id);
			return CONNECTING;
		},
		subscribe(id, listener) {
			const set_ = listeners.get(id) ?? new Set();
			set_.add(listener);
			listeners.set(id, set_);
			return () => {
				set_.delete(listener);
				if (set_.size === 0) listeners.delete(id);
			};
		},
		disconnected(id) {
			const view = views.get(id);
			if (view?.status !== "live") return;
			set(id, CONNECTING);
			ask(id, view.url);
		},
		dispose() {
			disposed = true;
			for (const abort of aborts) abort.abort();
			aborts.clear();
			listeners.clear();
		},
	};
}
