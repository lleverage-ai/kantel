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

Add `"@harbour/ui": "workspace:*"` to the app's dependencies. The package exports TypeScript source; components are
styled with Tailwind v4 utilities (a few still import a .css file of their own while they move over), so a Vite app
adds Tailwind's plugin, `@tailwindcss/vite`, to its `plugins` (see `apps/console/vite.config.ts`), and its `src/` to
the scanned sources in `src/tokens/tailwind.css`, or the utilities on its own elements aren't generated. React 19 is a
peer dependency. `src/index.ts` is listed in `sideEffects` because it imports the tokens, the base styles and the
Tailwind entry: keep it there, or a production build drops them while the dev server still shows them. Style
components with the utilities mapped from the tokens ([docs/tailwind.md](docs/tailwind.md)); the token lint fails
on an arbitrary raw value such as `p-[13px]`, as it does on one in CSS.

`apps/console` is the reference host: its `src/ui/session-view.tsx` maps a session client's state onto
`SessionHeader`, `Transcript` and `Composer`, and lays out its own elements with the same utilities; its one .css
file, `src/ui/styles.css`, keeps only what they can't say ([docs/tailwind.md](docs/tailwind.md#the-console)). Lint a
host's CSS and TSX
with the library's rules from a test (see `apps/console/src/ui/tokens.test.ts`), or by hand:
`node packages/ui/scripts/token-lint.ts apps/console`.

## Rules for frontend work

1. Build screens from `@harbour/ui`. If a component you need is missing, add it here, with stories and docs, and
   use it from your app. Don't write a one-off component in an app.
2. Use the tokens (`--hb-*` in [src/tokens/tokens.css](src/tokens/tokens.css)) for every colour, size, radius and
   duration. `pnpm --filter @harbour/ui test` fails on a raw value.
3. Space follows [docs/spacing.md](docs/spacing.md): one 4px scale (`--hb-step-*`, numbered as Tailwind's), within
   a block 2, between blocks 6, between turns 8.
4. Copy is plain sentence case. No uppercase tracked labels, no middle-dot meta strings, no arrows on buttons.
5. Every component has a story for each state it can be in: loading, empty, streaming, error, long content and
   mobile (420px), where they apply.
6. A component that costs render time, bytes or a timer has to say what it does for the person in its docs.

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
| `Breadcrumbs` | Where you are: project / session / subagent, parents muted links back, the current item emphasised | Tabs or switching between peers |
| `ListRow` | Any row in a list: sessions, skills, schedules, memory, audit events, inbox items | Tables with many columns |
| `Sidebar`, `SidebarSection`, `SidebarProject`, `SidebarItem`, `SidebarToggle` | An app's main navigation: projects with their sessions nested, page links with icons, collapsing to a rail | Navigation inside a page (use `SegmentedControl` or a list) |
| `Panel`, `FieldList`, `Field` | Framed content and label and value pairs | Wrapping the whole page |
| `Notice` | One or two lines of information or warning in the flow | Decisions (use a card) |
| `EmptyState` | What a list or screen says when it has nothing | Errors that need action (use `Notice`) |
| `Disclosure` | A summary that shows detail on demand | Navigation |
| `CopyButton` | Copying a link, code or command | |
| `PageHeader`, `FormLayout`, `FormSection`, `FormField`, `FormGrid`, `FormActions` | Config pages and their forms: the page title and actions, sections, labelled fields with help, equal tracks for short fields, and the buttons | Filters above a list, session cards |
| `TextField` | A labelled single-line input | The composer |
| `TextAreaField` | A labelled multi-line input, such as a scheduled task's prompt | The composer |
| `SegmentedControl` | Two to five exclusive views or filters | More options (use a menu) |
| `CheckboxField` | One on/off choice that takes effect with its form or decision, such as "Let agents write" beside Grant | A setting that applies at once (use `Switch`) |
| `Switch` | An on/off setting that applies the moment it changes, such as a tool server's tool, enabled or not | A choice that waits for a form's Save (use `CheckboxField`) |
| `OneTimeSecret`, `CommandBlock` | A secret shown once when it is made (a tunnel token, an API key) with Copy, the commands that use it and an "I've stored it"; a command to run, with its own Copy | Anything Harbour can show again (use `Code` or `FieldList`) |
| `Spinner`, `Skeleton` | Loading, when the shape is known (skeleton) or not (spinner) | Loads under about 300ms |
| `WorkingIndicator` | The agent working on a turn, live: "Working for 12s" with the working dot | A session's status in a header or list (use `StatusLabel`) |
| `Kbd` | A key or chord in text | |
| `ThemePicker` | Choosing the page's theme, with a live preview ([docs/theming.md](docs/theming.md)) | Per-component colours (themes are tokens) |
| `Code` | Code in the theme's syntax colours: a Markdown fence, a tool's arguments, a file it read | Editing code |
| `RelativeTime`, `Elapsed` | Times, on one shared clock | |
| `ClockTime` | A moment in a timeline, by the clock ("16:38") | Ages that should read "4m" (use `RelativeTime`) |
| Icons | 16px line icons in currentColor | Decoration |
| `FileTree` | A workspace's files as a keyboard-navigable tree, read-only | Choosing where to write, or flat search results (use `ListRow`) |
| `FilePreview` | Any file in one panel: Markdown, code, JSON, tables, images, PDF, HTML, media, Office, with Edit for text ([docs/preview.md](docs/preview.md)) | Diffs, or Markdown in a session (use the transcript) |

Session components (the transcript, tool-call chip, composer, session header, session list and approval cards) are
in `src/session/`, documented in [docs/session-transcript.md](docs/session-transcript.md),
[docs/session-composer.md](docs/session-composer.md) and [docs/session-list-vault.md](docs/session-list-vault.md).
Workspace components (the file tree, file viewer and note viewer) are in `src/workspace/`, documented in
[docs/workspace.md](docs/workspace.md); they are read-only and fed by the host from the workspace read API.
The schedules, skills and memory pages (`SchedulesPage`, `SkillsPage` with its `SkillEditor`, `MemoryPage`) are in
`src/schedules/`, `src/skills/` and `src/memory/`, documented in
[docs/schedules-skills-memory.md](docs/schedules-skills-memory.md); each takes its package's contract calls bound to
the viewer.
The identity pages are in `src/identity/`: `SignInScreen`, `ApiKeysPage` for a host app's keys, and `MembersPage`, the
organisation's people with an admin's passkey reset. Each takes the identity client's calls; stories show their states.
`ModelsPage` (`src/models/`) is a project's models: the agent's image model, picked from the image models the model
gateway's connectors offer, and each connector's models with what they take and give (Text, Makes images, Reads
images, the image API) and a Test generate button on an image model. The host makes every call and passes the states
in; stories show loading, empty, read-only, a test image and a failed test.
`ToolServersPage` (`src/tool-servers/`) is the MCP servers an organisation's or a project's agents call for tools
(docs/design/private-mcp-tools.md): the list with each server's status and a day's calls, Add tool server with its
tunnel token and command shown once, and a server's tools (each with an Enabled `Switch`), tokens, recent calls and
Remove. It calls a `ToolServersSource` the host binds; `@harbour/ui/tool-servers/fixtures` serves stories and the
console's recorded mode.
Themes (the colour tokens, the built-in themes, the picker, and how to add one or load a custom one) are in
[docs/theming.md](docs/theming.md).

Each primitive's purpose, when not to use it, its states and its cost are in [docs/components.md](docs/components.md). How components are improved is in
[docs/design-loop.md](docs/design-loop.md).
