import { useCallback, useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Sheet } from "../workbench/specimen.tsx";
import { DocumentPanel, type DocumentSaveState } from "./document-panel.tsx";
import { type ShareAccess, type ShareControls, SharePopover, type ShareState } from "./share-popover.tsx";
import "../workspace/stories.css";
import "./stories.css";

export default { title: "Documents/Document panel" } satisfies StoryDefault;

const rainbow = `# The colours of the rainbow

A rainbow always has seven colours, and they always come in the same order. Rainbows appear when sunlight shines through raindrops, so look for one when it is sunny and rainy at the same time!

## The seven colours, in order

| # | Colour | Things that are this colour |
| --- | --- | --- |
| 1 | Red | Strawberries, fire engines, ladybirds |
| 2 | Orange | Oranges, carrots, pumpkins |
| 3 | Yellow | Bananas, the sun, ducklings |
| 4 | Green | Grass, frogs, peas |
| 5 | Blue | The sky, the sea, blueberries |
| 6 | Indigo | Blackberries, the night sky, denim jeans |
| 7 | Violet | Lavender, grapes, violets |

## A trick to remember the order

Take the first letter of each colour and you get a funny name: **ROY G BIV**.

- Or try this sentence, where each word starts with the next colour:
- *Richard Of York Gave Battle In Vain.*

Can you say all seven colours without looking?
`;

const owner = { name: "Tom Davies", email: "tom@example.com" };
const exports = [
	{ id: "markdown", label: "Markdown", hint: "A .md file of the document", run: () => {} },
	{ id: "pdf", label: "PDF", hint: "Print it, or save it as a PDF", run: () => {} },
];

/** A share the story keeps in memory, as a host would keep it on the server. */
function useShare() {
	const [share, setShare] = useState<ShareState>({ owner, access: "restricted", invites: [] });
	const sharing: ShareControls = {
		share,
		onAccessChange: (access: ShareAccess) => setShare((current) => ({ ...current, access })),
		onInvite: (email: string) =>
			setShare((current) => ({
				...current,
				invites: [...current.invites.filter((i) => i.email !== email), { email }],
			})),
		onRemoveInvite: (email: string) =>
			setShare((current) => ({ ...current, invites: current.invites.filter((invite) => invite.email !== email) })),
		onCopyLink: async () => "https://harbour.example/s/7cQm2xWfZ9",
	};
	return { sharing, exports };
}

/** The document arriving a few characters at a time, as the agent writes it. */
function useStreamed(text: string, running: boolean): string {
	const [length, setLength] = useState(0);
	useEffect(() => {
		if (!running) return;
		setLength(0);
		const timer = setInterval(() => setLength((current) => Math.min(text.length, current + 9)), 40);
		return () => clearInterval(timer);
	}, [text, running]);
	return text.slice(0, length);
}

export const Streaming: Story = () => {
	const [round, setRound] = useState(0);
	const streamed = useStreamed(rainbow, true);
	const done = streamed.length === rainbow.length;
	const share = useShare();
	return (
		<Sheet
			title="Streaming in, then editable"
			intro="While the agent writes it, the page fills in with a caret at the end and the header says Writing. When it's written, the same page becomes the editor: a toolbar, and the text edited in place."
		>
			<div className="hb-story-viewer-frame hb-story-viewer-frame-tall" key={round}>
				<DocumentPanel
					title="The colours of the rainbow"
					markdown={done ? rainbow : streamed}
					status={done ? "ready" : "streaming"}
					onChange={() => {}}
					saveState="saved"
					share={share}
					onClose={() => setRound((value) => value + 1)}
				/>
			</div>
		</Sheet>
	);
};

export const Editing: Story = () => {
	const [markdown, setMarkdown] = useState(rainbow);
	const [saveState, setSaveState] = useState<DocumentSaveState>("saved");
	const share = useShare();
	const onChange = useCallback((next: string) => {
		setMarkdown(next);
		setSaveState("saving");
		setTimeout(() => setSaveState("saved"), 600);
	}, []);
	return (
		<Sheet
			title="Editing in place"
			intro="Rich text over Markdown: headings, lists, tables, quotes and code from the toolbar or as you type (# for a heading, - for a list). The host saves what the editor gives back."
		>
			<div className="hb-story-viewer-frame hb-story-viewer-frame-tall">
				<DocumentPanel
					title="The colours of the rainbow"
					markdown={markdown}
					status="ready"
					onChange={onChange}
					saveState={saveState}
					share={share}
					onClose={() => {}}
				/>
			</div>
		</Sheet>
	);
};

export const Share: Story = () => {
	const share = useShare();
	const linked = {
		...share,
		sharing: {
			...share.sharing,
			share: { owner, access: "link" as const, invites: [{ email: "sam@example.com" }] },
		},
	};
	return (
		<Sheet
			title="Share popover"
			intro="Share: invite by email, who has access, general access (only you, or anyone with the link) and Copy link. Export: Markdown and PDF."
		>
			<Column>
				<div className="hb-story-share-frame">
					<SharePopover title="The colours of the rainbow" {...share} onClose={() => {}} />
				</div>
				<div className="hb-story-share-frame">
					<SharePopover title="The colours of the rainbow" {...linked} onClose={() => {}} />
				</div>
				<div className="hb-story-share-frame">
					<SharePopover title="The colours of the rainbow" {...share} onClose={() => {}} initialTab="export" />
				</div>
			</Column>
		</Sheet>
	);
};

export const States: Story = () => (
	<Sheet title="Loading, read-only and error" intro="While it's read, without editing, and when it can't be read.">
		<Column>
			<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
				<DocumentPanel title="Quarterly plan" markdown="" status="loading" onClose={() => {}} />
			</div>
			<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
				<DocumentPanel title="The colours of the rainbow" markdown={rainbow} status="ready" />
			</div>
			<div className="hb-story-viewer-frame hb-story-viewer-frame-short">
				<DocumentPanel
					title="Quarterly plan"
					markdown=""
					status="error"
					error="Quarterly plan is no longer in the workspace."
					onClose={() => {}}
				/>
			</div>
		</Column>
	</Sheet>
);
