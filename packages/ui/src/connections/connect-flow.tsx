// The OAuth round trip as the page runs it (#327): open a window for the provider's sign-in, wait for Kantel's
// callback to settle the attempt, then show who it connected as. Kantel owns the redirect and the callback, so no
// token passes through the page: it only learns that the attempt settled and the connection it made.
//
// The window is opened in the click itself, before the connect call returns, because a browser blocks a popup that
// isn't opened by a click. It starts blank and is pointed at the connect URL once Kantel gives one. If the browser
// blocks it anyway, the page offers the URL as a link to open by hand.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { CopyButton } from "../primitives/controls.tsx";
import { CheckIcon, XIcon } from "../primitives/icons.tsx";
import { ExternalLinkIcon, ShieldCheckIcon } from "../primitives/lucide.tsx";
import { type ConnectFailure, type Connection, type ConnectStart, FAILURE_TEXT } from "./connections-model.ts";
import { ProviderLogo } from "./provider-logo.tsx";
import "./connections.css";

/** Where a round trip has got to. */
export type ConnectFlowState =
	| { readonly phase: "idle" }
	| { readonly phase: "starting" }
	| {
			readonly phase: "waiting";
			readonly start: ConnectStart;
			/** `blocked`: the browser refused the window; `closed`: it was closed before the attempt settled. */
			readonly window: "open" | "blocked" | "closed";
	  }
	| { readonly phase: "connected"; readonly connection: Connection }
	| {
			readonly phase: "failed";
			readonly reason: ConnectFailure | "unreachable";
			readonly message?: string;
	  };

/** Opens the sign-in window. The page's default opens a centred popup; stories pass a stand-in. */
export type OpenWindow = () => Window | null;

/** A window for the sign-in, about the size of a provider's consent screen, centred on the page. */
export const openPopup: OpenWindow = () => {
	if (typeof window === "undefined") return null;
	const width = 520;
	const height = 680;
	const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
	const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
	return window.open("", "harbour-connect", `popup,width=${width},height=${height},left=${left},top=${top}`);
};

/** How often the page asks whether the attempt settled. Kantel's callback page also tells the opener when it does. */
const POLL_MS = 1000;

export interface ConnectFlow {
	readonly state: ConnectFlowState;
	/**
	 * Starts a round trip. Call it from the click: it opens the window first, then asks Kantel for the connect URL with
	 * `begin`, then waits for the attempt to settle with `poll`. A `begin` that resolves to nothing needs no sign-in (an
	 * MCP server that takes a key): the window closes and the flow goes back to idle.
	 */
	readonly run: (begin: () => Promise<ConnectStart | undefined>) => void;
	/** Opens the window again, at the same URL, for a closed or blocked one. Call it from a click. */
	readonly reopen: () => void;
	/** Stops waiting, and gives up on the attempt so its URL stops working. */
	readonly cancel: () => void;
	/** Back to idle, after a result has been read. */
	readonly reset: () => void;
}

/**
 * Runs one OAuth round trip at a time. `poll` asks after an attempt (`ConnectionsSource.attempt`); `onConnected` hears
 * of the connection made, for the host to reload its list.
 */
export function useConnectFlow({
	poll,
	cancelAttempt,
	openWindow = openPopup,
	onConnected,
}: {
	poll: (
		attemptId: string,
	) => Promise<
		| { readonly status: "pending" }
		| { readonly status: "connected"; readonly connection: Connection }
		| { readonly status: "failed"; readonly reason: ConnectFailure; readonly message?: string }
	>;
	cancelAttempt?: ((attemptId: string) => Promise<void>) | undefined;
	openWindow?: OpenWindow | undefined;
	onConnected?: ((connection: Connection) => void) | undefined;
}): ConnectFlow {
	const [state, setStateNow] = useState<ConnectFlowState>({ phase: "idle" });
	// The state as last set, for the callbacks to read without side effects inside a state updater.
	const current = useRef<ConnectFlowState>(state);
	const setState = useCallback((next: ConnectFlowState) => {
		current.current = next;
		setStateNow(next);
	}, []);
	const popup = useRef<Window | null>(null);
	// Each run is numbered; a settled or cancelled run's late replies change nothing.
	const runId = useRef(0);
	const latest = useRef({ poll, cancelAttempt, openWindow, onConnected });
	latest.current = { poll, cancelAttempt, openWindow, onConnected };

	const closePopup = useCallback(() => {
		try {
			popup.current?.close();
		} catch {
			// A window on the provider's origin may refuse; it closes itself on Kantel's final page.
		}
		popup.current = null;
	}, []);

	useEffect(
		() => () => {
			runId.current += 1;
			closePopup();
		},
		[closePopup],
	);

	const watch = useCallback(
		async (mine: number, start: ConnectStart) => {
			const live = () => runId.current === mine;
			let wake: (() => void) | undefined;
			// Kantel's final page posts `{ type: "harbour.connect", attemptId }` to its opener: ask at once rather than wait.
			const onMessage = (event: MessageEvent) => {
				const data = event.data as { type?: unknown; attemptId?: unknown } | null;
				if (data?.type === "harbour.connect" && data.attemptId === start.attemptId) wake?.();
			};
			window.addEventListener("message", onMessage);
			try {
				while (live()) {
					let result: Awaited<ReturnType<typeof poll>>;
					try {
						result = await latest.current.poll(start.attemptId);
					} catch {
						result = { status: "pending" };
					}
					if (!live()) return;
					if (result.status === "connected") {
						closePopup();
						setState({ phase: "connected", connection: result.connection });
						latest.current.onConnected?.(result.connection);
						return;
					}
					if (result.status === "failed") {
						closePopup();
						setState({
							phase: "failed",
							reason: result.reason,
							...(result.message === undefined ? {} : { message: result.message }),
						});
						return;
					}
					// Still waiting: say so if the person closed the window without finishing.
					const now = current.current;
					if (popup.current?.closed === true && now.phase === "waiting" && now.window === "open")
						setState({ ...now, window: "closed" });
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, POLL_MS);
						wake = () => {
							clearTimeout(timer);
							resolve();
						};
					});
				}
			} finally {
				window.removeEventListener("message", onMessage);
			}
		},
		[setState, closePopup],
	);

	const run = useCallback(
		(begin: () => Promise<ConnectStart | undefined>) => {
			const mine = ++runId.current;
			closePopup();
			popup.current = latest.current.openWindow();
			setState({ phase: "starting" });
			begin().then(
				(start) => {
					if (runId.current !== mine) return;
					if (start === undefined) {
						closePopup();
						setState({ phase: "idle" });
						return;
					}
					// Connected with no sign-in: a server that answered without one.
					if (start.connected !== undefined) {
						closePopup();
						setState({ phase: "connected", connection: start.connected });
						latest.current.onConnected?.(start.connected);
						return;
					}
					// A sign-in with a code: the code shows here first, so the person reads or copies it before opening the provider's
					// page, rather than a window covering it.
					if (start.device !== undefined) {
						closePopup();
						setState({ phase: "waiting", start, window: "blocked" });
						void watch(mine, start);
						return;
					}
					const opened = popup.current !== null && !popup.current.closed;
					if (opened && popup.current !== null) popup.current.location.href = start.url;
					setState({ phase: "waiting", start, window: opened ? "open" : "blocked" });
					void watch(mine, start);
				},
				(error: unknown) => {
					if (runId.current !== mine) return;
					closePopup();
					setState({
						phase: "failed",
						reason: "unreachable",
						message: error instanceof Error ? error.message : "Kantel couldn't start the sign-in.",
					});
				},
			);
		},
		[watch, setState, closePopup],
	);

	const reopen = useCallback(() => {
		const now = current.current;
		if (now.phase !== "waiting") return;
		// A popup still open is brought forward; a closed or blocked one is opened again at the same URL.
		if (popup.current !== null && !popup.current.closed) {
			popup.current.focus();
			return;
		}
		const opened = latest.current.openWindow();
		popup.current = opened;
		if (opened !== null) opened.location.href = now.start.url;
		setState({ ...now, window: opened === null ? "blocked" : "open" });
	}, [setState]);

	const cancel = useCallback(() => {
		const now = current.current;
		runId.current += 1;
		closePopup();
		if (now.phase === "waiting") void latest.current.cancelAttempt?.(now.start.attemptId).catch(() => {});
		setState({ phase: "idle" });
	}, [setState, closePopup]);

	const reset = useCallback(() => {
		runId.current += 1;
		closePopup();
		setState({ phase: "idle" });
	}, [setState, closePopup]);

	return { state, run, reopen, cancel, reset };
}

/** The words for a failed round trip. */
export function failureText(state: Extract<ConnectFlowState, { phase: "failed" }>): string {
	if (state.reason === "unreachable") return state.message ?? "Kantel couldn't start the sign-in. Try again.";
	const base = FAILURE_TEXT[state.reason];
	return state.message === undefined ? base : `${base} ${state.message}`;
}

/** A URL's host and path, as a person would type it: "github.com/login/device". */
function siteOf(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
	} catch {
		return "the sign-in page";
	}
}

/**
 * The code to type at the provider, large and spaced so it reads across a room and copies in one click. Each
 * character sits in its own cell, as on the provider's page it is typed into.
 */
function DeviceCode({ code }: { code: string }) {
	return (
		<div className="flex min-w-0 flex-col items-center gap-3 rounded-panel border border-border bg-sunken px-3 py-4">
			<span className="kt-sr-only">Your code is {code.split("").join(" ")}</span>
			<span className="flex min-w-0 items-center gap-1" aria-hidden="true">
				{code.split("").map((char, index) =>
					char === "-" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: a code's characters repeat; their place is their identity.
						<span key={index} className="mx-0.5 block h-0.5 w-2.5 shrink-0 rounded-full bg-border-strong" />
					) : (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: as above.
							key={index}
							className="flex h-9 w-7 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-canvas font-mono text-lg font-strong text-fg"
						>
							{char}
						</span>
					),
				)}
			</span>
			<CopyButton text={code} label="Copy code" variant="ghost" />
		</div>
	);
}

/** The two ends of a connection, Kantel and the service, and the line between them. */
function Handshake({
	name,
	icon,
	tone,
}: {
	name: string;
	icon?: string | undefined;
	tone: "pending" | "connected" | "failed";
}) {
	return (
		<div className="flex items-center gap-3" aria-hidden="true">
			{/* Kantel's end: the store that holds the credential. */}
			<span className="box-border flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-accent-soft text-accent-text">
				<ShieldCheckIcon />
			</span>
			<span className="relative flex h-6 min-w-12 flex-1 items-center">
				{tone === "pending" ? (
					// Dashes with a light travelling along them: something is on its way.
					<span className="relative block h-0.5 w-full overflow-hidden rounded-full bg-border-strong">
						<span className="kt-connect-travel absolute inset-y-0 left-0 block w-1/3 rounded-full bg-accent-text motion-reduce:animate-none" />
					</span>
				) : tone === "connected" ? (
					<span className="block h-0.5 w-full rounded-full bg-status-done" />
				) : (
					<span className="flex w-full items-center gap-2">
						<span className="block h-0.5 flex-1 rounded-full bg-status-error-line" />
						<span className="block h-0.5 flex-1 rounded-full bg-status-error-line" />
					</span>
				)}
				{tone === "pending" ? null : (
					<span
						className={`kt-connect-pop absolute top-1/2 left-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border motion-reduce:animate-none ${tone === "connected" ? "border-status-done bg-status-done-soft text-status-done" : "border-status-error-line bg-status-error-soft text-status-error"} bg-canvas`}
					>
						{tone === "connected" ? <CheckIcon size="sm" /> : <XIcon size="sm" />}
					</span>
				)}
			</span>
			<ProviderLogo name={name} icon={icon} />
		</div>
	);
}

/**
 * What a round trip shows while it runs and once it settles: the two ends and the line between them, a sentence on
 * what is happening, and the actions that fit. Announced as it changes.
 */
export function ConnectProgress({
	flow,
	name,
	icon,
	connectedText,
	connectedAction,
	onDone,
	onRetry,
}: {
	flow: ConnectFlow;
	/** The service's name: "GitHub". */
	name: string;
	icon?: string | undefined;
	/** What the success says under "Connected": who it connected as and who may use it. */
	connectedText?: (connection: Connection) => string;
	/** A next step beside Done after success, such as sharing a personal connection with a project. */
	connectedAction?: ((connection: Connection) => ReactNode) | undefined;
	/** After success: back to where the person was. */
	onDone?: () => void;
	onRetry?: () => void;
}) {
	const { state } = flow;
	if (state.phase === "idle") return null;
	const tone = state.phase === "connected" ? "connected" : state.phase === "failed" ? "failed" : "pending";
	const code = state.phase === "waiting" ? state.start.device?.userCode : undefined;
	const site = state.phase === "waiting" ? siteOf(state.start.url) : "";
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<Handshake name={name} icon={icon} tone={tone} />
			{code === undefined ? null : <DeviceCode code={code} />}
			<div className="flex min-w-0 flex-col gap-1" role="status" aria-live="polite">
				{code !== undefined ? (
					<>
						<p className="m-0 font-medium text-fg">Enter this code on {name}</p>
						<p className="m-0 text-xs text-muted">
							Open {site}, type the code and approve the access. This page carries on by itself when you're done.
						</p>
					</>
				) : state.phase === "starting" ? (
					<>
						<p className="m-0 font-medium text-fg">Opening {name}</p>
						<p className="m-0 text-xs text-muted">Getting a sign-in link from Kantel.</p>
					</>
				) : state.phase === "waiting" ? (
					<>
						<p className="m-0 font-medium text-fg">
							{state.window === "blocked" ? `Open ${name} to sign in` : `Waiting for you to sign in to ${name}`}
						</p>
						<p className="m-0 text-xs text-muted">
							{state.window === "blocked"
								? "Your browser blocked the sign-in window. Open it here instead; this page carries on when you're done."
								: state.window === "closed"
									? "The sign-in window was closed before you finished. Open it again to carry on."
									: "Finish in the window that opened. This page carries on by itself when you're done."}
						</p>
					</>
				) : state.phase === "connected" ? (
					<>
						<p className="m-0 font-medium text-fg">Connected to {name}</p>
						<p className="m-0 text-xs text-muted">
							{connectedText?.(state.connection) ??
								(state.connection.account === undefined
									? "Agents can use it now."
									: `Connected as ${state.connection.account}.`)}
						</p>
					</>
				) : (
					<>
						<p className="m-0 font-medium text-fg">Not connected</p>
						<p className="m-0 text-xs text-muted">{failureText(state)}</p>
					</>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{state.phase === "waiting" && code !== undefined ? (
					<>
						<a
							className={`${buttonClass("primary", "sm")} no-underline`}
							href={state.start.url}
							target="_blank"
							rel="noreferrer"
							// The code goes on the clipboard on the way, ready to paste.
							onClick={() => void navigator.clipboard?.writeText(code).catch(() => undefined)}
						>
							<ExternalLinkIcon size="sm" />
							<span className={buttonLabelClass}>Copy code and open {site.split("/")[0]}</span>
						</a>
						<Button variant="ghost" onClick={flow.cancel}>
							Cancel
						</Button>
					</>
				) : state.phase === "waiting" ? (
					<>
						{state.window === "open" ? (
							<Button onClick={flow.reopen} icon={<ExternalLinkIcon size="sm" />}>
								Show the window
							</Button>
						) : (
							<a
								className={`${buttonClass("primary", "sm")} no-underline`}
								href={state.start.url}
								target="harbour-connect"
								rel="opener"
							>
								<ExternalLinkIcon size="sm" />
								<span className={buttonLabelClass}>Open sign-in</span>
							</a>
						)}
						<Button variant="ghost" onClick={flow.cancel}>
							Cancel
						</Button>
					</>
				) : state.phase === "starting" ? (
					<Button variant="ghost" onClick={flow.cancel}>
						Cancel
					</Button>
				) : state.phase === "connected" ? (
					<>
						<Button
							variant="primary"
							onClick={() => {
								flow.reset();
								onDone?.();
							}}
						>
							Done
						</Button>
						{connectedAction?.(state.connection)}
					</>
				) : (
					<>
						<Button
							variant="primary"
							onClick={() => {
								flow.reset();
								onRetry?.();
							}}
						>
							Try again
						</Button>
						<Button variant="ghost" onClick={flow.reset}>
							Close
						</Button>
					</>
				)}
			</div>
		</div>
	);
}
