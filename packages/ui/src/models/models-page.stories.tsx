import type { ConnectorModels } from "@kantel/contracts";
import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { type ImageTestState, ModelsPage, type ModelsPageAgent, testKey } from "./models-page.tsx";

export default { title: "Models/Models page" } satisfies StoryDefault;

// A 64 by 64 test image, as the fake upstream answers.
const IMAGE =
	"iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAABiUlEQVR42u3U3SvDURwG8Ocv+V0rpZRSopQ6pZRSSmihhRYz21pooYUWEhJaiJmZ9/d35v3lb3LlV7tR1L7n5qynTn2uzsXT8704D4qav6ihuPWTGko8H9RQ2vZODWUdb9RQ7n2lhorOF2qo6n6mhmrfEzXU9DwWyne28i/dECh/1rx/q/8mj0Jt4MGwvO1zhGmoC94bJjxAmIb68J1JwvY5kkA0RG5N0jpAEojGgRuTtA6QBKJp6NokrQMkgWiJXpmkdYAkEJ7hS5O0DpAEon30wiStAySB8MbODRO2F6aha+zMMOEBwjT4Jk7Ny9teHoXe+Emh/FtdNwSByWNqCE0fUUNk5pAaBmcPqCE6v08NIwt71BBb3KWG8eUdaognMtQwtbJNDTNraWqYW9+ihoVkihqWUpvUkEgnqWE1s0ENTkg5YeX4ldOnnIBy+pUTVESPoG7vPoK6vfsI6vbuI6jbu4+gbu8+grq9+2hn1M6onVE7o3ZG7YzaGbUzamfUzqidUTujtF/5ByS2PygU+A6kAAAAAElFTkSuQmCC";

const CONNECTORS: readonly ConnectorModels[] = [
	{
		id: "cpa",
		owner: { kind: "platform" },
		preset: "cliproxyapi",
		routes: [
			{ name: "default", modelId: "claude-sonnet-5-5" },
			{ name: "images", modelId: "gpt-image-1" },
		],
		models: [
			{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", input: ["text", "image"], output: ["text"] },
			{ id: "gpt-5", name: "GPT-5", input: ["text", "image"], output: ["text"] },
			{
				id: "gpt-image-1",
				name: "gpt-image-1",
				input: ["text", "image"],
				output: ["image"],
				imageApi: "openai-images",
			},
		],
	},
	{
		id: "openrouter-team",
		owner: { kind: "organisation", organisationId: "org_harbour" },
		preset: "openrouter",
		routes: [{ name: "team", modelId: "google/gemini-3-pro" }],
		models: [
			{ id: "google/gemini-3-pro", name: "Gemini 3 Pro", input: ["text", "image"], output: ["text"] },
			{
				id: "google/gemini-3-pro-image-preview",
				name: "Nano Banana Pro",
				input: ["text", "image"],
				output: ["image", "text"],
				imageApi: "chat-modalities",
			},
		],
	},
];

const AGENT: ModelsPageAgent = {
	name: "Assistant",
	chatModel: "default",
	options: [
		{ id: "images", label: "gpt-image-1 (route images)" },
		{ id: "team:google/gemini-3-pro-image-preview", label: "Nano Banana Pro (openrouter-team)" },
	],
};

/** The page with a working picker and test button. */
function Live({
	agent = AGENT,
	connectors = CONNECTORS,
}: {
	agent?: ModelsPageAgent;
	connectors?: readonly ConnectorModels[];
}) {
	const [state, setState] = useState<ModelsPageAgent>(agent);
	const [tests, setTests] = useState<Record<string, ImageTestState>>({});
	return (
		<ModelsPage
			connectors={connectors}
			agent={state}
			onDraft={(draft) =>
				setState((now) => ({ ...now, ...(draft === undefined ? { draft: "" } : { draft }), saved: false }))
			}
			onSave={() => {
				setState((now) => ({ ...now, saving: true }));
				setTimeout(() => {
					setState((now) => {
						const { draft, ...rest } = now;
						return { ...rest, ...(draft ? { imageModel: draft } : {}), saving: false, saved: true };
					});
				}, 500);
			}}
			tests={tests}
			onTest={(connectorId, modelId) => {
				const key = testKey(connectorId, modelId);
				setTests((now) => ({ ...now, [key]: { status: "running" } }));
				setTimeout(() => {
					setTests((now) => ({
						...now,
						[key]:
							connectorId === "openrouter-team"
								? { status: "error", message: "The gateway can't call the chat-modalities image API yet" }
								: { status: "done", image: { mimeType: "image/png", data: IMAGE }, costUsd: 0, ms: 2400 },
					}));
				}, 700);
			}}
		/>
	);
}

export const Connectors: Story = () => <Live />;

export const ImageModelSaved: Story = () => <Live agent={{ ...AGENT, imageModel: "images", saved: true }} />;

/** The image model saves on change; this save failed, and says so beside the select with a way to try again. */
export const SaveFailed: Story = () => (
	<ModelsPage
		connectors={CONNECTORS}
		agent={{
			...AGENT,
			imageModel: "images",
			draft: "team:google/gemini-3-pro-image-preview",
			error: "The profile store refused the change",
		}}
		onSave={() => {}}
	/>
);

export const TestImage: Story = () => (
	<ModelsPage
		connectors={CONNECTORS}
		agent={{ ...AGENT, imageModel: "images" }}
		tests={{
			[testKey("cpa", "gpt-image-1")]: {
				status: "done",
				image: { mimeType: "image/png", data: IMAGE },
				costUsd: 0.011,
				ms: 6100,
			},
			[testKey("openrouter-team", "google/gemini-3-pro-image-preview")]: {
				status: "error",
				message: "The gateway can't call the chat-modalities image API yet",
			},
		}}
		onTest={() => {}}
	/>
);

export const NoImageModels: Story = () => (
	<Live
		agent={{ ...AGENT, options: [] }}
		connectors={[
			{ ...(CONNECTORS[0] as ConnectorModels), models: (CONNECTORS[0] as ConnectorModels).models.slice(0, 2) },
		]}
	/>
);

export const ReadOnly: Story = () => (
	<ModelsPage
		connectors={CONNECTORS}
		agent={{ ...AGENT, imageModel: "images", readOnlyReason: "Changing the agent needs the operator role." }}
	/>
);

export const Loading: Story = () => <ModelsPage connectors={undefined} agent={AGENT} />;

export const LoadFailed: Story = () => (
	<ModelsPage connectors={undefined} error="This deployment has no model gateway: its sessions run on the echo model" />
);

export const Empty: Story = () => <ModelsPage connectors={[]} />;
