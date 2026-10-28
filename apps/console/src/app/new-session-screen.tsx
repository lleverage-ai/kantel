import type { ProjectOption } from "@harbour/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleClient, ProjectSummary, StartOptions } from "../api/client.ts";
import { createRequestIds, titleFrom } from "../ui/actions.ts";
import { NewSessionView } from "../ui/new-session-view.tsx";
import { navigate, newSessionPath, sessionPath } from "./router.ts";

type Options = { readonly projectId: string } & (
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly options: StartOptions }
	| { readonly state: "failed"; readonly reason: string }
);

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/**
 * New session, as T3 Code's new thread: the composer, with the project and model, before the session exists. Sending
 * creates the session, sends the draft as its first message and opens it, where it streams. If the session was
 * created but the message didn't go, sending again sends it to that session rather than creating another.
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
	const [model, setModel] = useState<string>();
	const [sending, setSending] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [loaded, setLoaded] = useState<Options>({ projectId, state: "loading" });
	const requestIds = useMemo(() => createRequestIds(), []);
	/** A session this screen created whose first message hasn't gone yet, so a retry doesn't make a second. */
	const created = useRef<{ projectId: string; sessionId: string }>(undefined);

	const access = client.mayStart(projectId);
	const project = projects.find((candidate) => candidate.id === projectId);

	// The agent and models for the project, asked again when it changes. A viewer can't start one, so isn't asked.
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
	// A model picked for another agent's catalogue isn't offered here; the agent's default stands.
	const chosen = options?.models.some((option) => option.id === model) ? model : undefined;

	const blocked = !access.allowed ? access.reason : current?.state === "failed" ? current.reason : undefined;

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
				let sessionId = created.current?.projectId === projectId ? created.current.sessionId : undefined;
				if (sessionId === undefined) {
					const title = titleFrom(text);
					sessionId = await client.create({
						projectId,
						agentId: options.agentId,
						...(chosen === undefined ? {} : { model: chosen }),
						...(title === undefined ? {} : { title }),
					});
					created.current = { projectId, sessionId };
				}
				await client.prompt(sessionId, text, { requestId: requestIds.for("prompt", text) });
				requestIds.sent();
				created.current = undefined;
				navigate(sessionPath(projectId, sessionId));
			} catch (reason) {
				setFailure(
					created.current === undefined
						? `The session couldn't be created. ${messageOf(reason)}`
						: `The session was created, but your message didn't send. ${messageOf(reason)} Send it again.`,
				);
				setSending(false);
			}
		},
		[client, options, sending, pending, projectId, chosen, requestIds],
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
				models: options?.models ?? [],
				...(chosen === undefined ? {} : { model: chosen }),
				draft,
				sending,
				...(blocked === undefined ? {} : { blocked }),
				...(failure === undefined ? {} : { failure }),
			}}
			on={{
				onDraft: setDraft,
				onModel: setModel,
				onProject: (id) => {
					if (id !== projectId) navigate(newSessionPath(id), { replace: true });
				},
				onSend: (text) => void send(text),
				...(onBack === undefined ? {} : { onBack }),
			}}
		/>
	);
}
