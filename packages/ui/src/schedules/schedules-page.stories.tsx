import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import {
	createSchedulesScenario,
	directory,
	FIXTURE_AGENTS,
	FIXTURE_NOW,
	FIXTURE_OWNER,
	type FixtureName,
	failingSource,
	pendingSource,
	type SchedulesScenario,
	slowSource,
} from "./fixtures.ts";
import type { StatusFilter } from "./schedules-model.ts";
import { type ScheduleFormSettings, type ScheduleLinks, SchedulesPage } from "./schedules-page.tsx";

/** Story-only frame: as wide as the console gives the page beside its sidebar. */
const frame = "max-w-[calc(var(--hb-content-width)+var(--hb-sidebar-width)+var(--hb-step-12))]";

export default { title: "Schedules/Schedules page" } satisfies StoryDefault;

// Each story builds its own in-memory store and plays three days of the scheduler into it, so the list, the next
// runs, the history and pause and resume all run against the store's real calls.

// In the workbench a run's session link goes to a hash, as there is no session view to open.
const links: ScheduleLinks = { session: (sessionId) => `#session=${encodeURIComponent(sessionId)}` };
const form: ScheduleFormSettings = { agents: FIXTURE_AGENTS, owner: FIXTURE_OWNER, timezone: "Europe/London" };

function ScenarioPage({
	open,
	filter,
	empty,
	slow,
	readOnly,
	creating,
}: {
	open?: FixtureName;
	filter?: StatusFilter;
	empty?: boolean;
	slow?: number;
	/** No form: the page reads and pauses only. */
	readOnly?: boolean;
	/** Open with the form for a new schedule. */
	creating?: boolean;
}) {
	const [scenario, setScenario] = useState<SchedulesScenario>();
	useEffect(() => {
		let live = true;
		void createSchedulesScenario(empty === true ? { empty } : {}).then((made) => {
			if (live) setScenario(made);
		});
		return () => {
			live = false;
		};
	}, [empty]);
	const source =
		scenario === undefined ? pendingSource : slow === undefined ? scenario.source : slowSource(scenario.source, slow);
	return (
		<div className={frame}>
			<SchedulesPage
				key={scenario === undefined ? "pending" : "ready"}
				source={source}
				directory={directory}
				now={FIXTURE_NOW}
				links={links}
				{...(readOnly === true ? {} : { form })}
				{...(creating === true ? { initialNew: true } : {})}
				{...(open === undefined || scenario === undefined ? {} : { initialSelected: scenario.ids[open] })}
				{...(filter === undefined ? {} : { initialFilter: filter })}
			/>
		</div>
	);
}

/** The active schedules, none open. */
export const Default: Story = () => <ScenarioPage />;

/**
 * "Every 10 minutes, ask Triage": a task's prompt and agent, and its run history, each run linking to the session it
 * started.
 */
export const TaskRunsWithSessions: Story = () => <ScenarioPage open="triage" />;
TaskRunsWithSessions.storyName = "Task runs, with their sessions";

/** New schedule: the form in the detail pane, beside the list it adds to. */
export const NewSchedule: Story = () => <ScenarioPage creating />;

/** A host that gives no form: no New schedule, no Edit; pause and resume still work. */
export const ReadOnly: Story = () => <ScenarioPage open="triage" readOnly />;
ReadOnly.storyName = "Read only";

/** The definition of done's view: the disk check with its next runs, the findings it raised and its history. */
export const CheckWithFindings: Story = () => <ScenarioPage open="disk" />;

/** A weekday summary: next runs in Europe/London, across the end of summer time. */
export const WeekdaySummary: Story = () => <ScenarioPage open="brief" />;

/** A monthly task with no runs yet, naming no agent, so the default one is asked. */
export const NoRunsYet: Story = () => <ScenarioPage open="invoices" />;

/** A one-off reminder, due in two days. */
export const OneOffReminder: Story = () => <ScenarioPage open="accountant" />;

/** The heartbeat: a run in flight, and runs coalesced after a two-hour runner outage. */
export const HeartbeatRunning: Story = () => <ScenarioPage open="heartbeat" />;

/** A paused program: no next runs, with Resume. */
export const Paused: Story = () => <ScenarioPage open="backfill" filter="paused" />;

/** A task that ended after its two runs, one of which failed. */
export const Ended: Story = () => <ScenarioPage open="export" filter="ended" />;

/** Every schedule, whatever its status. */
export const All: Story = () => <ScenarioPage filter="all" />;

export const Loading: Story = () => (
	<div className={frame}>
		<SchedulesPage source={pendingSource} directory={directory} now={FIXTURE_NOW} />
	</div>
);

/** The detail while its reads are slow. */
export const DetailLoading: Story = () => <ScenarioPage open="disk" slow={60_000} />;

export const Empty: Story = () => <ScenarioPage empty />;

export const LoadError: Story = () => (
	<div className={frame}>
		<SchedulesPage source={failingSource} directory={directory} now={FIXTURE_NOW} />
	</div>
);

/** On a phone the open schedule replaces the list, with a way back. */
export const Mobile: Story = () => <ScenarioPage open="disk" />;
Mobile.meta = { width: 420 };

export const MobileList: Story = () => <ScenarioPage />;
MobileList.meta = { width: 420 };

export const MobileNewSchedule: Story = () => <ScenarioPage creating />;
MobileNewSchedule.storyName = "Mobile new schedule";
MobileNewSchedule.meta = { width: 420 };
