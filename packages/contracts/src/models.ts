/**
 * The model names that outlive the agent plane's model gateway (removed in TASK-4721; it is on the
 * `agent-plane-archive` branch): the thinking level a user's last session asked for (`identity.ts`), and the wire APIs
 * and presets usage records name (`usage.ts`).
 */

/** The wire APIs connectors speak upstream; all are implemented by pi-ai. */
export type ModelWireApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/**
 * The wire APIs a connector generates images over, beside its chat APIs:
 *
 * - `openai-images`: OpenAI's Images API, `POST <baseUrl>/images/generations` (and `/images/edits` with reference
 *   images, as multipart form data). OpenAI, LiteLLM, CLIProxyAPI and the compatible presets speak it.
 * - `chat-modalities`: chat completions with `modalities: ["image", "text"]`, the images coming back in
 *   `message.images` (pi-ai's `openrouter-images`). OpenRouter and Vercel AI Gateway speak it; Vercel's image-only
 *   models take `openai-images` instead.
 */
export type ModelImageApi = "openai-images" | "chat-modalities";

/**
 * A preset fixes the pi-ai provider, the wire APIs, where the key goes and how scope reaches the upstream as
 * attribution and session affinity. `openai-compatible` and `anthropic-compatible` are for anything else.
 */
export type ConnectorPreset =
	| "litellm"
	| "vercel-ai-gateway"
	| "openrouter"
	| "anthropic"
	| "openai"
	| "cliproxyapi"
	| "cloudflare-ai-gateway"
	| "openai-compatible"
	| "anthropic-compatible";

/** A thinking level a route or a call asks for: pi's levels. */
export type ModelThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
