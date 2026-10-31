---
title: Skills
description: See which Agent Skills packages your sessions can read, browse their revisions and files, and import skills through the API.
---

A skill is an [Agent Skills](https://agentskills.io/specification) package: a directory with a `SKILL.md` file at its root, and any
other files it needs. Kantel keeps each skill with a stable ID, an owner and a numbered list of revisions. A session
sees its skills by name, description and path, and reads a skill's files when it needs them. A skill grants nothing:
it doesn't change any vault, capability or browser grant.

## Owners

Every skill belongs to one owner:

| Owner | Who sees it |
| --- | --- |
| Platform | Every organisation. Only Kantel itself creates or changes platform skills. |
| Organisation | Every session in the organisation. |
| Project | Sessions in that project. |
| User | Sessions that work for that person. |

The skills page groups skills by owner, the narrowest first. Platform skills are labelled "Built in" and your own
"Yours"; other groups carry the owner's name.

A session sees platform, organisation, its own project's and its own person's skills, never another project's or
person's. When two owners have a skill of the same name, the most specific wins: user, then project, then
organisation, then platform. A project-owned skill can also be shared into another project from its page (see
[Projects and sharing](/console/projects-and-sharing/)).

Names follow Agent Skills: 1 to 64 lowercase letters, digits and dashes, unique per owner. The same name under
another owner is fine.

## Revisions

A revision is a published, numbered copy of the package (1, 2, 3 and so on). It records who published it, when, its
files and sizes and a digest. A revision never changes once published. Publishing files identical to the latest
revision creates nothing.

The first time a session prompts, Kantel pins the revision of each skill it may see. The session keeps those
revisions for its whole life, including after a restart or a fork. A newer revision reaches only new sessions.

## The skills page

The skills page is at `/skills`; a skill opens at `/skills/<skillId>`. It shows "What a session can read: Agent Skills
packages by scope, each with every revision ever published."

- **Seen from** picks the view: "The organisation", or one of your projects to see exactly the skills a session in
  that project sees.
- **Filter** narrows the list by words in a name or description.
- Each row shows the name, the description and the latest revision.

Picking a skill shows:

- Its owner badge and revision, and its description.
- **About**: the owner, where it is mounted (`/skills/<name>/SKILL.md`), the source it was imported from (if any),
  and when it was created and updated.
- **Revisions**, newest first, each with who published it, when, its number of files and a short digest. The newest
  is marked "Latest". Picking one shows its files.
- **Files in revision** *n*: the files, `SKILL.md` first. For `SKILL.md` the page shows its frontmatter fields and
  renders the body; **Copy SKILL.md** copies the whole file. Other files open in a file viewer.
- **Sharing**, for a project-owned skill, when the gateway serves sharing.

:::note[Not yet available]
You can't create, edit or publish a skill in the console yet. The skills page on a real gateway is read-only, because
the API serves skill reads and imports only, not drafts or publishing.
:::

## Import a skill

A host adds skills with `POST /v1/skills/import`. The call creates the skill if needed and publishes the files as its
next revision. It is idempotent by source and ref: importing the same `sourceId` and `ref` again publishes nothing,
and a new ref publishes a new revision. Imports need the organisation's admin role, or an API key with the `import`
permission. Agents can never import.

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({
  baseUrl: `${process.env.KANTEL_URL}/v1`,
  token: process.env.KANTEL_API_KEY,
});

const revision = await kantel.importSkill({
  owner: { kind: "organisation", organisationId: "org_…" },
  name: "release-notes",
  description: "Write release notes from merged pull requests.",
  files: [{ path: "SKILL.md", content: "---\nname: release-notes\ndescription: …\n---\n\n…" }],
  source: { sourceId: "team-skills", ref: "4f2c1a9" },
});
```

```sh
curl -s "$KANTEL_URL/v1/skills/import" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"owner":{"kind":"organisation","organisationId":"org_…"},"name":"release-notes","description":"Write release notes from merged pull requests.","files":[{"path":"SKILL.md","content":"---\nname: release-notes\n---\n"}],"source":{"sourceId":"team-skills","ref":"4f2c1a9"}}'
```

Package and variable names still use the old name, `harbour`. The read routes are `GET /v1/skills`,
`GET /v1/skills/{skillId}`, `GET /v1/skills/{skillId}/revisions`, `GET /v1/skills/{skillId}/revisions/{revision}` and
`GET /v1/skills/{skillId}/revisions/{revision}/file`. See the [API reference](/api/reference/).

## How a session uses skills

On a session's first prompt:

1. Kantel pins the revisions of the skills the session may see.
2. It mounts them read-only at `/skills` in the session's workspace, so the agent reads
   `/skills/<name>/SKILL.md` with its file tools.
3. It lists the skills the agent profile names in its `skills` field.

Only skills the profile names are listed. Skills it doesn't name are still pinned and mounted, but the agent isn't
told about them. On a self-hosted gateway, a session created without a workspace whose profile names skills gets a
workspace of its own with the `/skills` mount; a session started on an existing workspace has `/skills` only if that
workspace was made with the mount. A profile's `skills` are set with `PUT /v1/profiles/{agentId}` (see
[Unlisted routes](/api/reference/unlisted/)); the console has no editor for them yet.

### What the listing adds to the prompt

Kantel adds no system prompt of its own. The skills listing is the only text skills add, and it isn't part of the
system prompt: it goes into the session's transcript, before the first prompt, as one `harbour.context` entry (a user
message to the model), together with any memory recall. The listing is Pi's own `<available_skills>` block:

```text
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>release-notes</name>
    <description>Write release notes from merged pull requests.</description>
    <location>/skills/release-notes/SKILL.md</location>
  </skill>
</available_skills>
```

A profile that names no skills gets no listing. A forked session keeps its source's listing and revisions.

<!-- Sources (8584d5b): packages/skills/CONTRACT.md:1-58, packages/skills/src/sources.ts:176-197, packages/runtime/src/context.ts:1-90, packages/contracts/src/session.ts:66-73, packages/ui/src/skills/skills-page.tsx:140-300, packages/ui/src/skills/skills-page.tsx:400-610, packages/ui/src/skills/skills-model.ts:160-170, apps/console/src/app/agent-screens.tsx:1-55, apps/console/src/api/agent-http.ts:1-57, apps/console/src/main.tsx:65-66, apps/console/src/app/router.ts:87-91, apps/cloudflare/src/gateway.ts:15, apps/selfhosted/src/gateway/skills-memory.ts:1-19, packages/api/generated/sdk.ts:681-694, packages/api/generated/sdk.ts:2230-2242, packages/runtime/HTTP.md:63, examples/sal-worker/README.md:52-70 -->
