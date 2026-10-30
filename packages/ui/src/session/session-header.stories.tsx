import { useState } from "react";
import { Breadcrumbs, type Crumb } from "../primitives/breadcrumbs.tsx";
import { IconButton } from "../primitives/button.tsx";
import { DotsIcon, FileIcon } from "../primitives/icons.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Row, Section, Sheet } from "../workbench/specimen.tsx";
import { DiffStat } from "./diff-stat.tsx";
import { ConnectionState, type ConnectionStateValue, SessionHeader } from "./session-header.tsx";

export default { title: "Session/Header" } satisfies StoryDefault;

const open: ConnectionStateValue = { state: "open" };

const actions = (
	<>
		<IconButton label="Files" icon={<FileIcon />} variant="ghost" />
		<IconButton label="Session options" icon={<DotsIcon />} variant="ghost" />
	</>
);

const project: Crumb = { label: "Default", href: "#project" };
const parent: Crumb = { label: "Fix the billing worker's double charges", href: "#parent" };

const longTitle =
	"Summarise yesterday's customer calls and draft the follow-up emails for the three that asked for pricing, then file them as drafts in the shared inbox";

/** An offline connection whose retry is `seconds` from when the story first rendered, counting down live. */
function useOffline(seconds: number): ConnectionStateValue {
	const [retryAt] = useState(() => Date.now() + seconds * 1000);
	return { state: "offline", retryAt };
}

export const Default: Story = () => (
	<Sheet
		title="Session header"
		intro="Breadcrumbs only, as T3 Code's: the project, muted and a link back, then the session, emphasised. Files and the options menu as icon buttons. No status: working shows in the thread, the composer and the sidebar."
	>
		<SessionHeader title="Hi" parents={[project]} connection={open} actions={actions} />
	</Sheet>
);

export const Subagent: Story = () => (
	<Sheet
		title="Session header, a subagent's session"
		intro="One level deeper: the project and the session that started the subagent are both muted links back."
	>
		<Section title="A subagent">
			<SessionHeader
				title="Write tests for the refund path"
				parents={[project, parent]}
				connection={open}
				actions={actions}
			/>
		</Section>
		<Section title="A subagent's subagent">
			<SessionHeader
				title="Find the refund fixtures"
				parents={[project, parent, { label: "Write tests for the refund path", href: "#child" }]}
				connection={open}
				actions={actions}
			/>
		</Section>
		<Section title="Three levels down, on a phone: the levels above the nearest fold into a button">
			<div style={{ maxWidth: "24em" }}>
				<SessionHeader
					title="Count the partial-refund tests"
					parents={[
						project,
						parent,
						{ label: "Write tests for the refund path", href: "#child" },
						{ label: "Check the partial refunds", href: "#grandchild" },
					]}
					connection={open}
					actions={actions}
					onBack={() => {}}
				/>
			</div>
		</Section>
	</Sheet>
);

function ConnectionsDemo() {
	const counting = useOffline(45);
	const due: ConnectionStateValue = { state: "offline", retryAt: 0 };
	return (
		<Sheet
			title="Session header, every connection state"
			intro="Connected says nothing (screen readers hear Connected). Offline counts down on the shared clock, then says Reconnecting."
		>
			<Section title="Open">
				<SessionHeader title="Fix the billing worker's double charges" parents={[project]} connection={open} />
			</Section>
			<Section title="Connecting">
				<SessionHeader
					title="Fix the billing worker's double charges"
					parents={[project]}
					connection={{ state: "connecting" }}
				/>
			</Section>
			<Section title="Offline, retry scheduled">
				<SessionHeader title="Fix the billing worker's double charges" parents={[project]} connection={counting} />
			</Section>
			<Section title="Offline, retry due">
				<SessionHeader title="Fix the billing worker's double charges" parents={[project]} connection={due} />
			</Section>
			<Section title="On its own">
				<Row>
					<ConnectionState connection={{ state: "connecting" }} />
					<ConnectionState connection={counting} />
					<ConnectionState connection={due} />
				</Row>
			</Section>
		</Sheet>
	);
}

export const Connections: Story = () => <ConnectionsDemo />;

export const Loading: Story = () => (
	<Sheet title="Session header, loading" intro="The title is a skeleton until the session's snapshot arrives.">
		<SessionHeader
			parents={[project]}
			connection={{ state: "connecting" }}
			loading
			actions={actions}
			onBack={() => {}}
		/>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="Session header, no title yet" intro="A session with no title yet is called New session.">
		<Section title="No title">
			<SessionHeader parents={[project]} connection={open} actions={actions} />
		</Section>
		<Section title="A blank title">
			<SessionHeader title="   " parents={[project]} connection={open} />
		</Section>
		<Section title="No project">
			<SessionHeader title="Fix the billing worker's double charges" connection={open} />
		</Section>
	</Sheet>
);

export const Streaming: Story = () => (
	<Sheet
		title="Session header, agent working"
		intro="Exactly as when idle: the bar never says the agent is working. The thread's working row and the composer's stop button do."
	>
		<SessionHeader
			title="Fix the billing worker's double charges"
			parents={[project]}
			connection={open}
			actions={actions}
		/>
	</Sheet>
);

function ErrorDemo() {
	const offline = useOffline(30);
	return (
		<Sheet
			title="Session header, offline"
			intro="The host link is down and retrying: the one thing besides the trail it says."
		>
			<SessionHeader title="Nightly bug sweep" parents={[project]} connection={offline} actions={actions} />
		</Sheet>
	);
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: every component's error state is the story named Error.
export const Error: Story = () => <ErrorDemo />;

export const LongContent: Story = () => (
	<Sheet
		title="Session header, long content"
		intro="The current item truncates first, with the whole title on hover; parents keep a few letters each."
	>
		<Section title="Long title">
			<SessionHeader title={longTitle} parents={[project]} connection={open} actions={actions} onBack={() => {}} />
		</Section>
		<Section title="Long everything">
			<SessionHeader
				title={longTitle}
				parents={[
					{ label: "Lleverage customer success and onboarding", href: "#p" },
					{ label: longTitle, href: "#s" },
				]}
				connection={open}
				actions={actions}
			/>
		</Section>
	</Sheet>
);

function MobileDemo() {
	const offline = useOffline(20);
	return (
		<Sheet title="Session header at 420px" intro="The trail keeps one line; the current item truncates first.">
			<Section title="A session">
				<SessionHeader
					title="Fix the billing worker's double charges"
					parents={[project]}
					connection={open}
					actions={actions}
					onBack={() => {}}
				/>
			</Section>
			<Section title="A subagent, offline">
				<SessionHeader
					title="Write tests for the refund path"
					parents={[project, parent]}
					connection={offline}
					actions={actions}
					onBack={() => {}}
				/>
			</Section>
			<Section title="Loading">
				<SessionHeader parents={[project]} connection={{ state: "connecting" }} loading onBack={() => {}} />
			</Section>
		</Sheet>
	);
}

export const Mobile: Story = () => <MobileDemo />;
Mobile.meta = { width: 420 };

export const Trail: Story = () => (
	<Sheet
		title="Breadcrumbs"
		intro="The trail on its own: muted parents, each a link or a button back to its level, the current item emphasised."
	>
		<Column>
			<Row label="One level">
				<Breadcrumbs label="Example" parents={[]} current="Default" />
			</Row>
			<Row label="Links">
				<Breadcrumbs label="Example" parents={[project]} current="Hi" />
			</Row>
			<Row label="Buttons">
				<Breadcrumbs label="Example" parents={[{ label: "Default", onSelect: () => {} }]} current="Hi" />
			</Row>
			<Row label="Three levels">
				<Breadcrumbs label="Example" parents={[project, parent]} current="Write tests for the refund path" />
			</Row>
		</Column>
	</Sheet>
);

export const DiffStats: Story = () => (
	<Sheet
		title="Diff stat"
		intro="Lines added and removed, in monospace with a true minus sign. Screen readers hear it in words."
	>
		<Column>
			<Row label="Small">
				<DiffStat additions={12} deletions={3} />
			</Row>
			<Row label="One line">
				<DiffStat additions={1} deletions={1} />
			</Row>
			<Row label="Only additions">
				<DiffStat additions={240} deletions={0} />
			</Row>
			<Row label="Large">
				<DiffStat additions={12_480} deletions={3_207} />
			</Row>
		</Column>
	</Sheet>
);
