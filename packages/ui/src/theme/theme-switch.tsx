import type { ThemePreference } from "@kantel/contracts";
import { useSyncExternalStore } from "react";
import { SegmentedControl, type SegmentOption } from "../primitives/controls.tsx";
import type { MenuEntry } from "../primitives/menu.tsx";
import { type ThemeController, type ThemeState, themeController } from "./controller.ts";

// The theme switch: System, Light or Dark, as a segmented control (a radio group: Tab reaches the chosen one, arrows
// move and choose). Choosing sets one attribute on <html> (controller.ts), so the page restyles in the next frame and
// only this control renders.

/** The page's theme state, re-rendering only the component that reads it. */
export function useThemeState(controller: ThemeController = themeController()): ThemeState {
	return useSyncExternalStore(controller.subscribe, controller.state, controller.state);
}

const OPTIONS: readonly SegmentOption<ThemePreference>[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

export type ThemeSwitchProps = {
	/** A theme was chosen, after the controller has applied and remembered it: the host keeps it for the person. */
	onChoose?: (preference: ThemePreference) => void;
	controller?: ThemeController;
};

const chooser =
	(controller: ThemeController, onChoose: ThemeSwitchProps["onChoose"]) =>
	(next: ThemePreference): void => {
		if (next === controller.state().preference) return;
		controller.choose(next);
		onChoose?.(next);
	};

/** Follow the device, or light or dark. */
export function ThemeSwitch({ onChoose, controller = themeController() }: ThemeSwitchProps) {
	const { preference } = useThemeState(controller);
	return (
		<SegmentedControl label="Theme" options={OPTIONS} value={preference} onChange={chooser(controller, onChoose)} />
	);
}

/**
 * The same three choices as a row in a menu, "Theme  System", whose options open to the side: the console's own menu,
 * under your name. A hook, so the row follows the theme while the menu is open.
 */
export function useThemeMenuEntry({ onChoose, controller = themeController() }: ThemeSwitchProps = {}): MenuEntry {
	const { preference } = useThemeState(controller);
	const choose = chooser(controller, onChoose);
	return {
		kind: "choices",
		id: "theme",
		label: "Theme",
		choices: OPTIONS,
		value: preference,
		onChoose: (value) => choose(value as ThemePreference),
	};
}
