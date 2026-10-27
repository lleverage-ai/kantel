import type { QuestionCard as QuestionCardData } from "@harbour/protocol";
import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Row, Section, Sheet } from "../workbench/specimen.tsx";
import { Composer, ComposerSendHint, type ComposerState } from "./composer.tsx";
import { question } from "./fixtures.ts";
import { QuestionCard } from "./question-card.tsx";

export default { title: "Session/Composer" } satisfies StoryDefault;

const longDraft = `Before you open the PR, three things.

First, the retry path in src/billing/retry.ts still builds a new idempotency key when the first attempt timed out, which is exactly the case we are trying to fix. Reuse the key from the first attempt, and add a test that times out the first call and checks that Stripe sees the same key twice.

Second, the worker logs the full charge object on failure, which includes the customer's email. Log the invoice id and the charge id only.

Third, run the whole suite, not just billing: the invoices API shares the retry helper and its tests mock it in a way that may now break.

Then open the PR against main with a short description of the double charge, the fix and how you tested it, and ask Sam to review it.`;

/** A list of what the composer sent, so the stories show that sending works. */
function Sent({ messages }: { messages: readonly string[] }) {
	if (messages.length === 0) return null;
	return (
		<p style={{ margin: 0, color: "var(--hb-text-muted)", fontSize: "var(--hb-text-xs)" }}>
			Sent: {messages.join(" / ")}
		</p>
	);
}

function Interactive({
	state = "idle",
	defaultValue,
	placeholder,
}: {
	state?: ComposerState;
	defaultValue?: string;
	placeholder?: string;
}) {
	const [sent, setSent] = useState<string[]>([]);
	return (
		<Column>
			<Composer
				state={state}
				defaultValue={defaultValue}
				placeholder={placeholder}
				onSend={(text) => setSent((all) => [...all, text])}
				footer={<ComposerSendHint />}
			/>
			<Sent messages={sent} />
		</Column>
	);
}

export const Default: Story = () => (
	<Sheet
		title="Composer"
		intro="Idle and empty: Send is disabled until there is something to send. Type and press Enter."
	>
		<Interactive />
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet
		title="Composer, sending"
		intro="A message on its way: the primary action is a spinner and can't be pressed. The draft stays until the host takes it."
	>
		<Column>
			<Composer
				state="sending"
				defaultValue="Now run the full suite and open a PR."
				onSend={() => {}}
				footer={<ComposerSendHint />}
			/>
		</Column>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet
		title="Composer, empty"
		intro="The placeholder says what the box is for. Hosts can make it say what to do next."
	>
		<Section title="Default placeholder">
			<Interactive />
		</Section>
		<Section title="Contextual placeholder">
			<Interactive placeholder="Answer the question above, or tell the agent something else" />
		</Section>
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
				footer={<ComposerSendHint />}
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
		intro="While the agent works the button is Stop when the field is empty and Steer once you type. Stop returns it to idle."
	>
		<StreamingDemo />
	</Sheet>
);

// biome-ignore lint/suspicious/noShadowRestrictedNames: every component's error state is the story named Error.
export const Error: Story = () => (
	<Sheet
		title="Composer, error and disabled"
		intro="A failed send keeps the draft and says so in the banner. A disabled composer says why, in the surface."
	>
		<Section title="Send failed">
			<Column>
				<Composer
					state="idle"
					defaultValue="Now run the full suite and open a PR."
					onSend={() => {}}
					banner={<Notice level="error">Your message didn't send. Try again.</Notice>}
					footer={<ComposerSendHint />}
				/>
			</Column>
		</Section>
		<Section title="Disabled, with a reason">
			<Column>
				<Composer
					state="disabled"
					disabledReason="Replaying a recorded session. Steering arrives with the live host."
					onSend={() => {}}
					banner={<Notice level="error">Your message didn't send. Try again.</Notice>}
				/>
			</Column>
		</Section>
		<Section title="Disabled with a reason, keeping a draft">
			<Column>
				<Composer
					state="disabled"
					defaultValue="Now run the full suite and open a PR."
					disabledReason="Offline. Your draft is kept and sends when you reconnect."
					onSend={() => {}}
				/>
			</Column>
		</Section>
	</Sheet>
);

export const LongContent: Story = () => (
	<Sheet
		title="Composer, long draft"
		intro="The field grows to about 208px and then scrolls inside the surface; the button stays put."
	>
		<Interactive defaultValue={longDraft} />
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet
		title="Composer at 420px"
		intro="On a touch screen the type is 16px, the button is 36px, Enter is a new line and the Enter hint is hidden."
	>
		<Section title="Idle">
			<Interactive />
		</Section>
		<Section title="Agent running">
			<StreamingDemo />
		</Section>
		<Section title="Long draft">
			<Interactive defaultValue={longDraft} />
		</Section>
	</Sheet>
);
Mobile.meta = { width: 420 };

function WithQuestionDemo() {
	const [card, setCard] = useState<QuestionCardData>(question());
	const [sent, setSent] = useState<string[]>([]);
	return (
		<Column>
			<Composer
				state="idle"
				onSend={(text) => setSent((all) => [...all, text])}
				placeholder="Answer the question above, or tell the agent something else"
				banner={<QuestionCard card={card} onAnswer={(answer) => setCard({ ...card, status: "answered", answer })} />}
				footer={<ComposerSendHint />}
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
		intro="Questions attach above the composer instead of opening a modal. Digits 1 to 3 pick an option while focus is in the card."
	>
		<WithQuestionDemo />
	</Sheet>
);
