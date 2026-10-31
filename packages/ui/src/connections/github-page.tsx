// GitHub's service page (#461): the parts only it has. Once connected, the page leads with the connection: what it can
// reach (the repositories the GitHub App is installed on that the person can open), what agents may do (the policy's
// summary, #462) and prompts that try it in a session. Before that, the two steps after the app is made (install it,
// then connect), and the app's permissions, read only: GitHub fixes them from Kantel's manifest, so no scope applies.

import { type ReactNode, useId, useState } from "react";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { LockIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { ExternalLinkIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusDot } from "../primitives/status.tsx";
import type { Status } from "../tokens/tokens.ts";
import { type PolicyLine, policyLines, readPolicyGrid } from "./connection-policy-model.ts";
import type { Connection, ConnectionReachView, ConnectionRulesSource, ConnectionsViewer } from "./connections-model.ts";
import { appPermissions, ownerCounts, repositoryCount, tryProject, tryPrompts } from "./github-page-model.ts";

const card = "flex min-w-0 flex-col gap-3 rounded-panel border border-border bg-panel p-5";
const cardTitle = "m-0 text-sm font-strong text-fg";
const textLink =
	"kt-focusable m-0 cursor-pointer self-start rounded-xs border-0 bg-transparent p-0 text-sm text-accent-text no-underline hover:underline";

/** How many repositories show before "Show all". */
const REPOSITORIES_SHOWN = 5;

/** What the GitHub App may do on GitHub, read only. `app`: its name on GitHub, when known. */
export function GitHubAppPermissions({ app }: { app?: string | undefined }) {
	const id = useId();
	return (
		<section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-2">
			<h3 id={`${id}-title`} className="m-0 text-sm font-strong text-fg">
				What {app ?? "the GitHub App"} may do on GitHub
			</h3>
			<p className="m-0 text-xs text-muted">
				Set by the app, not chosen at sign-in. A connection gets no more than these, and no more than the person who
				connected may do.
			</p>
			<ul className="m-0 flex min-w-0 list-none flex-col p-0">
				{appPermissions().map((permission) => (
					<li
						key={permission.id}
						className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 text-sm last:border-b-0"
					>
						<span className="min-w-0 text-fg">{permission.label}</span>
						<Badge tone={permission.access === "write" ? "approval" : "neutral"}>
							{permission.access === "write" ? "Read and write" : "Read only"}
						</Badge>
					</li>
				))}
			</ul>
		</section>
	);
}

/** One numbered step of GitHub's setup once the app is made. */
function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
	return (
		<li className="flex min-w-0 gap-4">
			<span
				className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-strong bg-panel text-xs font-strong text-fg tabular-nums"
				aria-hidden="true"
			>
				{number}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
				<h4 className="m-0 text-sm font-strong text-fg">
					<span className="kt-sr-only">Step {number}: </span>
					{title}
				</h4>
				{children}
			</div>
		</li>
	);
}

/**
 * GitHub once its app is made and nothing is connected: install the app on the repositories agents may use, then
 * connect your account through it. `connect` is step 2's form: who can use it and Connect. Without `installUrl` (an app
 * the console knows nothing about) only step 2 shows.
 */
export function GitHubSetupSteps({
	app,
	installUrl,
	connect,
}: {
	app?: string | undefined;
	installUrl?: string | undefined;
	connect: ReactNode;
}) {
	const name = app ?? "the GitHub App";
	return (
		<ol className="m-0 flex min-w-0 list-none flex-col gap-6 p-0">
			{installUrl === undefined ? null : (
				<Step number={1} title="Install on repositories">
					<p className="m-0 text-sm text-muted">
						Choose the repositories {name} may reach. Agents never reach a repository it isn't installed on.
					</p>
					<a
						className={`${buttonClass("secondary", "md")} self-start no-underline`}
						href={installUrl}
						target="_blank"
						rel="noreferrer"
					>
						<ExternalLinkIcon size="sm" />
						<span className={buttonLabelClass}>Install {name}</span>
					</a>
				</Step>
			)}
			<Step number={installUrl === undefined ? 1 : 2} title="Connect your account">
				<p className="m-0 text-sm text-muted">
					Sign in on GitHub as yourself. Agents act as you, only in the repositories {name} is installed on and you can
					open.
				</p>
				{connect}
			</Step>
		</ol>
	);
}

export interface GitHubOverviewProps {
	readonly connection: Connection;
	readonly viewer: ConnectionsViewer;
	readonly now: number;
	/** The GitHub App's name on GitHub, when known. */
	readonly app?: string | undefined;
	/** Asks what the connection reaches (`ConnectionsSource.reach`). Without it, the card says GitHub wasn't asked. */
	readonly reach?: ((connectionId: string) => Promise<ConnectionReachView | undefined>) | undefined;
	/** The connection's rules, for What agents may do. Without them, its one-line summary. */
	readonly rules?: ConnectionRulesSource | undefined;
	/** Opens the connection's page, where its rules are edited. */
	readonly onEditRules?: ((connection: Connection) => void) | undefined;
	/** Starts a session in a project with a prompt ready to send. Without it, no Try it. */
	readonly onTry?: ((projectId: string, prompt: string) => void) | undefined;
}

/** A connected GitHub account at a glance: what it reaches, what agents may do, and a session to try it in. */
export function GitHubOverview({
	connection,
	viewer,
	now,
	app,
	reach,
	rules,
	onEditRules,
	onTry,
}: GitHubOverviewProps) {
	const asked = useLoad(
		async () => (reach === undefined ? undefined : reach(connection.id)),
		[connection.id, reach === undefined],
	);
	const loaded = asked.state.status === "ready" ? asked.state.value : undefined;
	const projectId = tryProject(connection, viewer);
	return (
		<div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
			<ReachCard
				state={reach === undefined ? { status: "ready", value: undefined } : asked.state}
				app={app}
				onRetry={asked.reload}
			/>
			<PolicyCard connection={connection} rules={rules} now={now} onEdit={onEditRules} />
			{onTry === undefined || projectId === undefined ? null : (
				<TryCard
					prompts={tryPrompts(loaded)}
					project={viewer.projects.find((project) => project.id === projectId)?.name}
					onTry={(prompt) => onTry(projectId, prompt)}
				/>
			)}
		</div>
	);
}

type ReachState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: unknown }
	| { readonly status: "ready"; readonly value: ConnectionReachView | undefined };

function ReachCard({ state, app, onRetry }: { state: ReachState; app?: string | undefined; onRetry: () => void }) {
	const id = useId();
	const [all, setAll] = useState(false);
	const name = app ?? "the GitHub App";
	let body: ReactNode;
	if (state.status === "loading") {
		body = (
			<div className="flex min-w-0 flex-col gap-3" aria-busy="true">
				<Skeleton width="60%" />
				<Skeleton lines={3} />
			</div>
		);
	} else if (state.status === "error") {
		body = (
			<>
				<p className="m-0 text-sm text-muted">Kantel couldn't ask GitHub what this connection reaches just now.</p>
				<Button size="sm" onClick={onRetry} className="self-start">
					Try again
				</Button>
			</>
		);
	} else if (state.value === undefined) {
		body = (
			<p className="m-0 text-sm text-muted">
				GitHub doesn't say which repositories this connection reaches. Agents reach what the account can open.
			</p>
		);
	} else {
		const reach = state.value;
		const shown = all ? reach.repositories : reach.repositories.slice(0, REPOSITORIES_SHOWN);
		const more = reach.repositories.length - REPOSITORIES_SHOWN;
		const owners = ownerCounts(reach);
		body = (
			<>
				<p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
					<span className="font-strong text-fg">{repositoryCount(reach)}</span>
					{owners === "" ? null : <span className="text-muted">{owners}</span>}
				</p>
				<p className="m-0 text-sm text-muted">
					{reach.repositories.length === 0
						? `None yet. Install ${name} on the repositories agents may use.`
						: `Only repositories ${name} is installed on that you can open yourself.`}
				</p>
				{shown.length === 0 ? null : (
					<ul
						aria-label="Repositories"
						// Scrolls when it's long, and takes focus so a keyboard can scroll it too.
						{...(all ? { tabIndex: 0 } : {})}
						className={`kt-focusable m-0 flex min-w-0 list-none flex-col rounded-control border border-border p-0${all ? " max-h-72 overflow-y-auto" : ""}`}
					>
						{shown.map((repository) => (
							<li
								key={repository.fullName}
								className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
							>
								<span className="kt-mono min-w-0 truncate text-xs text-fg">{repository.fullName}</span>
								{repository.private ? (
									<span className="flex shrink-0 items-center gap-1 text-xs text-muted">
										<LockIcon size="sm" />
										Private
									</span>
								) : null}
							</li>
						))}
					</ul>
				)}
				{more > 0 ? (
					<button type="button" className={textLink} aria-expanded={all} onClick={() => setAll(!all)}>
						{all ? "Show fewer" : `Show all ${reach.repositories.length}`}
					</button>
				) : null}
				{reach.truncated ? (
					<p className="m-0 text-xs text-muted">
						Kantel lists the first {reach.repositories.length}; GitHub has the rest.
					</p>
				) : null}
				{reach.manageUrl === undefined ? null : (
					<a
						className={`${buttonClass("secondary", "sm")} self-start no-underline`}
						href={reach.manageUrl}
						target="_blank"
						rel="noreferrer"
					>
						<ExternalLinkIcon size="sm" />
						<span className={buttonLabelClass}>Manage repositories on GitHub</span>
					</a>
				)}
			</>
		);
	}
	return (
		<section aria-labelledby={`${id}-title`} className={card}>
			<h3 id={`${id}-title`} className={cardTitle}>
				What it can reach
			</h3>
			{body}
		</section>
	);
}

const LINE_STATUS: Record<PolicyLine["answer"], Status> = {
	allow: "done",
	ask: "approval",
	deny: "error",
	mixed: "idle",
};

function PolicyCard({
	connection,
	rules,
	now,
	onEdit,
}: {
	connection: Connection;
	rules?: ConnectionRulesSource | undefined;
	now: number;
	onEdit?: ((connection: Connection) => void) | undefined;
}) {
	const id = useId();
	const read = useLoad(
		async () => (rules === undefined ? undefined : rules.get(connection.id)),
		[rules, connection.id],
	);
	let body: ReactNode;
	if (rules === undefined || read.state.status === "error") {
		body = <p className="m-0 text-sm text-muted">{connection.rulesSummary ?? "Its rules decide each request."}</p>;
	} else if (read.state.status === "loading" || read.state.value === undefined) {
		body = <Skeleton lines={3} />;
	} else {
		const lines = policyLines(
			readPolicyGrid(read.state.value, {
				templateId: connection.templateId,
				host: connection.hosts[0] ?? "api.github.com",
				...(connection.owner.kind === "project" ? { projectId: connection.owner.projectId } : {}),
				now,
			}),
		);
		body = (
			<ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
				{lines.map((line) => (
					<li key={line.access} className="flex min-w-0 items-baseline gap-2 text-sm text-fg">
						<span className="flex translate-y-(--kt-on-cap)">
							<StatusDot status={LINE_STATUS[line.answer]} />
						</span>
						{line.text}
					</li>
				))}
			</ul>
		);
	}
	return (
		<section aria-labelledby={`${id}-title`} className={card}>
			<h3 id={`${id}-title`} className={cardTitle}>
				What agents may do
			</h3>
			{body}
			{onEdit === undefined ? null : (
				<button type="button" className={textLink} onClick={() => onEdit(connection)}>
					Edit what agents may do
				</button>
			)}
		</section>
	);
}

function TryCard({
	prompts,
	project,
	onTry,
}: {
	prompts: readonly string[];
	project?: string | undefined;
	onTry: (prompt: string) => void;
}) {
	const id = useId();
	return (
		<section aria-labelledby={`${id}-title`} className={`${card} md:col-span-2`}>
			<h3 id={`${id}-title`} className={cardTitle}>
				Try it in a session
			</h3>
			<ul className="m-0 flex min-w-0 list-none flex-wrap gap-2 p-0">
				{prompts.map((prompt) => (
					<li key={prompt} className="min-w-0">
						<button
							type="button"
							onClick={() => onTry(prompt)}
							className="kt-focusable m-0 max-w-full cursor-pointer rounded-full border border-border-strong bg-transparent px-3 py-1 text-left text-sm text-fg hover:bg-hover"
						>
							{prompt}
						</button>
					</li>
				))}
			</ul>
			<p className="m-0 text-xs text-muted">
				Opens a new session{project === undefined ? "" : ` in ${project}`} with the prompt ready to send.
			</p>
		</section>
	);
}
