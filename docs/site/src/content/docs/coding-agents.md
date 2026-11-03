---
title: Use from your coding agent
description: Let Claude Code, Codex or pi make and drive Kantel sandboxes from your machine, with a key for the agent, Kantel's MCP server or a skill to copy in, and an AGENTS.md snippet.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The agent drives Kantel through the compute API, which a control plane serves only when it runs with `KANTEL_COMPUTE=experimental`. Its shapes may still change.
:::

A coding agent on your machine can do its risky or heavy work in a Kantel sandbox instead of on your laptop: run a test suite on a clean Linux, try a migration, start Docker, open a browser, or fork five copies to try five fixes. The agent stays where it is and reaches Kantel in one of two ways:

- through Kantel's [MCP server](/tools/mcp-server/), which Claude Code and Codex take;
- with a skill that teaches it Kantel's API over `curl`, which works in any agent that runs shell commands, pi included.

You set it up once: a key for the agent, the MCP server or the skill, and a few lines in `AGENTS.md`.

## 1. Give the agent a key

Make a key with the `agent` preset, which can make, drive, stop and snapshot sandboxes but can't delete them or change your account. Make it with a key of yours that holds `account:admin`, such as your install's [first key](/accounts/api-keys/#make-your-first-key). With the [`kantel` command](/tools/cli/), signed in with that key:

```sh
kantel key create coding-agent --preset agent --expires-days 30
```

or with `curl`:

```sh
curl -s "$KANTEL_URL/v1/api-keys" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name": "coding-agent", "preset": "agent", "expiresInDays": 30}' | jq -r .secret
```

Put the address and the new secret where the agent's shell will see them, such as your shell's profile:

```sh
export KANTEL_URL=http://127.0.0.1:58090
export KANTEL_API_KEY=ksk_...
```

In fish, put `set -gx KANTEL_URL http://127.0.0.1:58090` and `set -gx KANTEL_API_KEY ksk_...` in `~/.config/fish/config.fish`.

For Claude Code you can instead set them only for Claude, in the `env` of `~/.claude/settings.json`:

```json
{ "env": { "KANTEL_URL": "http://127.0.0.1:58090", "KANTEL_API_KEY": "ksk_..." } }
```

## 2. Connect it over MCP

For Claude Code or Codex, [install the `kantel` command](/tools/cli/#install-it) and add its MCP server, with your control plane's address in place of `http://127.0.0.1:58090`:

```sh
# Claude Code
claude mcp add kantel -e KANTEL_URL=http://127.0.0.1:58090 -e KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp
# Codex
codex mcp add kantel --env KANTEL_URL=http://127.0.0.1:58090 --env KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp
```

The agent then has tools such as `sandbox_create`, `sandbox_exec` and `file_write`. [MCP server](/tools/mcp-server/) lists them all and covers Cursor and other clients. With MCP in place you can skip the skill and go to [step 4](#4-add-the-agentsmd-snippet).

### pi and the kantel command

pi doesn't take MCP servers. It runs the `kantel` command through its shell instead: install the command, start pi with `KANTEL_URL` and `KANTEL_API_KEY` set as in step 1, and either add the skill below or run `kantel agents --write` in your repository. That adds a block to `AGENTS.md` that tells pi how to make a sandbox, run commands in it, move files and stop it with the command.

## 3. Or add the skill

The skill needs nothing installed but `curl` and `jq`, so it suits any agent. A skill is a folder with a `SKILL.md` that the agent reads when a task needs it. Save the file below as `~/.agents/skills/kantel/SKILL.md`, which Codex and pi both read. For Claude Code, link the folder into its skills too:

```sh
mkdir -p ~/.agents/skills/kantel ~/.claude/skills
# save SKILL.md into ~/.agents/skills/kantel/, then:
ln -s ~/.agents/skills/kantel ~/.claude/skills/kantel
```

| Agent | Reads skills from |
| --- | --- |
| Claude Code | `~/.claude/skills/`, or `.claude/skills/` in a project |
| Codex | `~/.agents/skills/`, or `.agents/skills/` in a project |
| pi | `~/.agents/skills/` and `~/.pi/agent/skills/`, or `.pi/skills/` in a project |

`~/.agents/skills/kantel/SKILL.md`:

````md
---
name: kantel
description: Run code in a Kantel sandbox, a Linux machine on our Kantel control plane, instead of on this computer. Use for running tests or builds on a clean machine, anything that needs root, Docker or a browser, risky commands, or trying several approaches in parallel with forks.
---

# Kantel sandboxes

Call Kantel's API with curl. `KANTEL_URL` and `KANTEL_API_KEY` are set in the environment. Never print the key or put it in a file, a command's env or a sandbox.

Every call sends `-H "authorization: Bearer $KANTEL_API_KEY"`, and calls with a body add `-H "content-type: application/json"`. Answers are JSON; use jq.

## Make a sandbox

    curl -s "$KANTEL_URL/v1/sandboxes" -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
      -d '{"type": "microvm", "name": "<short-task-name>", "labels": {"agent": "coding-agent"}, "wait": true}' | jq '{id, state}'

- `type`: `microvm` is a full Linux machine with root, Docker and a browser. `isolate` starts at once but runs only a JavaScript shell over files.
- `"from": "<saved-snapshot-name>"` starts from a template someone saved. List them with `GET /v1/snapshots?kind=saved`.
- It stops by itself after 60 minutes. Give longer with `PATCH /v1/sandboxes/<id>` and `{"extendMinutes": 120}`.
- Reuse a sandbox you made earlier in this task: `GET /v1/sandboxes?all=true&label.agent=coding-agent`.

## Run commands

    curl -s "$KANTEL_URL/v1/sandboxes/<id>/commands" -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
      -d '{"command": "cd app && npm test", "timeoutMs": 300000}' | jq '{state, exitCode, stdout, stderr, truncated}'

- Commands run with `bash -lc` in the user's home. Check `exitCode`; the HTTP status is 200 even when the command fails.
- Default timeout 30 s, at most 600000 ms. `state: "timed_out"` means it was killed.
- For servers and long jobs add `"detached": true`, keep the returned `id`, and read it with `GET /v1/sandboxes/<id>/commands/<commandId>`. Stop it with `DELETE` on the same path.
- Output is capped at 1 MiB per stream: redirect big output to a file and read the file.

## Files

- Read: `GET /v1/sandboxes/<id>/files?path=<path>` → `.content` (add `&encoding=base64` for binary). Up to 1 MiB.
- Write: `PUT /v1/sandboxes/<id>/files` with `{"path": "...", "content": "...", "mode": "0755"}`.
- List: `GET /v1/sandboxes/<id>/files/list?path=<dir>`. Delete: `DELETE /v1/sandboxes/<id>/files?path=<path>`.
- To get code in, prefer `git clone` inside the sandbox over writing files one by one.

## See what it serves

- Public URL for a port: `POST /v1/sandboxes/<id>/ports` with `{"port": 3000}` → `.url`. The URL carries a token: give it only to the user.
- Browser: `POST /v1/sandboxes/<id>/browser` with `{}` → `.url` (live view for the user) and `.cdpUrl` (Playwright `chromium.connectOverCDP`).

## Several attempts at once

Fork a prepared sandbox: `POST /v1/sandboxes/<id>/fork` with `{"count": 3, "wait": true}` → `.items[].id`. Each copy starts from the source's newest snapshot.

## When you're done

- Stop the sandbox: `POST /v1/sandboxes/<id>/stop` with `{}`. Its disk is kept; resume with `POST /v1/sandboxes/<id>/resume`.
- To keep a set-up state as a template, ask the user first, then `POST /v1/snapshots` with `{"name": "<name>", "sandboxId": "<id>"}`.
- This key can't delete sandboxes. Tell the user the IDs of sandboxes you made.

## Errors

Errors are `{"error": {"code": "...", "message": "..."}}`. `conflict`: the sandbox is in the wrong state, such as stopped (resume it). `exhausted`: a limit or full hosts; wait and retry. `not_supported`: the sandbox's type can't do it; check `.capabilities`. `forbidden`: the key lacks the scope; tell the user.

Full docs: https://kantel.dev/docs/llms.txt
````

## 4. Add the AGENTS.md snippet

The MCP server or the skill says how; a line in your project's instructions says when. Add this to `AGENTS.md` at the root of a repository, which Codex and pi read:

```md
## Sandboxes

Run tests, builds, Docker and anything that changes the system in a Kantel sandbox, not on this machine: use the `kantel` MCP tools or the `kantel` skill. Make one microVM per task, labelled with the task, reuse it while the task lasts, and stop it when you're done. Never print `KANTEL_API_KEY`.
```

Claude Code reads `CLAUDE.md` rather than `AGENTS.md`. Put one line in `CLAUDE.md` to pull the same file in:

```md
@AGENTS.md
```

To use it in every project, put the snippet in your agent's own instructions file instead: `~/.claude/CLAUDE.md` for Claude Code, `~/.codex/AGENTS.md` for Codex and `~/.pi/agent/AGENTS.md` for pi.

## 5. Let the agent reach Kantel

- **Claude Code** asks before each MCP tool call and each `curl`. To let the MCP server's tools run without asking, add `"mcp__kantel"` to `permissions.allow` in your settings. With the skill, add `"Bash(curl:*)"` instead, if you're happy for it to run `curl` freely.
- **Codex** blocks network access from the commands it runs in its default sandbox, which the skill needs. Allow it in `~/.codex/config.toml`:

  ```toml
  [sandbox_workspace_write]
  network_access = true
  ```

- **pi** runs commands without a sandbox of its own, so it reaches Kantel as it is.

## Try it

Ask the agent something like: "Run this repository's tests in a Kantel sandbox and tell me what fails." It should make a sandbox, clone or copy the code in, run the tests, report, and stop the sandbox.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:318-712, packages/api/src/compute-routes.ts:843-857, packages/api/src/compute-schema.ts:365-404, packages/api/src/compute-schema.ts:506-548, packages/api/src/compute-schema.ts:802-812, packages/api/src/compute-schema.ts:1214-1239 -->
