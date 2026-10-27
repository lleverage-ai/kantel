import { useCallback, useState } from "react";
import { EmptyState } from "../primitives/surface.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { FileTree } from "./file-tree.tsx";
import {
	deepTree,
	projectDirectories,
	projectWithFailedDirectory,
	projectWithLoadingDirectory,
	rootEmpty,
	rootFailed,
	rootLoading,
} from "./fixtures.ts";
import type { DirectoryState } from "./workspace-model.ts";
import "./stories.css";

export default { title: "Workspace/File tree" } satisfies StoryDefault;

const nothingOpen: ReadonlySet<string> = new Set();
const ignore = () => {};
const hrefFor = (path: string) => `#file=${encodeURIComponent(path)}`;

/** A tree with its own open directories and selection, as a host keeps them. */
function TreeDemo({
	directories,
	open = [],
	selected: initial,
	links = false,
	root,
}: {
	directories: ReadonlyMap<string, DirectoryState>;
	open?: readonly string[];
	selected?: string;
	links?: boolean;
	root?: string;
}) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(open));
	const [selected, setSelected] = useState(initial);
	const toggle = useCallback((path: string) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);
	return (
		<FileTree
			label="Files"
			directories={directories}
			expanded={expanded}
			selectedPath={selected}
			onToggle={toggle}
			onSelect={setSelected}
			hrefFor={links ? hrefFor : undefined}
			root={root}
		/>
	);
}

export const Default: Story = () => (
	<Sheet
		title="File tree"
		intro="A workspace's files, directories first. Click a directory to open it, or use the arrow keys: Right opens and moves in, Left closes and moves out, Enter chooses a file. The tree is one Tab stop."
	>
		<Section title="One directory open, one file selected">
			<div className="hb-story-tree-frame">
				<TreeDemo directories={projectDirectories} open={["src"]} selected="src/app.ts" />
			</div>
		</Section>
		<Section title="Files as links">
			<div className="hb-story-tree-frame">
				<TreeDemo
					directories={projectDirectories}
					open={["notes", "notes/empty"]}
					selected="notes/release-notes.md"
					links
				/>
			</div>
		</Section>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="File tree: loading" intro="Placeholder rows while the workspace's root is listed.">
		<div className="hb-story-tree-frame">
			<FileTree label="Files" directories={rootLoading} expanded={nothingOpen} onToggle={ignore} />
		</div>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="File tree: empty" intro="A workspace with no files yet, and the same with the host's own empty state.">
		<Section title="Default">
			<div className="hb-story-tree-frame">
				<FileTree label="Files" directories={rootEmpty} expanded={nothingOpen} onToggle={ignore} />
			</div>
		</Section>
		<Section title="From the host">
			<div className="hb-story-tree-frame">
				<FileTree
					label="Notes"
					directories={rootEmpty}
					expanded={nothingOpen}
					onToggle={ignore}
					empty={<EmptyState title="No notes yet">Notes the agent writes in this session appear here.</EmptyState>}
				/>
			</div>
		</Section>
	</Sheet>
);

// Named ErrorState so the export doesn't shadow the global Error; the workbench shows it as "Error".
export const ErrorState: Story = () => (
	<Sheet title="File tree: error" intro="When the root can't be listed, the tree says why.">
		<div className="hb-story-tree-frame">
			<FileTree label="Files" directories={rootFailed} expanded={nothingOpen} onToggle={ignore} />
		</div>
	</Sheet>
);
ErrorState.storyName = "Error";

export const InlineLoading: Story = () => (
	<Sheet
		title="File tree: a directory loading"
		intro="An open directory whose listing hasn't arrived shows a Loading row under it. The rest of the tree works as usual."
	>
		<div className="hb-story-tree-frame">
			<TreeDemo directories={projectWithLoadingDirectory} open={["src"]} />
		</div>
	</Sheet>
);

export const InlineError: Story = () => (
	<Sheet
		title="File tree: a directory that failed"
		intro="An open directory that couldn't be listed shows a quiet error row with the reason, in place of its files."
	>
		<div className="hb-story-tree-frame">
			<TreeDemo directories={projectWithFailedDirectory} open={["docs"]} />
		</div>
	</Sheet>
);

const deep = deepTree();
const deepOpen = [...deep.expanded];
const deepSelected =
	"packages/a-package-with-a-rather-long-name-for-the-sidebar/src/components/workspace-file-browser/internal/README.md";

export const LongContent: Story = () => (
	<Sheet
		title="File tree: long content"
		intro="A project mount, six nested directories with long names, forty files at the root and a truncated listing. Names truncate with the full name on hover; sizes keep their width."
	>
		<Section title="Deep and wide">
			<div className="hb-story-tree-frame">
				<TreeDemo directories={deep.directories} open={deepOpen} selected={deepSelected} />
			</div>
		</Section>
		<Section title="Rooted at the project mount">
			<div className="hb-story-tree-frame">
				<TreeDemo directories={deep.directories} open={["/project/docs"]} root="/project" />
			</div>
		</Section>
	</Sheet>
);

export const Phone: Story = () => (
	<Sheet
		title="File tree at 420px"
		intro="The tree fills a phone's width; rows are touch height under a coarse pointer."
	>
		<Column>
			<TreeDemo directories={projectDirectories} open={["src", "src/billing"]} selected="src/billing/retry.ts" links />
		</Column>
	</Sheet>
);
Phone.meta = { width: 420 };
