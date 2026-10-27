import { systemContext } from "@harbour/contracts";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import { createModelGateway } from "@harbour/models/gateway";
import { createModelGatewayHttp } from "@harbour/models/http";
import { createHmacSessionTokens } from "@harbour/models/tokens";
import type { ConformanceDeps } from "@harbour/testing/harness";
import {
	createFakeModelUpstream,
	FAKE_CONNECTOR_MODELS,
	FAKE_CONNECTOR_TARGETS,
	type FakeModelGatewaySubject,
	type FakeModelUpstream,
	registerModelConnectorConformance,
	registerModelGatewayConformance,
} from "@harbour/testing/models";
import { createMemoryVault } from "@harbour/vault/memory";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://model-gateway.internal";
const TOKEN_KEY = "conformance-model-session-token-key-0123456789";

/** The memory gateway behind its HTTP handler, called in-process: the fetch the subject hands pi-ai's client. */
function memorySubject(deps: ConformanceDeps, upstream: FakeModelUpstream): FakeModelGatewaySubject {
	const vault = createMemoryVault({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const connectors = createMemoryModelConnectors({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const tokens = createHmacSessionTokens({ key: TOKEN_KEY, clock: deps.clock, audit: deps.audit });
	const gateway = createModelGateway({
		connectors,
		credentials: vault,
		clock: deps.clock,
		audit: deps.audit,
		fetch: upstream.fetch,
		baseUrl: BASE_URL,
		access: deps.access,
	});
	const handler = createModelGatewayHttp({ gateway, tokens });
	return {
		fetch: async (input, init) => handler(new Request(input, init)),
		baseUrl: BASE_URL,
		mintToken: async (scope, ttlMs) => (await tokens.mint(systemContext("session-runtime"), scope, ttlMs)).token,
		connectors,
		upstream,
		credentials: vault,
	};
}

registerModelGatewayConformance({ describe, expect, it }, "in-memory model gateway", async (deps, use) => {
	await use(memorySubject(deps, createFakeModelUpstream()));
});

registerModelConnectorConformance(
	{ describe, expect, it },
	"model connectors against the fake upstream",
	async (deps, use) => {
		await use(memorySubject(deps, createFakeModelUpstream({ models: FAKE_CONNECTOR_MODELS })));
	},
	FAKE_CONNECTOR_TARGETS,
);
