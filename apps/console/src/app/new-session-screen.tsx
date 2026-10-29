import type { ProjectOption } from "@harbour/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConsoleClient, ProjectSummary, StartOptions } from "../api/client.ts";
import { titleFrom } from "../ui/actions.ts";
import { type NewSessionState, NewSessionView } from "../ui/new-session-view.tsx";
import { handOver } from "./first-message.ts";
import { useModelPickers } from "./model-choices.ts";
import { navigate, newSessionPath, sessionPath } from "./router.ts";

type Options = { readonly projectId: string } & (
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly options: StartOptions }
	| { readonly state: "failed"; readonly reason: string }
);

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Where the console keeps the repositories this browser started sessions on, the latest first. */
const RECENT_REPOS_KEY = "harbour.recent-repositories";
const RECENT_REPOS_MAX = 6;

function readRecentRepos(): string[] {
	try {
		const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(RECENT_REPOS_KEY) ?? "[]");
		return Array.isArray(stored) ? stored.filter((repo): repo is string => typeof repo === "string") : [];
	} catch {
		return [];
	}
}

function rememberRepo(repo: string): string[] {
	const next = [repo, ...readRecentRepos().filter((other) => other !== repo)].slice(0, RECENT_REPOS_MAX);
	try {
		globalThis.localStorage?.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
	} catch {
		// Private browsing or a full store: the list just isn't remembered.
	}
	return next;
}

/** The chosen repository's branches, for the repository it was asked for. */
type Branches = { readonly repo: string } & NonNullable<NonNullable<NewSessionState["repository"]>["branches"]>;

/**
 * New session, as T3 Code's new thread: the composer, with the project, before the session exists. Sending
 * creates the session and opens it at once, handing it the draft as its first message (`first-message.ts`): the session
 * screen sends it, and says the turn is working from the moment it opens. A message that then fails to send stays in
 * that session's composer, to send again there.
 *
 * Changing the project keeps the draft: the screen stays mounted and only the path changes.
 */
export function NewSessionScreen({
	client,
	projectId,
	projects,
	onBack,
}: {
	client: ConsoleClient;
	projectId: string;
	projects: readonly ProjectSummary[];
	onBack?: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [loaded, setLoaded] = useState<Options>({ projectId, state: "loading" });
	// The repository the workspace starts from ("" for none) and its branches, when this client can seed one.
	const seeds = client.branches !== undefined;
	const [repo, setRepo] = useState("");
	const [recent, setRecent] = useState<readonly string[]>(() => (seeds ? readRecentRepos() : []));
	const [branches, setBranches] = useState<Branches>();

	const access = client.mayStart(projectId);
	const project = projects.find((candidate) => candidate.id === projectId);

	// The agent for the project, asked again when it changes. A viewer can't start one, so isn't asked.
	useEffect(() => {
		if (!access.allowed) return;
		const controller = new AbortController();
		setLoaded({ projectId, state: "loading" });
		client.startOptions(projectId, controller.signal).then(
			(options) => setLoaded({ projectId, state: "ready", options }),
			(reason: unknown) => {
				if (!controller.signal.aborted) setLoaded({ projectId, state: "failed", reason: messageOf(reason) });
			},
		);
		return () => controller.abort();
	}, [client, projectId, access.allowed]);

	// A chosen repository's branches, asked again when the repository or the project changes.
	useEffect(() => {
		if (repo === "" || client.branches === undefined || !access.allowed) {
			setBranches(undefined);
			return;
		}
		const controller = new AbortController();
		setBranches({ repo, state: "loading" });
		client.branches(projectId, repo, controller.signal).then(
			(listed) => {
				const options = listed.branches.map((branch) => ({
					name: branch.name,
					...(branch.name === listed.defaultBranch ? { default: true } : {}),
				}));
				const first = listed.defaultBranch ?? options[0]?.name;
				if (first === undefined) {
					setBranches({ repo, state: "failed", reason: `${repo} has no branches to start from.` });
				} else {
					setBranches({ repo, state: "ready", branches: options, branch: first });
				}
			},
			(reason: unknown) => {
				if (controller.signal.aborted) return;
				setBranches({ repo, state: "failed", reason: messageOf(reason) });
			},
		);
		return () => controller.abort();
	}, [client, projectId, repo, access.allowed]);
	const repoBranches = branches?.repo === repo ? branches : undefined;
	const repository = repo !== "" && repoBranches?.state === "ready" ? { repo, branch: repoBranches.branch } : undefined;
	/** Why the session can't start on the chosen repository yet, if it can't. */
	const repoNotReady =
		repo === ""
			? undefined
			: repoBranches?.state === "failed"
				? repoBranches.reason
				: repoBranches?.state !== "ready"
					? `${repo}'s branches are still loading. Send again in a moment.`
					: undefined;

	const current = loaded.projectId === projectId ? loaded : undefined;
	const options = current?.state === "ready" ? current.options : undefined;

	const blocked = !access.allowed ? access.reason : current?.state === "failed" ? current.reason : undefined;

	// What the new session may run with, once its agent is known; the picks go with its first message.
	const pickers = useModelPickers(
		client,
		options === undefined ? undefined : { start: { projectId, agentId: options.agentId } },
	);
	const { model: chosenModel, thinking: chosenThinking } = pickers.send;
	const choice = useMemo(
		() => ({
			...(chosenModel === undefined ? {} : { model: chosenModel }),
			...(chosenThinking === undefined ? {} : { thinking: chosenThinking }),
		}),
		[chosenModel, chosenThinking],
	);

	/** A message sent before the agent was known, sent once it is. */
	const [pending, setPending] = useState<string>();

	const send = useCallback(
		async (text: string) => {
			if (sending && pending === undefined) return;
			if (options === undefined) {
				setPending(text);
				setSending(true);
				return;
			}
			if (repoNotReady !== undefined) {
				setPending(undefined);
				setFailure(repoNotReady);
				setSending(false);
				return;
			}
			setPending(undefined);
			setSending(true);
			setFailure(undefined);
			try {
				const title = titleFrom(text);
				const sessionId = await client.create({
					projectId,
					agentId: options.agentId,
					...(title === undefined ? {} : { title }),
					...(repository === undefined ? {} : { repository }),
				});
				if (repository !== undefined) setRecent(rememberRepo(repository.repo));
				handOver(sessionId, { text, choice });
				navigate(sessionPath(projectId, sessionId));
			} catch (reason) {
				setFailure(`The session couldn't be created. ${messageOf(reason)}`);
				setSending(false);
			}
		},
		[client, options, sending, pending, projectId, choice, repository, repoNotReady],
	);

	// Once the agent is known, a message that was waiting for it goes; if it can't be known, the message stays a draft.
	useEffect(() => {
		if (pending === undefined) return;
		if (options !== undefined) void send(pending);
		else if (current?.state === "failed" || !access.allowed) {
			setPending(undefined);
			setSending(false);
		}
	}, [pending, options, current?.state, access.allowed, send]);

	const projectOptions: ProjectOption[] = projects.map((candidate) => {
		const may = client.mayStart(candidate.id);
		return { id: candidate.id, label: candidate.name, ...(may.allowed ? {} : { disabledReason: may.reason }) };
	});

	return (
		<NewSessionView
			state={{
				projectId,
				projectName: project?.name ?? projectId,
				projects: projectOptions,
				...(options === undefined ? {} : { agentName: options.agentName }),
				draft,
				sending,
				pickers: pickers.composer,
				...(blocked === undefined ? {} : { blocked }),
				...(failure === undefined ? {} : { failure }),
				...(seeds
					? {
							repository: {
								repo,
								recent,
								...(repoBranches === undefined ? {} : { branches: repoBranches }),
							},
						}
					: {}),
			}}
			on={{
				onDraft: setDraft,
				...(seeds
					? {
							onRepository: (next: string) => {
								setFailure(undefined);
								setRepo(next);
							},
							onBranch: (branch: string) =>
								setBranches((now) => (now?.state === "ready" && now.repo === repo ? { ...now, branch } : now)),
						}
					: {}),
				onProject: (id) => {
					if (id !== projectId) navigate(newSessionPath(id), { replace: true });
				},
				onSend: (text) => void send(text),
				...(onBack === undefined ? {} : { onBack }),
			}}
		/>
	);
}
