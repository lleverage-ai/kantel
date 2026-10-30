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
import { createPortal } from "react-dom";
import { IconButton } from "./button.tsx";
import { MenuCheckIcon, MenuChevronIcon } from "./lucide.tsx";
import "./menu.css";

/** One of a `choices` entry's options. */
export type MenuChoice = { readonly value: string; readonly label: string };

/**
 * What a menu holds: actions, lines between groups of them, and settings whose options open to the side (Claude's
 * "Status: Active", "Sort by: Last activity").
 */
export type MenuEntry =
	| {
			readonly kind: "item";
			readonly id: string;
			readonly label: string;
			/** A 16px icon before the label: a Lucide icon from `lucide.tsx`. */
			readonly icon?: ReactNode;
			/** One key that chooses the item while the menu is open, shown at the row's end: "P" for Pin. */
			readonly shortcut?: string;
			/** The action destroys something: red, and last. */
			readonly danger?: boolean;
			readonly disabled?: boolean;
			readonly onSelect: () => void;
	  }
	| { readonly kind: "separator"; readonly id: string }
	| {
			readonly kind: "choices";
			readonly id: string;
			readonly label: string;
			readonly choices: readonly MenuChoice[];
			/** The chosen option's value, shown muted on the row and ticked in its submenu. */
			readonly value: string;
			readonly onChoose: (value: string) => void;
	  };

export type MenuProps = {
	/** What the trigger does, for its accessible name and tooltip: "Session actions", "Filter sessions". */
	label: string;
	/** The trigger's icon. */
	icon: ReactNode;
	entries: readonly MenuEntry[];
	size?: "xs" | "sm";
	/** Which edge of the trigger the menu lines up with. */
	align?: "start" | "end";
	/** Told when the menu opens and closes. */
	onOpenChange?: (open: boolean) => void;
	/** Open on mount, for a story or a test. */
	defaultOpen?: boolean;
};

/** Room kept between the menu and the window's edges, and between the menu and what opened it. */
const EDGE = 8;
const GAP = 4;

type Place = { readonly top: number; readonly left: number };

/** Where a panel of `size` goes beside `anchor`: below it (or above when there's no room), or to its side. */
function placeBelow(anchor: DOMRect, size: DOMRect, align: "start" | "end"): Place {
	const left = align === "end" ? anchor.right - size.width : anchor.left;
	let top = anchor.bottom + GAP;
	if (top + size.height > window.innerHeight - EDGE) top = Math.max(EDGE, anchor.top - GAP - size.height);
	return { top, left: Math.min(Math.max(EDGE, left), window.innerWidth - size.width - EDGE) };
}

function placeBeside(row: DOMRect, panel: DOMRect, size: DOMRect): Place {
	let left = panel.right + GAP;
	if (left + size.width > window.innerWidth - EDGE) left = Math.max(EDGE, panel.left - GAP - size.width);
	const top = Math.min(Math.max(EDGE, row.top - GAP), window.innerHeight - size.height - EDGE);
	return { top, left };
}

const itemsIn = (panel: HTMLElement | null) => [
	...(panel?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]:not(:disabled)") ?? []),
];

/**
 * A menu behind an icon button, after Claude.ai's sidebar menus: a "…" on a session row, the filter by Recents. Its
 * rows are actions with a Lucide icon and a one-key shortcut shown at the end (pressing the key while the menu is open
 * chooses it), lines between groups, and settings whose options open in a submenu to the side. It floats above
 * everything (a portal on the page's body), so a scrolling or clipped list never cuts it off.
 *
 * Keys: Up and Down move, Right or Enter opens a submenu and Left or Escape closes it, Enter or Space chooses, Escape
 * closes and gives focus back to the trigger, Tab closes. A pointer down outside, a scroll or a resize closes it.
 */
export function Menu({
	label,
	icon,
	entries,
	size = "xs",
	align = "start",
	onOpenChange,
	defaultOpen = false,
}: MenuProps) {
	const [open, setOpenState] = useState(defaultOpen);
	const [sub, setSub] = useState<string>();
	const [place, setPlace] = useState<Place>();
	const [subPlace, setSubPlace] = useState<Place>();
	const trigger = useRef<HTMLButtonElement>(null);
	const layer = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const subPanel = useRef<HTMLDivElement>(null);
	const menuId = useId();

	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	const setOpen = useCallback((next: boolean) => {
		setOpenState(next);
		if (!next) {
			setSub(undefined);
			setPlace(undefined);
			setSubPlace(undefined);
		}
		onOpenChangeRef.current?.(next);
	}, []);

	useEffect(() => {
		if (defaultOpen) onOpenChangeRef.current?.(true);
	}, [defaultOpen]);

	// Placed once it has a size, beside the trigger.
	useLayoutEffect(() => {
		if (!open || trigger.current === null || panel.current === null) return;
		setPlace(placeBelow(trigger.current.getBoundingClientRect(), panel.current.getBoundingClientRect(), align));
	}, [open, align]);

	// Then focused on its first row, once it is shown: a hidden panel's rows can't take focus.
	const placed = place !== undefined;
	useLayoutEffect(() => {
		if (placed) itemsIn(panel.current)[0]?.focus({ preventScroll: true });
	}, [placed]);

	// A submenu goes beside its row, focused on the chosen option.
	useLayoutEffect(() => {
		if (sub === undefined || panel.current === null || subPanel.current === null) return;
		const row = panel.current.querySelector<HTMLElement>(`[data-entry="${CSS.escape(sub)}"]`);
		if (row === null) return;
		setSubPlace(
			placeBeside(
				row.getBoundingClientRect(),
				panel.current.getBoundingClientRect(),
				subPanel.current.getBoundingClientRect(),
			),
		);
	}, [sub]);

	// A pointer down outside, a scroll of anything else or a resize closes it: it would float away from its trigger.
	useEffect(() => {
		if (!open) return;
		const inside = (target: EventTarget | null) =>
			target instanceof Node && (trigger.current?.contains(target) || layer.current?.contains(target));
		const onPointer = (event: PointerEvent) => {
			if (!inside(event.target)) setOpen(false);
		};
		const onScroll = (event: Event) => {
			if (!inside(event.target)) setOpen(false);
		};
		const onResize = () => setOpen(false);
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
		};
	}, [open, setOpen]);

	const close = () => {
		setOpen(false);
		trigger.current?.focus({ preventScroll: true });
	};

	const select = (entry: Extract<MenuEntry, { kind: "item" }>) => {
		if (entry.disabled) return;
		close();
		entry.onSelect();
	};

	const openSub = (id: string, focus: boolean) => {
		setSub(id);
		if (!focus) return;
		// Focus moves in once the submenu has rendered: the chosen option, else the first.
		requestAnimationFrame(() => {
			const options = itemsIn(subPanel.current);
			(options.find((option) => option.getAttribute("aria-checked") === "true") ?? options[0])?.focus({
				preventScroll: true,
			});
		});
	};

	const closeSub = () => {
		const id = sub;
		setSub(undefined);
		setSubPlace(undefined);
		panel.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id ?? "")}"]`)?.focus({ preventScroll: true });
	};

	const onKey = (event: KeyboardEvent<HTMLDivElement>, level: "menu" | "sub") => {
		const items = itemsIn(level === "menu" ? panel.current : subPanel.current);
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus({ preventScroll: true });
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				focusAt(index + 1);
				return;
			case "ArrowUp":
				event.preventDefault();
				focusAt(index - 1);
				return;
			case "Home":
				event.preventDefault();
				focusAt(0);
				return;
			case "End":
				event.preventDefault();
				focusAt(items.length - 1);
				return;
			case "ArrowRight": {
				const id = (document.activeElement as HTMLElement | null)?.dataset.choices;
				if (level === "menu" && id !== undefined) {
					event.preventDefault();
					openSub(id, true);
				}
				return;
			}
			case "ArrowLeft":
				if (level === "sub") {
					event.preventDefault();
					closeSub();
				}
				return;
			case "Escape":
				event.preventDefault();
				event.stopPropagation();
				if (level === "sub") closeSub();
				else close();
				return;
			case "Tab":
				event.preventDefault();
				setOpen(false);
				trigger.current?.focus({ preventScroll: true });
				return;
		}
		// A row's one-key shortcut, without modifiers, whichever level has focus.
		if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
		const key = event.key.toLowerCase();
		const entry = entries.find(
			(candidate): candidate is Extract<MenuEntry, { kind: "item" }> =>
				candidate.kind === "item" && candidate.shortcut?.toLowerCase() === key,
		);
		if (entry === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		select(entry);
	};

	const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setOpen(true);
		}
	};

	const subEntry = entries.find(
		(entry): entry is Extract<MenuEntry, { kind: "choices" }> => entry.kind === "choices" && entry.id === sub,
	);

	const menu = (
		<div ref={layer} className="hb-menu-layer hb-theme">
			<div
				ref={panel}
				id={menuId}
				role="menu"
				aria-label={label}
				className="hb-menu"
				style={place === undefined ? { visibility: "hidden" } : { top: place.top, left: place.left }}
				onKeyDown={(event) => onKey(event, "menu")}
			>
				{entries.map((entry) => {
					if (entry.kind === "separator") return <hr key={entry.id} className="hb-menu-separator" />;
					if (entry.kind === "choices") {
						const chosen = entry.choices.find((choice) => choice.value === entry.value);
						return (
							<button
								key={entry.id}
								type="button"
								role="menuitem"
								tabIndex={-1}
								aria-haspopup="menu"
								aria-expanded={sub === entry.id}
								data-entry={entry.id}
								data-choices={entry.id}
								className="hb-menu-item hb-menu-item-choices"
								onClick={() => openSub(entry.id, true)}
								onPointerMove={(event) => {
									event.currentTarget.focus({ preventScroll: true });
									if (sub !== entry.id) openSub(entry.id, false);
								}}
							>
								<span className="hb-menu-item-label">{entry.label}</span>
								<span className="hb-menu-item-value">{chosen?.label}</span>
								<MenuChevronIcon className="hb-menu-item-chevron" />
							</button>
						);
					}
					return (
						<button
							key={entry.id}
							type="button"
							role="menuitem"
							tabIndex={-1}
							disabled={entry.disabled}
							data-entry={entry.id}
							{...(entry.shortcut === undefined ? {} : { "aria-keyshortcuts": entry.shortcut.toUpperCase() })}
							className={`hb-menu-item${entry.danger ? " hb-menu-item-danger" : ""}`}
							onClick={() => select(entry)}
							onPointerMove={(event) => {
								event.currentTarget.focus({ preventScroll: true });
								if (sub !== undefined) setSub(undefined);
							}}
						>
							{entry.icon === undefined ? null : <span className="hb-menu-item-icon">{entry.icon}</span>}
							<span className="hb-menu-item-label">{entry.label}</span>
							{entry.shortcut === undefined ? null : (
								<span className="hb-menu-item-shortcut" aria-hidden="true">
									{entry.shortcut.toUpperCase()}
								</span>
							)}
						</button>
					);
				})}
			</div>
			{subEntry === undefined ? null : (
				<div
					ref={subPanel}
					role="menu"
					aria-label={subEntry.label}
					className="hb-menu hb-menu-sub"
					style={subPlace === undefined ? { visibility: "hidden" } : { top: subPlace.top, left: subPlace.left }}
					onKeyDown={(event) => onKey(event, "sub")}
				>
					{subEntry.choices.map((choice) => (
						<button
							key={choice.value}
							type="button"
							role="menuitemradio"
							tabIndex={-1}
							aria-checked={choice.value === subEntry.value}
							className="hb-menu-item"
							onClick={() => {
								subEntry.onChoose(choice.value);
								closeSub();
							}}
							onPointerMove={(event) => event.currentTarget.focus({ preventScroll: true })}
						>
							<span className="hb-menu-item-label">{choice.label}</span>
							<span className="hb-menu-item-check">{choice.value === subEntry.value ? <MenuCheckIcon /> : null}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);

	return (
		<>
			<IconButton
				ref={trigger}
				variant="ghost"
				size={size}
				label={label}
				icon={icon}
				className="hb-menu-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				{...(open ? { "aria-controls": menuId } : {})}
				onClick={() => setOpen(!open)}
				onKeyDown={onTriggerKey}
			/>
			{open && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
		</>
	);
}
