---
title: Self-hosted
description: Run Kantel's self-hosted gateway with Docker Compose, Postgres and S3 storage, and set up sign-in, the vault, models and browsers.
---

Self-hosted Kantel is one gateway process on Bun, built from `apps/selfhosted/Dockerfile`. It serves the console and the API, keeps its state in Postgres, and keeps workspace and skill files in an S3-compatible bucket. `deploy/compose` runs it on one machine with Postgres, MinIO and Mailpit. For how it compares with Cloudflare, see the [deployment overview](/deploy/overview/).

The images and the Postgres database and schemas keep `harbour` in their names from before the rename. Settings named `HARBOUR_*` still work when the `KANTEL_*` one isn't set.

## Start it with Docker Compose

From the repository root:

```bash
docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

The console is at `http://127.0.0.1:58090/` (`KANTEL_GATEWAY_PORT` moves it). Every port is bound to 127.0.0.1, so on a remote machine forward it first: `ssh -L 58090:127.0.0.1:58090 <host>`. Mailpit, which catches sign-in codes, is at `http://127.0.0.1:58025/`.

To stop the stack and delete all its state:

```bash
docker compose -f deploy/compose/compose.yaml down -v
```

:::caution
`deploy/compose` is the repository's development and test stack. Its Postgres and MinIO passwords are fixed development values in `compose.yaml`, and it also starts services from an earlier prototype (`host-a`, `host-b`, `isolate-host`, `research-site`) that the gateway doesn't use. The gateway, two of those services and the browser host mount the Docker socket, which is root on the machine. There is no production compose file yet.
:::

The gateway depends on `postgres`, `minio`, `mailpit` and `browser-host`, and on two one-off services: `host-migrate`, which makes the table of the vault proxy's tokens, and `sandbox-image`, which builds the container tier's image. It reaches `vault-proxy` only when a sandbox container makes a request.

The installer at `https://kantel.dev/install.sh` runs the same stack from `~/.kantel/src`. With `--upgrade` it replaces that source, keeps `deploy/compose/.env`, and rebuilds and restarts the stack. Postgres, MinIO and the gateway's volume keep their data.

## First start

On its first start the gateway creates an organisation, a project and an operator API key (`ktk_…`) on that project. It writes their IDs and the key to `/var/lib/harbour/bootstrap.json` (mode 0600) in its volume. On later starts it reads the file back and keeps the same deployment while the key still works.

```bash
docker compose -f deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json
```

It also creates two agent profiles: `echo`, which always answers with the echo model, and `assistant`, on the `default` model route, once there's a model: the deployment's, or the default an admin picks when connecting a provider in the console. Both start with no prompt layers. Kantel adds no system prompt of its own: the prompt is what the profile's prompt layers and the prompt rules give it, plus recall and the skills listing.

`KANTEL_PROJECTS` takes more project names, comma-separated. Each is made once and put on the operator key. Naming a new one later issues a new key over them all and revokes the old one.

## Sign-in and API keys

People sign in with a one-time code sent by email. Kantel is invite-only: the gateway invites `KANTEL_ADMIN_EMAIL` (default `admin@harbour.localhost`) as an organisation admin at start, and nobody else can sign in until invited.

Codes go out through `KANTEL_SMTP_URL` from `KANTEL_MAIL_FROM`:

| `KANTEL_SMTP_URL` | Transport |
| --- | --- |
| `smtps://user:password@host:port` | TLS from the start |
| `smtp://user:password@host:port` | STARTTLS required |
| `smtp://host:port?starttls=off` | In the clear, for a relay on a private network |

Compose sends codes to Mailpit by default. Without `KANTEL_SMTP_URL` the sign-in routes answer 503, and a malformed value stops the gateway at start. Codes last 10 minutes and a signed-in session (`kts_…`) lasts 12 hours. The gateway allows 30 sign-in requests per client address per 15 minutes. Behind a reverse proxy every client shares one address, so limit there instead.

Set `KANTEL_PUBLIC_URL` (an origin, such as `https://kantel.example.com`) when people reach the console through a TLS proxy. Passkeys are made for that origin, and without it the gateway uses the request's own origin, which is `http:` behind a proxy.

Host apps use the bootstrap's operator key, or keys made on the console's `/keys` page. See [Authentication](/api/authentication/). Host tool callbacks must be `https:` unless `KANTEL_CALLBACK_ORIGINS` allows others, such as `http://127.0.0.1:*`.

## Postgres and storage

`KANTEL_DATABASE_URL` points the gateway at Postgres. Every table goes in one schema, `KANTEL_GATEWAY_SCHEMA` (default `harbour_m1`), and the vault in `<schema>_vault`. Without a database URL the gateway keeps everything in memory.

With a database URL the gateway also needs `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` (`S3_REGION` is optional). Workspace files go under `KANTEL_GATEWAY_S3_PREFIX` (default `m1/workspaces/`) and skill files under `KANTEL_SKILLS_S3_PREFIX` (default `m1/skills/`).

Sessions left mid-run resume when the gateway starts again.

## The vault

`KANTEL_VAULT_CIPHER_KEY` is the vault's 256-bit key, base64 (`openssl rand -base64 32`). It seals every item's value in Postgres. Without it a gateway on Postgres has no vault, the connection approval API (`/v1/connection-approvals`) and the model providers API (`/v1/model-providers`) aren't served, and real models can't run, since their key is kept in the vault.

`KANTEL_VAULT_CIPHER_KEY_FILE` names a file to hold the key instead. The first start writes a random key to it, readable by the gateway's user only, and later starts read it back; `KANTEL_VAULT_CIPHER_KEY`, where set, wins. `compose.yaml` sets it to `/var/lib/harbour/vault-cipher.key` on the gateway's volume, so a fresh install has a vault for the model providers you connect in the console. Back the file up with the database: the vault's values can't be read without it.

:::caution
Keep the cipher key. Values sealed with it can't be read with any other.
:::

## Models

Sessions reach models through Kantel's model gateway, which runs in the gateway's process and calls the deployment's platform connectors. An organisation admin can connect the organisation's own provider in the console (CLI Proxy API, LiteLLM, Cloudflare AI Gateway or OpenRouter; see [Models](/console/models/#connecting-a-provider)), or through the [model providers API](/api/model-providers/). The deployment can also set up platform connectors, two ways: CLIProxyAPI, the default, or a connectors config with any preset. Use one or the other; the gateway refuses to start with both. Without a platform connector or an organisation's provider, sessions use the echo model.

In `compose.yaml` the gateway reaches the machine it runs on as `host.docker.internal`, so a CLIProxyAPI or LiteLLM there is `http://host.docker.internal:<port>/v1`, listening on an address Docker's bridge reaches.

Either way, each connector's key is kept as a platform item in the vault, so a gateway on Postgres needs `KANTEL_VAULT_CIPHER_KEY`. A new key makes a new item. At start the gateway asks each connector's `/v1/models` with its key, checks that it lists every route's model, and logs what to change if not; otherwise a wrong key or model shows only as `no_model` on every session.

`compose.yaml` doesn't pass these variables to the gateway. Add them in an override file (see [Your own settings](#your-own-settings)).

### CLIProxyAPI (the default)

With `KANTEL_CPA_URL` (CLIProxyAPI's API root with its `/v1`, such as `http://127.0.0.1:8317/v1`) and `KANTEL_CPA_API_KEY` (at least 16 characters), the gateway has one connector, `sal-cliproxyapi`. Set both or neither. The `default` route serves `KANTEL_DEFAULT_MODEL` (default `claude-sonnet-5-5`), and every other model CLIProxyAPI lists is offered as `default:<model>`.

### Connectors of any preset

`KANTEL_MODEL_CONNECTORS` holds the platform connectors as JSON. `KANTEL_MODEL_CONNECTORS_FILE` is the alternative: the path of a file holding the same JSON, such as a mounted ConfigMap. Set one of them, not both. The config holds no key: each connector's `apiKeyEnv` names the environment variable that holds its key, so the key can come from a Kubernetes Secret while the rest stays in a ConfigMap or in Helm values.

```json
{
  "connectors": [
    {
      "id": "lleverage-litellm",
      "preset": "litellm",
      "baseUrl": "http://litellm.litellm.svc.cluster.local/v1",
      "apiKeyEnv": "KANTEL_LITELLM_API_KEY"
    }
  ],
  "routes": [
    { "name": "default", "connectorId": "lleverage-litellm", "modelId": "claude-sonnet-5-5" },
    { "name": "fast", "connectorId": "lleverage-litellm", "modelId": "gpt-5-mini" }
  ]
}
```

| Field | What it is |
| --- | --- |
| `connectors[].id` | Lowercase letters, digits and dashes, unique. Usage rows and `model.call` events name it |
| `connectors[].preset` | One of `litellm`, `vercel-ai-gateway`, `openrouter`, `anthropic`, `openai`, `cliproxyapi`, `openai-compatible`, `anthropic-compatible` (see [Models](/console/models/)) |
| `connectors[].baseUrl` | The upstream's API root with its `/v1`. Any http(s) address the gateway can reach, an in-cluster Service included |
| `connectors[].apiKeyEnv` | The variable holding the key: at least 16 characters, no spaces. The gateway refuses to start if it is unset |
| `connectors[].catalogue` | Optional: `include` (the model IDs offered) and `overrides` (per model: `canonical`, `api`, `contextWindow`, `maxTokens`, `rates` and more) |
| `connectors[].compat` | Optional pi-ai compat settings, such as `openRouterRouting` |
| `routes[]` | Optional: `name`, `connectorId`, `modelId` and optionally `thinking`. Must include `default`, which the `assistant` profile uses; `echo` is reserved |

Without `routes`, the `default` route serves `KANTEL_DEFAULT_MODEL` on the first connector. Each route's connector also offers its other models as `<route>:<model>`. The gateway reaches only the connectors' origins, and refuses any other.

To keep CLIProxyAPI beside other connectors, list it in the config as a `cliproxyapi` connector instead of setting `KANTEL_CPA_URL`.

### On Kubernetes

The key goes in a Secret and the rest in a ConfigMap. This runs the gateway on one LiteLLM key for the whole deployment, with each request tagged with its organisation and project (see [Building a host app](/api/host-apps/#models-through-a-litellm-gateway)):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: kantel-models
stringData:
  litellm-api-key: <LiteLLM key>
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: kantel-models
data:
  connectors.json: |
    {
      "connectors": [
        {
          "id": "lleverage-litellm",
          "preset": "litellm",
          "baseUrl": "http://litellm.litellm.svc.cluster.local/v1",
          "apiKeyEnv": "KANTEL_LITELLM_API_KEY"
        }
      ],
      "routes": [{ "name": "default", "connectorId": "lleverage-litellm", "modelId": "claude-sonnet-5-5" }]
    }
```

In the gateway's Deployment:

```yaml
containers:
  - name: gateway
    env:
      - name: KANTEL_MODEL_CONNECTORS_FILE
        value: /etc/kantel/models/connectors.json
      - name: KANTEL_LITELLM_API_KEY
        valueFrom:
          secretKeyRef: { name: kantel-models, key: litellm-api-key }
      - name: KANTEL_VAULT_CIPHER_KEY
        valueFrom:
          secretKeyRef: { name: kantel-vault, key: cipher-key }
    volumeMounts:
      - { name: models, mountPath: /etc/kantel/models, readOnly: true }
volumes:
  - name: models
    configMap: { name: kantel-models }
```

With Helm, the JSON can also go straight into the variable, such as `value: {{ .Values.models | toJson | quote }}` for `name: KANTEL_MODEL_CONNECTORS`. If the gateway's namespace restricts egress, allow it to reach LiteLLM's Service on its port. The ConfigMap is read at start, so restart the gateway after changing it.

## Commands in sessions

Every session has a workspace: one started without a repository, as the console's **New session** starts one, gets its own. A host app's profile that names no skills is the exception, so its host's own file tools aren't shadowed.

A session's `read`, `write`, `edit` and `ls` work on its workspace directly. `bash` leases an isolate, a just-bash shell in the gateway's own process, on its first command. The isolate runs shell commands and `git` reads. `git` writes, `node`, `python3`, the rest of the container commands and any program the isolate doesn't have go to the container tier (tier 2): one container per session from the sandbox image (`images/sandbox`, with git, Node.js, Python, Bun, pnpm and gh), started through the Docker socket. The workspace is committed after every container command, so the file tools and the console's files page see what it wrote. That includes `.git`: a repository a session makes or clones outlives its container, and a later session on the workspace sees it. Only `node_modules` stays in the container.

Each container gets an internal Docker network of its own whose only other member is `vault-proxy`. Its requests go out through the proxy, under the vault's egress policy, with a token that names the session. A direct connection fails. The container's end, when the session closes or its lease lapses after 15 minutes without a command, revokes the token. Every 5 minutes the gateway removes containers and networks it left behind, such as after a restart.

| Variable (gateway) | Default in `compose.yaml` | What it does |
| --- | --- | --- |
| `KANTEL_SANDBOX_CONTAINERS` | `docker` | `off` turns the tier off; container commands are then refused as `unavailable` |
| `KANTEL_SANDBOX_IMAGE` | `harbour-sandbox:dev` | The image, which the `sandbox-image` service builds |
| `KANTEL_SANDBOX_RUNTIME` | `auto` | `auto` is `runsc` (gVisor) when Docker has it registered and `runc` otherwise; or name one, such as `runsc-kvm` |
| `KANTEL_SANDBOX_MEMORY_BYTES`, `KANTEL_SANDBOX_NANO_CPUS` | 2 GiB, 2 CPUs | Each container's limits |
| `KANTEL_SANDBOX_NETWORK` | `harbour-sbx-gw` | The prefix of the per-container networks |
| `KANTEL_VAULT_PROXY_URL`, `KANTEL_VAULT_CONTAINER` | `http://vault-proxy:3128`, `harbour-vault-proxy` | The proxy, and its container, which joins each network. Without a proxy URL, containers have no network at all |
| `KANTEL_DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | The host's Docker socket that Compose mounts into the gateway. The installer sets it in `deploy/compose/.env` for rootless Docker |

If the gateway can't reach Docker when it starts, it starts anyway without the container tier, and container commands are refused as `unavailable` with Docker's error. `/v1/deployment` and the gateway's log say which tier and runtime it has:

```text
[gateway] container tier: in-process isolate (just-bash), leased on first bash; Docker container tier (runsc, auto), one container per lease from harbour-sandbox:dev, egress through the vault proxy (harbour-vault-proxy)
```

To put the containers under gVisor, [install gVisor](https://gvisor.dev/docs/user_guide/install/) and register it with Docker (the commands are under [Browsers](#browsers)), then restart the stack. Because the isolate runs in the gateway's process, gVisor doesn't apply to it. `KANTEL_ISOLATE_RUNTIME` in `compose.yaml` sets the runtime of the prototype's isolate host only.

With rootless Docker, `runsc` needs its own setup, and the installer's detection of the rootless socket hasn't been tested end to end.

A session also has the `subagent` tool, as on Cloudflare: it hands one self-contained task to a child session of the same agent, on the same workspace, and answers with the child's final answer. The gateway offers it unless `KANTEL_SUBAGENTS` is set to anything but `on`, and `compose.yaml` sets it to `on`; start the stack with `KANTEL_SUBAGENTS=off` to take it away. `/v1/deployment` says which, as `bindings.subagents`.

## The default tools

The bootstrap's `echo` and `assistant` profiles have the tools of Cloudflare's default profile. Each of these is on unless its variable is `off`:

| Variable | Tools |
| --- | --- |
| `KANTEL_PRESENT_FILES` | `present_files` and `create_document`: files and documents shown as cards the console opens |
| `KANTEL_CODEMODE` | `codemode`: a script that calls the session's other tools, in a QuickJS VM on a worker thread of the gateway, one per script, with at most 256 MiB of memory |
| `KANTEL_PROGRAMS` | `save_program` and the programs API (`/v1/programs`): saved code mode programs that run with no model, kept in Postgres. Off when `KANTEL_CODEMODE` is |
| `KANTEL_PROGRAM_WAITS` | Programs that pause for a person's input (`waitForInput`) or an agent's answer (`agent`), and the resume route. Off when `KANTEL_PROGRAMS` is |
| `KANTEL_CONNECTIONS` | The connection tools (`connections_list`, `connection_tools`, `connection_call`, `connection_request`), once connections have an origin and a vault |

Connections need an origin for OAuth providers to send people back to. That's `KANTEL_PUBLIC_URL` when it's set; otherwise `KANTEL_CONNECTIONS_ORIGIN`, which `compose.yaml` sets to `http://127.0.0.1:58090` (following `KANTEL_GATEWAY_PORT`). A profile whose image model, picked on the console's Models page, makes images also gets `generate_image`, and one with memory scopes gets `memory_search` and `memory_read`. The bootstrap keeps a profile's prompt layers, skills, memory scopes and image model across restarts and upgrades. `GET /v1/deployment` names what backs `codemode`, `programs`, `presentFiles` and `connections`.

## Browsers

`compose.yaml` runs a browser host (`browser-host`) that starts one Chromium container per browser through the Docker socket, from the image `browser-image` builds, and sets the gateway's `KANTEL_BROWSER_PROVIDER=kantel`, `KANTEL_BROWSER_HOST_URL`, `KANTEL_BROWSER_HOST_TOKEN` and `KANTEL_BROWSER_VIEW_KEY` to match it. So the stack's sessions have a browser with nothing to set. An agent asks before it opens any site, and a person allows or declines it in the console, then watches it live and plays it back from the session. `deploy/compose/browser.yaml`, the overlay that used to add the browser host, is now empty.

The browser keys are development defaults: anywhere else, set `KANTEL_BROWSER_HOST_TOKEN`, `KANTEL_BROWSER_VIEW_KEY` and `KANTEL_BROWSER_SEAL_KEY` to random values of 32 characters or more (`openssl rand -hex 32`), and keep the seal key, which profiles and recordings are sealed with. Set `KANTEL_EMBED_ORIGINS` when another app frames the viewer. `KANTEL_BROWSER_PROVIDER=off` starts the gateway without a browser; a second stack on the same machine also needs its own `KANTEL_BROWSER_NETWORK`.

`KANTEL_BROWSER_RUNTIME` picks the browser containers' runtime: `runc` by default, or `runsc` or `runsc-kvm` to put Chromium under gVisor. Set it for the `browser-host` service. [Install gVisor](https://gvisor.dev/docs/user_guide/install/) and register it with Docker first:

```bash
sudo runsc install
sudo runsc install --runtime runsc-kvm -- --platform=kvm
sudo systemctl reload docker
```

The repository's measurements recommend `runsc-kvm` on bare metal with `/dev/kvm`, and `runsc` inside a VM. The second command is only for bare metal.

To use brwsr.dev instead, set `KANTEL_BROWSER_PROVIDER=brwsr` and `KANTEL_BRWSR_API_KEY`. A gateway run outside this stack with no `KANTEL_BROWSER_PROVIDER` uses a browser host when `KANTEL_BROWSER_HOST_URL` is set, else brwsr when its key is, else no browser.

## Kubernetes

To configure the gateway's model connectors on Kubernetes, see [Models on Kubernetes](#on-kubernetes).

`deploy/kubernetes/browser-host` runs the browser host on Kubernetes, with a Pod per browser and no Docker socket (`KANTEL_BROWSER_DRIVER=kubernetes`). `KANTEL_BROWSER_RUNTIME_CLASS` sets a RuntimeClass, such as gVisor's. Its manifests build with `kubectl kustomize` but haven't run on a cluster yet. Point the gateway at it with `KANTEL_BROWSER_HOST_URL=http://kantel-browser-host.kantel-browsers.svc:8790` and the same host token and view key.

There are no Kubernetes manifests for the gateway and its stores.

## Usage

The gateway writes one row per model call to `usage_calls` in its schema. `KANTEL_USAGE=off` turns it off. With `deploy/compose/analytics.yaml` on top, it also ships the rows to ClickHouse (`KANTEL_CLICKHOUSE_URL`) every 15 seconds.

## Your own settings

`compose.yaml` reads `KANTEL_ADMIN_EMAIL`, `KANTEL_SMTP_URL`, `KANTEL_MAIL_FROM`, `KANTEL_PROJECTS` and `KANTEL_SUBAGENTS` from your environment. Everything else goes in an override file of your own, for example `kantel.yaml`:

```yaml
services:
  gateway:
    environment:
      KANTEL_ADMIN_EMAIL: you@example.com
      KANTEL_SMTP_URL: smtps://user:password@smtp.example.com
      KANTEL_MAIL_FROM: Kantel <kantel@example.com>
      KANTEL_PUBLIC_URL: https://kantel.example.com
      KANTEL_VAULT_CIPHER_KEY: <output of openssl rand -base64 32>
      KANTEL_CPA_URL: http://cliproxyapi.example.internal:8317/v1
      KANTEL_CPA_API_KEY: <CLIProxyAPI client key>
```

For another connector, replace the two CLIProxyAPI lines with `KANTEL_MODEL_CONNECTORS` and the key variable it names (see [Connectors of any preset](#connectors-of-any-preset)).

```bash
docker compose -f deploy/compose/compose.yaml -f kantel.yaml up -d --build --wait
```

Pass the same `-f` files to every later `docker compose` command, or compose recreates services with their defaults.

## Check it

`/healthz` needs no credentials. `/v1/deployment` lists what backs each part (Postgres, S3, the vault, the model gateway, the sandboxes), whether subagents are on, and where mail goes, never the credentials. Its `bindings.sandboxes` names the isolate and the container tier, with the container runtime, the image and the vault proxy. With `KANTEL_SANDBOX_CONTAINERS=off` it ends `no container tier`, and when Docker didn't answer at the start, `container tier unavailable:` and the reason. It is self-hosted only and not in the OpenAPI document (see [Unlisted routes](/api/reference/unlisted/)):

```bash
curl -s "$KANTEL_URL/healthz"
curl -s "$KANTEL_URL/v1/deployment" -H "authorization: Bearer $KANTEL_API_KEY"
```

`KANTEL_URL` is `http://127.0.0.1:58090` for the compose stack. `/v1/deployment` isn't in the SDK; for a call that is:

```ts
import { createKantelClient } from "@kantel/api/sdk";

const client = createKantelClient({
  baseUrl: `${process.env.KANTEL_URL}/v1`,
  token: process.env.KANTEL_API_KEY,
});

const page = await client.listSessions();
console.log(page.items.length);
```

<!-- Sources (8584d5b): deploy/compose/README.md:1-160, deploy/compose/README.md:213-265, deploy/compose/README.md:266-302, deploy/compose/README.md:315-389, deploy/compose/compose.yaml:1-322, deploy/compose/browser.yaml:1-81, deploy/compose/egress-vault.yaml:1-74, deploy/compose/next-to-sal.yaml:1-66, deploy/compose/analytics.yaml:1-46, apps/selfhosted/Dockerfile:1-22, apps/selfhosted/package.json:1-12, apps/selfhosted/src/gateway/main.ts:1-263, apps/selfhosted/src/gateway/gateway.ts:1-120, apps/selfhosted/src/gateway/mail.ts:1-50, apps/selfhosted/src/gateway/models.ts:1-60, apps/selfhosted/src/gateway/models.ts:157-220, apps/selfhosted/src/gateway/durable.ts:1-40, apps/selfhosted/src/gateway/durable.ts:224-272, apps/selfhosted/src/gateway/components.ts:471-560, apps/selfhosted/src/gateway/sandboxes.ts:1-27, apps/selfhosted/src/gateway/browser.ts:1-15, apps/selfhosted/src/gateway/usage.ts:1-30, apps/selfhosted/src/browser/host.ts:1-25, apps/selfhosted/src/browser/docker.ts:1-12, deploy/kubernetes/browser-host/README.md:1-68, targets/selfhosted/sandbox/README.md:1-20, packages/api/generated/sdk.ts:1966-1980, packages/api/generated/sdk.ts:2516-2520 -->
