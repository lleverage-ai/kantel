import { useCallback, useEffect, useMemo, useState } from "react";
import type { ShareAccess, ShareControls, ShareState } from "../documents/share-popover.tsx";
import { DraftDocumentCard, PresentedFileCard } from "../presented/presented-file-card.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Sheet } from "../workbench/specimen.tsx";
import { FilePreview } from "./file-preview.tsx";
import { binaryFixture, chartPng, type Fixture, pdfFixture, RAINBOW, TEXT_FIXTURES } from "./fixtures.ts";
import type { PreviewContent, PreviewFile } from "./preview-model.ts";

export default { title: "Preview/File preview" } satisfies StoryDefault;

// The stories lay the preview out as the console's session screen does: the transcript (here, cards) at the left and
// the panel at the right, at the width it was last dragged to, inside a frame the height of a laptop screen.

const frame = "relative flex h-180 w-full overflow-hidden rounded-panel border border-border bg-canvas";
const side = "flex min-w-0 flex-auto flex-col gap-3 overflow-auto p-gutter";
// On a phone, a sheet over the cards with nothing to resize, as the console's narrow main area has it.
const panel =
	"flex-[0_0_clamp(var(--hb-card-width),var(--hb-preview-share,48%),75%)] max-sm:absolute! max-sm:inset-0 max-sm:z-(--hb-z-overlay) max-sm:[&_.hb-preview-resize]:hidden";

const owner = { name: "Tom Davies", email: "tom@example.com" };

function useShare(): {
	sharing: ShareControls;
	exports: { id: string; label: string; hint: string; run: () => void }[];
} {
	const [share, setShare] = useState<ShareState>({ owner, access: "restricted", invites: [] });
	return {
		sharing: {
			share,
			onAccessChange: (access: ShareAccess) => setShare((current) => ({ ...current, access })),
			onInvite: (email: string) => setShare((current) => ({ ...current, invites: [...current.invites, { email }] })),
			onRemoveInvite: (email: string) =>
				setShare((current) => ({ ...current, invites: current.invites.filter((each) => each.email !== email) })),
			onCopyLink: async () => "https://harbour.example/s/7cQm2xWfZ9",
		},
		exports: [{ id: "download", label: "Download", hint: "The file as it is", run: () => {} }],
	};
}

/** Every fixture: the text kinds, then a chart, a PDF and an archive. */
function useFixtures(): readonly Fixture[] {
	const [png, setPng] = useState<Uint8Array>();
	useEffect(() => {
		void chartPng().then(setPng);
	}, []);
	return useMemo(() => {
		const image: Fixture = {
			file: { key: "chart", name: "chart.png", path: "outputs/chart.png", mimeType: "image/png", model: "gpt-image-1" },
			content: png === undefined ? { status: "loading" } : { status: "ready", bytes: png, contentType: "image/png" },
		};
		return [...TEXT_FIXTURES, image, pdfFixture(), binaryFixture()];
	}, [png]);
}

const asPresented = (file: PreviewFile) => ({
	workspaceId: "ws-1",
	path: file.path,
	name: file.name,
	mimeType: file.mimeType ?? "",
	size: file.size ?? 0,
	...(file.title === undefined ? {} : { title: file.title }),
});

/** The session screen: cards at the left open the panel; Previous and Next (or j and k) move through them. */
export const SlideIn: Story = () => {
	const fixtures = useFixtures();
	const [open, setOpen] = useState<string | undefined>("report");
	const share = useShare();
	const shown = fixtures.find((each) => each.file.key === open);
	const files = useMemo(() => fixtures.map((each) => each.file), [fixtures]);
	return (
		<Sheet
			title="One panel for every file"
			intro="It slides in from the right as a file opens and stays while files change, so moving between them swaps the body in place. Drag its left edge to resize it (the width is kept); Escape closes it, j and k (or the arrow keys) move through the files, f fills the frame."
		>
			<div className={frame}>
				<div className={side}>
					{fixtures.map((each) => (
						<div key={each.file.key} className="hb-presented-files-item">
							<PresentedFileCard
								file={asPresented(each.file)}
								open={each.file.key === open}
								onOpen={() => setOpen(each.file.key)}
							/>
						</div>
					))}
				</div>
				<FilePreview
					className={panel}
					file={shown?.file}
					content={shown?.content ?? { status: "loading" }}
					siblings={files}
					onNavigate={(file) => setOpen(file.key)}
					onClose={() => setOpen(undefined)}
					onDownload={() => {}}
					share={share}
					reveal={{ label: "Show in the workspace", run: () => {} }}
					widthKey="harbour.story.preview.width"
				/>
			</div>
		</Sheet>
	);
};

/** Each kind on its own, at the panel's usual width. */
export const Kinds: Story = () => {
	const fixtures = useFixtures();
	return (
		<Sheet title="Every kind" intro="The same header for each, and the body its renderer draws.">
			<div className="grid grid-cols-2 gap-6">
				{fixtures.map((each) => (
					<div key={each.file.key} className="flex h-120 overflow-hidden rounded-panel border border-border">
						<FilePreview
							layout="docked"
							file={each.file}
							content={each.content}
							onClose={() => {}}
							onDownload={() => {}}
						/>
					</div>
				))}
			</div>
		</Sheet>
	);
};

/** The document arriving as the agent writes it, then editable in place. */
export const StreamingDocument: Story = () => {
	const [length, setLength] = useState(0);
	const [round, setRound] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Close starts the stream again, as a new document.
	useEffect(() => {
		setLength(0);
		const timer = setInterval(() => setLength((current) => Math.min(RAINBOW.length, current + 9)), 40);
		return () => clearInterval(timer);
	}, [round]);
	const done = length === RAINBOW.length;
	const share = useShare();
	const file: PreviewFile = useMemo(
		() =>
			done
				? {
						key: "doc",
						name: "the-colours-of-the-rainbow.md",
						path: "documents/the-colours-of-the-rainbow.md",
						title: "The colours of the rainbow",
						document: true,
					}
				: {
						key: "draft",
						name: "the-colours-of-the-rainbow.md",
						path: "",
						title: "The colours of the rainbow",
						document: true,
					},
		[done],
	);
	const content: PreviewContent = useMemo(
		() =>
			done
				? { status: "ready", bytes: new TextEncoder().encode(RAINBOW) }
				: { status: "streaming", text: RAINBOW.slice(0, length) },
		[done, length],
	);
	const onSave = useCallback(() => new Promise<void>((resolve) => setTimeout(resolve, 500)), []);
	return (
		<Sheet
			title="Streaming in, then editable"
			intro="While the agent writes it the page fills in with a caret at its end and the header says Writing. Once written, the same page is the editor (a document opens in Edit), saved a moment after typing stops or at once with Cmd+S."
		>
			<div className={frame}>
				<div className={side}>
					<div className="hb-presented-files-item">
						<DraftDocumentCard title="The colours of the rainbow" />
					</div>
				</div>
				<FilePreview
					className={panel}
					file={file}
					content={content}
					onClose={() => setRound((value) => value + 1)}
					onSave={onSave}
					share={share}
					widthKey="harbour.story.preview.width"
				/>
			</div>
		</Sheet>
	);
};

/** Editing code: Preview and Edit, and what the save says. One save in three fails, to show it. */
export const Editing: Story = () => {
	const fixture = TEXT_FIXTURES[1] as Fixture;
	const [saves, setSaves] = useState(0);
	const onSave = useCallback(
		() =>
			new Promise<void>((resolve, reject) => {
				setSaves((count) => count + 1);
				setTimeout(() => ((saves + 1) % 3 === 0 ? reject(new Error("conflict")) : resolve()), 400);
			}),
		[saves],
	);
	return (
		<Sheet title="Editing a file" intro="Edit swaps the code view for a text editor in the same type and place.">
			<div className="flex h-150 overflow-hidden rounded-panel border border-border">
				<FilePreview layout="docked" file={fixture.file} content={fixture.content} onClose={() => {}} onSave={onSave} />
			</div>
		</Sheet>
	);
};

/** While it's read, when it can't be, and when it's too big. */
export const States: Story = () => {
	const file: PreviewFile = { key: "plan", name: "plan.md", path: "notes/plan.md", size: 18_000_000 };
	const states: readonly PreviewContent[] = [
		{ status: "loading" },
		{ status: "error", message: "plan.md is no longer in the workspace." },
		{ status: "too-large" },
	];
	return (
		<Sheet title="Loading, unreadable and too large">
			<Column>
				{states.map((content) => (
					<div key={content.status} className="flex h-75 overflow-hidden rounded-panel border border-border">
						<FilePreview layout="docked" file={file} content={content} onClose={() => {}} />
					</div>
				))}
			</Column>
		</Sheet>
	);
};
