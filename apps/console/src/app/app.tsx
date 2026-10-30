import {
	ApiKeysPage,
	Badge,
	BookIcon,
	Button,
	ClockIcon,
	ConnectionsPage,
	type Crumb,
	EmptyState,
	FileTextIcon,
	IconButton,
	ImageIcon,
	KeyIcon,
	LayersIcon,
	ListIcon,
	ListRow,
	MembersPage,
	NewSessionRow,
	Notice,
	PeopleIcon,
	PlugIcon,
	PlusIcon,
	SessionList,
	type SessionMenuActions,
	SharingPage,
	ShieldIcon,
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
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type ConsoleActor,
	type ConsoleClient,
	isOrganisationScope,
	ORGANISATION_ENTRY,
	type ProjectSummary,
	type SessionListState,
} from "../api/client.ts";
import type { ConsoleMembers } from "../api/members.ts";
import type { ConsoleModels } from "../api/models-http.ts";
import type {
	ConsoleAgent,
	ConsoleAudit,
	ConsoleConnections,
	ConsoleKeys,
	ConsoleSchedules,
	ConsoleSharing,
	ConsoleVault,
} from "../api/oversight.ts";
import type { ConsoleRules } from "../api/rules-http.ts";
import { type LiveSummary, withLive } from "../state/live-summary.ts";
import type { SessionClient } from "../state/session-client.ts";
import { BOOT, SHELL_EMPTY, SHELL_PAGE_BAR, shellClasses, shellPage } from "../ui/shell-styles.ts";
import { MemoryScreen, SkillsScreen } from "./agent-screens.tsx";
import { AuditScreen } from "./audit-screen.tsx";
import { FilesScreen } from "./files-screen.tsx";
import { useLineage } from "./lineage.ts";
import { ModelsScreen } from "./models-screen.tsx";
import { NewSessionScreen } from "./new-session-screen.tsx";
import {
	AUDIT_PATH,
	CONNECTIONS_PATH,
	filesPath,
	interceptLinks,
	KEYS_PATH,
	MEMBERS_PATH,
	memoryPath,
	modelsPath,
	navigate,
	newSessionPath,
	parseRoute,
	projectPath,
	type Route,
	RULES_PATH,
	SHARING_PATH,
	schedulesPath,
	sessionPath,
	skillsPath,
	usePathname,
	VAULT_PATH,
} from "./router.ts";
import { RulesScreen } from "./rules-screen.tsx";
import { SchedulesScreen } from "./schedules-screen.tsx";
import { SessionScreen } from "./session-screen.tsx";
import { ThemeButton, ThemeSwitcher } from "./theme.tsx";
import { NARROW_QUERY, useMedia } from "./use-media.ts";
import { useSessionView } from "./use-session-view.ts";
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
			actions={<ThemeButton />}
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

/**
 * The agent's skills and memory, shown when the console has a seam for them, and the open project's Models page when it
 * has the models seam.
 */
function AgentNav({ route, agent, modelsHref }: { route: Route; agent: boolean; modelsHref: string | undefined }) {
	if (!agent && modelsHref === undefined) return null;
	return (
		<SidebarSection label="Agent">
			{agent ? (
				<>
					<SidebarItem icon={<BookIcon />} label="Skills" href={skillsPath()} selected={route.name === "skills"} />
					<SidebarItem icon={<LayersIcon />} label="Memory" href={memoryPath()} selected={route.name === "memory"} />
				</>
			) : null}
			{modelsHref === undefined ? null : (
				<SidebarItem icon={<ImageIcon />} label="Models" href={modelsHref} selected={route.name === "models"} />
			)}
		</SidebarSection>
	);
}

/**
 * The organisation's pages: schedules, prompt rules, the vault, the audit log and API keys, each shown when the
 * console has a seam for it.
 */
function OrganisationNav({
	route,
	schedules,
	sharing = false,
	connections = false,
	rules = false,
	vault,
	audit,
	keys,
	members = false,
}: {
	route: Route;
	schedules: boolean;
	sharing?: boolean;
	connections?: boolean;
	rules?: boolean;
	vault: boolean;
	audit: boolean;
	keys: boolean;
	members?: boolean;
}) {
	if (!schedules && !sharing && !connections && !rules && !vault && !audit && !keys && !members) return null;
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
			{connections ? (
				<SidebarItem
					icon={<PlugIcon />}
					label="Connections"
					href={CONNECTIONS_PATH}
					selected={route.name === "connections"}
				/>
			) : null}
			{sharing ? (
				<SidebarItem icon={<ShieldIcon />} label="Sharing" href={SHARING_PATH} selected={route.name === "sharing"} />
			) : null}
			{rules ? (
				<SidebarItem icon={<FileTextIcon />} label="Rules" href={RULES_PATH} selected={route.name === "rules"} />
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
	const narrow = useMedia(NARROW_QUERY);
	const sidebar = useSidebarCollapse(!narrow);
	const classes = shellClasses({ narrow, collapsed: sidebar.collapsed, pane });
	return (
		<div className={classes.shell} data-pane={pane} data-sidebar={sidebar.collapsed ? "collapsed" : undefined}>
			<Sidebar
				className={classes.sidebar}
				collapsed={sidebar.collapsed}
				role="complementary"
				aria-label="Projects and sessions"
				head={<SidebarBrand>Harbour</SidebarBrand>}
			>
				<SidebarSection label="Projects">
					{sidebar.collapsed ? null : <SessionList sessions={[]} loading />}
				</SidebarSection>
			</Sidebar>
			<main className={classes.main} aria-busy="true" />
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
	sharing,
	connections,
	models,
	rules,
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
	/** The sharing page's seam; without it there's no Sharing in the sidebar. */
	sharing?: ConsoleSharing;
	/** The Connections page's seam (#339); without it there's no Connections in the sidebar. */
	connections?: ConsoleConnections;
	/** The Models page's seam (connectors and the agent's image model); without it there's no Models in the sidebar. */
	models?: ConsoleModels;
	/** The Rules page's seam (prompt rules); without it there's no Rules in the sidebar. */
	rules?: ConsoleRules;
	onOpen?: (sessionId: string, session: SessionClient) => void;
}) {
	const pathname = usePathname();
	const route = parseRoute(pathname);
	const narrow = useMedia(NARROW_QUERY);
	const { projects, error: projectsError } = useProjects(client);
	// Where sessions run: the organisation, when the client serves organisation sessions, then the projects. The tree,
	// New session's picker and a route's `projectId` take the organisation as one more project (`ORGANISATION_SCOPE`).
	const scopes = useMemo(
		() =>
			projects === undefined || client.organisationSessions !== true ? projects : [ORGANISATION_ENTRY, ...projects],
		[projects, client.organisationSessions],
	);

	const projectId =
		route.name === "project" ||
		route.name === "session" ||
		route.name === "files" ||
		route.name === "new-session" ||
		route.name === "models"
			? route.projectId
			: undefined;
	const sessionId = route.name === "session" || route.name === "files" ? route.sessionId : undefined;
	// A link to a session by its ID alone (a schedule's run): its project is read, then the link becomes its path.
	const linkedSession = route.name === "session-link" ? route.sessionId : undefined;
	const project = scopes?.find((candidate) => candidate.id === projectId);
	// The project the sidebar keeps open: the route's, or on a page outside projects (skills, the vault) the last one
	// visited, or else the first, so a project's sessions are always a click away.
	const [lastProjectId, setLastProjectId] = useState<string>();
	useEffect(() => {
		if (project !== undefined) setLastProjectId(project.id);
	}, [project]);
	const treeProject =
		project ??
		(projectId === undefined
			? (scopes?.find((candidate) => candidate.id === lastProjectId) ?? projects?.[0])
			: undefined);
	// The Models page is a project's: the one open, or else the first.
	const modelsProject = treeProject !== undefined && !isOrganisationScope(treeProject.id) ? treeProject : projects?.[0];
	const inOrganisation = isOrganisationScope(treeProject?.id ?? projectId);
	// The list starts with the page, beside the projects, rather than after them; an unknown project stops it.
	const list = useSessionList(
		client,
		projectId === undefined ? treeProject?.id : projects === undefined || project !== undefined ? projectId : undefined,
	);
	const [sessionsHidden, setSessionsHidden] = useState(false);
	const toggleSessions = useCallback(() => setSessionsHidden((hidden) => !hidden), []);
	const sidebar = useSidebarCollapse(!narrow);
	const [live, setLive] = useState<LiveSummary>();
	const sessionView = useSessionView();
	// The open session and its project, for Delete to leave a session that's on screen. A ref, so the menu's actions
	// stay one object and the list's rows don't re-render.
	const onScreen = useRef<{ sessionId?: string; projectId?: string }>({});
	onScreen.current = {
		...(sessionId === undefined ? {} : { sessionId }),
		...(projectId === undefined ? {} : { projectId }),
	};
	const menuActions = useMemo((): SessionMenuActions | undefined => {
		const { updateSession, deleteSession } = client;
		if (updateSession === undefined || deleteSession === undefined) return undefined;
		const update = updateSession.bind(client);
		return {
			setUnread: (id, unread) => update(id, { unread }),
			setPinned: (id, pinned) => update(id, { pinned }),
			setArchived: (id, archived) => update(id, { archived }),
			rename: (id, title) => update(id, { title }),
			remove: async (id) => {
				await deleteSession.call(client, id);
				const shown = onScreen.current;
				if (shown.sessionId === id && shown.projectId !== undefined) {
					navigate(projectPath(shown.projectId), { replace: true });
				}
			},
		};
	}, [client]);
	const sessionProject = useSessionProject(client, sessionId ?? linkedSession);
	const lineage = useLineage(client, route.name === "session" ? sessionId : undefined);
	// The open session's live state goes into the list once it's known to be a top-level session: a subagent's isn't
	// listed, and its parent shows it working through its card.
	const listedLive = lineage?.length === 0 ? live : undefined;
	const sessions = useMemo(() => withLive(list.sessions, listedLive), [list.sessions, listedLive]);
	// The session's top bar: the project, then the sessions above a subagent's, each a link back to its level.
	const parents = useMemo((): readonly Crumb[] | undefined => {
		if (projectId === undefined) return undefined;
		return [
			{ key: "project", label: project?.name ?? "Project", href: projectPath(projectId) },
			...(lineage ?? []).map((parent) => ({
				key: parent.id,
				label: parent.title,
				href: sessionPath(projectId, parent.id),
			})),
		];
	}, [projectId, project?.name, lineage]);
	// A subagent's session is under the top-level session it came from: that's the row the list marks.
	const listedId = lineage?.[0]?.id ?? sessionId;
	// Back, on a phone, goes up a level: from a subagent to the session that started it, from a session to the list.
	const parentId = lineage?.at(-1)?.id;

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
	const back = useCallback(
		() => navigate(parentId === undefined ? projectPath(projectId ?? "") : sessionPath(projectId ?? "", parentId)),
		[projectId, parentId],
	);
	const toFiles = useCallback(
		(path?: string) => sessionId !== undefined && navigate(filesPath(projectId ?? "", sessionId, path)),
		[projectId, sessionId],
	);
	/** A fork is a session in the same project: it opens in place of the one it came from. */
	const toFork = useCallback((forkId: string) => navigate(sessionPath(projectId ?? "", forkId)), [projectId]);

	if (projectsError !== undefined)
		return (
			<div className={BOOT}>
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
	const rulesRoute = rules !== undefined && route.name === "rules";
	const agentRoute = agent !== undefined && (route.name === "skills" || route.name === "memory");
	const sharingRoute = sharing !== undefined && route.name === "sharing";
	const connectionsRoute = connections !== undefined && route.name === "connections";
	const organisationPage =
		vaultRoute ||
		auditRoute ||
		keysRoute ||
		membersRoute ||
		schedulesRoute ||
		sharingRoute ||
		connectionsRoute ||
		rulesRoute ||
		agentRoute;
	const organisationRoute =
		route.name === "rules" ||
		route.name === "vault" ||
		route.name === "vault-request" ||
		route.name === "audit" ||
		route.name === "keys" ||
		route.name === "members" ||
		route.name === "schedules" ||
		route.name === "sharing" ||
		route.name === "connections" ||
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
	const page = shellPage(narrow);
	const pageBar = narrow ? (
		<div className={SHELL_PAGE_BAR}>
			<Button size="sm" variant="ghost" onClick={() => navigate(way === undefined ? "/" : projectPath(way.id))}>
				Back to sessions
			</Button>
		</div>
	) : null;

	let main: ReactNode;
	if (vaultRoute && vault !== undefined) {
		main = (
			<div className={page}>
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
			<div className={page}>
				{pageBar}
				<AuditScreen audit={audit} />
			</div>
		);
	} else if (keysRoute && keys !== undefined) {
		main = (
			<div className={page}>
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
			<div className={page}>
				{pageBar}
				<MembersPage api={members.api} viewer={members.viewer} />
			</div>
		);
	} else if (agentRoute && agent !== undefined && route.name === "skills") {
		main = (
			<div className={page}>
				{pageBar}
				<SkillsScreen
					agent={agent}
					projects={projectList}
					{...(route.skillId === undefined ? {} : { skillId: route.skillId })}
					{...(sharing === undefined ? {} : { sharing })}
				/>
			</div>
		);
	} else if (agentRoute && agent !== undefined && route.name === "memory") {
		main = (
			<div className={page}>
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
			<div className={page}>
				{pageBar}
				<SchedulesScreen
					schedules={schedules}
					{...(route.scheduleId === undefined ? {} : { scheduleId: route.scheduleId })}
					creating={route.creating === true}
				/>
			</div>
		);
	} else if (sharingRoute && sharing !== undefined) {
		main = (
			<div className={page}>
				{pageBar}
				<SharingPage
					source={sharing.source}
					projects={sharing.projects}
					directory={sharing.directory}
					{...(treeProject !== undefined && sharing.projects.some((shown) => shown.id === treeProject.id)
						? { initialProjectId: treeProject.id }
						: {})}
					{...(sharing.now === undefined ? {} : { now: sharing.now })}
				/>
			</div>
		);
	} else if (connectionsRoute && connections !== undefined) {
		main = (
			<div className={page}>
				{pageBar}
				<ConnectionsPage
					source={connections.source}
					viewer={connections.viewer}
					redirectUri={connections.redirectUri}
					{...(connections.people === undefined ? {} : { people: connections.people })}
					{...(connections.now === undefined ? {} : { now: connections.now })}
				/>
			</div>
		);
	} else if (rulesRoute && rules !== undefined) {
		main = (
			<div className={page}>
				{pageBar}
				<RulesScreen rules={rules} projects={projectList} />
			</div>
		);
	} else if (organisationWaiting || (!projectsKnown && (route.name === "home" || route.name === "new-session"))) {
		// Moments from now: the page's seam, or the projects the home page and New session need. Nothing to show yet.
		main = <div className={SHELL_EMPTY} aria-busy="true" />;
	} else if (linkedSession !== undefined && sessionProject !== undefined) {
		main = (
			<div className={SHELL_EMPTY}>
				<Spinner label="Opening the session" />
			</div>
		);
	} else if (missing || unknownProject) {
		main = (
			<div className={SHELL_EMPTY}>
				<EmptyState title="There's nothing here" action={wayBack}>
					Pick a project or a session from the list.
				</EmptyState>
			</div>
		);
	} else if (unknownSession) {
		main = (
			<div className={SHELL_EMPTY}>
				<EmptyState title="There's no such session in this project" action={wayBack}>
					It may have been in another project.
				</EmptyState>
			</div>
		);
	} else if (route.name === "models") {
		main =
			models === undefined ? (
				<div className={SHELL_EMPTY}>
					<EmptyState title="There's nothing here" action={wayBack}>
						This console can't read the model gateway.
					</EmptyState>
				</div>
			) : (
				<div className={page}>
					{pageBar}
					<ModelsScreen key={route.projectId} client={client} models={models} projectId={route.projectId} />
				</div>
			);
	} else if (route.name === "new-session") {
		main = (
			<NewSessionScreen
				client={client}
				projectId={route.projectId}
				projects={scopes ?? []}
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
				{...(projectId === undefined ? {} : { projectId })}
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
			<div className={SHELL_EMPTY}>
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
		route.name === "models" ||
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
	const classes = shellClasses({ narrow, collapsed: sidebar.collapsed, pane });
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
		<div className={classes.shell} data-pane={pane} data-sidebar={sidebar.collapsed ? "collapsed" : undefined}>
			<Sidebar
				id="shell-sidebar"
				className={classes.sidebar}
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
						<AgentNav
							route={route}
							agent={agent !== undefined}
							modelsHref={
								models === undefined || modelsProject === undefined ? undefined : modelsPath(modelsProject.id)
							}
						/>
						<OrganisationNav
							route={route}
							schedules={schedules !== undefined}
							sharing={sharing !== undefined}
							connections={connections !== undefined}
							rules={rules !== undefined}
							vault={vault !== undefined}
							audit={audit !== undefined}
							keys={keys !== undefined}
							members={members !== undefined}
						/>
						<div className={classes.actor}>
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
					projects={scopes ?? []}
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
								selectedId={listedId}
								hrefFor={hrefFor}
								loading={list.loading}
								error={list.error}
								view={sessionView.view}
								onViewChange={sessionView.setView}
								{...(menuActions !== undefined && start?.allowed === true ? { menuActions } : {})}
								empty={
									inOrganisation ? (
										<EmptyState title="No organisation-wide sessions yet">
											A session here works across the organisation, with its skills, memory and files, in no project.
										</EmptyState>
									) : (
										<EmptyState title="No sessions in this project yet">
											Sessions started here, by you or a schedule, show up as they run.
										</EmptyState>
									)
								}
							/>
						</>
					)}
				</ProjectNav>
			</Sidebar>
			{listIsPage ? null : (
				<main className={classes.main}>
					{heading}
					{main}
				</main>
			)}
			<ThemeSwitcher {...(client.saveTheme === undefined ? {} : { onChoose: client.saveTheme })} />
		</div>
	);
}
