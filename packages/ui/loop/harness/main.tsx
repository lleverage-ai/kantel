// The measurement harness page. `?scenario=<name>` mounts one scenario from scenarios.tsx inside a <Profiler>,
// installs the render probe (src/primitives/probe.ts) and input-latency listeners, and exposes `window.__hb` for
// loop/measure.ts to drive:
//   ready              the scenario has mounted and settled
//   run()              plays the scenario's fixed data updates (streaming, status changes, clock ticks)
//   reset()            zeroes the counters, before the interaction phase
//   collect()          what was counted since the last reset
// Interactions (clicks, typing, wheel) come from Playwright as real input; their latency is measured here, from the
// event's timestamp to the end of the next frame, and their work from the timestamp to the end of the event's
// dispatch, which includes React's render and commit for it but not the wait for a frame.

import { Profiler, type ProfilerOnRenderCallback } from "react";
import { createRoot } from "react-dom/client";
import "../../src/tokens/tokens.css";
import "../../src/tokens/base.css";
import { frame, scenarios } from "./scenarios.tsx";

export type Collected = {
	/** Total React actualDuration across commits, ms. */
	renderMs: number;
	commits: number;
	/** Re-renders (not mounts) per probed component, per id. */
	renders: Record<string, Record<string, number>>;
	/**
	 * The same re-renders split by update: a scenario marks each update with the ids it may change (step() in
	 * scenarios.tsx), so a render is needed only in the update that changed its id, not in every update of the run.
	 */
	steps: { changed: string[]; renders: Record<string, Record<string, number>> }[];
	/** Mounts of probed instances: rows scrolled into view, parts that appeared. */
	mounts: number;
	/** Input latencies, ms: from the event's timestamp to the end of the next frame. */
	latencies: number[];
	/**
	 * Input work, ms: from the event's timestamp to the end of its dispatch, after React has rendered and committed the
	 * update (React flushes a discrete event's update in a microtask, which runs before the window's bubble listener).
	 * Latency waits for the next frame, so it moves in whole frames with where in the frame the input lands; work
	 * does not, so it shows a difference in cost that latency's frame steps can hide.
	 */
	work: number[];
};

export type HarnessWindow = Window & {
	__hbRenderProbe?: (component: string, id: string, phase: "mount" | "update") => void;
	__hbStep?: (changed: string[]) => void;
	__hb?: {
		ready: boolean;
		run(): Promise<{ changed: string[] }>;
		reset(): void;
		collect(): Collected;
	};
};

const win = window as HarnessWindow;
const empty = (): Collected => ({
	renderMs: 0,
	commits: 0,
	renders: {},
	steps: [],
	mounts: 0,
	latencies: [],
	work: [],
});
let collected = empty();
const reset = () => {
	collected = empty();
};

win.__hbStep = (changed) => {
	collected.steps.push({ changed, renders: {} });
};

const count = (into: Collected["renders"], component: string, id: string) => {
	const byId = into[component] ?? {};
	byId[id] = (byId[id] ?? 0) + 1;
	into[component] = byId;
};

win.__hbRenderProbe = (component, id, phase) => {
	if (phase === "mount") {
		collected.mounts += 1;
		return;
	}
	count(collected.renders, component, id);
	const step = collected.steps[collected.steps.length - 1];
	if (step !== undefined) count(step.renders, component, id);
};

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
	collected.renderMs += actualDuration;
	collected.commits += 1;
};

// One latency per input: the first of a keydown, click or wheel event in a frame, to the end of the next frame.
let pending = false;
let measured: Event | undefined;
const measureInput = (event: Event) => {
	if (pending) return;
	pending = true;
	measured = event;
	const start = event.timeStamp;
	void frame().then(() => {
		collected.latencies.push(performance.now() - start);
		pending = false;
	});
};
// The last listener the event reaches (window, bubbling), so the page's own handlers and React's update have run.
const measureWork = (event: Event) => {
	if (event !== measured) return;
	measured = undefined;
	collected.work.push(performance.now() - event.timeStamp);
};
for (const type of ["keydown", "click", "wheel"]) {
	addEventListener(type, measureInput, { capture: true, passive: true });
	addEventListener(type, measureWork, { passive: true });
}

const name = new URLSearchParams(location.search).get("scenario") ?? "";
const scenario = scenarios[name];
const root = document.getElementById("root");
if (scenario === undefined || root === null) throw new Error(`No scenario "${name}"`);

const { Component, run } = scenario;
createRoot(root).render(
	<div className="hb-app" style={{ padding: "var(--hb-space-6)" }}>
		<Profiler id={name} onRender={onRender}>
			<Component />
		</Profiler>
	</div>,
);

// Settle: mount, measure and the first layout passes, before anything is counted.
for (let i = 0; i < 10; i++) await frame();
reset();
win.__hb = { ready: true, run, reset, collect: () => collected };
