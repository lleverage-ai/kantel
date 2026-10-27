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
`onRowRender(id, phase)` (`phase` is `"mount"` or `"update"`), `className`.

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
- Cards render through `renderCard`, with the host's handlers. Without it they show read-only, from the same
  components: a vault request's terms and binding code, a question and its options, a browser request's reason,
  each waiting with nothing to press. A card is never reduced to its type.

Key the transcript by session. A different session's items would otherwise look like older history put in front.

**Keyboard:** the list is focusable (Tab), so arrow keys, Page Up and Page Down scroll it; every row's controls
(tool calls, thoughts, groups) are buttons reached by Tab. "Scroll to end" is a real button.

**Cost:** only the rows near the viewport are mounted (a 600px buffer each way), whatever the session's length.
Rows come from `groupTranscript` and are memoised on their row object, so while one answer streams only its row
renders. `renderCard` is a row prop: pass a stable function, or every row renders when it changes. `onRowRender` is
read through a ref and never causes a render; `apps/console` feeds it to its `?profile=1` panel. One `ResizeObserver`
on the list's content and its viewport keeps the end in view while following, including when the viewport is
resized (a phone's keyboard opening).

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
is never hidden behind "Worked for". Expanded, it is in its place among the others.

**Not for** calls from different turns: the transcript ends a group at any other item.

**Keyboard:** the summary is a button with `aria-expanded` (the `Disclosure` primitive); each chip is its own
button.

**Cost:** memoised on its props; chips inside are memoised on their items, so one call's output growing renders only
that chip. Collapsed chips are not rendered.

### UserMessage

**For** what the person sent: a right-aligned bubble at most 80% of the column wide, on `--hb-user-message` with
`--hb-radius-bubble`, text pre-wrapped. A small muted caption, "Steered" or "Follow-up", says when the message was
sent while the agent was working (`via` is `steer` or `followUp`). `UserMessage({ item })`.

**Not for** the agent's words, or quoted text inside an answer.

**Cost:** memoised on `item`.

### AssistantMessage

**For** the agent's answer, unboxed on the canvas, its text as `Markdown`. `AssistantMessage({ item })`.

**States:** a thought (`item.thinking`) sits behind a disclosure, "Thinking" while streaming with no text yet and
"Thought it through" after. While streaming with text, a soft caret sits after the last word. While streaming with
no text and no thought, three dots (`role="img"`, "Working") say the agent is working.

**Not for** host notices (`NoticeRow`) or tool output (`ToolCallChip`).

**Keyboard:** the thought's disclosure is a button with `aria-expanded`. Links in the answer open in a new tab.

**Cost:** memoised on `item`; Markdown re-parses only the last block as text streams. The caret and the dots are the
only animations, CSS only, and stop under reduced motion (the caret stays, still).

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
