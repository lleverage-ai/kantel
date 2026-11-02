import { useState } from "react";
import { DraftDocumentCard, PresentedFileCard, presentedFilesItemClass } from "../presented/presented-file-card.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Sheet } from "../workbench/specimen.tsx";
import { type ShareAccess, type ShareControls, SharePopover, type ShareState } from "./share-popover.tsx";

// The document itself opens in the file preview (preview/file-preview.stories.tsx: Streaming document).
export default { title: "Documents/Sharing" } satisfies StoryDefault;

/** Story-only: the Share popover shown in place, in a frame its height, rather than hung under a button. */
const shareFrame = "relative flex w-full justify-end [&>.kt-share-popover]:static";

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
		onCopyLink: async () => "https://kantel.example/s/7cQm2xWfZ9",
	};
	return { sharing, exports };
}

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
				<div className={shareFrame}>
					<SharePopover title="The colours of the rainbow" {...share} onClose={() => {}} />
				</div>
				<div className={shareFrame}>
					<SharePopover title="The colours of the rainbow" {...linked} onClose={() => {}} />
				</div>
				<div className={shareFrame}>
					<SharePopover title="The colours of the rainbow" {...share} onClose={() => {}} initialTab="export" />
				</div>
			</Column>
		</Sheet>
	);
};

export const Cards: Story = () => (
	<Sheet
		title="In the transcript"
		intro="While it streams the answer shows the card the document becomes; once saved, the call's card opens it in the panel."
	>
		<Column>
			<div className={presentedFilesItemClass}>
				<DraftDocumentCard title="The colours of the rainbow" />
			</div>
			<div className={presentedFilesItemClass}>
				<PresentedFileCard
					file={{
						workspaceId: "ws-1",
						path: "documents/the-colours-of-the-rainbow.md",
						name: "the-colours-of-the-rainbow.md",
						mimeType: "text/markdown",
						size: 1200,
						title: "The colours of the rainbow",
						document: true,
					}}
					onOpen={() => {}}
				/>
			</div>
		</Column>
	</Sheet>
);
