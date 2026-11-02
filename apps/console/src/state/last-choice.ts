// The model and thinking level a person last chose, kept for them on the server (`UserPreferences.lastModel` and
// `lastThinking`) so New session preselects them in any browser. Read from `/v1/me` as the console boots, then kept
// here as messages go: each send's choice is written back only when it differs from what is kept, fire and forget.

import type { UserPreferences, UserPreferencesChange } from "@kantel/contracts";
import type { LastChoice } from "../api/client.ts";

/** The console client's `lastChoice` and `rememberChoice`, over the person's preferences and a way to change them. */
export function keptChoice(
	preferences: UserPreferences | undefined,
	save: (change: UserPreferencesChange) => Promise<unknown>,
): { lastChoice: () => LastChoice; rememberChoice: (choice: LastChoice) => void } {
	let kept: LastChoice = {
		...(preferences?.lastModel === undefined ? {} : { model: preferences.lastModel }),
		...(preferences?.lastThinking === undefined ? {} : { thinking: preferences.lastThinking }),
	};
	return {
		lastChoice: () => kept,
		rememberChoice: (choice) => {
			// A choice leaves out what it didn't carry (a model that can't think has no level): that stays as it was.
			const change: { -readonly [K in keyof UserPreferencesChange]: UserPreferencesChange[K] } = {};
			if (choice.model !== undefined && choice.model !== kept.model) change.lastModel = choice.model;
			if (choice.thinking !== undefined && choice.thinking !== kept.thinking) change.lastThinking = choice.thinking;
			if (Object.keys(change).length === 0) return;
			kept = { ...kept, ...choice };
			save(change).catch((error: unknown) => {
				console.info("kantel: couldn't keep the model choice:", error instanceof Error ? error.message : error);
			});
		},
	};
}
