import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import {
	type SessionPlace,
	type SessionVisibility,
	SessionVisibilityButton,
	SessionVisibilityDialog,
} from "../session/session-visibility.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { ConnectionSharingSection, ConnectionUsesSection } from "./connection-sharing.tsx";
import type { Connection, ConnectionsViewer, ConnectionUseView } from "./connections-model.ts";
import {
	ADMIN_OTHER_VIEWER,
	CONNECTIONS,
	createSessionVisibilityScenario,
	createSharingScenario,
	FIXTURE_NOW,
	FIXTURE_USES,
	PEOPLE,
	VIEWER,
} from "./fixtures.ts";

export default { title: "Connections/Sharing" } satisfies StoryDefault;

const github = CONNECTIONS.find((c) => c.id === "conn_github_tom") ?? CONNECTIONS[0]!;
const gmail = CONNECTIONS.find((c) => c.id === "conn_gmail_tom") ?? CONNECTIONS[0]!;
const linear = CONNECTIONS.find((c) => c.id === "conn_linear_support") ?? CONNECTIONS[0]!;
const bot = CONNECTIONS.find((c) => c.id === "conn_github_bot") ?? CONNECTIONS[0]!;
const people = (id: string) => PEOPLE[id];

function Sharing({
	connection,
	viewer = VIEWER,
	fail,
}: {
	connection: Connection;
	viewer?: ConnectionsViewer;
	fail?: boolean;
}) {
	const [state] = useState(() => {
		let list: readonly Connection[] = [connection];
		return createSharingScenario({
			connections: () => list,
			set: (next) => {
				list = list.map((c) => (c.id === next.id ? next : c));
			},
			viewer,
			wait: (value) =>
				new Promise((resolve, reject) =>
					setTimeout(() => {
						try {
							if (fail === true) throw new Error("Couldn't reach Kantel. Nothing was shared.");
							resolve(value());
						} catch (error) {
							reject(error);
						}
					}, 300),
				),
		});
	});
	return (
		<div className="max-w-(--kt-page-measure) p-6">
			<ConnectionSharingSection
				connection={connection}
				viewer={viewer}
				people={people}
				now={FIXTURE_NOW}
				source={state}
			/>
		</div>
	);
}

/** Tom's GitHub, shared with Support: where it reaches, the share, and Share with Billing. */
export const PersonalShared: Story = () => <Sharing connection={github} />;

/** Tom's Gmail, shared with no one: only his own private sessions. */
export const PersonalNotShared: Story = () => <Sharing connection={gmail} />;

/** An organisation admin looking at Tom's GitHub: she can see it and stop the share, not use or share it. */
export const PersonalSeenByAdmin: Story = () => <Sharing connection={github} viewer={ADMIN_OTHER_VIEWER} />;

/** A project's connection limited to two agents. */
export const ProjectConnection: Story = () => <Sharing connection={linear} />;

/** An organisation's connection: any session, unattended runs too. */
export const OrganisationConnection: Story = () => <Sharing connection={bot} />;

/** Sharing fails: the error stays on the section. */
export const ShareFails: Story = () => <Sharing connection={gmail} fail />;

function Uses({ uses, fail, hang }: { uses?: readonly ConnectionUseView[]; fail?: boolean; hang?: boolean }) {
	const load = () =>
		hang === true
			? new Promise<readonly ConnectionUseView[]>(() => {})
			: new Promise<readonly ConnectionUseView[]>((resolve, reject) =>
					setTimeout(() => (fail === true ? reject(new Error("offline")) : resolve(uses ?? FIXTURE_USES)), 200),
				);
	return (
		<div className="max-w-(--kt-page-measure) p-6">
			<ConnectionUsesSection connectionId={github.id} load={load} now={FIXTURE_NOW} onOpenSession={() => {}} />
		</div>
	);
}

/** Used, refused because others could see the session, used through the share, waiting for approval, unattended. */
export const RecentUses: Story = () => <Uses />;
export const RecentUsesEmpty: Story = () => <Uses uses={[]} />;
export const RecentUsesLoading: Story = () => <Uses hang />;
export const RecentUsesError: Story = () => <Uses fail />;

const SUPPORT: SessionPlace = { kind: "project", name: "Support" };

function Visibility({ start, locked }: { start: SessionVisibility; locked?: string }) {
	const [visibility, setVisibility] = useState(start);
	const [open, setOpen] = useState(true);
	const [source] = useState(() => createSessionVisibilityScenario());
	return (
		<div className="flex flex-col items-start gap-4 p-6">
			{open ? null : <Button onClick={() => setOpen(true)}>Open</Button>}
			<SessionVisibilityDialog
				open={open}
				visibility={visibility}
				place={SUPPORT}
				source={source}
				locked={locked}
				onClose={() => setOpen(false)}
				onChanged={setVisibility}
			/>
		</div>
	);
}

/** A private session: Tom's own connections are usable; the others say why not. */
export const SessionPrivate: Story = () => <Visibility start="private" />;

/** A session Support can see: Gmail is refused because others can see it; GitHub works through its share. */
export const SessionShared: Story = () => <Visibility start="shared" />;

/** Someone else's session, or a child: the choice is shown, not changeable. */
export const SessionLocked: Story = () => (
	<Visibility start="shared" locked="Only Ana Ruiz, who this session acts for, can change who sees it." />
);

/** The session header's chip, private and shared: opens the dialog. */
export const SessionHeaderChip: Story = () => (
	<div className="flex items-center gap-3 p-6">
		<SessionVisibilityButton visibility="private" place={SUPPORT} onClick={() => {}} />
		<SessionVisibilityButton visibility="shared" place={SUPPORT} onClick={() => {}} />
	</div>
);
