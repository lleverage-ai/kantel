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
Decline, Copy link), `ghost` (inside dense rows and toolbars), `danger` (stopping or refusing something), `danger-quiet` (a destructive action that isn't the page's point, such as Leave: a red outline with no fill, whose confirming dialog has the solid `danger`). Sizes `xs`
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

### Tooltip and HelpHint

**For** a few words about what's under the pointer or the keyboard's focus: a truncated name or address in full
(`whenTruncated` shows it only while the text is cut short), a time's date, a chart's figures, an icon button's
purpose. It shows after 350ms, at once while moving along a row of them, on keyboard focus too, and Escape or a scroll
hides it. It is on the page's body, so a table's scrolling frame or a row's covering link never clips it. `HelpHint`
is the small "?" after a column heading or a label, a Tab stop of its own with the explanation in its tooltip.

**Not for** anything someone must act on (a tooltip can't hold a button) or must read to use the page. Not on touch:
a tap shows nothing, so nothing essential may live only there.

### Dialog

**For** a modal: a heading, a sentence or a field, and its buttons (`actions`). Without `actions` it is a dialog to
look at, with a close button in the heading's corner; `width="wide"` gives it room for a chart and a table, `icon` an
icon before the heading and `toolbar` controls at the heading's end (a sandbox's metrics: the 1h, 24h and 1w range).
On a narrow screen the toolbar goes under the heading.

**Not for** long forms or anything with its own address (use a page).

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

### SideScroll

**For** content that is wider than its column and scrolls sideways: a table with more columns than the window has
room for. Its own scrollbar shows inside its frame. In a long list that bar is below the window, so nobody would know
there is more to the right: while it is out of view, a pinned bar shows at the bottom of whatever scrolls the page, and
it goes once the scroller's own bar comes into view, so one bar shows at a time. An edge with more past it fades the
content into its ground; the fade deepens over the first 32px of scroll and thins over the last 32px, so it never
switches on or off. `surface` (`raised` for a card, `canvas` for a table on the page) is the ground the fades, the pinned
bar and a stuck header row are painted in. With nothing to scroll there is no bar and no fade. `className` styles the
scroller itself, which sits with its fades and pinned bar in a wrapper of their own; wheel, trackpad, touch and keys
scroll it as usual.

`fill`, for a page that is a list (Sandboxes, Snapshots, Environments, the egress log; `TableFrame` passes it on): the
content takes the room its page leaves under the header, filters and notices, and scrolls down in it too, so New and
the filters stay in view down a long list. Its bottom is then always in view, so it shows its own scrollbars inside its
frame and the pinned bar doesn't show, and while it scrolls down its table's header row sticks. Every flex column from the
console's page down to it carries `kt-fill`
(`tokens/base.css`), which lets one holding a filling table shrink; the rest keep their height. A short list stays
as tall as its rows. A phone (the console puts no `kt-fill` on its page), a window under 36rem tall, and a table shown
as cards all scroll the page as before.

**Not for** a compute page's table (`TableFrame` has one), or a tab row (`PageTabs` scrolls its own, with no bar).
Not `fill` on a page with more than the list on it (a sandbox's own tabs, Settings): those scroll as a page.

**Cost:** a ResizeObserver on the scroller and its children, and a state update when the overflow or an edge changes,
not on every scroll.

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

### OrderedSelectField

**For** a choice of several from a list where their order matters: a new sandbox's environments, where the later one
wins. The ones picked are a numbered list, each with a cross that takes it out (focus moves to the select); under them
the browser's own select and Add put one more at the end. Add, or Enter in the select, adds: not the select's change,
which a closed select fires on every arrow key. An option picked already isn't offered again; `max` takes the select
away once that many are picked. A picked value no longer among the options is still listed, by its value.

**Not for** a choice of one (use a `SelectField`), an unordered set of a few (use `CheckboxField`s), or reordering a
long list.

**Costs** nothing beyond its elements: no listeners or timers.

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
bundled). Give one `className="kt-icon kt-icon-md"` (or `-sm`, or `-lg` for a state's mark) so it sizes like the rest, and `aria-hidden` unless it
carries meaning on its own.

## Compute parts

### HostDiskUsage

What takes the space on a host's disk (`src/compute/host-disk.tsx`), under its graphs when its row on the Hosts page
is opened: used of total with a bar (amber from 75%, red from 90%, as the table's capacity bars), then the bytes of
saved and automatic snapshots, sandboxes, base images, templates, bundles and the rest, and the limit on each account's
saved snapshots on it. The figures are in four columns on a wide screen, two on a small one and one on a phone;
`narrow` puts them in one column whatever the width. The host measures its snapshots together, and saved and automatic
come from Kantel's records. A host that hasn't measured its disk yet (just joined, or an older host agent) says so
instead.

**Don't use it for** live usage over time (use the host's graphs) or a sandbox's own disk.

**States:** measured, nearly full, with or without a limit, not measured, and a phone; all in its stories.

**Cost:** none: the host measures, every few minutes, and the page shows what it last sent.

### HostMemoryUsage

A host's memory (`src/compute/host-memory.tsx`), between its graphs and its disk when its row on the Hosts page is
opened: what decides admission (what sandboxes were given, or, with memory over-commit on, what they count for) of the
memory the host has for sandboxes, with a bar coloured as the disk's, then given (with its share, which may pass 100%),
committed, what the guests use, what they hold of the machine, available, what is kept for the host, swap and memory
pressure. A line says how it admits, and another, when it is short of memory, what it is doing about it (reclaiming,
refusing new sandboxes, ending processes). `narrow` puts the figures in one column. A host agent that doesn't report its
memory shows nothing.

**Don't use it for** memory over time (use the host's graphs) or a sandbox's own memory.

**States:** by reservation, by use, refusing, not reported; all in its stories.

**Cost:** none: the host sends it with every heartbeat.

### Pools on the Hosts page

The hosts grouped by the pool they are in (`src/compute/host-pools.tsx`), where the `HostsSource` has `pools`. Each
pool has a heading over its hosts (`PoolHeading`): its name, which wraps rather than being cut short, Default on the
default pool, a line of what its hosts hold (hosts, online, vCPU in use of the total, sandboxes), and its menu: Add host
here, Rename, Make default (not on the default) and Delete, greyed out with why ("Default", "Has hosts") unless the pool
is empty and not the default. A pool with no hosts says so under its heading, with Add host here (`EmptyPool`). The
default pool comes first, then the rest by name, and a host in no pool the page has read is in the default, as Kantel
puts it. Every pool shows, even with no hosts at all, so a new account's one pool can be renamed. On a super-admin's
page, accounts' own hosts are in their accounts' pools, not the deployment's: they're listed after the deployment's
pools under their own heading (`AccountHostsHeading`), with no pool menu and no Move to pool. New pool and Rename take a name the API takes (lower-case letters, digits and dashes), checked as it's typed
(`PoolNameDialog`); Delete asks first, and says that a join command made for the pool and not yet used still works,
its host joining the default (`DeletePoolDialog`). Make default runs one change at a time, greyed out on every pool
while one is under way (`oneAtATime`), as Kantel makes the change it handles last the default.

A host's menu has Move to pool where the source has `move` and there's another pool. Kantel moves only a drained host
with no sandboxes, so `MoveHostDialog` says so first, then what stands in the way as the page last read it (not
drained, with a Drain button; or drained with sandboxes left), then the pool to move it to. Kantel checks again as it
moves it, and its reason shows in the dialog as an error notice when it refuses. A moved host stays drained.

Add host has a pool picker (`PoolPicker`) where there is more than one pool, starting on the default, or on the pool
whose menu opened it; the pool goes with the join token, so changing it makes the command again. With one pool there
is no picker and the host joins the default. Where the pools can't be read, the page lists the hosts ungrouped under
an error notice with Try again, and Add host says the host joins the default pool; a later read that fails keeps the
pools last read, so a pool chosen in Add host stays chosen. A source with no `pools` (an older gateway) lists the hosts
ungrouped with no pool actions.

**Don't use it for** where a sandbox goes when it's created (New sandbox's pool picker, below) or a host's labels.

**States:** many pools with an empty one, one pool, one pool with no hosts, long names, pools that can't be read, no
pools, accounts' own hosts on a super-admin's page, New pool, Rename, Delete, Move to pool (not drained, with sandboxes,
ready), Add host in a pool and with one pool, and a phone; all in the Hosts page's stories.

**Cost:** one read of the pools with each read of the hosts (when the page opens, then every minute), and one after
each change made on it.

### New sandbox's pool picker

New sandbox (`NewSandboxDialog` in `src/compute/sandboxes-page.tsx`) picks the pool a sandbox goes in with the Hosts
page's `PoolPicker`, where the `SandboxesSource` has `pools` and the account has more than one, starting on the default
(or on the page's `pool`). With one pool, while the pools are being read, or with none (account hosts off) there is no
picker and nothing else changes: the sandbox goes in the default pool. The default sends no `pool`, so a create goes
where one naming none goes, the deployment's shared hosts included; another pool goes as `pool`, and the sandbox runs on
that pool's hosts and stays in it. Picking a pool reads the sizes again for its hosts (`shapes` with the pool), and the
host picker then offers only that pool's hosts, letting go of a host picked in another. A pool with no hosts says so
under the picker, and Create waits for another. Where the pools can't be read, a warning notice says the sandbox goes in
the default pool, with Try again. When Kantel refuses the create (none of the pool's hosts can take it now), its reason,
which names the pool, shows in the error notice over the list.

**Don't use it for** a host's pool (the Hosts page's Move to pool and Add host).

**States:** several pools, one pool (no picker), a pool picked, an empty pool, a refusal naming the pool, the pools
being read, the pools not read, long names and a phone; the Sandboxes page's `Create…` stories.

**Cost:** one read of the pools the first time New sandbox opens, and a read of the sizes each time the pool changes.

### HostPeers

A host's mesh peers (`src/compute/host-peers.tsx`), under its disk when its row on the Hosts page is opened: each other
host of its pool by name (its ID where the page has no name for it), whether the host reaches it, the path (direct, or
none), the endpoint it uses, its last handshake as a relative time and the round trip of its last probe, as the host
last reported them. A peer is unreachable when its path is none or its last handshake is more than 5 minutes old
(`meshPeerReachable`: the host's own 3 minutes and a heartbeat or two); unreachable peers come first, in the error
colour, and the heading counts them. `narrow` gives a short row per peer instead of the table. A host without a mesh
(its pool's sync off, or an older host agent) says so plainly, as does one that isn't connected, and one alone on its
pool's mesh says it has no peers yet.

**Don't use it for** a pool's mesh as a whole (each host shows its own view of it) or a sandbox's network.

**States:** reachable, unreachable (no path, a stale handshake, never shaken hands), many peers, long names, no peers,
no mesh, not connected, and a phone; all in its stories. Loading and a failed read are the Hosts page's, whose list
brings the peers.

**Cost:** none: the host sends it with every heartbeat.

### SnapshotHosts and SnapshotCopiesSwitch

A saved snapshot's hosts (`src/compute/snapshot-hosts.tsx`), in a dialog from Hosts in its menu on the Snapshots page:
the host it was saved on first, then each with a copy or fetching one, as they last reported. Each row is the host's
name, Held or Fetching, and for a snapshot saved with memory, whether a sandbox made from it there restores it (With
memory) or starts from the disk (Disk only). A shared host, for anyone but a super-admin, is listed as Shared host,
since the API doesn't name it. `SavedSnapshotHosts` reads them from `SnapshotsSource.hosts`: a skeleton while it does,
the reason with Try again where it can't, and a line where the gateway is from before it.

`SnapshotCopiesSwitch` is the account's Keep saved snapshots on two hosts (`snapshotCopies`): on an organisation's
General page and, for the personal account, on Profile. It applies at once, keeps what Kantel answers as saved, and
is read only for a member. Neither shows where the account doesn't say (a gateway from before it).

**Don't use it for** a host's own disk (use `HostDiskUsage`) or an automatic snapshot, which is on its sandbox's host
alone.

**States:** loading, one host, two hosts, fetching, with memory, shared hosts, not on a host yet, long names, a failed
read, an older gateway and a phone; the switch on, off, read only and refused. All in its stories.

**Cost:** one read of the snapshot (`getSnapshot`) each time its hosts open.

### MoveDialog

Move to host (`src/compute/sandbox-move.tsx`), from a microVM's menu on its page and its row in the Sandboxes list,
where the `SandboxesSource` has `move` and `moveTargets`. The item is there for every microVM, greyed out unless it can
move now (`canMove`: running, stopped or paused, on a host the viewer can see, connected). The dialog lists the hosts it may move
to (`moveTargets`: the other hosts of its pool that run microVMs), one radio row each with the host's name, cut short
with the whole name in its tooltip, and what a move there does: Keeps memory or Restarts, and the pause Kantel expects
(`pauseMs`) where it gives one. Until Kantel answers a move's dry run, `memory` and `pauseMs` are absent: every host
says Restarts and there is no pause. Where the chosen host keeps memory, Restart it instead sends `keepMemory: false`.
A paused sandbox whose chosen host restarts it says its memory is lost.

Move switches the dialog to the move's progress: its phase from the sandbox's reads (`moving` and its `move`), worded by
`movePhaseText` (`copying`, `starting`, and a running sandbox's `stopping` and `final-copy`; a phase it doesn't know
reads as Kantel names it), with the time it has taken. Close leaves it moving: the page shows Moving, and on the sandbox's
page its phase, and the result comes as the page's notice, also when the dialog went because a list's filter took its
row away. A failure keeps the dialog open with Kantel's reason and the hosts to try again; the sandbox is where it was.

**Don't use it for** a host's pool (the Hosts page's Move to pool) or where a new sandbox goes (New sandbox's pickers).

**States:** loading, no hosts, several hosts, the dry run (memory kept, a pause), paused, in progress and each phase
(copying, starting, stopping, final copy, one it doesn't know), failed with the reason (in the dialog, and on the page
once the dialog has gone), hosts not read, long names and a phone; all in its stories.

**Cost:** one read of the hosts each time it opens (`listHosts`, or the account's own); while it moves, the page reads the
sandbox as it does for any state change.

### SandboxStateLabel

A sandbox's state in words with its status dot (`src/compute/parts.tsx`), as the Sandboxes list and a sandbox's page
show it: its lifecycle state in its colour (Moving, pulsing, while it moves to another host), "Unresponsive" in the error colour for a running one whose guest agent
doesn't answer, and "Host unreachable" in the warning colour for one whose host isn't connected to Kantel
(`showsHostUnreachable`: starting, running, stopping or paused; a stopped one, or one in error, keeps its state). With
its host away, the page says why in a warning notice and offers only Stop (`sandboxActions`), and the pages read it
again every 15 seconds besides the live feed's word.

**Don't use it for** a host's own state (the Hosts page's labels) or anything but a sandbox.

**States:** each lifecycle state, unresponsive, host unreachable; the Sandboxes list's and Sandbox page's
`HostUnreachable` stories, on a wide screen and a phone.

**Cost:** none: it shows what the sandbox's answer says (`hostReachable`).

### SandboxEnvironments

A sandbox's environments (`src/compute/sandbox-environments.tsx`), on its Overview after its ports: in order, each a
link to the environment. Under each, quietly, what it loses to a later one (or to the sandbox's own env): variables,
secret files and repositories set by a later one instead. "On next start" marks one attached while the sandbox was
stopped, whose files and repositories come when it next starts. Attach picks one of the account's environments and
puts it last, so it wins; Detach asks first, since the environment's protected variables stop resolving at once.
Without the source's `environments` the section isn't shown; without the account's list there's no Attach.

**Don't use it for** editing an environment (its own page) or a sandbox's egress grants (its Egress tab).

**States:** several, shadowed, pending, one, none, loading, error, attaching, an attach refused, nothing left to
attach, long content and a phone; all in its stories.

**Cost:** one read when the page opens, and again when the sandbox starts or stops or its environments change.
