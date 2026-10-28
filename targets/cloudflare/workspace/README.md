# @harbour/cloudflare-workspace

Workspaces for the Cloudflare target: `@harbour/workspace/stored` over one R2 bucket. Adapted from `spikes/cloudflare`'s
`ObjectStoreWorkspaces`, which stays in place until the deployment lane switches over.

```ts
import { createCloudflareWorkspaces } from "@harbour/cloudflare-workspace";

const workspaces = createCloudflareWorkspaces({ bucket: env.WORKSPACES, prefix: "workspaces", clock, audit, access, sources });
```

Each workspace's head is one R2 object, replaced only by a conditional put on its etag (created only where none
exists). The head carries the versions not yet archived; the commit that moves the head past a version archives it
first, so history and old versions read from `ws/<id>/versions/<n>.json`. Blobs and trees are
`@harbour/workspace/stored`'s keys under the prefix.

With `headCache`, each head's document and etag are kept in front of R2 (the Cloudflare app keeps them in its stack
object's storage), so a load makes no R2 request. Every write drops the cached head before it starts and puts back only
what it wrote, if no other write overlapped it; a load caches what it read only if no write was in flight or started
meanwhile. Use it only where every write goes through the one store. A head moved anywhere else stays cached until a
write here fails its conditional put on it, which drops it.

## Tests

`pnpm test` runs the workspace conformance suite (with project access and the keyed `ensure` cases, and again with
workspace-backed `/project`, and with a head cache), the head cache's own cases, and the 10,000-file listing on the local R2 that `wrangler dev` serves, through
wrangler's `getPlatformProxy` and `wrangler.jsonc` here. Nothing is deployed and nothing persists.
