# Harbour self-hosted on one machine (M0-SH1)

One command starts the whole self-hosted target:

```bash
docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

Then, from the repo root (needs Bun 1.3):

```bash
bun spike/conformance/run.ts --target=selfhosted          # spike suite + Pi storage + lease tests
bun spike/scenario/run.ts                                  # the scripted research task
bun spike/scenario/run.ts --crash \
  --kill-cmd "docker compose -f deploy/compose/compose.yaml kill host-a" \
  --fallback http://127.0.0.1:58082                        # kill the owner mid tool call
deploy/compose/scripts/check-canary.sh                     # canary in no log, row or object
docker compose -f deploy/compose/compose.yaml down -v      # stop and delete all state
```

`apps/selfhosted/test` needs `bun install` in `apps/selfhosted` first.

## What runs

| Service | What it is | Host port |
|---|---|---|
| `host-a`, `host-b` | Session hosts (Bun). Pi Durable 1.4.0 on Postgres, one Harness per session, Postgres session leases. Each also serves the spike API and forwards requests for sessions it does not own. | 58081, 58082 |
| `isolate-host` | workerd from npm with a `workerLoader` binding: one Dynamic Worker per session running just-bash over the lazy MinIO workspace. Its `globalOutbound` is the vault. | 58080 |
| `vault-proxy` | Stub vault: default-deny forward proxy, injects one header for one route (`vault-policy.json`), audits every decision. | none |
| `postgres` | Session directory, leases, workspace heads and history, audit, and one schema per session for Pi Durable. | 55432 |
| `minio` | Content-addressed workspace blobs and manifests. | 59000 |
| `research-site` | The page the scripted task fetches. Answers only with the injected credential. | none |
| `sandbox-image` | Builds `harbour-sandbox:dev`, the container tier's warm image, and exits. | none |

Networks: `control` (everything but sandboxes and the fixture), `upstream`
(vault and fixture: the outside world), and `harbour-sandbox`, which is
`internal: true` and has only the vault on it. A sandbox container has no
other route out; `curl --noproxy '*'` to a public IP fails.

Ports are bound to 127.0.0.1 and can be moved with `HARBOUR_PG_PORT`,
`HARBOUR_S3_PORT`, `HARBOUR_ISOLATE_PORT`, `HARBOUR_HOST_A_PORT` and
`HARBOUR_HOST_B_PORT`.

## For M0-BE2 (seeding measurements)

The stack gives you Postgres (`postgres://harbour:harbour@127.0.0.1:55432/harbour`),
MinIO (`http://127.0.0.1:59000`, user `harbour`, password `harbour-dev-secret`,
bucket `harbour`), the warm sandbox image `harbour-sandbox:dev` and the
`harbour-sandbox` network. To time a container seed the way the container
tier starts one, run on that network with `--runtime "${HARBOUR_SANDBOX_RUNTIME:-runc}"`
and the vault as `HTTP(S)_PROXY`; the vault refuses everything not in
`vault-policy.json`, so add a route (for example `github.com`, `tunnel: true`)
for git over HTTPS.

## Runtimes: runc today, gVisor when the host has it

`HARBOUR_ISOLATE_RUNTIME` (the workerd container) and `HARBOUR_SANDBOX_RUNTIME`
(sandbox containers) both default to `runc`. workerd is not a hardened
sandbox, so production must run it under gVisor or in a microVM. The spike
host has no `runsc`, and installing it is a host change this spike was not
allowed to make. To switch, on the host:

```bash
# 1. Install gVisor (https://gvisor.dev/docs/user_guide/install/), then register it:
sudo runsc install            # adds "runsc" to /etc/docker/daemon.json
sudo systemctl restart docker
# 2. Start the stack on it:
HARBOUR_ISOLATE_RUNTIME=runsc HARBOUR_SANDBOX_RUNTIME=runsc \
  docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

Nothing else changes: the session host passes the runtime name to the Docker
API for every sandbox container. The cold-start numbers in
`docs/measurements/m0-sh1-selfhosted/` are on runc and need re-running on runsc.

## Spike shortcuts (not the production shape)

- The session hosts mount the Docker socket to start sandboxes. Anything with
  that socket is root on the machine. M1 should put container starts behind a
  small runner with a narrow API (or use Kubernetes with a RuntimeClass).
- Secrets are fixed development values in `compose.yaml`; the canary is
  overridable with `HARBOUR_CANARY_SECRET` and is random per run in CI.
- The vault cannot inject into HTTPS from a container (CONNECT is a tunnel);
  it refuses CONNECT unless a route sets `tunnel: true`. The isolate's HTTPS
  requests reach the vault in proxy form (the full `https://` URL), so the
  vault makes the TLS connection and can inject there; the M0 fixture is plain
  HTTP, so only refusal of HTTPS is tested.
- Your umask must let Docker read the build context (`077` breaks the image
  builds with EACCES; `chmod -R go+rX` the checkout).
