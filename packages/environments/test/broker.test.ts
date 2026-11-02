import {
	type AuditEventInput,
	type CallContext,
	environmentSettings,
	KantelError,
	type ProjectAccess,
	type Role,
} from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { createBoatProvider } from "../src/boat.ts";
import { createEnvironmentBroker, type EnvironmentSession } from "../src/broker.ts";
import { createFakeBoat } from "../src/fake-boat.ts";
import { createFakeProvider } from "../src/fake-provider.ts";
import { createMemoryEnvironmentStore } from "../src/store.ts";

const ORG = "org_acme";
const PROJECT = "proj_dev";
const MINUTE = 60_000;
const ROLES: Record<string, Role> = { usr_tom: "admin", usr_bethan: "operator", usr_viewer: "viewer" };
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

const as = (userId: string): CallContext => ({ actor: { kind: "human", userId }, organisationId: ORG });

/** Each person's role on every project; agents and the system pass. */
const access = {
	async allows(ctx: CallContext, check: { needed: Role }) {
		if (ctx.actor.kind !== "human") return true;
		const role = ROLES[ctx.actor.userId];
		return role !== undefined && RANK[role] >= RANK[check.needed];
	},
	async require(ctx: CallContext, check: { needed: Role; operation: string }) {
		if (!(await access.allows(ctx, check))) throw new KantelError("forbidden", `Refused ${check.operation}`);
		return { scope: "project" };
	},
} as unknown as ProjectAccess;

function setup(options: { settings?: Record<string, string>; provider?: "fake" | "boat" } = {}) {
	let now = Date.UTC(2026, 10, 2, 9);
	const clock = { now: () => now };
	const audit: AuditEventInput[] = [];
	const fake = createFakeProvider({ now: clock.now });
	const boat = createFakeBoat({ now: clock.now });
	const boatProvider = createBoatProvider({ apiKey: "boat_test", fetch: boat.fetch, sleep: async () => undefined });
	const broker = createEnvironmentBroker({
		store: createMemoryEnvironmentStore(),
		providers: { fake, boat: boatProvider },
		defaultProvider: options.provider ?? "fake",
		settings: environmentSettings({ KANTEL_ENVIRONMENTS: "experimental", ...options.settings }),
		access: () => access,
		audit: { append: async (_ctx: unknown, events: readonly AuditEventInput[]) => void audit.push(...events) },
		clock,
		pollMs: 0,
		sleep: async () => undefined,
	});
	return {
		broker,
		fake,
		boat,
		audit,
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
	};
}

const tomSession = (id = "ses_tom1"): EnvironmentSession => ({
	sessionId: id,
	organisationId: ORG,
	projectId: PROJECT,
	userId: "usr_tom",
});

describe("the environment broker", () => {
	it("creates an environment owned by the caller in the project, which idles once its machine is up", async () => {
		const { broker } = setup();
		const env = await broker.create(as("usr_tom"), {
			projectId: PROJECT,
			name: "lleverage-dev",
			description: "Dev stack",
		});
		expect(env).toMatchObject({
			owner: { projectId: PROJECT, userId: "usr_tom" },
			alias: "dev",
			sharing: "shared",
			egress: "unmanaged",
			placeholders: true,
			idleTimeoutMs: 15 * MINUTE,
			state: "idle",
			leaseCount: 0,
		});
		expect(env.idleStopAt).toBeDefined();
		await expect(broker.create(as("usr_tom"), { projectId: PROJECT, name: "lleverage-dev" })).rejects.toThrow(
			/already/,
		);
		await expect(broker.create(as("usr_viewer"), { projectId: PROJECT, name: "other" })).rejects.toThrow(/Refused/);
	});

	it("follows the deployment's settings: exclusive sharing, placeholders off, the idle timeout", async () => {
		const { broker } = setup({
			settings: {
				KANTEL_ENVIRONMENTS_SHARING: "exclusive",
				KANTEL_ENVIRONMENTS_PLACEHOLDERS: "off",
				KANTEL_ENVIRONMENTS_IDLE_MINUTES: "30",
			},
		});
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "solo" });
		expect(env).toMatchObject({ sharing: "exclusive", placeholders: false, idleTimeoutMs: 30 * MINUTE });
	});

	it("grants a person's sessions their own environments by default, and nobody else's", async () => {
		const { broker } = setup();
		await broker.create(as("usr_tom"), { projectId: PROJECT, name: "tom-dev", description: "Tom's stack" });
		await broker.create(as("usr_bethan"), { projectId: PROJECT, name: "bethan-dev" });
		const shared = await broker.create(as("usr_tom"), {
			projectId: PROJECT,
			name: "shared-ci",
			alias: "ci",
			projectWide: true,
		});
		// Every member's sessions share it, so no one's connection placeholders work on it.
		expect(shared.placeholders).toBe(false);
		expect(await broker.aliases(tomSession())).toEqual([{ alias: "dev", description: "Tom's stack" }, { alias: "ci" }]);
		const bethan = { ...tomSession("ses_b"), userId: "usr_bethan" };
		expect((await broker.aliases(bethan)).map((entry) => entry.alias)).toEqual(["dev", "ci"]);
		const other = await broker.exec(bethan, "dev", { command: "echo mine" });
		expect(other.stdout).toBe("mine\n");
		await expect(broker.exec(tomSession(), "nope", { command: "true" })).rejects.toThrow(/It has: dev, ci/);
	});

	it("starts a stopped environment on first use, times the start, and runs in the session's worktree", async () => {
		const { broker, audit } = setup();
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "dev-stack" });
		await broker.stop(as("usr_tom"), env.id);
		expect((await broker.get(as("usr_tom"), env.id)).environment.state).toBe("stopped");

		const result = await broker.exec(tomSession(), "dev", { command: "pwd\nprintenv COMPOSE_PROJECT_NAME" });
		expect(result.stdout).toBe("/home/user/kantel/worktrees/ses_tom1\nkt_tom1\n");
		const detail = await broker.get(as("usr_tom"), env.id);
		expect(detail.environment.state).toBe("running");
		expect(detail.environment.resume).toMatchObject({ samples: 1 });
		expect(detail.leases).toHaveLength(1);
		expect(detail.leases[0]).toMatchObject({
			sessionId: "ses_tom1",
			composeProject: "kt_tom1",
			portBase: 20_000,
			commands: 1,
		});
		expect(detail.events.map((event) => event.kind)).toContain("lease.acquired");
		expect(audit.map((event) => event.type)).toEqual(
			expect.arrayContaining(["environments.environment.created", "environments.lease.acquired"]),
		);
		expect(audit.every((event) => event.data?.egress === "unmanaged")).toBe(true);
	});

	it("gives two sessions their own worktrees, Compose projects and ports on one machine", async () => {
		const { broker } = setup();
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "dev-stack" });
		await broker.exec(tomSession("ses_a"), "dev", { command: "true" });
		await broker.exec(tomSession("ses_b"), "dev", { command: "true" });
		await broker.exec(tomSession("ses_a"), "dev", { command: "true" });
		const { leases, environment } = await broker.get(as("usr_tom"), env.id);
		expect(environment.leaseCount).toBe(2);
		const byId = Object.fromEntries(leases.map((lease) => [lease.sessionId, lease]));
		expect(byId.ses_a).toMatchObject({ composeProject: "kt_a", portBase: 20_000, commands: 2 });
		expect(byId.ses_b).toMatchObject({ composeProject: "kt_b", portBase: 20_010, commands: 1 });
	});

	it("takes one session at a time on an exclusive environment", async () => {
		const { broker } = setup();
		await broker.create(as("usr_tom"), { projectId: PROJECT, name: "solo", sharing: "exclusive" });
		await broker.exec(tomSession("ses_a"), "dev", { command: "true" });
		await expect(broker.exec(tomSession("ses_b"), "dev", { command: "true" })).rejects.toThrow(/one at a time/);
		await broker.release("ses_a");
		expect((await broker.exec(tomSession("ses_b"), "dev", { command: "echo ok" })).stdout).toBe("ok\n");
	});

	it("idles when the last session lets go, and stops after the idle timeout", async () => {
		const { broker, advance, fake } = setup();
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "dev-stack" });
		await broker.exec(tomSession(), "dev", { command: "true" });
		await broker.release("ses_tom1");
		let detail = await broker.get(as("usr_tom"), env.id);
		expect(detail.environment.state).toBe("idle");
		advance(14 * MINUTE);
		await broker.sweep();
		expect((await broker.get(as("usr_tom"), env.id)).environment.state).toBe("idle");
		advance(2 * MINUTE);
		await broker.sweep();
		detail = await broker.get(as("usr_tom"), env.id);
		expect(detail.environment.state).toBe("stopped");
		expect(detail.events[0]).toMatchObject({ kind: "stopped", reason: "idle" });
		expect([...fake.machines.values()][0]?.status).toBe("stopped");
	});

	it("expires a lease a session stopped renewing, then idles", async () => {
		const { broker, advance } = setup();
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "dev-stack" });
		await broker.exec(tomSession(), "dev", { command: "true" });
		advance(11 * MINUTE);
		await broker.sweep();
		const detail = await broker.get(as("usr_tom"), env.id);
		expect(detail.leases).toEqual([]);
		expect(detail.environment.state).toBe("idle");
	});

	it("starts again a machine the provider stopped behind its back", async () => {
		const { broker, fake } = setup();
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "dev-stack" });
		await broker.exec(tomSession(), "dev", { command: "true" });
		fake.stopBehindTheBack([...fake.machines.keys()][0]!);
		expect((await broker.exec(tomSession(), "dev", { command: "echo again" })).stdout).toBe("again\n");
		expect((await broker.get(as("usr_tom"), env.id)).environment.resume?.samples).toBe(1);
	});

	it("records a failed start, and a later start works", async () => {
		const { broker, fake } = setup();
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "dev-stack" });
		await broker.stop(as("usr_tom"), env.id);
		fake.failNextStart("boat refused the start (rate_limited)");
		await expect(broker.start(as("usr_tom"), env.id)).rejects.toThrow(/rate_limited/);
		const failed = await broker.get(as("usr_tom"), env.id);
		expect(failed.environment).toMatchObject({ state: "error", error: "boat refused the start (rate_limited)" });
		expect((await broker.start(as("usr_tom"), env.id)).state).toBe("idle");
	});

	it("keeps a viewer to reading, and another organisation out", async () => {
		const { broker } = setup();
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "dev-stack" });
		expect((await broker.list(as("usr_viewer"))).map((entry) => entry.name)).toEqual(["dev-stack"]);
		await expect(broker.stop(as("usr_viewer"), env.id)).rejects.toThrow(/Refused/);
		await expect(broker.get({ ...as("usr_tom"), organisationId: "org_other" }, env.id)).rejects.toThrow(
			/No environment/,
		);
		await expect(broker.destroy(as("usr_bethan"), env.id)).rejects.toThrow(/Refused/);
	});

	it("ends leases and grants when it is destroyed, and the machine goes", async () => {
		const { broker, fake } = setup();
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "dev-stack" });
		await broker.exec(tomSession(), "dev", { command: "true" });
		const gone = await broker.destroy(as("usr_tom"), env.id);
		expect(gone.state).toBe("destroyed");
		expect([...fake.machines.values()][0]?.status).toBe("gone");
		expect(await broker.aliases(tomSession())).toEqual([]);
		expect(await broker.list(as("usr_tom"))).toEqual([]);
	});

	it("drives a boat sandbox end to end through the fake API, measuring the resume", async () => {
		const { broker, boat, advance } = setup({ provider: "boat" });
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "boat-dev" });
		expect(env.provider).toBe("boat");
		const sandbox = [...boat.sandboxes.values()][0]!;
		expect(sandbox.noEnv).toBe(true);
		expect(sandbox.labels["kantel.environment"]).toBe(env.id);
		await broker.stop(as("usr_tom"), env.id);
		advance(MINUTE);
		await broker.sweep();
		expect((await broker.get(as("usr_tom"), env.id)).environment.state).toBe("stopped");
		const result = await broker.exec(tomSession(), "dev", { command: "printenv KANTEL_EGRESS" });
		expect(result.stdout).toBe("unmanaged\n");
		expect((await broker.get(as("usr_tom"), env.id)).environment.resume?.samples).toBe(1);
		await broker.destroy(as("usr_tom"), env.id);
		expect(sandbox.deleted).toBe(true);
	});

	it("refuses a machine that holds the provider account's logins", async () => {
		const { broker, boat } = setup({ provider: "boat" });
		const env = await broker.create(as("usr_tom"), { projectId: PROJECT, name: "boat-dev" });
		const sandbox = [...boat.sandboxes.values()][0]!;
		(sandbox as { noEnv: boolean }).noEnv = false;
		await broker.report({ ref: { provider: "boat", machineId: sandbox.id }, status: "running", at: Date.now() });
		const detail = await broker.get(as("usr_tom"), env.id);
		expect(detail.environment.state).toBe("error");
		expect(detail.environment.error).toMatch(/logins/);
		// A start resumes it with noEnv, which scrubs the logins, and it is usable again.
		expect((await broker.exec(tomSession(), "dev", { command: "echo clean" })).stdout).toBe("clean\n");
		expect(sandbox.noEnv).toBe(true);
	});
});
