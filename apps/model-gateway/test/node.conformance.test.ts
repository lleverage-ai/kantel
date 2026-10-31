import { createFakeModelUpstream, registerModelGatewayConformance } from "@kantel/testing/models";
import { describe, expect, it } from "vitest";
import { withNodeStack } from "./support.ts";

// The gateway suite through real HTTP: pi-ai's own client against the Node server, keys read from the vault's egress
// decision API on another server.
registerModelGatewayConformance({ describe, expect, it }, "model gateway on Node over HTTP", async (deps, use) => {
	await withNodeStack(deps, createFakeModelUpstream(), use);
});
