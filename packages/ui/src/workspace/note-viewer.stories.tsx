import { CopyButton } from "../primitives/controls.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Sheet } from "../workbench/specimen.tsx";
import { longNote, shortNote } from "./fixtures.ts";
import { NoteViewer } from "./note-viewer.tsx";
import "./stories.css";

export default { title: "Workspace/Note viewer" } satisfies StoryDefault;

// The note's time reads the real clock, so it is set relative to now.
const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000;
const back = () => {};

export const Default: Story = () => (
	<Sheet
		title="Note viewer"
		intro="A Markdown note, rendered at the transcript's reading measure: its name as the title, its folder and when it was last updated."
	>
		<div className="hb-story-viewer-frame">
			<NoteViewer
				path="notes/release-notes.md"
				state={{ status: "ready", markdown: shortNote, updatedAt: minutesAgo(4) }}
				actions={<CopyButton text={shortNote} label="Copy note" iconOnly variant="ghost" />}
			/>
		</div>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="Note viewer: loading" intro="A title and paragraphs as placeholders while the note is read.">
		<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
			<NoteViewer path="notes/release-notes.md" state={{ status: "loading" }} />
		</div>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="Note viewer: empty" intro="A note with nothing in it says so.">
		<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
			<NoteViewer path="notes/standup.md" state={{ status: "ready", markdown: "", updatedAt: minutesAgo(90) }} />
		</div>
	</Sheet>
);

// Named ErrorState so the export doesn't shadow the global Error; the workbench shows it as "Error".
export const ErrorState: Story = () => (
	<Sheet title="Note viewer: error" intro="When the note can't be read, the viewer says why.">
		<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
			<NoteViewer
				path="notes/release-notes.md"
				state={{ status: "error", message: "Couldn't read this note. You may no longer have access to it." }}
			/>
		</div>
	</Sheet>
);
ErrorState.storyName = "Error";

export const LongContent: Story = () => (
	<Sheet
		title="Note viewer: long content"
		intro="A long note with headings, nested lists, a quote, a table and a code block. Tables and code scroll sideways on their own; the note scrolls inside the viewer."
	>
		<div className="hb-story-viewer-frame hb-story-viewer-frame-tall">
			<NoteViewer
				path="/project/docs/runbooks/billing-retry-rollout-and-what-to-watch-while-it-ships.md"
				state={{ status: "ready", markdown: longNote, updatedAt: minutesAgo(60 * 26) }}
			/>
		</div>
	</Sheet>
);

export const Phone: Story = () => (
	<Sheet title="Note viewer at 420px" intro="On a phone the note fills the screen and Back returns to the tree.">
		<div className="hb-story-viewer-frame hb-story-viewer-frame-tall">
			<NoteViewer
				path="notes/billing-retry-rollout.md"
				state={{ status: "ready", markdown: longNote, updatedAt: minutesAgo(12) }}
				onBack={back}
			/>
		</div>
	</Sheet>
);
Phone.meta = { width: 420 };
