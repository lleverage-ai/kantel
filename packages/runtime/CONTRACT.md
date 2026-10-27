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

## Rules and the suite cases that enforce them

- Sessions and profiles belong to one organisation; others get `not_found` — "hides sessions and profiles from other
  organisations as not_found"; a profile for another organisation is `forbidden` — "keeps agent profiles per
  organisation and refuses one for another organisation".
- A created session is idle, keeps its labels, and lists newest first with project, label and paging filters — "lists a
  created session in its organisation with its labels, idle, and filters by project and labels".
- An unknown agent profile or parent is `not_found` — "refuses to create a session with an unknown agent profile as
  not_found".
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
- A name registers once (`conflict` otherwise), and closing the registration removes it — "session end: a teardown
  name is registered once, and closing its registration removes it".

### Project access (settled question 7; `projectAccess: true`)

Every call checks `ProjectAccess` before it acts. Reads (`get`, `list`, `children`, `wait`, `watch`, `snapshot`) need
`viewer`; `create`, `prompt`, `steer`, `followUp`, `abort`, `close`, `profiles.put` and `hostTools.register` need
`operator`. A project's profile is read with `viewer` on it; lists leave out what the caller may not see.

- "project access: refuses an operator outside the project every call on its sessions and profiles, and changes
  nothing".
- "project access: refuses an agent whose session belongs to another project, and changes nothing".
- An agent acts in its own session and on its children, not a sibling, and nowhere once its session is closed —
  "project access: an agent acts in its own session and supervises its children, never a sibling, and nowhere once its
  session is closed".
- "project access: a viewer on the project reads its sessions but cannot change them".

## The in-memory implementation

`createMemoryRuntime({ clock, audit, models, resolveModel, identity, sandboxes, pageSize })` from `@harbour/runtime/memory`
opens one Harness per session on Pi Durable's `MemoryStorage`. The profile's prompt layers become one system prompt
section, and the profile's tools that the host serves become Pi tools (`safe` tools replay; others do not). Input is
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

It leaves out: persistence across restarts, skills, memory
scopes, workspaces and sandbox routing beyond `releaseSession`, usage totals in snapshots, history paging through
`watch`, and session titles changing after creation.

## Open questions

- Should `close` also close child sessions, or only abort them as it does now?
- Pi types appear in the exports of `@harbour/runtime` (the projector, `hostToolAsPiTool`) for targets to reuse; hosts
  should import only `@harbour/contracts`.
- Should a host's tools be offered to the model only when registered (as now), or always, failing at call time?
