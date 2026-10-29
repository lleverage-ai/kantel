# Session runtime

## What it is for

A session is one durable agent conversation, owned by an organisation and project and run with an agent profile.
Hosts create sessions, prompt, steer, follow up, abort, close and watch them, and serve host tools. Every session runs
on its own Pi Durable Harness; Pi types stay inside this package and never reach contracts or protocol.

## Records

- `SessionRecord`: organisation, project, agent, optional parent and workspace, title, status, labels, creator, times.
- `AgentProfile`: model route, prompt layers, tools, skills, sandbox policy, memory scopes and the serving host.
- `HostToolDefinition`: name, description, JSON schema and replay policy, registered per host.
- `Submission` and `RunResult`: one admitted input and how its run ended (`answered`, `failed`, `aborted`).

## Key operations

- `SessionRuntime`: `create`, `prompt`, `steer`, `followUp`, `abort`, `wait`, `watch`, `snapshot`, `close`.
- `SessionDirectory`: `get`, `list` (newest first, filtered, paged), `children`.
- `AgentProfiles`: `put`, `get`, `list`. `HostToolBridge`: `register` (returns a subscription), `list`.
- `SessionEndHook`: `register(name, teardown)`. The runtime runs every registered teardown when a session is closed or
  aborted; the in-memory components register as `sandbox`, `browser`, `capability` and `vault`.
- Proposed, implemented by the runtime and served over HTTP (`test/session-models.test.ts`, not yet in the suite):
  `SessionModels` (`listModels`, `modelState` and `startModels`: the `ModelOption`s a session's prompts may name,
  what it runs with and what its profile names, for a client's model and thinking pickers) and `PromptInput.model` and
  `PromptInput.thinking`. A choice is kept with the session's Pi Durable conversation (`configure`), so it applies
  from the next model call, to every later run, and after the session reopens; a level the model lacks is clamped
  with pi's `clampThinkingLevel`. `@harbour/ui`'s composer takes the same shapes.
- Proposed, not yet implemented: `PromptInput.attachments` (`PromptAttachment`, a reference to a file the host
  uploaded). The runtime and the HTTP handler ignore `attachments` until they adopt them, and still require `text`.
- Proposed (open question 15 in docs/contracts.md): `SessionHistory.history`, a session's transcript in pages, newest
  first, served as `history` on the runtime service and `GET /sessions/:id/history`. The `history:` suite cases run
  with `{ history: true }`: the latest page first and cursors back to the start without a repeat or a gap; pages
  behind a cursor unchanged while new turns arrive; `before` an item a client holds; `invalid` for a malformed
  request, `not_found` for an unknown item or session, and project access refusing an operator outside the project.
- Proposed (open question 16 in docs/contracts.md): `SessionBranching`, served as `branching` on the runtime service,
  `POST /sessions/:id/fork` (a new session with the history up to an answer) and `POST /sessions/:id/edit` (rewind
  to a person's message and prompt new words in its place, kept across a restart). No suite case yet; the runtime's
  `test/branching.test.ts` and `test/http.test.ts` cover it on the SQL and in-memory runtimes.

## Rules and the suite cases that enforce them

- Sessions and profiles belong to one organisation; others get `not_found` — "hides sessions and profiles from other
  organisations as not_found"; a profile for another organisation is `forbidden` — "keeps agent profiles per
  organisation and refuses one for another organisation".
- A created session is idle, keeps its labels, and lists newest first with project, label and paging filters — "lists a
  created session in its organisation with its labels, idle, and filters by project and labels".
- An unknown agent profile or parent is `not_found`, and a project's profile runs only in that project (`invalid`
  elsewhere) — "refuses to create a session with an unknown agent profile as not_found".
- A prompt runs the profile's model with its prompt layers joined in order; `wait` gives the answer; the snapshot
  shows the user and assistant items and status idle — "answers a prompt with the scripted text and shows the user and
  assistant items".
- The same `requestId` returns the same submission and asks the model once — "returns the same submission for a
  retried requestId and asks the model once".
- Watching sends hello, then a snapshot or the deltas after a cursor; deltas rebuild the snapshot — "streams hello and a
  snapshot, live deltas rebuild the final snapshot, and a reconnect resumes after a cursor".
- A host tool call carries the session, agent, stable call ID and arguments; its result reaches the model; the tool
  item ends `done` — "passes a host tool call to the host with the session, agent, call ID and arguments, and its result
  to the model".
- A profile tool the host does not serve gives the model an error result and the run goes on — "gives the model an
  error result for a profile tool the host does not serve, and the run still answers".
- A steer joins the running turn after its tool round and shows as a user item `via: "steer"` — "joins a steer sent
  while a host tool is blocked to the run after the tool round".
- A follow-up waits for the current run and starts the next — "starts a follow-up sent while busy after the current run
  answers".
- Abort ends the run `aborted`, aborts the host handler's signal, releases sandbox leases and leaves the session usable
  — "aborting while a host tool is blocked ends the run aborted, aborts the handler, releases sandbox leases and leaves
  the session usable".
- Aborting a parent aborts its children first — "aborting a parent aborts its running child session, which the
  directory lists under the parent".
- Close marks the session done and later input is `conflict` — "closing a session marks it done and refuses later
  prompts with conflict".

### Session end (settled question 8)

- Close runs every teardown once, in registration order, with a `system` context and a `SessionEnd` naming the
  session, project, agent, reason `session_ended` and who ended it; another session keeps what it holds; closing or
  aborting a closed session runs nothing — "session end: closing runs every registered teardown once for the session,
  which then holds nothing, and closing again runs none".
- Abort runs the teardowns (`aborted`) for each child, then the session, which stays usable — "session end: aborting
  runs the teardowns for each child and the session, which stays usable, and a second abort changes nothing".
- A failing teardown does not stop the others or fail the close; it is audited as `session.teardown.failed` with its
  name and error code, never its message — "session end: a failing teardown does not stop the others or fail the
  close, and is audited with its name and code but not its message".
- Closing a parent does not end a child it already closed — "session end: closing a parent does not end an already
  closed child again".
- One session's failure (an audit sink that is down, say) does not keep its siblings or parent from running their
  teardowns; the first failure is rethrown afterwards (unit test in `packages/runtime/test/session-end.test.ts`).
- A name registers once (`conflict` otherwise), and closing the registration removes it — "session end: a teardown
  name is registered once, and closing its registration removes it".

### Project access (settled question 7; `projectAccess: true`)

Every call checks `ProjectAccess` before it acts. Reads (`get`, `list`, `children`, `wait`, `watch`, `snapshot`) need
`viewer`; `create`, `prompt`, `steer`, `followUp`, `abort`, `close`, `profiles.put` and `hostTools.register` need
`operator`. A project's profile is read with `viewer` on it, and replacing it needs `operator` on its project too. A
host registers for the project its call names (or across the organisation); replacing a host registered elsewhere
needs `operator` there too, and listing a project's host needs `viewer` on it. Lists leave out what the caller may not
see.

- "project access: refuses an operator outside the project every call on its sessions and profiles, and changes
  nothing".
- "project access: refuses an agent whose session belongs to another project, and changes nothing".
- An agent acts in its own session and on its children, not a sibling, and nowhere once its session is closed —
  "project access: an agent acts in its own session and supervises its children, never a sibling, and nowhere once its
  session is closed".
- "project access: a viewer on the project reads its sessions but cannot change them".

## The runtime and its store

`createSessionRuntime({ store, storage, clock, audit, models, resolveModel, identity, sandboxes, leaseSweepMs, hostHandler, pageSize })`
from `@harbour/runtime/core` is the runtime every target runs. A target gives it two things:

- `store`, a `SessionStore` (`@harbour/runtime/store`): the directory of sessions (each with the profile it was created
  with, its sequence, abort count and whether it is closed), agent profiles, submissions and host registrations.
  `createMemorySessionStore()` keeps them in maps; `createSqlSessionStore(db, { prefix })` from `@harbour/runtime/sql`
  keeps them in any database behind chord's `SqliteDatabase` facade: Node's SQLite, a Durable Object's SQLite, or
  Postgres through the self-hosted target's translation of the SQLite dialect.
- `storage(record)`, which opens a session's Pi Durable storage. `sqlPiStorage(db, sessionId)` puts it in the same
  database under the session's own table prefix (`pi_<uuid without dashes>_`).

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

A host registration made in this process (`hostTools.register` with a handler) offers its tools only while its handler
lives. `hosts.register(ctx, hostId, tools, callback, owner)` stores the registration with its callback URL and HMAC
secret, and any later runtime on the store serves it through `hostHandler` (`callbackHostHandlers()` from
`@harbour/runtime/http`); only `owner` may remove it, and only while it is the host's current registration. The
session API takes the runtime's `hosts` as its `hosts` option and then keeps every `PUT /hosts/:id` this way. The
secret is stored with the registration, so the store is as sensitive as the secrets it holds.

## Skills and memory

`createSessionRuntime({ skills, memory })` gives sessions the read side of #12 (`src/context.ts`). Both are optional;
without them a session gets neither.

- `skills: { store, render?, mount?, visibility?, mountRoot? }`. On a session's first prompt the runtime calls
  `store.pinForSession` as the session's agent, over `visibility` (default the session's project), so later revisions
  reach only new sessions; calls `mount(session, pins)` once, for the host to mount the pins read-only at `/skills`
  (the `skills` source of `@harbour/workspace/mounts`, `ref` the session ID); and passes the listings of the skills the
  profile names (`profile.skills`, by skill ID or name) to the host's `render`, such as `renderSkillListings` from
  `@harbour/skills/sources`. Without `render` nothing is listed.
- `memory: { store, spaces?, recall?, now? }`. On the same first prompt it recalls over the profile's
  `memoryScopes` (each a memory space ID, or `spaces(profile, session)`) with the prompt's text as the query; the
  text is the memory implementation's `RecallRenderer`. A session with memory scopes gets `memory_search` and
  `memory_read` (`memoryCapabilities` of `@harbour/memory`, `safe`, served as the session's agent and audited as
  host `harbour.memory`); a host tool of the same name is not offered beside them.

Harbour adds no prompt of its own: the listing and the recall are the host's and the deployment's text, joined by a
blank line, placed once as a `harbour.context` entry before the first prompt, a user message for the model with the
pinned revisions, listed skill IDs and recall manifest as its data. It stays in the transcript, so later turns, a
retried prompt and a restarted runtime see what the session saw; it is not a protocol item. A pin, mount or recall
that fails fails the prompt, and the next prompt tries again.

## The in-memory implementation

`createMemoryRuntime({ clock, audit, models, resolveModel, identity, sandboxes, pageSize })` from `@harbour/runtime/memory`
is `createSessionRuntime` over `createMemorySessionStore()`, with one Harness per session on Pi Durable's
`MemoryStorage`. The profile's prompt layers become one system prompt
section, and are the whole of it: Harbour adds no text of its own, so a profile with no layers sends no system prompt; and the profile's tools that the host serves become Pi tools (`safe` tools replay; others do not). Input is
placed as a `harbour.user` entry recording how it was sent. `ConversationProjector` (`project.ts`) diffs Pi's committed
view into protocol ops on a `createMemorySessionStream`; status is `running` while Pi has a run, `failed` after a model
error, `idle` otherwise and `done` after close. Audit: `session.created`, `session.prompted`, `session.steered`,
`session.aborted`, `session.tool.started`, `session.tool.finished`, with stable ids. `createScriptedModel()` from
`@harbour/runtime/testing` scripts pi-ai's faux provider for the suite.

With `identity` (role bindings), it checks project access through `createProjectAccess`, reading sessions from its own
map, and exposes that check as `access` for components to share. It exposes its session-end hook as `sessionEnd`
(`createSessionEndHook` from `@harbour/runtime`); pass it to `createMemorySandboxes`, `createMemoryBrowser`,
`createMemoryCapabilityRegistry` and `createMemoryVault`. The older `sandboxes` option registers the sandbox's
`releaseSession` as the `sandbox` teardown, so don't pass both.

It leaves out: persistence across restarts, workspaces and sandbox routing beyond `releaseSession`, usage totals in snapshots, history paging through
`watch`, and session titles changing after creation.

## Over HTTP

`@harbour/runtime/http` serves these contracts over HTTP as one portable fetch handler, with the caller taken from an
injected authenticator, `watch` as server-sent events and host tools served by signed HTTPS callbacks; its client
implements the same contracts, and the conformance suite runs through it. Routes and wire format are in
[HTTP.md](HTTP.md).

## Models

The runtime never calls a provider or holds a provider key: it calls Harbour's internal model gateway over pi-ai's
`pi-messages` protocol ([docs/model-connectors.md](../../docs/model-connectors.md), contracts in
`@harbour/contracts` `models.ts`). `@harbour/runtime/models` holds its side:

- `harbourResolveModel(choice)` gives `{ provider: "harbour", modelId }`, where `modelId` is the route, or
  `<route>:<modelId>` when the profile chooses a model. The profile's `thinking` is the conversation's thinking level,
  which Pi Durable sends as the request's `reasoning` option.
- `harbourProvider({ baseUrl, fetch?, token })` is the pi-ai provider `harbour` on API `pi-messages`. Its models come
  from `GET <baseUrl>/v1/config`; every request carries `Authorization: Bearer <token>` (read at each request) and
  goes through `fetch` when given, such as a Cloudflare service binding's.
- `harbourModels({ gateway: { baseUrl, fetch? }, tokens, ttlMs?, clock? })` gives each session its own `Models`, with
  only the `harbour` provider. Its token is minted with `tokens.mint(systemContext("session"), scope, ttlMs)` for the
  session's organisation, project, agent and session, and minted again once half its lifetime has passed. The
  catalogue is loaded once, when the session opens; a gateway whose config can't be loaded fails the opening with
  `unavailable`, and the next use of the session tries again.

The runtime's `models` option takes a `Models` shared by every session, as before, or a function
`(session: SessionRecord) => Models | Promise<Models>` called as each session opens. A function needs `resolveModel`
(`invalid` otherwise); pass `harbourModels(...)` with `resolveModel: harbourResolveModel`. The scripted model of
`@harbour/runtime/testing` stays the default for tests and the conformance suites.

`packages/runtime/test/models.test.ts` runs the runtime against a toy gateway (a fetch handler serving `/v1/config` and
an SSE `/messages`) with fake session tokens: a prompt end to end, each session's own bearer and scope, the route or
`route:modelId` as the model, `thinking` as `reasoning`, a token minted again near expiry, a tool call streamed through
to a host tool, and an upstream `429` error event retried by Pi Durable on the same route.

What remains for lane 5 is the gateway itself: `packages/models` and `apps/model-gateway` (token verification, route
resolution and pinning, connector presets, the vault credential read, redaction, usage and audit), its conformance
suites, and the targets wiring `harbourModels` to it. Until then no target passes `harbourModels`.

## Open questions

- Should `close` also close child sessions, or only abort them as it does now?
- Pi types appear in the exports of `@harbour/runtime` (the projector, `hostToolAsPiTool`) for targets to reuse; hosts
  should import only `@harbour/contracts`.
- Should a host's tools be offered to the model only when registered (as now), or always, failing at call time?
- How the runtime reads a `PromptAttachment`'s bytes: through the host that uploaded it (a host tool or a signed URL),
  or from a store the platform owns. See open question 14 in docs/contracts.md.
