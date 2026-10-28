import { createContext, useContext } from "react";

// What a Transcript tells the Composer docked over its foot (Transcript's `dock` prop), and what the Composer tells
// it back. A composer outside a transcript gets no dock and never rests by itself.

export type FileDropHandler = (files: readonly File[]) => void;

export type ComposerDock = {
	/** The reader scrolled the transcript away from its end: the composer may fold to one line. */
	resting: boolean;
	/** Brings a resting composer back: called when it takes focus, or when its draft changes. */
	wake: () => void;
	/** A file is being dragged over the transcript; the composer shows it can take it. */
	dragging: boolean;
	/**
	 * The composer takes files dropped anywhere on the transcript while it registers a handler, as T3 Code's thread
	 * does. Returns the unregister function.
	 */
	acceptDrops: (handler: FileDropHandler, hint: string) => () => void;
};

export const ComposerDockContext = createContext<ComposerDock | null>(null);

export function useComposerDock(): ComposerDock | null {
	return useContext(ComposerDockContext);
}
