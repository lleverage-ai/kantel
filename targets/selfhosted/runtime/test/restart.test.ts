// A restart mid model call and mid host tool call: a runtime that stops while its call is in flight, and a later one
// over the same schema that resumes the run on its own at start, as `packages/runtime/test/restart.test.ts` does on
// SQLite. The host tool is a durable registration, called back signed by whichever process runs the session.
import { PGlite } from "@electric-sql/pglite";
import type { AgentProfile, HostToolCall, HostToolResult, ReplayPolicy } from "@kantel/contracts";
import { createHostToolEndpoint } from "@kantel/runtime/http";
import { createScriptedModel } from "@kantel/runtime/testing";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createSelfhostedSessionRuntime, openPostgresSessionDatabase } from "../src/index.ts";
import { caseSchema, type PostgresTarget } from "./support.ts";

const ORG = "org-restart";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [{ name: "role", text: "You help." }],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const pglite = new PGlite();
const url = process.env.KANTEL_TEST_DATABASE_URL;
const pool = url === undefined || url === "" ? undefined : new pg.Pool({ connectionString: url, max: 4 });
afterAll(async () => {
	await pool?.end();
	await pglite.close();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

type Script = ReturnType<typeof createScriptedModel>["script"];

/**
 * One "process": its own connection (where the target has more than one), runtime and model. `beforeStart` scripts
 * the model before the runtime starts, since starting resumes whatever is due.
 */
async function processOn(
	target: PostgresTarget,
	schema: string,
	beforeStart?: (script: Script) => void,
	hostFetch?: typeof fetch,
) {
	const database = await target.open(schema);
	const { models, script } = createScriptedModel();
	beforeStart?.(script);
	const service = await createSelfhostedSessionRuntime({
		database,
		models,
		...(hostFetch === undefined ? {} : { hostCallbacks: { fetch: hostFetch } }),
	});
	return {
		service,
		script,
		async stop() {
			await service.close();
			await database.close();
		},
	};
}

const targets: { readonly name: string; readonly target?: PostgresTarget }[] = [
	{
		name: "PGlite",
		target: {
			open: (schema) => openPostgresSessionDatabase({ connection: pglite, schema }),
			drop: async (schema) => {
				await pglite.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			},
		},
	},
	{
		name: "pg",
		...(pool === undefined
			? {}
			: {
					target: {
						open: (schema: string) => openPostgresSessionDatabase({ pool, schema }),
						drop: async (schema: string) => {
							await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
						},
					},
				}),
	},
];

for (const { name, target } of targets) {
	describe.skipIf(target === undefined)(`a restart mid model call (${name})`, () => {
		it("carries the run on in a second runtime over the same schema, which resumes it at start", async () => {
			const on = target!;
			const schema = caseSchema();
			cleanups.push(() => on.drop(schema));

			// The first process's model call never answers; it fails only once the second has stopped, so the dead
			// process's Harness can close.
			let fail: (error: Error) => void = () => {};
			const hung = new Promise<never>((_resolve, reject) => {
				fail = reject;
			});
			hung.catch(() => undefined);
			const first = await processOn(on, schema);
			cleanups.unshift(async () => {
				fail(new Error("the process is gone"));
				await first.stop();
			});
			await first.service.profiles.put(ctx, profile);
			const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			first.script.reply(() => hung);
			const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Hello" });
			await until(() => first.script.requests.length === 1, "the first model call");
			await until(
				async () => (await first.service.directory.get(ctx, session.id)).status === "running",
				"the session to show running",
			);

			// The new process asks the model on its own while it starts, before anyone waits on the session.
			const second = await processOn(on, schema, (script) => script.reply({ text: "Answered after the restart" }));
			cleanups.unshift(() => second.stop());
			await until(() => second.script.requests.length === 1, "the resumed model call");
			expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({
				status: "answered",
				answer: "Answered after the restart",
			});
			expect(second.script.requests[0]?.messages.at(-1)).toMatchObject({ role: "user", text: "Hello" });
			expect((await second.service.directory.get(ctx, session.id)).status).toBe("idle");
		});
	});

	describe.skipIf(target === undefined)(`a restart mid host tool call (${name})`, () => {
		const SECRET = "a-callback-secret-of-at-least-32-characters";
		const lookup = (replay: ReplayPolicy) => ({
			name: "lookup",
			description: "Looks up",
			inputSchema: { type: "object" },
			replay,
		});
		const withTool: AgentProfile = { ...profile, tools: ["lookup"], hostId: "atlas" };

		/** The host's side of the callback, checking Kantel's signature, as each process reaches it. */
		const hostAt =
			(handler: (call: HostToolCall) => Promise<HostToolResult>): typeof fetch =>
			async (input, init) =>
				createHostToolEndpoint(handler, { secret: SECRET })(new Request(input, init));

		/**
		 * The first process: registers the host durably, prompts, and its call to the host never comes back. Its process
		 * "dies" there: the call fails only at cleanup, once the second process has stopped.
		 */
		async function cutOffMidToolCall(on: PostgresTarget, schema: string, replay: ReplayPolicy) {
			const reached: string[] = [];
			let fail: (error: Error) => void = () => {};
			const hung = new Promise<never>((_resolve, reject) => {
				fail = reject;
			});
			hung.catch(() => undefined);
			const first = await processOn(
				on,
				schema,
				undefined,
				hostAt(async (call) => {
					reached.push(`first:${call.callId}`);
					return hung;
				}),
			);
			cleanups.unshift(async () => {
				fail(new Error("the process is gone"));
				await first.stop();
			});
			await first.service.profiles.put(ctx, withTool);
			await first.service.hosts.register(
				ctx,
				"atlas",
				[lookup(replay)],
				{ url: "https://atlas.test/hosts/atlas", secret: SECRET },
				"owner",
			);
			const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			first.script.reply({ toolCalls: [{ name: "lookup", args: { key: "plan" } }] });
			const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Find the plan" });
			await until(() => reached.length === 1, "the first host call");
			return { session, prompt, reached };
		}

		it("reruns a replay-safe host tool with the same call ID from the next process, which nobody re-registered", async () => {
			const on = target!;
			const schema = caseSchema();
			cleanups.push(() => on.drop(schema));
			const { session, prompt, reached } = await cutOffMidToolCall(on, schema, "safe");

			const second = await processOn(
				on,
				schema,
				(script) => script.reply({ text: "Found it" }),
				hostAt(async (call) => {
					reached.push(`second:${call.callId}`);
					return { output: "the plan" };
				}),
			);
			cleanups.unshift(() => second.stop());
			expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({
				status: "answered",
				answer: "Found it",
			});
			const [firstCall, secondCall] = reached.map((entry) => entry.split(":")[1]);
			expect(reached.map((entry) => entry.split(":")[0])).toEqual(["first", "second"]);
			expect(secondCall).toBe(firstCall);
			expect(second.script.requests[0]?.messages.at(-1)).toMatchObject({ role: "tool", text: "the plan" });
			expect((await second.service.directory.get(ctx, session.id)).status).toBe("idle");
		});

		it("does not rerun a host tool that is not replay-safe; the model hears it was interrupted", async () => {
			const on = target!;
			const schema = caseSchema();
			cleanups.push(() => on.drop(schema));
			const { session, prompt, reached } = await cutOffMidToolCall(on, schema, "unsafe");

			const second = await processOn(
				on,
				schema,
				(script) => script.reply({ text: "It was interrupted; I will not retry" }),
				hostAt(async (call) => {
					reached.push(`second:${call.callId}`);
					return { output: "charged again" };
				}),
			);
			cleanups.unshift(() => second.stop());
			expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ status: "answered" });
			expect(reached).toHaveLength(1);
			const toolResult = second.script.requests[0]?.messages.find((message) => message.role === "tool");
			expect(toolResult?.text).toMatch(/interrupt/i);
		});
	});
}
