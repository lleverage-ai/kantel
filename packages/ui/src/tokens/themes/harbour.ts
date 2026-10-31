import type { ThemeDefinition } from "../theme-schema.ts";

/**
 * Kantel: the console's own dark look, after the Lleverage brand. Midnight (#141e28) is the canvas, paper (#f9f7f0)
 * the text, never pure white, and orange (#ec7523) the one accent, kept to primary actions, links and the focus ring.
 * Its values are tokens.css's, token for token (theme.test.ts holds them together), so choosing it changes nothing. It
 * extends nothing: every other dark theme takes the palette tokens it leaves out from here.
 *
 * The status colours are the brand's product set (info, success, warning, destructive) lifted until each passes AA on
 * midnight, plus an indigo for waiting on you. Type is the brand's: Public Sans for the interface, Abhaya Libre for
 * display headings and Roboto Mono for code (theme-schema.ts, the font tokens).
 */
export const harbour: ThemeDefinition = {
	id: "harbour",
	name: "Kantel",
	kind: "dark",
	tokens: {
		canvas: "#141e28",
		panel: "#18232e",
		raised: "#1e2a36",
		sunken: "#0f1720",
		hover: "rgb(249 247 240 / 0.05)",
		active: "rgb(249 247 240 / 0.08)",
		selected: "rgb(249 247 240 / 0.07)",
		"user-message": "#2c353e",
		code: "#101922",
		scrim: "rgb(8 12 16 / 0.6)",
		border: "rgb(249 247 240 / 0.07)",
		"border-strong": "rgb(249 247 240 / 0.12)",
		"border-input": "rgb(249 247 240 / 0.13)",
		text: "#f9f7f0",
		"text-muted": "#bdbbb3",
		"text-faint": "#9d9b94",
		"text-disabled": "#5f656b",
		accent: "#ec7523",
		"accent-hover": "#ff9626",
		"accent-fg": "#141e28",
		"accent-text": "#f08a47",
		"status-working": "#6aa6dc",
		"status-waiting": "#a9a6f0",
		"status-approval": "#d9b84a",
		"status-done": "#5cbf8a",
		"status-error": "#f07c74",
		"status-idle": "#9d9b94",
		"diff-add": "#5cbf8a",
		"diff-del": "#f07c74",
		"glass-outline": "rgb(249 247 240 / 0.08)",
		"syntax-comment": "#8a929c",
		"syntax-keyword": "#c3a6ff",
		"syntax-string": "#a5d6a7",
		"syntax-number": "#f5b97a",
		"syntax-function": "#8fb4f5",
		"syntax-type": "#6fd3e3",
		"syntax-property": "#f0a6c8",
		"syntax-operator": "#bdbbb3",
		"syntax-tag": "#f28b82",
	},
};

/**
 * Kantel light: the same interface on paper, the brand's page ground, with white for things raised above it. For
 * daylight and for System when the device is light. Text is midnight; the accent is the same orange, and links take a
 * darker cut of it so they pass AA on paper.
 */
export const harbourLight: ThemeDefinition = {
	id: "harbour-light",
	name: "Kantel light",
	kind: "light",
	tokens: {
		canvas: "#f9f7f0",
		panel: "#f1efe6",
		raised: "#ffffff",
		sunken: "#efede4",
		"user-message": "#ecebe1",
		code: "#f3f1ea",
		text: "#141e28",
		"text-muted": "#4f4f4c",
		"text-faint": "#656563",
		"text-disabled": "#abaca7",
		accent: "#ec7523",
		"accent-hover": "#d9661a",
		"accent-fg": "#141e28",
		"accent-text": "#a84d0c",
		"status-working": "#2f6a9f",
		"status-waiting": "#5650b8",
		"status-approval": "#7f6200",
		"status-done": "#2f7650",
		"status-error": "#b3312b",
		"status-idle": "#656563",
		"syntax-comment": "#636b78",
		"syntax-keyword": "#7c3aed",
		"syntax-string": "#13763a",
		"syntax-number": "#a54b07",
		"syntax-function": "#1d4ed8",
		"syntax-type": "#0e7490",
		"syntax-property": "#be185d",
		"syntax-operator": "#4f4f4c",
		"syntax-tag": "#b91c1c",
	},
};
