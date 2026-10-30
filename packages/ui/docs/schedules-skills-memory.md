# Schedules, skills and memory pages

What each page is for, what it reads and writes, its states and its limits. Stories are in the workbench under
"Schedules/Schedules page", "Skills/Skills page" and "Memory/Memory page"; the code is in `src/schedules/`,
`src/skills/` and `src/memory/`, each split into a model (`*-model.ts`, no React, unit-tested) and the view.

## How they get their data

Each page takes a source: the package's contract calls with the viewer's `CallContext` already bound, made by a
`bind*` function from any implementation. The stories and tests bind the in-memory stores (`@harbour/schedules/memory`,
`@harbour/skills/memory`, `@harbour/memory/memory`); the console binds its API client the same way.

| Page | Bind with | Reads | Writes |
| --- | --- | --- | --- |
| `SchedulesPage` | `bindSchedules(schedules, ctx, findings?)` | `list`, `get`, `preview`, `listOccurrences` | `create`, `update`, `pause`, `resume`, `end` |
| `SkillsPage` | `bindSkills(skills, ctx)`, and `bindSkillsAuthor(skills, ctx)` to write | `list`, `get`, `listRevisions`, `getRevision`, `readFile` | `create`, `saveDraft`, `readDraft`, `publish` |
| `MemoryPage` | `bindMemory(memory, ctx)` | `listConcepts`, `getConcept`, `search`, `recall`, `listProposals` | `propose`, `decide` |

Every read goes through `useLoad` (`src/primitives/load.ts`): a skeleton the first time, the last value kept while a
reload runs, an error notice with Try again, and a read that a newer one replaced never touches the state.

All three lay out the same way: a list beside the open record at desktop widths; under 900px the record replaces
the list, with a Back button, and focus moves to the record's heading when it opens.

## SchedulesPage

**For** the organisation's schedules: what runs on its own, when it runs next and how its runs went. A status
filter (Active, Paused, Ended, All) with counts; the open schedule shows its timing in its own time zone, the next
runs from `preview`, what it runs (a reminder's message, a task's prompt and the agent it asks, a check's command), its limits, and its run
history with a Problems filter for failed, missed and timed-out runs. Pause and Resume act on the store and read the
schedule again.

Findings: `Schedules` has no call that lists a check's findings, so the host passes them through `bindSchedules`'s
optional `findings` reader; without one the Findings panel is left out.

Creating and editing: with `form` (the agents a task can ask, and the owner of a new schedule, usually the person's
current project) the page has New schedule, and Edit on a task or check whose payload the form reads. Both open
`ScheduleForm` in the detail pane, saving through the same source; a save or an End opens the schedule as it now is.
Without `form` the page reads, pauses and resumes only. Agents can't create schedules (`Schedules.create` refuses
them): they propose them, and a person makes them here.

Runs and sessions: a task's run result names the session it started (`{ sessionId }`, `runSession`); with
`links.session` each such run links to it, as "Open session".

**The source is the public API's shape.** `SchedulesSource` has one call per schedule route in `@harbour/api`, so
the console's API client fits as it is:

| Call | Route (under `/v1`) |
| --- | --- |
| `list(filter?, page?)` | `GET /schedules` |
| `get(id)` | `GET /schedules/{scheduleId}` |
| `create(input)` | `POST /schedules`, body `{ owner, kind, title, timezone, at \| repeat, until?, count?, payload, check? }` |
| `update(id, input)` | `PATCH /schedules/{scheduleId}`, the fields to change |
| `pause(id)`, `resume(id)` | `POST /schedules/{scheduleId}/pause`, `/resume` |
| `end(id)` | `DELETE /schedules/{scheduleId}`: ends it; it stays listed as `ended`, with its runs |
| `preview(id, n)` | `GET /schedules/{scheduleId}/preview` |
| `listOccurrences(id, page?)` | `GET /schedules/{scheduleId}/runs` |

The fixtures (`@harbour/ui/schedules/fixtures`, `createSchedulesScenario`) are the one implementation for stories,
tests and the console's recorded source: `bindSchedules` over the in-memory store, with three days of runs played
into it. `sessions` makes task runs name a host's own sessions, so their links open.

## SkillsPage

**For** the skills a session sees, by scope (yours, the project's, the organisation's, built in), as `Skills.list`
chooses them: a narrower scope's skill replaces a wider one's of the same name. "Seen from" switches the project.
Opening one shows its owner, where it is mounted, where it was imported from, every published revision, and the
picked revision's files in `FilePreview`, docked: SKILL.md's body with its frontmatter as fields above it, anything
else as itself, with Previous and Next through the revision's files.

With `author` and `owners`, the page also writes:

- **New skill**: an owner, a name, a description and SKILL.md, which starts from a template whose frontmatter follows
  the name and description until the person writes in it.
- **Edit** on a skill the viewer may change (never a built-in one): starts from the open draft, or else the latest
  revision. Only SKILL.md is edited; the revision's other files carry over unchanged.
- **Save draft** keeps a draft sessions don't see. **Publish** saves and publishes with the draft's digest, so what
  was written is what is published, and says that sessions started from now get the new revision while running ones
  keep theirs (`Skills.pinForSession` pins once per session).

The form checks the name, the description and that SKILL.md's frontmatter names the skill before sending; the store
checks again, and its refusals (a taken name, a draft changed by someone else, a forbidden owner) come back as one
sentence. Bind `author` only for people: agents may save drafts but not create or publish.

**Not for** a draft nobody has published yet: `Skills.list` returns published skills only, and there is no call
that lists a viewer's drafts, so such a draft has no row to open.

## MemoryPage

**For** one memory space, in three views:

- **Concepts**, by scope (everywhere, each project, each job's exceptions), with Active, Superseded and Forgotten
  filters and a search (`Memory.search`, best match first, with the snippet that matched). The open concept shows its
  statement, where it applies, who set it, its sources (web ones as links), its version and freshness (stale once
  past `staleAfter`), the rule an exception overrides or the concept that replaced it, and its history. An active
  concept has **Correct** (title, statement and sources) and **Forget** (with a reason). `Memory` changes concepts
  only through proposals, so each is proposed at the version on screen and applied by the same person at once: it is
  audited and shows in the history like any other, and the concept becomes the owner's, which agents can't change.
  A version that moved on meanwhile is refused and nothing changes; if applying fails after proposing, the proposal
  waits in Proposals. Correcting drops a date for checking that has passed. Leave `propose` out of the source for a
  read-only page.
- **Recall**: what a session would be shown for a message, with the project and job scopes it names and the host's
  profile. Each recalled concept says why it came (profile, match with its score and terms, or a job's exception), and
  whether it is stale or was cut short; concepts that matched but were left out are listed, and the rendered text is a
  click away.
- **Proposals**: writes waiting for a person, oldest first, each with what it would do, its text, scope, sources and
  the session that proposed it, and Approve and Reject. A proposal that nearly repeats a concept says so, since
  approving it is refused. Decided proposals follow, newest first.

History: `Memory` keeps no history call, so a concept's history is read from the space's applied and rejected
proposals that named it. A change made outside proposals (a snapshot import) doesn't show.

Spaces: `Memory` has no call that lists the spaces a viewer may read, so the host passes `spaces`; with more than
one, a Space picker shows.

**Not for** remembering a new concept by hand, or superseding one with another: agents propose those, and a person
decides them in Proposals.
