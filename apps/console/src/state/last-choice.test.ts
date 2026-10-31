import type { UserPreferencesChange } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { keptChoice } from "./last-choice.ts";

describe("keptChoice", () => {
	it("starts from the person's kept preferences", () => {
		const kept = keptChoice({ theme: "harbour", lastModel: "default:gpt-5", lastThinking: "high" }, async () => {});
		expect(kept.lastChoice()).toEqual({ model: "default:gpt-5", thinking: "high" });
		expect(keptChoice(undefined, async () => {}).lastChoice()).toEqual({});
	});

	it("writes a new choice back once, only what changed, and offers it next", async () => {
		const saved: UserPreferencesChange[] = [];
		const kept = keptChoice({ lastModel: "default", lastThinking: "medium" }, async (change) => {
			saved.push(change);
		});
		kept.rememberChoice({ model: "default", thinking: "medium" });
		kept.rememberChoice({ model: "default:gpt-5", thinking: "medium" });
		kept.rememberChoice({ model: "default:gpt-5", thinking: "medium" });
		kept.rememberChoice({ model: "default:gpt-5", thinking: "xhigh" });
		// A model that can't think sends no level: the kept level stays.
		kept.rememberChoice({ model: "default:grok-code-fast" });
		expect(saved).toEqual([
			{ lastModel: "default:gpt-5" },
			{ lastThinking: "xhigh" },
			{ lastModel: "default:grok-code-fast" },
		]);
		expect(kept.lastChoice()).toEqual({ model: "default:grok-code-fast", thinking: "xhigh" });
	});

	it("keeps the choice in the page when the server can't", async () => {
		const kept = keptChoice({}, () => Promise.reject(new Error("offline")));
		kept.rememberChoice({ model: "default:gpt-5", thinking: "low" });
		await Promise.resolve();
		expect(kept.lastChoice()).toEqual({ model: "default:gpt-5", thinking: "low" });
	});
});
