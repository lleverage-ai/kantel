import type { AgentProfile, ConnectorModels, ModelProviderConnection, ModelProvidersState } from "@kantel/contracts";
import { type ImageTestState, ModelsPage, type ModelsPageAgent, testKey } from "@kantel/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleClient } from "../api/client.ts";
import type { ConsoleModelProviders } from "../api/model-providers-http.ts";
import { type ConsoleModels, choiceId, imageModelOptions } from "../api/models-http.ts";
import { ProviderSetupScreen } from "./model-providers-screen.tsx";

// A project's Models page: its connectors' models with their capabilities and a test image, and the image model of the
// agent a new session in the project runs (`ConsoleClient.startOptions`). @kantel/ui's ModelsPage lays it out; this
// file reads and writes through the models seam (`api/models-http.ts`) and keeps the page's state. With the model
// providers' seam (`api/model-providers-http.ts`) the page opens on the organisation's provider connections, with the
// provider form (`ProviderSetupScreen`) to connect or edit one.

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

type ProfileState =
	| { readonly status: "loading" }
	| { readonly status: "none" }
	| { readonly status: "ready"; readonly profile: AgentProfile };

/** The provider form while it is open: for a new connection, or editing a saved one. */
type ProviderForm = { readonly editing?: ModelProviderConnection };

export function ModelsScreen({
	client,
	models,
	modelProviders,
	projectId,
}: {
	client: ConsoleClient;
	models: ConsoleModels;
	/** The organisation's provider connections; without it the page has no Providers section. */
	modelProviders?: ConsoleModelProviders;
	projectId: string;
}) {
	const [providerState, setProviderState] = useState<ModelProvidersState>();
	const [providersError, setProvidersError] = useState<string>();
	const [providerForm, setProviderForm] = useState<ProviderForm>();
	const [removing, setRemoving] = useState<string>();
	// Bumped to read the providers again, after a save or a removal.
	const [providersRead, setProvidersRead] = useState(0);

	useEffect(() => {
		if (modelProviders === undefined) return;
		const abort = new AbortController();
		// Read again on each bump.
		void providersRead;
		modelProviders.state(abort.signal).then(
			(state) => {
				if (abort.signal.aborted) return;
				setProviderState(state);
				setProvidersError(undefined);
			},
			(reason: unknown) => {
				if (!abort.signal.aborted) setProvidersError(messageOf(reason));
			},
		);
		return () => abort.abort();
	}, [modelProviders, providersRead]);
	const [connectors, setConnectors] = useState<readonly ConnectorModels[]>();
	const [error, setError] = useState<string>();
	const [profile, setProfile] = useState<ProfileState>({ status: "loading" });
	const [draft, setDraft] = useState<string>();
	// The page saves as soon as the image model changes, calling onSave straight after onDraft, before the draft's state
	// has rendered: the save reads the draft from here.
	const draftRef = useRef<string | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saveError, setSaveError] = useState<string>();
	const [tests, setTests] = useState<Record<string, ImageTestState>>({});

	useEffect(() => {
		const abort = new AbortController();
		setConnectors(undefined);
		setError(undefined);
		models.connectors(projectId, abort.signal).then(setConnectors, (reason: unknown) => {
			if (!abort.signal.aborted) setError(messageOf(reason));
		});
		setProfile({ status: "loading" });
		client
			.startOptions(projectId, abort.signal)
			.then((start) => models.profile(start.agentId, abort.signal))
			.then(
				(found) => setProfile({ status: "ready", profile: found }),
				() => {
					if (!abort.signal.aborted) setProfile({ status: "none" });
				},
			);
		return () => abort.abort();
	}, [client, models, projectId]);

	const options = useMemo(() => imageModelOptions(connectors ?? []), [connectors]);

	// A provider saved or removed changes the connectors the project sees: read them again, keeping the list shown.
	const rereadConnectors = useCallback(() => {
		models.connectors(projectId).then(
			(found) => {
				setConnectors(found);
				setError(undefined);
			},
			(reason: unknown) => setError(messageOf(reason)),
		);
	}, [models, projectId]);

	const providerDone = useCallback(() => {
		setProviderForm(undefined);
		setProvidersRead((count) => count + 1);
		rereadConnectors();
	}, [rereadConnectors]);

	const removeProvider = useCallback(
		async (connectionId: string) => {
			if (modelProviders === undefined) return;
			setRemoving(connectionId);
			setProvidersError(undefined);
			try {
				await modelProviders.remove(connectionId);
				setProvidersRead((count) => count + 1);
				rereadConnectors();
			} catch (reason) {
				setProvidersError(messageOf(reason));
			} finally {
				setRemoving(undefined);
			}
		},
		[modelProviders, rereadConnectors],
	);

	const save = useCallback(async () => {
		const picked = draftRef.current;
		if (profile.status !== "ready" || picked === undefined) return;
		const choice = options.find((option) => option.id === picked)?.choice;
		const { imageModel: _old, ...rest } = profile.profile;
		const next: AgentProfile = picked === "" || choice === undefined ? rest : { ...rest, imageModel: choice };
		setSaving(true);
		setSaveError(undefined);
		try {
			const stored = await models.saveProfile(next);
			setProfile({ status: "ready", profile: stored });
			if (draftRef.current === picked) {
				draftRef.current = undefined;
				setDraft(undefined);
			}
			setSaved(true);
		} catch (reason) {
			setSaveError(messageOf(reason));
		} finally {
			setSaving(false);
		}
	}, [models, options, profile]);

	const test = useCallback(
		async (connectorId: string, modelId: string) => {
			const key = testKey(connectorId, modelId);
			setTests((now) => ({ ...now, [key]: { status: "running" } }));
			const started = performance.now();
			try {
				const result = await models.testImage(connectorId, { projectId, modelId });
				const image = result.images[0];
				setTests((now) => ({
					...now,
					[key]:
						image === undefined
							? { status: "error", message: "The model answered with no image" }
							: {
									status: "done",
									image: { mimeType: image.mimeType, data: image.data },
									costUsd: result.usage.cost.total,
									ms: performance.now() - started,
								},
				}));
			} catch (reason) {
				setTests((now) => ({ ...now, [key]: { status: "error", message: messageOf(reason) } }));
			}
		},
		[models, projectId],
	);

	const may = client.mayStart(projectId);
	const agent: ModelsPageAgent | undefined =
		profile.status !== "ready"
			? undefined
			: {
					name: profile.profile.name,
					chatModel: choiceId(profile.profile.model),
					...(profile.profile.imageModel === undefined ? {} : { imageModel: choiceId(profile.profile.imageModel) }),
					...(draft === undefined ? {} : { draft }),
					options,
					saving,
					saved,
					...(saveError === undefined ? {} : { error: saveError }),
					...(may.allowed ? {} : { readOnlyReason: "Changing the agent needs the operator role." }),
				};

	const editingDefault =
		providerForm?.editing !== undefined && providerState?.default?.connectionId === providerForm.editing.id
			? providerState.default.modelId
			: undefined;
	const providerSetup =
		modelProviders === undefined || providerForm === undefined ? undefined : (
			<ProviderSetupScreen
				key={providerForm.editing?.id ?? "new"}
				providers={modelProviders}
				variant="settings"
				{...(providerForm.editing === undefined ? {} : { editing: providerForm.editing })}
				{...(editingDefault === undefined ? {} : { initialModel: editingDefault })}
				onDone={providerDone}
				onCancel={() => setProviderForm(undefined)}
			/>
		);

	return (
		<ModelsPage
			{...(modelProviders === undefined
				? {}
				: {
						...(providerState === undefined
							? {}
							: {
									providers: {
										connections: providerState.connections,
										...(providerState.default === undefined ? {} : { default: providerState.default }),
										...(providerState.platformDefault === undefined
											? {}
											: { platformDefault: providerState.platformDefault }),
										canManage: providerState.canManage,
									},
								}),
						...(providersError === undefined ? {} : { providersError }),
						...(removing === undefined ? {} : { removingProvider: removing }),
						...(providerSetup === undefined ? {} : { providerSetup }),
						onConnectProvider: () => setProviderForm({}),
						onEditProvider: (connectionId: string) => {
							const editing = providerState?.connections.find((connection) => connection.id === connectionId);
							if (editing !== undefined) setProviderForm({ editing });
						},
						onRemoveProvider: (connectionId: string) => void removeProvider(connectionId),
					})}
			connectors={connectors}
			{...(error === undefined ? {} : { error })}
			{...(agent === undefined ? {} : { agent })}
			onDraft={(value) => {
				draftRef.current = value ?? "";
				setDraft(value ?? "");
				setSaved(false);
			}}
			onSave={() => void save()}
			tests={tests}
			onTest={(connectorId, modelId) => void test(connectorId, modelId)}
		/>
	);
}
