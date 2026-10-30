# Spacing

Whitespace says what belongs together. Harbour uses one scale and three rules, so a screen reads the same way
wherever you are in it.

## The scale

One step is 4px, numbered as Tailwind v4's spacing (`--spacing: 0.25rem`): step n is n × 4px, so `--hb-step-4` is
Tailwind's `p-4`, 16px. A component moving to Tailwind ([tailwind.md](tailwind.md)) turns `var(--hb-step-4)` into
`p-4` (or `gap-4`, `mt-4`) as it stands, and the rhythm's tokens into their utilities: `gap-within`, `mt-between`,
`pt-turn`, `p-pad-card`, `p-pad-panel`, `px-gutter`, `px-gutter-narrow` (`src/tokens/tailwind.css`). The console uses
the same names on its own elements: a page outside a session is `p-gutter`, or `p-gutter-narrow` on a phone.

| Step | Token | px | Tailwind |
| --- | --- | --- | --- |
| 0.5 | `--hb-step-0_5` | 2 | `*-0.5` |
| 1 | `--hb-step-1` | 4 | `*-1` |
| 1.5 | `--hb-step-1_5` | 6 | `*-1.5` |
| 2 | `--hb-step-2` | 8 | `*-2` |
| 2.5 | `--hb-step-2_5` | 10 | `*-2.5` |
| 3 | `--hb-step-3` | 12 | `*-3` |
| 4 | `--hb-step-4` | 16 | `*-4` |
| 5 | `--hb-step-5` | 20 | `*-5` |
| 6 | `--hb-step-6` | 24 | `*-6` |
| 8 | `--hb-step-8` | 32 | `*-8` |
| 10 | `--hb-step-10` | 40 | `*-10` |
| 12 | `--hb-step-12` | 48 | `*-12` |

The half steps (0.5, 1.5, 2.5) are for the insides of small controls only: a chip's padding, an icon beside its
label. Nothing between blocks uses them.

## Three rules

1. **Proximity groups.** Things that belong together sit close; things that don't, don't. Space is the separator:
   reach for a gap before a line or a box.
2. **More space between than within.** Within a block **2**, between blocks **6**, between turns **8**. The space
   between two blocks is always clearly more than the space inside either of them, at least double, so the eye
   finds the blocks before the items.
3. **One scale.** Every margin, padding and gap is a step on the scale, through a token. No ad hoc values, and no
   two neighbours adding up to an off-scale gap: put space on one side of a pair (above a row, not above and below).

The rhythm has names, so CSS says which rule it follows rather than a number:

| Token | Step | What it separates |
| --- | --- | --- |
| `--hb-gap-within` | 2 (8px) | Related things in one block: card and card, one line of work and the next |
| `--hb-gap-between` | 6 (24px) | One block and the next: prose, a run of work, a set of cards, a subagent's card |
| `--hb-gap-turn` | 8 (32px) | One turn and the next: an answer's end and the person's next message |
| `--hb-pad-card` | 3 (12px) | The inside of a card in the flow |
| `--hb-pad-panel` | 4 (16px) | The inside of a panel, a popover or a dialog |
| `--hb-gutter` | 6 (24px) | A page's or a panel's edge to its content, on a wide screen |
| `--hb-gutter-narrow` | 4 (16px) | The same on a phone (under 640px), and the session's own columns at every width: its bars, the transcript and the composer, which sit beside other panels |

## Where each step goes

| Where | Step | Token |
| --- | --- | --- |
| Inside a control: icon to label, a chip's padding | 1–2 | `--hb-step-1`, `--hb-step-1_5`, `--hb-step-2` |
| Lines of text that are one thing: a title and its meta, a card's name and kind | 0.5–1 | `--hb-step-0_5`, `--hb-step-1` |
| Paragraphs, list items in prose | 3 between paragraphs, 1 between list items | the Markdown styles |
| A run of work lines ("Worked for 30s", "Thought it through"), stacked | 2 | `--hb-gap-within` |
| Cards in a set: presented files, attachments | 2 | `--hb-gap-within` |
| Prose and the work under it, work and the cards it made, cards and the words after them | 6 | `--hb-gap-between` |
| A subagent's card, an approval or a question card, from what's above it | 6 | `--hb-gap-between` |
| The person's message and the first thing under it | 2 above its actions row (6 in all) | `--hb-gap-within` |
| One turn and the next | 8 | `--hb-gap-turn` |
| Inside a card in the flow | 3 | `--hb-pad-card` |
| Inside a panel, a popover, a dialog, the right-hand panel's header | 4 | `--hb-pad-panel` |
| Page and panel gutters | 6 wide, 4 narrow | `--hb-gutter`, `--hb-gutter-narrow` |
| List rows (sessions, skills, schedules, audit) | 0.5 between rows, which carry their own padding (2–2.5) and hover background | `--hb-step-0_5`, `--hb-step-2` |
| Groups of rows in the sidebar's dense column (Working, Done) | 4 | `--hb-step-4` |
| The composer: inside its surface | 3 | `--hb-pad-card` |
| The composer: from the transcript's end, and from the window's foot | 6 wide (4 narrow) | `--hb-gutter`, `--hb-gutter-narrow` |

### In the transcript

The transcript is a virtual list: every row is its own element, so a row can't see the row above it with a CSS
selector. The transcript marks the rows instead (`transcript-model.ts`, `closeRows`) and puts space above each row
only:

- every row stands `--hb-gap-between` under the one above;
- a line of work under another line of work (a group of calls, a browsing run, a thought with no words under it)
  stands `--hb-gap-within` under it: `hb-transcript-row-close`;
- the first thing under the person's message stands `--hb-gap-within` under it too, because the message's actions row
  (Copy and the time, shown on hover) already stands between them;
- the person's message starts a turn and stands `--hb-gap-turn` under what came before: `hb-transcript-turn`;
- a finished turn's work folds under one "Worked for" line, which is a line of work like any other (close under the
  message, a block above the answer). A folded row that shows nothing takes no room; one that keeps something in view
  (presented files, a failed call) is a block under the line. Opened, the fold's first line of work sits close under
  it and the agent's words a block under it.

Inside a row the same rules hold: an answer's thought, its words and a draft document's card are a block apart; the
cards a call presented are `--hb-gap-within` apart and a block under the call.

## The old names

Before this scale, Harbour's space tokens were numbered on a 2px step: `--hb-space-4` was 8px. They still work, mapped
onto the steps in `tokens.css`, so nothing moved when the scale did. A file moves to `--hb-step-*` and the rhythm
tokens when it is next touched, or when it moves to Tailwind:

| Old | New | px |
| --- | --- | --- |
| `--hb-space-1` | `--hb-step-0_5` | 2 |
| `--hb-space-2` | `--hb-step-1` | 4 |
| `--hb-space-3` | `--hb-step-1_5` | 6 |
| `--hb-space-4` | `--hb-step-2` | 8 |
| `--hb-space-5` | `--hb-step-2_5` | 10 |
| `--hb-space-6` | `--hb-step-3` | 12 |
| `--hb-space-7` | `--hb-step-4` | 16 |
| `--hb-space-8` | `--hb-step-5` | 20 |
| `--hb-space-9` | `--hb-step-6` | 24 |
| `--hb-space-10` | `--hb-step-8` | 32 |
| `--hb-space-11` | `--hb-step-12` | 48 |

Mind the numbers when moving a file: `--hb-space-4` is `--hb-step-2`, not `--hb-step-4`.

## Sources

- Tailwind v4's spacing scale: the default theme sets `--spacing: 0.25rem` (https://tailwindcss.com/docs/theme), and
  `p-<number>` is `padding: calc(var(--spacing) * <number>)` (https://tailwindcss.com/docs/padding).
- The reference: Claude.ai and Claude Code on the web, and T3 Code (see [principles.md](principles.md)): simple file
  cards close together under the work that made them, prose a clear gap away.
