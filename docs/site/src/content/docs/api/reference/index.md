---
title: API reference
description: Every route in Kantel's public API, generated from the route definitions themselves, and how to get the OpenAPI document.
sidebar:
  order: 0
  label: Overview
---

Kantel's public API is defined once, in `packages/api`. The OpenAPI document (`packages/api/generated/openapi.json`) and the TypeScript SDK (`packages/api/generated/sdk.ts`) are generated from those definitions, and the pages in this section are generated from the OpenAPI document by `docs/site/scripts/api-reference.ts`. CI fails when any of them is out of date, so the reference can't drift from the code.

Every path is under `/v1` on your control plane's address, such as `http://127.0.0.1:58090/v1` for a local install. Send an API key as a bearer token:

```sh
curl -s "$KANTEL_URL/v1/me" -H "authorization: Bearer $KANTEL_API_KEY"
```

Each route on these pages names the SDK method that calls it.

:::caution[Experimental]
The compute plane's routes, for sandboxes, snapshots, organisations, API keys, the proxy, webhooks and hosts, are joining the document now, and each gets a page here as it does. Until then this section lists only the shared types.
:::

## Errors

Every error answers with the same body, an [ErrorBody](/api/reference/types/#errorbody):

```json
{ "error": { "code": "not_found", "message": "No such sandbox." } }
```

`code` is one of the values of [ErrorCode](/api/reference/types/#errorcode). A missing or wrong key answers `401` with `unauthenticated`, and a key without the scope a call needs answers `403` with `forbidden`.

## Get the OpenAPI document

The document is OpenAPI 3.1. Take it from the repository at `packages/api/generated/openapi.json`, or generate it from a checkout:

```sh
pnpm --filter @kantel/api generate
```

Any OpenAPI generator can make a client from it in another language.

<!-- Sources (e496aeb): packages/api/README.md:1-30, packages/api/package.json:1-20, packages/api/generated/openapi.json, .github/workflows/ci.yml:60-75, docs/site/scripts/api-reference.ts -->
