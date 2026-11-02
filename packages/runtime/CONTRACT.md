# Session runtime

## What it is for

A session is one durable agent conversation, owned by an organisation and, unless it is scoped to the organisation,
a project, and run with an agent profile.
Hosts create sessions, prompt, steer, follow up, abort, close and watch them, and serve host tools. Every session runs
on its own Pi Durable Harness; Pi types stay inside this package and never reach contracts or protocol.

## Records

- `SessionRecord`: organisation, project (absent for an organisation session), agent, optional user, parent and
  workspace, title, status, labels, creator, times. `scopeOf(record)` gives its `AccessScope`.
- `AgentProfile`: model route, prompt layers, tools, skills, sandbox policy, memory scopes and the serving host.
- `HostToolDefinition`: name, description, JSON schema and replay policy, registered per host.
- `Submission` and `RunResult`: one admitted input and how its run ended (`answered`, `failed`, `aborted`).

## Key operations

- `SessionRuntime`: `create`, `prompt`, `steer`, `followUp`, `abort`, `wait`, `watch`, `snapshot`, `close`.
- `SessionDirectory`: `get`, `list` (newest first, filtered, paged), `children`.
- `AgentProfiles`: `put`, `get`, `list`. `HostToolBridge`: `register` (returns a subscription), `list`.
- `SessionEndHook`: `register(name, teardown)`. The runtime runs every registered teardown when a session is closed or
  aborted; the in-memory components register as `sandbox`, `browser`, `capability` and `vault`.
- `SessionModels`, implemented by the runtime and served over HTTP (`test/session-models.test.ts`; no suite cases):
  `SessionModels` (`listModels`, `modelState` and `startModels`: the `ModelOption`s a session's prompts may name,
  what it runs with and what its profile names, for a client's model and thinking pickers) and `PromptInput.model` and
  `PromptInput.thinking`. A choice is kept with the session's Pi Durable conversation (`configure`), so it applies
  from the next model call, to every later run, and after the session reopens; a level the model lacks is clamped
  with pi's `clampThinkingLevel`. `@kantel/ui`'s composer takes the same shapes.
- `PromptInput.attachments` (`PromptAttachment`, a reference to a file the host uploaded). With the runtime's
  `attachments` option, the runtime reads each file through the host that stored it and places what the model should
  see of it ahead of the prompt's words; files the host hands over are also saved in the session's files under
  `uploads/` (`src/attachments.ts`). Without the option a prompt with attachments is `invalid`.
- `SessionHistory.history`, a session's transcript in pages, newest first, served as `history` on the runtime service and `GET /sessions/:id/history`. The `history:` suite cases run
  with `{ history: true }`: the latest page first and cursors back to the start without a repeat or a gap; pages
  behind a cursor unchanged while new turns arrive; `before` an item a client holds; `invalid` for a malformed
  request, `not_found` for an unknown item or session, and project access refusing an operator outside the project.
- `SessionBranching`, served as `branching` on the runtime service,
  `POST /sessions/:id/fork` (a new session with the history up to an answer) and `POST /sessions/:id/edit` (rewind
  to a person's message and prompt new words in its place, kept across a restart). No suite cases; the runtime's
  `test/branching.test.ts` and `test/http.test.ts` cover it on the SQL and in-memory runtimes.

## Rules and the suite cases that enforce them

Each rule is followed by the suite case that checks it, in quotes.

- Sessions and profiles belong to one organisation; others get `not_found`: "hides sessions and profiles from other
  organisations as not_found"; a profile for another organisation is `forbidden`: "keeps agent profiles per
  organisation and refuses one for another organisation".
- A created session is idle, keeps its labels, and lists newest first with project, label and paging filters: "lists a
  created session in its organisation with its labels, idle, and filters by project and labels".
- An unknown agent profile or parent is `not_found`, and a project's profile runs only in that project (`invalid`
  elsewhere): "refuses to create a session with an unknown agent profile as not_found".
- A prompt runs the profile's model with its prompt layers joined in order; `wait` gives the answer; the snapshot
  shows the user and assistant items and status idle: "answers a prompt with the scripted text and shows the user and
  assistant items".
- The same `requestId` returns the same submission and asks the model once: "returns the same submission for a
  retried requestId and asks the model once".
- Watching sends hello, then a snapshot or the deltas after a cursor; deltas rebuild the snapshot: "streams hello and a
  snapshot, live deltas rebuild the final snapshot, and a reconnect resumes after a cursor".
- A host tool call carries the session, agent, stable call ID and arguments; its result reaches the model; the tool
  item ends `done`: "passes a host tool call to the host with the session, agent, call ID and arguments, and its result
  to the model".
- A profile tool the host does not serve gives the model an error result and the run goes on: "gives the model an
  error result for a profile tool the host does not serve, and the run still answers".
- A steer joins the running turn after its tool round and shows as a user item `via: "steer"`: "joins a steer sent
  while a host tool is blocked to the run after the tool round".
- A follow-up waits for the current run and starts the next: "starts a follow-up sent while busy after the current run
  answers".
- Abort ends the run `aborted`, aborts the host handler's signal, releases sandbox leases and leaves the session usable:
  "aborting while a host tool is blocked ends the run aborted, aborts the handler, releases sandbox leases and leaves
  the session usable".
- Aborting a parent aborts its children first: "aborting a parent aborts its running child session, which the
  directory lists under the parent".
- Close marks the session done and later input is `conflict`: "closing a session marks it done and refuses later
  prompts with conflict".

### Session end

- Close runs every teardown once, in registration order, with a `system` context and a `SessionEnd` naming the
  session, project, agent, reason `session_ended` and who ended it; another session keeps what it holds; closing or
  aborting a closed session runs nothing: "session end: closing runs every registered teardown once for the session,
  which then holds nothing, and closing again runs none".
- Abort runs the teardowns (`aborted`) for each child, then the session, which stays usable: "session end: aborting
  runs the teardowns for each child and the session, which stays usable, and a second abort changes nothing".
- A failing teardown does not stop the others or fail the close; it is audited as `session.teardown.failed` with its
  name and error code, never its message: "session end: a failing teardown does not stop the others or fail the
  close, and is audited with its name and code but not its message".
- Closing a parent does not end a child it already closed: "session end: closing a parent does not end an already
  closed child again".
- One session's failure (an audit sink that is down, say) does not keep its siblings or parent from running their
  teardowns; the first failure is rethrown afterwards (unit test in `packages/runtime/test/session-end.test.ts`).
- A name registers once (`conflict` otherwise), and closing the registration removes it: "session end: a teardown
  name is registered once, and closing its registration removes it".

### Project access (`projectAccess: true`)

Every call checks `ProjectAccess` before it acts. Reads (`get`, `list`, `children`, `wait`, `watch`, `snapshot`) need
`viewer`; `create`, `prompt`, `steer`, `followUp`, `abort`, `close`, `profiles.put` and `hostTools.register` need
`operator`. A project's profile is read with `viewer` on it, and replacing it needs `operator` on its project too. A
host registers for the project its call names (or across the organisation); replacing a host registered elsewhere
needs `operator` there too, and listing a project's host needs `viewer` on it. Lists leave out what the caller may not
see.

- "project access: refuses an operator outside the project every call on its sessions and profiles, and changes
  nothing".
- "project access: refuses an agent whose session belongs to another project, and changes nothing".
- An agent acts in its own session and on its children, not a sibling, and nowhere once its session is closed:
  "project access: an agent acts in its own session and supervises its children, never a sibling, and nowhere once its
  session is closed".
- "project access: a viewer on the project reads its sessions but cannot change them".

### Organisation scope (`projectAccess: true`)

`create` with `scope: "organisation"` and no `projectId` makes a session in no project; without `scope` a session
still needs a project. It needs `operator` across the organisation, and an agent passes only from an organisation
session. A child is in its parent's scope. An organisation session's agent passes organisation checks for its own
session and its children, never a project's check. `userId` is the person the session works for: a child's parent's,
else the person creating it (who may name only themselves) or the one a service names. SQL stores keep `project_id`
NOT NULL and write `''` for an organisation session; the record, without `projectId`, is what reads back.

- "organisation scope: an organisation-wide operator creates a session with no project, which lists under the
  organisation scope and no project".
- "organisation scope: refuses as invalid an organisation session naming a project, a project session naming none, an
  unknown scope and a project's profile".
- "organisation scope: an operator on one project only, a viewer and a project session's agent may not create an
  organisation session".
- "organisation scope: an organisation session's agent supervises organisation children but passes no project's
  check".
- "organisation scope: a person's session works for them, and they may name no one else".

## The runtime and its store

`createSessionRuntime({ store, storage, clock, audit, models, resolveModel, identity, sandboxes, leaseSweepMs, hostHandler, environment, pageSize })`
from `@kantel/runtime/core` is the runtime every target runs. A target gives it two things:

- `store`, a `SessionStore` (`@kantel/runtime/store`): the directory of sessions (each with the profile it was created
  with, its sequence, abort count and whether it is closed), agent profiles, submissions and host registrations.
  `createMemorySessionStore()` keeps them in maps; `createSqlSessionStore(db, { prefix })` from `@kantel/runtime/sql`
  keeps them in any database behind chord's `SqliteDatabase` facade: Node's SQLite, a Durable Object's SQLite, or
  Postgres through the self-hosted target's translation of the SQLite dialect.
- `storage(record)`, which opens a session's Pi Durable storage. `sqlPiStorage(db, sessionId)` puts it in the same
  database under the session's own table prefix (`pi_<uuid without dashes>_`). A new session's tables are created at
  Pi Durable's current schema version (`createPiSchema`), with the version recorded, so its migrations have nothing to
  replay.

Optionally, `archive(record)` archives a closed session's Pi storage once it has closed durably and its Harness has
closed here. `archiveSqlPiStorage(db, sessionId)` moves every record of the session's tables into one shared table
(`harbour_pi_archive`) and drops the tables, in one transaction, so a database's schema grows with its open sessions,
not with every session it has held: SQLite's DDL costs more the larger the schema, and every create adds some.
`sqlPiStorage` restores an archived session's tables when it is opened again (to read, watch or fork it), and the
runtime archives it again when it closes. Both targets wire it; a failure goes to `onArchiveError` and leaves the tables.

Sessions that closed before `archive` was set (or whose archive failed) keep their tables until something archives
them. With `unarchived()`, the sessions that may still have tables, `sweepArchive(limit)` archives up to `limit` of
the closed ones that aren't open in this runtime, one after another, and says how many; fewer than `limit` means none
is left. The Durable Object core lists them from the object's schema and runs one batch per alarm (`archiveSweep`,
default 5 every 2 s), arming the alarm again while a batch comes back full. Starting the object archives nothing; it
only arms the first alarm when a closed session still has tables.

Sessions open on first use. A runtime opened on a store that already holds sessions reopens each one when it is next
used: its profile, transcript, submissions and host tools carry on.

Each stored session has a wake: when it next needs a process. The runtime sets it to now before it admits input or an
abort (and refuses the input if it cannot), then keeps it to what the session's Harness says (`onWake`: right away
while work runs, the earliest sleep while it sleeps, none once it settles), and arms a timer for each sleep in its
process. Call `resume()` once after start, and from a target's alarm: it runs every session whose wake is due, so Pi
Durable carries its work on from the last commit, and arms a timer for the next wake. `onWakeAt` tells a target whose
process can be evicted when to set its alarm. A model call cut off is sent again; a host tool call cut off reruns, with the same call ID, when the tool is `replay: "safe"`,
and otherwise the model gets an interrupted result. Two processes must not run one session's storage at once: a target
fences its storage (self-hosted) or has one owner by construction (a Durable Object).

Sandbox leases expire by their TTL. With `sandboxes.sweep`, the runtime is their alarm: `resume()` sweeps first, and
while its process holds a session open it sweeps every `leaseSweepMs` (default 60 s), as the `session` component.
`sweepLeases()` sweeps on demand, and `onSweepError` hears of a failed sweep, which the next one retries. Sweeps never
overlap: every caller shares the one in progress. `resume()` waits at most `sweepWaitMs` (default 5 s) for its sweep
before recovering sessions anyway. A child's
leases are released when it ends: aborting or closing a parent runs the session-end hook, `sandbox` teardown included,
for each child too.

`environment(record)` gives a session its execution environment (Pi Durable's `ExecutionEnv`, which the `read`,
`write`, `edit` and `bash` tools need), such as `createSandboxExecutionEnv` from `@kantel/sandbox` over the session's
workspace: its file operations go to `Workspaces` directly and only its commands to `Sandboxes.run`. It is built
once when the session opens in a process and must acquire nothing: a sandbox is leased by the first command that needs
one and released by the session-end hook, so a session that never runs a command never holds one. Abort and close call
its `cleanup`, which stops waiting for commands still running. A session it gives none to has no environment, and a tool
that needs one fails with an error result.

A host registration made in this process (`hostTools.register` with a handler) offers its tools only while its handler
lives. `hosts.register(ctx, hostId, tools, callback, owner)` stores the registration with its callback URL and HMAC
secret, and any later runtime on the store serves it through `hostHandler` (`callbackHostHandlers()` from
`@kantel/runtime/http`); only `owner` may remove it, and only while it is the host's current registration. The
session API takes the runtime's `hosts` as its `hosts` option and then keeps every `PUT /hosts/:id` this way. The
secret is stored with the registration, so the store is as sensitive as the secrets it holds.

## Skills and memory

`createSessionRuntime({ skills, memory })` gives sessions skills and memory to read (`src/context.ts`). Both are optional;
without them a session gets neither.

- `skills: { store, render?, mount?, visibility?, mountRoot? }`. On a session's first prompt the runtime calls
  `store.pinForSession` as the session's agent, over `visibility` (default the session's project), so later revisions
  reach only new sessions; calls `mount(session, pins)` once, for the host to mount the pins read-only at `/skills`
  (the `skills` source of `@kantel/workspace/mounts`, `ref` the session ID); and passes the listings of the skills the
  profile names (`profile.skills`, by skill ID or name) to the host's `render`, such as `renderSkillListings` from
  `@kantel/skills/sources`. Without `render` nothing is listed.
- `memory: { store, spaces?, recall?, now? }`. On the same first prompt it recalls over the profile's
  `memoryScopes` (each a memory space ID, or `spaces(profile, session)`) with the prompt's text as the query; the
  text is the memory implementation's `RecallRenderer`. A session with memory scopes gets `memory_search` and
  `memory_read` (`memoryCapabilities` of `@kantel/memory`, `safe`, served as the session's agent and audited as
  host `harbour.memory`); a host tool of the same name is not offered beside them.

Kantel adds no prompt of its own: the listing and the recall are the host's and the deployment's text, joined by a
blank line, placed once as a `harbour.context` entry before the first prompt, a user message for the model with the
pinned revisions, listed skill IDs and recall manifest as its data. It stays in the transcript, so later turns, a
retried prompt and a restarted runtime see what the session saw; it is not a protocol item. A pin, mount or recall
that fails fails the prompt, and the next prompt tries again.

A forked session (`branching.fork`) copies its source's history, `harbour.context` entry included, so it keeps the
source's listing and recall and pins nothing of its own. On its first prompt the runtime calls `mount(fork, pins)` once,
with the revisions the source's entry records under the fork's session ID, so its `/skills` shows what its listing
names; the host mounts them by version (`skillsMountVersion(pins)` of `@kantel/workspace/mounts`). Which
revisions, and whether they are mounted, is a session document of the fork's (`harbour.fork-skills`).

## Prompt rules

`createSessionRuntime({ rules })` takes a `PromptRules` (`packages/rules/CONTRACT.md`). It is optional; without it a
session runs its profile's own layers alone. `create` calls `rules.forSession` as Kantel once, after its own create
check, with the session's project (none for an organisation session) and `userId`. The layers become platform,
organisation, project, the profile's own, then the user's (`resolvePromptLayers`), and are stored with the session's
copy of the profile. A restart, a reopened session and a fork (which copies the source's profile) run the same prompt;
an edited rule reaches only sessions created after the edit. Kantel adds no rule of its own. Covered by
`test/rules.test.ts`.

## The in-memory implementation

`createMemoryRuntime({ clock, audit, models, resolveModel, identity, sandboxes, pageSize })` from `@kantel/runtime/memory`
is `createSessionRuntime` over `createMemorySessionStore()`, with one Harness per session on Pi Durable's
`MemoryStorage`. The profile's prompt layers become one system prompt
section, and are the whole of it: Kantel adds no text of its own, so a profile with no layers sends no system prompt; and the profile's tools that the host serves become Pi tools (`safe` tools replay; others do not). Input is
placed as a `harbour.user` entry recording how it was sent. `ConversationProjector` (`project.ts`) diffs Pi's committed
view into protocol ops on a `createMemorySessionStream`; status is `running` while Pi has a run, `failed` after a model
error, `idle` otherwise and `done` after close. After each model response that reports usage (failed ones included)
it publishes the session's running total as a `usage` op, so the snapshot's `usage` is the session's tokens and cost so
far: one `UsageTally` per open session, shared by its projections, counts each `pi.assistant` entry once, so an edit
keeps what the abandoned branch used while the session stays open. Rebuilt on reopen from the active conversation's
entries; the per-call `model.call` audit events stay the record of truth. Audit: `session.created`, `session.prompted`, `session.steered`,
`session.aborted`, `session.tool.started`, `session.tool.finished`, with stable ids. `createScriptedModel()` from
`@kantel/runtime/testing` scripts pi-ai's faux provider for the suite.

With `identity` (role bindings), it checks project access through `createProjectAccess`, reading sessions from its own
map, and exposes that check as `access` for components to share. It exposes its session-end hook as `sessionEnd`
(`createSessionEndHook` from `@kantel/runtime`); pass it to `createMemorySandboxes`, `createMemoryBrowser`,
`createMemoryCapabilityRegistry` and `createMemoryVault`. The older `sandboxes` option registers the sandbox's
`releaseSession` as the `sandbox` teardown, so don't pass both.

It leaves out: persistence across restarts, workspaces and sandbox routing beyond `releaseSession`, history paging through
`watch`, and session titles changing after creation.

## Over HTTP

`@kantel/runtime/http` serves these contracts over HTTP as one portable fetch handler, with the caller taken from an
injected authenticator, `watch` as server-sent events and host tools served by signed HTTPS callbacks; its client
implements the same contracts, and the conformance suite runs through it. Routes and wire format are in
[HTTP.md](HTTP.md).

## Models

The runtime never calls a provider or holds a provider key: it calls Kantel's internal model gateway over pi-ai's
`pi-messages` protocol (`packages/models/CONTRACT.md`, contracts in `@kantel/contracts` `models.ts`). `@kantel/runtime/models` holds its side:

- `kantelResolveModel(choice)` gives `{ provider: "harbour", modelId }` (the provider ID from before the rename, kept: sessions store it in their model choices), where `modelId` is the route, or
  `<route>:<modelId>` when the profile chooses a model. The profile's `thinking` is the conversation's thinking level,
  which Pi Durable sends as the request's `reasoning` option.
- `kantelProvider({ baseUrl, fetch?, token })` is the pi-ai provider `harbour` (before the rename, as above) on API `pi-messages`. Its models come
  from `GET <baseUrl>/v1/config`; every request carries `Authorization: Bearer <token>` (read at each request) and
  goes through `fetch` when given, such as a Cloudflare service binding's.
- `kantelModels({ gateway: { baseUrl, fetch? }, tokens, ttlMs?, clock? })` gives each session its own `Models`, with
  only the `harbour` provider (its ID from before the rename, which sessions store). Its token is minted with `tokens.mint(systemContext("session"), scope, ttlMs)` for the
  session's organisation, project, agent and session, and minted again once half its lifetime has passed. The
  catalogue is loaded once, when the session opens; a gateway whose config can't be loaded fails the opening with
  `unavailable`, and the next use of the session tries again.

The runtime's `models` option takes a `Models` shared by every session, as before, or a function
`(session: SessionRecord) => Models | Promise<Models>` called as each session opens. A function needs `resolveModel`
(`invalid` otherwise); pass `kantelModels(...)` with `resolveModel: kantelResolveModel`. The scripted model of
`@kantel/runtime/testing` stays the default for tests and the conformance suites.

`packages/runtime/test/models.test.ts` runs the runtime against a toy gateway (a fetch handler serving `/v1/config` and
an SSE `/messages`) with fake session tokens: a prompt end to end, each session's own bearer and scope, the route or
`route:modelId` as the model, `thinking` as `reasoning`, a token minted again near expiry, a tool call streamed through
to a host tool, and an upstream `429` error event retried by Pi Durable on the same route.

The gateway itself is `packages/models` and `apps/model-gateway`; both targets wire `kantelModels` to it.

## Notes

- `close` aborts child sessions but doesn't close them.
- Pi types appear in the exports of `@kantel/runtime` (the projector, `hostToolAsPiTool`) for targets to reuse; hosts
  should import only `@kantel/contracts`.
- A host's tools are offered to the model only while the host is registered.
