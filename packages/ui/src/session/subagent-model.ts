import type { ToolItem, TranscriptItem } from "@harbour/protocol";

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

/** The most of a subagent's latest activity the card says: a line. */
const ACTIVITY_CHARS = 160;

const lastLine = (text: string): string =>
	text
		.split("\n")
		.map((line) => plainText(line))
		.filter((line) => line !== "")
		.at(-1) ?? "";

/**
 * What a working subagent is doing now, from its own session's transcript, as T3 Code's card shows a running
 * subagent's progress: the call it is making (one of its own subagents by title), else the last line it wrote, else
 * that it is thinking. Undefined before it has done anything after its task.
 */
export function subagentActivity(items: readonly TranscriptItem[]): string | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item === undefined || item.kind === "user") return undefined;
		if (item.kind === "tool") {
			const line = isSubagentCall(item)
				? `${item.status === "running" ? "Waiting on its subagent" : "Heard back from its subagent"}: ${subagentOf(item).title}`
				: item.label;
			return line.slice(0, ACTIVITY_CHARS);
		}
		if (item.kind === "assistant") {
			const line = lastLine(item.text);
			if (line !== "") return line.slice(0, ACTIVITY_CHARS);
			if ((item.thinking ?? "") !== "") return "Thinking";
		}
	}
	return undefined;
}

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
