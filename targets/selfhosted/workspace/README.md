# @harbour/selfhosted-workspace

Workspaces for the self-hosted target: `@harbour/workspace/stored` over Postgres (each workspace's head and version
table) and an S3-compatible bucket (content-addressed blobs and immutable trees). Adapted from `apps/selfhosted`'s
`PostgresWorkspaces`, which stays in place until the deployment lane switches over.

```ts
import pg from "pg";
import { createS3Objects, createSelfHostedWorkspaces, migrateWorkspaceStore, pgDatabase } from "@harbour/selfhosted-workspace";

const db = pgDatabase(new pg.Pool({ connectionString }));
await migrateWorkspaceStore(db, "harbour");
const objects = createS3Objects({ endpoint, bucket, accessKeyId, secretAccessKey, prefix: "workspaces" });
await objects.ensureBucket();
const workspaces = createSelfHostedWorkspaces({ db, objects, schema: "harbour", clock, audit, access, sources });
```

The store keeps a `revision` on each head row as its compare-and-set token: a commit writes its blobs and tree, then
updates the head where the revision is still the one it read, in one transaction with the version's row.

Git seeds are fetched by the host's fetcher, passed through as `seeders: { git }` (such as
`createGitHubTarballFetcher({ fetch: vaultEgressFetch })` from `@harbour/workspace/git-tarball`). To hand `notes/` back,
`syncExport(ctx, workspaces, id, { prefixes: ["notes/"], sink: createDirectoryExportSink(taskDir), previous })` writes
changed files into `taskDir` atomically, removes the ones it wrote that are gone (and the directories that leaves
empty, never one holding the host's files), and refuses any path through a symlink. After a failed sync, keep
`exportManifestOf(error)` as the next `previous`.

## Tests

`pnpm test` runs the workspace conformance suite (with project access and the keyed `ensure` cases, and again with
workspace-backed `/project`) on PGlite with objects in memory, so CI needs no services. The same suite and the
10,000-file listing run on a real Postgres and S3 when these are set:

```sh
HARBOUR_TEST_DATABASE_URL=postgres://harbour:harbour@127.0.0.1:55432/harbour \
HARBOUR_TEST_S3_ENDPOINT=http://127.0.0.1:59000 \
pnpm --filter @harbour/selfhosted-workspace test
```

Optional: `HARBOUR_TEST_S3_BUCKET` (default `harbour-m1-be23`), `HARBOUR_TEST_S3_ACCESS_KEY`, `HARBOUR_TEST_S3_SECRET_KEY`
(the compose stack's MinIO credentials by default). Each case uses its own schema and key prefix, and the run drops its
schemas and deletes its prefix's objects afterwards (never the bucket). The stack tests also race two connections on
one head and round-trip organisation IDs and paths with `/`, `%`, spaces and non-ASCII through S3.
