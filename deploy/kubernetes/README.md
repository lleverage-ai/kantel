# Harbour self-hosted on Kubernetes (M1-SH1)

Manifests for the M1 gateway and what it runs on, beside [the compose file](../compose/compose.yaml), with the same
images and settings:

| Workload | Kind | What it is |
| --- | --- | --- |
| `gateway` | Deployment, 1 replica, `Recreate` | Sessions, workspace reads, audit queries, sign-in and the console, on port 8080. Its bootstrap (organisation, project, workspace, API key) is on the `gateway-state` volume. |
| `postgres` | StatefulSet | Runtime, audit, identity and workspace tables, in schema `harbour_m1`. |
| `minio` | StatefulSet | Workspace trees, under `m1/workspaces/` in bucket `harbour` (the gateway creates the bucket). |
| `mailpit` | Deployment | The SMTP server sign-in codes go to in development and CI. Never relays. |

`base/` is the deployment; `overlays/kind/` runs it on a local kind cluster.

## On kind

```sh
kind create cluster --config deploy/kubernetes/overlays/kind/kind.yaml
docker build -f apps/selfhosted/Dockerfile -t harbour-selfhosted:dev .
kind load docker-image --name harbour harbour-selfhosted:dev
kubectl apply -k deploy/kubernetes/overlays/kind
kubectl -n harbour rollout status deployment/gateway
```

The console is then at <http://127.0.0.1:58390/> and Mailpit at <http://127.0.0.1:58325/>. Those ports differ from
compose's and from the second stack's in its README, so the cluster runs beside both. The API key:

```sh
kubectl -n harbour exec deploy/gateway -- cat /var/lib/harbour/bootstrap.json
```

The gateway's end-to-end test, the one CI runs against the compose stack, runs against the cluster too:

```sh
bun apps/selfhosted/test/gateway/stack.ts --base-url http://127.0.0.1:58390 --mailpit-url http://127.0.0.1:58325 \
  --exec "kubectl --namespace harbour exec deploy/gateway --"
```

CI does the same in [selfhosted-kind.yml](../../.github/workflows/selfhosted-kind.yml), in a Docker daemon of its
own, then replaces the gateway's pod and checks that the bootstrap and the test both survive.

kube-proxy needs the kernel's REJECT support (`xt_REJECT`, or `nft_reject_inet` in nftables mode). On a host that
can't load it (for example one running a kernel whose modules were upgraded away without a reboot), kube-proxy logs
`Extension REJECT revision 0 not supported` and programs no Service at all: CoreDNS and the local-path provisioner
never reach the API server, and every pod with a volume stays `Pending`.

## Before anything but a throwaway cluster

- Replace the development credentials in `base/kustomization.yaml`'s `secretGenerator` (an overlay's generator with
  `behavior: replace`, or Secrets from your own store).
- Point `HARBOUR_SMTP_URL` and `HARBOUR_MAIL_FROM` in `base/gateway.yaml` at a real relay, and leave out
  `mailpit.yaml`.
- Use managed Postgres and S3 if you have them: set `HARBOUR_DATABASE_URL` and the `S3_*` variables and leave out
  `postgres.yaml` and `minio.yaml`.
- Put an ingress with TLS in front of the `gateway` Service.

## Not here yet

The M0 session hosts, the workerd isolate host and the vault forward proxy are still compose-only. The session hosts
start sandboxes through the Docker socket and connect the vault proxy to each sandbox's network by container name;
on Kubernetes the sandbox tier wants pods under a gVisor `RuntimeClass` with a NetworkPolicy that only reaches the
vault proxy, which is a different sandbox backend from `targets/selfhosted/sandbox`. Until then, sessions on this
deployment run on the gateway's own runtime, as they do in compose.
