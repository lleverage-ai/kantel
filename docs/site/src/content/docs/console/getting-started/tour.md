---
title: A tour of the console
description: Find your way around the Partan console, sign in, understand projects and the organisation scope, and start your first session.
---

The console is Partan's web interface. It shows your projects and their sessions, lets you start and steer sessions, and holds the organisation's pages: schedules, sharing, prompt rules, connection requests, the audit log, API keys and members. It calls the same public API a host app does.

Some labels in the console still read "Harbour", the product's old name, such as the name at the top of the sidebar and on the sign-in screen.

## Signing in

How you sign in depends on where Partan runs. In both cases Partan is invite-only: the deployment invites its first admin by email when it starts, and anyone else who reaches the console without an invitation is refused.

**On Cloudflare**, Cloudflare Access signs you in at the edge, with the login method the Access application is set up with, before the console loads. The console sends no credential of its own. If your Access sign-in lapses, the console says "You're signed out. Reload the page to sign in." and reloading takes you back through Access.

**Self-hosted**, the console shows its own sign-in screen, "Sign in to Harbour":

1. Enter your email and select **Email me a code**.
2. Enter the six-digit code from the email under **Check your email**. **Send a new code** and **Use a different email** are below the field.

A sign-in lasts 12 hours and is kept in your browser, so a reload or another tab stays signed in. **Sign out** is at the foot of the sidebar.

## The layout

The sidebar is on the left; the open session or page fills the rest of the window.

- **Projects** lists **Organisation-wide** first, then your projects as folders. The one you're in has its sessions nested under it, with **New session** first. The list has a **Recents** heading and a filter for active, archived or all sessions. Where you can start sessions, each session row has a menu to mark it unread, pin, rename, archive or delete it.
- Below the projects: **Schedules** and **Settings**.
- At the foot: who is signed in, a **Theme** button and, where the console signed you in itself, **Sign out**.

**Settings** (`/settings`) swaps the projects for the setup pages, with **Back to sessions** at the top:

- **Agent**: Connections, Skills, Memory, Rules and Models.
- **Organisation**: Members, API keys, Sharing and Audit log.
- **You**: Connection requests.

On a wide screen `/settings` opens the first of these pages; on a phone it is the list itself, and each page has a **Settings** button back to it.

The toggle beside the product name, or Ctrl+B (⌘B on a Mac), collapses the sidebar to a rail of icons. The console remembers this in your browser. On a phone, each page fills the screen and pages outside a project have **Sessions** to go back.

Each page appears only when your role and the deployment allow it:

| Page | Path | What it shows |
| --- | --- | --- |
| A project | `/projects/:projectId` | The project's sessions |
| Organisation-wide | `/organisation` | Sessions in no project (see below) |
| Skills | `/skills` | The agent's skills, by revision ([Skills](/console/skills/)) |
| Memory | `/memory` | Memory concepts by scope, search and recall ([Memory](/console/memory/)) |
| Models | `/projects/:projectId/models` | The open project's model connectors and the agent's image model ([Models](/console/models/)) |
| Schedules | `/schedules` | The organisation's schedules and their runs ([Schedules](/console/schedules/)) |
| Settings | `/settings` | The setup pages below, in the sidebar |
| Connections | `/connections` | The connector catalogue, what's connected and the OAuth clients ([Connectors](/console/connectors/)) |
| Sharing | `/sharing` | What a project shares and is shared, and requests waiting on you ([Projects and sharing](/console/projects-and-sharing/)) |
| Rules | `/rules` | Prompt rules, and what a new session would get ([Prompt rules](/console/prompt-rules/)) |
| Connection requests | `/connections/requests` | Your active grants, and connection requests to decide ([Connection requests](/console/connection-requests/)). Old `/vault` links redirect here |
| Audit log | `/audit` | Every recorded event, with filters and JSONL export ([Audit](/console/audit/)) |
| API keys | `/keys` | Host apps' API keys, for an operator or above. Issuing or revoking a key needs the admin role on every project it covers |
| Members | `/members` | The organisation's members, for an organisation admin |

A few pages depend on what the deployment serves. The Connection requests page is listed only when the deployment has its encrypted store (self-hosted, that needs `HARBOUR_VAULT_CIPHER_KEY`). The self-hosted gateway doesn't serve the schedules routes (`/v1/schedules`) or the connectors route (`/v1/connectors`) yet, so the Schedules and Models pages are listed there but show the gateway's refusal.

## Projects and the organisation

Partan's tenancy is organisation, then project, then session. You hold a role, viewer, operator or admin, on a project or across the whole organisation. Viewers can watch; operators can start and steer sessions; admins manage the project or organisation.

Most sessions run in a project, with the project's skills, memory, files and rules as well as the organisation's. A session can also be **organisation-wide**: it works at the level of the organisation, with the organisation's skills, memory and files, in no project. Its sessions live under `/organisation`. Starting one needs a role across the organisation, not only on a project, so an API key, which holds roles only on its projects, can't. An agent profile with no project runs in either kind of session; a project's own profile runs only in that project. On Cloudflare, the default agent profile, Assistant, has no project, so it runs in both.

The deployment creates the first organisation and project when it starts. Creating more projects from the console or the API isn't available yet; self-hosted, the gateway creates one project per name in `HARBOUR_PROJECTS` at start.

## Start your first session

1. Select **New session** under a project in the sidebar, or the **+** button beside the project's name.
2. The composer opens before the session exists, titled "Start a session in" and the project's name. Its field is labelled **First message**, with the placeholder "What should this session do?".
3. Below the field, pick the project (or Organisation-wide) and, in a project, a repository and branch if you want the agent to work on code. **No repository** is the default. Type `owner/name` or paste a GitHub link to choose one.
4. Pick a model and thinking level if the pickers offer a choice. They list what the deployment's model connectors offer; see [Models](/console/models/).
5. Send. The session is created and opens at once, with your message as its first turn.

The session then appears in the project's list. While the agent runs, the composer's button steers the run, and "Send after this run" queues a follow-up. See [Sessions](/console/sessions/) for the session view, and [Workspace and files](/console/workspace-and-files/) for the files a session works on.

Starting from a repository works on the Cloudflare target, with public GitHub repositories only for now. The self-hosted gateway doesn't serve the branches route the repository picker needs (`/v1/git/branches`), so choosing a repository fails there.

The agent's prompt is what its agent profile's prompt layers and the prompt rules give it, plus recall from memory and the listing of its skills. Partan adds no system prompt of its own, so on Cloudflare a new deployment's Assistant starts with no prompt until you set one.

<!-- Sources (8584d5b): apps/console/src/app/router.ts:1-60,126,143-182, apps/console/src/app/app.tsx:93-135,160-325,338-347,398-404,560-575,740-880, apps/console/src/app/use-sidebar.ts:1-40, apps/console/src/app/theme.tsx:33-40, apps/console/src/main.tsx:340-424, apps/console/src/api/identity.ts:1-30, apps/console/src/api/client.ts:25-36,215-225, apps/console/src/api/http.ts:20,149,733-736, apps/console/src/api/members.ts:16-25, apps/console/src/api/keys.ts:1-20, apps/console/src/app/new-session-screen.tsx:66-80, apps/console/src/ui/new-session-view.tsx:80-188, apps/console/src/ui/session-view.tsx:450, apps/console/README.md:17-60, packages/ui/src/identity/sign-in.tsx:130-262, packages/ui/src/identity/signed-in-as.tsx:20-80, packages/ui/src/session/session-list.tsx:160-240, packages/ui/src/session/model-picker.tsx:164,191, packages/identity/src/http.ts:285-295,462-488, apps/cloudflare/README.md:4,21-22,247-256, apps/cloudflare/src/stack.ts:138,654-690, apps/selfhosted/src/gateway/gateway.ts:1-27, apps/selfhosted/src/gateway/durable.ts:16-17,224-252, packages/runtime/src/http/server.ts:7,642-645, docs/design/org-scope.md:1-60, deploy/compose/README.md:65-92,134-147 -->
