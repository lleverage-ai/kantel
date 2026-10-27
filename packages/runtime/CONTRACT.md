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

## The in-memory implementation

`createMemoryRuntime({ clock, audit, models, resolveModel, sandboxes, pageSize })` from `@harbour/runtime/memory`
opens one Harness per session on Pi Durable's `MemoryStorage`. The profile's prompt layers become one system prompt
section, and the profile's tools that the host serves become Pi tools (`safe` tools replay; others do not). Input is
placed as a `harbour.user` entry recording how it was sent. `ConversationProjector` (`project.ts`) diffs Pi's committed
view into protocol ops on a `createMemorySessionStream`; status is `running` while Pi has a run, `failed` after a model
error, `idle` otherwise and `done` after close. Audit: `session.created`, `session.prompted`, `session.steered`,
`session.aborted`, `session.tool.started`, `session.tool.finished`, with stable ids. `createScriptedModel()` from
`@harbour/runtime/testing` scripts pi-ai's faux provider for the suite.

It leaves out: persistence across restarts, permission checks (the operator role on the project), skills, memory
scopes, workspaces and sandbox routing beyond `releaseSession`, usage totals in snapshots, history paging through
`watch`, and session titles changing after creation.

## Open questions

- Who checks that the actor is an operator on the project: the runtime, or the gateway in front of it?
- Should `close` also close child sessions, or only abort them as it does now?
- Pi types appear in the exports of `@harbour/runtime` (the projector, `hostToolAsPiTool`) for targets to reuse; hosts
  should import only `@harbour/contracts`.
- Should a host's tools be offered to the model only when registered (as now), or always, failing at call time?
