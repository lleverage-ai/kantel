import type { ReactNode } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { BrowserPanel } from "./browser-panel.tsx";
import { type BrowserRecording, BrowserTimeline, type ReplayFrame } from "./browser-timeline.tsx";
import type { ReplayManifest, ReplayStep } from "./browser-timeline-model.ts";
import { EXAMPLE_GENERATED_IMAGE } from "./fixture-generated-image.ts";
import { EXAMPLE_SCREENSHOT } from "./fixture-screenshot.ts";

export default { title: "Session/Browser timeline" } satisfies StoryDefault;

// A recording as the stories can have one without a browser: two pictures standing in for the pages the agent saw, a
// frame each time a step changed the page, over two minutes and 22 seconds, mostly the agent thinking.
const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const PICTURES = [bytes(EXAMPLE_SCREENSHOT), bytes(EXAMPLE_GENERATED_IMAGE)];
const T0 = Date.UTC(2026, 9, 31, 10, 0, 0);
const SHOT_WIDTH = 640;
const SHOT_HEIGHT = 400;

const STEPS: readonly ReplayStep[] = [
	{ id: "s1", label: "Opening www.skyscanner.net", at: T0 + 2000, endedAt: T0 + 6400 },
	{ id: "s2", label: "Going to www.google.com", at: T0 + 21_000, endedAt: T0 + 23_500 },
	{ id: "s3", label: "Clicking on the page", at: T0 + 38_000, endedAt: T0 + 39_000, failed: true },
	{ id: "s4", label: "Reading the page", at: T0 + 52_000, endedAt: T0 + 52_600 },
	{ id: "s5", label: "Going to www.kayak.co.uk", at: T0 + 71_000, endedAt: T0 + 75_000 },
	{ id: "s6", label: "Typing into the page", at: T0 + 96_000, endedAt: T0 + 97_200 },
	{ id: "s7", label: "Scrolling the page", at: T0 + 118_000, endedAt: T0 + 118_900 },
	{ id: "s8", label: "Closing the browser", at: T0 + 140_000, endedAt: T0 + 140_400 },
];

const MANIFEST: ReplayManifest = {
	startedAt: T0,
	pages: [
		{
			pageId: "1",
			startMs: 3000,
			durationMs: 139_000,
			// The fixture screenshot's size, in pixels (data, not a style).
			width: SHOT_WIDTH,
			height: SHOT_HEIGHT,
			chunks: [
				{ index: 0, startMs: 0, durationMs: 60_000 },
				{ index: 1, startMs: 60_000, durationMs: 60_000 },
				{ index: 2, startMs: 120_000, durationMs: 19_000 },
			],
			navigations: [
				{ atMs: 0, url: "https://www.skyscanner.net/", title: "Skyscanner: compare cheap flights" },
				{ atMs: 18_500, url: "https://www.google.com/", title: "Google" },
				{ atMs: 68_500, url: "https://www.kayak.co.uk/flights", title: "Cheap flights from London | KAYAK" },
			],
		},
	],
};

/** A frame a little after each step's start, alternating pictures, in the chunk its time falls in. */
const RECORDING: BrowserRecording = {
	manifest: MANIFEST,
	async chunk(_pageId, index) {
		const page = MANIFEST.pages[0];
		const chunk = page?.chunks.find((each) => each.index === index);
		if (page === undefined || chunk === undefined) return [];
		const frames: ReplayFrame[] = [];
		STEPS.forEach((step, n) => {
			for (const offset of [300, 900, 1500]) {
				const ms = step.at - T0 - page.startMs + offset;
				if (ms >= chunk.startMs && ms < chunk.startMs + chunk.durationMs) {
					frames.push({ ms, jpeg: PICTURES[(n + (offset > 300 ? 1 : 0)) % 2] as Uint8Array });
				}
			}
		});
		if (index === 0) frames.unshift({ ms: 0, jpeg: PICTURES[0] as Uint8Array });
		return frames.sort((a, b) => a.ms - b.ms);
	},
};

const POSTER = `data:image/png;base64,${EXAMPLE_SCREENSHOT}`;

/** A recording whose frames never arrive: the timeline waits on its first chunk. */
const LOADING: BrowserRecording = { manifest: MANIFEST, chunk: () => new Promise(() => {}) };
/** A recording whose frames don't load. */
const FAILING: BrowserRecording = { manifest: MANIFEST, chunk: () => Promise.reject(new Error("404")) };

/** Forty steps, a few seconds apart, some failing: a long errand. */
const MANY_STEPS: readonly ReplayStep[] = Array.from({ length: 40 }, (_, n) => ({
	id: `m${n}`,
	label:
		n % 3 === 0 ? `Going to page ${n + 1} of the results` : n % 3 === 1 ? "Reading the page" : "Scrolling the page",
	at: T0 + 4000 + n * 3400,
	endedAt: T0 + 4000 + n * 3400 + 900,
	...(n % 11 === 5 ? { failed: true } : {}),
}));

/** The session's browser panel, at the height and width the console gives it beside the transcript. */
function Panel({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
	return (
		<div className={`flex h-(--kt-content-width) border border-border ${narrow ? "w-full" : "w-(--kt-card-width)"}`}>
			<BrowserPanel step="Closing the browser" fill className="min-w-0 flex-1">
				{children}
			</BrowserPanel>
		</div>
	);
}

export const InThePanel: Story = () => (
	<Sheet
		title="Browser timeline"
		intro="A closed browser's replay in the session's panel: each of the agent's steps a marker to seek to, the time it spent thinking skipped, 2× to start, the tab saying the page on view, the page filling the panel."
	>
		<Section title="Before it plays: the last page, the steps and how long they take">
			<Panel>
				<BrowserTimeline recording={RECORDING} steps={STEPS} poster={POSTER} />
			</Panel>
		</Section>
		<Section title="Playing">
			<Panel>
				<BrowserTimeline recording={RECORDING} steps={STEPS} poster={POSTER} autoPlay />
			</Panel>
		</Section>
		<Section title="No steps to go by: the whole recording">
			<Panel>
				<BrowserTimeline recording={RECORDING} steps={[]} poster={POSTER} />
			</Panel>
		</Section>
		<Section title="No poster">
			<Panel>
				<BrowserTimeline recording={RECORDING} steps={STEPS} />
			</Panel>
		</Section>
	</Sheet>
);

export const States: Story = () => (
	<Sheet
		title="Browser timeline states"
		intro="Frames are read a chunk at a time once it plays: while one loads the timeline waits, and one that fails stops it until a person plays again."
	>
		<Section title="Loading the first frames">
			<Panel>
				<BrowserTimeline recording={LOADING} steps={STEPS} poster={POSTER} autoPlay />
			</Panel>
		</Section>
		<Section title="The frames didn't load">
			<Panel>
				<BrowserTimeline recording={FAILING} steps={STEPS} poster={POSTER} autoPlay />
			</Panel>
		</Section>
		<Section title="Long: forty steps">
			<Panel>
				<BrowserTimeline recording={RECORDING} steps={MANY_STEPS} poster={POSTER} />
			</Panel>
		</Section>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet title="Browser timeline at 420px" intro="The controls keep to one row; the step on view stays in the corner.">
		<Panel narrow>
			<BrowserTimeline recording={RECORDING} steps={STEPS} poster={POSTER} autoPlay />
		</Panel>
	</Sheet>
);
