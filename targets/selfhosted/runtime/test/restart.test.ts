// A restart mid model call: a runtime that stops while its model call is in flight, and a later one over the same
// schema that resumes the run on its own at start, as `packages/runtime/test/restart.test.ts` does on SQLite.
import { PGlite } from "@electric-sql/pglite";
import type { AgentProfile } from "@harbour/contracts";
import { createScriptedModel } from "@harbour/runtime/testing";
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
const url = process.env.HARBOUR_TEST_DATABASE_URL;
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
async function processOn(target: PostgresTarget, schema: string, beforeStart?: (script: Script) => void) {
	const database = await target.open(schema);
	const { models, script } = createScriptedModel();
	beforeStart?.(script);
	const service = await createSelfhostedSessionRuntime({ database, models });
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
}
