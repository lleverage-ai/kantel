import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConsoleClient } from "../api/client.ts";
import { SessionClient } from "../state/session-client.ts";
import type { SessionActions } from "../ui/actions.ts";
import { SessionView } from "../ui/session-view.tsx";

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
	onOpen,
}: {
	client: ConsoleClient;
	sessionId: string;
	project?: string;
	onBack?: () => void;
	/** Told about each session client as it starts; the evidence script reads it from the page. */
	onOpen?: (sessionId: string, session: SessionClient) => void;
}) {
	const session = useMemo(() => new SessionClient(client.transport(sessionId), sessionId), [client, sessionId]);
	const [sending, setSending] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [draft, setDraft] = useState("");

	useEffect(() => {
		session.start();
		const release = client.markRead(sessionId);
		onOpen?.(sessionId, session);
		return () => {
			release();
			session.stop();
		};
	}, [client, session, sessionId, onOpen]);

	/** Runs one action. A sent draft is cleared once it has gone, unless it was edited meanwhile; a failed one stays. */
	const run = useCallback(async (action: () => Promise<void>, sent?: string) => {
		setSending(true);
		setFailure(undefined);
		try {
			await action();
			if (sent !== undefined) setDraft((current) => (current.trim() === sent ? "" : current));
		} catch (reason) {
			setFailure(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setSending(false);
		}
	}, []);

	const actions: SessionActions = {
		control: client.control(sessionId),
		sending,
		failure,
		draft,
		onDraft: setDraft,
		onSend: (text) => void run(() => client.prompt(sessionId, text, { requestId: crypto.randomUUID() }), text),
		onSteer: (text) => void run(() => client.steer(sessionId, text, { requestId: crypto.randomUUID() }), text),
		onFollowUp: (text) => void run(() => client.followUp(sessionId, text, { requestId: crypto.randomUUID() }), text),
		onStop: () => void run(() => client.cancel(sessionId)),
	};

	return <SessionView client={session} project={project} actions={actions} onBack={onBack} />;
}
