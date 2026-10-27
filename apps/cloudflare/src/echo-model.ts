/**
 * The model sessions run on until the model gateway is bound (step 2 of #17: CLIProxyAPI through the `vpc_services`
 * binding). pi-ai's faux provider, answering every prompt with its own text, so the session API can be driven end to
 * end with no key and no network.
 */
import type { Message } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import {
	createFauxCore,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
} from "@earendil-works/pi-ai/providers/faux";

export const ECHO_PROVIDER = "harbour-echo";
export const ECHO_MODEL = "echo-1";

function lastUserText(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.filter((text) => text !== "")
			.join("\n");
	}
	return "";
}

/** A model collection with one provider whose one model repeats the last user message. */
export function createEchoModels(): MutableModels {
	const core = createFauxCore({ provider: ECHO_PROVIDER, models: [{ id: ECHO_MODEL }] });
	const factory: FauxResponseFactory = (context) =>
		fauxAssistantMessage(fauxText(`Echo: ${lastUserText(context.messages)}`));
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Echo", resolve: async () => ({ auth: {} }) } },
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
	return models;
}
