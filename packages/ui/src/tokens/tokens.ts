/**
 * The tokens' names for TypeScript. Values live only in tokens.css; this file names them so code can refer to a token
 * without a raw value (`style={{ color: token.status.working }}`), and maps Kantel's states onto the status colours.
 */

export type Status = "working" | "waiting" | "approval" | "done" | "error" | "idle";

/** The words for each status, in sentence case. "Waiting" means waiting on an answer from you. */
export const statusLabel: Readonly<Record<Status, string>> = {
	working: "Working",
	waiting: "Needs your answer",
	approval: "Needs approval",
	done: "Done",
	error: "Failed",
	idle: "Idle",
};

const v = (name: string): string => `var(--kt-${name})`;

export const token = {
	surface: {
		canvas: v("canvas"),
		panel: v("panel"),
		raised: v("raised"),
		sunken: v("sunken"),
	},
	text: {
		default: v("text"),
		muted: v("text-muted"),
		faint: v("text-faint"),
	},
	accent: v("accent"),
	accentText: v("accent-text"),
	border: v("border"),
	status: {
		working: v("status-working"),
		waiting: v("status-waiting"),
		approval: v("status-approval"),
		done: v("status-done"),
		error: v("status-error"),
		idle: v("status-idle"),
	} satisfies Record<Status, string>,
	contentWidth: v("content-width"),
} as const;
