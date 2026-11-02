import {
	MODEL_PROVIDER_PRESETS,
	type ModelProvider,
	type ModelProviderConnection,
	type ModelProviderInput,
} from "@kantel/contracts";
import { ProviderSetup, type ProviderSetupField, type ProviderSetupFields, type ProviderTestState } from "@kantel/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleModelProviders } from "../api/model-providers-http.ts";

// Connecting an inference provider: the first-run onboarding, and the form the Models page opens to connect or edit
// one. @kantel/ui's ProviderSetup lays it out; this file keeps the form's state and calls the model providers' seam
// (`api/model-providers-http.ts`): test, save the connection, then set the organisation's default model on it.

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

const EMPTY: ProviderSetupFields = { baseUrl: "", accountId: "", gatewayId: "default", apiKey: "" };

/** A provider's form as it opens: its suggested base URL and Cloudflare's default gateway. */
const fieldsFor = (provider: ModelProvider): ProviderSetupFields => ({
	...EMPTY,
	baseUrl: MODEL_PROVIDER_PRESETS[provider].defaultBaseUrl ?? "",
});

/** A saved connection's form: where it points, and a blank key that keeps the one in the vault. */
const fieldsOf = (connection: ModelProviderConnection): ProviderSetupFields => ({
	baseUrl: connection.baseUrl,
	accountId: connection.accountId ?? "",
	gatewayId: connection.gatewayId ?? "default",
	apiKey: "",
});

/** What the form sends: only what the provider asks for, and the key only when one was typed. */
export function providerInput(provider: ModelProvider, fields: ProviderSetupFields): ModelProviderInput {
	const preset = MODEL_PROVIDER_PRESETS[provider];
	const baseUrl = fields.baseUrl.trim();
	const accountId = fields.accountId.trim();
	const gatewayId = fields.gatewayId.trim();
	return {
		provider,
		...(preset.baseUrl === "url" && baseUrl !== "" ? { baseUrl } : {}),
		...(preset.baseUrl === "cloudflare" ? { accountId, gatewayId: gatewayId === "" ? "default" : gatewayId } : {}),
		...(fields.apiKey === "" ? {} : { apiKey: fields.apiKey }),
	};
}

/** The connection a provider is saved as, when it isn't an edit of one: the provider's own name. */
const connectionIdFor = (provider: ModelProvider): string => provider;

export function ProviderSetupScreen({
	providers,
	variant,
	editing,
	initialModel,
	onDone,
	onSkip,
	onCancel,
}: {
	providers: ConsoleModelProviders;
	variant: "onboarding" | "settings";
	/** The saved connection being changed; absent for a new one. */
	editing?: ModelProviderConnection;
	/** The default model already set on it, picked again once a test lists it. */
	initialModel?: string;
	/** Saved, with the default model set. */
	onDone: () => void;
	/** Onboarding's Skip for now. */
	onSkip?: () => void;
	/** Settings' Cancel. */
	onCancel?: () => void;
}) {
	const [provider, setProvider] = useState<ModelProvider | undefined>(editing?.provider);
	const [fields, setFields] = useState<ProviderSetupFields>(() => (editing === undefined ? EMPTY : fieldsOf(editing)));
	const [test, setTest] = useState<ProviderTestState>({ status: "idle" });
	const [defaultModel, setDefaultModel] = useState<string | undefined>(initialModel);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string>();
	// The test running now: a change to the form stops it, as its answer would be for details no longer shown.
	const running = useRef<AbortController | undefined>(undefined);
	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			running.current?.abort();
		};
	}, []);

	const stopTest = useCallback(() => {
		running.current?.abort();
		running.current = undefined;
		setTest({ status: "idle" });
	}, []);

	const choose = useCallback(
		(next: ModelProvider) => {
			stopTest();
			setProvider(next);
			setFields(editing !== undefined && editing.provider === next ? fieldsOf(editing) : fieldsFor(next));
			setDefaultModel(editing?.provider === next ? initialModel : undefined);
			setSaveError(undefined);
		},
		[editing, initialModel, stopTest],
	);

	const change = useCallback(
		(name: ProviderSetupField, value: string) => {
			stopTest();
			setFields((now) => ({ ...now, [name]: value }));
			setSaveError(undefined);
		},
		[stopTest],
	);

	const runTest = useCallback(async () => {
		if (provider === undefined) return;
		running.current?.abort();
		const abort = new AbortController();
		running.current = abort;
		setTest({ status: "running" });
		setSaveError(undefined);
		try {
			const models = await providers.test(
				{ ...providerInput(provider, fields), ...(editing === undefined ? {} : { connectionId: editing.id }) },
				abort.signal,
			);
			if (abort.signal.aborted || !live.current) return;
			setTest({ status: "ok", models });
			// The default stays picked while the provider still lists it; a provider with one model has it picked.
			setDefaultModel((now) => {
				if (now !== undefined && models.some((model) => model.id === now)) return now;
				return models.length === 1 ? models[0]?.id : undefined;
			});
		} catch (reason) {
			if (abort.signal.aborted || !live.current) return;
			setTest({ status: "error", message: messageOf(reason) });
		} finally {
			if (running.current === abort) running.current = undefined;
		}
	}, [providers, provider, fields, editing]);

	const save = useCallback(async () => {
		if (provider === undefined || defaultModel === undefined) return;
		const id = editing?.id ?? connectionIdFor(provider);
		setSaving(true);
		setSaveError(undefined);
		try {
			await providers.save(id, providerInput(provider, fields));
			await providers.setDefault({ connectionId: id, modelId: defaultModel });
			if (!live.current) return;
			setSaving(false);
			onDone();
		} catch (reason) {
			if (!live.current) return;
			setSaving(false);
			setSaveError(messageOf(reason));
		}
	}, [providers, provider, fields, editing, defaultModel, onDone]);

	return (
		<ProviderSetup
			variant={variant}
			{...(provider === undefined ? {} : { provider })}
			onProvider={choose}
			fields={fields}
			onField={change}
			keySaved={editing !== undefined && editing.provider === provider}
			test={test}
			onTest={() => void runTest()}
			{...(defaultModel === undefined ? {} : { defaultModel })}
			onDefaultModel={setDefaultModel}
			saving={saving}
			{...(saveError === undefined ? {} : { saveError })}
			onSave={() => void save()}
			{...(onSkip === undefined ? {} : { onSkip })}
			{...(onCancel === undefined ? {} : { onCancel })}
		/>
	);
}

/** Where this browser keeps that the person skipped connecting a model. */
export const ONBOARDING_KEY = "kantel.onboarding.models";

/** This browser's local storage, when it has one it lets the page use. */
function storage(): Storage | undefined {
	try {
		return typeof localStorage === "undefined" || localStorage === null ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

function wasSkipped(): boolean {
	try {
		return storage()?.getItem(ONBOARDING_KEY) === "skipped";
	} catch {
		return false;
	}
}

/**
 * The first-run gate: whether to show the onboarding, which asks an organisation admin to connect a model while
 * sessions have none to call. Reads the providers' state once; Skip for now is kept in this browser.
 */
export function useModelOnboarding(providers?: ConsoleModelProviders): {
	show: boolean;
	skip(): void;
	done(): void;
} {
	const [skipped, setSkipped] = useState(wasSkipped);
	const [needed, setNeeded] = useState(false);
	useEffect(() => {
		if (providers === undefined || skipped) return;
		let live = true;
		providers.state().then(
			(state) => {
				if (live) setNeeded(!state.configured && state.canManage);
			},
			// Couldn't ask (an older gateway without the routes): no onboarding, the console as it was.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [providers, skipped]);
	const skip = useCallback(() => {
		setSkipped(true);
		try {
			storage()?.setItem(ONBOARDING_KEY, "skipped");
		} catch {
			// Storage full or refused: skipped for this visit.
		}
	}, []);
	const done = useCallback(() => setNeeded(false), []);
	return { show: needed && !skipped, skip, done };
}
