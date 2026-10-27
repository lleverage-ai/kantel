# Design loop results

The latest rounds of the [design loop](design-loop.md). Every number, gate result and judge's verdict behind this
page is in `loop/history/<scenario>.json`.

## Round 2

Four components (the composer has left the loop), one variant each, against champions that already carry Tom's two
calls from round 1: tool calls follow T3 Code's work log (no per-call duration; the start time on hover or focus;
"Worked for" on every finished group) and the vault card says its lifetime once, in the terms. Round 1's carried
inline duration and countdown split no longer apply as they stood: the first is what Tom ruled out, the second
split a countdown that is gone, so it was reworked around the Lifetime term. Every variant passed every gate.
Two were selected:

| Component | Selected | Why |
| --- | --- | --- |
| Transcript | "Working for 12s" in place of the three dots while a turn works | All three judges preferred it; judged gain 0.50 |
| SessionListItem | `content-visibility: auto` on rows (carried from round 1) | Selection latency halved again; looks the same |

ToolCallChip and VaultApprovalCard keep their champions. Measures and scores are read as in round 1 (below):
medians of five interleaved runs at 4x CPU throttling, `S = ΔJ + M`, accepted at S > 0.1 with no measure more
than 10% worse.

| Component | | Render | Wasted | Latency median / p95 | Input render | JS / CSS gz | J | S | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Transcript | Champion | 285.8 | 0 | 73.7 / 86.4 | 310.5 | 70.8 / 4.8 kB | 3.75 | | replaced |
| | Working row | 301.8 | 0 | 75.8 / 90.0 | 317.0 | 71.0 / 4.7 kB | 4.25 | **0.472** | **selected** |
| ToolCallChip | Champion | 16.5 | 0 | 32.5 / 65.8 | 21.5 | 2.9 / 1.5 kB | 4.38 | | kept |
| | Failed call as in T3 | 16.8 | 0 | 31.8 / 53.9 | 20.7 | 2.9 / 1.5 kB | 4.13 | −0.204 | rejected: all three judges preferred the champion |
| SessionListItem | Champion | 90.9 | 0 | 69.3 / 131.6 | 57.5 | 3.6 / 2.1 kB | | | replaced |
| | `content-visibility: auto` | 86.1 | 0 | 32.5 / 67.4 | 51.8 | 3.6 / 2.1 kB | not judged | **0.324** | **selected** |
| VaultApprovalCard | Champion | 16.0 | 10 | 37.3 / 55.3 | 35.2 | 4.6 / 2.8 kB | | | kept |
| | Lifetime ticks alone, card memoised | 4.0 | 0 | 44.3 / 51.7 | 21.1 | 4.8 / 2.8 kB | not judged | 0.838 | rejected: latency median 19% worse |

**Transcript.** Before its first word, a turn now ends with a muted "Working for 30s", timed from the person's
last message (a steer joins the turn under way), after T3 Code's working row; without that time it says "Working".
Only the `Elapsed` leaf ticks. All three judges preferred it on states, fidelity, consistency and copy: it tells how
long the agent has worked, where the dots told nothing, and it pairs with "Worked for" above it. It also puts back,
at turn level, the live duration the tool rows gave up. Render cost rose 5.6%, inside the noise band (the variant's
runs spread from 271 to 396ms).

**ToolCallChip.** The variant made a failed call look like T3 Code's: its own tool icon tinted red, the label at
the finished rows' strength, a small red X before the chevron. All three judges preferred the champion's red
circled X in the icon slot: it matches the interrupted call's amber icon, so status always sits in the same place,
and the variant marked one failure twice, 500px apart, where it is easier to miss. Round 1's reservation (a failed
label as bright as the running one) stands, and the judges judged it the smaller problem.

**SessionListItem.** As in round 1, containing rows halved selection latency (69.3 to 32.5ms median, 131.6 to
67.4ms p95). The screenshots match the champion's to sub-pixel offsets, checked by eye, so ΔJ = 0.

**VaultApprovalCard.** Moving the per-second clock into the Lifetime value and memoising the card did what it
should: render cost 16.0 to 4.0ms, wasted renders 10 to 0, and picking a code 35.2 to 21.1ms of rendering, as the
card no longer re-renders with its parent. The rule still rejects it, on latency: 44.3 against 37.3ms median. Both
sides' runs fall in the same two clusters, about 29 to 33ms and 44 to 46ms, which look like whole frames at 4x
throttling; the variant landed in the upper one three times out of five, the champion twice. Its p95 is lower
(51.7 against 55.3ms). It is the first candidate for round 3, measured with more runs.

## Round 1

Five components, two variants each: one performance hypothesis and one visual one. Every variant passed every gate
(types, tests, Biome, token and copy lint, axe and keyboard at 1280px and 420px, States). Three were selected:

| Component | Selected | Why |
| --- | --- | --- |
| ToolCallChip | A running call's label at full strength | All three judges preferred it; nothing measurably worse |
| SessionListItem | The title across the row's full width, the status at the right of the line above | All three judges preferred it; judged gain 0.44 |
| VaultApprovalCard | Who set the terms said once ("Proposed by the agent"), not as five amber badges | All three judges preferred it |

Transcript and Composer keep their champions. The composer then left the loop: it is being rebuilt in its own
task, and its round-1 record below is kept for that work.

### How to read the tables

Measures are medians of five interleaved runs at 4x CPU throttling: champion and variants run in turn, so load on
the shared host fell on each alike. Times are in ms. J is the mean over the eight criteria of the three judges'
median scores (1 to 5); M is the mean of `log2(champion / variant)` over the seven measures; S = ΔJ + M. A variant
is accepted when S > 0.1 and no measure is more than 10% worse. Performance-only variants were not judged: their
screenshots matched the champion's to within 1 to 2px sub-pixel offsets, checked by eye, so ΔJ = 0.

### Transcript

| | Render | Wasted | Latency median / p95 | Input render | JS / CSS gz | J | S | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Champion | 283.6 | 0 | 77.1 / 92.1 | 298.1 | 69.2 / 4.6 kB | 4.06 | | kept |
| Markdown block cache | 275.9 | 0 | 75.4 / 99.4 | 327.4 | 69.4 / 4.6 kB | not judged | −0.025 | rejected: inside the noise |
| Hairline between turns | 271.8 | 0 | 73.9 / 92.0 | 302.1 | 69.2 / 4.6 kB | 3.94 | −0.110 | rejected: all three judges preferred the champion |

The cache did not pay: the transcript's virtualised rows are memoised and keep their parsed Markdown while mounted,
so a cache only helps rows scrolling back in, and the scenario's scroll-back cost (input render) did not fall
(298.1 to 327.4ms, inside the noise band).
The judges read the hairline as repeating what the right-aligned user bubble already says, and further from T3
Code, which separates turns with space.

### ToolCallChip

| | Render | Wasted | Latency median / p95 | Input render | JS / CSS gz | J | S | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Champion | 18.5 | 0 | 34.1 / 59.1 | 19.1 | 2.9 / 1.4 kB | 4.13 / 4.25 | | replaced |
| Running label at full strength | 17.1 | 0 | 35.0 / 56.6 | 18.4 | 2.9 / 1.4 kB | 4.31 | **0.213** | **selected** |
| Duration after the label | 17.3 | 0 | 35.2 / 62.4 | 19.2 | 2.9 / 1.4 kB | 4.44 | 0.181 | accepted, carried to round 2 |

The champion's J differs per comparison because each comparison has its own three judges. Both variants were
preferred by all three of theirs. The judges' one reservation about the selected variant: the running row and a
failed row now share the same brightness, though the failed row keeps its red icon. The inline duration was also
accepted; it is carried rather than stacked, because the two changes were never judged together.

### Composer

| | Render | Wasted | Latency median / p95 | Input render | JS / CSS gz | J | S | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Champion | 0.0 | 0 | 18.6 / 28.9 | 50.0 | 2.2 / 1.3 kB | 3.94 | | kept |
| CSS `field-sizing: content` | 0.0 | 0 | 19.7 / 28.0 | 55.8 | 2.2 / 1.4 kB | not judged | −0.037 | rejected: input render 12% worse |
| Rest at three lines, like T3 | 0.0 | 0 | 17.3 / 25.5 | 42.9 | 2.2 / 1.4 kB | 3.81 | −0.057 | rejected: judges split 2 to 1 for the champion |

Field sizing's input render ranged from 45.6 to 77.8ms across its five runs, wider than any difference, so it neither helps nor
clearly hurts; the rule rejects it on the 10% band. The taller resting composer is closer to T3 Code, the judges
agreed, but it opens a large gap in the disabled-with-draft state and takes room above the mobile keyboard.

### SessionListItem

| | Render | Wasted | Latency median / p95 | Input render | JS / CSS gz | J | S | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Champion | 87.2 | 0 | 55.5 / 109.6 | 53.3 | 3.4 / 1.8 kB | 3.81 | | replaced |
| Full-width title | 93.0 | 0 | 57.2 / 101.9 | 56.6 | 3.4 / 1.9 kB | 4.25 | **0.405** | **selected** |
| `content-visibility: auto` on rows | 78.5 | 0 | 28.5 / 54.9 | 52.5 | 3.4 / 1.8 kB | not judged | 0.301 | accepted, carried to round 2 |

The champion truncated titles at the status column's left edge, so "Which staging database for the dry run?"
read "Which staging databa…" beside empty space. Containing rows halved selection latency (55.5 to 28.5ms median,
109.6 to 54.9ms p95) with no visible change; it is the strongest performance result of the round and the first
candidate for round 2.

### VaultApprovalCard

| | Render | Wasted | Latency median / p95 | Input render | JS / CSS gz | J | S | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Champion | 17.8 | 5 | 27.3 / 35.2 | 33.9 | 4.6 / 2.7 kB | 3.38 | | replaced |
| Terms' source said once | 16.0 | 5 | 29.7 / 38.7 | 32.6 | 4.6 / 2.7 kB | 3.88 | **0.492** | **selected** |
| Countdown in its own component | 3.1 | 0 | 28.8 / 38.6 | 41.0 | 4.7 / 2.7 kB | not judged | 0.619 | rejected: input render 21% worse |

The countdown split removed every wasted render and cut the five-tick render cost from 17.8 to 3.1ms, the highest
score of the round, but it made picking a binding code 21% more expensive in all five runs (39.4 to 45.1ms against
30.8 to 36.5ms). In the scenario the code picker shares a parent with the card, so each arrow press re-renders the
card, which is not memoised, and now also the countdown and its clock subscription. Round 2 should try the split
with a memoised card.

## The round-1 champion

The tree with the three selections passes every check: typecheck, Biome on 311 files, 332 of 332 tests, and 147 of
147 browser gates. Measured afterwards in a quieter hour, so not comparable with the interleaved numbers above:

| Component | Render | Wasted | Latency median / p95 | Input render | JS / CSS gz |
| --- | --- | --- | --- | --- | --- |
| Transcript | 282.3 | 0 | 72.6 / 91.1 | 268.0 | 69.2 / 4.6 kB |
| ToolCallChip | 13.2 | 0 | 27.2 / 51.9 | 17.1 | 2.9 / 1.4 kB |
| Composer | 0.0 | 0 | 14.6 / 22.4 | 41.8 | 2.2 / 1.3 kB |
| SessionListItem | 89.7 | 0 | 51.1 / 113.2 | 51.5 | 3.4 / 1.9 kB |
| VaultApprovalCard | 15.2 | 5 | 23.0 / 34.9 | 29.2 | 4.6 / 2.7 kB |

## Round 2 candidates (from round 1)

Round 1 accepted variants, so by the loop's stop rule it continued. What became of its candidates:

- SessionListItem: `content-visibility: auto` on rows, against the full-width-title champion. Selected in round 2.
- ToolCallChip: the duration after the label. Dropped: Tom chose T3 Code's work log, which has no per-call duration.
- VaultApprovalCard: the countdown split, with the card memoised. The countdown is gone (Tom: the lifetime is said
  once, in the terms); the same idea, applied to the Lifetime term, was round 2's vault variant.

## Round 3 candidates

Round 2 accepted variants, so by the stop rule a third round may run:

- VaultApprovalCard: the Lifetime value ticking alone in a memoised card, measured with more runs, as its latency
  sits on frame boundaries.

## For Tom

Taste calls the loop could not settle, with what the judges said:

- **Composer height** (for the composer rebuild). T3 Code rests its empty composer at about three lines; the judges agreed Harbour's shorter
  one is less faithful but preferred it 2 to 1 for density and the disabled and mobile states.
- **Failed tool calls.** T3 Code keeps a failed call's own icon, tinted red, with a small X at the row's end; the
  judges preferred Harbour's red circled X 3 to 0. Harbour keeps it, so here it departs from T3 on purpose.
- **Settled in round 2 by Tom's calls:** tool durations (T3 Code's work log: the start time on hover or focus, the
  duration once per group) and the vault lifetime (once, in the terms; the approved-narrowed story now reads
  "30 days left").
