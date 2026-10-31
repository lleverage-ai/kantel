// A prompt's attachments: the host reads each file for the model, the blocks lead the user message, and the transcript
// shows the typed words with the files named beside them.
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { AgentProfile, PromptAttachment } from "@kantel/contracts";
import { type AttachmentBlock, type PromptAttachments, parseAttachments, userInputOf } from "@kantel/runtime";
import { createSessionRuntime, type SessionRuntimeOptions } from "@kantel/runtime/core";
import { createMemorySessionStore } from "@kantel/runtime/store";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-attachments";
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

const notes: PromptAttachment = { id: "a1", name: "notes.md", type: "text/markdown", size: 12, kind: "file" };
const photo: PromptAttachment = { id: "a2", name: "cat.png", type: "image/png", size: 3, kind: "image" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

function runtimeWith(extra: Partial<SessionRuntimeOptions>) {
	const { models, script } = createScriptedModel();
	const service = createSessionRuntime({
		...extra,
		store: createMemorySessionStore(),
		storage: () => new MemoryStorage(),
		models,
	});
	cleanups.push(() => service.close());
	return { service, script };
}

/** A host that holds `notes` and `photo` in project `proj`, and names them as stored. */
const host: PromptAttachments = {
	async read(_ctx, session, attachments) {
		if (session.projectId !== "proj") throw new Error("wrong project");
		return {
			blocks: attachments.flatMap((attachment): AttachmentBlock[] =>
				attachment.id === "a1"
					? [{ type: "text" as const, text: '<file name="notes.md">\nThe launch is on Tuesday.\n</file>' }]
					: [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }],
			),
			attachments: attachments.map((attachment) => (attachment.id === "a1" ? notes : photo)),
		};
	},
};

describe("prompt attachments", () => {
	it("sends the files ahead of the words, and the transcript shows the words with the files named", async () => {
		const { service, script } = runtimeWith({ attachments: host });
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "Tuesday." });
		const submission = await service.runtime.prompt(ctx, session.id, {
			text: "When is the launch?",
			// The caller's name for a file is not what the transcript shows: the host's is.
			attachments: [{ ...notes, name: "renamed.md" }, photo],
		});
		await service.runtime.wait(ctx, session.id, submission.id);

		const sent = script.requests[0]?.messages.at(-1)?.text ?? "";
		expect(sent).toContain("The launch is on Tuesday.");
		expect(sent.indexOf("The launch is on Tuesday.")).toBeLessThan(sent.indexOf("When is the launch?"));

		const user = (await service.runtime.snapshot(ctx, session.id)).items.find((item) => item.kind === "user");
		expect(user).toMatchObject({ kind: "user", text: "When is the launch?", attachments: [notes, photo] });
	});

	it("takes a prompt of files alone, and refuses attachments where nothing reads them", async () => {
		const { service, script } = runtimeWith({ attachments: host });
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "A cat." });
		const submission = await service.runtime.prompt(ctx, session.id, { text: "", attachments: [photo] });
		await service.runtime.wait(ctx, session.id, submission.id);
		const user = (await service.runtime.snapshot(ctx, session.id)).items.find((item) => item.kind === "user");
		expect(user).toMatchObject({ text: "", attachments: [photo] });

		const bare = runtimeWith({});
		await bare.service.profiles.put(ctx, profile);
		const other = await bare.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await expect(bare.service.runtime.prompt(ctx, other.id, { text: "Hi", attachments: [notes] })).rejects.toThrow(
			"doesn't take attachments",
		);
	});

	it("checks a prompt body's attachments", () => {
		expect(parseAttachments(undefined)).toBeUndefined();
		expect(parseAttachments([notes])).toEqual([notes]);
		expect(() => parseAttachments("a1")).toThrow("must be a list");
		expect(() => parseAttachments([{ id: "a1" }])).toThrow("needs an id, name, type, size and kind");
		expect(() => parseAttachments([notes, notes])).toThrow("named twice");
	});

	it("puts the files before the words, and leaves a bare prompt as text", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		expect(userInputOf("Hi", [])).toBe("Hi");
		expect(userInputOf("What is it?", [image])).toEqual([image, { type: "text", text: "What is it?" }]);
		expect(userInputOf("  ", [image])).toEqual([image]);
	});
});
