import {
	ApiKeysPage,
	Badge,
	Button,
	EmptyState,
	ListRow,
	NewSessionRow,
	Notice,
	SessionList,
	SignedInAs,
	Spinner,
} from "@harbour/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { ConsoleActor, ConsoleClient, ProjectSummary, SessionListState } from "../api/client.ts";
import type { ConsoleAudit, ConsoleKeys, ConsoleVault } from "../api/oversight.ts";
import { type LiveSummary, withLive } from "../state/live-summary.ts";
import type { SessionClient } from "../state/session-client.ts";
import { AuditScreen } from "./audit-screen.tsx";
import { FilesScreen } from "./files-screen.tsx";
import { NewSessionScreen } from "./new-session-screen.tsx";
import {
	AUDIT_PATH,
	filesPath,
	interceptLinks,
	KEYS_PATH,
	navigate,
	newSessionPath,
	parseRoute,
	projectPath,
	type Route,
	sessionPath,
	usePathname,
	VAULT_PATH,
} from "./router.ts";
import { SessionScreen } from "./session-screen.tsx";
import { NARROW_QUERY, useMedia } from "./use-media.ts";
import { VaultScreen } from "./vault-screen.tsx";

// The console's shell: projects and the current project's sessions in a sidebar, the open session beside it. On a
// phone it is one pane at a time: the list, or the session with Back. Every piece is from @harbour/ui; this file
// only decides what goes where.

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
		client.projects().then(
			(projects) => live && setState({ projects }),
			(reason: unknown) => live && setState({ error: String(reason) }),
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

function ProjectNav({ projects, current }: { projects: readonly ProjectSummary[]; current: string | undefined }) {
	return (
		<nav className="shell-projects" aria-label="Projects">
			<h2 className="shell-heading">Projects</h2>
			<ul className="shell-rows">
				{projects.map((project) => (
					<li key={project.id}>
						<ListRow title={project.name} href={projectPath(project.id)} selected={project.id === current} />
					</li>
				))}
			</ul>
		</nav>
	);
}

/** The organisation's pages: the vault, the audit log and API keys, each shown when the console has a seam for it. */
function OrganisationNav({
	route,
	vault,
	audit,
	keys,
}: {
	route: Route;
	vault: boolean;
	audit: boolean;
	keys: boolean;
}) {
	if (!vault && !audit && !keys) return null;
	return (
		<nav className="shell-organisation" aria-label="Organisation">
			<h2 className="shell-heading">Organisation</h2>
			<ul className="shell-rows">
				{vault ? (
					<li>
						<ListRow
							title="Vault"
							href={VAULT_PATH}
							selected={route.name === "vault" || route.name === "vault-request"}
						/>
					</li>
				) : null}
				{audit ? (
					<li>
						<ListRow title="Audit log" href={AUDIT_PATH} selected={route.name === "audit"} />
					</li>
				) : null}
				{keys ? (
					<li>
						<ListRow title="API keys" href={KEYS_PATH} selected={route.name === "keys"} />
					</li>
				) : null}
			</ul>
		</nav>
	);
}

export function App({
	client,
	vault,
	audit,
	keys,
	onOpen,
}: {
	client: ConsoleClient;
	/** The vault page's seam; without it there's no Vault in the sidebar. */
	vault?: ConsoleVault;
	/** The audit view's seam; without it there's no Audit log in the sidebar. */
	audit?: ConsoleAudit;
	/** The API keys page's seam; without it there's no API keys in the sidebar. */
	keys?: ConsoleKeys;
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
	const project = projects?.find((candidate) => candidate.id === projectId);
	const list = useSessionList(client, project?.id);
	const [live, setLive] = useState<LiveSummary>();
	const sessions = useMemo(() => withLive(list.sessions, live), [list.sessions, live]);
	const sessionProject = useSessionProject(client, sessionId);

	// In-app links navigate without reloading the page.
	useEffect(() => interceptLinks(document.body), []);

	// The home page is the first project.
	useEffect(() => {
		const first = projects?.[0];
		if (route.name === "home" && first !== undefined) navigate(projectPath(first.id), { replace: true });
	}, [route.name, projects]);

	const hrefFor = useCallback((id: string) => sessionPath(projectId ?? "", id), [projectId]);
	const back = useCallback(() => navigate(projectPath(projectId ?? "")), [projectId]);
	const toFiles = useCallback(
		() => sessionId !== undefined && navigate(filesPath(projectId ?? "", sessionId)),
		[projectId, sessionId],
	);

	if (projectsError !== undefined)
		return (
			<div className="boot hb-app">
				<Notice level="error">{projectsError}</Notice>
			</div>
		);
	if (projects === undefined)
		return (
			<div className="boot hb-app">
				<Spinner label="Opening the console" />
			</div>
		);

	const unknownProject = projectId !== undefined && project === undefined;
	// The organisation's pages, when the console has their seams; without one the path is not found.
	const vaultRoute = vault !== undefined && (route.name === "vault" || route.name === "vault-request");
	const auditRoute = audit !== undefined && route.name === "audit";
	const keysRoute = keys !== undefined && route.name === "keys";
	const organisationPage = vaultRoute || auditRoute || keysRoute;
	const missing =
		route.name === "not-found" ||
		((route.name === "vault" || route.name === "vault-request" || route.name === "audit" || route.name === "keys") &&
			!organisationPage);
	const unknownSession =
		sessionId !== undefined && project !== undefined && sessionProject !== "pending" && sessionProject !== projectId;

	// A way back for an error, which on a phone fills the screen: the project's list, or the first project's.
	const way = project ?? projects[0];
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
					projects={projects.map((candidate) => ({ id: candidate.id, name: candidate.name }))}
				/>
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
				projects={projects}
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
				project={project?.name}
				onBack={narrow ? back : undefined}
				onFiles={toFiles}
				onOpen={onOpen}
				onLive={setLive}
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
	const pane = sessionId !== undefined || newSession || missing || unknownProject || organisationPage ? "main" : "list";
	// On a phone the list is the page, so it becomes the main landmark. By role, not by element: a different element
	// would remount the sidebar, losing its focus and scroll.
	const listIsPage = narrow && pane === "list";
	const sidebarRole = listIsPage ? { role: "main" } : { role: "complementary", "aria-label": "Projects and sessions" };
	// The page's heading, for a screen reader, wherever the session header's isn't on screen.
	// The vault page, the audit log and API keys bring their own headings.
	const title = organisationPage
		? undefined
		: missing || unknownProject
			? "Page not found"
			: unknownSession
				? "Session not found"
				: sessionId === undefined && !newSession
					? `${project?.name ?? "Harbour"} sessions`
					: undefined;
	const heading = title === undefined ? null : <h1 className="hb-sr-only">{title}</h1>;
	const start = project === undefined ? undefined : client.mayStart(project.id);
	const startBlocked = start === undefined || start.allowed ? {} : { disabledReason: start.reason };

	return (
		<div className="shell hb-app" data-pane={pane}>
			<div className="shell-sidebar" {...sidebarRole}>
				{listIsPage ? heading : null}
				<div className="shell-brand">
					<span className="shell-wordmark">Harbour</span>
				</div>
				<ProjectNav projects={projects} current={projectId} />
				<OrganisationNav
					route={route}
					vault={vault !== undefined}
					audit={audit !== undefined}
					keys={keys !== undefined}
				/>
				{/* An organisation page belongs to no project, so there's no project's sessions to list beside it. */}
				<div className="shell-sessions">
					{organisationPage ? null : (
						<>
							<h2 className="shell-heading">{project === undefined ? "Sessions" : `${project.name} sessions`}</h2>
							{project === undefined ? null : (
								<NewSessionRow
									href={newSessionPath(project.id)}
									selected={route.name === "new-session"}
									{...startBlocked}
								/>
							)}
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
				</div>
				<div className="shell-actor">
					<Actor actor={client.actor} />
				</div>
			</div>
			{listIsPage ? null : (
				<main className="shell-main">
					{heading}
					{main}
				</main>
			)}
		</div>
	);
}
