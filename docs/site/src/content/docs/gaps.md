---
title: Gaps
description: What Partan doesn't do yet, found while writing these docs, with where each piece would live.
---

Writing these docs meant checking every claim against the code. This page lists what we looked for and didn't find, or found only in part. Each entry says where the work would live. It reflects the code on 30 October 2026 (commit `d031001`), and is meant to feed the roadmap: remove an entry once it is done.

## The most important

These block the main uses of Partan: installing it, building an app on it, and running it for a team.

1. **Onboarding isn't built, and the installer isn't merged.** The one-command installer is in review (PR #389). There is no first-run onboarding in the console, and a fresh install opens on email sign-in. *Would live in*: `apps/console/src/app`, with progress kept in the person's preferences; a local first-run sign-in in `packages/identity`.
2. **No API to add model connectors.** The model gateway has presets for Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, LiteLLM and compatible APIs. A self-hosted deployment's operator can configure platform connectors with any of them (`HARBOUR_MODEL_CONNECTORS`), and Cloudflare sets up only CLIProxyAPI, but no route creates a connector. So no one can bring an API key for a provider from the console or the API, and an organisation can't add its own connector, such as its own LiteLLM key. *Would live in*: routes over `ModelConnectors` (`putConnector`, `putRoute`, `setProjectPolicy`) in `packages/api/src/routes.ts`, and each deployment's model config.
3. **Apps can't reach a Cloudflare deployment with a key alone.** Cloudflare Access guards every path, and the deploy configuration sets up no service-token policy. *Would live in*: the Access setup documented in `apps/cloudflare/README.md`.
4. **Much of the API used by the console isn't in the public API.** Who you are, API keys, agent profiles, host tools, workspace files, the audit log, connection approvals and the browser routes are served but missing from the OpenAPI document and the SDK. See [Unlisted routes](/api/reference/unlisted/). *Would live in*: `packages/api/src/routes.ts`.
5. **No packages are published.** `@harbour/api`, `@harbour/runtime`, `@harbour/contracts` and `@harbour/protocol` are private, so an app copies the SDK file, the host tool endpoint or the reducer. *Would live in*: each package's `package.json` and a release workflow.
6. **The self-hosted gateway lacks much of what Cloudflare has.** No container tier, schedules, session history, attachments, workspace creation, file share links, subagents, `codemode`, `present_files`, `create_document` or `generate_image`. *Would live in*: `apps/selfhosted/src/gateway`.

## Installing and onboarding

- **No first-run onboarding.** No route, screen or stored progress. *Would live in*: `apps/console/src/app`; `UserPreferences` holds only `theme` today.
- **Sign-in before onboarding.** A fresh local install opens on email sign-in, through a local mailbox. *Would live in*: `packages/identity`, as a one-time local claim.
- **Installer untested on macOS**, and the browser image is amd64 only. *Would live in*: PR #389 and `images/browser`.
- **No published images.** The installer builds every image from source, which takes about three minutes. *Would live in*: a CI job publishing to a registry.
- **The base compose file can't run real models.** `deploy/compose/compose.yaml` doesn't pass `HARBOUR_CPA_URL`, `HARBOUR_CPA_API_KEY`, `HARBOUR_DEFAULT_MODEL` or `HARBOUR_VAULT_CIPHER_KEY` to the gateway; only the Sal-specific overlay does. *Would live in*: `deploy/compose/compose.yaml`.

## Models

- **No connector management API**, as above.
- **Connectors page on self-hosted.** `GET /v1/connectors` is served only on Cloudflare, so the console's Models page can't list connectors self-hosted. *Would live in*: `apps/selfhosted/src/gateway/gateway.ts`.
- **No image model self-hosted.** `HARBOUR_IMAGE_MODEL` exists only on Cloudflare. *Would live in*: `apps/selfhosted/src/gateway/models.ts`.
- **No usage read side.** Usage rows are written but nothing reads them: no usage API, no console page. *Would live in*: `packages/usage`, with a route on both gateways and a page in `packages/ui`.

## Sessions and the API

- **Session organising routes aren't public.** `PATCH` and `DELETE /v1/sessions/{id}` and `POST /v1/sessions/{id}/edit` are served but not in the SDK. *Would live in*: `packages/api/src/routes.ts`.
- **Per-person session marks.** Pinned, archived and unread are stored once for everyone. *Would live in*: `SessionRecord` in `packages/contracts/src/session.ts`.
- **No idempotency on session creation.** `POST /v1/sessions` takes no `Idempotency-Key`. *Would live in*: `packages/api/src/routes.ts` and the runtime's `create`.
- **No membership check on `userId`.** An app may name any user when it creates a session. *Would live in*: `userOfNew` in `packages/runtime/src/runtime.ts`.
- **No external identities or token exchange.** An app can't match its users to Partan's by external ID, or mint a short-lived token for one user so its browser can call Partan. *Would live in*: `packages/identity` and the public API. Planned in `docs/design/public-api.md`.
- **No organisation-wide change events.** The stream covers one session; there are no webhooks. Planned.
- **No agent package format.** An agent is assembled from separate calls (profile, skills, memory, rules, host tools, schedules); nothing installs them together. *Would live in*: beside `PUT /v1/profiles/{agentId}`.
- **`idempotent` host tools aren't replayed.** The policy is accepted but treated as `unsafe` after a crash. *Would live in*: `packages/runtime`.

## Approvals and connections

- **Agents can't ask for a connection.** `propose` exists, but no session tool calls it, so `connection.approval` cards don't reach live transcripts. *Would live in*: a session tool in `packages/runtime`.
- **No approvals inside an app.** Connection approvals happen in the console. *Would live in*: the approval API, with a host-facing flow. Planned.
- **No route to answer cards.** `POST /v1/sessions/{sessionId}/cards/{cardId}/respond` is planned; question cards are defined but never emitted. *Would live in*: `packages/api/src/routes.ts` and `@harbour/runtime/http`.
- **No way to add items or policies to the encrypted store** from the console or a public route; items come from deployment seeding or the self-hosted policy file. *Would live in*: `packages/vault/src/approval-api.ts` and `packages/ui/src/vault`.
- **Session blocking and egress usage have no console UI**, though the routes are served. *Would live in*: the console's session view.
- **No key rotation for the encrypted store** on either target. *Would live in*: `@harbour/vault`.
- **No sandbox egress on Cloudflare.** Isolates have no network and containers start with internet off, so package installs and private repository seeds don't work there. *Would live in*: an egress gateway in `apps/cloudflare`.
- **Browser grants live in memory.** A restart forgets them. *Would live in*: a store in `packages/browser`.

## Workspaces, skills, memory and schedules

- **Private repositories don't seed**; only public GitHub tarballs. *Would live in*: `apps/cloudflare/src/stack.ts`, with the vault's egress.
- **`/project` and `/org` mounts aren't wired** into sessions, though the mount sources exist. *Would live in*: each deployment's stack.
- **Share invites don't notify or grant.** They are stored and listed only. *Would live in*: `@harbour/workspace/shares`.
- **Skills can't be written over HTTP.** Drafts and publishing exist in `@harbour/skills/writes`, but the API serves reads and imports only, so the console's skills page is read-only. *Would live in*: `packages/skills/src/http.ts`.
- **No console editor for agent profiles.** *Would live in*: `apps/console`.
- **Memory proposals aren't served**, and agents have no tool to save to memory. *Would live in*: `packages/memory/src/http.ts` and `packages/runtime/src/context.ts`.
- **Memory spaces can't be created in the console.** *Would live in*: `packages/ui`.
- **Reminder, summary, heartbeat and program schedules have no handler** on Cloudflare, so their runs fail; the console creates tasks and checks only. *Would live in*: `apps/cloudflare/src/schedules.ts`.
- **No route for a check's findings.** *Would live in*: `packages/schedules/src/http.ts`.
- **Agents can't create schedules.** *Would live in*: a schedules tool, if wanted.
- **No route for platform prompt rules**; only a system caller writes them. *Would live in*: `packages/rules`.

## Organisations, members and audit

- **Organisations can't be created over the API, and projects not from the console.** Each deployment makes its organisation when it starts; `POST /v1/projects` creates projects, but the console has no form for it. *Would live in*: `packages/identity/src/http.ts` and the console's projects pages.
- **Members can't be invited, and roles can't be granted or removed**, beyond the first admin. *Would live in*: `packages/identity/src/http.ts` and the Members page.
- **The console's key form** picks one project and offers no `import` permission. *Would live in*: `packages/ui/src/identity/api-keys.tsx`.
- **The `import` permission has no effect self-hosted.** *Would live in*: `apps/selfhosted/src/gateway/gateway.ts`.
- **Shares and access requests can't be created in the console**, only decided. *Would live in*: `packages/ui/src/sharing`.
- **No audit retention setting**, so rows are kept for ever. *Would live in*: a route beside `/v1/audit/events`.
- **`model.call` events have no filter** in the audit log. *Would live in*: `packages/ui/src/audit/audit-model.ts`.

## Deploying

- **Your own Cloudflare account.** Creating the Access application, the Workers VPC service, D1 and R2 is in a private runbook, not in the repository. *Would live in*: `apps/cloudflare/README.md`.
- **Cloudflare needs CLIProxyAPI to deploy.** The deploy step requires a Workers VPC service ID. *Would live in*: `apps/cloudflare/scripts/deploy-config.ts`.
- **Container region is fixed** to `WEUR`. *Would live in*: the same file.
- **No production self-hosted setup.** `deploy/compose` is a development stack with fixed passwords. *Would live in*: `deploy/`.
- **Kubernetes** has manifests for the browser host only, not yet run on a cluster. *Would live in*: `deploy/kubernetes`.
- **No self-hosted cost estimate.** *Would live in*: `deploy/compose/README.md`.

<!-- Sources (d031001): writers' gap notes, checked against apps/cloudflare/src/gateway.ts:1-36, apps/selfhosted/src/gateway/gateway.ts:1-30, apps/selfhosted/src/gateway/sandboxes.ts:8-27, apps/cloudflare/src/models.ts:127-157, apps/selfhosted/src/gateway/models.ts:127-145, packages/contracts/src/models.ts:200-241, docs/design/org-api-keys.md:1-25, docs/design/public-api.md:33-40,61,157-178, apps/cloudflare/test/remote/deployed.test.ts:6-11, packages/runtime/package.json:4, packages/api/package.json:4, packages/contracts/src/identity.ts:462-464, deploy/compose/compose.yaml:224-271, docs/usage-analytics.md:3-6, packages/runtime/src/http/server.ts:60-90, packages/runtime/src/runtime.ts:566-595, packages/vault/CONTRACT.md:1-24, packages/vault/src/approval-api.ts:7-27, apps/cloudflare/README.md:21-22,89-90,229-245,296-301,361-410, packages/browser/src/session.ts:22-23, packages/workspace/CONTRACT.md:148,200-230, packages/skills/CONTRACT.md:96-103, packages/memory/CONTRACT.md:136-142, apps/cloudflare/src/schedules.ts:7-13, packages/rules/CONTRACT.md:24-31, packages/identity/src/http.ts:484-488, packages/contracts/src/audit.ts:179-186, packages/ui/src/audit/audit-model.ts:40-53, apps/cloudflare/scripts/deploy-config.ts:29-36,104-133, deploy/kubernetes/browser-host/README.md:61-68; PR #389 -->
