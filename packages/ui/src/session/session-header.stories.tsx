import { useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { DotsIcon } from "../primitives/icons.tsx";
import { Elapsed } from "../primitives/time.tsx";
import { type Status, statusLabel } from "../tokens/tokens.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Row, Section, Sheet } from "../workbench/specimen.tsx";
import { DiffStat } from "./diff-stat.tsx";
import { ConnectionState, type ConnectionStateValue, SessionHeader } from "./session-header.tsx";

export default { title: "Session/Header" } satisfies StoryDefault;

const open: ConnectionStateValue = { state: "open" };
const started = Date.now() - 200_000;

const options = <IconButton label="Session options" icon={<DotsIcon />} variant="ghost" />;

const meta = (
	<>
		<span>harbour</span>
		<span className="hb-mono">ui/session-components</span>
		<DiffStat additions={128} deletions={37} />
	</>
);

const longTitle =
	"Summarise yesterday's customer calls and draft the follow-up emails for the three that asked for pricing, then file them as drafts in the shared inbox";

/** An offline connection whose retry is `seconds` from when the story first rendered, counting down live. */
function useOffline(seconds: number): ConnectionStateValue {
	const [retryAt] = useState(() => Date.now() + seconds * 1000);
	return { state: "offline", retryAt };
}

export const Default: Story = () => (
	<Sheet title="Session header" intro="Status, title, the session's facts and its actions. A healthy connection shows nothing.">
		<SessionHeader
			title="Fix the billing worker's double charges"
			status="working"
			connection={open}
			meta={meta}
			actions={options}
			onBack={() => {}}
		/>
	</Sheet>
);

const statuses: Status[] = ["working", "waiting", "approval", "done", "error", "idle"];

export const Statuses: Story = () => (
	<Sheet title="Session header, every status">
		{statuses.map((status) => (
			<Section key={status} title={statusLabel[status]}>
				<SessionHeader title="Fix the billing worker's double charges" status={status} connection={open} />
			</Section>
		))}
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
				<SessionHeader title="Fix the billing worker's double charges" status="working" connection={open} />
			</Section>
			<Section title="Connecting">
				<SessionHeader
					title="Fix the billing worker's double charges"
					status="working"
					connection={{ state: "connecting" }}
				/>
			</Section>
			<Section title="Offline, retry scheduled">
				<SessionHeader title="Fix the billing worker's double charges" status="working" connection={counting} />
			</Section>
			<Section title="Offline, retry due">
				<SessionHeader title="Fix the billing worker's double charges" status="working" connection={due} />
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
		<SessionHeader status="idle" connection={{ state: "connecting" }} loading actions={options} onBack={() => {}} />
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="Session header, no title yet" intro="A session with no title yet is called New session.">
		<Section title="No title">
			<SessionHeader status="idle" connection={open} actions={options} />
		</Section>
		<Section title="A blank title">
			<SessionHeader title="   " status="idle" connection={open} />
		</Section>
	</Sheet>
);

export const Streaming: Story = () => (
	<Sheet title="Session header, agent working" intro="Working, with how long for in the meta, ticking on the shared clock.">
		<SessionHeader
			title="Fix the billing worker's double charges"
			status="working"
			connection={open}
			meta={
				<>
					<span>
						Working for <Elapsed since={started} />
					</span>
					<DiffStat additions={12} deletions={3} />
				</>
			}
			actions={
				<Button size="xs" variant="danger">
					Stop
				</Button>
			}
		/>
	</Sheet>
);

function ErrorDemo() {
	const offline = useOffline(30);
	return (
		<Sheet title="Session header, failed and offline" intro="A failed session whose host link is down and retrying.">
			<SessionHeader
				title="Nightly bug sweep"
				status="error"
				connection={offline}
				meta={<span>Failed after 4m 12s</span>}
				actions={options}
			/>
		</Sheet>
	);
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: every component's error state is the story named Error.
export const Error: Story = () => <ErrorDemo />;

export const LongContent: Story = () => (
	<Sheet title="Session header, long content" intro="A long title truncates with the full text on hover; long meta wraps.">
		<SessionHeader
			title={longTitle}
			status="done"
			connection={open}
			meta={
				<>
					<span>lleverage</span>
					<span className="hb-mono">feature/customer-call-follow-ups-with-pricing-drafts</span>
					<DiffStat additions={12_480} deletions={3_207} />
				</>
			}
			actions={options}
			onBack={() => {}}
		/>
	</Sheet>
);

function MobileDemo() {
	const offline = useOffline(20);
	return (
		<Sheet title="Session header at 420px" intro="Meta moves to a second line; the title keeps the first.">
			<Section title="Working">
				<SessionHeader
					title="Fix the billing worker's double charges"
					status="working"
					connection={open}
					meta={meta}
					actions={options}
					onBack={() => {}}
				/>
			</Section>
			<Section title="Long title, offline">
				<SessionHeader
					title={longTitle}
					status="approval"
					connection={offline}
					meta={meta}
					actions={options}
					onBack={() => {}}
				/>
			</Section>
			<Section title="Loading">
				<SessionHeader status="idle" connection={{ state: "connecting" }} loading onBack={() => {}} />
			</Section>
		</Sheet>
	);
}

export const Mobile: Story = () => <MobileDemo />;
Mobile.meta = { width: 420 };

export const DiffStats: Story = () => (
	<Sheet title="Diff stat" intro="Lines added and removed, in monospace with a true minus sign. Screen readers hear it in words.">
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
