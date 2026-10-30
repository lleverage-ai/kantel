/**
 * What a theme is: data, not code. A theme names a value for each of Harbour's colour tokens (`--hb-canvas`,
 * `--hb-text-muted`, `--hb-status-done`, `--hb-syntax-keyword`...) and whether it is light or dark. Everything that
 * isn't colour (type, space, radius, motion) stays in tokens.css and is the same in every theme.
 *
 * A theme can leave tokens out. A *palette* token it leaves out comes from the theme it extends (Harbour or Harbour
 * light, by its kind); a *derived* token it leaves out is worked out from its other tokens in CSS (a hover is the
 * theme's own text at 5%), so a theme of a dozen colours still covers the whole interface. See docs/theming.md.
 *
 * Portable and dependency-free: the built-in themes, a theme from JSON (`parseTheme`) and the tests all use it.
 */

export type ThemeKind = "dark" | "light";

export type TokenGroup = "surface" | "line" | "text" | "accent" | "status" | "diff" | "effect" | "syntax" | "terminal";

export type TokenSpec = {
	/** The token's name without `--hb-`: `canvas`, `text-muted`, `syntax-keyword`. */
	readonly name: string;
	readonly group: TokenGroup;
	/** What it is for, for the docs and a theme editor. */
	readonly description: string;
	/**
	 * How the token is worked out from the theme's others when it doesn't set it, as CSS. Without one the token is a
	 * palette token: left out, it comes from the theme this one extends.
	 */
	readonly derive?: string | ((kind: ThemeKind) => string);
};

const shadowFloat = (kind: ThemeKind) =>
	kind === "dark"
		? "0 12px 32px -12px rgb(0 0 0 / 0.75), 0 0 0 1px var(--hb-border-strong)"
		: "0 12px 32px -12px rgb(0 0 0 / 0.2), 0 0 0 1px var(--hb-border-strong)";
const shadowComposer = (kind: ThemeKind) =>
	kind === "dark" ? "0 14px 32px -18px rgb(0 0 0 / 0.75)" : "0 14px 32px -18px rgb(0 0 0 / 0.22)";
const mixText = (dark: number, light: number) => (kind: ThemeKind) =>
	`color-mix(in srgb, var(--hb-text) ${kind === "dark" ? dark : light}%, transparent)`;

const terminal = (name: string, description: string, value: string): TokenSpec => ({
	name,
	group: "terminal",
	description,
	derive: value,
});

/** The 16 ANSI colours by palette index (0-7 normal, 8-15 bright), after VS Code's dark terminal. */
const ANSI = [
	"#6e7681",
	"#f14c4c",
	"#23d18b",
	"#e5e510",
	"#3b8eea",
	"#d670d6",
	"#29b8db",
	"#e5e5e5",
	"#8b949e",
	"#ff7b72",
	"#56d364",
	"#f5f543",
	"#79c0ff",
	"#f778ba",
	"#56d4dd",
	"#ffffff",
];

const TERMINAL_TOKENS: readonly TokenSpec[] = [
	terminal("terminal", "The inline terminal's well", "#050505"),
	terminal("terminal-text", "A terminal's text", "#d4d4d4"),
	terminal("terminal-prompt", "The prompt before a command", "#7ee787"),
	terminal("terminal-stderr", "What a command wrote to stderr, when a tool keeps it apart", "#ffa198"),
	...ANSI.map((value, index) => terminal(`ansi-${index}`, `ANSI colour ${index}`, value)),
];

/**
 * Every colour token a theme sets, in the order a theme's CSS lists them. A new colour token in tokens.css belongs
 * here too (theme.test.ts fails otherwise), so that every theme sets it.
 */
export const THEME_TOKENS: readonly TokenSpec[] = [
	// Surfaces.
	{ name: "canvas", group: "surface", description: "The page behind everything" },
	{ name: "panel", group: "surface", description: "A framed area in the flow: the sidebar, a panel, a tool's detail" },
	{ name: "raised", group: "surface", description: "Things that sit above the page: cards, menus, the composer" },
	{ name: "sunken", group: "surface", description: "Inputs and wells, set into a surface" },
	{ name: "user-message", group: "surface", description: "A person's message bubble in the transcript" },
	{ name: "code", group: "surface", description: "Code blocks, inline code and a tool's arguments and output" },
	{ name: "hover", group: "surface", description: "A row or control under the pointer", derive: mixText(5, 5) },
	{ name: "active", group: "surface", description: "A control being pressed", derive: mixText(8, 9) },
	{ name: "selected", group: "surface", description: "The selected row in a list", derive: mixText(7, 7) },
	{
		name: "scrim",
		group: "surface",
		description: "Behind a modal dialog",
		derive: (kind) => (kind === "dark" ? "rgb(0 0 0 / 0.6)" : "rgb(0 0 0 / 0.3)"),
	},
	// Lines.
	{ name: "border", group: "line", description: "Hairlines between things", derive: mixText(6, 10) },
	{
		name: "border-strong",
		group: "line",
		description: "A line that must be seen: a card's edge",
		derive: mixText(11, 16),
	},
	{ name: "border-input", group: "line", description: "An input's edge", derive: mixText(11, 18) },
	// Text.
	{ name: "text", group: "text", description: "Body text and headings; at least 4.5:1 on every surface" },
	{ name: "text-muted", group: "text", description: "Secondary text; at least 4.5:1 on every surface" },
	{
		name: "text-faint",
		group: "text",
		description: "Meta text: times, counts, hints; at least 4.5:1 on canvas and panel",
	},
	{ name: "text-disabled", group: "text", description: "A control that can't be used; not body text" },
	// The accent.
	{ name: "accent", group: "accent", description: "The one accent: primary buttons, the focus ring's colour" },
	{ name: "accent-hover", group: "accent", description: "A primary button under the pointer" },
	{ name: "accent-fg", group: "accent", description: "Text on the accent" },
	{ name: "accent-text", group: "accent", description: "The accent as text: links; at least 4.5:1 on canvas" },
	{
		name: "accent-soft",
		group: "accent",
		description: "A tint of the accent behind something marked",
		derive: "color-mix(in srgb, var(--hb-accent) 16%, transparent)",
	},
	{
		name: "focus",
		group: "accent",
		description: "The keyboard focus ring",
		derive: "color-mix(in srgb, var(--hb-accent-text) 80%, transparent)",
	},
	// Status.
	{ name: "status-working", group: "status", description: "The agent is working" },
	{ name: "status-waiting", group: "status", description: "Waiting on an answer from you" },
	{ name: "status-approval", group: "status", description: "Waiting on your approval" },
	{ name: "status-done", group: "status", description: "Done" },
	{ name: "status-error", group: "status", description: "Failed" },
	{ name: "status-idle", group: "status", description: "Nothing happening" },
	...(["working", "waiting"] as const).map((status) => ({
		name: `status-${status}-soft`,
		group: "status" as const,
		description: `A tint of status-${status} behind its label`,
		derive: `color-mix(in srgb, var(--hb-status-${status}) 12%, transparent)`,
	})),
	...(["approval", "done", "error"] as const).map((status) => ({
		name: `status-${status}-soft`,
		group: "status" as const,
		description: `A tint of status-${status} behind its label`,
		derive: `color-mix(in srgb, var(--hb-status-${status}) 10%, transparent)`,
	})),
	...(["approval", "error"] as const).map((status) => ({
		name: `status-${status}-line`,
		group: "status" as const,
		description: `The edge of a card that is status-${status}`,
		derive: `color-mix(in srgb, var(--hb-status-${status}) 35%, transparent)`,
	})),
	// Diff.
	{ name: "diff-add", group: "diff", description: "Lines added", derive: "var(--hb-status-done)" },
	{ name: "diff-del", group: "diff", description: "Lines removed", derive: "var(--hb-status-error)" },
	{
		name: "diff-add-soft",
		group: "diff",
		description: "Behind an added line in an edit's diff",
		derive: "color-mix(in srgb, var(--hb-diff-add) 10%, transparent)",
	},
	{
		name: "diff-del-soft",
		group: "diff",
		description: "Behind a removed line in an edit's diff",
		derive: "color-mix(in srgb, var(--hb-diff-del) 10%, transparent)",
	},
	// Effects.
	{ name: "shadow-float", group: "effect", description: "The shadow under a menu or popover", derive: shadowFloat },
	{ name: "shadow-composer", group: "effect", description: "The composer's shadow", derive: shadowComposer },
	{
		name: "glass",
		group: "effect",
		description: "The composer's frosted surface",
		derive: "color-mix(in srgb, var(--hb-raised) 80%, transparent)",
	},
	{ name: "glass-outline", group: "effect", description: "The composer's outline", derive: mixText(7, 12) },
	{
		name: "glass-highlight",
		group: "effect",
		description: "The one-pixel highlight on the composer's top edge",
		derive: (kind) =>
			kind === "dark" ? "inset 0 1px 0 0 rgb(255 255 255 / 0.03)" : "inset 0 1px 0 0 rgb(255 255 255 / 0.6)",
	},
	{
		name: "drop-fill",
		group: "effect",
		description: "Behind a drop target while a file is dragged over it",
		derive: "color-mix(in srgb, var(--hb-accent) 5%, transparent)",
	},
	{
		name: "drop-line",
		group: "effect",
		description: "A drop target's edge",
		derive: "color-mix(in srgb, var(--hb-accent) 60%, transparent)",
	},
	// Syntax: the colours of highlighted code. Each at least 4.5:1 on --hb-code.
	{ name: "syntax-text", group: "syntax", description: "Code that isn't any of the below", derive: "var(--hb-text)" },
	{ name: "syntax-comment", group: "syntax", description: "Comments" },
	{ name: "syntax-keyword", group: "syntax", description: "Keywords: const, if, return, import" },
	{ name: "syntax-string", group: "syntax", description: "Strings" },
	{ name: "syntax-number", group: "syntax", description: "Numbers and literals: 42, true, null" },
	{ name: "syntax-function", group: "syntax", description: "Function and method names, headings" },
	{ name: "syntax-type", group: "syntax", description: "Types, classes and built-ins" },
	{ name: "syntax-property", group: "syntax", description: "Properties, object keys and attributes" },
	{
		name: "syntax-variable",
		group: "syntax",
		description: "Variables and parameters",
		derive: "var(--hb-syntax-text)",
	},
	{
		name: "syntax-operator",
		group: "syntax",
		description: "Operators: =, =>, +",
		derive: "var(--hb-syntax-keyword)",
	},
	{
		name: "syntax-punctuation",
		group: "syntax",
		description: "Brackets, commas and semicolons",
		derive: "var(--hb-text-muted)",
	},
	{ name: "syntax-tag", group: "syntax", description: "Markup tags", derive: "var(--hb-syntax-keyword)" },
	{
		name: "syntax-regexp",
		group: "syntax",
		description: "Regular expressions and links",
		derive: "var(--hb-syntax-string)",
	},
	{
		name: "syntax-meta",
		group: "syntax",
		description: "Directives, decorators, shebangs",
		derive: "var(--hb-syntax-keyword)",
	},
	{ name: "syntax-inserted", group: "syntax", description: "Added lines in a diff", derive: "var(--hb-diff-add)" },
	{ name: "syntax-deleted", group: "syntax", description: "Removed lines in a diff", derive: "var(--hb-diff-del)" },
	// The inline terminal a bash call shows: dark in every theme, as a terminal is, unless a theme sets its own.
	...TERMINAL_TOKENS,
];

export type ThemeTokenName = string;

const specByName = new Map(THEME_TOKENS.map((spec) => [spec.name, spec]));

export const tokenSpec = (name: string): TokenSpec | undefined => specByName.get(name);

/** The tokens a theme must have from somewhere: itself or the theme it extends. */
export const PALETTE_TOKENS: readonly string[] = THEME_TOKENS.filter((spec) => spec.derive === undefined).map(
	(spec) => spec.name,
);

/** Where a theme's colours came from, credited in the picker and the docs. */
export type ThemeSource = {
	/** The theme it is after: "Dracula", "Catppuccin". */
	readonly name: string;
	readonly url: string;
	/** The original's licence, such as "MIT". */
	readonly licence: string;
};

/** A theme as data. Built-in themes and custom ones have the same shape. */
export type ThemeDefinition = {
	/** Lowercase letters, digits and dashes; a custom theme's ID starts with `custom-`. */
	readonly id: string;
	/** As people see it in the picker: "Catppuccin Mocha". */
	readonly name: string;
	readonly kind: ThemeKind;
	/** The theme its missing palette tokens come from. Default: Harbour for a dark theme, Harbour light for a light one. */
	readonly extends?: string;
	/** Token name (without `--hb-`) to a CSS colour. */
	readonly tokens: Readonly<Record<string, string>>;
	readonly source?: ThemeSource;
};

/** A theme with every token worked out: what its CSS sets. */
export type ResolvedTheme = {
	readonly id: string;
	readonly name: string;
	readonly kind: ThemeKind;
	readonly tokens: Readonly<Record<string, string>>;
	readonly source?: ThemeSource;
};

export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A colour value a theme may set: hex, a colour function, a `var(--hb-...)`, a shadow made of those, or a named colour.
 * Nothing that could end the declaration or load anything (`;`, braces, `url(`, quotes, backslashes), since a custom
 * theme's values go into a stylesheet.
 */
const SAFE_VALUE = /^[#a-zA-Z0-9\s().,%/+-]{1,200}$/;
export const isSafeValue = (value: string): boolean => SAFE_VALUE.test(value) && !/url\s*\(|expression/i.test(value);

export type ThemeProblem = { readonly path: string; readonly message: string };

/**
 * Reads a theme from untrusted JSON (a custom theme from storage, an import): checks its shape, drops unknown or unsafe
 * tokens, and says what was wrong. Missing tokens are not a problem; they fall back when the theme is resolved.
 */
export function parseTheme(input: unknown): { theme?: ThemeDefinition; problems: ThemeProblem[] } {
	const problems: ThemeProblem[] = [];
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { problems: [{ path: "", message: "A theme is a JSON object" }] };
	}
	const raw = input as Record<string, unknown>;
	const id = raw.id;
	const name = raw.name;
	const kind = raw.kind;
	if (typeof id !== "string" || !THEME_ID.test(id))
		problems.push({ path: "id", message: "Lowercase letters, digits and dashes, at most 64" });
	if (typeof name !== "string" || name.trim() === "" || name.length > 80)
		problems.push({ path: "name", message: "A name of 1 to 80 characters" });
	if (kind !== "dark" && kind !== "light") problems.push({ path: "kind", message: 'Either "dark" or "light"' });
	if (raw.extends !== undefined && (typeof raw.extends !== "string" || !THEME_ID.test(raw.extends)))
		problems.push({ path: "extends", message: "A theme ID" });
	const tokens: Record<string, string> = {};
	if (typeof raw.tokens !== "object" || raw.tokens === null || Array.isArray(raw.tokens)) {
		problems.push({ path: "tokens", message: "An object of token names to colours" });
	} else {
		for (const [token, value] of Object.entries(raw.tokens as Record<string, unknown>)) {
			if (!specByName.has(token)) problems.push({ path: `tokens.${token}`, message: "Not a theme token; ignored" });
			else if (typeof value !== "string" || !isSafeValue(value))
				problems.push({ path: `tokens.${token}`, message: "Not a colour Harbour accepts; ignored" });
			else tokens[token] = value.trim();
		}
	}
	const fatal = problems.some((problem) => !problem.path.startsWith("tokens."));
	if (fatal) return { problems };
	const source = parseSource(raw.source);
	return {
		theme: {
			id: id as string,
			name: (name as string).trim(),
			kind: kind as ThemeKind,
			...(typeof raw.extends === "string" ? { extends: raw.extends } : {}),
			tokens,
			...(source === undefined ? {} : { source }),
		},
		problems,
	};
}

function parseSource(input: unknown): ThemeSource | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { name, url, licence } = input as Record<string, unknown>;
	if (typeof name !== "string" || typeof url !== "string" || typeof licence !== "string") return undefined;
	if (!/^https:\/\//.test(url)) return undefined;
	return { name, url, licence };
}

/**
 * Works out every token of `theme`: its own, then a derived token's rule, then the palette of the theme it extends.
 * `base` resolves the theme it extends; it is undefined for a theme that extends nothing (Harbour, Harbour light),
 * which must then set every palette token itself.
 */
export function resolveTheme(theme: ThemeDefinition, base: ResolvedTheme | undefined): ResolvedTheme {
	const tokens: Record<string, string> = {};
	for (const spec of THEME_TOKENS) {
		const own = theme.tokens[spec.name];
		if (own !== undefined) tokens[spec.name] = own;
		else if (spec.derive !== undefined)
			tokens[spec.name] = typeof spec.derive === "string" ? spec.derive : spec.derive(theme.kind);
		else if (base?.tokens[spec.name] !== undefined) tokens[spec.name] = base.tokens[spec.name] as string;
	}
	return {
		id: theme.id,
		name: theme.name,
		kind: theme.kind,
		tokens,
		...(theme.source === undefined ? {} : { source: theme.source }),
	};
}

/** The selector a theme's tokens are set on: an element with `data-hb-theme`, and a portal's `hb-theme` layer under it. */
export const themeSelector = (id: string): string =>
	`[data-hb-theme="${id}"][data-hb-theme], [data-hb-theme="${id}"] .hb-theme`;

/** A resolved theme as one CSS rule. */
export function themeCss(theme: ResolvedTheme): string {
	const declarations = THEME_TOKENS.flatMap((spec) => {
		const value = theme.tokens[spec.name];
		return value === undefined || !isSafeValue(value) ? [] : [`--hb-${spec.name}:${value};`];
	});
	return `${themeSelector(theme.id)}{color-scheme:${theme.kind};${declarations.join("")}}`;
}

/** Follows `var(--hb-...)` references through a theme's own tokens to a plain colour, for contrast checks. */
export function plainColour(theme: ResolvedTheme, name: string, depth = 0): string | undefined {
	const value = theme.tokens[name];
	if (value === undefined || depth > 8) return undefined;
	const reference = /^var\(--hb-([a-z0-9-]+)\)$/.exec(value);
	if (reference !== null) return plainColour(theme, reference[1] as string, depth + 1);
	return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}
