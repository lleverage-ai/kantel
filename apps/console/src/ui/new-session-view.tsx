import {
	type BranchOption,
	BranchPicker,
	Composer,
	type ComposerAttachment,
	type ComposerProps,
	type ComposerState,
	EmptyState,
	Notice,
	type ProjectOption,
	ProjectPicker,
	RepoPicker,
	SessionHeader,
	Transcript,
} from "@harbour/ui";
import { isOrganisationScope } from "../api/client.ts";
import { COMPOSER_ACCESS } from "./composer-access.ts";
import { CONSOLE, CONSOLE_MAIN, CONSOLE_TRANSCRIPT } from "./shell-styles.ts";

// A new session before it exists, after T3 Code's new thread: the session header with nothing in it yet, an empty
// transcript saying where it starts, and the composer with the project picker in its footer. As with
// session-view.tsx, this only maps the screen's state onto @harbour/ui.

export type NewSessionState = {
	/** The project it starts in. */
	projectId: string;
	projectName: string;
	/** Where the project's crumb in the top bar goes: its sessions. */
	projectHref?: string;
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
	/**
	 * The repository the session's workspace starts from, when this host can seed one. Absent: no repository picker.
	 */
	repository?: {
		/** `owner/name`, or `""` for none. */
		repo: string;
		/** Repositories to offer before anything is typed. */
		recent: readonly string[];
		/** The chosen repository's branches, once a repository is chosen. */
		branches?:
			| { state: "loading" }
			| { state: "ready"; branches: readonly BranchOption[]; branch: string }
			| { state: "failed"; reason: string };
	};
	/** The model and thinking pickers, once the agent's models are known. */
	pickers?: Pick<
		ComposerProps,
		"models" | "model" | "onModelChange" | "thinking" | "defaultThinking" | "onThinkingChange"
	>;
	/** The composer's files: the attached ones and their handlers, or why it takes none. */
	files?: Pick<
		ComposerProps,
		"attachments" | "onAttach" | "onRemoveAttachment" | "onRetryAttachment" | "attachmentLimits" | "attachUnavailable"
	>;
};

export type NewSessionHandlers = {
	onDraft: (text: string) => void;
	onProject: (id: string) => void;
	onRepository?: (repo: string) => void;
	onBranch?: (branch: string) => void;
	onSend: (text: string, attachments?: readonly ComposerAttachment[]) => void;
	/** Shows Back, on a phone, to return to the list. */
	onBack?: () => void;
};

export function composerStateFor(state: Pick<NewSessionState, "blocked" | "sending">): ComposerState {
	if (state.blocked !== undefined) return "disabled";
	return state.sending ? "sending" : "idle";
}

/** What the composer's banner says: the last failure, else the repository's, else what sending is doing. */
function bannerFor(state: NewSessionState) {
	if (state.failure !== undefined) return <Notice level="error">{state.failure}</Notice>;
	const repository = state.repository;
	if (repository === undefined || repository.repo === "") return undefined;
	if (repository.branches?.state === "failed") return <Notice level="error">{repository.branches.reason}</Notice>;
	if (state.sending && repository.branches?.state === "ready") {
		return (
			<Notice>{`Copying ${repository.repo} at ${repository.branches.branch} into the session's workspace.`}</Notice>
		);
	}
	return undefined;
}

function RepositoryPickers({ state, on }: { state: NewSessionState; on: NewSessionHandlers }) {
	const repository = state.repository;
	if (repository === undefined || on.onRepository === undefined) return null;
	const branches = repository.branches;
	return (
		<>
			<RepoPicker
				value={repository.repo}
				recent={repository.recent}
				onChange={on.onRepository}
				disabled={state.sending}
			/>
			{repository.repo === "" || branches === undefined || branches.state === "failed" ? null : (
				<BranchPicker
					branches={branches.state === "ready" ? branches.branches : []}
					loading={branches.state === "loading"}
					{...(branches.state === "ready" ? { value: branches.branch } : {})}
					onChange={(branch) => on.onBranch?.(branch)}
					disabled={state.sending}
				/>
			)}
		</>
	);
}

export function NewSessionView({ state, on }: { state: NewSessionState; on: NewSessionHandlers }) {
	const who = state.agentName ?? "The agent";
	const repo = state.repository?.repo ?? "";
	return (
		<div className={CONSOLE}>
			<SessionHeader
				title=""
				parents={[
					{
						label: state.projectName,
						...(state.projectHref === undefined ? {} : { href: state.projectHref }),
					},
				]}
				// Nothing is connected until the session exists, and nothing has failed.
				connection={{ state: "open" }}
				onBack={on.onBack}
			/>
			{/* console-main is a flex row (#272): the transcript's own column keeps it, and the composer, full width. */}
			<div className={CONSOLE_MAIN}>
				<div className={CONSOLE_TRANSCRIPT}>
					<Transcript
						items={[]}
						// The greeting and the composer together in the middle of the page, as claude.ai opens a new chat.
						centreDockWhenEmpty
						empty={
							<EmptyState
								greeting
								title={
									isOrganisationScope(state.projectId)
										? "Start an organisation-wide session"
										: `Start a session in ${state.projectName}`
								}
							>
								{repo === ""
									? `Write the first message. ${who} answers it.`
									: `Write the first message. ${who} answers it, with ${repo} in its workspace.`}
							</EmptyState>
						}
						dock={
							<Composer
								state={composerStateFor(state)}
								{...(state.blocked === undefined ? {} : { disabledReason: state.blocked })}
								label="First message"
								placeholder="What should this session do?"
								banner={bannerFor(state)}
								value={state.draft}
								onChange={on.onDraft}
								{...state.pickers}
								{...COMPOSER_ACCESS}
								{...(state.files ?? { attachUnavailable: "Attaching files isn't available here" })}
								onSend={(text, attachments) => on.onSend(text, attachments)}
								footer={
									<>
										<ProjectPicker
											projects={state.projects}
											value={state.projectId}
											onChange={on.onProject}
											disabled={state.sending}
										/>
										<RepositoryPickers state={state} on={on} />
									</>
								}
								autoFocus
								captureTyping
							/>
						}
					/>
				</div>
			</div>
		</div>
	);
}
