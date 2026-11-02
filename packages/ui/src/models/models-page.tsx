import {
	type ConnectorModel,
	type ConnectorModels,
	MODEL_PROVIDER_PRESETS,
	type ModelProviderConnection,
	type ModelProviderDefault,
} from "@kantel/contracts";
import { type ReactNode, useId } from "react";
import { Button } from "../primitives/button.tsx";
import { Disclosure, SelectField } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/** A model's gateway ID, under its name and beside the chat model. */
const modelId = "font-mono text-xs text-muted wrap-anywhere";
/** A test image's frame: a column of the image and its caption, or the error. */
const testFrame = "m-0 flex flex-col gap-1.5";
/**
 * A settings row, after Vercel's project settings: the setting's name on the left, its value or control on the right,
 * wrapping to two lines on a phone. Rows after the first get a hairline.
 */
const settingsRow =
	"flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-border px-3 py-2.5 not-first:border-t";
/** The frame the settings rows and the connectors sit in: one bordered list, rows divided by hairlines. */
const rowList = "flex min-w-0 flex-col rounded-panel border border-border bg-panel";

/** One image model a profile may name, as the host worked it out from the connectors. */
export type ImageModelChoice = { readonly id: string; readonly label: string };

/** The agent whose image model the page sets, and the state of that setting. */
export type ModelsPageAgent = {
	readonly name: string;
	/** The chat model the profile names, as its gateway ID. Shown, not changed here. */
	readonly chatModel: string;
	/** The image model saved on the profile, as its gateway ID; absent for none. */
	readonly imageModel?: string;
	/** What the picker shows now, before it is saved. */
	readonly draft?: string;
	readonly options: readonly ImageModelChoice[];
	readonly saving?: boolean;
	readonly saved?: boolean;
	readonly error?: string;
	/** Why the person can't change it, such as a viewer's role. */
	readonly readOnlyReason?: string;
};

/** A test image's state, per connector and model. */
export type ImageTestState =
	| { readonly status: "running" }
	| {
			readonly status: "done";
			readonly image: { readonly mimeType: string; readonly data: string };
			/** What the call cost, in US dollars, as the gateway recorded it. */
			readonly costUsd: number;
			readonly ms?: number;
	  }
	| { readonly status: "error"; readonly message: string };

/** The organisation's provider connections and its default model, for the Providers section. */
export type ModelsPageProviders = {
	readonly connections: readonly ModelProviderConnection[];
	/** The organisation's default model, its `default` route. */
	readonly default?: ModelProviderDefault;
	/** A default the deployment set, which the organisation's replaces. */
	readonly platformDefault?: { readonly connectorId: string; readonly modelId: string };
	/** Whether the person may connect, change and remove providers (an organisation admin). */
	readonly canManage: boolean;
};

export type ModelsPageProps = {
	/**
	 * The organisation's provider connections, in a Providers section at the top; absent for no section (the host
	 * can't read them).
	 */
	readonly providers?: ModelsPageProviders;
	/** Why the provider connections couldn't be read, or a change to them failed: shown over the list. */
	readonly providersError?: string;
	/** Opens the form to connect another provider. */
	readonly onConnectProvider?: () => void;
	readonly onEditProvider?: (connectionId: string) => void;
	readonly onRemoveProvider?: (connectionId: string) => void;
	/** The connection being removed, whose Remove is busy. */
	readonly removingProvider?: string;
	/** The provider form (a `ProviderSetup` in its settings variant), shown in place of the list while open. */
	readonly providerSetup?: ReactNode;
	/** The connectors and their models; undefined while they load. */
	readonly connectors: readonly ConnectorModels[] | undefined;
	/** Why they couldn't be read. */
	readonly error?: string;
	/** The agent's image model setting; absent when the host can't read the profile. */
	readonly agent?: ModelsPageAgent;
	/** The image model the person picked. `onSave` follows straight after: the row saves on change. */
	readonly onDraft?: (imageModel: string | undefined) => void;
	/** Saves the draft: called on every change, after `onDraft`, and by Try again after a failed save. */
	readonly onSave?: () => void;
	/** Test images by `testKey(connectorId, modelId)`. */
	readonly tests?: Readonly<Record<string, ImageTestState>>;
	/** Makes a test image; absent when the person may not (they need admin on the project). */
	readonly onTest?: (connectorId: string, modelId: string) => void;
};

/** The key `tests` holds a connector's model's test under. */
export const testKey = (connectorId: string, modelId: string) => `${connectorId}\u0000${modelId}`;

const NONE = "";

const PRESET_LABELS: Readonly<Record<string, string>> = {
	cliproxyapi: "CLIProxyAPI",
	openai: "OpenAI",
	anthropic: "Anthropic",
	openrouter: "OpenRouter",
	litellm: "LiteLLM",
	vercel: "Vercel AI Gateway",
	"cloudflare-ai-gateway": "Cloudflare AI Gateway",
	"openai-compatible": "OpenAI-compatible",
	"anthropic-compatible": "Anthropic-compatible",
};

const cost = (usd: number) => (usd === 0 ? "No cost recorded" : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`);

/** What a model takes and gives, as badges: Text, Makes images, Reads images, and the image API. */
function Capabilities({ model }: { model: ConnectorModel }) {
	return (
		<span className="flex flex-wrap gap-1.5">
			{model.output.includes("text") ? <Badge>Text</Badge> : null}
			{model.output.includes("image") ? <Badge tone="accent">Makes images</Badge> : null}
			{model.input.includes("image") ? <Badge>Reads images</Badge> : null}
			{model.imageApi === undefined || !model.output.includes("image") ? null : <Badge>{model.imageApi}</Badge>}
		</span>
	);
}

function TestResult({ state, model }: { state: ImageTestState | undefined; model: ConnectorModel }) {
	if (state === undefined || state.status === "running") return null;
	if (state.status === "error") {
		return (
			<div className={testFrame}>
				<Notice level="error">{state.message}</Notice>
			</div>
		);
	}
	return (
		<figure className={testFrame}>
			<img
				className="size-[calc(var(--kt-thumb)*2)] rounded-sm border border-border bg-sunken object-cover"
				src={`data:${state.image.mimeType};base64,${state.image.data}`}
				alt={`What ${model.name} made for the test`}
			/>
			<figcaption className="flex gap-2.5 text-xs text-muted tabular-nums">
				<span>{cost(state.costUsd)}</span>
				{state.ms === undefined ? null : <span>{(state.ms / 1000).toFixed(1)} s</span>}
			</figcaption>
		</figure>
	);
}

/** Who owns a connector, on the first line inside it: what the Platform and Organisation badges said. */
const OWNERS = {
	platform: "Owned by the platform",
	organisation: "Owned by the organisation",
} as const;

/**
 * Test generate on an image model's row: a quiet ghost button that shows while the row is hovered or has focus, as
 * Linear's and Vercel's row actions do, so a long list isn't a wall of buttons. It stays shown while it runs and on a
 * touch screen, which has no hover; it is always in the tab order, and shows when focused.
 */
const rowAction =
	"opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-busy:opacity-100 pointer-coarse:opacity-100";

/**
 * One connector as a collapsed row: its name, its kind and how many models it lists, opening on click to the models
 * with what each takes and gives. Collapsed, a project's connectors read as one short list, as Vercel's integrations
 * do; the long model lists are a click away.
 */
function ConnectorRow({
	connector,
	tests,
	onTest,
}: {
	connector: ConnectorModels;
	tests: Readonly<Record<string, ImageTestState>>;
	onTest: ((connectorId: string, modelId: string) => void) | undefined;
}) {
	const routed = new Map(connector.routes.map((route) => [route.modelId, route.name]));
	const models = [...connector.models].sort(
		(a, b) => Number(b.output.includes("image")) - Number(a.output.includes("image")) || a.name.localeCompare(b.name),
	);
	const total = connector.models.length;
	// Open already when it holds a test image, so the result isn't hidden behind a click.
	const tested = connector.models.some((model) => tests[testKey(connector.id, model.id)] !== undefined);
	return (
		<li className="min-w-0 border-border px-3 py-1.5 not-first:border-t">
			<Disclosure
				className="kt-models-connector"
				defaultOpen={tested}
				summary={<span className="font-mono text-code text-fg wrap-anywhere">{connector.id}</span>}
				trailing={
					<span className="flex flex-none items-center gap-2">
						<Badge>{PRESET_LABELS[connector.preset] ?? connector.preset}</Badge>
						<span className="text-xs text-faint tabular-nums">
							{total} {total === 1 ? "model" : "models"}
						</span>
					</span>
				}
			>
				<div className="flex min-w-0 flex-col gap-2">
					<p className="m-0 text-xs text-faint">{OWNERS[connector.owner.kind]}</p>
					{models.length === 0 ? (
						<p className="m-0 text-muted">This connector lists no models.</p>
					) : (
						<ul className="m-0 flex list-none flex-col p-0" aria-label={`Models on ${connector.id}`}>
							{models.map((model) => {
								const test = tests[testKey(connector.id, model.id)];
								const route = routed.get(model.id);
								return (
									<li
										key={model.id}
										className="group flex min-w-0 flex-col gap-2 border-border py-2 not-first:border-t"
									>
										<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
											<div className="flex min-w-0 grow basis-12 flex-col">
												<span className="font-medium wrap-anywhere">{model.name}</span>
												<span className={modelId}>
													{model.id}
													{route === undefined ? null : <> on route {route}</>}
												</span>
											</div>
											<Capabilities model={model} />
											{model.output.includes("image") && onTest !== undefined ? (
												<Button
													size="xs"
													variant="ghost"
													className={rowAction}
													busy={test?.status === "running"}
													aria-label={`Test generate with ${model.name}`}
													onClick={() => onTest(connector.id, model.id)}
												>
													Test generate
												</Button>
											) : null}
										</div>
										<TestResult state={test} model={model} />
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</Disclosure>
		</li>
	);
}

/**
 * The agent's models as settings rows, after Vercel's project settings: Image model with its select on the right,
 * saved as soon as it changes, and what happened in a word beside it; the chat model as a quiet row under it.
 */
function AgentSettings({
	agent,
	connectorsLoaded,
	onDraft,
	onSave,
}: {
	agent: ModelsPageAgent;
	connectorsLoaded: boolean;
	onDraft: ((imageModel: string | undefined) => void) | undefined;
	onSave: (() => void) | undefined;
}) {
	const id = useId();
	const selectId = `${id}-image`;
	const noteId = `${id}-note`;
	const headingId = `${id}-title`;
	const current = agent.draft ?? agent.imageModel ?? NONE;
	const changed = current !== (agent.imageModel ?? NONE);
	const known = agent.options.some((option) => option.id === current);
	const note =
		agent.saving === true
			? "Saving"
			: agent.saved === true && !changed
				? "Saved"
				: (agent.readOnlyReason ??
					(agent.options.length === 0 && connectorsLoaded ? "No connector offers an image model yet." : undefined));
	return (
		<section className="flex max-w-content min-w-0 flex-col gap-2" aria-labelledby={headingId}>
			<h2 id={headingId} className="m-0 text-sm font-medium">
				{agent.name}
			</h2>
			<div className={rowList}>
				<div className={settingsRow}>
					{/* The select's own label (hidden) names it; this is the row's visible name for sighted readers. */}
					<span className="font-medium" aria-hidden="true">
						Image model
					</span>
					<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
						<SelectField
							id={selectId}
							label="Image model"
							hideLabel
							value={current}
							disabled={agent.readOnlyReason !== undefined || agent.saving === true}
							aria-describedby={agent.error !== undefined || note !== undefined ? noteId : undefined}
							onChange={(event) => {
								// Saved on change, as a settings row is: the same save the Save button made.
								onDraft?.(event.target.value === NONE ? undefined : event.target.value);
								onSave?.();
							}}
							options={[
								{ value: NONE, label: "None" },
								...agent.options.map((option) => ({ value: option.id, label: option.label })),
								...(current === NONE || known ? [] : [{ value: current, label: `${current} (not offered now)` }]),
							]}
						/>
						{agent.error === undefined ? (
							<span id={noteId} className="text-xs text-faint" role="status">
								{note}
							</span>
						) : (
							<span className="inline-flex min-w-0 flex-wrap items-center gap-2">
								<span id={noteId} className="text-xs text-status-error wrap-anywhere" role="alert">
									{agent.error}
								</span>
								{changed && agent.readOnlyReason === undefined ? (
									<Button size="xs" variant="ghost" onClick={onSave}>
										Try again
									</Button>
								) : null}
							</span>
						)}
					</div>
				</div>
				<div className={settingsRow}>
					<span className="text-muted">Chat model</span>
					<span className={modelId}>{agent.chatModel}</span>
				</div>
			</div>
		</section>
	);
}

/**
 * The organisation's provider connections as rows: the provider, the connection's ID and address, and which holds the
 * default model, with Edit and Remove for an admin. The provider form takes the list's place while it is open.
 */
function Providers({
	providers,
	error,
	onConnect,
	onEdit,
	onRemove,
	removing,
	setup,
}: {
	providers: ModelsPageProviders | undefined;
	error: string | undefined;
	onConnect: (() => void) | undefined;
	onEdit: ((connectionId: string) => void) | undefined;
	onRemove: ((connectionId: string) => void) | undefined;
	removing: string | undefined;
	setup: ReactNode;
}) {
	const headingId = `${useId()}-providers`;
	const manage = providers?.canManage === true;
	const chosen = providers?.default;
	const platform = providers?.platformDefault;
	const hasSetup = setup !== undefined && setup !== null && setup !== false;
	const platformName = "font-mono wrap-anywhere";
	return (
		<section className="flex max-w-content min-w-0 flex-col gap-2" aria-labelledby={headingId}>
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
				<h2 id={headingId} className="m-0 text-sm font-medium">
					Providers
				</h2>
				{manage && onConnect !== undefined && !hasSetup && providers !== undefined ? (
					<Button size="xs" onClick={onConnect}>
						Connect a provider
					</Button>
				) : null}
			</div>
			{error === undefined ? null : <Notice level="error">{error}</Notice>}
			{hasSetup ? (
				setup
			) : providers === undefined ? (
				error !== undefined ? null : (
					<div>
						<span className="kt-sr-only">Loading the providers</span>
						<Skeleton lines={2} />
					</div>
				)
			) : providers.connections.length === 0 ? (
				<EmptyState title="No provider connected">
					{platform === undefined
						? "Sessions answer with the echo model until one is."
						: `Sessions use the deployment's default, ${platform.modelId}, until one is.`}
				</EmptyState>
			) : (
				<ul className={`m-0 list-none p-0 ${rowList}`} aria-label="Provider connections">
					{providers.connections.map((connection) => {
						const isDefault = chosen?.connectionId === connection.id;
						return (
							<li key={connection.id} className={settingsRow}>
								<div className="flex min-w-0 grow basis-12 flex-col gap-0.5">
									<span className="flex min-w-0 flex-wrap items-center gap-2">
										<span className="font-mono text-code text-fg wrap-anywhere">{connection.id}</span>
										<Badge>{MODEL_PROVIDER_PRESETS[connection.provider]?.label ?? connection.provider}</Badge>
										{isDefault && chosen !== undefined ? <Badge tone="accent">Default: {chosen.modelId}</Badge> : null}
									</span>
									<span className={modelId}>{connection.baseUrl}</span>
								</div>
								{manage ? (
									<span className="flex flex-none items-center gap-1">
										{onEdit === undefined ? null : (
											<Button
												size="xs"
												variant="ghost"
												aria-label={`Edit ${connection.id}`}
												disabled={removing !== undefined}
												onClick={() => onEdit(connection.id)}
											>
												Edit
											</Button>
										)}
										{onRemove === undefined ? null : (
											<Button
												size="xs"
												variant="ghost"
												aria-label={`Remove ${connection.id}`}
												busy={removing === connection.id}
												disabled={removing !== undefined}
												onClick={() => onRemove(connection.id)}
											>
												Remove
											</Button>
										)}
									</span>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
			{platform === undefined || hasSetup || providers === undefined || providers.connections.length === 0 ? null : (
				<p className="m-0 text-xs text-faint">
					The deployment's default is <span className={platformName}>{platform.modelId}</span> on{" "}
					<span className={platformName}>{platform.connectorId}</span>. The organisation's default replaces it.
				</p>
			)}
		</section>
	);
}

/**
 * A project's models: the organisation's provider connections, the agent's image model, chosen from the image models
 * the connectors offer, and each connector's models with what they take and give, with a test image for an image
 * model. The host does every call; the page only shows what it is given.
 */
export function ModelsPage({
	providers,
	providersError,
	onConnectProvider,
	onEditProvider,
	onRemoveProvider,
	removingProvider,
	providerSetup,
	connectors,
	error,
	agent,
	onDraft,
	onSave,
	tests = {},
	onTest,
}: ModelsPageProps) {
	return (
		<div className="kt-models flex w-full min-w-0 flex-col gap-6 text-sm leading-normal text-fg">
			<PageHeader title="Models" />
			{providers === undefined && providersError === undefined && providerSetup === undefined ? null : (
				<Providers
					providers={providers}
					error={providersError}
					onConnect={onConnectProvider}
					onEdit={onEditProvider}
					onRemove={onRemoveProvider}
					removing={removingProvider}
					setup={providerSetup}
				/>
			)}
			{agent === undefined ? null : (
				<AgentSettings agent={agent} connectorsLoaded={connectors !== undefined} onDraft={onDraft} onSave={onSave} />
			)}
			<section className="flex max-w-content min-w-0 flex-col gap-2" aria-label="Connectors">
				<h2 className="m-0 text-sm font-medium">Connectors</h2>
				{error !== undefined ? (
					<Notice level="error">{error}</Notice>
				) : connectors === undefined ? (
					<div>
						<span className="kt-sr-only">Loading the connectors</span>
						<Skeleton lines={3} />
					</div>
				) : connectors.length === 0 ? (
					<EmptyState title="No connectors">This project can't reach any model connector.</EmptyState>
				) : (
					<ul className={`m-0 list-none p-0 ${rowList}`}>
						{connectors.map((connector) => (
							<ConnectorRow key={connector.id} connector={connector} tests={tests} onTest={onTest} />
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
