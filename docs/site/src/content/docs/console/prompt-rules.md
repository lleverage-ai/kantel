---
title: Prompt rules
description: Add standing instructions for every new session at organisation, project or personal level, and preview the prompt a new session gets.
---

Prompt rules are named pieces of text that Kantel adds around an agent's own prompt when a session is created. Use them
for instructions every session should follow: house style for the organisation, conventions for one project, or your
own preferences.

## What a session's system prompt is made of

Kantel adds no system prompt of its own. A session's system prompt is its prompt layers, joined in order with a blank
line between each, and nothing else:

1. Platform rules
2. The organisation's rules
3. The project's rules (a project session only)
4. The agent profile's own prompt layers
5. The rules of the person the session works for

Within each owner, rules go by their order (lowest first), then by name. An organisation session, which works above
every project, has no project layer. The platform layer is empty unless your deployment's operator writes to it:
Kantel adds no rules of its own.

Two other things reach the model at the start of a session, but neither is part of the system prompt: the skills
listing and memory recall. They go into the transcript before the first prompt, as one `harbour.context` entry (a user
message). See [Skills](/console/skills/) and [Memory](/console/memory/). Code mode adds no prompt section either; the
tool's own description covers it.

## When rules apply

A session's rules are fixed when it is created. Kantel keeps the resulting layers with the session's copy of its agent
profile, so a restart or a fork runs exactly the same prompt. When you add, change or remove a rule, only new sessions
get the change; running sessions keep the rules they started with.

## Who may change rules

| Owner | Who may change them | Who may read them |
| --- | --- | --- |
| Platform | Only the deployment's operator (a system caller) | Every organisation |
| Organisation | An organisation-wide admin | The organisation's members |
| Project | An admin on the project, or an organisation-wide admin | Viewers of the project |
| Person | That person, or an organisation-wide admin | The organisation's members |

Agents never write rules. Every change is recorded in the [audit log](/console/audit/) as `rules.rule.put` or
`rules.rule.removed`, with the rule's ID and owner but never its text.

## The rules page

The rules page is at `/rules`. Its heading reads "Rules are added around every new session's prompt, in this order:
platform, organisation, project, the agent's own prompt, then yours. Running sessions keep the rules they started
with."

**Whose rules** picks the rules to show: Platform, Organisation, Project or Yours. For Project, pick the project
from **Project**. Platform rules are read-only in the console.

Each rule shows its name, its order and its text, with **Edit** and **Remove**. The console shows these buttons to
everyone; the server checks each change, and a refusal appears on the rule.

### Add a rule

1. Choose **Whose rules**, and the project if needed.
2. Choose **Add rule**.
3. Fill in:
   - **Name**: letters, digits, dots, underscores and hyphens, 1 to 100 characters, starting with a letter or
     digit. If the owner already has a rule of that name, the form says so, and saving replaces it.
   - **Order**: a whole number, lowest first; ties go by name. The default is 0.
   - **Text**: up to 32,768 characters.
4. Choose **Add rule**.

The page confirms "New sessions get it; running ones keep the rules they started with."

### Edit or remove a rule

**Edit** opens the same form; the name can't change. To rename a rule, add it under the new name and remove the old
one. Choose **Save** when you're done.

**Remove** asks "Remove this rule? New sessions stop getting it; running ones keep it." Choose **Remove rule** to
confirm.

## Preview what a new session gets

The **Preview** section shows "What a new session would get, in order." Pick where the session would run with
**A new session in**: "The organisation, in no project", or a project. The list shows each rule with its layer, and
"The agent's own prompt" at its place between the project's rules and yours. Open a rule to read its text. If no
rules apply, the preview says a new session gets only its agent's own prompt.

The preview is for you as the session's person. A session started for someone else gets their personal rules instead.

## Rules in the API

| Route | What it does |
| --- | --- |
| `GET /v1/rules?owner=&projectId=&userId=` | List one owner's rules, in order. |
| `GET /v1/rules/resolved?projectId=&userId=` | The rules a new session would get. |
| `GET /v1/rules/{ruleId}` | One rule. |
| `PUT /v1/rules` | Create the owner's rule of that name, or replace its text and order. |
| `DELETE /v1/rules/{ruleId}` | Remove a rule. |

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({
  baseUrl: `${process.env.KANTEL_URL}/v1`,
  token: process.env.KANTEL_API_KEY,
});

await kantel.putPromptRule({
  owner: { kind: "project", organisationId: "org_…", projectId: "prj_…" },
  name: "british-english",
  text: "Write in British English.",
  order: 10,
});

const rules = await kantel.resolvePromptRules({ projectId: "prj_…" });
```

```sh
curl -s "$KANTEL_URL/v1/rules/resolved?projectId=prj_…" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

See the [API reference](/api/reference/).

<!-- Sources (8584d5b): packages/rules/CONTRACT.md:1-62, packages/contracts/src/rules.ts:80-108, packages/runtime/src/runtime.ts:597-612, packages/runtime/src/runtime.ts:858-865, packages/runtime/src/index.ts:48-53, packages/runtime/src/context.ts:12-16, apps/selfhosted/src/gateway/skills-memory.ts:10-12, apps/cloudflare/README.md:143-144, apps/console/src/app/rules-screen.tsx:36-525, apps/console/src/app/router.ts:86, apps/console/src/main.tsx:71-74, packages/api/generated/sdk.ts:774-781, packages/api/generated/sdk.ts:1195-1203, packages/api/generated/sdk.ts:1330-1335, packages/api/generated/sdk.ts:2243-2252 -->
