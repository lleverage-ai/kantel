# Components

What each component is for, when not to use it, its states and what it costs. Stories for each are in the
workbench (`pnpm --filter @kantel/ui dev`).

The compute console's pages (`src/compute/`) are built from these primitives.

## Primitives

### Centring on text

Text looks centred on the middle of its capitals, not on its line box: in most UI fonts the descent is deeper than
the space above the capitals, so a line box's middle sits a pixel or two below the letters'. `align-items: center`
on a row of a dot and some words therefore puts the dot low. The primitives handle this two ways, and a new
component should use one of them:

- **Something beside text** (a dot, an icon): align it to the text's baseline, then move it up with
  `translate: 0 var(--kt-on-cap)`. `StatusLabel`, `ListRow`'s leading slot and `Notice` do this. In a slot with no
  text of its own, give the slot the text's size and line height and an invisible character for a baseline, as
  `.kt-list-row-leading` does.
- **Text inside a fixed-height box** (a button, a badge): trim the text to its capitals with
  `text-box: trim-both cap alphabetic` and centre it. `Button` and `Badge` do this.

`node loop/gates.ts` fails any icon, dot, badge or button label more than 1px off its text's centre.

### Button and IconButton

**For** actions. Variants: `primary` (one per surface: Approve, Send, New session), `secondary` (the alternatives:
Decline, Copy link), `ghost` (inside dense rows and toolbars), `danger` (stopping or refusing something), `danger-quiet` (a destructive action that isn't the page's point, such as Leave, whose confirming dialog has the solid `danger`). Sizes `xs`
24px, `sm` 28px (default), `md` 32px, `lg` 36px; under a coarse pointer every button is at least 36px.
`busy` swaps the icon for a spinner and blocks clicks without changing the width.

**Not for** navigation to another page: use a link. Never put an arrow in the label or beside it.

`IconButton` requires `label`, which becomes the accessible name and the tooltip.

The primary variant is drawn in the `primary` tokens, not the accent: navy with white text in the light theme,
orange with dark text in the dark one.

**Cost:** none beyond the element.

### SplitButton

**For** an action done at once with the defaults, beside a caret for the same action with choices: the console's New
makes a sandbox at once, and its caret opens New sandbox. Two buttons joined, each a Tab stop with its own name
(`moreLabel` names the caret).

**Not for** a list of different actions (use a `Menu`), or when the defaults are rarely what someone wants.

### TabBar

**For** a phone's main navigation: up to five pages along the bottom, each an icon over a short label, the page shown
in full-strength text with its icon in the accent, and `aria-current="page"`. It sits above the home indicator (`env(safe-area-inset-bottom)`).

**Not for** a wide screen (use `Sidebar`), more than five pages, or tabs inside a page (`PageTabs`).

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

A selected row's title is in full-strength text and medium weight, even on a `quiet` row, so the row you're on reads
as more than a fill.

### Sidebar

**For** an app's main navigation, after T3 Code's sidebar: `Sidebar` frames a head (`SidebarBrand` and
`SidebarToggle`), a body that scrolls on its own and a foot that stays put. In the body, `SidebarSection`s hold
`SidebarItem`s, each a page link with a 16px icon (the compute console's Sandboxes, Snapshots, Keys and the rest), and
`SidebarProject` rows (chevron, folder, name, an optional action) whose children nest on a guide line under its
chevron. In the foot, `SignedInAs`. Every name truncates on one line.

Active state: the page shown (`selected`) is filled, in full-strength text and medium weight, with
`aria-current="page"`; the project you're in (`current`) is in full-strength text without a fill, so only one row in
the sidebar is ever filled. `collapsed` makes it a rail `--kt-rail-width` wide: icons, a project's first letter in a
small square, and the avatar, each keeping its name for screen readers and as a tooltip; a project's children and
headings are hidden. The host owns the state, the width (`--kt-sidebar-width` or `--kt-rail-width`) and the landmark role; the
console remembers it in localStorage and toggles it with Ctrl+B (⌘B on a Mac). `useSidebarCollapsed()` tells a
component inside whether it is on the rail.

**Not for** navigation inside a page (use `PageTabs`, `SegmentedControl` or a list).

The compute console draws it `--kt-nav-width` wide with no rail: its pages, Settings, Admin for a super-admin, and
the person's own menu (`UserMenu`: who they are, the theme, sign out) in the foot. On a phone it has a top bar and a
`TabBar` instead.

**Cost:** no timers or animation; the rail is a CSS state of the same elements, so collapsing mounts nothing new.

### Breadcrumbs

**For** where you are, as a trail: `Default / Fix the billing worker / Write the refund tests`. `parents` (`Crumb[]`,
outermost first) are muted, in medium weight, and each is a link (`href`, preferred) or a button (`onSelect`) back to
its level, brightening on hover; `current` is the last item, in the text colour, with `aria-current="page"` and never
a link. Slashes in the faint colour separate them and are hidden from screen readers. Everything sits on one
baseline. The current item takes the room that's left and truncates first; a parent keeps at least a few letters.
Modelled on T3 Code's `WorkspaceBreadcrumb` and its chat header's project / parent / thread trail.

**Not for** tabs or switching between peers (use `PageTabs` or `SegmentedControl`), or a path inside a file tree.

**Cost:** memoised on its props; pass a stable `parents` array.

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
action. `greeting` sets the title larger (the document's second heading size) and the detail at the body size: a new
session's greeting over the composer in the middle of the page (`Transcript`'s `centreDockWhenEmpty`).

**Not for** errors (use `Notice`), or loading (use `Skeleton`).

### Disclosure

**For** a summary that shows detail on demand: a thought, a group of tool calls, older steps. The summary is a
button with `aria-expanded`; the detail is rendered only while open.

**Not for** navigation or tabs.

**Cost:** closed detail costs nothing, because it isn't rendered.

### CopyButton

**For** copying a link, a binding code or a command. Shows "Copied" with a tick for 1.5 seconds, announced
politely. `iconOnly` for tight rows.

### Config pages and forms: PageHeader, FormLayout, FormSection, FormField, FormGrid and FormActions

Every config page (skills, memory, schedules, vault, audit log, API keys) and every form on them uses these, so
titles, labels, help text, column tracks and buttons sit in the same places from page to page.

- `PageHeader`: the page's title, one line on what it is for, and its own actions on the right (New key, Export
  JSONL). The actions drop under the title on a narrow page. Pages take the main area's width; forms keep the
  `--kt-content-width` measure.
- `FormLayout`: the column a form sits in. It is the container the fields measure, so the same form lays out the
  same in a page, a panel or a phone.
- `FormSection`: a titled group of fields (What runs, When), a line on what it decides and an optional action on
  its right. Sections after the first get a hairline.
- `FormField`: one field's label, control and help or error. `TextField`, `TextAreaField` and `SelectField` are
  built on it; wrap any other control (a `SegmentedControl`, a row of toggles) in it so it gets the same label and
  help. `layout="inline"` makes it a settings row, the label beside the control on two fixed tracks once the form is
  36rem wide; `extra` puts a badge beside the label.
- `FormGrid`: short fields on two or three equal tracks, so inputs line up from row to row; one column under 32rem.
- `FormActions`: the primary action first, then the rest, left aligned; `end` holds one that removes. Each button
  takes the whole width, at the touch size, on a form under 30rem.

**Not for** filters above a list (a plain grid of `SelectField`s, as the audit log has), or a decision card in a
session.

**Costs** container queries only: no script, no listeners.

### TextField

**For** a labelled single-line input with a hint or an error, laid out by `FormField`. `width="short"` for a number
or a time, `mono` for a path or a command. 16px under a coarse pointer, so iOS doesn't zoom.

**Not for** the composer, which has its own multi-line field.

### TextAreaField

**For** a labelled multi-line input for text a person writes out, such as a scheduled task's prompt. Same frame,
hint and error as `TextField`; its height follows `rows` and the person can drag it taller.

**Not for** the composer, which sends on Enter and has attachments.

### PageTabs

**For** a page's own views, one shown at a time, each with its address: Egress's Log, Rules and Settings. Each tab is
a link (`href`), so a view can be reloaded, shared and opened in a new tab; the one shown (`selected`) is in
full-strength text with a bar on the row's hairline and `aria-current="page"`. `onSelect` shows a tab in place of
following its link (the host navigates); a modified click still follows it. A tab's `count` follows its label. The
row scrolls sideways when the tabs don't fit, as on a phone.

**Not for** the app's pages (use `Sidebar` or `TabBar`), or filters and views within one view that need no address
(use `SegmentedControl`).

### SegmentedControl

**For** two to five exclusive views or filters: Unified or Split, All, Working or Done. A radio group: Tab reaches
the selected option, arrow keys move. An option may be `disabled` (shown, not chosen, such as one that is coming);
arrow keys pass over it. Its `value` may be `undefined` while a page is still working out which view to open on: no
option is lit until then, rather than lighting one and moving off it (the Connections page's tabs). An option's
`tone` (`done`, `approval`, `error`) colours it when it's chosen, for a choice that is itself a status: Allow, Ask,
Block in a connection's policy grid. The label still says it; the colour only repeats it.

**Not for** more than five options, for actions, or for a page's views that each have an address (use `PageTabs`).

### CheckboxField

**For** one on/off choice that takes effect with the form or decision it sits in: "Let agents write" beside a
Grant button. The browser's own checkbox in the accent colour, its label beside it (clicking the label toggles it)
and an optional hint, read as its description.

**Not for** a setting that applies the moment it changes (use a `Switch`), or a choice of one from several (use a
`SegmentedControl` or a `SelectField`).

### Switch

**For** an on/off setting that applies the moment it changes, with no Save button: a tool server's tool, enabled or
not. A button with `role="switch"` and `aria-checked`, so Space and Enter toggle it and a screen reader says on or
off; its label beside it toggles it too (`hideLabel` keeps the label for screen readers only, where the row says what
it is), and an optional `hint` is read as its description. The owner sets `checked`: while the change saves it passes
`busy`, which keeps focus on the switch, ignores clicks and makes the thumb breathe. `disabled` greys it and its
label.

**Not for** a choice that takes effect with a form or a decision (use `CheckboxField`), or a choice of one from
several (use a `SegmentedControl`).

**Cost:** none beyond the element; the busy thumb's breathing is an opacity animation, off under reduced motion.

### SliderField

**For** a number chosen along a range, where the position matters more than typing it: a new sandbox's vCPUs and
memory. The browser's range input, so arrow keys move a step, Page Up and Down further and Home and End to the ends,
and a screen reader reads `format`'s words ("4 vCPU", "256 MB") as its value. The value shows beside the label, the
range's ends under the track, and a tick at each of `marks` (the shapes a host offers by name). `onChange` gets a
value already on a step and within `min` and `max`; the owner may narrow `min` and `max` as other fields change (memory
follows vCPUs). Its track and thumb are drawn in controls.css, since they are engine pseudo-elements.

**Not for** a few named choices (use a `SegmentedControl` or a `SelectField`), or an exact figure to type (use a
`TextField`).

**Cost:** none beyond the element.

### OneTimeSecret and CommandBlock

**For** a secret shown once, when it is made: a tunnel token, an API key. `OneTimeSecret` is a panel in the approval
tone: its heading (which takes focus, so a screen reader reads it next), the secret in a code block that selects
whole with one click, with Copy; any `commands` that use it, each a `CommandBlock` with its own Copy; a warning that
it won't be shown again (`warning` says where to keep it); and an acknowledge button ("I've stored it") after which
the owner forgets the secret. `CommandBlock` alone is a command to run, in code's font, with Copy; it wraps rather
than scrolls, and Copy drops under it on a phone.

**Not for** anything Kantel can show again (use `Code` or a `Field`), or code to read (use `Code`).

**Cost:** none beyond the elements and CopyButton's 1.5 second timer after a copy.

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

New icons come from [lucide](https://lucide.dev) (`lucide-react`, imported one by one so only those used are
bundled). Give one `className="kt-icon kt-icon-md"` (or `-sm`) so it sizes like the rest, and `aria-hidden` unless it
carries meaning on its own.
