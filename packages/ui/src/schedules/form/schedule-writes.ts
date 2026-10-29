// What the schedule form changes, and the payloads it writes. The calls are `Schedules`' `create`, `update` and `end`
// with the viewer's call context already bound, so the form never holds one; they are shaped like the public API's
// schedule routes (one route per contract call, after issue #150), so the console's API client fits them as it is.

import type {
	AgentId,
	CallContext,
	JsonValue,
	Schedule,
	ScheduleInput,
	ScheduleKind,
	Schedules,
} from "@harbour/contracts";

/** The fields `update` may change: everything but the owner and the kind, which are fixed at create. */
export type ScheduleUpdate = Partial<Omit<ScheduleInput, "owner" | "kind">>;

/**
 * What the form calls. Failures reject with Harbour's `HarbourError`s: `invalid` (with the server's reason),
 * `forbidden`, `not_found`, or anything else when Harbour can't answer.
 *
 * Named and shaped to sit beside the schedules page's read calls (`list`, `get`, `preview`, `listOccurrences`, `pause`,
 * `resume`) as one client over the schedule routes.
 */
export interface ScheduleWrites {
	create(input: ScheduleInput): Promise<Schedule>;
	update(scheduleId: string, input: ScheduleUpdate): Promise<Schedule>;
	/**
	 * Ends the schedule for good: nothing more runs, and it stays in the list as ended with its run history. The
	 * contract has no delete; the form's "End schedule" is this call.
	 */
	end(scheduleId: string): Promise<Schedule>;
}

export type ScheduleWritesApi = Pick<Schedules, "create" | "update" | "end">;

/** The form's calls over `Schedules`, as the viewer `ctx`. */
export function bindScheduleWrites(schedules: ScheduleWritesApi, ctx: CallContext): ScheduleWrites {
	return {
		create: (input) => schedules.create(ctx, input),
		update: (id, input) => schedules.update(ctx, id, input),
		end: (id) => schedules.end(ctx, id),
	};
}

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
