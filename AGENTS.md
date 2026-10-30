# Agent instructions

## Frontend: use @harbour/ui

Every Harbour frontend (apps/console and any other app or page) is built from `@harbour/ui` in `packages/ui` and
its tokens.

- Use its components. Start from [packages/ui/README.md](packages/ui/README.md), which lists what each is for and
  when not to use it; the details are in [packages/ui/docs/components.md](packages/ui/docs/components.md).
- If you need a component that isn't there, add it to `packages/ui` with stories for its states (loading, empty,
  streaming, error, long content, mobile) and a docs entry, then use it from your app. Don't write one-off
  components in an app.
- Use the `--hb-*` tokens for every colour, size, radius and duration. `pnpm --filter @harbour/ui test` fails on a
  raw value in the library.
- Space follows [packages/ui/docs/spacing.md](packages/ui/docs/spacing.md): one 4px scale, `--hb-step-*` numbered as
  Tailwind's (`--hb-step-4` is `p-4`, 16px), and the rhythm tokens (`--hb-gap-within`, `--hb-gap-between`,
  `--hb-gap-turn`). Within a block 2, between blocks 6, between turns 8. New CSS uses the steps, not the old
  2px-numbered `--hb-space-*` names.
- Copy is plain sentence case: no uppercase tracked labels, no middle-dot meta strings, no arrows on buttons.
- Style with Tailwind v4 (below), not a new .css file.
- Check your component in the workbench (`pnpm --filter @harbour/ui dev`) at 1280px and 420px, and run
  `node packages/ui/loop/gates.ts` after `pnpm --filter @harbour/ui build:workbench` for the accessibility and
  keyboard gates.

## Styling: Tailwind v4

`@harbour/ui` is styled with Tailwind v4 utilities in `className`, moving over from one hand-written .css file per
component. The details and every utility name are in
[packages/ui/docs/tailwind.md](packages/ui/docs/tailwind.md).

- Tokens live in `@theme` in `packages/ui/src/tokens/tailwind.css`, mapped from the `--hb-*` tokens with
  `var(--hb-*)` references (`@theme inline`), so a theme switch restyles utilities at runtime. A new token goes in
  `tokens.css` first, then gets mapped; never copy a value into `@theme`.
- No ad hoc values: no arbitrary pixel, rem, colour or duration values (`p-[13px]`, `bg-[#fff]`); the token lint
  fails on them. Spacing is Tailwind's 4px step (`--spacing: 0.25rem`): `p-2` is 8px. For a token with no utility,
  use `w-(--hb-card-width)`.
- Plain CSS only where utilities are worse (keyframes, complex selectors such as rendered Markdown or state on
  another element, syntax-highlighting colours, print), with a comment saying why.
- Animations on live rows in `@harbour/ui` (transcript rows, the working row, status dots, the streaming caret)
  stay opacity and transform only.
- Preflight is off while component .css files remain, and those unlayered files beat utilities: convert a component
  whole and delete its .css.
