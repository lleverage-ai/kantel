// The design loop's per-component specs: what each of the loop's five components owes (the States gate) and the
// fixed scenario that measures it (loop/harness). Plain data, shared by the harness page, measure.ts and gates.ts.
// A variant may not change a spec; it is the workload every variant is measured on.

/** The states every loop component owes a story for, as story-name slugs. */
export const requiredStates = ["default", "loading", "empty", "streaming", "error", "long-content", "mobile"] as const;

export type ComponentSpec = {
	/** The component, as exported from @kantel/ui. */
	component: string;
	/** Its workbench stories' id prefix: the States gate wants `<stories>--<state>` for each required state. */
	stories: string;
	/** The harness scenario that measures it. */
	scenario: string;
	/** Components whose renders the probe counts in this scenario (see src/primitives/probe.ts). */
	watched: readonly string[];
	/** What the scenario does, for the results. */
	workload: string;
	/** What the interaction latency is the latency of. */
	interaction: string;
	/** The module whose exports the bundle cost is measured for, and the export. */
	bundle: { module: string; exports: readonly string[] };
};

export const specs: readonly ComponentSpec[] = [
	{
		component: "Transcript",
		stories: "session--transcript",
		scenario: "transcript",
		watched: ["TranscriptRow", "UserMessage", "AssistantMessage", "ToolCallChip"],
		workload:
			"300 earlier items (75 turns), then an answer streams 400 words in 40 updates, one per frame. Wasted: renders of any row but the streaming one.",
		interaction: "Wheel scroll up the transcript, 20 steps of 300px: event to next frame.",
		bundle: { module: "src/session/transcript.tsx", exports: ["Transcript"] },
	},
	{
		component: "ToolCallChip",
		stories: "session--tool-call",
		scenario: "tool-group",
		watched: ["ToolCallChip"],
		workload:
			"A live group of 12 calls; the last one's output grows in 10 updates, then it finishes. Wasted: renders of the 11 calls that did not change.",
		interaction: "Click each of the 12 chips open: click to next frame.",
		bundle: { module: "src/session/tool-call.tsx", exports: ["ToolCallChip", "ToolCallGroup"] },
	},
	{
		component: "Composer",
		stories: "session--composer",
		scenario: "composer",
		watched: ["Composer"],
		workload: "An idle composer with a send hint; 60 characters are typed.",
		interaction: "A keystroke: keydown to next frame.",
		bundle: { module: "src/session/composer.tsx", exports: ["Composer", "ComposerSendHint"] },
	},
	{
		component: "SessionListItem",
		stories: "session--session-list",
		scenario: "session-list",
		watched: ["SessionListItem"],
		workload:
			"200 sessions, grouped. One session at a time changes 20 times (its title, then its status, so it moves group). Wasted: renders of any row but the one that changed.",
		interaction: "Click 20 rows to select them: click to next frame. Each click must render two rows.",
		bundle: { module: "src/session/session-list.tsx", exports: ["SessionList", "SessionListItem"] },
	},
	{
		component: "VaultApprovalCard",
		stories: "session--vault-approval-card",
		scenario: "vault-card",
		watched: ["VaultApprovalCard", "VaultTerms"],
		workload:
			"A pending card counting down, for 5 ticks of its one-second clock. Wasted: renders of the terms list, whose text changes once a minute.",
		interaction: "Pick a binding code with the arrow keys, 12 times: keydown to next frame.",
		bundle: {
			module: "src/session/vault-approval-card.tsx",
			exports: ["VaultApprovalCard", "BindingCodePicker"],
		},
	},
];

export const specFor = (scenario: string): ComponentSpec | undefined =>
	specs.find((spec) => spec.scenario === scenario);

/** The States gate: the required story ids missing from a built workbench's story ids. */
export function missingStates(storyIds: readonly string[]): string[] {
	const have = new Set(storyIds);
	return specs.flatMap((spec) =>
		requiredStates.map((state) => `${spec.stories}--${state}`).filter((id) => !have.has(id)),
	);
}
