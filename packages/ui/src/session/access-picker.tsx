import { type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, LockIcon } from "../primitives/icons.tsx";
import "./access-picker.css";

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
}: AccessPickerProps) {
	const [open, setOpenState] = useState(defaultOpen);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
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

	const title = chosen.description === undefined ? chosen.label : `${chosen.label}: ${chosen.description}`;

	return (
		<div className={`hb-access-picker hb-access-picker-${size}`} ref={root}>
			<button
				ref={trigger}
				type="button"
				className="hb-access-trigger hb-focusable"
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
				<span className="hb-access-trigger-label">{chosen.label}</span>
				<ChevronDownIcon size="sm" className="hb-access-trigger-chevron" />
			</button>
			{open ? (
				<div
					ref={menu}
					id={menuId}
					className="hb-access-menu"
					role="menu"
					aria-label="Access"
					tabIndex={-1}
					onKeyDown={onMenuKey}
				>
					<div className="hb-access-heading" aria-hidden="true">
						Access
					</div>
					{options.map((option) => {
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
								className="hb-access-option"
								onClick={() => choose(option)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										choose(option);
									}
								}}
							>
								<span className="hb-access-option-name">{option.label}</span>
								<span className="hb-access-option-check">
									{option.id === chosen.id ? <CheckIcon size="sm" /> : null}
								</span>
								{detail === undefined ? null : (
									<span id={detailId} className="hb-access-option-detail">
										{detail}
									</span>
								)}
							</div>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
