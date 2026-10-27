import { Badge, EmptyState, ListRow, Notice, SessionList, Spinner } from "@harbour/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { ConsoleClient, ProjectSummary, SessionListState } from "../api/client.ts";
import type { SessionClient } from "../state/session-client.ts";
import { interceptLinks, navigate, parseRoute, projectPath, sessionPath, usePathname } from "./router.ts";
import { SessionScreen } from "./session-screen.tsx";
import { NARROW_QUERY, useMedia } from "./use-media.ts";

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

export function App({
	client,
	onOpen,
}: {
	client: ConsoleClient;
	onOpen?: (sessionId: string, session: SessionClient) => void;
}) {
	const pathname = usePathname();
	const route = parseRoute(pathname);
	const narrow = useMedia(NARROW_QUERY);
	const { projects, error: projectsError } = useProjects(client);

	const projectId = route.name === "project" || route.name === "session" ? route.projectId : undefined;
	const sessionId = route.name === "session" ? route.sessionId : undefined;
	const project = projects?.find((candidate) => candidate.id === projectId);
	const list = useSessionList(client, project?.id);

	// In-app links navigate without reloading the page.
	useEffect(() => interceptLinks(document.body), []);

	// The home page is the first project.
	useEffect(() => {
		const first = projects?.[0];
		if (route.name === "home" && first !== undefined) navigate(projectPath(first.id), { replace: true });
	}, [route.name, projects]);

	const hrefFor = useCallback((id: string) => sessionPath(projectId ?? "", id), [projectId]);
	const back = useCallback(() => navigate(projectPath(projectId ?? "")), [projectId]);

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
	const unknownSession = sessionId !== undefined && project !== undefined && client.projectOf(sessionId) !== projectId;

	// A way back for an error, which on a phone fills the screen: the project's list, or the first project's.
	const way = project ?? projects[0];
	const wayBack =
		way === undefined ? undefined : (
			<ListRow title={`Go to ${way.name}`} href={projectPath(way.id)} density="compact" />
		);

	let main: ReactNode;
	if (route.name === "not-found" || unknownProject) {
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
	} else if (sessionId !== undefined) {
		main = (
			<SessionScreen
				key={sessionId}
				client={client}
				sessionId={sessionId}
				project={project?.name}
				onBack={narrow ? back : undefined}
				onOpen={onOpen}
			/>
		);
	} else {
		main = (
			<div className="shell-empty">
				<EmptyState title="No session open">Pick a session from the list to watch it.</EmptyState>
			</div>
		);
	}

	const pane = sessionId !== undefined || route.name === "not-found" || unknownProject ? "main" : "list";

	return (
		<div className="shell hb-app" data-pane={pane}>
			<aside className="shell-sidebar" aria-label="Projects and sessions">
				<div className="shell-brand">
					<span className="shell-wordmark">Harbour</span>
				</div>
				<ProjectNav projects={projects} current={projectId} />
				<div className="shell-sessions">
					<h2 className="shell-heading">{project === undefined ? "Sessions" : `${project.name} sessions`}</h2>
					<SessionList
						sessions={list.sessions}
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
				</div>
				<div className="shell-actor">
					<span className="shell-actor-name">{client.actor.name}</span>
					{client.actor.stubbed ? <Badge>Sign-in stubbed</Badge> : null}
				</div>
			</aside>
			<main className="shell-main">{main}</main>
		</div>
	);
}
