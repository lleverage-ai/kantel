import type { TranscriptItem } from "@kantel/protocol";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import type { BrowserEntryState } from "./browser-entry.tsx";
import { isBrowserCall } from "./browser-steps.ts";
import { BROWSING_SESSION } from "./fixture-browsing-session.ts";
import { transcriptFrameTurn } from "./story-frames.ts";
import { ToolCallChip, toolGroup } from "./tool-call.tsx";
import { ToolRenderersContext } from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS } from "./tool-renderers.tsx";
import { Transcript } from "./transcript.tsx";

export default { title: "Session/Browsing" } satisfies StoryDefault;

// A real browsing session (fixture-browsing-session.ts): Skyscanner's bot check, Google's consent page and a Kayak page
// that didn't answer, in 15 browser calls, 4 of them failed.

const BROWSER = "bsession_92e04b8c-08dc-49f3-9d34-23221f23d3ea";
const states: ReadonlyMap<string, BrowserEntryState> = new Map([[BROWSER, "replay"]]);
const show = () => {};

/** The first failed click, which a link (`#turn=`) can name to open the run on it. */
const FAILED_CLICK = BROWSING_SESSION.find((item) => item.kind === "tool" && item.status === "error")?.id;

export const Finished: Story = () => (
	<Sheet
		title="A finished browsing turn"
		intro="The turn as a person finds it once the agent has answered: its browsing run, its browser's card and the answer."
	>
		<Section title="As it lands">
			<div className={transcriptFrameTurn}>
				<Transcript items={BROWSING_SESSION} onShowBrowser={show} shownBrowser={BROWSER} browserStates={states} />
			</div>
		</Section>
	</Sheet>
);

export const Open: Story = () => (
	<Sheet
		title="A browsing run, open"
		intro="The same turn with its run open on its first failed step: every step, what the agent said between them, and why a step failed."
	>
		<div className={transcriptFrameTurn}>
			<Transcript
				items={BROWSING_SESSION}
				onShowBrowser={show}
				shownBrowser={BROWSER}
				browserStates={states}
				{...(FAILED_CLICK === undefined ? {} : { turn: FAILED_CLICK })}
			/>
		</div>
	</Sheet>
);

// Two steps of the run, opened: the page the agent landed on, and a click that failed.
const calls = BROWSING_SESSION.filter(isBrowserCall);
const kayak = calls.find(
	(call) => call.output?.startsWith("URL: https://www.kayak.co.uk") && call.images !== undefined,
);

export const Steps: Story = () => (
	<Sheet
		title="A browsing run's steps, opened"
		intro="A step opens to a compact card: the page, what it did or why it failed, the thought that led to it and its screenshot. Raw shows its arguments and output."
	>
		<ToolRenderersContext.Provider value={DEFAULT_TOOL_RENDERERS}>
			<div className={transcriptFrameTurn}>
				<div className={toolGroup}>
					{kayak === undefined ? null : (
						<ToolCallChip
							item={kayak}
							images="detail"
							defaultOpen
							thought="Google's consent page won't let me through. I'll go straight to Kayak's results, sorted by price."
						/>
					)}
					{FAILED_CLICK === undefined
						? null
						: calls
								.filter((call) => call.id === FAILED_CLICK)
								.map((call) => <ToolCallChip key={call.id} item={call} images="detail" defaultOpen />)}
				</div>
			</div>
		</ToolRenderersContext.Provider>
	</Sheet>
);

// The session as it was while the agent waited on Kayak: everything up to the 60 s wait, which is still running.
// Its times are moved so the wait started 20 s ago.
const waiting = BROWSING_SESSION.findIndex((item) => item.kind === "tool" && item.output?.includes("within 60 s"));
const shift = Date.now() - 20_000 - (BROWSING_SESSION[waiting]?.at ?? 0);
const live: TranscriptItem[] = BROWSING_SESSION.slice(0, waiting + 1).map((item, index) => {
	const moved = { ...item, at: item.at + shift };
	if (moved.kind !== "tool") return moved;
	const { endedAt, ...rest } = moved;
	if (index === waiting) return { ...rest, status: "running", output: "" };
	return endedAt === undefined ? rest : { ...rest, endedAt: endedAt + shift };
});

export const Live: Story = () => (
	<Sheet title="A browsing run, live" intro="The same run while the agent waits for Kayak's page.">
		<div className={transcriptFrameTurn}>
			<Transcript
				items={live}
				working
				onShowBrowser={show}
				shownBrowser={BROWSER}
				browserStates={new Map([[BROWSER, "live"]])}
			/>
		</div>
	</Sheet>
);
