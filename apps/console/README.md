# @kantel/console

Kantel's console: the compute console on the gateway's compute API, behind Kantel's sign-in. Sandboxes, snapshots,
API keys, the egress proxy, webhooks, OpenTelemetry, the organisation, billing and, for a super-admin, hosts. Built from
`@kantel/ui` (`src/compute/`); this app signs in, picks the source and decides where the pages go.

```sh
pnpm --filter @kantel/cloudflare dev           # a local gateway on http://127.0.0.1:8787
pnpm --filter @kantel/console dev              # http://127.0.0.1:5173, on that gateway
pnpm --filter @kantel/console dev:recorded     # http://127.0.0.1:5173, on @kantel/ui's sample data, no backend
```

`pnpm dev` forwards `/v1` to the gateway (`KANTEL_GATEWAY`, default `http://127.0.0.1:8787`) and signs each call in
as the dev admin with a token from the gateway's mock Access issuer (`scripts/dev-gateway.ts`). Deployed, and in a
self-hosted install, the gateway serves the console itself.

## Routes

The console's pages are the compute console's (`@kantel/ui`'s `computePath`): `/` is Sandboxes, then `/snapshots`,
`/keys`, `/proxy`, `/webhooks`, `/telemetry`, `/organisation`, `/billing` and, for a super-admin, `/hosts`. `/device` is where
`kantel login` sends a person to approve a device. The paths under `/compute/...` that earlier consoles used go to the
same page here, so old bookmarks and an older CLI's device link still work.

A new install has no hosts. Sandboxes and Hosts then say so and offer **Add a host**, which makes a one-time join
token and shows the command to run on the machine (docs/site/src/content/docs/self-hosting/install.md).

`?source=recorded` or `?source=api` picks the source for the tab (the default is `api`, or `VITE_KANTEL_SOURCE`).

## Sign-in

`src/api/identity.ts` asks `GET /v1/me` first. A 401 shows Kantel's email-code sign-in where the deployment signs
people in that way (self-hosted), and asks for a reload where Access does it at the edge. The person's saved theme
follows from `/v1/me` (`src/state/theme-sync.ts`).

## Checks

`pnpm --filter @kantel/console test` runs the console's tests, including the token and copy lint over its CSS and
TSX (`src/ui/tokens.test.ts`) and the compute API source (`src/compute/api-source.test.ts`).
