import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import {
	CREATED,
	createToolServersScenario,
	DOCS_SERVER,
	FIXTURE_NOW,
	ORGANISATION,
	ORIGIN,
	PROJECTS,
	SAL_SERVER,
	type ToolServersScenarioOptions,
	WAREHOUSE_SERVER,
} from "./fixtures.ts";
import type { ToolServerProject } from "./tool-servers-model.ts";
import { ToolServersPage, type ToolServersView } from "./tool-servers-page.tsx";

export default { title: "Tool servers/Tool servers page" } satisfies StoryDefault;

// Each story keeps its own source, so adding, toggling, rotating and removing change what it shows.
function Scenario({
	view,
	options,
	project,
	created,
}: {
	view?: ToolServersView;
	options?: ToolServersScenarioOptions;
	project?: ToolServerProject;
	created?: boolean;
}) {
	const [source] = useState(() => createToolServersScenario(options));
	return (
		<ToolServersPage
			source={source}
			organisation={ORGANISATION}
			projects={PROJECTS}
			origin={ORIGIN}
			now={FIXTURE_NOW}
			{...(project === undefined ? {} : { project })}
			{...(view === undefined ? {} : { initialView: view })}
			{...(created === true ? { initialCreated: CREATED } : {})}
		/>
	);
}

const SAL_PROJECT = PROJECTS[0];

/** The organisation's servers: Sal's connected one, an offline one and one that hasn't connected yet. */
export const List: Story = () => <Scenario />;

/** No servers yet: the way to add one. */
export const ListEmpty: Story = () => <Scenario options={{ servers: [] }} />;

/** The list while it loads. */
export const ListLoading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const ListError: Story = () => <Scenario options={{ fail: true }} />;

/** Add tool server, from the organisation's page: any scope, a tunnel. */
export const Add: Story = () => <Scenario view={{ name: "add" }} />;

/** Add tool server from a project's page: the project is the scope. */
export const AddProjectScoped: Story = () => <Scenario view={{ name: "add" }} project={SAL_PROJECT} />;

/** A server just added: its token once, and the command that connects it. */
export const TokenIssued: Story = () => <Scenario view={{ name: "add" }} created />;

/** Sal's server: connected, six tools, one turned off, its token and its recent calls. */
export const Server: Story = () => <Scenario view={{ name: "server", serverId: SAL_SERVER.id }} />;

/** An offline server, with a tool whose name is too long for a model. */
export const ServerOffline: Story = () => <Scenario view={{ name: "server", serverId: DOCS_SERVER.id }} />;

/** A server that hasn't connected yet: no tools to show. */
export const ServerNeverConnected: Story = () => <Scenario view={{ name: "server", serverId: WAREHOUSE_SERVER.id }} />;

/** A server whose tools couldn't be read. */
export const ServerToolsError: Story = () => (
	<Scenario view={{ name: "server", serverId: SAL_SERVER.id }} options={{ failTools: true }} />
);
