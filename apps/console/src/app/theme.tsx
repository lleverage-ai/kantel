import { IconButton, PaletteIcon, ThemePicker, themeShortcut, useThemeShortcut } from "@harbour/ui";
import { useCallback, useSyncExternalStore } from "react";

// The console's theme picker: one picker for the whole shell, opened by Ctrl+K T (⌘K T) or the palette button by who
// is signed in. Whether it is open lives here, outside the shell's state, so opening it renders only the picker, and
// choosing a theme renders nothing at all: @harbour/ui's theme controller restyles the page by itself.

let open = false;
const listeners = new Set<() => void>();
const setOpen = (next: boolean) => {
	if (open === next) return;
	open = next;
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const isOpen = () => open;

/** Opens the theme picker. */
export const openThemePicker = () => setOpen(true);

/** The picker and its shortcut. Mount once. `onChoose` keeps the chosen theme for the person. */
export function ThemeSwitcher({ onChoose }: { onChoose?: (preference: string) => void }) {
	const shown = useSyncExternalStore(subscribe, isOpen, isOpen);
	useThemeShortcut(openThemePicker);
	const close = useCallback(() => setOpen(false), []);
	return <ThemePicker open={shown} onClose={close} {...(onChoose === undefined ? {} : { onChoose })} />;
}

/** The palette button that opens the picker, for the sidebar's foot. */
export function ThemeButton() {
	return (
		<IconButton
			variant="ghost"
			size="xs"
			label="Theme"
			title={`Theme (${themeShortcut()})`}
			icon={<PaletteIcon />}
			onClick={openThemePicker}
		/>
	);
}
