import type { ConnectorModel, ConnectorModels } from "@harbour/contracts";
import { Button } from "../primitives/button.tsx";
import { SelectField } from "../primitives/controls.tsx";
import { FormActions, FormLayout, FormSection, PageHeader } from "../primitives/form-layout.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice, Panel } from "../primitives/surface.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/** A model's gateway ID, under its name and beside the chat model. */
const modelId = "font-mono text-xs text-muted wrap-anywhere";
/** A test image's frame: a column of the image and its caption, or the error. */
const testFrame = "m-0 flex flex-col gap-1.5";

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

export type ModelsPageProps = {
	/** The connectors and their models; undefined while they load. */
	readonly connectors: readonly ConnectorModels[] | undefined;
	/** Why they couldn't be read. */
	readonly error?: string;
	/** The agent's image model setting; absent when the host can't read the profile. */
	readonly agent?: ModelsPageAgent;
	readonly onDraft?: (imageModel: string | undefined) => void;
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
				className="size-[calc(var(--hb-thumb)*2)] rounded-sm border border-border bg-sunken object-cover"
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

function ConnectorPanel({
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
	return (
		<Panel
			className="hb-models-connector"
			aria-label={connector.id}
			header={
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<span className="font-mono text-code wrap-anywhere">{connector.id}</span>
					<Badge>{PRESET_LABELS[connector.preset] ?? connector.preset}</Badge>
					<Badge>
						{connector.owner.kind === "platform"
							? "Platform"
							: connector.owner.kind === "organisation"
								? "Organisation"
								: "Project"}
					</Badge>
				</div>
			}
		>
			{models.length === 0 ? (
				<p className="m-0 text-muted">This connector lists no models.</p>
			) : (
				<ul className="m-0 flex list-none flex-col p-0">
					{models.map((model) => {
						const test = tests[testKey(connector.id, model.id)];
						const route = routed.get(model.id);
						return (
							<li key={model.id} className="flex min-w-0 flex-col gap-2 border-border py-2 not-first:border-t">
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
											variant="secondary"
											busy={test?.status === "running"}
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
		</Panel>
	);
}

/**
 * A project's models: the agent's image model, chosen from the image models the connectors offer, and each connector's
 * models with what they take and give, with a test image for an image model. The host does every call; the page only
 * shows what it is given.
 */
export function ModelsPage({ connectors, error, agent, onDraft, onSave, tests = {}, onTest }: ModelsPageProps) {
	const current = agent?.draft ?? agent?.imageModel ?? NONE;
	const changed = agent !== undefined && current !== (agent.imageModel ?? NONE);
	const known = agent?.options.some((option) => option.id === current) ?? false;
	return (
		<div className="hb-models flex w-full min-w-0 flex-col gap-6 text-sm leading-normal text-fg">
			<PageHeader
				title="Models"
				lede="What each connector offers, and the model the agent makes images with. Images use their own model, whatever the agent chats with."
			/>
			{agent === undefined ? null : (
				<FormLayout className="max-w-content">
					<FormSection
						title={agent.name}
						description="The agent gets the generate_image tool when it has an image model."
					>
						<div className="flex min-w-0 flex-wrap items-baseline gap-2">
							<span className="font-medium">Chat model</span>
							<span className={modelId}>{agent.chatModel}</span>
						</div>
						<SelectField
							label="Image model"
							hint={
								agent.readOnlyReason ??
								(agent.options.length === 0 && connectors !== undefined
									? "No connector offers an image model yet."
									: "Only models that make images are listed.")
							}
							value={current}
							disabled={agent.readOnlyReason !== undefined || agent.saving === true}
							onChange={(event) => onDraft?.(event.target.value === NONE ? undefined : event.target.value)}
							options={[
								{ value: NONE, label: "None" },
								...agent.options.map((option) => ({ value: option.id, label: option.label })),
								...(current === NONE || known ? [] : [{ value: current, label: `${current} (not offered now)` }]),
							]}
						/>
						{agent.error === undefined ? null : <Notice level="error">{agent.error}</Notice>}
						{agent.saved === true && !changed ? <Notice>Saved. New sessions use it.</Notice> : null}
						{agent.readOnlyReason === undefined ? (
							<FormActions>
								<Button variant="primary" size="sm" disabled={!changed} busy={agent.saving} onClick={onSave}>
									Save
								</Button>
							</FormActions>
						) : null}
					</FormSection>
				</FormLayout>
			)}
			<section className="flex min-w-0 flex-col gap-3" aria-label="Connectors">
				<h2 className="m-0 text-sm font-medium">Connectors</h2>
				{error !== undefined ? (
					<Notice level="error">{error}</Notice>
				) : connectors === undefined ? (
					<div>
						<span className="hb-sr-only">Loading the connectors</span>
						<Skeleton lines={3} />
					</div>
				) : connectors.length === 0 ? (
					<EmptyState title="No connectors">This project can't reach any model connector.</EmptyState>
				) : (
					connectors.map((connector) => (
						<ConnectorPanel key={connector.id} connector={connector} tests={tests} onTest={onTest} />
					))
				)}
			</section>
		</div>
	);
}
