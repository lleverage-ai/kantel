# The design loop

How `@harbour/ui` components get better: a hill-climb on a scored fitness, one component at a time, with every
iteration recorded. A variant replaces the current version (the champion) only if it passes every gate and beats
it on the score without making anything measurably worse.

It started from the brief's suggestion (gates, measurements, a judged rubric). The changes from that suggestion are
marked **Change**, with the reason. Everything below is in place: the static gates (`scripts/token-lint.ts`), the
browser and States gates (`loop/gates.ts`, `loop/specs.ts`), the measurement harness (`loop/harness/`,
`loop/measure.ts`, `loop/ab.ts`) and the score (`loop/score.ts`). Round 1 ran on five components, round 2 on four
and round 3 on the vault card alone; the results are in [loop-results.md](loop-results.md) and every number and verdict behind them is in `loop/history/`.

## Fitness

### 1. Hard gates (pass or fail)

A variant that fails any gate is rejected before anything is measured or judged.

| Gate | What it checks | How |
| --- | --- | --- |
| Accessibility | No axe violations for WCAG 2.2 A and AA, on every story at 1280px and 420px | `loop/gates.ts`, axe-core in headless Chromium |
| Keyboard | Every enabled control is reached by Tab, in order, shows a visible focus ring when reached, and nothing traps focus. Components' own keys (the composer's Enter and Escape, a radio group's arrows) are not scripted in the gate yet; see [What it does not cover](#what-it-does-not-cover) | `loop/gates.ts` |
| Alignment | Icons, status dots, badges and button labels are centred on their text within 1px: the middle of the capitals (baseline minus half the cap height, read from the font the browser used), not the line box. Checked on every story at both widths | `loop/align.ts`, run by `loop/gates.ts` |
| Tokens | No raw colour or size outside `src/tokens/tokens.css`; font sizes and radii are tokens | `scripts/token-lint.ts`, also in CI through `pnpm test` |
| Copy | No uppercase or tracked labels, no middle-dot meta strings, no arrows in rendered text | `scripts/token-lint.ts`. **Change:** the copy rules are made mechanical as a gate rather than left to the judge, because they are rules, not taste |
| States | The component has a story for each state it can be in: loading, empty, streaming, error, long content and mobile, where they apply | `loop/specs.ts` lists the states each component owes. **Change:** added, so a variant cannot win by dropping a hard state |
| Types and tests | `pnpm typecheck` and `pnpm test` pass | CI |

### 2. Measured (lower is better)

Each component has a fixed scenario in `loop/harness/`, run in a production build with React's profiling build, in
headless Chromium with the CPU throttled four times. A run is one fresh page; garbage is collected before its
update phase and again before its interactions, so a collection left over from earlier does not land in them.

| Measure | Meaning | Scenario example |
| --- | --- | --- |
| Render cost | Total React `actualDuration` (ms) across the scenario | Transcript: 300 earlier items, then an answer streams 400 tokens in 200ms batches |
| Wasted renders | Renders of a component instance whose output did not need to change | Transcript: renders of any row other than the streaming one. Session list: rows re-rendered when one row's status changes |
| Interaction latency | From the input event's timestamp to the end of the next frame, for real input from Playwright; median and p95 | Tool-call chip: expand. Composer: a keystroke. Vault card: pick a code |
| Bundle cost | Minified and gzipped JS and CSS the component adds to a host app, excluding React | One entry per component, bundled with Vite |

Also reported, not scored: **input work**, from the input event's timestamp to the end of its dispatch, which takes
in the handlers but not the wait for a frame. It includes React's render and commit only when that event's own
handler changes state (a click, the vault picker's arrow keys); typing in the composer changes state on the later
`input` event, so there it measures the keydown alone. Both trees' harnesses must have it: `loop/ab.ts` stops on the
first page if one predates it. Latency waits for the next frame,
so at four times throttling it moves in whole frames (about 16ms) with where in the frame an input lands; work does
not, so it shows whether a change in latency comes from the component's cost or from frame timing.

**Change:** a champion and its variants are measured interleaved (champion, variant 1, variant 2, then again, five
rounds) rather than one tree after another. Round 1 ran on a shared host whose load moved between 1 and 20 over the
hour; measured in sequence, that drift is larger than most of the effects. Interleaving gives each side the same
conditions, and the median of the five runs is what is scored.

**Change (round 3):** comparisons run in `loop/ab.ts`, in one browser, alternating the two trees' pages in ABBA
order (C V V C C V ...) for 40 runs a side, after four warm-up runs a side that are thrown away. Rounds 1 and 2 ran
each tree's run in its own process and browser, so every run was a fresh browser's first page, which runs cold;
round 3 found those runs slower and noisier than warm ones (see [loop-results.md](loop-results.md#round-3)). The
gap between inputs is lengthened by a random part of a frame (up to 17ms): with a fixed gap, a cheaper component
shifts every later input to another point in the frame, and latency to the next frame moves by whole frames for
that reason alone, which is what rejected round 2's vault variant. Every difference gets a noise band: the 95% bootstrap interval of the ratio of the two sides' median runs, from
resampling each side's runs.

**Change:** wasted renders are counted separately from render cost. Total milliseconds are noisy at this scale; a
re-render count is exact and is what regresses when someone breaks memoisation.

### 3. Judged (higher is better)

A rubric scored by model judges from screenshots of the component's stories at 1280px and 420px. Each judge also
sees two references:

- **Fidelity:** T3 Code's equivalent screen, from its published app screenshot and the pinned source
  (pingdotgg/t3code at `1152e9171a9ce6ede20e0cc1f16ed0dbe103da9b`).
- **Consistency:** a contact sheet of Harbour's other current champions, so a component is judged against the
  platform it has to sit in, not alone.

Rubric, each scored 1 to 5:

1. **Hierarchy:** the one thing that matters on it is the thing you see first.
2. **Density and rhythm:** compact 12 to 14px type, spacing from the scale, nothing cramped or loose.
3. **Fidelity:** reads as T3 Code's equivalent, in layout, weight and restraint.
4. **Consistency:** the same radius, borders, type, status colours and control heights as the rest of Harbour.
5. **States:** loading, empty, streaming, error and long content are each clear and calm.
6. **Mobile:** works at 420px with no lost information and touch-sized targets.
7. **Copy:** plain sentence case, says what happens, nothing redundant.
8. **Earns its cost:** every element on screen does something for the person; nothing decorative moves.

**Change:** judges compare pairwise and blind rather than score in isolation. Each judge sees the champion and the
variant as A and B in random order and scores both; three judges per comparison, and the median per criterion is
kept. Absolute 1 to 5 scores drift between runs; a blind A and B comparison on the same screenshots does not.

### Score and acceptance

For a variant V against the champion C:

- **Judged** `J = mean over criteria of median judge score`, from 1 to 5.
- **Measured** `M = mean over measures of log2(C / V)`, so halving a cost scores +1 and doubling it scores −1.
- **Score** `S = (J_V − J_C) + M`.

V replaces C when all gates pass, `S > 0.1`, and no single measure is more than 10% worse than C's (the
measurement noise band). A variant that only moves the score inside the noise is not kept, so the loop does not
wander. `loop/score.ts` is this rule, tested.

**Change (round 3):** a measure whose noise band includes no change (a ratio of 1) counts as no change: it scores 0
and cannot reject the variant, however far its median moved. Before, a measure more than 10% worse rejected the
variant even when its runs could not tell the two sides apart, which is how round 2 rejected the vault card's
variant. Bundle size is exact, so it has no band.

**Change:** each measure has a floor (1ms for times, one render, 64 bytes), and both sides are raised to it before
the log ratio. Without it a composer that renders in 0.0ms either way scores `log2(0 / 0)`, and one wasted render
against none is infinitely worse. Removing a cost still counts: five wasted renders down to none scores
`log2(5 / 1)`.

A performance-only variant is not judged. Its screenshots are compared with the champion's instead; when they
differ by no more than sub-pixel offsets, it scores `J_V − J_C = 0` and stands on its measures.

### Iteration

1. **Baseline:** score the component as it is (gates, measures, judges against references). That is round 0.
2. **Generate:** propose two or three variants (round 1 had two: one for performance, one for the look), each with
   one hypothesis, such as "group consecutive tool calls", "drop
   the per-row interval", "tighten the header to 32px". Different hypotheses keep the variants apart.
3. **Gate, measure, judge:** run the fitness on each.
4. **Select:** keep the best variant that passes acceptance, or keep the champion. A second accepted variant is
   not stacked on the first in the same round, as the pair was never measured or judged together; it is carried
   to the next round as a candidate against the new champion.
5. **Record:** append the round to `loop/history/<scenario>.json`: the hypotheses, the gate results, the
   measures, the judges' scores and reasons (with which side was the champion), and the decision.
6. **Stop** after three rounds or the first round with no accepted variant.

Variant generation and judging run as parallel subagents: one per variant to write it, three per comparison to
judge it. The judges never see which version is the champion: A and B are assigned at random per judge, and the
consistency contact sheet leaves out the component being judged, as its champion would give the answer away.

### Guarding against gaming

- Fixed scenarios and fixtures, checked in, so a variant cannot pick an easier workload.
- The mobile and long-content stories are always judged, so a variant cannot look good only at 1280px.
- A variant that removes a feature or a state fails the States gate.
- The rubric's "earns its cost" criterion keeps a variant from buying a judged point with a measured loss the
  person never benefits from.

## Running it

```sh
pnpm --filter @harbour/ui build:workbench
node packages/ui/loop/gates.ts            # gates on every story
node packages/ui/loop/measure.ts          # measures for the loop's components
node packages/ui/scripts/shoot.ts         # screenshots for the judges
```

To compare trees (the champion and each variant in its own worktree), run from either tree:

```sh
node packages/ui/loop/ab.ts --only vault-card --champion <champion>/packages/ui --variant <variant>/packages/ui \
  --json ab.json
```

It builds both trees' harnesses, measures them alternately in one browser and prints each measure's ratio with its
noise band and the measured gain `M` under the noise rule. A run of 40 a side on the vault card takes about 12
minutes. Check a new scenario with the champion against itself first: every band should include 1.

Results and history live in `loop/history/`; the latest summary is in `docs/loop-results.md`.

## What it does not cover

Real-device feel (scroll physics on an iPhone, IME composition), screen-reader flows beyond what axe and the
keyboard checks catch, components' own keyboard handling (the gate checks Tab order and focus rings; Enter,
Escape and arrow keys are covered only where a component's unit tests cover them), and taste calls that need Tom.
Those are listed with each round's results.

The composer left the loop after round 1: it is being rebuilt in its own task (model picker, attachments), and
its round-1 record stays in `loop/history/composer.json` for that work.
