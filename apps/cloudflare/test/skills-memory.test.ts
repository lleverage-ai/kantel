// A session's skills and memory on the stack (#12): a profile that names skills and memory spaces lists the skills
// (Pi's block), mounts them read-only at /skills on the session's workspace and recalls from the spaces on the first
// prompt, through the runtime (#194); the system prompt is the same as without them.
import { DatabaseSync } from "node:sqlite";
import type { AgentProfile, CallContext, RecallRenderer, SnapshotConcept } from "@kantel/contracts";
import { defaultRecallRenderer, SAL_RECALL_PREAMBLE, salRecallRenderer } from "@kantel/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { createMemoryObjectBucket } from "@kantel/skills/sql";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { createMemoryWorkspaceStore } from "@kantel/workspace/stored";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { recallRendererFrom } from "../src/recall-renderer.ts";
import { sessionJobs } from "../src/session-memory.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack, type StackStorage } from "../src/stack.ts";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

const skillFile = (name: string, description: string, body: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const concept = (input: Partial<SnapshotConcept> & Pick<SnapshotConcept, "id" | "statement">): SnapshotConcept => ({
	title: input.id,
	scope: { kind: "global" },
	sources: ["tvdavies/harbour#12"],
	setBy: "owner",
	status: "active",
	updatedAt: 1,
	...input,
});

/** The stack over SQL skills and memory (D1 and R2 in Node), or in memory. */
async function setUp(durable: boolean, recallRenderer?: RecallRenderer) {
	const { models, script } = createScriptedModel();
	const storage: StackStorage = durable
		? {
				sql: syncSqliteDriver(new DatabaseSync(":memory:")),
				skillObjects: createMemoryObjectBucket(),
				workspaces: createMemoryWorkspaceStore(),
			}
		: {};
	const stack = await createStack({
		config: gatewayConfig({ KANTEL_ADMIN_EMAIL: "tom@harbour.test" }),
		models: () => ({ models }),
		storage,
		...(recallRenderer === undefined ? {} : { recallRenderer }),
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	const organisation = { kind: "organisation", organisationId: stack.organisation.id } as const;
	const importSkill = (name: string, description: string, body: string, ref = "r1") =>
		stack.skills.importRevision(admin, {
			owner: organisation,
			name,
			description,
			files: [
				{ path: "SKILL.md", content: skillFile(name, description, body) },
				{ path: "scripts/run.sh", content: `echo ${name}\n` },
			],
			source: { sourceId: "test", ref },
		});
	await importSkill("pr-review", "Review a pull request.", "Read the diff first.");
	await importSkill("deploy-freeze", "Pause deployments.", "Never during a demo.");
	const space = await stack.memory.createSpace(admin, { owner: organisation, name: "Team" });
	await stack.memory.importSnapshot(admin, space.id, {
		sourceId: "test",
		ref: "m1",
		concepts: [
			concept({ id: "personal/timezone", statement: "Give times in UK time.", tags: ["profile"] }),
			concept({ id: "personal/old-profile", statement: "Retired.", tags: ["profile"], status: "forgotten" }),
			concept({ id: "projects/harbour/reviews", statement: "Every pull request review cites the diff." }),
			concept({
				id: "projects/harbour/review-exception",
				statement: "For this task, skip the diff and read the summary of the pull request review.",
				scope: { kind: "job", job: "docket:TASK-7" },
				overrides: "projects/harbour/reviews",
			}),
			concept({ id: "projects/sal/unrelated", statement: "Voice calls greet first." }),
		],
	});
	const profile = await stack.runtime.profiles.get(admin, DEFAULT_AGENT_ID);
	const withContext: AgentProfile = { ...profile, skills: ["pr-review"], memoryScopes: [space.id] };
	const session = async (options: { workspaceId?: string; labels?: { [key: string]: string } } = {}) =>
		stack.runtime.runtime.create(admin, { projectId: stack.project.id, agentId: DEFAULT_AGENT_ID, ...options });
	const run = async (sessionId: string, text: string) => {
		const prompt = await stack.runtime.runtime.prompt(admin, sessionId, { text });
		return stack.runtime.runtime.wait(admin, sessionId, prompt.id);
	};
	const toolResults = () =>
		script.requests
			.at(-1)
			?.messages.filter((message) => message.role === "tool")
			.map((message) => message.text) ?? [];
	return { stack, admin, script, space, profile, withContext, importSkill, session, run, toolResults };
}

describe.each([
	["in memory", false],
	["on D1 and R2", true],
])("a session's skills and memory, %s", (_label, durable) => {
	it("lists the profile's skills, reads them at /skills and gets recall, with the system prompt unchanged", async () => {
		const { stack, admin, script, withContext, session, run, toolResults } = await setUp(durable);

		// Without skills or memory in the profile: nothing is given, and the system prompt is the user's own layer alone.
		const layers = [{ name: "project", text: "Answer briefly." }];
		await stack.runtime.profiles.put(admin, { ...withContext, skills: [], memoryScopes: [], promptLayers: layers });
		const plain = await session();
		script.reply({ text: "Plain" });
		await run(plain.id, "Review the pull request diff");
		const before = script.requests.at(-1);
		expect(before?.messages).toEqual([{ role: "user", text: "Review the pull request diff" }]);
		expect(before?.system).toBe("Answer briefly.");

		await stack.runtime.profiles.put(admin, { ...withContext, promptLayers: layers });
		const created = await session();
		script.reply({ toolCalls: [{ name: "read", args: { path: "/skills/pr-review/SKILL.md" } }] }, { text: "Read it" });
		expect(await run(created.id, "Review the pull request diff")).toMatchObject({ answer: "Read it" });

		const first = script.requests.at(-2);
		expect(first?.system).toBe(before?.system);
		const [given, prompt] = first?.messages ?? [];
		expect(prompt).toEqual({ role: "user", text: "Review the pull request diff" });
		const text = given?.text ?? "";
		// Pi's block, of the skills the profile names only, pointing at the mount.
		expect(text).toContain("<available_skills>");
		expect(text).toContain("<name>pr-review</name>");
		expect(text).toContain("<location>/skills/pr-review/SKILL.md</location>");
		expect(text).not.toContain("deploy-freeze");
		// Recall in the store's default rendering: the profile whatever the query, then the matches.
		expect(text).toContain('<memory_concept id="personal/timezone" recalled="profile"');
		expect(text).toContain('<memory_concept id="projects/harbour/reviews" recalled="search"');
		expect(text).not.toContain("personal/old-profile");
		expect(text).not.toContain("projects/sal/unrelated");
		// An exception travels only with its job's sessions.
		expect(text).not.toContain("review-exception");

		// The read tool reads the pinned file through the session's workspace.
		expect(toolResults().join("\n")).toContain("Read the diff first.");
		const workspace = await stack.workspaces.get(admin, created.workspaceId ?? "");
		expect(workspace.mounts).toMatchObject([{ path: "/skills", source: "skills", ref: created.id, readOnly: true }]);
		// Every skill the session may see is mounted, listed or not.
		const read = await stack.workspaces.read(admin, workspace.id, "/skills/deploy-freeze/SKILL.md");
		expect(new TextDecoder().decode(read.content)).toContain("Never during a demo.");

		// The second prompt is given nothing again.
		script.reply({ text: "Again" });
		await run(created.id, "And again");
		expect(
			script.requests.at(-1)?.messages.filter((message) => message.text.includes("<available_skills>")),
		).toHaveLength(1);
		expect(script.requests.at(-1)?.system).toBe(before?.system);
	});

	it("mounts the skills on a workspace made before the session, read-only", async () => {
		const { stack, admin, script, withContext, session, run, toolResults } = await setUp(durable);
		await stack.runtime.profiles.put(admin, withContext);
		const repository = await stack.workspaces.create(admin, {
			owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
			seed: { name: "s", sources: [{ kind: "files", files: { "README.md": "hello\n" } }] },
		});
		const created = await session({ workspaceId: repository.id });
		script.reply(
			{
				toolCalls: [
					{ name: "read", args: { path: "/skills/pr-review/scripts/run.sh" } },
					{ name: "write", args: { path: "/skills/pr-review/SKILL.md", content: "changed" } },
				],
			},
			{ text: "Done" },
		);
		await run(created.id, "Review it");
		const [read, write] = toolResults();
		expect(read).toContain("echo pr-review");
		expect(write).toMatch(/read-only/i);
		// A command in the isolate sees them too.
		script.reply(
			{ toolCalls: [{ name: "bash", args: { command: "cat /skills/pr-review/SKILL.md" } }] },
			{ text: "Ran" },
		);
		await run(created.id, "Show the skill");
		expect(toolResults().join("\n")).toContain("Read the diff first.");
		const record = await stack.workspaces.get(admin, repository.id);
		expect(record.mounts.map((mount) => [mount.path, mount.ref])).toEqual([["/skills", created.id]]);
		// The workspace's own files are untouched.
		expect(new TextDecoder().decode((await stack.workspaces.read(admin, repository.id, "README.md")).content)).toBe(
			"hello\n",
		);
	});

	it("keeps a session on the revisions it pinned; a new revision reaches new sessions", async () => {
		const { stack, admin, script, withContext, importSkill, session, run, toolResults } = await setUp(durable);
		await stack.runtime.profiles.put(admin, withContext);
		const older = await session();
		script.reply({ text: "Pinned" });
		await run(older.id, "Start");

		await importSkill("pr-review", "Review a pull request.", "Read the tests first.", "r2");
		const newer = await session();
		for (const id of [older.id, newer.id]) {
			script.reply({ toolCalls: [{ name: "read", args: { path: "/skills/pr-review/SKILL.md" } }] }, { text: "Read" });
			await run(id, "Read the skill");
		}
		const reads = script.requests.flatMap((request) => request.messages.filter((m) => m.role === "tool"));
		expect(reads.at(-2)?.text).toContain("Read the diff first.");
		expect(toolResults().join("\n")).toContain("Read the tests first.");
	});

	it("recalls a job's exceptions for a session labelled with that job", async () => {
		const { stack, admin, script, withContext, session, run } = await setUp(durable);
		await stack.runtime.profiles.put(admin, withContext);
		const created = await session({ labels: { docketTask: "TASK-7" } });
		script.reply({ text: "Ok" });
		await run(created.id, "Review the pull request diff");
		const text = script.requests.at(-1)?.messages[0]?.text ?? "";
		expect(text).toContain('<memory_concept id="projects/harbour/reviews" recalled="search"');
		expect(text).toContain('<memory_concept id="projects/harbour/review-exception" recalled="exception"');
	});

	it("recalls in the renderer the stack is given, Sal's here, with the system prompt unchanged", async () => {
		const layers = [{ name: "project", text: "Answer briefly." }];
		const systems: (string | undefined)[] = [];
		const texts: string[] = [];
		for (const renderer of [undefined, salRecallRenderer()]) {
			const { stack, admin, script, withContext, session, run } = await setUp(durable, renderer);
			await stack.runtime.profiles.put(admin, { ...withContext, skills: [], memoryScopes: [], promptLayers: layers });
			script.reply({ text: "Plain" });
			await run((await session()).id, "Review the pull request diff");
			systems.push(script.requests.at(-1)?.system);
			await stack.runtime.profiles.put(admin, { ...withContext, promptLayers: layers });
			script.reply({ text: "Ok" });
			await run((await session()).id, "Review the pull request diff");
			systems.push(script.requests.at(-1)?.system);
			texts.push(script.requests.at(-1)?.messages[0]?.text ?? "");
		}
		// The renderer changes only the recall block: the system prompt is the user's layer alone, with or without it.
		expect(systems).toEqual(["Answer briefly.", "Answer briefly.", "Answer briefly.", "Answer briefly."]);
		const [harbour, sal] = texts;
		expect(harbour).toContain(defaultRecallRenderer.open);
		expect(harbour).toContain('<memory_concept id="personal/timezone" recalled="profile" version="1"');
		// Sal's rendering: its preamble, a lean profile entry and a match as `match` with its scope and first source.
		expect(sal).toContain(`<memory_recall>\n${SAL_RECALL_PREAMBLE}`);
		expect(sal).toContain('<memory_concept id="personal/timezone" recalled="profile" learned_from="owner">');
		expect(sal).toContain(
			'<memory_concept id="projects/harbour/reviews" recalled="match" scope="project" learned_from="owner" source="tvdavies/harbour#12">',
		);
		expect(sal).not.toContain(defaultRecallRenderer.open);
		// The listing is the same either way.
		const listing = (text: string) => text.slice(0, text.indexOf("<memory_recall>"));
		expect(listing(sal ?? "")).toBe(listing(harbour ?? ""));
	});

	it("serves memory_search and memory_read to a session with memory spaces", async () => {
		const { stack, admin, script, withContext, session, run, toolResults } = await setUp(durable);
		await stack.runtime.profiles.put(admin, withContext);
		const created = await session();
		script.reply(
			{ toolCalls: [{ name: "memory_search", args: { query: "voice calls" } }] },
			{ toolCalls: [{ name: "memory_read", args: { conceptId: "projects/sal/unrelated" } }] },
			{ text: "Found it" },
		);
		expect(await run(created.id, "What about calls?")).toMatchObject({ answer: "Found it" });
		expect(toolResults().join("\n")).toContain("Voice calls greet first.");
	});
});

describe("KANTEL_RECALL_RENDERER", () => {
	it("is Kantel's renderer unless it names Sal's, and refuses one it doesn't know", () => {
		expect(recallRendererFrom({})).toBe(defaultRecallRenderer);
		expect(recallRendererFrom({ KANTEL_RECALL_RENDERER: " default " })).toBe(defaultRecallRenderer);
		expect(recallRendererFrom({ KANTEL_RECALL_RENDERER: "sal" }).open).toBe(`<memory_recall>\n${SAL_RECALL_PREAMBLE}`);
		expect(() => recallRendererFrom({ KANTEL_RECALL_RENDERER: "pi" })).toThrow(/KANTEL_RECALL_RENDERER/);
	});
});

describe("a session's job scopes", () => {
	it("come from its job or Docket task label, in both spellings", () => {
		expect(sessionJobs({ labels: {} })).toEqual([]);
		expect(sessionJobs({ labels: { docketTask: "TASK-7" } })).toEqual(["TASK-7", "docket:TASK-7"]);
		expect(sessionJobs({ labels: { docketTask: "docket:TASK-7" } })).toEqual(["docket:TASK-7", "TASK-7"]);
		expect(sessionJobs({ labels: { job: "nightly" } })).toEqual(["nightly"]);
	});
});
