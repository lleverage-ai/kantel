import type { ProjectOption } from "@harbour/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConsoleClient, ProjectSummary, StartOptions } from "../api/client.ts";
import { titleFrom } from "../ui/actions.ts";
import { NewSessionView } from "../ui/new-session-view.tsx";
import { handOver } from "./first-message.ts";
import { useModelPickers } from "./model-choices.ts";
import { navigate, newSessionPath, sessionPath } from "./router.ts";

type Options = { readonly projectId: string } & (
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly options: StartOptions }
	| { readonly state: "failed"; readonly reason: string }
);

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

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
			setPending(undefined);
			setSending(true);
			setFailure(undefined);
			try {
				const title = titleFrom(text);
				const sessionId = await client.create({
					projectId,
					agentId: options.agentId,
					...(title === undefined ? {} : { title }),
				});
				handOver(sessionId, { text, choice });
				navigate(sessionPath(projectId, sessionId));
			} catch (reason) {
				setFailure(`The session couldn't be created. ${messageOf(reason)}`);
				setSending(false);
			}
		},
		[client, options, sending, pending, projectId, choice],
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
			}}
			on={{
				onDraft: setDraft,
				onProject: (id) => {
					if (id !== projectId) navigate(newSessionPath(id), { replace: true });
				},
				onSend: (text) => void send(text),
				...(onBack === undefined ? {} : { onBack }),
			}}
		/>
	);
}
