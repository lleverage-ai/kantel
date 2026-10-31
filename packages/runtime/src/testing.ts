/**
 * A scripted model for the session conformance suite, on pi-ai's faux provider: each request takes the next queued
 * turn and is recorded as the suite's `ModelRequestView`.
 */
import type { Message } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import {
	createFauxCore,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonValue } from "@harbour/contracts";
import type { ModelRequestView, ModelScript, ScriptedTurn } from "@harbour/testing/session";

export interface ScriptedModel {
	readonly models: MutableModels;
	readonly script: ModelScript;
	/** Each request's messages as the provider was given them, images included: what the model read. */
	readonly contexts: readonly (readonly Message[])[];
}

function contentText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

function requestView(messages: readonly Message[]): ModelRequestView {
	const system: string[] = [];
	const flattened: ModelRequestView["messages"][number][] = [];
	for (const message of messages) {
		if (message.role === "system") {
			const parts = [contentText(message.content)];
			for (const section of Object.values(message.sections ?? {})) if (section !== null) parts.push(section);
			system.push(...parts.filter((part) => part !== ""));
		} else if (message.role === "user") {
			flattened.push({ role: "user", text: contentText(message.content) });
		} else if (message.role === "assistant") {
			const parts = message.content.map((block) =>
				block.type === "text"
					? block.text
					: block.type === "toolCall"
						? `${block.name}(${JSON.stringify(block.arguments)})`
						: "",
			);
			flattened.push({ role: "assistant", text: parts.filter((part) => part !== "").join("\n") });
		} else {
			flattened.push({ role: "tool", text: contentText(message.content) });
		}
	}
	return { system: system.join("\n\n"), messages: flattened };
}

/**
 * A Pi model collection with one faux provider whose replies come from a `ModelScript`. `input` is what the model reads:
 * text only by default, or `["text", "image"]` for one that looks at images.
 */
export function createScriptedModel(options: { readonly input?: ("text" | "image")[] } = {}): ScriptedModel {
	const queue: ScriptedTurn[] = [];
	const requests: ModelRequestView[] = [];
	const contexts: (readonly Message[])[] = [];
	const core = createFauxCore({
		provider: "scripted",
		models: [{ id: "scripted-1", ...(options.input === undefined ? {} : { input: options.input }) }],
	});

	const resolve = async (turn: ScriptedTurn | undefined, view: ModelRequestView) => {
		let current = turn;
		while (typeof current === "function") current = await current(view);
		if (current === undefined) return fauxAssistantMessage(fauxText("(no scripted reply)"));
		if ("text" in current) return fauxAssistantMessage(fauxText(current.text));
		return fauxAssistantMessage(
			current.toolCalls.map((call) => fauxToolCall(call.name, call.args as { [key: string]: JsonValue })),
			{ stopReason: "toolUse" },
		);
	};
	const factory: FauxResponseFactory = (context) => {
		const view = requestView(context.messages);
		requests.push(view);
		contexts.push(context.messages);
		return resolve(queue.shift(), view);
	};
	// Every request gets its own factory, so the faux queue never runs dry and the script decides the reply.
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Scripted", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: {
			stream: (model, context, options) => {
				core.appendResponses([factory]);
				return core.stream(model, context, options);
			},
			streamSimple: (model, context, options) => {
				core.appendResponses([factory]);
				return core.streamSimple(model, context, options);
			},
		},
	});
	const models = createModels();
	models.setProvider(provider);
	return {
		models,
		contexts,
		script: {
			reply(...turns) {
				queue.push(...turns);
			},
			get requests() {
				return requests;
			},
		},
	};
}
