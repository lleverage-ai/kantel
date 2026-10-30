import {
	type CatalogueEntry,
	type Connection,
	ONBOARDING_STEPS,
	type ModelProvider,
	type ModelProviderList,
	type ModelSignIn,
	type Onboarding,
	type OnboardingStepId,
	type OnboardingStepStatus,
} from "@harbour/contracts";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Disclosure, SelectField, TextAreaField, TextField } from "../primitives/controls.tsx";
import { FormActions } from "../primitives/form-layout.tsx";
import { CheckIcon, KeyIcon, SparkIcon } from "../primitives/icons.tsx";
import { ExternalLinkIcon } from "../primitives/lucide.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice, Panel } from "../primitives/surface.tsx";
import { type OnboardingApi, type OnboardingProject, problemOf } from "./onboarding-api.ts";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/** What each step is called and says it is for. */
export const ONBOARDING_STEP_TEXT: Readonly<Record<OnboardingStepId, { title: string; lede: string }>> = {
	models: {
		title: "Connect a model",
		lede: "Sign in with a Claude or ChatGPT subscription, or add a provider's API key. Keys go into the vault and are never shown again.",
	},
	connectors: {
		title: "Add connectors",
		lede: "Let agents reach the tools you use. Sign in once; Harbour keeps the credential in the vault and sends it only to that service.",
	},
	session: {
		title: "Start your first session",
		lede: "Give the agent something to do. You can change models and connectors later in settings.",
	},
};

/** How often a sign-in or a connect is asked about while the person signs in elsewhere. */
export const POLL_MS = 2_000;

/** Ideas for a first message, one click each. */
export const FIRST_SESSION_IDEAS: readonly string[] = [
	"Tell me what you can do here, and what you'd need from me to do more.",
	"Read the repository in this project and summarise how it fits together.",
	"Make a short plan for my week from my calendar and open issues.",
];

export interface OnboardingPageProps {
	/** Every call the page makes, each one public API route (`onboarding-api.ts`). */
	readonly api: OnboardingApi;
	/** Where the first session can start. */
	readonly projects: readonly OnboardingProject[];
	/** The product's name, as the console's header shows it. */
	readonly product?: string;
	/**
	 * Whether the person may change the setup: an organisation-wide admin. Anyone else sees the steps and is told who
	 * can; the server refuses them either way.
	 */
	readonly canChange?: boolean;
	/** Leaves the onboarding for the console: after skipping it all, finishing it, or as someone who can't change it. */
	readonly onLeave: () => void;
	/** The first session has started: open it. */
	readonly onSessionStarted: (projectId: string, sessionId: string) => void;
	/** Opens a provider's sign-in page. Default a new tab. */
	readonly openUrl?: (url: string) => void;
	/** Where the page starts, for stories and screenshots; it loads the rest either way. */
	readonly initial?: {
		readonly onboarding?: Onboarding;
		readonly providers?: ModelProviderList;
		readonly catalogue?: readonly CatalogueEntry[];
		readonly connections?: readonly Connection[];
	};
}

const defaultOpen = (url: string) => {
	window.open(url, "_blank", "noopener");
};

/**
 * First-run onboarding: connect a model, add connectors, start a first session. Each step can be skipped, the whole
 * thing dismissed, and where the person is is kept on the server (`/v1/onboarding`), so a reload or another browser
 * picks up at the same step. Every step uses the same public API a host app would.
 */
export function OnboardingPage({
	api,
	projects,
	product = "Harbour",
	canChange = true,
	onLeave,
	onSessionStarted,
	openUrl = defaultOpen,
	initial,
}: OnboardingPageProps) {
	const [onboarding, setOnboarding] = useState<Onboarding | undefined>(initial?.onboarding);
	const [problem, setProblem] = useState<string>();
	const [moving, setMoving] = useState(false);
	const [providers, setProviders] = useState<ModelProviderList | undefined>(initial?.providers);

	useEffect(() => {
		let live = true;
		api.get().then(
			(found) => live && setOnboarding(found),
			(reason: unknown) => live && setProblem(problemOf(reason)),
		);
		return () => {
			live = false;
		};
	}, [api]);

	const refreshProviders = useCallback(async () => {
		try {
			setProviders(await api.modelProviders());
		} catch (reason) {
			setProblem(problemOf(reason));
		}
	}, [api]);
	useEffect(() => {
		void refreshProviders();
	}, [refreshProviders]);

	/** One change to the onboarding: the server answers with where it is now. */
	const change = useCallback(async (call: () => Promise<Onboarding>, after?: (next: Onboarding) => void) => {
		setMoving(true);
		setProblem(undefined);
		try {
			const next = await call();
			setOnboarding(next);
			after?.(next);
		} catch (reason) {
			setProblem(problemOf(reason));
		} finally {
			setMoving(false);
		}
	}, []);

	const settle = (step: OnboardingStepId, status: Exclude<OnboardingStepStatus, "pending">) =>
		change(
			() => api.setStep(step, status),
			(next) => {
				if (next.status === "completed" && step !== "session") onLeave();
			},
		);
	const dismiss = () => change(() => api.dismiss(), onLeave);

	if (onboarding === undefined) {
		return (
			<Frame>
				{problem === undefined ? (
					<Skeleton lines={4} />
				) : (
					<Notice level="error">The setup couldn't be read. {problem}</Notice>
				)}
			</Frame>
		);
	}

	const current = onboarding.current;
	const index = ONBOARDING_STEPS.indexOf(current);
	const previous = index > 0 ? ONBOARDING_STEPS[index - 1] : undefined;
	const text = ONBOARDING_STEP_TEXT[current];

	return (
		<Frame>
			<header className="flex items-start justify-between gap-4 max-sm:flex-col">
				<div className="flex min-w-0 flex-col gap-1">
					<p className="m-0 text-sm font-strong text-muted">{product}</p>
					<h1 className="m-0 text-lg font-strong text-fg">Set up {product}</h1>
					<p className="m-0 text-sm text-muted">
						Three steps, each one optional. Your progress is saved, so you can leave and come back.
					</p>
				</div>
				<Button variant="ghost" onClick={() => void dismiss()} disabled={moving || !canChange}>
					Skip setup
				</Button>
			</header>

			<Stepper
				onboarding={onboarding}
				disabled={moving || !canChange}
				onSelect={(step) => void change(() => api.goTo(step))}
			/>

			{canChange ? null : (
				<Notice level="warning" action={<Button onClick={onLeave}>Open the console</Button>}>
					Only an organisation admin can connect models and connectors. Ask one to finish setting up.
				</Notice>
			)}
			{problem === undefined ? null : <Notice level="error">{problem}</Notice>}

			<Panel
				aria-labelledby="onboarding-step-title"
				header={
					<div className="flex flex-col gap-1">
						<p className="m-0 text-xs text-muted">
							Step {index + 1} of {ONBOARDING_STEPS.length}
						</p>
						<h2 id="onboarding-step-title" className="m-0 text-md font-strong text-fg">
							{text.title}
						</h2>
						<p className="m-0 text-sm text-muted">{text.lede}</p>
					</div>
				}
			>
				{current === "models" ? (
					<ModelsStep
						api={api}
						providers={providers}
						refresh={refreshProviders}
						disabled={!canChange}
						openUrl={openUrl}
					/>
				) : current === "connectors" ? (
					<ConnectorsStep api={api} disabled={!canChange} openUrl={openUrl} initial={initial} />
				) : (
					<SessionStep
						api={api}
						projects={projects}
						defaultRoute={providers?.defaultRoute}
						modelsKnown={providers !== undefined}
						disabled={!canChange || moving}
						onStarted={(projectId, sessionId) =>
							void change(
								() => api.setStep("session", "done"),
								() => onSessionStarted(projectId, sessionId),
							)
						}
					/>
				)}
			</Panel>

			<FormActions>
				{previous === undefined ? null : (
					<Button variant="ghost" onClick={() => void change(() => api.goTo(previous))} disabled={moving}>
						Back
					</Button>
				)}
				<Button onClick={() => void settle(current, "skipped")} disabled={moving || !canChange}>
					Skip this step
				</Button>
				{current === "session" ? (
					onboarding.status === "completed" ? (
						<Button variant="primary" onClick={onLeave}>
							Open the console
						</Button>
					) : null
				) : (
					<Button
						variant="primary"
						onClick={() => void settle(current, "done")}
						busy={moving}
						disabled={!canChange}
					>
						Continue
					</Button>
				)}
			</FormActions>
		</Frame>
	);
}

function Frame({ children }: { children: ReactNode }) {
	return (
		<div className="min-h-full w-full overflow-y-auto">
			<main className="mx-auto flex w-full max-w-content flex-col gap-6 px-gutter py-12 max-sm:px-gutter-narrow max-sm:py-8">
				{children}
			</main>
		</div>
	);
}

const stepStatusText: Readonly<Record<OnboardingStepStatus, string>> = {
	pending: "To do",
	done: "Done",
	skipped: "Skipped",
};

/** The three steps across the top: each one's state, and a way to go to it. */
function Stepper({
	onboarding,
	disabled,
	onSelect,
}: {
	onboarding: Onboarding;
	disabled: boolean;
	onSelect: (step: OnboardingStepId) => void;
}) {
	return (
		<nav aria-label="Setup steps">
			<ol className="m-0 grid list-none grid-cols-3 gap-2 p-0 max-sm:grid-cols-1">
				{ONBOARDING_STEPS.map((step, at) => {
					const status = onboarding.steps[step];
					const here = step === onboarding.current;
					return (
						<li key={step} className="min-w-0">
							<button
								type="button"
								onClick={() => onSelect(step)}
								disabled={disabled || here}
								aria-current={here ? "step" : undefined}
								className={`hb-focusable flex w-full items-center gap-3 rounded-control border px-3 py-2 text-left disabled:cursor-default ${
									here ? "border-accent bg-accent-soft" : "border-border bg-panel enabled:hover:bg-hover"
								}`}
							>
								<span
									className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-strong ${
										status === "done"
											? "bg-status-done text-on-solid"
											: here
												? "bg-accent text-accent-fg"
												: "bg-sunken text-muted"
									}`}
									aria-hidden="true"
								>
									{status === "done" ? <CheckIcon size="sm" /> : at + 1}
								</span>
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-sm font-medium text-fg">{ONBOARDING_STEP_TEXT[step].title}</span>
									<span className="text-xs text-muted">{stepStatusText[status]}</span>
								</span>
							</button>
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

// The models step.

type SignInState =
	| { readonly status: "starting" }
	| { readonly status: "pending"; readonly signIn: ModelSignIn }
	| { readonly status: "failed"; readonly error: string };

function ModelsStep({
	api,
	providers,
	refresh,
	disabled,
	openUrl,
}: {
	api: OnboardingApi;
	providers: ModelProviderList | undefined;
	refresh: () => Promise<void>;
	disabled: boolean;
	openUrl: (url: string) => void;
}) {
	const [open, setOpen] = useState<string>();
	const [signIns, setSignIns] = useState<Readonly<Record<string, SignInState>>>({});

	const pending = Object.entries(signIns).flatMap(([id, state]) =>
		state.status === "pending" ? [{ id, signIn: state.signIn }] : [],
	);
	// Asks about each sign-in under way until it settles.
	useEffect(() => {
		if (pending.length === 0) return;
		const timer = setInterval(() => {
			for (const { id, signIn } of pending) {
				api.signInStatus(signIn.providerId, signIn.id).then(
					(next) => {
						if (next.status === "pending") return;
						setSignIns((all) => {
							const { [id]: _, ...rest } = all;
							return next.status === "failed"
								? { ...rest, [id]: { status: "failed", error: next.error ?? "The sign-in failed." } }
								: rest;
						});
						if (next.status === "completed") void refresh();
					},
					() => undefined,
				);
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [api, pending, refresh]);

	if (providers === undefined) return <Skeleton lines={5} />;

	const subscriptions = providers.items.filter((provider) => provider.auth === "subscription");
	const keys = providers.items.filter((provider) => provider.auth === "key");

	const startSignIn = async (provider: ModelProvider) => {
		setSignIns((all) => ({ ...all, [provider.id]: { status: "starting" } }));
		try {
			const signIn = await api.startSignIn(provider.id);
			if (signIn.url !== undefined) openUrl(signIn.url);
			setSignIns((all) => ({ ...all, [provider.id]: { status: "pending", signIn } }));
		} catch (reason) {
			setSignIns((all) => ({ ...all, [provider.id]: { status: "failed", error: problemOf(reason) } }));
		}
	};

	return (
		<div className="flex flex-col gap-5">
			<DefaultRoute providers={providers} />
			<section className="flex flex-col gap-2" aria-labelledby="onboarding-subscriptions">
				<h3 id="onboarding-subscriptions" className="m-0 text-sm font-strong text-fg">
					Subscriptions
				</h3>
				<div className="flex flex-col rounded-control border border-border">
					{subscriptions.map((provider) => (
						<SubscriptionRow
							key={provider.id}
							provider={provider}
							state={signIns[provider.id]}
							disabled={disabled}
							onSignIn={() => void startSignIn(provider)}
							onFinish={async (redirectUrl) => {
								const state = signIns[provider.id];
								if (state?.status !== "pending") return;
								const next = await api.finishSignIn(provider.id, state.signIn.id, redirectUrl);
								setSignIns((all) => ({ ...all, [provider.id]: { status: "pending", signIn: next } }));
							}}
						/>
					))}
				</div>
			</section>
			<section className="flex flex-col gap-2" aria-labelledby="onboarding-keys">
				<h3 id="onboarding-keys" className="m-0 text-sm font-strong text-fg">
					API keys
				</h3>
				<div className="flex flex-col rounded-control border border-border">
					{keys.map((provider) => (
						<KeyProviderRow
							key={provider.id}
							api={api}
							provider={provider}
							open={open === provider.id}
							disabled={disabled}
							onOpen={() => setOpen(open === provider.id ? undefined : provider.id)}
							onConnected={async () => {
								setOpen(undefined);
								await refresh();
							}}
						/>
					))}
				</div>
			</section>
		</div>
	);
}

function DefaultRoute({ providers }: { providers: ModelProviderList }) {
	const route = providers.defaultRoute;
	if (route === undefined) {
		return (
			<Notice level="warning">
				Nothing serves sessions yet. Connect a subscription or a key so agents have a model to run on.
			</Notice>
		);
	}
	return (
		<Notice level="info">
			Sessions run on <span className="font-mono text-xs">{route.modelId}</span>
			{route.owner === "platform" ? ", this deployment's default." : ", your organisation's default."}
		</Notice>
	);
}

function SubscriptionRow({
	provider,
	state,
	disabled,
	onSignIn,
	onFinish,
}: {
	provider: ModelProvider;
	state: SignInState | undefined;
	disabled: boolean;
	onSignIn: () => void;
	onFinish: (redirectUrl: string) => Promise<void>;
}) {
	const account = provider.connection?.account;
	const trailing =
		provider.connection !== undefined ? (
			<Badge tone="done">{account === undefined ? "Signed in" : `Signed in as ${account}`}</Badge>
		) : !provider.available ? (
			<Badge>Unavailable</Badge>
		) : state?.status === "pending" || state?.status === "starting" ? (
			<Spinner size="sm" label="Waiting for the sign-in" />
		) : (
			<Button size="xs" icon={<ExternalLinkIcon size="sm" />} onClick={onSignIn} disabled={disabled}>
				Sign in
			</Button>
		);
	return (
		<div className="border-b border-border last:border-b-0">
			<ListRow
				density="comfortable"
				leading={<SparkIcon />}
				title={provider.name}
				meta={provider.available ? provider.description : provider.unavailableReason}
				trailing={trailing}
				quiet={!provider.available}
			/>
			{state?.status === "failed" ? (
				<div className="px-3 pb-3">
					<Notice level="error">{state.error}</Notice>
				</div>
			) : null}
			{state?.status === "pending" ? (
				<div className="flex flex-col gap-2 px-3 pb-3">
					<p className="m-0 text-sm text-muted">
						Finish signing in on the page that opened. This updates by itself when you're done.
					</p>
					{state.signIn.url === undefined ? null : (
						<p className="m-0 text-xs text-muted">
							Page didn't open?{" "}
							<a className="text-accent-text" href={state.signIn.url} target="_blank" rel="noopener noreferrer">
								Open the sign-in page
							</a>
						</p>
					)}
					<FinishSignIn onFinish={onFinish} />
				</div>
			) : null}
		</div>
	);
}

/** For a sign-in whose provider couldn't send the browser back here: the address it ended up on. */
function FinishSignIn({ onFinish }: { onFinish: (redirectUrl: string) => Promise<void> }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			await onFinish(value.trim());
			setValue("");
		} catch (reason) {
			setError(problemOf(reason));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Disclosure summary="Signing in on another machine?">
			<form className="flex flex-col gap-2 pt-2" onSubmit={(event) => void submit(event)}>
				<TextField
					label="The address the browser ended up on"
					hint="After you approve, the provider sends you to a page that may not load. Copy its address here."
					value={value}
					onChange={(event) => setValue(event.target.value)}
					mono
					{...(error === undefined ? {} : { error })}
				/>
				<FormActions>
					<Button type="submit" busy={busy} disabled={value.trim() === ""}>
						Finish signing in
					</Button>
				</FormActions>
			</form>
		</Disclosure>
	);
}

function KeyProviderRow({
	api,
	provider,
	open,
	disabled,
	onOpen,
	onConnected,
}: {
	api: OnboardingApi;
	provider: ModelProvider;
	open: boolean;
	disabled: boolean;
	onOpen: () => void;
	onConnected: () => Promise<void>;
}) {
	const connected = provider.connection !== undefined;
	const trailing = !provider.available ? (
		<Badge>Unavailable</Badge>
	) : (
		<span className="flex items-center gap-2">
			{connected ? <Badge tone="done">Connected</Badge> : null}
			<Button size="xs" icon={<KeyIcon size="sm" />} onClick={onOpen} disabled={disabled} aria-expanded={open}>
				{connected ? "Replace key" : "Add key"}
			</Button>
		</span>
	);
	const meta =
		!provider.available && provider.unavailableReason !== undefined
			? provider.unavailableReason
			: connected && provider.connection?.modelId !== undefined
				? `${provider.description} Routes: ${provider.connection.routes.join(", ")} (${provider.connection.modelId}).`
				: provider.description;
	return (
		<div className="border-b border-border last:border-b-0">
			<ListRow
				density="comfortable"
				leading={<KeyIcon />}
				title={provider.name}
				meta={meta}
				trailing={trailing}
				quiet={!provider.available}
			/>
			{open ? <KeyForm api={api} provider={provider} onConnected={onConnected} /> : null}
		</div>
	);
}

function KeyForm({
	api,
	provider,
	onConnected,
}: {
	api: OnboardingApi;
	provider: ModelProvider;
	onConnected: () => Promise<void>;
}) {
	const [key, setKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [model, setModel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const needsBaseUrl = provider.baseUrl === undefined;
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			await api.connectModelKey(provider.id, {
				key: key.trim(),
				...(baseUrl.trim() === "" ? {} : { baseUrl: baseUrl.trim() }),
				...(model.trim() === "" ? {} : { model: model.trim() }),
			});
			setKey("");
			await onConnected();
		} catch (reason) {
			setError(problemOf(reason));
		} finally {
			setBusy(false);
		}
	};
	const hint = `${provider.keyPrefix === undefined ? "" : `Starts with ${provider.keyPrefix}. `}Stored in the vault and never shown again.`;
	return (
		<form className="flex flex-col gap-3 px-3 pb-3" onSubmit={(event) => void submit(event)}>
			<TextField
				label={`${provider.name} API key`}
				type="password"
				autoComplete="off"
				spellCheck={false}
				value={key}
				onChange={(event) => setKey(event.target.value)}
				hint={hint}
				mono
				extra={
					provider.keyUrl === undefined ? undefined : (
						<a className="text-xs text-accent-text" href={provider.keyUrl} target="_blank" rel="noopener noreferrer">
							Get a key
						</a>
					)
				}
				{...(error === undefined ? {} : { error })}
			/>
			{needsBaseUrl ? (
				<TextField
					label="Base URL"
					placeholder="https://models.example.com/v1"
					value={baseUrl}
					onChange={(event) => setBaseUrl(event.target.value)}
					mono
				/>
			) : null}
			<TextField
				label="Model"
				hint={
					provider.defaultModel === undefined
						? "The model sessions use through this provider."
						: `Leave empty for ${provider.defaultModel}.`
				}
				placeholder={provider.defaultModel}
				value={model}
				onChange={(event) => setModel(event.target.value)}
				mono
			/>
			<FormActions>
				<Button
					type="submit"
					variant="primary"
					busy={busy}
					disabled={key.trim() === "" || (needsBaseUrl && baseUrl.trim() === "")}
				>
					Save key
				</Button>
			</FormActions>
		</form>
	);
}

// The connectors step.

type ConnectState =
	| { readonly status: "starting" }
	| { readonly status: "pending"; readonly attemptId: string; readonly url?: string }
	| { readonly status: "key" }
	| { readonly status: "failed"; readonly error: string };

/** A template connects with a key when it has a key auth type and no OAuth sign-in. */
const connectsWithKey = (entry: CatalogueEntry) =>
	!entry.authTypes.includes("oauth2") &&
	entry.authTypes.some((type) => type !== "oauth2_client_credentials" && type !== "none");

function ConnectorsStep({
	api,
	disabled,
	openUrl,
	initial,
}: {
	api: OnboardingApi;
	disabled: boolean;
	openUrl: (url: string) => void;
	initial: OnboardingPageProps["initial"];
}) {
	const connections = api.connections;
	const [catalogue, setCatalogue] = useState<readonly CatalogueEntry[] | undefined>(initial?.catalogue);
	const [connected, setConnected] = useState<readonly Connection[]>(initial?.connections ?? []);
	const [problem, setProblem] = useState<string>();
	const [query, setQuery] = useState("");
	const [states, setStates] = useState<Readonly<Record<string, ConnectState>>>({});

	const load = useCallback(async () => {
		if (connections === undefined) return;
		try {
			const [entries, mine] = await Promise.all([connections.catalogue(), connections.connections()]);
			setCatalogue(entries);
			setConnected(mine);
		} catch (reason) {
			setProblem(problemOf(reason));
		}
	}, [connections]);
	useEffect(() => {
		void load();
	}, [load]);

	const pending = Object.entries(states).flatMap(([id, state]) =>
		state.status === "pending" ? [{ id, attemptId: state.attemptId }] : [],
	);
	useEffect(() => {
		if (pending.length === 0 || connections === undefined) return;
		const timer = setInterval(() => {
			for (const { id, attemptId } of pending) {
				connections.attempt(attemptId).then(
					(attempt) => {
						if (attempt.status === "pending") return;
						setStates((all) => {
							const { [id]: _, ...rest } = all;
							return attempt.status === "completed"
								? rest
								: {
										...rest,
										[id]: {
											status: "failed",
											error: attempt.failure?.message ?? "The sign-in didn't finish. Try again.",
										},
									};
						});
						if (attempt.status === "completed") void load();
					},
					() => undefined,
				);
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [connections, pending, load]);

	const shown = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return (catalogue ?? []).filter(
			(entry) =>
				needle === "" ||
				entry.name.toLowerCase().includes(needle) ||
				entry.description.toLowerCase().includes(needle) ||
				entry.category.includes(needle),
		);
	}, [catalogue, query]);

	if (connections === undefined) {
		return (
			<EmptyState title="Connectors aren't available here yet">
				This deployment doesn't serve the Connections API. Skip this step; you can add connectors later in settings.
			</EmptyState>
		);
	}
	if (catalogue === undefined) {
		return problem === undefined ? (
			<Skeleton lines={5} />
		) : (
			<Notice level="error">The catalogue couldn't be read. {problem}</Notice>
		);
	}

	const connect = async (entry: CatalogueEntry) => {
		if (connectsWithKey(entry)) {
			setStates((all) => ({ ...all, [entry.id]: { status: "key" } }));
			return;
		}
		setStates((all) => ({ ...all, [entry.id]: { status: "starting" } }));
		try {
			const attempt = await connections.connect(entry.id);
			if (attempt.status === "completed") {
				setStates(({ [entry.id]: _, ...rest }) => rest);
				await load();
				return;
			}
			if (attempt.connectUrl !== undefined) openUrl(attempt.connectUrl);
			setStates((all) => ({
				...all,
				[entry.id]: {
					status: "pending",
					attemptId: attempt.id,
					...(attempt.connectUrl === undefined ? {} : { url: attempt.connectUrl }),
				},
			}));
		} catch (reason) {
			setStates((all) => ({ ...all, [entry.id]: { status: "failed", error: problemOf(reason) } }));
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<TextField
				label="Search connectors"
				hideLabel
				type="search"
				placeholder="Search GitHub, Linear, Notion…"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			{shown.length === 0 ? (
				<EmptyState title="No connector matches">Try another name, or skip this step.</EmptyState>
			) : (
				<ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 max-sm:grid-cols-1">
					{shown.map((entry) => (
						<li key={entry.id} className="min-w-0">
							<ConnectorCard
								entry={entry}
								connected={connected.some((connection) => connection.templateId === entry.id)}
								state={states[entry.id]}
								disabled={disabled}
								onConnect={() => void connect(entry)}
								onKey={async (value) => {
									await connections.connectKey(entry.id, value);
									setStates(({ [entry.id]: _, ...rest }) => rest);
									await load();
								}}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function ConnectorCard({
	entry,
	connected,
	state,
	disabled,
	onConnect,
	onKey,
}: {
	entry: CatalogueEntry;
	connected: boolean;
	state: ConnectState | undefined;
	disabled: boolean;
	onConnect: () => void;
	onKey: (value: string) => Promise<void>;
}) {
	const action = connected ? (
		<Badge tone="done">Connected</Badge>
	) : entry.setup === "needs_client" ? (
		<Badge>Needs an OAuth app</Badge>
	) : state?.status === "pending" || state?.status === "starting" ? (
		<Spinner size="sm" label={`Waiting for ${entry.name}`} />
	) : state?.status === "key" ? null : (
		<Button size="xs" onClick={onConnect} disabled={disabled}>
			Connect
		</Button>
	);
	return (
		<div className="flex h-full flex-col gap-2 rounded-control border border-border bg-panel p-3">
			<div className="flex items-start gap-3">
				<img src={entry.icon} alt="" className="size-6 shrink-0 rounded-xs" />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-sm font-medium text-fg">{entry.name}</span>
					<span className="line-clamp-2 text-xs text-muted">{entry.description}</span>
				</div>
				<div className="shrink-0">{action}</div>
			</div>
			{state?.status === "failed" ? <Notice level="error">{state.error}</Notice> : null}
			{state?.status === "pending" ? (
				<p className="m-0 text-xs text-muted">
					Finish signing in on the page that opened.{" "}
					{state.url === undefined ? null : (
						<a className="text-accent-text" href={state.url} target="_blank" rel="noopener noreferrer">
							Open it again
						</a>
					)}
				</p>
			) : null}
			{state?.status === "key" ? <ConnectorKeyForm name={entry.name} onKey={onKey} /> : null}
		</div>
	);
}

function ConnectorKeyForm({ name, onKey }: { name: string; onKey: (value: string) => Promise<void> }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			await onKey(value.trim());
		} catch (reason) {
			setError(problemOf(reason));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
			<TextField
				label={`${name} key`}
				type="password"
				autoComplete="off"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				hint="Stored in the vault and never shown again."
				mono
				{...(error === undefined ? {} : { error })}
			/>
			<FormActions>
				<Button type="submit" variant="primary" size="xs" busy={busy} disabled={value.trim() === ""}>
					Save key
				</Button>
			</FormActions>
		</form>
	);
}

// The first session.

function SessionStep({
	api,
	projects,
	defaultRoute,
	modelsKnown,
	disabled,
	onStarted,
}: {
	api: OnboardingApi;
	projects: readonly OnboardingProject[];
	defaultRoute: ModelProviderList["defaultRoute"];
	modelsKnown: boolean;
	disabled: boolean;
	onStarted: (projectId: string, sessionId: string) => void;
}) {
	const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
	const [text, setText] = useState(FIRST_SESSION_IDEAS[0] ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	if (projects.length === 0) {
		return (
			<EmptyState title="There's no project to start a session in">
				Sessions run in a project. Ask an admin to make one, or skip this step.
			</EmptyState>
		);
	}

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			const { sessionId } = await api.startSession({ projectId, text: text.trim() });
			onStarted(projectId, sessionId);
		} catch (reason) {
			setError(problemOf(reason));
			setBusy(false);
		}
	};

	return (
		<form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
			{modelsKnown && defaultRoute === undefined ? (
				<Notice level="warning">
					No model is connected, so the session can't answer yet. Go back to connect one, or start anyway.
				</Notice>
			) : null}
			{projects.length > 1 ? (
				<SelectField
					label="Project"
					value={projectId}
					onChange={(event) => setProjectId(event.target.value)}
					options={projects.map((project) => ({ value: project.id, label: project.name }))}
				/>
			) : null}
			<TextAreaField
				label="First message"
				value={text}
				onChange={(event) => setText(event.target.value)}
				rows={4}
				{...(error === undefined ? {} : { error })}
			/>
			<div className="flex flex-wrap gap-2" aria-label="Ideas">
				{FIRST_SESSION_IDEAS.map((idea) => (
					<Button key={idea} size="xs" variant="ghost" onClick={() => setText(idea)} aria-pressed={text === idea}>
						{idea}
					</Button>
				))}
			</div>
			<FormActions>
				<Button type="submit" variant="primary" busy={busy} disabled={disabled || text.trim() === ""}>
					Start session
				</Button>
			</FormActions>
		</form>
	);
}
