import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConsoleClient } from "../api/client.ts";
import type { LiveSummary } from "../state/live-summary.ts";
import { needsOf } from "../state/needs.ts";
import { SessionClient } from "../state/session-client.ts";
import { createRequestIds, type SessionActions } from "../ui/actions.ts";
import { SessionView } from "../ui/session-view.tsx";
import { useModelPickers } from "./model-choices.ts";

/**
 * One open session: a SessionClient over the console client's transport, started while the screen is shown, and the
 * composer's controls wired to the console client. Keyed on the session id by its parent, so switching sessions
 * starts a fresh connection.
 */
export function SessionScreen({
	client,
	sessionId,
	project,
	onBack,
	onFiles,
	onOpen,
	onLive,
}: {
	client: ConsoleClient;
	sessionId: string;
	/** Told the session's live state as its stream changes it, and undefined when the screen closes, for the list. */
	onLive?: (live: LiveSummary | undefined) => void;
	project?: string;
	onBack?: () => void;
	onFiles?: () => void;
	/** Told about each session client as it starts; the evidence script reads it from the page. */
	onOpen?: (sessionId: string, session: SessionClient) => void;
}) {
	const session = useMemo(() => new SessionClient(client.transport(sessionId), sessionId), [client, sessionId]);
	const [sending, setSending] = useState(false);
	const [promptedAt, setPromptedAt] = useState<number>();
	const [failure, setFailure] = useState<string>();
	const [draft, setDraft] = useState("");
	const requestIds = useMemo(() => createRequestIds(), []);
	const pickers = useModelPickers(client, client.control(sessionId).live ? { sessionId } : undefined);

	useEffect(() => {
		session.start();
		const release = client.markRead(sessionId);
		onOpen?.(sessionId, session);
		return () => {
			release();
			session.stop();
		};
	}, [client, session, sessionId, onOpen]);

	// A prompt shows the turn working at once, until the session's status first moves after it: from then on the host's
	// status says whether it works. If the status never moves (the prompt was queued behind something), it gives up
	// after a minute rather than say working for ever.
	useEffect(() => {
		if (promptedAt === undefined) return;
		const from = session.getState().status;
		const settle = () => setPromptedAt((current) => (current === promptedAt ? undefined : current));
		const unsubscribe = session.subscribe(() => {
			if (session.getState().status !== from) settle();
		});
		const timer = setTimeout(settle, 60_000);
		return () => {
			unsubscribe();
			clearTimeout(timer);
		};
	}, [session, promptedAt]);

	// The sidebar's row for this session follows its stream, not the list's poll. A prompt shows it working at once.
	useEffect(() => {
		if (onLive === undefined) return;
		let last: LiveSummary | undefined;
		const tell = () => {
			const state = session.getState();
			if (state.freshness.state === "loading") return;
			const status = promptedAt === undefined ? state.status : "running";
			const needs = status === "waiting" ? needsOf(state.items) : undefined;
			if (last?.status === status && last.needs === needs && last.title === state.title) return;
			last = { id: sessionId, status, title: state.title, ...(needs === undefined ? {} : { needs }) };
			onLive(last);
		};
		tell();
		return session.subscribe(tell);
	}, [session, sessionId, onLive, promptedAt]);
	useEffect(() => (onLive === undefined ? undefined : () => onLive(undefined)), [onLive]);

	/** Runs one action. A sent draft is cleared once it has gone, unless it was edited meanwhile; a failed one stays. */
	const run = useCallback(
		async (action: () => Promise<void>, sent?: string) => {
			setSending(true);
			setFailure(undefined);
			try {
				await action();
				if (sent !== undefined) {
					requestIds.sent();
					setDraft((current) => (current.trim() === sent ? "" : current));
				}
			} catch (reason) {
				setFailure(reason instanceof Error ? reason.message : String(reason));
			} finally {
				setSending(false);
			}
		},
		[requestIds],
	);

	/** Sends the draft one way, with the request id of a failed attempt to send it the same way, if there was one. */
	const send = (how: "prompt" | "steer" | "followUp", text: string) => {
		const at = Date.now();
		if (how === "prompt") setPromptedAt(at);
		void run(async () => {
			try {
				await client[how](sessionId, text, { requestId: requestIds.for(how, text), ...pickers.send });
			} catch (reason) {
				if (how === "prompt") setPromptedAt((current) => (current === at ? undefined : current));
				throw reason;
			}
		}, text);
	};

	const actions: SessionActions = {
		control: client.control(sessionId),
		sending,
		...(promptedAt === undefined ? {} : { promptedAt }),
		failure,
		draft,
		onDraft: setDraft,
		onSend: (text) => send("prompt", text),
		onSteer: (text) => send("steer", text),
		onFollowUp: (text) => send("followUp", text),
		onStop: () => void run(() => client.cancel(sessionId)),
		pickers: pickers.composer,
	};

	return <SessionView client={session} project={project} actions={actions} onBack={onBack} onFiles={onFiles} />;
}
