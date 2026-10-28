# @harbour/ui

Harbour's component library. Every Harbour screen (the session view, the vault page, audit, schedules, skills,
memory, the inbox) is built from these components and tokens, so the platform looks and behaves as one thing.

It follows T3 Code's interface closely, in look and in flow: dark neutral surfaces, compact type, quiet tool rows,
a stateful composer, status colours from T3's sidebar. See [docs/principles.md](docs/principles.md) for the
direction and what was borrowed from where.

## Use it

```tsx
import { Button, ListRow, StatusLabel } from "@harbour/ui";

// Put `hb-app` on the root element once; it sets the canvas, the font and the text colour.
<div className="hb-app">
	<ListRow title="Rotate the Linear API key" trailing={<StatusLabel status="approval" />} onSelect={open} />
</div>;
```

Add `"@harbour/ui": "workspace:*"` to the app's dependencies. The package exports TypeScript source and plain CSS
that each component imports itself, so a Vite app needs no extra configuration and pays only for the components it
uses. React 19 is a peer dependency. `src/index.ts` is listed in `sideEffects` because it imports the tokens and the
base styles: keep it there, or a production build drops them while the dev server still shows them.

`apps/console` is the reference host: its `src/ui/session-view.tsx` maps a session client's state onto
`SessionHeader`, `Transcript` and `Composer`, and its only CSS is layout, in tokens. Lint a host's CSS and TSX
with the library's rules from a test (see `apps/console/src/ui/tokens.test.ts`), or by hand:
`node packages/ui/scripts/token-lint.ts apps/console`.

## Rules for frontend work

1. Build screens from `@harbour/ui`. If a component you need is missing, add it here, with stories and docs, and
   use it from your app. Don't write a one-off component in an app.
2. Use the tokens (`--hb-*` in [src/tokens/tokens.css](src/tokens/tokens.css)) for every colour, size, radius and
   duration. `pnpm --filter @harbour/ui test` fails on a raw value.
3. Copy is plain sentence case. No uppercase tracked labels, no middle-dot meta strings, no arrows on buttons.
4. Every component has a story for each state it can be in: loading, empty, streaming, error, long content and
   mobile (420px), where they apply.
5. A component that costs render time, bytes or a timer has to say what it does for the person in its docs.

## The workbench

```sh
pnpm --filter @harbour/ui dev               # Ladle on http://localhost:61000
pnpm --filter @harbour/ui build:workbench   # static build in packages/ui/build
node packages/ui/scripts/shoot.ts           # screenshots of every story at 1280px and 420px
node packages/ui/loop/gates.ts              # axe and keyboard gates on every story
```

## What's in it

| Component | For | Not for |
| --- | --- | --- |
| `Button`, `IconButton` | Actions | Navigation between pages (use a link) |
| `StatusLabel`, `StatusDot` | A session's or task's state: working, waiting on an answer, approval, done, failed | Tags on a value (use `Badge`) |
| `Badge` | A one or two word tag on a value: Proposed, Approved, Read only | Anything clickable |
| `ListRow` | Any row in a list: sessions, skills, schedules, memory, audit events, inbox items | Tables with many columns |
| `Panel`, `FieldList`, `Field` | Framed content and label and value pairs | Wrapping the whole page |
| `Notice` | One or two lines of information or warning in the flow | Decisions (use a card) |
| `EmptyState` | What a list or screen says when it has nothing | Errors that need action (use `Notice`) |
| `Disclosure` | A summary that shows detail on demand | Navigation |
| `CopyButton` | Copying a link, code or command | |
| `TextField` | A labelled single-line input | The composer |
| `SegmentedControl` | Two to five exclusive views or filters | More options (use a menu) |
| `Spinner`, `Skeleton` | Loading, when the shape is known (skeleton) or not (spinner) | Loads under about 300ms |
| `WorkingIndicator` | The agent working on a turn, live: "Working for 12s" with the working dot | A session's status in a header or list (use `StatusLabel`) |
| `Kbd` | A key or chord in text | |
| `RelativeTime`, `Elapsed` | Times, on one shared clock | |
| `ClockTime` | A moment in a timeline, by the clock ("16:38") | Ages that should read "4m" (use `RelativeTime`) |
| Icons | 16px line icons in currentColor | Decoration |
| `FileTree` | A workspace's files as a keyboard-navigable tree, read-only | Choosing where to write, or flat search results (use `ListRow`) |
| `FileViewer` | One file's text with line numbers, or an image, read-only | Notes people read (use `NoteViewer`), diffs |
| `NoteViewer` | A Markdown note from a workspace, rendered at a reading measure | Editing, or Markdown in a session (use the transcript) |

Session components (the transcript, tool-call chip, composer, session header, session list and approval cards) are
in `src/session/`, documented in [docs/session-transcript.md](docs/session-transcript.md),
[docs/session-composer.md](docs/session-composer.md) and [docs/session-list-vault.md](docs/session-list-vault.md).
Workspace components (the file tree, file viewer and note viewer) are in `src/workspace/`, documented in
[docs/workspace.md](docs/workspace.md); they are read-only and fed by the host from the workspace read API.
Each primitive's purpose, when not to use it, its states and its cost are in [docs/components.md](docs/components.md). How components are improved is in
[docs/design-loop.md](docs/design-loop.md).
