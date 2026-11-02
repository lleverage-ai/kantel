# Theming

A theme is data, not code: a name, whether it is light or dark, a colour for each of Kantel's colour tokens and its
three fonts. Switching theme sets one attribute, `data-kt-theme`, on `<html>`. Each theme's CSS rule sets the `--kt-*`
tokens for that attribute, and every component already reads those tokens, so the whole page restyles in the next
frame without rendering anything in React.

Kantel (ID `kantel`), the dark theme, is the default, and its values are `tokens.css`'s `:root` values unchanged
(`theme.test.ts` holds the two together). Kantel and Kantel light (`kantel-light`) follow the Lleverage brand:
midnight `#141e28` and paper `#f9f7f0` as the grounds, paper text on midnight (never pure white), orange `#ec7523` as
the one accent, kept to primary actions, links and the focus ring, and the brand's three faces. Neutral and Neutral
light keep the console's earlier look, after T3 Code, with the system's fonts.

## The pieces

| File | What it is |
| --- | --- |
| `src/tokens/theme-schema.ts` | The model. `THEME_TOKENS` lists every colour token, with its group, its purpose and, for *derived* tokens, how it is worked out from the others. `parseTheme` checks a theme from JSON; `resolveTheme` fills in what a theme leaves out; `themeCss` writes its CSS rule. |
| `src/tokens/themes/` | The built-in themes, one file per family. |
| `src/theme/registry.ts` | The themes a page can choose from: the built-ins, plus any registered from data at runtime. |
| `src/theme/controller.ts` | Applies a theme to the page, previews one, follows the device for System, and remembers the choice in `localStorage`. |
| `src/theme/boot.ts` | The inline script that applies the remembered theme before first paint. |
| `src/theme/theme-picker.tsx` | The command-palette picker and the `Ctrl+K T` (`⌘K T`) shortcut. |
| `src/code/` | Highlighted code: Highlight.js writes `hljs-*` classes and `syntax.css` maps them onto the `--kt-syntax-*` tokens. |

## Tokens

Colour and the three font families are themed. Type sizes, space, radius and motion stay in `tokens.css` and are the
same in every theme.

Tailwind utilities theme the same way: `src/tokens/tailwind.css` maps each token into `@theme inline` as a
`var(--kt-*)` reference, so `bg-canvas` or `text-muted` reads the token and follows the theme with nothing rebuilt
(see [tailwind.md](tailwind.md)).

- **Surfaces**: `canvas`, `panel`, `raised`, `sunken`, `user-message`, `code`, and the derived `hover`, `active`,
  `selected` and `scrim`.
- **Lines**: `border`, `border-strong` and `border-input`, all derived from the theme's text colour.
- **Text**: `text` and `text-muted` (at least 4.5:1 on every surface), `text-faint` (4.5:1 on canvas and panel),
  and `text-disabled`.
- **Accent**: `accent`, `accent-hover`, `accent-fg` (text on the accent), `accent-text` (the accent as link text),
  and the derived `accent-soft` and `focus`.
- **Status**: `status-working`, `status-waiting`, `status-approval`, `status-done`, `status-error` and
  `status-idle`, each at least 4.5:1 on canvas and panel, and no two closer than 0.08 apart in OKLab, so they stay
  distinguishable.
- **Diff and effects**: `diff-add`, `diff-del`, their soft tints `diff-add-soft` and `diff-del-soft` (behind an
  edit's changed lines), the shadows and the composer's glass, all derived by default.
- **Syntax**: `syntax-comment`, `syntax-keyword`, `syntax-string`, `syntax-number`, `syntax-function`,
  `syntax-type` and `syntax-property`, and the derived `syntax-text`, `syntax-variable`, `syntax-operator`,
  `syntax-punctuation`, `syntax-tag`, `syntax-regexp`, `syntax-meta`, `syntax-inserted` and `syntax-deleted`. Each
  is at least 4.5:1 on `code`.
- **Terminal**: `terminal`, `terminal-text`, `terminal-prompt`, `terminal-stderr` and the 16 ANSI colours
  `ansi-0` to `ansi-15` (0-7 normal, 8-15 bright), for a bash call's inline terminal. Derived from the theme's own
  colours, so the terminal sits on `code` as the code view does: its text is `syntax-text`, the prompt
  `status-done`, stderr `status-error`; ANSI red, green, yellow, blue and magenta are the error, done, approval,
  working and waiting colours, cyan halfway between working and done, black and white the faint and muted text, and
  each bright colour its normal one a quarter of the way to `text`. Each is at least 4.5:1 on `terminal`. A theme can
  set its own.
- **Brand**: `brand-ink` (the Kantel mark's tile and the wordmark's letters: grey 900 `#252820` on a light theme,
  white on a dark one, as the approved artwork) and `brand-fulcrum` (the mark's orange). Derived by kind.
- **Fonts**: `font-sans` (the interface and body), `font-display` (display headings: the new-session welcome,
  sign-in, an empty page's title) and `font-mono` (code). Each is a font-family list of unquoted names, falling back
  to the system's fonts. The default is the brand's: Public Sans, Abhaya Libre and Roboto Mono, self-hosted from
  Fontsource packages (SIL Open Font License 1.1: `packages/ui/licences/`) by `src/tokens/fonts.css`, with no call to
  a font CDN. A theme that sets its own, as Neutral does, needs those fonts installed or loaded by its host: a theme
  can't load a font file (no `url()`). Components never name a family: they use `font-sans`, `font-display`,
  `font-mono` or `.kt-mono`.

A *palette* token a theme leaves out comes from the theme it extends: Kantel for a dark theme, Kantel light for a
light one. A *derived* token it leaves out is worked out in CSS from its own colours (a hover is its text at 5%), so
a theme of a dozen colours still covers the whole interface.

## Add a built-in theme

1. Add a file in `src/tokens/themes/` exporting a `ThemeDefinition`: an `id` (lower-case letters, digits and
   dashes), a `name`, its `kind`, a `source` naming the theme it follows and its licence, and its `tokens`. Follow
   the original's palette, but set every surface, text, accent, status and syntax colour yourself: the original's
   own values rarely pass the contrast checks as they are.
2. List it in `src/tokens/themes/index.ts`. The picker shows the built-ins in that order: Kantel and Kantel
   light first, then the dark themes by name, then the light ones.
3. Run `pnpm --filter @kantel/ui test`. `theme.test.ts` checks every theme for WCAG AA body text, status colours
   that can be told apart and syntax colours readable on code, and names the token and ratio that fail.
4. Look at it: the workbench's *Theme / Theme picker / Themes* story shows every theme side by side.

## Use it in a host app

```ts
import { themeBootScript, themeController, ThemePicker, useThemeShortcut } from "@kantel/ui";

themeController(); // once, at start: puts every theme's CSS on the page and applies the remembered one
```

Put `themeBootScript` (also exported from `@kantel/ui/theme-boot`, which has no other imports) in an inline
`<script>` at the top of `<head>`, so the first paint is in the right theme. The console does it in
`vite.config.ts`. Mount one `ThemePicker` and open it from `useThemeShortcut` and a button. Its `onChoose` is where
the host keeps the choice for the person; the console sends it to `PATCH /v1/me/preferences`, and when `GET /v1/me`
answers with a different theme, the server's wins (`apps/console/src/state/theme-sync.ts`).

## Custom themes

Nothing here is specific to built-in themes, so the component library can load a theme it doesn't ship:

- **Schema.** A custom theme is the JSON form of `ThemeDefinition`: `{ "id", "name", "kind", "tokens" }`, with
  `tokens` keyed by token name without `--kt-`. `parseTheme` checks it: an unknown token or an unsafe value (anything
  that could escape the rule, or a `url()`) is dropped with a problem naming it; a bad shape is refused. Custom IDs
  should be prefixed `custom-`, and a built-in can't be replaced.
- **Loading.** `themeController().registry.register(json)` adds it. The registry rewrites the page's theme
  stylesheet, and the picker lists it at once, after the built-ins.
- **First paint.** The boot cache stores the CSS of the theme it applies, so a custom theme paints before the bundle
  loads like a built-in one.

A person's preferences hold only the chosen theme's ID, so the console doesn't store custom themes, and it has no
theme editor.
