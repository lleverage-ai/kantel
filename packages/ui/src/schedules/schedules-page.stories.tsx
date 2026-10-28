import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import {
	createSchedulesScenario,
	directory,
	FIXTURE_NOW,
	type FixtureName,
	failingSource,
	pendingSource,
	type SchedulesScenario,
	slowSource,
} from "./fixtures.ts";
import type { StatusFilter } from "./schedules-model.ts";
import { SchedulesPage } from "./schedules-page.tsx";
import "./stories.css";

export default { title: "Schedules/Schedules page" } satisfies StoryDefault;

// Each story builds its own in-memory store and plays three days of the scheduler into it, so the list, the next
// runs, the history and pause and resume all run against the store's real calls.

function ScenarioPage({
	open,
	filter,
	empty,
	slow,
}: {
	open?: FixtureName;
	filter?: StatusFilter;
	empty?: boolean;
	slow?: number;
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
		<div className="schedules-story">
			<SchedulesPage
				key={scenario === undefined ? "pending" : "ready"}
				source={source}
				directory={directory}
				now={FIXTURE_NOW}
				{...(open === undefined || scenario === undefined ? {} : { initialSelected: scenario.ids[open] })}
				{...(filter === undefined ? {} : { initialFilter: filter })}
			/>
		</div>
	);
}

/** The active schedules, none open. */
export const Default: Story = () => <ScenarioPage />;

/** The definition of done's view: the disk check with its next runs, the findings it raised and its history. */
export const CheckWithFindings: Story = () => <ScenarioPage open="disk" />;

/** A weekday summary: next runs in Europe/London, across the end of summer time. */
export const WeekdaySummary: Story = () => <ScenarioPage open="brief" />;

/** A monthly task with no runs yet, its payload as JSON. */
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
	<div className="schedules-story">
		<SchedulesPage source={pendingSource} directory={directory} now={FIXTURE_NOW} />
	</div>
);

/** The detail while its reads are slow. */
export const DetailLoading: Story = () => <ScenarioPage open="disk" slow={60_000} />;

export const Empty: Story = () => <ScenarioPage empty />;

export const LoadError: Story = () => (
	<div className="schedules-story">
		<SchedulesPage source={failingSource} directory={directory} now={FIXTURE_NOW} />
	</div>
);

/** On a phone the open schedule replaces the list, with a way back. */
export const Mobile: Story = () => <ScenarioPage open="disk" />;
Mobile.meta = { width: 420 };

export const MobileList: Story = () => <ScenarioPage />;
MobileList.meta = { width: 420 };
