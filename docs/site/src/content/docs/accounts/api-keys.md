---
title: API keys
description: Make scoped API keys for scripts, CI and agents, with presets, sandbox limits and expiry; what each scope allows; and rotating and revoking a key.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

An API key lets a program act for an account without anyone signing in. Each key has scopes, the things it may do, so you can give an agent a key that drives sandboxes but can't delete them or change your account. A key's secret starts `ksk_`. Kantel shows it once, when the key is made, and keeps only enough to check it.

## Use a key

Send the secret as a bearer token:

```sh
export KANTEL_URL=http://127.0.0.1:58090
export KANTEL_API_KEY=ksk_...
curl -s "$KANTEL_URL/v1/whoami" -H "authorization: Bearer $KANTEL_API_KEY"
```

In fish, use `set -x` instead of `export`. `whoami` answers the key's name, its scopes and the account it acts in. A key always acts in the account it was made in.

A call with no key, or a wrong, revoked or expired one, answers `401` with `unauthenticated`. A key without the scope a call needs answers `403` with `forbidden`. Each route in the [API reference](/api/reference/) names the scope it needs.

## Make your first key

A self-hosted install makes the first key itself, with every scope, when you [turn on the compute API](/self-hosting/install/#turn-on-the-compute-api). Use it to make the others, as below: any key holding `account:admin` can.

## Scopes

| Scope | Allows |
| --- | --- |
| `sandboxes:read` | Listing and reading sandboxes, their usage and their events |
| `sandboxes:write` | Creating, changing, starting, stopping, pausing, resuming, forking and recovering sandboxes |
| `sandboxes:delete` | Deleting sandboxes for good |
| `exec` | Running, reading and killing commands |
| `files` | Reading, writing, listing and deleting files |
| `access` | SSH, the desktop, the browser and public ports |
| `snapshots:read` | Listing snapshots and reading their files |
| `snapshots:write` | Taking, saving and deleting snapshots |
| `account:read` | Reading the account, its members and its keys |
| `account:admin` | Managing members, invites, keys, webhooks, OpenTelemetry and the proxy |
| `hosts:admin` | Managing the deployment's hosts. Only a super-admin's key can hold it |

## Presets

A preset is a named set of scopes:

| Preset | Scopes | For |
| --- | --- | --- |
| `read-only` | `sandboxes:read`, `snapshots:read`, `account:read` | Dashboards and reports |
| `agent` | `sandboxes:read`, `sandboxes:write`, `exec`, `files`, `access`, `snapshots:read`, `snapshots:write`, `account:read` | A coding agent that makes and drives its own sandboxes, but can't delete them |
| `ci` | Everything in `agent`, and `sandboxes:delete` | A job that cleans up after itself |
| `admin` | Every scope except `hosts:admin` | People's own scripts |

## Create a key

Give a `name`, and a `preset`, `scopes` or both (they add up):

```sh
curl -s "$KANTEL_URL/v1/api-keys" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name": "claude-code-laptop", "preset": "agent", "expiresInDays": 30}'
```

```ts
const issued = await kantel.createApiKey({ name: "github-actions", preset: "ci", expiresInDays: 365 });
console.log(issued.secret); // ksk_... Store it now: it isn't shown again
```

The answer is an [IssuedApiKey](/api/reference/types/#issuedapikey): the key's details in `key` and its secret in `secret`. Store the secret straight away, in a secret manager or your CI's secrets.

| Field | What it does |
| --- | --- |
| `name` | Up to 100 characters, to tell keys apart |
| `preset` | One of the presets above |
| `scopes` | Scopes, beside or instead of a preset |
| `sandboxIds` | Limit the key to these sandboxes, and the ones it creates itself |
| `expiresInDays` | Days until it stops working, from 1 to 3,650. Leave it out for a key that doesn't expire |
| `account` | The organisation to make it in, when a person makes it |

A key can't hold a scope its maker lacks, so a key with the `agent` preset can't make an `admin` key. Making keys needs `account:admin`.

## Limit a key to some sandboxes

To let an agent work in one sandbox you've prepared and nowhere else, give the key `sandboxIds`:

```sh
curl -s "$KANTEL_URL/v1/api-keys" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name": "review-bot", "scopes": ["sandboxes:read", "exec", "files"], "sandboxIds": ["sbx_4kq9x2mt"]}'
```

The key also reaches any sandbox it creates itself, if it has `sandboxes:write`.

## List keys

```sh
curl -s "$KANTEL_URL/v1/api-keys" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {id, name, prefix, scopes, lastUsedAt, revokedAt}'
```

The list includes revoked keys. Each shows its `prefix`, the first characters of its secret such as `ksk_5n2p`, so you can match a key you hold to its entry. Listing needs `account:read`.

## Rotate a key

Rotating gives a key a new secret, with the same name and scopes. The old secret stops working at once:

```sh
curl -s -X POST "$KANTEL_URL/v1/api-keys/key_5n2p8r/rotate" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq -r .secret
```

To change a key with no moment where nothing works, make a new key with the same scopes, move your programs to it, then revoke the old one.

## Revoke a key

Revoke a key you no longer need, or one that has leaked. It stops working at once:

```sh
curl -s -X DELETE "$KANTEL_URL/v1/api-keys/key_5n2p8r" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

The answer is the key, with `revokedAt` set. Rotating and revoking need `account:admin`.

## Keep keys out of sandboxes

Don't pass a key into a sandbox through `env` or a file: anything that can run commands there can read it. Agents drive sandboxes from outside, with the key where the agent runs. For credentials a sandbox's own programs need, such as a token for a private registry, see the [proxy](/concepts/#the-proxy).

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:829-895, packages/api/src/compute-schema.ts:27-53, packages/api/src/compute-schema.ts:777-831, packages/api/src/compute-schema.ts:1199-1239 -->
