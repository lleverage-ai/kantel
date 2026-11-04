# Theming

Kantel has two themes, dark and light, and a person chooses System, Light or Dark. System follows the device's
`prefers-color-scheme` and changes with it. Dark is the default until they choose.

Each theme is one palette in one file: `src/tokens/dark.css` and `src/tokens/light.css`. Switching sets one attribute,
`data-kt-theme="dark"` or `"light"`, on `<html>`; both palettes are already in the page's stylesheet and every
component reads the `--kt-*` tokens, so the page restyles in the next frame without rendering anything in React.

Both follow the Lleverage brand: paper `#f9f7f0` as the light ground, paper text on the dark one (never pure white),
orange `#ec7523` as the accent for links and the focus ring, and the brand's three faces. Light is "Crisp": paper,
with a near-black navy primary button and white text on it. Dark is "Bold": neutral greys with no blue, and an orange
primary button with dark text on it. The primary action has its own tokens (`primary`, `primary-hover`, `primary-fg`)
so a theme can draw it apart from the accent.

## The pieces

| File | What it is |
| --- | --- |
| `src/tokens/dark.css` | The dark palette: every colour the dark theme sets. On `:root`, so it is also what paints before any script. |
| `src/tokens/light.css` | The light palette, the same tokens, on `[data-kt-theme="light"]`. |
| `src/tokens/tokens.css` | Imports the two, and holds the formulas built on them (soft tints, the focus ring, the terminal, the derived syntax colours) and everything the same in both: fonts, type, space, radius, motion. |
| `src/tokens/theme.test.ts` | Holds the two palettes to the same tokens and checks each for contrast. |
| `src/theme/controller.ts` | Applies the preference to the page, follows the device for System, and remembers the choice in `localStorage`. |
| `src/theme/boot.ts` | The inline script that applies the remembered theme before first paint. |
| `src/theme/theme-switch.tsx` | `ThemeSwitch`, the System / Light / Dark segmented control, and `useThemeMenuEntry`, the same three choices as a submenu (the console's own menu uses it). |
| `src/code/` | Highlighted code: Highlight.js writes `hljs-*` classes and `syntax.css` maps them onto the `--kt-syntax-*` tokens. |

## Tokens

Colour is themed. The three font families, type sizes, space, radius and motion are in `tokens.css` and the same in
both themes.

Tailwind utilities theme the same way: `src/tokens/tailwind.css` maps each token into `@theme inline` as a
`var(--kt-*)` reference, so `bg-canvas` or `text-muted` reads the token and follows the theme with nothing rebuilt
(see [tailwind.md](tailwind.md)).

- **Surfaces**: `canvas`, `panel`, `raised`, `sunken`, `user-message`, `code`, `hover`, `active`, `selected` and
  `scrim`.
- **Lines**: `border`, `border-strong` and `border-input`.
- **Text**: `text` and `text-muted` (at least 4.5:1 on every surface), `text-faint` (4.5:1 on canvas and panel),
  and `text-disabled`.
- **Accent**: `accent`, `accent-hover`, `accent-fg` (text on the accent), `accent-text` (the accent as link text),
  and, in `tokens.css`, `accent-soft` and `focus`.
- **Primary**: `primary`, `primary-hover` and `primary-fg` (text on the primary button, at least 4.5:1 on both),
  for the primary button alone.
- **Status**: `status-working`, `status-waiting`, `status-approval`, `status-done`, `status-error` and
  `status-idle`, each at least 4.5:1 on canvas and panel, and no two closer than 0.08 apart in OKLab, so they stay
  distinguishable. Their soft fills and lines are in `tokens.css`.
- **Diff and effects**: `diff-add` and `diff-del` (the done and error colours) and their soft tints in `tokens.css`;
  the shadows and the composer's glass in each palette.
- **Syntax**: `syntax-comment`, `syntax-keyword`, `syntax-string`, `syntax-number`, `syntax-function`,
  `syntax-type`, `syntax-property` and the rest, each at least 4.5:1 on `code`.
- **Terminal**: `terminal`, `terminal-text`, `terminal-prompt`, `terminal-stderr` and the 16 ANSI colours
  `ansi-0` to `ansi-15`, for a bash call's inline terminal, worked out in `tokens.css` from the palette's own colours,
  so the terminal sits on `code` as the code view does. Each is at least 4.5:1 on `terminal`.
- **Brand**: `brand-ink` (the Kantel mark's tile and the wordmark's letters: white on dark, grey 900 `#252820` on
  light, as the approved artwork) and `brand-fulcrum` (the mark's orange).

Components never name a colour or a font family: they use the tokens. `pnpm --filter @kantel/ui lint:tokens` fails on
a raw colour anywhere but `tokens.css`, `dark.css` and `light.css`.

## Change a palette

1. Edit `dark.css` or `light.css`. Both set the same tokens; one set in only one of them fails the test, so nothing
   of the other theme shows through.
2. Run `pnpm --filter @kantel/ui test`. `theme.test.ts` checks both for WCAG AA body text, status colours that can be
   told apart, syntax and terminal colours readable on code, and names the token and ratio that fail.
3. If the dark canvas changes, change the browser chrome's copy of it too: the dark `theme-color` in
   `apps/console/index.html` and the colours in `apps/console/public/manifest.webmanifest`.
4. Look at it: every story in the workbench (`pnpm --filter @kantel/ui dev`) has a dark and a light theme in its
   toolbar.

## Use it in a host app

```ts
import { themeBootScript, themeController, ThemeSwitch } from "@kantel/ui";

themeController(); // once, at start: applies the remembered preference and follows the device for System
```

Put `themeBootScript` (also exported from `@kantel/ui/theme-boot`, which has no other imports) in an inline
`<script>` at the top of `<head>`, so the first paint is in the right theme. The console does it in
`vite.config.ts`. Mount a `ThemeSwitch`; the console has one in the sidebar's foot. Its `onChoose` is where the host
keeps the choice for the person: the console sends it to `PATCH /v1/me/preferences`, and when `GET /v1/me` answers
with a different theme, the server's wins (`apps/console/src/state/theme-sync.ts`).

## Preferences from before light and dark

Kantel once shipped more themes (Nord, Catppuccin, Rose Pine and others) and let a host register custom ones. A
preference saved then, on the server or in a browser, is migrated to the nearer of light and dark by the luminance of
the theme's canvas, or to System when the canvas is mid-grey or unknown (`themePreference` in
`@kantel/contracts`). Kantel migrates the server's copy as it reads and writes it; the theme controller migrates this
browser's (version 1 of its cache) on first load and writes it back as version 2. Migrating again changes nothing.
