// A session's skills and memory (#12): pinned, mounted, listed through the host's renderer and recalled on the first
// prompt, kept in the transcript for later turns and restarts, and the memory tools served as the session's agent.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { AgentProfile, CallContext, SessionSkillPin, SkillFile } from "@harbour/contracts";
import { createMemoryMemory } from "@harbour/memory/memory";
import { createSessionRuntime, type SessionRuntimeOptions } from "@harbour/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import { createMemorySessionStore } from "@harbour/runtime/store";
import { createScriptedModel } from "@harbour/runtime/testing";
import { createMemorySkills } from "@harbour/skills/memory";
import { renderSkillListings } from "@harbour/skills/sources";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-context";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const service: CallContext = ctx;
const owner = { kind: "organisation", organisationId: ORG } as const;

const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [{ name: "role", text: "You help." }],
	tools: [],
	skills: ["pr-review"],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

function skillMd(name: string, description: string): SkillFile {
	return { path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n` };
}

async function publish(skills: ReturnType<typeof createMemorySkills>, name: string, description: string, ref: string) {
	return skills.importRevision(service, {
		owner,
		name,
		description,
		files: [skillMd(name, description)],
		source: { sourceId: "toolkit", ref },
	});
}

async function memoryWith(statement: string) {
	const memory = createMemoryMemory();
	const space = await memory.createSpace(service, { owner, name: "Team memory" });
	await memory.importSnapshot(service, space.id, {
		sourceId: "team-memory",
		ref: "c1",
		concepts: [
			{
				id: "team/deploys",
				title: "Deploy days",
				description: "When the team deploys",
				statement,
				scope: { kind: "global" },
				sources: ["slack:T1/C1/1"],
				setBy: "owner",
				status: "active",
				updatedAt: 1,
			},
		],
	});
	return { memory, space };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

/** A runtime in memory. */
function inMemory(extra: Partial<SessionRuntimeOptions>) {
	const { models, script } = createScriptedModel();
	const runtime = createSessionRuntime({
		...extra,
		store: createMemorySessionStore(),
		storage: () => new MemoryStorage(),
		models,
	});
	cleanups.push(() => runtime.close());
	return { runtime, script };
}

/** A database file in its own directory, removed after the test. */
function databaseFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "harbour-context-"));
	cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "harbour.db");
}

/** One process on a database file, so a second one on the same file is the deployment after a restart. */
async function processOn(file: string, extra: Partial<SessionRuntimeOptions>) {
	const db = await openNodeSqliteDatabase(file);
	const { models, script } = createScriptedModel();
	const runtime = createSessionRuntime({
		...extra,
		store: await createSqlSessionStore(db),
		storage: (session) => sqlPiStorage(db, session.id),
		models,
	});
	const close = async () => {
		await runtime.close();
		await db.close();
	};
	cleanups.push(close);
	return { runtime, script, close };
}

/** Prompts a session and waits for its answer. */
async function ask(service: ReturnType<typeof createSessionRuntime>, sessionId: string, text: string) {
	const submission = await service.runtime.prompt(ctx, sessionId, { text });
	return service.runtime.wait(ctx, sessionId, submission.id);
}

describe("a session's skills and memory", () => {
	it("pins, mounts and lists the profile's skills through the host's renderer, once, before the first prompt", async () => {
		const skills = createMemorySkills();
		await publish(skills, "pr-review", "Review a PR", "a1");
		await publish(skills, "deploy", "Deploy a service", "a1");
		const mounted: { sessionId: string; pins: readonly SessionSkillPin[] }[] = [];
		const file = databaseFile();
		const options: Partial<SessionRuntimeOptions> = {
			skills: {
				store: skills,
				render: (listings) => renderSkillListings(listings),
				mount: async (session, pins) => {
					mounted.push({ sessionId: session.id, pins });
				},
			},
		};
		const first = await processOn(file, options);
		await first.runtime.profiles.put(ctx, profile);
		const session = await first.runtime.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		first.script.reply({ text: "One" });
		await ask(first.runtime, session.id, "Review my PR");

		// Every visible skill is pinned and mounted; only the profile's are listed, at the mount.
		expect(mounted).toHaveLength(1);
		expect(mounted[0]?.pins.map((pin) => pin.revision)).toEqual([1, 1]);
		const request = first.script.requests[0];
		expect(request?.messages.map((message) => message.role)).toEqual(["user", "user"]);
		expect(request?.messages[0]?.text).toContain("<name>pr-review</name>");
		expect(request?.messages[0]?.text).toContain("/skills/pr-review/SKILL.md");
		expect(request?.messages[0]?.text).not.toContain("deploy");
		expect(request?.messages[1]?.text).toBe("Review my PR");
		// Harbour adds nothing of its own: the system prompt is the profile's.
		expect(request?.system).toBe("You help.");

		// A newer revision reaches new sessions only; the next prompt, and a restarted process, add nothing again.
		await publish(skills, "pr-review", "Review a PR carefully", "b2");
		first.script.reply({ text: "Two" });
		await ask(first.runtime, session.id, "Again");
		await first.close();
		const second = await processOn(file, options);
		second.script.reply({ text: "Three" });
		await ask(second.runtime, session.id, "After a restart");
		expect(mounted).toHaveLength(1);
		const last = second.script.requests[0];
		expect(last?.messages.filter((message) => message.text.includes("<available_skills>"))).toHaveLength(1);
		expect(last?.messages[0]?.text).toContain("Review a PR</description>");

		const fresh = await second.runtime.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		second.script.reply({ text: "Fresh" });
		await ask(second.runtime, fresh.id, "Hello");
		expect(second.script.requests[1]?.messages[0]?.text).toContain("Review a PR carefully</description>");
		expect(mounted[1]?.pins.map((pin) => pin.revision).sort()).toEqual([1, 2]);
	});

	it("keeps the context, once, when the first message is edited", async () => {
		const skills = createMemorySkills();
		await publish(skills, "pr-review", "Review a PR", "a1");
		const mounted: string[] = [];
		const { runtime, script } = inMemory({
			skills: {
				store: skills,
				render: (listings) => renderSkillListings(listings),
				mount: async (session) => void mounted.push(session.id),
			},
		});
		await runtime.profiles.put(ctx, profile);
		const session = await runtime.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "One" });
		await ask(runtime, session.id, "Review my PR");
		const items = (await runtime.runtime.snapshot(ctx, session.id)).items;
		const first = items.find((item) => item.kind === "user");
		if (first === undefined) throw new Error("No user item");

		// The edit forks from the context entry, so the rerun sees the listing once and nothing is pinned or mounted again.
		script.reply({ text: "Two" });
		const submission = await runtime.branching.edit(ctx, session.id, { itemId: first.id, text: "Review it carefully" });
		await runtime.runtime.wait(ctx, session.id, submission.id);
		const rerun = script.requests.at(-1);
		expect(rerun?.messages.map((message) => message.role)).toEqual(["user", "user"]);
		expect(rerun?.messages[0]?.text).toContain("<name>pr-review</name>");
		expect(rerun?.messages[1]?.text).toBe("Review it carefully");
		expect(mounted).toEqual([session.id]);
	});

	it("pins and mounts without listing when the host gives no renderer", async () => {
		const skills = createMemorySkills();
		await publish(skills, "pr-review", "Review a PR", "a1");
		const mounted: string[] = [];
		const { runtime, script } = inMemory({
			skills: { store: skills, mount: async (session) => void mounted.push(session.id) },
		});
		await runtime.profiles.put(ctx, profile);
		const session = await runtime.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "Done" });
		await ask(runtime, session.id, "Hello");
		expect(mounted).toEqual([session.id]);
		expect(script.requests[0]?.messages).toEqual([{ role: "user", text: "Hello" }]);
	});

	it("recalls over the profile's memory scopes with the host's renderer and serves the memory tools", async () => {
		const { memory, space } = await memoryWith("The team deploys on Tuesdays.");
		const { runtime, script } = inMemory({ memory: { store: memory } });
		await runtime.profiles.put(ctx, { ...profile, skills: [], memoryScopes: [space.id] });
		const session = await runtime.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ toolCalls: [{ name: "memory_search", args: { query: "deploys" } }] });
		script.reply({ toolCalls: [{ name: "memory_read", args: { concept: "team/deploys" } }] });
		script.reply({ text: "Tuesdays." });
		await ask(runtime, session.id, "When do we deploy?");

		const [first, second, third] = script.requests;
		expect(first?.messages[0]?.text).toContain("The team deploys on Tuesdays.");
		expect(first?.messages[1]?.text).toBe("When do we deploy?");
		expect(second?.messages.at(-1)).toMatchObject({ role: "tool" });
		expect(second?.messages.at(-1)?.text).toContain("team/deploys: Deploy days");
		expect(third?.messages.at(-1)?.text).toContain("The team deploys on Tuesdays.");
	});

	it("gives a session without memory scopes no recall and no memory tools", async () => {
		const { memory } = await memoryWith("The team deploys on Tuesdays.");
		const { runtime, script } = inMemory({ memory: { store: memory } });
		await runtime.profiles.put(ctx, { ...profile, skills: [] });
		const session = await runtime.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ toolCalls: [{ name: "memory_search", args: { query: "deploys" } }] });
		script.reply({ text: "Done" });
		await ask(runtime, session.id, "When do we deploy?");
		expect(script.requests[0]?.messages).toEqual([{ role: "user", text: "When do we deploy?" }]);
		expect(script.requests[1]?.messages.at(-1)?.text).toContain("memory_search");
	});
});
