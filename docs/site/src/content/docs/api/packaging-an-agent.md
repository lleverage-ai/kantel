---
title: Packaging an agent
description: Assemble an agent on Partan from a profile, skills, memory, rules, host tools and schedules, with Sal and Erys as worked examples.
---

On Partan an agent is not a program you deploy. Partan runs the model loop; your agent is a set of records that tell
it what to run with, plus the tools your own app serves. This page lists those records and walks through two personal
agents: Sal, which has parts running on Partan, and Erys, which does not run on Partan yet.

:::note
There is no single package format or endpoint that installs a whole agent. You make each record with its own call,
usually from a script in your app. Package and variable names in code still use the old name, `harbour`.
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

Partan adds no system prompt of its own. A session's system prompt is its prompt layers joined by blank lines: the
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

A project's profile needs `operator` on that project. An organisation-wide profile needs an organisation-wide role,
which API keys don't hold yet. A session keeps the profile it was created with. The route is not in the generated SDK
yet; use HTTP or `profiles.put` on the [`@harbour/runtime/http` client](/api/host-tools/#register-from-typescript).

```sh
curl -s -X PUT "$PARTAN_URL/v1/profiles/research-worker" \
  -H "authorization: Bearer $PARTAN_API_KEY" \
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

## Worked example: Sal

Sal is a personal agent for delegated work, built on Pi: it supervises worker sessions that take on tasks in the
background.

### Loading Sal's skills and memory

`examples/sal-worker` in the Partan repository turns Sal's memory bundle (concept files in a Git repository) into a
memory snapshot, and its skill sources, pinned at a commit or by a digest, into skill packages, as Pi discovers them.
`scripts/import-to-harbour.ts` loads them into a deployed Partan:

1. An organisation admin mints an `operator` key on the project with the `import` permission (`POST /v1/keys` with
   `"permissions": ["import"]`; the console's API keys page doesn't offer permissions) and creates the `Sal memory` space once, since
   creating a space is still the admin's.
2. Run the script with a config naming the memory repository and commit and the skill sources in Pi's order:

   ```sh
   env HARBOUR_URL=$PARTAN_URL HARBOUR_API_KEY=$PARTAN_API_KEY \
     node examples/sal-worker/scripts/import-to-harbour.ts --config sal.json --profile research-worker
   ```

   It imports each skill with `POST /v1/skills/import`, loads the bundle with
   `POST /v1/memory/spaces/{spaceId}/snapshot`, and with `--profile` puts the skills and the space on that project
   profile. A second run at the same commits publishes nothing new. `--out requests.json` writes the requests instead.

A parity harness in the same example (`scripts/parity.ts`) checks that a Partan Sal worker gets the same recall,
skills and skills listing as a local Sal worker for the same task.

### Running Sal's workers on Partan

Sal's own code has an experimental placement, off by default, that runs a labelled task's model loop as a Partan
session while Sal keeps dispatching and supervising it. For each run, the worker:

- puts a project profile, `sal-worker-<run>`, whose prompt layers are Sal's own worker context (preamble, repository
  instructions, memory and recall), whose `tools` are the host tools below, with no sandbox tiers, and whose `hostId`
  is `sal-<run>`;
- registers host `sal-<run>` with `hostTools.register`: `task_outcome`, Sal's memory tools, the task's capability
  tools and file tools confined to the task's workspace, with only read-only tools marked `safe`;
- creates a session labelled `sal.run` and `sal.task`, sends each turn with a request ID, and aborts or closes it when
  Sal stops or cancels the run.

Sal copies Partan's contracts and HTTP client into its own repository, since they aren't published.

## Worked example: Erys

Erys is a named assistant for each person, running on Cloudflare with one Durable Object per agent. Erys does not run
on Partan; none of its code calls Partan. This is how its parts would map:

| Erys | On Partan |
| --- | --- |
| One agent per person | An organisation-wide profile, and organisation-scoped sessions with `userId` naming the person |
| Conversations | Sessions, labelled with Erys's conversation ID |
| Its system prompt, with the agent's and person's names | Prompt layers, and the person's own prompt rules |
| Memory the agent saves and the person edits | A user-owned memory space in `memoryScopes`. A session's agent reads it with `memory_search` and `memory_read`; it has no tool to save to it |
| Schedules for the person | `task` schedules, which a person or your app creates; agents may not create schedules |
| Computers | The `container` sandbox tier |
| Keys and accounts the person approves | Vault items, user-owned ones included; approvals inside a host app aren't built yet |
| Tools that act in Erys's own app | Host tools |
| Delegated and background work | Subagents, experimental on Cloudflare (`HARBOUR_SUBAGENTS=on`), which run as child sessions |
| Sign-in, notifications and settings | Stay in Erys's app |

Running Erys this way needs pieces Partan doesn't have yet, listed on the [gaps page](/gaps/): organisation-wide API
keys, external identities, a memory tool for saving, and approvals in a host app.

<!-- Sources (8584d5b): packages/contracts/src/session.ts:53-79, packages/contracts/src/sandbox.ts:17-25, packages/contracts/src/rules.ts:100-108, packages/runtime/src/runtime.ts:598-612,858-865,1843-1893, packages/runtime/src/index.ts:47-53, packages/runtime/src/context.ts:1-17, packages/runtime/CONTRACT.md:196-238, packages/runtime/src/http/server.ts:620-636, packages/skills/src/sources.ts:180-197, apps/cloudflare/README.md:143-144, apps/cloudflare/src/stack.ts:138,148-152,662-693, apps/cloudflare/src/coding-tools.ts:43, apps/cloudflare/src/import-access.ts:1-10, apps/cloudflare/src/schedules.ts:1-15, packages/schedules/src/handlers.ts:66-80, packages/schedules/CONTRACT.md:66-67, packages/memory/CONTRACT.md:1-25,94-105, docs/design/public-api.md:62-73, docs/design/org-scope.md:20-40,71-96,112-128, docs/design/org-api-keys.md:1-25, docs/design/public-api.md:175-178, packages/memory/CONTRACT.md:20-23, packages/api/generated/sdk.ts:482-521,681-694,1040-1057, examples/sal-worker/README.md:1-114, examples/sal-worker/src/worker.ts:30-40,87-140, examples/sal-worker/scripts/import-to-harbour.ts:1-35,135-204, examples/sal-worker/scripts/harbour-sal.ts:1-18, examples/sal-worker/scripts/parity.ts:1-9, examples/sal-worker/scripts/sal-local.ts:1-16. Sal (tvdavies/sal origin/main 9b3bf24): docs/design/harbour-placement.md, src/harbour/worker.ts:77-80,330-470, src/harbour/host-tools.ts:1-30,156. Erys (erys-ai/erys main 50d31b1): README.md, AGENTS.md, docs/PLAN.md, apps/agent/README.md, apps/agent/src/pi/prompt.ts, apps/agent/src/brain.ts:1-30, apps/agent/src/schedules.ts:1-30, apps/agent/src/profile.ts:1-20, apps/app/README.md -->
