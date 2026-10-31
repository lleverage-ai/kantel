// GitHub's service page (#461), in words and choices: which of its three states it is in, which connection leads it,
// what the GitHub App may do, what the connection reaches, and the prompts that try it in a session.

import { GITHUB_APP_PERMISSIONS } from "@kantel/contracts";
import {
	type Connection,
	type ConnectionReachView,
	type ConnectionsViewer,
	connectionsFor,
	connectRoute,
	type GitHubAppState,
	type GitHubAppView,
	type ProviderTemplate,
} from "./connections-model.ts";

/**
 * GitHub's page has one primary action in each state:
 * - `not_set_up`: no app to sign in through yet. Set up the organisation's GitHub App.
 * - `app_made`: an app is there to sign in through. Install it on repositories, then connect.
 * - `connected`: a GitHub connection the viewer can see. The page leads with it.
 */
export type GitHubPageState = "not_set_up" | "app_made" | "connected";

export function gitHubPageState(
	template: ProviderTemplate,
	connections: readonly Connection[],
	made?: GitHubAppState,
): GitHubPageState {
	if (connectionsFor(connections, template.id).length > 0) return "connected";
	if (connectRoute(template) === "one_click" || made?.status === "created") return "app_made";
	return "not_set_up";
}

/** The GitHub App behind the page: the client the catalogue resolves to, else the one GitHub just made. */
export function gitHubAppOf(template: ProviderTemplate, made?: GitHubAppState): GitHubAppView | undefined {
	if (template.client?.githubApp !== undefined) return template.client.githubApp;
	return made?.status === "created" ? made.client.githubApp : undefined;
}

/**
 * The connection GitHub's page leads with: the viewer's own, then their open project's, then the organisation's, then
 * any other they can see. Needing attention never moves one down: its page says so.
 */
export function leadConnection(connections: readonly Connection[], viewer: ConnectionsViewer): Connection | undefined {
	const github = connectionsFor(connections, "github");
	const rank = (connection: Connection): number => {
		const { owner } = connection;
		if (owner.kind === "user") return owner.userId === viewer.userId ? 0 : 3;
		if (owner.kind === "project") return owner.projectId === viewer.projectId ? 1 : 3;
		return 2;
	};
	return [...github].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The project "Try it" starts a session in: the connection's own project; for a person's, a project it's shared with
 * (the open one first), else the open project; for the organisation's, the open project where it may be used. Else the
 * viewer's first project.
 */
export function tryProject(connection: Connection, viewer: ConnectionsViewer): string | undefined {
	const open = viewer.projectId;
	const first = viewer.projects[0]?.id;
	switch (connection.owner.kind) {
		case "project":
			return connection.owner.projectId;
		case "user": {
			const shared = (connection.shares ?? []).map((share) => share.projectId);
			if (open !== undefined && shared.includes(open)) return open;
			return shared[0] ?? open ?? first;
		}
		case "organisation": {
			const only = connection.onlyProjects ?? [];
			if (only.length > 0) return open !== undefined && only.includes(open) ? open : only[0];
			return open ?? first;
		}
	}
}

/** Suggested first prompts for a GitHub connection, naming a repository it reaches when one is known. */
export function tryPrompts(reach?: ConnectionReachView): readonly string[] {
	const repository = reach?.repositories[0]?.fullName.split("/")[1];
	return [
		"What pull requests did I open this week?",
		repository === undefined
			? "Why did the last Actions run fail?"
			: `Why did the last Actions run on ${repository} fail?`,
		"List the issues assigned to me",
	];
}

const PERMISSION_LABELS: Readonly<Record<keyof typeof GITHUB_APP_PERMISSIONS, string>> = {
	contents: "Code and branches",
	issues: "Issues",
	pull_requests: "Pull requests",
	actions: "Actions runs",
	metadata: "Repository details",
	members: "Organisation members",
};

/** One of the GitHub App's permissions, read only: GitHub sets them from Kantel's manifest. */
export interface AppPermission {
	readonly id: string;
	readonly label: string;
	readonly access: "read" | "write";
}

/** The GitHub App's permissions, writes first: what a sign-in through it may do at most. */
export function appPermissions(): readonly AppPermission[] {
	const all = Object.entries(GITHUB_APP_PERMISSIONS).map(([id, access]) => ({
		id,
		label: PERMISSION_LABELS[id as keyof typeof GITHUB_APP_PERMISSIONS],
		access,
	}));
	return [...all.filter((p) => p.access === "write"), ...all.filter((p) => p.access === "read")];
}

/** "40 repositories", "1 repository": every one GitHub counts, listed or not. */
export function repositoryCount(reach: ConnectionReachView): string {
	const count = Math.max(reach.total, reach.repositories.length);
	return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

/** Whose they are: "32 tvdavies, 8 lleverage-ai". Empty for none. */
export function ownerCounts(reach: ConnectionReachView): string {
	return reach.owners.map((owner) => `${owner.repositories} ${owner.login}`).join(", ");
}
