# Session fixtures (protocol frames)

Recorded sessions as Kantel's client protocol sends them: JSON Lines, one `ServerFrame` from `@kantel/protocol` per
line, which `parseFixture` reads and `serializeFixture` writes. Each file is what a client that connected before the
recording started would receive: a `hello`, one `snapshot` holding every item so far (`hasEarlier: false`), then a
`delta` per commit, with `at` giving the recorded pace.

These are generated, not hand-edited. `apps/console/scripts/project-fixtures.ts` projects each Pi Durable recording in
[`../pi-durable`](../pi-durable) through the console's projector (`apps/console/src/server-sim/project.ts`), and the
output is deterministic.

- `small.jsonl`: committed. The console's tests fail if it drifts from what `../pi-durable/small.jsonl` projects to
  (`pnpm fixtures:check` in `apps/console` says the same).
- `long-2000.jsonl`: gitignored, generated before `dev`, `build` and `test` (`pnpm fixtures` in `apps/console`).
  Nothing outside the console needs it.
