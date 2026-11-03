# @kantel/compute

The compute plane's control-plane API: every route in `@kantel/api`'s `computeRoutes` (accounts and organisations,
sandboxes and their commands, files, ports, SSH, desktop and browser, snapshots, scoped API keys, the proxy's settings,
events, webhooks, OpenTelemetry export and the super-admin's hosts), served over a `SandboxBackend`. The self-hosted
gateway always serves it, and its console runs on it.

- `createComputeApi({ backend, store?, authenticatePerson?, fetch?, now?, basePath?, publicUrl? })` (`.`): answers a
  compute route, or resolves `undefined` for any other path so a gateway can chain it. It holds the webhook dispatcher
  and the telemetry exporter; start their timers, or call `drain()` and `flush()` yourself.
- `SandboxBackend` (`src/backend.ts`): what the API asks of the machines. The control plane keeps every record; the
  backend keeps machines and the bytes of their disks, and names a snapshot by an opaque `ref`. **Lane 2's host
  scheduler implements this**, placing sandboxes on the hosts that dialled in and relaying each call to the host agent.
- `createStubBackend()` (`./stub`): the backend until then, in memory. Each sandbox is a just-bash shell over an
  in-memory file tree, so commands and files really work; snapshots copy the tree. microVM-only features (SSH,
  desktop, browser, pause) answer `https://stub.kantel.invalid/…` URLs that go nowhere, and `not_supported` on an
  isolate, as the real ones will. Nothing is isolated or persisted: it's for tests and local runs.
- `createMemoryStore()` (`src/store.ts`): the records, in memory, behind `ComputeStore`; a SQL store (over
  `@kantel/sql`, as `@kantel/environments` does) replaces it for a durable gateway.
- Keys: `ksk_…`; only the SHA-256 of the secret is stored. A person's bearer goes to `authenticatePerson` (the
  gateway's sign-in); a person acts in their personal account unless `account` names an organisation they're in.
- Webhooks (`src/webhooks.ts`) are signed as [Standard Webhooks](https://www.standardwebhooks.com/)
  (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,…`); `verifyWebhook` checks one. A failed delivery is
  retried after 5 s, 30 s, 2 min, 10 min, 1 h, 6 h and 12 h, and a webhook that keeps failing is disabled.
- OpenTelemetry (`src/telemetry.ts`): lifecycle events as OTLP logs and usage as OTLP metrics, over OTLP/HTTP JSON
  to the account's endpoint.
- Costs come from `PLACEHOLDER_RATES` until a deployment sets its own prices.

## A local server

```sh
node packages/compute/src/serve.ts --port 58190
```

It serves the API over the stub backend, makes a super-admin (`admin@localhost`) with an API key holding every scope,
and prints `KANTEL_URL=…` and `KANTEL_API_KEY=ksk_…` (`KANTEL_COMPUTE_BOOTSTRAP_KEY` fixes the secret). The CLI
(`packages/cli`) and its MCP server work against it:

```sh
npx kantel login --url http://127.0.0.1:58190 --key ksk_…
npx kantel sandbox create
```
