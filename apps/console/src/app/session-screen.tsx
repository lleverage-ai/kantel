import type { PresentedFile, UserAttachment } from "@harbour/protocol";
import type { ComposerAttachment, Crumb } from "@harbour/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ConsoleClient, SendOptions, WorkspaceFiles } from "../api/client.ts";
import { ApiError } from "../api/http.ts";
import { followTurn, type TurnSearch } from "../state/linked-turn.ts";
import type { LiveSummary } from "../state/live-summary.ts";
import { needsOf } from "../state/needs.ts";
import { Outbox, type OutgoingVia } from "../state/outbox.ts";
import { SessionClient } from "../state/session-client.ts";
import { createRequestIds, createWarmHint, type SessionActions } from "../ui/actions.ts";
import { createBrowserLiveStore } from "../ui/browser-live.ts";
import { SessionView } from "../ui/session-view.tsx";
import type { SubagentLinks } from "../ui/subagent.tsx";
import { useMessageAttachments } from "./attachments.ts";
import { type FirstMessage, takeOver } from "./first-message.ts";
import { useModelPickers } from "./model-choices.ts";
import { browserFromHash, turnOfHash, useHash } from "./router.ts";

/** How long a session waits for this browser's cached copy before connecting without it. */
export const CACHE_WAIT_MS = 150;
/** How often, at most, an open session is kept for the next load while it changes. */
export const KEEP_EVERY_MS = 10_000;

/** The model and thinking level a message is sent with, as the pickers showed when it was sent. */
type Choice = Pick<SendOptions, "model" | "thinking">;

/**
 * The turn a `#turn=<id>` link names, on load and whenever the hash changes, and where the search for it stands. A turn
 * that isn't loaded yet is looked for by paging back through the session's history, a page at a time, until it is
 * found or there is nothing older.
 */
function useLinkedTurn(session: SessionClient): { turn: string | undefined; search: TurnSearch } {
	const turn = turnOfHash(useHash());
	const [search, setSearch] = useState<TurnSearch>("none");
	useEffect(() => followTurn(session, turn, setSearch), [session, turn]);
	return { turn, search: turn === undefined ? "none" : search };
}

/**
 * One open session: a SessionClient over the console client's transport, started while the screen is shown, and the
 * composer's controls wired to the console client. Keyed on the session id by its parent, so switching sessions
 * starts a fresh connection.
 */
export function SessionScreen({
	client,
	sessionId,
	projectId,
	parents,
	onBack,
	onFiles,
	onForked,
	onOpen,
	onLive,
	subagentHref,
}: {
	client: ConsoleClient;
	sessionId: string;
	/** The session's project, where the composer's files are uploaded. Without it the composer takes no files. */
	projectId?: string;
	/** Where a subagent's session is, for its card in this session's thread. */
	subagentHref: (sessionId: string) => string;
	/** Told the session's live state as its stream changes it, and undefined when the screen closes, for the list. */
	onLive?: (live: LiveSummary | undefined) => void;
	/** The top bar's trail above the session: its project, then for a subagent's session the sessions above it. */
	parents?: readonly Crumb[];
	onBack?: () => void;
	onFiles?: () => void;
	/** Opens a session forked from this one. */
	onForked?: (sessionId: string) => void;
	/** Told about each session client as it starts; the evidence script reads it from the page. */
	onOpen?: (sessionId: string, session: SessionClient) => void;
}) {
	const session = useMemo(() => new SessionClient(client.transport(sessionId), sessionId), [client, sessionId]);
	const [sending, setSending] = useState(false);
	const [promptedAt, setPromptedAt] = useState<number>();
	const [failure, setFailure] = useState<string>();
	const [draft, setDraft] = useState("");
	const requestIds = useMemo(() => createRequestIds(), []);
	// The composer's files, uploaded to the session's project as they are attached and sent with the next message.
	const attached = useMessageAttachments(client, projectId);
	// Messages and steers go through the outbox: each shows in the transcript the moment it is sent, goes to the host
	// one at a time with its requestId, and gives way to the session's own copy when the stream brings it
	// (state/outbox.ts).
	const outbox = useMemo(
		() =>
			new Outbox<Choice>((message) =>
				client[message.via](sessionId, message.text, {
					requestId: message.requestId,
					...message.options,
					...(message.attachments === undefined ? {} : { attachments: message.attachments }),
				}),
			),
		[client, sessionId],
	);
	const outgoing = useSyncExternalStore(outbox.subscribe, outbox.getState);
	useEffect(() => {
		const settle = () => outbox.settle(session.getState().items);
		settle();
		return session.subscribe(settle);
	}, [session, outbox]);
	// The prompt that set `promptedAt`: if it fails, the turn isn't working after all.
	const prompting = useRef<{ readonly requestId: string; readonly at: number }>(undefined);
	const prompted = useCallback((requestId: string) => {
		const at = Date.now();
		prompting.current = { requestId, at };
		setPromptedAt(at);
	}, []);
	useEffect(
		() =>
			outbox.subscribe(() => {
				const current = prompting.current;
				if (current === undefined) return;
				const message = outbox.getState().find((candidate) => candidate.requestId === current.requestId);
				if (message?.status !== "failed") return;
				prompting.current = undefined;
				setPromptedAt((at) => (at === current.at ? undefined : at));
			}),
		[outbox],
	);
	const onRetrySend = useCallback(
		(requestId: string) => {
			const message = outbox.getState().find((candidate) => candidate.requestId === requestId);
			if (message?.status !== "failed") return;
			if (message.via === "prompt") prompted(requestId);
			outbox.retry(requestId);
		},
		[outbox, prompted],
	);
	// A failed message's words go back to the composer, before anything typed since.
	const onEditUnsent = useCallback(
		(requestId: string) => {
			const message = outbox.take(requestId);
			if (message === undefined) return;
			setDraft((current) => (current.trim() === "" ? message.text : `${message.text}\n\n${current}`));
		},
		[outbox],
	);
	// The session's browsers' live views, while the screen is open; none on a client that can't have them.
	const browserLive = useMemo(() => {
		const load = client.browserLive?.bind(client);
		const replay = client.browserReplay?.bind(client);
		return load === undefined
			? undefined
			: createBrowserLiveStore(
					(browserSessionId, signal) => load(sessionId, browserSessionId, signal),
					replay === undefined ? undefined : (browserSessionId, signal) => replay(sessionId, browserSessionId, signal),
				);
	}, [client, sessionId]);
	useEffect(() => () => browserLive?.dispose(), [browserLive]);
	const pickers = useModelPickers(client, client.control(sessionId).live ? { sessionId } : undefined);
	const linked = useLinkedTurn(session);
	// Where the session's subagent cards go: each call's own session, found from the call. None on a client that
	// can't have subagents.
	const subagents = useMemo<SubagentLinks | undefined>(() => {
		const find = client.subagentOf?.bind(client);
		if (find === undefined) return undefined;
		const found = new Map<string, string>();
		return {
			known: (callId) => found.get(callId),
			find: async (callId, signal) => {
				const child = await find(sessionId, callId, signal);
				if (child !== undefined) found.set(callId, child);
				return child;
			},
			href: (child) => subagentHref(child),
			// A working card follows its subagent's own stream, to say what it is doing now.
			watch: (child) => new SessionClient(client.transport(child), child),
			// A working card's Stop aborts its subagent's session, as that session's own Stop would.
			stop: (child) => client.cancel(child),
		};
	}, [client, sessionId, subagentHref]);

	useEffect(() => {
		// What this browser last held of the session shows at once, and the stream resumes after it. The cache gets a
		// moment; a slow one never holds the stream up, and what it has still shows if it comes before the host's.
		let started = false;
		let closed = false;
		const start = () => {
			if (started || closed) return;
			started = true;
			session.start();
		};
		const cached = client.cachedSession?.(sessionId);
		const wait = cached === undefined ? undefined : setTimeout(start, CACHE_WAIT_MS);
		if (cached === undefined) start();
		else {
			cached.then((snapshot) => {
				if (!closed && snapshot !== undefined) session.seed(snapshot);
				start();
			}, start);
		}
		// Kept for the next load: once it is current, at most every KEEP_EVERY_MS while it changes, and as it closes.
		const remember = client.rememberSession?.bind(client);
		let keepTimer: ReturnType<typeof setTimeout> | undefined;
		const keep = () => {
			clearTimeout(keepTimer);
			keepTimer = undefined;
			const snapshot = session.kept();
			if (snapshot !== undefined && session.getState().freshness.state === "current") remember?.(snapshot);
		};
		let keptOnce = false;
		const unsubscribe =
			remember === undefined
				? undefined
				: session.subscribe(() => {
						if (session.getState().freshness.state !== "current") return;
						if (!keptOnce) {
							keptOnce = true;
							keep();
						} else keepTimer ??= setTimeout(keep, KEEP_EVERY_MS);
					});
		const onHide = () => keep();
		if (remember !== undefined) addEventListener("pagehide", onHide);
		const release = client.markRead(sessionId);
		onOpen?.(sessionId, session);
		return () => {
			closed = true;
			clearTimeout(wait);
			if (remember !== undefined) {
				unsubscribe?.();
				removeEventListener("pagehide", onHide);
				keep();
			}
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

	/**
	 * Sends a message or a steer at once, through the outbox: it shows in the transcript as it goes, and the composer
	 * clears, files and all. Sent with the pickers' model and level unless `choice` says otherwise.
	 */
	const sendNow = (
		via: OutgoingVia,
		text: string,
		choice: Choice = pickers.send,
		files: { sent?: readonly ComposerAttachment[]; references?: readonly UserAttachment[] } = {},
	) => {
		const sent = files.sent ?? [];
		const attachments = files.references ?? attached.referencesOf(sent);
		attached.sentOff(sent);
		setFailure(undefined);
		const message = outbox.send(via, text, { attachments, options: choice });
		if (via === "prompt") prompted(message.requestId);
	};

	/**
	 * Queues the draft as a follow-up, with the request id of a failed attempt to queue it, if there was one. It stays
	 * in the composer until the host has it.
	 */
	const followUp = (text: string) => {
		void run(
			() => client.followUp(sessionId, text, { requestId: requestIds.for("followUp", text), ...pickers.send }),
			text,
		);
	};

	// A session the new-session screen just created brings its first message, sent from here so the turn shows working
	// as the screen opens. It shows in the transcript at once; a failed send stays there, to try again or edit.
	const sendFirst = useRef<(first: FirstMessage) => void>(undefined);
	sendFirst.current = ({ text, choice, attachments }) => {
		sendNow("prompt", text, choice, attachments === undefined ? {} : { references: attachments });
	};
	useEffect(() => {
		const first = takeOver(sessionId);
		if (first !== undefined) sendFirst.current?.(first);
	}, [sessionId]);

	// Fork and Edit from here, when the host can branch a session. Stable, so the messages don't render again.
	const { fork, edit } = client;
	const onFork = useMemo(
		() =>
			fork === undefined
				? undefined
				: async (itemId: string) => {
						const forkId = await fork(sessionId, itemId);
						onForked?.(forkId);
					},
		[fork, sessionId, onForked],
	);
	// An edit reruns on the model and thinking the composer shows, read when it is sent, so a new choice doesn't render
	// every message again. It shows the turn working at once, as a prompt does.
	const pickerSend = useRef(pickers.send);
	pickerSend.current = pickers.send;
	const onEdit = useMemo(
		() =>
			edit === undefined
				? undefined
				: async (itemId: string, text: string) => {
						const at = Date.now();
						setPromptedAt(at);
						try {
							await edit(sessionId, itemId, text, { requestId: crypto.randomUUID(), ...pickerSend.current });
						} catch (reason) {
							setPromptedAt((current) => (current === at ? undefined : current));
							throw reason;
						}
					},
		[edit, sessionId],
	);

	// A presented file is read from the session's own workspace, through the read API with the console's credentials;
	// a document the person edits is written back the same way.
	const { readPresented, writePresented, sharesOf } = useMemo(() => {
		let files: Promise<WorkspaceFiles | undefined> | undefined;
		const workspaceOf = async (file: PresentedFile) => {
			files ??= client.workspace(sessionId);
			const workspace = await files.catch((reason: unknown) => {
				files = undefined;
				throw reason;
			});
			if (workspace === undefined || workspace.id !== file.workspaceId) {
				throw new ApiError("not_found", "The file isn't in this session's workspace");
			}
			return workspace;
		};
		return {
			readPresented: async (file: PresentedFile, signal: AbortSignal) =>
				(await workspaceOf(file)).read(file.path, signal),
			writePresented: async (file: PresentedFile, markdown: string, ifMatch: string | undefined) => {
				const workspace = await workspaceOf(file);
				if (workspace.write === undefined) throw new ApiError("not_supported", "This console can't save files");
				return workspace.write(file.path, markdown, ifMatch);
			},
			sharesOf: async (file: PresentedFile) => (await workspaceOf(file)).shares,
		};
	}, [client, sessionId]);
	// Typing (or focusing the composer) warms the session's sandbox, so the agent's first command after a pause waits for
	// no container to start. One hint per session at most every 30 s.
	const { warm } = client;
	const onEngage = useMemo(
		() => (warm === undefined ? undefined : createWarmHint(() => warm(sessionId))),
		[warm, sessionId],
	);

	const actions: SessionActions = {
		readPresented,
		writePresented,
		sharesOf,
		sharer: { name: client.actor.name, ...(client.actor.email === undefined ? {} : { email: client.actor.email }) },
		...(onFork === undefined ? {} : { onFork }),
		...(onEngage === undefined ? {} : { onEngage }),
		...(onEdit === undefined ? {} : { onEdit }),
		control: client.control(sessionId),
		sending,
		...(promptedAt === undefined ? {} : { promptedAt }),
		failure,
		draft,
		onDraft: setDraft,
		outbox: outgoing,
		onRetrySend,
		onEditUnsent,
		onSend: (text, sent) => {
			setDraft("");
			sendNow("prompt", text, pickers.send, sent === undefined ? {} : { sent });
		},
		onSteer: (text, sent) => {
			setDraft("");
			sendNow("steer", text, pickers.send, sent === undefined ? {} : { sent });
		},
		files: attached.composer,
		onFollowUp: followUp,
		onStop: () => void run(() => client.cancel(sessionId)),
		...(client.decideBrowser === undefined
			? {}
			: {
					onBrowserDecision: (callId: string, allow: boolean) =>
						void run(() => client.decideBrowser?.(sessionId, callId, allow) ?? Promise.resolve()),
				}),
		...(browserLive === undefined ? {} : { browserLive }),
		pickers: pickers.composer,
	};

	// An audit link to one of the session's browsers (`#browser=<id>`): the transcript scrolls to its view.
	// Read once, as the screen opens: the hash is the link's, not state the screen keeps.
	const [focusBrowser] = useState(() => browserFromHash(location.hash));
	return (
		<SessionView
			client={session}
			{...(parents === undefined ? {} : { parents })}
			{...(subagents === undefined ? {} : { subagents })}
			actions={actions}
			onBack={onBack}
			onFiles={onFiles}
			{...(linked.turn === undefined ? {} : { turn: linked.turn, turnSearch: linked.search })}
			{...(focusBrowser === undefined ? {} : { focusBrowser })}
		/>
	);
}
