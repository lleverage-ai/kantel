import { Button } from "../primitives/button.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { FileViewer } from "./file-viewer.tsx";
import { longSourceFile, overCapFile, sourceFile } from "./fixtures.ts";
import "./stories.css";

export default { title: "Workspace/File viewer" } satisfies StoryDefault;

const bytes = (text: string): number => new TextEncoder().encode(text).length;
const back = () => {};

export const Default: Story = () => (
	<Sheet
		title="File viewer"
		intro="One file's text, read-only: the name, its folder and size, Copy, then the text in mono with line numbers that aren't copied with it. Scrolls inside the viewer."
	>
		<div className="hb-story-viewer-frame">
			<FileViewer
				path="src/billing/retry.ts"
				state={{ status: "ready", text: sourceFile, size: bytes(sourceFile), version: 4 }}
				actions={<Button variant="ghost">History</Button>}
			/>
		</div>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="File viewer: loading" intro="Placeholder lines while the file is read.">
		<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
			<FileViewer path="src/billing/retry.ts" state={{ status: "loading" }} />
		</div>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="File viewer: empty" intro="A file with nothing in it says so, rather than showing a blank page.">
		<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
			<FileViewer path="src/billing/__init__.py" state={{ status: "ready", text: "", size: 0 }} />
		</div>
	</Sheet>
);

// Named ErrorState so the export doesn't shadow the global Error; the workbench shows it as "Error".
export const ErrorState: Story = () => (
	<Sheet title="File viewer: error" intro="When the file can't be read, the viewer says why.">
		<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
			<FileViewer
				path="src/billing/retry.ts"
				state={{ status: "error", message: "Couldn't read this file. It may have been deleted." }}
			/>
		</div>
	</Sheet>
);
ErrorState.storyName = "Error";

export const CantShow: Story = () => (
	<Sheet
		title="File viewer: files it can't show"
		intro="Binary files and files over the read limit say why they aren't shown, with their size in the header."
	>
		<Section title="Binary">
			<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
				<FileViewer path="logo.png" state={{ status: "binary", size: 48_211, contentType: "image/png" }} />
			</div>
		</Section>
		<Section title="Too large">
			<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
				<FileViewer path="exports/invoices-2026.jsonl" state={{ status: "too-large", size: 24 * 1024 * 1024 }} />
			</div>
		</Section>
	</Sheet>
);
CantShow.storyName = "Can't show";

export const LongContent: Story = () => (
	<Sheet
		title="File viewer: long content"
		intro="Six hundred lines, some far wider than the viewer: long lines scroll sideways with the numbers held at the left. Past 5,000 lines the viewer shows the first 5,000 and says how many more there are."
	>
		<Section title="600 lines">
			<div className="hb-story-viewer-frame hb-story-viewer-frame-tall">
				<FileViewer
					path="test/fixtures/a-directory-with-a-long-name/billing-retry-generated-cases.test.ts"
					state={{ status: "ready", text: longSourceFile, size: bytes(longSourceFile) }}
				/>
			</div>
		</Section>
		<Section title="Over 5,000 lines">
			<div className="hb-story-viewer-frame">
				<FileViewer path="logs/retry.log" state={{ status: "ready", text: overCapFile, size: bytes(overCapFile) }} />
			</div>
		</Section>
	</Sheet>
);

export const Phone: Story = () => (
	<Sheet title="File viewer at 420px" intro="On a phone the viewer fills the screen and Back returns to the tree.">
		<div className="hb-story-viewer-frame hb-story-viewer-frame-tall">
			<FileViewer
				path="src/billing/retry.ts"
				state={{ status: "ready", text: longSourceFile, size: bytes(longSourceFile) }}
				onBack={back}
			/>
		</div>
	</Sheet>
);
Phone.meta = { width: 420 };
