import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { FilePanel, type FilePanelState } from "./file-panel.tsx";
import { PresentedFileCard, PresentedFiles } from "./presented-file-card.tsx";
import { presentedKey } from "./presented-file-model.ts";
import {
	bytesOf,
	dashboardHtml,
	pipelineCsv,
	presentedCsv,
	presentedDeck,
	presentedDoc,
	presentedPage,
	presentedPdf,
	presentedReport,
	presentedSheet,
	presentedZip,
	reportMarkdown,
	samplePdf,
} from "./presented-fixtures.ts";
import deckUrl from "./samples/board-pack.pptx?url";
import docUrl from "./samples/churn-review.docx?url";
import sheetUrl from "./samples/pipeline.xlsx?url";
import "../workspace/stories.css";

export default { title: "Workspace/Presented files" } satisfies StoryDefault;

const close = () => {};
const download = () => {};

const all = [
	presentedReport,
	presentedPdf,
	presentedPage,
	presentedDoc,
	presentedSheet,
	presentedDeck,
	presentedCsv,
	presentedZip,
];

const call: ToolItem = {
	kind: "tool",
	id: "t1",
	callId: "c1",
	at: 0,
	name: "present_files",
	label: `Presenting ${all.length} files`,
	status: "done",
	files: all,
};

/** The sample Office files are real files beside the stories, made with docx, pptxgenjs and SheetJS. */
const urls = new Map<PresentedFile, string>([
	[presentedDoc, docUrl],
	[presentedSheet, sheetUrl],
	[presentedDeck, deckUrl],
]);

/** A file's bytes, as a host would read them: at once for text, fetched for the sample Office files. */
function useContent(file: PresentedFile): FilePanelState {
	const [state, setState] = useState<FilePanelState>({ status: "loading" });
	useEffect(() => {
		const text =
			file === presentedReport
				? reportMarkdown
				: file === presentedPage
					? dashboardHtml
					: file === presentedCsv
						? pipelineCsv
						: undefined;
		if (text !== undefined) return setState({ status: "ready", content: bytesOf(text) });
		if (file === presentedPdf) return setState({ status: "ready", content: samplePdf() });
		const url = urls.get(file);
		if (url === undefined) return setState({ status: "ready", content: new Uint8Array() });
		let cancelled = false;
		setState({ status: "loading" });
		void fetch(url)
			.then((response) => response.arrayBuffer())
			.then((buffer) => {
				if (!cancelled) setState({ status: "ready", content: new Uint8Array(buffer) });
			});
		return () => {
			cancelled = true;
		};
	}, [file]);
	return state;
}

export const Cards: Story = () => (
	<Sheet
		title="Presented file cards"
		intro="What a present_files call leaves in the transcript: a card per file, after Claude's: a lucide icon in a square tinted for its kind, its title and what kind of file it is. Pressing one opens it in the viewer; the open one has an accent border."
	>
		<Section title={`One call, ${all.length} files`}>
			<PresentedFiles item={call} onOpen={() => {}} openKey={presentedKey(presentedPdf)} />
		</Section>
		<Section title="Read-only (no viewer)">
			<Column>
				<PresentedFileCard file={presentedReport} />
			</Column>
		</Section>
	</Sheet>
);

function Viewer({ file }: { file: PresentedFile }) {
	const state = useContent(file);
	return (
		<div className="hb-story-viewer-frame hb-story-viewer-frame-tall">
			<FilePanel file={file} state={state} onClose={close} onDownload={download} />
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

export const Word: Story = () => (
	<Sheet title="Viewer: Word" intro="Laid out as pages with docx-preview, scaled down when the viewer is narrower.">
		<Viewer file={presentedDoc} />
	</Sheet>
);

export const Excel: Story = () => (
	<Sheet title="Viewer: Excel" intro="A grid per sheet with SheetJS, its cells as Excel formats them; sheets as tabs.">
		<Viewer file={presentedSheet} />
	</Sheet>
);

export const Csv: Story = () => (
	<Sheet title="Viewer: CSV" intro="CSV and TSV in the same grid, quoted fields and all.">
		<Viewer file={presentedCsv} />
	</Sheet>
);
Csv.storyName = "CSV";

export const PowerPoint: Story = () => (
	<Sheet
		title="Viewer: PowerPoint"
		intro="Slide under slide with pptx-renderer, charts included; external media blocked."
	>
		<Viewer file={presentedDeck} />
	</Sheet>
);

export const NotShown: Story = () => (
	<Sheet title="Viewer: a kind it can't show" intro="Says so, and offers Download.">
		<Viewer file={presentedZip} />
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

function OpenFile({ file, onClose }: { file: PresentedFile; onClose: () => void }) {
	const state = useContent(file);
	return <FilePanel file={file} state={state} onClose={onClose} onDownload={download} />;
}

export const Interactive: Story = () => {
	const [open, setOpen] = useState<PresentedFile | undefined>(presentedReport);
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
					<OpenFile key={presentedKey(open)} file={open} onClose={() => setOpen(undefined)} />
				)}
			</div>
		</Sheet>
	);
};
