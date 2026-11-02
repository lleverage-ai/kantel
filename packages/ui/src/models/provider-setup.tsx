import {
	cloudflareAiGatewayBaseUrl,
	MODEL_PROVIDER_PRESETS,
	MODEL_PROVIDERS,
	type ModelProvider,
	type ModelProviderModel,
} from "@kantel/contracts";
import { useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { FormGrid, PageHeader } from "../primitives/form-layout.tsx";
import { Notice } from "../primitives/surface.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/** The frame the provider and model rows sit in: one bordered list, rows divided by hairlines, as the Models page's. */
const rowList = "flex min-w-0 flex-col rounded-panel border border-border bg-panel";
/** One choice in a list of them: the whole row is the click target, the radio is real, lit while chosen. */
const choiceRow =
	"flex min-w-0 cursor-pointer items-start gap-3 border-border px-3 py-2.5 not-first:border-t has-checked:bg-active has-disabled:cursor-default";
/** The radio, beside the row's first line. */
const radio = "kt-focusable mt-0.5 size-3.5 flex-none cursor-pointer accent-accent disabled:cursor-default";
/** The card: a calm panel the page's reading width, as the first-run mock's Connect a model. */
const cardFrame =
	"flex w-full max-w-content min-w-0 flex-col gap-6 rounded-panel border border-border bg-panel p-4 text-sm leading-normal text-fg";
/** A small heading inside the card. */
const legend = "m-0 mb-2 p-0 text-sm font-medium text-fg";
/** A value shown, not changed: a base URL. */
const mono = "font-mono text-xs text-muted wrap-anywhere";

/** What the first-run page says under its title. */
const LEDE =
	"Connect a model so sessions have something to call. Your key goes into the vault; you can change this later in Models.";

/** Above this many models the list gets a filter. */
const FILTER_FROM = 8;

/** What the form holds, as the person typed it. */
export type ProviderSetupFields = {
	readonly baseUrl: string;
	readonly accountId: string;
	readonly gatewayId: string;
	readonly apiKey: string;
};

export type ProviderSetupField = keyof ProviderSetupFields;

/** Test connection's state: not run, running, the models the provider listed, or why it failed. */
export type ProviderTestState =
	| { readonly status: "idle" }
	| { readonly status: "running" }
	| { readonly status: "ok"; readonly models: readonly ModelProviderModel[] }
	| { readonly status: "error"; readonly message: string };

export type ProviderSetupProps = {
	/** `onboarding`: the first-run page, titled, with Skip for now. `settings`: the card alone, with Cancel. */
	readonly variant: "onboarding" | "settings";
	/** The provider picked; absent until one is. */
	readonly provider?: ModelProvider;
	readonly onProvider?: (provider: ModelProvider) => void;
	readonly fields: ProviderSetupFields;
	readonly onField?: (name: ProviderSetupField, value: string) => void;
	/** Editing a saved connection: its key is in the vault, and a blank key field keeps it. */
	readonly keySaved?: boolean;
	readonly test: ProviderTestState;
	readonly onTest?: () => void;
	/** The model picked as the organisation's default, by its ID. */
	readonly defaultModel?: string;
	readonly onDefaultModel?: (modelId: string) => void;
	readonly saving?: boolean;
	readonly saveError?: string;
	readonly onSave?: () => void;
	/** Onboarding's Skip for now. */
	readonly onSkip?: () => void;
	/** Settings' Cancel. */
	readonly onCancel?: () => void;
	/** Why the person can't change it, such as not being an organisation admin: everything is shown, nothing works. */
	readonly readOnlyReason?: string;
};

const modelCount = (count: number) => `${count} ${count === 1 ? "model" : "models"}`;

/** A context window in thousands of tokens: `200k context`. */
const contextOf = (tokens: number) =>
	tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M context` : `${Math.round(tokens / 1000)}k context`;

/** The four providers as radio rows: each one's name and a line on what it is. */
function ProviderPicker({
	provider,
	onProvider,
	disabled,
}: {
	provider: ModelProvider | undefined;
	onProvider: ((provider: ModelProvider) => void) | undefined;
	disabled: boolean;
}) {
	const name = useId();
	return (
		<fieldset className="m-0 flex min-w-0 flex-col border-0 p-0" disabled={disabled}>
			<legend className={legend}>Provider</legend>
			<div className={`${rowList} overflow-hidden`}>
				{MODEL_PROVIDERS.map((candidate) => {
					const preset = MODEL_PROVIDER_PRESETS[candidate];
					return (
						<label key={candidate} className={choiceRow}>
							<input
								type="radio"
								name={name}
								value={candidate}
								checked={provider === candidate}
								onChange={() => onProvider?.(candidate)}
								className={radio}
							/>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-sm font-medium text-fg">{preset.label}</span>
								<span className="text-xs leading-normal text-muted">{preset.description}</span>
							</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}

/** Where the provider is: a base URL, a Cloudflare account and gateway, or nothing to ask for. */
function Address({
	provider,
	fields,
	onField,
}: {
	provider: ModelProvider;
	fields: ProviderSetupFields;
	onField: ((name: ProviderSetupField, value: string) => void) | undefined;
}) {
	const preset = MODEL_PROVIDER_PRESETS[provider];
	if (preset.baseUrl === "url") {
		return (
			<TextField
				label="Base URL"
				mono
				type="url"
				inputMode="url"
				autoComplete="off"
				spellCheck={false}
				value={fields.baseUrl}
				{...(preset.defaultBaseUrl === undefined ? {} : { placeholder: preset.defaultBaseUrl })}
				hint="The OpenAI-compatible address Kantel calls, usually ending in /v1."
				onChange={(event) => onField?.("baseUrl", event.target.value)}
			/>
		);
	}
	if (preset.baseUrl === "cloudflare") {
		const account = fields.accountId.trim();
		const gateway = fields.gatewayId.trim();
		const url = cloudflareAiGatewayBaseUrl(
			account === "" ? "<account ID>" : account,
			gateway === "" ? "default" : gateway,
		);
		return (
			<div className="flex min-w-0 flex-col gap-2">
				<FormGrid columns={2}>
					<TextField
						label="Account ID"
						mono
						autoComplete="off"
						spellCheck={false}
						value={fields.accountId}
						hint="On your Cloudflare dashboard's overview."
						onChange={(event) => onField?.("accountId", event.target.value)}
					/>
					<TextField
						label="Gateway ID"
						mono
						autoComplete="off"
						spellCheck={false}
						value={fields.gatewayId}
						placeholder="default"
						hint="Leave it as default unless you made another gateway."
						onChange={(event) => onField?.("gatewayId", event.target.value)}
					/>
				</FormGrid>
				<p className="m-0 flex min-w-0 flex-col gap-0.5 text-xs text-faint">
					<span>Kantel calls</span>
					<span className={mono}>{url}</span>
				</p>
			</div>
		);
	}
	return preset.defaultBaseUrl === undefined ? null : (
		<p className="m-0 flex min-w-0 flex-col gap-0.5 text-xs text-faint">
			<span>Kantel calls</span>
			<span className={mono}>{preset.defaultBaseUrl}</span>
		</p>
	);
}

/** The models the provider listed, as radio rows to pick the default from, with a filter over a long list. */
function ModelPicker({
	models,
	defaultModel,
	onDefaultModel,
	disabled,
}: {
	models: readonly ModelProviderModel[];
	defaultModel: string | undefined;
	onDefaultModel: ((modelId: string) => void) | undefined;
	disabled: boolean;
}) {
	const id = useId();
	const [filter, setFilter] = useState("");
	const words = filter.trim().toLowerCase();
	const shown =
		words === ""
			? models
			: models.filter(
					(model) => model.id.toLowerCase().includes(words) || (model.name?.toLowerCase().includes(words) ?? false),
				);
	if (models.length === 0) {
		return <Notice level="warning">The provider lists no models, so there's nothing to pick as the default.</Notice>;
	}
	return (
		<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
			<legend className={legend}>Default model</legend>
			<p className="m-0 text-xs leading-normal text-muted">
				Sessions call this model unless their agent names another.
			</p>
			{models.length > FILTER_FROM ? (
				<TextField
					label="Filter models"
					hideLabel
					type="search"
					autoComplete="off"
					spellCheck={false}
					placeholder="Filter models"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
			) : null}
			{shown.length === 0 ? (
				<p className="m-0 text-sm text-muted" role="status">
					No model matches {filter.trim()}.
				</p>
			) : (
				<div className={`${rowList} max-h-72 overflow-y-auto overscroll-contain`}>
					{shown.map((model) => {
						const named = model.name !== undefined && model.name !== model.id;
						const title = named ? "text-sm text-fg wrap-anywhere" : "font-mono text-code text-fg wrap-anywhere";
						return (
							<label key={model.id} className={choiceRow}>
								<input
									type="radio"
									name={`${id}-model`}
									value={model.id}
									checked={defaultModel === model.id}
									onChange={() => onDefaultModel?.(model.id)}
									className={radio}
								/>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className={title}>{named ? model.name : model.id}</span>
									{named ? <span className={mono}>{model.id}</span> : null}
								</span>
								{model.contextWindow === undefined ? null : (
									<span className="flex-none text-xs text-faint tabular-nums">{contextOf(model.contextWindow)}</span>
								)}
							</label>
						);
					})}
				</div>
			)}
		</fieldset>
	);
}

/**
 * Connecting an inference provider: pick one of the four, say where it is and give its key, test the connection,
 * which lists its models, pick the default model and save. The key goes into the vault. `onboarding` is the first-run
 * page, titled Set up Kantel with Skip for now; `settings` is the card alone, for the Models page, with Cancel. The
 * host holds the form's state and makes every call.
 */
export function ProviderSetup({
	variant,
	provider,
	onProvider,
	fields,
	onField,
	keySaved = false,
	test,
	onTest,
	defaultModel,
	onDefaultModel,
	saving = false,
	saveError,
	onSave,
	onSkip,
	onCancel,
	readOnlyReason,
}: ProviderSetupProps) {
	const id = useId();
	const headingId = `${id}-title`;
	// Under the page's title on the first run; under the Models page's Providers heading in settings.
	const Heading = variant === "onboarding" ? "h2" : "h3";
	const readOnly = readOnlyReason !== undefined;
	const preset = provider === undefined ? undefined : MODEL_PROVIDER_PRESETS[provider];
	const locked = readOnly || saving;
	const canSave = !locked && test.status === "ok" && defaultModel !== undefined && defaultModel !== "";
	const card = (
		<section className={cardFrame} aria-labelledby={headingId}>
			<div className="flex min-w-0 flex-col gap-1">
				<Heading id={headingId} className="m-0 text-md font-medium text-fg">
					{variant === "onboarding" ? "Connect a model" : "Connect a provider"}
				</Heading>
				<p className="m-0 text-sm leading-normal text-muted">
					Pick where your models come from, give its key and test the connection. Keys go into the vault.
				</p>
			</div>
			{readOnlyReason === undefined ? null : (
				<Notice level="info" announce={false}>
					{readOnlyReason}
				</Notice>
			)}
			<ProviderPicker provider={provider} onProvider={onProvider} disabled={locked} />
			{preset === undefined || provider === undefined ? null : (
				<fieldset className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0" disabled={locked}>
					<legend className={legend}>{preset.label}</legend>
					<Address provider={provider} fields={fields} onField={onField} />
					<TextField
						label={preset.keyLabel}
						type="password"
						autoComplete="off"
						spellCheck={false}
						mono
						value={fields.apiKey}
						{...(keySaved ? { placeholder: "Saved in the vault — leave blank to keep it" } : {})}
						hint="It goes into the vault, and Kantel never shows it again."
						extra={
							<a
								href={preset.docsUrl}
								target="_blank"
								rel="noreferrer"
								className="kt-focusable rounded-xs text-xs text-accent-text no-underline hover:underline"
							>
								Where to find it
							</a>
						}
						onChange={(event) => onField?.("apiKey", event.target.value)}
					/>
					<div className="flex min-w-0 flex-wrap items-center gap-3">
						<Button busy={test.status === "running"} onClick={onTest}>
							Test connection
						</Button>
						<span className="text-xs text-faint" role="status">
							{test.status === "running" ? (
								"Asking for its models"
							) : test.status === "ok" ? (
								<span className="text-status-done">Connected — {modelCount(test.models.length)}</span>
							) : null}
						</span>
					</div>
					{test.status === "error" ? <Notice level="error">{test.message}</Notice> : null}
				</fieldset>
			)}
			{test.status === "ok" && provider !== undefined ? (
				<ModelPicker
					key={provider}
					models={test.models}
					defaultModel={defaultModel}
					onDefaultModel={onDefaultModel}
					disabled={locked}
				/>
			) : null}
			{saveError === undefined ? null : <Notice level="error">{saveError}</Notice>}
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<Button variant="primary" busy={saving} disabled={!canSave} onClick={onSave}>
					Save
				</Button>
				{variant === "settings" && onCancel !== undefined ? (
					<Button disabled={saving} onClick={onCancel}>
						Cancel
					</Button>
				) : null}
				{test.status !== "ok" && provider !== undefined && !readOnly ? (
					<span className="text-xs text-faint">Test the connection to pick a default model.</span>
				) : null}
			</div>
		</section>
	);
	if (variant === "settings") return card;
	return (
		<div className="flex w-full max-w-content min-w-0 flex-col gap-6 text-sm leading-normal text-fg">
			<PageHeader
				title="Set up Kantel"
				lede={LEDE}
				{...(onSkip === undefined
					? {}
					: {
							actions: (
								<Button variant="ghost" onClick={onSkip}>
									Skip for now
								</Button>
							),
						})}
			/>
			{card}
		</div>
	);
}
