/** What the generated files hold, so the script and the tests make them the same way. */
import { type JsonSchema, openApiDocument } from "./openapi.ts";
import { API_VERSION_BASE, routes } from "./routes.ts";
import { renderSdk } from "./sdk.ts";

export const SDK_HEADER = [
	"// Kantel's public API: the TypeScript SDK. Generated from packages/api/src/routes.ts by",
	"// `pnpm --filter @kantel/api generate`; don't edit it by hand. CI fails while it is stale.",
].join("\n");

/** The v1 OpenAPI document. */
export const openApi = (): JsonSchema =>
	openApiDocument(routes, {
		title: "Kantel API",
		version: "1",
		description:
			"Kantel's public API for host apps, such as Lleverage, and for Kantel's own console, which uses it like any other client.",
		basePath: API_VERSION_BASE,
	});

/** The v1 SDK's source, before formatting. */
export const sdkSource = (runtime: string): string => renderSdk(routes, { runtime, header: SDK_HEADER });
