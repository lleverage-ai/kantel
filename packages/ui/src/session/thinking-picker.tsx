import { type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BrainIcon, CheckIcon, ChevronDownIcon } from "../primitives/icons.tsx";
import { popoverRoom, popoverSide, usePopoverPlacement } from "../primitives/popover-placement.ts";
import { chosenThinking, clampThinking, THINKING_LABELS, type ThinkingLevel } from "./thinking-model.ts";

// The composer's thinking picker, after T3 Code's traits picker: a control of its own beside the model's, shaped as the
// model picker's button is (a brain, the level, a chevron), that opens a short menu upward (downward when there's more
// room below, as the model picker's does).
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). The kt-thinking- classes carry no style of their own: they
// are hooks for loop/align.ts and the composer's stories.

/** Trimmed to its capitals and centred, as the model picker's name is, so the two words share one line. */
const trimmed = "py-(--kt-trim-room) [text-box:trim-both_cap_alphabetic]";
/** The model picker's button (model-picker.tsx's `triggerClass`), muted, with its brain and chevron. */
const triggerClass =
	"kt-thinking-trigger kt-focusable inline-flex cursor-pointer items-center border border-transparent bg-transparent py-0 [font-family:inherit] [font-feature-settings:inherit] font-medium leading-none whitespace-nowrap text-muted transition-[background-color,color] duration-(--kt-duration-fast) ease-standard enabled:hover:bg-hover enabled:hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg disabled:cursor-default disabled:opacity-50";
/** The button's size: `sm` in the composer's toolbar, `xs` in its resting strip. */
const triggerSize = {
	sm: "h-control-sm gap-1.5 rounded-control px-2 text-md",
	xs: "h-control-xs gap-1 rounded-sm px-1.5 text-xs",
} as const;
/** The menu, a raised panel above the button (or below: `popoverSide`), scrolling when the room there is short. */
const menuClass = `kt-thinking-menu absolute left-0 z-(--kt-z-overlay) flex min-w-(--kt-menu-width) cursor-default flex-col overflow-y-auto overscroll-contain rounded-panel bg-raised p-1 text-md text-fg shadow-float outline-none ${popoverRoom}`;
/** The menu's quiet heading. */
const heading = "kt-thinking-heading px-2 pt-1.5 pb-1 text-xs font-medium text-faint";
/**
 * A row: the level's name with "Default" on its baseline, then the tick. The row under the pointer or the keys is lit
 * as the model picker's is; the menu keeps focus inside, so no ring.
 */
const optionClass =
	"kt-thinking-option grid min-h-control-md cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-2 py-1.5 outline-none hover:bg-hover focus:bg-hover";
/**
 * The menu's foot: a quiet line under the levels about what a change costs (`note`), as wide as the menu, wrapping
 * rather than widening it.
 */
const noteClass =
	"kt-thinking-note mt-1 w-0 min-w-full border-t border-border px-2 pt-2 pb-1 text-xs leading-snug text-faint";

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
	/**
	 * A quiet line at the foot of the menu, under the levels, about what changing the level costs here: on a session
	 * that has started, `THINKING_CACHE_NOTE`. It informs; every level can still be chosen.
	 */
	note?: string;
};

/**
 * How hard the model thinks before it answers, after T3 Code's traits picker: a control of its own after the model's,
 * a brain, the level ("High") and a chevron, that opens a short menu of the levels the model supports, with the
 * default marked. Renders nothing for a model that can't think. Up and Down move, Enter or Space chooses, Escape
 * closes.
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
	note,
}: ThinkingPickerProps) {
	const [open, setOpenState] = useState(defaultOpen);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const place = usePopoverPlacement(open, root, menu);
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
		<div className="kt-thinking-picker relative flex min-w-0 flex-none" ref={root}>
			<button
				ref={trigger}
				type="button"
				className={`${triggerClass} ${triggerSize[size]}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				aria-label={`Thinking: ${label}`}
				title={`Thinking: ${label}`}
				disabled={disabled}
				onClick={() => (open ? close("trigger") : setOpen(true))}
				onKeyDown={onTriggerKey}
			>
				<BrainIcon size={size === "xs" ? "sm" : "md"} />
				<span className={`kt-thinking-trigger-label ${trimmed}`}>{label}</span>
				<ChevronDownIcon size="sm" className="kt-thinking-trigger-chevron text-faint" />
			</button>
			{open ? (
				<div
					ref={menu}
					id={menuId}
					className={`${menuClass} ${popoverSide[place.side]}`}
					style={place.style}
					data-side={place.side}
					role="menu"
					aria-label="Thinking"
					{...(note === undefined ? {} : { "aria-describedby": `${menuId}-note` })}
					tabIndex={-1}
					onKeyDown={onMenuKey}
				>
					<div className={heading} aria-hidden="true">
						Thinking
					</div>
					{levels.map((level) => (
						<div
							key={level}
							role="menuitemradio"
							aria-checked={level === chosen}
							tabIndex={-1}
							data-level={level}
							className={optionClass}
							onClick={() => choose(level)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									choose(level);
								}
							}}
						>
							<span className="kt-thinking-option-label flex min-w-0 items-baseline gap-1.5 text-md leading-tight">
								<span className={`kt-thinking-option-name whitespace-nowrap ${trimmed}`}>{THINKING_LABELS[level]}</span>
								{level === marked ? (
									<span className={`kt-thinking-option-default text-xs whitespace-nowrap text-faint ${trimmed}`}>
										Default
									</span>
								) : null}
							</span>
							<span className="kt-thinking-option-check grid w-icon-sm place-items-center text-accent-text">
								{level === chosen ? <CheckIcon size="sm" /> : null}
							</span>
						</div>
					))}
					{note === undefined ? null : (
						<p id={`${menuId}-note`} className={noteClass}>
							{note}
						</p>
					)}
				</div>
			) : null}
		</div>
	);
}
