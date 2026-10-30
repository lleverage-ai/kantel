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
`onRowRender(id, phase)` (`phase` is `"mount"` or `"update"`), `dock`, `className`.

`dock` floats a node, usually a `Composer`, over the transcript's foot, as T3 Code's thread does: the list scrolls
under its glass, and the end of the list makes room for it (its measured height plus 16px). A docked `Composer`
rests (folds to one line) while the reader scrolls back and comes back at the end; files dropped anywhere on the
transcript go to it. See [session-composer.md](session-composer.md#docked-in-a-transcript).

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

### groupTranscript

**For** turning transcript items into rows: `groupTranscript(items, previous?)` returns
`{ kind: "item"; id; item }` for every item that is not a tool call and `{ kind: "tools"; id; items; live }` for
each run of consecutive tool calls. Any other item ends a run. A group's `id` is its first call's id, so its key is
stable as calls join it; a single call is still a group of one, for the same reason. Only a group that is the last
row is `live`.

Pass the previous result as `previous`: every row whose items are unchanged (by identity) is the same object as
before, and when nothing changed the previous array itself comes back. This is what lets memoised rows skip
rendering while an answer streams.

**Not for** grouping by run or attempt: the protocol does not carry them yet, so every run of calls between two
other items is one group.

**Cost:** one pass over the items and a map of the previous rows by id, per change to `items`.

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
- **Browser in the timeline:** a browsing run (`BrowsingGroup`) in a host with a panel (`onShowBrowser`) carries its
  browser as a `BrowserEntry` card under its line: the page the run left it on (`browsingPage`: its title and
  address, from the calls' `URL:` and `Title:` lines), the run's last screenshot as a thumbnail, "Live", "Replay"
  or "Closed" (the host's `browserStates`, else the calls), and a click that shows it in the panel ("Watch live",
  "Watch the replay"; "Showing" when the panel already does). It never grows while the agent works.

A call shows no duration of its own, running or finished: how long the work took is said once, by the group
("Worked for 8s, 4 steps"), as T3 says it once per turn ("Worked for 22s").

Icons by name, checked in this order: vault (`VaultIcon`); read or view (`EyeIcon`); edit, write or patch
(`PencilIcon`); bash, shell, exec or command (`TerminalIcon`); grep, glob, search or find (`SearchIcon`); fetch, web
or browser (`GlobeIcon`); anything else, `FileIcon`.

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

**Keyboard:** the row is a button with `aria-expanded`: Enter or Space opens and closes it. The argument and output
blocks are focusable, so a long output can be scrolled from the keyboard.

**Cost:** memoised on `item`. The detail is rendered only while open. No call has a timer, running or not: the start
time is formatted once per render and never ticks. The spinner is the only animation.

### ToolCallGroup

**For** consecutive tool calls in a turn. `ToolCallGroup({ items, live? })`. While any call is running, or the group
is `live` (it is the last row and the turn may add to it), every call shows as a chip. Once all are finished,
however few, the group collapses to one disclosure, "Worked for 8s, 4 steps" (from the first call's start to the
last call's end; "1 step" for one), which expands to the chips. As in T3 Code, which folds a finished turn's work
under "Worked for …" (`MessagesTimeline.logic.ts`), the calls carry no duration of their own, so this summary is
the one place the time is told; collapsing only larger groups would leave a short one with no time at all.

A failed or interrupted call stays visible while the group is collapsed: it is shown under the summary, so a failure
is never hidden behind "Worked for". Expanded, it is in its place among the others. The last image the group's calls
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
Copy. `UserMessage({ item, actions?, showActions? })`; `actions={false}` leaves the line out (a preview),
`showActions` shows it without a hover (stories). Edit from here turns the bubble into a `MessageEditor`; while the
host sets `editBlocked` (a run is going) the button is off and its label says why.

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
through" disclosure. While streaming with text, a soft caret sits after the last word. While streaming with no text
and no thought, the activity row alone says the agent is thinking. It is one line as tall as the answer's first line,
so the first word takes its place without the row moving. The turn's timer is the transcript's working header, not
the answer's; `turnStartedAt` is accepted and ignored.

**Not for** host notices (`NoticeRow`) or tool output (`ToolCallChip`).

**Keyboard:** the thought's disclosure is a button with `aria-expanded`. Links in the answer open in a new tab.

**Cost:** memoised on `item`; Markdown re-parses only the last block as text streams. The caret and the activity
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
in the mono font on `--hb-code`, code blocks and tables scrolling sideways rather than squeezing, links in
`--hb-accent-text`. Long unbroken words and links wrap. `Markdown({ text, className? })`; `splitBlocks(text)` is the
splitter it uses.

**Not for** text the person typed (it is shown as typed, in `UserMessage`) or tool output (shown verbatim).

**Cost:** the text is split into top-level blocks at blank lines outside code fences, each a memoised component
keyed by position. As an answer streams, only the last block is parsed and rendered again. A construct that spans a
blank line (a loose list, a reference link defined later) is parsed per block; lists still render as lists.
