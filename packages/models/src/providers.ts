/**
 * A connection test: reads an upstream's model listing with a key the caller holds, before anything is saved, as the
 * console's onboarding does on "Test connection". The same listing the gateway's catalogue reads (`catalogueUrl`,
 * `parseCatalogueListing`), with the same key header, so a test that passes means the catalogue will too.
 *
 * Never throws the key back: every message is redacted, and an upstream's own error body is not repeated.
 */
import { type ConnectorPreset, KantelError, type ModelProviderModel } from "@kantel/contracts";
import { parseCatalogueListing, sanitisedListing } from "./catalogue.ts";
import { catalogueUrl, presetSpec } from "./presets.ts";
import { Redactor } from "./redact.ts";

export const PROVIDER_TEST_TIMEOUT_MS = 10_000;

export interface ProviderModelsRequest {
	readonly preset: ConnectorPreset;
	readonly baseUrl: string;
	readonly key: string;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/**
 * The models the upstream lists for `key`, sorted by ID. Rejects with `refused` when the upstream refuses the key (401
 * or 403), `not_found` when it has no listing at that address (404), and `unavailable` when it can't be reached, times
 * out, fails or answers something that isn't a listing.
 */
export async function listProviderModels(request: ProviderModelsRequest): Promise<readonly ModelProviderModel[]> {
	const spec = presetSpec(request.preset);
	const url = catalogueUrl({ baseUrl: request.baseUrl, preset: request.preset });
	const redactor = new Redactor([request.key]);
	const timeout = AbortSignal.timeout(request.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS);
	const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
	const anthropicOnly = spec.apis.every((api) => api === "anthropic-messages");
	let response: Response;
	try {
		response = await (request.fetch ?? fetch)(url, {
			signal,
			headers: {
				accept: "application/json",
				...spec.catalogueHeaders,
				...(anthropicOnly ? { "x-api-key": request.key } : { authorization: `Bearer ${request.key}` }),
			},
		});
	} catch (error) {
		if (error instanceof KantelError) throw error;
		const timedOut = timeout.aborted;
		const detail = error instanceof Error ? error.message : String(error);
		throw new KantelError(
			"unavailable",
			timedOut
				? `${new URL(url).host} didn't answer within ${Math.round((request.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS) / 1000)} seconds`
				: redactor.text(`Couldn't reach ${new URL(url).host}: ${detail}`),
		);
	}
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 401 || response.status === 403) {
			throw new KantelError("refused", `The provider refused the key (${response.status})`);
		}
		if (response.status === 404) {
			throw new KantelError("not_found", `There's no model list at ${url}: check the base URL`);
		}
		throw new KantelError("unavailable", `The provider answered ${response.status} for its model list`);
	}
	const body: unknown = await response.json().catch(() => undefined);
	if (body === undefined || typeof body !== "object" || body === null || !("data" in body)) {
		throw new KantelError("unavailable", `${url} didn't answer with a model list: check the base URL`);
	}
	return sanitisedListing(parseCatalogueListing(body), redactor)
		.map((model) => ({
			id: model.id,
			...(model.name === undefined ? {} : { name: model.name }),
			...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}
