import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { EnvironmentsPage, type EnvironmentsView } from "./environments-page.tsx";
import {
	createEnvironmentsScenario,
	DEV_ENV,
	directory,
	type EnvironmentsScenarioOptions,
	FAILED_ENV,
	FIXTURE_NOW,
	links,
	RENDER_ENV,
	SCRATCH_ENV,
} from "./fixtures.ts";

export default { title: "Environments/Environments page" } satisfies StoryDefault;

// Each story keeps its own source, so Start and Stop move its environments through their states.
function Scenario({
	view,
	options,
	projectId,
}: {
	view?: EnvironmentsView;
	options?: EnvironmentsScenarioOptions;
	projectId?: string;
}) {
	const [source] = useState(() => createEnvironmentsScenario(options));
	return (
		<EnvironmentsPage
			source={source}
			directory={directory}
			links={links}
			now={FIXTURE_NOW}
			{...(projectId === undefined ? {} : { projectId })}
			{...(view === undefined ? {} : { initialView: view })}
		/>
	);
}

/** Every environment the viewer can see: running and held, idle and counting down, stopped, and one that failed. */
export const List: Story = () => <Scenario />;

/** One project's environments. */
export const ProjectList: Story = () => <Scenario projectId="proj_kantel" />;

/** No environments yet. */
export const ListEmpty: Story = () => <Scenario options={{ environments: [] }} />;

/** The list while it loads. */
export const ListLoading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const ListError: Story = () => <Scenario options={{ fail: true }} />;

/** The dev stack: running, two sessions holding it, each in its own worktree and Compose project. */
export const Running: Story = () => <Scenario view={{ name: "environment", environmentId: DEV_ENV.id }} />;

/** Idle: nobody holds it, and it stops when the countdown runs out. */
export const Idle: Story = () => <Scenario view={{ name: "environment", environmentId: SCRATCH_ENV.id }} />;

/** Stopped, with a session still granted it: it starts when that session next runs a command. */
export const Stopped: Story = () => <Scenario view={{ name: "environment", environmentId: RENDER_ENV.id }} />;

/** A start the provider refused. */
export const Failed: Story = () => <Scenario view={{ name: "environment", environmentId: FAILED_ENV.id }} />;
