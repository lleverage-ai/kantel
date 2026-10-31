// The person's theme, between this browser and Kantel. The page already shows what this browser remembers (the boot
// script in index.html, then @kantel/ui's theme controller); once `/v1/me` answers, the theme kept for the person on
// the server wins, so a theme chosen on one machine follows them to the next. A theme the console doesn't know (one
// from a newer console, say) leaves the page as it is.

import type { UserPreferences } from "@kantel/contracts";
import type { ThemeController } from "@kantel/ui";

/**
 * Applies the person's saved theme. When they have none but this browser remembers a choice (made before themes were
 * kept on the server, or while saving failed), `save` keeps it for them.
 */
export function syncTheme(
	controller: Pick<ThemeController, "state" | "choose" | "remembered">,
	preferences: UserPreferences | undefined,
	save?: (preference: string) => void,
): void {
	const saved = preferences?.theme;
	if (saved !== undefined) {
		if (saved !== controller.state().preference) controller.choose(saved);
		return;
	}
	if (controller.remembered()) save?.(controller.state().preference);
}
