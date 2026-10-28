# Session: composer, cards, header and diff stat

What each component is for, when not to use it, its states, its keyboard behaviour and what it costs. Stories are in
the workbench under Session/Composer, Session/Question and browser cards, and Session/Header.

### Composer

**For** the message box at the foot of a session, after T3 Code's composer: a frosted-glass surface in the
transcript's column (`--hb-content-width`), a field that grows with its text and then scrolls, attachments above the
field and a toolbar below it, with the model picker on the left and the paperclip and one round primary action on
the right. Docked in a `Transcript` it floats over the transcript's foot and rests (folds to one line) while the
reader scrolls back. Questions and approvals dock on its top edge through `banner`, in a tray that shares its glass,
instead of opening a modal.

```tsx
const uploads = useComposerAttachments(uploadToHost);

<Transcript
	items={items}
	dock={
		<Composer
			state={running ? "running" : "idle"}
			onSend={(text) => send(text, uploads.take())}
			onSteer={(text) => steer(text, uploads.take())}
			onStop={stop}
			models={catalogue}
			model={modelId}
			onModelChange={setModelId}
			thinking={level}
			defaultThinking={profileLevel}
			onThinkingChange={setLevel}
			attachments={uploads.attachments}
			onAttach={uploads.attach}
			onRemoveAttachment={uploads.remove}
			onRetryAttachment={uploads.retry}
			attachmentLimits={{ maxFiles: 10, maxFileBytes: 20 * 1024 * 1024, maxImageBytes: 5 * 1024 * 1024 }}
			history={sentMessages}
			banner={pendingQuestion ? <QuestionCard card={pendingQuestion} onAnswer={answer} /> : undefined}
			captureTyping
		/>
	}
/>
```

**Props**

- Draft: `value` and `onChange` for a controlled draft, or `defaultValue` for an uncontrolled one, which clears itself
  after sending. `placeholder` defaults to "Ask anything"; `label` (the field's accessible name) to "Message".
  `autoFocus` focuses the field once it can be typed in.
- Actions: `onSend(text, attachments)` gets the draft trimmed and the attachments that are `ready`; `onSteer(text,
  attachments)` gets them while the agent runs (without it, `onSend` does); `onStop()` stops the run. Existing
  `onSend(text)` callers keep working: the second argument is extra. The host takes the attachments out of the draft
  (`useComposerAttachments().take()` does).
- `state`: `idle`, `running`, `sending` or `disabled`; `disabledReason` says why in the surface.
- `banner` docks on the top edge; `footer` goes in the toolbar after the model picker (`ComposerSendHint`, or the
  host's own controls).
- Models: `models` (the host's catalogue, `ComposerModelOption[]`), `model` (the chosen id) and `onModelChange`.
  Without `models` and `onModelChange` there is no picker.
- Thinking: `thinking` (the chosen level), `defaultThinking` (the session's level when nobody chose one, marked
  Default) and `onThinkingChange`. The levels come from the chosen model's `capabilities.thinking`; a model without
  any but `off`, or no `onThinkingChange`, has no thinking picker. With a picker the model's button drops its
  chevron, so the level reads on from the name ("Claude Sonnet 4.5 High"), as T3 Code's does.
- Attachments: `attachments` (what the host reports, `ComposerAttachment[]`), `onAttach(files, source)`,
  `onRemoveAttachment(id)`, `onRetryAttachment(id)`, `attachmentLimits` and `pasteFold`. Without `onAttach` the
  composer takes no files: no paperclip, no drop, no file paste.
- `history`: messages sent before, oldest first, for Up and Down recall.
- `captureTyping`: typing or pasting anywhere on the page outside another field goes into the composer, as in T3
  Code. Leave it off where the page has other keyboard uses.
- `resting`: `true` or `false` overrides the dock and the narrow-screen rule; left out, the composer decides.

**Not for** single-line inputs in forms (use `TextField`), or for answering a question (the `QuestionCard` has its
own field; the composer beside it is for telling the agent something else).

**States**, from `state`, the draft and the attachments (`primaryAction()` in `composer-model.ts` decides):

| `state` | Draft | Primary action |
| --- | --- | --- |
| `idle` | text or a ready attachment | Send (accent, "Send") |
| `idle` | empty, or blocked | Send, disabled |
| `running` | text or a ready attachment | Steer (accent, "Steer"): calls `onSteer`, else `onSend` |
| `running` | empty | Stop (solid red, "Stop"): calls `onStop`; disabled without it |
| `sending` | any | A spinner ("Sending"), not clickable |
| `disabled` | any | Send, disabled; `disabledReason` shows in the surface in muted text. With a reason and no draft the field folds away, so the composer is one line; a draft always stays visible |

A draft is *blocked*, and Send disabled with the reason as its tooltip and description, while an attachment is
uploading, while one has failed, or while there is an image and the chosen model's `capabilities.images` is `false`.

**Size.** The surface has a 16px radius, a near-invisible outline with a one-pixel top highlight, and frosted glass
(`--hb-glass`, 16px blur) over the transcript. The field grows from about two lines to 200px
(`--hb-composer-field-max`, about nine lines) and then scrolls inside the surface; the toolbar stays put. At
1280px, docked, the expanded composer is 736 by 114px and the resting one 736 by 50px, as T3 Code's are. Where the
browser supports `field-sizing: content` (Chromium 123 and later) CSS sizes the field and nothing is measured;
elsewhere one layout effect sets its height from `scrollHeight`. Type is 14px, 16px under a coarse pointer so iOS
doesn't zoom; the action is 32px, 36px under a coarse pointer.

#### Docked in a transcript

Pass the composer as a `Transcript`'s `dock`. It then:

- **Rests** while the reader scrolls back: one 50px line with the draft's first line (or the placeholder), small
  thumbnails of any attachments, the paperclip and the action; the model picker moves into a strip tucked under the
  glass. Focus anywhere in it, reaching the end of the list, or "Scroll to end" brings it back. It never rests while
  focused, with a draft of more than one line, with a banner, with the picker open, while files are dragged over,
  while disabled, or while something needs action (a failed upload, an image the model can't read, a file turned
  away).
- **Rests on a narrow screen** (below 640px) whenever it isn't in use, docked or not, as T3 Code's does on a phone.
- **Takes drops** anywhere on the transcript, which shows a dashed frame with "Drop files to attach" and the limits.

The controls stay in one place in the DOM in both states and are only moved visually, so Tab order and focus are the
same whether it rests or not.

#### Attachments

The library never uploads. The composer checks files against `attachmentLimits` (`maxFiles`, counting those already
in the draft; `maxFileBytes`; `maxImageBytes`, when images have a lower limit; `accept`, MIME types, wildcards or
extensions, also passed to the file picker), hands those that pass to `onAttach`, and says in one sentence in the
surface why any were turned away ("notes.heic isn't a type this session takes."). The paperclip's tooltip gives the
limits.

**Sizes are in bytes and shown in binary units.** `maxFileBytes` and `maxImageBytes` are byte counts, and the
composer shows them, in the paperclip's tooltip, the drop frame and the turned-away message, with the library's
`formatBytes`, where 1 KB is 1,024 bytes and 1 MB is 1,048,576. To show "5 MB", pass `5 * 1024 * 1024`. A decimal
limit shows as an odd number: `5_000_000` reads "4.8 MB", and `20_000_000` reads "19 MB".

The host reports each file back in `attachments`:

```ts
type ComposerAttachment = {
	id: string;
	name: string;
	size: number;
	type: string;
	kind: "image" | "file" | "text"; // text: a folded paste
	previewUrl?: string; // an image's thumbnail
	status: "uploading" | "ready" | "failed";
	progress?: number; // 0 to 1; without it, a spinner
	error?: string; // why it failed, in the item's tooltip
};
```

Images (PNG, JPEG, GIF, WebP) show as 64px thumbnails; other files and pasted text as chips with their size. Each has
a Remove button; a failed one turns red and has Retry when `onRetryAttachment` is given.

`useComposerAttachments(upload)` keeps all of this for a host that has an upload function and nothing else:
`upload(file, { progress, signal, source })` resolves with whatever the host needs to send the file later. It starts
an upload per file, reports progress (re-rendering only when the percentage changes), aborts on remove, retries,
makes and frees object URLs for thumbnails, and `take()` hands over the ready attachments with their results.

**Paste.** Files on the clipboard (a screenshot) become attachments. Text of 32 KiB or 80 lines or more (T3 Code folds
at 32 KiB) becomes `pasted-text.txt`, then `pasted-text-2.txt` and on, instead of flooding the field;
Ctrl+Shift+V (Cmd+Shift+V) pastes it into the field anyway. `pasteFold` changes the thresholds; `false` turns folding
off.

#### Model picker

`ModelPicker` is the composer's, and exported for hosts that put it elsewhere. A ghost button with the chosen model's
label opens a popover upward: a search field, then the catalogue grouped by provider, each with its description, a
"Default" mark, an image icon when it reads images and a tick on the chosen one. A model with `disabledReason` shows
dimmed with the reason and can't be chosen. `selectedModel(models, id)` falls back to the default, then the first
enabled model; `filterModels(models, query)` matches every word against the label, provider, description and id.

```ts
type ComposerModelOption = {
	id: string;
	label: string;
	provider?: string;
	description?: string;
	capabilities?: { images?: boolean; thinking?: ThinkingLevel[] };
	default?: boolean;
	disabledReason?: string;
};
```

The composer passes `chevron={false}` when a thinking picker follows the button; a host showing `ModelPicker` alone
leaves it on.

#### Thinking picker

`ThinkingPicker` is the composer's, after T3 Code's traits picker, and exported for hosts that put it elsewhere. A
quiet word after the model's name ("Medium") opens a short menu upward headed Thinking: the levels the model supports,
in order, with the default marked "Default" and a tick on the chosen one. Up and Down move, Home and End jump, Enter or
Space chooses and returns focus to the field, Escape closes back to the button, and Up or Down on the button opens it.
It renders nothing for a model that can't think.

The levels are pi's, and Harbour's model gateway's: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, read
Off, Minimal, Low, Medium, High, Extra high and Max (`THINKING_LABELS`). The helpers in `thinking-model.ts` are the
rules, pure and tested:

- `offeredLevels(levels)`: a model's levels in order, unknown values dropped; empty for a model that can't think.
- `clampThinking(levels, level)`: the level itself when the model has it, else the nearest above, else the nearest
  below, as pi's `clampThinkingLevel` does. Switching from a model with Max to one without shows (and sends) its
  nearest level, and switching back shows Max again, because the composer keeps the chosen level, not the clamped one.
- `chosenThinking(levels, value, fallback)`: what the button shows; `stepThinking(levels, current, ±1)` cycles, for a
  host's shortcut.

**Sizes.** The button is the model button's height (28px, 24px in the resting strip) and type (14px, 12px resting),
in `--hb-text-faint` until hovered or open; it pulls back by the toolbar's gap so the two words sit one model-button
padding apart. The menu is `--hb-menu-width` (12rem) wide, rows 32px. Both words are trimmed to their capitals and
centred, so the level and the model's name share a baseline; `loop/gates.ts` holds the level, each row's name, tick and
"Default" to their text within 1px.

**Not for** settings that aren't the model's (permissions, the project): give those their own control in `footer`.

**Cost:** one button; the menu mounts only while open.

#### Project picker

`ProjectPicker` is the model picker's button and searchable list for projects, with a folder icon: which project a new
session starts in, for the composer's `footer` on a new-session page, as T3 Code puts the project beside a new thread.
Each `ProjectOption` has an `id`, a `label`, an optional `description`, and a `disabledReason` for a project the
person can't start a session in (a viewer's), shown dimmed with the reason and not chosen. Not for switching the
project a running session is in: a session stays in the project it started in.

**Keyboard**

- Enter sends, or steers while the agent runs. Shift+Enter is a new line (`shouldSend()`).
- Enter while an IME is composing confirms the composition and never sends.
- Under a coarse pointer plain Enter is a new line, as T3 Code does for software keyboards; the button sends.
  Ctrl+Enter or Cmd+Enter sends with any pointer.
- Up in an empty field recalls the last message in `history`; Up again, with the caret on the first line, goes
  further back; Down on the last line goes forward, and past the newest returns to an empty draft (`recall()`). A
  draft you typed, a selection, a modifier or attachments turn it off.
- The model picker: Enter, Space, Up or Down opens it with focus in the search field; Up and Down move through
  enabled models (the search field keeps focus, with `aria-activedescendant`), Home and End jump while the search is
  empty, Enter chooses and returns focus to the composer's field, Escape closes and returns focus to the picker's
  button, Tab closes and moves on.
- Escape is otherwise not bound: it belongs to whatever overlay is open.
- After sending, focus stays in the field. After Stop, focus returns to the field.
- Tab order: the attachments' Retry and Remove buttons, the field, the model picker, the footer, the paperclip, the
  primary action.

Focus in the field shows as a one-hairline accent edge on the whole surface (the field sits in a declared
`data-focus-surface`), not a ring round the box you are typing in; every button has the library's focus ring.
Rejections and attachment changes are announced through a polite live region.

**Alignment:** the composer follows the library's two rules (see components.md). Words in a fixed-height box (the
model picker's button, each model's name, the attachment chips' names and sizes, the resting "+2", the disabled
reason beside the action) are trimmed to
their capitals with `text-box: trim-both cap alphabetic` and centred, as `Button`'s label is; icons beside a line of
words (the notes' icons, the search field's magnifier) sit on its baseline and move up by `--hb-on-cap`, as
`Notice`'s do. A model row's image icon and tick centre on the model's name, not the row, so a description below
doesn't pull them down. A field's text can't be trimmed, so the resting one-line field measures its font with canvas
(once, again when web fonts load) and moves down by `--hb-composer-nudge`, the gap between the middle of its line and
the middle of its capitals, so its words sit level with the action button. `loop/gates.ts` fails any of these more
than 1px off, at 1280px and 420px.

**Cost:** with `field-sizing` support, none per keystroke beyond React's; otherwise one layout effect per change of
the draft (one reflow). One `matchMedia` listener for the pointer type and one `ResizeObserver` for the composer's
width. Uploads re-render only when a shown percentage changes. No timers, and no animation except spinners.

### ComposerSendHint

**For** the composer's footer: "Enter to send" with a `Kbd`. Hidden under a coarse pointer, where Enter is a new line.

### QuestionCard

**For** a question from the agent (`QuestionCard` from `@harbour/protocol`), answered in place, in the transcript
or in the composer's `banner`. Props: `card`, `onAnswer(answer)` (the chosen option or the typed text, trimmed) and
`busy` while the answer is on its way.

**Not for** approvals of secrets or grants (use the vault approval card), or for anything the agent hasn't asked.

**States:**

- **Open:** the question beside a `QuestionIcon` in the waiting colour; its options as a radio group of real radio
  inputs with labels, numbered 1, 2, 3 in muted text; an "Other" field; Answer, enabled once an option is chosen or
  something is typed. Whichever you touched last is sent: typing in Other clears the chosen option.
- **Open, no options:** just the field, labelled "Your answer".
- **Busy:** Answer shows a spinner and does nothing more.
- **Answered:** one quiet line, a tick in the done colour and "You answered: ..." with the question on hover.
- **Withdrawn:** one quiet line, "The agent withdrew this question".

**Keyboard:** Tab reaches the chosen radio (or the first), arrow keys move between options, as native radios do.
Digits 1 to 9 pick an option while focus is anywhere in the card except a text field. Enter in the field sends the
answer.

**Cost:** memoised on its props. Settled cards render one line and no form.

### BrowserGrantCard

**For** the agent asking to use a browser (`BrowserGrantCard` from `@harbour/protocol`): a `GlobeIcon`, "Wants to use
a browser", the agent's reason, Decline (secondary) and Allow (primary). Props: `card`, `onGrant`, `onDeny`, `busy`.

**Not for** vault grants, which need the binding code and terms.

**States:** pending (the panel in the approval tone); busy (the pressed button shows a spinner, the other is
blocked); granted ("Browser access allowed") and denied ("Browser access declined"), each one quiet line with the
reason on hover.

**Keyboard:** Tab reaches Decline, then Allow; Enter or Space presses them. No shortcuts: deciding should be
deliberate.

**Cost:** memoised on its props.

### SessionHeader

**For** the bar at the top of a session view: an optional Back button (a mirrored chevron, labelled "Back"), the
status in words (`StatusLabel`), the title (16px, medium, truncated with the whole title on hover; "New session" when
empty; a skeleton while `loading`), `meta` (the project, the branch, a `DiffStat`, "Working for" an `Elapsed`),
`ConnectionState`, then `actions`. One compact row with a hairline under it. On a phone (640px and narrower) the
meta moves to a second line so the title keeps its room.

Props: `title`, `status` (a `Status` from tokens.ts), `connection`, `meta`, `actions`, `onBack`, `loading`. The
title is an `h1`: the session is the page.

**Not for** page headers elsewhere (the vault, the inbox), or for the session list's rows (use `SessionListItem`).
Put separate facts in `meta` as separate elements, never a middle-dot string.

**Keyboard:** Back and the actions are ordinary buttons, in reading order.

**Cost:** none of its own. `ConnectionState` subscribes to the shared clock only while offline.

### ConnectionState

**For** the link to the session host, said only when it matters. `connection` is `{ state: "open" }`,
`{ state: "connecting" }` or `{ state: "offline"; retryAt }`.

- **Open:** nothing on screen (a healthy link isn't news); screen readers hear "Connected".
- **Connecting:** a small spinner and "Connecting".
- **Offline:** "Offline, retrying in 4s" in the error colour, counting down, then "Reconnecting" once the retry is
  due. Screen readers hear "Offline, retrying soon" once rather than a number every second.

It is a polite live region, so a change of state is announced.

**Cost:** while offline it re-renders once a second on the page's one shared clock (`useNow(1000)`); otherwise it
costs nothing. The spinner turns only while connecting.

### DiffStat

**For** lines added and removed: "+12" in `--hb-diff-add` and "−12" (a true minus sign, U+2212) in
`--hb-diff-del`, in monospace, as T3 Code's diff stats. Screen readers hear "12 lines added, 3 removed".

**Not for** counts that aren't lines of a diff.

**Cost:** none beyond the elements.
