import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { assistant, FIXTURE_NOW, finishedTurn, liveTurn, user } from "./fixtures.ts";
import { AssistantMessage, UserMessage } from "./message.tsx";
import {
	type MessageActionHandlers,
	MessageActions,
	MessageActionsContext,
	MessageEditor,
} from "./message-actions.tsx";
import { transcriptFrame } from "./story-frames.ts";
import { Transcript } from "./transcript.tsx";

export default { title: "Session/Message actions" } satisfies StoryDefault;

const DAY = 24 * 60 * 60 * 1000;

const asked = user("ma-u1", "The billing worker charged two customers twice last night. Find out why and fix it.", 420);
const answered = assistant(
	"ma-a1",
	"The retry in `retry.ts` charged again without an idempotency key. I added one, so a retry now reuses the first charge.",
	{ secondsAgo: 300 },
);

/** Both lines shown, as on hover: under the person's bubble and under the agent's final answer. */
export const Shown: Story = () => (
	<Sheet
		title="Message actions"
		intro="On hover or focus, a person's message shows when it was sent and Copy; the agent's final answer shows Copy and when it was generated. Shown here without a hover."
	>
		<Section title="A person's message">
			<Column>
				<UserMessage item={asked} showActions />
			</Column>
		</Section>
		<Section title="The agent's final answer">
			<Column>
				<AssistantMessage item={answered} actions showActions />
			</Column>
		</Section>
	</Sheet>
);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A host that can branch: Fork takes a moment, Edit from here sends after one. */
const branching: MessageActionHandlers = {
	fork: () => wait(800),
	edit: () => wait(800),
};

/** With a host that can branch: Edit from here under the person's message, Fork from this response under the answer. */
export const WithBranching: Story = () => (
	<Sheet
		title="Edit from here and Fork"
		intro="With a host that can branch a session, the person's message has Edit from here, and the agent's final answer has Fork from this response. While a run is going, Edit from here is off and says why."
	>
		<MessageActionsContext.Provider value={branching}>
			<Section title="A person's message">
				<Column>
					<UserMessage item={asked} showActions />
				</Column>
			</Section>
			<Section title="The agent's final answer">
				<Column>
					<AssistantMessage item={answered} actions showActions />
				</Column>
			</Section>
		</MessageActionsContext.Provider>
		<MessageActionsContext.Provider value={{ ...branching, editBlocked: "Stop the run to edit a message" }}>
			<Section title="While a run is going">
				<Column>
					<UserMessage item={asked} showActions />
				</Column>
			</Section>
		</MessageActionsContext.Provider>
		<MessageActionsContext.Provider
			value={{
				fork: () => wait(300).then(() => Promise.reject(new Error("You can't start a session in this project"))),
			}}
		>
			<Section title="A fork the host refused">
				<Column>
					<AssistantMessage item={answered} actions showActions />
				</Column>
			</Section>
		</MessageActionsContext.Provider>
	</Sheet>
);

/** Edit from here, open: the bubble becomes a field with Cancel and Send. */
export const Editing: Story = () => (
	<Sheet
		title="Editing a message"
		intro="Edit from here turns the message into a field. Enter sends and reruns the session from this message; Shift+Enter starts a new line; Escape cancels."
	>
		<Section title="Open">
			<Column>
				<div className="kt-user-message">
					<MessageEditor text={asked.text} onSend={() => wait(800)} onCancel={() => {}} />
				</div>
			</Column>
		</Section>
		<Section title="Refused">
			<Column>
				<div className="kt-user-message">
					<MessageEditor
						text={asked.text}
						onSend={() => Promise.reject(new Error("Stop the run before editing a message"))}
						onCancel={() => {}}
						autoFocus={false}
					/>
				</div>
			</Column>
		</Section>
	</Sheet>
);

/** In a transcript with a host that can branch: hover a message for its actions; Edit from here opens in place. */
export const BranchingInTranscript: Story = () => (
	<Sheet
		title="Branching in a transcript"
		intro="Hover the person's message for Edit from here, or the final answer for Fork from this response."
	>
		<div className={transcriptFrame}>
			<Transcript items={finishedTurn} messageActions={branching} />
		</div>
	</Sheet>
);

/** Hidden until hovered: the line keeps its room, so the transcript never moves when it appears. */
export const InTranscript: Story = () => (
	<Sheet
		title="Message actions in a transcript"
		intro="Hover a message to see its time and Copy. Only a turn's final answer has them, not the words between tool calls, and not an answer still streaming."
	>
		<div className={transcriptFrame}>
			<Transcript items={[...finishedTurn, ...liveTurn]} />
		</div>
	</Sheet>
);

/** Times from earlier days read as the tool calls' do: "Yesterday at 16:38", then the date. */
export const OlderTimes: Story = () => (
	<Sheet title="Older messages" intro="A message from yesterday, and one from last week, by the clock.">
		<Column>
			<MessageActions at={FIXTURE_NOW - DAY} text="Yesterday's message" align="end" visible now={FIXTURE_NOW} />
			<MessageActions at={FIXTURE_NOW - 6 * DAY} text="Last week's answer" align="start" visible now={FIXTURE_NOW} />
		</Column>
	</Sheet>
);

/** A long message: the line stays one row under it, at the bubble's right edge. */
export const LongMessage: Story = () => (
	<Sheet title="Long message" intro="A long prompt and a long answer; the line stays under each, on one row.">
		<Column>
			<UserMessage
				item={user(
					"ma-u2",
					"Go through every tenant's invoices from last night, find each one charged more than once, refund the extra charges through the billing API, and write up what happened for the billing channel with the tenant names, the amounts and the time of each refund.",
				)}
				showActions
			/>
			<AssistantMessage
				item={assistant(
					"ma-a2",
					"I found 14 invoices charged twice across 9 tenants, refunded the second charge on each (1,284.50 EUR in total), and posted the write-up to the billing channel with every tenant, amount and refund time.\n\nThe cause was the retry in the billing worker: it charged again without an idempotency key after a timeout that had in fact succeeded.",
				)}
				actions
				showActions
			/>
		</Column>
	</Sheet>
);

/** While an answer streams it has no actions: there is nothing finished to copy yet. */
export const Streaming: Story = () => (
	<Sheet title="Streaming answer" intro="No actions while the answer is still arriving.">
		<Column>
			<AssistantMessage
				item={assistant("ma-a3", "The typecheck is clean. Running the full test suite now", { streaming: true })}
				actions
				showActions
			/>
		</Column>
	</Sheet>
);
