import type { AgentProfile, ConnectorModels } from "@harbour/contracts";
import { type ImageTestState, ModelsPage, type ModelsPageAgent, testKey } from "@harbour/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConsoleClient } from "../api/client.ts";
import { type ConsoleModels, choiceId, imageModelOptions } from "../api/models-http.ts";

// A project's Models page: its connectors' models with their capabilities and a test image, and the image model of the
// agent a new session in the project runs (`ConsoleClient.startOptions`). @harbour/ui's ModelsPage lays it out; this
// file reads and writes through the models seam (`api/models-http.ts`) and keeps the page's state.

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

type ProfileState =
	| { readonly status: "loading" }
	| { readonly status: "none" }
	| { readonly status: "ready"; readonly profile: AgentProfile };

export function ModelsScreen({
	client,
	models,
	projectId,
}: {
	client: ConsoleClient;
	models: ConsoleModels;
	projectId: string;
}) {
	const [connectors, setConnectors] = useState<readonly ConnectorModels[]>();
	const [error, setError] = useState<string>();
	const [profile, setProfile] = useState<ProfileState>({ status: "loading" });
	const [draft, setDraft] = useState<string>();
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

	const save = useCallback(async () => {
		if (profile.status !== "ready" || draft === undefined) return;
		const choice = options.find((option) => option.id === draft)?.choice;
		const { imageModel: _old, ...rest } = profile.profile;
		const next: AgentProfile = draft === "" || choice === undefined ? rest : { ...rest, imageModel: choice };
		setSaving(true);
		setSaveError(undefined);
		try {
			const stored = await models.saveProfile(next);
			setProfile({ status: "ready", profile: stored });
			setDraft(undefined);
			setSaved(true);
		} catch (reason) {
			setSaveError(messageOf(reason));
		} finally {
			setSaving(false);
		}
	}, [draft, models, options, profile]);

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

	return (
		<ModelsPage
			connectors={connectors}
			{...(error === undefined ? {} : { error })}
			{...(agent === undefined ? {} : { agent })}
			onDraft={(value) => {
				setDraft(value ?? "");
				setSaved(false);
			}}
			onSave={() => void save()}
			tests={tests}
			onTest={(connectorId, modelId) => void test(connectorId, modelId)}
		/>
	);
}
