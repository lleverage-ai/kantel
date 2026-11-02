---
title: Projects and sharing
description: How organisations, projects and roles fit together, how to manage members and API keys, and how to share resources and files across projects.
---

Kantel's tenancy runs platform, organisation, project, session. People hold roles on a project or across an organisation, host apps act through API keys scoped to projects or to the organisation, and resources such as skills can be shared from one project into another.

## Organisations and projects

An organisation holds projects, and a project holds sessions, workspaces and the resources its agents use. A session can also be scoped to the organisation itself; the console lists those under `/organisation`, above the projects.

People may belong to several organisations. `GET /v1/organisations` lists yours, and a call names one with the `kantel-organisation` header. An API key acts in its own organisation only. `GET /v1/me` says who you are and which roles you hold; `GET /v1/projects` lists the projects you hold a role on.

Each deployment makes its organisation and first projects when it starts: Cloudflare makes one project, and the self-hosted gateway makes the ones named in `KANTEL_PROJECT_NAME` and `KANTEL_PROJECTS`. See [Deployment overview](/deploy/overview/). After that, `POST /v1/projects` with `{ "name": "…" }` creates a project in the caller's organisation. It needs the organisation-wide `admin` role, or an organisation key with the `create_projects` permission, and is audited as `identity.project.created`. See [Projects](/api/reference/projects/).

:::note[Not yet available]
The console has no form to create a project, and no route creates an organisation.
:::

## Roles

There are three roles, weakest first. Each includes what the ones before it allow.

| Role | What it allows |
| --- | --- |
| `viewer` | Reads sessions, files and the audit log. Starts nothing. |
| `operator` | Starts and steers sessions, as a host app does. |
| `admin` | Everything an operator does, and issues and revokes API keys. |

A role is bound to one project or to every project in the organisation. Inviting people, resetting passkeys, issuing a key for a new host app and issuing a key with a permission all need the organisation-wide `admin` role.

:::note[Not yet available]
There is no console page or API route for changing or removing a role once someone has it. Each deployment invites one first admin by email (`KANTEL_ADMIN_EMAIL`) when it starts.
:::

## Members

The **Members** page (`/members`) lists the people with a role in the organisation, and the invites still pending. Only organisation admins see it.

Press **Invite**, enter the person's email and pick a role (`viewer`, `operator` or `admin`, across the organisation). Kantel emails them a link where the deployment sends mail (self-hosted with `KANTEL_SMTP_URL`); otherwise the dialog gives you the link to send them yourself. The link holds no secret: the person joins when they sign in with the invited email, which their sign-in must verify. On Cloudflare, Access decides who reaches the sign-in at all, so its policy must let them through. An invite lasts 14 days. Revoke one from its row's **⋯** menu. Making, revoking and accepting an invite are audited as `identity.invite.created`, `identity.invite.revoked` and `identity.invite.accepted`; the route is `POST /v1/invites`.

If someone loses their passkeys, press **Reset passkeys** on their row and confirm. Kantel removes every passkey they have, and they can set up a new one on the connection request page. Do this only once you know it's them asking. The route is `POST /v1/members/:userId/passkeys/reset`, audited as `identity.passkey.reset`.

## API keys

A key belongs to a host app and holds one role. A project key acts only in the projects it names. An organisation key acts across its organisation, in every project, including ones made later, and holds at most `operator`. Its secret starts `ktk_`.

The **API keys** page (`/keys`) is listed for operators and above. It shows, issues and revokes a key only for an admin of every project the key covers; an organisation key, only for an organisation-wide admin. To issue one:

1. Press **New key**.
2. Fill in **Name**. An organisation-wide admin picks what it **Acts in**: **One project** or **Whole organisation**.
3. For a project key, pick the **Project**. Then pick the **Role** and when it **Expires** (No expiry, 30 days, 90 days or 1 year). For an organisation key, tick **Can create projects** if the host app should create projects.
4. Press **Issue key**, copy the secret with **Copy key**, and press **I've stored it**.

The list marks organisation keys **Organisation**, and keys that may create projects **Creates projects**.

Kantel shows the secret once and keeps only a hash. If it's lost, revoke the key and issue another. **Revoke** asks you to confirm, and the key's next call is refused. Ended keys move under **Revoked and expired keys**.

### Keys over the API

`POST /v1/keys` takes up to 100 `projectIds`, where the console takes one, and three more fields:

- `scope` is `projects` (the default) or `organisation`. An organisation key names no `projectIds`, holds `viewer` or `operator`, and needs an organisation-wide admin signed in as a person to issue; another key can't issue one.

- `serviceId` issues the key for an existing host app, such as when rotating its key. Without it, the key gets a new service identity, which needs the organisation's `admin` role.
- `permissions` adds permissions beyond the role. `import` loads skills and memory snapshots into the organisation (`POST /v1/skills/import`, `POST /v1/memory/spaces/{spaceId}/snapshot`); the console doesn't offer it. `create_projects`, on an organisation key only, creates projects with `POST /v1/projects`. Either needs the organisation's `admin` role to issue.

No key holds the organisation-wide `admin` role, so send these calls as a signed-in admin. Here `$KANTEL_ADMIN_TOKEN` stands for an admin's credential, such as the `kts_…` token from self-hosted email sign-in:

```bash
curl -s -X POST "$KANTEL_URL/v1/keys" \
  -H "authorization: Bearer $KANTEL_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"Import script","projectIds":["prj_123"],"role":"viewer","permissions":["import"]}'
```

The answer is `201` with `{ key, secret }`. `GET /v1/keys` lists the keys you administer, and `POST /v1/keys/:id/revoke` revokes one. These routes aren't in the generated SDK; see [Unlisted routes](/api/reference/unlisted/).

:::caution
The self-hosted gateway allows imports for organisation admins only, so a key's `import` permission has no effect there yet.
:::

For an organisation key, send `"scope":"organisation"` and no `projectIds`, for example `{"name":"Lleverage","scope":"organisation","role":"operator","permissions":["create_projects"]}`. Issuing and revoking a key are audited as `identity.key.issued` and `identity.key.revoked`, with the key's scope and role.

## Share resources across projects

A resource belongs to one owner. A share lets another project, an agent profile, a person or one session use it. Kantel's shareable kinds are `skills.skill`, `memory.space`, `vault.item`, `workspace` and `models.connector`; a host app can register its own (`POST /v1/sharing/resources`).

A share grants one permission:

| Permission | Console label | What the grantee may do |
| --- | --- | --- |
| `use` | Use | Read it and use it in sessions. |
| `propose` | Propose changes | Use it and suggest changes for the owner to review. |
| `edit` | Edit | Use it and change it. Agents only propose, unless you let them write. |
| `approve` | Approve | Change it and publish or apply others' changes. |

Agents hold at most `propose`, unless an `edit` or `approve` share has `agentWrites` on. A share can expire, and can pin one revision instead of following the latest.

Someone with authority over a resource (its approver, or an admin where it lives) can assign a share directly. Otherwise an operator of the grantee's project requests access with a reason, and the owner's approvers grant it, possibly narrower than asked, or reject it. Agents never decide. Revoking a share also revokes every share passed on from it.

Bindings say who maintains a resource, who approves edits to it, and who is in a group. A policy can turn on the two-person rule: whoever publishes an edit may not be one of its authors. `GET /v1/sharing/uses?sessionId=` lists what a session used through shares.

### The Sharing page

The **Sharing** page (`/sharing`) shows one **Project** at a time, in four panels:

- **Requests to decide**: pick what to **Grant** (what was asked, or less), tick **Let agents write** where offered, then **Grant** or **Reject**.
- **Shared by this project**: **Revoke** ends a share.
- **Shared with this project**: **Detach** ends a share, as an admin of this project.
- **This project's requests**: **Withdraw** takes back a pending one.

A project-owned skill's page also shows its shares and requests. Creating shares and requests is API-only.

### Over the API

The generated SDK covers every route under `/v1/sharing/`, such as `createResourceShare`, `requestAccess` and `decideAccessRequest`.

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_API_KEY });

await kantel.requestAccess({
	resource: { kind: "skills.skill", id: "skl_123" },
	grantee: { kind: "project", projectId: "prj_456" },
	permission: "use",
	reason: "The billing agents need the reconciliation skill.",
});
```

```bash
curl -s -X POST "$KANTEL_URL/v1/sharing/requests/req_789/decision" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"decision":"grant","permission":"use"}'
```

## Share a file by link

On Cloudflare, a file an agent presents in a session has a Share tab (**Share or export**). Set **General access** to "Only you" (people who can already see the session) or "Anyone with the link", then **Copy link**. The link (`/shared/<token>`) needs no sign-in, opens that one file, and always shows its newest version. Behind Cloudflare Access it opens only for people Access admits, unless the Access application bypasses `/shared/*`.

You can also invite people by email. Kantel stores the invites but sends no email, and an invite grants nothing on its own.

The SDK's `shareFile`, `updateShare` and `revokeShare` cover the routes. Changing a share needs the operator role, as a person, never an agent or a key. The self-hosted gateway doesn't serve file share links yet.

<!-- Sources (8584d5b): apps/console/src/app/router.ts:1-35, apps/console/src/app/app.tsx:280-325, apps/console/src/main.tsx:55-77, packages/contracts/src/identity.ts:21-113, packages/contracts/src/identity.ts:193, packages/contracts/src/identity.ts:415-535, packages/identity/src/http.ts:1-160, packages/identity/src/http.ts:646-700, packages/identity/src/index.ts:20-33, packages/contracts/src/passkey.ts:160-180, packages/ui/src/identity/members.tsx:20-80, packages/ui/src/identity/members.tsx:140-200, packages/ui/src/identity/api-keys.tsx:55-71, packages/ui/src/identity/api-keys.tsx:136-440, apps/console/src/api/keys.ts:1-20, apps/cloudflare/src/stack.ts:860-882, apps/selfhosted/src/gateway/main.ts:1-40, apps/selfhosted/src/gateway/components.ts:430-440, apps/selfhosted/src/gateway/components.ts:555-565, apps/selfhosted/src/gateway/gateway.ts:237-252, apps/cloudflare/src/gateway.ts:1-30, apps/cloudflare/src/gateway.ts:232-243, packages/sharing/src/http.ts:1-22, packages/api/generated/sdk.ts:465-479, packages/api/generated/sdk.ts:539-550, packages/api/generated/sdk.ts:1316-1384, packages/api/generated/sdk.ts:1966-1980, packages/api/generated/sdk.ts:2292-2345, packages/ui/src/sharing/sharing-page.tsx:1-110, packages/ui/src/sharing/sharing-page.tsx:140-290, packages/ui/src/sharing/sharing-model.ts:94-110, packages/ui/src/sharing/resource-sharing-panel.tsx:1-25, packages/ui/src/skills/skills-page.tsx:497-510, packages/contracts/src/shares.ts:1-60, packages/workspace/src/shares-api.ts:1-16, packages/ui/src/documents/share-popover.tsx:60-65, packages/ui/src/documents/share-popover.tsx:140-260, packages/ui/src/documents/share-popover.tsx:360-370, apps/cloudflare/README.md:247-270 -->
