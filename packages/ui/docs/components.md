# Components

What each component is for, when not to use it, its states and what it costs. Stories for each are in the
workbench (`pnpm --filter @harbour/ui dev`).

The session components are documented in [session-transcript.md](session-transcript.md),
[session-composer.md](session-composer.md) and [session-list-vault.md](session-list-vault.md); the workspace
components in [workspace.md](workspace.md).

## Primitives

### Centring on text

Text looks centred on the middle of its capitals, not on its line box: in most UI fonts the descent is deeper than
the space above the capitals, so a line box's middle sits a pixel or two below the letters'. `align-items: center`
on a row of a dot and some words therefore puts the dot low. The primitives handle this two ways, and a new
component should use one of them:

- **Something beside text** (a dot, an icon): align it to the text's baseline, then move it up with
  `translate: 0 var(--hb-on-cap)`. `StatusLabel`, `ListRow`'s leading slot and `Notice` do this. In a slot with no
  text of its own, give the slot the text's size and line height and an invisible character for a baseline, as
  `.hb-list-row-leading` does.
- **Text inside a fixed-height box** (a button, a badge): trim the text to its capitals with
  `text-box: trim-both cap alphabetic` and centre it. `Button` and `Badge` do this.

`node loop/gates.ts` fails any icon, dot, badge or button label more than 1px off its text's centre.

### Button and IconButton

**For** actions. Variants: `primary` (one per surface: Approve, Send, New session), `secondary` (the alternatives:
Decline, Copy link), `ghost` (inside dense rows and toolbars), `danger` (stopping or refusing something). Sizes `xs`
24px, `sm` 28px (default), `md` 32px, `lg` 36px; under a coarse pointer every button is at least 36px.
`busy` swaps the icon for a spinner and blocks clicks without changing the width.

**Not for** navigation to another page: use a link. Never put an arrow in the label or beside it.

`IconButton` requires `label`, which becomes the accessible name and the tooltip.

**Cost:** none beyond the element.

### StatusLabel and StatusDot

**For** the state of a session, a task or a schedule: `working` (sky), `waiting` on an answer (indigo), `approval`
(amber), `done` (emerald), `error` (red), `idle`. The label says it in words; the dot is the colour alone, for
rows where the words are elsewhere or space is short (give it a `label` then).

**Not for** tags on a value (use `Badge`) or for success messages.

**Cost:** the working dot runs a CSS opacity pulse, the one animation that says something is happening; it stops
under reduced motion.

### Badge

**For** a one or two word tag on a value: "Proposed" next to agent-proposed terms, "Approved", "Read only", "Route
grant". Tones: `neutral`, `accent`, or any status.

**Not for** a whole session's status, counts that change (put them in the text) or anything clickable.

### ListRow

**For** every row in every list: sessions, skills, schedules, memory concepts, audit events, inbox items. One line
(`compact`, 36px) or three (`comfortable`: overline, title, meta). `leading` takes a dot or an icon, `trailing` a
status or a time, `actions` replaces `trailing` on hover or keyboard focus (always shown on touch, and on a static row, which has no
main target to focus). A row is a
link with `href`, a button with `onSelect`, or static. The main target and the actions are siblings, so both are
reachable by Tab.

**Not for** tables with several columns of data (the audit view's detail, for instance), or rows whose only content
is a form control.

**Cost:** memoised on its props: a list re-renders only the rows whose props changed. Pass stable `leading`,
`trailing` and `actions` elements (memoise them or derive them from the item) to keep that true.

### Panel, FieldList and Field

**For** framed content: a card's body, a settings group, a grant's terms. `header` and `footer` are separated by
hairlines; `tone` is `approval` or `error` for a panel that needs attention. `FieldList` and `Field` lay out label
and value pairs with an optional `extra` (a badge, a copy button).

**Not for** the page frame itself, or for nesting panels in panels.

### Notice

**For** one or two lines in the flow: "This command may have partly run", "Reconnecting". `info`, `warning`,
`error`; an optional small action.

**Not for** anything the person must decide (use a card) or a whole empty screen (use `EmptyState`).

### EmptyState

**For** what a list or a screen says when it has nothing: one sentence of title, at most one of detail, at most one
action.

**Not for** errors (use `Notice`), or loading (use `Skeleton`).

### Disclosure

**For** a summary that shows detail on demand: a thought, a group of tool calls, older steps. The summary is a
button with `aria-expanded`; the detail is rendered only while open.

**Not for** navigation or tabs.

**Cost:** closed detail costs nothing, because it isn't rendered.

### CopyButton

**For** copying a link, a binding code or a command. Shows "Copied" with a tick for 1.5 seconds, announced
politely. `iconOnly` for tight rows.

### TextField

**For** a labelled single-line input with a hint or an error. 16px under a coarse pointer, so iOS doesn't zoom.

**Not for** the composer, which has its own multi-line field.

### TextAreaField

**For** a labelled multi-line input for text a person writes out, such as a scheduled task's prompt. Same frame,
hint and error as `TextField`; its height follows `rows` and the person can drag it taller.

**Not for** the composer, which sends on Enter and has attachments.

### SegmentedControl

**For** two to five exclusive views or filters: Unified or Split, All, Working or Done. A radio group: Tab reaches
the selected option, arrow keys move.

**Not for** more than five options, or for actions.

### Spinner, Skeleton and Kbd

`Spinner` for work of unknown shape; `Skeleton` for content whose shape is known (a list row, a card title). Neither
for loads under about 300ms, which should show nothing. `Kbd` shows a key or chord in text.

### RelativeTime, Elapsed and ClockTime

**For** times. `RelativeTime` says "now", "4m", "3h", "2d" (T3 Code's compact form, no "ago"), with the full date on
hover. `Elapsed` says "3m 20s" and ticks while running. `ClockTime` says when something happened by the clock, aware
of the day: "16:38", "Yesterday at 16:38", "26/10 16:38", with the full date as its title. Use it for a moment in a
timeline (a tool call's start), where an age would keep changing.

**Cost:** `RelativeTime` and `Elapsed` read one shared clock (`useNow`): one interval per period for the whole page,
stopped when nothing listens. `RelativeTime` stops ticking once a time is a day old. `ClockTime` never ticks.

### Icons

16px line icons in `currentColor`. Decorative unless given a `label`. The arrow-shaped `SendIcon` is only for the
composer's icon-only send button.

## Workspace

Read-only views of a workspace's files, fed by the host from the workspace read API (`@harbour/workspace/read-api`,
GET routes only); they never fetch, write or acquire a sandbox. Details, keyboard behaviour and costs are in
[workspace.md](workspace.md).

- **`FileTree`**: a workspace's files as a WAI-ARIA tree, one Tab stop with arrow-key navigation. Loading, error and
  empty states for the root, and inline Loading and error rows for a directory.
- **`FileViewer`**: one file's text in mono with unselectable line numbers, Copy, and states for loading, error,
  empty, image, binary and too large. Renders at most 5,000 lines and says how many more there are. An image is
  fitted to the viewer, with its pixel size in the header.
- **`NoteViewer`**: a Markdown note, parsed as one document in the transcript's Markdown styles at its reading
  measure, with when it was last updated.
- **`workspace-model.ts`**: the pure helpers behind them (`visibleRows`, `nextFocus`, `sortEntries`, `fileKind`,
  `formatBytes` and others), exported for hosts.

## Schedules

The schedule form, in `src/schedules/form/`. The schedules page (list, detail, run history) is in `src/schedules/`
beside it and opens the form for New schedule and Edit; see [schedules-skills-memory.md](schedules-skills-memory.md).

- **`ScheduleForm`**: creates or edits a task (an agent and a prompt) or a check (a command), repeating every N
  minutes, hours or days, on weekdays, on chosen days of the week or on a day of the month, or once; with its time
  zone, an optional limit on runs, a check's re-raise settings, and the next five due times beside it as the person
  types. Editing offers End after a confirmation. The prompt goes to the agent exactly as written. The preview uses
  `previewDue` from `@harbour/schedules`, the scheduler's own function, on each render; no timers.
- **`ScheduleWrites`**: the calls the form makes, `create`, `update` and `end`: the writes of the page's
  `SchedulesSource` (`bindSchedules`), so the page's source is the form's. The fixtures are the page's
  (`@harbour/ui/schedules/fixtures`).
- **Payloads**: a task's is `{ agentId, prompt }`, a check's is its argument list (`taskPayload`,
  `readTaskPayload`, `readCheckPayload`). A schedule whose payload is another shape keeps it when edited.
