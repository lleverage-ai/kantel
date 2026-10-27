import {
	type ChangeEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { IconButton } from "../primitives/button.tsx";
import { SendIcon, StopIcon } from "../primitives/icons.tsx";
import { Kbd } from "../primitives/spinner.tsx";
import {
	type ComposerState,
	type PrimaryAction as PrimaryActionKind,
	primaryAction,
	shouldSend,
	submits,
} from "./composer-model.ts";
import "./composer.css";

export type { ComposerState } from "./composer-model.ts";

export type ComposerProps = {
	/** The draft, for a controlled composer. Pair with onChange. */
	value?: string;
	/** The first draft, for an uncontrolled composer, which clears itself after sending. */
	defaultValue?: string;
	onChange?: (value: string) => void;
	/** Sends the draft (trimmed). Also used to steer when onSteer is not given. */
	onSend: (text: string) => void;
	/** Sends the draft to a running agent, to steer it. */
	onSteer?: (text: string) => void;
	/** Stops the running agent. Without it, Stop shows disabled. */
	onStop?: () => void;
	/** `idle`: Send. `running`: Steer with text, Stop without. `sending`: a spinner. `disabled`: nothing works. */
	state: ComposerState;
	/** Why the composer is disabled, shown in the surface in muted text. */
	disabledReason?: string;
	placeholder?: string;
	/** Attached above the surface, sharing its width: an approval, a question, a notice that a send failed. */
	banner?: ReactNode;
	/** Bottom left, beside the primary action: hints such as ComposerSendHint, or a model picker. */
	footer?: ReactNode;
	autoFocus?: boolean;
	/** The textarea's accessible name. */
	label?: string;
};

const coarseQuery = "(pointer: coarse)";

function subscribeCoarse(listener: () => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	const list = window.matchMedia(coarseQuery);
	list.addEventListener("change", listener);
	return () => list.removeEventListener("change", listener);
}

function readCoarse(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function"
		? window.matchMedia(coarseQuery).matches
		: false;
}

/** True under a coarse pointer (a touch screen), where the keyboard is usually a software one. */
function useCoarsePointer(): boolean {
	return useSyncExternalStore(subscribeCoarse, readCoarse, () => false);
}

/**
 * Sets the textarea's height to fit its text. CSS caps it (min and max height), after which it scrolls. The inputs
 * (the draft, the pointer, which changes the font size) are passed only so the call site re-measures when they change.
 */
function fitHeight(element: HTMLTextAreaElement | null, ..._inputs: readonly unknown[]): void {
	if (element === null) return;
	element.style.height = "auto";
	element.style.height = `${element.scrollHeight}px`;
}

/**
 * The message box at the foot of a session: one raised surface with an autosizing field and one stateful round
 * action at the bottom right (Send, Steer, Stop or a spinner), as T3 Code's composer. Enter sends, Shift+Enter is a
 * new line, and a software keyboard's Enter is always a new line. Approvals and questions attach above it through
 * `banner` rather than opening a modal.
 */
export function Composer({
	value,
	defaultValue,
	onChange,
	onSend,
	onSteer,
	onStop,
	state,
	disabledReason,
	placeholder = "Ask anything",
	banner,
	footer,
	autoFocus = false,
	label = "Message",
}: ComposerProps) {
	const [draft, setDraft] = useState(defaultValue ?? "");
	const controlled = value !== undefined;
	const text = controlled ? value : draft;
	const field = useRef<HTMLTextAreaElement>(null);
	const coarse = useCoarsePointer();
	const reasonId = useId();
	const disabled = state === "disabled";
	const action = primaryAction(state, text);

	useLayoutEffect(() => {
		fitHeight(field.current, text, coarse);
	}, [text, coarse]);

	useEffect(() => {
		if (autoFocus) field.current?.focus();
	}, [autoFocus]);

	const change = (event: ChangeEvent<HTMLTextAreaElement>) => {
		if (!controlled) setDraft(event.target.value);
		onChange?.(event.target.value);
	};

	const submit = useCallback(() => {
		if (!submits(action)) return;
		const message = text.trim();
		if (action === "steer") (onSteer ?? onSend)(message);
		else onSend(message);
		if (!controlled) setDraft("");
		field.current?.focus();
	}, [action, text, onSend, onSteer, controlled]);

	const stop = () => {
		onStop?.();
		field.current?.focus();
	};

	const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		const sends = shouldSend(
			{
				key: event.key,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				isComposing: event.nativeEvent.isComposing,
				keyCode: event.nativeEvent.keyCode,
			},
			coarse,
		);
		if (!sends) return;
		// Enter never inserts a new line where it would send, even when there is nothing to send yet.
		event.preventDefault();
		submit();
	};

	const showReason = disabled && disabledReason !== undefined && disabledReason !== "";

	return (
		<div className={`hb-composer hb-composer-${state}`}>
			{banner === undefined || banner === null ? null : <div className="hb-composer-banner">{banner}</div>}
			<div className="hb-composer-surface" data-focus-surface="">
				{/* Disabled with a reason and nothing typed, the composer is one line: the reason and the action. An empty
				    field, or an invitation to type, beside the reason would contradict it. A draft always stays visible. */}
				{showReason && text === "" ? null : (
					<textarea
						ref={field}
						className="hb-composer-input"
						rows={1}
						value={text}
						onChange={change}
						onKeyDown={keyDown}
						placeholder={showReason ? undefined : placeholder}
						aria-label={label}
						aria-describedby={showReason ? reasonId : undefined}
						disabled={disabled}
						enterKeyHint={coarse ? "enter" : "send"}
					/>
				)}
				<div className="hb-composer-bar">
					<div className="hb-composer-footer">
						{showReason ? (
							<p id={reasonId} className="hb-composer-reason">
								{disabledReason}
							</p>
						) : (
							footer
						)}
					</div>
					<PrimaryAction action={action} onSubmit={submit} onStop={onStop === undefined ? undefined : stop} />
				</div>
			</div>
		</div>
	);
}

/** The round button at the composer's bottom right. One element whatever the action, so focus survives a change. */
function PrimaryAction({
	action,
	onSubmit,
	onStop,
}: {
	action: PrimaryActionKind;
	onSubmit: () => void;
	onStop: (() => void) | undefined;
}) {
	switch (action) {
		case "stop":
			return (
				<IconButton
					className="hb-composer-action"
					size="md"
					variant="danger"
					label="Stop"
					icon={<StopIcon />}
					onClick={onStop}
					disabled={onStop === undefined}
				/>
			);
		case "steer":
			return (
				<IconButton
					className="hb-composer-action"
					size="md"
					variant="primary"
					label="Steer"
					icon={<SendIcon />}
					onClick={onSubmit}
				/>
			);
		case "busy":
			return (
				<IconButton
					className="hb-composer-action"
					size="md"
					variant="primary"
					label="Sending"
					icon={<SendIcon />}
					busy
				/>
			);
		default:
			return (
				<IconButton
					className="hb-composer-action"
					size="md"
					variant="primary"
					label="Send"
					icon={<SendIcon />}
					onClick={onSubmit}
					disabled={action !== "send"}
				/>
			);
	}
}

/**
 * The footer hint "Enter to send", hidden under a coarse pointer, where Enter is a new line and the button sends.
 */
export function ComposerSendHint() {
	return (
		<span className="hb-composer-hint">
			<Kbd>Enter</Kbd>
			<span>to send</span>
		</span>
	);
}
