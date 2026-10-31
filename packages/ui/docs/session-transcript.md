# Session transcript

The transcript and the rows it is made of, in `src/session/`. Stories are under "Session/Transcript" and
"Session/Tool call" in the workbench. The patterns follow T3 Code's chat timeline (see
[principles.md](principles.md) for the sources).

### Transcript

**For** a session's whole conversation: the person's messages, the agent's answers, its tool calls, the host's
notices and cards. A virtualised list (virtua's `VList`) in a centred column `--hb-content-width` wide, filling its
parent's height.

```tsx
<Transcript
	key={sessionId}
	items={state.items}
	hasOlder={state.hasEarlier}
	loadingOlder={state.loadingOlder}
	onLoadOlder={client.loadOlder}
	renderCard={renderCard}
/>
```

Props: `items`, `hasOlder`, `loadingOlder`, `onLoadOlder`, `renderCard(item)`, `loading`, `empty`, `error`,
`onRowRender(id, phase)` (`phase` is `"mount"` or `"update"`), `delivery`, `dock`, `centreDockWhenEmpty`, `toolRenderers` and
`previewImage` (see [Tool renderers](#tool-renderers)), `className`.

`dock` floats a node, usually a `Composer`, over the transcript's foot, as T3 Code's thread does: the list scrolls
under its glass, and the end of the list makes room for it (its measured height plus 16px). A docked `Composer`
rests (folds to one line) while the reader scrolls back and comes back at the end; files dropped anywhere on the
transcript go to it. See [session-composer.md](session-composer.md#docked-in-a-transcript).

`centreDockWhenEmpty`: while there are no items, the dock sits under `empty` in the middle of the page, a little above
it (the space under is twice the space over), rather than at the foot, as claude.ai and Claude Code on the web open a
new chat. The new session's screen uses it, with a `greeting` `EmptyState`; once items arrive the dock is at the foot.

**Not for** short lists of messages outside a session (a preview, a search result): render `UserMessage` and
`AssistantMessage` directly. Not a live region: screen readers are not read every token.

**States:**

- *Following:* while the reader is within 48px of the bottom, new rows and growing rows (a streamed answer, a tool's
  output) keep the end in view. Scrolling up stops following and shows a floating "Scroll to end" button just above
  the bottom edge; reaching the bottom again, or pressing the button, resumes following.
- *Older history:* within 600px of the top, with `hasOlder`, it calls `onLoadOlder`; "Loading earlier messages"
  floats at the top while `loadingOlder`. When older items are put in front, the visible rows stay where they are.
- *Loading:* `loading` with no items shows two skeleton turns. With items, `loading` is ignored and the list shows.
- *Empty:* no items and not loading shows `empty`, or "No messages yet" with "Send a message to start the session."
- *Error:* `error` shows in an error `Notice` above the list; the list stays usable below it.
- *Working:* with `working`, the session is working on a turn, after T3 Code's timeline
  (`MessagesTimeline.logic.ts:1646-1684`, `TimelineWorkGroupRows.tsx:277-309` and `383-420`), from the moment a
  message is sent until the run settles. Right under the person's message, a `WorkingIndicator`, "Working for 12s"
  with a hairline divider under it; a steer joins the turn under way and doesn't move it. The turn's work follows the
  divider, and the turn ends with a `LiveActivity` row, a brain and "Thinking", whenever nothing else shows what the
  agent is doing: before the first token and between steps. A running tool call or a streaming answer is the activity
  itself, so the row leaves the end to it (`workingPlacement`). `working` is `true` (timed from the last message the
  person sent, other than a steer) or `{ since, label }` (timed from when the host sent it, before the message is back
  from the stream). When the turn's message is not loaded (it is in an older page), the header goes at the end,
  before the activity row, and says "Working" unless `since` is given. The rows alone are a list: a message just sent
  to an empty session shows them, not the empty state.
- *Sent from here:* a host that sends optimistically puts the person's message in `items` the moment it is sent,
  under an ID of its own with the send's `requestId`, and says in `delivery` (by item ID) that it is on its way or
  failed (`MessageDelivery`). On its way it looks sent, without Edit from here; failed, the line under the bubble
  says "Couldn't send" and why, with Try again and Edit in the composer. A person's message with a `requestId` is
  keyed by it (`messageKeys`), so when the session's copy arrives and the host drops its own, the row updates in
  place: no second copy, no remount, nothing moves.
- *Docked:* with `dock`, "Scroll to end" sits just above the dock, and the empty state and skeleton stay clear of
  it. A wheel gesture of 24px or more up the list, a finger dragging it, or Page Up or Home rests a docked composer;
  reaching the end, "Scroll to end" or focusing the composer wakes it. While it rests the room at the end keeps the
  expanded composer's height, so the text you are reading doesn't move when it folds. Dragging files over the
  transcript shows a dashed frame with "Drop files to attach" and the host's limits, while the composer takes files.
- Cards render through `renderCard`, with the host's handlers. Without it they show read-only, from the same
  components: a vault request's terms and binding code, a question and its options, a browser request's reason,
  each waiting with nothing to press. A card is never reduced to its type.

Key the transcript by session. A different session's items would otherwise look like older history put in front.

**Keyboard:** the list is focusable (Tab), so arrow keys, Page Up and Page Down scroll it; every row's controls
(tool calls, thoughts, groups) are buttons reached by Tab. "Scroll to end" is a real button.

**Cost:** only the rows near the viewport are mounted (a 600px buffer each way), whatever the session's length.
Rows come from `groupTranscript` and are memoised on their row object, so while one answer streams only its row
renders. Each streaming answer's turn start is found in the same pass over the rows and passed as a number, so it
never renders a row on its own. `renderCard` is a row prop: pass a stable function, or every row renders when it
changes. `onRowRender` is
read through a ref and never causes a render; `apps/console` feeds it to its `?profile=1` panel. One `ResizeObserver`
on the list's content and its viewport keeps the end in view while following, including when the viewport is
resized (a phone's keyboard opening). Docked, one more `ResizeObserver` measures the dock, and passive wheel, touch
and key listeners on the list decide when the composer rests; none of them renders unless the resting state changes.

### Tool renderers

**For** giving a tool's calls a rendering of their own, in one place: the registry in
`src/session/tool-renderer-model.ts`, with the library's entries in `src/session/tool-renderers.tsx`. A tool with no
entry is the generic tool-call row (`ToolCallChip`), a step of the turn's work, folded under its "Worked for" line
once the turn ends. An entry (`ToolRenderer`) names its `tools` and says how they show, in one of two ways:

- **In place** (`inPlace`, `shows`): the call renders as something of its own instead of the generic row, such as
  `present_files`' file cards. The call is a row of its own (`{ kind: "call" }` from `groupTranscript`), where it
  happened in the turn, ending any run of calls around it. While `shows(item)` says it has something of its own to
  show (by default, once it is done), it is not a step: it never marks the turn's line, a closed fold keeps it in
  view, and a turn whose work is only such calls has no line at all, so it shows exactly once. Otherwise (it is
  running, or it failed) the transcript draws it as the generic row, which is a step and folds like any
  other, a failure too (the turn's line carries the alert mark for it). The renderer gets the call, the host's `onOpenFile` and `openFile`,
  `previewImage`, and `linked`. Whether a call renders in place goes by the tool's name alone, so a call keeps its
  row from start to end.
- **Within the row** (`label`, `detail`, `openByDefault`): the call keeps its generic row in its group, with its own
  words, what it shows when opened (`detail({ item, raw, showRaw, onShowRawChange })`, where `raw` is the generic
  arguments and output, to offer as a switch the row keeps), and whether it starts open. For calls that are steps of
  the work but read better as more than JSON: a file as an editor shows it, a command as a terminal.

The library's entries (`defaultToolRenderers`):

- `present_files` and `create_document`, once done with files: their files' cards. With the host's `previewImage` an
  image file is an image tile (`PresentedImageCard`, an `ImageTile`; see Image tiles), opening in the viewer like any
  card; a picture the host has none of keeps its tile, with the image icon. Without `previewImage`, a file's card with
  its icon. Files an earlier `generate_image` already showed get
  no second card (`repeatedImageFiles`); a call left with none takes no room.
- `generate_image`: while it runs, its row with `ImagePlaceholders` under it; once done with files,
  `GeneratedImages` (see Generated images), an image the call returned no picture of shown through `previewImage`.
- `read`, `write`, `edit` and `bash` (`codingToolRenderers`, `tool-views.tsx`): within the row, their cards (see
  Cards for read, write, edit and bash). A `ToolCallChip` outside any transcript (a story, a host's own list of
  calls) has no registry, and uses these.

A host adds or replaces entries with `toolRenderers([...defaultToolRenderers, ...mine])`, made once and passed as
`toolRenderers`; a later entry for a tool replaces an earlier one.

```tsx
const renderers = toolRenderers([
	...defaultToolRenderers,
	{ tools: ["make_chart"], inPlace: ({ item }) => <Chart item={item} />, shows: (item) => item.status === "done" },
	{ tools: ["bash"], label: commandLabel, detail: ({ item, raw }) => <TerminalCard item={item} raw={raw} /> },
]);
<Transcript items={items} toolRenderers={renderers} previewImage={previewImage} />;
```

**Presentation only.** The registry changes what the console draws, never the items: the session's API and event
stream carry every call as it was made (`ToolItem`, with its name, arguments, output and files) whatever renders it,
so an app built on Harbour shows calls its own way. `packages/runtime/test/project.test.ts` checks that a
`present_files` call is still a tool item in what the API sends.

**Not for** a run of calls that reads as one thing (a browsing run, `BrowsingGroup`) or a subagent's card
(`renderSubagent`): those are rows of their own kinds.

**Cost:** a lookup by name per call. The registry is a row prop and the context of every call: make it once, or every
row renders when it changes. `previewImage` is asked once per image card as it mounts; cache what it reads (the
console's `useImagePreviews` reads each file once and frees the object URLs when the session closes).

### groupTranscript

**For** turning transcript items into rows: `groupTranscript(items, previous?, inPlace?)` returns
`{ kind: "item"; id; item }` for every item that is not a tool call and `{ kind: "tools"; id; items; live }` for
each run of consecutive tool calls. Any other item ends a run. A call `inPlace` says renders in place (the registry's
`ToolRenderers.inPlace`) is `{ kind: "call"; id; item }`, ending any run. A group's `id` is its first call's id, so its key is
stable as calls join it; a single call is still a group of one, for the same reason. Only a group that is the last
row is `live`.

Pass the previous result as `previous`: every row whose items are unchanged (by identity) is the same object as
before, and when nothing changed the previous array itself comes back. This is what lets memoised rows skip
rendering while an answer streams.

**Not for** grouping by run or attempt: the protocol does not carry them yet, so every run of calls between two
other items is one group.

**Cost:** one pass over the items and a map of the previous rows by id, per change to `items`.

### Turn folds (`turnFolds`)

**For** folding a finished turn's work under one "Worked for 1m 12s" line, after T3 Code's turn folds
(`deriveTurnFolds`, `MessagesTimeline.logic.ts`). `turnFolds(rows, working, previous?, shows?)` returns each fold
(`{ id, rows, elapsed, failed }`, `failed` a boolean) by the id of every row it folds. A turn runs from a message the person sent
(a steer joins the turn under way) to the next. It folds once it has ended with an answer with words, after all its
work (a subagent still working keeps it open): its tool calls, browsing runs and the agent's words before the answer
go in the fold, failed calls included, as T3 Code's fold hides them too; the person's messages, the answer, notices,
cards and the turn's subagents stay out. A subagent's card is never a step of a working section: it stays in view
where it ran, a top-level row with its own avatar and status, as T3's subagent card is (`TimelineV2EventRow`). T3
keeps only a live subagent's card out of its fold (`liveSubagentCardEntryIds`) and folds a finished one; Harbour
keeps every one out, so a subagent never reads as a step of the work around it. The time runs from the person's message to the answer. A turn that stopped
without an answer (failed, stopped) stays unfolded, as T3 leaves a failed run open, and with `working` the last turn
isn't folded: its work streams at the top level and folds when it ends. A call rendered in place that shows as itself
(`shows`, the registry's `ToolRenderers.shows`) is in the fold but not a step, and stays in view while it is closed;
a turn whose work is only such calls gets no line.

The fold's rows stay rows of the virtualised list: the first carries the line (`TurnFoldLine`, which looks and works
as a `Disclosure` summary), and while it is closed each row shows only what stays in view: the files its calls
presented (and a generated image's card) and its browser's card (`ToolCallGroup` and `BrowsingGroup` take
`folded`). Its failed and interrupted calls fold away with the rest. The line never counts anything, steps or
failures: closed, it reads "Worked for 23s", then, when a step it hides failed (`failed`), an alert mark in the error
tone with no text (`StepFailed`: `role="img"`, aria-label and title "A step failed"). Nothing failed, no mark. A folded row with nothing to show takes no room. So folding a turn never changes how
many rows the list has, which virtua sizes by index. Open, every call shows flat (each group as if live), so the
turn's line is the one "Worked for" in it. Folds are closed by default on every load; the ones a person opened stay
open for the view, and a linked call (`#turn=`) opens its fold.

**Cost:** one pass over the rows per change; pass the previous result to keep each unchanged fold's identity, so
only a changed fold's rows render again.

### Generated images (`generated-image.tsx`)

**For** what `generate_image` leaves in the transcript. While the call runs, `ImagePlaceholders` shows one
`ImagePlaceholder` per image it asked for (`count`), in the shape it asked for (`aspect`: square, landscape 3:2,
portrait 2:3): a frame, a soft band of light crossing it by `transform` on its own layer, and an image icon breathing
(`hb-pulse`, opacity). Nothing that repaints animates. Once done, the runtime presents the saved images as
`present_files` presents files, each with `model` (`PresentedFile.model`), and `GeneratedImages` shows each as an
image tile (see Image tiles): the picture (the call's image, scaled down by the runtime when the file is too large),
its name and "PNG image made with gpt-image-1". It opens the file in the host's viewer, whose facts end with the
model. Without a picture from the call, the tile shows the host's read of the file (`previewImage`, a
`PresentedImageCard`); without a host either, it is a `PresentedFileCard`. The placeholders sit in the same grid, so
each is as wide as the tile its image becomes.

### Image tiles (`ImageTile`, `ImageTiles`, presented-file-card.tsx)

**For** every image in the transcript, whichever way it got there: a `generate_image` call's own picture or the host's
read of a presented image. A tile is a card with the picture as a square (`object-fit: cover`; the viewer shows it
whole), then the file's name and what it is. While the host reads the picture the square is a frame with the image
icon breathing (opacity); a picture it has none of, or one that fails to load, leaves the icon. `ImageTiles` lays them
side by side, wrapping: one image alone up to `--hb-presented-image-size` (the column's width on a phone), two or more
up to `--hb-presented-image-size-many` each, four to a row in the content column and two on a phone. A tile's width
comes from its place in the grid, never from its picture: cards sized to their picture (`width: fit-content` round a
`max-width: 100%` image) shrank to their caption's padding on iOS Safari, a row of narrow pills. It renders in place through the tool renderer registry (see
Tool renderers), so its call is not a step of the turn's work. The call's chip doesn't
repeat the picture (`images="none"`), and a later `present_files` of the same file adds no second card
(`repeatedImageFiles`).

### ToolCallChip

**For** one tool call, as a quiet work-log row (T3 Code's `WorkLog`): a 16px icon chosen from the tool's name, the
host's label in plain words and a chevron. `ToolCallChip({ item, defaultOpen? })`.

What shows where follows T3 Code's work-log row (pingdotgg/t3code at `1152e917`,
`apps/web/src/components/chat/TimelineWorkEntryRow.tsx` and `TimelineRowParts.tsx`):

- **Always:** the icon (or the spinner, or the failure icon), the label, the chevron.
- **On hover or focus:** when the call started, by the clock (`ClockTime`: "16:38", "Yesterday at 16:38"), before
  the chevron, with the full date and time as its title. Hidden, it is out of the flow, so it never costs the label
  width. Focus anywhere in the call shows it, so it is there for the keyboard too.
- **Open:** the arguments and the output.
- **Images:** a call that returned images (`item.images`, such as a browser's screenshot of the page it left) shows
  them under the row, open or not, at most `--hb-tool-image-width` wide, so a person watches the browser move without
  opening anything. Each is a button ("Open full size") that opens the image in a new tab; its alt text says which
  call it came after. `ToolImages({ item, images? })` draws them, for a host that shows a call's images elsewhere.
- **Live browser:** with `Transcript`'s `renderBrowserView`, the newest call on each browser the calls name
  (`item.browserSessionId`) shows that browser's live view in place of its images, and a folded group keeps it in
  view under its summary. The host renders a `BrowserLiveView` with a source, which knows no provider
  (`BrowserLiveSource`): an `embed` page (a watch-only share link, or a browser runtime's own embed page, with the
  message it posts to its parent when its stream is over) or `frames` pushed to it (a screencast, or a recording
  played back, `mode: "replay"`). It is drawn as a browser window (`BrowserWindow`, below) at the column's width
  and the browser's 16 by 10: a tab for the page (its title, else its host, from the newest call's `page`) or the
  host's own tabs (`tabs`), a "Live" (or "Replay") label with "Watch only", and "Open in a new tab" for an embed. An
  embedded view page draws its own address bar and replay controls inside the window, following the page as it
  navigates; otherwise the window's address bar shows `page`. Before the source arrives it shows the last screenshot,
  dimmed, with "Connecting to the live view"; once the source ends (`onEnded`) the host asks again or settles on
  ended, "Closed" over the last screenshot. With no view to have (`unavailable`) it is the screenshot alone in the
  window, as without a live view. An embed is sandboxed and sends no referrer; either kind is unmounted, and a frames
  source unsubscribed, when it scrolls away, so it costs a stream only while on screen.
- **Browser window pieces** (`browser-window.tsx`, stories in Session/Browser window): `BrowserWindow` (tabs, a
  toolbar, the page, a footer), `BrowserTabs` (a tab list, arrow keys between tabs, each tab its page's host
  initial, title or host, a spinner while busy), `BrowserAddressBar` (read-only: a lock for https, the host in full
  colour and the rest quieter, the whole address as its title), `PlayerControls` (play, pause or play again as an
  `IconButton`, a `Scrubber` drawn in Harbour's colours over a range input, the time, and a speed button) and the
  helpers `pageLabel`, `pageHost`, `addressParts` and `playerClock`. The window never fetches anything, not even a
  favicon. Not for a browser a person drives: everything in it is watch-only.
- **Browser in the timeline:** in a host with a panel (`onShowBrowser`), each browser is one `BrowserEntry` card,
  under the browsing run (`BrowsingGroup`) that opened it (`browserEntrySlots`); later runs on the same browser show
  none. The card has the browser's newest page (its title and address, from the calls' `URL:` and `Title:` lines),
  its last screenshot as a thumbnail, "Live", "Replay"
  or "Closed" (the host's `browserStates`, else the calls), and a click that shows it in the panel ("Watch live",
  "Watch the replay"; "Showing" when the panel already does). It never grows while the agent works.

A call shows no duration of its own, running or finished: how long the work took is said once, by the group
("Worked for 8s"), as T3 says it once per turn ("Worked for 22s"). No header says how many steps it holds.

Icons by name, checked in this order: vault (`VaultIcon`); read or view (`EyeIcon`); edit, write or patch
(`PencilIcon`); bash, shell, exec or command (`TerminalIcon`); grep, glob, search or find (`SearchIcon`); fetch, web
or browser (`GlobeIcon`); image, such as `generate_image` (`ImageIcon`); anything else, `FileIcon`.

**Not for** cards that need a decision (approvals, questions), or a summary of many calls (`ToolCallGroup`).

**States:** running (a spinner in place of the icon, the label at full strength so the call happening now is read
first, "Output so far" in the detail); done (the label muted); error (a red `XCircleIcon`, the label at full strength, the output in the error tone under "Error");
interrupted (`MinusCircleIcon` in amber). Open, the detail shows the arguments (a lone `{ command }` as the command
itself, under "Command"; anything else as indented JSON, under "Arguments"; nothing when there are none) and the
output in selectable mono text, scrolling inside a block at most `--hb-tool-output-height` tall; "No output" when
there is none, "Waiting for output" while running.

**A deliberate difference from T3 Code: how a failed call looks.** T3 Code keeps a failed call's own tool icon,
tinted a faint red (`failedToolIconClassName`, `text-tool-error-icon/40`), and leaves its label at the finished
rows' strength; only when the tool brings its own image icon, which cannot be tinted, does it add a small `XIcon` at
the row's end, and only a severe failure turns the icon and label fully red (pingdotgg/t3code at `1152e917`,
`apps/web/src/components/chat/TimelineWorkEntryRow.tsx` lines 344 to 362 and 479 to 483;
`TimelineToolActivityIcon.tsx` lines 30 to 34). Harbour puts a red `XCircleIcon` in the icon slot instead and keeps
the label at full strength. Round 2 of the design loop tried T3's treatment (a red-tinted kind icon, the label
muted, a small red X at the end); all three judges preferred Harbour's, because status then always sits in the icon
slot, as an interrupted call's amber icon does, and a failure is plain at a glance. Tom chose to keep it on 27 Oct
2026. Don't change it to match T3.

**Cards for read, write, edit and bash** (`tool-views.tsx`, its pure model in `tool-views-model.ts`, stories in
Session/Tool cards). These four open as a card made for what they do, instead of the Arguments and Output detail,
which every other tool keeps (and which these fall back to when their arguments aren't what the card expects, such as
a finished edit with no edits in it). They are an entry in the tool renderer registry (`codingToolRenderers`, see
Tool renderers), so a host can replace any of them. `toolView(item)` says which card a call gets, from the coding tools' argument
shapes (`read { path, offset?, limit? }`, `write { path, content }`, `edit { path, edits: [{ oldText, newText }] }`
or the older single `oldText`/`newText`, `bash { command, timeout? }`); the label is the card's own ("Writing
notes/plan.py", "Ran pytest -q").

- **write**: the file in a `CodeView` (`src/code/code-view.tsx`): the path as the header (directory muted, file name
  at full strength), the language by the file's extension, numbered lines, highlighted with the transcript's
  highlighter (`src/code/lines.ts` cuts highlight.js's HTML into lines, so each line is memoised on its own). While
  the model is still writing the call (`item.streaming`, fed by the protocol's `args` delta), the content grows with
  a caret at its end and the window follows the newest line unless the reader has scrolled up. Then the tool's answer
  under it, an error in the error tone.
- **read**: what it returned, in the same code view, numbered from `offset`; the header says the range ("Lines
  41–49") when the read was partial. The harness's "more lines in file" note becomes a footer note, not text in the file. Closed by default: a
  read is context, not a change.
- **edit**: each replacement as a unified diff (`DiffView`, `src/code/diff-view.tsx`, a line diff in
  `src/code/diff.ts`): removed lines on `--hb-diff-del-soft` with a minus, added on `--hb-diff-add-soft` with a
  plus, highlighted; "+3 −2" in the header. Streams as write does.
- **bash**: an inline `Terminal` (`src/code/terminal.tsx`): `$` and the command, typed in as it streams, then the
  output in the terminal's dark well with ANSI colours honoured (`src/code/ansi.ts`: SGR colours and styles kept,
  cursor and title sequences dropped, a carriage return redrawing its line as a progress bar does). Collapsed, it
  shows the last 10 lines, where a command says how it ended. The harness's `<harness>[error] Command exited with
  code 2</harness>` becomes an "Exit 2" badge and a footer note, a timeout "Timed out", an interrupted call
  "Interrupted"; the tags never show in the output.
- **Raw**: each card has a Raw toggle that shows the generic Arguments and Output detail in its place, and a copy
  button for the file, the new text or the command.

Write, edit and bash cards open by default, as their content is the change; long content collapses to a window with
"Show all 240 lines". Highlighting loads with the transcript's highlighter, so code shows plain until it has loaded;
over `HIGHLIGHT_LIMIT` characters it stays plain, and a view renders at most 5,000 lines.

**Keyboard:** the row is a button with `aria-expanded`: Enter or Space opens and closes it. The argument and output
blocks are focusable, so a long output can be scrolled from the keyboard.

**Cost:** memoised on `item`. The detail is rendered only while open. No call has a timer, running or not: the start
time is formatted once per render and never ticks. The spinner is the only animation.

### ToolCallGroup

**For** consecutive tool calls in a turn. `ToolCallGroup({ items, live? })`. While any call is running, or the group
is `live` (it is the last row and the turn may add to it), every call shows as a chip. Once all are finished,
however few, the group collapses to one disclosure, "Worked for 8s" (from the first call's start to the
last call's end; no step count), which expands to the chips. As in T3 Code, which folds a finished turn's work
under "Worked for …" (`MessagesTimeline.logic.ts`), the calls carry no duration of their own, so this summary is
the one place the time is told; collapsing only larger groups would leave a short one with no time at all.

A failed or interrupted call collapses with the rest; the collapsed summary carries an alert mark in the error tone
and nothing more (`StepFailed`: no count, `role="img"` with aria-label and title "A step failed", as T3 Code labels a
failed call's mark "Tool call failed"), so a failure is hidden but never unseen. Expanded, it is in its place among
the others, and the mark goes. A `BrowsingGroup` does the same; its line reads "Browsing" while it runs and "Browsed
for 48s" once done, with no step count either. The last image the group's calls
returned (the page a browser ended on) also stays under the folded summary.

**Not for** calls from different turns: the transcript ends a group at any other item.

**Keyboard:** the summary is a button with `aria-expanded` (the `Disclosure` primitive); each chip is its own
button.

**Cost:** memoised on its props; chips inside are memoised on their items, so one call's output growing renders only
that chip. Collapsed chips are not rendered.

### UserMessage

**For** what the person sent: a right-aligned bubble at most 80% of the column wide, on `--hb-user-message` with
`--hb-radius-bubble`, text pre-wrapped. A small muted caption, "Steered" or "Follow-up", says when the message was
sent while the agent was working (`via` is `steer` or `followUp`). The files sent with it (`item.attachments`) sit
above the bubble as cards on `--hb-raised`: the file type's Lucide icon (`fileTypeIcon`), the name, the type and
size; a message of files alone has no bubble. Under the bubble, on hover or focus, a
`MessageActions` line: when it was sent, Edit from here (when the host gives `MessageActionsContext` an `edit`) and
Copy. `UserMessage({ item, actions?, showActions?, delivery? })`; `actions={false}` leaves the line out (a preview),
`showActions` shows it without a hover (stories). Edit from here turns the bubble into a `MessageEditor`; while the
host sets `editBlocked` (a run is going) the button is off and its label says why. With `delivery` the message is
the host's own copy of one just sent: `sending` looks sent but has no Edit from here; `failed` shows the line
always, with "Couldn't send" and the reason in the error colour, Try again and, when the host can take it back,
Edit in the composer.

**Not for** the agent's words, or quoted text inside an answer.

**Cost:** memoised on `item`. The line is always rendered (transparent until hovered), so it never moves the
transcript; it holds no timer.

### AssistantMessage

**For** the agent's answer, unboxed on the canvas, its text as `Markdown`.
`AssistantMessage({ item, turnStartedAt?, actions?, showActions? })`; `turnStartedAt` is when the answer's turn
started, which `Transcript` passes. With `actions`, a finished answer with text has a `MessageActions` line under it on
hover or focus: Copy, Fork from this response (when the host gives `MessageActionsContext` a `fork`; a spinner while
it runs, and why on the line when it fails) and the time it was generated. `Transcript` turns `actions` on for each
turn's final answer only
(`finalAnswerIds`), as T3 Code shows its message meta only on a turn's terminal answer, so the words an agent says
between tool calls have none, and neither does an answer still streaming.

**States:** while streaming with no text yet, a thought (`item.thinking`) streams live under the live activity row (a
brain and "Thinking", `LiveActivity`), its newest four lines in a window that doesn't grow, after T3 Code's live
reasoning preview (`TimelineWorkGroupRows.tsx:503-581`); once the first word arrives it folds behind a "Thought it
through" disclosure. While streaming with text, a soft caret sits after the last word, and the words flow in at a
steady pace rather than in the bursts they arrive in (`useSmoothText`, `smooth-text.ts`, after claude.ai): what has
arrived is revealed at the backlog over 240ms (at least 120 characters a second), so the text on screen is never more
than a moment behind the model; once the stream ends the rest drains over 90ms. Nothing already on screen is replayed
(a reload, a row scrolled back into view), and under reduced motion the text shows as it arrives. While streaming with no text
and no thought, the activity row alone says the agent is thinking. It is one line as tall as the answer's first line,
so the first word takes its place without the row moving. The turn's timer is the transcript's working header, not
the answer's; `turnStartedAt` is accepted and ignored.

**Not for** host notices (`NoticeRow`) or tool output (`ToolCallChip`).

**Keyboard:** the thought's disclosure is a button with `aria-expanded`. Links in the answer open in a new tab.

**Cost:** memoised on `item`; Markdown re-parses only the last block as text streams, at most once a frame while the
words flow in. The caret and the activity
row's breathing are the only animations, CSS only, and stop under reduced motion.

### WorkingIndicator

**For** a working turn's header, under the person's message: "Working for 12s" in muted `--hb-text-sm` with tabular
numbers on one 24px line, and a hairline divider (`--hb-border-strong`) under it, after T3 Code's working row
(`TimelineWorkGroupRows.tsx:277-309`). It is still: only the timer moves; the activity row at the turn's foot is what
breathes. `WorkingIndicator({ since?, label? })`; `label` defaults to "Working" ("Compacting", say, for another kind
of work).

**States:** with `since`, it counts from it and is a `role="timer"` named after the label, whose implicit `aria-live`
is off: screen readers can read it but are not told every second. Without `since` it says the label alone, as a
`role="status"`, announced once.

**Not for** a session's status in a header or a list (`StatusLabel`), or a control that is busy (a button's own
spinner).

**Cost:** memoised on its props; the timer is an `Elapsed` on the shared one-second clock, so only that leaf renders
each second.

### LiveActivity

**For** what the agent is doing now, at the foot of a working turn: a 16px icon (a brain by default) and a word or
two ("Thinking" by default) in the work log's row shape, so it lines up with the tool calls above it, after T3 Code's
`LiveActivityRow` (`TimelineWorkGroupRows.tsx:383-420`). The words breathe as a skeleton does (`hb-shimmer`,
`--hb-duration-shimmer`) in `--hb-ease-breathe`'s steps. `LiveActivity({ label?, icon? })`. The transcript shows it
between steps and before the first token, and `AssistantMessage` heads a streaming thought with it.

**States:** one. A `role="status"`, announced once, not on every breath. The icon sits on the middle of the words'
capitals (the words are trimmed to them).

**Not for** a tool call that is running (its own row, with its spinner, is the activity).

**Cost:** memoised on its props. The breathing animates opacity alone, which the compositor runs without the main
thread, and stops under reduced motion. Don't animate anything that repaints here (a moving background clipped to the
text did, every frame: a fifth of the main thread at rest without a GPU, and the stream above it stuttered).

### MessageActions

**For** the quiet line under a message, after T3 Code's message meta rows (pingdotgg/t3code at `9826dbb9`,
`apps/web/src/components/chat/TimelineUserMessageRow.tsx` lines 196 to 229 and `TimelineAssistantRows.tsx` lines
144 to 196): the message's time (`ClockTime`: "16:38", "Yesterday at 16:38", the full date and time as its title)
and small ghost icon buttons, Copy on the aligned edge. `MessageActions({ at, text, align, children?, after?, visible?, now? })`.
`align="end"` sits under a person's bubble, the time first; `align="start"` sits under an answer, the actions first,
the first icon pulled left onto the answer's text edge (optical alignment: the icon lines up, not its button's box).
`children` are more actions, beside Copy (before it under a bubble, after it under an answer, so the line reads time,
Edit from here, Copy and Copy, Fork, time as T3 Code's do): `MessageAction({ label, icon, onClick, disabled?, busy? })`,
a 24px ghost `IconButton` whose label is its accessible name and tooltip. `after` follows the time, such as why an
action failed (`.hb-message-actions-error`, which keeps the line shown).

`Transcript({ messageActions })` gives every message the host's `MessageActionHandlers` through
`MessageActionsContext`: `fork(itemId)`, `edit(itemId, text)` and `editBlocked`, the reason Edit from here is off.
Each is optional; an action the host leaves out is not shown. Messages render again only when one changes, so keep
the functions stable.

### MessageEditor

**For** Edit from here: the person's message in place, as a field the column's width on the bubble's surface and
radius, "Sending reruns from here. What came after this message leaves the session." under it, then Cancel and Send.
`MessageEditor({ text, onSend, onCancel, autoFocus? })`. It takes focus with the cursor at the end.

**States:** editing; sending (the field read-only, Send busy, Cancel off); refused (the rejection's message, in the
error colour, in place of the hint, and the words kept to try again).

**Keyboard:** Enter sends and Shift+Enter starts a new line, as in the composer; Escape cancels. The surface shows
the focus ring for the field (`data-focus-surface`).

The time is trimmed to its capitals (`text-box: trim-both cap alphabetic`), as a button's label is, so its figures
sit on the icons' centre line; the alignment gate checks icons against it.

**States:** hidden (transparent, still in the flow, so nothing moves when it shows); shown while its message is
hovered or anything in the line holds focus; always shown under a coarse pointer, where there is no hover (as T3's
`pointer-coarse:opacity-100`); Copy turns to a check and "Copied" for 1.5s. Under a coarse pointer the buttons take
the touch size.

**Not for** a message's primary action, or actions that need the person to read first (use a card).

**Keyboard:** each button is reached by Tab; focusing one shows the line.

**Cost:** no timer and no state but Copy's; the time is formatted once per render.

### NoticeRow

**For** a host notice in the flow of the transcript: a reconnect, a call that may have partly run, a run that
stopped. The `Notice` primitive at the item's level. `NoticeRow({ item })`.

**Not for** anything the person must decide (a card) or the transcript's own error (`Transcript`'s `error`).

**Cost:** memoised on `item`. Note that `Notice` sets `role="status"` or `role="alert"`, so a notice row is announced
when it mounts, which in a virtualised list includes scrolling it back into view.

### Markdown

**For** rendering an answer's Markdown: GitHub flavoured (tables, task lists, strikethrough), raw HTML skipped.
Paragraphs and lists at the body size, headings small (none larger than `--hb-text-lg`), inline code and fenced code
in the mono font on `--hb-code`, code blocks scrolling sideways rather than squeezing, links in
`--hb-accent-text`. Long unbroken words and links wrap. Tables are set as Claude sets them (`MarkdownTable`): as wide
as the prose with no box, fill or vertical rules, the first column flush with the text, a bold header in the text
colour over a stronger rule and a hairline under each row; cells wrap, and the table scrolls sideways in its own box
only when its columns can't fit. A document's page and its editor use the same rules. `Markdown({ text, className? })`; `splitBlocks(text)` is the
splitter it uses.

**Not for** text the person typed (it is shown as typed, in `UserMessage`) or tool output (shown verbatim).

**Cost:** the text is split into top-level blocks at blank lines outside code fences, each a memoised component
keyed by position. As an answer streams, only the last block is parsed and rendered again. A construct that spans a
blank line (a loose list, a reference link defined later) is parsed per block; lists still render as lists.
