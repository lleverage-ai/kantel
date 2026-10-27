# Workspace file tree and viewers

What each workspace component is for, when not to use it, its states, its keyboard behaviour and what it costs.
Stories are in the workbench under "Workspace/File tree", "Workspace/File viewer" and "Workspace/Note viewer". All of
it lives in `src/workspace/`.

## Read-only and presentational

`FileTree`, `FileViewer` and `NoteViewer` show a workspace's files; they never change them, and they never fetch.
The host reads the workspace through the console read API, `@harbour/workspace/read-api` (its GET routes only, see
`packages/workspace/CONTRACT.md`, "Console read API"), and passes what it has as props. Browsing that way never
acquires a sandbox: the read API takes only the workspace's read operations, and these components have no way to ask
for anything else.

How a host maps the read API onto the props:

| Read API (`GET /v1/workspaces/:id/...`) | Props |
| --- | --- |
| `files?path=<dir>` answered | `directories.set(dir, { status: "ready", entries: page.items, truncated: page.nextCursor !== undefined })` |
| `files?path=<dir>` in flight | `directories.set(dir, { status: "loading" })` (or leave the directory out: it shows as loading) |
| `files?path=<dir>` failed | `directories.set(dir, { status: "error", message })`, the error body's message in words |
| `content?path=<file>`, text | `{ status: "ready", text, size, version }` (`Harbour-Version` header) for `FileViewer`, `{ status: "ready", markdown, updatedAt }` for `NoteViewer` |
| `content?path=<file>`, not text | `{ status: "binary", size, contentType }` |
| `content?path=<file>`, 413 | `{ status: "too-large", size }` (the size from `stat` or the listing) |

The root directory is `""`. Paths are the API's: relative (`src/app.ts`), or absolute under a mount
(`/project/README.md`); `path=/project` lists the project mount. `@harbour/ui` doesn't depend on
`@harbour/contracts`: `WorkspaceEntry` is declared structurally, and a contracts `FileEntry` is one.

The content route serves every file as bytes with `X-Content-Type-Options: nosniff`, and HTML and SVG as
`text/plain`. The viewers keep to that: `FileViewer` renders text as text (never as HTML), and `NoteViewer` renders
Markdown with raw HTML skipped.

## FileTree

**For** a workspace's files in a sidebar or a panel: the console's file browser, a session's notes. Directories
first, then names in natural order ("step-2" before "step-10"), case-insensitive. Directories open and close in
place; files are chosen (or followed, as links).

Props:

- `label`: the tree's accessible name ("Files", "Project files").
- `directories`: every listing the host has, by directory path. A directory with no entry shows as loading.
- `expanded`: the open directories. The tree is controlled: it calls `onToggle(path)` and the host updates the set
  (and lists a directory it opens for the first time).
- `selectedPath`, `onSelect(path)`: the file being shown, and choosing another.
- `hrefFor(path)`: makes files links, so they open in a new tab with the browser's own gestures. A plain click still
  calls `onSelect`; a click with a modifier key or the middle button only follows the link.
- `empty`: replaces the default empty state.
- `root`: where the tree starts, `""` by default; `"/project"` shows only the project mount.

**States:**

- Root loading: seven placeholder rows, and "Loading files" for screen readers.
- Root error: an error notice with the message.
- Root empty: "This workspace has no files yet", or `empty`.
- A directory loading inline: a small "Loading" row with a spinner under it.
- A directory that failed inline: a quiet error row with the message, in place of its files.
- A directory that is open and empty: a quiet "No files" row.
- A truncated listing (`truncated: true`, more pages exist): a last row saying "Some files are not shown". The tree
  doesn't page; a host that wants every entry fetches the remaining pages and merges them into `entries`.
- Long names truncate with an ellipsis, with the full name as the title. A file's size is quiet trailing text that
  keeps its width.

**Not for** choosing a file to upload or a destination to write to: it has no editing, renaming, drag and drop or
multi-select, and there is no way to write through the read API. Not for a flat list of search results: use
`ListRow`.

**Keyboard**, after the WAI-ARIA tree pattern: the tree is one Tab stop, on the last focused row, else the selected
file, else the first row. Up and Down move one row, Home and End go to the first and last. Right opens a closed
directory, or moves to an open one's first child; Left closes an open directory, or moves to the parent. Enter and
Space open or close a directory, or choose a file (Enter follows a file's link). Placeholder rows (Loading, an error,
No files) can be reached with the arrows, so a screen reader hears them, but do nothing. There is no type-ahead.

**Accessibility:** `role="tree"` named by `label`, with flat `treeitem`s carrying `aria-level`, `aria-setsize` and
`aria-posinset`; directories have `aria-expanded`, files `aria-selected`. A file with a link is the link itself, so
each row is one element and one focus target, with the library's focus ring. Rows are 28px tall, and the touch size
(36px) under a coarse pointer.

**Cost:** the visible rows are worked out once per change to `directories`, `expanded` or `root` (`visibleRows`), and
rows are memoised on their fields, so moving focus re-renders the two rows whose Tab stop changed and opening a
directory renders only the new rows. Every visible row is rendered: there is no virtualisation, which is fine for the
few hundred rows an open tree shows; a directory with thousands of entries should be listed a page at a time
(`truncated`). The spinner on a loading row is the only animation.

### workspace-model.ts

Pure helpers, exported from the library:

- `entryName(path)`, `parentPath(path)`: "retry.ts" and "src/billing" for "src/billing/retry.ts"; "project" and ""
  for "/project". The root is "".
- `sortEntries(entries)`, `compareEntries(a, b)`: directories first, then names, case-insensitive and natural.
- `visibleRows(directories, expanded, root = "")`: the rows an expanded tree shows, in order, as
  `{ path, name, kind, depth, size, setSize, position, state?, message?, parent? }`. `depth` is 1 for the root's
  children, as `aria-level`. `kind` is `file` or `directory`, or a placeholder: `loading`, `error`, `empty` or
  `truncated`, whose `path` is its directory's path, a double slash and the kind (`placeholderPath(dir, kind)`).
- `nextFocus(rows, currentPath, key, expanded)`: what an arrow, Home or End key does, as `{ type: "focus", path }` or
  `{ type: "toggle", path }`, or `undefined` when the key does nothing there.
- `fileKind(path)`: `markdown` (.md, .markdown, .mdx), `image`, `binary` (archives, fonts, media, executables and the
  like) or `text` (everything else, names with no extension included). `isNote(path)` is `fileKind === "markdown"`;
  `noteTitle(path)` is the name without its Markdown extension. A guess from the name: a host still shows `binary`
  when the content turns out not to be text.
- `formatBytes(n)`: "0 bytes", "1 byte", "812 bytes", "1.2 KB", "48 KB", "3.4 MB" (1 KB is 1,024 bytes).
- `textLines(text)`, `fileViewerLineCap` (5,000): how `FileViewer` counts and caps lines.

## FileViewer

**For** one file's text, read-only: source, config, logs. A header with the name, its folder (muted) and its size,
Copy (the whole text, icon only), an optional Back button for a phone and an `actions` slot; then the text in mono
with line numbers in a gutter. Long lines scroll sideways rather than wrap, with the numbers held at the left; the
text scrolls vertically within the viewer, which fills the height its host gives it.

Props: `path`, `state` (`FileViewState`), `onBack`, `actions`.

**States:**

- Loading: placeholder lines.
- Error: an error notice with the message, under the header.
- Ready: the text. An empty file says "This file is empty".
- Binary: "This file can't be shown here", with the content type when given.
- Too large: "This file is too large to show here", with its size. The read API answers 413 over 16 MiB.
- Over 5,000 lines: the first 5,000, and a notice saying how many more lines aren't shown. Copy still copies all of
  it.

**Not for** Markdown notes people read rather than inspect (use `NoteViewer`), images (show them with an `img` from
the content route), or diffs. It doesn't highlight syntax.

**Keyboard and accessibility:** the viewer is a region named by the file's name. The text is a region named
"Contents of" the file, and one Tab stop, so it can be scrolled with the arrow keys. Line numbers are hidden from
screen readers and can't be selected, so copying a selection copies only the text. Back and Copy are buttons with
words for names.

**Cost:** the text is split into lines once per text (memoised); the numbers and the text are two text nodes, not an
element per line, so a 5,000-line file is two DOM nodes in the body. Past 5,000 lines the rest isn't rendered,
which bounds layout and memory for logs and generated files; the notice says so, so nothing is hidden silently.
No timers; Copy holds a 1.5 second timer only after a copy.

## NoteViewer

**For** a Markdown note in the workspace: release notes, runbooks, what the agent wrote down. A header with the
note's name without its extension, its folder and "Updated" with a `RelativeTime` when `updatedAt` is given, an
optional Back button and an `actions` slot; then the note, in the transcript's Markdown styles (GitHub flavoured,
raw HTML skipped, links open in a new tab), at the transcript's reading measure (`--hb-content-width`), scrolling
within the viewer. It is rendered by `note-markdown.tsx`, which parses the note as one document: the transcript's
`Markdown` splits at blank lines so streaming re-parses only the last block, which would leave a reference link
defined further down unresolved in a stored note.

Props: `path`, `state` (`NoteViewState`), `onBack`, `actions`.

**States:** loading (a title and paragraphs as placeholders), error (a notice), ready, and empty ("This note is
empty", for a note that is blank or only whitespace).

**Not for** editing a note, or for Markdown that isn't a file (an answer in a session is `AssistantMessage`).

**Keyboard and accessibility:** the viewer is an `article` named by the title. The note's body is a region and one
Tab stop, for scrolling; links and code blocks inside it are reachable by Tab as in the transcript. Two things
differ from the transcript: a task's box is a disabled checkbox named "Done" or "Not done", where the transcript's
is unnamed; and a wide table scrolls with the note, which takes focus, rather than in a box of its own that a
keyboard can't reach. The transcript's `Markdown` has both gaps.

**Cost:** the note is parsed once per text, as one document. `RelativeTime` reads the page's shared clock
once a minute, only while the note was updated under a day ago.
