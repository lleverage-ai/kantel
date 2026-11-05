---
title: Environments and protected variables
description: Give sandboxes the variables, secret files, repositories and grants they need from one named environment. A protected variable never enters the sandbox; the host's egress proxy puts the value into requests to the places you bind it to.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
Environments are part of Kantel's API, which every control plane serves. Protected variables and grants work on sandboxes on [your own hosts](/hosts/), whose egress proxy does the work, not on the built-in stand-in (`KANTEL_COMPUTE_BACKEND=stub`). Their shapes may still change.
:::

An environment is a named set of things a new sandbox starts with. Make one for each kind of work, such as `work` or `ci`, and start sandboxes from it with `kantel new --env work`.

## What an environment holds

| Part | What the sandbox gets |
| --- | --- |
| Variables | Environment variables every command sees. A plain one holds its value. A [protected](#plain-and-protected-variables) one holds a placeholder, never the value |
| Secret files | Files written into the sandbox once it runs, such as `~/.npmrc`. Kantel keeps their content encrypted and never shows it again, but the sandbox can read them |
| Repositories | `https://` git repositories cloned into the sandbox once it runs, through the egress proxy |
| Grants | Rules that allow or refuse requests by host, method and path, on top of the account's [proxy settings](/sandboxes/egress-proxy/#grants) |

Changes apply to sandboxes made after them. The exceptions are a protected variable's value and bindings, and grants, which running sandboxes pick up within seconds.

An [isolate](/sandboxes/types/) sandbox gets the variables, protected ones included, and the grants. Secret files and repositories need a microVM: an isolate keeps files only under `/workspace` and has no `git`. Kantel doesn't skip them silently. Each one that can't be written or cloned is a `sandbox.degraded` event saying why, and the sandbox keeps running.

Names are lower-case letters, digits and hyphens, unique in the account. Each environment has an ID too, such as `env_3k8m2xq9pa`, and every command takes either.

## Make one and use it

The examples use the [command line](/tools/cli/), signed in to your Kantel.

```sh
kantel env create work --description "Day-to-day agent work"
printf '%s' "$GH_TOKEN" | kantel env set work GH_TOKEN --value-stdin --protected --bind api.github.com --bind github.com
kantel env set work NODE_ENV=development
kantel env file work /home/user/.npmrc --from ~/.npmrc
kantel env repo add work https://github.com/acme/app --path /home/user/app
kantel new --type microvm --env work
```

The sandbox starts with `NODE_ENV` and `GH_TOKEN` in its environment, `.npmrc` in its home and the repository in `/home/user/app`. `gh`, which reads `GH_TOKEN`, and `curl -H "authorization: Bearer $GH_TOKEN"` work against GitHub as they would with the real token.

`kantel env show work` lists what the environment holds. It shows a plain variable's value, but only the bindings of a protected one:

```text
id           env_3k8m2xq9pa
name         work
description  Day-to-day agent work
sandboxes    1
updated      2026-11-03 14:05 UTC (just now)

Variables:
  NAME      VALUE        SENT ONLY TO
  GH_TOKEN  protected    api.github.com, github.com
  NODE_ENV  development
Files:
  PATH               MODE  SIZE  UPDATED
  /home/user/.npmrc  0600  88 B  just now
Repos:
  URL                          PATH            REF
  https://github.com/acme/app  /home/user/app
Grants: none
```

Secret files and repositories are added after the sandbox starts. If one fails, such as a clone of a repository that doesn't exist, the sandbox still runs, and the failure is recorded in its [events](/api/reference/events/).

A sandbox can still have variables of its own: `kantel new --env work -e DEBUG=1`. They come after the environment's and win over its plain ones, but may not name one of its protected variables. Kantel keeps some names for itself and refuses them in an environment: `KANTEL_*`, `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, in any case.

## Plain and protected variables

A plain variable is an ordinary environment variable. Its value is in the sandbox, so anything that runs there can read it, print it or send it anywhere the egress rules allow. Use plain variables for settings, not secrets.

A protected variable is for a credential the sandbox should use but never hold. You bind it to the destinations it is for, and the sandbox gets a placeholder in its place:

```sh
kantel exec sbx_g2yy5jhyqr -- 'echo $GH_TOKEN'
```

```text
kph_7Qx2mR0cV9pLwE3nT8aZ4kYbJ6sHdF1gU5oNiC2q
```

A program uses the placeholder as it would the token. When a request that carries it goes to a destination it is bound to, the host's egress proxy swaps it for the real value on the way out. A request that carries it anywhere else is refused.

A binding is a host, and optionally a path prefix and methods. With `--bind`, that is `<host>[/path-prefix][:METHOD,METHOD]`:

| `--bind` | The value may go to |
| --- | --- |
| `api.github.com` | Any request to `api.github.com` |
| `*.example.com` | Any name under `example.com`, but not `example.com` itself |
| `api.github.com/repos/acme/` | Paths under `/repos/acme/` only |
| `api.openai.com/v1/:POST,GET` | `POST` and `GET` requests to paths under `/v1/` |

Repeat `--bind` for more. The port is always 443. Bind as narrowly as the program allows: see [which credentials suit protected mode](#which-credentials-suit-protected-mode).

Set a protected value with `--value-stdin`, as above, rather than as `NAME=value`, which leaves it in your shell's history and the process list.

## How a protected variable works

Each sandbox gets its own placeholder for each protected variable: `kph_` and 40 random letters and digits, made when the sandbox is created and kept while it lives. A placeholder means nothing outside its sandbox. A fork gets fresh ones. The parent's placeholders are never swapped for the fork: a request from the fork carrying one is refused with `placeholder-unknown` and logged. A live fork keeps the parent's running processes, and their environment still holds the parent's placeholders, so restart any that make protected requests; new commands and shells get the fork's own.

The real value lives in three places only:

- in the control plane's database, encrypted with the deployment's key, [`KANTEL_SECRETS_KEY`](/self-hosting/install/#your-own-settings), and tied to its record, so it can't be moved to another;
- on its way to the sandbox's host, over the host's authenticated connection to Kantel;
- in the host agent's memory, while it serves the sandbox.

It is never in the sandbox, its environment or its disk, a snapshot or a fork, the host's disk, a log line, an event, an error message, a webhook or any answer the API gives. Kantel never shows it again once it is set.

### Which requests the proxy reads

The proxy can swap a placeholder only in a request it can read. It reads:

- plain HTTP requests;
- HTTPS requests to a bound host, and to a host with a [grant](/sandboxes/egress-proxy/#grants) that names methods or paths.

For those hosts the proxy ends TLS itself, with a certificate from a certificate authority of the sandbox's own. That authority can only sign for the bound hosts, its key never enters the sandbox, and its certificate is in the sandbox's system trust store. The proxy then opens its own TLS connection to the real host and checks that host's certificate against the usual public roots. It offers HTTP/1.1 only, and passes WebSocket upgrades through.

HTTPS to every other host is a tunnel the proxy passes on without reading, as it always has. A program that brings its own list of trusted certificates, rather than using the system's, has to be pointed at the system's to reach a bound host. Node, Bun and Python's `requests` already are: a microVM behind the proxy sets `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE` to `/etc/ssl/certs/ca-certificates.crt`.

The proxy also turns a value back into its placeholder in what the host answers, so an API that echoes a request never hands the sandbox the value. It finds the value as it is and escaped up to two layers deep, as percent-escapes, JSON or HTML would write it. A value the API changes in some other way, such as base64 or a hash, gets through, so bind a value only to the hosts that should have it.

### Rotate a value

To rotate a credential, set the variable again with the new value:

```sh
printf '%s' "$NEW_GH_TOKEN" | kantel env set work GH_TOKEN --value-stdin
```

It stays protected, with the bindings it had. Running sandboxes keep their placeholder and send the new value from their next request, with nothing to restart. To change where a value may go without entering it again, use `--keep-value` with the new bindings:

```sh
kantel env set work GH_TOKEN --keep-value --bind api.github.com --bind github.com --bind uploads.github.com
```

`--plain` turns a protected variable into a plain one, which puts its value in new sandboxes. `kantel env unset work GH_TOKEN` removes it.

## The egress log

Each sandbox keeps a log of its newest 1,000 outbound requests, allowed and refused, with the protected variables swapped into each. It never holds a value or a query string.

```sh
kantel egress sbx_g2yy5jhyqr
```

```text
sandbox      sbx_g2yy5jhyqr (fix-login-bug)
environment  work (env_3k8m2xq9pa)
protected    GH_TOKEN (kph_7Qx2…) to api.github.com, github.com

TIME                 METHOD   DESTINATION          DECISION     CODE/RULE            SWAPPED
2026-11-03 14:07:41  POST     paste.example/api    denied 403   placeholder-unbound
2026-11-03 14:07:12  GET      api.github.com/user  allowed 200                       GH_TOKEN
2026-11-03 14:06:58  CONNECT  registry.npmjs.org   allowed
```

`--denied` shows only refusals, and `--json` the whole answer. A tunnel the proxy doesn't read shows as one `CONNECT`, with no path. The API serves the same log at `GET /v1/sandboxes/{sandboxId}/egress`.

## Refusals

When the proxy refuses a request, or can't complete one, it answers the sandbox itself, with a plain-text body of a sentence or two saying why, and these headers:

| Header | What it holds |
| --- | --- |
| `X-Kantel-Proxy-Error` | The code, below |
| `X-Kantel-Proxy-Rule` | The grant that decided, such as `deny DELETE api.github.com /repos/*` |
| `X-Kantel-Proxy-Variable` | The variable whose placeholder was in the wrong place, for `placeholder-unbound` |

| Code | Why |
| --- | --- |
| `denied` | A grant refused the request. `X-Kantel-Proxy-Rule` names it |
| `placeholder-unbound` | The request carried a placeholder to a destination outside the variable's bindings. Nothing was sent |
| `placeholder-unknown` | The request carried a placeholder that isn't this sandbox's, such as a fork's parent's. It is never swapped, and nothing was sent |
| `secret-unavailable` | The host couldn't get the value from Kantel, such as while the control plane is unreachable. Nothing was sent |
| `upstream-failed` | The proxy couldn't connect to the real host, or that host's certificate didn't check out |
| `body-too-large` | The request's body was larger than the proxy reads to swap placeholders in |

`denied`, `placeholder-unbound` and `placeholder-unknown` come with status 403, and `secret-unavailable` and `upstream-failed` with 502 or 503. A request refused before an HTTPS tunnel opens gets the same headers on its 403, though `curl` then shows only `CONNECT tunnel failed, response 403`. Every refusal is in the [egress log](#the-egress-log).

## Check a sandbox

Inside a sandbox, `kantel-doctor` checks its egress: the proxy variables, the sandbox's certificate authority in the trust store, and, for each placeholder in its environment, that the proxy accepts it for a bound host.

```sh
kantel exec sbx_g2yy5jhyqr -- kantel-doctor
```

```text
ok HTTP_PROXY: set (10.231.0.13:3129)
ok HTTPS_PROXY: set (10.231.0.13:3129)
ok egress certificate: in /etc/ssl/certs/ca-certificates.crt
ok GH_TOKEN api.github.com: would be swapped
```

It comes with the sandbox images from the release after `host-images-20261103.1`. An isolate sandbox has no `kantel-doctor`; `kantel egress <sandbox>` shows what its requests did.

For each placeholder it sends a `HEAD` request to a bound host through the proxy, marked with an `X-Kantel-Proxy-Check` header. The proxy completes a real TLS handshake with that host, then answers the check itself, with `ok` or an error code, so the value goes nowhere.

## Which credentials suit protected mode

The proxy swaps a placeholder for the value in the bytes of an HTTP request. That suits a credential a program sends as it is, and not one it computes with or needs to read.

Suitable:

- bearer tokens and API keys sent in a header, such as GitHub, npm, OpenAI and Anthropic tokens, and those of most HTTP APIs;
- Basic auth, such as `git` over HTTPS with a token as the password;
- a key sent in the query string or the request body.

Not suitable:

- **Request-signing secrets**, such as AWS SigV4 and other HMAC signing. The program signs the request with the placeholder, so the signature no longer matches once the value is swapped in. Give the sandbox short-lived credentials instead, as plain variables.
- **Database passwords and other protocols that aren't HTTP.** The proxy only reads HTTP, so a placeholder sent to Postgres, MySQL or Redis stays a placeholder.
- **SSH keys.** SSH isn't HTTP, and a key signs rather than being sent.
- **Anything the sandbox must read**, such as a key a program decrypts files with. The sandbox only ever sees the placeholder. Use a plain variable, ideally with a short-lived credential.

A client that pins certificates refuses the proxy's certificate for a host it intercepts, so bind only the hosts that need the value. A pinned client needs a plain, short-lived value instead.

Two limits are worth knowing:

- **A placeholder in a tunnel the proxy doesn't read isn't seen.** If a program sends a placeholder over HTTPS to a host it isn't bound to, and no grant has the proxy read that host, the proxy can't see it, so it can't refuse it. It isn't swapped either, so what arrives there is worthless.
- **A bound API that hands the value back can leak it.** The proxy scrubs the value from responses, back to the placeholder, so an API that stores a value and echoes it as it was gives the sandbox only the placeholder. An API that can transform what it returns, such as one that stores a value and later serves it base64-encoded, can still hand the real value to the sandbox. Bind narrowly, with path prefixes and methods, to the endpoints that need the credential.

## The API and the console

Environments belong to the account, as the [proxy settings](/sandboxes/egress-proxy/) do. Reading them needs `account:read`, and changing them `account:admin`.

| Route | What it does |
| --- | --- |
| `GET /v1/environments`, `POST /v1/environments` | List the account's environments, and make one |
| `GET`, `PATCH` and `DELETE /v1/environments/{environmentId}` | Read one, change its name or description, and delete it |
| `PUT` and `DELETE /v1/environments/{environmentId}/variables/{name}` | Set a variable, and remove it |
| `PUT /v1/environments/{environmentId}/files`, `DELETE …/files?path=` | Set a secret file, and remove it |
| `PUT /v1/environments/{environmentId}/repos` | Replace its repositories |
| `PUT /v1/environments/{environmentId}/grants` | Replace its grants |
| `GET /v1/sandboxes/{sandboxId}/egress` | A sandbox's egress log, its protected variables (names and the first 8 characters of their placeholders) and its grants |
| `PUT /v1/sandboxes/{sandboxId}/grants` | Replace a sandbox's own grants |

To start a sandbox from an environment, send its name or ID as `environment` when you [create the sandbox](/sandboxes/lifecycle/):

```sh
curl -s "$KANTEL_URL/v1/sandboxes" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"type": "microvm", "environment": "work", "wait": true}'
```

The [API reference](/api/reference/) has every field. The console edits the same environments.

Protected values and secret files need the deployment to have a secrets key. Where it has none, setting one is refused with `not_supported` ("This deployment doesn't support protected variables or secret files"), plain variables still work, and `GET /v1/whoami` says `protectedValues: false`: the CLI and console check it and say so before writing anything. On a self-hosted install the key is `KANTEL_SECRETS_KEY` on the control plane; see [Your own settings](/self-hosting/install/#your-own-settings).

<!-- Sources: the TASK-4826 contract (protected environment variables); packages/cli/src/commands.ts and packages/cli/src/environments.ts for the commands and their output. -->
