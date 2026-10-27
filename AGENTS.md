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
- Copy is plain sentence case: no uppercase tracked labels, no middle-dot meta strings, no arrows on buttons.
- Check your component in the workbench (`pnpm --filter @harbour/ui dev`) at 1280px and 420px, and run
  `node packages/ui/loop/gates.ts` after `pnpm --filter @harbour/ui build:workbench` for the accessibility and
  keyboard gates.
