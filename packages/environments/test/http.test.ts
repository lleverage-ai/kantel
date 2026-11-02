import { type CallContext, environmentSettings, KantelError, type ProjectAccess } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { createEnvironmentBroker } from "../src/broker.ts";
import { createFakeBoat } from "../src/fake-boat.ts";
import { createFakeProvider } from "../src/fake-provider.ts";
import { createEnvironmentsApi } from "../src/http.ts";
import { createMemoryEnvironmentStore } from "../src/store.ts";

const SECRET = `whsec_${"cd".repeat(32)}`;
const tom: CallContext = { actor: { kind: "human", userId: "usr_tom" }, organisationId: "org_acme" };
const access = {
	allows: async () => true,
	require: async () => ({}),
} as unknown as ProjectAccess;

function api() {
	const fake = createFakeProvider();
	const broker = createEnvironmentBroker({
		store: createMemoryEnvironmentStore(),
		providers: { fake },
		defaultProvider: "fake",
		settings: environmentSettings({ KANTEL_ENVIRONMENTS: "experimental" }),
		access: () => access,
		pollMs: 0,
		sleep: async () => undefined,
	});
	const environments = createEnvironmentsApi({
		broker,
		authenticate: async (request) => {
			if (request.headers.get("authorization") !== "Bearer tom") throw new KantelError("forbidden", "Sign in");
			return tom;
		},
		boatWebhookSecret: SECRET,
	});
	const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
		environments.fetch(
			new Request(`https://kantel.test${path}`, {
				method,
				headers: {
					authorization: "Bearer tom",
					...(body === undefined ? {} : { "content-type": "application/json" }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	return { call, environments, broker };
}

describe("the environments API", () => {
	it("creates, lists, reads, stops, starts and destroys an environment", async () => {
		const { call } = api();
		const created = await call("POST", "/v1/environments", { projectId: "proj_dev", name: "lleverage-dev" });
		expect(created?.status).toBe(201);
		const env = (await created!.json()) as { id: string; state: string };
		expect(env.state).toBe("idle");
		const list = (await (await call("GET", "/v1/environments?projectId=proj_dev"))!.json()) as { items: unknown[] };
		expect(list.items).toHaveLength(1);
		const detail = (await (await call("GET", `/v1/environments/${env.id}`))!.json()) as { events: unknown[] };
		expect(detail.events.length).toBeGreaterThan(0);
		expect(((await (await call("POST", `/v1/environments/${env.id}/stop`))!.json()) as { state: string }).state).toBe(
			"stopped",
		);
		expect((await call("POST", `/v1/environments/${env.id}/start`))?.status).toBe(200);
		expect((await call("DELETE", `/v1/environments/${env.id}`))?.status).toBe(200);
		// Its history stays readable; the list leaves it out.
		const gone = (await (await call("GET", `/v1/environments/${env.id}`))!.json()) as {
			environment: { state: string };
		};
		expect(gone.environment.state).toBe("destroyed");
		expect(((await (await call("GET", "/v1/environments"))!.json()) as { items: unknown[] }).items).toEqual([]);
	});

	it("refuses an unsigned caller and a malformed body, and leaves other paths alone", async () => {
		const { call } = api();
		expect((await call("GET", "/v1/environments", undefined, { authorization: "Bearer nobody" }))?.status).toBe(403);
		expect((await call("POST", "/v1/environments", { name: "x" }))?.status).toBe(400);
		expect(await call("GET", "/v1/sessions")).toBeUndefined();
	});

	it("takes a signed boat webhook and refuses an unsigned one", async () => {
		const { environments } = api();
		const boat = createFakeBoat();
		const delivery = await boat.webhook(SECRET, "sandbox.archived", "bx_unknown1");
		const signed = await environments.fetch(
			new Request("https://kantel.test/v1/environment-webhooks/boat", {
				method: "POST",
				headers: delivery.headers,
				body: delivery.body,
			}),
		);
		expect(signed?.status).toBe(204);
		const unsigned = await environments.fetch(
			new Request("https://kantel.test/v1/environment-webhooks/boat", { method: "POST", body: delivery.body }),
		);
		expect(unsigned?.status).toBe(401);
	});
});
