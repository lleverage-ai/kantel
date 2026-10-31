// The schedule form as plain state and a small flow object with no React in it: a draft as the person types it, what
// it means as a `ScheduleInput` (or which fields are wrong), the next due times it would have, and saving or ending
// through `ScheduleWrites`. The form only renders what the flow says.
//
// Due times come from `@kantel/schedules`' own `previewDue`, the function the scheduler uses, so what the form
// previews is what will run.

import {
	type AgentId,
	type CheckSettings,
	isKantelError,
	type JsonValue,
	type OwnerRef,
	type Recurrence,
	type Schedule,
	type ScheduleInput,
	type Timestamp,
	type Weekday,
} from "@kantel/contracts";
import { assertValidTimeZone, previewDue, utcToZoned, zonedToUtc } from "@kantel/schedules";
import type { ScheduleUpdate } from "../schedules-model.ts";
import {
	type FormKind,
	joinCommand,
	readCheckPayload,
	readTaskPayload,
	type ScheduleWrites,
	splitCommand,
	taskPayload,
} from "./schedule-writes.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** An agent a task can ask, by name. */
export interface ScheduleAgent {
	readonly id: AgentId;
	readonly name: string;
}

export type ScheduleWhen = "repeat" | "once";
export type ScheduleEvery = Recurrence["every"];

export const WEEK: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** The form's fields as the person types them: numbers stay text until the draft is read. */
export interface ScheduleDraft {
	readonly kind: FormKind;
	readonly title: string;
	readonly agentId: string;
	/** Sent to the agent exactly as written: never trimmed or added to. */
	readonly prompt: string;
	/** A check's command line, split into arguments when read. */
	readonly command: string;
	readonly when: ScheduleWhen;
	readonly every: ScheduleEvery;
	/** Minutes, hours or days between runs. */
	readonly interval: string;
	/** `HH:MM`, local to the time zone, for day, weekday, week and month. */
	readonly at: string;
	readonly on: readonly Weekday[];
	/** Day of the month, 1 to 31; 31 is the last day. */
	readonly day: string;
	/** A one-off's local date and time, `YYYY-MM-DDTHH:MM`, as a datetime-local input gives it. */
	readonly once: string;
	readonly timezone: string;
	/** At most this many runs; empty for no limit. */
	readonly count: string;
	readonly reraiseHours: string;
	readonly risingFactor: string;
	readonly failuresBeforeRaise: string;
}

export type DraftField = keyof ScheduleDraft;
export type DraftErrors = Partial<Record<DraftField, string>>;

/** The draft read into the fields `create` and `update` take. */
export interface ReadDraft {
	readonly title: string;
	readonly timezone: string;
	readonly at?: Timestamp;
	readonly repeat?: Recurrence;
	readonly count?: number;
	readonly payload: JsonValue;
	readonly check?: CheckSettings;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A moment as a datetime-local value in `timezone`. */
export function localInputValue(at: Timestamp, timezone: string): string {
	const zoned = utcToZoned(at, timezone);
	return `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}T${pad(zoned.hour)}:${pad(zoned.minute)}`;
}

/** The browser's own time zone, or UTC. */
export function localTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** A new draft: a task every 10 minutes asking the first agent, or a check on the same timing. */
export function emptyDraft(options: {
	readonly kind?: FormKind;
	readonly agents: readonly ScheduleAgent[];
	readonly timezone: string;
	readonly now: number;
}): ScheduleDraft {
	const nextHour = Math.ceil((options.now + MINUTE_MS) / HOUR_MS) * HOUR_MS;
	return {
		kind: options.kind ?? "task",
		title: "",
		agentId: options.agents[0]?.id ?? "",
		prompt: "",
		command: "",
		when: "repeat",
		every: "minutes",
		interval: "10",
		at: "09:00",
		on: ["mon"],
		day: "1",
		once: localInputValue(nextHour, options.timezone),
		timezone: options.timezone,
		count: "",
		reraiseHours: "",
		risingFactor: "",
		failuresBeforeRaise: "",
	};
}

const text = (value: number | undefined) => (value === undefined ? "" : String(value));

/** The draft for editing a schedule. A payload the form doesn't recognise is left empty and isn't written back. */
export function draftFromSchedule(schedule: Schedule, now: number): ScheduleDraft {
	const kind: FormKind = schedule.kind === "check" ? "check" : "task";
	const task = readTaskPayload(schedule.payload);
	const command = readCheckPayload(schedule.payload);
	const repeat = schedule.repeat;
	return {
		...emptyDraft({ kind, agents: [], timezone: schedule.timezone, now }),
		title: schedule.title,
		agentId: task?.agentId ?? "",
		prompt: task?.prompt ?? "",
		command: command === undefined ? "" : joinCommand(command),
		when: repeat === undefined ? "once" : "repeat",
		...(repeat === undefined
			? {}
			: {
					every: repeat.every,
					...("interval" in repeat && repeat.interval !== undefined ? { interval: String(repeat.interval) } : {}),
					...("at" in repeat ? { at: repeat.at } : {}),
					...(repeat.every === "week" ? { on: repeat.on } : {}),
					...(repeat.every === "month" ? { day: String(repeat.day) } : {}),
				}),
		...(schedule.at === undefined ? {} : { once: localInputValue(schedule.at, schedule.timezone) }),
		count: text(schedule.count),
		reraiseHours: text(schedule.check?.reraiseHours),
		risingFactor: text(schedule.check?.risingFactor),
		failuresBeforeRaise: text(schedule.check?.failuresBeforeRaise),
	};
}

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_MOMENT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const wholeNumber = (value: string): number | undefined => {
	const trimmed = value.trim();
	return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
};

const positiveNumber = (value: string): number | undefined => {
	const parsed = Number(value.trim());
	return value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/** Whether the form can write this schedule's payload: a task with an agent and a prompt, or a check's command. */
export function payloadEditable(schedule: Pick<Schedule, "kind" | "payload">): boolean {
	if (schedule.kind === "task") return readTaskPayload(schedule.payload) !== undefined;
	if (schedule.kind === "check") return readCheckPayload(schedule.payload) !== undefined;
	return false;
}

/**
 * The draft as `create` or `update` fields, or each wrong field's error. `editing` keeps an interval schedule's `from`
 * (so editing its title doesn't shift when it runs) and lets a payload the form can't edit stand.
 */
export function readDraft(
	draft: ScheduleDraft,
	now: number,
	editing?: Schedule,
): { readonly ok: true; readonly value: ReadDraft } | { readonly ok: false; readonly errors: DraftErrors } {
	const errors: DraftErrors = {};
	const title = draft.title.trim();
	if (title === "") errors.title = "Give it a title you'll recognise in the list.";

	let payload: JsonValue | undefined;
	const keepPayload = editing !== undefined && !payloadEditable(editing);
	if (keepPayload) payload = editing.payload;
	else if (draft.kind === "task") {
		if (draft.agentId === "") errors.agentId = "Pick the agent to ask.";
		if (draft.prompt.trim() === "") errors.prompt = "Write what to ask the agent.";
		payload = taskPayload({ agentId: draft.agentId, prompt: draft.prompt });
	} else {
		const command = splitCommand(draft.command);
		if (command.length === 0) errors.command = "Give the command to run, such as checks/disk-free.sh --min 15%.";
		payload = command;
	}

	const timezone = draft.timezone.trim();
	try {
		assertValidTimeZone(timezone);
	} catch {
		errors.timezone = "Pick a time zone, such as Europe/London.";
	}

	let repeat: Recurrence | undefined;
	let at: Timestamp | undefined;
	if (draft.when === "once") {
		const match = LOCAL_MOMENT.exec(draft.once);
		if (match === null) errors.once = "Pick a date and time.";
		else if (errors.timezone === undefined) {
			const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
			at = zonedToUtc(year, month, day, hour, minute, timezone);
			if (at <= now) errors.once = "Pick a time in the future.";
		}
	} else {
		const interval = wholeNumber(draft.interval);
		const needsInterval = draft.every === "minutes" || draft.every === "hours" || draft.every === "day";
		if (needsInterval && (interval === undefined || interval < 1)) errors.interval = "Use a whole number, 1 or more.";
		const needsAt = !(draft.every === "minutes" || draft.every === "hours");
		if (needsAt && !LOCAL_TIME.test(draft.at)) errors.at = "Use a 24-hour time, such as 09:00.";
		const day = wholeNumber(draft.day);
		if (draft.every === "month" && (day === undefined || day < 1 || day > 31)) {
			errors.day = "Use a day from 1 to 31; 31 means the last day.";
		}
		if (draft.every === "week" && draft.on.length === 0) errors.on = "Pick at least one day.";
		switch (draft.every) {
			case "minutes":
			case "hours": {
				const kept = editing?.repeat?.every === draft.every ? editing.repeat.from : undefined;
				repeat = {
					every: draft.every,
					interval: interval ?? 1,
					from: kept ?? Math.floor(now / MINUTE_MS) * MINUTE_MS,
				};
				break;
			}
			case "day":
				repeat =
					interval === undefined || interval === 1
						? { every: "day", at: draft.at }
						: { every: "day", at: draft.at, interval };
				break;
			case "weekday":
				repeat = { every: "weekday", at: draft.at };
				break;
			case "week":
				repeat = { every: "week", at: draft.at, on: WEEK.filter((weekday) => draft.on.includes(weekday)) };
				break;
			case "month":
				repeat = { every: "month", at: draft.at, day: day ?? 1 };
				break;
		}
	}

	let count: number | undefined;
	if (draft.count.trim() !== "") {
		count = wholeNumber(draft.count);
		if (count === undefined || count < 1) errors.count = "Use a whole number, 1 or more, or leave it empty.";
	}

	let check: CheckSettings | undefined;
	if (draft.kind === "check") {
		const settings: { reraiseHours?: number; risingFactor?: number; failuresBeforeRaise?: number } = {};
		if (draft.reraiseHours.trim() !== "") {
			const value = positiveNumber(draft.reraiseHours);
			if (value === undefined) errors.reraiseHours = "Use a number of hours above 0.";
			else settings.reraiseHours = value;
		}
		if (draft.risingFactor.trim() !== "") {
			const value = positiveNumber(draft.risingFactor);
			if (value === undefined || value <= 1) errors.risingFactor = "Use a factor above 1, such as 2.";
			else settings.risingFactor = value;
		}
		if (draft.failuresBeforeRaise.trim() !== "") {
			const value = wholeNumber(draft.failuresBeforeRaise);
			if (value === undefined || value < 1) errors.failuresBeforeRaise = "Use a whole number, 1 or more.";
			else settings.failuresBeforeRaise = value;
		}
		if (Object.keys(settings).length > 0) check = settings;
	}

	if (Object.keys(errors).length > 0 || payload === undefined) return { ok: false, errors };
	return {
		ok: true,
		value: {
			title,
			timezone,
			...(at === undefined ? {} : { at }),
			...(repeat === undefined ? {} : { repeat }),
			...(count === undefined ? {} : { count }),
			payload,
			...(check === undefined ? {} : { check }),
		},
	};
}

/** A new schedule's input. */
export function createInput(value: ReadDraft, kind: FormKind, owner: OwnerRef): ScheduleInput {
	return { owner, kind, ...value };
}

/**
 * An edit's fields. Switching between a one-off and a recurrence sends the other as `null`, and a cleared limit sends
 * `count` as `null`, so the store clears them: `null`, unlike undefined, survives the PATCH body's JSON. The form has
 * no end date, so it leaves `until` out and the schedule keeps its own.
 */
export function updateInput(value: ReadDraft, schedule: Schedule): ScheduleUpdate {
	return {
		title: value.title,
		timezone: value.timezone,
		at: value.at ?? null,
		repeat: value.repeat ?? null,
		count: value.count ?? null,
		payload: value.payload,
		...(schedule.kind === "check" ? { check: value.check } : {}),
	};
}

/**
 * The next `n` due times the draft would have from `now`, or undefined while the timing fields are wrong. An edit
 * counts the runs the schedule has had against its limit and keeps its `until`.
 */
export function previewDraft(
	draft: ScheduleDraft,
	now: number,
	n: number,
	editing?: Schedule,
): readonly Timestamp[] | undefined {
	const read = readDraft(draft, now, editing);
	const timingErrors: readonly DraftField[] = ["timezone", "once", "interval", "at", "day", "on", "count"];
	if (!read.ok && timingErrors.some((field) => read.errors[field] !== undefined)) return undefined;
	const timing = read.ok ? read.value : timingOnly(draft, now, editing);
	if (timing === undefined) return undefined;
	return previewDue(
		{
			timezone: timing.timezone,
			...(timing.at === undefined ? {} : { at: timing.at }),
			...(timing.repeat === undefined ? {} : { repeat: timing.repeat }),
			...(editing?.until === undefined ? {} : { until: editing.until }),
			...(timing.count === undefined ? {} : { count: timing.count }),
			occurrences: editing?.occurrences ?? 0,
			createdAt: editing?.createdAt ?? now,
		},
		now,
		n,
	);
}

/** The timing alone, when only the title or payload is wrong, so the preview still shows. */
function timingOnly(draft: ScheduleDraft, now: number, editing?: Schedule): ReadDraft | undefined {
	const filled: ScheduleDraft = {
		...draft,
		title: draft.title.trim() === "" ? "x" : draft.title,
		agentId: draft.agentId === "" ? "x" : draft.agentId,
		prompt: draft.prompt.trim() === "" ? "x" : draft.prompt,
		command: draft.command.trim() === "" ? "x" : draft.command,
		reraiseHours: "",
		risingFactor: "",
		failuresBeforeRaise: "",
	};
	const read = readDraft(filled, now, editing);
	return read.ok ? read.value : undefined;
}

export type ScheduleFormProblem =
	| { readonly kind: "forbidden" }
	| { readonly kind: "not-found" }
	| { readonly kind: "ended" }
	/** The server's own words, for input it refused. */
	| { readonly kind: "invalid"; readonly message: string }
	| { readonly kind: "unavailable" };

/** What a failed call means for the form. */
export function scheduleFormProblem(error: unknown): ScheduleFormProblem {
	if (isKantelError(error, "forbidden")) return { kind: "forbidden" };
	if (isKantelError(error, "not_found")) return { kind: "not-found" };
	if (isKantelError(error, "conflict")) return { kind: "ended" };
	if (isKantelError(error, "invalid")) return { kind: "invalid", message: error.message };
	return { kind: "unavailable" };
}

export interface ScheduleFormState {
	readonly draft: ScheduleDraft;
	/** Shown once the person has tried to save, so a half-typed form isn't red. */
	readonly errors: DraftErrors;
	readonly saving: boolean;
	readonly problem?: ScheduleFormProblem;
	/** End is waiting for its confirmation. */
	readonly confirmingEnd: boolean;
	readonly ending: boolean;
}

export interface ScheduleFormFlow {
	getState(): ScheduleFormState;
	subscribe(listener: () => void): () => void;
	edit(patch: Partial<ScheduleDraft>): void;
	/** Creates the schedule, or saves the edit; resolves with it, or undefined when it didn't save. */
	save(): Promise<Schedule | undefined>;
	askEnd(): void;
	cancelEnd(): void;
	/** Ends the schedule being edited; resolves with it, or undefined when it didn't end. */
	end(): Promise<Schedule | undefined>;
}

export interface ScheduleFormFlowOptions {
	readonly writes: ScheduleWrites;
	/** Who owns a new schedule: the project the console is in, or the person. */
	readonly owner: OwnerRef;
	readonly draft: ScheduleDraft;
	/** The schedule being edited; absent to create one. */
	readonly schedule?: Schedule;
	readonly now?: () => number;
	/** Show the draft's errors from the start, as after a refused save: for stories. */
	readonly validate?: boolean;
	/** Where the form starts, for stories. */
	readonly initial?: Partial<Pick<ScheduleFormState, "saving" | "problem" | "confirmingEnd" | "ending">>;
}

export function createScheduleFormFlow(options: ScheduleFormFlowOptions): ScheduleFormFlow {
	const { writes, schedule } = options;
	const now = options.now ?? Date.now;
	let tried = options.validate === true;
	const first = tried ? readDraft(options.draft, now(), schedule) : undefined;
	let state: ScheduleFormState = {
		draft: options.draft,
		errors: first === undefined || first.ok ? {} : first.errors,
		saving: false,
		confirmingEnd: false,
		ending: false,
		...options.initial,
	};
	const listeners = new Set<() => void>();
	const set = (next: ScheduleFormState) => {
		state = next;
		for (const listener of listeners) listener();
	};
	const withoutProblem = ({ problem, ...rest }: ScheduleFormState): ScheduleFormState => rest;

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		edit(patch) {
			if (state.saving || state.ending) return;
			const draft = { ...state.draft, ...patch };
			// Once a save was refused, errors follow the typing, so each clears as it's fixed.
			const read = tried ? readDraft(draft, now(), schedule) : undefined;
			set({ ...withoutProblem(state), draft, errors: read === undefined || read.ok ? {} : read.errors });
		},

		async save() {
			if (state.saving || state.ending) return undefined;
			tried = true;
			const read = readDraft(state.draft, now(), schedule);
			if (!read.ok) {
				set({ ...withoutProblem(state), errors: read.errors });
				return undefined;
			}
			set({ ...withoutProblem(state), errors: {}, saving: true, confirmingEnd: false });
			try {
				const saved =
					schedule === undefined
						? await writes.create(createInput(read.value, state.draft.kind, options.owner))
						: await writes.update(schedule.id, updateInput(read.value, schedule));
				set({ ...state, saving: false });
				return saved;
			} catch (error) {
				set({ ...state, saving: false, problem: scheduleFormProblem(error) });
				return undefined;
			}
		},

		askEnd() {
			if (schedule === undefined || state.saving || state.ending) return;
			set({ ...withoutProblem(state), confirmingEnd: true });
		},

		cancelEnd() {
			if (state.ending) return;
			set({ ...state, confirmingEnd: false });
		},

		async end() {
			if (schedule === undefined || state.ending || !state.confirmingEnd) return undefined;
			set({ ...withoutProblem(state), ending: true });
			try {
				const ended = await writes.end(schedule.id);
				set({ ...state, ending: false, confirmingEnd: false });
				return ended;
			} catch (error) {
				set({ ...state, ending: false, problem: scheduleFormProblem(error) });
				return undefined;
			}
		},
	};
}
