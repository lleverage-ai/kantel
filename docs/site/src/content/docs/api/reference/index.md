---
title: API reference
description: Every route in Partan's public API, generated from the routes themselves, and the routes not in it yet.
sidebar:
  order: 0
  label: Overview
---

The public API is defined once, in `packages/api/src/routes.ts`. The OpenAPI document (`packages/api/generated/openapi.json`) and the TypeScript SDK (`packages/api/generated/sdk.ts`) are generated from those definitions, and CI fails when either is stale. The pages in this section are generated from the OpenAPI document by `docs/site/scripts/api-reference.ts`, and CI fails when they are stale too, so the reference can't drift from the routes.

Every path is under `/v1` on your deployment's origin, such as `https://partan.example.com/v1/sessions`. Each route names its SDK method.

| Page | Covers |
| --- | --- |
| [Sessions](/api/reference/sessions/) | Create, list, read, close, abort, fork and warm sessions |
| [Messages and results](/api/reference/messages/) | Send messages, wait for a run's result, choose models |
| [Stream and history](/api/reference/stream/) | A session's live stream and its history |
| [Skills](/api/reference/skills/) | Published skills, revisions and files, and imports |
| [Prompt rules](/api/reference/rules/) | Prompt rules at each level |
| [Memory](/api/reference/memory/) | Memory spaces, concepts, search, recall and snapshots |
| [Schedules](/api/reference/schedules/) | Schedules and their runs |
| [Browsers](/api/reference/browsers/) | Embedding a session's browser |
| [File shares](/api/reference/shares/) | Sharing a workspace file |
| [Resource sharing](/api/reference/sharing/) | Shares, access requests, bindings and policies |
| [Connections](/api/reference/connections/) | Connecting outside services |
| [Types](/api/reference/types/) | Every named type |

## Not every route is in it yet

Both deployments serve more under `/v1` than the public API defines: who you are, API keys, the audit log, agent profiles, host tools, workspaces' files, the vault's approvals and others. The console uses them, and so can your app, but they aren't in the OpenAPI document or the SDK, and may change without notice. They are listed on [Unlisted routes](/api/reference/unlisted/).

Some public routes aren't served by both deployments either. The self-hosted gateway doesn't serve schedules, file shares or session history yet. See [Deployment overview](/deploy/overview/#features-on-each-target-today).

## Get the OpenAPI document

The document is OpenAPI 3.1. Take it from the repository at `packages/api/generated/openapi.json`, or generate it again:

```bash
pnpm --filter @harbour/api generate
```

<!-- Sources (d031001): packages/api/README.md:1-30, packages/api/package.json:1-20, packages/api/generated/openapi.json, .github/workflows/ci.yml:66-74, docs/site/scripts/api-reference.ts, apps/selfhosted/src/gateway/gateway.ts:1-30 -->
