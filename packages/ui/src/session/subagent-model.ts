import type { ToolItem } from "@harbour/protocol";

// A subagent's call, read for its card: which calls are subagents, and what the card says about one.

/** The tool whose calls are subagents: Harbour's `subagent` tool (the Cloudflare stack's `src/subagent.ts`). */
export const SUBAGENT_TOOL = "subagent";

/** Whether a tool call is a subagent's, shown as a card rather than a line in a group of calls. */
export const isSubagentCall = (item: ToolItem): boolean => item.name === SUBAGENT_TOOL;

/** The most of a subagent's answer the card says: the opening of it, in plain words. */
const SUMMARY_CHARS = 280;

/** Markdown as one line of plain words: links as their text, no code ticks, emphasis, headings or list marks. */
export function plainText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
		.replace(/[`*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

/** What a subagent call's card shows, from the call: its title, its task and, once it has one, its answer. */
export function subagentOf(item: ToolItem): {
	readonly title: string;
	readonly task: string | undefined;
	readonly summary: string | undefined;
} {
	const args = (typeof item.args === "object" && item.args !== null ? item.args : {}) as {
		readonly task?: unknown;
		readonly title?: unknown;
	};
	const task = typeof args.task === "string" && args.task.trim() !== "" ? args.task.trim() : undefined;
	const given = typeof args.title === "string" ? args.title.trim() : "";
	const title = given !== "" ? given : task === undefined ? "Subagent" : plainText(firstLine(task)) || "Subagent";
	const output = item.status === "running" ? "" : plainText(item.output ?? "");
	const summary = output === "" ? undefined : output.slice(0, SUMMARY_CHARS);
	return { title, task: task === undefined ? undefined : plainText(task), summary };
}
