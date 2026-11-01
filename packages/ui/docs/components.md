# Components

What each component is for, when not to use it, its states and what it costs. Stories for each are in the
workbench (`pnpm --filter @kantel/ui dev`).

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
  `translate: 0 var(--kt-on-cap)`. `StatusLabel`, `ListRow`'s leading slot and `Notice` do this. In a slot with no
  text of its own, give the slot the text's size and line height and an invisible character for a baseline, as
  `.kt-list-row-leading` does.
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

A selected row's title is in full-strength text and medium weight, even on a `quiet` row, so the row you're on reads
as more than a fill.

### Sidebar

**For** an app's main navigation, after T3 Code's sidebar: `Sidebar` frames a head (`SidebarBrand` and
`SidebarToggle`), a body that scrolls on its own and a foot that stays put. In the body, `SidebarSection` "Projects"
holds `SidebarProject` rows (chevron, folder, name, an optional action such as New session); the current project's
sessions (`NewSessionRow`, `SessionList`) are its children, nested on a guide line under its chevron. In the foot,
`SidebarItem`s link to the pages outside projects, each with a 16px icon, then `SignedInAs`. Every name truncates on
one line.

Active state: the page shown (`selected`) is filled, in full-strength text and medium weight, with
`aria-current="page"`; the project you're in (`current`) is in full-strength text without a fill, so only one row in
the sidebar is ever filled. `collapsed` makes it a rail `--kt-rail-width` wide: icons, a project's first letter in a
small square, and the avatar, each keeping its name for screen readers and as a tooltip; sessions and headings are
hidden. The host owns the state, the width (`--kt-sidebar-width` or `--kt-rail-width`) and the landmark role; the
console remembers it in localStorage and toggles it with Ctrl+B (⌘B on a Mac). `useSidebarCollapsed()` tells a
component inside whether it is on the rail.

**Not for** navigation inside a page (use `SegmentedControl` or a list), or a file tree (`FileTree`).

**Cost:** no timers or animation; the rail is a CSS state of the same elements, so collapsing mounts nothing new
but the rail's New session link.

### Breadcrumbs

**For** where you are, as a trail: `Default / Fix the billing worker / Write the refund tests`. `parents` (`Crumb[]`,
outermost first) are muted, in medium weight, and each is a link (`href`, preferred) or a button (`onSelect`) back to
its level, brightening on hover; `current` is the last item, in the text colour, with `aria-current="page"` and never
a link. Slashes in the faint colour separate them and are hidden from screen readers. Everything sits on one
baseline. The current item takes the room that's left and truncates first; a parent keeps at least a few letters.
Modelled on T3 Code's `WorkspaceBreadcrumb` and its chat header's project / parent / thread trail.

**Not for** tabs or switching between peers (use `SegmentedControl`), or a path inside a file tree.

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

### SegmentedControl

**For** two to five exclusive views or filters: Unified or Split, All, Working or Done. A radio group: Tab reaches
the selected option, arrow keys move. An option may be `disabled` (shown, not chosen, such as one that is coming);
arrow keys pass over it. Its `value` may be `undefined` while a page is still working out which view to open on: no
option is lit until then, rather than lighting one and moving off it (the Connections page's tabs). An option's
`tone` (`done`, `approval`, `error`) colours it when it's chosen, for a choice that is itself a status: Allow, Ask,
Block in a connection's policy grid. The label still says it; the colour only repeats it.

**Not for** more than five options, or for actions.

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

### OneTimeSecret and CommandBlock

**For** a secret shown once, when it is made: a tunnel token, an API key. `OneTimeSecret` is a panel in the approval
tone: its heading (which takes focus, so a screen reader reads it next), the secret in a code block that selects
whole with one click, with Copy; any `commands` that use it, each a `CommandBlock` with its own Copy; a warning that
it won't be shown again (`warning` says where to keep it); and an acknowledge button ("I've stored it") after which
the owner forgets the secret. `CommandBlock` alone is a command to run, in code's font, with Copy; it wraps rather
than scrolls, and Copy drops under it on a phone.

**Not for** anything Kantel can show again (use `Code` or a `Field`), or code to read (use `Code`).

**Cost:** none beyond the elements and CopyButton's 1.5 second timer after a copy.

### JsonViewer

**For** a JSON value to read, such as a connection call's answer (`src/code/json-viewer.tsx`): a tree open at its
first level (`openDepth`, default 1) and folded under it. Each fold is a button with `aria-expanded`, the key and
what it holds ("3 items", "2 keys"), so Tab, Enter and Space walk and open it; keys, strings, numbers, booleans and
null take the syntax colours. An array or object shows its first `JSON_PAGE` (100) entries, then "Show N more".
`label` names it for a screen reader. It wraps long strings; its host gives it a scrolling frame.

**Not for** JSON to copy or edit (use `Code` with `json`), or a value that isn't parsed yet.

**Cost:** an element per shown entry; folded entries render nothing under them until opened.

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
carries meaning on its own. The presented-file cards are the first to use them.

## Workspace

Read-only views of a workspace's files, fed by the host from the workspace read API (`@kantel/workspace/read-api`,
GET routes only); they never fetch, write or acquire a sandbox. Details, keyboard behaviour and costs are in
[workspace.md](workspace.md).

- **`FileTree`**: a workspace's files as a WAI-ARIA tree, one Tab stop with arrow-key navigation. Loading, error and
  empty states for the root, and inline Loading and error rows for a directory.
- A file opens in **`FilePreview`** (`src/preview/`, [preview.md](preview.md)), the same panel as everywhere else.
- **`workspace-model.ts`**: the pure helpers behind them (`visibleRows`, `nextFocus`, `sortEntries`, `fileKind`,
  `formatBytes` and others), exported for hosts.

## Documents

A document the agent writes with `create_document`, after Claude Docs, in `src/documents/`. Presentational: the host
reads and saves the file and passes the state in.

- A document opens in **`FilePreview`** ([preview.md](preview.md)): while it streams the Markdown so far flows in at
  a steady pace (`useSmoothText`, at most a render every 48ms) with a caret at the end of its last line, and the
  header says Writing; once written it opens in Edit, a TipTap (ProseMirror) editor over
  Markdown with a sticky toolbar (undo, redo, text, headings 1 to 3, bold, italic, strikethrough, code, lists, quote,
  table, divider), saved as the person types (Saving, Saved, Edited or Couldn't save). The editor is its own chunk,
  loaded when a document first opens.
- **`SharePopover`** and **`ShareButton`**: Share and Export tabs, after Claude's. Share invites by email, lists who
  has access (the owner, then each invite), sets general access (Only you, or Anyone with the link) and copies the
  link; Export lists the host's exports. Without `sharing` the popover is Export alone.
- **`exportMarkdown`** and **`printDocument`**: Export's Markdown (a `.md` download) and PDF (the print dialog with
  only the document on light paper; its "Save as PDF" makes the file).
- **`draftDocument`** and **`documentSlug`**: the draft the newest answer is streaming, and a title's file name.
- **`DraftDocumentCard`** (in the transcript, from `AssistantMessage`): the card a streaming document becomes.

## Schedules

The schedule form, in `src/schedules/form/`. The schedules page (list, detail, run history) is in `src/schedules/`
beside it and opens the form for New schedule and Edit; see [schedules-skills-memory.md](schedules-skills-memory.md).

- **`ScheduleForm`**: creates or edits a task (an agent and a prompt) or a check (a command), repeating every N
  minutes, hours or days, on weekdays, on chosen days of the week or on a day of the month, or once; with its time
  zone, an optional limit on runs, a check's re-raise settings, and the next five due times beside it as the person
  types. Editing offers End after a confirmation. The prompt goes to the agent exactly as written. The preview uses
  `previewDue` from `@kantel/schedules`, the scheduler's own function, on each render; no timers.
- **`ScheduleWrites`**: the calls the form makes, `create`, `update` and `end`: the writes of the page's
  `SchedulesSource` (`bindSchedules`), so the page's source is the form's. The fixtures are the page's
  (`@kantel/ui/schedules/fixtures`).
- **Payloads**: a task's is `{ agentId?, prompt }`, as the public API has it (the form always names an agent; without
  one the runner asks the default), a check's is its argument list (`taskPayload`, `readTaskPayload`,
  `readCheckPayload`). A schedule whose payload is another shape, extra fields included, has no Edit, so the form never overwrites it.

## Connection sharing and session visibility

Who can use a connection and who can see a session, in `src/connections/connection-sharing.tsx` and
`src/session/session-visibility.tsx`. Stories: Connections/Sharing.

- **`ConnectionSharingSection`** (on a connection's page, above its rules): where the connection reaches, line by
  line (sessions, who may see them, unattended runs, agents), and for a person's connection the projects it's shared
  with. Only its owner shares it, after a confirmation that says what sharing lets happen; the owner or an admin stops
  a share. An admin looking at someone else's connection sees it all, with a notice that only its owner can use it.
- **`ConnectionUsesSection`**: its recent uses, newest first: the session and step, who the session acted for, who
  could see it, and the reason for a refusal or a hold.
- **`SessionVisibilityButton`** (in the session header's actions) and **`SessionVisibilityDialog`**: Only you, or
  everyone in the project; the connections the session could use with each choice, with the API's reason for each it
  couldn't; a warning before a private session becomes shared. `locked` shows the choice read-only, with why.

## What agents may do, and a session's connections

A connection's policy as a grid (#462), in `src/connections/connection-policy.tsx` over
`connection-policy-model.ts`, and a session's connections in its access menu (#463), in
`src/session/access-connections.tsx`. Stories: Connections/What agents may do, and Session/Composer's Access menu
stories.

- **The grid** leads `ConnectionRulesSection` for an API connection: a row per permission group, a column each for
  read, write and delete, each cell an Allow, Ask or Block `SegmentedControl` (a dash where the group has no such
  requests, and no option lit, with "Varies" beside it, where the answer varies by request). Then Repositories, for
  GitHub: every repository it can reach, or only these (chips, and an owner/name field). Then Exceptions: the rules
  that decide some requests themselves, each saying where it came from. The grid is made of ordinary rules, marked
  with `GRID_NOTE`; a change runs its plan (create, then update, then remove, one call at a time), says it's saving
  and takes nothing more meanwhile, then reads the rules again. Advanced, closed by default, holds every rule, the
  unmatched answer and Add rule. An MCP server's connection has no grid: its tool rules show as before. Without
  `canManage` each cell shows its answer as a badge, with no controls.
- **`SessionAccessConnections`**, passed to `Composer`'s `accessConnections` (and from there to `AccessPicker`'s
  `connections`), lists under the access levels the connections the session can use: logo, name, account and owner,
  its policy in a line (`accessPolicyLine`: "Reads allowed, writes ask, deletes blocked", read the way the dry run
  decides), and under it what this session alone was allowed (`sessionAllowances`: rules for this session), with
  Revoke where the viewer manages the connection. It loads each time the menu opens; loading, none and error states
  keep the levels usable. The levels stay a radio menu; the connections sit beside it, reached with Tab. Leave it out
  where there's no session yet.

## GitHub's service page

GitHub's page on the Connections page (#461), in `src/connections/github-page.tsx` with its words and choices in
`github-page-model.ts`; `ProviderDetail` picks the state. Stories: Connections/GitHub page.

- **Three states, one primary action each** (`gitHubPageState`): not set up (GitHub makes the organisation's GitHub
  App from Kantel's manifest, through `GuidedSetup`); app made (**`GitHubSetupSteps`**: 1 Install on repositories,
  2 Connect your account); connected (led by the connection, `leadConnection`: the viewer's own first). The app is
  called by its name on GitHub (its slug, such as kantel-agent) throughout.
- **`GitHubOverview`** (connected): the header says who it's connected as and who can use it, with Change to the
  connection's sharing. Then what it can reach (`ConnectionsSource.reach`: the repositories, whose they are, Show all,
  and Manage repositories on GitHub; loading, error and can't-be-asked states), what agents may do (`policyLines` over
  the connection's rules, with Edit what agents may do) and Try it in a session (prompts that open New session in the
  connection's project, `tryProject`, with the prompt ready to send). Connect another GitHub account is a quiet link.
- **`GitHubAppPermissions`**: the app's permissions (`GITHUB_APP_PERMISSIONS`), read only. A GitHub App's sign-in
  gets these whatever it asks for, so the page shows no scope checkboxes for it.
- Signing in connects a person's own account, so who can use it starts on Just me (`defaultOwner(viewer,
  "identity")`). Where sessions are their project's, the form warns, and the connected step offers Share it with a
  project.
