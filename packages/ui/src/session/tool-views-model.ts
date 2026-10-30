// What the file and shell tools' cards show, from a tool item: which card a call gets (`toolView`), its label, and the
// harness's notes split off its output. Pure, so the cards' states are tested without a DOM.
//
// The four tools are Pi Durable's coding tools as Harbour registers them (`@harbour/sandbox`'s `codingTools`):
// `read { path, offset?, limit? }`, `write { path, content }`, `edit { path, edits: [{ oldText, newText }] }` and
// `bash { command, timeout? }`. While a call streams in, its arguments are the model's partial JSON parsed so far, so
// any field may be missing or cut short; every reader here takes what is there.

import type { ToolItem } from "@harbour/protocol";
import type { DiffEdit } from "../code/diff-view.tsx";

export type ToolView =
	| { readonly kind: "write"; readonly path: string; readonly content: string }
	| { readonly kind: "read"; readonly path: string; readonly offset?: number; readonly limit?: number }
	| { readonly kind: "edit"; readonly path: string; readonly edits: readonly DiffEdit[] }
	| { readonly kind: "bash"; readonly command: string; readonly timeout?: number };

export type ToolViewKind = ToolView["kind"];

type Args = { readonly [key: string]: unknown };

const record = (value: unknown): Args | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : undefined;
const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

function editsOf(args: Args): DiffEdit[] | undefined {
	let edits: unknown = args.edits;
	if (typeof edits === "string") {
		// Some models send the array as a JSON string; the tool parses it, so the card does too.
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	const list: DiffEdit[] = [];
	const add = (value: unknown) => {
		const edit = record(value);
		if (edit === undefined) return;
		const oldText = string(edit.oldText);
		const newText = string(edit.newText);
		if (oldText === undefined && newText === undefined) return;
		list.push({ oldText: oldText ?? "", newText: newText ?? "" });
	};
	if (Array.isArray(edits)) for (const edit of edits) add(edit);
	else add(edits);
	// The single-edit form: `oldText` and `newText` beside `path`.
	if (string(args.oldText) !== undefined || string(args.newText) !== undefined) add(args);
	if (list.length === 0 && edits !== undefined && !Array.isArray(edits) && record(edits) === undefined)
		return undefined;
	return list;
}

/**
 * The card a call gets, or `undefined` for the generic arguments and output. Only the coding tools by their exact
 * names, and only when their arguments have the expected shape (an empty object while the call starts streaming). A
 * finished edit with no edits to show keeps the generic detail, which shows whatever it was sent.
 */
export function toolView(item: Pick<ToolItem, "name" | "args" | "streaming">): ToolView | undefined {
	const args = item.args === undefined ? {} : record(item.args);
	if (args === undefined) return undefined;
	const path = args.path === undefined ? "" : string(args.path);
	switch (item.name) {
		case "write": {
			const content = args.content === undefined ? "" : string(args.content);
			if (path === undefined || content === undefined) return undefined;
			return { kind: "write", path, content };
		}
		case "read": {
			if (path === undefined) return undefined;
			const offset = positive(args.offset);
			const limit = positive(args.limit);
			return {
				kind: "read",
				path,
				...(offset === undefined ? {} : { offset }),
				...(limit === undefined ? {} : { limit }),
			};
		}
		case "edit": {
			const edits = editsOf(args);
			if (path === undefined || edits === undefined) return undefined;
			if (edits.length === 0 && item.streaming !== true) return undefined;
			return { kind: "edit", path, edits };
		}
		case "bash": {
			const command = args.command === undefined ? "" : string(args.command);
			if (command === undefined) return undefined;
			const timeout = positive(args.timeout);
			return { kind: "bash", command, ...(timeout === undefined ? {} : { timeout }) };
		}
		default:
			return undefined;
	}
}

/** Whether a call's card shows without opening its row: what was written, changed or run. A read waits to be opened. */
export const openByDefault = (view: ToolView | undefined): boolean => view !== undefined && view.kind !== "read";

/** A command as a label: its first line, cut at 72 characters. */
export function shortCommand(command: string, max = 72): string {
	const trimmed = command.trim();
	const line = trimmed.split("\n")[0] ?? "";
	const more = line.length > max || trimmed.includes("\n");
	return more ? `${line.slice(0, max).trimEnd()}\u2026` : line;
}

/**
 * The row's label for a card: "Writing notes/plan.py" while it runs or streams in, "Wrote notes/plan.py" once it has
 * ended (a failure is said by the row's icon), "Writing a file" before the path has arrived.
 */
export function toolViewLabel(view: ToolView, status: ToolItem["status"]): string {
	const running = status === "running";
	switch (view.kind) {
		case "write":
			return view.path === "" ? "Writing a file" : `${running ? "Writing" : "Wrote"} ${view.path}`;
		case "read":
			return view.path === "" ? "Reading a file" : `${running ? "Reading" : "Read"} ${view.path}`;
		case "edit":
			return view.path === "" ? "Editing a file" : `${running ? "Editing" : "Edited"} ${view.path}`;
		case "bash": {
			const command = shortCommand(view.command);
			return command === "" ? "Running a command" : `${running ? "Running" : "Ran"} ${command}`;
		}
	}
}

export type HarnessNote = { readonly severity: "error" | "warn" | "info"; readonly message: string };

const HARNESS = /<harness>\n?([\s\S]*?)\n?<\/harness>\s*$/;
const NOTE = /^\[(error|warn|warning|info)\]\s*(.*)$/;

/**
 * A tool's output with the harness's notes taken off its end. Pi Durable appends a call's diagnostics to what the
 * model sees as `<harness>[error] Command exited with code 2</harness>`; the cards show those as a status and notes,
 * not as tags in the output.
 */
export function splitHarness(output: string): { body: string; notes: HarnessNote[] } {
	const match = HARNESS.exec(output);
	if (match === null) return { body: output, notes: [] };
	const notes: HarnessNote[] = [];
	for (const line of (match[1] ?? "").split("\n")) {
		const text = line.trim();
		if (text === "") continue;
		const note = NOTE.exec(text);
		if (note === null) {
			const last = notes.pop();
			notes.push(
				last === undefined ? { severity: "info", message: text } : { ...last, message: `${last.message} ${text}` },
			);
			continue;
		}
		const severity = note[1] === "warning" ? "warn" : (note[1] as HarnessNote["severity"]);
		notes.push({ severity, message: note[2] ?? "" });
	}
	return { body: output.slice(0, match.index), notes };
}

const EXITED = /^Command exited with code (-?\d+)$/;

/** How a command ended, from its status and the harness's notes. */
export type CommandEnd =
	| { readonly kind: "running" }
	| { readonly kind: "exited"; readonly code: number }
	| { readonly kind: "timed-out"; readonly message: string }
	| { readonly kind: "interrupted" }
	| { readonly kind: "failed"; readonly message?: string };

/**
 * A command's end and the notes left to show: "Command exited with code 2" becomes the exit code and is not repeated
 * as a note. A call that ended done exited 0. A timeout or another failure without an exit code says why in `message`.
 */
export function commandEnd(
	status: ToolItem["status"],
	body: string,
	notes: readonly HarnessNote[],
): { end: CommandEnd; notes: HarnessNote[] } {
	const rest: HarnessNote[] = [];
	let code: number | undefined;
	for (const note of notes) {
		const exited = EXITED.exec(note.message);
		if (exited !== null && code === undefined) code = Number(exited[1]);
		else rest.push(note);
	}
	switch (status) {
		case "running":
			return { end: { kind: "running" }, notes: rest };
		case "interrupted":
			return { end: { kind: "interrupted" }, notes: rest };
		case "done":
			return { end: { kind: "exited", code: code ?? 0 }, notes: rest };
		case "error": {
			if (code !== undefined) return { end: { kind: "exited", code }, notes: rest };
			// A thrown failure (a timeout, an abort, a refusal) is the result's text, and the output may be only that.
			const lastLine = body.trimEnd().split("\n").at(-1) ?? "";
			const timeout = /timed out/i.test(lastLine)
				? lastLine
				: rest.find((note) => /timed out/i.test(note.message))?.message;
			if (timeout !== undefined) return { end: { kind: "timed-out", message: timeout }, notes: rest };
			const error = rest.find((note) => note.severity === "error");
			return { end: { kind: "failed", ...(error === undefined ? {} : { message: error.message }) }, notes: rest };
		}
	}
}

/**
 * The lines a read returned, as numbers in the file: from its `offset` (1 when none) for as many lines as its output
 * has. "Lines 120 to 180" when it read part of the file, which a limit, an offset or the harness's truncation note says.
 */
export function readRange(
	view: Extract<ToolView, { kind: "read" }>,
	lineCount: number,
	notes: readonly HarnessNote[],
): { start: number; end: number; partial: boolean } {
	const start = Math.max(1, Math.floor(view.offset ?? 1));
	const end = start + Math.max(0, lineCount - 1);
	const partial =
		view.offset !== undefined ||
		view.limit !== undefined ||
		notes.some((note) => /^Showing lines|more lines in file/.test(note.message));
	return { start, end, partial };
}
