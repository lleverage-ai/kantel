import { useRef } from "react";

// The design loop's render probe. Memoised rows and parts call it while they render, with their name and the id of
// what they show; the loop's harness (loop/harness) installs a counter on globalThis to find wasted renders: an
// instance rendering again although nothing it shows changed. A first render (a row scrolling into a virtualised
// list) is a mount, not waste, so the probe says which it is. In an app nothing is installed: the cost is one ref
// and one property read per render.

export type RenderPhase = "mount" | "update";
export type RenderProbe = (component: string, id: string, phase: RenderPhase) => void;

type ProbeGlobal = { __hbRenderProbe?: RenderProbe };

export function useRenderProbe(component: string, id: string): void {
	const seen = useRef<string | undefined>(undefined);
	const probe = (globalThis as ProbeGlobal).__hbRenderProbe;
	if (probe !== undefined) probe(component, id, seen.current === id ? "update" : "mount");
	// Written during render on purpose: a render React throws away can only make the next one count as an update,
	// and that over-counts waste rather than hiding it.
	seen.current = id;
}
