// Prompt rules in a session's prompt (docs/design/org-scope.md, decision 5): resolved when the session is created, for
// its scope and user, around the profile's own layers, and fixed for the session's life.
import type { AgentProfile, CallContext, OwnerRef } from "@kantel/contracts";
import { createMemoryPromptRules } from "@kantel/rules/memory";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { describe, expect, it } from "vitest";

const ORG = "org-rules";
const PROJECT = "proj-rules";
const harbour: CallContext = { actor: { kind: "system", component: "test" }, organisationId: ORG };
const alice: CallContext = { actor: { kind: "human", userId: "alice" }, organisationId: ORG };

const profile: AgentProfile = {
	id: "assistant",
	organisationId: ORG,
	name: "Assistant",
	model: { route: "default" },
	promptLayers: [{ name: "role", text: "PROFILE" }],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

async function setUp() {
	const { models, script } = createScriptedModel();
	const rules = createMemoryPromptRules();
	const service = createMemoryRuntime({ models, rules });
	await service.profiles.put(harbour, profile);
	const put = (owner: OwnerRef, name: string, text: string) => rules.put(harbour, { owner, name, text });
	await put({ kind: "platform" }, "house", "PLATFORM");
	await put({ kind: "organisation", organisationId: ORG }, "org", "ORGANISATION");
	await put({ kind: "project", organisationId: ORG, projectId: PROJECT }, "proj", "PROJECT");
	await put({ kind: "project", organisationId: ORG, projectId: "proj-other" }, "other", "OTHER-PROJECT");
	await put({ kind: "user", organisationId: ORG, userId: "alice" }, "mine", "ALICE");
	await put({ kind: "user", organisationId: ORG, userId: "bob" }, "theirs", "BOB");
	return { service, script, rules, put };
}

async function ask(service: Awaited<ReturnType<typeof setUp>>["service"], sessionId: string): Promise<void> {
	const submission = await service.runtime.prompt(alice, sessionId, { text: "hi" });
	await service.runtime.wait(alice, sessionId, submission.id);
}

/** The system prompt the model saw on the session's last request. */
async function promptOf(
	setup: Awaited<ReturnType<typeof setUp>>,
	input: { projectId?: string; scope?: "organisation" },
): Promise<string> {
	const { service, script } = setup;
	setup.script.reply({ text: "ok" });
	const session = await service.runtime.create(alice, { agentId: profile.id, ...input });
	await ask(service, session.id);
	return script.requests.at(-1)?.system ?? "";
}

describe("prompt rules in a session", () => {
	it("layers platform, organisation, project, profile, then the session user's rules", async () => {
		const setup = await setUp();
		const system = await promptOf(setup, { projectId: PROJECT });
		expect(system).toBe(["PLATFORM", "ORGANISATION", "PROJECT", "PROFILE", "ALICE"].join("\n\n"));
	});

	it("gives an organisation session no project layer", async () => {
		const setup = await setUp();
		const system = await promptOf(setup, { scope: "organisation" });
		expect(system).toBe(["PLATFORM", "ORGANISATION", "PROFILE", "ALICE"].join("\n\n"));
	});

	it("fixes the rules when the session is created: an edit reaches only new sessions", async () => {
		const setup = await setUp();
		const { service, script, put } = setup;
		script.reply({ text: "ok" });
		const session = await service.runtime.create(alice, { agentId: profile.id, projectId: PROJECT });
		await put({ kind: "organisation", organisationId: ORG }, "org", "EDITED");
		script.reply({ text: "ok" });
		await ask(service, session.id);
		expect(script.requests.at(-1)?.system).toContain("ORGANISATION");
		expect(script.requests.at(-1)?.system).not.toContain("EDITED");
		expect(await promptOf(setup, { projectId: PROJECT })).toContain("EDITED");
	});
});
