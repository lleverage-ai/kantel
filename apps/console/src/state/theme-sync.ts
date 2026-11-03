// The person's theme, between this browser and Kantel. The page already shows what this browser remembers (the boot
// script in index.html, then @kantel/ui's theme controller); once `/v1/me` answers, the theme kept for the person on
// the server wins, so a theme chosen on one machine follows them to the next.
//
// A theme kept before the console had only light and dark (`nord`, `catppuccin-latte`) is read as the nearer of the two,
// or as system (`themePreference`); Kantel migrates it as it reads it, and the console saves it again in today's form
// should an older gateway still answer with the old one.

import { type ThemePreference, themePreference, type UserPreferences } from "@kantel/contracts";
import type { ThemeController } from "@kantel/ui";

/**
 * Applies the person's saved theme. When they have none but this browser remembers a choice (made before themes were
 * kept on the server, or while saving failed), `save` keeps it for them.
 */
export function syncTheme(
	controller: Pick<ThemeController, "state" | "choose" | "remembered">,
	preferences: UserPreferences | undefined,
	save?: (preference: ThemePreference) => void,
): void {
	const kept = preferences?.theme;
	if (kept !== undefined) {
		const saved = themePreference(kept);
		if (saved !== controller.state().preference) controller.choose(saved);
		if (saved !== kept) save?.(saved);
		return;
	}
	if (controller.remembered()) save?.(controller.state().preference);
}
