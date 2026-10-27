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
# The scenario shared with Cloudflare (M0-CF1's spikes/scenario), needs internet:
HARBOUR_SPIKE_TOKEN=unused HARBOUR_CANARY=harbour-canary-0000 \
  bun spikes/scenario/run.ts --base-url http://127.0.0.1:58081 --kill-after-exec 2
docker compose -f deploy/compose/compose.yaml down -v      # stop and delete all state
```

`apps/selfhosted/test` needs `bun install` in `apps/selfhosted` first.

## What runs

| Service | What it is | Host port |
|---|---|---|
| `host-a`, `host-b` | Session hosts (Bun). Pi Durable 1.4.0 on Postgres, one Harness per session, Postgres session leases. Each also serves the spike API and forwards requests for sessions it does not own. | 58081, 58082 |
| `isolate-host` | workerd from npm with a `workerLoader` binding: one Dynamic Worker per session running just-bash over the lazy MinIO workspace. Its `globalOutbound` is the vault. | 58080 |
| `vault-proxy` | Stub vault: default-deny forward proxy. Injects a header per route (`vault-policy.json`), redacts the secret from responses, audits every decision. Intercepts container HTTPS with its own CA. | none |
| `postgres` | Session directory, leases, workspace heads and history, audit, and one schema per session for Pi Durable. | 55432 |
| `minio` | Content-addressed workspace blobs and manifests. | 59000 |
| `research-site` | The page the scripted task fetches. Answers only with the injected credential. | none |
| `sandbox-image` | Builds `harbour-sandbox:dev`, the container tier's warm image, and exits. | none |

Networks: `control` (everything but sandboxes and the fixture) and `upstream`
(vault and fixture: the outside world). Each sandbox container gets its own
`internal` network for the length of its command (`harbour-sbx-<token>`), and
the session host connects the vault (container `harbour-vault-proxy`) to it as
`vault-proxy`. A sandbox has no other route out (`curl --noproxy '*'` to a
public IP fails) and cannot reach another sandbox (the conformance suite
probes for peers). Docker's default address pools allow about 30 such
networks at once, which caps concurrent container commands on one daemon;
widen `default-address-pools` in the daemon config to raise it.

Ports are bound to 127.0.0.1 and can be moved with `HARBOUR_PG_PORT`,
`HARBOUR_S3_PORT`, `HARBOUR_ISOLATE_PORT`, `HARBOUR_HOST_A_PORT` and
`HARBOUR_HOST_B_PORT`.

## For M0-BE2 (seeding measurements)

The stack gives you Postgres (`postgres://harbour:harbour@127.0.0.1:55432/harbour`),
MinIO (`http://127.0.0.1:59000`, user `harbour`, password `harbour-dev-secret`,
bucket `harbour`) and the warm sandbox image `harbour-sandbox:dev`. To time a
container seed the way the container tier starts one, create an internal
network, connect `harbour-vault-proxy` to it with the alias `vault-proxy`, run
on it with `--runtime "${HARBOUR_SANDBOX_RUNTIME:-runc}"` and the vault as
`HTTP(S)_PROXY`; the vault refuses everything not in
`vault-policy.json`, so add a route (for example `github.com`, `tunnel: true`)
for git over HTTPS.

## Runtimes: runc or gVisor

`HARBOUR_ISOLATE_RUNTIME` (the workerd container) and `HARBOUR_SANDBOX_RUNTIME`
(sandbox containers) both default to `runc`. workerd is not a hardened
sandbox, so production must run it under gVisor or in a microVM. To switch,
on the host:

```bash
# 1. Install gVisor (https://gvisor.dev/docs/user_guide/install/). Since release
#    20260831.0 it ships as one gvisor.tar.zstd: runsc and
#    containerd-shim-runsc-v1, plus the sentry in a gvisor-bin/ directory
#    beside them. Then register it:
sudo runsc install            # adds "runsc" to /etc/docker/daemon.json
# On bare metal with /dev/kvm, also register the KVM platform:
sudo runsc install --runtime runsc-kvm -- --platform=kvm
sudo systemctl reload docker  # or restart
# 2. Start the stack on it (runsc-kvm on bare metal, runsc in a VM):
HARBOUR_ISOLATE_RUNTIME=runsc-kvm HARBOUR_SANDBOX_RUNTIME=runsc-kvm \
  docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

`runsc` uses gVisor's default platform, systrap. `runsc-kvm` is the same
binary with `--platform=kvm`: on bare metal it is the fastest gVisor config
for both tiers (a new isolate about 170 ms p50 against 220 ms on systrap and
140 ms on runc, and real container work about 30% faster than systrap), so it
is the recommended self-hosted default where the host has `/dev/kvm`. Inside a
VM, gVisor recommends systrap.

The session host passes the runtime name to the Docker API for every sandbox
container. Keep both variables exported for every later `docker compose`
command (including `up host-a` after a kill): compose recreates a service whose
runtime differs, so a bare `up` quietly puts it back on runc. The cold-start
numbers for runc, runsc and runsc-kvm are in `docs/measurements/m0-sh1-selfhosted/`.

Two things work differently under gVisor, and the stack allows for both:

- **No Docker DNS.** runsc's network stack cannot reach Docker's embedded DNS
  (127.0.0.11) on a user-defined network
  (https://gvisor.dev/docs/user_guide/faq/). So `minio` and `vault-proxy` have
  fixed addresses on `control` (`HARBOUR_CONTROL_PREFIX`, default
  `10.250.89`, giving `10.250.89.0/24`; change it if that clashes with a
  network you have), the isolate host gets them through `extra_hosts`, and
  each sandbox gets the vault's address as an `/etc/hosts` entry. Anything new
  that runs under runsc must find its peers the same way.
- **Root filesystem writes stay in the sandbox** (`overlay2=root:self`), out
  of reach of Docker's archive API. `/workspace` is an anonymous volume per
  container, so the session host can read the command's changes back.

The isolate host has a fixed address as well (`.12`), on any runtime. The
session hosts run on Bun, which caches DNS answers for 30 s, so when the
isolate host was recreated on a new address, a session host that wasn't
recreated with it kept calling the old one, and its isolate commands failed
with "Unable to connect" until the cache expired. Docker allocates every other
address on `control` from `.128` up, so nothing else can take a fixed one.

## Spike shortcuts (not the production shape)

- The session hosts mount the Docker socket to start sandboxes. Anything with
  that socket is root on the machine. M1 should put container starts behind a
  small runner with a narrow API (or use Kubernetes with a RuntimeClass).
- Secrets are fixed development values in `compose.yaml`; the canary is
  overridable with `HARBOUR_CANARY_SECRET` and is random per run in CI.
- HTTPS: the isolate's requests reach the vault in proxy form (the full
  `https://` URL), so the vault makes the TLS connection itself. A
  container's HTTPS arrives as CONNECT; the vault answers it, terminates TLS
  with a certificate from its own CA (made on first start, kept in the
  `vaultca` volume, served at `http://vault-proxy:3128/ca.crt`), and applies
  the same per-request policy inside. The session host copies that CA into
  each container and points `SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
  `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE` at it. A
  client that pins certificates needs a `tunnel: true` route (raw TLS, no
  injection). The CA key never leaves the vault container; production wants
  it in a KMS or HSM and short-lived.
- Your umask must let Docker read the build context (`077` breaks the image
  builds with EACCES; `chmod -R go+rX` the checkout).
