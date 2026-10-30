import {
	parseTheme,
	type ResolvedTheme,
	resolveTheme,
	type ThemeDefinition,
	type ThemeProblem,
	themeCss,
} from "../tokens/theme-schema.ts";
import { builtinThemes, DEFAULT_LIGHT_THEME, DEFAULT_THEME } from "../tokens/themes/index.ts";

// The themes a page can choose from: the built-in ones, and any registered at runtime from data (a person's custom
// themes, read from wherever the host keeps them). Each is resolved once, when it is added, so choosing one is only
// setting an attribute; its CSS rule is ready in the registry's stylesheet before anyone picks it.

export type ThemeRegistry = {
	/** Every theme, built-in ones first, in the picker's order. */
	list(): readonly ResolvedTheme[];
	get(id: string): ResolvedTheme | undefined;
	/** Whether the theme ships with Harbour. A built-in theme can't be replaced or removed. */
	builtin(id: string): boolean;
	/**
	 * Adds or replaces a custom theme from untrusted data (JSON from storage or a file). Unknown and unsafe tokens are
	 * dropped and named in `problems`; missing ones fall back. Refused, with problems, when its shape is wrong or its ID
	 * is a built-in theme's.
	 */
	register(input: unknown): { theme?: ResolvedTheme; problems: ThemeProblem[] };
	remove(id: string): void;
	/** Every theme's CSS rule, for the page's theme stylesheet. */
	css(): string;
	/** Told when a theme is added, replaced or removed. */
	subscribe(listener: () => void): () => void;
};

/** The theme a definition falls back to: the one it names, else Harbour or Harbour light by its kind. */
const baseId = (theme: ThemeDefinition): string | undefined =>
	theme.extends ??
	(theme.id === DEFAULT_THEME || theme.id === DEFAULT_LIGHT_THEME
		? undefined
		: theme.kind === "light"
			? DEFAULT_LIGHT_THEME
			: DEFAULT_THEME);

export function createThemeRegistry(builtins: readonly ThemeDefinition[] = builtinThemes): ThemeRegistry {
	const resolved = new Map<string, ResolvedTheme>();
	const builtinIds = new Set(builtins.map((theme) => theme.id));
	const listeners = new Set<() => void>();
	const resolve = (theme: ThemeDefinition): ResolvedTheme => {
		const base = baseId(theme);
		return resolveTheme(theme, base === undefined || base === theme.id ? undefined : resolved.get(base));
	};
	// The two roots first: every other theme falls back to one of them.
	const ordered = [...builtins].sort((a, b) => Number(baseId(a) !== undefined) - Number(baseId(b) !== undefined));
	for (const theme of ordered) resolved.set(theme.id, resolve(theme));
	const order = (): ResolvedTheme[] => [
		...builtins.map((theme) => resolved.get(theme.id) as ResolvedTheme),
		...[...resolved.values()].filter((theme) => !builtinIds.has(theme.id)),
	];
	let cache: { list: ResolvedTheme[]; css: string } | undefined;
	const changed = () => {
		cache = undefined;
		for (const listener of listeners) listener();
	};
	const snapshot = () => {
		if (cache === undefined) {
			const list = order();
			cache = { list, css: list.map(themeCss).join("\n") };
		}
		return cache;
	};
	return {
		list: () => snapshot().list,
		get: (id) => resolved.get(id),
		builtin: (id) => builtinIds.has(id),
		register(input) {
			const { theme, problems } = parseTheme(input);
			if (theme === undefined) return { problems };
			if (builtinIds.has(theme.id)) {
				return { problems: [...problems, { path: "id", message: "A built-in theme's ID; pick another" }] };
			}
			const made = resolve(theme);
			resolved.set(theme.id, made);
			changed();
			return { theme: made, problems };
		},
		remove(id) {
			if (builtinIds.has(id) || !resolved.delete(id)) return;
			changed();
		},
		css: () => snapshot().css,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
