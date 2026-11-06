---
title: Accounts and organisations
description: Your personal account and the organisations you belong to, sharing sandboxes with an organisation, members and their roles, inviting people with a join code, and an account's usage and limits.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

Everything in Kantel belongs to an account: sandboxes, snapshots, API keys, webhooks and settings. There are two kinds.

- Your **personal account**, your personal space, is made the first time you sign in. What you create there, hosts included, is yours alone.
- An **organisation** is an account people create or join to share hosts, sandboxes and snapshots. You can belong to any number.

## In the console

- **Create an organisation**: open the account switcher and select **Create an organisation**. You become its owner, and the console switches to it.
- **Invite someone**: switch to the organisation, open **Settings**, then **General**, select **Invite**, and enter their email address and a role. Where the deployment sends mail, Kantel emails them a link that opens the console's **Join** with the code filled in. Otherwise, or if the email doesn't arrive, pass on the join code it shows. The code is shown once. On a self-hosted install, someone who can't sign in to it yet isn't emailed: an admin invites them to the deployment first. Admins and owners change a member's role from the same list.
- **Join one**: open the account switcher, select **Join with an invite code**, and enter the code you were given. Sign in first with the email address the invite was made for: signed in as anyone else, the console says which email the invite is for and offers **Sign out**.

The account switcher also moves you between your personal space and your organisations. The rest of this page does the same over the API.

The examples use `KANTEL_URL` and `KANTEL_API_KEY` as set in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start).

## Who you are and where you act

`GET /v1/whoami` answers who is calling and the accounts they may act in. Any key may call it:

```sh
curl -s "$KANTEL_URL/v1/whoami" -H "authorization: Bearer $KANTEL_API_KEY"
```

```json
{
  "apiKey": { "id": "key_5n2p8r", "name": "ci", "scopes": ["sandboxes:read", "sandboxes:write", "sandboxes:delete", "exec", "files", "access", "snapshots:read", "snapshots:write", "account:read"] },
  "accountId": "acc_7f3k2m9q",
  "accounts": [{ "id": "acc_7f3k2m9q", "kind": "organisation", "name": "Acme", "role": "admin", "defaultVisibility": "organisation", "createdAt": 1793660400000 }],
  "superAdmin": false,
  "mode": "selfhosted"
}
```

An API key always acts in the account it was made in. A person, or their [personal access token](/accounts/api-keys/#personal-access-tokens), acts in their personal account unless a call names an organisation they belong to, with `account` in its body or query. Signed in with a token, `whoami` also answers `personalToken`, with any limits it has; a token limited to one account acts there by default. `superAdmin` says whether the caller may manage the deployment's hosts, and `mode` whether this is a self-hosted install (`selfhosted`) or a hosted service (`hosted`).

To list the accounts with their kind and your role in each, call `GET /v1/accounts` (`listAccounts`), which needs `account:read`.

## Roles

| Role | Can |
| --- | --- |
| `member` | Use the organisation's shared sandboxes and snapshots, and make their own |
| `admin` | Everything a member can, and manage members, invites, API keys, webhooks, OpenTelemetry, the proxy and the organisation's settings |
| `owner` | Everything an admin can, and delete the organisation and make or unmake owners |

You are the owner of your personal account. An organisation always keeps at least one owner.

## Sharing sandboxes

A sandbox in an organisation is `private` or `organisation`:

- `private`: only the person who made it, and their API keys, can see or use it;
- `organisation`: every member can.

A sandbox in a personal account is always `private`. Choose when you create it with `visibility`, or change it later:

```sh
curl -s -X PATCH "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"visibility": "organisation"}'
```

An admin sets what new sandboxes start as with the organisation's `defaultVisibility`:

```sh
curl -s -X PATCH "$KANTEL_URL/v1/accounts/acc_7f3k2m9q" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"defaultVisibility": "private"}'
```

The same call renames the organisation, with `name`. It needs `account:admin` and an admin's role.

## Create an organisation

Creating, joining and deleting an organisation need a person's sign-in, the bearer token you sign in to the console with: an API key is refused. The call is `POST /v1/accounts` (`createOrganisation`) with a `name` and, optionally, a `defaultVisibility`. You become its owner.

## Invite people

An admin makes an invite, and gets a join code to pass on. The code is shown only once:

```sh
curl -s "$KANTEL_URL/v1/accounts/acc_7f3k2m9q/invites" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"email": "sam@example.com", "role": "member", "expiresInHours": 72}' | jq -r .code
```

```ts
const invite = await kantel.createInvite("acc_7f3k2m9q", { email: "sam@example.com", role: "member" });
console.log(invite.code); // kji_...
```

| Field | What it does |
| --- | --- |
| `role` | The role the person joins with |
| `email` | Only this person may use the code. Leave it out to make a code anyone holding it can use |
| `expiresInHours` | How long the code works. Default 168 (a week), at most 720 (30 days) |

With an `email`, where the deployment sends mail (self-hosted with `KANTEL_SMTP_URL`, or the hosted service), Kantel emails the invite with a link to the console that opens **Join** with the code. The answer's `emailed` says whether it went. Self-hosted sign-in is invite-only, so an invite to someone who can't sign in to the deployment yet isn't emailed (`emailed: false`): an admin invites them to the deployment, and then they join with the code. The code is in the link's fragment, which a browser doesn't send, so it stays out of request logs.

The person joins with the code, signed in as themselves (`POST /v1/accounts/join`, `joinOrganisation`). A code that has expired or has been used answers `410` with `expired`.

To see open invites, call `GET /v1/accounts/{accountId}/invites` (`listInvites`); their codes aren't shown again. To withdraw one, revoke it:

```sh
curl -s -X DELETE "$KANTEL_URL/v1/accounts/acc_7f3k2m9q/invites/$INVITE_ID" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

Invites and member changes need `account:admin`.

## Manage members

```sh
curl -s "$KANTEL_URL/v1/accounts/acc_7f3k2m9q/members" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {userId, name, role}'
```

Change a member's role:

```sh
curl -s -X PATCH "$KANTEL_URL/v1/accounts/acc_7f3k2m9q/members/$USER_ID" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"role": "admin"}'
```

Only an owner can make someone an owner or take it away, and the last owner stays an owner.

Remove a member with `DELETE /v1/accounts/{accountId}/members/{userId}` (`removeMember`). A member can leave the same way, with their own user ID; the last owner can't. Sandboxes the person kept `private` stay in the organisation, stopped, for an admin to delete or share.

## Personal access tokens

Members' personal access tokens act in an organisation with each member's own role, unless an admin blocks them. Blocked, a call made with one there answers `403`, and members use the console or one of the organisation's API keys. Their tokens still work in their other accounts:

```sh
curl -s -X PATCH "$KANTEL_URL/v1/accounts/acc_7f3k2m9q" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"personalTokens": "blocked"}'
```

In the console it is **Allow personal access tokens** under **Settings**, **General**, and from the command line `kantel org set --personal-tokens blocked`. An account answers its setting as `personalTokens`. A personal account always allows its own person's tokens.

## Delete an organisation

Its owner can delete an organisation (`DELETE /v1/accounts/{accountId}`, `deleteOrganisation`), signed in, once it has no sandboxes and no saved snapshots left; until then it answers `409` with `conflict`. A personal account can't be deleted this way: delete your account instead.

## Delete your account

In the console, **Settings → Profile → Delete account**; through the API, `DELETE /v1/whoami` (`deleteCaller`), signed in as yourself, not with an API key or a personal token. It deletes your personal account with its hosts, environments, webhooks and templates, revokes every API key that acts for you in any account and every personal token of yours, takes you out of every organisation, and signs you out everywhere. Sandboxes you kept `private` in an organisation stay there, stopped, as when you leave it.

It answers `409` with `conflict` while your personal account has sandboxes, saved snapshots or bundles, or while you're the last owner of an organisation: make someone else an owner, or delete the organisation, first. A deployment's super-admin can't delete their own account. Once those checks pass, the deletion is accepted: your personal account is closed for good, you're signed out and can't sign in as that person again, and Kantel carries the deletion on in the background until everything has gone, a final pass included a few minutes later. Signing in again afterwards makes a new, empty account.

## Usage and limits

An account's usage covers its running time and cost since a moment you choose, the last 24 hours by default:

```sh
curl -s "$KANTEL_URL/v1/accounts/acc_7f3k2m9q/usage" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

```json
{
  "accountId": "acc_7f3k2m9q",
  "since": 1793574000000,
  "running": 3,
  "runningSeconds": 41820,
  "cost": { "currency": "USD", "total": 0, "ratePerHour": 0 },
  "limits": { "concurrentSandboxes": 20, "startsPerMinute": 30, "savedSnapshots": 25 }
}
```

`limits` appears where the deployment sets any: how many sandboxes may run at once, how many may start a minute, and how many saved snapshots the account keeps. A call past a limit answers `429` with `exhausted`. A self-hosted install's rates are 0 unless its operator sets them, so its costs are 0 too.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:105-314, packages/api/src/compute-schema.ts:55-197, packages/api/src/compute-schema.ts:477-504 -->
