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

## Tests

`pnpm test` runs the workspace conformance suite (with project access and the keyed `ensure` cases, and again with
workspace-backed `/project`) and the 10,000-file listing on the local R2 that `wrangler dev` serves, through
wrangler's `getPlatformProxy` and `wrangler.jsonc` here. Nothing is deployed and nothing persists.
