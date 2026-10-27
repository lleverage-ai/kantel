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

	useEffect(() => {
		session.start();
		client.markRead(sessionId);
		onOpen?.(sessionId, session);
		return () => session.stop();
	}, [client, session, sessionId, onOpen]);

	const run = useCallback(async (action: () => Promise<void>) => {
		setSending(true);
		setFailure(undefined);
		try {
			await action();
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
		onSend: (text) => void run(() => client.prompt(sessionId, text, { requestId: crypto.randomUUID() })),
		onSteer: (text) => void run(() => client.steer(sessionId, text, { requestId: crypto.randomUUID() })),
		onStop: () => void run(() => client.cancel(sessionId)),
	};

	return <SessionView client={session} project={project} actions={actions} onBack={onBack} />;
}
