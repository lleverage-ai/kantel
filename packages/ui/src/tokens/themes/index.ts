// The themes Harbour ships, in the picker's order: Harbour's own first, then the rest by name within dark and light.
// To add one: a file here with a `ThemeDefinition`, listed below. docs/theming.md has the checklist.

import type { ThemeDefinition } from "../theme-schema.ts";
import { catppuccinLatte, catppuccinMocha } from "./catppuccin.ts";
import { dracula } from "./dracula.ts";
import { githubLight } from "./github-light.ts";
import { gruvbox } from "./gruvbox.ts";
import { harbour, harbourLight } from "./harbour.ts";
import { nord } from "./nord.ts";
import { oneDark } from "./one-dark.ts";
import { rosePine } from "./rose-pine.ts";
import { solarizedLight } from "./solarized-light.ts";
import { tokyoNight } from "./tokyo-night.ts";

export const builtinThemes: readonly ThemeDefinition[] = [
	harbour,
	harbourLight,
	catppuccinMocha,
	dracula,
	gruvbox,
	nord,
	oneDark,
	rosePine,
	tokyoNight,
	catppuccinLatte,
	githubLight,
	solarizedLight,
];

/** The theme a person sees until they choose one, and the dark half of System. */
export const DEFAULT_THEME = harbour.id;
/** The light half of System. */
export const DEFAULT_LIGHT_THEME = harbourLight.id;
