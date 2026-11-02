// Environments (sandbox tier 3) on the self-hosted gateway, end to end through its fetch handler: off without
// KANTEL_ENVIRONMENTS=experimental; with it, an environment created over the API, a session's `bash` with `env`
// running on it in its own worktree (through the fake provider, then a fake boat.dev API), the session's end letting
// go of it, and boat's signed webhook taken without a sign-in.
import { type CallContext, type Environment, type EnvironmentDetail, systemContext } from "@kantel/contracts";
import { createFakeBoat } from "@kantel/environments/fake-boat";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";
import { environmentsConfig } from "../../src/gateway/environments.ts";
import { createGateway } from "../../src/gateway/gateway.ts";

const SECRET = `whsec_${"ef".repeat(32)}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function serve(vars: NodeJS.ProcessEnv, boat?: ReturnType<typeof createFakeBoat>) {
	const { models, script } = createScriptedModel();
	const config = environmentsConfig(vars);
	const components: GatewayComponents = createGatewayComponents({
		models: { models },
		...(config === undefined ? {} : { environments: config }),
		...(boat === undefined ? {} : { boatFetch: boat.fetch }),
	});
	cleanups.push(() => components.close());
	const seeded = await bootstrap(components, { organisation: "Envs", project: "envs" });
	const gateway = createGateway({ components });
	cleanups.push(() => gateway.close());
	const call = async (method: string, path: string, body?: unknown, headers?: Headers | Record<string, string>) => {
		const response = await gateway.fetch(
			new Request(`http://gateway.test${path}`, {
				method,
				headers: headers ?? {
					authorization: `Bearer ${seeded.apiKey}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
	};
	const key = await components.identity.authenticateApiKey(
		{ ...systemContext("environments-test"), organisationId: seeded.organisationId },
		seeded.apiKey,
	);
	const operator: CallContext = {
		actor: key.actor,
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	// A project admin's key: destroying an environment is admin on its project.
	const system: CallContext = { ...systemContext("environments-test"), organisationId: seeded.organisationId };
	const service = await components.identity.createServiceIdentity(system, { name: "env-admin" });
	const admin = await components.identity.issueApiKey(system, {
		serviceId: service.id,
		projectIds: [seeded.projectId],
		role: "admin",
	});
	const asAdmin = (method: string, path: string) =>
		call(method, path, undefined, { authorization: `Bearer ${admin.secret}` });
	const { runtime } = components.runtime;
	const run = async (sessionId: string, text: string) => {
		const prompt = await runtime.prompt(operator, sessionId, { text });
		return runtime.wait(operator, sessionId, prompt.id);
	};
	const toolResults = () =>
		script.requests
			.at(-1)
			?.messages.filter((message) => message.role === "tool")
			.map((message) => message.text) ?? [];
	return { components, seeded, script, call, asAdmin, operator, runtime, run, toolResults };
}

describe("environments on the self-hosted gateway", () => {
	it("are on only with KANTEL_ENVIRONMENTS=experimental, and boat needs a key", () => {
		expect(environmentsConfig({})).toBeUndefined();
		expect(environmentsConfig({ KANTEL_ENVIRONMENTS: "on" })).toBeUndefined();
		expect(environmentsConfig({ KANTEL_ENVIRONMENTS: "experimental" })).toMatchObject({ provider: "fake" });
		expect(environmentsConfig({ KANTEL_ENVIRONMENTS: "experimental", KANTEL_BOAT_API_KEY: "boat_x" })).toMatchObject({
			provider: "boat",
		});
		expect(() =>
			environmentsConfig({ KANTEL_ENVIRONMENTS: "experimental", KANTEL_ENVIRONMENTS_PROVIDER: "boat" }),
		).toThrow(/KANTEL_BOAT_API_KEY/);
		// boat's own auto-stop backstop: two hours for an account still on boat's trial.
		const on = { KANTEL_ENVIRONMENTS: "experimental", KANTEL_BOAT_API_KEY: "boat_x" };
		expect(environmentsConfig({ ...on, KANTEL_BOAT_AUTO_STOP_MINUTES: "120" })).toMatchObject({
			boatAutoStopSeconds: 7200,
		});
		expect(() => environmentsConfig({ ...on, KANTEL_BOAT_AUTO_STOP_MINUTES: "5" })).toThrow(/at least 30/);
	});

	it("have no routes, no binding and no env when off", async () => {
		const { components, call, seeded, script, runtime, operator, run } = await serve({});
		expect(components.environments).toBeUndefined();
		expect(components.bindings.environments).toBeUndefined();
		expect((await call("GET", "/v1/environments")).status).toBe(404);
		expect((await call("POST", "/v1/environment-webhooks/boat", "{}")).status).toBe(404);
		const session = await runtime.create(operator, {
			projectId: seeded.projectId,
			agentId: "echo",
			workspaceId: seeded.workspaceId,
		});
		script.reply({ text: "ok" });
		await run(session.id, "Hi");
		const bash = script.requests[0]?.tools?.find((tool) => tool.name === "bash");
		expect(JSON.stringify(bash?.parameters)).not.toContain('"env"');
	});

	it("run a session's bash on its environment in its own worktree, and let go when it ends", async () => {
		const { components, seeded, script, call, asAdmin, runtime, operator, run, toolResults } = await serve({
			KANTEL_ENVIRONMENTS: "experimental",
		});
		expect(components.bindings.environments).toBe("memory, fake (experimental)");
		const created = await call("POST", "/v1/environments", {
			projectId: seeded.projectId,
			name: "lleverage-dev",
			description: "Dev stack",
			projectWide: true,
		});
		expect(created.status).toBe(201);
		const env = created.body as Environment;
		expect(env).toMatchObject({ alias: "dev", provider: "fake", egress: "unmanaged" });

		const session = await runtime.create(operator, {
			projectId: seeded.projectId,
			agentId: "echo",
			workspaceId: seeded.workspaceId,
		});
		script.reply(
			{ toolCalls: [{ name: "bash", args: { command: "pwd && printenv COMPOSE_PROJECT_NAME", env: "dev" } }] },
			{ text: "Done" },
		);
		expect(await run(session.id, "Where am I?")).toMatchObject({ status: "answered", answer: "Done" });
		const bash = script.requests[0]?.tools?.find((tool) => tool.name === "bash");
		expect(bash?.description).toContain("Your environments: dev (Dev stack).");
		expect(JSON.stringify(bash?.parameters)).toContain('"env"');
		expect(toolResults().join("\n")).toContain(`/home/user/kantel/worktrees/${session.id}`);

		const held = (await call("GET", `/v1/environments/${env.id}`)).body as EnvironmentDetail;
		expect(held.environment.state).toBe("running");
		expect(held.leases.filter((lease) => lease.endedAt === undefined)).toHaveLength(1);

		await runtime.close(operator, session.id);
		const after = (await call("GET", `/v1/environments/${env.id}`)).body as EnvironmentDetail;
		expect(after.environment.state).toBe("idle");
		expect(after.leases.every((lease) => lease.endedAt !== undefined)).toBe(true);
		expect((await call("DELETE", `/v1/environments/${env.id}`)).status).toBe(403);
		expect((await asAdmin("DELETE", `/v1/environments/${env.id}`)).status).toBe(200);
		const audited = await components.audit.query(operator, { source: "environments" });
		expect(audited.items.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"environments.environment.created",
				"environments.lease.acquired",
				"environments.lease.ended",
				"environments.environment.destroyed",
			]),
		);
	});

	it("drive a boat sandbox, and take boat's signed webhook without a sign-in", async () => {
		const boat = createFakeBoat();
		const { components, seeded, call, asAdmin } = await serve(
			{ KANTEL_ENVIRONMENTS: "experimental", KANTEL_BOAT_API_KEY: "boat_test", KANTEL_BOAT_WEBHOOK_SECRET: SECRET },
			boat,
		);
		expect(components.bindings.environments).toBe("memory, boat (experimental)");
		const env = (await call("POST", "/v1/environments", { projectId: seeded.projectId, name: "boat-dev" }))
			.body as Environment;
		expect(env.provider).toBe("boat");
		const sandbox = [...boat.sandboxes.values()][0];
		expect(sandbox?.noEnv).toBe(true);

		// boat's own auto-stop archives it, and says so: the webhook makes the broker read it.
		boat.set(sandbox?.id ?? "", "archived");
		const delivery = await boat.webhook(SECRET, "sandbox.archived", sandbox?.id ?? "");
		const hook = await call("POST", "/v1/environment-webhooks/boat", delivery.body, delivery.headers);
		expect(hook.status).toBe(204);
		expect((await call("POST", "/v1/environment-webhooks/boat", delivery.body, {})).status).toBe(401);
		const detail = (await call("GET", `/v1/environments/${env.id}`)).body as EnvironmentDetail;
		expect(detail.environment.state).toBe("stopped");
		expect((await asAdmin("DELETE", `/v1/environments/${env.id}`)).status).toBe(200);
		expect(sandbox?.deleted).toBe(true);
	});
});
