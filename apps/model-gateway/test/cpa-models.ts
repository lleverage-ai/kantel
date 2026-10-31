import type { ModelConnector, ModelWireApi } from "@kantel/contracts";
import { findPiModel, upstreamModel } from "@kantel/models/catalogue";

/**
 * Choosing the models the live CLIProxyAPI test runs on. CPA lists IDs only, and the gateway offers a CPA model only
 * when pi-ai's catalogue knows its ID (packages/models/CONTRACT.md), so a model must be both
 * listed by this CPA and known to pi-ai. A model that isn't would leave the route out of `/v1/config`, and every case on
 * that wire API would fail with "/v1/config does not list under-test", which says nothing about why.
 */

/** The wire APIs in the order the live test runs them, with the variable that picks each one's model. */
export const CPA_WIRE_APIS: readonly { readonly api: ModelWireApi; readonly env: string; readonly fallback: string }[] =
	[
		{ api: "anthropic-messages", env: "KANTEL_CPA_MESSAGES_MODEL", fallback: "claude-sonnet-4-5" },
		{ api: "openai-responses", env: "KANTEL_CPA_RESPONSES_MODEL", fallback: "gpt-5" },
		{ api: "openai-completions", env: "KANTEL_CPA_COMPLETIONS_MODEL", fallback: "gemini-2.5-pro" },
	];

/** A model the live test can run on one wire API, or why there is none. */
export type CpaModelChoice =
	| { readonly api: ModelWireApi; readonly modelId: string; readonly source: "env" | "default" | "listing" }
	| { readonly api: ModelWireApi; readonly error: string };

/** A connector shaped as the conformance suite configures it, to ask the gateway's own catalogue code about a model. */
function probeConnector(api: ModelWireApi, modelId: string): ModelConnector {
	return {
		id: "cpa-live-probe",
		owner: { kind: "platform" },
		preset: "cliproxyapi",
		baseUrl: "http://cpa.invalid/v1",
		vaultItemId: "cpa-live-probe",
		catalogue: { refresh: "gateway", overrides: { [modelId]: { api } } },
		createdAt: 0,
		updatedAt: 0,
	};
}

/** Whether the gateway offers `modelId` from a CPA connector: pi-ai's catalogue must give its limits. */
export function gatewayOffers(api: ModelWireApi, modelId: string): boolean {
	return upstreamModel(probeConnector(api, modelId), modelId) !== undefined;
}

/** Whether pi-ai's entry for `modelId` is a model of the kind that wire API is for, so a choice from the listing fits. */
function suits(api: ModelWireApi, modelId: string): boolean {
	const pi = findPiModel(modelId, "cliproxyapi");
	if (pi === undefined) return false;
	if (api === "anthropic-messages") return pi.api === "anthropic-messages";
	if (api === "openai-responses") return pi.api === "openai-responses";
	// Completions is the generic one: anything that isn't Anthropic's, Google's first.
	return pi.api !== "anthropic-messages";
}

/**
 * The model to run each wire API on, from what this CPA lists (`listed`, its `/v1/models` IDs in order) and the
 * `KANTEL_CPA_*_MODEL` variables in `env`. A variable that is set must name a listed model the gateway offers, and is
 * an error otherwise. An unset one takes the default when it qualifies, then the first listed model that qualifies and
 * suits the wire API (for completions, Google's models first).
 */
export function chooseCpaModels(
	listed: readonly string[],
	env: { readonly [name: string]: string | undefined },
): readonly CpaModelChoice[] {
	const served = new Set(listed);
	return CPA_WIRE_APIS.map(({ api, env: name, fallback }): CpaModelChoice => {
		const wanted = env[name]?.trim();
		if (wanted) {
			if (!served.has(wanted)) return { api, error: `${name}=${wanted} is not in this CPA's /v1/models listing` };
			if (!gatewayOffers(api, wanted)) {
				return {
					api,
					error:
						`${name}=${wanted} is listed by CPA but not in pi-ai's catalogue, so the gateway won't offer it ` +
						'(packages/models/CONTRACT.md, "Catalogue"); pick a listed model pi-ai knows',
				};
			}
			return { api, modelId: wanted, source: "env" };
		}
		if (served.has(fallback) && gatewayOffers(api, fallback)) return { api, modelId: fallback, source: "default" };
		const usable = listed.filter((id) => gatewayOffers(api, id) && suits(api, id));
		const google =
			api === "openai-completions" ? usable.find((id) => findPiModel(id)?.provider === "google") : undefined;
		const pick = google ?? usable[0];
		if (pick !== undefined) return { api, modelId: pick, source: "listing" };
		return {
			api,
			error: `this CPA lists no model pi-ai knows for ${api}; set ${name} to a listed model pi-ai's catalogue has`,
		};
	});
}
