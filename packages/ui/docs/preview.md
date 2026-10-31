# File preview

One panel for every file the console shows: a file a call presented, a document the agent is writing or wrote, a
file sent with a message, a file in the workspace browser and a skill's files. It lives in `src/preview/`; stories
are in the workbench under "Preview/File preview".

## What it is

`FilePreview` is the chrome: one compact header line, then the body its renderer draws.

- **Header:** the file's icon, its name (a document's title), and its kind muted after a dot ("report.md · Markdown").
  The path, size, when it changed, the model that made it and what the body learned (an image's pixel size, a
  table's rows) are in the name's tooltip, not on screen. Then icon buttons on the same line: Edit (a text file the
  host can save), Previous and Next (when there are siblings), Show in the workspace (when the host can reveal it),
  Share, Download, Expand and Close. Short of room, the kind gives way before the name.
- **Body:** chosen by the registry (`registry.ts`) from the name, then the media type, then the type the server
  answered with. Each body is its own chunk, loaded when a file of its kind first opens, or earlier when a card for
  one is hovered or focused (`warmPreview`).

| Kind | Body | Notes |
| --- | --- | --- |
| Markdown | The transcript's Markdown styles at the reading measure, set as a page | A document (`file.document`) opens in Edit, in the rich editor. Streaming, read and edited, the page has one type (`.hb-doc-page`, `.hb-doc-prose`), so nothing moves when the stream ends or Edit opens. Read or edited, its sections fold under their headings as in Notion: a chevron in the gutter (on hover, always once folded) folds everything up to the next heading of its level or above; `#` to `####`, but not a first-block title (`documents/sections.ts`; `note-sections.tsx` reading, `fold-sections.ts` editing). Folding never changes the Markdown |
| Code and text | `CodeView`, highlighted, line numbers | SVG is shown as its source, never drawn |
| JSON | Pretty-printed (up to 2 MB), highlighted | JSON that doesn't parse (comments, JSON Lines) is shown as it is |
| CSV, TSV | A table with a sticky header, row numbers and numbers aligned right | Only the rows on screen are rendered (manual windowing keeps the native table's column widths) |
| Image | Fitted, never scaled up, decoded before it shows | The last 24 decoded images are kept; a card's picture is shown as it is (`content.url`) |
| PDF | pdf.js, each page a canvas at the panel's width | |
| HTML | A sandboxed frame (`HTML_FRAME_SANDBOX`): scripts run, nothing else | No same-origin, forms, top navigation or network |
| Audio, video | The browser's own player | |
| Word, Excel, PowerPoint | `DocxView`, `SheetView`, `PptxView` | |
| Anything else | "This file can't be previewed", its kind and size, and Download | |

## Props

- `file` (`PreviewFile`) and `content` (`PreviewContent`: loading, error, too large, streaming text, or ready bytes).
  An undefined `file` closes the panel: an overlay slides out, then renders nothing. A new `file` while open swaps
  the body in place, without the panel's entrance again.
- `siblings` and `onNavigate`: Previous and Next.
- `onSave(text)`: offers Edit for a text kind. Edits save 800ms after typing stops, at once on Cmd/Ctrl+S, and as the
  file closes or changes; a rejected save says Couldn't save and keeps the edits.
- `onDownload`, `share` (the `SharePopover`'s props), `reveal` (`{ label, run }`), `onClose`, `onBack` (a phone).
- `layout`: `overlay` (default) sits at the right of its host, resizable from its left edge by pointer or keyboard,
  its width kept in `localStorage` (`widthKey`) as a share of the host between 30% and 75%; `docked` fills the pane
  it is given (the workspace browser, a skill's files).

The host owns reading and writing. The console's `preview-cache.ts` reads each file once, shares reads of one file,
keeps the last 60 files or 48 MiB, retries a failed read on the next open, and puts what was saved in place of what
was read. A read made elsewhere (an image's card) seeds it, and is checked again behind it.

## Keyboard and accessibility

The panel is a labelled `aside` and takes focus when it opens; focus goes back to what opened it when it closes.
Escape leaves Expand, then closes. `j`/`k` and the arrow keys move between siblings, and `f` toggles Expand, except
while typing in a field or the editor. The resize handle is a focusable WAI-ARIA window splitter (the left and right
arrow keys). Each body is a region named "Contents of" the file, one Tab stop for scrolling. Every icon button has a name
and a tooltip. Motion is transform and opacity only, and off under `prefers-reduced-motion`.

## Cost

Nothing loads until a file of a kind opens or is warmed: the preview's own chunk is small, and the heavy renderers
(pdf.js, the Office renderers, the rich editor) load with their first file. A table renders the rows on screen plus
an overscan, so a 20,000-row CSV keeps the rows on screen and 20 either side in the DOM. An image decodes off the main thread before it shows.
