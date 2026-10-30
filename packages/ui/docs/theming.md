# Theming

A theme is data, not code: a name, whether it is light or dark, and a colour for each of Harbour's colour tokens.
Switching theme sets one attribute, `data-hb-theme`, on `<html>`. Each theme's CSS rule sets the `--hb-*` colour
tokens for that attribute, and every component already reads those tokens, so the whole page restyles in the next
frame without rendering anything in React.

Harbour, the dark theme the console has always had, is the default, and its colours are `tokens.css`'s `:root`
values unchanged (`theme.test.ts` holds the two together).

## The pieces

| File | What it is |
| --- | --- |
| `src/tokens/theme-schema.ts` | The model. `THEME_TOKENS` lists every colour token, with its group, its purpose and, for *derived* tokens, how it is worked out from the others. `parseTheme` checks a theme from JSON; `resolveTheme` fills in what a theme leaves out; `themeCss` writes its CSS rule. |
| `src/tokens/themes/` | The built-in themes, one file per family. |
| `src/theme/registry.ts` | The themes a page can choose from: the built-ins, plus any registered from data at runtime. |
| `src/theme/controller.ts` | Applies a theme to the page, previews one, follows the device for System, and remembers the choice in `localStorage`. |
| `src/theme/boot.ts` | The inline script that applies the remembered theme before first paint. |
| `src/theme/theme-picker.tsx` | The command-palette picker and the `Ctrl+K T` (`⌘K T`) shortcut. |
| `src/code/` | Highlighted code: Highlight.js writes `hljs-*` classes and `syntax.css` maps them onto the `--hb-syntax-*` tokens. |

## Tokens

Only colour is themed. Type, space, radius and motion stay in `tokens.css` and are the same in every theme.

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
- **Diff and effects**: `diff-add`, `diff-del`, the shadows and the composer's glass, all derived by default.
- **Syntax**: `syntax-comment`, `syntax-keyword`, `syntax-string`, `syntax-number`, `syntax-function`,
  `syntax-type` and `syntax-property`, and the derived `syntax-text`, `syntax-variable`, `syntax-operator`,
  `syntax-punctuation`, `syntax-tag`, `syntax-regexp`, `syntax-meta`, `syntax-inserted` and `syntax-deleted`. Each
  is at least 4.5:1 on `code`.

A *palette* token a theme leaves out comes from the theme it extends: Harbour for a dark theme, Harbour light for a
light one. A *derived* token it leaves out is worked out in CSS from its own colours (a hover is its text at 5%), so
a theme of a dozen colours still covers the whole interface.

## Add a built-in theme

1. Add a file in `src/tokens/themes/` exporting a `ThemeDefinition`: an `id` (lower-case letters, digits and
   dashes), a `name`, its `kind`, a `source` naming the theme it follows and its licence, and its `tokens`. Follow
   the original's palette, but set every surface, text, accent, status and syntax colour yourself: the original's
   own values rarely pass the contrast checks as they are.
2. List it in `src/tokens/themes/index.ts`. The picker shows the built-ins in that order: Harbour and Harbour
   light first, then the dark themes by name, then the light ones.
3. Run `pnpm --filter @harbour/ui test`. `theme.test.ts` checks every theme for WCAG AA body text, status colours
   that can be told apart and syntax colours readable on code, and names the token and ratio that fail.
4. Look at it: the workbench's *Theme / Theme picker / Themes* story shows every theme side by side.

## Use it in a host app

```ts
import { themeBootScript, themeController, ThemePicker, useThemeShortcut } from "@harbour/ui";

themeController(); // once, at start: puts every theme's CSS on the page and applies the remembered one
```

Put `themeBootScript` (also exported from `@harbour/ui/theme-boot`, which has no other imports) in an inline
`<script>` at the top of `<head>`, so the first paint is in the right theme. The console does it in
`vite.config.ts`. Mount one `ThemePicker` and open it from `useThemeShortcut` and a button. Its `onChoose` is where
the host keeps the choice for the person; the console sends it to `PATCH /v1/me/preferences`, and when `GET /v1/me`
answers with a different theme, the server's wins (`apps/console/src/state/theme-sync.ts`).

## Custom themes: the next step

Nothing here is specific to built-in themes, so a person's own themes need no new machinery:

- **Schema.** A custom theme is the JSON form of `ThemeDefinition`: `{ "id", "name", "kind", "tokens" }`, with
  `tokens` keyed by token name without `--hb-`. `parseTheme` checks it: an unknown token or an unsafe value (anything
  that could escape the rule, or a `url()`) is dropped with a problem naming it; a bad shape is refused. Custom IDs
  should be prefixed `custom-`, and a built-in can't be replaced.
- **Loading.** `themeController().registry.register(json)` adds it. The registry rewrites the page's theme
  stylesheet, and the picker lists it at once, after the built-ins.
- **Storage.** A person's themes would be one more field in their preferences, `customThemes`, kept the way `theme`
  is: as JSON in `identity_user_preferences` (`packages/identity/src/sql.ts`), changed through
  `PATCH /v1/me/preferences` and returned in `GET /v1/me`. `changedPreferences` in `packages/identity/src/index.ts`
  is where its validation would go, with `parseTheme` and a size limit.
- **First paint.** The boot cache already stores the CSS of the theme it applies, so a custom theme paints before
  the bundle loads like a built-in one.
- **Still to do.** An editor (pick a few colours, see the contrast checks live), import and export, and sharing a
  theme with an organisation.
