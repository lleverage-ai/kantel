// The default profile's tools on the self-hosted gateway beyond the coding, browser and connection tools, as on
// Cloudflare (session-tools.ts): `codemode`, `save_program` with the programs API, `present_files`, `create_document`
// and `generate_image`, each used by a session; the switches that take them away; and the programs' tables on
// Postgres (PGlite here, not node:sqlite, which Bun, running these files in CI's self-hosted job, does not have).
import { type CallContext, type ModelGatewayModel, systemContext } from "@kantel/contracts";
import { createSqlProgramStore, migratePrograms } from "@kantel/programs/store";
import { SAVE_PROGRAM_TOOL } from "@kantel/programs/tool";
import { createScriptedModel } from "@kantel/runtime/testing";
import { CODEMODE_TOOL } from "@kantel/sandbox/codemode";
import { CODING_TOOLS } from "@kantel/sandbox/coding-tools";
import { CREATE_DOCUMENT_TOOL } from "@kantel/sandbox/documents";
import { PRESENT_FILES_TOOL } from "@kantel/sandbox/present-files";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { ALL_SESSION_TOOLS, type SessionToolsConfig, sessionToolsConfig } from "../../src/gateway/session-tools.ts";

const opened: GatewayComponents[] = [];
afterEach(async () => {
	for (const components of opened.splice(0)) await components.close();
});

const IMAGE_MODEL: ModelGatewayModel = {
	id: "images",
	name: "Images",
	reasoning: false,
	input: ["text"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
};

async function setUp(sessionTools?: SessionToolsConfig) {
	const { models, script } = createScriptedModel();
	const provider = models.getProviders()[0];
	const chat = provider === undefined ? undefined : models.getModels(provider.id)[0];
	if (provider === undefined || chat === undefined) throw new Error("the scripted model has no model");
	const components = createGatewayComponents({
		models: {
			models,
			// The `images` route goes to the fake image model below; every other to the scripted chat model.
			resolveModel: (choice) =>
				choice.route === "images"
					? { provider: "fake-images", modelId: IMAGE_MODEL.id }
					: { provider: provider.id, modelId: chat.id },
			images: () => ({
				models: async () => [IMAGE_MODEL],
				generate: async () => ({ images: [] }) as never,
			}),
		},
		...(sessionTools === undefined ? {} : { sessionTools }),
	});
	opened.push(components);
	const seeded = await bootstrap(components, { organisation: "Tools", project: "tools" });
	const key = await components.identity.authenticateApiKey(
		{ ...systemContext("session-tools-test"), organisationId: seeded.organisationId },
		seeded.apiKey,
	);
	const operator: CallContext = {
		actor: key.actor,
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	const { runtime } = components.runtime;
	/** A session of the bootstrap's echo profile, started as the console starts one: with no workspace. */
	const session = () => runtime.create(operator, { projectId: seeded.projectId, agentId: "echo" });
	const run = async (sessionId: string, text: string) => {
		const prompt = await runtime.prompt(operator, sessionId, { text });
		return runtime.wait(operator, sessionId, prompt.id);
	};
	const offered = () => script.requests.at(-1)?.tools?.map((tool) => tool.name) ?? [];
	const toolResults = () =>
		script.requests
			.at(-1)
			?.messages.filter((message) => message.role === "tool")
			.map((message) => message.text) ?? [];
	return { components, seeded, operator, script, session, run, offered, toolResults };
}

describe("the default profile's tools on the self-hosted gateway", () => {
	it("are those of Cloudflare's default profile, and a console session is offered them", async () => {
		const { components, operator, script, session, run, offered } = await setUp();
		const profile = await components.runtime.profiles.get(operator, "echo");
		expect(profile.tools).toEqual([
			...CODING_TOOLS,
			PRESENT_FILES_TOOL,
			CREATE_DOCUMENT_TOOL,
			CODEMODE_TOOL,
			SAVE_PROGRAM_TOOL,
		]);
		expect(components.bindings).toMatchObject({
			codemode: "QuickJS on a worker thread per script",
			programs: "memory, with pauses",
			presentFiles: "on",
		});
		const created = await session();
		script.reply({ text: "Hello" });
		await run(created.id, "Hi");
		expect(offered()).toEqual(expect.arrayContaining([...CODING_TOOLS, ...components.sessionTools]));
	});

	it("codemode runs a script that calls the session's other tools and computes", async () => {
		const { script, session, run, toolResults } = await setUp();
		const created = await session();
		const code = [
			'await tools.write({ path: "numbers.txt", content: "1 2 3.5 4" });',
			'const text = await tools.read({ path: "numbers.txt" });',
			"const total = text.trim().split(' ').map(Number).reduce((sum, n) => sum + n, 0);",
			"return { total };",
		].join("\n");
		script.reply({ toolCalls: [{ name: CODEMODE_TOOL, args: { code } }] }, { text: "Computed" });
		expect(await run(created.id, "Add them up")).toMatchObject({ status: "answered", answer: "Computed" });
		expect(toolResults()[0]).toContain('{"total":10.5}');
	});

	it("present_files and create_document show a session's files as cards", async () => {
		const { script, session, run, toolResults } = await setUp();
		const created = await session();
		script.reply(
			{ toolCalls: [{ name: "write", args: { path: "report.md", content: "# Report\n" } }] },
			{ toolCalls: [{ name: PRESENT_FILES_TOOL, args: { filepaths: ["report.md"] } }] },
			{ toolCalls: [{ name: CREATE_DOCUMENT_TOOL, args: { title: "Plan", content: "# Plan\n\nShip it.\n" } }] },
			{ text: "Shown" },
		);
		expect(await run(created.id, "Show me")).toMatchObject({ status: "answered", answer: "Shown" });
		const [, presented, document] = toolResults();
		expect(presented).toMatch(/report\.md/);
		expect(document).toMatch(/documents\/plan/);
	});

	it("save_program saves a program the API then runs with no model, and pauses resume", async () => {
		const { components, seeded, operator, script, session, run, toolResults } = await setUp();
		const created = await session();
		const code = [
			'await tools.write({ path: "sum.txt", content: String(input.a + input.b) });',
			'return { sum: Number((await tools.read({ path: "sum.txt" })).trim()) };',
		].join("\n");
		script.reply(
			{ toolCalls: [{ name: SAVE_PROGRAM_TOOL, args: { name: "sum", code, tools: ["read", "write"] } }] },
			{ text: "Saved" },
		);
		await run(created.id, "Save a program");
		expect(toolResults()[0]).toMatch(/Saved program sum \(prog_[0-9a-f]+\) version 1, with tools: read, write/);

		// Through the gateway's `/v1/programs`, with the bootstrap's operator key.
		const gateway = createGateway({ components });
		const call = (path: string, body?: unknown) =>
			gateway.fetch(
				new Request(`http://gateway.test/v1${path}`, {
					method: body === undefined ? "GET" : "POST",
					headers: { authorization: `Bearer ${seeded.apiKey}`, "content-type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
		const listed = (await (await call(`/programs?projectId=${seeded.projectId}`)).json()) as {
			items: { id: string; name: string }[];
		};
		const program = listed.items.find((each) => each.name === "sum");
		if (program === undefined) throw new Error("not saved");
		const modelCalls = script.requests.length;
		const ran = await call(`/programs/${program.id}/runs`, { input: { a: 2, b: 3.5 } });
		expect(ran.status).toBe(200);
		expect(await ran.json()).toMatchObject({ status: "succeeded", output: { sum: 5.5 } });
		expect(script.requests.length).toBe(modelCalls);

		// A program that waits for a person's input, resumed with it.
		const programs = components.programs;
		if (programs === undefined) throw new Error("no programs");
		const asks = await programs.create(operator, {
			projectId: seeded.projectId,
			name: "ask",
			code: "const answer = await waitForInput('Ship it?'); return { answer };",
			tools: [],
		});
		let waiting = await programs.run(operator, asks.id, { input: null });
		for (let tries = 0; tries < 400 && waiting.status === "running"; tries += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			waiting = await programs.getRun(operator, asks.id, waiting.id);
		}
		expect(waiting.status).toBe("waiting");
		const resumed = await programs.resume(operator, asks.id, waiting.id, { value: "yes", waitMs: 5_000 });
		let ended = resumed;
		for (let tries = 0; tries < 400 && ended.status === "running"; tries += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			ended = await programs.getRun(operator, asks.id, ended.id);
		}
		expect(ended).toMatchObject({ status: "succeeded", output: { answer: "yes" } });
		await gateway.close();
	});

	it("generate_image is offered to a profile with an image model, as on Cloudflare, kept across starts", async () => {
		const { components, seeded, operator, script, session, run, offered } = await setUp();
		const echo = await components.runtime.profiles.get(operator, "echo");
		await components.runtime.profiles.put(operator, {
			...echo,
			imageModel: { route: "images" },
			memoryScopes: ["notes"],
		});
		// The next start keeps what the user chose.
		await bootstrap(components, { organisation: "Tools", project: "tools" }, seeded);
		expect(await components.runtime.profiles.get(operator, "echo")).toMatchObject({
			imageModel: { route: "images" },
			memoryScopes: ["notes"],
		});
		// (No such memory space: recall would refuse it.)
		await components.runtime.profiles.put(operator, {
			...(await components.runtime.profiles.get(operator, "echo")),
			memoryScopes: [],
		});
		const created = await session();
		script.reply({ text: "Hello" });
		await run(created.id, "Hi");
		expect(offered()).toContain("generate_image");
	});

	it("are taken away by their switches", async () => {
		expect(sessionToolsConfig({})).toEqual(ALL_SESSION_TOOLS);
		expect(sessionToolsConfig({ KANTEL_CODEMODE: "off" })).toEqual({
			presentFiles: true,
			codemode: false,
			programs: false,
			programWaits: false,
		});
		expect(sessionToolsConfig({ KANTEL_PROGRAM_WAITS: "off", KANTEL_PRESENT_FILES: "OFF" })).toEqual({
			presentFiles: false,
			codemode: true,
			programs: true,
			programWaits: false,
		});
		const { components, operator, seeded } = await setUp({
			presentFiles: false,
			codemode: false,
			programs: false,
			programWaits: false,
		});
		expect((await components.runtime.profiles.get(operator, "echo")).tools).toEqual([...CODING_TOOLS]);
		expect(components.programs).toBeUndefined();
		const gateway = createGateway({ components });
		const listed = await gateway.fetch(
			new Request(`http://gateway.test/v1/programs?projectId=${seeded.projectId}`, {
				headers: { authorization: `Bearer ${seeded.apiKey}` },
			}),
		);
		expect(listed.status).toBe(404);
		await gateway.close();
	});
});

describe("the programs' tables on Postgres", () => {
	it("migrate twice and keep a program", async () => {
		const database = await pgliteDatabase.open();
		try {
			await migratePrograms(database.driver);
			await migratePrograms(database.driver);
			const store = createSqlProgramStore(database.driver);
			const program = {
				id: "prog_1",
				organisationId: "org-a",
				projectId: "proj-a",
				name: "sum",
				versions: [1],
				nextVersion: 2,
				createdAt: 1,
				updatedAt: 1,
				createdBy: { kind: "system" as const, component: "test" },
			};
			await store.putProgram(program);
			expect(await store.programByName("org-a", "proj-a", "sum")).toEqual(program);
		} finally {
			await database.close();
		}
	});
});
