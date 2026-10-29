// What the schedule form changes, and the payloads it writes. The calls are the schedules page's `SchedulesSource`'s
// writes (`create`, `update`, `end`), so any source the page reads from, the fixtures or the console's API client,
// is one the form saves through.

import type { AgentId, JsonValue, ScheduleKind } from "@harbour/contracts";
import type { SchedulesSource } from "../schedules-model.ts";

/**
 * What the form calls: `POST /v1/schedules`, `PATCH /v1/schedules/{scheduleId}` and `DELETE /v1/schedules/{scheduleId}`
 * (which ends a schedule; the contract has no delete, so the form's "End schedule" is this call).
 */
export type ScheduleWrites = Pick<SchedulesSource, "create" | "update" | "end">;

/** The kinds the form creates and edits. Other kinds open read-only on the schedules page. */
export type FormKind = Extract<ScheduleKind, "task" | "check">;

export const isFormKind = (kind: ScheduleKind): kind is FormKind => kind === "task" || kind === "check";

/**
 * A task's payload: at each due time the runner starts a session with this agent, in the schedule's project, and sends
 * `prompt` as the first message exactly as the person wrote it. Harbour adds nothing to it.
 */
export interface TaskPayload {
	readonly agentId: AgentId;
	readonly prompt: string;
}

/** A check's payload: the command and its arguments, run with no model. Exit 0 is healthy, 3 is findings. */
export type CheckPayload = readonly string[];

export const taskPayload = (payload: TaskPayload): JsonValue => ({ agentId: payload.agentId, prompt: payload.prompt });

/** A task payload the form can edit, or undefined for any other shape (which the form then won't overwrite). */
export function readTaskPayload(payload: JsonValue): TaskPayload | undefined {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const { agentId, prompt } = payload as { readonly [key: string]: JsonValue };
	return typeof agentId === "string" && typeof prompt === "string" ? { agentId, prompt } : undefined;
}

/** A check's command as the form shows it: an argument list, or a single command string. */
export function readCheckPayload(payload: JsonValue): CheckPayload | undefined {
	if (typeof payload === "string") return splitCommand(payload);
	if (Array.isArray(payload) && payload.every((part) => typeof part === "string")) return payload as readonly string[];
	return undefined;
}

/**
 * A command line split into its arguments, as a shell would for plain words and quotes: `checks/disk.sh --min "15 %"`
 * is three arguments. No variables, globs or escapes beyond a backslash before a quote or a space.
 */
export function splitCommand(line: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index] as string;
		if (char === "\\" && quote !== "'" && index + 1 < line.length) {
			current += line[index + 1];
			started = true;
			index += 1;
		} else if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) parts.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (started) parts.push(current);
	return parts;
}

/** An argument list as one line the person can edit, quoting any argument with a space or a quote in it. */
export function joinCommand(parts: readonly string[]): string {
	return parts
		.map((part) => (part === "" || /[\s"'\\]/.test(part) ? `"${part.replaceAll(/["\\]/g, (c) => `\\${c}`)}"` : part))
		.join(" ");
}
