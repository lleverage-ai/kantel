import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { FIXTURE_NOW, sessions as fixtureSessions } from "./fixtures.ts";
import { SessionList, SessionListItem } from "./session-list.tsx";
import { SessionFilterMenu, type SessionMenuActions, SessionRowMenu } from "./session-menu.tsx";
import { defaultSessionListView, type SessionListView, type SessionSummary } from "./session-model.ts";

export default { title: "Session/Session list" } satisfies StoryDefault;

// The fixtures are relative to a fixed instant; the list's times read the real clock, so move them to now.
const base = Date.now();
const rebase = (session: SessionSummary): SessionSummary => ({
	...session,
	startedAt: session.startedAt - FIXTURE_NOW + base,
	updatedAt: session.updatedAt - FIXTURE_NOW + base,
});
const sessions = fixtureSessions.map(rebase);

/** The sidebar's width, as the list sits in the console. */
function Sidebar({ children }: { children: ReactNode }) {
	return <div style={{ width: "100%", maxWidth: "var(--kt-sidebar-width)" }}>{children}</div>;
}

function Selectable({ list, grouped = true }: { list: SessionSummary[]; grouped?: boolean }) {
	const [selected, setSelected] = useState("s3");
	return <SessionList sessions={list} selectedId={selected} onSelect={setSelected} grouped={grouped} />;
}

export const Default: Story = () => (
	<Sheet
		title="Session list"
		intro="Grouped by what each session needs from you: Needs you, Working, Done. Sessions that need you or are working get two lines, a working one with its spinner and Working 3m 20s; settled ones are one quiet line with their time. An unseen completion shows an emerald Done."
	>
		<Section title="Grouped, one selected">
			<Sidebar>
				<Selectable list={sessions} />
			</Sidebar>
		</Section>
		<Section title="A row with actions, shown on hover or focus">
			<Sidebar>
				<SessionListItem
					session={sessions[2] as SessionSummary}
					onSelect={() => {}}
					actions={
						<Button size="xs" variant="ghost">
							Settle
						</Button>
					}
				/>
			</Sidebar>
		</Section>
		<Section title="As links">
			<Sidebar>
				<SessionList sessions={sessions.slice(0, 3)} selectedId="s1" hrefFor={(id) => `#session-${id}`} />
			</Sidebar>
		</Section>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="Session list: loading" intro="Five placeholder rows while the first page of sessions loads.">
		<Sidebar>
			<SessionList sessions={[]} loading />
		</Sidebar>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="Session list: empty" intro="What the list says before there are any sessions.">
		<Sidebar>
			<SessionList sessions={[]} />
		</Sidebar>
	</Sheet>
);

function StreamingDemo() {
	const [list, setList] = useState(sessions);
	useEffect(() => {
		const timer = setInterval(() => {
			setList((current) =>
				current.map((session): SessionSummary => {
					if (session.id !== "s3") return session;
					return session.status === "running"
						? { ...session, status: "waiting", needs: "approval", updatedAt: Date.now() }
						: { ...session, status: "running", needs: undefined, updatedAt: Date.now() };
				}),
			);
		}, 3000);
		return () => clearInterval(timer);
	}, []);
	return (
		<Sidebar>
			<SessionList sessions={list} selectedId="s3" onSelect={() => {}} />
		</Sidebar>
	);
}

export const Streaming: Story = () => (
	<Sheet
		title="Session list: streaming"
		intro="The billing session's elapsed time ticks on the shared clock, and every three seconds it flips between working and needing approval, moving between groups. Every other row keeps its identity, so only that row re-renders."
	>
		<StreamingDemo />
	</Sheet>
);

// Named ErrorState so the export doesn't shadow the global Error; the workbench shows it as "Error".
export const ErrorState: Story = () => (
	<Sheet
		title="Session list: error"
		intro="When the list can't load, it says so. With sessions already known, the notice sits above them."
	>
		<Section title="Nothing loaded">
			<Sidebar>
				<SessionList sessions={[]} error="Couldn't load your sessions. Retrying in a few seconds." />
			</Sidebar>
		</Section>
		<Section title="Stale list">
			<Sidebar>
				<SessionList
					sessions={sessions}
					onSelect={() => {}}
					error="Lost the connection. This list may be out of date."
				/>
			</Sidebar>
		</Section>
	</Sheet>
);
ErrorState.storyName = "Error";

const statuses: Pick<SessionSummary, "status" | "needs" | "unread">[] = [
	{ status: "waiting", needs: "approval" },
	{ status: "waiting", needs: "answer" },
	{ status: "running" },
	{ status: "failed" },
	{ status: "done", unread: true },
	{ status: "done" },
	{ status: "idle" },
	{ status: "cancelled" },
];

const longSessions: SessionSummary[] = Array.from({ length: 40 }, (_, index) => {
	const shape = statuses[index % statuses.length] as (typeof statuses)[number];
	return {
		id: `long-${index}`,
		title:
			index % 3 === 0
				? `Re-run the migration against the staging copy of the billing database for tenant ${index + 1}, then compare row counts and report any differences`
				: `Session ${index + 1}: tidy the release notes`,
		project: index % 4 === 0 ? "a-project-with-a-rather-long-name-for-the-sidebar" : "kantel",
		...(index % 2 === 0 ? { branch: `feature/very-long-branch-name-for-session-${index + 1}-and-its-follow-ups` } : {}),
		...shape,
		startedAt: base - (index + 1) * 600_000,
		updatedAt: base - (index + 1) * 300_000,
	};
});

export const LongContent: Story = () => (
	<Sheet
		title="Session list: long content"
		intro="Forty sessions with long titles, projects and branches. Titles, projects and branches each truncate on their own line."
	>
		<Sidebar>
			<Selectable list={longSessions} />
		</Sidebar>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet
		title="Session list at 420px"
		intro="The list fills the width of a phone; titles and branches truncate sooner."
	>
		<Column>
			<Selectable list={sessions} />
		</Column>
	</Sheet>
);
Mobile.meta = { width: 420 };

/** A list whose menu works on its own copy of the fixtures, as the console's does on the host. */
function Organised({ initial }: { initial?: SessionListView }) {
	const [list, setList] = useState<SessionSummary[]>(() =>
		sessions.map((session, index) =>
			index === 1
				? { ...session, pinned: true }
				: index === sessions.length - 1
					? { ...session, archived: true }
					: session,
		),
	);
	const [view, setView] = useState(initial ?? defaultSessionListView);
	const [selected, setSelected] = useState("s3");
	const actions = useMemo((): SessionMenuActions => {
		const change = (id: string, patch: Partial<SessionSummary>) =>
			setList((was) => was.map((session) => (session.id === id ? { ...session, ...patch } : session)));
		return {
			setUnread: async (id, unread) => change(id, { unread }),
			setPinned: async (id, pinned) => change(id, { pinned }),
			setArchived: async (id, archived) => change(id, { archived }),
			rename: async (id, title) => change(id, { title }),
			remove: async (id) => setList((was) => was.filter((session) => session.id !== id)),
		};
	}, []);
	return (
		<SessionList
			sessions={list}
			selectedId={selected}
			onSelect={setSelected}
			view={view}
			onViewChange={setView}
			menuActions={actions}
		/>
	);
}

export const FilterAndMenu: Story = () => (
	<Sheet
		title="Session list: filter and menu"
		intro="After Claude.ai's sidebar. Recents has a filter button (Status, Last activity, Group by, Sort by), and each row has a … menu on hover: Mark as unread, Pin, Rename, Archive and Delete, with U, P, R, A and D while it is open. Pinned sessions come first; archived ones leave the Active view."
	>
		<Section title="Recents, one pinned, one archived out of view">
			<Sidebar>
				<Organised />
			</Sidebar>
		</Section>
		<Section title="All sessions, by date, by title">
			<Sidebar>
				<Organised initial={{ status: "all", activity: "all", groupBy: "date", sortBy: "title" }} />
			</Sidebar>
		</Section>
	</Sheet>
);

export const FilterOpen: Story = () => {
	const [view, setView] = useState(defaultSessionListView);
	return (
		<Sheet title="Session filter, open" intro="The filter's menu: each setting opens its choices to the side.">
			<div style={{ display: "flex", justifyContent: "flex-end", width: "var(--kt-sidebar-width)" }}>
				<SessionFilterMenu view={view} onViewChange={setView} defaultOpen />
			</div>
		</Sheet>
	);
};

export const RowMenuOpen: Story = () => (
	<Sheet title="Session row menu, open" intro="A row's … menu, with each action's key.">
		<RowMenuDemo />
	</Sheet>
);

function RowMenuDemo() {
	const session = sessions[2] as SessionSummary;
	return (
		<div style={{ width: "var(--kt-sidebar-width)" }}>
			<SessionRowMenu session={session} onAction={() => {}} defaultOpen />
		</div>
	);
}

const manySessions: SessionSummary[] = Array.from({ length: 140 }, (_, index) => ({
	id: `many-${index}`,
	title: `Session ${index + 1}: check the nightly import`,
	status: "done",
	startedAt: base - (index + 1) * 600_000,
	updatedAt: base - (index + 1) * 300_000,
}));

export const ManySessions: Story = () => (
	<Sheet
		title="Session list: many sessions"
		intro="A hundred and forty sessions: a group shows its newest 50 and offers the rest 50 at a time, so an organisation with a thousand sessions doesn't render them all on every page. The selected session is always shown."
	>
		<Sidebar>
			<Selectable list={manySessions} />
		</Sidebar>
	</Sheet>
);

export const Ungrouped: Story = () => (
	<Sheet
		title="Session list: ungrouped"
		intro="With grouped off, the list keeps the order it is given, with no headings: for search results or a filtered view."
	>
		<Sidebar>
			<Selectable list={sessions} grouped={false} />
		</Sidebar>
	</Sheet>
);
