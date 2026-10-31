/**
 * Browser goal mode's decisions (docs/design/browser-runtime.md, "Goal mode"): Reflex's goal loop runs in the browser's
 * container, next to Chromium, and asks a System One model for each step's choices. The model and its key stay here,
 * in the Worker: the container asks `BROWSER_DECISIONS_URL`, which its `KantelBrowser` object intercepts
 * (`interceptOutboundHttp`) and routes to the `KantelBrowserDecisions` entrypoint with the browser's decision token in
 * its props. Each request is answered with
 *
 * - **Clef** (`/decide/clef`): Cloudflare's, through the Worker's Workers AI binding (`AI`), so there is no key at all;
 * - **Jev** (`/decide/jev`): TypeSafe's, with the `KANTEL_JEV_API_KEY` Worker secret.
 *
 * The request and answer are TypeSafe's System One shape (https://api.typesafe.ai/openapi.json), which Clef speaks
 * too, plus the call's `cost_usd`. A request without the browser's token as its bearer is refused, so a page in the
 * browser that finds the address can't spend the deployment's model. Portable, so the tests run it in Node.
 */

/** The address the container asks for decisions: TEST-NET-1 (RFC 5737), which nothing on the internet answers. */
export const BROWSER_DECISIONS_ADDRESS = "192.0.2.10:80";
export const BROWSER_DECISIONS_URL = "http://192.0.2.10/decide";

/** The models, as Workers AI and TypeSafe name them, and what each costs per million input tokens (as Reflex counts). */
export const CLEF_MODEL = "@cf/cloudflare/clef";
export const JEV_MODEL = "jev-1.14.0";
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const USD_PER_MILLION = { clef: 0.33, jev: 0.042 } as const;

/** The biggest decision request taken: a page's state and its questions, well under Reflex's own bounds. */
export const MAX_DECISION_BYTES = 512 * 1024;

export interface DecisionVars {
	/** TypeSafe's key, for Jev. A Worker secret. Without it a Jev decision is `unavailable`. */
	readonly KANTEL_JEV_API_KEY?: string;
}

export interface DecisionModels {
	/** The Worker's Workers AI binding, for Clef. */
	readonly ai?: { run(model: string, input: unknown): Promise<unknown> };
	readonly jevApiKey?: string;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, code: string, message: string) => answer(status, { error: { code, message } });

/** Compares two tokens in time that depends only on their lengths. */
function sameToken(a: string, b: string): boolean {
	if (a.length !== b.length || a.length === 0) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One decision request from the container: checked against the browser's token, then asked of the model it names. */
export async function answerDecision(request: Request, token: string, models: DecisionModels): Promise<Response> {
	if (request.method !== "POST") return refuse(405, "invalid", "Use POST");
	const model = new URL(request.url).pathname.match(/^\/decide\/(clef|jev)$/)?.[1] as "clef" | "jev" | undefined;
	if (model === undefined) return refuse(404, "not_found", "No such decision route");
	const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
	if (!sameToken(bearer, token)) return refuse(403, "forbidden", "Not this browser's decision token");
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > MAX_DECISION_BYTES) {
		return refuse(413, "invalid", "The decision request is too big");
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return refuse(400, "invalid", "The decision request is not JSON");
	}
	if (!isRecord(body) || !isRecord(body.questions)) return refuse(400, "invalid", "A decision request has questions");
	let reply: unknown;
	try {
		if (model === "clef") {
			if (models.ai === undefined) return refuse(503, "unavailable", "Clef needs the Worker's Workers AI binding");
			reply = await models.ai.run(CLEF_MODEL, body);
		} else {
			const key = (models.jevApiKey ?? "").trim();
			if (key === "") return refuse(503, "unavailable", "Jev needs the KANTEL_JEV_API_KEY secret");
			const headers: { [name: string]: string } = {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			};
			if (body.assets !== undefined) headers["TypeSafe-Danger-Zone-Images"] = "true";
			const response = await (models.fetch ?? fetch)(JEV_ENDPOINT, {
				method: "POST",
				headers,
				body: JSON.stringify({ model: JEV_MODEL, ...body }),
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) {
				await response.body?.cancel();
				return refuse(502, "unavailable", `Jev answered ${response.status}`);
			}
			reply = await response.json();
		}
	} catch (error) {
		return refuse(502, "unavailable", `The decision model failed: ${error instanceof Error ? error.name : "error"}`);
	}
	if (!isRecord(reply) || !isRecord(reply.answers)) return refuse(502, "unavailable", "The model gave no answers");
	const usage = isRecord(reply.usage) ? reply.usage : {};
	const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	return answer(200, {
		model: typeof reply.model === "string" ? reply.model : model === "clef" ? CLEF_MODEL : JEV_MODEL,
		answers: reply.answers,
		usage: { input_tokens: inputTokens },
		cost_usd: (inputTokens * USD_PER_MILLION[model]) / 1e6,
	});
}
