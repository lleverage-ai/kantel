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
`deploy/compose` is the repository's development and test stack. Its Postgres and MinIO passwords are fixed development values in `compose.yaml`, and it also starts services from an earlier prototype (`host-a`, `host-b`, `isolate-host`, `vault-proxy`, `research-site`) that the gateway doesn't use. Two of them, and the browser host, mount the Docker socket, which is root on the machine. There is no production compose file yet.
:::

The gateway itself depends only on `postgres`, `minio` and `mailpit`.

## First start

On its first start the gateway creates an organisation, a project and an operator API key (`hbr_…`) on that project. It writes their IDs and the key to `/var/lib/harbour/bootstrap.json` (mode 0600) in its volume. On later starts it reads the file back and keeps the same deployment while the key still works.

```bash
docker compose -f deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json
```

It also creates two agent profiles: `echo`, which always answers with the echo model, and `assistant`, on the `default` model route, when real models are set up. Both start with no prompt layers. Kantel adds no system prompt of its own: the prompt is what the profile's prompt layers and the prompt rules give it, plus recall and the skills listing.

`KANTEL_PROJECTS` takes more project names, comma-separated. Each is made once and put on the operator key. Naming a new one later issues a new key over them all and revokes the old one.

## Sign-in and API keys

People sign in with a one-time code sent by email. Kantel is invite-only: the gateway invites `KANTEL_ADMIN_EMAIL` (default `admin@harbour.localhost`) as an organisation admin at start, and nobody else can sign in until invited.

Codes go out through `KANTEL_SMTP_URL` from `KANTEL_MAIL_FROM`:

| `KANTEL_SMTP_URL` | Transport |
| --- | --- |
| `smtps://user:password@host:port` | TLS from the start |
| `smtp://user:password@host:port` | STARTTLS required |
| `smtp://host:port?starttls=off` | In the clear, for a relay on a private network |

Compose sends codes to Mailpit by default. Without `KANTEL_SMTP_URL` the sign-in routes answer 503, and a malformed value stops the gateway at start. Codes last 10 minutes and a signed-in session (`hbs_…`) lasts 12 hours. The gateway allows 30 sign-in requests per client address per 15 minutes. Behind a reverse proxy every client shares one address, so limit there instead.

Set `KANTEL_PUBLIC_URL` (an origin, such as `https://kantel.example.com`) when people reach the console through a TLS proxy. Passkeys are made for that origin, and without it the gateway uses the request's own origin, which is `http:` behind a proxy.

Host apps use the bootstrap's operator key, or keys made on the console's `/keys` page. See [Authentication](/api/authentication/). Host tool callbacks must be `https:` unless `KANTEL_CALLBACK_ORIGINS` allows others, such as `http://127.0.0.1:*`.

## Postgres and storage

`KANTEL_DATABASE_URL` points the gateway at Postgres. Every table goes in one schema, `KANTEL_GATEWAY_SCHEMA` (default `harbour_m1`), and the vault in `<schema>_vault`. Without a database URL the gateway keeps everything in memory.

With a database URL the gateway also needs `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` (`S3_REGION` is optional). Workspace files go under `KANTEL_GATEWAY_S3_PREFIX` (default `m1/workspaces/`) and skill files under `KANTEL_SKILLS_S3_PREFIX` (default `m1/skills/`).

Sessions left mid-run resume when the gateway starts again.

## The vault

`KANTEL_VAULT_CIPHER_KEY` is the vault's 256-bit key, base64 (`openssl rand -base64 32`). It seals every item's value in Postgres. Without it a gateway on Postgres has no vault, the connection approval API (`/v1/connection-approvals`) isn't served, and real models can't run, since their key is kept in the vault. `compose.yaml` doesn't set one.

:::caution
Keep the cipher key. Values sealed with it can't be read with any other.
:::

## Models

Sessions reach models through Kantel's model gateway, which runs in the gateway's process and calls the deployment's platform connectors. There are two ways to set them up: CLIProxyAPI, the default, or a connectors config with any preset. Use one or the other; the gateway refuses to start with both. Without either, sessions use the echo model.

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

The key goes in a Secret and the rest in a ConfigMap. This runs the gateway on one LiteLLM key for the whole deployment, as Lleverage does (see [How Lleverage uses Kantel](/api/lleverage/)):

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

A session's `read`, `write`, `edit` and `ls` work on its workspace directly. `bash` leases an isolate, a just-bash shell in the gateway's own process, on its first command. There is no container tier yet, so commands that need one (`git`, `node`, `python` and the like) are refused as `unavailable`.

Because the isolate runs in the gateway's process, gVisor doesn't apply to it. `KANTEL_ISOLATE_RUNTIME` and `KANTEL_SANDBOX_RUNTIME` in `compose.yaml` set the runtime of the prototype's services only.

## Browsers

`deploy/compose/browser.yaml` adds a browser host that runs one Chromium container per browser through the Docker socket:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/browser.yaml up -d --build --wait
```

The gateway then uses `KANTEL_BROWSER_PROVIDER=harbour`. An agent asks before it opens any site, and a person allows or declines it in the console. The overlay's keys are development defaults: anywhere else, set `KANTEL_BROWSER_HOST_TOKEN`, `KANTEL_BROWSER_VIEW_KEY` and `KANTEL_BROWSER_SEAL_KEY` to random values of 32 characters or more (`openssl rand -hex 32`). Set `KANTEL_EMBED_ORIGINS` when another app frames the viewer.

`KANTEL_BROWSER_RUNTIME` picks the browser containers' runtime: `runc` by default, or `runsc` or `runsc-kvm` to put Chromium under gVisor. Set it for the `browser-host` service. [Install gVisor](https://gvisor.dev/docs/user_guide/install/) and register it with Docker first:

```bash
sudo runsc install
sudo runsc install --runtime runsc-kvm -- --platform=kvm
sudo systemctl reload docker
```

The repository's measurements recommend `runsc-kvm` on bare metal with `/dev/kvm`, and `runsc` inside a VM. The second command is only for bare metal.

To use brwsr.dev instead, set `KANTEL_BRWSR_API_KEY` on the gateway. Without a browser host or a brwsr key, sessions have no browser.

## Kubernetes

To configure the gateway's model connectors on Kubernetes, see [Models on Kubernetes](#on-kubernetes).

`deploy/kubernetes/browser-host` runs the browser host on Kubernetes, with a Pod per browser and no Docker socket (`KANTEL_BROWSER_DRIVER=kubernetes`). `KANTEL_BROWSER_RUNTIME_CLASS` sets a RuntimeClass, such as gVisor's. Its manifests build with `kubectl kustomize` but haven't run on a cluster yet. Point the gateway at it with `KANTEL_BROWSER_HOST_URL=http://harbour-browser-host.harbour-browsers.svc:8790` and the same host token and view key.

:::note[Not yet merged]
Kubernetes manifests for the gateway and its stores are in a draft pull request (#174) and aren't in main.
:::

## Usage

The gateway writes one row per model call to `usage_calls` in its schema. `KANTEL_USAGE=off` turns it off. With `deploy/compose/analytics.yaml` on top, it also ships the rows to ClickHouse (`KANTEL_CLICKHOUSE_URL`) every 15 seconds.

## Your own settings

`compose.yaml` reads `KANTEL_ADMIN_EMAIL`, `KANTEL_SMTP_URL`, `KANTEL_MAIL_FROM` and `KANTEL_PROJECTS` from your environment. Everything else goes in an override file of your own, for example `kantel.yaml`:

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

`/healthz` needs no credentials. `/v1/deployment` lists what backs each part (Postgres, S3, the vault, the model gateway, the sandboxes) and where mail goes, never the credentials. It is self-hosted only and not in the OpenAPI document (see [Unlisted routes](/api/reference/unlisted/)):

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

<!-- Sources (8584d5b): deploy/compose/README.md:1-160, deploy/compose/README.md:213-265, deploy/compose/README.md:266-302, deploy/compose/README.md:315-389, deploy/compose/compose.yaml:1-322, deploy/compose/browser.yaml:1-81, deploy/compose/egress-vault.yaml:1-74, deploy/compose/next-to-sal.yaml:1-66, deploy/compose/analytics.yaml:1-46, apps/selfhosted/Dockerfile:1-22, apps/selfhosted/package.json:1-12, apps/selfhosted/src/gateway/main.ts:1-263, apps/selfhosted/src/gateway/gateway.ts:1-120, apps/selfhosted/src/gateway/mail.ts:1-50, apps/selfhosted/src/gateway/models.ts:1-60, apps/selfhosted/src/gateway/models.ts:157-220, apps/selfhosted/src/gateway/durable.ts:1-40, apps/selfhosted/src/gateway/durable.ts:224-272, apps/selfhosted/src/gateway/components.ts:471-560, apps/selfhosted/src/gateway/sandboxes.ts:1-27, apps/selfhosted/src/gateway/browser.ts:1-15, apps/selfhosted/src/gateway/usage.ts:1-30, apps/selfhosted/src/browser/host.ts:1-25, apps/selfhosted/src/browser/docker.ts:1-12, deploy/kubernetes/browser-host/README.md:1-68, targets/selfhosted/sandbox/README.md:1-20, docs/measurements/m0-sh1-selfhosted/README.md:1-20, packages/api/generated/sdk.ts:1966-1980, packages/api/generated/sdk.ts:2516-2520 -->
