// The default profile's tools on the self-hosted gateway beyond the coding, browser and connection tools, as on
// Cloudflare (session-tools.ts): `present_files`, `create_document` and `generate_image`, each used by a session, and
// the switch that takes the first two away.
import { type CallContext, type ModelGatewayModel, systemContext } from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import { CODING_TOOLS } from "@kantel/sandbox/coding-tools";
import { CREATE_DOCUMENT_TOOL } from "@kantel/sandbox/documents";
import { PRESENT_FILES_TOOL } from "@kantel/sandbox/present-files";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";
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
		expect(profile.tools).toEqual([...CODING_TOOLS, PRESENT_FILES_TOOL, CREATE_DOCUMENT_TOOL]);
		expect(components.bindings).toMatchObject({ presentFiles: "on" });
		const created = await session();
		script.reply({ text: "Hello" });
		await run(created.id, "Hi");
		expect(offered()).toEqual(expect.arrayContaining([...CODING_TOOLS, ...components.sessionTools]));
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
		expect(sessionToolsConfig({ KANTEL_PRESENT_FILES: "OFF" })).toEqual({ presentFiles: false });
		const { components, operator } = await setUp({ presentFiles: false });
		expect((await components.runtime.profiles.get(operator, "echo")).tools).toEqual([...CODING_TOOLS]);
	});
});
