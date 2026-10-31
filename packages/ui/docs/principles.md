# Principles

## Sources

- **T3 Code**, the primary reference, read at pingdotgg/t3code `1152e9171a9ce6ede20e0cc1f16ed0dbe103da9b`
  (27 October 2026), `apps/web/src`, and its published app screenshot on https://t3.codes. MIT-licensed. Patterns
  are borrowed and reimplemented; no code is copied.
- **Jeff's web app**, a secondary reference for the vault card, read at jaythegeek/jeff-pi
  `af2783a1d8f2388123e0eee3f5cba180a1090759` (`apps/desktop/src/renderer/content/vault-card.tsx`). It has no licence
  file, so only ideas are taken from it.

## Look

- **Kantel, after the Lleverage brand.** Midnight `#141e28` canvas with panels a step lighter, paper `#f9f7f0` text
  (never pure white) and hairline paper borders; Kantel light is the same on paper. The layout and density stay
  T3 Code's. Neutral and Neutral light keep the earlier look: canvas `#0a0a0a`, panels `#111`, borders white at 6%,
  after T3 Code's dark theme (`apps/web/src/index.css:1193-1231`).
- **One accent**, the brand's orange `#ec7523`, kept to primary actions, links and the focus ring, and set through
  four tokens (`--kt-accent`, `--kt-accent-hover`, `--kt-accent-text`, `--kt-accent-fg`) so a host app can rebrand
  it.
- **Status colours** for working, waiting on an answer, pending approval, done and failed: the brand's product set
  (blue, ochre, green, red) lifted to pass AA, plus indigo, after T3 Code's sidebar
  (`apps/web/src/components/ThreadStatusIndicators.tsx:806-857`). Only working pulses.
- **Type:** the brand's faces, as theme tokens: Public Sans for the interface, Abhaya Libre for display headings,
  Roboto Mono for code (docs/theming.md). 14px body, 13px secondary, 12px metadata, 11px badges.
- **Radius:** 10px for panels, 8px for controls, 16px for the user's message bubble.
- **Borders, not shadows,** for anything in the flow. Shadows only for things that float.

## Copy

- Plain sentence case everywhere: "Open in vault", "Needs approval", "Worked for 3m 43s".
- No uppercase tracked labels. (T3 Code and Jeff both use them in places; Kantel doesn't.)
- No middle-dot meta strings ("main · 2h · 3 files"). Put separate facts in separate elements, or a sentence.
- No arrows on buttons. Say where it goes in words. The composer's icon-only send button is the one arrow glyph.
- Say what happens, from the person's side: "The agent carries on when you're done", not "Awaiting resolution".

## Cost

Every element earns its place. A component that costs render time, bytes, a timer or an animation says in its docs
what it does for the person. Rules that follow:

- Nothing animates unless something is happening (a working dot, a spinner, a streaming caret).
- Times share one clock (`useNow`), not an interval per row.
- Lists memoise rows on their item, so streaming re-renders only what changed.
- Detail is rendered on demand (a tool's arguments and output), not hidden with CSS.

## Flow borrowed from T3 Code

The session components named here live in `src/session/`.

| Pattern | T3 Code source | Kantel component |
| --- | --- | --- |
| Session cards with project, title and meta lines; slim rows for settled ones; status as icon and words, top right | `apps/web/src/components/sidebar/SidebarThreadRow.tsx:1114-1118,1292-1321,1454-1524` | `SessionListItem`, `ListRow` |
| Status priority: approval, then input, then working, then failed or done | `apps/web/src/components/Sidebar.logic.ts:871-898` | `sessionStatus()` |
| Hover or focus swaps the time for row actions | `apps/web/src/components/sidebar/SidebarThreadRow.tsx:1393-1450` | `ListRow` `actions` |
| Right-aligned user bubble, at most 80% wide; assistant text unboxed on the canvas | `apps/web/src/components/chat/TimelineUserMessageRow.tsx:432-459`; `TimelineAssistantRows.tsx:26-72` | `Transcript` rows |
| Tool calls as quiet 24px work-log rows with a meaningful icon, expanding to selectable detail | `apps/web/src/components/chat/WorkLog.tsx:53-90,134-164` | `ToolCallChip` |
| Consecutive tool calls grouped, collapsing to "Worked for …" | `apps/web/src/components/chat/MessagesTimeline.logic.ts:1758-1889` | `ToolCallGroup` |
| Follow new output only while at the bottom; a "Scroll to end" button otherwise | `apps/web/src/components/chat/useTimelineFollow.ts:162-196`; `TimelineOverlays.tsx:25-55` | `Transcript` |
| Composer: one surface, 46rem column, 16px type under a coarse pointer, a stateful primary action (send, steer, stop) | `apps/web/src/components/chat/ComposerSurface.tsx:5-32`; `ComposerPrimaryActions.tsx:133-160,262-350` | `Composer` |
| Enter sends, Shift+Enter is a new line, software-keyboard Enter does not send | `apps/web/src/composer-logic.ts:49-93` | `Composer` |
| Approvals and questions attach above the composer, not as a modal; Decline and Approve | `apps/web/src/components/chat/ComposerPendingApprovalActions.tsx:25-105`; `ChatComposer.tsx:3405-3455` | `Composer` `banner`, `QuestionCard` |
| Diff stats in monospace, emerald and red | `apps/web/src/components/chat/DiffStatLabel.tsx:33-48` | `DiffStat` |
