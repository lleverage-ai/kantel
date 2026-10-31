import type { PresentedFile } from "@kantel/protocol";
import { createContext, useContext, useMemo } from "react";
import { warmPreview } from "./registry.ts";

// Opening a file starts before the press: a card that opens one warms it as the pointer reaches it, as it takes focus
// and as it is pressed, so the renderer's code is loading (always) and the host is reading its bytes (when it gives
// `PreviewWarmContext`) by the time the click lands. A pointer resting on a card is about 100-300 ms ahead of its
// click, which is most of a read.

/** The host's prefetch: reads a file into its preview cache. Cheap to call again. */
export const PreviewWarmContext = createContext<((file: PresentedFile) => void) | undefined>(undefined);

/** The handlers that warm `file` on a card that opens it. */
export function useWarmHandlers(file: PresentedFile | undefined) {
	const prefetch = useContext(PreviewWarmContext);
	return useMemo(() => {
		if (file === undefined) return {};
		const warm = () => {
			warmPreview(file);
			prefetch?.(file);
		};
		return { onPointerEnter: warm, onFocus: warm, onPointerDown: warm };
	}, [file, prefetch]);
}
