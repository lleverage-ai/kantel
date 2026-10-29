import type { QuestionCard as QuestionCardData, TranscriptItem } from "@harbour/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Row, Section, Sheet } from "../workbench/specimen.tsx";
import type { ComposerAccessOption } from "./access-picker.tsx";
import { Composer, type ComposerProps, type ComposerState } from "./composer.tsx";
import { type ComposerAttachment, type UploadContext, useComposerAttachments } from "./composer-attachments.tsx";
import { chartImage, errorImage, uiImage } from "./composer-images.ts";
import type { AttachmentLimits } from "./composer-model.ts";
import { finishedTurn, liveTurn, longTranscript, question } from "./fixtures.ts";
import type { ComposerModelOption } from "./model-picker.tsx";
import { QuestionCard } from "./question-card.tsx";
import type { ThinkingLevel } from "./thinking-model.ts";
import { Transcript } from "./transcript.tsx";
import "./stories.css";

export default { title: "Session/Composer" } satisfies StoryDefault;

// Fixtures: a model catalogue as an organisation's configuration might give it, attachment limits, and drafts.

const anthropicLevels: ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
const openaiLevels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

const models: ComposerModelOption[] = [
	{
		id: "anthropic/claude-sonnet-4-5",
		label: "Claude Sonnet 4.5",
		provider: "Anthropic",
		description: "The default for coding work",
		capabilities: { images: true, thinking: anthropicLevels },
		default: true,
	},
	{
		id: "anthropic/claude-opus-4-1",
		label: "Claude Opus 4.1",
		provider: "Anthropic",
		description: "Slower, for the hardest problems",
		capabilities: { images: true, thinking: anthropicLevels },
	},
	{
		id: "anthropic/claude-haiku-4-5",
		label: "Claude Haiku 4.5",
		provider: "Anthropic",
		description: "Fast, for small edits",
		capabilities: { images: true, thinking: anthropicLevels },
	},
	{ id: "openai/gpt-5", label: "GPT-5", provider: "OpenAI", capabilities: { images: true, thinking: openaiLevels } },
	{
		id: "openai/gpt-5-mini",
		label: "GPT-5 mini",
		provider: "OpenAI",
		capabilities: { images: true, thinking: openaiLevels },
	},
	{
		id: "xai/grok-code-fast-1",
		label: "Grok Code Fast",
		provider: "xAI",
		description: "Text only",
		capabilities: { images: false },
	},
	{
		id: "google/gemini-2-5-pro",
		label: "Gemini 2.5 Pro",
		provider: "Google",
		disabledReason: "Not enabled for this project",
	},
];

/** Access levels as Harbour has them today: full access, with supervised listed for when the runtime can ask. */
const accessOptions: ComposerAccessOption[] = [
	{ id: "full-access", label: "Full access", description: "Runs commands and edits files without asking." },
	{
		id: "supervised",
		label: "Supervised",
		description: "Asks before commands and file changes.",
		disabledReason: "Not available yet: asks before commands and file changes.",
	},
];

const limits: AttachmentLimits = {
	maxFiles: 10,
	maxFileBytes: 20 * 1024 * 1024,
	maxImageBytes: 5 * 1024 * 1024,
};

const longDraft = `Before you open the PR, three things.

First, the retry path in src/billing/retry.ts still builds a new idempotency key when the first attempt timed out, which is exactly the case we are trying to fix. Reuse the key from the first attempt, and add a test that times out the first call and checks that Stripe sees the same key twice.

Second, the worker logs the full charge object on failure, which includes the customer's email. Log the invoice id and the charge id only.

Third, run the whole suite, not just billing: the invoices API shares the retry helper and its tests mock it in a way that may now break.

Then open the PR against main with a short description of the double charge, the fix and how you tested it, and ask Sam to review it.`;

const history = [
	"The billing worker charged two customers twice last night. Find out why and fix it.",
	"Now run the full suite and open a PR.",
];

const image = (id: string, name: string, previewUrl: string, extra: Partial<ComposerAttachment> = {}) =>
	({
		id,
		name,
		size: 184_320,
		type: "image/png",
		kind: "image",
		previewUrl,
		status: "ready",
		...extra,
	}) satisfies ComposerAttachment;

const file = (id: string, name: string, size: number, extra: Partial<ComposerAttachment> = {}) =>
	({ id, name, size, type: "application/pdf", kind: "file", status: "ready", ...extra }) satisfies ComposerAttachment;

const pasted = (id: string, name: string, size: number, extra: Partial<ComposerAttachment> = {}) =>
	({ id, name, size, type: "text/plain", kind: "text", status: "ready", ...extra }) satisfies ComposerAttachment;

/**
 * A pretend upload for the stories: about two seconds of progress, failing for a file whose name has "fail" in it.
 * Hosts pass their own; the library never uploads.
 */
async function pretendUpload(file: File, { progress, signal }: UploadContext): Promise<string> {
	for (let step = 1; step <= 10; step++) {
		await new Promise((resolve) => setTimeout(resolve, 180));
		// globalThis: this module's Error is the error story.
		if (signal.aborted) throw new globalThis.Error("Removed");
		if (step === 6 && file.name.includes("fail")) throw new globalThis.Error("The upload timed out.");
		progress(step / 10);
	}
	return `file_${file.name}`;
}

/** A list of what the composer sent, so the stories show that sending works. */
function Sent({ messages }: { messages: readonly string[] }) {
	if (messages.length === 0) return null;
	return (
		<p style={{ margin: 0, color: "var(--hb-text-muted)", fontSize: "var(--hb-text-xs)" }}>
			Sent: {messages.join(" / ")}
		</p>
	);
}

/** A composer wired as a host would: a model, uploads, history, sending. */
function Live({
	state = "idle",
	initialModel,
	...props
}: Partial<ComposerProps> & { state?: ComposerState; initialModel?: string }) {
	const [sent, setSent] = useState<string[]>([]);
	const [model, setModel] = useState(initialModel);
	const [thinking, setThinking] = useState<ThinkingLevel | undefined>(undefined);
	const uploads = useComposerAttachments(pretendUpload);
	const send = (text: string) => {
		const files = uploads.take();
		const parts = [text, ...files.map((entry) => `[${entry.attachment.name}]`)].filter(Boolean);
		setSent((all) => [...all, parts.join(" ")]);
	};
	return (
		<Column>
			<Composer
				state={state}
				onSend={send}
				models={models}
				model={model}
				onModelChange={setModel}
				thinking={thinking}
				defaultThinking="medium"
				onThinkingChange={setThinking}
				accessOptions={accessOptions}
				attachments={uploads.attachments}
				onAttach={uploads.attach}
				onRemoveAttachment={uploads.remove}
				onRetryAttachment={uploads.retry}
				attachmentLimits={limits}
				history={history}
				{...props}
			/>
			<Sent messages={sent} />
		</Column>
	);
}

/** Static props for the states the stories show still: no uploads run. */
const still = {
	onSend: () => {},
	models,
	onModelChange: () => {},
	defaultThinking: "medium",
	onThinkingChange: () => {},
	accessOptions,
	onAttach: () => {},
	onRemoveAttachment: () => {},
	onRetryAttachment: () => {},
	attachmentLimits: limits,
} satisfies Partial<ComposerProps>;

export const Default: Story = () => (
	<Sheet
		title="Composer"
		intro="Idle and empty, as T3 Code's: a glass surface, the model (its provider's mark, name and chevron), the thinking level (a brain) and the access level (a lock) on the left of the toolbar, the paperclip and Send on the right. Send is disabled until there is something to send. Type and press Enter; Up in the empty field recalls what you sent before; drop, paste or pick files to attach them (a file named with 'fail' fails to upload)."
	>
		<Live />
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet
		title="Composer, empty"
		intro="The placeholder says what the box is for. Hosts can make it say what to do next. Without models or onAttach there is no picker and no paperclip."
	>
		<Section title="Default placeholder">
			<Live />
		</Section>
		<Section title="Contextual placeholder">
			<Live placeholder="Answer the question above, or tell the agent something else" />
		</Section>
		<Section title="Bare: no model catalogue, no attachments">
			<Column>
				<Composer state="idle" onSend={() => {}} />
			</Column>
		</Section>
	</Sheet>
);

export const Focused: Story = () => (
	<Sheet
		title="Composer, focused"
		intro="Focus shows as a one-hairline accent edge on the whole surface, not a ring around the field."
	>
		<Live autoFocus defaultValue="Run the whole suite, not just billing, then open the PR." />
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet
		title="Composer, sending"
		intro="A message on its way: the primary action is a spinner and can't be pressed. The draft stays until the host takes it."
	>
		<Column>
			<Composer state="sending" defaultValue="Now run the full suite and open a PR." {...still} />
		</Column>
	</Sheet>
);

function StreamingDemo() {
	const [state, setState] = useState<ComposerState>("running");
	const [draft, setDraft] = useState("");
	const [log, setLog] = useState<string[]>([]);
	return (
		<Column>
			<Composer
				state={state}
				value={draft}
				onChange={setDraft}
				onSend={(text) => {
					setLog((all) => [...all, `sent "${text}"`]);
					setDraft("");
				}}
				onSteer={(text) => {
					setLog((all) => [...all, `steered with "${text}"`]);
					setDraft("");
				}}
				onStop={() => {
					setLog((all) => [...all, "stopped"]);
					setState("idle");
				}}
				placeholder="Steer the agent, or stop it"
				models={models}
				onModelChange={() => {}}
			/>
			<Row>
				<Button size="xs" onClick={() => setState("running")} disabled={state === "running"}>
					Start the agent again
				</Button>
			</Row>
			<Sent messages={log} />
		</Column>
	);
}

export const Streaming: Story = () => (
	<Sheet
		title="Composer, agent running"
		intro="While the agent works the button is a red Stop when the field is empty and Steer once you type. Stop returns it to idle."
	>
		<StreamingDemo />
		<Section title="Running, with a steer typed">
			<Column>
				<Composer state="running" defaultValue="Use the staging database instead." onStop={() => {}} {...still} />
			</Column>
		</Section>
	</Sheet>
);

// biome-ignore lint/suspicious/noShadowRestrictedNames: every component's error state is the story named Error.
export const Error: Story = () => (
	<Sheet
		title="Composer, error"
		intro="A failed send keeps the draft and says so in the tray on the composer's top edge. Files the host doesn't take are turned away with the reason, in the surface."
	>
		<Section title="Send failed">
			<Column>
				<Composer
					state="idle"
					defaultValue="Now run the full suite and open a PR."
					banner={<Notice level="error">Your message didn't send. Try again.</Notice>}
					{...still}
				/>
			</Column>
		</Section>
		<Section title="A file turned away (try attaching a large file)">
			<Live attachmentLimits={{ maxFileBytes: 1024, accept: [".txt", ".md", "image/*"] }} />
		</Section>
		<Section title="An image the chosen model can't read">
			<Column>
				<Composer
					state="idle"
					defaultValue="What's wrong in this trace?"
					attachments={[image("i1", "trace.png", errorImage)]}
					{...still}
					model="xai/grok-code-fast-1"
				/>
			</Column>
		</Section>
	</Sheet>
);

export const Disabled: Story = () => (
	<Sheet
		title="Composer, disabled"
		intro="A disabled composer says why, in the surface. With nothing typed it is one line: the reason and the action."
	>
		<Section title="Disabled, with a reason">
			<Column>
				<Composer
					state="disabled"
					disabledReason="Replaying a recorded session. Steering arrives with the live host."
					onSend={() => {}}
				/>
			</Column>
		</Section>
		<Section title="Disabled with a reason, keeping a draft">
			<Column>
				<Composer
					state="disabled"
					defaultValue="Now run the full suite and open a PR."
					disabledReason="Offline. Your draft is kept and sends when you reconnect."
					{...still}
				/>
			</Column>
		</Section>
	</Sheet>
);

export const LongContent: Story = () => (
	<Sheet
		title="Composer, long draft"
		intro="The field grows to about nine lines (200px) and then scrolls inside the surface; the toolbar stays put. Where the browser supports field-sizing, CSS sizes the field with no measuring."
	>
		<Live defaultValue={longDraft} />
	</Sheet>
);

/** Opens a picker once mounted, as a click on it would: the model's by default. */
function OpenPicker({ children, trigger = ".hb-model-trigger" }: { children: ReactNode; trigger?: string }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		frame.current?.querySelector<HTMLButtonElement>(trigger)?.click();
	}, [trigger]);
	return (
		<div ref={frame} className="hb-story-picker-frame">
			{children}
		</div>
	);
}

export const ModelPickerOpen: Story = () => (
	<Sheet
		title="Composer, model picker open"
		intro="The host's catalogue, grouped by provider, opening upward from the toolbar. Type to filter; Up and Down move, Enter chooses, Escape closes. A model the project hasn't enabled shows dimmed with the reason."
	>
		<OpenPicker>
			<Live />
		</OpenPicker>
	</Sheet>
);
ModelPickerOpen.storyName = "Model picker open";

export const ThinkingPickerOpen: Story = () => (
	<Sheet
		title="Composer, thinking picker open"
		intro="The thinking level reads on from the model's name, as T3 Code's does, and opens the levels the chosen model supports, with the session's default marked. A model that can't think has no thinking picker: choose Grok Code Fast to see it go. A level the new model lacks shows as its nearest one."
	>
		<OpenPicker trigger=".hb-thinking-trigger">
			<Live />
		</OpenPicker>
		<Section title="A model without thinking">
			<Column>
				<Composer state="idle" {...still} model="xai/grok-code-fast-1" />
			</Column>
		</Section>
		<Section title="A chosen level, on a model with different levels">
			<Column>
				<Composer state="idle" {...still} model="openai/gpt-5" thinking="max" />
			</Column>
		</Section>
	</Sheet>
);
ThinkingPickerOpen.storyName = "Thinking picker open";

export const AccessPickerOpen: Story = () => (
	<Sheet
		title="Composer, access picker open"
		intro="What the agent may do without asking, after T3 Code's permissions chip: the levels the host has, with what each means, the chosen one ticked. A level the host can't honour yet shows dimmed with its reason. Without onAttach, attachUnavailable shows the paperclip disabled, its title saying why."
	>
		<OpenPicker trigger=".hb-access-trigger">
			<Live />
		</OpenPicker>
		<Section title="Attaching not available yet">
			<Column>
				<Composer
					state="idle"
					{...still}
					onAttach={undefined}
					attachUnavailable="Attaching files isn't available yet"
				/>
			</Column>
		</Section>
	</Sheet>
);
AccessPickerOpen.storyName = "Access picker open";

export const WithAttachments: Story = () => (
	<Sheet
		title="Composer with attachments"
		intro="Images as thumbnails, files and pasted text as chips, each with its size and a remove button. A paste of 32 KB or 80 lines becomes pasted-text.txt rather than flooding the field; Ctrl+Shift+V pastes it inline."
	>
		<Column>
			<Composer
				state="idle"
				defaultValue="Here's the failing run and the chart from last night."
				attachments={[
					image("i1", "charges-per-hour.png", chartImage),
					image("i2", "stack-trace.png", errorImage),
					file("f1", "stripe-invoice-in_1Q2w3e.pdf", 412_000),
					pasted("p1", "pasted-text.txt", 39_200),
				]}
				{...still}
			/>
		</Column>
	</Sheet>
);

export const Uploading: Story = () => (
	<Sheet
		title="Composer, uploading"
		intro="The host reports progress; without a fraction the item shows a spinner. Send waits until every upload is done."
	>
		<Column>
			<Composer
				state="idle"
				defaultValue="Check these against the invoice."
				attachments={[
					image("i1", "charges-per-hour.png", chartImage, { status: "uploading", progress: 0.4 }),
					image("i2", "checkout-page.png", uiImage, { status: "uploading" }),
					file("f1", "stripe-export-october.csv", 8_400_000, {
						type: "text/csv",
						status: "uploading",
						progress: 0.72,
					}),
				]}
				{...still}
			/>
		</Column>
	</Sheet>
);

export const UploadFailed: Story = () => (
	<Sheet
		title="Composer, upload failed"
		intro="A failed upload turns red with the host's reason in its tooltip, and offers Retry and Remove. Send waits until it is retried or removed."
	>
		<Column>
			<Composer
				state="idle"
				defaultValue="Here's the failing run."
				attachments={[
					image("i1", "stack-trace.png", errorImage, { status: "failed", error: "The upload timed out." }),
					file("f1", "worker.log", 2_100_000, {
						type: "text/plain",
						status: "failed",
						error: "The file server refused it.",
					}),
					pasted("p1", "pasted-text.txt", 39_200),
				]}
				{...still}
			/>
		</Column>
	</Sheet>
);

/** Starts a file drag over the element once mounted, as dragging a file from the desktop would. */
function DragOver({ children, selector }: { children: ReactNode; selector: string }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const target = frame.current?.querySelector(selector);
		if (!target || typeof DataTransfer === "undefined") return;
		const transfer = new DataTransfer();
		transfer.items.add(new File(["x"], "screenshot.png", { type: "image/png" }));
		target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
	}, [selector]);
	return <div ref={frame}>{children}</div>;
}

export const DragOverStory: Story = () => (
	<Sheet
		title="Composer, files dragged over"
		intro="Dragging files over the composer outlines it and says where they go, with the limits. Docked in a transcript, the whole transcript takes the drop."
	>
		<Section title="On its own">
			<DragOver selector=".hb-composer-surface">
				<Live />
			</DragOver>
		</Section>
		<Section title="Docked in a transcript">
			<DragOver selector=".hb-transcript">
				<div className="hb-story-transcript-frame">
					<Transcript items={finishedTurn} dock={<Live />} />
				</div>
			</DragOver>
		</Section>
	</Sheet>
);
DragOverStory.storyName = "Drag over";

function WithQuestionDemo() {
	const [card, setCard] = useState<QuestionCardData>(question());
	const [sent, setSent] = useState<string[]>([]);
	return (
		<Column>
			<Composer
				{...still}
				state="idle"
				onSend={(text) => setSent((all) => [...all, text])}
				placeholder="Answer the question above, or tell the agent something else"
				banner={<QuestionCard card={card} onAnswer={(answer) => setCard({ ...card, status: "answered", answer })} />}
			/>
			<Row>
				<Button size="xs" onClick={() => setCard(question())} disabled={card.status === "open"}>
					Ask again
				</Button>
			</Row>
			<Sent messages={sent} />
		</Column>
	);
}

export const WithQuestion: Story = () => (
	<Sheet
		title="Composer with a question"
		intro="Questions dock on the composer's top edge in a tray that shares its glass, as T3 Code's pending questions do, instead of opening a modal. Digits 1 to 3 pick an option while focus is in the card. The composer never rests while one is open."
	>
		<WithQuestionDemo />
	</Sheet>
);

// Docked in a transcript: the scroll behaviour.

// Running calls are re-based on the real clock, so their elapsed time reads as seconds.
const rebase = (items: readonly TranscriptItem[]): TranscriptItem[] =>
	items.map((item) =>
		item.kind === "tool" && item.status === "running" ? { ...item, at: Date.now() - 30_000 } : item,
	);

const session: TranscriptItem[] = [...longTranscript(12), ...finishedTurn, ...rebase(liveTurn)];

/** Scrolls the transcript back once mounted, with the wheel, as a reader would. */
function ScrolledBack({ children }: { children: ReactNode }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Once the list has settled at its end (the virtualiser measures its rows over a few frames), scroll back.
		let timer: ReturnType<typeof setTimeout>;
		let lastHeight = 0;
		let steady = 0;
		const attempt = (tries: number) => {
			const viewport = frame.current?.querySelector(".hb-transcript-list");
			const atEnd =
				viewport instanceof HTMLElement &&
				viewport.scrollTop > 0 &&
				viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 2;
			steady = atEnd && viewport.scrollHeight === lastHeight ? Math.max(steady, 0) + 1 : 0;
			lastHeight = viewport instanceof HTMLElement ? viewport.scrollHeight : 0;
			if (!(viewport instanceof HTMLElement) || steady < 3) {
				if (tries > 0) timer = setTimeout(() => attempt(tries - 1), 25);
				return;
			}
			for (let step = 0; step < 3; step++) {
				viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
			}
			viewport.scrollTop -= 900;
			// The virtualiser may still be finishing its first jump to the end, which undoes the scroll; scroll again.
			timer = setTimeout(() => {
				if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 2 && tries > 0) {
					steady = 3;
					attempt(tries - 1);
				}
			}, 60);
		};
		timer = setTimeout(() => attempt(60), 25);
		return () => clearTimeout(timer);
	}, []);
	return <div ref={frame}>{children}</div>;
}

function DockedDemo({ state = "running" }: { state?: ComposerState }) {
	return (
		<div className="hb-story-transcript-frame hb-story-transcript-frame-tall">
			<Transcript items={session} dock={<Live state={state} onStop={() => {}} captureTyping />} />
		</div>
	);
}

export const Docked: Story = () => (
	<Sheet
		title="Composer docked in a transcript"
		intro="As in T3 Code, the composer floats over the transcript's foot and the list scrolls under its glass. Scroll back and it rests, folding to one line with the model in a strip underneath; focus it, or return to the end, and it comes back. Typing anywhere outside a field goes into it."
	>
		<DockedDemo />
	</Sheet>
);

export const Resting: Story = () => (
	<Sheet
		title="Composer resting"
		intro="Scrolled back: one 50px line, the paperclip and the action on the right, the model in a strip tucked under the glass. The end of the list keeps the room the expanded composer needs, so nothing moves when it folds."
	>
		<ScrolledBack>
			<DockedDemo state="idle" />
		</ScrolledBack>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet
		title="Composer at 420px"
		intro="On a phone the composer rests whenever it isn't in use, as T3 Code's does: one line and the action, with the model underneath. Tap it to expand. On a touch screen the type is 16px, the button 36px and Enter is a new line."
	>
		<Section title="Docked, at rest">
			<div className="hb-story-transcript-frame">
				<Transcript items={[...finishedTurn, ...rebase(liveTurn)]} dock={<Live state="running" onStop={() => {}} />} />
			</div>
		</Section>
		<Section title="Expanded, with attachments">
			<Column>
				<Composer
					state="idle"
					resting={false}
					defaultValue="Here's the failing run."
					attachments={[image("i1", "stack-trace.png", errorImage), pasted("p1", "pasted-text.txt", 39_200)]}
					{...still}
				/>
			</Column>
		</Section>
		<Section title="Long draft">
			<Live defaultValue={longDraft} />
		</Section>
		<Section title="With a question">
			<WithQuestionDemo />
		</Section>
	</Sheet>
);
Mobile.meta = { width: 420 };
