import { type ReactNode, useEffect, useRef, useState } from "react";
import { EmptyState } from "../primitives/surface.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { ComposerAccessOption } from "./access-picker.tsx";
import { Composer } from "./composer.tsx";
import { finishedTurn, longTranscript } from "./fixtures.ts";
import { type ComposerModelOption, type ProjectOption, ProjectPicker, RepoPicker } from "./model-picker.tsx";
import { SessionHeader } from "./session-header.tsx";
import type { ThinkingLevel } from "./thinking-model.ts";
import { Transcript } from "./transcript.tsx";

// The composer's pickers as the console shows them: a whole window, header on top, with the composer either in the
// middle of an empty session (as a new session opens) or docked at the foot of a transcript. Each story opens one
// picker, so its screenshot shows where the popover lands with the window's real room above and below the composer.
// Shoot them at a laptop's window (1440x900, 1280x720): a picker opens upward when it fits there, else downward, and
// is never taller than the room on the side it opens to.

export default { title: "Session/Composer in the window" } satisfies StoryDefault;

const levels: ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
const model = (id: string, label: string, provider: string, extra: Partial<ComposerModelOption> = {}) =>
	({ id, label, provider, capabilities: { images: true, thinking: levels }, ...extra }) satisfies ComposerModelOption;

/** A catalogue as long as harbour.myslop.app's: a dozen Anthropic models, so the list is at its full height. */
const models: ComposerModelOption[] = [
	model("default", "Claude Sonnet 5.5", "Anthropic", { default: true }),
	model("default:claude-opus-5-5", "Claude Opus 5.5", "Anthropic"),
	model("default:claude-haiku-5-5", "Claude Haiku 5.5", "Anthropic"),
	model("default:claude-fable-5-1", "Claude Fable 5.1", "Anthropic"),
	model("default:claude-fable-5", "Claude Fable 5", "Anthropic"),
	model("default:claude-opus-5", "Claude Opus 5", "Anthropic"),
	model("default:claude-sonnet-5", "Claude Sonnet 5", "Anthropic"),
	model("default:claude-opus-4-8", "Claude Opus 4.8", "Anthropic"),
	model("default:claude-opus-4-7", "Claude Opus 4.7", "Anthropic"),
	model("default:claude-opus-4-6", "Claude Opus 4.6", "Anthropic"),
	model("default:claude-sonnet-4-6", "Claude Sonnet 4.6", "Anthropic"),
	model("default:claude-haiku-4-5", "Claude Haiku 4.5", "Anthropic"),
	model("default:grok-5", "Grok 5", "xAI"),
	model("default:gpt-6-sol", "GPT-6 Sol", "OpenAI"),
	model("default:gpt-6-luna", "GPT-6 Luna", "OpenAI"),
];

const access: ComposerAccessOption[] = [
	{ id: "full-access", label: "Full access", description: "Runs commands and edits files without asking." },
	{ id: "supervised", label: "Supervised", description: "Asks before commands and file changes." },
];

const projects: ProjectOption[] = [
	{ id: "default", label: "Default" },
	{ id: "billing", label: "Billing" },
	{ id: "support", label: "Customer support" },
	{ id: "docs", label: "Docs site" },
	{ id: "infra", label: "Infrastructure" },
	{ id: "growth", label: "Growth experiments" },
	{ id: "mobile", label: "Mobile app" },
	{ id: "data", label: "Data platform" },
	{ id: "design", label: "Design system" },
	{ id: "ops", label: "Operations" },
];

/** Which picker a story opens, by its trigger. */
const TRIGGERS = {
	model: '.hb-model-trigger[aria-label^="Model:"]',
	thinking: ".hb-thinking-trigger",
	access: ".hb-access-trigger",
	project: '.hb-model-trigger[aria-label^="Project:"]',
} as const;
type Opens = keyof typeof TRIGGERS;

/** The whole window, over the workbench's padding, as the console's main area is under its header. */
function Window({ opens, children }: { opens: Opens; children: ReactNode }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		frame.current?.querySelector<HTMLButtonElement>(TRIGGERS[opens])?.click();
	}, [opens]);
	return (
		<div ref={frame} className="fixed inset-0 flex flex-col bg-canvas">
			{children}
		</div>
	);
}

function Pickers({ captureTyping = false }: { captureTyping?: boolean }) {
	const [chosen, setChosen] = useState<string>();
	const [thinking, setThinking] = useState<ThinkingLevel>("low");
	const [project, setProject] = useState("default");
	const [repo, setRepo] = useState("");
	return (
		<Composer
			state="idle"
			placeholder="What should this session do?"
			onSend={() => {}}
			models={models}
			{...(chosen === undefined ? {} : { model: chosen })}
			onModelChange={setChosen}
			thinking={thinking}
			onThinkingChange={setThinking}
			accessOptions={access}
			access="full-access"
			onAccessChange={() => {}}
			footer={
				<>
					<ProjectPicker projects={projects} value={project} onChange={setProject} />
					<RepoPicker value={repo} onChange={setRepo} recent={["tvdavies/harbour", "tvdavies/sal"]} />
				</>
			}
			captureTyping={captureTyping}
		/>
	);
}

/** A new session: no transcript yet, the greeting and the composer together in the middle of the window. */
function Centred({ opens }: { opens: Opens }) {
	return (
		<Window opens={opens}>
			<SessionHeader title="" parents={[{ label: "Default", href: "#project" }]} connection={{ state: "open" }} />
			<Transcript
				items={[]}
				centreDockWhenEmpty
				empty={
					<EmptyState greeting title="Start a session in Default">
						Write the first message. Assistant answers it.
					</EmptyState>
				}
				dock={<Pickers captureTyping />}
			/>
		</Window>
	);
}

const conversation = [...finishedTurn, ...longTranscript(6)];

/** An existing session: the composer docked at the transcript's foot. */
function Docked({ opens }: { opens: Opens }) {
	return (
		<Window opens={opens}>
			<SessionHeader
				title="Tidy the billing exports"
				parents={[{ label: "Default", href: "#project" }]}
				connection={{ state: "open" }}
			/>
			<Transcript items={conversation} dock={<Pickers />} />
		</Window>
	);
}

export const CentredModel: Story = () => <Centred opens="model" />;
CentredModel.storyName = "New session, model picker open";

export const CentredThinking: Story = () => <Centred opens="thinking" />;
CentredThinking.storyName = "New session, effort picker open";

export const CentredAccess: Story = () => <Centred opens="access" />;
CentredAccess.storyName = "New session, access picker open";

export const CentredProject: Story = () => <Centred opens="project" />;
CentredProject.storyName = "New session, project picker open";

export const DockedModel: Story = () => <Docked opens="model" />;
DockedModel.storyName = "Docked, model picker open";

export const DockedThinking: Story = () => <Docked opens="thinking" />;
DockedThinking.storyName = "Docked, effort picker open";
