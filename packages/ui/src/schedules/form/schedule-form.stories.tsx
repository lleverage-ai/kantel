import { HarbourError, type Schedule } from "@harbour/contracts";
import { type ComponentProps, useEffect, useState } from "react";
import { Notice } from "../../primitives/surface.tsx";
import type { Story, StoryDefault } from "../../workbench/ladle.ts";
import {
	createFixtureScheduleWrites,
	FIXTURE_AGENTS,
	FIXTURE_NOW,
	FIXTURE_OWNER,
	type FixtureScheduleWrites,
} from "./fixtures.ts";
import { ScheduleForm } from "./schedule-form.tsx";
import type { ScheduleWrites } from "./schedule-writes.ts";
import "./stories.css";

export default { title: "Schedules/Form" } satisfies StoryDefault;

type FormProps = Omit<ComponentProps<typeof ScheduleForm>, "writes" | "agents" | "owner" | "schedule" | "now">;

/**
 * The form on the fixtures: an in-memory store at a fixed time, so the preview reads the same in every screenshot.
 * `edit` opens one of the fixture schedules by index; `wrap` changes the store's calls, to show a refusal.
 */
function FormStory({
	edit,
	wrap,
	delayMs = 400,
	...props
}: FormProps & { edit?: number; wrap?: (writes: ScheduleWrites) => ScheduleWrites; delayMs?: number }) {
	const [ready, setReady] = useState<{ writes: ScheduleWrites; schedules: readonly Schedule[] }>();
	const [saved, setSaved] = useState<{ schedule: Schedule; how: "saved" | "ended" }>();
	const [key, setKey] = useState(0);
	useEffect(() => {
		let live = true;
		void createFixtureScheduleWrites({ delayMs }).then(({ writes, schedules }) => {
			if (live) setReady({ writes: wrap === undefined ? writes : wrap(writes as FixtureScheduleWrites), schedules });
		});
		return () => {
			live = false;
		};
	}, [wrap, delayMs]);
	if (ready === undefined) return null;
	const schedule = edit === undefined ? undefined : ready.schedules[edit];
	return (
		<div className="hb-story-schedule-form">
			{saved === undefined ? null : (
				<Notice level="info">
					{saved.how === "ended" ? "Ended" : "Saved"} {saved.schedule.title}.{" "}
					<button type="button" className="hb-story-schedule-again hb-focusable" onClick={() => setSaved(undefined)}>
						Start again
					</button>
					<pre className="hb-story-schedule-json">
						{JSON.stringify(
							{
								kind: saved.schedule.kind,
								status: saved.schedule.status,
								timezone: saved.schedule.timezone,
								repeat: saved.schedule.repeat,
								at: saved.schedule.at,
								count: saved.schedule.count,
								payload: saved.schedule.payload,
								check: saved.schedule.check,
							},
							null,
							2,
						)}
					</pre>
				</Notice>
			)}
			{saved === undefined ? (
				<ScheduleForm
					key={key}
					writes={ready.writes}
					agents={FIXTURE_AGENTS}
					owner={FIXTURE_OWNER}
					timezone="Europe/London"
					now={() => FIXTURE_NOW}
					{...(schedule === undefined ? {} : { schedule })}
					onSaved={(next) => {
						setSaved({ schedule: next, how: "saved" });
						setKey(key + 1);
					}}
					onEnded={(next) => {
						setSaved({ schedule: next, how: "ended" });
						setKey(key + 1);
					}}
					onCancel={() => setKey(key + 1)}
					{...props}
				/>
			) : null}
		</div>
	);
}

const ASK_TRIAGE = {
	title: "Triage new issues",
	agentId: "agt_triage",
	prompt:
		"Look at the issues opened on tvdavies/harbour since your last run. Label each one, and ask for a reproduction where it's missing.",
} as const;

export const NewTask: Story = () => <FormStory />;
NewTask.storyName = "New task";

/** "Every 10 minutes, ask Triage to look at new issues": the form filled in, with its next five runs. */
export const NewTaskFilled: Story = () => <FormStory draft={ASK_TRIAGE} />;
NewTaskFilled.storyName = "New task, every 10 minutes";

export const NewCheck: Story = () => (
	<FormStory
		kind="check"
		draft={{
			title: "Disk free on the build hosts",
			command: "checks/disk-free.sh --hosts build-1,build-2 --min-free 15%",
			every: "hours",
			interval: "1",
		}}
	/>
);
NewCheck.storyName = "New check, hourly";

export const WeeklyAt: Story = () => (
	<FormStory
		draft={{
			title: "Weekly release notes",
			agentId: "agt_writer",
			prompt: "Draft this week's release notes from the merged pull requests, grouped by area.",
			every: "week",
			at: "16:30",
			on: ["mon", "thu"],
			count: "12",
		}}
	/>
);
WeeklyAt.storyName = "Weekly on chosen days";

export const Once: Story = () => (
	<FormStory draft={{ ...ASK_TRIAGE, title: "Check the release went out", when: "once", once: "2026-10-30T09:15" }} />
);

export const Invalid: Story = () => (
	<FormStory validate draft={{ every: "week", on: [], at: "9am", agentId: "", prompt: "   " }} />
);
Invalid.storyName = "Error: fields to fix";

export const EditTask: Story = () => <FormStory edit={0} />;
EditTask.storyName = "Edit task";

export const EditCheck: Story = () => <FormStory edit={1} />;
EditCheck.storyName = "Edit check";

export const EditAtLimit: Story = () => <FormStory edit={2} />;
EditAtLimit.storyName = "Edit weekly, with a limit";

export const EndConfirm: Story = () => <FormStory edit={0} initial={{ confirmingEnd: true }} />;
EndConfirm.storyName = "End confirm";

export const Saving: Story = () => <FormStory draft={ASK_TRIAGE} initial={{ saving: true }} />;

const refuse =
	(error: HarbourError) =>
	(writes: ScheduleWrites): ScheduleWrites => ({
		...writes,
		create: () => Promise.reject(error),
		update: () => Promise.reject(error),
	});

const forbidden = refuse(new HarbourError("forbidden", "needs operator on the project"));

export const SaveRefused: Story = () => (
	<FormStory draft={ASK_TRIAGE} wrap={forbidden} initial={{ problem: { kind: "forbidden" } }} />
);
SaveRefused.storyName = "Error: save refused";

export const Unavailable: Story = () => <FormStory draft={ASK_TRIAGE} initial={{ problem: { kind: "unavailable" } }} />;
Unavailable.storyName = "Error: Harbour unavailable";

export const LongPrompt: Story = () => (
	<FormStory
		draft={{
			...ASK_TRIAGE,
			title: "Go through every open pull request on the platform repositories and write up what's blocking each one",
			prompt: Array.from(
				{ length: 8 },
				(_, index) =>
					`${index + 1}. Read the pull request's description, its checks and every unresolved review thread, then say in one line what it is waiting for and who can unblock it.`,
			).join("\n"),
		}}
	/>
);
LongPrompt.storyName = "Long content";

export const Mobile: Story = () => <FormStory draft={ASK_TRIAGE} />;
Mobile.meta = { width: 420 };
