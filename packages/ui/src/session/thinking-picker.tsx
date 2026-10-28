import { type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon } from "../primitives/icons.tsx";
import { chosenThinking, clampThinking, THINKING_LABELS, type ThinkingLevel } from "./thinking-model.ts";
import "./thinking-picker.css";

export type ThinkingPickerProps = {
	/**
	 * The levels the chosen model supports, in order (`offeredLevels` builds them from a model's capabilities). Empty,
	 * or only `off`, and there is no picker: the model can't think.
	 */
	levels: readonly ThinkingLevel[];
	/** The chosen level. Out of `levels` it shows (and should be sent) clamped to the nearest one the model has. */
	value?: ThinkingLevel;
	/** The level the session runs with when nobody chose one, marked "Default" in the list. */
	defaultLevel?: ThinkingLevel;
	onChange: (level: ThinkingLevel) => void;
	disabled?: boolean;
	/** `sm` in the composer's toolbar; `xs` in its resting strip. */
	size?: "xs" | "sm";
	/** Told when the menu opens and closes, so the composer stays expanded while it's open. */
	onOpenChange?: (open: boolean) => void;
	/** Where focus goes after a choice: the composer's field. */
	returnFocus?: () => void;
	/** Open on mount, for a story or a test. */
	defaultOpen?: boolean;
};

/**
 * How hard the model thinks before it answers, after T3 Code's traits picker: a quiet word after the model's name
 * ("High") that opens a short menu of the levels the model supports, with the default marked. Renders nothing for a
 * model that can't think. Up and Down move, Enter or Space chooses, Escape closes.
 */
export function ThinkingPicker({
	levels,
	value,
	defaultLevel,
	onChange,
	disabled = false,
	size = "sm",
	onOpenChange,
	returnFocus,
	defaultOpen = false,
}: ThinkingPickerProps) {
	const [open, setOpenState] = useState(defaultOpen);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const thinks = levels.some((level) => level !== "off");
	const chosen = chosenThinking(levels, value, defaultLevel);
	const marked = clampThinking(levels, defaultLevel);

	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	const setOpen = useCallback((next: boolean) => {
		setOpenState(next);
		onOpenChangeRef.current?.(next);
	}, []);

	useEffect(() => {
		if (defaultOpen) onOpenChangeRef.current?.(true);
	}, [defaultOpen]);

	// A model that can't think, chosen while the menu is open, closes it.
	useEffect(() => {
		if (open && !thinks) setOpen(false);
	}, [open, thinks, setOpen]);

	// Opening puts focus on the chosen level, as a menu of radios does.
	const chosenRef = useRef(chosen);
	chosenRef.current = chosen;
	useLayoutEffect(() => {
		if (!open) return;
		const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
		const current = items.find((item) => item.dataset.level === chosenRef.current) ?? items[0];
		current?.focus({ preventScroll: true });
	}, [open]);

	// A pointer down outside closes it.
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [open, setOpen]);

	if (!thinks || chosen === undefined) return null;

	const close = (focus: "trigger" | "field") => {
		setOpen(false);
		if (focus === "field" && returnFocus) returnFocus();
		else trigger.current?.focus();
	};

	const choose = (level: ThinkingLevel) => {
		onChange(level);
		close("field");
	};

	const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
		const index = items.indexOf(document.activeElement as HTMLElement);
		const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				focusAt(index + 1);
				break;
			case "ArrowUp":
				event.preventDefault();
				focusAt(index - 1);
				break;
			case "Home":
				event.preventDefault();
				focusAt(0);
				break;
			case "End":
				event.preventDefault();
				focusAt(items.length - 1);
				break;
			case "Escape":
				event.preventDefault();
				event.stopPropagation();
				close("trigger");
				break;
			case "Tab":
				setOpen(false);
				break;
		}
	};

	const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault();
			setOpen(true);
		}
	};

	const label = THINKING_LABELS[chosen];

	return (
		<div className={`hb-thinking-picker hb-thinking-picker-${size}`} ref={root}>
			<button
				ref={trigger}
				type="button"
				className="hb-thinking-trigger hb-focusable"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				aria-label={`Thinking: ${label}`}
				title={`Thinking: ${label}`}
				disabled={disabled}
				onClick={() => (open ? close("trigger") : setOpen(true))}
				onKeyDown={onTriggerKey}
			>
				<span className="hb-thinking-trigger-label">{label}</span>
			</button>
			{open ? (
				<div
					ref={menu}
					id={menuId}
					className="hb-thinking-menu"
					role="menu"
					aria-label="Thinking"
					tabIndex={-1}
					onKeyDown={onMenuKey}
				>
					<div className="hb-thinking-heading" aria-hidden="true">
						Thinking
					</div>
					{levels.map((level) => (
						<div
							key={level}
							role="menuitemradio"
							aria-checked={level === chosen}
							tabIndex={-1}
							data-level={level}
							className="hb-thinking-option"
							onClick={() => choose(level)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									choose(level);
								}
							}}
						>
							<span className="hb-thinking-option-label">
								<span className="hb-thinking-option-name">{THINKING_LABELS[level]}</span>
								{level === marked ? <span className="hb-thinking-option-default">Default</span> : null}
							</span>
							<span className="hb-thinking-option-check">{level === chosen ? <CheckIcon size="sm" /> : null}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
