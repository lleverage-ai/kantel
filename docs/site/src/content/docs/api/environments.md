---
title: Environments
description: Long-lived machines a project's sessions run commands on, with Docker and room for a whole dev stack, through bash's env argument. boat.dev provides them first.
---

An environment is a long-lived machine owned by a project, by default by one person in it. A session runs a command
on it by giving `bash` an `env` argument, the environment's alias (such as `dev`). Each session gets its own worktree
on the machine (`/home/user/kantel/worktrees/<session>`), its own `COMPOSE_PROJECT_NAME` and its own ten ports from
`KANTEL_PORT_BASE`, so sessions sharing a machine don't collide. `read`, `write` and `edit` are unchanged: they stay
on the session's own workspace.

An environment starts when a session first needs it and stops once no session has used it for the idle timeout; its
disk is kept. The console's Environments page shows each one's state, who holds it, how long it takes to wake, and
Start and Stop.

:::caution[Experimental]
Environments are off unless the deployment sets `KANTEL_ENVIRONMENTS=experimental`. Without it there are no routes
(`/v1/environments` answers 404), no Environments page and no `env` argument on `bash`. Only the self-hosted gateway
serves them yet.
:::

The routes are in the [Environments reference](/api/reference/environments/). The contract, including the provider
contract every machine provider implements, is `packages/contracts/src/environments.ts`.

## Settings

Each `KANTEL_*` setting is also read as `HARBOUR_*`.

| Variable | Default | What it does |
| --- | --- | --- |
| `KANTEL_ENVIRONMENTS` | off | `experimental` turns environments on. |
| `KANTEL_BOAT_API_KEY` | none | A boat.dev API key. With it, new environments are boat sandboxes. Use a key scoped to the `ci` actions, never an account key. |
| `KANTEL_ENVIRONMENTS_PROVIDER` | `boat` with a key, else `fake` | `fake` is an in-process stand-in for local runs and tests; it runs no process. |
| `KANTEL_BOAT_WEBHOOK_SECRET` | none | boat's webhook signing secret (`whsec_…`). With it, Kantel takes boat's signed deliveries at `POST /v1/environment-webhooks/boat`. Optional: Kantel reads a machine's state itself. |
| `KANTEL_BOAT_API_URL` | `https://boat.dev/api/v1` | boat's API, for a test server. |
| `KANTEL_ENVIRONMENTS_SHARING` | `person` | `person`: one person's sessions in a project share an environment. `exclusive`: one session at a time. |
| `KANTEL_ENVIRONMENTS_PLACEHOLDERS` | `unmanaged` | Whether connection placeholders work on machines whose network Kantel doesn't run. `unmanaged` lets them, through Kantel's proxy, and marks the environment's audit events `egress: unmanaged`; `off` refuses them. |
| `KANTEL_ENVIRONMENTS_IDLE_MINUTES` | `15` | Minutes an environment with no session on it waits before it stops. |

The self-hosted gateway keeps environments in its store (Postgres with `KANTEL_DATABASE_URL`, memory otherwise). With
Postgres, a restart still knows its machines and stops them when they idle.

## boat.dev

Kantel calls boat's REST API with the key above. Every sandbox is created and resumed with `noEnv`, so it holds none
of the boat account's logins, and Kantel refuses a machine that reports it does. Kantel stops a machine itself after
the idle timeout, and sets boat's own auto-stop to four hours as a backstop. Destroying an environment deletes its
sandbox and disk.

A key scoped to the `ci` actions carries `sandbox.create`, `sandbox.read`, `sandbox.stop`, `sandbox.resume`, `exec`,
`file.read`, `file.write` and `host`. Kantel doesn't register a webhook on the account itself.

## Create an environment and use it

```bash
curl -s -X POST "$KANTEL_URL/v1/environments" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"projectId": "<project ID>", "name": "lleverage-dev", "description": "Lleverage dev stack"}'
```

The environment belongs to the caller unless `projectWide` is true, and its alias is `dev` unless you give another. A
session of the owner's in the project then sees `env` on `bash`, with a line naming its environments, and runs a
command there with `{"command": "docker compose up -d", "env": "dev"}`. A command waits while a stopped environment
starts. Destroying an environment needs admin on its project.
