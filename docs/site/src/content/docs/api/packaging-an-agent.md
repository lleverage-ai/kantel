---
title: Packaging an agent
description: Assemble an agent on Kantel from a profile, skills, memory, rules, host tools and schedules, with a worked example that imports skills and memory from Git.
---

On Kantel an agent is not a program you deploy. Kantel runs the model loop; your agent is a set of records that tell
it what to run with, plus the tools your own app serves. This page lists those records and walks through an example that
loads an agent's skills and memory from Git and runs its work as sessions.

:::note
There is no single package format or endpoint that installs a whole agent. You make each record with its own call,
usually from a script in your app. Settings named `HARBOUR_*` from before the rename still work when the `KANTEL_*` one isn't set.
:::

## What an agent is made of

| Part | What it gives the agent | How you make it |
| --- | --- | --- |
| Agent profile | Model, prompt layers, tool list, sandbox tiers, skills, memory scopes, host | `PUT /v1/profiles/{agentId}` |
| Skills | Instructions it lists and reads at `/skills` | `POST /v1/skills/import` ([Skills](/console/skills/)) |
| Memory | Recall on the first prompt, and `memory_search` and `memory_read` | `POST /v1/memory/spaces/{spaceId}/snapshot` ([Memory](/console/memory/)) |
| Prompt rules | Layers around the profile's own, per organisation, project or user | `PUT /v1/rules` ([Prompt rules](/console/prompt-rules/)) |
| Host tools | Actions your app performs, such as recording an outcome | `PUT /v1/hosts/{hostId}` ([Host tools](/api/host-tools/)) |
| Schedules | Recurring work: a `task` schedule starts a session with a prompt | `POST /v1/schedules` ([Schedules](/console/schedules/)) |
| Sessions | One conversation each, labelled with your app's references | `POST /v1/sessions` ([Quick start](/api/quick-start/)) |

## What the model sees

Kantel adds no system prompt of its own. A session's system prompt is its prompt layers joined by blank lines: the
platform's, the organisation's and the project's prompt rules, the profile's own `promptLayers`, then the rules of the
user the session works for. The rules are fixed when the session is created. With no layers and no rules there is no
system prompt.

On the first prompt, the session also gets the listing of the skills the profile names (in Pi's
`<available_skills>` format) and the recall from its memory spaces. Tools describe themselves through their names,
descriptions and schemas.

## The agent profile

`PUT /v1/profiles/{agentId}` stores the whole profile and answers it; a malformed one is `400`.

| Field | What |
| --- | --- |
| `id`, `organisationId` | The agent ID (as in the path) and your organisation (`GET /v1/me` gives it) |
| `projectId` | The profile's project; absent for an organisation-wide profile, which runs in every project and in organisation sessions |
| `name` | A display name |
| `model` | `{ route, modelId?, thinking? }`: a route your deployment defines, such as `default` |
| `imageModel` | Optional route for the `generate_image` tool |
| `promptLayers` | `[{ name, text }]`, joined in order |
| `tools` | Built-in tools such as `read`, `write`, `edit`, `ls` and `bash`, and your host tools |
| `skills` | Skill IDs or names to list |
| `sandbox` | `{ tiers }`, from `isolate` and `container` |
| `memoryScopes` | Memory space IDs to recall from |
| `hostId` | The host serving the host tools in `tools` |

A project's profile needs `operator` on that project. An organisation-wide profile needs an organisation-wide role:
an [organisation key](/api/authentication/#organisation-keys) with `operator`, or a person. A session keeps the profile
it was created with. The route is not in the generated SDK
yet; use HTTP or `profiles.put` on the [`@kantel/runtime/http` client](/api/host-tools/#register-from-typescript).

```sh
curl -s -X PUT "$KANTEL_URL/v1/profiles/research-worker" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"id": "research-worker", "organisationId": "<organisation ID>", "projectId": "<project ID>",
       "name": "Research worker", "model": {"route": "default"},
       "promptLayers": [{"name": "role", "text": "You research questions and record what you found."}],
       "tools": ["read", "write", "ls", "record_outcome"], "skills": [],
       "sandbox": {"tiers": ["isolate"]}, "memoryScopes": [], "hostId": "my-app"}'
```

:::caution
On Cloudflare the default `assistant` profile is rewritten each time the deployment starts. Its prompt layers, skills,
memory scopes and image model are kept; its tools, sandbox and model are reset and `hostId` is dropped.
:::

## Worked example: skills and memory from Git

`examples/sal-worker` in the Kantel repository turns a memory bundle (concept files in a Git repository) into a
memory snapshot, and skill sources, pinned at a commit or by a digest, into skill packages, as Pi discovers them.
`scripts/import-to-kantel.ts` loads them into a deployed Kantel:

1. An organisation admin mints an `operator` key on the project with the `import` permission (`POST /v1/keys` with
   `"permissions": ["import"]`; the console's API keys page doesn't offer permissions) and creates the memory space
   once, since creating a space needs an admin.
2. Run the script with a config naming the memory repository and commit and the skill sources in Pi's order:

   ```sh
   env KANTEL_URL=$KANTEL_URL KANTEL_API_KEY=$KANTEL_API_KEY \
     node examples/sal-worker/scripts/import-to-kantel.ts --config sal.json --profile research-worker
   ```

   It imports each skill with `POST /v1/skills/import`, loads the bundle with
   `POST /v1/memory/spaces/{spaceId}/snapshot`, and with `--profile` puts the skills and the space on that project
   profile. A second run at the same commits publishes nothing new. `--out requests.json` writes the requests instead.

A parity harness in the same example (`scripts/parity.ts`) checks that a session on Kantel gets the same recall,
skills and skills listing as a local Pi worker for the same task.

### Running each task as a session

An app that hands tasks to an agent and supervises them can run each task's model loop as a Kantel session. For each
task it:

- puts a project profile for the task, whose prompt layers carry its own context, whose `tools` are its host tools,
  and whose `hostId` names the host below;
- registers that host with `hostTools.register`: the tools that record the task's outcome and act in the app, with
  only read-only tools marked `safe` ([Host tools](/api/host-tools/));
- creates a session labelled with the task's IDs, sends each turn with a request ID, and aborts or closes it when the
  app stops or cancels the task.

An app for one person per agent uses an [organisation key](/api/authentication/#organisation-keys) instead, with an
organisation-wide profile and organisation sessions whose `userId` names the person. An organisation key holds at
most `operator`, so an organisation admin, signed in as a person, still creates vault items and prompt rules. A
session's agent reads memory with `memory_search` and `memory_read` but has no tool to save to it, and agents can't
create schedules.

<!-- Sources (8584d5b, rechecked at ba80016): packages/contracts/src/session.ts:53-79, packages/contracts/src/sandbox.ts:17-25, packages/contracts/src/rules.ts:100-108, packages/runtime/src/runtime.ts:598-612,858-865,1843-1893, packages/runtime/src/index.ts:47-53, packages/runtime/src/context.ts:1-17, packages/runtime/CONTRACT.md:196-238, packages/runtime/src/http/server.ts:620-636, packages/skills/src/sources.ts:180-197, apps/cloudflare/README.md:143-144, apps/cloudflare/src/stack.ts:138,148-152,662-693, apps/cloudflare/src/coding-tools.ts:43, apps/cloudflare/src/import-access.ts:1-10, apps/cloudflare/src/schedules.ts:1-15, packages/schedules/src/handlers.ts:66-80, packages/schedules/CONTRACT.md:66-67, packages/memory/CONTRACT.md:1-25,94-105, packages/api/generated/sdk.ts:482-521,681-694,1040-1057, examples/sal-worker/README.md:1-114, examples/sal-worker/src/worker.ts:30-40,87-140, examples/sal-worker/scripts/import-to-kantel.ts:1-35,135-204, examples/sal-worker/scripts/parity.ts:1-9 -->
