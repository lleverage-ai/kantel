/**
 * `@kantel/compute`: the compute plane's control-plane API. `createComputeApi` serves `@kantel/api`'s `computeRoutes`
 * over a `SandboxBackend`; until lane 2's host scheduler implements that seam, `createStubBackend` (`./stub`) runs each
 * sandbox in memory with a just-bash shell. `./serve` is a dev server over the stub.
 */
export * from "./auth.ts";
export * from "./backend.ts";
export * from "./base-images.ts";
export * from "./base-status.ts";
export * from "./disk-holders.ts";
export * from "./github-app.ts";
export * from "./github-runners.ts";
export * from "./grants.ts";
export * from "./http.ts";
export * from "./live.ts";
export * from "./mounts.ts";
export * from "./names.ts";
export * from "./needs-microvm.ts";
export * from "./routed-backend.ts";
export * from "./secrets.ts";
export * from "./service.ts";
export * from "./store.ts";
export * from "./stub-backend.ts";
export { type TarEntry, writeTar } from "./tar.ts";
export * from "./telemetry.ts";
/** How long a stored template build's lease lasts: the hosts service's build timeouts must stay within it. */
export { TEMPLATE_BUILD_LEASE_MS } from "./templates.ts";
export * from "./util.ts";
export * from "./webhooks.ts";
