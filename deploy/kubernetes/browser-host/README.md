# Harbour's browsers on Kubernetes

The self-hosted browser host (`apps/selfhosted/src/browser/host.ts`) with `HARBOUR_BROWSER_DRIVER=kubernetes`: one
Pod of `images/browser` per browser, in the host's own namespace, instead of one Docker container per browser
(`deploy/compose/browser.yaml`). The gateway and the browser host speak the same API either way
(`docs/design/browser-runtime.md`), so only the host changes.

| File | What it is |
| --- | --- |
| `rbac.yaml` | The host's service account: Pods get, list, create and delete; Secrets create and delete, never read |
| `host.yaml` | The host's Deployment (one replica), its volume for sealed profiles and recordings, and its Service |
| `network-policy.yaml` | Browsers take traffic from the host only, and reach DNS and the public internet only; the host takes its API |

## How a browser runs

1. The gateway asks the host for a browser (`POST /browsers/<id>/start`, with the host's token).
2. The host makes a Secret `harbour-browser-<id>` holding that start's agent token, then a Pod of the same name that
   reads it as its environment (`AGENT_TOKEN`). The token is never in the Pod's spec, and the host can't read Secrets back.
3. It waits for the Pod to run, then talks to its agent at the Pod's IP, port 8080, as it would a container.
4. On release, timeout or teardown it deletes the Pod and the Secret. When the host starts, its janitor deletes every
   Pod (and its Secret) labelled `harbour.dev/browser-host=<HARBOUR_BROWSER_STACK>`: an earlier run's leftovers.

Profiles and recordings stay on the host's volume, sealed with `HARBOUR_BROWSER_SEAL_KEY`, as with Docker. A browser's
Pod keeps nothing.

## Install

```bash
kubectl create namespace harbour-browsers
kubectl -n harbour-browsers create secret generic harbour-browser-host \
  --from-literal=HARBOUR_BROWSER_HOST_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=HARBOUR_BROWSER_VIEW_KEY="$(openssl rand -hex 32)" \
  --from-literal=HARBOUR_BROWSER_SEAL_KEY="$(openssl rand -hex 32)"
kubectl apply -k deploy/kubernetes/browser-host
```

Before applying, push both images where the cluster pulls from, and set them:

- the host: `images:` in `kustomization.yaml` (built from `apps/selfhosted/Dockerfile`);
- the browsers: `HARBOUR_BROWSER_IMAGE` in `host.yaml` (built from `images/browser`).

Then point the gateway at it, with the same host token and view key:

```
HARBOUR_BROWSER_PROVIDER=harbour
HARBOUR_BROWSER_HOST_URL=http://harbour-browser-host.harbour-browsers.svc:8790
HARBOUR_BROWSER_HOST_TOKEN=<the secret's HARBOUR_BROWSER_HOST_TOKEN>
HARBOUR_BROWSER_VIEW_KEY=<the secret's HARBOUR_BROWSER_VIEW_KEY>
```

## Settings

| Variable (`host.yaml`) | Default | What it does |
| --- | --- | --- |
| `HARBOUR_BROWSER_IMAGE` | `harbour-browser:dev` | The browser image, as the cluster pulls it |
| `HARBOUR_BROWSER_NAMESPACE` | the host's own | Where browser Pods go (the Role must be there too) |
| `HARBOUR_BROWSER_RUNTIME_CLASS` | none | A RuntimeClass for browser Pods, such as gVisor's `gvisor` |
| `HARBOUR_BROWSER_MEMORY_MB`, `HARBOUR_BROWSER_CPUS` | `2048`, `1` | Each browser Pod's requests and limits |
| `HARBOUR_BROWSER_STACK` | `harbour` | Labels this host's Pods, so its janitor removes only its own |

## Limits

- One host replica: it keeps its browsers' state in memory. A restart forgets them and its janitor removes their Pods;
  the gateway's leases end with its sessions anyway.
- `network-policy.yaml` needs a CNI that enforces NetworkPolicy (Calico, Cilium and the like). Without one, a browser
  can reach the cluster's private addresses. Its agent's domain guard still holds it to the sites a person allowed.
- Checked offline only: `kubectl kustomize` builds it, and `apps/selfhosted/test/browser/kubernetes.test.ts` drives
  the driver against a fake API server. It hasn't run on a cluster yet.
