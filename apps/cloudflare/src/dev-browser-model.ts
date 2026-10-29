/**
 * `wrangler dev` only (src/dev.ts): the echo model, plus two scripted errands so the browser and code mode can be tried
 * end to end without a model gateway. A message `browse <url>` makes it ask for a browser on the URL's host, open the
 * URL once a person allows it, take a screenshot and say what it saw. A message `codemode <script>` makes it run the
 * script with the `codemode` tool and say what it answered. Anything else is echoed. The tool calls are real: the
 * broker, brwsr, the console's Allow and the code mode isolate are what a deployed session uses.
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

export const DEV_BROWSER_PROVIDER = "harbour-dev-browser";

const textOf = (content: string | readonly { readonly type: string; readonly text?: string }[]): string =>
	typeof content === "string"
		? content
		: content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");

/** The next step of the errand, from the conversation since the last user message. */
export function nextStep(messages: readonly Message[]) {
	let start = messages.length - 1;
	while (start >= 0 && messages[start]?.role !== "user") start -= 1;
	const said = start < 0 ? "" : textOf((messages[start] as { content: Parameters<typeof textOf>[0] }).content).trim();
	const script = /^codemode\s+([\s\S]+)$/i.exec(said)?.[1];
	if (script !== undefined) {
		const answered = messages.slice(start + 1).find((message) => message.role === "toolResult");
		if (answered === undefined) {
			return fauxAssistantMessage([fauxToolCall("codemode", { code: script })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(fauxText(`Done: ${textOf(answered.content)}`));
	}
	const match = /^browse\s+(\S+)/i.exec(said);
	let url: URL | undefined;
	try {
		url = match?.[1] === undefined ? undefined : new URL(match[1]);
	} catch {
		url = undefined;
	}
	if (url === undefined) return fauxAssistantMessage(fauxText(`Echo: ${said}`));
	const results = messages
		.slice(start + 1)
		.filter((message) => message.role === "toolResult")
		.map((message) => ({ name: message.toolName, text: textOf(message.content), isError: message.isError }));
	const last = results.at(-1);
	const call = (name: string, args: { [key: string]: string | string[] }) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	if (last === undefined) {
		return call("browser_request", { reason: `To look at ${url.href}`, sites: [url.hostname] });
	}
	if (last.isError) return fauxAssistantMessage(fauxText(`I stopped: ${last.text}`));
	if (last.name === "browser_request") return call("browser_open", { url: url.href });
	const browserSessionId = /bsession_[\w-]+/.exec(results.map((result) => result.text).join("\n"))?.[0];
	if (last.name === "browser_open" && browserSessionId !== undefined) {
		return call("browser_screenshot", { browserSessionId });
	}
	return fauxAssistantMessage(fauxText(`Done: ${last.text.split("\n")[0] ?? ""}`));
}

export function createDevBrowserModels(): MutableModels {
	const core = createFauxCore({ provider: DEV_BROWSER_PROVIDER, models: [{ id: "dev-browser-1" }] });
	const factory: FauxResponseFactory = (context) => nextStep(context.messages);
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Dev", resolve: async () => ({ auth: {} }) } },
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
