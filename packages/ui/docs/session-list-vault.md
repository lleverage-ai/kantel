# Session list and vault approval card

What each component is for, when not to use it, its states, its keyboard behaviour and what it costs. Stories are in
the workbench under "Session/Session list" and "Session/Vault approval card". All of it lives in `src/session/`.

## Session list

### sessionStatus, attentionGroup and groupSessions

Pure functions in `session-model.ts`, after T3 Code's status priority (`apps/web/src/components/Sidebar.logic.ts:871-898`).

- `sessionStatus(summary)` is the status a row shows: waiting on approval is `approval`, any other wait is `waiting`
  (needs your answer), running is `working`, failed is `error`, done and unread is `done`. A settled session you have
  already seen (done and read, idle, cancelled) has no status (`undefined`): its row shows only its time. As in
  T3 Code, the emerald Done is only for completions you haven't seen.
- `attentionGroup(summary)` is `needs-you` for waiting sessions, `working` for running ones and `done` for the rest,
  failed included.
- `groupSessions(list)` returns the groups in the order Needs you, Working, Done, each newest first by `updatedAt`,
  leaving out empty groups. It doesn't change its input.

`SessionSummary` is re-exported from `session-model.ts`; it lives in `fixtures.ts` until the list API arrives.

### SessionListItem

**For** one session in a list: the console's sidebar, the inbox, search results. Built on `ListRow`.

- Needs you and working sessions are `comfortable`, three lines after T3 Code's sidebar cards: the project and the
  branch as separate elements (the branch in mono, separated by a gap, never a dot) with the status in words at the
  right end of that line, the title on its own line across the row's full width, and for a working session the time
  it has been working (`Elapsed`). Nothing sits beside the title; when space is short the project and branch
  truncate before the status does.
- Settled sessions are `compact`, one line. Seen ones are quiet with their time at the right (`RelativeTime`: "4m",
  "3h", never "ago"). An unseen completion shows an emerald Done; a failed one shows Failed in red, and neither is
  quiet.

Props: `session`, `selected`, `href` (a link; wins over `onSelect`), `onSelect(id)` (a button), `actions` (shown in
place of the status or time on hover or focus, as T3 Code swaps in "Settle"). On a three-line row the actions float
at the top right over the status, which keeps its width, so nothing reflows; keep them about as small as the status
(one extra-small button).

**Not for** anything that isn't a session; use `ListRow` directly.

**Keyboard:** each row is one Tab stop, activated with Enter (and Space, as a button). Actions follow the row in Tab
order and appear when the row has focus. There is no arrow-key roving between rows, as in T3 Code.

**Cost:** memoised on its props, and `onSelect` is wrapped in a stable callback per id, so a list re-render doesn't
re-render rows. A working row's elapsed time and a settled row's age read the page's one shared clock (one interval
for every row, not one each); ages stop ticking once a day old.

### SessionList

**For** the list of a person's sessions: a `nav` landmark labelled "Sessions", grouped as Needs you, Working and Done
by default, each group headed by a small muted heading with its count ("Needs you" "2").

Props: `sessions`, `selectedId`, `onSelect(id)`, `hrefFor(id)`, `loading`, `error`, `empty`, `grouped` (default true).

**States:**

- Loading: five placeholder rows while there are no sessions yet. With sessions already shown, `loading` keeps them
  rather than flashing placeholders.
- Empty: "No sessions yet", "Start one from the composer or a schedule." Pass `empty` to say something else (a
  filtered view with no matches).
- Error: an error notice. With known sessions it sits above them, so a dropped connection doesn't blank the list.
- Ungrouped (`grouped={false}`): no headings, in the order given, for search results or a filter.

**Not for** a long, scrolling archive of thousands of sessions: it renders every row. Page or virtualise above it.

**Keyboard:** Tab moves through the rows in order; group headings are `h3`s for screen reader navigation.

**Cost:** grouping is memoised on the `sessions` array. A streaming update that replaces one session object
re-renders that row only, provided the other session objects keep their identity and `onSelect` and `hrefFor` are
stable.

## Vault approval card

### VaultApprovalCard

**For** the card a session shows when its agent asks the vault for a secret or a route (Harbour issue #7). It names
what is needed and why, says the agent never sees the value, shows the terms (host, methods, path prefix, injection
template, lifetime) under one quiet line saying whose they are ("Proposed by the agent" or "Approved on the vault
page"), the binding code, Open in vault and Copy link, and that the agent carries on when you're done. How long is
left is said once, in the Lifetime term ("15 minutes left"), which turns amber with under two minutes left; there is
no separate countdown.
The protocol gives one `termsSource` for every term on a card, so the source is said once rather than as a badge on
each row: five identical amber badges read as five warnings and compete with the binding code.

Props: `card` (the protocol's `VaultApprovalCard`), `now` (a fixed time for stories and screenshots), `onAskAgain`
(offers "Ask for a new link" when expired), `requester` (adds a "Requested by" term).

**States:**

- Pending: the full card, in the approval colour. The header has the vault mark, "Needs approval" (and "Route grant"
  for a request with no injection template) and the vault's host from the link.
- Approved: one quiet row, "Approved: what on host", the binding code small at the right, and Terms, which shows the
  approved terms on demand.
- Approved and narrowed: looks the same as approved. The approver may narrow the agent's proposal on the vault page;
  the card then carries the terms that were approved (`termsSource: "approved"`), so Terms shows the narrowed terms
  under "Approved on the vault page". The card doesn't show what was proposed before.
- Route grant: a request with no injection template. The Injection term says nothing is injected; "Any method" when
  the methods are empty or `*`.
- Denied: one row in the error colour. Withdrawn: one quiet row.
- Expired: one compact row, "This request expired before anyone approved it.", and "Ask for a new link" when
  `onAskAgain` is given. A pending card whose lifetime runs out shows this too, without waiting for the server.
- Revoked is not a card state: revoking is something done to a grant on the vault page, after the card has settled
  as approved. The card stays as it was.

**The binding code rule.** The binding code is always shown, on the card and on the vault page, and they must match.
For writes (any method other than GET, HEAD or OPTIONS, including any method), route grants and secret pastes, the
vault page has the approver pick the code that matches the card (`BindingCodePicker`) before Approve or Paste is
enabled; the server checks the pick. Reads only display the code. `mustPickCode()` in `vault-model.ts` says which
applies.

**Not for** other approvals (use the composer's approval banner) or questions (`QuestionCard`). It never shows a
secret's value: the protocol doesn't carry one.

**Keyboard:** in a pending card, Tab reaches Copy code, Open in vault (a link, opening the vault page in a new tab),
Copy link and nothing else; the Lifetime term is not a live region, so it doesn't talk as it changes.
A settled approved card has one stop, Terms, a disclosure button with `aria-expanded`.

**Narrow:** under 480px the actions stack at full width and the code and host wrap.

**Cost:** the card is memoised and holds no clock: it re-renders when its props change and once more when a pending
request runs out, from a single timeout set for `expiresAt` (cleared on unmount or when the expiry or status
changes), which folds it to expired on time. Only the Lifetime term's value reads the shared one-second clock
(`useNow`), and only while the card is pending and has no fixed `now`: that one span re-renders each second, so the
wording and the amber under two minutes change on time, while the rest of the card and the terms list stay put.
Approved, denied, expired, withdrawn and fixed-time cards cost no timer. Terms on a settled card are rendered only
while open; on a live approved card their Lifetime reads the time they were opened.

### VaultApprovalCardSkeleton

The pending card's shape as placeholders, for while a request loads. Shimmers like every `Skeleton`, and stops under
reduced motion.

### BindingCodePicker

**For** the vault page: the approver picks, from three or four codes, the one the card in the session shows. A radio
group labelled "Pick the code shown on the card" of large mono codes; the picked one has a tick as well as the
accent border. `error` shows under the codes (after the server refuses a pick); `disabled` while an approval is sent.

Props: `codes`, `value`, `onPick(code)`, `disabled`, `error`, `label`.

**Not for** checking the code itself: the picker doesn't know which code is right, and must not. The server checks.
Record the pick with `onPick` and send it with Approve or Paste; don't submit on every pick, because arrow keys pick
as they move.

**Keyboard:** as `SegmentedControl`: Tab reaches the picked code (or the first, before a pick), arrow keys move and
pick, Home and End go to the first and last.

**Cost:** none beyond the buttons.

### vault-model.ts

Pure helpers: `vaultHost(link)`, `lifetimeText(expiresAt, now)` ("15 minutes left", "2h 10m left", "3 days left"),
`isUrgent(expiresAt, now)` (under two minutes left), `methodText(methods)` ("Any method" for an empty list or `*`),
`isRouteGrant(card)` and `mustPickCode(request)`.
