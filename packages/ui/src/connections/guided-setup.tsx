// Tier 3 of #325: creating your own app at a provider, with Harbour's help. GitHub can create a GitHub App from a
// manifest Harbour sends, in one click; any provider with a guide gets numbered steps carrying this deployment's
// redirect URI and the template's scopes to copy exactly, its warnings (Google's Testing mode, restricted scopes),
// and last the client ID and secret, which are stored once and never shown again.

import { type FormEvent, useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton, SelectField, TextField } from "../primitives/controls.tsx";
import { ExternalLinkIcon, GuidedSetupIcon } from "../primitives/lucide.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import type {
	ConnectionsViewer,
	GitHubAppInput,
	OAuthClient,
	OAuthClientInput,
	ProviderTemplate,
	SetupGuide,
	SetupStep,
} from "./connections-model.ts";
import { ClientForm } from "./oauth-clients.tsx";

export interface GuidedSetupProps {
	readonly template: ProviderTemplate & { readonly guide: SetupGuide };
	readonly viewer: ConnectionsViewer;
	/** Saves the client the person registered (`ConnectionsSource.createClient`). */
	readonly onSaveClient: (input: OAuthClientInput) => Promise<OAuthClient>;
	/** Has GitHub create the app from Harbour's manifest; absent where the deployment can't. */
	readonly onCreateGitHubApp?: ((input: GitHubAppInput) => Promise<unknown>) | undefined;
	readonly onDone?: ((client: OAuthClient) => void) | undefined;
	/** Starts on the manual steps, for stories. */
	readonly initialMode?: "choose" | "manual";
}

/** The whole guide, as a service's page shows it in place of Connect's main column. */
export function GuidedSetup({
	template,
	viewer,
	onSaveClient,
	onCreateGitHubApp,
	onDone,
	initialMode,
}: GuidedSetupProps) {
	const id = useId();
	const { guide } = template;
	const manifest = guide.kind === "github_app_manifest" && onCreateGitHubApp !== undefined;
	const [mode, setMode] = useState<"choose" | "manual">(initialMode ?? (manifest ? "choose" : "manual"));
	const save = async (input: OAuthClientInput) => {
		const client = await onSaveClient(input);
		onDone?.(client);
	};

	return (
		<section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-5">
			<div className="flex min-w-0 flex-col gap-1.5">
				<span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-text">
					<GuidedSetupIcon size="sm" />
					Guided setup
				</span>
				<h3 id={`${id}-title`} className="m-0 text-lg font-strong text-fg">
					Create your own {template.name} app
				</h3>
				<p className="m-0 max-w-content text-sm text-muted">
					{template.name} doesn't let Harbour register itself, so connections go through an app you own in{" "}
					{guide.provider}. {manifest ? "It takes a minute." : `${guide.steps.length} steps, about five minutes.`} Its
					secret stays in Harbour's vault; nobody sees it again, agents included.
				</p>
			</div>

			{manifest && mode === "choose" ? (
				<GitHubAppChoice
					template={template}
					viewer={viewer}
					onCreate={onCreateGitHubApp}
					onManual={() => setMode("manual")}
				/>
			) : (
				<>
					{guide.notes === undefined || guide.notes.length === 0 ? null : (
						<div className="flex min-w-0 flex-col gap-2">
							{guide.notes.map((note) => (
								<Notice key={note.text} level={note.level} announce={false}>
									{note.text}
								</Notice>
							))}
						</div>
					)}
					<ol className="m-0 flex min-w-0 list-none flex-col p-0">
						{guide.steps.map((step, index) => (
							<GuideStep key={step.title} step={step} number={index + 1} />
						))}
						<li className="relative flex min-w-0 gap-4">
							<StepNumber number={guide.steps.length + 1} last />
							<div className="flex min-w-0 flex-1 flex-col gap-3 pb-1">
								<ClientForm
									guided
									title="Paste the client ID and secret"
									templates={[template]}
									viewer={viewer}
									redirectUri={guide.redirectUri}
									initialTemplateId={template.id}
									onSave={save}
									onCancel={manifest ? () => setMode("choose") : undefined}
								/>
							</div>
						</li>
					</ol>
				</>
			)}
		</section>
	);
}

/** A step's number on the rail that joins the steps. */
function StepNumber({ number, last = false }: { number: number; last?: boolean }) {
	return (
		<span className="relative flex w-7 shrink-0 flex-col items-center" aria-hidden="true">
			<span className="z-1 flex size-7 items-center justify-center rounded-full border border-border-strong bg-panel text-xs font-strong text-fg tabular-nums">
				{number}
			</span>
			{last ? null : <span className="w-px flex-1 bg-border" />}
		</span>
	);
}

function GuideStep({ step, number }: { step: SetupStep; number: number }) {
	return (
		<li className="relative flex min-w-0 gap-4">
			<StepNumber number={number} />
			<div className="flex min-w-0 flex-1 flex-col gap-2 pb-6">
				<span className="hb-sr-only">Step {number}: </span>
				<h4 className="m-0 pt-1 text-sm font-strong text-fg">{step.title}</h4>
				<p className="m-0 max-w-content text-sm text-muted">{step.detail}</p>
				{step.values === undefined ? null : (
					<dl className="m-0 flex min-w-0 flex-col gap-2">
						{step.values.map((item) => (
							<div key={`${item.label}:${item.value}`} className="flex min-w-0 flex-col gap-1">
								<dt className="text-xs font-medium text-muted">{item.label}</dt>
								<dd className="m-0 flex min-w-0 items-center gap-2">
									<code className="hb-selectable min-w-0 flex-1 rounded-control border border-border-input bg-sunken px-2.5 py-1.5 font-mono text-code wrap-anywhere select-all">
										{item.value}
									</code>
									<CopyButton text={item.value} label="Copy" iconOnly />
								</dd>
							</div>
						))}
					</dl>
				)}
				{step.link === undefined ? null : (
					<a
						href={step.link.url}
						target="_blank"
						rel="noreferrer"
						className="hb-focusable inline-flex items-center gap-1 self-start rounded-xs text-sm text-accent-text no-underline hover:underline"
					>
						{step.link.label}
						<ExternalLinkIcon size="sm" />
					</a>
				)}
			</div>
		</li>
	);
}

/**
 * GitHub's two ways: have GitHub create the app from Harbour's manifest (it opens GitHub with everything filled in,
 * and the person only confirms), or register it by hand.
 */
function GitHubAppChoice({
	template,
	viewer,
	onCreate,
	onManual,
}: {
	template: ProviderTemplate;
	viewer: ConnectionsViewer;
	onCreate: (input: GitHubAppInput) => Promise<unknown>;
	onManual: () => void;
}) {
	const [whose, setWhose] = useState(viewer.admin ? "organisation" : "user");
	const [githubOrganisation, setGitHubOrganisation] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const whoseOptions = [
		...(viewer.admin ? [{ value: "organisation", label: `${viewer.organisation}, for everyone` }] : []),
		...viewer.projects.map((project) => ({ value: `project:${project.id}`, label: `${project.name} project` })),
		{ value: "user", label: `Just me (${viewer.name})` },
	];
	const create = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setFailure(undefined);
		try {
			await onCreate({
				tier: whose === "organisation" ? "organisation" : whose === "user" ? "user" : "project",
				...(whose.startsWith("project:") ? { projectId: whose.slice("project:".length) } : {}),
				...(githubOrganisation.trim() === "" ? {} : { githubOrganisation: githubOrganisation.trim() }),
			});
		} catch (caught) {
			setFailure(caught instanceof Error ? caught.message : "GitHub couldn't be opened. Try again.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
			<form
				onSubmit={(event) => void create(event)}
				className="flex min-w-0 flex-col gap-4 rounded-panel border border-accent bg-panel p-5 shadow-[0_0_0_3px_var(--hb-accent-soft)]"
			>
				<div className="flex min-w-0 items-center justify-between gap-2">
					<h4 className="m-0 text-md font-strong text-fg">Create it on GitHub</h4>
					<Badge tone="accent">One click</Badge>
				</div>
				<p className="m-0 text-sm text-muted">
					Harbour opens GitHub with the app filled in: its name, permissions and redirect URL. You confirm it there,
					install it on the repositories agents may use, and you're back here ready to connect.
				</p>
				<SelectField
					label="Whose it is"
					value={whose}
					disabled={busy}
					options={whoseOptions}
					onChange={(event) => setWhose(event.target.value)}
				/>
				<TextField
					label="GitHub organisation"
					placeholder="Your personal account"
					hint="Leave empty to create it in your own GitHub account."
					value={githubOrganisation}
					disabled={busy}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => setGitHubOrganisation(event.target.value)}
				/>
				{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
				<Button
					type="submit"
					variant="primary"
					size="lg"
					busy={busy}
					icon={<ExternalLinkIcon />}
					className="mt-auto w-full justify-center"
				>
					Create {template.name} app
				</Button>
			</form>
			<div className="flex min-w-0 flex-col gap-4 rounded-panel border border-border bg-panel p-5">
				<h4 className="m-0 text-md font-strong text-fg">Register it by hand</h4>
				<p className="m-0 text-sm text-muted">
					Create an OAuth app or GitHub App yourself in GitHub's developer settings, then paste its client ID and
					secret. For an existing app, or settings of your own.
				</p>
				<Button size="lg" onClick={onManual} className="mt-auto w-full justify-center">
					Show the steps
				</Button>
			</div>
		</div>
	);
}
