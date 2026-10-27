// The composer's decisions, as pure functions so they can be tested without a DOM: which primary action the button
// shows, and whether a key press sends. After T3 Code's ComposerPrimaryActions.tsx:133-160,262-350 and
// composer-logic.ts:49-93 (pingdotgg/t3code@1152e9171a9ce6ede20e0cc1f16ed0dbe103da9b).

/** What the session lets the composer do. */
export type ComposerState = "idle" | "running" | "sending" | "disabled";

/**
 * The composer's one primary action.
 * - `send`: idle with text.
 * - `send-empty`: idle with nothing to send; Send shows, disabled.
 * - `steer`: the agent is running and there is text; sending it steers the run.
 * - `stop`: the agent is running and the field is empty; the button stops the run.
 * - `busy`: a message is on its way; a spinner, not clickable.
 * - `disabled`: the composer can't be used right now; Send shows, disabled.
 */
export type PrimaryAction = "send" | "send-empty" | "steer" | "stop" | "busy" | "disabled";

/** True when the draft has something other than whitespace in it. */
export function hasText(text: string): boolean {
	return text.trim().length > 0;
}

/** The primary action for a state and a draft. */
export function primaryAction(state: ComposerState, text: string): PrimaryAction {
	const filled = hasText(text);
	switch (state) {
		case "sending":
			return "busy";
		case "disabled":
			return "disabled";
		case "running":
			return filled ? "steer" : "stop";
		case "idle":
			return filled ? "send" : "send-empty";
	}
}

/** True for the actions that hand the draft to the session (onSend or onSteer). */
export function submits(action: PrimaryAction): action is "send" | "steer" {
	return action === "send" || action === "steer";
}

/** The parts of a keyboard event the composer reads. A React KeyboardEvent's fields, with the native ones lifted. */
export type KeyLike = {
	key: string;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	/** The native event's isComposing: true while an IME is composing (Japanese, Chinese, Korean input). */
	isComposing?: boolean;
	/** The native keyCode; 229 means an IME has the key. */
	keyCode?: number;
};

/**
 * Whether a key press sends the draft.
 * - Enter sends; Shift+Enter and Alt+Enter are a new line.
 * - Enter while an IME is composing never sends: it confirms the composition.
 * - On a coarse pointer (a phone or tablet's software keyboard) plain Enter is a new line, since the keyboard's
 *   return key is the only way to start one; the send button sends. Ctrl+Enter or Cmd+Enter still sends there, for
 *   a hardware keyboard attached to a tablet.
 */
export function shouldSend(event: KeyLike, coarse: boolean): boolean {
	if (event.key !== "Enter") return false;
	if (event.isComposing === true || event.keyCode === 229) return false;
	if (event.shiftKey === true || event.altKey === true) return false;
	const modified = event.ctrlKey === true || event.metaKey === true;
	if (coarse) return modified;
	return true;
}
