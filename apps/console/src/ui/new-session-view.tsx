import {
	Composer,
	type ComposerState,
	EmptyState,
	Notice,
	type ProjectOption,
	ProjectPicker,
	SessionHeader,
	Transcript,
} from "@harbour/ui";

// A new session before it exists, after T3 Code's new thread: the session header with nothing in it yet, an empty
// transcript saying where it starts, and the composer with the project picker in its footer. As with
// session-view.tsx, this only maps the screen's state onto @harbour/ui.

export type NewSessionState = {
	/** The project it starts in. */
	projectId: string;
	projectName: string;
	/** Every project, the ones the person can't start a session in dimmed with the reason. */
	projects: readonly ProjectOption[];
	/** The agent that will answer, once known. */
	agentName?: string;
	draft: string;
	/** Creating the session or sending its first message. */
	sending: boolean;
	/** Why the person can't start a session here (a viewer), or why no session can start (no agent). */
	blocked?: string;
	/** Why the last attempt failed, until the next. */
	failure?: string;
};

export type NewSessionHandlers = {
	onDraft: (text: string) => void;
	onProject: (id: string) => void;
	onSend: (text: string) => void;
	/** Shows Back, on a phone, to return to the list. */
	onBack?: () => void;
};

export function composerStateFor(state: Pick<NewSessionState, "blocked" | "sending">): ComposerState {
	if (state.blocked !== undefined) return "disabled";
	return state.sending ? "sending" : "idle";
}

export function NewSessionView({ state, on }: { state: NewSessionState; on: NewSessionHandlers }) {
	const who = state.agentName ?? "The agent";
	return (
		<div className="console">
			<SessionHeader
				title=""
				status="idle"
				// Nothing is connected until the session exists, and nothing has failed.
				connection={{ state: "open" }}
				onBack={on.onBack}
				meta={<span className="console-project">{state.projectName}</span>}
			/>
			<div className="console-main">
				<Transcript
					items={[]}
					empty={
						<EmptyState title={`Start a session in ${state.projectName}`}>
							{`Write the first message. ${who} answers it.`}
						</EmptyState>
					}
					dock={
						<Composer
							state={composerStateFor(state)}
							{...(state.blocked === undefined ? {} : { disabledReason: state.blocked })}
							label="First message"
							placeholder="What should this session do?"
							banner={state.failure === undefined ? undefined : <Notice level="error">{state.failure}</Notice>}
							value={state.draft}
							onChange={on.onDraft}
							onSend={(text) => on.onSend(text)}
							footer={
								<ProjectPicker
									projects={state.projects}
									value={state.projectId}
									onChange={on.onProject}
									disabled={state.sending}
								/>
							}
							autoFocus
							captureTyping
						/>
					}
				/>
			</div>
		</div>
	);
}
