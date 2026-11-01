import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { CheckIcon, ChevronDownIcon, LockIcon } from "../primitives/icons.tsx";
import { popoverRoom, popoverSide, usePopoverPlacement } from "../primitives/popover-placement.ts";

// The composer's access picker, after T3 Code's permissions chip: the model picker's button (a lock, the level, a
// chevron), muted, opening a short menu upward (downward when there's more room below) of the levels, each with what
// it means underneath.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). The kt-access- classes carry no style of their own: they
// are hooks for loop/align.ts, the composer's stories and access-picker.test.ts.

/** Trimmed to its capitals, as the model picker's name is, so the lock and chevron share the letters' centre. */
const trimmed = "py-(--kt-trim-room) [text-box:trim-both_cap_alphabetic]";
/** The model picker's button (model-picker.tsx's `triggerClass`), muted, with its lock and chevron. */
const triggerClass =
	"kt-access-trigger kt-focusable inline-flex cursor-pointer items-center border border-transparent bg-transparent py-0 [font-family:inherit] [font-feature-settings:inherit] font-medium leading-none whitespace-nowrap text-muted transition-[background-color,color] duration-(--kt-duration-fast) ease-standard enabled:hover:bg-hover enabled:hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg disabled:cursor-default disabled:opacity-50";
/** The button's size: `sm` in the composer's toolbar, `xs` in its resting strip. */
const triggerSize = {
	sm: "h-control-sm gap-1.5 rounded-control px-2 text-md",
	xs: "h-control-xs gap-1 rounded-sm px-1.5 text-xs",
} as const;
/**
 * The menu, a raised panel above the button (or below: `popoverSide`), the popover's width (less a margin on a narrow
 * window), scrolling when the room there is short. With a session's connections under the levels it is the share
 * popover's width, for a connection's name, account and policy on two lines.
 */
const menuClass = `kt-access-menu absolute left-0 z-(--kt-z-overlay) flex cursor-default flex-col overflow-y-auto overscroll-contain rounded-panel bg-raised p-1 text-md text-fg shadow-float outline-none ${popoverRoom}`;
const menuWidth = {
	levels: "w-[min(var(--kt-popover-width),calc(100vw_-_var(--kt-step-8)))]",
	connections: "w-[min(var(--kt-share-width),calc(100vw_-_var(--kt-step-8)))]",
} as const;
/** The menu's quiet heading. */
const heading = "kt-access-heading px-2 pt-1.5 pb-1 text-xs font-medium text-faint";
/**
 * A row: the level's name and the tick on one line, what it means (or why it can't be chosen) under them. The row
 * under the pointer or the keys is lit; the menu keeps focus inside, so no ring.
 */
const optionClass =
	"kt-access-option grid min-h-control-md cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-sm px-2 py-1.5 outline-none hover:bg-hover focus:bg-hover aria-disabled:cursor-default";

/**
 * One level of access a session's agent may run with: what it may do without asking. The host decides which there
 * are and which it can honour; one it can't is listed, dimmed, with `disabledReason`.
 */
export type ComposerAccessOption = {
	/** What `onChange` reports, such as `full-access`. */
	id: string;
	/** "Full access". */
	label: string;
	/** One short line: "Runs commands and edits files without asking." */
	description?: string;
	/** Set when the level can't be chosen now; the menu shows it, dimmed, with this reason. */
	disabledReason?: string;
};

export type AccessPickerProps = {
	options: readonly ComposerAccessOption[];
	/** The chosen level's id. Without it the first level that can be chosen shows as chosen. */
	value?: string;
	/** Without it the menu only shows the levels and says what the chosen one means. */
	onChange?: (id: string) => void;
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
	 * Under the levels, in the same panel: the session's connections and what it has been allowed
	 * (`SessionAccessConnections`). Mounted only while the menu is open; Tab moves from the levels into it.
	 */
	connections?: ReactNode;
};

/** The level the picker shows as chosen: `value`, else the first that can be chosen, else the first. */
export function chosenAccess(
	options: readonly ComposerAccessOption[],
	value: string | undefined,
): ComposerAccessOption | undefined {
	return (
		options.find((option) => option.id === value) ??
		options.find((option) => option.disabledReason === undefined) ??
		options[0]
	);
}

/**
 * What the agent may do without asking, after T3 Code's permissions chip (ComposerFooterControls.tsx): a lock, the
 * level ("Full access") and a chevron, opening a short menu of the levels with what each means, the chosen one ticked.
 * A level the host can't honour yet is listed, dimmed, with its reason. Renders nothing without levels. Up and Down
 * move, Enter or Space chooses, Escape closes.
 */
export function AccessPicker({
	options,
	value,
	onChange,
	disabled = false,
	size = "sm",
	onOpenChange,
	returnFocus,
	defaultOpen = false,
	connections,
}: AccessPickerProps) {
	const [open, setOpenState] = useState(defaultOpen);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const place = usePopoverPlacement(open, root, panel);
	const menuId = useId();
	const chosen = chosenAccess(options, value);

	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	const setOpen = useCallback((next: boolean) => {
		setOpenState(next);
		onOpenChangeRef.current?.(next);
	}, []);

	useEffect(() => {
		if (defaultOpen) onOpenChangeRef.current?.(true);
	}, [defaultOpen]);

	// Opening puts focus on the chosen level, as a menu of radios does.
	const chosenId = chosen?.id;
	const chosenRef = useRef(chosenId);
	chosenRef.current = chosenId;
	useLayoutEffect(() => {
		if (!open) return;
		const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
		const current = items.find((item) => item.dataset.access === chosenRef.current) ?? items[0];
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

	// Focus leaving the picker closes it: Tab past the last of its connections, or a click on something focusable.
	useEffect(() => {
		const element = root.current;
		if (!open || element === null) return;
		const onFocusOut = (event: FocusEvent) => {
			const next = event.relatedTarget as Node | null;
			if (next !== null && !element.contains(next)) setOpen(false);
		};
		element.addEventListener("focusout", onFocusOut);
		return () => element.removeEventListener("focusout", onFocusOut);
	}, [open, setOpen]);

	if (chosen === undefined) return null;

	const close = (focus: "trigger" | "field") => {
		setOpen(false);
		if (focus === "field" && returnFocus) returnFocus();
		else trigger.current?.focus();
	};

	const choose = (option: ComposerAccessOption) => {
		if (option.disabledReason !== undefined) return;
		if (option.id !== chosen.id) onChange?.(option.id);
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
				// With connections under the levels, Tab moves into them; otherwise it leaves the menu, which closes.
				if (connections === undefined) setOpen(false);
				break;
		}
	};

	// Escape anywhere in the panel closes it, from the levels or the connections.
	const onPanelKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		close("trigger");
	};

	const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault();
			setOpen(true);
		}
	};

	const title = chosen.description === undefined ? chosen.label : `${chosen.label}: ${chosen.description}`;

	return (
		<div className="kt-access-picker relative flex min-w-0 flex-none" ref={root}>
			<button
				ref={trigger}
				type="button"
				className={`${triggerClass} ${triggerSize[size]}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				aria-label={`Access: ${chosen.label}`}
				title={title}
				disabled={disabled}
				onClick={() => (open ? close("trigger") : setOpen(true))}
				onKeyDown={onTriggerKey}
			>
				<LockIcon size={size === "xs" ? "sm" : "md"} />
				<span className={`kt-access-trigger-label ${trimmed}`}>{chosen.label}</span>
				<ChevronDownIcon size="sm" className="kt-access-trigger-chevron text-faint" />
			</button>
			{open ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: the panel only passes Escape on from its menu and connections.
				<div
					ref={panel}
					className={`${menuClass} ${menuWidth[connections === undefined ? "levels" : "connections"]} ${popoverSide[place.side]}`}
					style={place.style}
					data-side={place.side}
					onKeyDown={onPanelKey}
				>
					<div
						ref={menu}
						id={menuId}
						role="menu"
						aria-label="Access"
						tabIndex={-1}
						onKeyDown={onMenuKey}
						className="outline-none"
					>
						<div className={heading} aria-hidden="true">
							Access
						</div>
						{options.map((option) => {
							const unavailable = option.disabledReason !== undefined;
							const detail = option.disabledReason ?? option.description;
							const detailId = `${menuId}-${option.id}`;
							return (
								<div
									key={option.id}
									role="menuitemradio"
									aria-checked={option.id === chosen.id}
									aria-disabled={option.disabledReason === undefined ? undefined : true}
									aria-describedby={detail === undefined ? undefined : detailId}
									tabIndex={-1}
									data-access={option.id}
									className={optionClass}
									onClick={() => choose(option)}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											choose(option);
										}
									}}
								>
									{/* A level that can't be chosen has a muted name. */}
									<span
										className={`kt-access-option-name row-1 min-w-0 leading-tight whitespace-nowrap ${trimmed} ${unavailable ? "text-muted" : ""}`}
									>
										{option.label}
									</span>
									<span className="kt-access-option-check row-1 grid w-icon-sm place-items-center text-accent-text">
										{option.id === chosen.id ? <CheckIcon size="sm" /> : null}
									</span>
									{detail === undefined ? null : (
										<span
											id={detailId}
											className="kt-access-option-detail col-span-full row-2 min-w-0 text-xs leading-tight text-faint"
										>
											{detail}
										</span>
									)}
								</div>
							);
						})}
					</div>
					{connections}
				</div>
			) : null}
		</div>
	);
}
