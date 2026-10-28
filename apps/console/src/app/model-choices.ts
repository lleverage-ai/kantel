import { type ComposerProps, chosenThinking, offeredLevels, selectedModel, type ThinkingLevel } from "@harbour/ui";
import { useEffect, useState } from "react";
import type { ConsoleClient, ModelChoices, SendOptions } from "../api/client.ts";

type Target = Parameters<NonNullable<ConsoleClient["modelChoices"]>>[0];

/** The composer's model and thinking props, and what to send with the next message. */
export type ModelPickers = {
	/** Spread onto the composer; empty while loading, on failure, or on a client that can't choose. */
	readonly composer: Pick<
		ComposerProps,
		"models" | "model" | "onModelChange" | "thinking" | "defaultThinking" | "onThinkingChange"
	>;
	/** The chosen model and level for a send: what the pickers show, so the run uses what the person saw. */
	readonly send: Pick<SendOptions, "model" | "thinking">;
};

/** What to send for a choice: the model's id, and the level it shows, or none for a model that can't think. */
export function sendChoice(
	choices: ModelChoices | undefined,
	model: string | undefined,
	thinking: ThinkingLevel | undefined,
): Pick<SendOptions, "model" | "thinking"> {
	if (choices === undefined) return {};
	const chosen = selectedModel(choices.models, model ?? choices.model);
	if (chosen === undefined) return {};
	const level = chosenThinking(
		offeredLevels(chosen.capabilities?.thinking),
		thinking ?? choices.thinking,
		choices.defaultThinking,
	);
	return { model: chosen.id, ...(level === undefined ? {} : { thinking: level }) };
}

/**
 * Loads what a session (or a new session in a project) may run with and holds the person's picks, which start from
 * what the session runs with now. A target that changes loads again and starts over. Fails quietly: without a
 * catalogue there are no pickers and messages go on the session's own model.
 */
export function useModelPickers(client: ConsoleClient, target: Target | undefined): ModelPickers {
	const key = target === undefined ? "" : "sessionId" in target ? target.sessionId : JSON.stringify(target.start);
	const [loaded, setLoaded] = useState<{ key: string; choices: ModelChoices }>();
	const [model, setModel] = useState<string>();
	const [thinking, setThinking] = useState<ThinkingLevel>();

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `target`, which is a new object each render.
	useEffect(() => {
		setModel(undefined);
		setThinking(undefined);
		if (target === undefined || client.modelChoices === undefined) return;
		const controller = new AbortController();
		client.modelChoices(target, controller.signal).then(
			(choices) => {
				if (!controller.signal.aborted) setLoaded({ key, choices });
			},
			() => {},
		);
		return () => controller.abort();
	}, [client, key]);

	const choices = loaded?.key === key ? loaded.choices : undefined;
	if (choices === undefined || choices.models.length === 0) return { composer: {}, send: {} };
	return {
		composer: {
			models: choices.models,
			model: model ?? choices.model,
			onModelChange: setModel,
			thinking: thinking ?? choices.thinking,
			...(choices.defaultThinking === undefined ? {} : { defaultThinking: choices.defaultThinking }),
			onThinkingChange: setThinking,
		},
		send: sendChoice(choices, model, thinking),
	};
}
