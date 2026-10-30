import {
	type CSSProperties,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { MenuCheckIcon } from "../primitives/lucide.tsx";
import { Kbd } from "../primitives/spinner.tsx";
import type { ResolvedTheme } from "../tokens/theme-schema.ts";
import { SYSTEM_THEME, type ThemeController, type ThemeState, themeController } from "./controller.ts";
import "./theme-picker.css";

// The theme picker: a command palette of themes. Arrow keys (or typing to filter) preview each theme on the whole page
// as you move, Enter keeps the one you're on, Escape or a click outside puts back what you had. Previewing sets one
// attribute on <html> (controller.ts), so the page restyles in the next frame and nothing but this list renders.

/** The page's theme state, re-rendering only the component that reads it. */
export function useThemeState(controller: ThemeController = themeController()): ThemeState {
	return useSyncExternalStore(controller.subscribe, controller.state, controller.state);
}

type Choice =
	| { readonly kind: "system"; readonly id: typeof SYSTEM_THEME; readonly name: string }
	| { readonly kind: "theme"; readonly id: string; readonly name: string; readonly theme: ResolvedTheme };

export type ThemePickerProps = {
	open: boolean;
	onClose: () => void;
	/** A theme was kept, after the controller has applied and remembered it: the host stores it for the person. */
	onChoose?: (preference: string) => void;
	controller?: ThemeController;
	/** What the search field holds when the picker opens. Default empty: every theme. */
	defaultQuery?: string;
};

/** The words a theme matches when filtering: its name, its kind and the theme it is after. */
const haystack = (choice: Choice): string =>
	(choice.kind === "system"
		? `${choice.name} auto device dark light`
		: `${choice.name} ${choice.theme.kind} ${choice.theme.source?.name ?? ""}`
	).toLowerCase();

/** A theme's swatch colours, as custom properties the swatch's CSS reads. */
function swatchStyle(theme: ResolvedTheme): CSSProperties {
	const t = theme.tokens;
	return {
		"--hb-swatch-canvas": t.canvas,
		"--hb-swatch-text": t.text,
		"--hb-swatch-accent": t.accent,
		"--hb-swatch-a": t["syntax-keyword"],
		"--hb-swatch-b": t["syntax-string"],
	} as CSSProperties;
}

function Swatch({ choice, controller }: { choice: Choice; controller: ThemeController }) {
	if (choice.kind === "theme")
		return <span className="hb-theme-swatch" style={swatchStyle(choice.theme)} aria-hidden="true" />;
	const dark = controller.registry.get(controller.system.dark);
	const light = controller.registry.get(controller.system.light);
	return (
		<span className="hb-theme-swatch hb-theme-swatch-split" aria-hidden="true">
			{dark === undefined ? null : <span className="hb-theme-swatch" style={swatchStyle(dark)} />}
			{light === undefined ? null : <span className="hb-theme-swatch" style={swatchStyle(light)} />}
		</span>
	);
}

/**
 * The theme picker: a search field over every theme, System first. Open it from a shortcut (`useThemeShortcut`) or a
 * button; it previews as you move and keeps the theme on Enter or a click.
 */
export function ThemePicker({
	open,
	onClose,
	onChoose,
	controller = themeController(),
	defaultQuery = "",
}: ThemePickerProps) {
	const dialog = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const listId = useId();
	const state = useThemeState(controller);
	const themes = useSyncExternalStore(
		controller.registry.subscribe,
		controller.registry.list,
		controller.registry.list,
	);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);

	const choices = useMemo<Choice[]>(
		() => [
			{ kind: "system", id: SYSTEM_THEME, name: "System" },
			...themes.map((theme): Choice => ({ kind: "theme", id: theme.id, name: theme.name, theme })),
		],
		[themes],
	);
	const shown = useMemo(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		return words.length === 0
			? choices
			: choices.filter((choice) => words.every((word) => haystack(choice).includes(word)));
	}, [choices, query]);

	// Opening: the list starts on what's chosen, with nothing previewed yet.
	useEffect(() => {
		const element = dialog.current;
		if (element === null) return;
		if (open && !element.open) {
			setQuery(defaultQuery);
			setActive(
				Math.max(
					0,
					choices.findIndex((choice) => choice.id === controller.state().preference),
				),
			);
			element.showModal();
			input.current?.focus();
		}
		if (!open && element.open) element.close();
	}, [open, choices, controller, defaultQuery]);

	const close = useCallback(() => {
		controller.endPreview();
		onClose();
	}, [controller, onClose]);

	const show = useCallback(
		(index: number) => {
			setActive(index);
			const choice = shown[index];
			if (choice === undefined) return;
			controller.preview(choice.kind === "system" ? controller.resolve(SYSTEM_THEME) : choice.id);
			list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
		},
		[shown, controller],
	);

	const keep = useCallback(
		(choice: Choice | undefined) => {
			if (choice === undefined) return;
			controller.choose(choice.id);
			onChoose?.(choice.id);
			onClose();
		},
		[controller, onChoose, onClose],
	);

	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		const last = shown.length - 1;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				if (last >= 0) show(active >= last ? 0 : active + 1);
				return;
			case "ArrowUp":
				event.preventDefault();
				if (last >= 0) show(active <= 0 ? last : active - 1);
				return;
			case "Home":
				event.preventDefault();
				if (last >= 0) show(0);
				return;
			case "End":
				event.preventDefault();
				if (last >= 0) show(last);
				return;
			case "Enter":
				event.preventDefault();
				keep(shown[active]);
				return;
		}
	};

	// Escape: the browser's cancel. Put back what was chosen.
	useEffect(() => {
		const element = dialog.current;
		if (element === null) return;
		const onCancel = (event: Event) => {
			event.preventDefault();
			close();
		};
		element.addEventListener("cancel", onCancel);
		return () => element.removeEventListener("cancel", onCancel);
	}, [close]);

	const activeChoice = shown[active];
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Escape is the keyboard's way.
		<dialog
			ref={dialog}
			className="hb-theme-picker"
			aria-label="Choose a theme"
			onClick={(event) => {
				if (event.target === dialog.current) close();
			}}
		>
			<div className="hb-theme-picker-panel">
				<input
					ref={input}
					className="hb-theme-picker-search"
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={activeChoice === undefined ? undefined : `${listId}-${activeChoice.id}`}
					placeholder="Search themes"
					spellCheck={false}
					autoComplete="off"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={onKey}
				/>
				<div ref={list} id={listId} role="listbox" aria-label="Themes" className="hb-theme-picker-list">
					{shown.length === 0 ? <p className="hb-theme-picker-empty">No theme matches</p> : null}
					{shown.map((choice, index) => {
						const chosen = choice.id === state.preference;
						const kind =
							choice.kind === "system" ? "Follows your device" : choice.theme.kind === "dark" ? "Dark" : "Light";
						return (
							// biome-ignore lint/a11y/useKeyWithClickEvents: the search field owns the keyboard (aria-activedescendant).
							<div
								key={choice.id}
								id={`${listId}-${choice.id}`}
								role="option"
								// Reachable only through the search field's aria-activedescendant, never by Tab.
								tabIndex={-1}
								aria-selected={index === active}
								data-index={index}
								className="hb-theme-picker-option"
								onPointerMove={() => index !== active && setActive(index)}
								onClick={() => keep(choice)}
							>
								<Swatch choice={choice} controller={controller} />
								<span className="hb-theme-picker-name">{choice.name}</span>
								<span className="hb-theme-picker-kind">{kind}</span>
								<span className="hb-theme-picker-check">{chosen ? <MenuCheckIcon label="Current theme" /> : null}</span>
							</div>
						);
					})}
				</div>
				<div className="hb-theme-picker-foot">
					<span>
						<Kbd>Enter</Kbd> keeps it
					</span>
					<span>
						<Kbd>Esc</Kbd> puts yours back
					</span>
				</div>
			</div>
		</dialog>
	);
}

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");

/** The shortcut's name, as this platform writes it: "⌘K T" or "Ctrl+K T". */
export const themeShortcut = (): string => (isMac() ? "⌘K T" : "Ctrl+K T");

/** How long after Ctrl+K (⌘K) the T may come. */
const CHORD_MS = 1500;

/**
 * Opens the theme picker on Ctrl+K then T (⌘K then T on a Mac), as VS Code's ⌘K ⌘T. The T is plain because the
 * browser keeps Ctrl+T for a new tab. Ctrl+K alone does nothing else in the page.
 */
export function useThemeShortcut(onOpen: () => void, enabled = true): void {
	const openRef = useRef(onOpen);
	openRef.current = onOpen;
	useEffect(() => {
		if (!enabled) return;
		let armed = 0;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			const key = event.key.toLowerCase();
			const mod = isMac() ? event.metaKey : event.ctrlKey;
			if (key === "k" && mod && !event.altKey && !event.shiftKey) {
				event.preventDefault();
				armed = event.timeStamp;
				return;
			}
			if (armed !== 0 && event.timeStamp - armed < CHORD_MS && key === "t" && !event.altKey && !event.shiftKey) {
				event.preventDefault();
				armed = 0;
				openRef.current();
				return;
			}
			if (!["control", "meta", "shift", "alt"].includes(key)) armed = 0;
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [enabled]);
}
