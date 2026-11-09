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
The compute plane's routes, for sandboxes, snapshots, accounts and organisations, API keys, the proxy, webhooks, OpenTelemetry and hosts, are in the document and on these pages. Every control plane serves them, and their shapes may still change.
:::

## Errors

Every error answers with the same body, an [ErrorBody](/api/reference/types/#errorbody):

```json
{ "error": { "code": "not_found", "message": "No such sandbox." } }
```

`code` is one of the values of [ErrorCode](/api/reference/types/#errorcode). A missing or wrong key answers `401` with `unauthenticated`, and a key without the scope a call needs answers `403` with `forbidden`.

Some errors say more in `details`. A call that needs a running sandbox (commands, files, ports, file URLs, archives) answers `409` `conflict` when the sandbox isn't running, with a [SandboxNotRunning](/api/reference/types/#sandboxnotrunning) in `details`: a stable `code` such as `sandbox_stopped` or `sandbox_starting`, the sandbox's `state`, the `stopReason` where Kantel recorded why it stopped, and a `hint` naming the resume call. A call made while the sandbox starts waits for it first, up to 60 seconds. See [When the sandbox isn't running](/sandboxes/commands-and-files/#when-the-sandbox-isnt-running).

## Safe retries

A call whose retry could do something twice takes an `Idempotency-Key` header. Send a value of your own, such as a UUID, new for each call and the same on each retry of it:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/$SANDBOX/commands" -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "idempotency-key: $(uuidgen)" -H "content-type: application/json" -d '{"command":"make deploy"}'
```

Keys belong to the key or person that sent them, one set per route. A retry with the same key gets one of these:

- **The first call's answer**, when it finished. Nothing is done again.
- **`409` `conflict` with `details.idempotencyKey: "in_progress"`**, while the first call is still working on another gateway. Retry shortly with the same key.
- **`409` `conflict` with `details.idempotencyKey: "held"`**, when the first call didn't finish: it failed part way (a `503` `unavailable`, such as a host that never answered, or a `500`), or its gateway stopped answering. It may have taken effect, or still will, so it is never done again under that key, and a lapsed call is never taken over. Check whether it took effect, then use a new key.
- **The work, done**, when the first call was refused before it did anything (a `4xx` such as `invalid`, `forbidden`, `not_found` or `conflict`). That frees the key.
- **`422` `refused`**, when the request differs from the first (another path, query or body). Use a new key for each new call.

These routes take a key:

| What | Routes |
| --- | --- |
| Sandboxes | create, fork, change (`extendMinutes` and `autoStopMinutes` count from now), recover, restart on the latest base, delete |
| Commands | run, detached or not |
| Ports | expose (a gated port gets a new token each time) |
| Snapshots | take, save |
| Account | create an organisation, invite someone, create or rotate an API key, create an environment, create a webhook or rotate its secret |
| Hosts | create a join token, for the deployment or an account |
| Mounts | create a bucket source |
| Templates | create, rebuild |

An answer that holds a secret (an API key, a join token, an invite code, a gated port's URL) is kept for retries sealed with the deployment's `KANTEL_SECRETS_KEY`. An install with a database and no secrets key keeps no copy: the call is still done once, and its retry is `409` `conflict` with `details.idempotencyKey: "withheld"`.

The others need no key, because a retry answers things as they are: stopping a stopped sandbox, starting or resuming a running one, killing an ended command, writing the same file, revoking a revoked key, exposing a public port again, uploading a bundle the account already has, changing a template to the spec it has (no new version), publishing a template base's current digest, or setting a variable to the same value. A webhook test sends another test event each time, which is what it is for. A second delete of a snapshot, webhook, environment or template, or a second hide of a port, is `404` `not_found`: take it as done.

The [SDK](/tools/typescript-sdk/) sends a key you give as `{ idempotencyKey }`, or makes one per call with the client's `idempotencyKey` option. The `kantel` CLI and its MCP server send a new key with each call that takes one. When it can't reach Kantel, or a proxy in front of it answers `502`, `503` or `504` with no answer of Kantel's own, the CLI tries again up to four times, waiting 0.5, 1, 2 and 4 s: a create, a fork or a command with the same key, a read as it is, and a file's write (`files put`, `scp`, `push`) as it is, since writing the same bytes again leaves the same file. It sends the other calls once: a stop or a delete takes no key, and a control plane from before the other calls took keys would do them again. It never retries an answer Kantel gave itself, a `409` included: a held key's `409` is reported, and running the command again sends a new key. The MCP server's tools say to check before calling again when a key is held.

A retry is checked against what you may do now, so a secret made while you could grant it isn't answered once you can't.

An API key rotating itself keeps no copy of its new secret, since its old secret can't sign in to a retry once it is done. The key still stops a retry that overlaps it from rotating it again: that retry is `409` `conflict`.

## Get the OpenAPI document

The document is OpenAPI 3.1. Take it from the repository at `packages/api/generated/openapi.json`, or generate it from a checkout:

```sh
pnpm --filter @kantel/api generate
```

Any OpenAPI generator can make a client from it in another language.

<!-- Sources (e496aeb): packages/api/README.md:1-30, packages/api/package.json:1-20, packages/api/generated/openapi.json, .github/workflows/ci.yml:60-75, docs/site/scripts/api-reference.ts -->
