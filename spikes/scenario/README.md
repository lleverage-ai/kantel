# M0 spike scenario

The scripted task from the plan's [first spike](https://files.myslop.app/6278860afc/harbour-plan-v2-2026-10-27.html#spike), in a form any target can run: Cloudflare (`spikes/cloudflare`, M0-CF1) now, the self-hosted stack (M0-SH1, #4) next. A target passes when `run.ts` exits 0 against it.

- `research-task.json`: the scenario. Seed files, then nine scripted tool calls: list the workspace and fetch a page through the vault in the isolate, check the vault injects a header (and redacts it on the way back) and denies an unlisted host, write `notes/x.md` with the write tool, run git in the container on the same version, check the vault from the container, read the container's write back in the isolate, read the notes with the read tool. Each step says which tier must run it and what its output must contain.
- `run.ts`: sets up a session, optionally arms a crash, prompts, polls until the submission settles, then checks every step, both tiers, the vault audit and that the canary never appears in the transcript, fixture or exec log. With `--fixture` it saves the session fixture.
- `fixtures/research-task.cloudflare.json`: a recorded run on Cloudflare (Pi Durable entries, exec log, vault audit), for the console stream (M0-FE1).

```sh
HARBOUR_SPIKE_TOKEN=... HARBOUR_CANARY=... bun spikes/scenario/run.ts --base-url https://harbour-m0-cf1.<subdomain>.workers.dev
# crash test: kill the session owner right after the 2nd command commits, before its tool result is recorded
HARBOUR_SPIKE_TOKEN=... HARBOUR_CANARY=... bun spikes/scenario/run.ts --base-url ... --kill-after-exec 2
```

The model is scripted (pi-ai's faux provider): the next step is the number of completed tool results since the prompt, so it survives replay. An `interrupted` result does not count, so after a crash the script reissues the call that was cut off.

## The HTTP surface a target serves

All routes take `Authorization: Bearer <token>` and JSON bodies.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /sessions/:id/setup` | `{ scenario, workspaceId? }` | `{ sessionId, workspaceId, conversationId, head, timings }`. Creates the workspace from `scenario.seed` if it does not exist. |
| `POST /sessions/:id/prompt` | `{ content, requestId }` | `{ submissionId }`. The run continues in the background. |
| `GET /sessions/:id/state?submission=` | | `{ submission: { status }, toolResults[], answer?, workspace: { id, head }, execs[], events[] }`. `execs` is every sandbox command with its tier, base and resulting version and per-phase timings; `events` has `kill` and `reopen`. |
| `POST /sessions/:id/kill` | `{ afterExec: n }` | Crash the session owner right after the n-th next command has committed its workspace changes, before the tool result is recorded. |
| `POST /sessions/:id/exec` | `{ command, tier? }` | One sandbox command outside the model loop, for measurements. |
| `GET /sessions/:id/vault` | | The vault audit for the session: host, method, decision, injected header name (never the value), redactions. |
| `GET /sessions/:id/fixture` | | Entries, exec log, events and vault audit, as recorded. |
| `GET /sessions/:id/file?path=` | | One file at the current head. |

The self-hosted target can serve this from its session host; nothing in it is Cloudflare-specific.
