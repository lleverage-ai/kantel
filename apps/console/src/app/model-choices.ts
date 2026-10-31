import {
	type ComposerProps,
	chosenThinking,
	MODEL_LOCKED_REASON,
	offeredLevels,
	selectedModel,
	THINKING_CACHE_NOTE,
	type ThinkingLevel,
} from "@harbour/ui";
import { useEffect, useState } from "react";
import type { ConsoleClient, LastChoice, ModelChoices, SendOptions } from "../api/client.ts";

type Target = Parameters<NonNullable<ConsoleClient["modelChoices"]>>[0];

/** The composer's model and thinking props, and what to send with the next message. */
export type ModelPickers = {
	/** Spread onto the composer; empty while loading, on failure, or on a client that can't choose. */
	readonly composer: Pick<
		ComposerProps,
		| "models"
		| "model"
		| "onModelChange"
		| "modelLocked"
		| "thinking"
		| "defaultThinking"
		| "onThinkingChange"
		| "thinkingNote"
	>;
	/**
	 * The chosen model and level for a send: what the pickers show, so the run uses what the person saw. Once the session
	 * has started it carries no model, as the session's is fixed; only the level.
	 */
	readonly send: Pick<SendOptions, "model" | "thinking">;
	/** Shows `choice` in the pickers, as what the person picked: a first message's, sent before the session started. */
	readonly pick: (choice: Pick<SendOptions, "model" | "thinking">) => void;
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
 * A new session's choices, starting from what the person last chose (`last`) where the new session can use it: their
 * last model when the catalogue lists it and it isn't disabled, and their last level (the pickers clamp it to the
 * model). What the person picks on New session still wins, as it goes with the first message.
 */
export function withLastChoice(choices: ModelChoices, last: LastChoice | undefined): ModelChoices {
	if (last === undefined) return choices;
	const usable = choices.models.find((model) => model.id === last.model && model.disabledReason === undefined);
	return {
		...choices,
		...(usable === undefined ? {} : { model: usable.id }),
		...(last.thinking === undefined ? {} : { thinking: last.thinking }),
	};
}

/**
 * What a send carried, as the person's last choice: `shown`, the model the pickers show, when the send named none (the
 * session has started). Undefined when there was no choice to keep (no pickers).
 */
export function lastChoiceOf(
	shown: string | undefined,
	send: Pick<SendOptions, "model" | "thinking">,
): LastChoice | undefined {
	const model = send.model ?? shown;
	const choice: LastChoice = {
		...(model === undefined ? {} : { model }),
		...(send.thinking === undefined ? {} : { thinking: send.thinking }),
	};
	return choice.model === undefined && choice.thinking === undefined ? undefined : choice;
}

export type ModelPickerOptions = {
	/**
	 * The session has started (its transcript has a message from the host): its model is fixed. When it becomes true
	 * before the choices said so, they load again, so the pickers show what the session's first message chose.
	 */
	readonly started?: boolean;
	/** For a new session: what the person last chose, preselected where the session can use it (`withLastChoice`). */
	readonly last?: LastChoice;
};

/**
 * Loads what a session (or a new session in a project) may run with and holds the person's picks, which start from
 * what the session runs with now (for a new session, what the person last chose). A target that changes loads again
 * and starts over. Once the session has started, the model picker is read-only and the thinking picker says a change
 * may cost the prompt cache. Fails quietly: without a catalogue there are no pickers and messages go on the session's
 * own model.
 */
export function useModelPickers(
	client: ConsoleClient,
	target: Target | undefined,
	options: ModelPickerOptions = {},
): ModelPickers {
	const key = target === undefined ? "" : "sessionId" in target ? target.sessionId : JSON.stringify(target.start);
	const [loaded, setLoaded] = useState<{ key: string; choices: ModelChoices }>();
	const [model, setModel] = useState<string>();
	const [thinking, setThinking] = useState<ThinkingLevel>();
	const started = options.started === true;
	const lastModel = options.last?.model;
	const lastThinking = options.last?.thinking;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `target`, which is a new object each render.
	useEffect(() => {
		setModel(undefined);
		setThinking(undefined);
		if (target === undefined || client.modelChoices === undefined) return;
		const controller = new AbortController();
		client.modelChoices(target, controller.signal).then(
			(choices) => {
				if (controller.signal.aborted) return;
				const last =
					"start" in target && (lastModel !== undefined || lastThinking !== undefined)
						? { model: lastModel, thinking: lastThinking }
						: undefined;
				setLoaded({ key, choices: withLastChoice(choices, last) });
			},
			() => {},
		);
		return () => controller.abort();
	}, [client, key]);

	const choices = loaded?.key === key ? loaded.choices : undefined;

	// The session started after the choices loaded: load them again, keeping these until the new ones come so the
	// pickers don't flicker, and show what the session runs with now in place of the person's picks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `target`, which is a new object each render.
	useEffect(() => {
		if (!started || choices === undefined || choices.locked === true) return;
		if (target === undefined || client.modelChoices === undefined) return;
		const controller = new AbortController();
		client.modelChoices(target, controller.signal).then(
			(next) => {
				if (controller.signal.aborted) return;
				setLoaded({ key, choices: { ...next, locked: true } });
				setModel(undefined);
				setThinking(undefined);
			},
			() => {},
		);
		return () => controller.abort();
	}, [client, key, started, choices]);

	const pick = (choice: Pick<SendOptions, "model" | "thinking">) => {
		if (choice.model !== undefined) setModel(choice.model);
		if (choice.thinking !== undefined) setThinking(choice.thinking);
	};
	if (choices === undefined || choices.models.length === 0) return { composer: {}, send: {}, pick };
	const locked = started || choices.locked === true;
	// Once the host says the session has started, the model is the session's, whatever was picked before; until then a
	// pick (the first message's) still shows.
	const shownModel = choices.locked === true ? choices.model : (model ?? choices.model);
	const send = sendChoice(choices, shownModel, thinking);
	return {
		composer: {
			models: choices.models,
			model: shownModel,
			onModelChange: setModel,
			...(locked ? { modelLocked: MODEL_LOCKED_REASON, thinkingNote: THINKING_CACHE_NOTE } : {}),
			thinking: thinking ?? choices.thinking,
			...(choices.defaultThinking === undefined ? {} : { defaultThinking: choices.defaultThinking }),
			onThinkingChange: setThinking,
		},
		send: locked ? (send.thinking === undefined ? {} : { thinking: send.thinking }) : send,
		pick,
	};
}
