/**
 * What a GitHub connection can reach (#461): the installations of the GitHub App its person can reach and their
 * repositories, read as the person (https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token).
 * A user-to-server token sees the repositories the app is installed on that the person can open themselves. The token
 * is opened for each request through `token`, so the vault records every one; nothing here keeps or returns it.
 */
import {
	type ConnectionReach,
	type ConnectionReachInstallation,
	type ConnectionReachRepository,
	KantelError,
	REACH_REPOSITORY_LIMIT,
} from "@kantel/contracts";
import type { Fetch } from "./ports.ts";

const API = "https://api.github.com";
const PAGE = 100;
/** Where a person sees the GitHub Apps installed on their account, when there's no one installation to point at. */
export const GITHUB_INSTALLATIONS_PAGE = "https://github.com/settings/installations";

export type GitHubReach = Omit<ConnectionReach, "connectionId" | "checkedAt">;

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

function installationOf(value: unknown): ConnectionReachInstallation | undefined {
	const item = record(value);
	const account = record(item?.account);
	if (typeof item?.id !== "number" || typeof account?.login !== "string") return undefined;
	const type = account.type === "Organization" ? "Organization" : "User";
	const manageUrl =
		type === "Organization"
			? `https://github.com/organizations/${encodeURIComponent(account.login)}/settings/installations/${item.id}`
			: `https://github.com/settings/installations/${item.id}`;
	return {
		id: item.id,
		account: { login: account.login, type },
		repositorySelection: item.repository_selection === "selected" ? "selected" : "all",
		manageUrl,
	};
}

function repositoryOf(value: unknown): ConnectionReachRepository | undefined {
	const item = record(value);
	const owner = record(item?.owner);
	if (typeof item?.full_name !== "string" || typeof owner?.login !== "string") return undefined;
	return { fullName: item.full_name, owner: owner.login, private: item.private === true };
}

/**
 * Reads the installations (the first hundred) and their repositories, a page at a time, until `REACH_REPOSITORY_LIMIT`
 * are listed. A refusal (401) says the connection must sign in again; any other failure is `unavailable`, with
 * GitHub's status and never its body.
 */
export async function readGitHubReach(input: {
	readonly fetch: Fetch;
	/** Opens the connection's token for one GET to `url`. */
	readonly token: (url: URL) => Promise<string>;
	readonly signal?: AbortSignal;
}): Promise<GitHubReach> {
	const get = async (path: string): Promise<Record<string, unknown>> => {
		const url = new URL(path, API);
		const token = await input.token(url);
		const response = await input.fetch(url.href, {
			method: "GET",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"user-agent": "Kantel",
				"x-github-api-version": "2022-11-28",
			},
			redirect: "manual",
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			if (response.status === 401) {
				throw new KantelError("refused", "GitHub no longer accepts this connection's sign-in: reconnect it");
			}
			throw new KantelError("unavailable", `GitHub answered ${response.status} when asked what it can reach`);
		}
		return record(await response.json()) ?? {};
	};

	const listed = await get(`/user/installations?per_page=${PAGE}`);
	const installations = (Array.isArray(listed.installations) ? listed.installations : [])
		.map(installationOf)
		.filter((item): item is ConnectionReachInstallation => item !== undefined);

	const repositories: ConnectionReachRepository[] = [];
	let total = 0;
	let truncated = false;
	for (const installation of installations) {
		for (let page = 1; ; page += 1) {
			if (repositories.length >= REACH_REPOSITORY_LIMIT) {
				truncated = true;
				break;
			}
			const answer = await get(`/user/installations/${installation.id}/repositories?per_page=${PAGE}&page=${page}`);
			const items = Array.isArray(answer.repositories) ? answer.repositories : [];
			if (page === 1) total += typeof answer.total_count === "number" ? answer.total_count : items.length;
			for (const item of items) {
				const repository = repositoryOf(item);
				if (repository === undefined) continue;
				if (repositories.length >= REACH_REPOSITORY_LIMIT) {
					truncated = true;
					break;
				}
				repositories.push(repository);
			}
			if (truncated || items.length < PAGE) break;
		}
		if (truncated) break;
	}
	// GitHub counted more than were listed.
	truncated ||= total > repositories.length;

	const only = installations.length === 1 ? installations[0] : undefined;
	return {
		installations,
		repositories,
		total,
		truncated,
		manageUrl: only?.manageUrl ?? GITHUB_INSTALLATIONS_PAGE,
	};
}
