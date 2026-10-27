# Session: composer, cards, header and diff stat

What each component is for, when not to use it, its states, its keyboard behaviour and what it costs. Stories are in
the workbench under Session/Composer, Session/Question and browser cards, and Session/Header.

### Composer

**For** the message box at the foot of a session: one raised surface in the transcript's column
(`--hb-content-width`), an autosizing field and one round primary action at the bottom right, after T3 Code's
composer. Approvals and questions attach above it through `banner` (T3 Code attaches them to the composer instead of
opening a modal); hints such as `ComposerSendHint` go in `footer`, at the bottom left.

```tsx
<Composer
	state={running ? "running" : "idle"}
	onSend={send}
	onSteer={steer}
	onStop={stop}
	banner={pendingQuestion ? <QuestionCard card={pendingQuestion} onAnswer={answer} /> : undefined}
	footer={<ComposerSendHint />}
/>
```

Props: `value` and `onChange` for a controlled draft, or `defaultValue` for an uncontrolled one, which clears itself
after sending. `onSend(text)` gets the draft trimmed; `onSteer(text)` gets it while the agent runs (without it,
`onSend` does); `onStop()` stops the run. `placeholder` defaults to "Ask anything"; `label` (the field's accessible
name) to "Message". `autoFocus` focuses the field on mount.

**Not for** single-line inputs in forms (use `TextField`), or for answering a question (the `QuestionCard` has its
own field; the composer beside it is for telling the agent something else).

**States**, from `state` and the draft (`primaryAction()` in `composer-model.ts` decides):

| `state` | Draft | Primary action |
| --- | --- | --- |
| `idle` | text | Send (primary, "Send") |
| `idle` | empty | Send, disabled |
| `running` | text | Steer (primary, "Steer"): calls `onSteer`, else `onSend` |
| `running` | empty | Stop (danger, "Stop"): calls `onStop`; disabled without it |
| `sending` | any | A spinner ("Sending"), not clickable |
| `disabled` | any | Send, disabled; `disabledReason` shows in the surface in muted text. With a reason and no draft the field folds away, so the composer is one line; a draft always stays visible |

The field grows from about 48px to about 208px with its text, then scrolls. Type is 14px, and 16px under a coarse
pointer so iOS doesn't zoom; the button is 32px, 36px under a coarse pointer.

**Keyboard** (`shouldSend()` in `composer-model.ts`):

- Enter sends, or steers while the agent runs. Shift+Enter is a new line.
- Enter while an IME is composing (Japanese, Chinese, Korean input) confirms the composition and never sends.
- Under a coarse pointer plain Enter is a new line, as T3 Code does for software keyboards; the button sends.
  Ctrl+Enter or Cmd+Enter sends with any pointer, for a hardware keyboard on a tablet.
- Escape is not bound: it belongs to whatever overlay is open.
- After sending, focus stays in the field. After Stop, focus returns to the field.
- Tab reaches the field, then whatever is in the footer, then the primary action.

Focus in the field is shown by the caret and a brighter hairline on the surface, not a ring round the box you are
typing in; the button has the library's focus ring.

**Cost:** one layout effect per change of the draft, which sets the field's height from its scrollHeight (one
reflow). One `matchMedia` listener for the pointer type, shared by nothing else. No timers and no animation except
the spinner while sending.

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
