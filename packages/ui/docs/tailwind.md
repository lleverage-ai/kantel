# Styling with Tailwind

`@harbour/ui` is styled with Tailwind v4 utilities in each component's `className`. The library used to have one
hand-written .css file per component; those go as each component is converted. Tailwind is set up the CSS-first
way, with no JavaScript config: everything is in [src/tokens/tailwind.css](../src/tokens/tailwind.css).

## How it fits together

- **Tokens stay in tokens.css.** The `--hb-*` custom properties in [src/tokens/tokens.css](../src/tokens/tokens.css)
  are still the only place a value is written, and the themes (src/tokens/themes/, see [theming.md](theming.md))
  still set the colour tokens on `[data-hb-theme]`.
- **tailwind.css maps them, it doesn't copy them.** Its `@theme inline` block names each token for Tailwind with a
  `var(--hb-*)` reference, so `bg-canvas` compiles to `background-color: var(--hb-canvas)` and follows a theme
  switch at runtime. A new token goes in tokens.css first, then in tailwind.css if a utility should reach it.
- **The theme is closed.** `--*: initial` drops Tailwind's defaults, so `bg-red-500`, `text-base`, `rounded-lg`,
  `shadow-md` and `tracking-wide` don't exist. The one default kept is spacing: Tailwind's 4px step,
  `--spacing: 0.25rem`.
- **Builds.** `src/index.ts` imports the entry after tokens.css and base.css, so every host gets it; the host adds
  `@tailwindcss/vite` to its Vite plugins (the console does; the workbench's is `.ladle/vite.config.ts`; the loop's
  harness has its own). Only `packages/ui/src` is scanned for class names (`@source "../"`, with automatic
  detection off).
- **No preflight, for now.** Tailwind's reset would restyle every component still on its own .css, which assume
  browser defaults plus base.css. Only the theme and utilities layers are loaded, and base.css stays the base. A
  converted component sets what it needs itself (`m-0`, `list-none`, `bg-transparent`, `appearance-none`).
  `border` needs no reset: Tailwind v4's border utilities set the style themselves. Turn preflight on once the last
  component .css is gone.
- **The cascade.** Utilities live in the `utilities` cascade layer; component .css files are unlayered, so they win.
  Convert a component whole and delete its .css; don't style one element with both. Another component's .css that
  reaches into it (the sidebar's collapsed rail hides parts of `SignedInAs`) keeps working through the `hb-` class
  names, which stay on the elements as hooks.

## Names

The colour names are the `--hb-` token names, except that text colours drop `text-`, `--hb-text` is `fg` and
`--hb-code` is `code-surface` (so it can't clash with `text-code`, the code font size). Every colour works with every
colour utility: `bg-`, `text-`, `border-`, `ring-`, `outline-`, `fill-`, `stroke-`, `divide-`, and opacity
modifiers such as `bg-accent/50`.

| Token | Utility |
| --- | --- |
| `--hb-canvas`, `-panel`, `-raised`, `-sunken` | `bg-canvas`, `bg-panel`, `bg-raised`, `bg-sunken` |
| `--hb-hover`, `-active`, `-selected`, `-user-message`, `-scrim` | `bg-hover`, `bg-active`, `bg-selected`, `bg-user-message`, `bg-scrim` |
| `--hb-code` | `bg-code-surface` |
| `--hb-border`, `-border-strong`, `-border-input` | `border-border`, `border-border-strong`, `border-border-input` |
| `--hb-text`, `-text-muted`, `-text-faint`, `-text-disabled` | `text-fg`, `text-muted`, `text-faint`, `text-disabled` |
| `--hb-accent`, `-accent-hover`, `-accent-fg`, `-accent-text`, `-accent-soft`, `-focus` | `bg-accent`, `bg-accent-hover`, `text-accent-fg`, `text-accent-text`, `bg-accent-soft`, `outline-focus` |
| `--hb-status-<s>`, `-<s>-soft`, `-<s>-line` | `text-status-working`, `bg-status-done-soft`, `border-status-error-line` |
| `--hb-diff-add`, `-diff-del` | `text-diff-add`, `text-diff-del` |
| `--hb-glass`, `-glass-outline`, `-thumb-scrim`, `-on-solid`, `-drop-fill`, `-drop-line` | `bg-glass`, `border-glass-outline`, `bg-thumb-scrim`, `text-on-solid`, `bg-drop-fill`, `border-drop-line` |
| `--hb-font-sans`, `-font-mono` | `font-sans`, `font-mono` |
| `--hb-text-2xs` … `-text-lg`, `-text-code`, `-text-display` | `text-2xs`, `text-xs`, `text-sm`, `text-md`, `text-lg`, `text-code`, `text-display` |
| `--hb-doc-text`, `-doc-h1` … `-doc-h3` | `text-doc`, `text-doc-h1`, `text-doc-h2`, `text-doc-h3` |
| `--hb-weight-regular`, `-medium`, `-strong` | `font-regular`, `font-medium`, `font-strong` |
| `--hb-leading-tight`, `-leading`, `-leading-prose` | `leading-tight`, `leading-normal`, `leading-prose` (and Tailwind's `leading-none`) |
| `--hb-radius`, `-radius-control`, `-sm`, `-xs`, `-bubble`, `-full` | `rounded-panel`, `rounded-control`, `rounded-sm`, `rounded-xs`, `rounded-bubble`, `rounded-full` |
| `--hb-shadow-float`, `-shadow-composer` | `shadow-float`, `shadow-composer` |
| `--hb-control-xs` … `-control-lg`, `-icon-sm`, `-icon-md`, `-dot`, `-thumb` | `size-control-sm`, `h-control-md`, `size-icon-sm`, `size-dot`, `size-thumb` (any sizing or spacing utility) |
| `--hb-content-width`, `-card-width`, `-sidebar-width`, `-rail-width`, `-popover-width`, `-menu-width`, `-palette-width`, `-share-width`, `-doc-width` | `max-w-content`, `max-w-card`, `w-sidebar`, `w-rail`, `w-popover`, `w-menu`, `w-palette`, `w-share`, `max-w-doc` |
| `--hb-ease`, `-ease-breathe` | `ease-standard`, `ease-breathe`; `transition-*` default to `--hb-duration` and `--hb-ease` |
| `--hb-step-0` … `-step-16` | Tailwind's steps, by the same number: `--hb-step-2` is `p-2`, `--hb-step-1_5` is `gap-1.5` |
| `--hb-gap-within`, `-gap-between`, `-gap-turn`, `-pad-card`, `-pad-panel`, `-gutter`, `-gutter-narrow` | `gap-within`, `mt-between`, `pt-turn`, `p-pad-card`, `p-pad-panel`, `px-gutter`, `px-gutter-narrow` (any spacing utility; [spacing.md](spacing.md)) |
| `--hb-space-1` … `-space-11` (legacy) | Tailwind's steps: 2px `0.5`, 4px `1`, 6px `1.5`, 8px `2`, 10px `2.5`, 12px `3`, 16px `4`, 20px `5`, 24px `6`, 32px `8`, 48px `12` (`p-2`, `gap-1.5`, `mt-6`) |
| `--hb-hairline` | `border` (1px), `divide-y` |

A token with no utility is read directly with Tailwind's variable shorthand: `duration-(--hb-duration-fast)`,
`z-(--hb-z-float)`, `w-(--hb-swatch-width)`, `max-h-(--hb-popover-height)`. That is the only form of arbitrary
value allowed: the token lint (`pnpm --filter @harbour/ui test`) fails on a raw one, such as `p-[13px]`,
`max-w-[40rem]`, `bg-[#fff]` or `duration-[150ms]`. Arbitrary values without a raw size or colour, such as
`grid-cols-[auto_1fr]` or `w-[60%]`, are fine.

## Plain CSS, where utilities are worse

Keep a rule in CSS, with a comment saying why, for:

- keyframes and the animations that use them (`hb-pulse`, `hb-spin` and `hb-shimmer` are in base.css);
- complex selectors: rendered Markdown and other HTML the component doesn't write element by element, state on
  another element (`.hb-sidebar[data-collapsed] .hb-signed-in-as`), long `:has()` chains;
- syntax-highlighting colours (src/code/syntax.css maps Highlight.js's classes onto `--hb-syntax-*`);
- print styles (documents/document-print.css).

## Motion on live rows

Anything that animates while a session is live (transcript rows, the working row, status dots, the streaming
caret) animates `opacity` and `transform` only, never layout or paint properties such as `height`, `width`, `top`
or `background`: the compositor runs those two without the main thread, so a streaming answer doesn't stutter. In
utilities that means `transition-opacity` or `transition-transform`, not `transition-all`.

## Converting a component

1. Move each rule of its .css onto the elements as utilities, using the names above. Keep its `hb-` class names
   where another stylesheet or a test selects on them.
2. Delete the .css file and its import.
3. Shoot its stories before and after (`pnpm build:workbench && node scripts/shoot.ts --only <story ids>`) and
   compare them; they should match.
4. Check it follows a theme switch, such as in the console with the theme picker (`Ctrl+K T`): a utility that
   doesn't change with the theme is reading a copied value, not a token.

The first component converted is `SignedInAs` (src/identity/signed-in-as.tsx).
