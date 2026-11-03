/**
 * Kantel's public API, defined once: the v1 routes (`routes.ts`) over the wire shapes (`schema.ts`), the server's
 * router (`router.ts`), and the generators for the OpenAPI document (`openapi.ts`) and the TS SDK (`sdk.ts`). The
 * generated files are `@kantel/api/openapi.json` and `@kantel/api/sdk`.
 */
export * from "./compute-routes.ts";
export * as computeSchema from "./compute-schema.ts";
// Only the dormant agent plane's route group, for @kantel/environments: its route consts share names with the compute
// plane's environment routes.
export { environmentRoutes } from "./environment-routes.ts";
export * as environmentSchema from "./environments-schema.ts";
export * from "./openapi.ts";
export * from "./route.ts";
export * from "./router.ts";
export * from "./routes.ts";
export * as schema from "./schema.ts";
export * from "./sdk.ts";
