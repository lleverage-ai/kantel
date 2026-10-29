import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { FilePanel, type FilePanelState } from "./file-panel.tsx";
import { PresentedFileCard, PresentedFiles } from "./presented-file-card.tsx";
import { presentedKey } from "./presented-file-model.ts";
import {
	bytesOf,
	dashboardHtml,
	presentedDoc,
	presentedPage,
	presentedPdf,
	presentedReport,
	presentedSheet,
	reportMarkdown,
	samplePdf,
} from "./presented-fixtures.ts";
import "../workspace/stories.css";

export default { title: "Workspace/Presented files" } satisfies StoryDefault;

const close = () => {};
const download = () => {};

const call: ToolItem = {
	kind: "tool",
	id: "t1",
	callId: "c1",
	at: 0,
	name: "present_files",
	label: "Presenting 5 files",
	status: "done",
	files: [presentedReport, presentedPdf, presentedPage, presentedSheet, presentedDoc],
};

const contentOf = (file: PresentedFile): Uint8Array | undefined =>
	file === presentedReport
		? bytesOf(reportMarkdown)
		: file === presentedPage
			? bytesOf(dashboardHtml)
			: file === presentedPdf
				? samplePdf()
				: undefined;

export const Cards: Story = () => (
	<Sheet
		title="Presented file cards"
		intro="What a present_files call leaves in the transcript: a card per file, with its kind, size and, for text, its first lines. Pressing one opens it in the viewer; the open one has an accent border."
	>
		<Section title="One call, five files">
			<PresentedFiles item={call} onOpen={() => {}} openKey={presentedKey(presentedPdf)} />
		</Section>
		<Section title="Read-only (no viewer)">
			<Column>
				<PresentedFileCard file={presentedReport} />
			</Column>
		</Section>
	</Sheet>
);

function Viewer({ file, state }: { file: PresentedFile; state?: FilePanelState }) {
	const content = contentOf(file);
	return (
		<div className="hb-story-viewer-frame hb-story-viewer-frame-tall">
			<FilePanel
				file={file}
				state={
					state ??
					(content === undefined ? { status: "ready", content: new Uint8Array() } : { status: "ready", content })
				}
				onClose={close}
				onDownload={download}
			/>
		</div>
	);
}

export const Markdown: Story = () => (
	<Sheet title="Viewer: Markdown" intro="Rendered as a note is, at the transcript's reading measure.">
		<Viewer file={presentedReport} />
	</Sheet>
);

export const Html: Story = () => (
	<Sheet
		title="Viewer: HTML"
		intro="In an iframe sandboxed without allow-same-origin, under a policy that blocks requests, forms and frames. Its scripts run; it can't reach the console."
	>
		<Viewer file={presentedPage} />
	</Sheet>
);
Html.storyName = "HTML";

export const Pdf: Story = () => (
	<Sheet title="Viewer: PDF" intro="Page by page with pdf.js, at the viewer's width.">
		<Viewer file={presentedPdf} />
	</Sheet>
);
Pdf.storyName = "PDF";

export const NotShown: Story = () => (
	<Sheet title="Viewer: a kind it can't show" intro="Says so, and offers Download.">
		<Viewer file={presentedDoc} />
	</Sheet>
);

export const States: Story = () => (
	<Sheet title="Viewer: loading, too large and error" intro="While the file is read, and when it can't be shown.">
		<Column>
			<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
				<FilePanel file={presentedPdf} state={{ status: "loading" }} onClose={close} />
			</div>
			<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
				<FilePanel file={presentedDoc} state={{ status: "too-large" }} onClose={close} />
			</div>
			<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
				<FilePanel
					file={presentedReport}
					state={{ status: "error", message: "churn-review.md is no longer in the workspace." }}
					onClose={close}
				/>
			</div>
		</Column>
	</Sheet>
);

export const Interactive: Story = () => {
	const [open, setOpen] = useState<PresentedFile | undefined>(presentedReport);
	const content = open === undefined ? undefined : contentOf(open);
	return (
		<Sheet title="Cards and viewer" intro="Press a card to open its file; Close or Escape closes the viewer.">
			<div className="hb-story-presented-split">
				<div>
					<PresentedFiles
						item={call}
						onOpen={(file) => setOpen(file)}
						openKey={open === undefined ? undefined : presentedKey(open)}
					/>
				</div>
				{open === undefined ? null : (
					<FilePanel
						key={presentedKey(open)}
						file={open}
						state={
							content === undefined ? { status: "ready", content: new Uint8Array() } : { status: "ready", content }
						}
						onClose={() => setOpen(undefined)}
						onDownload={download}
					/>
				)}
			</div>
		</Sheet>
	);
};
