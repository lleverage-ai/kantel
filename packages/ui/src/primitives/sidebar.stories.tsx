import { type ReactNode, useState } from "react";
import { KantelLockup } from "../brand/kantel.tsx";
import { SignedInAs } from "../identity/signed-in-as.tsx";
import { NewSessionRow } from "../session/new-session.tsx";
import { SessionList } from "../session/session-list.tsx";
import type { SessionSummary } from "../session/session-model.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { IconButton } from "./button.tsx";
import { BookIcon, ClockIcon, KeyIcon, LayersIcon, ListIcon, PlusIcon, VaultIcon } from "./icons.tsx";
import { Sidebar, SidebarBrand, SidebarItem, SidebarProject, SidebarSection, SidebarToggle } from "./sidebar.tsx";

export default { title: "Primitives/Sidebar" } satisfies StoryDefault;

const now = Date.now();
const minutes = (n: number) => now - n * 60_000;
const session = (id: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	id,
	title,
	status: "idle",
	startedAt: minutes(90),
	updatedAt: minutes(30),
	...extra,
});

const sessions: SessionSummary[] = [
	session("a", "Rotate the Linear API key", { status: "running", startedAt: minutes(2), updatedAt: minutes(0) }),
	session("b", "Tidy the release notes"),
	session("c", "Draft the M0 handback", { updatedAt: minutes(60 * 26) }),
];

const longSessions: SessionSummary[] = [
	session(
		"l1",
		"Read README.md and tell me in two sentences what this repository does and who it is for, then open a PR",
	),
	session("l2", "Re-run the migration against the staging copy of the billing database and compare row counts"),
	session("l3", "Untitled session"),
];

const projects = ["Default", "Harbour", "brwsr"];
const longProjects = ["Lleverage platform: workflow engine and integrations monorepo", "Harbour", "brwsr"];

/** The sidebar at its console size: as wide as the token or the rail, and about as tall as a small window. */
function Frame({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
	return (
		<div
			style={{
				width: collapsed ? "var(--hb-rail-width)" : "min(var(--hb-sidebar-width), 100%)",
				height: "calc(var(--hb-sidebar-width) * 2)",
			}}
		>
			{children}
		</div>
	);
}

function Example({
	initiallyCollapsed = false,
	names = projects,
	list = sessions,
	loading = false,
	page,
}: {
	initiallyCollapsed?: boolean;
	names?: string[];
	list?: SessionSummary[];
	loading?: boolean;
	page?: "skills" | "project";
}) {
	const [collapsed, setCollapsed] = useState(initiallyCollapsed);
	const [open, setOpen] = useState(true);
	const [selected, setSelected] = useState<string | undefined>(page === undefined ? list[1]?.id : undefined);
	return (
		<Frame collapsed={collapsed}>
			<Sidebar
				collapsed={collapsed}
				aria-label="Projects and sessions"
				role="complementary"
				head={
					<>
						<SidebarBrand>
							<KantelLockup className="h-(--hb-brand-sm)" title="Kantel" />
						</SidebarBrand>
						<SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((was) => !was)} shortcut="Ctrl+B" />
					</>
				}
				foot={
					<>
						<SidebarSection label="Agent">
							<SidebarItem icon={<BookIcon />} label="Skills" href="#skills" selected={page === "skills"} />
							<SidebarItem icon={<LayersIcon />} label="Memory" href="#memory" />
						</SidebarSection>
						<SidebarSection label="Organisation">
							<SidebarItem icon={<ClockIcon />} label="Schedules" href="#schedules" />
							<SidebarItem icon={<VaultIcon />} label="Vault" href="#vault" />
							<SidebarItem icon={<ListIcon />} label="Audit log" href="#audit" />
							<SidebarItem icon={<KeyIcon />} label="API keys" href="#keys" />
						</SidebarSection>
						<SignedInAs name="Tom Davies" email="tom@example.com" />
					</>
				}
			>
				<SidebarSection label="Projects">
					{names.map((name, index) => (
						<SidebarProject
							key={name}
							name={name}
							href={`#${index}`}
							current={index === 0}
							selected={index === 0 && page === "project"}
							open={index === 0 && open}
							{...(index === 0
								? {
										onToggle: () => setOpen((was) => !was),
										action: (
											<IconButton
												variant="ghost"
												size="xs"
												label={`New session in ${name}`}
												title="New session"
												icon={<PlusIcon size="sm" />}
											/>
										),
									}
								: {})}
						>
							{index === 0 ? (
								<>
									<NewSessionRow href="#new" />
									<SessionList sessions={list} selectedId={selected} onSelect={setSelected} loading={loading} />
								</>
							) : undefined}
						</SidebarProject>
					))}
				</SidebarSection>
			</Sidebar>
		</Frame>
	);
}

export const Default: Story = () => (
	<Sheet
		title="Sidebar"
		intro="Projects with the current one's sessions nested under it on a guide line, the pages outside projects at the foot with icons, and who is signed in. The page shown is filled and in full-strength text; the project you're in is in full-strength text. The toggle (or Ctrl+B in the console) collapses it to a rail of icons and project initials, each named in a tooltip."
	>
		<div style={{ display: "flex", gap: "var(--hb-space-10)", flexWrap: "wrap", alignItems: "flex-start" }}>
			<Section title="Expanded, a session open">
				<Example />
			</Section>
			<Section title="Collapsed to the rail">
				<Example initiallyCollapsed />
			</Section>
		</div>
	</Sheet>
);

export const PageOutsideProjects: Story = () => (
	<Sheet title="Sidebar on a page outside projects">
		<Section title="Skills open: the item is filled, the project keeps its sessions">
			<Example page="skills" />
		</Section>
	</Sheet>
);

export const LongContent: Story = () => (
	<Sheet title="Sidebar with long names">
		<Section title="Project and session names truncate on one line">
			<Example names={longProjects} list={longSessions} />
		</Section>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="Sidebar while sessions load">
		<Section title="Placeholder rows under the project">
			<Example list={[]} loading page="project" />
		</Section>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="Sidebar with no sessions">
		<Section title="The project's page is shown and it has no sessions yet">
			<Example list={[]} page="project" />
		</Section>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet title="Sidebar on a phone">
		<Section title="On a phone the sidebar is the list page; the console hides the toggle there">
			<Example />
		</Section>
	</Sheet>
);
Mobile.meta = { width: 420 };
