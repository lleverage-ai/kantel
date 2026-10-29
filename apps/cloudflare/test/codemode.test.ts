// Code mode on the stack: the model's script runs in the session's code mode isolate (src/codemode/serve.ts, behind a
// stand-in for the Worker Loader that keeps one isolate per loader ID and copies what crosses the boundary as RPC
// would) and calls the session's own tools, as its agent. The isolate is loaded by the first script, not before.
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { CodemodeRemoteExchange, CodemodeRemoteRequest } from "@earendil-works/pi-codemode/portable";
import type { CallContext } from "@harbour/contracts";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeServer } from "../src/codemode/serve.ts";
import {
	CODEMODE_ENTRYPOINT,
	CODEMODE_TOOL,
	type CodemodeCode,
	type CodemodeLoaderLike,
	codemodeDescription,
	codemodeEnabled,
	codemodeIsolateId,
	QUICKJS_MODULE,
	workerLoaderCodemode,
} from "../src/codemode.ts";
import { CODING_TOOLS } from "../src/coding-tools.ts";
import { gatewayConfig } from "../src/config.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";

const BUNDLE = "export class HarbourCodemode {}";
const QUICKJS = new ArrayBuffer(8);
const wasm = loadQuickJSWasm();

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

/** A Worker Loader stand-in: one code mode server per ID, made on first use; requests are copied as RPC copies them. */
function fakeLoader() {
	const isolates = new Map<string, ReturnType<typeof createCodemodeServer>>();
	const codes: CodemodeCode[] = [];
	const loaded: string[] = [];
	const loader: CodemodeLoaderLike = {
		get(id, code) {
			return {
				getEntrypoint(name) {
					expect(name).toBe(CODEMODE_ENTRYPOINT);
					return {
						async execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange) {
							let server = isolates.get(id);
							if (server === undefined) {
								codes.push(await code());
								loaded.push(id);
								server = createCodemodeServer(wasm);
								isolates.set(id, server);
							}
							// Only plain data and the exchange stub cross.
							return server.execute(structuredClone(request), async (messages) =>
								structuredClone(await exchange(structuredClone(messages))),
							);
						},
					};
				},
			};
		},
	};
	return { loader, codes, loaded };
}

async function setUp() {
	const { models, script } = createScriptedModel();
	const fake = fakeLoader();
	const stack = await createStack({
		config: gatewayConfig({ HARBOUR_ADMIN_EMAIL: "tom@harbour.test" }),
		models: () => ({ models }),
		codemode: { load: workerLoaderCodemode(fake.loader, BUNDLE, QUICKJS), bundleId: "b1" },
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	const workspace = await stack.workspaces.create(admin, {
		owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
		seed: { name: "s", sources: [{ kind: "files", files: { "notes/plan.md": "the plan\n" } }] },
	});
	const session = (workspaceId?: string) =>
		stack.runtime.runtime.create(admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			...(workspaceId === undefined ? {} : { workspaceId }),
		});
	const run = async (sessionId: string, text: string) => {
		const prompt = await stack.runtime.runtime.prompt(admin, sessionId, { text });
		return stack.runtime.runtime.wait(admin, sessionId, prompt.id);
	};
	const live = (sessionId: string) => stack.sandboxes.sandboxes.leases(admin, { sessionId, live: true });
	const toolResults = () =>
		script.requests
			.at(-1)
			?.messages.filter((message) => message.role === "tool")
			.map((message) => message.text) ?? [];
	return { stack, admin, script, fake, workspace, session, run, live, toolResults };
}

describe("code mode", () => {
	it("is on unless HARBOUR_CODEMODE is off, and the default profile names it after the coding tools", async () => {
		expect(codemodeEnabled({})).toBe(true);
		expect(codemodeEnabled({ HARBOUR_CODEMODE: "on" })).toBe(true);
		expect(codemodeEnabled({ HARBOUR_CODEMODE: " off " })).toBe(false);
		const { stack, admin } = await setUp();
		const profile = await stack.runtime.profiles.get(admin, DEFAULT_AGENT_ID);
		expect(profile.tools).toEqual([...CODING_TOOLS, CODEMODE_TOOL]);
	});

	it("runs a script in the session's isolate that calls the session's tools as its agent, loaded only when used", async () => {
		const { stack, admin, script, fake, workspace, session, run, live, toolResults } = await setUp();
		const created = await session(workspace.id);

		// Plain tool calls load nothing.
		script.reply({ toolCalls: [{ name: "read", args: { path: "notes/plan.md" } }] }, { text: "Read" });
		await run(created.id, "Read the plan");
		expect(fake.loaded).toEqual([]);
		// Harbour adds no prompt about code mode: only the tool's own description says what it is.
		expect(script.requests.at(-1)?.system ?? "").not.toMatch(/codemode/i);

		const code = [
			'const plan = await tools.read({ path: "notes/plan.md" });',
			'await tools.write({ path: "notes/loud.md", content: plan.toUpperCase() });',
			'const listed = await tools.ls({ path: "notes" });',
			"console.log(listed);",
			"return { plan: plan.trim(), fetch: typeof fetch, timers: typeof setTimeout };",
		].join("\n");
		script.reply({ toolCalls: [{ name: CODEMODE_TOOL, args: { code } }] }, { text: "Ran the script" });
		expect(await run(created.id, "Shout the plan")).toMatchObject({ status: "answered", answer: "Ran the script" });
		const result = toolResults().at(-1) ?? "";
		expect(result).toMatch(/^Script completed/);
		expect(result).toContain("loud.md\nplan.md");
		expect(result).toContain('"plan":"the plan"');
		// No network or timers in the script.
		expect(result).toContain('"fetch":"undefined"');
		expect(result).toContain('"timers":"undefined"');
		const written = await stack.workspaces.read(admin, workspace.id, "notes/loud.md");
		expect(new TextDecoder().decode(written.content)).toBe("THE PLAN\n");

		// One isolate, for this session, with no bindings and no network, loaded by the script.
		const id = codemodeIsolateId({ organisationId: stack.organisation.id, sessionId: created.id, bundleId: "b1" });
		expect(fake.loaded).toEqual([id]);
		expect(fake.codes).toEqual([
			{
				compatibilityDate: expect.any(String),
				compatibilityFlags: [],
				mainModule: "codemode.js",
				modules: { "codemode.js": BUNDLE, [QUICKJS_MODULE]: { wasm: QUICKJS } },
				env: {},
				globalOutbound: null,
			},
		]);
		// The file tools leased no sandbox, from a script as from the model.
		expect(await live(created.id)).toEqual([]);
		// The script's write was committed as the session's agent.
		const commits = await stack.audit.query(admin, { type: "workspace.committed", sessionId: created.id });
		expect(commits.items.at(-1)?.actor).toEqual({ kind: "agent", agentId: DEFAULT_AGENT_ID, sessionId: created.id });

		// A second script reuses the warm isolate; `bash` from a script leases the session's isolate tier as usual.
		script.reply(
			{
				toolCalls: [
					{ name: CODEMODE_TOOL, args: { code: 'return await tools.bash({ command: "cat notes/loud.md" });' } },
				],
			},
			{ text: "Ran it again" },
		);
		await run(created.id, "Cat it");
		expect(toolResults().at(-1)).toContain("THE PLAN");
		expect(fake.loaded).toEqual([id]);
		expect((await live(created.id)).map((lease) => lease.tier)).toEqual(["isolate"]);
	});

	it("reports a script's error and a call to a tool the session doesn't have", async () => {
		const { script, workspace, session, run, toolResults } = await setUp();
		const created = await session(workspace.id);
		script.reply(
			{
				toolCalls: [
					{ name: CODEMODE_TOOL, args: { code: 'await tools.browser_open({ url: "https://example.com" });' } },
				],
			},
			{ toolCalls: [{ name: CODEMODE_TOOL, args: { code: "throw new Error('broken on purpose');" } }] },
			{ text: "Failed" },
		);
		await run(created.id, "Try");
		const [missing, thrown] = toolResults();
		expect(missing).toMatch(/^Script failed/);
		expect(missing).toContain("tools.browser_open does not exist. Available: read, write, edit, ls, bash.");
		expect(thrown).toMatch(/^Script failed/);
		expect(thrown).toContain("Error: broken on purpose");
	});

	it("works in a session started without a repository, on the workspace its first tool call makes", async () => {
		const { script, fake, session, run, toolResults } = await setUp();
		const created = await session();
		const code =
			'await tools.write({ path: "hello.txt", content: "hi" }); return await tools.read({ path: "hello.txt" });';
		script.reply({ toolCalls: [{ name: CODEMODE_TOOL, args: { code } }] }, { text: "Wrote" });
		await run(created.id, "Try");
		expect(toolResults().at(-1)).toMatch(/^Script completed/);
		expect(toolResults().at(-1)).toContain("hi");
		expect(fake.loaded).toHaveLength(1);
	});

	it("describes where a script's tools are without pointing at a system prompt section", async () => {
		const description = codemodeDescription(
			"Run JavaScript that calls other tools.\n\nThe `codemode` section of the system prompt lists the tools scripts can call, by namespace, as far as space allows.",
		);
		expect(description).not.toContain("system prompt");
		expect(description).toContain("`tools` has the other tools you are offered");
		expect(() => codemodeDescription("Something else")).toThrow(/description changed/);
	});
});
