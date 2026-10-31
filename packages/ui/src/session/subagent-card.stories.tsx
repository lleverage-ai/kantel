import type { TranscriptItem } from "@kantel/protocol";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { assistant, tool, user } from "./fixtures.ts";
import { transcriptFrame } from "./story-frames.ts";
import { SubagentCard } from "./subagent-card.tsx";
import { subagentOf, subagentStatus } from "./subagent-model.ts";
import { Transcript } from "./transcript.tsx";

export default { title: "Session/Subagent card" } satisfies StoryDefault;

const task =
	"Read the refund path in billing/refund.ts and its tests in billing/refund.test.ts, then list each case the tests miss, with the line it would cover.";
const answer =
	"The tests miss three cases: a refund larger than the charge (refund.ts:41), a refund on a charge that was already partly refunded (refund.ts:58), and a currency mismatch between the charge and the refund (refund.ts:73). Each needs one test; I'd add them beside the existing partial-refund test.";
const started = Date.now() - 72_000;

export const States: Story = () => (
	<Sheet
		title="Subagent card"
		intro="A task the agent handed to a session of its own: a bot avatar with the status on its corner and a Subagent tag, so it reads as a subagent at a glance. Working: a pulsing dot, a live timer and what it is doing now, or its task until it starts, and a Stop when the host can stop it. Done: the opening of its answer and how long it took. The whole card opens the subagent's session; Stop stops just the subagent and its own."
	>
		<Section title="Working, just started">
			<Column>
				<SubagentCard
					title="Find the untested refund cases"
					task={task}
					status="running"
					startedAt={started}
					href="#s"
				/>
			</Column>
		</Section>
		<Section title="Working, with what it's doing now">
			<Column>
				<SubagentCard
					title="Find the untested refund cases"
					task={task}
					activity="Reading billing/refund.test.ts"
					status="running"
					startedAt={started}
					href="#s"
				/>
			</Column>
		</Section>
		<Section title="Working, waiting on a subagent of its own">
			<Column>
				<SubagentCard
					title="Audit the refund path"
					task="Audit the refund path, handing the partial refunds to a subagent of your own."
					activity="Waiting on its subagent: Check the partial refunds"
					status="running"
					startedAt={started}
					href="#s"
				/>
			</Column>
		</Section>
		<Section title="Working, with Stop">
			<Column>
				<SubagentCard
					title="Audit the refund path"
					task="Audit the refund path, handing the partial refunds to a subagent of your own."
					activity="Waiting on its subagent: Check the partial refunds"
					status="running"
					startedAt={started}
					href="#s"
					onStop={() => {}}
				/>
			</Column>
		</Section>
		<Section title="Stopping">
			<Column>
				<SubagentCard
					title="Audit the refund path"
					task="Audit the refund path, handing the partial refunds to a subagent of your own."
					activity="Waiting on its subagent: Check the partial refunds"
					status="running"
					startedAt={started}
					href="#s"
					onStop={() => {}}
					stopping
				/>
			</Column>
		</Section>
		<Section title="Done">
			<Column>
				<SubagentCard
					title="Find the untested refund cases"
					task={task}
					summary={answer}
					status="done"
					startedAt={started}
					endedAt={started + 94_000}
					href="#s"
				/>
			</Column>
		</Section>
		<Section title="Failed">
			<Column>
				<SubagentCard
					title="Run the billing migration dry run"
					task="Run pnpm migrate --dry-run against billing-staging and report what it would change."
					summary="The subagent failed: the model request was refused"
					status="error"
					startedAt={started}
					endedAt={started + 8_000}
					href="#s"
				/>
			</Column>
		</Section>
		<Section title="Stopped">
			<Column>
				<SubagentCard
					title="Summarise last week's incidents"
					task="Summarise last week's incidents from the incident channel export in notes/incidents.md."
					status="interrupted"
					startedAt={started}
					endedAt={started + 21_000}
					href="#s"
				/>
			</Column>
		</Section>
		<Section title="Not yet openable">
			<Column>
				<SubagentCard title="Find the untested refund cases" task={task} status="running" startedAt={started} />
			</Column>
		</Section>
	</Sheet>
);

export const LongContent: Story = () => (
	<Sheet
		title="Subagent card, long content"
		intro="The title and the detail keep one line each and end in an ellipsis. The avatar, the tag, the status and the chevron never move."
	>
		<Section title="Long everything">
			<Column>
				<SubagentCard
					title="Go through every migration in the billing service since January and check each one has a down migration that actually restores the previous schema"
					task={task.repeat(4)}
					summary={answer.repeat(3)}
					status="done"
					startedAt={started}
					endedAt={started + 3_725_000}
					href="#s"
				/>
			</Column>
		</Section>
	</Sheet>
);

const subagentCall = (id: string, status: "running" | "done", output?: string) => ({
	...tool(id, "subagent", "subagent", {
		status,
		args: { task, title: "Find the untested refund cases" },
		...(output === undefined ? {} : { output }),
		seconds: 94,
	}),
	...(status === "running" ? { at: Date.now() - 41_000 } : {}),
});

const thread: TranscriptItem[] = [
	user("u1", "Are the refund tests complete? Use a subagent to check."),
	assistant("a1", "I'll hand the check to a subagent so it can read the whole refund path."),
	subagentCall("s1", "done", answer),
	assistant("a2", "Three cases are missing. Want me to add the tests?"),
	user("u2", "Yes, and check the partial refunds too."),
	subagentCall("s2", "running"),
];

export const InTheThread: Story = () => (
	<Sheet
		title="Subagent cards in the thread"
		intro="Each subagent call is a card of its own between the messages, not a line in a group of tool calls, and opens the subagent's session (renderSubagent gives it the link)."
	>
		<div className={transcriptFrame}>
			<Transcript
				items={thread}
				renderSubagent={(item) => (
					<SubagentCard
						{...subagentOf(item)}
						status={subagentStatus(item)}
						startedAt={item.at}
						endedAt={item.endedAt}
						{...(item.status === "running" ? { activity: "Reading billing/refund.test.ts", onStop: () => {} } : {})}
						href={`#${item.callId}`}
					/>
				)}
				working={{ since: Date.now() - 45_000 }}
			/>
		</div>
	</Sheet>
);
