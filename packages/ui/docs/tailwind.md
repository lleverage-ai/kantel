# Styling with Tailwind

`@kantel/ui` is styled with Tailwind v4 utilities in each component's `className`. The library used to have one
hand-written .css file per component; those go as each component is converted. Tailwind is set up the CSS-first
way, with no JavaScript config: everything is in [src/tokens/tailwind.css](../src/tokens/tailwind.css).

## How it fits together

- **Tokens stay in tokens.css.** The `--kt-*` custom properties in [src/tokens/tokens.css](../src/tokens/tokens.css)
  are still the only place a value is written, and the two themes' palettes (src/tokens/dark.css and light.css, see
  [theming.md](theming.md)) still set the colour tokens.
- **tailwind.css maps them, it doesn't copy them.** Its `@theme inline` block names each token for Tailwind with a
  `var(--kt-*)` reference, so `bg-canvas` compiles to `background-color: var(--kt-canvas)` and follows a theme
  switch at runtime. A new token goes in tokens.css first, then in tailwind.css if a utility should reach it.
- **The theme is closed.** `--*: initial` drops Tailwind's defaults, so `bg-red-500`, `text-base`, `rounded-lg`,
  `shadow-md` and `tracking-wide` don't exist. The one default kept is spacing: Tailwind's 4px step,
  `--spacing: 0.25rem`.
- **Builds.** `src/index.ts` imports the entry after tokens.css and base.css, so every host gets it; the host adds
  `@tailwindcss/vite` to its Vite plugins (the console does; the workbench's is `.ladle/vite.config.ts`; the loop's
  harness has its own). `packages/ui/src` and the console's `apps/console/src` are scanned for class names
  (`@source "../"` and `@source "../../../../apps/console/src"`, with automatic detection off), whichever of them
  builds. A new host adds its `src/` there rather than a Tailwind entry of its own: a second entry emits a second
  utilities sheet later in the page, whose copy of a utility beats a more specific one in the first (`p-2` over
  `px-4`).
- **Preflight is on.** Tailwind's reset is loaded in the `base` layer (`@import "tailwindcss/preflight.css"
  layer(base)` in tailwind.css): every element starts with no margin or padding, `border: 0 solid` and
  `box-sizing: border-box`; lists are unmarked; headings and links inherit their type and colour; buttons, inputs
  and selects take the page's font, size and line height rather than the browser's form font; images, svg, video,
  canvas and iframes are `display: block`; and a `<dialog>` loses its centring margin. Its page and code fonts are
  Kantel's (`--default-font-family` and `--default-mono-font-family` in `@theme`), so a bare `<code>` or `<pre>`
  is in `--kt-font-mono`, not the browser's monospace. Being layered, it loses to utilities and to the component
  .css that remains (unlayered), so a component says what it wants beyond the reset itself: `m-auto` on a modal
  dialog, `list-disc` on a list that should show bullets, a `leading-*` on a button whose text should be tighter
  than the page's. Rendered Markdown, which the component doesn't write element by element, keeps its list markers
  in session/markdown.css. Don't add CSS that undoes preflight for everything (a page-wide `ol { list-style:
  decimal }`). base.css keeps what preflight doesn't do: the `kt-app` root's colours and type, the focus ring,
  `kt-sr-only`, `kt-mono`, the keyframes, the theme switch and reduced motion; its old `box-sizing` rule went,
  as preflight sets that on every element (on the `kt-app` root too, so its padding no longer adds to its
  `min-height`). Two things that rendered outside that old rule's reach say what they had: the menu panel, on the
  body outside `kt-app`, is `box-content`, and a disabled select is `disabled:opacity-70`, the browser's fade that
  preflight's `opacity: 1` on controls takes away.
- **The cascade.** Utilities live in the `utilities` cascade layer; component .css files are unlayered, so they win.
  Convert a component whole and delete its .css; don't style one element with both. Another component's .css that
  reaches into it (the sidebar's collapsed rail hides parts of `SignedInAs`) keeps working through the `kt-` class
  names, which stay on the elements as hooks.

## Names

The colour names are the `--kt-` token names, except that text colours drop `text-`, `--kt-text` is `fg` and
`--kt-code` is `code-surface` (so it can't clash with `text-code`, the code font size). Every colour works with every
colour utility: `bg-`, `text-`, `border-`, `ring-`, `outline-`, `fill-`, `stroke-`, `divide-`, and opacity
modifiers such as `bg-accent/50`.

| Token | Utility |
| --- | --- |
| `--kt-canvas`, `-panel`, `-raised`, `-sunken` | `bg-canvas`, `bg-panel`, `bg-raised`, `bg-sunken` |
| `--kt-hover`, `-active`, `-selected`, `-user-message`, `-scrim` | `bg-hover`, `bg-active`, `bg-selected`, `bg-user-message`, `bg-scrim` |
| `--kt-code` | `bg-code-surface` |
| `--kt-border`, `-border-strong`, `-border-input` | `border-border`, `border-border-strong`, `border-border-input` |
| `--kt-text`, `-text-muted`, `-text-faint`, `-text-disabled` | `text-fg`, `text-muted`, `text-faint`, `text-disabled` |
| `--kt-accent`, `-accent-hover`, `-accent-fg`, `-accent-text`, `-accent-soft`, `-focus` | `bg-accent`, `bg-accent-hover`, `text-accent-fg`, `text-accent-text`, `bg-accent-soft`, `outline-focus` |
| `--kt-primary`, `-primary-hover`, `-primary-fg` | `bg-primary`, `bg-primary-hover`, `text-primary-fg` |
| `--kt-status-<s>`, `-<s>-soft`, `-<s>-line` | `text-status-working`, `bg-status-done-soft`, `border-status-error-line` |
| `--kt-diff-add`, `-diff-del` | `text-diff-add`, `text-diff-del` |
| `--kt-glass`, `-glass-outline`, `-thumb-scrim`, `-on-solid`, `-drop-fill`, `-drop-line` | `bg-glass`, `border-glass-outline`, `bg-thumb-scrim`, `text-on-solid`, `bg-drop-fill`, `border-drop-line` |
| `--kt-font-sans`, `-font-mono` | `font-sans`, `font-mono` |
| `--kt-text-xs` … `-text-lg`, `-text-heading`, `-text-code`, `-text-display` | `text-xs`, `text-sm`, `text-md`, `text-lg`, `text-heading`, `text-code`, `text-display` |
| `--kt-doc-text`, `-doc-h1` … `-doc-h3` | `text-doc`, `text-doc-h1`, `text-doc-h2`, `text-doc-h3` |
| `--kt-weight-regular`, `-medium`, `-strong` | `font-regular`, `font-medium`, `font-strong` |
| `--kt-leading-tight`, `-leading`, `-leading-prose` | `leading-tight`, `leading-normal`, `leading-prose` (and Tailwind's `leading-none`) |
| `--kt-radius`, `-radius-control`, `-sm`, `-xs`, `-bubble`, `-full` | `rounded-panel`, `rounded-control`, `rounded-sm`, `rounded-xs`, `rounded-bubble`, `rounded-full` |
| `--kt-shadow-float`, `-shadow-composer` | `shadow-float`, `shadow-composer` |
| `--kt-logo-edge`, `-logo-dark-mark`, `-logo-light-mark` | `drop-shadow-logo`, `filter-(--kt-logo-dark-mark)`, `filter-(--kt-logo-light-mark)` (a service's logo, drawn with no tile: provider-logo.tsx) |
| `--kt-control-xs` … `-control-lg`, `-icon-sm`, `-icon-md`, `-dot`, `-thumb` | `size-control-sm`, `h-control-md`, `size-icon-sm`, `size-dot`, `size-thumb` (any sizing or spacing utility) |
| `--kt-content-width`, `-card-width`, `-sidebar-width`, `-rail-width`, `-popover-width`, `-menu-width`, `-palette-width`, `-share-width`, `-doc-width` | `max-w-content`, `max-w-card`, `w-sidebar`, `w-rail`, `w-popover`, `w-menu`, `w-palette`, `w-share`, `max-w-doc` |
| `--kt-nav-width`, `-topbar-height`, `-tabbar-height` | `w-(--kt-nav-width)`, `h-(--kt-topbar-height)`, `h-(--kt-tabbar-height)`: the compute console's sidebar, and a phone's top bar and tab bar |
| `--kt-ease`, `-ease-breathe` | `ease-standard`, `ease-breathe`; `transition-*` default to `--kt-duration` and `--kt-ease` |
| `--kt-step-0` … `-step-12` | Tailwind's steps, by the same number: `--kt-step-2` is `p-2`, `--kt-step-1_5` is `gap-1.5` |
| `--kt-gap-within`, `-gap-between`, `-gap-turn`, `-pad-card`, `-pad-panel`, `-gutter`, `-gutter-narrow` | `gap-within`, `mt-between`, `pt-turn`, `p-pad-card`, `p-pad-panel`, `px-gutter`, `px-gutter-narrow` (any spacing utility; [spacing.md](spacing.md)) |
| `--kt-space-1` … `-space-11` (legacy) | Tailwind's steps: 2px `0.5`, 4px `1`, 6px `1.5`, 8px `2`, 10px `2.5`, 12px `3`, 16px `4`, 20px `5`, 24px `6`, 32px `8`, 48px `12` (`p-2`, `gap-1.5`, `mt-6`) |
| `--kt-hairline` | `border` (1px), `divide-y` |

A token with no utility is read directly with Tailwind's variable shorthand: `duration-(--kt-duration-fast)`,
`z-(--kt-z-float)`, `w-(--kt-swatch-width)`, `max-h-(--kt-popover-height)`. That is the only form of arbitrary
value allowed: the token lint (`pnpm --filter @kantel/ui test`) fails on a raw one, such as `p-[13px]`,
`max-w-[40rem]`, `bg-[#fff]` or `duration-[150ms]`. Arbitrary values without a raw size or colour, such as
`grid-cols-[auto_1fr]` or `w-[60%]`, are fine.

## Plain CSS, where utilities are worse

Keep a rule in CSS, with a comment saying why, for:

- keyframes and the animations that use them (`kt-pulse`, `kt-spin` and `kt-shimmer` are in base.css);
- complex selectors: rendered Markdown and other HTML the component doesn't write element by element, state on
  another element (`.kt-sidebar[data-collapsed] .kt-signed-in-as`), long `:has()` chains;
- syntax-highlighting colours (src/code/syntax.css maps Highlight.js's classes onto `--kt-syntax-*`);
- print styles (documents/document-print.css).

## Motion on live rows

Anything that animates while a session is live (transcript rows, the working row, status dots, the streaming
caret) animates `opacity` and `transform` only, never layout or paint properties such as `height`, `width`, `top`
or `background`: the compositor runs those two without the main thread, so a streaming answer doesn't stutter. In
utilities that means `transition-opacity` or `transition-transform`, not `transition-all`.

## Converting a component

1. Move each rule of its .css onto the elements as utilities, using the names above. Keep its `kt-` class names
   where another stylesheet or a test selects on them.
2. Delete the .css file and its import.
3. Shoot its stories before and after (`pnpm build:workbench && node scripts/shoot.ts --only <story ids>`) and
   compare them; they should match.
4. Check it follows a theme switch, such as in the console with the sidebar's theme switch: a utility that
   doesn't change with the theme is reading a copied value, not a token.

The first component converted is `SignedInAs` (src/identity/signed-in-as.tsx). The identity, theme, sharing,
skills and vault areas followed, then the session's transcript, messages, tool calls and cards, and the code, diff
and terminal views (src/code/). What those keep in CSS, each with its reason beside it: the transcript's folded-row
and linked-turn rules (`:has()`, keyframes on other components' elements) and its 900px gutters; rendered Markdown
(session/markdown.css, also used by documents and notes); the assistant message's child spacing and streaming caret;
the working row's shimmer; the generated-image placeholder's sweep; the tool group's reach into `Disclosure`'s
parts; a browsing run's margin on the live view under it; the code view's caret; the terminal's ANSI colours; and syntax.css.
The primitives, presented files, workspace and workbench followed.

## The primitives

The primitives are utilities on their own elements. Where other code writes a primitive's markup itself (a link that
looks like a button, a hand-written disclosure, a placeholder of another shape), it takes the primitive's classes
rather than its hook names: `buttonClass(variant, size)` and `buttonLabelClass` (button.tsx), `disclosureClass`,
`disclosureSummaryClass`, `disclosureChevronClass(open)` and `disclosureTextClass`, and `inputClass` (controls.tsx),
`skeletonClass` (spinner.tsx), `fileTileClass` (file-icons.ts), and `presentedFilesClass` and
`presentedFilesItemClass` (presented/presented-file-card.tsx). A bare `kt-button` class styles nothing now.

Their .css files keep only what utilities can't say, each with a comment:

- shared hooks other components wear on their own elements: `.kt-icon`, `.kt-icon-sm` and `.kt-icon-md` (icons.css,
  on raw lucide-react icons too), and the six `.kt-status-<status>` classes that set `--kt-status-current` and
  `--kt-status-current-soft` (status.css);
- container queries at sizes the theme has no name for (breadcrumbs.css, form-layout.css);
- state on another component's elements (sidebar.css reaching `SignedInAs` on the rail) and `:has()` rules
  (list-row.css);
- an `\200b` `content` the scanner can't take from a class (list-row.css, menu.css), an `@property` (surface.css),
  and a focus ring that must beat base.css's unlayered `.kt-focusable` rule (controls.css);
- HTML the component doesn't write: docx-preview's pages (presented/office-view.css).

What caught those conversions out:

- Utilities are in a layer, and the primitives' remaining CSS isn't, so one of its rules (an icon's size, say) beats
  a utility on the same property. Override it with `!` (`size-control-xs!` on an icon) and say why beside it.
- A page-wide `p { margin: 0 }` used to win over rendered Markdown's paragraph spacing; as `[&_p]:m-0` it is in
  the utilities layer and no longer does, so Markdown inside the page keeps its own spacing.
- While preflight was off, `border-dashed` (or `-dotted`) styled every side, and the others showed at the browser's
  medium width, so those components write `border-0 border-t border-dashed`. Preflight's `border: 0 solid` makes
  the `border-0` unnecessary now, and harmless.
- Tailwind finds classes by scanning the source, and a class run straight into an interpolation
  (`` `border-t${x}` ``) can be missed. Leave a space before `${`.
- The theme has Tailwind's breakpoints only. A component with its own breakpoint (900px, 1040px) keeps that
  media query in its .css, on a kept `kt-` class, because `max-[900px]:` is a raw size.

## The console

The console's shell, pages, session layout, files screen, profiler and browser viewer are utilities on its own
elements; the class strings several of them share (the shell grid, a page, a session's main area) are named in
`apps/console/src/ui/shell-styles.ts`. Its `src/ui/styles.css` keeps only what utilities can't say, each with a
comment:

- `html`, `body` and `#root` fill the window, and the body shows the canvas: the page itself, which no component owns.
- A presented file's preview turns into a sheet over the transcript when the session's main area is under 60rem: a
  container query at a size the theme has no name for, and it hides the preview's resize handle inside it.
- The session's browser moves above the transcript under 1340px: a breakpoint the theme lacks, which also sizes the
  view inside @kantel/ui's `BrowserPanel`.

Those rules select kept hook classes (`console-file-panel`, `console-browser`, `console-main-browser`). Where a
console utility has to beat a library component's own unlayered CSS (a `Button`'s centred label, `kt-app` on the
viewer's page), it carries `!` and a comment, as in the library.
