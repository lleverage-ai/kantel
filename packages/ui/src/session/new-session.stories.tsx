import { type ReactNode, useEffect, useRef, useState } from "react";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { Composer } from "./composer.tsx";
import { FIXTURE_NOW, sessions as fixtureSessions } from "./fixtures.ts";
import { type ComposerModelOption, type ProjectOption, ProjectPicker } from "./model-picker.tsx";
import { NewSessionRow } from "./new-session.tsx";
import { SessionHeader } from "./session-header.tsx";
import { SessionList } from "./session-list.tsx";
import type { SessionSummary } from "./session-model.ts";
import { pickerFrame, transcriptFrameTall } from "./story-frames.ts";
import { Transcript } from "./transcript.tsx";

export default { title: "Session/New session" } satisfies StoryDefault;

const base = Date.now();
const sessions: SessionSummary[] = fixtureSessions.map((session) => ({
	...session,
	startedAt: session.startedAt - FIXTURE_NOW + base,
	updatedAt: session.updatedAt - FIXTURE_NOW + base,
}));

const VIEWER_REASON = "You can watch this project's sessions. Starting one needs the operator role.";

const projects: ProjectOption[] = [
	{ id: "billing", label: "Billing" },
	{ id: "support", label: "Customer support" },
	{ id: "docs", label: "Docs site" },
	{ id: "infra", label: "Infrastructure", disabledReason: "You're a viewer here" },
];

const models: ComposerModelOption[] = [
	{
		id: "default",
		label: "Claude Sonnet 5.5",
		provider: "Anthropic",
		capabilities: { images: true },
		default: true,
	},
	{ id: "default:claude-opus-5-5", label: "Claude Opus 5.5", provider: "Anthropic", capabilities: { images: true } },
	{ id: "default:gpt-5-5", label: "GPT-5.5", provider: "OpenAI", capabilities: { images: true } },
];

/** The sidebar's width, as the row sits in the console. */
function Sidebar({ children }: { children: ReactNode }) {
	return <div style={{ width: "100%", maxWidth: "var(--hb-sidebar-width)" }}>{children}</div>;
}

export const Row: Story = () => (
	<Sheet
		title="New session row"
		intro="At the top of a project's sessions, as T3 Code's New thread: a link to the host's new-session page. For someone who can't start a session there it stays in place, dimmed, and says why under it."
	>
		<Section title="Ready">
			<Sidebar>
				<NewSessionRow href="#new" />
			</Sidebar>
		</Section>
		<Section title="Open: the new-session page is showing">
			<Sidebar>
				<NewSessionRow href="#new" selected />
			</Sidebar>
		</Section>
		<Section title="A viewer">
			<Sidebar>
				<NewSessionRow disabledReason={VIEWER_REASON} />
			</Sidebar>
		</Section>
		<Section title="Above the session list">
			<Sidebar>
				<NewSessionRow href="#new" />
				<SessionList sessions={sessions} hrefFor={(id) => `#session-${id}`} />
			</Sidebar>
		</Section>
		<Section title="Above an empty list, for a viewer">
			<Sidebar>
				<NewSessionRow disabledReason={VIEWER_REASON} />
				<SessionList
					sessions={[]}
					empty={
						<EmptyState title="No sessions in this project yet">
							Sessions started here, by you or a schedule, show up as they run.
						</EmptyState>
					}
				/>
			</Sidebar>
		</Section>
	</Sheet>
);
Row.storyName = "New session row";

function Picker({ open = false, disabled = false }: { open?: boolean; disabled?: boolean }) {
	const [project, setProject] = useState("billing");
	return (
		<ProjectPicker projects={projects} value={project} onChange={setProject} defaultOpen={open} disabled={disabled} />
	);
}

export const Projects: Story = () => (
	<Sheet
		title="Project picker"
		intro="Which project a new session starts in: the model picker's button and searchable list, with a folder. A project the person can only watch shows dimmed with the reason."
	>
		<Section title="Closed">
			<Picker />
		</Section>
		<Section title="Disabled while the session is being created">
			<Picker disabled />
		</Section>
	</Sheet>
);
Projects.storyName = "Project picker";

function OpenPicker({ children }: { children: ReactNode }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		frame.current?.querySelector<HTMLButtonElement>(".hb-model-trigger")?.click();
	}, []);
	return (
		<div ref={frame} className={pickerFrame}>
			{children}
		</div>
	);
}

export const ProjectsOpen: Story = () => (
	<Sheet title="Project picker, open" intro="Type to filter; Up and Down move, Enter chooses, Escape closes.">
		<OpenPicker>
			<Picker />
		</OpenPicker>
	</Sheet>
);
ProjectsOpen.storyName = "Project picker open";

/** The new-session page as a host builds it: the header, an empty transcript and the composer with both pickers. */
function Page({
	state = "idle",
	failure,
	reason,
}: {
	state?: "idle" | "sending" | "disabled";
	failure?: string;
	reason?: string;
}) {
	const [project, setProject] = useState("billing");
	const [model, setModel] = useState<string>();
	const name = projects.find((candidate) => candidate.id === project)?.label ?? "";
	return (
		<div className={transcriptFrameTall}>
			<SessionHeader title="" parents={[{ label: name, href: "#project" }]} connection={{ state: "open" }} />
			<Transcript
				items={[]}
				centreDockWhenEmpty
				empty={
					<EmptyState greeting title={`Start a session in ${name}`}>
						Write the first message. Assistant answers it with the model you pick.
					</EmptyState>
				}
				dock={
					<Composer
						state={state}
						{...(reason === undefined ? {} : { disabledReason: reason })}
						banner={failure === undefined ? undefined : <Notice level="error">{failure}</Notice>}
						onSend={() => {}}
						models={models}
						{...(model === undefined ? {} : { model })}
						onModelChange={setModel}
						footer={<ProjectPicker projects={projects} value={project} onChange={setProject} />}
						autoFocus
					/>
				}
			/>
		</div>
	);
}

export const NewSessionPage: Story = () => (
	<Sheet
		title="New session page"
		intro="What the console shows for New session, after T3 Code's new thread: no transcript yet, the composer with the model and the project beside it. Sending creates the session and opens it."
	>
		<Section title="Ready">
			<Page />
		</Section>
		<Section title="Creating the session">
			<Page state="sending" />
		</Section>
		<Section title="The session couldn't be created">
			<Page failure="Harbour answered 503. Your message is still here; send it again." />
		</Section>
		<Section title="A viewer who followed a link here">
			<Page state="disabled" reason={VIEWER_REASON} />
		</Section>
	</Sheet>
);
NewSessionPage.storyName = "New session page";

export const Mobile: Story = () => (
	<Sheet
		title="New session at 420px"
		intro="On a phone the row heads the list page and the new-session page fills the screen."
	>
		<Section title="The list page">
			<Sidebar>
				<NewSessionRow href="#new" />
				<SessionList sessions={sessions.slice(0, 4)} hrefFor={(id) => `#session-${id}`} />
			</Sidebar>
		</Section>
		<Section title="A viewer's list page">
			<Sidebar>
				<NewSessionRow disabledReason={VIEWER_REASON} />
			</Sidebar>
		</Section>
		<Section title="The new-session page">
			<Page />
		</Section>
	</Sheet>
);
Mobile.meta = { width: 420 };
