---
title: Sessions
description: Start, steer, organise and branch agent sessions in the Kantel console, and find the matching API routes.
---

A session is one conversation with an agent, with its own transcript and, usually, a workspace of files. In the console, a project's sessions are at `/projects/<project>`, and each session opens at `/projects/<project>/sessions/<session>`.

## The session list

The sidebar lists the project's sessions. **Pinned** sessions come first. By default the list groups the rest by what they need from you:

| Group | Sessions in it |
| --- | --- |
| Needs you | waiting for an approval or an answer |
| Working | running a turn now, with a live timer ("Working 12s") |
| Done | everything else: finished, idle, failed or stopped |

Each group shows its newest 50 sessions; **Show 50 more** under it shows the next. The session you have open is always shown.

The **Filter sessions** button by the heading sets **Status** (Active, Archived or All), **Last activity**, **Group by** (Status, Date or None) and **Sort by** (Last activity, Date created or Title). The heading follows the status: "Recents", "Archived" or "All sessions". The console remembers your choice in the browser.

### Organising a session

Each row has a "…" menu:

- **Mark as unread** or **Mark as read**. The mark is on the session, for everyone, and opening the session clears it.
- **Pin** or **Unpin**.
- **Rename** opens a dialog with a **Title** field (up to 200 characters).
- **Archive** or **Unarchive**. An archived session leaves the default view but stays readable and usable.
- **Delete** asks first. Deleting stops anything the session is still doing, ends its browsers and grants, and removes it for everyone in the project. You can't undo it.

These actions need the operator role on the project. The console sends them as `PATCH /v1/sessions/{id}` and `DELETE /v1/sessions/{id}`. Both gateways serve these routes, but they aren't in the public API or the SDK yet (see [Unlisted routes](/api/reference/unlisted/)).

## Starting a session

Choose **New session** at the top of the project's list (`/projects/<project>/new`). Starting a session needs the operator role on the project, and the console says so on **New session** when you don't have it. You write the first message in the composer, with pickers in its footer:

- the project, or **Organisation-wide** (see below);
- on Cloudflare, a repository and a branch. Choosing a repository makes the session's workspace from it first. See [Workspace and files](/console/workspace-and-files/).

The session starts when you send that first message, with the agent that runs in that project. If no agent can run there, the console says so, and an admin needs to add one.

### Project and organisation sessions

An **Organisation-wide** session (`/organisation`, and `/organisation/new` to start one) belongs to no project. Its agent reaches what the organisation owns and the session user's own records, but no project's. Starting one needs an organisation-wide operator role and an agent profile with no project. It can't start from a repository yet. In the API, pass `scope: "organisation"` instead of a `projectId` to `POST /v1/sessions`.

## The composer

The composer sits at the bottom of the session. Enter sends and Shift+Enter starts a new line.

- **Model and thinking pickers** list the models the session may use and the thinking levels the chosen model supports. The agent profile's level is marked Default. A choice sticks: it applies to this run and the session's later runs.
- **Attach files** (the paperclip), a drop on the transcript or a paste adds files. Each file uploads before you send. An image the chosen model can't read blocks **Send** and the composer says why.
- While the agent works, the main button changes:
  - With text in the draft it is **Steer** ("Send to the running agent"). A steer reaches the run at its next model call without stopping it.
  - **Send after this run**, in the footer, queues the draft as a follow-up instead. It runs when the current run ends.
  - With an empty draft the button is **Stop**, which aborts the run. Stopping a session stops its subagents too.

Focusing the composer or typing sends a warm-up hint, at most every 30 seconds. On Cloudflare this gets the session's sandbox ready for its next command, so the agent doesn't wait for one to start.

When the agent asks for a browser or for a connection, a notice with the decision appears above the composer. See [Browsers](/console/browsers/) and [Connection requests](/console/connection-requests/).

## The transcript

The transcript shows your messages, the agent's answers and its work in between:

- **Tool calls** appear as rows. `read`, `write`, `edit` and `bash` get their own cards: the file, a diff or a terminal. Each card has a Raw toggle that shows the arguments and output instead.
- **Working sections**: while a turn runs, "Working for 12s" sits under your message. Once the turn ends with an answer, its steps fold under one line, such as "Worked for 1m 12s, 6 steps", which opens to show them.
- **Browsing runs** show as one line ("Browsing, 12 steps") with a card for the browser.
- **Presented files, documents and images** show as cards that open in a panel. See [Workspace and files](/console/workspace-and-files/).
- **Notices** sit in the flow of the transcript: a reconnect, a call that may have partly run, a run that stopped.
- A message that failed to send says "Couldn't send" and why, with **Try again**.

A session opens on its latest turns. Older turns load as you scroll up, and **Load earlier messages** at the top of what has loaded loads them too.

### Subagents and child sessions

The agent has a `subagent` tool on Cloudflare with `KANTEL_SUBAGENTS=on` (as the repository's `wrangler.jsonc` sets it), and on a self-hosted gateway unless `KANTEL_SUBAGENTS` is set to anything but `on`. It hands one self-contained task to a child session of the same agent, on the same workspace.

A session's own workspace (the one a session started without one gets, as the self-hosted console's do) is bound to that session, and only it may use the workspace. Its subagents are the exception: a subagent may read and write the workspace of any session above it, up to four levels, in the same project. That reaches upward only: never a sibling's or a cousin's workspace, and a session gets nothing new over its subagents' own. It covers the workspace alone; prompting or stopping the parent is still refused. Each use through this rule is audited as `access.ancestor.allowed`, naming the session above whose workspace it was.

A subagent shows as a card tagged **Subagent**, with its status (Working, Done, Failed or Stopped) and what it is doing now. The card opens the child session, whose top bar links back to its parent. **Stop subagent** stops only that child, and the parent carries on. Subagents can start their own, down to four levels below the session you started.

Through the API, `parentSessionId` on `POST /v1/sessions` makes a child session. Aborting the parent aborts the child.

## Editing a message and forking from an answer

Messages have small actions beside them, next to Copy:

- **Edit from here**, on your own messages, opens the message for editing. Sending reruns the session from that message, and what came after it leaves the transcript. While a run is going the action says "Stop the run to edit a message".
- **Fork from this response**, on a finished answer, starts a new session with the same agent and workspace, whose history runs up to and including that answer. The console opens the fork. The original doesn't change.

Forking is `POST /v1/sessions/{id}/fork` in the public API. Editing is `POST /v1/sessions/{id}/edit`, which both gateways serve but which isn't in the public API yet.

## Labels

Host apps set labels, such as `{ "appTask": "task-42" }`, on `POST /v1/sessions` and filter with `label.<key>=<value>` on `GET /v1/sessions`. The console sets `repo` and `branch` labels on a session it starts from a repository, but doesn't show or filter by labels yet.

## From the API

See the [API reference](/api/reference/) for the full shapes.

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_API_KEY });

// Steer a running session; "prompt" and "followUp" are the other ways in.
await kantel.sendMessage(
	"SESSION_ID",
	{ via: "steer", text: "Run the whole suite, then open the PR." },
	{ idempotencyKey: crypto.randomUUID() },
);
await kantel.warmSession("SESSION_ID");
await kantel.forkSession("SESSION_ID", { itemId: "ITEM_ID" });
```

```bash
curl -s "$KANTEL_URL/v1/sessions/SESSION_ID/messages" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: steer-0001" \
  -d '{"via":"steer","text":"Run the whole suite, then open the PR."}'
curl -s -X POST "$KANTEL_URL/v1/sessions/SESSION_ID/abort" -H "authorization: Bearer $KANTEL_API_KEY"
```

## On a self-hosted gateway

The self-hosted gateway serves the session menu, editing, forking and the model pickers. It doesn't serve `GET /v1/sessions/{id}/history` (older turns) or `/v1/attachments`, and its warm-up only checks the session. Its sessions have the `subagent` tool, as Cloudflare's do; `KANTEL_SUBAGENTS=off` takes it away.

<!-- Sources (8584d5b): apps/console/src/app/router.ts:1-35,143-160, apps/console/src/api/client.ts:30-36,110-260, apps/console/src/api/http.ts:1-25,496-505,720-925, apps/console/src/ui/session-view.tsx:280-460, apps/console/src/ui/actions.ts:74-160,244-246, apps/console/src/ui/new-session-view.tsx:100-190, apps/console/src/app/session-screen.tsx:295-430, packages/ui/src/session/session-model.ts:1-210, packages/ui/src/session/session-list.tsx:165-300, packages/ui/src/session/session-menu.tsx:40-290, packages/ui/src/session/composer.tsx:800-870, packages/ui/src/session/message-actions.tsx:50-90, packages/ui/src/session/message.tsx:100-220, packages/ui/src/session/subagent-card.tsx:14-120, packages/ui/src/session/browsing-group.tsx:13-40, packages/ui/docs/session-composer.md:40-110, packages/ui/docs/session-transcript.md:44-190, packages/contracts/src/session.ts:80-160,300-345,500-525, packages/runtime/HTTP.md:36-95, packages/runtime/src/http/server.ts:60-90, packages/api/generated/sdk.ts:503-520,656-661,809-825,912-925,1635-1638,2193-2216, apps/cloudflare/src/gateway.ts:157-195, packages/subagents/src/index.ts:1-50, apps/selfhosted/src/gateway/subagents.ts:1-12, packages/contracts/src/access.ts:80-95,165-180,290-345,610-640, packages/workspace/src/tree.ts:444-475, apps/selfhosted/src/gateway/skills-memory.ts:110-150, apps/cloudflare/wrangler.jsonc:78-100, apps/selfhosted/src/gateway/gateway.ts:1-30,155-170 -->
