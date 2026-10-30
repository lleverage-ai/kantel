import {
	ApiKeysPage,
	Badge,
	BookIcon,
	Button,
	ClockIcon,
	type Crumb,
	EmptyState,
	IconButton,
	KeyIcon,
	LayersIcon,
	ListIcon,
	ListRow,
	MembersPage,
	NewSessionRow,
	Notice,
	PeopleIcon,
	PlusIcon,
	SessionList,
	Sidebar,
	SidebarBrand,
	SidebarItem,
	SidebarProject,
	SidebarSection,
	SidebarToggle,
	SignedInAs,
	Spinner,
	VaultIcon,
} from "@harbour/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { ConsoleActor, ConsoleClient, ProjectSummary, SessionListState } from "../api/client.ts";
import type { ConsoleMembers } from "../api/members.ts";
import type { ConsoleAgent, ConsoleAudit, ConsoleKeys, ConsoleSchedules, ConsoleVault } from "../api/oversight.ts";
import { type LiveSummary, withLive } from "../state/live-summary.ts";
import type { SessionClient } from "../state/session-client.ts";
import { MemoryScreen, SkillsScreen } from "./agent-screens.tsx";
import { AuditScreen } from "./audit-screen.tsx";
import { FilesScreen } from "./files-screen.tsx";
import { useLineage } from "./lineage.ts";
import { NewSessionScreen } from "./new-session-screen.tsx";
import {
	AUDIT_PATH,
	filesPath,
	interceptLinks,
	KEYS_PATH,
	MEMBERS_PATH,
	memoryPath,
	navigate,
	newSessionPath,
	parseRoute,
	projectPath,
	type Route,
	schedulesPath,
	sessionPath,
	skillsPath,
	usePathname,
	VAULT_PATH,
} from "./router.ts";
import { SchedulesScreen } from "./schedules-screen.tsx";
import { SessionScreen } from "./session-screen.tsx";
import { NARROW_QUERY, useMedia } from "./use-media.ts";
import { sidebarShortcut, useSidebarCollapse } from "./use-sidebar.ts";
import { VaultScreen } from "./vault-screen.tsx";

// The console's shell: a sidebar with the projects, the current project's sessions nested under it, and the pages
// that belong to no project at its foot; the open session or page beside it, as wide as the window. The sidebar
// collapses to a rail of icons. On a phone it is one pane at a time: the list, or the session with Back. Every piece
// is from @harbour/ui; this file only decides what goes where.

const loadingList: SessionListState = { sessions: [], loading: true };
const noList: SessionListState = { sessions: [], loading: false };

/** A project's sessions, followed live. */
function useSessionList(client: ConsoleClient, projectId: string | undefined): SessionListState {
	const [state, setState] = useState<SessionListState>(loadingList);
	useEffect(() => {
		if (projectId === undefined) {
			setState(noList);
			return;
		}
		setState(loadingList);
		return client.watchSessions(projectId, setState);
	}, [client, projectId]);
	return state;
}

function useProjects(client: ConsoleClient): { projects?: readonly ProjectSummary[]; error?: string } {
	const [state, setState] = useState<{ projects?: readonly ProjectSummary[]; error?: string }>({});
	useEffect(() => {
		let live = true;
		let answered = false;
		// The projects this browser last showed, until the API answers.
		client.cachedProjects?.().then(
			(projects) => live && !answered && projects !== undefined && setState({ projects }),
			() => {},
		);
		client.projects().then(
			(projects) => {
				answered = true;
				if (live) setState({ projects });
			},
			(reason: unknown) => {
				answered = true;
				if (live) setState({ error: String(reason) });
			},
		);
		return () => {
			live = false;
		};
	}, [client]);
	return state;
}

/**
 * The project a linked session is in: `pending` until the client answers, then its project id, or undefined when
 * there's no such session. Until then the session opens as linked; most links are good.
 */
function useSessionProject(client: ConsoleClient, sessionId: string | undefined): string | undefined | "pending" {
	const [found, setFound] = useState<{ sessionId: string; projectId: string | undefined }>();
	useEffect(() => {
		if (sessionId === undefined) return;
		let live = true;
		client.projectOf(sessionId).then(
			(projectId) => live && setFound({ sessionId, projectId }),
			// Couldn't ask; the session's own stream will say what's wrong.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [client, sessionId]);
	return found !== undefined && found.sessionId === sessionId ? found.projectId : "pending";
}

/** Who is signed in, at the sidebar's foot, with Sign out when the console signed them in itself. */
function Actor({ actor }: { actor: ConsoleActor }) {
	const [signingOut, setSigningOut] = useState(false);
	const { signOut } = actor;
	return (
		<SignedInAs
			name={actor.name}
			{...(actor.email === undefined ? {} : { email: actor.email })}
			{...(actor.stubbed ? { badge: <Badge>Sign-in stubbed</Badge> } : {})}
			{...(signOut === undefined
				? {}
				: {
						onSignOut: () => {
							setSigningOut(true);
							void signOut().finally(() => location.reload());
						},
					})}
			signingOut={signingOut}
		/>
	);
}

/**
 * The projects, each a folder; the one you're in has its sessions nested under it, with New session first. Its
 * chevron hides and shows them; another project's row opens that project.
 */
function ProjectNav({
	projects,
	current,
	selected,
	open,
	onToggle,
	newSession,
	children,
}: {
	projects: readonly ProjectSummary[];
	/** The project whose sessions are listed: the route's, or the last one visited on a page outside projects. */
	current: string | undefined;
	/** The project's own page is the one shown. */
	selected: boolean;
	open: boolean;
	onToggle: () => void;
	/** The current project's New session link, when you may start one there. */
	newSession?: string;
	children: ReactNode;
}) {
	return (
		<SidebarSection label="Projects">
			{projects.map((project) => {
				const isCurrent = project.id === current;
				return (
					<SidebarProject
						key={project.id}
						name={project.name}
						href={projectPath(project.id)}
						current={isCurrent}
						selected={isCurrent && selected}
						open={isCurrent && open}
						{...(isCurrent ? { onToggle } : {})}
						{...(isCurrent && newSession !== undefined
							? {
									action: (
										<IconButton
											variant="ghost"
											size="xs"
											label={`New session in ${project.name}`}
											title="New session"
											icon={<PlusIcon size="sm" />}
											onClick={() => navigate(newSession)}
										/>
									),
								}
							: {})}
					>
						{isCurrent ? children : undefined}
					</SidebarProject>
				);
			})}
		</SidebarSection>
	);
}

/** The agent's skills and memory, shown when the console has a seam for them. */
function AgentNav({ route, agent }: { route: Route; agent: boolean }) {
	if (!agent) return null;
	return (
		<SidebarSection label="Agent">
			<SidebarItem icon={<BookIcon />} label="Skills" href={skillsPath()} selected={route.name === "skills"} />
			<SidebarItem icon={<LayersIcon />} label="Memory" href={memoryPath()} selected={route.name === "memory"} />
		</SidebarSection>
	);
}

/**
 * The organisation's pages: schedules, the vault, the audit log and API keys, each shown when the console has a seam
 * for it.
 */
function OrganisationNav({
	route,
	schedules,
	vault,
	audit,
	keys,
	members = false,
}: {
	route: Route;
	schedules: boolean;
	vault: boolean;
	audit: boolean;
	keys: boolean;
	members?: boolean;
}) {
	if (!schedules && !vault && !audit && !keys && !members) return null;
	return (
		<SidebarSection label="Organisation">
			{schedules ? (
				<SidebarItem
					icon={<ClockIcon />}
					label="Schedules"
					href={schedulesPath()}
					selected={route.name === "schedules"}
				/>
			) : null}
			{vault ? (
				<SidebarItem
					icon={<VaultIcon />}
					label="Vault"
					href={VAULT_PATH}
					selected={route.name === "vault" || route.name === "vault-request"}
				/>
			) : null}
			{audit ? (
				<SidebarItem icon={<ListIcon />} label="Audit log" href={AUDIT_PATH} selected={route.name === "audit"} />
			) : null}
			{keys ? (
				<SidebarItem icon={<KeyIcon />} label="API keys" href={KEYS_PATH} selected={route.name === "keys"} />
			) : null}
			{members ? (
				<SidebarItem icon={<PeopleIcon />} label="Members" href={MEMBERS_PATH} selected={route.name === "members"} />
			) : null}
		</SidebarSection>
	);
}

/**
 * The shell's frame with nothing in it yet, shown while the console learns who is signed in, so a page load never
 * starts on a page-wide spinner. The pane follows the address, so a phone opening a session doesn't show the list first.
 */
export function ShellPlaceholder() {
	const route = parseRoute(location.pathname);
	const pane = route.name === "home" || route.name === "project" ? "list" : "main";
	// The rail, if that's how it was left, so the frame doesn't jump wide then narrow when the console arrives.
	const sidebar = useSidebarCollapse(!useMedia(NARROW_QUERY));
	return (
		<div className="shell hb-app" data-pane={pane} data-sidebar={sidebar.collapsed ? "collapsed" : undefined}>
			<Sidebar
				className="shell-sidebar"
				collapsed={sidebar.collapsed}
				role="complementary"
				aria-label="Projects and sessions"
				head={<SidebarBrand>Harbour</SidebarBrand>}
			>
				<SidebarSection label="Projects">
					{sidebar.collapsed ? null : <SessionList sessions={[]} loading />}
				</SidebarSection>
			</Sidebar>
			<main className="shell-main" aria-busy="true" />
		</div>
	);
}

export function App({
	client,
	vault,
	audit,
	keys,
	members,
	agent,
	schedules,
	oversightPending = false,
	onOpen,
}: {
	client: ConsoleClient;
	/**
	 * True while the organisation's pages (vault, audit log, schedules) are still being asked about: their paths wait
	 * rather than say there's nothing there, and the rest of the console doesn't wait for them.
	 */
	oversightPending?: boolean;
	/** The vault page's seam; without it there's no Vault in the sidebar. */
	vault?: ConsoleVault;
	/** The audit view's seam; without it there's no Audit log in the sidebar. */
	audit?: ConsoleAudit;
	/** The API keys page's seam; without it there's no API keys in the sidebar. */
	keys?: ConsoleKeys;
	/** The members page's seam, for an organisation admin; without it there's no Members in the sidebar. */
	members?: ConsoleMembers;
	/** The skills and memory pages' seam; without it there's no Agent section in the sidebar. */
	agent?: ConsoleAgent;
	/** The schedules page's seam; without it there's no Schedules in the sidebar. */
	schedules?: ConsoleSchedules;
	onOpen?: (sessionId: string, session: SessionClient) => void;
}) {
	const pathname = usePathname();
	const route = parseRoute(pathname);
	const narrow = useMedia(NARROW_QUERY);
	const { projects, error: projectsError } = useProjects(client);

	const projectId =
		route.name === "project" || route.name === "session" || route.name === "files" || route.name === "new-session"
			? route.projectId
			: undefined;
	const sessionId = route.name === "session" || route.name === "files" ? route.sessionId : undefined;
	// A link to a session by its ID alone (a schedule's run): its project is read, then the link becomes its path.
	const linkedSession = route.name === "session-link" ? route.sessionId : undefined;
	const project = projects?.find((candidate) => candidate.id === projectId);
	// The project the sidebar keeps open: the route's, or on a page outside projects (skills, the vault) the last one
	// visited, or else the first, so a project's sessions are always a click away.
	const [lastProjectId, setLastProjectId] = useState<string>();
	useEffect(() => {
		if (project !== undefined) setLastProjectId(project.id);
	}, [project]);
	const treeProject =
		project ??
		(projectId === undefined
			? (projects?.find((candidate) => candidate.id === lastProjectId) ?? projects?.[0])
			: undefined);
	// The list starts with the page, beside the projects, rather than after them; an unknown project stops it.
	const list = useSessionList(
		client,
		projectId === undefined ? treeProject?.id : projects === undefined || project !== undefined ? projectId : undefined,
	);
	const [sessionsHidden, setSessionsHidden] = useState(false);
	const toggleSessions = useCallback(() => setSessionsHidden((hidden) => !hidden), []);
	const sidebar = useSidebarCollapse(!narrow);
	const [live, setLive] = useState<LiveSummary>();
	const sessionProject = useSessionProject(client, sessionId ?? linkedSession);
	const lineage = useLineage(client, route.name === "session" ? sessionId : undefined);
	// A subagent's session isn't listed (it's reached from its card), so it gets no live row of its own while open.
	const subagentOpen = lineage.length > 0;
	const sessions = useMemo(
		() => withLive(list.sessions, subagentOpen ? undefined : live),
		[list.sessions, live, subagentOpen],
	);
	// The session's top bar: the project, then the sessions above a subagent's, each a link back to its level.
	const parents = useMemo((): readonly Crumb[] | undefined => {
		if (projectId === undefined) return undefined;
		return [
			{ key: "project", label: project?.name ?? "Project", href: projectPath(projectId) },
			...lineage.map((parent) => ({ key: parent.id, label: parent.title, href: sessionPath(projectId, parent.id) })),
		];
	}, [projectId, project?.name, lineage]);

	// In-app links navigate without reloading the page.
	useEffect(() => interceptLinks(document.body), []);

	// The home page is the first project.
	useEffect(() => {
		const first = projects?.[0];
		if (route.name === "home" && first !== undefined) navigate(projectPath(first.id), { replace: true });
	}, [route.name, projects]);

	// A session linked by its ID alone goes to its path once its project is known.
	useEffect(() => {
		if (linkedSession === undefined || sessionProject === "pending" || sessionProject === undefined) return;
		navigate(sessionPath(sessionProject, linkedSession), { replace: true });
	}, [linkedSession, sessionProject]);

	const treeProjectId = treeProject?.id;
	const hrefFor = useCallback((id: string) => sessionPath(treeProjectId ?? "", id), [treeProjectId]);
	const back = useCallback(() => navigate(projectPath(projectId ?? "")), [projectId]);
	const toFiles = useCallback(
		() => sessionId !== undefined && navigate(filesPath(projectId ?? "", sessionId)),
		[projectId, sessionId],
	);
	/** A fork is a session in the same project: it opens in place of the one it came from. */
	const toFork = useCallback((forkId: string) => navigate(sessionPath(projectId ?? "", forkId)), [projectId]);

	if (projectsError !== undefined)
		return (
			<div className="boot hb-app">
				<Notice level="error">{projectsError}</Notice>
			</div>
		);
	// Until the projects come the shell is shown as it will be, with what doesn't need them (an open session) in place.
	const projectsKnown = projects !== undefined;
	const projectList = projects ?? [];
	const unknownProject = projectsKnown && projectId !== undefined && project === undefined;
	// The organisation's pages, when the console has their seams; without one the path is not found.
	const vaultRoute = vault !== undefined && (route.name === "vault" || route.name === "vault-request");
	const auditRoute = audit !== undefined && route.name === "audit";
	const keysRoute = keys !== undefined && route.name === "keys";
	const membersRoute = members !== undefined && route.name === "members";
	const schedulesRoute = schedules !== undefined && route.name === "schedules";
	const agentRoute = agent !== undefined && (route.name === "skills" || route.name === "memory");
	const organisationPage = vaultRoute || auditRoute || keysRoute || membersRoute || schedulesRoute || agentRoute;
	const organisationRoute =
		route.name === "vault" ||
		route.name === "vault-request" ||
		route.name === "audit" ||
		route.name === "keys" ||
		route.name === "members" ||
		route.name === "schedules" ||
		route.name === "skills" ||
		route.name === "memory";
	// An organisation page whose seam may still come: shown once it does, not called missing meanwhile.
	const organisationWaiting = organisationRoute && !organisationPage && oversightPending;
	const missing =
		route.name === "not-found" ||
		(linkedSession !== undefined && sessionProject === undefined) ||
		(organisationRoute && !organisationPage && !oversightPending);
	const unknownSession =
		sessionId !== undefined && project !== undefined && sessionProject !== "pending" && sessionProject !== projectId;

	// A way back for an error, which on a phone fills the screen: the project's list, or the first project's.
	const way = project ?? projectList[0];
	const wayBack =
		way === undefined ? undefined : (
			<ListRow title={`Go to ${way.name}`} href={projectPath(way.id)} density="compact" />
		);

	// On a phone an organisation page fills the screen, so it gets a way back to the list.
	const pageBar = narrow ? (
		<div className="shell-page-bar">
			<Button size="sm" variant="ghost" onClick={() => navigate(way === undefined ? "/" : projectPath(way.id))}>
				Back to sessions
			</Button>
		</div>
	) : null;

	let main: ReactNode;
	if (vaultRoute && vault !== undefined) {
		main = (
			<div className="shell-page">
				{pageBar}
				<VaultScreen
					key={route.name === "vault-request" ? route.proposalId : "grants"}
					vault={vault}
					{...(route.name === "vault-request" ? { proposalId: route.proposalId } : {})}
				/>
			</div>
		);
	} else if (auditRoute && audit !== undefined) {
		main = (
			<div className="shell-page">
				{pageBar}
				<AuditScreen audit={audit} />
			</div>
		);
	} else if (keysRoute && keys !== undefined) {
		main = (
			<div className="shell-page">
				{pageBar}
				<ApiKeysPage
					api={keys.api}
					roles={keys.roles}
					projects={projectList.map((candidate) => ({ id: candidate.id, name: candidate.name }))}
				/>
			</div>
		);
	} else if (membersRoute && members !== undefined) {
		main = (
			<div className="shell-page">
				{pageBar}
				<MembersPage api={members.api} viewer={members.viewer} />
			</div>
		);
	} else if (agentRoute && agent !== undefined && route.name === "skills") {
		main = (
			<div className="shell-page">
				{pageBar}
				<SkillsScreen
					agent={agent}
					projects={projectList}
					{...(route.skillId === undefined ? {} : { skillId: route.skillId })}
				/>
			</div>
		);
	} else if (agentRoute && agent !== undefined && route.name === "memory") {
		main = (
			<div className="shell-page">
				{pageBar}
				<MemoryScreen
					agent={agent}
					projects={projectList}
					{...(route.conceptId === undefined ? {} : { conceptId: route.conceptId })}
				/>
			</div>
		);
	} else if (schedulesRoute && schedules !== undefined && route.name === "schedules") {
		main = (
			<div className="shell-page">
				{pageBar}
				<SchedulesScreen
					schedules={schedules}
					{...(route.scheduleId === undefined ? {} : { scheduleId: route.scheduleId })}
					creating={route.creating === true}
				/>
			</div>
		);
	} else if (organisationWaiting || (!projectsKnown && (route.name === "home" || route.name === "new-session"))) {
		// Moments from now: the page's seam, or the projects the home page and New session need. Nothing to show yet.
		main = <div className="shell-empty" aria-busy="true" />;
	} else if (linkedSession !== undefined && sessionProject !== undefined) {
		main = (
			<div className="shell-empty">
				<Spinner label="Opening the session" />
			</div>
		);
	} else if (missing || unknownProject) {
		main = (
			<div className="shell-empty">
				<EmptyState title="There's nothing here" action={wayBack}>
					Pick a project or a session from the list.
				</EmptyState>
			</div>
		);
	} else if (unknownSession) {
		main = (
			<div className="shell-empty">
				<EmptyState title="There's no such session in this project" action={wayBack}>
					It may have been in another project.
				</EmptyState>
			</div>
		);
	} else if (route.name === "new-session") {
		main = (
			<NewSessionScreen
				client={client}
				projectId={route.projectId}
				projects={projectList}
				{...(narrow ? { onBack: back } : {})}
			/>
		);
	} else if (route.name === "files") {
		main = (
			<FilesScreen
				key={route.sessionId}
				client={client}
				projectId={route.projectId}
				sessionId={route.sessionId}
				project={project?.name}
				path={route.path}
				narrow={narrow}
			/>
		);
	} else if (sessionId !== undefined) {
		main = (
			<SessionScreen
				key={sessionId}
				client={client}
				sessionId={sessionId}
				{...(parents === undefined ? {} : { parents })}
				onBack={narrow ? back : undefined}
				onFiles={toFiles}
				onForked={toFork}
				onOpen={onOpen}
				onLive={setLive}
				subagentHref={hrefFor}
			/>
		);
	} else {
		main = (
			<div className="shell-empty">
				{project !== undefined && client.mayStart(project.id).allowed ? (
					<EmptyState
						title="No session open"
						action={<ListRow title="New session" href={newSessionPath(project.id)} density="compact" />}
					>
						Pick a session from the list to watch it, or start a new one.
					</EmptyState>
				) : (
					<EmptyState title="No session open">Pick a session from the list to watch it.</EmptyState>
				)}
			</div>
		);
	}

	const newSession = route.name === "new-session" && project !== undefined;
	const pane =
		sessionId !== undefined ||
		linkedSession !== undefined ||
		newSession ||
		missing ||
		unknownProject ||
		organisationPage ||
		organisationWaiting
			? "main"
			: "list";
	// On a phone the list is the page, so it becomes the main landmark. By role, not by element: a different element
	// would remount the sidebar, losing its focus and scroll.
	const listIsPage = narrow && pane === "list";
	const sidebarRole = listIsPage ? { role: "main" } : { role: "complementary", "aria-label": "Projects and sessions" };
	// The page's heading, for a screen reader, wherever the session header's isn't on screen.
	// The vault page, the audit log and API keys bring their own headings.
	const title =
		organisationPage || organisationWaiting
			? undefined
			: missing || unknownProject
				? "Page not found"
				: unknownSession
					? "Session not found"
					: sessionId === undefined && !newSession
						? `${project?.name ?? "Harbour"} sessions`
						: undefined;
	const heading = title === undefined ? null : <h1 className="hb-sr-only">{title}</h1>;
	const start = treeProject === undefined ? undefined : client.mayStart(treeProject.id);
	const startBlocked = start === undefined || start.allowed ? {} : { disabledReason: start.reason };
	const newSessionHref =
		treeProject !== undefined && start?.allowed === true ? newSessionPath(treeProject.id) : undefined;

	return (
		<div className="shell hb-app" data-pane={pane} data-sidebar={sidebar.collapsed ? "collapsed" : undefined}>
			<Sidebar
				id="shell-sidebar"
				className="shell-sidebar"
				collapsed={sidebar.collapsed}
				{...sidebarRole}
				head={
					<>
						{listIsPage ? heading : null}
						<SidebarBrand>Harbour</SidebarBrand>
						{narrow ? null : (
							<SidebarToggle
								collapsed={sidebar.collapsed}
								onToggle={sidebar.toggle}
								controls="shell-sidebar"
								shortcut={sidebarShortcut()}
							/>
						)}
					</>
				}
				foot={
					<>
						<AgentNav route={route} agent={agent !== undefined} />
						<OrganisationNav
							route={route}
							schedules={schedules !== undefined}
							vault={vault !== undefined}
							audit={audit !== undefined}
							keys={keys !== undefined}
							members={members !== undefined}
						/>
						<div className="shell-actor">
							<Actor actor={client.actor} />
						</div>
					</>
				}
			>
				{/* On the rail the sessions are hidden, so New session gets an icon of its own. */}
				{sidebar.collapsed && newSessionHref !== undefined ? (
					<SidebarSection label="Start" heading={false}>
						<SidebarItem
							icon={<PlusIcon />}
							label="New session"
							href={newSessionHref}
							selected={route.name === "new-session"}
						/>
					</SidebarSection>
				) : null}
				<ProjectNav
					projects={projectList}
					current={treeProject?.id ?? projectId}
					selected={route.name === "project"}
					open={!sessionsHidden}
					onToggle={toggleSessions}
					{...(newSessionHref === undefined ? {} : { newSession: newSessionHref })}
				>
					{treeProject === undefined ? null : (
						<>
							<NewSessionRow
								href={newSessionPath(treeProject.id)}
								selected={route.name === "new-session"}
								{...startBlocked}
							/>
							<SessionList
								sessions={sessions}
								selectedId={sessionId}
								hrefFor={hrefFor}
								loading={list.loading}
								error={list.error}
								empty={
									<EmptyState title="No sessions in this project yet">
										Sessions started here, by you or a schedule, show up as they run.
									</EmptyState>
								}
							/>
						</>
					)}
				</ProjectNav>
			</Sidebar>
			{listIsPage ? null : (
				<main className="shell-main">
					{heading}
					{main}
				</main>
			)}
		</div>
	);
}
