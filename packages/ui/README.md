# @kantel/ui

Kantel's component library. Every Kantel screen (the compute console's sandboxes, snapshots, keys, hosts and the
rest, and sign-in) is built from these components and tokens, so the platform looks and behaves as one thing.

It follows T3 Code's interface closely, in look and in flow: dark neutral surfaces, compact type, quiet tool rows,
a stateful composer, status colours from T3's sidebar. See [docs/principles.md](docs/principles.md) for the
direction and what was borrowed from where.

## Use it

```tsx
import { Button, ListRow, StatusLabel } from "@kantel/ui";

// Put `kt-app` on the root element once; it sets the canvas, the font and the text colour.
<div className="kt-app">
	<ListRow title="Rotate the Linear API key" trailing={<StatusLabel status="approval" />} onSelect={open} />
</div>;
```

Add `"@kantel/ui": "workspace:*"` to the app's dependencies. The package exports TypeScript source; components are
styled with Tailwind v4 utilities (a few still import a .css file of their own while they move over), so a Vite app
adds Tailwind's plugin, `@tailwindcss/vite`, to its `plugins` (see `apps/console/vite.config.ts`), and its `src/` to
the scanned sources in `src/tokens/tailwind.css`, or the utilities on its own elements aren't generated. React 19 is a
peer dependency. `src/index.ts` is listed in `sideEffects` because it imports the tokens, the base styles and the
Tailwind entry: keep it there, or a production build drops them while the dev server still shows them. Style
components with the utilities mapped from the tokens ([docs/tailwind.md](docs/tailwind.md)); the token lint fails
on an arbitrary raw value such as `p-[13px]`, as it does on one in CSS.

`apps/console` is the reference host: its `src/compute/compute-app.tsx` binds `ComputeConsole` to the gateway's
compute API, and lays out its own elements with the same utilities; its one .css
file, `src/ui/styles.css`, keeps only what they can't say ([docs/tailwind.md](docs/tailwind.md#the-console)). Lint a
host's CSS and TSX
with the library's rules from a test (see `apps/console/src/ui/tokens.test.ts`), or by hand:
`node packages/ui/scripts/token-lint.ts apps/console`.

## Rules for frontend work

1. Build screens from `@kantel/ui`. If a component you need is missing, add it here, with stories and docs, and
   use it from your app. Don't write a one-off component in an app.
2. Use the tokens (`--kt-*` in [src/tokens/tokens.css](src/tokens/tokens.css)) for every colour, size, radius and
   duration. `pnpm --filter @kantel/ui test` fails on a raw value.
3. Space follows [docs/spacing.md](docs/spacing.md): one 4px scale (`--kt-step-*`, numbered as Tailwind's), within
   a block 2, between blocks 6, between turns 8.
4. Copy is plain sentence case. No uppercase tracked labels, no middle-dot meta strings, no arrows on buttons.
5. Every component has a story for each state it can be in: loading, empty, streaming, error, long content and
   mobile (420px), where they apply.
6. A component that costs render time, bytes or a timer has to say what it does for the person in its docs.

## The workbench

```sh
pnpm --filter @kantel/ui dev               # Ladle on http://localhost:61000
pnpm --filter @kantel/ui build:workbench   # static build in packages/ui/build
node packages/ui/scripts/shoot.ts           # screenshots of every story at 1280px and 420px
node packages/ui/loop/gates.ts              # axe, keyboard, alignment and state gates on every story
```

Both scripts read the static build, so run `build:workbench` first. They drive a headless Chromium (`/usr/bin/chromium`,
or the path in `CHROMIUM`). `shoot.ts` writes `<story>-1280.png` and `<story>-420.png` for each story to
`packages/ui/loop/out/shots` (`--out` to change it, `--only` for chosen stories). `gates.ts` checks every story at
1280px and 420px for WCAG 2.2 A and AA violations with axe, Tab order and a visible focus ring, icons and labels
centred on their text within 1px, and a story for every required state; `--only` limits it to chosen stories and
`--json <file>` writes the results. The token and copy lint is `scripts/token-lint.ts`, run by
`pnpm --filter @kantel/ui test`.

## What's in it

| Component | For | Not for |
| --- | --- | --- |
| `Button`, `IconButton` | Actions | Navigation between pages (use a link) |
| `StatusLabel`, `StatusDot` | A sandbox's, host's or task's state: working, waiting, done, failed | Tags on a value (use `Badge`) |
| `Badge` | A one or two word tag on a value: Proposed, Approved, Read only | Anything clickable |
| `Breadcrumbs` | Where you are: parents muted links back, the current item emphasised | Tabs or switching between peers |
| `ListRow` | Any row in a list: sandboxes, snapshots, keys, hosts | Tables with many columns |
| `Sidebar`, `SidebarSection`, `SidebarProject`, `SidebarItem`, `SidebarToggle` | An app's main navigation: page links with icons, collapsing to a rail | Navigation inside a page (use `SegmentedControl` or a list) |
| `Panel`, `FieldList`, `Field` | Framed content and label and value pairs | Wrapping the whole page |
| `Notice` | One or two lines of information or warning in the flow | Decisions (use a card) |
| `EmptyState` | What a list or screen says when it has nothing | Errors that need action (use `Notice`) |
| `Disclosure` | A summary that shows detail on demand | Navigation |
| `CopyButton` | Copying a link, code or command | |
| `Tooltip`, `HelpHint` | A few words on hover and keyboard focus: a truncated value in full, a chart's figures, what a column means (`HelpHint`'s "?") | Anything to act on, or that must be read to use the page (say it in the page) |
| `Dialog` | A modal: a short decision with its buttons, or (`width="wide"`, no `actions`) something to look at, such as a sandbox's metrics, with a close button | Long forms (use a page) |
| `PageHeader`, `FormLayout`, `FormSection`, `FormField`, `FormGrid`, `FormActions` | Config pages and their forms: the page title and actions, sections, labelled fields with help, equal tracks for short fields, and the buttons | Filters above a list |
| `TextField` | A labelled single-line input | |
| `TextAreaField` | A labelled multi-line input, such as a webhook's description | |
| `PageTabs` | A page's own views, each a link with its address (Egress's Log, Rules, Settings) | The app's pages (use `Sidebar` or `TabBar`); filters with no address (use `SegmentedControl`) |
| `SideScroll` | Content wider than its column that scrolls sideways, such as a table with more columns than fit: its cut-off edges fade and its scrollbar is inside its frame, pinned to the window's bottom while that is out of view; with `fill`, a list page's table that scrolls down under its header, with its header row stuck and its own scrollbars inside its frame | A compute page's table (use `TableFrame`, which has one); tabs (`PageTabs` scrolls its own row) |
| `SegmentedControl` | Two to five exclusive views or filters | More options (use a menu); a page's views with their own address (use `PageTabs`) |
| `CheckboxField` | One on/off choice that takes effect with its form or decision | A setting that applies at once (use `Switch`) |
| `OrderedSelectField` | Several from a list, in the order picked: a new sandbox's environments, the later winning | One choice (use `SelectField`); a set whose order doesn't matter (use `CheckboxField`s) |
| `Switch` | An on/off setting that applies the moment it changes | A choice that waits for a form's Save (use `CheckboxField`) |
| `SliderField` | A number chosen along a range, with its value beside the label: a sandbox's vCPUs or memory | A few named choices (use `SegmentedControl` or `SelectField`); an exact figure to type (use `TextField`) |
| `OneTimeSecret`, `CommandBlock` | A secret shown once when it is made (a host's join token, an API key) with Copy, the commands that use it and an "I've stored it"; a command to run, with its own Copy | Anything Kantel can show again (use `Code` or `FieldList`) |
| `Spinner`, `Skeleton` | Loading, when the shape is known (skeleton) or not (spinner) | Loads under about 300ms |
| `Kbd` | A key or chord in text | |
| `ThemeSwitch` | Choosing System, Light or Dark ([docs/theming.md](docs/theming.md)) | Per-component colours (themes are tokens) |
| `Code` | Code in the theme's syntax colours: a command, a snapshot's file, a webhook's payload | Editing code |
| `RelativeTime`, `Elapsed` | Times, on one shared clock | |
| `ClockTime` | A moment in a timeline, by the clock ("16:38") | Ages that should read "4m" (use `RelativeTime`) |
| Icons | 16px line icons in currentColor | Decoration |

The compute console (`ComputeConsole` and its pages: sandboxes, snapshots, keys, the egress proxy, webhooks,
OpenTelemetry, the organisation, billing, hosts, base images and the device page) is in `src/compute/`. A sandbox or
saved snapshot on an outdated base image shows `BaseOutdatedBadge` (`src/compute/base-outdated.tsx`) wherever it's
listed. An opened host shows its memory with `HostMemoryUsage` (`src/compute/host-memory.tsx`), what takes its disk with
`HostDiskUsage` (`src/compute/host-disk.tsx`) and its mesh peers with `HostPeers` (`src/compute/host-peers.tsx`). The
Hosts page groups hosts by pool and manages pools with `src/compute/host-pools.tsx`. It calls a `ComputeSource`
the host binds; `@kantel/ui/compute/fixtures` serves stories and the console's recorded mode.
`SignInScreen` and `SignedInAs` are in `src/identity/`; they take the identity client's calls.
The two themes (the colour tokens, the dark and light palettes, the switch, and how to change a palette) are in
[docs/theming.md](docs/theming.md).

Each primitive's purpose, when not to use it, its states and its cost are in [docs/components.md](docs/components.md).
