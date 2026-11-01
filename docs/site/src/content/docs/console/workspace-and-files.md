---
title: Workspace and files
description: Understand a session's workspace, the agent's file and command tools, the read-only files page, presented documents and file share links.
---

A session's workspace is a versioned file tree. The agent works in it at `/workspace` with its coding tools, and you browse it on the session's files page. This page describes Cloudflare; [On a self-hosted gateway](#on-a-self-hosted-gateway) lists what differs.

## Where a session's workspace comes from

- **From a repository.** On **New session**, choose a repository and a branch in the composer's footer. The console lists the branches (`GET /v1/git/branches`), creates a workspace seeded from that branch (`POST /v1/workspaces`) and starts the session on it. The files arrive without `.git`. Only public GitHub repositories can be seeded for now, and organisation-wide sessions can't start from one yet.
- **Its own, empty.** A session started without a repository gets its own workspace, `session_<session ID>`. The agent's first file tool or command creates it, empty, in the session's project. A session that only talks stores nothing.

Every write is a commit that adds one version, audited as `workspace.committed` with the agent as its actor.

### Several sessions on one workspace

Several sessions can share a workspace, each with its own conversation and history. A fork made with **Fork from this response** keeps the source's workspace, and a subagent works on its parent's. Through the API, pass an existing `workspaceId` to `POST /v1/sessions`. `GET /v1/sessions?workspaceId=…` lists the sessions on a workspace. The console has no way yet to start a session on an existing workspace.

A shared workspace has one `/skills` mount. Each session's first prompt re-pins it to that session's skills, so an earlier session then reads the later one's.

## The coding tools

Every session has `read`, `write`, `edit`, `ls` and `bash` (its agent profile picks which) on its workspace:

- `read`, `write`, `edit` and `ls` work on the stored workspace directly, as the session's agent, and lease no sandbox. `ls` lists at most 500 entries.
- `bash` leases the session's isolate on its first command. Closing or aborting the session releases it. A command runs for two minutes unless it names a timeout, and never longer than ten minutes. A command that runs out of time stops with exit code 124.
- Paths outside `/workspace` and its mounts are refused. Mounts are read-only. A file over 16 MiB is neither read nor written.

### What runs where

| Tier | What runs there |
| --- | --- |
| Isolate (the default `in-process` backend) | Shell commands, `node script.js` in QuickJS (plain JavaScript, no `require`, `fs`, network or timers), and `git` reads such as `status`, `log`, `diff` and `show` |
| Container, with `KANTEL_SANDBOX_CONTAINERS=on` | `python`, `npm`, `git` writes and any program the isolate doesn't have, such as `make` or `./run.sh` |

The router chooses the tier before a command runs: a command goes to the container whole if any program in it needs one. Without containers, those commands are refused as `unavailable`.

A session's container starts on its first command that needs it and stops after 10 minutes without calls. It has no network, so `pip install` and `npm install` from a registry don't work yet. The workspace is checkpointed after every command, so the file tools see what a command wrote. When you type in the composer, the console's warm-up call (`POST /v1/sessions/{id}/warm`) starts the container of a session that has used one before.

### Code mode

Every session with tools also gets `codemode`, unless `KANTEL_CODEMODE=off`. The model writes a JavaScript script that calls the session's other tools, such as `await tools.read({ path })`, in an isolate with no secrets or network. Each call gets the same checks, audit and approvals as a direct one. Kantel adds no prompt for code mode: the tool's description is all the model gets.

## The files page

Choose **Files** in a session's top bar to open `/projects/<project>/sessions/<session>/files`. Organisation sessions use `/organisation/sessions/<session>/files`. The page is marked **Read-only**:

- The tree lists directories first. Each file is a link, so you can open it in a new tab.
- Text opens with line numbers, up to 5,000 lines, and Markdown as a note. Images show as pictures. Files over 16 MiB say "This file is too large to show here".
- **Back to the session** returns to the transcript.

The page uses only the workspace read API's GET routes, so browsing never starts a sandbox.

```bash
curl -s "$KANTEL_URL/v1/workspaces/WORKSPACE_ID/files?path=&recursive=true" -H "authorization: Bearer $KANTEL_API_KEY"
curl -s "$KANTEL_URL/v1/workspaces/WORKSPACE_ID/content?path=README.md" -H "authorization: Bearer $KANTEL_API_KEY"
```

The read API isn't in the generated SDK. It serves content as bytes, never run: HTML and SVG come back as `text/plain`.

## Mounts

A session's skills are mounted read-only at `/skills/<name>/`, pinned on its first prompt to the revisions it was given. A later skill revision reaches only new sessions. See [Skills](/console/skills/).

The workspace package also has read-only sources for project files (`/project`) and organisation files (`/org`). Neither deployment mounts them into a session's workspace yet.

## Presented files, documents and images

The agent can put files in front of you in the transcript. Kantel adds no prompt about these tools: each one describes itself through its description and schema.

- **`present_files`** shows up to 20 workspace files as cards. A card opens the file in a panel beside the transcript, with **Download**.
- **`create_document`** writes a Markdown document under `documents/` and presents it. It streams into the document panel while the model writes. Once it is saved you can edit it in place, and the console saves your edits as you go. If the agent changed the file in the meantime, the save fails and your edits stay on the page.
- **`generate_image`** makes or edits images with the agent profile's image model and saves them under `images/`. It is offered only when the profile names an image model that the deployment's model gateway lists with image output.

`KANTEL_PRESENT_FILES=off` removes `present_files` and `create_document`.

## Sharing a file by link

A presented file or document has a **Share** button. Its popover has a **Share** tab and an **Export** tab. Export offers **Download** for a file, and **Markdown** and **PDF** for a document. The Share tab has:

- an invite field ("Invite people by email") and the list of **People with access**. Kantel stores invites but sends no email, and an invite grants no access on its own;
- **General access**: **Only you** or **Anyone with the link**.

The link is `/shared/<token>` on your deployment's hostname. It opens that one file, read-only, without sign-in, and works only while general access is **Anyone with the link**. Switching back to **Only you** stops it at once.

A file has one live share, which always shows its newest version. Sharing needs the operator role on the project, as a person: an agent or an API key is refused. Each change is audited as a `workspace.share.*` event, without the token or any email address. An API key with the viewer role can list a workspace's shares (`listShares`, `GET /v1/workspaces/{id}/shares`). See the [API reference](/api/reference/).

## On a self-hosted gateway

The self-hosted gateway serves the workspace read API, so the files page works. The gateway lacks several things:

- It has no workspace write API (`POST /v1/workspaces`) and no branch listing, so sessions can't start from a repository.
- It has no shares API and no `/shared/<token>` links.
- It doesn't offer `present_files`, `create_document`, `generate_image` or code mode.
- `bash` runs in an in-process isolate. There is no container tier yet, so commands that need one are refused as `unavailable`.
- A session gets a workspace only when it is created on one, or when its profile names skills (for the `/skills` mount).

<!-- Sources (8584d5b): apps/cloudflare/README.md:1-30,50-150, apps/cloudflare/src/coding-tools.ts:1-120, apps/cloudflare/src/stack.ts:545-590, apps/cloudflare/src/skills-mount.ts:1-40, apps/cloudflare/src/gateway.ts:1-30,214-270, apps/cloudflare/src/stack-object.ts:200-235, apps/console/src/api/http.ts:15-25,380-475,735-770,915-925, apps/console/src/api/client.ts:130-205, apps/console/src/app/files-screen.tsx:1-290, apps/console/src/app/router.ts:28-35,170-175, apps/console/src/ui/session-view.tsx:320-326,460-490, apps/console/src/ui/document-view.tsx:20-170, apps/console/src/ui/presented-panel.tsx:90-115, packages/ui/src/documents/share-popover.tsx:1-70,190-260,360-370, packages/ui/docs/workspace.md:1-150, packages/workspace/CONTRACT.md:55-130,200-240, packages/workspace/src/write-api.ts:40-120, packages/sandbox/src/present-files.ts:1-40, packages/sandbox/src/documents.ts:1-80, packages/runtime/src/images.ts:1-30, packages/contracts/src/session.ts:508-520, packages/api/generated/sdk.ts:614-640,1649-1656,2296-2305, apps/selfhosted/src/gateway/gateway.ts:1-30,195-210, apps/selfhosted/src/gateway/sandboxes.ts:1-25, apps/selfhosted/src/gateway/skills-memory.ts:1-20 -->
